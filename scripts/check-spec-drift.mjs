#!/usr/bin/env node
/**
 * WebMCP spec-drift check.
 *
 * Fetches the WebMCP specification source (webmachinelearning/webmcp,
 * index.bs on `main`), extracts its API surface from the normative WebIDL
 * blocks, and compares it with the checked-in snapshot in
 * spec/webmcp-surface.json. Prose, comments, whitespace and member order do
 * not count as drift; a changed signature, a new or removed member, a
 * changed extended attribute or a renamed permissions-policy feature does.
 *
 * Exit status — distinct so a nightly lane can tell "upstream changed" from
 * "could not look":
 *   0  no drift
 *   1  drift: the surface differs from the snapshot (or the source is gone)
 *   3  extraction: the source was fetched but no WebIDL could be parsed
 *  64  usage error (including a --ref that does not exist upstream)
 *  75  network: the source could not be fetched; nothing was compared
 *      (EX_TEMPFAIL, so it cannot be confused with a shell or usage error)
 *
 * Usage:
 *   npm run check:spec
 *   npm run check:spec -- --update          accept the current upstream surface
 *   npm run check:spec -- --ref <sha>       check a specific upstream commit
 *   node scripts/check-spec-drift.mjs --source-url <url> --snapshot <file>
 *
 * Needs the network, so it is not part of `npm run check`. The extractor is
 * unit-tested offline in test/spec-drift.test.mjs.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "webidl2";

export const REPOSITORY = "webmachinelearning/webmcp";
export const SPEC_PATH = "index.bs";
export const DEFAULT_REF = "main";
const DEFAULT_SNAPSHOT = fileURLToPath(new URL("../spec/webmcp-surface.json", import.meta.url));

export const EXIT = { ok: 0, drift: 1, extraction: 3, usage: 64, network: 75 };

/**
 * What the package itself relies on. A drift report flags these first,
 * because a change here can break consumers rather than merely open an
 * opportunity. Keep in step with src/register.ts and src/defineTool.ts.
 */
export const PACKAGE_DEPENDENCIES = [
  ["interface Document", "modelContext", "register.ts detects document.modelContext"],
  ["interface ModelContext", "registerTool", "register.ts registers incrementally"],
  ["dictionary ModelContextRegisterToolOptions", "signal", "register.ts forwards { signal } to registerTool"],
  ["dictionary ModelContextTool", "name", "defineTool.ts emits name"],
  ["dictionary ModelContextTool", "description", "defineTool.ts emits description"],
  ["dictionary ModelContextTool", "inputSchema", "defineTool.ts emits inputSchema"],
  ["dictionary ModelContextTool", "annotations", "defineTool.ts emits annotations"],
  ["dictionary ModelContextTool", "execute", "defineTool.ts emits execute"],
  ["dictionary ToolAnnotations", "readOnlyHint", "defineTool.ts derives readOnlyHint"],
  ["dictionary ToolAnnotations", "consequentialHint", "defineTool.ts sets consequentialHint"],
  ["dictionary ToolExecuteCallbackOptions", "signal", "defineTool.ts reads execute's options.signal"],
];

export function sourceUrl(ref = DEFAULT_REF) {
  return `https://raw.githubusercontent.com/${REPOSITORY}/${ref}/${SPEC_PATH}`;
}

// ---------------------------------------------------------------------------
// Extraction (pure, offline)
// ---------------------------------------------------------------------------

/** Bikeshed drops HTML comments, so commented-out IDL is not normative. */
function withoutComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", "#39": "'" };

/**
 * Pull the normative WebIDL out of a Bikeshed source. Bikeshed marks IDL as
 * <xmp class="idl"> (raw text) or <pre class="idl"> (HTML, so entities and
 * inline markup are undone). Blocks also classed `exclude` are not part of
 * the spec's IDL index and are skipped.
 */
export function extractIdlBlocks(source) {
  const blocks = [];
  const pattern = /<(xmp|pre)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const [, tag, attributes, body] of withoutComments(source).matchAll(pattern)) {
    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const classes = (classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "").split(/\s+/);
    if (!classes.includes("idl") || classes.includes("exclude")) continue;
    blocks.push(
      tag.toLowerCase() === "pre"
        ? body.replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp|quot|apos|#39);/g, (_, name) => ENTITIES[name])
        : body,
    );
  }
  return blocks;
}

