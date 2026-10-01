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
