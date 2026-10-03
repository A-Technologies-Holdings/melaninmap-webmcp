# Changelog

All notable changes to `@melaninmap/webmcp-consent` are documented here. The
project follows the compatibility contract in [CONTRIBUTING.md](./CONTRIBUTING.md):
published tool names and schemas are stable surfaces and only change on a new
versioned path.

## [Unreleased]

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
  Confirm requires a trusted event. Exposes `subscribe`/`getSnapshot` for UI
  bindings. Generalizes `reference/consentBridge.ts`.
- **`@melaninmap/webmcp-consent/react`**: `useConsentQueue(queue)`, a
  `useSyncExternalStore` hook returning the displayed request plus
  `confirm(event)` / `decline()` / `dismiss()` bound to it. React (>= 18) is an
  optional peer dependency; the package root still has no dependencies and
  never imports React.
- `examples/domConsentSurface` is rebuilt on `createConsentQueue` (behavior
  unchanged, less code), and resolves `busy` instead of `closed` when its
  three-prompt queue is full. The playground fires four requests to show it.

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
