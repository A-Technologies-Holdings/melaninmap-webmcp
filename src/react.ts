/**
 * `@melaninmap/webmcp-consent/react` — a thin React binding over a consent
 * queue.
 *
 * Everything that matters lives in `createConsentQueue`: one request on
 * screen, a bounded queue, deadlines, cancellation, and every answer bound to
 * the request that was displayed. This hook only reads the queue with
 * `useSyncExternalStore` and hands a component the displayed request plus
 * answers already bound to it. It renders nothing — the markup, the focus
 * handling and the look are yours.
 *
 * React is an optional peer dependency used only by this entry point. The
 * package root never imports it.
 *
 * ```tsx
 * const queue = createConsentQueue();          // module scope, shared
 * const tool = defineConsequentialTool({ consent: queue.surface, ... });
 *
 * function ConsentPrompt() {
 *   const { request, confirm, decline } = useConsentQueue(queue);
 *   if (!request) return null;
 *   // key: a new request gets new DOM nodes, so focus never carries over
 *   // from the last prompt's Confirm to this one's.
 *   return (
 *     <div key={request.id} role="dialog" aria-modal="true">
 *       <h2>{request.title}</h2>
 *       <p>{request.detail}</p>
 *       <button autoFocus onClick={decline}>Not now</button>
 *       <button onClick={confirm}>{request.confirmLabel}</button>
 *     </div>
 *   );
 * }
 * ```
 */

import { useMemo, useSyncExternalStore } from "react";
import type { ConsentConfirmEvent, ConsentQueue, DisplayedConsentRequest } from "./queue.js";

export type ConsentQueuePrompt = {
  /** The request on screen, or null when there is nothing to render. */
  request: DisplayedConsentRequest | null;
  /**
   * Confirm the request THIS render displayed. Pass the click event: an
   * untrusted (script-dispatched) event is ignored, see
   * `ConsentQueue.confirm`. Returns whether the confirmation was accepted —
   * `false` if the request has since timed out, been cancelled or been
   * replaced, so a stale button can never confirm the next request.
   */
  confirm: (event: ConsentConfirmEvent) => boolean;
  /** Decline the request this render displayed. Returns whether accepted. */
  decline: () => boolean;
  /** Dismiss (Escape, backdrop) the request this render displayed. Never consent. */
  dismiss: () => boolean;
};

/**
 * Consent prompts are never rendered on the server: a prompt only means
 * something in the live page a person is looking at, and a server-side queue
 * would be shared by every visitor. Hydration therefore always starts empty.
 */
function getServerSnapshot(): null {
  return null;
}

/**
 * Bind answers to one displayed request: the hook without the subscription,
 * for a binding that subscribes some other way (a class component, an
 * external store library).
 */
export function bindConsentAnswers(
  queue: ConsentQueue,
  request: DisplayedConsentRequest | null,
): Omit<ConsentQueuePrompt, "request"> {
  const id = request?.id;
  if (id === undefined) {
    const no = () => false;
    return { confirm: no, decline: no, dismiss: no };
  }
  return {
    // The queue reads nativeEvent.isTrusted itself, so a React event passes
    // straight through.
    confirm: (event) => queue.confirm(id, event),
    decline: () => queue.decline(id),
    dismiss: () => queue.dismiss(id),
  };
}

/**
 * Subscribe a component to a consent queue.
 *
 * The answers it returns are bound to the request id of the render that
 * produced them, not to "whatever is displayed now". A Confirm button
 * rendered for one request and clicked after the next one replaced it
 * reports `false` and changes nothing.
 */
export function useConsentQueue(queue: ConsentQueue): ConsentQueuePrompt {
  const request = useSyncExternalStore(queue.subscribe, queue.getSnapshot, getServerSnapshot);
  const answers = useMemo(() => bindConsentAnswers(queue, request), [queue, request]);
  return { request, ...answers };
}
