# Releasing `@melaninmap/webmcp-consent`

The package is published to npm under the `@melaninmap` scope with
`publishConfig.access: "public"`. Releases are cut by hand from a clean,
green `main`. There is deliberately no release automation yet — re-add CI
before automating this.

## Preconditions

- You can publish to the `@melaninmap` npm scope (`npm whoami`), with 2FA
  ready for the publish OTP.
- `main` is green: every merged PR passed `npm run check` on Buildkite.
- `CHANGELOG.md` has an entry for the version you are about to tag.

## Steps

1. Bump the version — `npm version <patch|minor|major> --no-git-tag-version`
   (the tag is created below, after the checks pass). Commit the bump.
2. Update `CHANGELOG.md`: rename the `Unreleased` heading to the new version
   and date, then add a fresh `Unreleased` section if there is follow-up work.
3. `npm run check` — runs the whole gate: typecheck, contract drift, OpenAPI
   pointer resolution, build, the `node:test` behavioral suite, and
   `check:pack` (`publint` + `attw --pack` under the ESM-only profile).
4. `npm pack --dry-run` and eyeball the file list — `dist/`, `src/`,
   `schemas/`, `examples/`, `reference/`, and the docs, nothing else.
5. `npm publish`. `prepublishOnly` reruns the full gate, so a dirty or
   unverified tree cannot ship.
6. `git tag v<version> && git push --tags`, then open a GitHub release
   pointing at the CHANGELOG section.

## Provenance

`npm publish --provenance` attests the tarball against the CI that built it,
but provenance only works from a supported OIDC provider (GitHub Actions or
GitLab CI). This org's GitHub Actions is currently billing-locked and CI runs
on Buildkite, so provenance is not available yet — revisit when Actions is
re-enabled.

## After publishing

- `npm view @melaninmap/webmcp-consent` — confirm the version and file list.
- In a scratch directory: `npm install @melaninmap/webmcp-consent` and import
  it once from Node to confirm the published artifact resolves.
- Port `reference/` changes to the private monorepo if the release touched
  the flattened copy.
