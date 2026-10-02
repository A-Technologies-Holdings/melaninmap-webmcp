# WebMCP CI on Buildkite

Pipeline: https://buildkite.com/rgi-group/melaninmap-webmcp in the existing RGI Group organization. Bootstrap configuration:

```yaml
steps:
  - label: ':pipeline: Upload checks'
    command: buildkite-agent pipeline upload .buildkite/pipeline.yml
    agents:
      queue: macos-15-medium
```

Build pull requests when opened/updated or when their base branch changes, including PR base metadata. Limit ordinary branch builds to `main` so a branch build cannot suppress the PR build and skip DCO. Use the existing macOS queue and shared serialization; no new paid queue is provisioned. Package and DCO steps report `Buildkite / WebMCP package` and `Buildkite / WebMCP DCO`. Jobs have bounded runtimes. No publishing or deployment is performed.

Keep fork builds disabled until an isolated, credential-free runner policy is configured. Public PR code must never receive production credentials or execute on a signing runner. This pipeline requires only public repository checkout access.

Buildkite build [#2](https://buildkite.com/rgi-group/melaninmap-webmcp/builds/2) passed package and PR DCO checks at `a3370660f5f9fd7ff466dd9e9dad4ef16e1db58b`. The redundant GitHub Actions workflow is retired in this CI migration. Require both Buildkite checks alongside existing Semgrep and code-owner approval. Each new PR head still needs fresh hosted checks; do not treat local validation as hosted proof.

DCO uses the fetched PR base branch merge-base with HEAD. Missing PR base metadata fails the step; branch-only builds explicitly report DCO as not applicable.
