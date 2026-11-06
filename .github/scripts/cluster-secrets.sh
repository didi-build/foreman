#!/usr/bin/env bash
# Create or update the cluster's Secrets from the `platform` environment's secrets (D-339, O-105;
# first-hosting runbook steps 9, 10 and 15). A Markdown report, names only, goes to the file
# $REPORT for the job summary. Stdout carries only the log and the masks of the values this script
# derives (the tunnel token and the planning token's hash), so a mask never lands in the summary.
#
# Each value goes from an environment variable through stdin into
# `kubectl create secret generic <name> --from-file=<key>=/dev/stdin`, and from there through a
# pipe into a server-side apply: never into a file, an argument or the log. An environment secret
# that is empty leaves its Secret as it is and is reported by name only, so Didi can also clear a
# secret from the environment once its run has put it in the cluster. A value that cannot be
# right (spaces at either end, or a planning token outside the state API's own rule) is refused
# by name and fails the run. Each deployment whose Secret changed is restarted and waited for.
set -euo pipefail
: "${STACK:?}" "${REPORT:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ns="foreman-platform"
field_manager="foreman-cluster-secrets"

# The Secrets the platform pods read (PLATFORM_SECRETS in infra/kubernetes/platform.ts) and the
# deployment that reads each one. test/admin-workflows.test.ts holds this table to both.
#   Secret                                 key     variable                    deployment
SECRETS=(
  "cloudflared-tunnel-token               token   RECEIVER_TUNNEL_TOKEN       cloudflared"
  "state-api-database                     url     STATE_API_DATABASE_URL      state-api"
  "github-receiver-database               url     RECEIVER_DATABASE_URL       github-receiver"
  "github-receiver-webhook-secret         value   RECEIVER_WEBHOOK_SECRET     github-receiver"
  "state-api-planning-token               sha256  PLANNING_TOKEN_SHA256       state-api"
  "state-api-windmill-plan-approval-token token   STATE_API_WINDMILL_TOKEN    state-api"
  "github-receiver-windmill-token         token   RECEIVER_WINDMILL_TOKEN     github-receiver"
  "run-watcher-windmill-token             token   RUN_WATCHER_WINDMILL_TOKEN  run-watcher"
)

changed=()
unchanged=()
skipped=()
refused=()
declare -A restart=()
failed_rollouts=()

# The tunnel token, straight from the infrastructure state into a variable, never printed (step 9).
RECEIVER_TUNNEL_TOKEN=""
if RECEIVER_TUNNEL_TOKEN="$(tofu -chdir="$STACK" output -raw receiver_tunnel_token 2>"$RUNNER_TEMP/tofu-output.err")" &&
  [ -n "$RECEIVER_TUNNEL_TOKEN" ]; then
  echo "::add-mask::$RECEIVER_TUNNEL_TOKEN"
else
  RECEIVER_TUNNEL_TOKEN=""
  refused+=("cloudflared-tunnel-token (the infrastructure state has no tunnel token: apply the infrastructure first)")
  "$here/redact.sh" <"$RUNNER_TEMP/tofu-output.err" >&2
fi
rm -f "$RUNNER_TEMP/tofu-output.err"

# The planning token's hash, exactly as step 15 makes it: the token with no newline, through
# sha256sum, the hex only, no newline. The token itself never reaches the cluster.
PLANNING_TOKEN_SHA256=""
planning_refused=""
if [ -n "${PLANNING_TOKEN:-}" ]; then
  if [[ "$PLANNING_TOKEN" =~ ^[A-Za-z0-9_-]{32,256}$ ]]; then
    PLANNING_TOKEN_SHA256="$(printf '%s' "$PLANNING_TOKEN" | sha256sum | cut -d' ' -f1 | tr -d '\n')"
    echo "::add-mask::$PLANNING_TOKEN_SHA256"
  else
    planning_refused="yes"
  fi
fi

resource_version() {
  kubectl get secret "$1" -n "$ns" --ignore-not-found --output 'jsonpath={.metadata.resourceVersion}'
}

put_secret() {
  local secret="$1" key="$2" variable="$3" deployment="$4"
  local value="${!variable:-}" before after
  if [ "$variable" = "PLANNING_TOKEN_SHA256" ] && [ -n "$planning_refused" ]; then
    refused+=("$secret (PLANNING_TOKEN must be 32 to 256 letters, digits, - and _, with no newline)")
    return 0
  fi
  if [ -z "$value" ]; then
    if [ "$variable" != "RECEIVER_TUNNEL_TOKEN" ]; then
      skipped+=("$secret (${variable/_SHA256/} is not set)")
    fi
    return 0
  fi
  if [[ "$value" =~ ^[[:space:]] || "$value" =~ [[:space:]]$ ]]; then
    refused+=("$secret ($variable starts or ends with a space or a newline: enter it again)")
    return 0
  fi
  before="$(resource_version "$secret")"
  printf '%s' "$value" |
    kubectl create secret generic "$secret" --namespace "$ns" --from-file="$key=/dev/stdin" \
      --dry-run=client --output json |
    kubectl apply --server-side --force-conflicts --field-manager="$field_manager" \
      --filename - >/dev/null
  after="$(resource_version "$secret")"
  if [ "$before" = "$after" ]; then
    unchanged+=("$secret")
  else
    changed+=("$secret")
    restart["$deployment"]=1
  fi
}

for entry in "${SECRETS[@]}"; do
  read -r secret key variable deployment <<<"$entry"
  put_secret "$secret" "$key" "$variable" "$deployment"
done

restarted=()
for deployment in $(printf '%s\n' "${!restart[@]}" | sort); do
  kubectl rollout restart "deployment/$deployment" -n "$ns" >/dev/null
  restarted+=("$deployment")
done
for deployment in "${restarted[@]+"${restarted[@]}"}"; do
  if ! kubectl rollout status "deployment/$deployment" -n "$ns" --timeout=180s >/dev/null 2>&1; then
    failed_rollouts+=("$deployment")
  fi
done

list() {
  if [ "$#" -eq 0 ]; then
    echo "none"
  else
    printf '`%s`, ' "$@" | sed 's/, $//'
  fi
}

{
  echo "## Cluster Secrets"
  echo
  echo "Namespace \`$ns\`. Names only: no value is shown anywhere."
  echo
  echo "- Created or updated: $(list "${changed[@]+"${changed[@]}"}")"
  echo "- Already up to date: $(list "${unchanged[@]+"${unchanged[@]}"}")"
  echo "- Skipped, the environment secret is not set (the Secret is left as it is): $(list "${skipped[@]+"${skipped[@]}"}")"
  echo "- Refused: $(list "${refused[@]+"${refused[@]}"}")"
  echo "- Restarted: $(list "${restarted[@]+"${restarted[@]}"}")"
  echo "- Not ready within 3 minutes after the restart: $(list "${failed_rollouts[@]+"${failed_rollouts[@]}"}")"
  if [ "${#refused[@]}" -gt 0 ] || [ "${#failed_rollouts[@]}" -gt 0 ]; then
    echo
    echo "**Something needs a look.** A refused Secret was not changed. A deployment that is not ready usually still waits for another Secret, or cannot reach the database: read its pod's events."
  fi
} >"$REPORT"

if [ "${#refused[@]}" -gt 0 ] || [ "${#failed_rollouts[@]}" -gt 0 ]; then
  exit 1
fi
