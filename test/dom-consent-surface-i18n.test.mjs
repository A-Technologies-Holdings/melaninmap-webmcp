/**
 * Localized DOM consent surfaces.
 *
 * A localized surface must change only the words: focus still lands on the
 * safe control, an untrusted click still cannot confirm, each surface owns
 * an independent queue, and malformed strings fail at creation where the
 * mistake was written. Same minimal fake DOM as the default-surface suite.
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
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {}, ...event });
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); }
  remove() { this.removed = true; }
  focus() { focused = this; }
  click() { this.dispatch("click", { isTrusted: true, target: this }); }
  syntheticClick() { this.dispatch("click", { isTrusted: false, target: this }); }
}

class FakeDialog extends FakeElement {
  constructor() { super("dialog"); this.open = false; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
  getBoundingClientRect() { return { left: 100, right: 400, top: 100, bottom: 300 }; }
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

const { createDomConsentSurface, domConsentSurface } = await import(
  "../.test-build/src/domConsentSurface.js"
);

const request = {
  title: "Hold 2 tickets?",
  detail: "We'll open the ticket page.",
  confirmLabel: "Open tickets",
  timeoutMs: 90_000,
};

function texts(dialog) {
  const flat = [];
  const walk = (node) => { flat.push(node); for (const child of node.children) walk(child); };
  walk(dialog);
  return flat.map((node) => node.textContent).filter(Boolean);
}

test("a localized surface renders its strings and keeps the safety contract", async () => {
  const surface = createDomConsentSurface({
    strings: {
      eyebrow: "Demande d'un agent",
      declineLabel: "Pas maintenant",
      formatDuration: (ms) => `${Math.round(ms / 1000)} secondes`,
      expiryText: (duration, label) => `Expire dans ${duration}. Rien sans « ${label} ».`,
    },
  });
  const pending = surface(request);
  const dialog = dialogs.at(-1);
  const shown = texts(dialog);
  assert.ok(shown.includes("Demande d'un agent"));
  assert.ok(shown.includes("Pas maintenant"));
  assert.ok(shown.some((text) => text.startsWith("Expire dans 90 secondes.")));
  // Focus is still the safe control, labeled in the new locale.
  assert.equal(focused.textContent, "Pas maintenant");

  // An untrusted click still cannot confirm; decline still resolves.
  const buttons = [];
  const walk = (node) => { buttons.push(node); for (const child of node.children) walk(child); };
  walk(dialog);
  const confirmButton = buttons.find((node) => node.textContent === "Open tickets");
  confirmButton.syntheticClick();
  const declineButton = buttons.find((node) => node.textContent === "Pas maintenant");
  declineButton.click();
  assert.deepEqual(await pending, { decision: "declined" });
});

test("surfaces own independent queues; the default surface is unchanged", async () => {
  const other = createDomConsentSurface();
  const first = other(request);
  const second = domConsentSurface(request);
  // Both render their own dialog; neither stole the other's prompt.
  assert.ok(dialogs.length >= 2);
  const cleanup = await Promise.all([
    Promise.race([first, new Promise((r) => setTimeout(() => r("pending"), 50))]),
    Promise.race([second, new Promise((r) => setTimeout(() => r("pending"), 50))]),
  ]);
  assert.deepEqual(cleanup, ["pending", "pending"]);
  // Resolve both by declining through their visible dialogs' decline buttons.
  for (const dialog of dialogs.slice(-2)) {
    const buttons = [];
    const walk = (node) => { buttons.push(node); for (const child of node.children) walk(child); };
    walk(dialog);
    buttons.find((node) => node.textContent === "Not now")?.click();
  }
  assert.deepEqual(await first, { decision: "declined" });
  assert.deepEqual(await second, { decision: "declined" });
});

test("malformed strings fail at creation, where the mistake was written", () => {
  assert.throws(() => createDomConsentSurface({ strings: { declineLabel: "" } }), TypeError);
  assert.throws(() => createDomConsentSurface({ strings: { eyebrow: 3 } }), TypeError);
  assert.throws(() => createDomConsentSurface({ strings: { expiryText: "nope" } }), TypeError);
  assert.throws(() => createDomConsentSurface({ capacity: 0 }), RangeError);
});
