#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  package)
    node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw Error("Node 22+ required")'
    npm ci --ignore-scripts
    npm run check
    ;;
  dco)
    if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" ]]; then
      echo 'DCO applies to pull requests; branch build has no PR range.'
      exit 0
    fi
    base_branch="${BUILDKITE_PULL_REQUEST_BASE_BRANCH:?PR base branch required}"
    git check-ref-format "refs/heads/$base_branch"
    git fetch origin "refs/heads/$base_branch:refs/remotes/origin/$base_branch"
    export DCO_BASE
    DCO_BASE="$(git merge-base HEAD "refs/remotes/origin/$base_branch")"
    node scripts/check-dco.mjs
    ;;
  *) echo 'Usage: buildkite-check.sh package|dco' >&2; exit 2 ;;
esac
