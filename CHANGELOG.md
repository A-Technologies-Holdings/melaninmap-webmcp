# Changelog

All notable changes to `@melaninmap/webmcp-consent` are documented here. The
project follows the compatibility contract in [CONTRIBUTING.md](./CONTRIBUTING.md):
published tool names and schemas are stable surfaces and only change on a new
versioned path.

## [1.0.0] - Unreleased

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
