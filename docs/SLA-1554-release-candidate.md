# SLA-1554 source release candidate

This is preparation for the first npm release, 1.1.0. It is not published,
tagged or deployed. The authorized first-release date is October 14, 2026;
the changelog explicitly awaits registry publication proof.

## Source ownership

Public base: `046255d99d564065232a7ff7f64beb3d602a20bb`.
This single integration commit preserves the changes from these peer PRs:

- #33 package exports: `c4d8e161a7637c9a04521a5989eb5115ad95a6ad`.
- #35 queue-expiry browser fixture: `f20cf8d9c90b9017a66a13ea33ede69c99f91ffb`.
- #34 cancellation envelope: `89da8bc795e6b235cd220d1c973a8a73168eacc2`.
- #36 reference cancellation: `228a016a25ae8413f9de43b2af587add928fccec`.

The original branches remain unchanged. Additional edits consolidate truthful
release notes and make the existing release runbook require exact-source browser,
private-parity and extracted-payload evidence. #32 dependency updates remain
separate. #30's consolidation is represented here without its stale release date.
No private source or frozen private branch is changed.

## Session evidence

Codex composed the source in an isolated cloud clone. The first clean offline
`npm ci --ignore-scripts --offline --no-audit` installed 86 packages.
`npm run check` passed 291/291 tests, zero skipped, plus typecheck, package
analysis, compatibility validation and isolated packed-consumer import.
`PLAYWRIGHT_CHANNEL=chrome npm run test:browser` passed 28/28, zero skipped,
using Chrome 153.0.8010.47 and Playwright 1.63.0.

`WEBMCP_LIVE_REGISTRAR` was set to a read-only copy of the registrar at private
#2803 `8b829439a6a80fcd5eb73f18a7735a5479079b58`. All five tool schemas matched;
all 12 OpenAPI contract pointers and 70 internal references resolved. These are
source checks, not deployed parity, live customer or signed-device evidence.
Actual runtime: Node 24.14.1 and npm 11.11.0. The package supports Node >=22;
this is not an exact Node 22.22 runtime receipt.

Before draft publication, repeat package, artifact and browser validation in
a fresh checkout of the captured candidate; scan the full source range and
actual extracted tarball payload with the pinned scanner, and scan the genuine
native transcript export before checkpoint upload. The PR must record the exact
head, checkpoint, final commands/results and independent-review status.

**Verdict:** local composition checks pass; publication remains gated.

## Remaining release actions

Independent review and required exact-head hosted checks belong to the root
coordinator. No CI labels, readiness toggle, merge, npm publication, tag, GitHub
release or account/provider change was requested from this lane.

The sandbox's read-only `npm whoami --registry=https://registry.npmjs.org`
returned `ENEEDAUTH`. This is an access blocker on this host; historical access
in another session is not proof of current authenticated scope permission or
2FA readiness. Do not log credential or OTP values.

After review and root-controlled integration, follow `RELEASING.md` from clean
reviewed `main`: validate the dated source, confirm
authenticated scope access and 2FA, publish without bypassing lifecycle checks,
verify registry integrity/exports, then create the tag and GitHub release under
the separate release action. Manual publication does not establish npm OIDC
provenance. Private registry migration remains a separate reviewed change.

Rollback: revert this integration commit as a unit. Existing private immutable
package pins and the original public branches are unaffected.

## Focused consumer-copy follow-up

The GitHub finding at README lines 104–112 exposed a broken copied adapter: it
referenced ../src outside the consumer. The README and adapter now use the
supported DOM surface package export. Full markup customization still copies
the real implementation from the packed src/domConsentSurface.ts and rewrites
its two imports to the public package root; no duplicate implementation was added.
The isolated artifact checker executes the documented import, copied adapter and
customized source outside the checkout. Its pre-fix failure is preserved privately.
A narrow source-only TypeScript mapping lets the package typecheck the adapter
before dist exists; independent packed-consumer resolution does not use that map.
Browser import maps make the same documented package entry executable in the
unbundled playground and test harness. Runtime consent logic is unchanged.

The founder authorized the October 14 first-release date. Notes remain explicit
that registry publication has not occurred. Build 63 is evidence for the prior
source only; this additive correction needs independent owner review and root's
next bounded hosted run. No dependency, provider, authorization or schema change.
