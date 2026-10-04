/**
 * Offline tests for scripts/check-spec-drift.mjs.
 *
 * The fixture is an excerpt of the WebMCP spec source at the snapshot commit
 * (test/fixtures/webmcp-index.excerpt.bs). These tests pin down what counts
 * as drift and, just as important, what must not: prose, comments,
 * whitespace and ordering changes are noise, and a drift check that cries
 * wolf gets switched off.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  EXIT,
  ExtractionError,
  PACKAGE_DEPENDENCIES,
  diffSurfaces,
  extractIdlBlocks,
  extractSurface,
  main,
  missingDependencies,
} from "../scripts/check-spec-drift.mjs";

const fixture = await readFile(new URL("./fixtures/webmcp-index.excerpt.bs", import.meta.url), "utf8");
const baseline = extractSurface(fixture);

function drift(source) {
  return diffSurfaces(baseline.surface, extractSurface(source).surface);
}

function replaceOnce(source, from, to) {
  assert.ok(source.includes(from), `fixture must contain ${JSON.stringify(from)}`);
  return source.replace(from, to);
}

test("extracts the WebMCP surface from the spec's IDL blocks", () => {
  const { idl, permissionsPolicyFeatures } = baseline.surface;
  assert.deepEqual(Object.keys(idl), [
    "callback ToolExecuteCallback",
    "dictionary ModelContextExecuteToolOptions",
    "dictionary ModelContextGetToolOptions",
    "dictionary ModelContextRegisterToolOptions",
    "dictionary ModelContextTool",
    "dictionary RegisteredTool",
    "dictionary ToolActivatedEventInit",
    "dictionary ToolAnnotations",
    "dictionary ToolCancelEventInit",
    "dictionary ToolExecuteCallbackOptions",
    "interface Document",
    "interface ModelContext",
    "interface ToolActivatedEvent",
    "interface ToolCancelEvent",
  ]);
  assert.equal(idl["interface Document"].declaration, "partial interface Document");
  assert.deepEqual(idl["interface Document"].members, [
    "[SecureContext, SameObject] readonly attribute ModelContext modelContext",
  ]);
  assert.equal(idl["interface ModelContext"].declaration, "[Exposed=Window, SecureContext] interface ModelContext : EventTarget");
  assert.ok(idl["interface ModelContext"].members.includes(
    "Promise<undefined> registerTool(ModelContextTool tool, optional ModelContextRegisterToolOptions options = {})",
  ));
  assert.equal(
    idl["callback ToolExecuteCallback"].declaration,
    "callback ToolExecuteCallback = Promise<any> (object inputObject, ToolExecuteCallbackOptions options)",
  );
  assert.deepEqual(idl["dictionary ToolExecuteCallbackOptions"].members, ["required AbortSignal signal"]);
  assert.deepEqual(permissionsPolicyFeatures, ["tools"]);
});

test("the checked-in snapshot is exactly what the extractor makes of the fixture", async () => {
  // The fixture is the spec's IDL at the snapshot commit. After
  // `npm run check:spec -- --update`, refresh the fixture from the same
  // commit too, or this fails.
  const snapshot = JSON.parse(await readFile(new URL("../spec/webmcp-surface.json", import.meta.url), "utf8"));
  assert.deepEqual(baseline.surface, snapshot.surface);
  assert.deepEqual(missingDependencies(baseline.names), []);
  for (const [definition] of PACKAGE_DEPENDENCIES) {
    assert.ok(snapshot.surface.idl[definition], `snapshot is missing ${definition}`);
  }
});

test("prose, comments, whitespace and ordering are not drift", () => {
  let noisy = fixture.replaceAll("Prose that the extractor must ignore.", "Rewritten prose, still not IDL.");
  noisy = replaceOnce(noisy, "  required DOMString name;\n", "\n  // a new comment\n  required   DOMString\n    name;\n");
  noisy = replaceOnce(
    noisy,
    "  boolean readOnlyHint = false;\n  boolean untrustedContentHint = false;",
    "  boolean untrustedContentHint = false;\n  /* reordered */ boolean readOnlyHint = false;",
  );
  assert.deepEqual(drift(noisy), []);

  // Every block reversed in document order.
  const blocks = extractIdlBlocks(fixture);
  const reordered = blocks.reverse().map((block) => `<xmp class="idl">${block}</xmp>`).join("\n<p>between</p>\n");
  assert.deepEqual(drift(`${reordered}\n<dfn permission>tools</dfn>`), []);
});

