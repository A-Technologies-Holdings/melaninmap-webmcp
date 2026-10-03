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
  assert.deepEqual(Object.keys(request).sort(), ["argsDigest", "auditToken", "signal", "toolName"]);
  assert.equal(request.toolName, "hold_tickets");
  assert.equal(request.argsDigest, await argsDigest("hold_tickets", { eventId: "evt_1", quantity: 2 }));
  assert.equal(request.auditToken, "audit-1");
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(runs.length, 1);
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
  ["is not a function", "proof-please"],
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

test("arguments that cannot be digested fail closed without calling the exchange", async () => {
  let exchanges = 0;
  const { definition, runs } = tool({
    parseArgs: () => ({ when: new Date(0) }),
    exchangeConsent: async () => { exchanges += 1; return "p"; },
  });
  assert.equal(json(await definition.execute(call)).code, "consent_unverified");
  assert.equal(exchanges, 0);
  assert.equal(runs.length, 0);
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
  // The consent endpoint: your checks go here, then mint.
  const consentEndpoint = async ({ toolName, argsDigest: digest }) =>
    signConsentProof({ secret, toolName, argsDigest: digest, audience, ttlMs: 30_000 });
  // The action endpoint: recompute the digest from what it is about to do.
  const actionEndpoint = async (body) => verifyConsentProof({
    secret, audience, consume, proof: body.proof, toolName: "hold_tickets",
    argsDigest: await argsDigest("hold_tickets", body.args),
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
