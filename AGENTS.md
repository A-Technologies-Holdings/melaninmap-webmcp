# Agent contract — @melaninmap/webmcp-consent

Operating rules for any coding agent (human or AI) working in this repository.
This file is the fast path; `CONTRIBUTING.md` and `docs/production-readiness.md`
carry the full policy.

## What this package is

A consent gate for the WebMCP (`document.modelContext` / `navigator.modelContext`)
browser surface. Consequential tools pause for visible human consent; the server
gateway verifies proofs, enforces single-use nonces, scoped idempotency, rate
limits, and an authorization policy before any action runs.

## Setup and verify

```bash
npm ci --ignore-scripts
npm run check          # the gate: typecheck + contract + openapi + compat + build + tests + pack + artifact
npm test               # behavioral suite only (builds first)
npm run test:browser   # Playwright suite; run `npx playwright install chromium` once
```

Node `>=22` is required. The package is ESM-only and ships **zero runtime
dependencies** — do not add one without a maintainer decision.

## Non-negotiables

- **Fail closed.** Consequential tools must never gain a trusted-caller,
  consent-bypass, or silent-retry path. Every client refusal collapses to
  `403 { ok: false, error: "refused" }`; refusal detail is server-side only.
- **No retry after indeterminate effects.** A synchronous host-registration
  throw may have partially registered; never bare-retry it. Rejected async
  registration must release reservations and lifecycle listeners.
- **Freeze consequential args** before prompting; snapshot what the human saw.
- **Published schemas are a compatibility surface.** Never edit a shipped
  schema in place; breaking changes go to a new versioned path (`schemas/v2/`).
- **No secrets, user data, Big Mama prompts/voice, or private app code** in the
  diff. `examples/` and `reference/` are public.
- DCO: every commit needs `Signed-off-by` (`git commit -s`).

## Release lane

Releases are manual — see `RELEASING.md`. `npm publish --access public` from a
clean `main` with npm login + 2FA, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
Bump `package.json` and `compatibility/webmcp.json` `libraryVersion` together;
`npm run check` enforces the match. GitHub Actions provenance publishing exists
(`publish.yml`) but requires the org's Actions billing to be active.

## Where things live

- `src/` — published surface (`register.ts`, `server.ts`, `defineTool.ts`, types)
- `examples/serverGateway.ts` — hardened reference gateway (authorize policy,
  authenticated retry, single-use nonce, scoped idempotency, unknown-outcome
  retention). Copy it, don't reinvent it.
- `test/` — node:test behavioral suite; `browser-tests/` — Playwright
- `schemas/` — published JSON schemas; `compatibility/` — WebMCP receipts
- `docs/` — production-readiness, spec-drift, observability
