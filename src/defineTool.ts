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
  type ConsentRequest,
  type ConsentResult,
  type ConsentSurface,
} from "./consent.js";
import type { ModelContextTool, ModelContextToolResult } from "./types.js";

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
  execute: (args: Args) => Promise<unknown>;
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
    return parseArgs(raw ?? {});
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
    annotations: { readOnlyHint: true, ...spec.annotations },
    execute: async (raw) => {
      const args = safeParseArgs(spec.parseArgs, raw);
      if (args === null) return toToolResult(INVALID_ARGUMENTS);
      try {
        return toToolResult(await spec.execute(args));
      } catch (error) {
        return toToolResult(safeMapError(mapError, error));
      }
    },
  };
}

/** The confirmed decision handed to a consequential action. */
export type ConsentConfirmation = ConsentResult & { decision: "confirmed" };

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
  execute: (args: Args, consent: ConsentConfirmation) => Promise<unknown>;
};

/**
 * A tool with a consequence. The action runs only after a human confirms in
 * the page. There is no bypass parameter and no "trusted caller" path — if you
 * find yourself wanting one, what you actually want is a read tool.
 */
export function defineConsequentialTool<Args>(
  spec: ConsequentialToolSpec<Args>,
): ModelContextTool {
  const mapError = spec.mapError ?? defaultErrorMapper;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: { readOnlyHint: false, ...spec.annotations },
    execute: async (raw) => {
      const args = safeParseArgs(spec.parseArgs, raw);
      if (args === null) return toToolResult(INVALID_ARGUMENTS);

      let decision;
      try {
        const request = spec.describeConsent(args);
        decision = await spec.consent({
          timeoutMs: CONSENT_DEFAULT_TIMEOUT_MS,
          ...request,
        });
      } catch {
        // A consent surface that fails is a consent surface that did not
        // confirm. Fail closed, always.
        return toToolResult(consentRefusal("closed"));
      }

      if (decision.decision !== "confirmed") {
        return toToolResult(consentRefusal(decision.decision));
      }

      try {
        return toToolResult(
          await spec.execute(args, decision as ConsentConfirmation),
        );
      } catch (error) {
        return toToolResult(safeMapError(mapError, error));
      }
    },
  };
}