/** Policy-controlled features the spec defines (`<dfn permission>name</dfn>`). */
export function extractPermissionsPolicyFeatures(source) {
  const names = new Set();
  for (const [, attributes, name] of withoutComments(source).matchAll(/<dfn\b([^>]*)>([^<]+)<\/dfn>/gi)) {
    if (/(^|\s)permission(\s|=|$)/i.test(attributes)) names.add(name.trim());
  }
  return [...names].sort();
}

function extAttrs(list) {
  if (!list?.length) return "";
  const item = (attribute) => {
    let text = attribute.name;
    const rhs = attribute.rhs;
    if (rhs) {
      const value = Array.isArray(rhs.value)
        ? `(${rhs.value.map((entry) => entry.value).join(", ")})`
        : rhs.value;
      text += `=${value}`;
    }
    if (attribute.arguments?.length) text += `(${attribute.arguments.map(argument).join(", ")})`;
    return text;
  };
  return `[${list.map(item).join(", ")}] `;
}

function type(idlType) {
  if (!idlType) return "undefined";
  let text;
  if (idlType.union) text = `(${idlType.idlType.map(type).join(" or ")})`;
  else if (idlType.generic) text = `${idlType.generic}<${idlType.idlType.map(type).join(", ")}>`;
  else text = idlType.idlType;
  return `${extAttrs(idlType.extAttrs)}${text}${idlType.nullable ? "?" : ""}`;
}

function defaultValue(value) {
  if (!value) return "";
  switch (value.type) {
    case "dictionary": return " = {}";
    case "sequence": return " = []";
    case "null": return " = null";
    case "string": return ` = "${value.value}"`;
    default: return ` = ${value.value ?? value.type}`;
  }
}

function argument(arg) {
  return `${extAttrs(arg.extAttrs)}${arg.optional ? "optional " : ""}${type(arg.idlType)}${arg.variadic ? "..." : ""} ${arg.name}${defaultValue(arg.default)}`;
}

function member(node) {
  const prefix = extAttrs(node.extAttrs);
  const special = node.special ? `${node.special} ` : "";
  switch (node.type) {
    case "operation":
      return `${prefix}${special}${type(node.idlType)} ${node.name}(${node.arguments.map(argument).join(", ")})`;
    case "constructor":
      return `${prefix}constructor(${node.arguments.map(argument).join(", ")})`;
    case "attribute":
      return `${prefix}${special}${node.readonly ? "readonly " : ""}attribute ${type(node.idlType)} ${node.name}`;
    case "field":
      return `${prefix}${node.required ? "required " : ""}${type(node.idlType)} ${node.name}${defaultValue(node.default)}`;
    case "const":
      return `${prefix}const ${type(node.idlType)} ${node.name} = ${node.value?.value ?? node.value}`;
    case "iterable":
    case "maplike":
    case "setlike":
      return `${prefix}${node.readonly ? "readonly " : ""}${node.async ? "async " : ""}${node.type}<${node.idlType.map(type).join(", ")}>`;
    default:
      return `${prefix}${node.type} ${node.name ?? ""}`.trim();
  }
}

/** One key per definition name: a partial and its full definition merge. */
function definitionKey(node) {
  return `${node.type} ${node.name}`;
}

function declaration(node) {
  const head = `${extAttrs(node.extAttrs)}${node.partial ? "partial " : ""}${definitionKey(node)}`;
  switch (node.type) {
    case "callback":
      return `${head} = ${type(node.idlType)} (${node.arguments.map(argument).join(", ")})`;
    case "typedef":
      return `${head} = ${type(node.idlType)}`;
    case "enum":
      return `${head} { ${node.values.map((value) => JSON.stringify(value.value)).join(", ")} }`;
    case "includes":
      return `${node.target} includes ${node.includes}`;
    default:
      return node.inheritance ? `${head} : ${node.inheritance}` : head;
  }
}

/**
 * Turn WebIDL text into a stable, diffable surface: one entry per
 * definition (a full definition and its partials merge under one key), each
 * with its declaration line(s) and its members as sorted canonical strings.
 * Moving a member between a definition and its partial changes the
 * declaration line but never makes the member look removed. Throws a WebIDL
 * parse error on malformed input.
 */
