#!/usr/bin/env bash
# Build one agent image and check the job conventions in ADR 0106 section 4 (on top of ADR 0111's
# digest pin and non-root user). Agent images are jobs, not services: no PORT, no exposed port,
# no health check. Started with no settings, an image must exit non-zero and print one result
# line as its last line, naming the missing settings.
# Usage, from the repo root: scripts/check-agent-container.sh src/agent-images/<image>
set -euo pipefail

dir="${1:?usage: scripts/check-agent-container.sh src/agent-images/<image>}"
name="$(basename "$dir")"
image="agent-conventions-check-${name}"

fail() {
  echo "::error::${name}: $1"
  exit 1
}

# 0. Base image pinned by digest (every FROM line).
if grep -E '^FROM ' "${dir}/Dockerfile" | grep -Evq '@sha256:[0-9a-f]{64}'; then
  fail "every FROM line must pin its image by digest (@sha256:...)"
fi

docker build -f "${dir}/Dockerfile" -t "${image}" .

# 1. Runs as a non-root user.
image_user="$(docker inspect -f '{{.Config.User}}' "${image}")"
case "${image_user}" in
  "" | root | 0 | 0:*) fail "the image runs as root (USER is '${image_user:-unset}')" ;;
esac

# 2. A job: no exposed port and no health check.
[ "$(docker inspect -f '{{len .Config.ExposedPorts}}' "${image}")" = "0" ] ||
  fail "an agent image exposes no port"
[ "$(docker inspect -f '{{if .Config.Healthcheck}}yes{{end}}' "${image}")" = "" ] ||
  fail "an agent image has no health check"

# 3. With no settings it fails closed, read-only, and its last line is the result.
set +e
output="$(docker run --rm --read-only --tmpfs /tmp "${image}" 2>&1)"
code=$?
set -e
[ "${code}" != "0" ] || fail "with no settings the image must exit non-zero"
last_line="$(printf '%s\n' "${output}" | sed -n '$p')"
node -e '
  const r = JSON.parse(process.argv[1]);
  if (r.foremanResult !== 1 || r.status !== "error" || !/FOREMAN_RUN_ID is not set/.test(r.errorText)) process.exit(1);
' "${last_line}" || fail "the last line is not a result line naming the missing settings"

echo "${name}: agent image conventions hold"
