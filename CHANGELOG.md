# Changelog

All notable changes to `@melaninmap/webmcp-consent` are documented here. The
project follows the compatibility contract in [CONTRIBUTING.md](./CONTRIBUTING.md):
published tool names and schemas are stable surfaces and only change on a new
versioned path.

## [Unreleased]

## [1.1.0] - SET_TO_PUBLISH_DAY

Not yet published. 1.0.0 below was prepared and dated but never published to
npm; its changes ship in this release, which is the first one intended for
npm. Set the date on the day it is published.

- **Host detection prefers `document.modelContext`.** The spec moved the
  API from `Navigator` to `Document`, and Chrome 152 and later expose it only
  there. `navigator.modelContext` is still used when `document` has no
  registrar, but a stale polyfill on `navigator` can no longer win over the
  browser's own host. `reference/registerAgentTools.ts` matches.
- The synchronous `registerAgentTools` hands back a reservation the browser
  rejected (for example an invalid tool name) once the rejection arrives, so a
  retry registers instead of answering `already_registered` while no tool is
  live. A partly rejected set keeps its scope; a rejection that arrives after
  the caller's signal already released the reservation changes nothing.
- `registerAgentToolsAsync` reports `aborted`, not `unsupported` or
  `partial_registration`, when the caller's signal aborts while the browser is
  still registering, and frees the names so a remount can register them.
