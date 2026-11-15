#!/usr/bin/env bash
#
# Renders the chart and asserts the promises the deployment makes.
#
# Every check here failed at least once during the chart's first draft, or is a rule the
# brief calls out by name. The script renders the chart several times: the default values,
# with the hook receiver turned on, with the alpha reset turned on, with the level recompute
# turned on, with the purge CronJob turned on, and with the provider credentials turned on,
# because the gated resources must stay out of a default install. Further renders cover each
# half of the provider pair on its own — the Secret without the channel login, and the login
# without the Secret — plus one with a different Secret name, because a hardcoded name would
# pass every other check.
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

# One file of the chart only, so a check can say "the api" or "the worker" and mean it.
render_component() {
  local component="$1"
  shift
  helm template ashuworld . --set ingress.host=ashuworld.test --show-only "templates/$component.yaml" "$@"
}

default_out="$(render)"
hooks_out="$(render --set hooks.enabled=true)"
reset_out="$(render --set alphaReset.enabled=true)"
level_out="$(render --set levelRecompute.enabled=true)"
purge_out="$(render --set purge.enabled=true)"
providers_out="$(render --set providers.secretName=ashuworld-providers --set providers.twitch.channelLogin=ashuworld)"
providers_api_out="$(render_component api --set providers.secretName=ashuworld-providers --set providers.twitch.channelLogin=ashuworld)"
providers_worker_out="$(render_component worker --set providers.secretName=ashuworld-providers --set providers.twitch.channelLogin=ashuworld)"
no_provider_secret_out="$(render --set providers.twitch.channelLogin=ashuworld)"
no_channel_login_out="$(render --set providers.secretName=ashuworld-providers)"
no_channel_login_api_out="$(render_component api --set providers.secretName=ashuworld-providers)"
no_channel_login_worker_out="$(render_component worker --set providers.secretName=ashuworld-providers)"
custom_secret_out="$(render --set providers.secretName=operator-secret --set providers.twitch.channelLogin=ashuworld)"
custom_secret_api_out="$(render_component api --set providers.secretName=operator-secret --set providers.twitch.channelLogin=ashuworld)"
custom_secret_worker_out="$(render_component worker --set providers.secretName=operator-secret --set providers.twitch.channelLogin=ashuworld)"

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
grep -q 'reset-ashuworld' <<<"$reset_out" || fail "the alpha reset confirm Secret is missing"

# --- the level recompute is gated ----------------------------------------------------

grep -q 'level-recompute' <<<"$default_out" &&
  fail "level recompute job rendered without levelRecompute.enabled"
grep -q 'level-recompute' <<<"$level_out" ||
  fail "level recompute job missing when levelRecompute.enabled=true"

# --- the purge CronJob is gated and armed --------------------------------------------

test "$(grep -c 'kind: CronJob' <<<"$default_out")" -eq 0 ||
  fail "purge CronJob rendered without purge.enabled"
test "$(grep -c 'kind: CronJob' <<<"$purge_out")" -eq 1 ||
  fail "expected exactly one CronJob when purge.enabled=true"
grep -q 'command: \["node", "dist/worker.js", "purge"\]' <<<"$purge_out" ||
  fail "the CronJob does not run the purge subcommand"
grep -q 'concurrencyPolicy: Forbid' <<<"$purge_out" ||
  fail "two purge passes may run at once, and they would race for the same rows"
grep -q 'restartPolicy: OnFailure' <<<"$purge_out" ||
  fail "the purge container has no restart policy"
grep -q 'PURGE_CONFIRM' <<<"$purge_out" || fail "purge is not armed"
grep -q 'purge-ashuworld' <<<"$purge_out" || fail "purge confirm Secret has no value"
# Three erasing workloads: the api, the worker and the pass. A fourth caller of the ledger's
# erasure with no pepper would write a value nothing can re-derive.
test "$(grep -c 'ERASURE_PEPPER' <<<"$purge_out")" -ge 3 ||
  fail "an erasing workload has no pepper (expected api, worker and purge)"

# The chart-wide checks below run on the default render, which holds no CronJob, so the CronJob
# needs its own. Extract just that document — stopping at the next `---` — and assert the same
# promises on it: reading to the end of the stream would let the worker Deployment answer for it.
purge_job="$(awk '/^kind: CronJob/{f=1} f && /^---$/{exit} f' <<<"$purge_out")"
grep -qi 'postgres://[^" ]*:[^" ]*@' <<<"$purge_job" && fail "connection string rendered into the purge CronJob"
for guard in 'readOnlyRootFilesystem: true' 'allowPrivilegeEscalation: false' 'drop:'; do
  grep -q "$guard" <<<"$purge_job" || fail "the purge CronJob is missing $guard"
done
# The pepper must come from the Secret, not a value: an inline pepper cannot re-derive a key.
# The named Secret is asserted too, because the CronJob's own metadata.name would otherwise
# satisfy a bare name grep and the check would prove nothing.
grep -A3 'name: ERASURE_PEPPER' <<<"$purge_job" | grep -q 'secretKeyRef' ||
  fail "the purge pepper is not read from a Secret"
grep -A4 'name: ERASURE_PEPPER' <<<"$purge_job" | grep -q 'name: ashuworld-erasure' ||
  fail "the purge CronJob does not read the erasure Secret"
grep -A4 'name: PURGE_CONFIRM' <<<"$purge_job" | grep -q 'name: ashuworld-purge' ||
  fail "the purge CronJob does not reference its confirm Secret"
