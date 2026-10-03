/**
 * Tool definition helpers.
 *
 * Two rules, enforced by construction rather than by review:
 *
 * 1. A tool never throws into the agent runtime. Every failure becomes a
 *    result envelope the model can read and reason about. A thrown exception
 *    is an opaque dead end; `{ ok: false, code, message }` is a next step.
 *
 * 2. A consequential tool cannot be defined without a consent surface. There
 *    is no code path through `defineConsequentialTool` that reaches the action
 *    without first awaiting a human decision. You cannot forget the gate,
 *    because the gate is the only door.
 */

import {
  CONSENT_DEFAULT_TIMEOUT_MS,
  consentRefusal,
  type ConsentDecision,
  type ConsentRequest,
  type ConsentResult,
  type ConsentSurface,
} from "./consent.js";
import { argsDigest } from "./digest.js";
import type { ModelContextTool, ModelContextToolResult, ToolExecutionOptions } from "./types.js";

/**
 * Everything a tool returns is JSON in a single text block.
 *
 * `execute` is typed `Promise<unknown>`, so a side-effect-only implementation
 * legitimately resolves to `undefined` — and `JSON.stringify(undefined)`
 * returns `undefined`, not a string. That would hand the host a text block
 * whose `text` is not a string, breaking our own `ModelContextTextContent`
 * contract and turning a SUCCESSFUL call into a malformed result. Anything
 * that does not serialise — a value JSON.stringify skips, and equally one it
 * THROWS on — becomes `null`, which is valid JSON and reads to a model as
 * "this worked and returned nothing".
 */
export function toToolResult(value: unknown): ModelContextToolResult {
  // JSON.stringify does not merely return undefined for unserialisable input —
  // it THROWS on a bigint or a circular object. This call sits inside the
  // execute try/catch, so a throw here would be mapped to `tool_unavailable`
  // even though the call SUCCEEDED. On a consequential tool the side effect has
  // already happened by then, and reporting it as unavailable invites the model
  // or the person to retry a handoff that already went through.
  //
  // So serialisation failure is contained here, and the promised valid-JSON
  // fallback is emitted instead.
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  return {
    content: [{ type: "text", text: typeof text === "string" ? text : "null" }],
  };
}

const CANCELLED = {
  ok: false, code: "tool_cancelled",
  message: "The tool call was cancelled. Do not retry automatically.",
};

/**
 * This realm's own `AbortSignal.prototype.aborted` getter. Calling it on a
 * value is a brand check that works across realms: a genuine signal from an
 * iframe passes, while a Proxy, an `Object.create` object or a signal-shaped
 * fake throws. It also ignores an own `aborted` property shadowing the real one.
 */
const abortedGetter: ((this: unknown) => boolean) | undefined = (() => {
  try {
    return typeof AbortSignal === "undefined"
      ? undefined
      : (Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get as
          | ((this: unknown) => boolean)
          | undefined);
  } catch {
    return undefined;
  }
})();

/** Never throws. A signal that cannot be read counts as aborted: fail closed. */
function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return abortedGetter ? abortedGetter.call(signal) === true : signal.aborted === true;
  } catch {
    return true;
  }
}

/**
 * Read the host's execution options once, keeping only a genuine AbortSignal.
 *
 * The host is untyped in practice. `null`, `{}` or a signal-shaped object must
 * not throw on the way in, and must not reach handlers as if it could cancel
 * a `fetch`.
 */
function executionOptions(options: unknown): ToolExecutionOptions {
  try {
    const signal = (options as { signal?: unknown } | null | undefined)?.signal;
    if (abortedGetter === undefined || signal === null || typeof signal !== "object") return {};
    abortedGetter.call(signal); // throws for anything that is not a real signal
    return { signal: signal as AbortSignal };
  } catch {
    return {};
  }
}

