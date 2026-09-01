/**
 * Behavioral smoke test against the BUILT output in dist/.
 *
 * Typechecking proves the shapes line up. It does not prove the consent gate
 * actually holds, and the gate is the whole product — so these assertions run
 * the compiled JavaScript the way a consumer would import it.
 *
 * Run: npm run build && npm run check:smoke
 */

import assert from "node:assert/strict";
import {
  defineReadTool,
  defineConsequentialTool,
  registerAgentTools,
  consentRefusal,
} from "../dist/index.js";

const parse = (raw) => raw;
const schema = { type: "object" };
const json = (result) => JSON.parse(result.content[0].text);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok   ${name}`);
}

// --- read tools ------------------------------------------------------------
const read = defineReadTool({
  name: "search",
  description: "d",
  inputSchema: schema,
  parseArgs: parse,
  execute: async () => ({ ok: true, items: [] }),
});
const readResult = json(await read.execute({}));
check("a read tool returns its payload", () =>
  assert.deepEqual(readResult, { ok: true, items: [] }),
);
check("a read tool is annotated read-only", () =>
  assert.equal(read.annotations.readOnlyHint, true),
);

// A side-effect-only execute resolves to undefined, and JSON.stringify(undefined)
// is undefined — which would put a non-string in a text block and turn a
// successful call into a malformed result.
const voidResult = await defineReadTool({
  name: "void",
  description: "d",
  inputSchema: schema,
  parseArgs: parse,
  execute: async () => undefined,
}).execute({});
check("a void result serialises as valid JSON", () => {
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
const readThrew = json(await defineReadTool(throwingParse).execute({}));
check("a throwing parseArgs becomes invalid_arguments (read)", () =>
  assert.equal(readThrew.code, "invalid_arguments"),
);
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
check("a throwing parseArgs becomes invalid_arguments (consequential)", () => {
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
  let ran = false;
  const result = json(
    await gated(async () => ({ decision }), () => {
      ran = true;
    }).execute({}),
  );
  check(`the action does not run on "${decision}"`, () => {
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
check("a throwing error mapper falls back instead of rejecting", () => {
  assert.equal(mapperThrew.ok, false);
  assert.equal(mapperThrew.code, "tool_unavailable");
});

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
check("a consent surface that throws fails CLOSED", () => {
  assert.equal(ranOnThrow, false);
  assert.equal(thrown.ok, false);
});

let ranOnConfirm = false;
const confirmed = json(
  await gated(async () => ({ decision: "confirmed", auditToken: "t" }), () => {
    ranOnConfirm = true;
  }).execute({}),
);
check("the action DOES run once confirmed", () => {
  assert.equal(ranOnConfirm, true);
  assert.deepEqual(confirmed, { ok: true });
});

// The audit token exists so it can be forwarded to a backend as evidence a
// confirmation was shown and answered. If execute cannot see it, the token is
// decoration and consumers reach for out-of-band shared state instead.
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
check("the confirmation and its audit token reach the action", () => {
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
  check(`a successful ${label} result is not reported as a failure`, () => {
    assert.equal(ran, true, "the action must have run");
    // null, not an error envelope: the side effect happened.
    assert.equal(result, null);
  });
}

// --- registration ----------------------------------------------------------
check("registration is a silent no-op with no host present", () =>
  assert.deepEqual(registerAgentTools([read]), {
    registered: false,
    reason: "unsupported",
  }),
);

// A browser exposing BOTH styles must get incremental: it is the only one that
// takes `{ signal }`, and it is what the deployed reference registrar uses.
const seen = { incremental: 0, bulk: 0, signals: [] };
// Node exposes `navigator` as a getter-only global, so replace it outright.
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: {
    modelContext: {
      registerTool(tool, options) {
        seen.incremental += 1;
        seen.signals.push(options?.signal);
      },
      provideContext() {
        seen.bulk += 1;
      },
    },
  },
});
delete globalThis.__webmcpAgentToolsRegistered;
const controller = new AbortController();
const registered = registerAgentTools([read], { signal: controller.signal });
check("prefers incremental when a host offers both", () => {
  assert.equal(registered.registered, true);
  assert.equal(registered.style, "incremental");
  assert.equal(seen.incremental, 1);
  assert.equal(seen.bulk, 0);
});
check("passes the caller's AbortSignal through", () =>
  assert.equal(seen.signals[0], controller.signal),
);
check("re-registration is idempotent", () =>
  assert.deepEqual(registerAgentTools([read]), {
    registered: false,
    reason: "already_registered",
  }),
);

// Aborting a scoped registration must free the idempotence flags. A conforming
// host drops the tools on abort; if the flags stuck, the next mount would get
// `already_registered` and WebMCP would stay dead for the page's lifetime.
controller.abort();
const remount = new AbortController();
check("aborting a scoped registration allows re-registration", () => {
  const again = registerAgentTools([read], { signal: remount.signal });
  assert.equal(again.registered, true, "remount after abort must re-register");
  assert.equal(again.style, "incremental");
});
// Leave the flags clear for the cases below. Aborting is the only way to do
// that through the public API, which is itself the point of the fix.
remount.abort();

const preAborted = new AbortController();
preAborted.abort();
delete globalThis.__webmcpAgentToolsRegistered;
check("an already-aborted signal registers nothing", () =>
  assert.deepEqual(registerAgentTools([read], { signal: preAborted.signal }), {
    registered: false,
    reason: "aborted",
  }),
);

// A host that rejects the options bag gets BARE registrations, which abort
// cannot remove. Releasing the flags there would let a remount register the
// same tool twice — duplicate executions and duplicate consent prompts.
let bareCalls = 0;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: {
    modelContext: {
      registerTool(tool, options) {
        if (options) throw new TypeError("unsupported options bag");
        bareCalls += 1;
      },
    },
  },
});
delete globalThis.__webmcpAgentToolsRegistered;
const fallbackController = new AbortController();
const fellBack = registerAgentTools([read], {
  signal: fallbackController.signal,
});
check("falls back to a bare call when the options bag is rejected", () => {
  assert.equal(fellBack.registered, true);
  assert.equal(bareCalls, 1);
});
fallbackController.abort();
check("an unscoped fallback keeps the flags set on abort", () =>
  assert.deepEqual(registerAgentTools([read]), {
    registered: false,
    reason: "already_registered",
  }),
);

check("refusal envelopes are well formed", () =>
  assert.equal(consentRefusal("timeout").code, "consent_timeout"),
);
