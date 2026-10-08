# WebMCP spec drift

Recorded **2026-10-03** for SLA-1606. Package version compared: `1.0.0` on
`main` (`src/types.ts`, `src/register.ts`, `src/defineTool.ts`).

`npm run check:spec` re-runs the mechanical half of this comparison in the
SLA-1569 regression lanes: the nightly schedule on `main`, and PRs labelled
`ci:full` / `ci:release` (see [Keeping this current](#keeping-this-current)). This page is the
human half: what changed upstream, what it means for the package, and what to
do about it.

## Sources

| Source | Location | Revision |
| --- | --- | --- |
| WebMCP spec (W3C Web Machine Learning CG), normative WebIDL | [`webmachinelearning/webmcp/index.bs`](https://github.com/webmachinelearning/webmcp/blob/d61d0e6d297ddb6bff3510b1330dbb215c6ef43c/index.bs), published at <https://webmachinelearning.github.io/webmcp/> | `d61d0e6d297ddb6bff3510b1330dbb215c6ef43c` (2026-09-30, last commit touching `index.bs`); repository HEAD `6891d0e857a0b35d8478aa8a01958565fb5466cd` (2026-10-02) |
| Declarative API explainer (non-normative; the spec section is a TODO) | [`declarative-api-explainer.md`](https://github.com/webmachinelearning/webmcp/blob/6891d0e857a0b35d8478aa8a01958565fb5466cd/declarative-api-explainer.md) | `6891d0e8` (last changed `e7c1ef53`, 2026-09-26) |
| Continuations explainer (proposal only) | [`continuations-explainer.md`](https://github.com/webmachinelearning/webmcp/blob/6891d0e857a0b35d8478aa8a01958565fb5466cd/continuations-explainer.md) | `6891d0e8` (2026-10-02) |
| Chromium implementation | [`third_party/blink/renderer/core/script_tools/`](https://github.com/chromium/chromium/tree/479b12558bdf94837713d5cf6f1c983cee713a41/third_party/blink/renderer/core/script_tools) (`model_context.idl`, `model_context_supplement.idl`, `model_context_tool.idl`) | `479b12558bdf94837713d5cf6f1c983cee713a41` (main@{#1710769}, 2026-10-03) |
| Chrome, executed | Playwright 1.63.0's Chrome for Testing **153.0.8010.12**, launched with `--enable-features=WebMCP` (the switch behind `chrome://flags/#enable-webmcp-testing`) | Probed on 2026-10-03; the behavior that matters is now asserted in `browser-tests/webmcp-host.spec.mjs` |
| Chrome status | [ChromeStatus 5117755740913664](https://chromestatus.com/feature/5117755740913664), [origin trial announcement](https://developer.chrome.com/blog/ai-webmcp-origin-trial) | Dev trial from M146; origin trial "WebMCP" M149 to M156 |

Spec commits referenced below: `fe84c677` (2026-03-05, remove
`provideContext()`/`clearContext()`, #132), `6708e339` (2026-03-26,
`registerTool()` takes an `AbortSignal`, `unregisterTool()` removed, #147),
`c7b5c702` (2026-05-27, `modelContext` moves from `Navigator` to `Document`,
#184), `ec37ec48` (2026-06-08, `registerTool()` returns a promise, #200),
`067a1c90` (2026-06-11, `ModelContextClient` removed, #205), `83e893ac`
(2026-08-19, `execute(input, { signal })`, #247), `7b3f50f3` (2026-09-03,
`consequentialHint`, #217), `8a82bb78` (2026-09-17, `debugging` hint, #253),
`f5645e9a` (2026-09-17, `toolactivated` / `toolcancel` events, #245).

"Chrome 153" cells were observed by running code. Other Chrome milestones come
from reading Chromium's source history and were not executed; they are marked
"(source)".

## API surface, side by side

| API point | Spec (`d61d0e6`) | Package 1.0.0 | Chrome |
| --- | --- | --- | --- |
| Entry point | `document.modelContext`, `[SecureContext, SameObject]`. `navigator.modelContext` was removed in `c7b5c702`. `window.modelContext` never existed in IDL. | `detectHost()` checks `document.modelContext` first, then `navigator.modelContext` (`register.ts`). **Aligned** since the 2026-10-04 follow-up. | 153: `document.modelContext` only; `navigator.modelContext` is `undefined`. (source) `navigator` only in 146 to 149, both in 150 and 151 (the `navigator` one logs a deprecation warning), `document` only from 152. |
| `registerTool(tool, options)` | Returns `Promise<undefined>` (`ec37ec48`). Rejects on a duplicate name, an invalid name or empty description, a schema that does not serialize, `NotAllowedError` without the `tools` permissions policy, and an already-aborted signal. | `registerAgentToolsAsync` awaits it. Sync `registerAgentTools` treats a thenable as `async_registration_pending` (`registered: false`) and keeps the names reserved. | 153: returns a promise, rejecting with `InvalidStateError` ("Duplicate tool name", "Invalid tool name"). |
| Registration options | `{ signal?: AbortSignal, exposedTo?: sequence<USVString> }`. Abort unregisters. | Forwards `{ signal }` only. Never forwards its own `scope`. | HEAD IDL matches the spec. |
| `unregisterTool(name)` | Removed (`6708e339`); abort the registration signal instead. | Not used. | (source) Removed in 148. |
| `provideContext()` / `clearContext()` | Removed (`fe84c677`). | Bulk fallback path used when `registerTool` is missing; `bulk_conflict` logic exists for it. | (source) Removed in 147. |
| Tool dictionary | `name` (required, 1 to 128 chars of `[A-Za-z0-9_.-]`), `title` (optional), `description` (required, non-empty), `inputSchema` (object), `execute` (required), `annotations`. | `ModelContextTool` has `name`, `description`, `inputSchema`, `annotations`, `execute`. No `title`. Names are not validated at definition time. | 153: `getTools()` returns `inputSchema` as a JSON **string** and `title` as `""`. Spec and Chromium HEAD say object. |
| Annotations | `readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging`, all default `false`. | Derives `readOnlyHint`; consequential tools also set `consequentialHint: true`. The type admits any extra keys. | 153 exposes `readOnlyHint` and `untrustedContentHint` only, so `consequentialHint` is dropped. Chromium HEAD has all four. |
| `execute` second argument | `ToolExecuteCallbackOptions { required AbortSignal signal }` (`83e893ac`). `ModelContextClient` / `requestUserInteraction()` was removed in `067a1c90`; the README lists user prompting as future work (issues #165, #50). | `ToolExecutionOptions { signal? }`. `executionOptions()` keeps only a genuine `AbortSignal` (cross-realm brand check) and ignores anything else, including a client object. **Aligned.** | 153: calls `execute(input, { signal })` with a real `AbortSignal`. Aborting `executeTool()`'s signal aborts it, and the consent dialog unmounts (tested). (source) Chromium never passed a client object; 146 to 152 passed the input only. |
| `execute` return value | `Promise<any>`. The browser JSON-serializes the fulfilled value for the agent. | Resolves to an MCP-style `{ content: [{ type: "text", text: JSON }] }`. | 153: JSON-stringifies it, so the agent receives `{"content":[{"type":"text","text":"{\"ok\":true,\"count\":1}"}]}`. |
| Events | `toolchange`, `toolactivated` (`ToolActivatedEvent.toolName`), `toolcancel` (`ToolCancelEvent.toolName`). | Not used. | 153: `ontoolchange` only. (source, inferred from commit position) The other two arrive in 156. |
| In-page agent API | `getTools({ fromOrigins })`, `executeTool(tool, inputObject?, { signal })` returns `Promise<DOMString>`. | Not used by `src/`. The browser suite uses it to invoke tools the way an agent does. | 153: `executeTool()` takes a JSON **string**; an object rejects with `UnknownError: Failed to parse input arguments` before the tool runs. Chromium HEAD takes an object and returns `Promise<DOMString?>`. |
| Permissions policy | Feature `tools`, default allowlist `'self'`. | Not mentioned. A cross-origin iframe needs `allow="tools"`. | HEAD matches the spec. |
| Declarative API | Spec section is "entirely a TODO". The explainer has `<form toolname tooldescription toolautosubmit>`, `toolparamdescription` on controls, `SubmitEvent.agentInvoked`, `SubmitEvent.respondWith()`, and `:tool-form-active` / `:tool-submit-active`. | Not supported. | 153: `SubmitEvent.prototype.agentInvoked` and `respondWith` exist. (source) Chromium also recognizes `tooltitle`. |

## Recommended changes

None of these were made in the SLA-1606 PR, because `src/` was changing in
parallel for SLA-1604 and SLA-1605. Nothing below is a failure of the consent
gate itself. The gate holds on Chrome 153's real WebMCP: no confirm without a
trusted click, and cancellation unmounts the dialog.

**Status, 2026-10-04 follow-up:** done — "Breaks us now" 1 (rejected
reservations are released; the README steers callers to the async API) and 2
(opt-in `resultFormat: "json"`, asserted against Chrome 153 in
`browser-tests/webmcp-host.spec.mjs`), and "Will break us" 1, 2 (documented as
legacy), 3 (checked at registration, before the host, as `invalid_tool`; the
`define*` helpers stay non-throwing), 5 and 6. Still open — "Will break us" 4,
which the browser suite tracks.

### Breaks us now

1. **Sync `registerAgentTools` cannot tell success from failure on any
   current host.** `registerTool()` returns a promise in the spec (`ec37ec48`) and
   in Chrome 151 and later. On Chrome 153, a successful registration and a
   rejected one (for example the invalid name `"bad name!"`) both return
   `{ registered: false, reason: "async_registration_pending" }`. The rejected
   tool's name stays reserved, so a retry returns `already_registered` while
   nothing is registered. This was verified in Chrome 153.
   `registerAgentToolsAsync` handles both cases correctly and the README already
   recommends it.
   *Change:* deprecate `registerAgentTools` for promise-returning hosts in the
   README and types, or release the reservation when the host promise
   rejects.
2. **Tool results reach the agent double-encoded.** The spec and Chrome
   JSON-serialize whatever `execute` resolves to. Because the package resolves an
   MCP content array, the envelope, including a refusal's "Do not retry", arrives
   as an escaped string inside a wrapper. The information survives, but the model
   has to unwrap it, and that is exactly where a refusal can be misread.
   *Change:* on a spec host, resolve the envelope object itself and keep the
   content array for MCP-style polyfills. `ModelContextToolResult` is public, so
   this needs a compatible API, for example an opt-in result style, and a minor
   release.

### Will break us

1. **Detection prefers `navigator.modelContext`.** That location is gone from
   the spec and from Chrome 152 onward, so today it is only probed and skipped. On
   Chrome 150 and 151, which are still inside the origin-trial window, the package
   would use the deprecated alias. On any browser, a polyfill or extension that
   still installs `navigator.modelContext` would win over the native
   `document.modelContext`, so tools would register where the browser's agent
   cannot see them.
   *Change:* check `document.modelContext` first and keep `navigator` as a
   fallback. This is a two-line swap in `detectHost()`, deferred only because
   `register.ts` is being edited for SLA-1604/1605.
2. **The bulk `provideContext` path is dead upstream** (`fe84c677`, Chrome 147).
   Only polyfills reach it now.
   *Change:* mark it legacy and drop it in the next major version.
3. **Names and descriptions are validated late.** The spec rejects names
   outside `[A-Za-z0-9_.-]{1,128}` and empty descriptions. The package lets them
   through `defineReadTool` / `defineConsequentialTool`, and the failure shows up
   only at registration as `unsupported` or `partial_registration` (or, through
   the sync API, not at all).
   *Change:* validate in the `define*` helpers.
4. **Chrome 153 still differs from the spec in ways the next Playwright bump
   will change:** `executeTool()` input as a JSON string rather than an object,
   `RegisteredTool.inputSchema` as a string, and `consequentialHint` not exposed.
   The browser suite accepts either `executeTool()` input form and does not
   assert `consequentialHint`, so a bump changes the recorded behavior without
   failing for the wrong reason.
5. **An abort during async registration is reported as `unsupported`.** A
   signal that aborts while `registerTool()` is pending rejects with the abort
   reason, and `registerAgentToolsAsync`'s catch reports `unsupported` (or
   `partial_registration`) rather than `aborted`.
   *Change:* check `signal.aborted` in the catch.
6. **Permissions policy.** Tools registered from a cross-origin iframe fail with
   `NotAllowedError` unless the embedder grants `allow="tools"`.
   *Change:* document it in the README.

### Opportunity

1. **`requestUserInteraction()` is the consent gate's natural hook.** It was
   removed with `ModelContextClient` (`067a1c90`) but is still listed as future
   work (issues #165, #50). If it returns, `domConsentSurface` should run inside it,
   so the browser's agent knows the page is waiting on the person instead of
   treating the call as hung.
   *Change:* track upstream. The gate already ignores a client-shaped second
   argument (tested), so adopting it later is additive.
2. **`consequentialHint` is now standard** (`7b3f50f3`). The package already sets
   it on every consequential tool. Chrome 153 drops it, and Chromium HEAD will
   pass it to the agent.
   *Change:* update the `types.ts` comment that calls annotations "MCP-style".
3. **`title`:** add an optional `title` to `ToolSpec` and `ModelContextTool` for
   browsers that show tools in native UI.
4. **`exposedTo`:** forward it through `RegisterAgentToolsOptions` for embedders
   that deliberately expose tools to another origin.
5. **`untrustedContentHint`:** let read tools that return user-generated content
   say so.
6. **`toolactivated` / `toolcancel`:** a source for the SLA-1605 `onDecision`
   hook or for telemetry. Cancellation itself already arrives through the
   execute signal.
7. **Declarative API:** document that a consequential `<form toolname>` must not
   set `toolautosubmit`, because the person's own submit is the consent. A later
   helper could put `SubmitEvent.agentInvoked` plus `respondWith()` behind a
   consent surface.
8. **Continuations** (`invocation.requestToken()`, `resumeTool()`; explainer
   only): a way to keep a consent decision meaningful across a navigation. Watch,
   don't build.

## Keeping this current

- `npm run check:spec` fetches `index.bs` from `main`, extracts every
  `<xmp class="idl">` / `<pre class="idl">` block with
  [webidl2](https://github.com/w3c/webidl2.js) plus the `<dfn permission>`
  features, and compares the result with `spec/webmcp-surface.json`. It reports
  drift by exit status: 0 for none, 1 for drift or a moved source, 3 for a
  source it can no longer parse, 64 for a usage error (including a `--ref`
  that does not exist), 75 for a network failure (nothing compared). HTML
  comments are ignored, and a definition and its partials merge, so moving a
  member between them is not reported as a removal. It
  also flags any member the package depends on that disappears.
- When it reports drift, update this page, decide what the package does about
  it, then accept the new surface with `npm run check:spec -- --update`.
  `npm run check:spec -- --ref <sha>` checks a specific upstream commit.
- `npm run test:browser` runs `browser-tests/webmcp-host.spec.mjs` against
  Chromium's real WebMCP implementation, so a Playwright bump that changes
  Chrome's behavior shows up there.
