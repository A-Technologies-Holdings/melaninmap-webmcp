/**
 * A working ConsentSurface over plain DOM — no framework, no dependencies.
 *
 * Copy this, restyle it, keep the behavior. The behavior is what matters:
 *
 * - It mounts into the page the person is actually looking at.
 * - Confirm and decline are separate, deliberate controls. Dismissing the
 *   dialog (Escape, backdrop, the close control) is a decline, never a
 *   confirm — the safe answer must be the easy one.
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

function randomToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function prompt(request: ConsentRequest): Promise<ConsentResult> {
  return new Promise<ConsentResult>((resolve) => {
    let settled = false;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", request.title);

    const finish = (result: ConsentResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      dialog.close();
      dialog.remove();
      resolve(result);
    };

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
    confirm.addEventListener("click", () =>
      finish({ decision: "confirmed", auditToken: randomToken() }),
    );

    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "Not now";
    decline.addEventListener("click", () => finish({ decision: "declined" }));

    // Escape and backdrop dismissal both land here. Dismissal is never consent.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish({ decision: "closed" });
    });
    dialog.addEventListener("close", () => finish({ decision: "closed" }));

    dialog.append(title, detail, confirm, decline);
    document.body.appendChild(dialog);
    dialog.showModal();
    // Deliberately the safe control. See the note above; the deployed card in
    // reference/HandoffConsentCard.tsx does the same thing for the same reason.
    decline.focus();
  });
}

/** Serializes prompts so concurrent tool calls queue instead of stacking. */
export const domConsentSurface: ConsentSurface = (request) => {
  const next = pending.then(() => prompt(request));
  pending = next.catch(() => undefined);
  return next;
};
