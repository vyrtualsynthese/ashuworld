#!/usr/bin/env bash
#
# Renders the chart and asserts the promises the deployment makes.
#
# Every check here failed at least once during the chart's first draft, or is a rule the
# brief calls out by name. The script renders the chart four times: the default values,
# with the hook receiver turned on, with the alpha reset turned on, and with the level
# recompute turned on, because the gated resources must stay out of a default install.
#
# Run from anywhere: the chart directory is resolved from this file's own path.
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$chart_dir"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# `helm template` with a host, because the ingress and PUBLIC_BASE_URL are derived from it.
render() {
  helm template ashuworld . --set ingress.host=ashuworld.test "$@"
}

default_out="$(render)"
hooks_out="$(render --set hooks.enabled=true)"
reset_out="$(render --set alphaReset.enabled=true)"
level_out="$(render --set levelRecompute.enabled=true)"

# --- shape ---------------------------------------------------------------------------

grep -q 'kind: Deployment' <<<"$default_out" || fail "no Deployment"
test "$(grep -c 'kind: Deployment' <<<"$default_out")" -eq 3 ||
  fail "expected 3 deployments (api, web, worker)"

test "$(grep -c 'kind: Service' <<<"$default_out")" -eq 2 ||
  fail "expected 2 services (api, web); the worker binds no port"

grep -q 'kind: Ingress' <<<"$default_out" || fail "no Ingress"
for path in '/api' '/auth'; do
  grep -q "path: $path" <<<"$default_out" || fail "ingress does not route $path"
done
grep -q 'path: /$' <<<"$default_out" || fail "ingress does not route /"
grep -q 'ashuworld.test' <<<"$default_out" || fail "ingress host not rendered"

# --- the hooks route is gated --------------------------------------------------------

grep -q '/hooks' <<<"$default_out" &&
  fail "hooks path routed before any adapter exists: set hooks.enabled=false is ignored"
test "$(grep -c '/hooks' <<<"$hooks_out")" -eq 1 ||
  fail "hooks path missing (or duplicated) when hooks.enabled=true"

# --- migrations run before the release -----------------------------------------------

grep -q 'helm.sh/hook: pre-install,pre-upgrade' <<<"$default_out" ||
  fail "no migrate job hooked before install and upgrade"
grep -q 'kind: Job' <<<"$default_out" || fail "no migrate Job"

# --- the alpha reset is gated --------------------------------------------------------

grep -q 'alpha-reset' <<<"$default_out" && fail "alpha reset job rendered without alphaReset.enabled"
grep -q 'alpha-reset' <<<"$reset_out" || fail "alpha reset job missing when alphaReset.enabled=true"

# --- the level recompute is gated ----------------------------------------------------

grep -q 'level-recompute' <<<"$default_out" &&
  fail "level recompute job rendered without levelRecompute.enabled"
grep -q 'level-recompute' <<<"$level_out" ||
  fail "level recompute job missing when levelRecompute.enabled=true"

# --- secrets stay in Secrets ---------------------------------------------------------

grep -qi 'postgres://[^" ]*:[^" ]*@' <<<"$default_out" &&
  fail "connection string rendered into the chart"
grep -q 'secretKeyRef' <<<"$default_out" || fail "DATABASE_URL is not read from a Secret"

# --- hardened containers -------------------------------------------------------------

test "$(grep -c 'runAsNonRoot: true' <<<"$default_out")" -ge 3 || fail "containers run as root"
test "$(grep -c 'readOnlyRootFilesystem: true' <<<"$default_out")" -ge 3 ||
  fail "a container can write to its own filesystem"
grep -q 'allowPrivilegeEscalation: false' <<<"$default_out" ||
  fail "a container may escalate to root"
grep -q 'drop:' <<<"$default_out" || fail "no capabilities dropped"
grep -q 'emptyDir' <<<"$default_out" || fail "web has nowhere to write its temp files"

# --- probes --------------------------------------------------------------------------

grep -q 'path: /api/health' <<<"$default_out" || fail "api has no health probe"
grep -q 'path: /$' <<<"$default_out" || fail "web has no probe"
grep -q 'TRUST_PROXY' <<<"$default_out" || fail "TRUST_PROXY missing; the ingress address would be logged"

echo ok