test("commented-out IDL and definitions are not normative", () => {
  const commented = fixture
    .replace(/<xmp class="idl">\npartial interface Document[\s\S]*?<\/xmp>/, (block) => `<!--\n${block}\n-->`)
    .replace("permission>tools</dfn>", "permission>tools</dfn><!-- <dfn permission>old</dfn> -->");
  const { surface, names } = extractSurface(commented);
  assert.equal(surface.idl["interface Document"], undefined);
  assert.deepEqual(surface.permissionsPolicyFeatures, ["tools"]);
  assert.deepEqual(
    missingDependencies(names).map(([definition, member]) => `${definition}.${member}`),
    ["interface Document.modelContext"],
  );
});

test("moving a member into a partial definition is not a missing member", () => {
  const moved = replaceOnce(fixture, "  required ToolExecuteCallback execute;\n", "")
    + '\n<xmp class="idl">\npartial dictionary ModelContextTool {\n  required ToolExecuteCallback execute;\n};\n</xmp>\n';
  const { names } = extractSurface(moved);
  assert.deepEqual(missingDependencies(names), []);
  assert.deepEqual(drift(moved), [
    "~ dictionary ModelContextTool",
    "    - dictionary ModelContextTool",
    "    + dictionary ModelContextTool; partial dictionary ModelContextTool",
  ]);
});

test("<pre class=idl> with HTML entities parses like <xmp>", () => {
  const asPre = fixture.replace(/<xmp class="idl">([\s\S]*?)<\/xmp>/g, (_, body) =>
    `<pre class=idl>${body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>`,
  );
  assert.deepEqual(drift(asPre), []);
});

test("blocks marked exclude and non-IDL code are ignored", () => {
  const extra = `${fixture}\n<pre class="idl exclude">interface Ignored { undefined nope(); };</pre>\n<pre class=js>interface NotIdl {};</pre>`;
  assert.deepEqual(drift(extra), []);
});

test("a removed member is drift", () => {
  const changed = replaceOnce(fixture, "  attribute EventHandler ontoolcancel;\n", "");
  assert.deepEqual(drift(changed), ["~ interface ModelContext", "    - attribute EventHandler ontoolcancel"]);
});

test("a changed signature is drift, shown as remove plus add", () => {
  const changed = replaceOnce(
    fixture,
    "callback ToolExecuteCallback = Promise<any> (object inputObject, ToolExecuteCallbackOptions options);",
    "callback ToolExecuteCallback = Promise<any> (object inputObject, ModelContextClient client);",
  );
  assert.deepEqual(drift(changed), [
    "~ callback ToolExecuteCallback",
    "    - callback ToolExecuteCallback = Promise<any> (object inputObject, ToolExecuteCallbackOptions options)",
    "    + callback ToolExecuteCallback = Promise<any> (object inputObject, ModelContextClient client)",
  ]);
});

test("an extended-attribute change is drift", () => {
  const changed = replaceOnce(
    fixture,
    "[Exposed=Window, SecureContext]\ninterface ModelContext",
    "[Exposed=(Window,Worker), SecureContext]\ninterface ModelContext",
  );
  assert.deepEqual(drift(changed), [
    "~ interface ModelContext",
    "    - [Exposed=Window, SecureContext] interface ModelContext : EventTarget",
    "    + [Exposed=(Window, Worker), SecureContext] interface ModelContext : EventTarget",
  ]);
});

