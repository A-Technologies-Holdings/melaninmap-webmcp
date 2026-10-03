/**
 * The consent gate.
 *
 * This is the part of the package that matters. Everything else is plumbing.
 *
 * A WebMCP tool runs because a language model decided to call it. The person
 * sitting in front of the browser did not click anything. For a read-only
 * lookup that is fine. For an action with a consequence — spending money,
 * sending a message, handing an identity to a third party — it is not.
 *
 * The rule this package encodes: **a consequential tool never performs its
 * action itself.** It suspends, renders a confirmation surface in the page's
 * own DOM, and resolves only when a human interacts with that surface. If the
 * person declines, or does not answer inside the timeout, the tool returns a
 * refusal envelope to the model. The model is told what happened. It is never
 * given a way to answer on the person's behalf.
 *
 * ## What this does and does not prove
 *
 * Be honest about the boundary, because it is easy to overclaim.
 *
 * A confirmation gate makes it impossible for *the agent* to take the action
 * through the tool surface without a human in the loop. That is its whole job,
 * and it does that job completely.
 *
 * It does NOT authenticate the human to your server. Any HTTP endpoint your
 * page can call, a script can also call — including with whatever consent
 * field your page sends. Treat a consent token as an audit record and a UX
 * contract, never as an authorization credential. Your server still needs its
 * own defenses: bind the action to server-minted state the caller could not
 * invent, rate limit on something the caller cannot rotate, restrict the set
 * of reachable destinations, and never let this path move money or disclose
 * personal data.
 *
 * See SECURITY.md for the full threat model.
 */

/**
 * How a consent request ended.
 *
 * `busy` is distinct from `closed` on purpose. `closed` means a prompt was
 * dismissed (or could not be shown at all) and the model should not retry.
 * `busy` means the surface is already showing — or holding as many as it will
 * hold of — other confirmations, so THIS request was never shown. The person
 * has not said no to it. An agent that cannot tell the two apart either gives
 * up on an action nobody refused or retries a dismissal in a loop.
 */
export type ConsentDecision =
  | "confirmed"
  | "declined"
  | "timeout"
  | "closed"
  | "busy";

export type ConsentRequest = {
  /** Short human sentence: the action, named plainly. */
  title: string;
  /** What the person is agreeing to, in their own interest's terms. */
  detail: string;
  /** Label on the affirmative control. Say the action, not "OK". */
  confirmLabel: string;
  /** Milliseconds before an unanswered prompt resolves as `timeout`. */
  timeoutMs?: number;
};

/**
 * The surface's answer, as a discriminated union: a confirmation is the only
 * outcome that may carry an audit token, so the type itself makes a token on
 * a refusal unrepresentable rather than merely undocumented.
 */
export type ConsentResult =
  | {
      decision: "confirmed";
      /**
       * Opaque token the caller may forward to its own backend as an audit
       * record of the confirmation.
       *
       * This is evidence for your logs, not a credential. Do not authorize on
       * it.
       */
      auditToken?: string;
    }
  | { decision: "declined" | "timeout" | "closed" | "busy" };

/**
 * A consent surface. Implement this over whatever your page already uses for
 * modals — the reference implementation in `examples/` mounts a plain dialog.
 *
 * Contract:
 * - MUST render inside the page the person is looking at.
 * - MUST require a distinct affirmative interaction (not a dismiss).
 * - MUST resolve exactly once, and MUST resolve on timeout rather than hang.
 * - MUST NOT be callable by a tool without producing a visible surface.
 * - MAY resolve `busy` immediately, without showing anything, when it cannot
 *   take another request. That is the only outcome allowed to skip the
 *   visible surface, and it never runs the action.
 */
export type ConsentSurface = (
  request: ConsentRequest,
  options?: { signal?: AbortSignal },
) => Promise<ConsentResult>;

export const CONSENT_DEFAULT_TIMEOUT_MS = 120_000;

/** Refusal envelope handed back to the model when consent is not given. */
export function consentRefusal(
  decision: Exclude<ConsentDecision, "confirmed">,
): {
  ok: false;
  code: string;
  message: string;
} {
  // An exhaustive table rather than a ternary chain, so a future decision is
  // a type error here instead of silently borrowing the last branch's words.
  const messages: Record<Exclude<ConsentDecision, "confirmed">, string> = {
    declined:
      "The person declined this action. Do not retry it. Ask what they would prefer instead.",
    timeout:
      "The confirmation prompt timed out with no answer. Do not retry automatically.",
    closed:
      "The confirmation prompt was dismissed without an answer. Do not retry automatically.",
    // Never shown, so never refused: the one refusal that permits a retry —
    // once, later, after the open confirmation has been answered.
    busy:
      "Another confirmation is already open for this person, so this request was not shown. " +
      "Wait for that one to be answered; you may then retry this action once. Do not retry in a loop.",
  };
  // A plain-JavaScript caller can pass anything. An unknown decision must not
  // leak into the code as `consent_yes`: it is a dismissal, like any other
  // answer the gate cannot read.
  const known = Object.prototype.hasOwnProperty.call(messages, decision);
  const safe = known ? decision : "closed";
  return { ok: false, code: `consent_${safe}`, message: messages[safe] };
}
