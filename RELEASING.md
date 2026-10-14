# Releasing `@melaninmap/webmcp-consent`

The package is configured for publication to npm under the `@melaninmap` scope with
`publishConfig.access: "public"`. Releases are cut by hand from a clean,
green `main`. CI checks do not publish packages; releases remain manual.

## Preconditions

- You can publish to the `@melaninmap` npm scope (`npm whoami`), with 2FA
  ready for the publish OTP.
- `main` is clean (`git status --porcelain`) and the exact release commit
  passed `npm run check` in a recorded release session. A configured workflow
  or an older browser receipt is not proof for the release commit.
- `CHANGELOG.md` has the authorized date for the version you are about to tag.
  A dated release candidate is still preparation until registry proof confirms
  publication.
- The exact release commit passed `npm run test:browser`, with browser/client
  versions and skipped counts recorded. This suite is separate from `check`.
- Private schema parity passed with `WEBMCP_LIVE_REGISTRAR` pointing at the
  intended exact private source. An unset path is not parity proof.

## Steps

1. The first npm release is 1.1.0; 1.0.0 was never published. Keep the existing
   1.1.0 version for this release. For later releases,
   bump the version — `npm version <patch|minor|major> --no-git-tag-version`
   (the tag is created below, after the checks pass). Commit the bump.
2. Confirm `CHANGELOG.md` already has the authorized 1.1.0 release date and
   still states that registry publication is unproven. Add a fresh `Unreleased`
   section if there is follow-up work. Validate the exact final source; a
   prepared date alone never establishes publication.
3. `npm run check` — runs the whole gate: typecheck, contract drift, OpenAPI
   pointer resolution, build, the `node:test` behavioral suite, and
   `check:pack` (`publint` + `attw --pack` under the ESM-only profile).
4. `npm run check:artifact`, then `npm pack --dry-run` and eyeball the file list — `dist/`, `src/`,
   `schemas/`, `examples/*.ts` and `examples/*.css` (not `playground.html`),
   `reference/`, `compatibility/`, and the docs, nothing else. The artifact
   check uses a temporary directory outside the checkout and does not publish.
5. Pack the reviewed source and record its SHA-512 integrity, source commit
   and file list. Scan the source and the actual extracted tarball payload for
   secrets; scanning a Git patch alone cannot inspect binary archive contents.
   Check `git status --porcelain` again, then `npm publish --access public`.
   Do not skip lifecycle scripts or use a dry run as proof of publish access.
   `prepublishOnly` reruns the gate; it does not enforce a clean checkout.
6. `git tag v<version> && git push origin v<version>`, then open a GitHub release
   pointing at the CHANGELOG section.

## Provenance

`npm publish --provenance` attests the tarball against the CI that built it,
but provenance only works from a supported OIDC provider (GitHub Actions or
GitLab CI). Publishing is manual and Buildkite validation does not supply npm OIDC
provenance. Do not claim provenance from ordinary CI success. Any publishing
automation needs separate review; GitHub-hosted CI remains retired.

## After publishing

- `npm view @melaninmap/webmcp-consent@1.1.0 version dist --json` — confirm the
  exact version, integrity and dist metadata. Use `npm pack` to inspect the
  registry artifact and compare its exports, schemas and reference payload
  against the reviewed source before changing private pins.
- In a scratch directory: `npm install @melaninmap/webmcp-consent` and import
  it once from Node to confirm the published artifact resolves.
- Replace private snapshot pins only in a separately reviewed consumer change.
  Use the verified exact registry version/integrity in both declarations and
  lockfiles, run clean isolated installs and consumer checks, and retain a
  compatible rollback until migration is accepted. Never overwrite private
  reference behavior wholesale.

## Private reference parity

Set `WEBMCP_LIVE_REGISTRAR` to the absolute private registrar path and run
`npm run check:contract`. An invalid configured path fails. An unset path means
private parity was NOT RUN. This check compares tool registration and input
schemas; it does not prove equivalent consent UI or backend deployment.

Port reference changes in a separate private PR, adapting flattened import
names to that repository. Run its own typecheck, consent tests and review gates.
Do not overwrite the private implementation wholesale.
