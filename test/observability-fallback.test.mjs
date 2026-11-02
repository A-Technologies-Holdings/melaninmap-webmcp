/**
 * Observability aggregates and the unsupported-host fallback.
 *
 * Metrics must never see arguments or tokens, alerts must not fire on
 * anecdotes, and the fallback must run only when the platform is missing —
 * never for a caller bug that a second presentation would compound.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDecisionMetrics,
  defineConsequentialTool,
  evaluateDecisionAlerts,
  registerAgentToolsWithFallback,
  toAuditLogRecord,
} from "../dist/index.js";

// --- metrics ------------------------------------------------------------------

test("metrics aggregate decisions per kind and per tool, without payloads", async () => {
  const metrics = createDecisionMetrics();
  const tool = (name, decision) => defineConsequentialTool({
    name,
    description: "d",
    inputSchema: { type: "object" },
    parseArgs: (raw) => raw,
    consent: async () => ({ decision, auditToken: "must-not-appear" }),
    describeConsent: () => ({ title: "t", detail: "d", confirmLabel: "Go" }),
    execute: async () => ({ ok: true }),
    onDecision: metrics.observer,
  });
  await tool("hold", "confirmed").execute({ secret: "argument" });
  await tool("hold", "declined").execute({});
  await tool("send", "timeout").execute({});

  const snap = metrics.snapshot();
  assert.equal(snap.total, 3);
  assert.deepEqual(snap.byDecision, { confirmed: 1, declined: 1, timeout: 1 });
  assert.equal(snap.rates.confirmed, 1 / 3);
  assert.equal(snap.byTool.hold.total, 2);
  assert.equal(snap.byTool.send.byDecision.timeout, 1);
  assert.ok(!JSON.stringify(snap).includes("must-not-appear"));
  assert.ok(!JSON.stringify(snap).includes("argument"));

  metrics.reset();
  assert.equal(metrics.snapshot().total, 0);
});

test("a metrics observer survives hostile records and snapshot mutation", () => {
  const metrics = createDecisionMetrics();
  metrics.observer(null);
  metrics.observer({ toolName: 42, decision: undefined, elapsedMs: -5 });
  const snap = metrics.snapshot();
  snap.byDecision.closed = 999;
  assert.equal(metrics.snapshot().byDecision.closed, 2);
});

// --- alerts -------------------------------------------------------------------

function snapshotWith(byDecision, total = 100) {
  const rates = {};
  for (const [k, v] of Object.entries(byDecision)) rates[k] = v / total;
  return { total, byDecision, rates, byTool: {} };
}

test("alerts fire only over threshold and only with enough samples", () => {
  const snap = snapshotWith({ confirmed: 60, timeout: 30, busy: 10 });
  const alerts = evaluateDecisionAlerts(snap, { timeoutRate: 0.25, busyRate: 0.05 });
  assert.deepEqual(alerts.map((a) => a.kind).sort(), ["busy_rate", "timeout_rate"]);
  assert.equal(alerts[0].toolName, null);

  const anecdote = evaluateDecisionAlerts(
    { total: 3, byDecision: { timeout: 3 }, rates: { timeout: 1 }, byTool: {} },
    { timeoutRate: 0.25 },
  );
  assert.deepEqual(anecdote, []);
  assert.deepEqual(evaluateDecisionAlerts(snap, {}), []);
});

// --- audit records --------------------------------------------------------------

test("audit records are versioned, JSON-safe and carry no token or args", () => {
  const record = toAuditLogRecord(
    { toolName: "hold_tickets", decision: "confirmed", elapsedMs: 1234 },
    new Date("2026-10-14T00:00:00.000Z"),
  );
  assert.deepEqual(record, {
    v: 1,
    type: "webmcp.consent.decision",
    toolName: "hold_tickets",
    decision: "confirmed",
    elapsedMs: 1234,
    at: "2026-10-14T00:00:00.000Z",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

// --- fallback -------------------------------------------------------------------

const readTool = {
  name: "search",
  description: "d",
  inputSchema: { type: "object" },
  execute: async () => ({}),
};

test("on an unsupported host the fallback runs once and is reported", async () => {
  // Node has no document.modelContext: the honest unsupported path.
  let calls = 0;
  const result = await registerAgentToolsWithFallback([readTool], {
    onUnsupported: () => { calls += 1; },
  });
  assert.equal(result.registered, false);
  assert.equal(result.reason, "unsupported");
  assert.equal(result.fallbackInvoked, true);
  assert.equal(calls, 1);
});

test("a throwing or rejecting fallback never changes the result", async () => {
  const thrown = await registerAgentToolsWithFallback([readTool], {
    onUnsupported: () => { throw new Error("fallback down"); },
  });
  assert.equal(thrown.fallbackInvoked, true);
  const rejected = await registerAgentToolsWithFallback([readTool], {
    onUnsupported: async () => { throw new Error("fallback down"); },
  });
  assert.equal(rejected.reason, "unsupported");
});

test("invalid tools never invoke the fallback", async () => {
  let calls = 0;
  const result = await registerAgentToolsWithFallback(
    [{ ...readTool, name: "not a valid name!" }],
    { onUnsupported: () => { calls += 1; } },
  );
  assert.equal(result.reason, "invalid_tool");
  assert.equal(result.fallbackInvoked, false);
  assert.equal(calls, 0);
});
