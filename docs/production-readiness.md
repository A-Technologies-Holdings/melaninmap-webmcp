# Production readiness

What must be true before this package carries live consequential traffic.
Items are checked only by evidence named beside them, never by inference
from the offline gate.

## Server half

The browser gate is half the system. The other half lives in
[`examples/serverGateway.ts`](../examples/serverGateway.ts), a copyable,
framework-agnostic reference:

- Proofs are minted only by `issueConsentProof`, rate limited on the
  server-observed network key (`remoteKey`). Never key a limiter solely on
  a client-supplied installation id — the caller can rotate it for free.
  Behind a reverse proxy, read the client address from the platform-set
  forwarding header on the trusted hop, never from the request body.
- `performConsequentialAction` verifies the proof single-use through the
  nonce ledger, then runs the action under an idempotency key: a retry
  replays the first result, and the same key with different arguments is a
  conflict, never a second action.
- Every refusal is the same `403 { ok: false, error: "refused" }` to the
  client. The specific reason goes to the server log only, so the endpoint
  is not an oracle for which check a forgery passed.
- The in-memory ledger, limiter and idempotency store in
  `@melaninmap/webmcp-consent/server` are single-instance references. With
  more than one instance, back the same shapes with an atomic shared store
  (Redis, Postgres, platform KV). A nonce spent on one instance must be
  spent on all of them.
- Keep money movement and personal-data disclosure off this path entirely
  (see SECURITY.md). A consent proof authorizes one bounded operation; it
  does not prove a human was present.

## Client half

- Register with `registerAgentToolsWithFallback` so visitors without a
  WebMCP host get the ordinary non-agent flow, not a dead end.
- Localize the consent surface with `createDomConsentSurface({ strings })`
  on the `dom-consent-surface` entry. Tool titles, details and confirm
  labels localize in `describeConsent`, where the tool is defined.
- Wire `onDecision` to `createDecisionMetrics` and evaluate alerts per
  [observability.md](./observability.md) before launch, not after the
  first incident.

## Release evidence still required

These cannot be produced from this repository alone, and no offline check
substitutes for them:

1. **npm publication.** `npm whoami` must succeed for the `@melaninmap`
   scope, with 2FA available, from a clean green `main` — see
   [RELEASING.md](../RELEASING.md). Provenance (`npm publish --provenance`)
   is wired in `.github/workflows/publish.yml` (manual dispatch, `release`
   environment, OIDC). It still needs an npm trusted publisher or an
   `NPM_TOKEN` secret configured by an npm-scope owner before first use.
2. **Live origin-trial run.** `compatibility/webmcp.json` must record a
   `liveOriginTrial` pass against a real origin-trial endpoint on the
   exact release commit. A local Chromium run with
   `--enable-features=WebMCP` is not this.
   Observed 2026-11-02: `https://melaninmap.app` serves an `origin-trial`
   response header for feature `WebMCP`, origin
   `https://melaninmap.app:443`, expiring 2027-03-30, on deploy
   `108898080ce6a0ead5bd3bdea01c3c2df7e1c02f`. The token is live, but no
   deployed bundle in the initial page load references `modelContext`,
   and a clean Chromium profile still reports
   `document.modelContext === undefined`. The trial is provisioned; the
   tools are not yet deployed behind it, so this stays `not-run`.
3. **Production deployment.** The same record must show
   `productionDeployment` exercised — the deployed page registering tools
   and completing a gated action through the real gateway, with the
   private registrar parity check run against the intended source.
4. **Current browser receipt.** The recorded browser run must name the
   release commit, not an ancestor.

## Absorbing WebMCP spec churn

The upstream API has already moved from `navigator` to `document`, dropped
`provideContext`, and changed registration signatures. Policy:

- `src/types.ts` tracks the proposal structurally; nothing assumes the
  host exists. New spec surface is adopted only behind feature detection,
  never UA sniffing.
- `npm run check:spec` runs in the nightly and release lanes. Drift is
  triaged in [spec-drift.md](./spec-drift.md) before the next release, and
  breaking upstream changes ship in this package as additive API first.
- Published tool names and input schemas are a stable contract
  (CONTRIBUTING.md): spec pressure changes the registration plumbing, not
  the tools consumers already depend on, except on a new versioned path.

## Live deployment recheck — 2026-11-01 EST (2026-11-02 UTC)

At 2026-11-02T01:40:17Z, an HTTPS fetch returned 200 with the WebMCP
`origin-trial` header and `x-melanin-deploy-sha` equal to
`108898080ce6a0ead5bd3bdea01c3c2df7e1c02f`. All eight script bundles
referenced by the initial HTML were fetched; none contained `modelContext`.
This checks the initial page surface, not every lazy-loaded route.

Live origin-trial and production action evidence remain blocked on the
private melaninmap.app application deploying its registrar for all five tools:
`search_black_owned_directory`, `get_business_details`,
`check_ownership_verification`, `record_interest`, and
`request_event_handoff`. That deployment must include the consent surface
and the real server gateway behind consequential actions, with proof
verification, single-use nonce consumption, rate limiting and idempotency.
A multi-instance deployment needs atomic shared state. Confirm and decline
paths must then be exercised against the live origin on the exact release
commit before either compatibility status can pass.
