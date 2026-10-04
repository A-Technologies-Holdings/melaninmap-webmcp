/**
 * The React entry, `@melaninmap/webmcp-consent/react`, against the built output
 * and real React.
 *
 * happy-dom supplies just enough DOM for react-dom/client; nothing here ships.
 * What is proven: the hook re-renders as the queue changes, answers are bound
 * to the request a render displayed, Confirm needs a trusted event, the server
 * render is always empty, and the package root never loads React.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Window } from "happy-dom";

const window = new Window();
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLIFrameElement", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: name === "window" ? window : window[name],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { createConsentQueue } = await import("../dist/index.js");
const { bindConsentAnswers, useConsentQueue } = await import("../dist/react.js");

const h = React.createElement;
const ask = (title, timeoutMs = 1000) => ({ title, detail: `${title} detail`, confirmLabel: "Go", timeoutMs });

/** A consumer component, written the way the README shows. */
function Prompt({ queue, onRender }) {
  const prompt = useConsentQueue(queue);
  onRender?.(prompt);
  if (!prompt.request) return null;
  // Keyed by request id, as the README shows, so each request gets new nodes.
  return h("div", { key: prompt.request.id, role: "dialog" },
    h("h2", null, prompt.request.title),
    h("button", { className: "decline", onClick: prompt.decline }, "Not now"),
    h("button", { className: "confirm", onClick: prompt.confirm }, prompt.request.confirmLabel));
}

async function mount(queue, onRender, { strict = false } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const element = h(Prompt, { queue, onRender });
  await React.act(() => root.render(strict ? h(React.StrictMode, null, element) : element));
  return {
    container,
    button: (name) => container.querySelector(`button.${name}`),
    title: () => container.querySelector("h2")?.textContent ?? null,
    unmount: () => React.act(() => root.unmount()),
  };
}

