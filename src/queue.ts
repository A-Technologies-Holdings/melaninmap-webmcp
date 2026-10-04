/**
 * A consent queue: the store behind a consent prompt, without the prompt.
 *
 * Rendering a confirmation is the easy part, and every page renders it
 * differently. The part that is easy to get wrong is the bookkeeping around
 * it, and that part is the same everywhere. This module is that part, and it
 * renders nothing: a plain DOM dialog, a React component, or anything else
 * subscribes to it and draws whatever request it says is on screen.
 *
 * It generalizes the deployed `reference/consentBridge.ts`, including the
 * rules that file learned the hard way (#12):
 *
 * - **One request on screen at a time.** A model that fires three
 *   consequential calls in a row must not stack three prompts. Later requests
 *   wait behind the displayed one.
 * - **Bounded.** The queue holds at most `capacity` requests, displayed plus
 *   waiting. One more resolves `busy` at once, without being shown — never
 *   `closed`, because nobody dismissed it, and the model should be able to
 *   tell "not shown" from "said no".
 * - **The deadline starts when the request arrives,** not when it reaches the
 *   screen. Time spent waiting is time spent; a queued request can expire
 *   without ever being displayed, and one that is displayed late shows only
 *   the time it has left.
 * - **Every answer is bound to the request that was displayed.** Confirm,
 *   decline and dismiss all name the request id the UI rendered. If that
 *   request is no longer on screen — it timed out, was cancelled, or was
 *   replaced by the next one between render and click — the answer is ignored
 *   and the call returns `false`. A click aimed at one request can never land
 *   on another. Each request's own timer can only ever expire that request.
 * - **Confirm requires a trusted event.** See `ConsentQueue.confirm`.
 * - **Cancellation is honored.** An aborted signal removes the request,
 *   displayed or waiting, and resolves it `closed`.
 *
 * Like the rest of the package it never throws at call time: every failure
 * resolves a refusal, and a listener that throws cannot break the queue.
 * (`createConsentQueue` itself throws on an invalid `capacity` — that is
 * configuration, caught where it is written.)
 *
 * Known limit: a person double-clicking Confirm, or holding Enter, can answer
 * the request that replaces the one they meant, if it renders in the same
 * place. Remount the prompt per request (key it by `id`) so focus never
 * carries over, and keep Decline as the focused control.
 */

import {
  CONSENT_DEFAULT_TIMEOUT_MS,
  type ConsentRequest,
  type ConsentResult,
  type ConsentSurface,
} from "./consent.js";

/** Displayed plus waiting, by default — the same bound as the DOM example. */
export const CONSENT_QUEUE_DEFAULT_CAPACITY = 3;

/** setTimeout's ceiling. Past it, a timer fires immediately rather than late. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The request currently on screen, as a UI should render it. Frozen, and the
 * same object for as long as the request stays displayed, so it can serve
 * directly as a `useSyncExternalStore` snapshot.
 */
export type DisplayedConsentRequest = Readonly<{
  /**
   * Identifies this request for its whole life. Pass it back to `confirm`,
   * `decline` or `dismiss`. Unique per request and not a sequence, so it can
   * also seed document-unique element ids.
   */
  id: string;
  title: string;
  detail: string;
  confirmLabel: string;
  /**
   * Milliseconds left when this request reached the screen. Drive a
   * countdown from this, not from the original timeout: a request that waited
   * in the queue has less time than it was created with.
   */
  timeoutMs: number;
  /** `Date.now()` time at which the request expires as `timeout`. */
  expiresAt: number;
}>;

/**
 * The event that caused a Confirm: a DOM `Event`, or a framework wrapper
 * around one (a React synthetic event). Only `isTrusted` is read — from
 * `nativeEvent` when there is one, because the native event is the browser's
 * own word for it.
 */
export type ConsentConfirmEvent =
  | { readonly isTrusted?: unknown; readonly nativeEvent?: { readonly isTrusted?: unknown } | null }
  | null
  | undefined;

export type ConsentQueueOptions = {
  /**
   * Requests held at once, displayed plus waiting. Must be a positive
   * integer. Defaults to `CONSENT_QUEUE_DEFAULT_CAPACITY`.
   */
  capacity?: number;
};

