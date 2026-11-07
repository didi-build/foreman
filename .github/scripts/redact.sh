#!/usr/bin/env bash
# Copy stdin to stdout for a log or a job summary. The repository is public, so anyone can read
# both (O-105). The value of each variable named in REDACT_NAMES (comma-separated) becomes
# <NAME>, and every UUID and every 32-hex id (the Cloudflare account, zone and record ids, the
# cluster and tunnel ids) becomes <id>. A 64-hex image digest is left as it is.
#
# Every dotted-quad IPv4 address becomes <ip>, except 0.0.0.0, so the cluster API's address stays
# out even where the cluster resource is shown (D-349, O-107). A quad counts when it stands on its
# own: not right after a letter, a digit, an underscore or a dotted number, and not followed by a
# digit or by a dot and a digit. So version strings such as v1.2.3.4, 1.37.2-do.0 or 1.2.3.4.5
# are left as they are, as is 0.0.0.0/0. A bare four-number version of small numbers would be
# replaced too, which hides nothing that matters.
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

# Any quad but 0.0.0.0: one of its four numbers is not zero.
n='[0-9]{1,3}'
z='0{1,3}'
nz='0{0,2}[1-9][0-9]{0,2}'
quad="(${nz}\\.${n}\\.${n}\\.${n}|${z}\\.${nz}\\.${n}\\.${n}|${z}\\.${z}\\.${nz}\\.${n}|${z}\\.${z}\\.${z}\\.${nz})"
before='(^|[^0-9A-Za-z_.]|[^0-9]\.)'
after='([^0-9.]|\.[^0-9]|\.?$)'

# The address rule loops on each line until nothing is left to replace, so two addresses side by
# side are both replaced.
printf '%s' "$text" | sed -E \
  -e 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<id>/g' \
  -e 's/(^|[^0-9a-fA-F])[0-9a-fA-F]{32}([^0-9a-fA-F]|$)/\1<id>\2/g' |
  sed -E -e ':address' -e "s/${before}${quad}${after}/\\1<ip>\\3/" -e 't address'