/** Enforce the deadline even when consumer code ignores its own timeout. */
async function awaitConsent(
  surface: ConsentSurface,
  request: ConsentRequest,
  signal?: AbortSignal,
): Promise<ConsentResult> {
  const timeoutMs = request.timeoutMs ?? CONSENT_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return { decision: "closed" };
  }
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ConsentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A host signal can carry its own throwing methods. This runs from a
      // timer, outside every try/catch, so it must not throw.
      try { signal?.removeEventListener("abort", cancel); } catch { /* ignore */ }
      resolve(result);
      controller.abort();
    };
    const cancel = () => finish({ decision: "closed" });
    const timer = setTimeout(() => finish({ decision: "timeout" }), timeoutMs);
    try { signal?.addEventListener("abort", cancel, { once: true }); }
    catch { finish({ decision: "closed" }); return; }
    if (isAborted(signal)) { cancel(); return; }
    try {
      Promise.resolve(surface({ ...request, timeoutMs }, { signal: controller.signal }))
        .then(value => {
          try { finish(normalizeConsentResult(value)); }
          catch { finish({ decision: "closed" }); }
        }, () => finish({ decision: "closed" }));
    } catch { finish({ decision: "closed" }); }
  });
}

export type ToolFailure = { ok: false; code: string; message?: string };

/**
 * Map a thrown value to a stable public code. Never let an internal error
 * string reach the model: it leaks implementation detail into a transcript you
 * do not control, and it gives the model nothing actionable.
 */
export type ErrorMapper = (error: unknown) => ToolFailure;

const defaultErrorMapper: ErrorMapper = () => ({
  ok: false,
  code: "tool_unavailable",
  message: "This tool is temporarily unavailable. Do not retry immediately.",
});

/**
 * Run a consumer's error mapper without letting it escape.
 *
 * A mapper is written to inspect an error's shape, and error shapes are
 * exactly what surprises people — `error.response.status` on a network failure,
 * say. If the mapper throws while handling a failure, the tool promise rejects
 * into the agent runtime and rule 1 is broken on the path that exists to
 * uphold it. Fall back to the default envelope instead.
 */
function safeMapError(mapError: ErrorMapper, error: unknown): ToolFailure {
  try {
    return mapError(error);
  } catch {
    return defaultErrorMapper(error);
  }
}

export type ToolSpec<Args> = {
  name: string;
  /**
   * Written for a model that has never seen this site and gets exactly one
   * attempt. Say what the tool returns, name the arguments it needs and where
   * they come from, and state any ordering dependency explicitly.
   */
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ModelContextTool["annotations"];
  /** Validate and narrow raw model-supplied arguments, or return null. */
  parseArgs: (raw: Record<string, unknown>) => Args | null;
  execute: (args: Args, options: ToolExecutionOptions) => Promise<unknown>;
  mapError?: ErrorMapper;
};

const INVALID_ARGUMENTS: ToolFailure = {
  ok: false,
  code: "invalid_arguments",
  message: "Arguments did not match the tool's input schema.",
};

/**
 * Run a consumer's `parseArgs` without letting it escape.
 *
 * `parseArgs` is documented as returning null for bad input, but the natural
 * way to write one is to wrap a schema validator — and most of them (Zod's
 * `.parse`, Valibot, ajv in throwing mode) signal failure by throwing. If that
 * throw reached the agent runtime it would break rule 1 at the top of this
 * file, and it would break it in the *most* confusing place: the model would
 * see a rejected tool call rather than "your arguments were wrong", and would
 * have nothing to correct.
 *
 * A parser that throws is a parser saying the arguments are invalid, so it is
 * treated identically to returning null.
 */
function safeParseArgs<Args>(
  parseArgs: (raw: Record<string, unknown>) => Args | null,
  raw: Record<string, unknown>,
): Args | null {
  try {
    // The host is untyped in practice: a conforming runtime sends an object,
    // but nothing enforces it. A string, array or other non-plain value is
    // normalized to {} so parseArgs always sees the shape it was written for.
    return parseArgs(
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? raw
        : {},
    );
  } catch {
    return null;
  }
}

/** A read-only tool. No consent gate — reads have no consequence to confirm. */
export function defineReadTool<Args>(spec: ToolSpec<Args>): ModelContextTool {
  const mapError = spec.mapError ?? defaultErrorMapper;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    // readOnlyHint is derived, not caller-set: the spread order makes the
    // tool kind win over spec.annotations so a read tool can never be marked
    // non-read-only (and, below, a consequential tool can never claim to be).
    annotations: { ...spec.annotations, readOnlyHint: true },
    execute: async (raw, hostOptions) => {
      const options = executionOptions(hostOptions);
      if (isAborted(options.signal)) return toToolResult(CANCELLED);
      const args = safeParseArgs(spec.parseArgs, raw);
      if (args === null) return toToolResult(INVALID_ARGUMENTS);
      try {
        return toToolResult(await spec.execute(args, options));
      } catch (error) {
        // A handler that forwards the signal to fetch rejects with an abort
        // error. That is a cancellation, not an unavailable tool.
        if (isAborted(options.signal)) return toToolResult(CANCELLED);
        return toToolResult(safeMapError(mapError, error));
      }
    },
  };
}