export type ConsentQueue = {
  /**
   * The `ConsentSurface` to hand to `defineConsequentialTool({ consent })`.
   * A standalone function — it does not depend on `this`.
   */
  readonly surface: ConsentSurface;
  /**
   * Called whenever the displayed request changes. Returns an unsubscribe
   * function. The signature `useSyncExternalStore` expects.
   */
  subscribe(listener: () => void): () => void;
  /** The displayed request, or null when nothing is on screen. */
  getSnapshot(): DisplayedConsentRequest | null;
  /**
   * Confirm the displayed request with id `id`, minting an audit token.
   *
   * Pass the event that caused the confirm. It is required, and it must be
   * a trusted one (`isTrusted === true`), for the same reason the DOM example
   * checks: a page script — or an agent automating the page — calling
   * `button.click()` dispatches an untrusted event, and an untrusted event
   * must never count as a person's confirmation. Taking the event here,
   * rather than trusting each UI binding to check it, means a binding that
   * forgets cannot confirm at all: it fails closed instead of open.
   *
   * Be clear about what this is. It raises the bar for scripts that drive
   * the page by dispatching events. It is not proof a human acted: a script
   * that can call this method can pass any object it likes, and browser
   * automation over the DevTools protocol produces trusted events. Your
   * server must still not authorize on a confirmation alone (see SECURITY.md).
   *
   * Returns whether the confirmation was accepted. `false` means nothing
   * happened: the id is not the request on screen, or the event was not
   * trusted.
   */
  confirm(id: string, event: ConsentConfirmEvent): boolean;
  /**
   * Decline the displayed request with id `id`. Needs no event: refusing is
   * always safe. Returns whether the answer was accepted.
   */
  decline(id: string): boolean;
  /**
   * Resolve the displayed request with id `id` as `closed` — Escape, a
   * backdrop click, a dialog closed out from under it. Dismissal is never
   * consent. Returns whether the answer was accepted.
   */
  dismiss(id: string): boolean;
};

type Entry = {
  id: string;
  settled: boolean;
  title: string;
  detail: string;
  confirmLabel: string;
  deadline: number;
  settle: (result: ConsentResult) => boolean;
};

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Never throws. Anything but a readable, literal `true` is untrusted. */
function isTrustedEvent(event: ConsentConfirmEvent): boolean {
  try {
    if (event === null || typeof event !== "object") return false;
    const native = event.nativeEvent;
    const source = native !== undefined && native !== null ? native : event;
    return typeof source === "object" && source.isTrusted === true;
  } catch {
    return false;
  }
}

/** Never throws. A signal that cannot be read counts as aborted: fail closed. */
function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted === true;
  } catch {
    return true;
  }
}

/**
 * Create a consent queue. Usually one per page, created at module scope and
 * shared by every consequential tool, so all of them queue behind one prompt.
 *
 * Throws a `RangeError` for an invalid `capacity` — a configuration mistake
 * that should fail where it is written, not on the first tool call.
 */
