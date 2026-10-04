#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  package|regression)
    node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw Error("Node 22+ required")'
    npm ci --ignore-scripts
    scope="${1}"
    if [[ "$scope" == "regression" ]]; then
      npm run check
    else
      npm run typecheck
      npm run check:contract
      npm run check:openapi
      npm run build
      npm run build:test
      # The behavioral suite is small and tightly coupled: keep it on ready PRs.
      # Expensive tarball/package analysis belongs to nightly and release runs.
      node --test
    fi
    ;;
  browser)
    # Regression lane only (SLA-1606): real-browser consent suite in
    # Playwright's own Chromium, never a system browser; cached on the agent.
    node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw Error("Node 22+ required")'
    npm ci --ignore-scripts
    npx playwright install chromium
    npm run test:browser
    ;;
  spec)
    # Regression lane only (SLA-1606). Exit 1 = upstream drift, 3 = spec no
    # longer parses, 75 = network failure (nothing compared; the pipeline
    # soft-fails only on 75). A registry outage during install is a network
    # failure too.
    node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw Error("Node 22+ required")'
    npm ci --ignore-scripts || exit 75
    npm run check:spec
    ;;
  dco)
    if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" ]]; then
      echo 'DCO applies to pull requests; branch build has no PR range.'
      exit 0
    fi
    base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:?PR base branch required}"
    git check-ref-format "refs/heads/$base_branch"
    git fetch origin "+refs/heads/$base_branch:refs/remotes/origin/$base_branch"
    export DCO_BASE
    DCO_BASE="$(git merge-base HEAD "refs/remotes/origin/$base_branch")"
    node scripts/check-dco.mjs
    ;;
  *) echo 'Usage: buildkite-check.sh package|regression|browser|spec|dco' >&2; exit 2 ;;
esac