/**
 * The confirmed decision handed to a consequential action — plus, when the
 * tool has an `exchangeConsent` step, the server proof it was exchanged for.
 */
export type ConsentConfirmation = Extract<
  ConsentResult,
  { decision: "confirmed" }
> & {
  /**
   * The proof `exchangeConsent` returned for this exact call. Present if and
   * only if the tool defines `exchangeConsent`: without one there is nothing
   * to exchange, and with one the action never runs unless a proof came
   * back. Send it with the action; your server checks it with
   * `verifyConsentProof` from `@melaninmap/webmcp-consent/server`.
   */
  proof?: string;
};

/** What `exchangeConsent` receives. */
export type ConsentExchangeRequest = {
  /** The tool's registered name. */
  toolName: string;
  /**
   * `argsDigest(toolName, args)` over the arguments `parseArgs` returned —
   * the same arguments `execute` will receive. Your server binds the proof to
   * it and recomputes it from the action request.
   */
  argsDigest: string;
  /** The confirmation's audit token, if the surface minted one. */
  auditToken?: string;
  /**
   * Aborts when the host cancels the call or the exchange deadline
   * (`CONSENT_EXCHANGE_TIMEOUT_MS`) passes. Forward it to `fetch`.
   */
  signal: AbortSignal;
};

/**
 * Trade a confirmation for a server proof bound to this exact call. Return
 * the proof string; anything else — a throw, a rejection, a non-string, an
 * empty string, no answer before the deadline — fails closed as
 * `consent_unverified` and the action never runs.
 */
export type ConsentExchange = (request: ConsentExchangeRequest) => Promise<string> | string;

/** How long the gate waits for `exchangeConsent` before failing closed. */
export const CONSENT_EXCHANGE_TIMEOUT_MS = 30_000;

const UNVERIFIED: ToolFailure = {
  ok: false,
  code: "consent_unverified",
  message:
    "The person confirmed, but the confirmation could not be verified with the server, so nothing was done. " +
    "Do not retry automatically. Tell the person it did not go through.",
};

/** Distinguishes "the host cancelled" from "no proof" in the exchange's answer. */
const EXCHANGE_CANCELLED = Symbol("exchange cancelled");

/**
 * Run the host's exchange under the same rules as the consent surface: it
 * cannot throw into the runtime, cannot hang the call, and cannot confirm by
 * answering something that merely resembles a proof.
 *
 * The digest is computed after the confirmation and over the very object
 * `execute` receives, so the proof binds what will actually be sent. Args
 * that are not pure JSON cannot be digested; with an exchange configured,
 * such a call fails closed rather than binding to an approximation.
 */
async function exchangeProof(
  exchange: ConsentExchange,
  toolName: string,
  args: unknown,
  auditToken: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | null | typeof EXCHANGE_CANCELLED> {
  let digest: string;
  try {
    digest = await argsDigest(toolName, args);
  } catch {
    return null;
  }
  if (isAborted(signal)) return EXCHANGE_CANCELLED;
  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null | typeof EXCHANGE_CANCELLED) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { signal?.removeEventListener("abort", cancel); } catch { /* ignore */ }
      resolve(value);
      // Tell an exchange still in flight that nobody is listening any more.
      controller.abort();
    };
    const cancel = () => finish(EXCHANGE_CANCELLED);
    const timer = setTimeout(() => finish(null), CONSENT_EXCHANGE_TIMEOUT_MS);
    try { signal?.addEventListener("abort", cancel, { once: true }); }
    catch { finish(null); return; }
    if (isAborted(signal)) { cancel(); return; }
    try {
      const request: ConsentExchangeRequest = { toolName, argsDigest: digest, signal: controller.signal };
      if (auditToken !== undefined) request.auditToken = auditToken;
      Promise.resolve(exchange(request)).then(
        (proof) => finish(typeof proof === "string" && proof.length > 0 ? proof : null),
        () => finish(null),
      );
    } catch {
      finish(null);
    }
  });
}

