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
 *
 * The queueing, deadlines, cancellation and the binding of every answer to
 * the request on screen all come from `createConsentQueue`. This file only
 * draws what the queue says is displayed, and reports clicks back by id.
 */

import type { ConsentSurface, DisplayedConsentRequest } from "../src/index.js";
import { createConsentQueue } from "../src/index.js";

/** At most three prompts, open or waiting. A fourth resolves `busy`. */
const queue = createConsentQueue({ capacity: 3 });

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

/** Build the dialog for one displayed request. Answers name that request's id. */
function render(request: DisplayedConsentRequest): { dialog: HTMLDialogElement; decline: HTMLButtonElement } {
  const dialog = document.createElement("dialog");

  // Structure and class names only — the look lives in consent-surface.css,
  // so restyling never means touching the behavior below.
  // IDs must be unique in the document, not just in this module: a page can
  // load two copies of this file, or carry its own mm-consent-* markup, and a
  // duplicate id would let a screen reader announce another request's words.
  // The queue's request id is random, not a sequence, so it serves.
  const id = `mm-consent-${request.id}`;
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
  fill.style.setProperty("--mm-consent-duration", `${request.timeoutMs}ms`);
  meter.append(fill);

  const expiry = element(
    "p",
    "mm-consent__expiry",
    `Expires in ${formatDuration(request.timeoutMs)}. Nothing happens unless you choose \u201c${request.confirmLabel}\u201d.`,
  );
  expiry.setAttribute("id", `${id}-expiry`);

  const confirm = element("button", "mm-consent__button mm-consent__button--confirm", request.confirmLabel);
  confirm.type = "button";
  // The queue checks event.isTrusted itself; a script's click() is ignored.
  confirm.addEventListener("click", (event) => { queue.confirm(request.id, event); });

  const decline = element("button", "mm-consent__button mm-consent__button--decline", "Not now");
  decline.type = "button";
  decline.addEventListener("click", () => { queue.decline(request.id); });

  // Escape. Dismissal is never consent.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    queue.dismiss(request.id);
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
    if (outside) queue.dismiss(request.id);
  });
  // A dialog closed out from under us is a dismissal. When this module closes
  // it after an answer, the id is no longer displayed and the queue ignores it.
  dialog.addEventListener("close", () => { queue.dismiss(request.id); });

  // Decline comes first in reading order and holds focus; Confirm sits at
  // the end of the row where a deliberate choice expects to find it.
  const actions = element("div", "mm-consent__actions");
  actions.append(decline, confirm);
  dialog.append(eyebrow, title, detail, meter, expiry, actions);
  return { dialog, decline };
}

let mounted: { id: string; dialog: HTMLDialogElement } | null = null;

/** Make the DOM match the queue: at most one dialog, for the displayed request. */
function sync(): void {
  const request = queue.getSnapshot();
  if (mounted !== null && mounted.id === request?.id) return;
  if (mounted !== null) {
    const { dialog } = mounted;
    mounted = null;
    try { dialog.close(); } catch { /* Removal is still final if the host dialog fails. */ }
    finally { dialog.remove(); }
  }
  if (request === null) return;
  const { dialog, decline } = render(request);
  mounted = { id: request.id, dialog };
  document.body.appendChild(dialog);
  // A dialog that cannot open cannot be answered. Dismissing it re-enters
  // sync() and moves on to the next request, so nothing may run after this.
  try { dialog.showModal(); }
  catch { queue.dismiss(request.id); return; }
  // Deliberately the safe control. See the note above; the deployed card in
  // reference/HandoffConsentCard.tsx does the same thing for the same reason.
  decline.focus();
}

queue.subscribe(sync);

/** Serializes prompts so concurrent tool calls queue instead of stacking. */
export const domConsentSurface: ConsentSurface = queue.request;