- **`resultFormat: "json"`** on `defineReadTool` and `defineConsequentialTool`
  resolves the result value itself instead of the MCP content envelope. Spec
  WebMCP hosts JSON-serialize what `execute` resolves, so with the default the
  agent received the envelope double-encoded inside a wrapper; with `"json"` a
  refusal arrives as `{ ok: false, code, message }` (verified against Chrome
  153's WebMCP). The default is unchanged. New exports `toJsonResult` and
  `ToolResultFormat`; `ModelContextTool` gains a `Result` type parameter
  (default `ModelContextToolResult`, so existing code is unaffected), and the
  registrar types accept `ModelContextTool<unknown>`.
- **Registration validates tools first.** `registerAgentTools` and
  `registerAgentToolsAsync` refuse the whole set with `{ registered: false,
  reason: "invalid_tool", toolName }` when a name falls outside the spec's
  `[A-Za-z0-9_.-]{1,128}` or a description is empty, before touching the host
  and on every browser. **Behavior and type change:** such a tool previously
  registered on permissive polyfills; spec browsers already rejected it. An
  exhaustive `switch` over `RegisterResult["reason"]` gains a case.
- README: the bulk `provideContext` path is legacy (removed from the spec and
  Chrome 147); cross-origin iframes need `allow="tools"`; prefer
  `registerAgentToolsAsync` on every current browser.
- **`busy` consent decision.** `ConsentDecision` and `ConsentResult` gain
  `"busy"`, and `consentRefusal("busy")` returns `consent_busy` with a message
  telling the model another confirmation is already open and it may retry
  once, later. A surface that cannot take another request now says so instead
  of reporting `closed`, so an agent can tell "never shown" from "dismissed".
  **Type change:** an exhaustive `switch` over `ConsentDecision` (or over a
  refusal's `decision`) gains a case and will fail to typecheck until it
  handles `"busy"`.
- `consentRefusal` given a decision it does not know (plain JavaScript)
  returns the `consent_closed` envelope instead of leaking the value into the
  code.
- **`onDecision`** on `defineConsequentialTool`: an observer called exactly
  once per call that reached the gate with `{ toolName, decision, elapsedMs }`
  (`decision` includes `"cancelled"` when the host aborts an open prompt).
  Never awaited; throws and rejections are swallowed; no arguments or tokens
  in the record. New exported types `ConsentDecisionRecord` and
  `DecisionObserver`.
- **`createConsentQueue`**: a framework-agnostic consent store implementing
  `ConsentSurface` — one displayed request at a time, a bounded queue
  answering `busy` when full (default capacity 3), deadlines counted from
  enqueue, abort support, and every confirm/decline/dismiss bound to the
  displayed request id (a stale answer is ignored and returns `false`).
  Confirm requires a trusted event (read from `nativeEvent` when present).
  Pass `queue.surface` as a tool's `consent`; `subscribe`/`getSnapshot` serve
  UI bindings. Generalizes `reference/consentBridge.ts`.
- **`@melaninmap/webmcp-consent/react`**: `useConsentQueue(queue)`, a
  `useSyncExternalStore` hook returning the displayed request plus
  `confirm(event)` / `decline()` / `dismiss()` bound to it, and
  `bindConsentAnswers` for bindings that subscribe another way. React (>= 18) is an
  optional peer dependency; the package root still has no dependencies and
  never imports React.
- `examples/domConsentSurface` is rebuilt on `createConsentQueue` (less
  code; focus, ids, dismissal and trusted-click behavior unchanged). It
  resolves `busy` instead of `closed` when its three-prompt queue is full, and
  a dialog that cannot be built or opened now resolves `closed` at once
  instead of blocking the queue. The playground fires four requests to show
  `busy`.
- **Server-bound consent proofs.** `exchangeConsent` on
  `defineConsequentialTool` trades a confirmation for a server proof before
  `execute`. With an exchange configured, the arguments are pinned before the
  prompt: canonicalized, and a deep-frozen JSON copy is what
  `describeConsent`, the exchange and `execute` receive, so the proof binds
  what the person was shown. Arguments that are not plain JSON are
  `invalid_arguments` without prompting; a page without WebCrypto refuses as
  `consent_unverified` without prompting. The exchange receives
  `{ toolName, args, argsDigest, auditToken?, signal }` and must return a
  proof string; a throw, a rejection, a non-string or empty answer, a
  non-function, or no answer within `CONSENT_EXCHANGE_TIMEOUT_MS` (30 s)
  fails closed as `consent_unverified` and the action never runs. A host
  abort during the exchange is `tool_cancelled`. The proof reaches `execute`
  as `consent.proof` (`ConsentConfirmation` gains an optional `proof`;
  existing signatures are unchanged). New exported types `ConsentExchange`
  and `ConsentExchangeRequest`.
- **Type change:** `ConsentDecisionRecord["decision"]` gains `"unverified"`
  (a confirmation that could not be exchanged for a proof). An exhaustive
  `switch` over it will fail to typecheck until it handles the new case. With
  an exchange configured, `confirmed` is reported only once a proof is in
  hand, and `elapsedMs` includes the exchange.
- **`argsDigest(toolName, args)`**: SHA-256 (WebCrypto) over canonical JSON
  of `["webmcp-consent/args/v1", toolName, args]` — sorted keys, no
  whitespace, RFC 8785 (JCS) output for every value accepted; values with no
  JSON form are rejected with their path. Exported from the root and from
  `/server`.
- **`@melaninmap/webmcp-consent/server`**: `signConsentProof` and
  `verifyConsentProof`.
  - HMAC-SHA-256 with a context prefix over a base64url payload
    (`v1.<payload>.<mac>`) binding audience, tool, argument digest, an
    optional subject, issue and expiry times and a random nonce.
  - Both accept `args` (digested for you) or a precomputed `argsDigest`.
  - Verification accepts up to four secrets for rotation, compares MACs
    without early exit, reads the payload only after the MAC, allows 5 s of
    skew, and caps lifetimes at ten minutes and proofs at
    `CONSENT_PROOF_MAX_LENGTH`. It calls a REQUIRED
    `consume(nonce, expiresAt)` last; single use is the host's storage.
  - It never throws and returns `{ ok: true, claims }` or
    `{ ok: false, reason }`.
  - Signing rejects anything verification would refuse.
  - WebCrypto only, with no `node:` imports, so it runs in Node 22+, browsers
    and Workers.
- SECURITY.md and README state what a proof proves (this exact operation was
  authorized by your consent endpoint, once, recently) and what it does not
  (that a human was present), with an end-to-end sketch.
- `tsconfig.json` sets `"types": []`, so the library is typechecked without
  Node or test-tooling globals leaking in.
- Real-browser consent suite (`npm run test:browser`, Playwright + Chromium,
  dev-only): initial focus on Decline, Enter declines, Escape and backdrop
  dismiss as `consent_closed`, untrusted Confirm clicks ignored, one dialog at
  a time with in-order resolution, expiry counting queue time, cancellation
  mid-prompt, reduced motion, accessible name/description ids, light and dark
  schemes, and the gate behind Chromium's own WebMCP (`--enable-features=WebMCP`).
- WebMCP spec-drift check (`npm run check:spec`): extracts the spec's WebIDL
  surface and compares it with `spec/webmcp-surface.json`; network failures
  are reported separately from drift. Findings as of 2026-10-03 are in
  `docs/spec-drift.md`. No runtime change.

## [1.0.0] - 2026-10-03

First public release.

- `defineReadTool` / `defineConsequentialTool` — tools never throw into the
  agent runtime; consequential tools cannot reach their action without a
  human confirmation.
- `registerAgentTools` / `detectModelContext` — fully feature-detected
  registration for the proposed `navigator.modelContext` /
  `document.modelContext` APIs, silent no-op elsewhere.
- Published contract in `schemas/` (`melaninmap.tools.json`, `openapi.yaml`)
  with mechanical drift checks against the reference registrar.
- `examples/domConsentSurface` — dependency-free DOM consent surface to copy.
- `registerAgentTools` forwards only the WebMCP `{ signal }` to the host —
  the internal `scope` option is idempotence bookkeeping and never leaves
  the package, so a spec-strict host can no longer fall back to an
  unscoped bare registration.
- `node:test` behavioral suite replaces the ad-hoc smoke scripts, including
  DOM-level tests of `domConsentSurface`'s safety contract (initial focus on
  Decline, dismissal-as-`closed`, prompt serialization, timeout).
- `check:pack` lints the published artifact (`publint` +
  `attw --pack --profile esm-only`), `prepublishOnly` reruns the full gate
  before npm publish, and `RELEASING.md` documents the release runbook.
- `npm test` builds before it runs, so the suite works from a fresh clone;
  the README states the package is ESM-only; Dependabot keeps the
  devDependencies current.
- A consent surface resolving anything but a well-formed `ConsentResult`
  (`undefined`, `null`, an unknown decision) now fails closed as a
  well-formed `consent_closed` refusal instead of rejecting into the agent
  runtime.
- On a bulk-only host, a second registration scope is refused with
  `reason: "bulk_conflict"` instead of silently replacing the first scope's
  tools; `RegisterResult` gains that reason.
- `examples/domConsentSurface` ignores untrusted (script-dispatched) Confirm
  clicks, and a click on the backdrop now resolves `closed` as its header
  always claimed.
- Contract: `ToolRefusal` and the tools.json refusal envelope gain an
  optional `message` (additive); the reference registrar's `busy` and
  `user_declined` refusals now carry a do-not-retry instruction.
- `openapi.yaml` counts seven endpoints and describes the three-call handoff
  lane; a stale `check_verification_status` tool name is corrected to
  `check_ownership_verification`, and `check:openapi` now fails on any tool
  name the contract does not define.
- The reference consent card ignores untrusted Confirm clicks, and its docs
  no longer claim tool code "cannot fabricate a confirmation".
- The live-registrar parity check reads `WEBMCP_LIVE_REGISTRAR` instead of a
  hard-coded private monorepo path.
- Reference consent and refusal behavior, schema drift, private parity
  configuration and DCO checks have executable regression coverage.
- Consent deadlines are enforced by the library even when a custom surface
  never settles, and a late confirmation never runs the action.
- Per-call cancellation (`options.signal`) reaches consent surfaces and
  action handlers. A call cancelled before its handler runs returns
  `tool_cancelled`, as does a handler that rejects after cancellation; a
  handler that completes anyway reports its real result. Execution options
  without a genuine `AbortSignal` (from any realm) are ignored rather than
  thrown on, a signal that cannot be read fails closed as cancelled, and
  handlers receive only `{ signal }`.
- `domConsentSurface` bounds its prompt queue, expires queued prompts from
  enqueue time, and frees a slot as soon as a request settles.
- Registration state is isolated per browser host, overlapping tool names
  are rejected, and throwing browser feature getters fail closed.
- CI runs on Buildkite (`Buildkite / WebMCP package`, `Buildkite / WebMCP DCO`).
- The reference consent card and bridge bind every confirm, decline and
  timeout to the request on screen, reject stale or synthetic Confirm clicks
  before opening a tab, and report whether an answer was accepted.
- Example consent surface redesign: structured markup with `mm-consent__*`
  classes, a default stylesheet (`examples/consent-surface.css`) themed on
  custom properties with light/dark, reduced-motion and forced-colors support,
  an "Agent request" provenance label, and a written expiry plus a CSS
  countdown meter driven by the request's own deadline. The dialog is now
  labelled by its title and described by its detail and expiry text.
  Behavior is unchanged: focus on Decline, untrusted Confirm clicks ignored,
  dismissal never confirms.
- Playground redesign: tool card, queue demonstration, and a log of the exact
  result envelope each call returned.