/** What a person's click produces: the browser marks the native event trusted. */
function trustedClick(button) {
  const event = new window.MouseEvent("click", { bubbles: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  button.dispatchEvent(event);
}

test("the hook renders the displayed request and follows the queue", async () => {
  const queue = createConsentQueue();
  const view = await mount(queue);
  assert.equal(view.title(), null);
  let first, second;
  await React.act(() => { first = queue.surface(ask("First")); second = queue.surface(ask("Second")); });
  assert.equal(view.title(), "First");
  await React.act(() => view.button("decline").click());
  assert.deepEqual(await first, { decision: "declined" });
  assert.equal(view.title(), "Second");
  await React.act(() => trustedClick(view.button("confirm")));
  assert.equal((await second).decision, "confirmed");
  assert.equal(view.title(), null);
  await view.unmount();
});

// StrictMode double-invokes renders and effects, and subscribes twice. The
// queue must still notify exactly the live subscription and answer once.
test("the hook works under StrictMode", async () => {
  const queue = createConsentQueue();
  const view = await mount(queue, undefined, { strict: true });
  let first, second;
  await React.act(() => { first = queue.surface(ask("First")); second = queue.surface(ask("Second")); });
  assert.equal(view.title(), "First");
  await React.act(() => trustedClick(view.button("confirm")));
  assert.equal((await first).decision, "confirmed");
  assert.equal(view.title(), "Second");
  await React.act(() => view.button("decline").click());
  assert.deepEqual(await second, { decision: "declined" });
  assert.equal(view.title(), null);
  await view.unmount();
});

// Focus must not carry from one request's Confirm to the next one's: with the
// prompt keyed by request id, the next request's buttons are new nodes.
test("each request renders fresh nodes, so focus cannot carry over", async () => {
  const queue = createConsentQueue();
  const view = await mount(queue);
  let first, second;
  await React.act(() => { first = queue.surface(ask("First")); second = queue.surface(ask("Second")); });
  const firstConfirm = view.button("confirm");
  firstConfirm.focus();
  await React.act(() => trustedClick(firstConfirm));
  await first;
  assert.notEqual(view.button("confirm"), firstConfirm);
  assert.notEqual(document.activeElement, view.button("confirm"));
  await React.act(() => view.button("decline").click());
  await second;
  await view.unmount();
});

test("a script-dispatched Confirm click does not confirm", async () => {
  const queue = createConsentQueue();
  const view = await mount(queue);
  let pending;
  await React.act(() => { pending = queue.surface(ask("Pay", 40)); });
  await React.act(() => view.button("confirm").click()); // isTrusted is false
  assert.equal(view.title(), "Pay", "the prompt stays open");
  // The deadline fires a state update, so wait for it inside act().
  await React.act(async () => { assert.deepEqual(await pending, { decision: "timeout" }); });
  assert.equal(view.title(), null);
  await view.unmount();
});

test("answers from an earlier render cannot reach the request that replaced it", async () => {
  const queue = createConsentQueue();
  const renders = [];
  const view = await mount(queue, (prompt) => renders.push(prompt));
  let first, second;
  await React.act(() => { first = queue.surface(ask("First")); second = queue.surface(ask("Second")); });
  const stale = renders.at(-1);
  assert.equal(stale.request.title, "First");
  await React.act(() => { stale.decline(); });
  await first;
  assert.equal(view.title(), "Second");
  // The handlers captured while "First" was on screen now name a request
  // that is gone. They must report false and leave "Second" alone.
  const trustedEvent = { nativeEvent: { isTrusted: true } };
  assert.equal(stale.confirm(trustedEvent), false);
  assert.equal(stale.decline(), false);
  assert.equal(stale.dismiss(), false);
  assert.equal(view.title(), "Second");
  const current = renders.at(-1);
  assert.equal(current.request.title, "Second");
  await React.act(() => { assert.equal(current.dismiss(), true); });
  assert.deepEqual(await second, { decision: "closed" });
  await view.unmount();
});

test("the server render is always empty, even with a request pending", async () => {
  const queue = createConsentQueue();
  const pending = queue.surface(ask("Not on the server"));
  assert.equal(renderToString(h(Prompt, { queue })), "");
  queue.decline(queue.getSnapshot().id);
  await pending;
});

test("bindConsentAnswers reads isTrusted from nativeEvent first, and fails closed", async () => {
  const queue = createConsentQueue();
  const none = bindConsentAnswers(queue, null);
  assert.equal(none.confirm({ isTrusted: true }), false);
  assert.equal(none.decline(), false);
  assert.equal(none.dismiss(), false);

  const pending = queue.surface(ask("Pay"));
  const answers = bindConsentAnswers(queue, queue.getSnapshot());
  // A synthetic event claiming trust over an untrusted native event is untrusted.
  assert.equal(answers.confirm({ isTrusted: true, nativeEvent: { isTrusted: false } }), false);
  assert.equal(answers.confirm({ get nativeEvent() { throw new Error("no"); } }), false);
  assert.equal(answers.confirm(undefined), false);
  assert.equal(answers.confirm({ isTrusted: true }), true, "a native DOM event fits too");
  assert.equal((await pending).decision, "confirmed");
});

// The root entry must stay zero-dependency: importing it must never pull in
// React, or every non-React consumer would need React installed.
test("the package root never imports react", () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
    // Statement-level imports and re-exports, plus any dynamic import().
    // Anchored to line starts so prose in comments cannot match.
    const specifiers = [
      ...source.matchAll(/^(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith("./"), `${file} imports ${specifier}`);
      visit(specifier.slice(2));
    }
  };
  visit("index.js");
  assert.ok(!seen.has("react.js"));
  assert.ok(seen.has("consent.js") && seen.has("register.js"), "the scan follows re-exports");
  assert.ok(seen.has("queue.js"));
});

test("react is an optional peer and a separate export", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies, undefined, "the runtime has no dependencies");
  assert.ok(pkg.peerDependencies.react);
  assert.equal(pkg.peerDependenciesMeta.react.optional, true);
  assert.equal(pkg.exports["./react"].import, "./dist/react.js");
  assert.equal(pkg.exports["./react"].types, "./dist/react.d.ts");
});
