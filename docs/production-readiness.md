# Production readiness

What must be true before this package carries live consequential traffic.
Items are checked only by evidence named beside them, never by inference
from the offline gate.


## Current deployment receipt — 2026-11-04 UTC

**PASS: exact published artifact identity, live origin trial and consequential
handoff.** This receipt supersedes the earlier unverified-artifact and unavailable
ticket-page observations below; those dated observations remain historical.

Private [migration PR #3164](https://github.com/A-Technologies-Holdings/rork-melanin-map-342/pull/3164)
merged as `db4db2c1c0ea8a0b98b1811be12a16457adbafcc`. That exact clean main
commit was deployed through the landing helper, Cloudflare Worker version
`d7f3e4a0-6de3-473d-9f9b-eef97be9956c`. Production readback at
`2026-11-04T04:50:36Z` matched its deployment SHA, package version `1.1.0`,
and the registry's published integrity:

```text
sha512-J6Daikt+aBjL+0L2oszBoapu0EVMGH999tERp7w4vAvLUBcodKRHo+2/2WpzSOU5B9IpD+FRmaYzsJRaWVxZMQ==
```

Both consumers pin the registry artifact. All 82 published package files matched
the installed consumers; the clean deployment installation was independently
compared again with a fresh registry download and had zero mismatches. The
served main and WebMCP registrar assets matched the exact deployment build
byte-for-byte. The registrar executes the published SDK result serializer.
The reviewed consent UI, server proof exchange and navigation remain private
adapters; this does not claim those implementations were replaced by the SDK.
The published package source remains release commit
`c80c30e0bb47e6c3e0d5c30b18f23ecb3a8a6f1b`.

The new deployment retained the live origin-trial header. Isolated in-app
Chromium (`Chrome/156.0.0.0`) exposed all five native tools. A real host search
returned [1st Wednesdays Open Mic](https://www.eventbrite.com/e/1st-wednesdays-open-mic-450-k-hosted-by-anthony-oakes-tickets-1054426160029),
November 4 at 8 PM, Busboys and Poets, 450 K Street NW, Washington, DC. Its
Eventbrite organizer is Busboys and Poets; Anthony Oakes is the host. The
production pilot binds `eventbrite:1054426160029` to the sourced business
`organizer:busboys-and-poets-1554292416`, channel `event_detail`. No ownership
badge or partnership claim was added.

- Trusted Decline returned `user_declined`; zero handoff network requests.
- A separate test invocation with trusted Confirm completed real consent,
  creation and redemption, all HTTP 200. The host returned `ok: true`,
  `replayed: false`, `sequence: 2`, `attributionIncluded: true`, and
  `navigated: true`.
- Independent production ledger readback at `2026-11-04T04:51:27.006Z`
  confirmed `recommended` → `handoff_created` → `handoff_opened` for the exact
  event and business, sequence 2.
- The actual attributed Eventbrite tab loaded the matching listing. Its
  November 4, 8 PM selector offered “Open Mic Night!” tickets at $7.56 including
  fees and tax. No checkout, payment or conversion was performed or claimed.

The earlier Seven Black Minutes link was not substituted with this event. Its
known-unavailable ticket URL remains removed; this is a separately sourced event.
The successful receipt establishes this web deployment and published package
input, not signed-device, store, customer-conversion or public-GA acceptance.

Private migration validation included the full landing check/build, 96 focused
WebMCP tests, 106 Passport Bench tests and three Worker tests. Kilo and hosted
Semgrep passed on the PR head. Broader monorepo validation is **not** claimed
green: local policy hit a Semgrep rules-download connection reset, and an Expo
chat timeout reproduced on the unchanged base commit. Remaining broader stages
were not completed. These limits are recorded in Linear SLA-1554.

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
  conflict, never a second action. Cache keys include the verified subject
  and audience, so shared stores cannot replay another caller's result.
  Capacity exhaustion refuses new actions rather than evicting live records;
  pending actions remain deduplicated and retention starts on completion.
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

## Release evidence requirements and dated history

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
   tools were not yet observed behind it, so that dated run stayed `not-run`.
   The current successful receipt is recorded above.
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
That initial-bundle scan does not cover dynamically loaded code and did not
predict the actual browser result.

Fresh Playwright Chromium 153.0.8010.12 profiles exposed
`typeof document.modelContext === "object"`, both with and without an
explicit WebMCP flag. The default profile's real `getTools()` returned all
five tools: `search_black_owned_directory`, `get_business_details`,
`check_ownership_verification`, `record_interest`, and
`request_event_handoff`. A real host-invoked search returned an event.

At 2026-11-02T01:41:25Z, host-invoked `request_event_handoff` displayed the
live consent dialog. Clicking Decline returned `user_declined` without a
handoff request. A second invocation followed by Confirm posted to
`/api/agent/handoff-consent` but returned `destination_unavailable` for the
selected event (Heartbeat Saturdays). The successful consequential action
and downstream gateway execution therefore remain unverified. No external
ticketing handoff completed.

These observations supersede the earlier no-tools finding above. They do
not establish release compatibility: the private application's deploy SHA
is not this package's release commit, private source parity was not run in
this session, and the confirm path did not complete a successful action.
`compatibility/webmcp.json` remains unchanged. The private application must
provide a valid destination and deploy the intended release registrar,
consent surface and server gateway, including proof verification, shared
single-use nonce state, rate limiting and idempotency. Re-run both paths on
the exact release source before recording either live status as passed.


## Live deployment verification — 2026-11-03

The Codex isolated in-app browser exposed `document.modelContext` on the live
origin without enabling a local WebMCP flag. Its user agent reported
`Chrome/156.0.0.0`. HTTPS headers still identify private application deploy
`108898080ce6a0ead5bd3bdea01c3c2df7e1c02f` and include the WebMCP origin-trial
token. All five registered tools were discovered through the native host.

Using native `document.modelContext.getTools()` and `executeTool()`:

- Search returned published event records and a recommendation ID.
- A handoff for Nissan Free Wednesdays displayed the real consent surface.
  A trusted browser Decline click returned `user_declined`. Network capture
  showed no `/api/agent/handoff*` request during this decline invocation.
- A separate handoff for the returned Eventbrite record
  `eventbrite:1979758661450` (NASHVILLE, TN SCHOOL SAFETY TECH AND WIRELESS
  SEMINAR) displayed the consent surface. A trusted Confirm click sent
  `POST /api/agent/handoff-consent`. The endpoint returned HTTP 200 with
  `{ "ok": false, "code": "destination_unavailable" }`. No successful
  downstream handoff or ticketing navigation was established.

The final browser receipt was read at `2026-11-03T13:56:51.611Z`. Temporary
page-local diagnostic state was removed after capture. No gateway mocking,
consent bypass, or production configuration change was used.

**Result:** decline passed; successful consequential handoff failed at consent
proof issuance. HTTP 200 is transport success, not action success. The public
code intentionally combines missing/unexposed event or ticket URL, malformed
or disallowed destination, and missing business binding; this run does not
identify which internal reason occurred. The private application must supply
a real approved pilot event/tour with a published ticket destination and the
matching server-governed business/channel binding before the success path can
be proved. Do not invent a binding merely to turn the check green.

This is evidence for the named private deploy, not proof that npm release
`v1.1.0` is deployed there. Package release compatibility remains unproven.

Separately, the development dependency advisory was already fixed in focused
[PR #39](https://github.com/A-Technologies-Holdings/melaninmap-webmcp/pull/39),
merged at `0e646b012c89d2b51685a04138d1cd9abd664f15`, upgrading `happy-dom`
from `20.14.6` to `21.0.4`. A clean install and npm audit at that commit
reported zero vulnerabilities; `npm run check` passed 314 tests with zero
skips, and `npm run test:browser` passed all 28 tests. The older v1.1.0
release-source lockfile is historical and was not rewritten.


### Candidate lookup and production binding check — 2026-11-03

A fresh lookup selected [Seven Black Minutes: Black Friday](https://www.eventbrite.com/e/seven-black-minutes-black-friday-tickets-1984623247558),
`eventbrite:1984623247558`, rather than requiring the operator to supply an ID.
The live native WebMCP search returned this exact record. A read-only production
catalog query confirmed that its stored `ticketUrl` is the matching Eventbrite
HTTPS URL. A trusted Confirm click again posted to
`/api/agent/handoff-consent`, which returned HTTP 200 and
`{ "ok": false, "code": "destination_unavailable" }`; the result was captured
at `2026-11-03T14:01:13.872Z`.

A separate read-only production environment check found
`COMMERCE_HANDOFF_PILOT_BINDINGS` absent. This establishes a concrete missing
prerequisite: no event can resolve the required server-governed pilot binding
while that map is unset. The public refusal still does not identify its exact
internal branch, and allowed-host configuration was not validated in this run.
Looking up a real ticket URL does not create an approved event-to-business
attribution relationship. The next production step is to approve and configure
a real event/business binding, then repeat consent, create, redemption and
navigation. No production environment or catalog record was changed.


### Authorized pilot configuration and retest — 2026-11-03

After explicit authorization, the production pilot map was configured and read
back for `eventbrite:1984623247558` with target type `event` and channel
`event_detail`. Attribution is bound to the event's named organizer, Anthony
Oakes, rather than the unrelated Busboys and Poets K Street catalog record.
The organizer's [official site](https://www.anthonyoakescomedian.com/) confirms
that he produces Seven Black Minutes. A sourced organizer business draft was
saved through the admin editor, without an ownership-verification badge. The
city-level service-area marker is explicitly not a storefront or venue.

The draft remains suppressed, and a `catalog.publish` request is pending the
required second-admin review. No publication control was bypassed.

At `2026-11-03T14:12:39.054Z`, a fresh native host search and trusted Confirm
click advanced beyond the previous refusal:

- `POST /api/agent/handoff-consent`: HTTP 200, `ok: true`, target type `event`,
  and a consent proof present (proof value not retained in this document).
- `POST /api/agent/handoff`: HTTP 200, `ok: false`,
  `code: destination_unavailable`. The organizer is still suppressed.
- Redemption and outbound navigation: not reached; successful consequential
  handoff remains unproved. Re-run after reviewed catalog publication.

The earlier absent-binding observation is historical; the current remaining
prerequisite is publication of the correct organizer business through the
existing two-person catalog approval workflow.


### Published organizer and successful application handoff — 2026-11-03

The founder explicitly authorized completion of the publication workflow. The
initial founder-origin request was rejected as superseded, preserving its audit
trail. The authenticated admin service account submitted the publication
request; the distinct founder account recorded the user's explicit approval;
the service account executed that exact approved request. Production readback
confirms the request completed and the organizer record is published. The
requester and approver identities remain distinct; no requester or approval row
was rewritten and no publication guard was disabled.

At `2026-11-03T14:29:35.975Z`, the isolated in-app browser exercised both paths
against private application deploy
`108898080ce6a0ead5bd3bdea01c3c2df7e1c02f`:

- Decline returned `user_declined` with zero handoff network events.
- Confirm sent the real consent, create and open requests to
  `/api/agent/handoff-consent`, `/api/agent/handoff` and
  `/api/agent/handoff-open`; all three returned HTTP 200.
- The native host result was `ok: true`, `replayed: false`, `sequence: 2`,
  `attributionIncluded: true`, and `navigated: true`.
- The new tab navigated to the exact Eventbrite event URL with the documented
  `mm_j` and `mm_href` parameters.
- A read-only production ledger query independently confirmed transitions from
  `recommended` to `handoff_created` to `handoff_opened`, sequence 2, attributed
  to `organizer:anthony-oakes-13087731278` for
  `eventbrite:1984623247558` through `event_detail`.

**Application result: PASS** for visible consent, proof issuance, creation,
redemption, audited attribution and outbound navigation. No payment or purchase
was performed or claimed.

**External ticket-page result: FAIL.** Eventbrite displayed “Something went
wrong” and “We can't find what you looked for.” Navigating to the same stored
URL with both Melanin Map parameters removed produced the same page. This
observation does not establish whether Eventbrite removed the event or returned
a temporary/provider-specific refusal. A usable ticket-buying page is not
verified. Do not substitute a different event URL without source verification.

These live observations prove the named private deployment's application
handoff, not that it imports the exact published npm release. Release-wide
compatibility remains unproven, and the manifest does not claim a full pass.
