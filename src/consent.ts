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

export type ConsentDecision = "confirmed" | "declined" | "timeout" | "closed";

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

export type ConsentResult = {
  decision: ConsentDecision;
  /**
   * Opaque token the caller may forward to its own backend as an audit record
   * of the confirmation. Present only when `decision === "confirmed"`.
   *
   * This is evidence for your logs, not a credential. Do not authorize on it.
   */
  auditToken?: string;
};

/**
 * A consent surface. Implement this over whatever your page already uses for
 * modals — the reference implementation in `examples/` mounts a plain dialog.
 *
 * Contract:
 * - MUST render inside the page the person is looking at.
 * - MUST require a distinct affirmative interaction (not a dismiss).
 * - MUST resolve exactly once, and MUST resolve on timeout rather than hang.
 * - MUST NOT be callable by a tool without producing a visible surface.
 */
export type ConsentSurface = (
  request: ConsentRequest,
) => Promise<ConsentResult>;

export const CONSENT_DEFAULT_TIMEOUT_MS = 120_000;

/** Refusal envelope handed back to the model when consent is not given. */
export function consentRefusal(decision: ConsentDecision): {
  ok: false;
  code: string;
  message: string;
} {
  const message =
    decision === "declined"
      ? "The person declined this action. Do not retry it. Ask what they would prefer instead."
      : decision === "timeout"
        ? "The confirmation prompt timed out with no answer. Do not retry automatically."
        : "The confirmation prompt was dismissed without an answer. Do not retry automatically.";
  return { ok: false, code: `consent_${decision}`, message };
}
