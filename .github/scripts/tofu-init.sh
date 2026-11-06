#!/usr/bin/env bash
# Check the environment's plain settings, then `tofu init` the factory stack against its R2 state
# backend, as infra/README.md documents (ADR 0110, D-339, O-105). Used by the infra plan and
# apply jobs and by the cluster Secrets job (which reads the tunnel token from the same state).
#
# The settings are plain values from the GitHub environment's variables, not secrets, but they
# go into a backend setting and an OpenTofu variable, so each is checked against its own pattern
# first and named, never shown, when it does not match. Each is also masked: the repository is
# public, so its logs are too.
set -euo pipefail
: "${STACK:?}"
: "${AWS_ACCESS_KEY_ID:?is not set in this environment}"
: "${AWS_SECRET_ACCESS_KEY:?is not set in this environment}"
: "${TF_VAR_state_encryption_passphrase:?is not set in this environment}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bad=""
check() {
  local name="$1" pattern="$2" required="$3" value="${!1:-}"
  if [ -z "$value" ]; then
    [ "$required" = "required" ] && bad="$bad $name (not set)"
    return 0
  fi
  if [[ "$value" =~ $pattern ]]; then
    echo "::add-mask::$value"
  else
    bad="$bad $name (does not look like one)"
  fi
}
check CLOUDFLARE_ACCOUNT_ID '^[0-9a-f]{32}$' required
check STATE_BUCKET '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' required
check CLOUDFLARE_ZONE_ID '^[0-9a-f]{32}$' optional
check RECEIVER_HOSTNAME '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' optional
if [ -n "$bad" ]; then
  echo "::error::Check these environment variables:$bad" >&2
  exit 1
fi

endpoint="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
set +e
tofu -chdir="$STACK" init -input=false -lockfile=readonly -no-color \
  -backend-config="bucket=${STATE_BUCKET}" \
  -backend-config="endpoints={s3=\"${endpoint}\"}" >"$RUNNER_TEMP/tofu-init.log" 2>&1
code=$?
set -e
"$here/redact.sh" <"$RUNNER_TEMP/tofu-init.log"
rm -f "$RUNNER_TEMP/tofu-init.log"
exit "$code"