# The Secret's *key* as well as its name: a ref naming the right Secret with the wrong key
# mounts nothing, and the pass would exit at startup with an empty pepper. Anchored at the
# end of the line, because a bare substring check accepts `key: peppered` for `key: pepper`.
grep -A4 'name: ERASURE_PEPPER' <<<"$purge_job" | grep -Eq 'key: pepper[[:space:]]*$' ||
  fail "the purge CronJob reads the wrong key from the erasure Secret"
grep -A4 'name: PURGE_CONFIRM' <<<"$purge_job" | grep -Eq 'key: confirm[[:space:]]*$' ||
  fail "the purge CronJob reads the wrong key from its confirm Secret"

# --- secrets stay in Secrets ---------------------------------------------------------

grep -qi 'postgres://[^" ]*:[^" ]*@' <<<"$default_out" &&
  fail "connection string rendered into the chart"
grep -q 'secretKeyRef' <<<"$default_out" || fail "DATABASE_URL is not read from a Secret"

# --- provider credentials stay in a Secret ------------------------------------------
#
# The chart takes no client secret as a value, so the only way one can reach a pod is a
# secretKeyRef to the Secret the operator created. Each reference is optional, so a key the
# operator did not create leaves that provider off instead of holding the pod in
# CreateContainerConfigError.

for key in twitch-client-id twitch-client-secret twitch-channel-token platform-token-key; do
  grep -q "key: $key" <<<"$providers_out" || fail "provider key $key is never mounted"
done

# The credential on each line must be followed by valueFrom, never by a literal value. The
# two worker-only keys appear once each, the client pair twice: api and worker.
for name in TWITCH_CLIENT_ID TWITCH_CLIENT_SECRET; do
  test "$(grep -A1 "name: $name\$" <<<"$providers_out" | grep -c 'valueFrom:')" -eq 2 ||
    fail "$name is not read from the Secret on both Deployments"
done
for name in TWITCH_CHANNEL_REFRESH_TOKEN PLATFORM_TOKEN_KEY; do
  test "$(grep -A1 "name: $name\$" <<<"$providers_out" | grep -c 'valueFrom:')" -eq 1 ||
    fail "$name must be read by the worker only"
done

test "$(grep -c 'optional: true' <<<"$providers_api_out")" -eq 2 ||
  fail "the api must read the client pair, both optional"
test "$(grep -c 'optional: true' <<<"$providers_worker_out")" -eq 4 ||
  fail "the worker must read the client pair, the channel token and the sealing key, all optional"

test "$(grep -c 'name: TWITCH_CHANNEL_LOGIN' <<<"$providers_out")" -eq 2 ||
  fail "TWITCH_CHANNEL_LOGIN is missing from the api or the worker"
test "$(grep -c 'value: "ashuworld"' <<<"$providers_out")" -eq 2 ||
  fail "TWITCH_CHANNEL_LOGIN does not carry providers.twitch.channelLogin"
grep -q 'TWITCH_CHANNEL_LOGIN' <<<"$default_out" &&
  fail "TWITCH_CHANNEL_LOGIN rendered with providers.twitch.channelLogin empty"

# The two switches are independent: no Secret named, no credential mounted, and the plain
# channel login still there.
for key in twitch-client-id twitch-client-secret twitch-channel-token platform-token-key; do
  grep -q "key: $key" <<<"$no_provider_secret_out" &&
    fail "provider key $key mounted with providers.secretName empty"
done
grep -q 'TWITCH_CHANNEL_LOGIN' <<<"$no_provider_secret_out" ||
  fail "the channel login is lost when providers.secretName is empty"
grep -q 'ashuworld-providers' <<<"$default_out" &&
  fail "a provider Secret is referenced by the default values"

# The Secret name is a value, not a literal. Every other render uses the same name, so this
# one is the only thing that would notice a hardcoded `name:` in the helper.
test "$(grep -c 'name: operator-secret' <<<"$custom_secret_api_out")" -eq 2 ||
  fail "the api does not follow providers.secretName: expected 2 refs to operator-secret"
test "$(grep -c 'name: operator-secret' <<<"$custom_secret_worker_out")" -eq 4 ||
  fail "the worker does not follow providers.secretName: expected 4 refs to operator-secret"
grep -q 'ashuworld-providers' <<<"$custom_secret_out" &&
  fail "the provider Secret name is hardcoded: ashuworld-providers appears with secretName=operator-secret"

# The other half: the Secret exists, the channel login does not. This is the state right
# after `kubectl create secret`, and the pods must start with every ref in place.
test "$(grep -c 'optional: true' <<<"$no_channel_login_api_out")" -eq 2 ||
  fail "the api must mount the client pair when providers.twitch.channelLogin is empty"
test "$(grep -c 'optional: true' <<<"$no_channel_login_worker_out")" -eq 4 ||
  fail "the worker must mount all four keys when providers.twitch.channelLogin is empty"
grep -q 'TWITCH_CHANNEL_LOGIN' <<<"$no_channel_login_out" &&
  fail "TWITCH_CHANNEL_LOGIN rendered with providers.twitch.channelLogin empty"

# A helper that renders nothing must not leave a whitespace-only line in the env list.
grep -qE '^ +$' <<<"$default_out" &&
  fail "whitespace-only line in the default render: an empty provider include is not gated"

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