export function surfaceFromIdl(blocks) {
  const definitions = {};
  const names = new Set();
  for (const block of blocks) {
    for (const node of parse(block)) {
      if (node.type === "eof") continue;
      const key = node.type === "includes" ? `includes ${node.target} ${node.includes}` : definitionKey(node);
      const entry = (definitions[key] ??= { declarations: [], members: [] });
      entry.declarations.push(declaration(node));
      for (const child of node.members ?? []) {
        entry.members.push(member(child));
        if (child.name) names.add(`${key}.${child.name}`);
      }
    }
  }
  const sorted = {};
  for (const key of Object.keys(definitions).sort()) {
    const { declarations, members } = definitions[key];
    sorted[key] = { declaration: [...new Set(declarations)].sort().join("; "), members: [...new Set(members)].sort() };
  }
  return { definitions: sorted, names };
}

export class ExtractionError extends Error {}

/** Extract the full comparable surface from a spec source. */
export function extractSurface(source) {
  const blocks = extractIdlBlocks(source);
  if (blocks.length === 0) throw new ExtractionError("no WebIDL blocks (<xmp class=\"idl\"> / <pre class=\"idl\">) found");
  let parsed;
  try {
    parsed = surfaceFromIdl(blocks);
  } catch (error) {
    throw new ExtractionError(`WebIDL did not parse: ${error.bareMessage ?? error.message}`);
  }
  return {
    surface: {
      idl: parsed.definitions,
      permissionsPolicyFeatures: extractPermissionsPolicyFeatures(source),
    },
    names: parsed.names,
  };
}

/** Line-oriented diff of two surfaces; empty when they match. */
export function diffSurfaces(expected, actual) {
  const lines = [];
  const keys = [...new Set([...Object.keys(expected.idl ?? {}), ...Object.keys(actual.idl ?? {})])].sort();
  for (const key of keys) {
    const before = expected.idl?.[key];
    const after = actual.idl?.[key];
    if (!after) {
      lines.push(`- ${key}  (removed)`);
      continue;
    }
    if (!before) {
      lines.push(`+ ${key}  (added)`, `    + ${after.declaration}`, ...after.members.map((m) => `    + ${m}`));
      continue;
    }
    const changes = [];
    if (before.declaration !== after.declaration) changes.push(`    - ${before.declaration}`, `    + ${after.declaration}`);
    const was = new Set(before.members);
    const now = new Set(after.members);
    for (const m of before.members) if (!now.has(m)) changes.push(`    - ${m}`);
    for (const m of after.members) if (!was.has(m)) changes.push(`    + ${m}`);
    if (changes.length) lines.push(`~ ${key}`, ...changes);
  }
  const policyBefore = (expected.permissionsPolicyFeatures ?? []).join(", ");
  const policyAfter = (actual.permissionsPolicyFeatures ?? []).join(", ");
  if (policyBefore !== policyAfter) {
    lines.push("~ permissions-policy features", `    - ${policyBefore || "(none)"}`, `    + ${policyAfter || "(none)"}`);
  }
  return lines;
}

/** Package dependencies that no longer exist in the extracted surface. */
export function missingDependencies(names) {
  return PACKAGE_DEPENDENCIES.filter(([definition, name]) => !names.has(`${definition}.${name}`));
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export class NetworkError extends Error {}
export class SourceMissingError extends Error {}

async function fetchText(url, { attempts = 2, timeoutMs = 30_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "melaninmap-webmcp-spec-drift-check" },
      });
      if (response.status === 404 || response.status === 410) {
        throw new SourceMissingError(`HTTP ${response.status} for ${url}: the spec source moved or was removed`);
      }
      if (!response.ok) throw new NetworkError(`HTTP ${response.status} ${response.statusText} for ${url}`);
      return await response.text();
    } catch (error) {
      if (error instanceof SourceMissingError) throw error;
      const cause = error?.cause ? ` (${error.cause.code ?? error.cause.message ?? error.cause})` : "";
      lastError = error instanceof NetworkError
        ? error
        : new NetworkError(`${error?.name ?? "Error"}: ${error?.message ?? error}${cause} for ${url}`);
    }
  }
  throw lastError;
}

