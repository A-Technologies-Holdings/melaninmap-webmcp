/**
 * Tests for the reference consent surface in examples/.
 *
 * The example is the artifact consumers copy, so its safety contract is tested
 * for real: initial focus on Decline, dismissal never counting as consent,
 * prompt serialization, and timeout resolution. A minimal fake DOM stands in
 * for the browser — no framework, no test-only dependencies, matching the
 * package's own posture.
 *
 * The example compiles into .test-build/ so these run against real JavaScript
 * on any Node >= 22 — no TypeScript stripping required.
 *
 * Run: npm run build:test && npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    const props = new Map();
    this.style = {
      setProperty: (name, value) => props.set(name, value),
      getPropertyValue: (name) => props.get(name) ?? "",
    };
    this.textContent = "";
    this.type = "";
    this.removed = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ preventDefault() {}, ...event });
    }
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
  }

  remove() {
    this.removed = true;
  }

  focus() {
    focused = this;
  }

  // A real user's click: the browser marks it trusted.
  click() {
    this.dispatch("click", { isTrusted: true, target: this });
  }

  // What `element.click()` from page script produces: isTrusted is false.
  syntheticClick() {
    this.dispatch("click", { isTrusted: false, target: this });
  }
}

// A real <dialog> fires "close" on close(); the surface relies on that to turn
// programmatic dismissal into `closed` — and on its settled guard to keep a
// normal finish from reporting `closed` after the fact.
class FakeDialog extends FakeElement {
  constructor() {
    super("dialog");
    this.open = false;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatch("close");
  }

  getBoundingClientRect() {
    return { left: 100, right: 400, top: 100, bottom: 300 };
  }
}

const dialogs = [];
let focused = null;

globalThis.document = {
  body: new FakeElement("body"),
  createElement(tag) {
    const el = tag === "dialog" ? new FakeDialog() : new FakeElement(tag);
    if (el instanceof FakeDialog) dialogs.push(el);
    return el;
  },
};
globalThis.window = { setTimeout, clearTimeout };

const { domConsentSurface } = await import(
  "../.test-build/examples/domConsentSurface.js"
);

const request = {
  title: "Hold 2 tickets to the Saturday history tour?",
  detail: "We'll open the ticket page. Nothing is charged here.",
  confirmLabel: "Open tickets",
};

function reset() {
  dialogs.length = 0;
  focused = null;
}

// The surface serializes prompts through a promise chain, so a prompt mounts
// on a microtask, not synchronously with the call.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Find by role class, not by position, so layout changes do not break tests.
function find(node, className) {
  for (const child of node.children) {
    const classes = (child.attributes.get("class") ?? "").split(" ");
    if (classes.includes(className)) return child;
    const nested = find(child, className);
    if (nested) return nested;
  }
  return undefined;
}
const confirmButton = (dialog) => find(dialog, "mm-consent__button--confirm");
const declineButton = (dialog) => find(dialog, "mm-consent__button--decline");

test("mounts a modal dialog carrying the request's words", async () => {
  reset();
  const pending = domConsentSurface(request);
  await tick();
  assert.equal(dialogs.length, 1);
  const dialog = dialogs[0];
  assert.equal(dialog.open, true);
  assert.equal(find(dialog, "mm-consent__title").textContent, request.title);
  assert.equal(find(dialog, "mm-consent__detail").textContent, request.detail);
  assert.equal(confirmButton(dialog).textContent, request.confirmLabel);
  declineButton(dialog).click();
  return pending;
});

// The dialog is named by its title and described by the detail and the
// expiry line, so a screen reader announces what is asked and for how long.
test("the dialog is labelled by its title and says when it expires", async () => {
  reset();
  const pending = domConsentSurface({ ...request, timeoutMs: 5000 });
  await tick();
  const dialog = dialogs[0];
  const title = find(dialog, "mm-consent__title");
  const expiry = find(dialog, "mm-consent__expiry");
  assert.equal(dialog.attributes.get("aria-labelledby"), title.attributes.get("id"));
  assert.ok(
    dialog.attributes.get("aria-describedby").split(" ").includes(expiry.attributes.get("id")),
  );
  assert.match(expiry.textContent, /^Expires in 5 seconds\./);
  assert.match(expiry.textContent, /Open tickets/);
  // The meter drains over the prompt's remaining time, give or take the
  // millisecond between the call and the mount.
  const duration = find(dialog, "mm-consent__meter-fill").style.getPropertyValue("--mm-consent-duration");
  assert.match(duration, /^(4999|5000)ms$/);
  declineButton(dialog).click();
  return pending;
});

// The written expiry must never promise more time than remains. Rounding 90
// seconds to "2 minutes" would overstate the deadline by half a minute.
test("the expiry text never overstates the time remaining", async () => {
  const cases = [
    [90_000, /^Expires in 90 seconds\./],
    [119_000, /^Expires in 119 seconds\./],
    [150_000, /^Expires in 2 minutes\./],
    [179_000, /^Expires in 2 minutes\./],
  ];
  for (const [timeoutMs, expected] of cases) {
    reset();
    const pending = domConsentSurface({ ...request, timeoutMs });
    await tick();
    assert.match(find(dialogs[0], "mm-consent__expiry").textContent, expected, `${timeoutMs}ms`);
    declineButton(dialogs[0]).click();
    await pending;
  }
});

// Two copies of this module on one page, or host markup using the same prefix,
// must not produce duplicate ids for aria-labelledby to resolve ambiguously.
test("each prompt labels itself with document-unique ids", async () => {
  reset();
  const first = domConsentSurface(request);
  await tick();
  declineButton(dialogs[0]).click();
  await first;
  const second = domConsentSurface(request);
  await tick();
  declineButton(dialogs[1]).click();
  await second;
  const [a, b] = dialogs.map((dialog) => find(dialog, "mm-consent__title").attributes.get("id"));
  assert.notEqual(a, b);
  assert.doesNotMatch(a, /^mm-consent-\d+-title$/, "ids must not be a guessable sequence");
  assert.equal(dialogs[1].attributes.get("aria-labelledby"), b);
});

// An agent can open this dialog mid-keystroke. If Confirm held focus, the
// person's next Enter press would authorise something they never read.
test("initial focus lands on Decline, never Confirm", async () => {
  reset();
  const pending = domConsentSurface(request);
  await tick();
  assert.equal(focused, declineButton(dialogs[0]));
  assert.equal(focused.textContent, "Not now");
  declineButton(dialogs[0]).click();
  return pending;
});

test("a Confirm click resolves with an audit token", async () => {
  reset();
  const pending = domConsentSurface(request);
  await tick();
  confirmButton(dialogs[0]).click();
  const result = await pending;
  assert.equal(result.decision, "confirmed");
  assert.equal(typeof result.auditToken, "string");
  assert.ok(result.auditToken.length > 0);
});

test("a Decline click resolves as declined", async () => {
  reset();
  const pending = domConsentSurface(request);
  await tick();
  declineButton(dialogs[0]).click();
  assert.deepEqual(await pending, { decision: "declined" });
});

test("Escape resolves as closed — dismissal is never consent", async () => {
  reset();
  const pending = domConsentSurface(request);
  await tick();
  dialogs[0].dispatch("cancel");
  assert.deepEqual(await pending, { decision: "closed" });
});

test("an unanswered prompt resolves as timeout rather than hanging", async () => {
  reset();
  const result = await domConsentSurface({ ...request, timeoutMs: 30 });
  assert.deepEqual(result, { decision: "timeout" });
});

// A model that fires three consequential calls in a row must not stack three
// dialogs; later prompts queue behind the open one.
test("concurrent prompts queue instead of stacking", async () => {
  reset();
  const first = domConsentSurface(request);
  const second = domConsentSurface(request);
  // Let the microtask queue run: only the first prompt may be mounted.
  await tick();
  assert.equal(dialogs.length, 1);
  declineButton(dialogs[0]).click();
  assert.deepEqual(await first, { decision: "declined" });
  await tick();
  assert.equal(dialogs.length, 2);
  confirmButton(dialogs[1]).click();
  assert.equal((await second).decision, "confirmed");
});

// A script can reach the button. `element.click()` produces an untrusted event,
// and an untrusted event must never count as a person's confirmation.
test("a script-dispatched Confirm click does not confirm", async () => {
  reset();
  const pending = domConsentSurface({ ...request, timeoutMs: 30 });
  await tick();
  confirmButton(dialogs[0]).syntheticClick();
  assert.equal(dialogs[0].open, true, "the prompt must stay open");
  assert.deepEqual(await pending, { decision: "timeout" });
});

// Refusing is always safe, so Decline does not need the same guard.
test("a script-dispatched Decline click still declines", async () => {
  reset();
  const pending = domConsentSurface(request);
  await tick();
  declineButton(dialogs[0]).syntheticClick();
  assert.deepEqual(await pending, { decision: "declined" });
});

test("a click on the backdrop resolves as closed", async () => {
  reset();
  const pending = domConsentSurface(request);
  await tick();
  const dialog = dialogs[0];
  dialog.dispatch("click", { target: dialog, clientX: 20, clientY: 20 });
  assert.deepEqual(await pending, { decision: "closed" });
});

// The dialog's own padding also targets the dialog element. Treating that as a
// backdrop click would dismiss the prompt under a person aiming for a button.
test("a click on the dialog's padding does not dismiss it", async () => {
  reset();
  const pending = domConsentSurface(request);
  await tick();
  const dialog = dialogs[0];
  dialog.dispatch("click", { target: dialog, clientX: 150, clientY: 150 });
  assert.equal(dialog.open, true);
  declineButton(dialog).click();
  assert.deepEqual(await pending, { decision: "declined" });
});

test("a queued prompt expires without ever mounting", async () => {
  reset();
  const first = domConsentSurface(request);
  const second = domConsentSurface({ ...request, timeoutMs: 20 });
  await tick();
  assert.deepEqual(await second, { decision: "timeout" });
  assert.equal(dialogs.length, 1);
  declineButton(dialogs[0]).click();
  await first; await tick();
  assert.equal(dialogs.length, 1);
});

test("prompt backlog is bounded and cancellation removes the active dialog", async () => {
  reset();
  const controller = new AbortController();
  const first = domConsentSurface(request, { signal: controller.signal });
  const second = domConsentSurface({ ...request, timeoutMs: 20 });
  const third = domConsentSurface({ ...request, timeoutMs: 20 });
  // A fourth request is not shown and not refused by anyone: it is `busy`,
  // which the model can tell apart from a dismissal.
  assert.deepEqual(await domConsentSurface(request), { decision: "busy" });
  await tick();
  controller.abort();
  assert.deepEqual(await first, { decision: "closed" });
  assert.equal(dialogs[0].removed, true);
  await Promise.all([second, third]); await tick();
});

test("an expired queued prompt frees its slot while an earlier prompt is open", async () => {
  reset();
  const first = domConsentSurface(request);
  const second = domConsentSurface({ ...request, timeoutMs: 20 });
  const third = domConsentSurface({ ...request, timeoutMs: 20 });
  assert.deepEqual(await Promise.all([second, third]), [
    { decision: "timeout" },
    { decision: "timeout" },
  ]);
  // Only the first prompt is still unanswered, so a new one must queue rather
  // than be refused as if the backlog were full.
  const fourth = domConsentSurface({ ...request, timeoutMs: 20 });
  assert.deepEqual(await fourth, { decision: "timeout" });
  await tick();
  declineButton(dialogs[0]).click();
  assert.deepEqual(await first, { decision: "declined" });
  await tick();
});

// #12, in the DOM: a dialog that has been replaced is gone from the page, but
// its buttons and listeners still exist. Nothing done to them may answer the
// request that replaced it.
test("a replaced dialog's controls cannot answer the next request", async () => {
  reset();
  const first = domConsentSurface(request);
  const second = domConsentSurface(request);
  await tick();
  const old = dialogs[0];
  declineButton(old).click();
  assert.deepEqual(await first, { decision: "declined" });
  await tick();
  assert.equal(old.removed, true);
  assert.equal(dialogs.length, 2);
  confirmButton(old).click();
  old.dispatch("cancel");
  old.dispatch("click", { target: old, clientX: 20, clientY: 20 });
  old.close();
  assert.equal(dialogs[1].open, true, "the next request is still waiting for its person");
  declineButton(dialogs[1]).click();
  assert.deepEqual(await second, { decision: "declined" });
});

test("a dialog that cannot open resolves closed and the next request still shows", async () => {
  reset();
  const original = FakeDialog.prototype.showModal;
  FakeDialog.prototype.showModal = function () { throw new Error("not allowed"); };
  let first;
  try {
    first = domConsentSurface(request);
    await tick();
  } finally {
    FakeDialog.prototype.showModal = original;
  }
  assert.deepEqual(await first, { decision: "closed" });
  assert.equal(dialogs[0].removed, true);
  const second = domConsentSurface(request);
  await tick();
  assert.equal(dialogs[1].open, true);
  declineButton(dialogs[1]).click();
  assert.deepEqual(await second, { decision: "declined" });
});

// No <body> yet (a surface called before the document finished parsing) must
// not leave a request "displayed" with nothing on screen until it times out.
test("a dialog that cannot even be mounted resolves closed at once", async () => {
  reset();
  const body = document.body;
  document.body = null;
  let first;
  try {
    first = domConsentSurface({ ...request, timeoutMs: 5000 });
  } finally {
    document.body = body;
  }
  const started = Date.now();
  assert.deepEqual(await first, { decision: "closed" });
  assert.ok(Date.now() - started < 1000, "it must not wait for the deadline");
  const second = domConsentSurface(request);
  await tick();
  assert.equal(dialogs.at(-1).open, true);
  declineButton(dialogs.at(-1)).click();
  assert.deepEqual(await second, { decision: "declined" });
});
