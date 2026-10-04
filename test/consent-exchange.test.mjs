/**
 * The exchange step on defineConsequentialTool, against the built output.
 *
 * With `exchangeConsent`, a confirmation is necessary but not sufficient: the
 * action runs only once the host has traded it for a proof bound to this
 * exact call. Every way the exchange can fail must fail closed, and the
 * action must never run without a proof.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONSENT_EXCHANGE_TIMEOUT_MS,
  argsDigest,
  defineConsequentialTool,
} from "../dist/index.js";
import { signConsentProof, verifyConsentProof } from "../dist/server.js";

const json = (result) => JSON.parse(result.content[0].text);
const prompt = { title: "t", detail: "d", confirmLabel: "Go", timeoutMs: 1000 };

function tool(overrides) {
  const runs = [];
  const decisions = [];
  const definition = defineConsequentialTool({
    name: "hold_tickets",
    description: "d",
    inputSchema: { type: "object" },
    // The digest covers what parseArgs returns, not the raw input.
    parseArgs: (raw) => (raw.bad ? null : { eventId: String(raw.eventId), quantity: Number(raw.quantity) }),
    consent: async () => ({ decision: "confirmed", auditToken: "audit-1" }),
    describeConsent: () => prompt,
    execute: async (args, consent) => { runs.push({ args, consent }); return { ok: true }; },
    onDecision: (record) => decisions.push(record.decision),
    ...overrides,
  });
  return { definition, runs, decisions };
}

const call = { eventId: "evt_1", quantity: 2, ignored: "dropped by parseArgs" };

test("the exchange runs after confirmation and its proof reaches execute", async () => {
  const seen = [];
  const { definition, runs, decisions } = tool({
    exchangeConsent: async (request) => { seen.push(request); return "proof-123"; },
  });
  assert.deepEqual(json(await definition.execute(call)), { ok: true });
  assert.equal(seen.length, 1);
  const [request] = seen;
  assert.deepEqual(Object.keys(request).sort(), ["args", "argsDigest", "auditToken", "signal", "toolName"]);
  assert.equal(request.toolName, "hold_tickets");
  // The parsed arguments, as a frozen JSON snapshot: the consent endpoint
  // gets the operation itself, not just an opaque hash.
  assert.deepEqual(request.args, { eventId: "evt_1", quantity: 2 });
  assert.ok(Object.isFrozen(request.args));
  assert.equal(request.argsDigest, await argsDigest("hold_tickets", { eventId: "evt_1", quantity: 2 }));
  assert.equal(request.auditToken, "audit-1");
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].args, request.args, "execute receives the very snapshot that was bound");
  assert.deepEqual(runs[0].consent, { decision: "confirmed", auditToken: "audit-1", proof: "proof-123" });
  assert.deepEqual(decisions, ["confirmed"]);
});

test("no audit token means no auditToken key, not an undefined one", async () => {
  const seen = [];
  const { definition } = tool({
    consent: async () => ({ decision: "confirmed" }),
    exchangeConsent: (request) => { seen.push(request); return "p"; },
  });
  await definition.execute(call);
  assert.equal("auditToken" in seen[0], false);
});

test("without exchangeConsent there is no proof and nothing changes", async () => {
  const { definition, runs } = tool({});
  await definition.execute(call);
  assert.deepEqual(runs[0].consent, { decision: "confirmed", auditToken: "audit-1" });
});

for (const decision of ["declined", "timeout", "closed", "busy"]) {
  test(`a "${decision}" decision never reaches the exchange`, async () => {
    let exchanges = 0;
    const { definition, runs } = tool({
      consent: async () => ({ decision }),
      exchangeConsent: async () => { exchanges += 1; return "p"; },
    });
    assert.equal(json(await definition.execute(call)).code, `consent_${decision}`);
    assert.equal(exchanges, 0);
    assert.equal(runs.length, 0);
  });
}

for (const [label, exchangeConsent] of [
  ["throws", () => { throw new Error("endpoint down"); }],
  ["rejects", async () => { throw new Error("403"); }],
  ["resolves undefined", async () => undefined],
  ["resolves an empty string", async () => ""],
  ["resolves a number", async () => 42],
  ["resolves an object", async () => ({ proof: "p" })],
  ["resolves a String object", async () => new String("p")],
  ["returns a thenable whose then throws", () => ({ then() { throw new Error("x"); } })],
  ["returns a promise whose constructor getter throws", () => {
    const promise = Promise.resolve("p");
    Object.defineProperty(promise, "constructor", { get() { throw new Error("ctor"); } });
    return promise;
  }],
]) {
  test(`an exchange that ${label} fails closed as consent_unverified`, async () => {
    const { definition, runs, decisions } = tool({ exchangeConsent });
    const result = json(await definition.execute(call));
    assert.equal(result.ok, false);
    assert.equal(result.code, "consent_unverified");
    assert.match(result.message, /could not be verified/);
    assert.match(result.message, /Do not retry automatically/);
    assert.equal(runs.length, 0, "the action never runs without a proof");
    assert.deepEqual(decisions, ["unverified"]);
  });
}

test("an exchange that is not a function fails closed before anyone is asked", async () => {
  let prompts = 0;
  const { definition, runs, decisions } = tool({
    consent: async () => { prompts += 1; return { decision: "confirmed" }; },
    exchangeConsent: "proof-please",
  });
  const result = json(await definition.execute(call));
  assert.equal(result.code, "consent_unverified");
  assert.match(result.message, /was not asked/);
  assert.equal(prompts, 0);
  assert.equal(runs.length, 0);
  assert.deepEqual(decisions, [], "no decision was reached");
});

// Digest first, prompt second: a person must never confirm a call that can
// never be verified.
for (const [label, parseArgs] of [
  ["a Date", () => ({ when: new Date(0) })],
  ["undefined", () => undefined],
  ["NaN", () => ({ n: NaN })],
]) {
  test(`arguments holding ${label} are invalid_arguments, and nobody is prompted`, async () => {
    let prompts = 0;
    let exchanges = 0;
    const { definition, runs } = tool({
      parseArgs,
      consent: async () => { prompts += 1; return { decision: "confirmed" }; },
      exchangeConsent: async () => { exchanges += 1; return "p"; },
    });
    assert.equal(json(await definition.execute(call)).code, "invalid_arguments");
    assert.equal(prompts, 0);
    assert.equal(exchanges, 0);
    assert.equal(runs.length, 0);
  });
}

test("a tool with no arguments works with an exchange when parseArgs returns {}", async () => {
  const seen = [];
  const { definition, runs } = tool({
    parseArgs: () => ({}),
    exchangeConsent: (request) => { seen.push(request); return "p"; },
  });
  assert.deepEqual(json(await definition.execute({})), { ok: true });
  assert.equal(seen[0].argsDigest, await argsDigest("hold_tickets", {}));
  assert.equal(runs.length, 1);
});

// The arguments are pinned before the prompt. Nothing that runs afterwards —
// describeConsent, a getter, the exchange itself — can change what the
// person saw into something else that gets bound and executed.
test("what the person saw is what gets bound and executed", async () => {
  const parsed = { eventId: "evt_1", quantity: 2 };
  let reads = 0;
  const shown = [];
  const seen = [];
  const { definition, runs } = tool({
    parseArgs: () => parsed,
    describeConsent: (args) => {
      shown.push(args.quantity);
      parsed.quantity = 200; // mutate the original after it was pinned
      try { args.quantity = 300; } catch { /* the snapshot is frozen */ }
      return prompt;
    },
    exchangeConsent: (request) => { seen.push(request.args.quantity); return "p"; },
  });
  await definition.execute(call);
  assert.deepEqual(shown, [2]);
  assert.deepEqual(seen, [2]);
  assert.equal(runs[0].args.quantity, 2);
  assert.equal(runs[0].consent.proof, "p");

  const withGetter = tool({
    parseArgs: () => ({ get quantity() { reads += 1; return reads === 1 ? 2 : 200; } }),
    describeConsent: (args) => { shown.push(args.quantity); return prompt; },
    exchangeConsent: (request) => { seen.push(request.args.quantity); return "p"; },
  });
  await withGetter.definition.execute(call);
  assert.equal(reads, 1, "the getter is read once, when pinned");
  assert.deepEqual(shown, [2, 2]);
  assert.deepEqual(seen, [2, 2]);
  assert.equal(withGetter.runs[0].args.quantity, 2);
});

