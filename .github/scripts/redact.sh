#!/usr/bin/env bash
# Copy stdin to stdout for a log or a job summary. The repository is public, so anyone can read
# both (O-105). The value of each variable named in REDACT_NAMES (comma-separated) becomes
# <NAME>, and every UUID and every 32-hex id (the Cloudflare account, zone and record ids, the
# cluster and tunnel ids) becomes <id>. A 64-hex image digest is left as it is.
#
# This keeps ids and host names out of public pages. It is not what keeps secrets out: tofu and
# kubectl never print a sensitive value, and the secret-value scan runs before anything is
# published (ADR 0110 secrets rule 6).
set -euo pipefail
text="$(
  cat
  printf x
)"
text="${text%x}"

IFS=',' read -r -a names <<<"${REDACT_NAMES:-}"
for name in "${names[@]}"; do
  [ -n "$name" ] || continue
  if ! [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
    echo "redact.sh: REDACT_NAMES holds a name that is not a variable name." >&2
    exit 2
  fi
  value="${!name:-}"
  [ -n "$value" ] || continue
  text="${text//"$value"/<$name>}"
done

printf '%s' "$text" | sed -E \
  -e 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<id>/g' \
  -e 's/(^|[^0-9a-fA-F])[0-9a-fA-F]{32}([^0-9a-fA-F]|$)/\1<id>\2/g'
