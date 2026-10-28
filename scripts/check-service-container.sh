#!/usr/bin/env bash
# Build one service image and check the container conventions in ADR 0111.
# Usage, from the repo root: scripts/check-service-container.sh src/<service>
set -euo pipefail

dir="${1:?usage: scripts/check-service-container.sh src/<service>}"
name="$(basename "$dir")"
image="conventions-check-${name}"
port=18080

fail() {
  echo "::error::${name}: $1"
  exit 1
}

docker build -f "${dir}/Dockerfile" -t "${image}" .

# 1. Config only from the environment, health endpoint answers.
cid="$(docker run -d -e PORT="${port}" -p "${port}:${port}" "${image}")"
trap 'docker rm -f "${cid}" >/dev/null 2>&1 || true' EXIT
healthy=""
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    healthy="yes"
    break
  fi
  sleep 1
done
if [ -z "${healthy}" ]; then
  docker logs "${cid}" || true
  fail "GET /health did not return 200 within 30 seconds"
fi

# 2. Structured logs: the first log line is JSON.
# sed reads all input, so the pipe cannot fail under pipefail the way head can.
first_line="$(docker logs "${cid}" 2>&1 | sed -n 1p)"
node -e 'JSON.parse(process.argv[1])' "${first_line}" >/dev/null 2>&1 || fail "the first log line is not JSON"

# 3. Clean shutdown: SIGTERM leads to exit code 0.
docker stop -t 15 "${cid}" >/dev/null
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "${cid}")"
[ "${exit_code}" = "0" ] || fail "exited with ${exit_code} after SIGTERM, expected 0"

# 4. Invalid config: refuses to start, names the setting, never prints the value.
bad_value="invalid-port-value-for-check"
if output="$(docker run --rm -e PORT="${bad_value}" "${image}" 2>&1)"; then
  fail "started with an invalid PORT"
fi
grep -q "PORT" <<<"${output}" || fail "did not name the invalid setting"
if grep -q "${bad_value}" <<<"${output}"; then
  fail "printed the rejected value"
fi

echo "${name}: container conventions OK"