test("a cancellation that lands after the proof but before execute cancels", async () => {
  const controller = new AbortController();
  const { definition, runs, decisions } = tool({
    exchangeConsent: () => {
      // Cancel the host call one microtask after the gate takes the proof,
      // before execute can start.
      const proof = Promise.resolve("proof-in-hand");
      proof.then(() => queueMicrotask(() => controller.abort()));
      return proof;
    },
  });
  assert.equal(json(await definition.execute(call, { signal: controller.signal })).code, "tool_cancelled");
  assert.equal(runs.length, 0);
  assert.deepEqual(decisions, ["cancelled"]);
});

test("a successful exchange's signal is left alone for work it bound to it", async () => {
  let exchangeSignal;
  const { definition, runs } = tool({
    exchangeConsent: (request) => { exchangeSignal = request.signal; return "proof-in-hand"; },
  });
  await definition.execute(call);
  assert.equal(runs.length, 1);
  assert.equal(exchangeSignal.aborted, false);
});

test("the host cancelling during the exchange cancels the call and aborts the exchange", async () => {
  const controller = new AbortController();
  let exchangeSignal;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const { definition, runs, decisions } = tool({
    exchangeConsent: (request) => { exchangeSignal = request.signal; started(); return new Promise(() => {}); },
  });
  const pending = definition.execute(call, { signal: controller.signal });
  await running;
  controller.abort();
  assert.equal(json(await pending).code, "tool_cancelled");
  assert.equal(exchangeSignal.aborted, true);
  assert.equal(runs.length, 0);
  assert.deepEqual(decisions, ["cancelled"]);
});

