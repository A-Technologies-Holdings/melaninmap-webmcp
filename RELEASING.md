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
- `CHANGELOG.md` has an entry for the version you are about to tag.

## Steps

1. The first npm release is 1.1.0; 1.0.0 was never published. Keep the existing
   1.1.0 version for this release. For later releases,
   bump the version — `npm version <patch|minor|major> --no-git-tag-version`
   (the tag is created below, after the checks pass). Commit the bump.
2. Update `CHANGELOG.md`: rename the `Unreleased` heading to the new version
   and date, then add a fresh `Unreleased` section if there is follow-up work.
3. `npm run check` — runs the whole gate: typecheck, contract drift, OpenAPI
   pointer resolution, build, the `node:test` behavioral suite, and
   `check:pack` (`publint` + `attw --pack` under the ESM-only profile).
4. `npm run check:artifact`, then `npm pack --dry-run` and eyeball the file list — `dist/`, `src/`,
   `schemas/`, `examples/*.ts` and `examples/*.css` (not `playground.html`),
   `reference/`, `compatibility/`, and the docs, nothing else. The artifact
   check uses a temporary directory outside the checkout and does not publish.
5. Check `git status --porcelain` again, then `npm publish`.
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

- `npm view @melaninmap/webmcp-consent` — confirm the version and dist metadata. Use `npm pack` to inspect the file list.
- In a scratch directory: `npm install @melaninmap/webmcp-consent` and import
  it once from Node to confirm the published artifact resolves.
- Port `reference/` changes to the private monorepo if the release touched
  the flattened copy.

## Private reference parity

Set `WEBMCP_LIVE_REGISTRAR` to the absolute private registrar path and run
`npm run check:contract`. An invalid configured path fails. An unset path means
private parity was NOT RUN. This check compares tool registration and input
schemas; it does not prove equivalent consent UI or backend deployment.

Port reference changes in a separate private PR, adapting flattened import
names to that repository. Run its own typecheck, consent tests and review gates.
Do not overwrite the private implementation wholesale.
