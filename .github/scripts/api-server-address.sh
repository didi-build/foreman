#!/usr/bin/env bash
# Put the Kubernetes API server's own address into the rendered objects, on this runner only
# (D-349, O-107). The run watcher's network policy allows the address and port the `kubernetes`
# Service sends to (D-330, runbook step 7). The repository is public, so that address never
# reaches a log, a job summary or an artifact: the render job, which holds no credential, writes
# the placeholder 192.0.2.1 (TEST-NET-1, RFC 5737, never routed) on port 443, and each job that
# holds the cluster credential runs this right after fetching it, before any other kubectl
# output, and swaps the placeholder in its own copy of the rendered objects.
#
#   api-server-address.sh <rendered manifests JSON>
#
# It reads the `kubernetes` EndpointSlice, masks every address before anything can print it, and
# accepts plain IPv4 addresses and exactly one port only. It then finds the one egress rule whose
# `to` is exactly the placeholder's ipBlock and whose port is 443, across all objects, and gives
# it one /32 ipBlock per address and the real port. It refuses, with fixed text that never holds
# an address, when there is no such rule or more than one, or when the placeholder is still in
# the file afterwards. It prints only the number of addresses. The file is changed in place and
# is never uploaded or printed.
set -euo pipefail
manifests="${1:?the rendered manifests}"
placeholder_address="192.0.2.1"
placeholder_port=443

slices="$(kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes --output json)"
# jq's own error could quote a value before it is masked, so it is not shown.
if ! api="$(jq -c '{
  addresses: ([.items[].endpoints[]?.addresses[]?] | unique),
  port: ([.items[].ports[]? | select(.name == "https" or .name == null) | .port] | unique)
}' <<<"$slices" 2>/dev/null)"; then
  echo "::error::The kubernetes Service's EndpointSlice list could not be read."
  exit 1
fi

# Masked first, before any check or other output. Only a value made of address characters can be
# a mask line; any other value is refused below, and nothing prints it.
while IFS= read -r address; do
  echo "::add-mask::$address"
done < <(jq -r '.addresses[] | strings | select(test("^[0-9A-Fa-f:.]+$"))' <<<"$api")

# Plain IPv4 addresses and one port, as the run watcher's policy takes them (step 7), by the
# render's own rule for these values: no 0.0.0.0, and a port from 1 to 65535 that is not DNS's.
if ! jq -e '
    def octet: "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
    (.addresses | length) > 0
    and all(.addresses[];
      type == "string" and test("^(\(octet)\\.){3}\(octet)$") and . != "0.0.0.0")
    and (.port | length) == 1
    and (.port[0] | type == "number" and . == floor and . >= 1 and . <= 65535 and . != 53)' \
  <<<"$api" >/dev/null 2>&1; then
  echo "::error::The kubernetes Service's EndpointSlice has no single port and plain IPv4 addresses."
  exit 1
fi

placeholder_rule='type == "object"
  and .to == [{ ipBlock: { cidr: $cidr, except: [] } }]
  and [.ports[]?.port] == [$port]'
matches="$(jq --arg cidr "${placeholder_address}/32" --argjson port "$placeholder_port" \
  "[paths($placeholder_rule)] | length" "$manifests")"
if [ "$matches" -eq 0 ]; then
  echo "::error::The rendered objects hold no egress rule to the API server's placeholder, so there is nothing to put the address in."
  exit 1
fi
if [ "$matches" -ne 1 ]; then
  echo "::error::The rendered objects hold more than one egress rule to the API server's placeholder. Only the run watcher's policy may hold one."
  exit 1
fi

swapped="$(mktemp "${manifests}.XXXXXX")"
trap 'rm -f "$swapped"' EXIT
jq --arg cidr "${placeholder_address}/32" --argjson port "$placeholder_port" --argjson api "$api" "
  first(paths($placeholder_rule)) as \$at
  | setpath(\$at; getpath(\$at)
      | .to = [\$api.addresses[] | { ipBlock: { cidr: (. + \"/32\"), except: [] } }]
      | .ports |= map(.port = \$api.port[0]))" "$manifests" >"$swapped"

if grep -Eq "(^|[^0-9])${placeholder_address//./\\.}([^0-9]|$)" "$swapped"; then
  echo "::error::The placeholder for the API server's address is still in the rendered objects after the swap."
  exit 1
fi
mv "$swapped" "$manifests"
echo "The API server's address is in this runner's copy of the rendered objects: $(jq -r '.addresses | length' <<<"$api") address(es)."
