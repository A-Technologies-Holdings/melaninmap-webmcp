# WebMCP CI on Buildkite

Pipeline: https://buildkite.com/rgi-group/melaninmap-webmcp in the existing RGI Group organization. Bootstrap configuration:

```yaml
steps:
  - label: ':pipeline: Upload checks'
    command: buildkite-agent pipeline upload .buildkite/pipeline.yml
    agents:
      queue: macos-15-medium
```

Build pull requests when opened/updated or when their base branch changes, including PR base metadata. Disable ordinary branch and tag builds. Enable ready-for-review and label-change events. Set the provider filter to:

```text
build.pull_request.id != null && (!build.pull_request.draft || build.pull_request.labels includes "ci:full" || build.pull_request.labels includes "ci:release")
```

Disable "Skip when pull request has existing build for commit and branch" so marking the same commit ready, or adding a regression label, creates a fresh validation. Enable skipping queued and canceling running intermediate builds with `!main !release/*`. Use the existing macOS queue and shared serialization; no new paid queue is provisioned. Package and DCO steps report `Buildkite / WebMCP package` and `Buildkite / WebMCP DCO`. Jobs have bounded runtimes. No publishing or deployment is performed.

Keep fork builds disabled until an isolated, credential-free runner policy is configured. Public PR code must never receive production credentials or execute on a signing runner. This pipeline requires only public repository checkout access.

Buildkite build [#2](https://buildkite.com/rgi-group/melaninmap-webmcp/builds/2) passed package and PR DCO checks at `a3370660f5f9fd7ff466dd9e9dad4ef16e1db58b`. The redundant GitHub Actions workflow is retired in this CI migration. Require both Buildkite checks alongside existing Semgrep and code-owner approval. Each new PR head still needs fresh hosted checks; do not treat local validation as hosted proof.

DCO uses the fetched PR base branch merge-base with HEAD. Missing PR base metadata fails the step; branch-only builds explicitly report DCO as not applicable.

## Regression cadence (SLA-1569)

Ready PRs retain typecheck, published contract/OpenAPI checks, build, the small behavioral test suite and DCO. Tarball analysis (`check:pack`) runs nightly and on release PRs; `prepublishOnly` still runs the complete gate. Use a `release/*` branch or add `ci:release`/`ci:full` to run the full package gate before merging a release. Each regression PR still reports the required `Buildkite / WebMCP package` check.

Create one Buildkite schedule on `main`, commit `HEAD`, at `30 3 * * * America/Chicago` (03:30 Central daily), after this pipeline is on main. It runs `buildkite-check.sh regression`; it never publishes. Local equivalents: `bash scripts/buildkite-check.sh package` and `bash scripts/buildkite-check.sh regression`.
