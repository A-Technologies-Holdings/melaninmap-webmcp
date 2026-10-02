/**
 * tools.json points into openapi.yaml by JSON pointer instead of duplicating
 * the response shapes — deliberate, so the two cannot drift apart. But a JSON
 * pointer is only as good as its target: a renamed path or a typo'd pointer
 * leaves the published contract referencing schema that does not exist, and
 * nothing in the gate noticed. This check closes that hole.
 *
 * It also validates that openapi.yaml parses at all — until now nothing in
 * `npm run check` read it — and that every tool name the schemas mention is
 * one the contract actually defines.
 *
 * Run: npm run check:openapi
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "schemas/melaninmap.tools.json");
const openapiPath = join(root, "schemas/openapi.yaml");

let failures = 0;

const contract = JSON.parse(readFileSync(contractPath, "utf8"));

let openapi;
try {
  openapi = YAML.parse(readFileSync(openapiPath, "utf8"));
} catch (error) {
  console.error(`FAIL schemas/openapi.yaml does not parse: ${error.message}`);
  process.exit(1);
}
if (!openapi || typeof openapi !== "object") {
  console.error("FAIL schemas/openapi.yaml parsed but is not a document");
  process.exit(1);
}
console.log("ok   openapi.yaml parses");

/** Decode a JSON pointer segment (RFC 6901: ~1 -> /, ~0 -> ~). */
const decode = (segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~");

/** Resolve a `#/a/b/c` pointer against a document; returns undefined if dead. */
function resolvePointer(document, pointer) {
  let node = document;
  for (const raw of pointer.replace(/^#\/?/, "").split("/")) {
    const key = decode(raw);
    if (node === null || typeof node !== "object" || !(key in node)) {
      return undefined;
    }
    node = node[key];
  }
  return node;
}

/** Recursively collect every { $ref } value in a value tree. */
function collectRefs(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key === "$ref" && typeof nested === "string") found.push(nested);
      else collectRefs(nested, found);
    }
  }
  return found;
}

// 1. Every external pointer in the tool contract must resolve in openapi.yaml.
let externalRefs = 0;
for (const ref of collectRefs(contract)) {
  const match = /^\.\/openapi\.yaml(#.*)$/.exec(ref);
  if (!match) {
    failures += 1;
    console.error(`FAIL unexpected $ref shape (only ./openapi.yaml#… allowed): ${ref}`);
    continue;
  }
  externalRefs += 1;
  if (resolvePointer(openapi, match[1]) === undefined) {
    failures += 1;
    console.error(`FAIL dead pointer in melaninmap.tools.json: ${ref}`);
  }
}
if (externalRefs === 0) {
  failures += 1;
  console.error("FAIL no openapi.yaml pointers found in melaninmap.tools.json");
} else {
  console.log(`ok   all ${externalRefs} contract pointers resolve in openapi.yaml`);
}

// 2. Every internal `#/...` reference inside openapi.yaml must resolve.
const internalRefs = collectRefs(openapi).filter((ref) => ref.startsWith("#"));
let deadInternal = 0;
for (const ref of internalRefs) {
  if (resolvePointer(openapi, ref) === undefined) {
    failures += 1;
    deadInternal += 1;
    console.error(`FAIL dead internal $ref in openapi.yaml: ${ref}`);
  }
}
if (deadInternal === 0) {
  console.log(`ok   all ${internalRefs.length} internal openapi.yaml $refs resolve`);
}

// 3. Every tool name the schemas mention must be a tool the contract defines.
// Prose and comments in openapi.yaml name tools freely, and pointers cannot
// catch a stale one: `check_verification_status` survived a rename to
// `check_ownership_verification` this way. Scoped to the tool verbs so error
// codes like `invalid_installation_id` are not mistaken for tool names.
const toolNames = new Set(contract.tools.map((tool) => tool.name));
const TOOL_NAME_SHAPE = /\b(?:search|get|check|record|request)_[a-z_]+\b/g;
const unknownNames = new Set();
for (const path of [openapiPath, contractPath]) {
  for (const name of readFileSync(path, "utf8").match(TOOL_NAME_SHAPE) ?? []) {
    if (!toolNames.has(name)) unknownNames.add(name);
  }
}
if (unknownNames.size > 0) {
  failures += unknownNames.size;
  for (const name of [...unknownNames].sort()) {
    console.error(`FAIL schemas name a tool the contract does not define: ${name}`);
  }
} else {
  console.log(`ok   every tool name in schemas/ is one of the ${toolNames.size} contract tools`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
