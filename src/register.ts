/**
 * Feature-detected registration against the proposed Web Model Context API.
 *
 * `navigator.modelContext` / `document.modelContext` is a browser proposal,
 * not a shipped standard. Nothing here may assume it exists: unsupported
 * browsers receive a silent no-op. Experimental browser support is detected
 * rather than inferred from user-agent strings. Load it lazily, after your app has mounted, so a change in
 * the proposal can never break your page.
 */

import type {
  DetectedModelContext,
  ModelContextProvideContext,
  ModelContextRegisterTool,
  ModelContextTool,
} from "./types.js";

type HostState = { scopes: Set<string>; names: Set<string>; bulkOwner?: string };
const registryKey = Symbol.for("@melaninmap/webmcp-consent/hosts/v2");
const globals = globalThis as unknown as Record<symbol, unknown>;
const localRegistry = new WeakMap<object, HostState>();
function stateFor(identity: object): HostState {
  let registry = localRegistry;
  try {
    const existing = globals[registryKey];
    if (existing instanceof WeakMap) registry = existing;
    else globals[registryKey] = registry;
  } catch { /* Local deduplication still works when globals are locked. */ }
  let state = registry.get(identity);
  if (!state) { state = { scopes: new Set(), names: new Set() }; registry.set(identity, state); }
  // Legacy bundles used page-global scopes without host identity. Preserve them
  // conservatively on every detected host while those bundles remain loaded.
  try {
    const legacy = (globalThis as unknown as Record<string, unknown>).__webmcpAgentToolsRegistered;
    if (legacy === true) state.scopes.add("*");
    else if (legacy && typeof legacy === "object") {
      for (const [scope, active] of Object.entries(legacy)) {
        if (active !== true) continue;
        state.scopes.add(scope);
        try {
          const names: unknown = JSON.parse(scope);
          if (Array.isArray(names) && names.every(name => typeof name === "string")) names.forEach(name => state!.names.add(name));
          else state.scopes.add("*");
        } catch { state.scopes.add("*"); }
      }
    }
  } catch { /* Locked legacy globals must not throw into the page. */ }
  return state;
}
function registrationScope(tools: readonly ModelContextTool[], options?: RegisterAgentToolsOptions): string {
  return options?.scope || JSON.stringify([...new Set(tools.map(tool => tool.name))].sort());
}
function markRegistered(state: HostState, scope: string, names: string[]): void {
  state.scopes.add(scope);
  names.forEach(name => state.names.add(name));
}
function releaseOnAbort(signal: AbortSignal | undefined, state: HostState, scope: string, names: string[]): void {
  const release = () => {
    state.scopes.delete(scope);
    names.forEach(name => state.names.delete(name));
  };
  if (signal?.aborted) release();
  else signal?.addEventListener("abort", release, { once: true });
}

/** Narrow one candidate host object, or null if it registers nothing. */
function narrowModelContext(candidate: unknown): (DetectedModelContext & { identity: object }) | null {
  if (typeof candidate !== "object" || candidate === null) return null;

  const host = candidate as Record<string, unknown>;
  const registerTool = host.registerTool;
  const provideContext = host.provideContext;
  const hasRegister = typeof registerTool === "function";
  const hasProvide = typeof provideContext === "function";
  if (!hasRegister && !hasProvide) return null;

  return {
    identity: candidate,
    registerTool: hasRegister
      ? (registerTool as ModelContextRegisterTool).bind(candidate)
      : undefined,
    provideContext: hasProvide
      ? (provideContext as ModelContextProvideContext).bind(candidate)
      : undefined,
  };
}

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
 *
 * `navigator.modelContext` is checked first, then `document.modelContext` —
 * and independently, so a navigator object that exists but exposes no
 * registrar does not mask a working document-level one.
 */
function detectHost(): (DetectedModelContext & { identity: object }) | null {
  for (const target of ["navigator", "document"] as const) {
    try {
      const surface = (globalThis as unknown as Record<string, { modelContext?: unknown }>)[target];
      const host = narrowModelContext(surface?.modelContext);
      if (host) return host;
    } catch { /* A blocked getter must not prevent fallback or break the page. */ }
  }
  return null;
}
export function detectModelContext(): DetectedModelContext | null {
  const host = detectHost();
  if (!host) return null;
  return { registerTool: host.registerTool, provideContext: host.provideContext };
}

export type RegisterAgentToolsOptions = {
  /**
   * Scope the registration to this signal's lifetime. Only the incremental
   * style accepts it; on a bulk-only host the tools live for the page.
   */
  signal?: AbortSignal;
  /**
   * Idempotence scope. Defaults to the sorted tool names, so re-registering
   * the same tools is a no-op while an unrelated set registers independently.
   * Pass an explicit scope to stabilize it across tool list changes.
   */
  scope?: string;
};

