/**
 * Reference server primitives and the copyable gateway example.
 *
 * Single use, rate limiting and idempotency are where server deployments
 * fail quietly: a replayed proof acting twice, a limiter keyed on a value
 * the caller rotates, a retried request re-running the action. These run
 * against the built output and the compiled example the way a consumer
 * would wire them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInMemoryIdempotencyStore,
  createInMemoryNonceLedger,
  createRateLimiter,
  signConsentProof,
  verifyConsentProof,
} from "../dist/server.js";
import {
  createConsentGateway,
  createHoldTicketsAuthorizationPolicy,
} from "../.test-build/examples/serverGateway.js";

const secret = "test-secret-that-is-at-least-32-bytes-long!";
const audience = "https://api.example.test/handoff";
const policyNow = 1_800_000_000_000;

const recommendationId = (subject, eventId) => `rec-${subject}-${eventId}`;
const recommendations = new Map();
for (const subject of ["alice", "bob"]) {
  for (const eventId of ["e1", "e2"]) {
    const id = recommendationId(subject, eventId);
    recommendations.set(id, {
      recommendationId: id,
      subject,
      eventId,
      maxQuantity: eventId === "e1" ? 4 : 2,
      expiresAt: policyNow + 60_000,
    });
  }
}
recommendations.set("rec-expired", {
  recommendationId: "rec-expired",
  subject: "alice",
  eventId: "e1",
  maxQuantity: 4,
  expiresAt: policyNow,
});
const authorizeHoldTickets = createHoldTicketsAuthorizationPolicy({
  loadRecommendation: (id) => recommendations.get(id),
  now: () => policyNow,
});
const ticketArgs = (subject = "alice", eventId = "e1", quantity = 2) => ({
  recommendationId: recommendationId(subject, eventId),
  eventId,
  quantity,
});

// --- nonce ledger -----------------------------------------------------------

test("a nonce spends once, including concurrently, then is refused", async () => {
  const ledger = createInMemoryNonceLedger();
  const until = Date.now() + 60_000;
  const [first, second] = await Promise.all([
    ledger.consume("nonce-1", until),
    ledger.consume("nonce-1", until),
  ]);
  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(await ledger.consume("nonce-1", until), false);
  assert.equal(ledger.size, 1);
});

test("expired nonce records are evicted and cannot block memory forever", async () => {
  const ledger = createInMemoryNonceLedger();
  await ledger.consume("old", Date.now() - 1);
  assert.equal(ledger.prune(), 1);
  assert.equal(ledger.size, 0);
});

test("capacity refuses new nonces without evicting live replay records", async () => {
  const ledger = createInMemoryNonceLedger({ maxEntries: 1 });
  const until = Date.now() + 60_000;
  assert.equal(await ledger.consume("first", until), true);
  assert.equal(await ledger.consume("second", until), false);
  assert.equal(await ledger.consume("first", until), false);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.prune(until), 1);
  assert.equal(await ledger.consume("second", until + 60_000), true);
});

test("a proof replayed through the real verifier is refused as replayed", async () => {
  const ledger = createInMemoryNonceLedger();
  const proof = await signConsentProof({
    secret, toolName: "hold_tickets", args: { eventId: "e1" }, audience, ttlMs: 60_000,
  });
  const verify = () => verifyConsentProof({
    secret, proof, toolName: "hold_tickets", args: { eventId: "e1" }, audience,
    consume: ledger.consume,
  });
  assert.equal((await verify()).ok, true);
  const replay = await verify();
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "replayed");
});

// --- rate limiter -----------------------------------------------------------

test("the limiter allows up to the limit, then denies with a retry delay", () => {
  let now = 1_000_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
  assert.equal(limiter.check("203.0.113.7").allowed, true);
  assert.equal(limiter.check("203.0.113.7").allowed, true);
  const denied = limiter.check("203.0.113.7");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000);
  now += 60_000;
  assert.equal(limiter.check("203.0.113.7").allowed, true);
});

test("the limiter fails closed on a missing key and isolates keys", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
  assert.equal(limiter.check("").allowed, false);
  assert.equal(limiter.check(undefined).allowed, false);
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("b").allowed, true);
  assert.equal(limiter.check("a").allowed, false);
});

// --- idempotency ------------------------------------------------------------

test("idempotency runs once, replays the result, and conflicts on new args", async () => {
  const store = createInMemoryIdempotencyStore();
  let runs = 0;
  const run = async () => { runs += 1; return { holdId: "h1" }; };
  const first = await store.execute("key-1", "digest-a", run);
  const replay = await store.execute("key-1", "digest-a", run);
  const conflict = await store.execute("key-1", "digest-b", run);
  assert.equal(first.status, "executed");
  assert.equal(replay.status, "replayed");
  assert.deepEqual(replay.value, { holdId: "h1" });
  assert.equal(conflict.status, "conflict");
  assert.equal(runs, 1);
});

test("concurrent duplicates share one run; failures are not cached", async () => {
  const store = createInMemoryIdempotencyStore();
  let runs = 0;
  const slow = async () => { runs += 1; await new Promise((r) => setTimeout(r, 10)); return runs; };
  const [a, b] = await Promise.all([
    store.execute("k", "d", slow),
    store.execute("k", "d", slow),
  ]);
  assert.equal(runs, 1);
  assert.deepEqual([a.status, b.status].sort(), ["executed", "replayed"]);
  await assert.rejects(store.execute("k2", "d", async () => { throw new Error("down"); }));
  const retried = await store.execute("k2", "d", async () => "ok");
  assert.equal(retried.status, "executed");
});

// --- gateway composition ------------------------------------------------------

function gateway(overrides = {}) {
  const refusals = [];
  return {
    refusals,
    api: createConsentGateway({
      secret,
      audience,
      authorize: authorizeHoldTickets,
      ...overrides,
      onRefusal: (reason) => refusals.push(reason),
    }),
  };
}

test("the gateway fails closed when no authorization policy is configured", async () => {
  const api = createConsentGateway({ secret, audience });
  const response = await api.issueConsentProof({
    toolName: "hold_tickets",
    args: ticketArgs(),
    remoteKey: "203.0.113.7",
    authenticatedSubject: "alice",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { ok: false, error: "refused" });
  assert.equal(response.body.proof, undefined);
});

test("the ticket policy rejects unlisted tools, unsafe arguments and unbound state", async () => {
  const { api, refusals } = gateway();
  const base = {
    toolName: "hold_tickets",
    args: ticketArgs(),
    remoteKey: "203.0.113.7",
    authenticatedSubject: "alice",
  };
  const attempts = [
    { ...base, toolName: "cancel_tickets" },
    { ...base, args: ticketArgs("alice", "e1", 9) },
    { ...base, args: ticketArgs("alice", "e2", 3) },
    { ...base, args: { ...ticketArgs(), eventId: "e2" } },
    { ...base, authenticatedSubject: "bob" },
    { ...base, args: { recommendationId: "unknown", eventId: "e1", quantity: 1 } },
    { ...base, args: { recommendationId: "rec-expired", eventId: "e1", quantity: 1 } },
    { ...base, args: { ...ticketArgs(), admin: true } },
    { ...base, authenticatedSubject: "" },
  ];
  for (const attempt of attempts) {
    const response = await api.issueConsentProof(attempt);
    assert.equal(response.status, 403);
    assert.equal(response.body.proof, undefined);
  }
  assert.equal(refusals.length, attempts.length);
  assert.ok(refusals.includes("not_authorized"));
  assert.ok(refusals.includes("unauthenticated"));
});

test("the gateway signs and executes only the policy-normalized operation", async () => {
  const normalizedArgs = ticketArgs();
  const { api } = gateway({
    authorize: async () => ({
      authorized: true,
      operation: { toolName: "hold_tickets", args: normalizedArgs },
    }),
  });
  const callerOperation = {
    toolName: "caller_selected_operation",
    args: { target: "everything" },
    remoteKey: "203.0.113.7",
    authenticatedSubject: "alice",
  };
  const issued = await api.issueConsentProof(callerOperation);
  assert.equal(issued.status, 200);
  const callerVerification = await verifyConsentProof({
    secret,
    proof: issued.body.proof,
    toolName: callerOperation.toolName,
    args: callerOperation.args,
    audience,
    subject: "alice",
    consume: async () => true,
  });
  assert.equal(callerVerification.ok, false);
  assert.equal(callerVerification.reason, "wrong_tool");

  let actedWith;
  const result = await api.performConsequentialAction(
    { ...callerOperation, proof: issued.body.proof, idempotencyKey: "normalized-1" },
    async (args) => { actedWith = args; return { holdId: "h1" }; },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(actedWith, normalizedArgs);
});

test("the gateway issues, verifies, acts once, and replays idempotently", async () => {
  const { api, refusals } = gateway();
  const base = {
    toolName: "hold_tickets", args: ticketArgs(), remoteKey: "203.0.113.7",
    authenticatedSubject: "alice",
  };
  const issued = await api.issueConsentProof(base);
  assert.equal(issued.status, 200);
  let acts = 0;
  const action = async () => { acts += 1; return { holdId: "h1" }; };
  const request = { ...base, proof: issued.body.proof, idempotencyKey: "req-1" };
  const first = await api.performConsequentialAction(request, action);
  assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false);

  // A fresh proof for the same logical request replays instead of acting.
  const reissued = await api.issueConsentProof(base);
  const replay = await api.performConsequentialAction(
    { ...request, proof: reissued.body.proof }, action,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(acts, 1);
  const spentFreshProof = await api.performConsequentialAction(
    { ...request, proof: reissued.body.proof, idempotencyKey: "req-2" }, action,
  );
  assert.equal(spentFreshProof.status, 403);
  assert.equal(acts, 1);
  assert.deepEqual(refusals, ["replayed"]);
});

test("an exact authenticated retry returns a dropped result without acting twice", async () => {
  const ledger = createInMemoryNonceLedger();
  const idempotency = createInMemoryIdempotencyStore();
  const authenticatedRetries = createInMemoryIdempotencyStore();
  const options = {
    secret, audience, ledger, idempotency, authenticatedRetries,
    authorize: authorizeHoldTickets,
  };
  const firstInstance = createConsentGateway(options);
  const retryInstance = createConsentGateway(options);
  const base = {
    toolName: "hold_tickets", args: ticketArgs(), remoteKey: "network",
    authenticatedSubject: "alice",
  };
  const issued = await firstInstance.issueConsentProof(base);
  const request = { ...base, proof: issued.body.proof, idempotencyKey: "dropped-response" };
  let acts = 0;
  const action = async () => { acts += 1; return { holdId: "h1" }; };

  // The action committed, but its first response never reached the caller.
  const committed = await firstInstance.performConsequentialAction(request, action);
  assert.equal(committed.status, 200);
  assert.equal(committed.body.replayed, false);
  const retried = await retryInstance.performConsequentialAction(request, action);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.replayed, true);
  assert.deepEqual(retried.body.value, { holdId: "h1" });
  assert.equal(acts, 1);
});

test("refused retry outcomes do not occupy authenticated-retry capacity", async () => {
  const ledger = createInMemoryNonceLedger();
  const idempotency = createInMemoryIdempotencyStore();
  const authenticatedRetries = createInMemoryIdempotencyStore({ maxEntries: 3 });
  const options = {
    secret, audience, ledger, idempotency, authenticatedRetries,
    authorize: authorizeHoldTickets,
  };
  const api = createConsentGateway(options);
  const base = {
    toolName: "hold_tickets", args: ticketArgs(), remoteKey: "network",
    authenticatedSubject: "alice",
  };
  const issued = await api.issueConsentProof(base);
  const action = async () => ({ holdId: "h1" });
  const first = await api.performConsequentialAction(
    { ...base, proof: issued.body.proof, idempotencyKey: "k0" }, action,
  );
  assert.equal(first.status, 200);
  // One spent proof resubmitted under many keys must not fill the store.
  for (const key of ["k1", "k2", "k3", "k4"]) {
    const replay = await api.performConsequentialAction(
      { ...base, proof: issued.body.proof, idempotencyKey: key }, action,
    );
    assert.equal(replay.status, 403);
  }
  const fresh = await api.issueConsentProof(base);
  const legitimate = await api.performConsequentialAction(
    { ...base, proof: fresh.body.proof, idempotencyKey: "legit" }, action,
  );
  assert.equal(legitimate.status, 200);
});

test("a missing idempotency key does not consume an otherwise valid proof", async () => {
  const { api, refusals } = gateway();
  const base = {
    toolName: "hold_tickets", args: ticketArgs(), remoteKey: "network",
    authenticatedSubject: "alice",
  };
  const issued = await api.issueConsentProof(base);
  let acts = 0;
  const missing = await api.performConsequentialAction(
    { ...base, proof: issued.body.proof }, async () => ++acts,
  );
  assert.equal(missing.status, 403);
  const accepted = await api.performConsequentialAction(
    { ...base, proof: issued.body.proof, idempotencyKey: "present" }, async () => ++acts,
  );
  assert.equal(accepted.status, 200);
  assert.equal(acts, 1);
  assert.deepEqual(refusals, ["missing_idempotency_key"]);
});

test("the gateway refuses forgeries, cross-key proof replays and key conflicts identically", async () => {
  const { api, refusals } = gateway();
  const base = {
    toolName: "hold_tickets", args: ticketArgs(), remoteKey: "203.0.113.7",
    authenticatedSubject: "alice",
  };
  const action = async () => ({ holdId: "h1" });
  const forged = await api.performConsequentialAction(
    { ...base, proof: "v1.forged.nope", idempotencyKey: "r1" }, action,
  );
  assert.equal(forged.status, 403);
  assert.deepEqual(forged.body, { ok: false, error: "refused" });

  const issued = await api.issueConsentProof(base);
  const request = { ...base, proof: issued.body.proof, idempotencyKey: "r1" };
  await api.performConsequentialAction(request, action);
  const proofReplay = await api.performConsequentialAction(
    { ...request, idempotencyKey: "r2" }, action,
  );
  assert.equal(proofReplay.status, 403);
  assert.deepEqual(proofReplay.body, forged.body);

  const other = await api.issueConsentProof({ ...base, args: ticketArgs("alice", "e2") });
  const conflict = await api.performConsequentialAction(
    { ...base, args: ticketArgs("alice", "e2"), proof: other.body.proof, idempotencyKey: "r1" }, action,
  );
  assert.equal(conflict.status, 403);
  assert.ok(refusals.includes("replayed"));
  assert.ok(refusals.includes("idempotency_conflict"));
});

test("a shared gateway store isolates verified subjects and audiences", async () => {
  const idempotency = createInMemoryIdempotencyStore();
  let runs = 0;
  for (const [subject, scope] of [["alice", audience], ["bob", audience], ["alice", "https://api.example.test/other"]]) {
    const api = createConsentGateway({
      secret, audience: scope, idempotency, authorize: authorizeHoldTickets,
    });
    const base = {
      authenticatedSubject: subject, toolName: "hold_tickets",
      args: ticketArgs(subject), remoteKey: "network",
    };
    const issued = await api.issueConsentProof(base);
    const response = await api.performConsequentialAction(
      { ...base, proof: issued.body.proof, idempotencyKey: "same-key" },
      async () => { runs += 1; return { subject, scope }; },
    );
    assert.equal(response.body.replayed, false);
    assert.deepEqual(response.body.value, { subject, scope });
  }
  assert.equal(runs, 3);
});

test("capacity never evicts retained results and recovers after expiry", async () => {
  let now = 0;
  const store = createInMemoryIdempotencyStore({ maxEntries: 1, ttlMs: 10, now: () => now });
  let runs = 0;
  const run = async () => ++runs;
  await store.execute("a", "digest", run);
  assert.equal((await store.execute("b", "digest", run)).status, "capacity_exceeded");
  assert.equal((await store.execute("a", "digest", run)).status, "replayed");
  assert.equal(runs, 1);
  now = 10;
  assert.equal((await store.execute("b", "digest", run)).status, "executed");
  assert.equal(runs, 2);
});

test("pending actions remain deduplicated beyond ttl and under capacity pressure", async () => {
  let now = 0;
  const store = createInMemoryIdempotencyStore({ maxEntries: 1, ttlMs: 10, now: () => now });
  let finish;
  let runs = 0;
  const first = store.execute("a", "digest", async () => { runs += 1; return new Promise(resolve => { finish = resolve; }); });
  await Promise.resolve();
  now = 100;
  assert.equal((await store.execute("b", "digest", async () => ++runs)).status, "capacity_exceeded");
  const duplicate = store.execute("a", "digest", async () => ++runs);
  finish("done");
  assert.equal((await first).value, "done");
  assert.equal((await duplicate).value, "done");
  assert.equal(runs, 1);
  assert.equal((await store.execute("a", "digest", async () => ++runs)).status, "replayed");
});

test("gateway refuses capacity exhaustion without running the action", async () => {
  const refusals = [];
  const api = createConsentGateway({ secret, audience,
    authorize: authorizeHoldTickets,
    idempotency: createInMemoryIdempotencyStore({ maxEntries: 1 }),
    onRefusal: reason => refusals.push(reason),
  });
  const base = {
    toolName: "hold_tickets", args: ticketArgs(), remoteKey: "network",
    authenticatedSubject: "alice",
  };
  let runs = 0;
  for (const key of ["a", "b", "a"]) {
    const issued = await api.issueConsentProof(base);
    const result = await api.performConsequentialAction(
      { ...base, proof: issued.body.proof, idempotencyKey: key }, async () => ++runs,
    );
    assert.equal(result.status, key === "b" ? 403 : 200);
  }
  assert.equal(runs, 1);
  assert.deepEqual(refusals, ["idempotency_capacity"]);
});

test("the action route has an independent per-network-key limit", async () => {
  const { api, refusals } = gateway({ actionLimit: { limit: 1, windowMs: 60_000 } });
  const base = {
    toolName: "hold_tickets", args: ticketArgs(), remoteKey: "network",
    authenticatedSubject: "alice",
  };
  const firstProof = await api.issueConsentProof(base);
  const secondProof = await api.issueConsentProof(base);
  let runs = 0;
  const action = async () => ++runs;
  assert.equal((await api.performConsequentialAction(
    { ...base, proof: firstProof.body.proof, idempotencyKey: "action-1" }, action,
  )).status, 200);
  assert.equal((await api.performConsequentialAction(
    { ...base, proof: secondProof.body.proof, idempotencyKey: "action-2" }, action,
  )).status, 403);
  assert.equal(runs, 1);
  assert.deepEqual(refusals, ["action_rate_limited"]);
});
