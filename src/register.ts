/**
 * Feature-detected registration against the proposed Web Model Context API.
 *
 * `navigator.modelContext` / `document.modelContext` is a browser proposal,
 * not a shipped standard. Nothing here may assume it exists: in every browser
 * shipping today `registerAgentTools` is a silent no-op that costs one
 * property read. Load it lazily, after your app has mounted, so a change in
 * the proposal can never break your page.
 */

import type {
  DetectedModelContext,
  ModelContextProvideContext,
  ModelContextRegisterTool,
  ModelContextTool,
} from "./types.js";

const GLOBAL_FLAG = "__webmcpAgentToolsRegistered";

let registeredInThisModule = false;

/**
 * Narrow the host object at runtime. A user agent may ship either the
 * incremental (`registerTool`) or the bulk (`provideContext`) style; we accept
 * whichever is present and prefer INCREMENTAL when both are.
 *
 * Incremental wins for a concrete reason: it is the only style that takes the
 * per-registration `{ signal }` option this function accepts, so preferring
 * bulk would silently ignore an argument the caller passed. An advertised
 * option that does nothing is worse than not offering it. It also matches the
 * deployed registrar in `reference/`, which matters because that file is
 * published beside this one as the same thing done for real.
 */
export function detectModelContext(): DetectedModelContext | null {
  const fromNavigator =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { modelContext?: unknown }).modelContext
      : undefined;
  const fromDocument =
    typeof document !== "undefined"
      ? (document as Document & { modelContext?: unknown }).modelContext
      : undefined;
  const candidate = fromNavigator ?? fromDocument;
  if (typeof candidate !== "object" || candidate === null) return null;

  const host = candidate as Record<string, unknown>;
  const registerTool = host.registerTool;
  const provideContext = host.provideContext;
  const hasRegister = typeof registerTool === "function";
  const hasProvide = typeof provideContext === "function";
  if (!hasRegister && !hasProvide) return null;

  return {
    registerTool: hasRegister
      ? (registerTool as ModelContextRegisterTool).bind(candidate)
      : undefined,
    provideContext: hasProvide
      ? (provideContext as ModelContextProvideContext).bind(candidate)
      : undefined,
  };
}

function alreadyRegistered(): boolean {
  if (registeredInThisModule) return true;
  try {
    return Boolean(
      (globalThis as unknown as Record<string, unknown>)[GLOBAL_FLAG],
    );
  } catch {
    return false;
  }
}

function markRegistered(): void {
  registeredInThisModule = true;
  try {
    (globalThis as unknown as Record<string, unknown>)[GLOBAL_FLAG] = true;
  } catch {
    // The module-level flag still holds for this evaluation.
  }
}

function clearRegistered(): void {
  registeredInThisModule = false;
  try {
    delete (globalThis as unknown as Record<string, unknown>)[GLOBAL_FLAG];
  } catch {
    // The module-level flag is already cleared for this evaluation.
  }
}

/** Frees the idempotence flags when a scoped registration's signal aborts. */
function releaseOnAbort(signal: AbortSignal | undefined): void {
  if (!signal) return;
  try {
    signal.addEventListener("abort", clearRegistered, { once: true });
  } catch {
    // No listener support: the flags simply stay set, which is the old
    // behavior rather than a new failure.
  }
}

export type RegisterResult =
  | {
      registered: false;
      reason: "unsupported" | "already_registered" | "aborted";
    }
  | {
      registered: false;
      reason: "partial_registration";
      toolCount: number;
    }
  | { registered: true; toolCount: number; style: "bulk" | "incremental" };

/**
 * Register tools if — and only if — a capable browser is present.
 *
 * Never throws. A registrar that can break the host page is worse than no
 * registrar at all.
 */
export function registerAgentTools(
  tools: readonly ModelContextTool[],
  options?: { signal?: AbortSignal },
): RegisterResult {
  // A signal that has already fired means the caller's scope is gone before we
  // got here (a fast unmount, a cancelled route transition). Registering would
  // publish tools nobody owns.
  if (options?.signal?.aborted) {
    return { registered: false, reason: "aborted" };
  }

  if (alreadyRegistered()) {
    return { registered: false, reason: "already_registered" };
  }

  const host = detectModelContext();
  if (!host) return { registered: false, reason: "unsupported" };

  let registeredToolCount = 0;
  let allSuccessfulRegistrationsScoped = true;
  try {
    if (host.registerTool) {
      // Whether EVERY tool ended up scoped to the caller's signal. The
      // compatibility fallback below registers bare, and a bare registration
      // survives abort — see the release condition after the loop.
      // Registration is not atomic and WebMCP offers no rollback. If a later
      // tool fails outright, the earlier ones are already live in the host —
      // so the failure path must still mark, or a retry would register those
      // again: duplicate executions, duplicate consent prompts, or a hard
      // failure on a host enforcing unique names. Better to report
      // `unsupported` with some tools registered than to make a retry unsafe.
      for (const tool of tools) {
        try {
          host.registerTool(tool, options);
        } catch {
          // Some implementations reject an unknown options bag. Retry bare
          // rather than lose the whole registration over it.
          host.registerTool(tool);
          allSuccessfulRegistrationsScoped = false;
        }
        registeredToolCount += 1;
      }
      markRegistered();
      // The idempotence flags exist to survive StrictMode double-invocation and
      // HMR. When the caller scopes registration to a signal, a conforming host
      // DROPS the tools on abort — and if the flags stayed set, the next mount
      // would get `already_registered` and never re-register, leaving WebMCP
      // dead for the rest of the page's life. So release them when the scope
      // ends.
      //
      // ONLY when every registration was actually scoped, though. If any tool
      // fell back to a bare call, abort cannot remove it, and releasing the
      // flags would let a remount register the same tool a second time —
      // duplicate executions and duplicate consent prompts, or an outright
      // failure on a host that enforces unique names. Keeping the flags set is
      // the safe side of that trade.
      if (allSuccessfulRegistrationsScoped) {
        releaseOnAbort(options?.signal);
      }
      return {
        registered: true,
        toolCount: tools.length,
        style: "incremental",
      };
    }
    if (host.provideContext) {
      host.provideContext({ tools: [...tools] });
      markRegistered();
      return { registered: true, toolCount: tools.length, style: "bulk" };
    }
  } catch {
    if (registeredToolCount > 0) {
      // The proposed incremental API has no unregister/rollback primitive. A
      // retry would duplicate the tools that already landed (and potentially
      // duplicate consent prompts), so retain the idempotence flag and report
      // the partial state explicitly instead of pretending nothing happened.
      markRegistered();
      if (allSuccessfulRegistrationsScoped) {
        releaseOnAbort(options?.signal);
      }
      return {
        registered: false,
        reason: "partial_registration",
        toolCount: registeredToolCount,
      };
    }
    return { registered: false, reason: "unsupported" };
  }

  return { registered: false, reason: "unsupported" };
}
