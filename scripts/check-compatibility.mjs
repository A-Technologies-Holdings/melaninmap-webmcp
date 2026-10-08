#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const schema = await readJson(path.join(root, "compatibility/webmcp.schema.json"));
const evidencePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "compatibility/webmcp.json");
const evidence = await readJson(evidencePath);

function validate(value, rule, at = "$") {
  if (rule.$ref) {
    const target = rule.$ref.slice(2).split("/").reduce((part, key) => part[key], schema);
    return validate(value, target, at);
  }
  if (rule.oneOf) {
    const matches = rule.oneOf.filter(candidate => { try { validate(value, candidate, at); return true; } catch { return false; } });
    assert.equal(matches.length, 1, `${at} must match exactly one allowed shape`);
    return;
  }
  if (rule.type === "object") {
    assert(value && typeof value === "object" && !Array.isArray(value), `${at} must be an object`);
    for (const key of rule.required ?? []) assert(Object.hasOwn(value, key), `${at}.${key} is required`);
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(value)) assert(Object.hasOwn(rule.properties ?? {}, key), `${at}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(rule.properties ?? {})) if (Object.hasOwn(value, key)) validate(value[key], child, `${at}.${key}`);
  } else if (rule.type === "string") {
    assert.equal(typeof value, "string", `${at} must be a string`);
    if (rule.minLength) assert(value.length >= rule.minLength, `${at} is too short`);
    if (rule.pattern) assert(new RegExp(rule.pattern).test(value), `${at} has an invalid format`);
    if (rule.format === "date-time") assert(!Number.isNaN(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value), `${at} must be an RFC 3339 date-time`);
  }
  if (rule.enum) assert(rule.enum.includes(value), `${at} must be one of ${rule.enum.join(", ")}`);
}

validate(evidence, schema);
const [pkg, snapshot] = await Promise.all([
  readJson(path.join(root, "package.json")), readJson(path.join(root, "spec/webmcp-surface.json")),
]);
assert.equal(evidence.libraryVersion, pkg.version, "compatibility libraryVersion must match package.json");
assert.equal(evidence.specSnapshot.commit, snapshot.source.commit, "compatibility spec commit must match the snapshot");
for (const observation of [evidence.browser.currentRun]) {
  if (observation?.status === "passed" && observation.playwrightVersion) {
    assert.equal(observation.playwrightVersion, pkg.devDependencies["@playwright/test"], "browser receipt must use pinned Playwright");
  }
}
console.log(`compatibility evidence is valid: ${evidencePath}`);
