/**
 * Non-React ↔ React bridge for the agent handoff consent card.
 *
 * Modeled on the hooks/useConsent.ts store pattern: module-level state plus
 * subscribe/notify. The WebMCP registrar (non-React) calls
 * requestHandoffConsent() and awaits the person's answer; the React side
 * (HandoffConsentCard.tsx) subscribes, renders the pending request, and
 * resolves it.
 *
 * Invariants:
 * - One pending request at a time; a concurrent request resolves
 *   { status: "busy" } immediately without disturbing the open card.
 * - A pending request auto-declines after 60 seconds.
 * - A "confirmed" resolution carries the consent token, which only the card
 *   module holds — tool execute code cannot fabricate a confirmation.
 */

export type HandoffConsentRequest = {
  /** Human-readable name of the event/tour shown on the card. */
  targetName: string;
};

/** What the card answers with; the bridge enriches a confirmation below. */
export type HandoffConsentAnswer =
  | {
      status: "confirmed";
      consentToken: string;
      /**
       * Placeholder tab opened SYNCHRONOUSLY inside the Confirm click so the
       * transient user activation is spent while it is still valid — by the
       * time the create/redeem round trips finish, a direct window.open would
       * be popup-blocked on strict browsers. Null when the browser refused
       * even the synchronous open.
       */
      navigationHandle: Window | null;
    }
  | { status: "declined" };

export type HandoffConsentResolution =
  | {
      status: "confirmed";
      consentToken: string;
      idempotencyKey: string;
      navigationHandle: Window | null;
    }
  | { status: "declined" };

export type HandoffConsentOutcome =
  | HandoffConsentResolution
  | { status: "busy" };

export const HANDOFF_CONSENT_TIMEOUT_MS = 60_000;

type PendingConsent = {
  request: HandoffConsentRequest;
  /**
   * Minted ONCE per consent request and carried on the confirmation. The
   * Convex journey id derives from this key, and the web create budget is
   * tight — a fresh key per network attempt would make retries non-idempotent
   * and burn the rate limit, so the consent lifecycle owns the key.
   */
  idempotencyKey: string;
  resolve: (outcome: HandoffConsentResolution) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

function generateIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `webmcp-${crypto.randomUUID()}`;
  }
  return `webmcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let pending: PendingConsent | null = null;
let listeners: Array<() => void> = [];

function notify() {
  listeners.forEach((fn) => fn());
}

/**
 * React-side subscription (useSyncExternalStore-compatible). Fires whenever a
 * request is enqueued or resolved.
 */
export function subscribeToConsentRequests(callback: () => void) {
  listeners.push(callback);
  return () => {
    listeners = listeners.filter((fn) => fn !== callback);
  };
}

/**
 * Snapshot for the React side. Returns a stable reference while a request is
 * pending, null otherwise.
 */
export function getPendingConsentRequest(): HandoffConsentRequest | null {
  return pending ? pending.request : null;
}

/**
 * Registrar-side entry point. Enqueues a consent request, notifies the React
 * side, and resolves when the person answers (or the 60s timeout declines).
 * If another request is already pending, resolves { status: "busy" }
 * immediately — cards never stack.
 */
export function requestHandoffConsent(
  request: HandoffConsentRequest,
): Promise<HandoffConsentOutcome> {
  if (pending) {
    return Promise.resolve({ status: "busy" });
  }

  return new Promise<HandoffConsentOutcome>((resolve) => {
    const timeoutId = setTimeout(() => {
      resolvePendingConsentRequest({ status: "declined" });
    }, HANDOFF_CONSENT_TIMEOUT_MS);
    pending = {
      request,
      idempotencyKey: generateIdempotencyKey(),
      resolve,
      timeoutId,
    };
    notify();
  });
}

/**
 * React-side answer. No-op when nothing is pending (e.g. the timeout already
 * declined). A confirmation must include the consent token held by the card
 * module; the bridge attaches the pending request's idempotency key so the
 * whole consent resolves to exactly one server-side create identity.
 */
export function resolvePendingConsentRequest(answer: HandoffConsentAnswer) {
  if (!pending) {
    return;
  }
  const current = pending;
  pending = null;
  clearTimeout(current.timeoutId);
  notify();
  current.resolve(
    answer.status === "confirmed"
      ? { ...answer, idempotencyKey: current.idempotencyKey }
      : answer,
  );
}