test("a proof that arrives after cancellation is never used", async () => {
  const controller = new AbortController();
  const { definition, runs } = tool({
    exchangeConsent: async () => { controller.abort(); return "late-proof"; },
  });
  assert.equal(json(await definition.execute(call, { signal: controller.signal })).code, "tool_cancelled");
  assert.equal(runs.length, 0);
});

test("an exchange that never answers fails closed at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let exchangeSignal;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const { definition, runs, decisions } = tool({
    exchangeConsent: (request) => { exchangeSignal = request.signal; started(); return new Promise(() => {}); },
  });
  const pending = definition.execute(call);
  await running;
  t.mock.timers.tick(CONSENT_EXCHANGE_TIMEOUT_MS);
  assert.equal(json(await pending).code, "consent_unverified");
  assert.equal(exchangeSignal.aborted, true, "the exchange is told nobody is waiting");
  assert.equal(runs.length, 0);
  assert.deepEqual(decisions, ["unverified"]);
});

// The whole loop, page to server: a proof minted for the confirmed call
// verifies at the action endpoint for those arguments, and only those.
test("end to end: exchange, execute, verify; a swapped argument does not verify", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const audience = "https://api.example.test/hold";
  const used = new Set();
  const consume = async (nonce) => (used.has(nonce) ? false : (used.add(nonce), true));
  // The consent endpoint: your checks go here — which tools may be
  // exchanged, ceilings on the arguments — then mint from the args.
  const consentEndpoint = async ({ toolName, args }) => {
    if (toolName !== "hold_tickets" || !(args.quantity >= 1 && args.quantity <= 8)) throw new Error("403");
    return signConsentProof({ secret, toolName, args, audience, ttlMs: 30_000 });
  };
  // The action endpoint: verify against the args it is about to act on.
  const actionEndpoint = async (body) => verifyConsentProof({
    secret, audience, consume, proof: body.proof, toolName: "hold_tickets", args: body.args,
  });
  const responses = [];
  const { definition } = tool({
    exchangeConsent: (request) => consentEndpoint(request),
    execute: async (args, consent) => {
      responses.push(await actionEndpoint({ args, proof: consent.proof }));
      // A script that captured the proof tries it on bigger arguments, then replays it.
      responses.push(await actionEndpoint({ args: { ...args, quantity: 200 }, proof: consent.proof }));
      responses.push(await actionEndpoint({ args, proof: consent.proof }));
      return { ok: true };
    },
  });
  await definition.execute(call);
  assert.equal(responses[0].ok, true);
  assert.deepEqual(responses[1], { ok: false, reason: "wrong_args" });
  assert.deepEqual(responses[2], { ok: false, reason: "replayed" });
});
