/**
 * The consent queue's contract, against the built output.
 *
 * Every UI binding — the DOM example, the React hook, whatever a host writes —
 * relies on these rules, so they are tested here once, without any UI: one
 * request displayed at a time, a bounded queue that answers `busy`, deadlines
 * counted from enqueue, cancellation, and every answer bound to the request
 * that was on screen.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONSENT_QUEUE_DEFAULT_CAPACITY,
  createConsentQueue,
  defineConsequentialTool,
} from "../dist/index.js";

const ask = (title, timeoutMs = 1000) => ({ title, detail: `${title} detail`, confirmLabel: "Go", timeoutMs });
const trusted = { isTrusted: true };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Settle whatever is displayed until the queue is empty, so no timer outlives a test. */
async function drain(queue, pending) {
  for (let shown = queue.getSnapshot(); shown; shown = queue.getSnapshot()) queue.decline(shown.id);
  await Promise.all(pending);
}

test("displays one request at a time, as a stable frozen snapshot", async () => {
  const queue = createConsentQueue();
  assert.equal(queue.getSnapshot(), null);
  const first = queue.request(ask("First"));
  const second = queue.request(ask("Second"));
  const shown = queue.getSnapshot();
  assert.equal(shown.title, "First");
  assert.equal(shown.detail, "First detail");
  assert.equal(shown.confirmLabel, "Go");
  assert.equal(typeof shown.id, "string");
  assert.ok(Object.isFrozen(shown));
  // useSyncExternalStore requires the same reference until something changes.
  assert.equal(queue.getSnapshot(), shown);
  assert.ok(shown.timeoutMs > 0 && shown.timeoutMs <= 1000);
  assert.ok(shown.expiresAt > Date.now());
  assert.equal(queue.decline(shown.id), true);
  assert.deepEqual(await first, { decision: "declined" });
  const next = queue.getSnapshot();
  assert.equal(next.title, "Second");
  assert.notEqual(next.id, shown.id);
  await drain(queue, [second]);
  assert.equal(queue.getSnapshot(), null);
});

test("subscribers hear every change of the displayed request, and can leave", async () => {
  const queue = createConsentQueue();
  const seen = [];
  const unsubscribe = queue.subscribe(() => seen.push(queue.getSnapshot()?.title ?? null));
  // A broken listener must not starve the others or break the queue.
  queue.subscribe(() => { throw new Error("listener exploded"); });
  const first = queue.request(ask("First"));
  const second = queue.request(ask("Second")); // waits: the screen does not change
  assert.deepEqual(seen, ["First"]);
  queue.decline(queue.getSnapshot().id);
  assert.deepEqual(seen, ["First", "Second"]);
  unsubscribe();
  queue.decline(queue.getSnapshot().id);
  assert.deepEqual(seen, ["First", "Second"]);
  await Promise.all([first, second]);
});

test("confirm requires a trusted event and mints an audit token", async () => {
  const queue = createConsentQueue();
  const pending = queue.request(ask("Pay"));
  const { id } = queue.getSnapshot();
  const getterThrows = { get isTrusted() { throw new Error("no"); } };
  const untrusted = [undefined, null, {}, { isTrusted: false }, { isTrusted: "true" }, { isTrusted: 1 }, getterThrows, "trusted"];
  for (const [index, event] of untrusted.entries()) {
    assert.equal(queue.confirm(id, event), false, `untrusted event #${index}`);
    assert.equal(queue.getSnapshot()?.id, id, "the request stays on screen");
  }
  assert.equal(queue.confirm(id, trusted), true);
  const result = await pending;
  assert.equal(result.decision, "confirmed");
  assert.equal(typeof result.auditToken, "string");
  assert.ok(result.auditToken.length > 0);
  assert.notEqual(result.auditToken, id);
});

// #12: an answer is bound to the request the UI displayed. If it is no longer
// displayed, the answer goes nowhere — it must not land on whatever replaced it.
test("answers naming a request no longer displayed are ignored and report false", async () => {
  const queue = createConsentQueue();
  const first = queue.request(ask("First"));
  const second = queue.request(ask("Second"));
  const stale = queue.getSnapshot().id;
  queue.decline(stale);
  await first;
  const current = queue.getSnapshot();
  assert.equal(queue.confirm(stale, trusted), false);
  assert.equal(queue.decline(stale), false);
  assert.equal(queue.dismiss(stale), false);
  assert.equal(queue.getSnapshot(), current, "the next request is untouched");
  // Waiting requests cannot be answered either: only the displayed one can.
  const third = queue.request(ask("Third"));
  assert.equal(queue.confirm("not-an-id", trusted), false);
  assert.equal(queue.confirm(undefined, trusted), false);
  assert.equal(queue.dismiss(current.id), true);
  assert.deepEqual(await second, { decision: "closed" });
  await drain(queue, [third]);
});

test("a full queue answers busy at once, without showing anything", async () => {
  const queue = createConsentQueue({ capacity: 2 });
  const seen = [];
  queue.subscribe(() => seen.push(queue.getSnapshot()?.title ?? null));
  const first = queue.request(ask("First"));
  const second = queue.request(ask("Second"));
  assert.deepEqual(await queue.request(ask("Third")), { decision: "busy" });
  assert.deepEqual(seen, ["First"], "busy never reaches the screen");
  // Settling frees a slot.
  queue.decline(queue.getSnapshot().id);
  await first;
  const fourth = queue.request(ask("Fourth"));
  await drain(queue, [second, fourth]);
  assert.equal(CONSENT_QUEUE_DEFAULT_CAPACITY, 3);
});

