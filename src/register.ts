/**
 * Feature-detected registration against the proposed Web Model Context API.
 *
 * `document.modelContext` (and the older `navigator.modelContext`) is a browser proposal,
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
function registrationScope(tools: readonly ModelContextTool<unknown>[], options?: RegisterAgentToolsOptions): string {
  return options?.scope || JSON.stringify([...new Set(tools.map(tool => tool.name))].sort());
}
function markRegistered(state: HostState, scope: string, names: string[]): void {
  state.scopes.add(scope);
  names.forEach(name => state.names.add(name));
}
/**
 * A held reservation. Whichever release runs first (abort, or a host
 * rejection) hands back its names, and later releases skip them: by then a
 * remount may own the same names, and deleting them would let a third mount
 * register the same tool twice.
 */
type Reservation = { scope: string; names: string[]; released: boolean };
function releaseOnAbort(signal: AbortSignal | undefined, state: HostState, scope: string, names: string[]): Reservation {
  const reservation: Reservation = { scope, names: [...names], released: false };
  const release = () => {
    if (reservation.released) return;
    reservation.released = true;
    state.scopes.delete(scope);
    reservation.names.forEach(name => state.names.delete(name));
  };
  if (signal?.aborted) release();
  else signal?.addEventListener("abort", release, { once: true });
  return reservation;
}

/**
 * The sync API cannot wait for a host promise, but it can still hand back
 * reservations the host refused. A rejected registration published nothing,
 * so keeping its names would turn a retry into a false `already_registered`
 * while no tool is live. The scope is released only when nothing landed.
 */
function releaseOnRejection(
  pending: ReadonlyArray<{ name: string; result: PromiseLike<unknown> }>,
  landedSynchronously: number,
  state: HostState,
  reservation: Reservation,
): void {
  if (pending.length === 0) return;
  void Promise.allSettled(pending.map(entry => Promise.resolve(entry.result))).then(outcomes => {
    if (reservation.released) return;
    const refused = new Set(
      pending.filter((_, index) => outcomes[index]!.status === "rejected").map(entry => entry.name),
    );
    if (refused.size === 0) return;
    refused.forEach(name => state.names.delete(name));
    reservation.names = reservation.names.filter(name => !refused.has(name));
    if (landedSynchronously === 0 && reservation.names.length === 0) {
      reservation.released = true;
      state.scopes.delete(reservation.scope);
      if (state.bulkOwner === reservation.scope) delete state.bulkOwner;
    }
  }).catch(() => undefined);
}

/**
 * The spec's tool-name rule: 1 to 128 characters of `[A-Za-z0-9_.-]`. The
 * browser rejects anything else, and so does an empty description.
 */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/**
 * The first tool the browser would refuse, checked before anything reaches
 * the host. Caught here, the mistake fails the same way on every browser and
 * never leaves half a set registered.
 */
function firstInvalidTool(tools: readonly ModelContextTool<unknown>[]): string | null {
  for (const tool of tools) {
    let name: unknown;
    let description: unknown;
    try {
      ({ name, description } = tool);
    } catch {
      return "";
    }
    if (typeof name !== "string" || !TOOL_NAME.test(name)) return typeof name === "string" ? name : "";
    if (typeof description !== "string" || description.trim() === "") return name;
  }
  return null;
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
 * `document.modelContext` is checked first: it is where the spec and Chrome 152
 * and later expose the API. `navigator.modelContext` is the pre-2026-05 location
 * (Chrome 146 to 151 and older polyfills), kept as a fallback so a stale
 * polyfill on `navigator` cannot win over the browser's own host. The two are
 * checked independently, so an object that exists but exposes no registrar
 * does not mask a working one at the other location.
 */
function detectHost(): (DetectedModelContext & { identity: object }) | null {
  for (const target of ["document", "navigator"] as const) {
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
  | {
      registered: false;
      /**
       * A tool name outside `[A-Za-z0-9_.-]{1,128}`, or an empty description.
       * Nothing was registered. `toolName` is the first offending name.
       */
      reason: "invalid_tool";
      toolName: string;
    }
  | { registered: true; toolCount: number; style: "bulk" | "incremental" };

/**
 * Register tools if — and only if — a capable browser is present.
 *
 * Never throws. A registrar that can break the host page is worse than no
 * registrar at all.
 */
export function registerAgentTools(
  tools: readonly ModelContextTool<unknown>[],
  options?: RegisterAgentToolsOptions,
): RegisterResult {
  // A signal that has already fired means the caller's scope is gone before we
  // got here (a fast unmount, a cancelled route transition). Registering would
  // publish tools nobody owns.
  if (options?.signal?.aborted) {
    return { registered: false, reason: "aborted" };
  }
  const invalid = firstInvalidTool(tools);
  if (invalid !== null) return { registered: false, reason: "invalid_tool", toolName: invalid };

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
  const pending: { name: string; result: PromiseLike<unknown> }[] = [];
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
            // Keep the reservation while it is pending; releaseOnRejection
            // hands back whatever the host refuses.
            pending.push({ name: tool.name, result: result as PromiseLike<unknown> });
          }
        } catch {
          // Some implementations reject an unknown options bag. Retry bare
          // rather than lose the whole registration over it.
          const result = host.registerTool(tool);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            asyncRegistrationPending = true;
            pending.push({ name: tool.name, result: result as PromiseLike<unknown> });
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
      const landed = names.slice(0, registeredToolCount);
      const reservation: Reservation = allSuccessfulRegistrationsScoped
        ? releaseOnAbort(options?.signal, state, scope, landed)
        : { scope, names: landed, released: false };
      releaseOnRejection(pending, registeredToolCount - pending.length, state, reservation);
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
      markRegistered(state, scope, names);
      state.bulkOwner = scope;
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        asyncRegistrationPending = true;
        // One call carries the whole set, so a rejection releases all of it.
        releaseOnRejection(
          names.map(name => ({ name, result: result as PromiseLike<unknown> })),
          0,
          state,
          { scope, names: [...names], released: false },
        );
      }
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
  tools: readonly ModelContextTool<unknown>[],
  options?: RegisterAgentToolsOptions,
): Promise<RegisterResult> {
  if (options?.signal?.aborted) return { registered: false, reason: "aborted" };
  const invalid = firstInvalidTool(tools);
  if (invalid !== null) return { registered: false, reason: "invalid_tool", toolName: invalid };
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
    // A signal that fired while the host was registering rejects that call
    // with the abort reason. That is the caller ending the scope, not a host
    // without support: report it as such. A conforming host drops the tools
    // that landed, and releaseOnAbort hands their names back.
    if (options?.signal?.aborted) {
      if (count === 0) state.scopes.delete(scope);
      else releaseOnAbort(options.signal, state, scope, names.slice(0, count));
      return { registered: false, reason: "aborted" };
    }
    if (count === 0) {
      state.scopes.delete(scope);
      if (state.bulkOwner === scope) delete state.bulkOwner;
      return { registered: false, reason: "unsupported" };
    }
    releaseOnAbort(options?.signal, state, scope, names.slice(0, count));
    return { registered: false, reason: "partial_registration", toolCount: count };
  }
}