export function createConsentQueue(options?: ConsentQueueOptions): ConsentQueue {
  const capacity = options?.capacity ?? CONSENT_QUEUE_DEFAULT_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("createConsentQueue: capacity must be a positive integer");
  }

  let displayed: { entry: Entry; snapshot: DisplayedConsentRequest } | null = null;
  const waiting: Entry[] = [];
  const listeners = new Set<() => void>();

  const notify = () => {
    // A copy: a listener may subscribe or unsubscribe while being notified.
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* One broken listener must not starve the rest. */ }
    }
  };

  /**
   * Put the next live waiting request on screen. A request whose deadline
   * passed while it waited expires here without ever being shown — its own
   * timer may not have run yet if the event loop was busy.
   */
  const advance = () => {
    while (displayed === null && waiting.length > 0) {
      const entry = waiting[0]!;
      if (entry.settled) { waiting.shift(); continue; } // never display an answered request
      const remaining = entry.deadline - Date.now();
      if (remaining <= 0) {
        entry.settle({ decision: "timeout" });
        continue;
      }
      waiting.shift();
      displayed = {
        entry,
        snapshot: Object.freeze({
          id: entry.id,
          title: entry.title,
          detail: entry.detail,
          confirmLabel: entry.confirmLabel,
          timeoutMs: remaining,
          expiresAt: entry.deadline,
        }),
      };
    }
  };

  /**
   * Expire requests whose deadline has passed but whose timer has not run yet
   * (a busy event loop). Otherwise they would count against capacity and turn
   * a request that fits into a spurious `busy`.
   */
  const purgeExpired = () => {
    const now = Date.now();
    if (displayed !== null && displayed.entry.deadline <= now) displayed.entry.settle({ decision: "timeout" });
    for (const entry of [...waiting]) {
      if (entry.deadline <= now) entry.settle({ decision: "timeout" });
    }
  };

  const surface: ConsentSurface = (consentRequest, surfaceOptions) => {
    try {
      // Read every input exactly once. A getter can answer differently on
      // each read, and the value checked must be the value used.
      const signal = surfaceOptions?.signal;
      const { title, detail, confirmLabel, timeoutMs: requested } = consentRequest;
      // Converted here, outside the promise below: a value whose toString
      // throws must resolve `closed`, not reject the surface.
      const words = { title: String(title), detail: String(detail), confirmLabel: String(confirmLabel) };
      const timeoutMs = requested ?? CONSENT_DEFAULT_TIMEOUT_MS;
      if (signalAborted(signal)) return Promise.resolve({ decision: "closed" });
      if (
        typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
      ) {
        return Promise.resolve({ decision: "closed" });
      }
      purgeExpired();
      if ((displayed ? 1 : 0) + waiting.length >= capacity) {
        return Promise.resolve({ decision: "busy" });
      }

      return new Promise<ConsentResult>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => { entry.settle({ decision: "closed" }); };
        const entry: Entry = {
          id: randomId(),
          settled: false,
          ...words,
          deadline: Date.now() + timeoutMs,
          settle: (result) => {
            if (entry.settled) return false;
            entry.settled = true;
            clearTimeout(timer);
            try { signal?.removeEventListener("abort", onAbort); } catch { /* ignore */ }
            let changed = false;
            if (displayed?.entry === entry) {
              displayed = null;
              advance();
              changed = true;
            } else {
              const index = waiting.indexOf(entry);
              if (index >= 0) waiting.splice(index, 1);
            }
            resolve(result);
            if (changed) notify();
            return true;
          },
        };
        // Bound to THIS entry. However late it fires, it can only expire the
        // request it was created for — never whichever one is on screen now.
        timer = setTimeout(() => entry.settle({ decision: "timeout" }), timeoutMs);
        try { signal?.addEventListener("abort", onAbort, { once: true }); }
        catch { entry.settle({ decision: "closed" }); return; }
        // The signal can fire between the first check and the listener — or,
        // for a hand-rolled signal, synchronously inside addEventListener.
        // Either way the entry is already answered and must never be queued:
        // a settled entry on screen could not be removed by any answer.
        if (signalAborted(signal)) entry.settle({ decision: "closed" });
        if (entry.settled) return;

        waiting.push(entry);
        if (displayed === null) {
          advance();
          notify();
        }
      });
    } catch {
      return Promise.resolve({ decision: "closed" });
    }
  };

  /** Settle the displayed request, but only if it is still the one named. */
  const answer = (id: unknown, result: () => ConsentResult): boolean => {
    const current = displayed;
    if (current === null || typeof id !== "string" || current.snapshot.id !== id) return false;
    // A late timer must not let an answer land after the deadline the surface
    // showed: past it, the request has expired whatever the answer.
    if (Date.now() >= current.entry.deadline) {
      current.entry.settle({ decision: "timeout" });
      return false;
    }
    return current.entry.settle(result());
  };

  return {
    surface,
    subscribe(listener) {
      if (typeof listener !== "function") return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot() {
      return displayed?.snapshot ?? null;
    },
    confirm(id, event) {
      // Read the event BEFORE checking which request is displayed: reading it
      // can run a getter, and a getter can change the queue.
      if (!isTrustedEvent(event)) return false;
      return answer(id, () => ({ decision: "confirmed", auditToken: randomId() }));
    },
    decline(id) {
      return answer(id, () => ({ decision: "declined" }));
    },
    dismiss(id) {
      return answer(id, () => ({ decision: "closed" }));
    },
  };
}
