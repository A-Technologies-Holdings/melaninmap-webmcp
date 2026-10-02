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

First run the new pipeline against this PR and verify both checks at its exact head. Only after that succeeds, retire `.github/workflows/check.yml` and require the two Buildkite checks alongside existing Semgrep and code-owner approval. Do not weaken review protection or treat local validation as hosted proof.

DCO uses the fetched PR base branch merge-base with HEAD. Missing PR base metadata fails the step; branch-only builds explicitly report DCO as not applicable.