test("the default capacity holds three requests", async () => {
  const queue = createConsentQueue();
  const held = [queue.request(ask("1")), queue.request(ask("2")), queue.request(ask("3"))];
  assert.deepEqual(await queue.request(ask("4")), { decision: "busy" });
  await drain(queue, held);
});

test("the deadline counts from enqueue: a waiting request can expire unseen", async () => {
  const queue = createConsentQueue();
  const titles = [];
  queue.subscribe(() => titles.push(queue.getSnapshot()?.title ?? null));
  const first = queue.request(ask("First"));
  const short = queue.request(ask("Short", 20));
  assert.deepEqual(await short, { decision: "timeout" });
  queue.decline(queue.getSnapshot().id);
  await first;
  assert.deepEqual(titles, ["First", null], "the expired request was never displayed");
});

test("a request displayed late shows only the time it has left", async () => {
  const queue = createConsentQueue();
  const first = queue.request(ask("First"));
  const second = queue.request(ask("Second", 1000));
  await sleep(60);
  queue.decline(queue.getSnapshot().id);
  await first;
  const shown = queue.getSnapshot();
  assert.equal(shown.title, "Second");
  assert.ok(shown.timeoutMs <= 950, `remaining ${shown.timeoutMs}ms must exclude time spent waiting`);
  await drain(queue, [second]);
});

test("a request's timer expires only that request, never its replacement", async () => {
  const queue = createConsentQueue();
  const first = queue.request(ask("First", 20));
  const second = queue.request(ask("Second", 1000));
  assert.deepEqual(await first, { decision: "timeout" });
  const shown = queue.getSnapshot();
  assert.equal(shown.title, "Second");
  await sleep(40);
  assert.equal(queue.getSnapshot(), shown, "the next request is still waiting for its person");
  await drain(queue, [second]);
});

test("cancellation removes a waiting or displayed request as closed", async () => {
  const queue = createConsentQueue();
  const pre = new AbortController();
  pre.abort();
  assert.deepEqual(await queue.request(ask("Pre"), { signal: pre.signal }), { decision: "closed" });
  assert.equal(queue.getSnapshot(), null, "a cancelled request is never displayed");

  const shownCtl = new AbortController();
  const waitingCtl = new AbortController();
  const first = queue.request(ask("First"), { signal: shownCtl.signal });
  const second = queue.request(ask("Second"), { signal: waitingCtl.signal });
  const third = queue.request(ask("Third"));
  waitingCtl.abort();
  assert.deepEqual(await second, { decision: "closed" });
  assert.equal(queue.getSnapshot().title, "First");
  shownCtl.abort();
  assert.deepEqual(await first, { decision: "closed" });
  assert.equal(queue.getSnapshot().title, "Third", "the cancelled waiting request is skipped");
  await drain(queue, [third]);
});

test("bad input resolves closed instead of throwing or queueing", async () => {
  const queue = createConsentQueue();
  const throwingTitle = { toString() { throw new Error("no"); } };
  const throwingSignal = { get aborted() { throw new Error("no"); } };
  for (const [label, call] of [
    ["a null request", () => queue.request(null)],
    ["a zero timeout", () => queue.request(ask("x", 0))],
    ["a negative timeout", () => queue.request(ask("x", -1))],
    ["an infinite timeout", () => queue.request(ask("x", Infinity))],
    ["a timeout past setTimeout's range", () => queue.request(ask("x", 2 ** 31))],
    ["a string timeout", () => queue.request(ask("x", "100"))],
    ["a title whose toString throws", () => queue.request({ ...ask("x"), title: throwingTitle })],
    ["an unreadable signal", () => queue.request(ask("x"), { signal: throwingSignal })],
  ]) {
    assert.deepEqual(await call(), { decision: "closed" }, label);
    assert.equal(queue.getSnapshot(), null, label);
  }
});

test("an invalid capacity fails at construction, not at call time", () => {
  for (const capacity of [0, -1, 1.5, NaN, "3"]) {
    assert.throws(() => createConsentQueue({ capacity }), RangeError, String(capacity));
  }
});

// The gate aborts its surface signal when ITS deadline or the host's
// cancellation wins, so a queue behind a tool must drop that request.
test("behind a tool: the gate's own deadline clears the displayed request", async () => {
  const queue = createConsentQueue();
  let ran = false;
  const tool = defineConsequentialTool({
    name: "queued",
    description: "d",
    inputSchema: { type: "object" },
    parseArgs: () => ({}),
    consent: queue.request,
    describeConsent: () => ask("Queued", 20),
    execute: async () => { ran = true; return { ok: true }; },
  });
  const pending = tool.execute({});
  assert.equal(queue.getSnapshot().title, "Queued");
  assert.equal(JSON.parse((await pending).content[0].text).code, "consent_timeout");
  assert.equal(queue.getSnapshot(), null);
  assert.equal(ran, false);
});

test("behind a tool: a full queue reaches the model as consent_busy", async () => {
  const queue = createConsentQueue({ capacity: 1 });
  let runs = 0;
  const tool = defineConsequentialTool({
    name: "queued",
    description: "d",
    inputSchema: { type: "object" },
    parseArgs: () => ({}),
    consent: queue.request,
    describeConsent: () => ask("Queued"),
    execute: async () => { runs += 1; return { ok: true }; },
  });
  const first = tool.execute({});
  const busy = JSON.parse((await tool.execute({})).content[0].text);
  assert.equal(busy.code, "consent_busy");
  assert.equal(runs, 0);
  assert.equal(queue.confirm(queue.getSnapshot().id, trusted), true);
  assert.deepEqual(JSON.parse((await first).content[0].text), { ok: true });
  assert.equal(runs, 1);
});
