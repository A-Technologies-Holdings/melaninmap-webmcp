/**
 * The `busy` decision and the `onDecision` observer, against the built output.
 *
 * `busy` must reach the model as its own refusal — not as `closed` — so an
 * agent can tell "never shown" from "dismissed". `onDecision` must report
 * every gated call exactly once and must never be able to change, delay or
 * break the result.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { consentRefusal, defineConsequentialTool } from "../dist/index.js";

const json = (result) => JSON.parse(result.content[0].text);
const prompt = { title: "t", detail: "d", confirmLabel: "Go", timeoutMs: 20 };

function tool(overrides) {
  return defineConsequentialTool({
    name: "observed",
    description: "d",
    inputSchema: { type: "object" },
    parseArgs: (raw) => (raw.bad ? null : raw),
    consent: async () => ({ decision: "confirmed" }),
    describeConsent: () => prompt,
    execute: async () => ({ ok: true }),
    ...overrides,
  });
}

test("busy is its own refusal, distinct from closed, and permits one later retry", () => {
  const busy = consentRefusal("busy");
  const closed = consentRefusal("closed");
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "consent_busy");
  assert.notEqual(busy.message, closed.message);
  assert.match(busy.message, /already open/i);
  assert.match(busy.message, /retry this action once/i);
  assert.match(busy.message, /not retry in a loop/i);
});

test("an unknown decision never leaks into the refusal code", () => {
  assert.deepEqual(consentRefusal("yes"), consentRefusal("closed"));
  assert.deepEqual(consentRefusal("toString"), consentRefusal("closed"));
});

test("a surface answering busy refuses with consent_busy and never runs the action", async () => {
  let ran = false;
  const result = json(await tool({
    consent: async () => ({ decision: "busy" }),
    execute: async () => { ran = true; },
  }).execute({}));
  assert.deepEqual(result, consentRefusal("busy"));
  assert.equal(ran, false);
});

for (const decision of ["confirmed", "declined", "timeout", "closed", "busy"]) {
  test(`onDecision reports "${decision}" exactly once, as a plain record`, async () => {
    const records = [];
    await tool({
      consent: async () => ({ decision, auditToken: "secret-audit-token" }),
      onDecision: (record) => { records.push(record); },
    }).execute({ message: "private words" });
    assert.equal(records.length, 1);
    const [record] = records;
    // Exactly these keys: no arguments, no tokens.
    assert.deepEqual(Object.keys(record).sort(), ["decision", "elapsedMs", "toolName"]);
    assert.equal(record.toolName, "observed");
    assert.equal(record.decision, decision);
    assert.equal(typeof record.elapsedMs, "number");
    assert.ok(record.elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(record), /private words|secret-audit-token/);
  });
}

test("onDecision reports a surface that never answers as timeout", async () => {
  const records = [];
  await tool({ consent: () => new Promise(() => {}), onDecision: (r) => records.push(r.decision) }).execute({});
  assert.deepEqual(records, ["timeout"]);
});

test("onDecision reports a describeConsent that throws as closed", async () => {
  const records = [];
  const result = json(await tool({
    describeConsent: () => { throw new Error("no words"); },
    onDecision: (r) => records.push(r.decision),
  }).execute({}));
  assert.equal(result.code, "consent_closed");
  assert.deepEqual(records, ["closed"]);
});

test("onDecision reports cancelled when the host aborts an open prompt", async () => {
  const records = [];
  const controller = new AbortController();
  const pending = tool({
    consent: () => new Promise(() => {}),
    onDecision: (r) => records.push(r.decision),
  }).execute({}, { signal: controller.signal });
  controller.abort();
  assert.equal(json(await pending).code, "tool_cancelled");
  assert.deepEqual(records, ["cancelled"]);
});

test("onDecision reports cancelled when the host aborts as the person confirms", async () => {
  const records = [];
  const controller = new AbortController();
  let ran = false;
  const result = json(await tool({
    consent: async () => { controller.abort(); return { decision: "confirmed" }; },
    onDecision: (r) => records.push(r.decision),
    execute: async () => { ran = true; },
  }).execute({}, { signal: controller.signal }));
  assert.equal(result.code, "tool_cancelled");
  assert.equal(ran, false);
  assert.deepEqual(records, ["cancelled"]);
});

test("an observer that aborts the host signal stops the action", async () => {
  const controller = new AbortController();
  let ran = false;
  const result = json(await tool({
    onDecision: () => controller.abort(),
    execute: async () => { ran = true; },
  }).execute({}, { signal: controller.signal }));
  assert.equal(result.code, "tool_cancelled");
  assert.equal(ran, false);
});

test("calls that never reached the gate are not reported", async () => {
  const records = [];
  const observed = tool({ onDecision: (r) => records.push(r) });
  assert.equal(json(await observed.execute({ bad: true })).code, "invalid_arguments");
  const controller = new AbortController();
  controller.abort();
  assert.equal(json(await observed.execute({}, { signal: controller.signal })).code, "tool_cancelled");
  assert.deepEqual(records, []);
});

test("onDecision runs before the action, with the decision already final", async () => {
  const order = [];
  await tool({
    onDecision: () => order.push("decision"),
    execute: async () => { order.push("execute"); return { ok: true }; },
  }).execute({});
  assert.deepEqual(order, ["decision", "execute"]);
});

test("an observer that throws, rejects or misbehaves changes nothing", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const hostileThenable = { get then() { throw new Error("then getter"); } };
    const hostilePromise = Promise.resolve();
    Object.defineProperty(hostilePromise, "constructor", { get() { throw new Error("constructor getter"); } });
    for (const [label, onDecision] of [
      ["sync throw", () => { throw new Error("logger down"); }],
      ["rejected promise", async () => { throw new Error("logger down"); }],
      ["thenable whose then getter throws", () => hostileThenable],
      ["promise whose constructor getter throws", () => hostilePromise],
      ["not a function", "log it please"],
    ]) {
      for (const decision of ["confirmed", "declined"]) {
        let runs = 0;
        const result = json(await tool({
          consent: async () => ({ decision }),
          onDecision,
          execute: async () => { runs += 1; return { ok: true, ran: true }; },
        }).execute({}));
        if (decision === "confirmed") {
          assert.deepEqual(result, { ok: true, ran: true }, label);
          assert.equal(runs, 1, label);
        } else {
          assert.deepEqual(result, consentRefusal("declined"), label);
          assert.equal(runs, 0, label);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a slow observer is never awaited", { timeout: 1000 }, async () => {
  let release;
  const result = json(await tool({
    onDecision: () => new Promise((resolve) => { release = resolve; }),
  }).execute({}));
  assert.deepEqual(result, { ok: true });
  release();
});