/**
 * What `onDecision` receives: one plain record per gated call.
 *
 * Deliberately small. It carries no arguments and no tokens, because a
 * decision log is usually shipped somewhere lower-trust than the action
 * itself — an analytics pipeline, a third-party logger — and arguments are
 * where personal data lives (a message body, a recipient, an address). The
 * audit token stays out for the same reason: it already reaches `execute`,
 * which is the one place that needs it, and a copy in a log is a copy an
 * attacker reading that log can replay into your audit trail. If you want
 * either in your log, you already have both inside `execute`, where you
 * decide what leaves the page.
 */
export type ConsentDecisionRecord = {
  /** The tool's registered name. */
  toolName: string;
  /**
   * The gate's outcome. `cancelled` means the host aborted the call while the
   * prompt was open (or while a confirmation was being exchanged), whatever
   * the surface reported; it is the same moment the model receives
   * `tool_cancelled`. `unverified` means the person confirmed but
   * `exchangeConsent` produced no proof, so the action did not run.
   *
   * With `exchangeConsent`, a confirmation is reported once the exchange
   * finishes, so `confirmed` always means "and the action is about to run".
   */
  decision: ConsentDecision | "cancelled" | "unverified";
  /**
   * Milliseconds from asking the surface to the decision, including time a
   * request spent queued behind another prompt. Measured with a monotonic
   * clock where one exists.
   */
  elapsedMs: number;
};

/**
 * Observe every consent decision a consequential tool reaches — for your own
 * confirmation log, metrics, or an "agent activity" panel.
 *
 * Called exactly once per call that reached the consent gate (its arguments
 * parsed), at the moment the decision is known and before any action runs.
 * Calls refused earlier — cancelled before they started, or invalid
 * arguments — never asked anyone anything and are not reported.
 *
 * It is an observer, not a participant: it cannot change the result or veto
 * the action, its return value is ignored, and it is never awaited, so a slow
 * logger cannot delay the tool. A synchronous throw or a rejected promise is
 * swallowed. (A synchronous function that blocks the thread still blocks the
 * thread — nothing in JavaScript can prevent that — so keep it cheap.)
 */
export type DecisionObserver = (record: ConsentDecisionRecord) => unknown;

/** A monotonic clock where the runtime has one; elapsed time must not go negative. */
function now(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch { /* fall through */ }
  return Date.now();
}

/**
 * Report a decision without letting the observer touch the result.
 *
 * Every step is inside the try: calling the observer, and adopting whatever
 * it returned. `Promise.resolve` on a hostile thenable can itself throw
 * synchronously (a throwing `constructor` getter on a promise subclass), and
 * attaching the catch is what keeps an async observer's rejection from
 * surfacing as an unhandled rejection in the host page.
 */
function reportDecision(
  observer: DecisionObserver | undefined,
  toolName: string,
  decision: ConsentDecisionRecord["decision"],
  startedAt: number,
): void {
  if (typeof observer !== "function") return;
  try {
    const returned = observer({
      toolName,
      decision,
      elapsedMs: Math.max(0, now() - startedAt),
    });
    if (returned !== null && (typeof returned === "object" || typeof returned === "function")) {
      Promise.resolve(returned).catch(() => undefined);
    }
  } catch { /* An observer that fails has observed nothing. The result stands. */ }
}

export type ConsequentialToolSpec<Args> = Omit<ToolSpec<Args>, "execute"> & {
  /** The confirmation surface. Required — this is the point of the package. */
  consent: ConsentSurface;
  /**
   * Build the prompt from the parsed arguments. Name the real target: "Hold 2
   * tickets to the Saturday history tour", not "Confirm this action". A person
   * who cannot tell what they are agreeing to has not agreed to it.
   */
  describeConsent: (args: Args) => ConsentRequest;
  /**
   * Runs only after a human confirms. Receives the confirmation itself as a
   * second argument, so `auditToken` can be forwarded to your backend as
   * evidence that a confirmation surface was shown and answered — the whole
   * reason that token exists. Without this the token would be unreachable and
   * consumers would resort to out-of-band shared state, which is both racy and
   * exactly the kind of ambient authority this package argues against.
   */
  execute: (args: Args, consent: ConsentConfirmation, options: ToolExecutionOptions) => Promise<unknown>;
  /** Optional. See `DecisionObserver`: logs decisions, never changes them. */
  onDecision?: DecisionObserver;
  /**
   * Optional. Trade each confirmation for a server proof before the action
   * runs — see `ConsentExchange` and `@melaninmap/webmcp-consent/server`.
   * When set, the action runs only with a proof, and receives it as
   * `consent.proof`. Requires `parseArgs` to return pure JSON (see
   * `argsDigest`).
   */
  exchangeConsent?: ConsentExchange;
};