export type RegisterResult =
  | {
      registered: false;
      reason:
        | "unsupported"
        | "already_registered"
        | "aborted"
        /** A bulk-only host already holds a different scope's tool set. */
        | "bulk_conflict"
        | "tool_conflict"
        | "async_registration_pending";
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
  options?: RegisterAgentToolsOptions,
): RegisterResult {
  // A signal that has already fired means the caller's scope is gone before we
  // got here (a fast unmount, a cancelled route transition). Registering would
  // publish tools nobody owns.
  if (options?.signal?.aborted) {
    return { registered: false, reason: "aborted" };
  }

  const host = detectHost();
  if (!host) return { registered: false, reason: "unsupported" };
  const state = stateFor(host.identity);
  const scope = registrationScope(tools, options);
  if (state.scopes.has("*") || state.scopes.has(scope)) return { registered: false, reason: "already_registered" };
  const names = tools.map(tool => tool.name);
  if (new Set(names).size !== names.length || names.some(name => state.names.has(name))) {
    return { registered: false, reason: "tool_conflict" };
  }

  let registeredToolCount = 0;
  let allSuccessfulRegistrationsScoped = true;
  let asyncRegistrationPending = false;
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
      //
      // The bag forwarded to the host carries ONLY the WebMCP `{ signal }`.
      // Our own `scope` option is idempotence bookkeeping for the flags below
      // and must never reach the host: an implementation that validates the
      // options bag strictly would reject the unknown key, fall through to the
      // bare retry, and silently drop the caller's abort-scoping.
      const hostOptions = options?.signal
        ? { signal: options.signal }
        : undefined;
      for (const tool of tools) {
        try {
          const result = host.registerTool(tool, hostOptions);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            asyncRegistrationPending = true;
            // The compatibility API cannot report acceptance before it settles.
            // Observe rejections and retain ownership so callers cannot blindly retry.
            void Promise.resolve(result).catch(() => undefined);
          }
        } catch {
          // Some implementations reject an unknown options bag. Retry bare
          // rather than lose the whole registration over it.
          const result = host.registerTool(tool);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            asyncRegistrationPending = true;
            void Promise.resolve(result).catch(() => undefined);
          }
          allSuccessfulRegistrationsScoped = false;
        }
        registeredToolCount += 1;
      }
      markRegistered(state, scope, names.slice(0, registeredToolCount));
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
        releaseOnAbort(options?.signal, state, scope, names.slice(0, registeredToolCount));
      }
      if (asyncRegistrationPending) return { registered: false, reason: "async_registration_pending" };
      return {
        registered: true,
        toolCount: tools.length,
        style: "incremental",
      };
    }
    if (host.provideContext) {
      // Bulk replaces, so a second scope would erase the first. See
      // readBulkOwner. The bulk style also takes no `{ signal }`: these tools
      // live for the page, and an abort does not release this scope.
      const owner = state.bulkOwner ?? null;
      if (owner !== null && owner !== scope) {
        return { registered: false, reason: "bulk_conflict" };
      }
      const result = host.provideContext({ tools: [...tools] });
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        asyncRegistrationPending = true;
        void Promise.resolve(result).catch(() => undefined);
      }
      markRegistered(state, scope, names);
      state.bulkOwner = scope;
      if (asyncRegistrationPending) return { registered: false, reason: "async_registration_pending" };
      return { registered: true, toolCount: tools.length, style: "bulk" };
    }
  } catch {
    if (registeredToolCount > 0) {
      // The proposed incremental API has no unregister/rollback primitive. A
      // retry would duplicate the tools that already landed (and potentially
      // duplicate consent prompts), so retain the idempotence flag and report
      // the partial state explicitly instead of pretending nothing happened.
      markRegistered(state, scope, names.slice(0, registeredToolCount));
      if (allSuccessfulRegistrationsScoped) {
        releaseOnAbort(options?.signal, state, scope, names.slice(0, registeredToolCount));
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

/**
 * Promise-aware registration for the current browser draft. Reservations are
 * made before awaiting the host, so concurrent mounts cannot publish twice.
 * Rejections are surfaced without retrying a possibly consequential host call.
 */
export async function registerAgentToolsAsync(
  tools: readonly ModelContextTool[],
  options?: RegisterAgentToolsOptions,
): Promise<RegisterResult> {
  if (options?.signal?.aborted) return { registered: false, reason: "aborted" };
  const host = detectHost();
  if (!host) return { registered: false, reason: "unsupported" };
  const state = stateFor(host.identity);
  const scope = registrationScope(tools, options);
  if (state.scopes.has("*") || state.scopes.has(scope)) return { registered: false, reason: "already_registered" };
  const names = tools.map(tool => tool.name);
  if (new Set(names).size !== names.length || names.some(name => state.names.has(name))) {
    return { registered: false, reason: "tool_conflict" };
  }
  if (!host.registerTool && state.bulkOwner !== undefined) {
    return { registered: false, reason: "bulk_conflict" };
  }
  markRegistered(state, scope, names);
  // Bulk replaces the entire set; reserve the host while that promise is pending.
  if (!host.registerTool) state.bulkOwner = scope;
  let count = 0;
  try {
    if (host.registerTool) {
      for (const tool of tools) {
        if (options?.signal?.aborted) break;
        await host.registerTool(tool, options?.signal ? { signal: options.signal } : undefined);
        count += 1;
      }
      releaseOnAbort(options?.signal, state, scope, names);
      if (options?.signal?.aborted) return { registered: false, reason: "aborted" };
      return { registered: true, toolCount: count, style: "incremental" };
    }
    await host.provideContext!({ tools: [...tools] });
    return { registered: true, toolCount: tools.length, style: "bulk" };
  } catch {
    // Release names known not to have landed; retain scope and landed names on partial success.
    names.slice(count).forEach(name => state.names.delete(name));
    if (count === 0) {
      state.scopes.delete(scope);
      if (state.bulkOwner === scope) delete state.bulkOwner;
      return { registered: false, reason: "unsupported" };
    }
    releaseOnAbort(options?.signal, state, scope, names.slice(0, count));
    return { registered: false, reason: "partial_registration", toolCount: count };
  }
}
