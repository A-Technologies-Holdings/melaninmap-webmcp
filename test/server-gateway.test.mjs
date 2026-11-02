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
import { createConsentGateway } from "../.test-build/examples/serverGateway.js";

const secret = "test-secret-that-is-at-least-32-bytes-long!";
const audience = "https://api.example.test/handoff";

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

function gateway() {
  const refusals = [];
  return {
    refusals,
    api: createConsentGateway({
      secret, audience, onRefusal: (reason) => refusals.push(reason),
    }),
  };
}

test("the gateway issues, verifies, acts once, and replays idempotently", async () => {
  const { api, refusals } = gateway();
  const base = { toolName: "hold_tickets", args: { eventId: "e1" }, remoteKey: "203.0.113.7" };
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
  assert.deepEqual(refusals, []);
});

test("the gateway refuses forgeries, replays and key conflicts identically", async () => {
  const { api, refusals } = gateway();
  const base = { toolName: "hold_tickets", args: { eventId: "e1" }, remoteKey: "203.0.113.7" };
  const action = async () => ({ holdId: "h1" });
  const forged = await api.performConsequentialAction(
    { ...base, proof: "v1.forged.nope", idempotencyKey: "r1" }, action,
  );
  assert.equal(forged.status, 403);
  assert.deepEqual(forged.body, { ok: false, error: "refused" });

  const issued = await api.issueConsentProof(base);
  const request = { ...base, proof: issued.body.proof, idempotencyKey: "r1" };
  await api.performConsequentialAction(request, action);
  const proofReplay = await api.performConsequentialAction(request, action);
  assert.equal(proofReplay.status, 403);
  assert.deepEqual(proofReplay.body, forged.body);

  const other = await api.issueConsentProof({ ...base, args: { eventId: "e2" } });
  const conflict = await api.performConsequentialAction(
    { ...base, args: { eventId: "e2" }, proof: other.body.proof, idempotencyKey: "r1" }, action,
  );
  assert.equal(conflict.status, 403);
  assert.ok(refusals.includes("replayed"));
  assert.ok(refusals.includes("idempotency_conflict"));
});

test("a shared gateway store isolates verified subjects and audiences", async () => {
  const idempotency = createInMemoryIdempotencyStore();
  let runs = 0;
  for (const [subject, scope] of [["alice", audience], ["bob", audience], ["alice", "https://api.example.test/other"]]) {
    const api = createConsentGateway({ secret, audience: scope, idempotency });
    const base = { subject, toolName: "hold_tickets", args: { eventId: "e1" }, remoteKey: "network" };
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
    idempotency: createInMemoryIdempotencyStore({ maxEntries: 1 }),
    onRefusal: reason => refusals.push(reason),
  });
  const base = { toolName: "hold_tickets", args: { eventId: "e1" }, remoteKey: "network" };
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
