/**
 * Behavioral tests against the BUILT output in dist/.
 *
 * Typechecking proves the shapes line up. It does not prove the consent gate
 * actually holds, and the gate is the whole product — so these assertions run
 * the compiled JavaScript the way a consumer would import it.
 *
 * Run: npm run build && npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defineReadTool,
  defineConsequentialTool,
  registerAgentTools,
  consentRefusal,
} from "../dist/index.js";

const parse = (raw) => raw;
const schema = { type: "object" };
const json = (result) => JSON.parse(result.content[0].text);

// --- read tools ------------------------------------------------------------
const read = defineReadTool({
  name: "search",
  description: "d",
  inputSchema: schema,
  parseArgs: parse,
  execute: async () => ({ ok: true, items: [] }),
});

test("a read tool returns its payload", async () => {
  assert.deepEqual(json(await read.execute({})), { ok: true, items: [] });
});

test("a read tool is annotated read-only", () => {
  assert.equal(read.annotations.readOnlyHint, true);
});

// readOnlyHint is derived from the tool kind, not from caller annotations — a
// consequential tool that claimed readOnlyHint would tell a host the gate is
// side-effect-free. The derived value must win over spec.annotations.
test("a read tool cannot be annotated non-read-only", () => {
  assert.equal(
    defineReadTool({
      name: "lie",
      description: "d",
      inputSchema: schema,
      annotations: { readOnlyHint: false, destructiveHint: true },
      parseArgs: parse,
      execute: async () => null,
    }).annotations.readOnlyHint,
    true,
  );
});

test("a consequential tool cannot claim readOnlyHint", () => {
  assert.equal(
    defineConsequentialTool({
      name: "lie2",
      description: "d",
      inputSchema: schema,
      annotations: { readOnlyHint: true },
      parseArgs: parse,
      consent: async () => ({ decision: "declined" }),
      describeConsent: () => ({ title: "t", detail: "d", confirmLabel: "Go" }),
      execute: async () => null,
    }).annotations.readOnlyHint,
    false,
  );
});

// The host's execute argument is untyped in practice. A non-object payload is
// normalized to {} before parseArgs sees it — the parser must never receive a
// string or array it was not written for.
test("a non-object raw argument is normalized to {} for parseArgs", async () => {
  let parseSaw;
  await defineReadTool({
    name: "probe",
    description: "d",
    inputSchema: schema,
    parseArgs: (raw) => {
      parseSaw = raw;
      return raw;
    },
    execute: async () => null,
  }).execute("definitely-not-an-object");
  assert.deepEqual(parseSaw, {});
});

// A side-effect-only execute resolves to undefined, and JSON.stringify(undefined)
// is undefined — which would put a non-string in a text block and turn a
// successful call into a malformed result.
test("a void result serialises as valid JSON", async () => {
  const voidResult = await defineReadTool({
    name: "void",
    description: "d",
    inputSchema: schema,
    parseArgs: parse,
    execute: async () => undefined,
  }).execute({});
  assert.equal(typeof voidResult.content[0].text, "string");
  assert.equal(voidResult.content[0].text, "null");
  assert.doesNotThrow(() => JSON.parse(voidResult.content[0].text));
});

// A parseArgs that THROWS (the natural shape when wrapping a schema validator)
// must become an envelope, not a rejected promise. Rule 1: a tool never throws
// into the agent runtime.
const throwingParse = {
  name: "throws",
  description: "d",
  inputSchema: schema,
  parseArgs: () => {
    throw new Error("schema validator rejected the input");
  },
  execute: async () => ({ ok: true }),
};

test("a throwing parseArgs becomes invalid_arguments (read)", async () => {
  const readThrew = json(await defineReadTool(throwingParse).execute({}));
  assert.equal(readThrew.code, "invalid_arguments");
});

test("a throwing parseArgs becomes invalid_arguments (consequential)", async () => {
  let ranAfterBadParse = false;
  const consThrew = json(
    await defineConsequentialTool({
      ...throwingParse,
      consent: async () => ({ decision: "confirmed" }),
      describeConsent: () => ({ title: "t", detail: "d", confirmLabel: "Go" }),
      execute: async () => {
        ranAfterBadParse = true;
        return { ok: true };
      },
    }).execute({}),
  );
  assert.equal(consThrew.code, "invalid_arguments");
  // And never reaches consent or the action.
  assert.equal(ranAfterBadParse, false);
});

// --- the consent gate ------------------------------------------------------
function gated(consent, onRun) {
  return defineConsequentialTool({
    name: "handoff",
    description: "d",
    inputSchema: schema,
    parseArgs: parse,
    consent,
    describeConsent: () => ({ title: "t", detail: "d", confirmLabel: "Go" }),
    execute: async () => {
      onRun();
      return { ok: true };
    },
  });
}

for (const decision of ["declined", "timeout", "closed"]) {
  test(`the action does not run on "${decision}"`, async () => {
    let ran = false;
    const result = json(
      await gated(async () => ({ decision }), () => {
        ran = true;
      }).execute({}),
    );
    assert.equal(ran, false);
    assert.equal(result.ok, false);
    assert.equal(result.code, `consent_${decision}`);
    // The model gets an instruction, not just a code.
    assert.ok(result.message.length > 0);
  });
}

// A consumer's error mapper inspecting a surprising error shape can itself
// throw. That must not reject into the runtime on the very path that exists to
// prevent rejections.
test("a throwing error mapper falls back instead of rejecting", async () => {
  const mapperThrew = json(
    await defineReadTool({
      name: "badmapper",
      description: "d",
      inputSchema: schema,
      parseArgs: parse,
      execute: async () => {
        throw new Error("upstream exploded");
      },
      mapError: () => {
        throw new TypeError("mapper assumed a shape the error did not have");
      },
    }).execute({}),
  );
  assert.equal(mapperThrew.ok, false);
  assert.equal(mapperThrew.code, "tool_unavailable");
});

test("a consent surface that throws fails CLOSED", async () => {
  let ranOnThrow = false;
  const thrown = json(
    await gated(
      async () => {
        throw new Error("consent surface exploded");
      },
      () => {
        ranOnThrow = true;
      },
    ).execute({}),
  );
  assert.equal(ranOnThrow, false);
  assert.equal(thrown.ok, false);
});

// A surface is consumer code, often plain JavaScript. Whatever it resolves to,
// the tool must stay well formed: no rejection into the runtime, no unknown
// value leaking into the refusal code, and never a run of the action.
for (const [label, value] of [
  ["undefined", undefined],
  ["null", null],
  ["a bare string", "confirmed"],
  ["an unknown decision", { decision: "yes" }],
  ["a missing decision", {}],
]) {
  test(`a surface resolving ${label} fails CLOSED as a well-formed refusal`, async () => {
    let ran = false;
    const result = json(
      await gated(async () => value, () => {
        ran = true;
      }).execute({}),
    );
    assert.equal(ran, false);
    assert.deepEqual(result, consentRefusal("closed"));
  });
}

test("the action DOES run once confirmed", async () => {
  let ranOnConfirm = false;
  const confirmed = json(
    await gated(async () => ({ decision: "confirmed", auditToken: "t" }), () => {
      ranOnConfirm = true;
    }).execute({}),
  );
  assert.equal(ranOnConfirm, true);
  assert.deepEqual(confirmed, { ok: true });
});

// The audit token exists so it can be forwarded to a backend as evidence a
// confirmation was shown and answered. If execute cannot see it, the token is
// decoration and consumers reach for out-of-band shared state instead.
test("the confirmation and its audit token reach the action", async () => {
  let received;
  await defineConsequentialTool({
    name: "audited",
    description: "d",
    inputSchema: schema,
    parseArgs: parse,
    consent: async () => ({ decision: "confirmed", auditToken: "audit-abc" }),
    describeConsent: () => ({ title: "t", detail: "d", confirmLabel: "Go" }),
    execute: async (_args, consent) => {
      received = consent;
      return { ok: true };
    },
  }).execute({});
  assert.equal(received.decision, "confirmed");
  assert.equal(received.auditToken, "audit-abc");
});

// JSON.stringify THROWS on a bigint or a circular object — it does not merely
// return undefined. That call lives inside the execute try/catch, so an
// unguarded throw would report a SUCCESSFUL consequential action as
// `tool_unavailable` and invite a retry of a handoff that already happened.
const circular = {};
circular.self = circular;
for (const [label, badValue] of [
  ["bigint", 1n],
  ["circular object", circular],
]) {
  test(`a successful ${label} result is not reported as a failure`, async () => {
    let ran = false;
    const result = json(
      await defineConsequentialTool({
        name: "unserialisable",
        description: "d",
        inputSchema: schema,
        parseArgs: parse,
        consent: async () => ({ decision: "confirmed" }),
        describeConsent: () => ({ title: "t", detail: "d", confirmLabel: "Go" }),
        execute: async () => {
          ran = true;
          return badValue;
        },
      }).execute({}),
    );
    assert.equal(ran, true, "the action must have run");
    // null, not an error envelope: the side effect happened.
    assert.equal(result, null);
  });
}

// --- registration ----------------------------------------------------------
// Registration state is module-level, so these tests are order-dependent by
// design: every mutation (a mock host, a registration, an abort) lives inside
// a test body, and each test asserts the state the previous one left.
const seen = { incremental: 0, bulk: 0, options: [] };
const strictSeen = { options: [] };
let bareCalls = 0;
let controller;
let fallbackController;

const otherTool = defineReadTool({
  name: "other",
  description: "d",
  inputSchema: schema,
  parseArgs: parse,
  execute: async () => null,
});
const bulkTool = defineReadTool({
  name: "bulk_probe",
  description: "d",
  inputSchema: schema,
  parseArgs: parse,
  execute: async () => null,
});

function setModelContext(target, modelContext) {
  // Node exposes `navigator` as a getter-only global, so replace it outright.
  Object.defineProperty(globalThis, target, {
    configurable: true,
    writable: true,
    value: { modelContext },
  });
}

test("registration is a silent no-op with no host present", () => {
  assert.deepEqual(registerAgentTools([read]), {
    registered: false,
    reason: "unsupported",
  });
});

// A browser exposing BOTH styles must get incremental: it is the only one that
// takes `{ signal }`, and it is what the deployed reference registrar uses.
test("prefers incremental when a host offers both", () => {
  setModelContext("navigator", {
    registerTool(tool, options) {
      seen.incremental += 1;
      seen.options.push(options);
    },
    provideContext() {
      seen.bulk += 1;
    },
  });
  delete globalThis.__webmcpAgentToolsRegistered;
  controller = new AbortController();
  const registered = registerAgentTools([read], { signal: controller.signal });
  assert.equal(registered.registered, true);
  assert.equal(registered.style, "incremental");
  assert.equal(seen.incremental, 1);
  assert.equal(seen.bulk, 0);
});

test("passes the caller's AbortSignal through", () => {
  assert.equal(seen.options[0]?.signal, controller.signal);
});

// The forwarded bag must be the WebMCP `{ signal }` and nothing else. Our own
// `scope` option is idempotence bookkeeping; a host that validates the bag
// strictly would reject the unknown key and silently lose abort-scoping.
test("the host receives only { signal } — never the internal scope option", () => {
  assert.deepEqual(Object.keys(seen.options[0]), ["signal"]);
});

test("re-registration is idempotent", () => {
  assert.deepEqual(registerAgentTools([read]), {
    registered: false,
    reason: "already_registered",
  });
});

// Aborting a scoped registration must free the idempotence flags. A conforming
// host drops the tools on abort; if the flags stuck, the next mount would get
// `already_registered` and WebMCP would stay dead for the page's lifetime.
test("aborting a scoped registration allows re-registration", () => {
  controller.abort();
  const remount = new AbortController();
  const again = registerAgentTools([read], { signal: remount.signal });
  assert.equal(again.registered, true, "remount after abort must re-register");
  assert.equal(again.style, "incremental");
  // Leave the flags clear for the cases below. Aborting is the only way to do
  // that through the public API, which is itself the point of the fix.
  remount.abort();
});

test("an already-aborted signal registers nothing", () => {
  const preAborted = new AbortController();
  preAborted.abort();
  delete globalThis.__webmcpAgentToolsRegistered;
  assert.deepEqual(registerAgentTools([read], { signal: preAborted.signal }), {
    registered: false,
    reason: "aborted",
  });
});

// A host that rejects the options bag gets BARE registrations, which abort
// cannot remove. Releasing the flags there would let a remount register the
// same tool twice — duplicate executions and duplicate consent prompts.
test("falls back to a bare call when the options bag is rejected", () => {
  setModelContext("navigator", {
    registerTool(tool, options) {
      strictSeen.options.push(options);
      if (options) throw new TypeError("unsupported options bag");
      bareCalls += 1;
    },
  });
  delete globalThis.__webmcpAgentToolsRegistered;
  fallbackController = new AbortController();
  const fellBack = registerAgentTools([read], {
    signal: fallbackController.signal,
  });
  assert.equal(fellBack.registered, true);
  assert.equal(bareCalls, 1);
});

test("a strict host sees { signal } then the bare retry — never `scope`", () => {
  assert.equal(strictSeen.options[0]?.signal, fallbackController.signal);
  assert.deepEqual(Object.keys(strictSeen.options[0]), ["signal"]);
  assert.equal(strictSeen.options[1], undefined);
});

test("an unscoped fallback keeps the flags set on abort", () => {
  fallbackController.abort();
  assert.deepEqual(registerAgentTools([read]), {
    registered: false,
    reason: "already_registered",
  });
});

// Idempotence is scoped, not global: a different tool set is a different
// registration, even on the same page. The flag holds a map of scopes, so a
// second consumer (a widget beside the host app, say) is not locked out by a
// flag the first consumer set. This host rejects the options bag, so the
// registration lands via the bare fallback.
test("a different tool set is a different scope and registers", () => {
  const secondConsumer = registerAgentTools([otherTool]);
  assert.equal(secondConsumer.registered, true);
  assert.equal(secondConsumer.style, "incremental");
});

test("the same scope stays idempotent", () => {
  assert.deepEqual(registerAgentTools([otherTool]), {
    registered: false,
    reason: "already_registered",
  });
});

// A caller may name the scope explicitly instead of deriving it from names.
// With no signal there is nothing host-facing to send: the strict host must
// see a bare call, proving `scope` was never forwarded.
test("an explicit scope dedupes across different tool sets", () => {
  const before = strictSeen.options.length;
  assert.equal(
    registerAgentTools([read], { scope: "widget" }).registered,
    true,
  );
  assert.deepEqual(registerAgentTools([otherTool], { scope: "widget" }), {
    registered: false,
    reason: "already_registered",
  });
  assert.equal(
    strictSeen.options[before],
    undefined,
    "a scope-only call reaches the host bare",
  );
});

// navigator.modelContext that exists but exposes no registrar must not mask a
// working document.modelContext — the candidates are checked independently.
test("falls back to document.modelContext when navigator's is empty", () => {
  setModelContext("navigator", {});
  setModelContext("document", {
    provideContext({ tools }) {
      seen.bulk += tools.length;
    },
  });
  assert.deepEqual(registerAgentTools([bulkTool]), {
    registered: true,
    toolCount: 1,
    style: "bulk",
  });
});

// provideContext REPLACES the page's tool set. A second scope on a bulk-only
// host would silently unregister the first, so it is refused instead.
test("a different scope on a bulk-only host is refused, not allowed to wipe the first", () => {
  const before = seen.bulk;
  assert.deepEqual(registerAgentTools([otherTool], { scope: "second-bundle" }), {
    registered: false,
    reason: "bulk_conflict",
  });
  assert.equal(seen.bulk, before, "provideContext must not be called again");
});

test("the bulk owner's own scope stays idempotent, not a conflict", () => {
  assert.deepEqual(registerAgentTools([bulkTool]), {
    registered: false,
    reason: "already_registered",
  });
});

// provideContext REPLACES the page's tool set. A second scope calling it would
// silently erase the first scope's tools while both were told they registered,
// so the first bulk scope owns the page and a different one is refused.
test("a second scope on a bulk-only host is refused, not allowed to erase the first", () => {
  const before = seen.bulk;
  assert.deepEqual(registerAgentTools([otherTool], { scope: "second-bundle" }), {
    registered: false,
    reason: "bulk_conflict",
  });
  assert.equal(seen.bulk, before, "provideContext must not be called again");
});

test("the bulk owner's own scope stays idempotent, not a conflict", () => {
  assert.deepEqual(registerAgentTools([bulkTool]), {
    registered: false,
    reason: "already_registered",
  });
});

// The conflict exists only because bulk replaces. Incremental registration
// adds, so a host offering registerTool is unaffected by a prior bulk owner.
test("a bulk owner does not block incremental registration", () => {
  let incremental = 0;
  setModelContext("navigator", {
    registerTool() {
      incremental += 1;
    },
    provideContext() {
      throw new Error("bulk must not be used when incremental exists");
    },
  });
  assert.deepEqual(registerAgentTools([otherTool], { scope: "after-bulk" }), {
    registered: true,
    toolCount: 1,
    style: "incremental",
  });
  assert.equal(incremental, 1);
});

test("refusal envelopes are well formed", () => {
  assert.equal(consentRefusal("timeout").code, "consent_timeout");
});
