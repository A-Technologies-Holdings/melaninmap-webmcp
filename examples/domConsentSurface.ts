/**
 * A working ConsentSurface over plain DOM — no framework, no dependencies.
 *
 * Copy this, restyle it, keep the behavior. The behavior is what matters:
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
 *   calls in a row must not stack three dialogs; the later ones queue.
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

function prompt(request: ConsentRequest, signal?: AbortSignal): Promise<ConsentResult> {
  if (signal?.aborted) return Promise.resolve({ decision: "closed" });
  return new Promise<ConsentResult>((resolve) => {
    let settled = false;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", request.title);

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
    const timer = window.setTimeout(
      () => finish({ decision: "timeout" }),
      request.timeoutMs ?? CONSENT_DEFAULT_TIMEOUT_MS,
    );

    const title = document.createElement("h2");
    title.textContent = request.title;

    const detail = document.createElement("p");
    detail.textContent = request.detail;

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = request.confirmLabel;
    confirm.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      finish({ decision: "confirmed", auditToken: randomToken() });
    });

    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "Not now";
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

    dialog.append(title, detail, confirm, decline);
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
  if (queued >= MAX_PENDING_PROMPTS || options.signal?.aborted ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return Promise.resolve({ decision: "closed" });
  }
  const deadline = Date.now() + timeoutMs;
  queued += 1;
  const controller = new AbortController();
  let settled = false;
  let finish!: (value: ConsentResult) => void;
  const answer = new Promise<ConsentResult>(resolve => {
    finish = value => {
      if (settled) return;
      settled = true;
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
  pending = next.finally(() => { queued -= 1; });
  return answer;
};
