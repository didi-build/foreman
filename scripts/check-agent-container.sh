#!/usr/bin/env bash
# Build one agent image and check the job conventions in ADR 0106 section 4 (on top of ADR 0111's
# digest pin and non-root user). Agent images are jobs, not services: no PORT, no exposed port,
# no health check. Started with no settings, an image must exit non-zero and print one result
# line as its last line, naming the missing settings. The Messages API image also runs QA's browser
# pod (ADR 0119 slice 5b, D-476), so for it the browser canary runs inside the built image too.
# Not privileged: every container it starts runs as a user, with no privileged mode.
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

# 4. The Messages API image's browser host (ADR 0119 slice 5b, D-476): inside the built image, with
# a read-only root, user 1000, every capability dropped, no new privileges and no network but
# loopback, the fixture page tries every way it has to reach a local canary and the host's own API,
# and the canary must see nothing (test/fixtures/browser-canary/canary.mjs, which the local test
# test/browser-canary.test.ts runs too). The fixtures are mounted read-only, never built in.
if [ "${name}" = "claude-api" ]; then
  set +e
  canary="$(docker run --rm --read-only --tmpfs /tmp:rw,mode=1777,size=512m \
    --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --network none \
    --volume "${PWD}/test/fixtures:/fixtures:ro" --env HOME=/tmp --env TMPDIR=/tmp \
    --entrypoint node "${image}" \
    /fixtures/browser-canary/canary.mjs /app/src/agent-images/claude-api/browser-host.ts 2>&1)"
  code=$?
  set -e
  printf '%s\n' "${canary}" | sed -n '$p'
  [ "${code}" = "0" ] || fail "the browser canary saw traffic, or the browser host did not run"
fi

echo "${name}: agent image conventions hold"