const REFUSAL_DECISIONS: ReadonlySet<unknown> = new Set([
  "declined",
  "timeout",
  "closed",
  "busy",
]);

/**
 * Narrow whatever the surface resolved to.
 *
 * The type says `ConsentResult`, but a surface is consumer code and often
 * plain JavaScript. Resolving `undefined` would make `decision.decision` throw
 * into the agent runtime, and an unknown string would leak into the refusal
 * code as `consent_yes`. Only an object whose `decision` is exactly
 * `"confirmed"` confirms; a known refusal keeps its meaning; anything else
 * becomes `closed`. Fail closed, and stay well formed while doing it.
 */
function normalizeConsentResult(value: unknown): ConsentResult {
  if (value === null || typeof value !== "object") {
    return { decision: "closed" };
  }
  // Read each property exactly once. A getter or Proxy can answer differently
  // on every read, and the value checked must be the value returned.
  const { decision, auditToken } = value as {
    decision?: unknown;
    auditToken?: unknown;
  };
  if (decision === "confirmed") {
    return typeof auditToken === "string"
      ? { decision: "confirmed", auditToken }
      : { decision: "confirmed" };
  }
  return REFUSAL_DECISIONS.has(decision)
    ? { decision: decision as Exclude<ConsentDecision, "confirmed"> }
    : { decision: "closed" };
}

/**
 * A tool with a consequence. The action runs only after a human confirms in
 * the page. There is no bypass parameter and no "trusted caller" path — if you
 * find yourself wanting one, what you actually want is a read tool.
 */
export function defineConsequentialTool<Args>(
  spec: ConsequentialToolSpec<Args>,
): ModelContextTool {
  const mapError = spec.mapError ?? defaultErrorMapper;
  // Read once, at definition: the name in a decision record is then the name
  // the host registered, and an observer or exchange behind a throwing getter
  // fails here, where it is written, instead of rejecting a tool call into
  // the runtime.
  const name = spec.name;
  const onDecision = spec.onDecision;
  const exchange = spec.exchangeConsent;
  return {
    name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: { ...spec.annotations, readOnlyHint: false, consequentialHint: true },
    execute: async (raw, hostOptions) => {
      const options = executionOptions(hostOptions);
      if (isAborted(options.signal)) return toToolResult(CANCELLED);
      const args = safeParseArgs(spec.parseArgs, raw);
      if (args === null) return toToolResult(INVALID_ARGUMENTS);

      const startedAt = now();
      const report = (outcome: ConsentDecisionRecord["decision"]) =>
        reportDecision(onDecision, name, outcome, startedAt);

      let decision: ConsentResult;
      try {
        const request = spec.describeConsent(args);
        decision = await awaitConsent(spec.consent, request, options.signal);
      } catch {
        // A consent surface that fails is a consent surface that did not
        // confirm. Fail closed, always.
        report("closed");
        return toToolResult(consentRefusal("closed"));
      }

      if (isAborted(options.signal)) {
        report("cancelled");
        return toToolResult(CANCELLED);
      }
      if (decision.decision !== "confirmed") {
        report(decision.decision);
        return toToolResult(consentRefusal(decision.decision));
      }

      let confirmation: ConsentConfirmation = decision;
      if (exchange !== undefined) {
        // A configured exchange that is not callable is a gate that cannot
        // verify. Fail closed rather than quietly skipping the step.
        const proof = typeof exchange === "function"
          ? await exchangeProof(exchange, name, args, decision.auditToken, options.signal)
          : null;
        if (proof === EXCHANGE_CANCELLED || isAborted(options.signal)) {
          report("cancelled");
          return toToolResult(CANCELLED);
        }
        if (proof === null) {
          report("unverified");
          return toToolResult(UNVERIFIED);
        }
        confirmation = { ...decision, proof };
      }
      report("confirmed");
      // The observer runs synchronously and may itself abort the host signal.
      if (isAborted(options.signal)) return toToolResult(CANCELLED);

      try {
        return toToolResult(await spec.execute(args, confirmation, options));
      } catch (error) {
        // Same as the read path: an aborted signal means cancelled.
        if (isAborted(options.signal)) return toToolResult(CANCELLED);
        return toToolResult(safeMapError(mapError, error));
      }
    },
  };
}