/** Best effort: the newest upstream commit touching the spec, for the report. */
async function latestCommit(ref) {
  try {
    const url = `https://api.github.com/repos/${REPOSITORY}/commits?path=${SPEC_PATH}&sha=${encodeURIComponent(ref)}&per_page=1`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/vnd.github+json", "user-agent": "melaninmap-webmcp-spec-drift-check" },
    });
    if (!response.ok) return null;
    const [commit] = await response.json();
    if (!commit?.sha) return null;
    return {
      sha: commit.sha,
      date: commit.commit?.committer?.date ?? null,
      message: commit.commit?.message?.split("\n")[0] ?? null,
    };
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = { update: false, ref: DEFAULT_REF, sourceUrl: null, snapshot: DEFAULT_SNAPSHOT };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--update") options.update = true;
    else if (flag === "--ref") {
      options.ref = value();
      options.refGiven = true;
    }
    else if (flag === "--source-url") options.sourceUrl = value();
    else if (flag === "--snapshot") options.snapshot = path.resolve(value());
    else throw new Error(`unknown option ${flag}`);
  }
  if (!/^[\w.\-/]+$/.test(options.ref) || options.ref.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`invalid --ref ${options.ref}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2), log = console) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log.error(`check-spec-drift: ${error.message}`);
    return EXIT.usage;
  }
  const url = options.sourceUrl ?? sourceUrl(options.ref);
  const pinned = !options.sourceUrl;

  let source;
  try {
    source = await fetchText(url);
  } catch (error) {
    if (error instanceof SourceMissingError && options.refGiven) {
      log.error(`check-spec-drift: --ref ${options.ref} does not exist upstream (${error.message}).`);
      return EXIT.usage;
    }
    if (error instanceof SourceMissingError) {
      log.error(`SPEC DRIFT: ${error.message}.`);
      log.error("Find the spec's new location, update check-spec-drift.mjs and docs/spec-drift.md.");
      return EXIT.drift;
    }
    log.error(`NETWORK FAILURE (not drift): could not fetch the WebMCP spec.\n  ${error.message}`);
    log.error("Nothing was compared. Re-run when the network is available.");
    return EXIT.network;
  }

  let extracted;
  try {
    extracted = extractSurface(source);
  } catch (error) {
    if (!(error instanceof ExtractionError)) throw error;
    log.error(`EXTRACTION FAILURE: fetched ${url} but ${error.message}.`);
    log.error("The spec's source format changed; the extractor needs updating before drift can be judged.");
    return EXIT.extraction;
  }

  const commit = pinned ? await latestCommit(options.ref) : null;
  const commitText = commit ? `${commit.sha.slice(0, 12)} ${commit.date?.slice(0, 10) ?? ""} "${commit.message ?? ""}"` : "unknown";

  if (options.update) {
    const snapshot = {
      $comment: "Generated by scripts/check-spec-drift.mjs --update. Compare, do not hand-edit.",
      source: {
        repository: REPOSITORY,
        path: SPEC_PATH,
        ref: pinned ? options.ref : null,
        url,
        commit: commit?.sha ?? null,
        commitDate: commit?.date ?? null,
      },
      surface: extracted.surface,
    };
    await writeFile(options.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
    log.log(`Wrote ${path.relative(process.cwd(), options.snapshot)} from ${url} (commit ${commitText}).`);
    return EXIT.ok;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(options.snapshot, "utf8"));
  } catch (error) {
    log.error(`check-spec-drift: cannot read snapshot ${options.snapshot}: ${error.message}`);
    return EXIT.usage;
  }

  const diff = diffSurfaces(snapshot.surface, extracted.surface);
  const missing = missingDependencies(extracted.names);
  const snapshotAt = snapshot.source?.commit
    ? `${snapshot.source.commit.slice(0, 12)} ${snapshot.source.commitDate?.slice(0, 10) ?? ""}`
    : "unknown commit";

  if (diff.length === 0 && missing.length === 0) {
    log.log(`No WebMCP spec drift: ${url} matches the snapshot (snapshot ${snapshotAt}; upstream ${commitText}).`);
    return EXIT.ok;
  }

  log.error("SPEC DRIFT: the WebMCP API surface no longer matches spec/webmcp-surface.json.");
  log.error(`  upstream: ${url}`);
  log.error(`  upstream commit touching ${SPEC_PATH}: ${commitText}`);
  log.error(`  snapshot: ${snapshotAt}`);
  if (missing.length) {
    log.error("\nPackage dependencies missing upstream (these can break consumers):");
    for (const [definition, name, why] of missing) log.error(`  ! ${definition}.${name} — ${why}`);
  }
  if (diff.length) {
    log.error("\nSurface diff (- snapshot, + upstream):");
    for (const line of diff) log.error(`  ${line}`);
  }
  log.error("\nReview the change against src/ and docs/spec-drift.md, then accept it with");
  log.error("  npm run check:spec -- --update");
  return EXIT.drift;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
