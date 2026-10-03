/**
 * A working ConsentSurface over plain DOM — no framework, no dependencies.
 *
 * Copy this, restyle it, keep the behavior. The default look ships beside it
 * in consent-surface.css (load it once per page); every element carries an
 * `mm-consent__*` class so a host can restyle without editing this file. The
 * behavior is what matters:
 *
 * - It mounts into the page the person is actually looking at.
 * - Confirm and decline are separate, deliberate controls. Dismissing the
 *   dialog (Escape, a click on the backdrop, a programmatic close) is never a
 *   confirm — the safe answer must be the easy one.
 * - **Confirm ignores clicks the browser did not originate.** A script calling
 *   `confirmButton.click()` dispatches an event with `isTrusted === false`;
 *   only a real input event confirms. This raises the bar for page scripts —
 *   it is not proof a human acted, and the server must still not authorize on
 *   it (see SECURITY.md). Decline stays callable either way: refusing is
 *   always safe.
 * - **Initial focus lands on Decline, never Confirm.** An agent can open this
 *   dialog at any moment, including mid-keystroke. If Confirm held focus, a
 *   person's next Enter press would authorise a consequential action they had
 *   not read, let alone chosen. Focusing the safe control costs a person one
 *   Tab and costs the careless case nothing.
 * - It resolves exactly once and always resolves. A prompt nobody answers
 *   becomes a timeout, not a promise that hangs and a tool call that never
 *   returns.
 * - Only one prompt exists at a time. A model that fires three consequential
 *   calls in a row must not stack three dialogs; the later ones queue, and
 *   one more than the queue holds is refused as `busy`.
 */

import type { ConsentRequest, ConsentResult, ConsentSurface } from "../src/index.js";
import { CONSENT_DEFAULT_TIMEOUT_MS } from "../src/index.js";

let pending: Promise<unknown> = Promise.resolve();
let queued = 0;
const MAX_PENDING_PROMPTS = 3;

function randomToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.setAttribute("class", className);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * "5 seconds", "90 seconds", "2 minutes" — what a person reads, not a number
 * of ms. It must never promise more time than remains: whole seconds round up
 * by under a second (the text's own resolution), seconds are kept below two
 * minutes, and minutes always round DOWN. A queued prompt shows its remaining
 * time, so "2 minutes" for 90 seconds would overstate a real deadline.
 */
function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function prompt(request: ConsentRequest, signal?: AbortSignal): Promise<ConsentResult> {
  if (signal?.aborted) return Promise.resolve({ decision: "closed" });
  return new Promise<ConsentResult>((resolve) => {
    let settled = false;
    const dialog = document.createElement("dialog");

    const finish = (result: ConsentResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      try { dialog.close(); } catch { /* Dismissal is still final if the host dialog fails. */ }
      finally { dialog.remove(); resolve(result); }
    };

    const cancel = () => finish({ decision: "closed" });
    signal?.addEventListener("abort", cancel, { once: true });
    const timeoutMs = request.timeoutMs ?? CONSENT_DEFAULT_TIMEOUT_MS;
    const timer = window.setTimeout(() => finish({ decision: "timeout" }), timeoutMs);

    // Structure and class names only — the look lives in consent-surface.css,
    // so restyling never means touching the behavior below.
    // IDs must be unique in the document, not just in this module: a page can
    // load two copies of this file, or carry its own mm-consent-* markup, and a
    // duplicate id would let a screen reader announce another request's words.
    const id = `mm-consent-${randomToken()}`;
    dialog.setAttribute("class", "mm-consent");
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    dialog.setAttribute("aria-describedby", `${id}-detail ${id}-expiry`);

    // Say who is asking. The page did not open this dialog; an agent did.
    const eyebrow = element("p", "mm-consent__eyebrow", "Agent request");

    const title = element("h2", "mm-consent__title", request.title);
    title.setAttribute("id", `${id}-title`);

    const detail = element("p", "mm-consent__detail", request.detail);
    detail.setAttribute("id", `${id}-detail`);

    // The meter is a CSS animation over the request's own deadline, so the
    // countdown needs no extra timers and cannot drift from the real one.
    const meter = element("div", "mm-consent__meter");
    meter.setAttribute("aria-hidden", "true");
    const fill = element("span", "mm-consent__meter-fill");
    // CSSOM, not a style attribute: a strict CSP (no 'unsafe-inline' in
    // style-src) blocks setAttribute("style"), which would silently fall back
    // to the stylesheet's default duration and drain on the wrong deadline.
    fill.style.setProperty("--mm-consent-duration", `${timeoutMs}ms`);
    meter.append(fill);

    const expiry = element(
      "p",
      "mm-consent__expiry",
      `Expires in ${formatDuration(timeoutMs)}. Nothing happens unless you choose \u201c${request.confirmLabel}\u201d.`,
    );
    expiry.setAttribute("id", `${id}-expiry`);

    const confirm = element("button", "mm-consent__button mm-consent__button--confirm", request.confirmLabel);
    confirm.type = "button";
    confirm.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      finish({ decision: "confirmed", auditToken: randomToken() });
    });

    const decline = element("button", "mm-consent__button mm-consent__button--decline", "Not now");
    decline.type = "button";
    decline.addEventListener("click", () => finish({ decision: "declined" }));

    // Escape. Dismissal is never consent.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish({ decision: "closed" });
    });
    // A click on the ::backdrop targets the dialog itself — but so does a click
    // on the dialog's own padding, so the pointer must also fall outside the
    // dialog's box before it counts as a backdrop dismissal.
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const outside =
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom;
      if (outside) finish({ decision: "closed" });
    });
    dialog.addEventListener("close", () => finish({ decision: "closed" }));

    // Decline comes first in reading order and holds focus; Confirm sits at
    // the end of the row where a deliberate choice expects to find it.
    const actions = element("div", "mm-consent__actions");
    actions.append(decline, confirm);
    dialog.append(eyebrow, title, detail, meter, expiry, actions);
    document.body.appendChild(dialog);
    try { dialog.showModal(); }
    catch { finish({ decision: "closed" }); return; }
    // Deliberately the safe control. See the note above; the deployed card in
    // reference/HandoffConsentCard.tsx does the same thing for the same reason.
    decline.focus();
  });
}

/** Serializes prompts so concurrent tool calls queue instead of stacking. */
export const domConsentSurface: ConsentSurface = (request, options = {}) => {
  const timeoutMs = request.timeoutMs ?? CONSENT_DEFAULT_TIMEOUT_MS;
  if (options.signal?.aborted ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return Promise.resolve({ decision: "closed" });
  }
  // Full is not dismissed: nobody saw this request, so it is `busy`, which
  // the model can tell apart from a person closing the prompt.
  if (queued >= MAX_PENDING_PROMPTS) return Promise.resolve({ decision: "busy" });
  const deadline = Date.now() + timeoutMs;
  queued += 1;
  const controller = new AbortController();
  let settled = false;
  let finish!: (value: ConsentResult) => void;
  const answer = new Promise<ConsentResult>(resolve => {
    finish = value => {
      if (settled) return;
      settled = true;
      // Capacity counts unanswered requests, so free the slot the moment this
      // one settles. Waiting for its turn in the chain would keep an expired
      // request counted behind a prompt that is still open.
      queued -= 1;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      resolve(value);
      controller.abort();
    };
  });
  const cancel = () => finish({ decision: "closed" });
  const timer = setTimeout(() => finish({ decision: "timeout" }), timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const next = pending.then(async () => {
    if (settled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { finish({ decision: "timeout" }); return; }
    try { finish(await prompt({ ...request, timeoutMs: remaining }, controller.signal)); }
    catch { finish({ decision: "closed" }); }
  });
  pending = next;
  return answer;
};
