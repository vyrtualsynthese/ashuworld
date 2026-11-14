#!/usr/bin/env bash
#
# Runs the same validation CI runs, locally, in containers: typecheck, lint, the suite with
# coverage against a throwaway Postgres, then the chart lint and render assertions.
#
#   bash scripts/check.sh
#
# Run it before pushing, and before opening a pull request into develop. It needs Docker and
# a `pnpm install` on the host, because the containers mount this working tree rather than
# copying it.
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose -f compose.ci.yaml)

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== node checks (typecheck, lint, tests with coverage) =="
"${compose[@]}" run --rm check

echo "== chart checks (lint, render assertions) =="
"${compose[@]}" run --rm helm

echo "ok: every local check passed"