test("a new definition and a renamed policy feature are drift", () => {
  const changed = replaceOnce(fixture, "permission>tools</dfn>", "permission>webmcp</dfn>")
    + '\n<xmp class="idl">\npartial interface SubmitEvent {\n  readonly attribute boolean agentInvoked;\n};\n</xmp>\n';
  assert.deepEqual(drift(changed), [
    "+ interface SubmitEvent  (added)",
    "    + partial interface SubmitEvent",
    "    + readonly attribute boolean agentInvoked",
    "~ permissions-policy features",
    "    - tools",
    "    + webmcp",
  ]);
});

test("moving modelContext back to Navigator flags the package dependency", () => {
  const changed = replaceOnce(fixture, "partial interface Document {", "partial interface Navigator {");
  const { names } = extractSurface(changed);
  assert.deepEqual(
    missingDependencies(names).map(([definition, member]) => `${definition}.${member}`),
    ["interface Document.modelContext"],
  );
});

test("a source with no IDL, or IDL that does not parse, is an extraction failure", () => {
  assert.throws(() => extractSurface("<h1>Moved</h1><p>See elsewhere.</p>"), ExtractionError);
  assert.throws(() => extractSurface('<xmp class="idl">interface Broken {</xmp>'), ExtractionError);
});

// --- The CLI, against a local server: drift, network and extraction failures
// --- must be distinguishable by exit status alone.

async function serve(routes) {
  const server = createServer((req, res) => {
    const route = routes[req.url];
    if (!route) return res.writeHead(404).end();
    res.writeHead(route.status ?? 200, { "content-type": "text/plain" }).end(route.body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: { log: (line) => out.push(line), error: (line) => err.push(line) } };
}

test("CLI exit status separates no drift, drift, missing source, network and extraction failures", async (t) => {
  const changed = replaceOnce(fixture, "  attribute EventHandler ontoolcancel;\n", "");
  const server = await serve({
    "/spec.bs": { body: fixture },
    "/changed.bs": { body: changed },
    "/broken.bs": { body: "<p>no idl here</p>" },
    "/down.bs": { status: 503 },
  });
  t.after(() => server.close());
  const snapshot = path.join(await mkdtemp(path.join(tmpdir(), "webmcp-spec-")), "surface.json");
  const run = async (file) => {
    const c = capture();
    const code = await main(["--source-url", `${server.base}${file}`, "--snapshot", snapshot], c.log);
    return { code, ...c };
  };

  const update = capture();
  assert.equal(await main(["--source-url", `${server.base}/spec.bs`, "--snapshot", snapshot, "--update"], update.log), EXIT.ok);

  assert.equal((await run("/spec.bs")).code, EXIT.ok);

  const drifted = await run("/changed.bs");
  assert.equal(drifted.code, EXIT.drift);
  assert.match(drifted.err.join("\n"), /SPEC DRIFT[\s\S]*- attribute EventHandler ontoolcancel/);

  const missing = await run("/gone.bs");
  assert.equal(missing.code, EXIT.drift);
  assert.match(missing.err.join("\n"), /HTTP 404/);

  const down = await run("/down.bs");
  assert.equal(down.code, EXIT.network);
  assert.match(down.err.join("\n"), /NETWORK FAILURE \(not drift\)[\s\S]*HTTP 503/);

  const broken = await run("/broken.bs");
  assert.equal(broken.code, EXIT.extraction);
  assert.match(broken.err.join("\n"), /EXTRACTION FAILURE/);
});

test("CLI reports a refused connection as a network failure", async () => {
  const server = await serve({});
  const { base } = server;
  await server.close();
  const c = capture();
  const code = await main(["--source-url", `${base}/spec.bs`, "--snapshot", "unused.json"], c.log);
  assert.equal(code, EXIT.network);
  assert.match(c.err.join("\n"), /NETWORK FAILURE \(not drift\)/);
});

test("CLI rejects unknown options and path-like refs", async () => {
  for (const args of [["--nope"], ["--ref", "../../other/repo/main"], ["--ref", "main/../x"], ["--ref"]]) {
    const c = capture();
    assert.equal(await main(args, c.log), EXIT.usage, args.join(" "));
  }
});

test("network failure has its own exit status, distinct from shell and usage errors", () => {
  assert.equal(EXIT.network, 75);
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length);
  assert.ok(![1, 2, 126, 127].includes(EXIT.network));
});
