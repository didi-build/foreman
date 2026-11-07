#!/usr/bin/env bash
# The infrastructure plan as Didi reads it in the job summary before approving the apply (D-339,
# O-105): what changes, by resource address and action; the gates the change touches (AGENTS.md
# section 5), with each DNS record and Workers route that changes by name (D-357, O-112); then the
# plan as `tofu show -no-color` prints it, already redacted.
#
#   infra-plan-summary.sh <changes.json> <redacted plan text>
#
# changes.json holds only each resource change's address, type and actions, read from the plan's
# JSON form by jq in a pipe. The JSON form prints sensitive values in plain text, so it is never
# written to a file or a log (ADR 0110 secrets rule 5).
set -euo pipefail
changes="${1:?changes.json}"
plan_text="${2:?the redacted plan text}"

# Each change's action in one word: create, update, replace, delete or read (no-op is dropped).
rows="$(jq -r '
  .[]
  | .action = (
      if (.actions | index("delete")) and (.actions | index("create")) then "replace"
      elif (.actions | index("create")) then "create"
      elif (.actions | index("update")) then "update"
      elif (.actions | index("delete")) then "delete"
      elif (.actions | index("read")) then "read"
      else "no-op" end)
  | select(.action != "no-op")
  | [.action, .type, .address] | @tsv' "$changes")"

count() { printf '%s\n' "$rows" | awk -F'\t' -v a="$1" '$1 == a' | grep -c . || true; }
gate() { printf -- '- %s\n' "$1"; gates=$((gates + 1)); }
has() { printf '%s\n' "$rows" | awk -F'\t' -v t="$1" -v a="${2:-}" '$2 == t && (a == "" || $1 == a)' | grep -q .; }

# Each change of one type, by name, one line each under its gate (D-357, O-112). A project's
# record and route are keyed by the project's host name, so the name comes from the address
# alone, and the JSON form is still read for addresses, types and actions only (ADR 0110 secrets
# rule 5). A project's host name is public and shown as it is. The receiver's record is named by
# its address: its host name is one of the placeholders. Anything else shows its address.
names() {
  local type="$1" suffix="$2" action address
  local project='\.project\["([a-z0-9][a-z0-9.-]*)"\]$'
  printf '%s\n' "$rows" | awk -F'\t' -v t="$type" '$2 == t { print $1 "\t" $3 }' |
    while IFS=$'\t' read -r action address; do
      if [[ "$address" =~ $project ]]; then
        printf -- '  - %s `%s%s`\n' "$action" "${BASH_REMATCH[1]}" "$suffix"
      elif [[ "$address" == *.cloudflare_dns_record.receiver\[0\] ]]; then
        printf -- "  - %s the receiver's record \`%s\` (its host name is a placeholder in the plan below)\n" "$action" "$address"
      else
        printf -- '  - %s `%s`\n' "$action" "$address"
      fi
    done
}

echo "## Infrastructure plan"
echo
echo "Commit \`${GITHUB_SHA:-unknown}\`. Read it all before approving the \`infra\` job. The apply runs this exact saved plan and nothing else."
echo
echo "| Change | Resources |"
echo "| --- | --- |"
for action in create update replace delete read; do
  echo "| ${action} | $(count "$action") |"
done
echo

echo "### Gates this plan touches"
echo
gates=0
if has cloudflare_dns_record; then
  gate "**DNS change** (DNS gate, D-195, D-357): approve only the record changes Didi approved, and nothing else in the same plan. Each record that changes:"
  names cloudflare_dns_record ""
fi
if has cloudflare_workers_route; then
  gate "**Workers route change** (DNS gate, D-357): each route sends every path of one project's host name to that project's staging Worker, \`<slug>-staging\`. Approve only the routes of the projects Didi added. Each route that changes:"
  names cloudflare_workers_route "/*"
fi
if has cloudflare_zero_trust_tunnel_cloudflared_config; then
  gate "**Tunnel routing change** (tunnel gate, D-271): check the ingress rules below match the change Didi approved."
fi
if has cloudflare_zero_trust_tunnel_cloudflared create || has cloudflare_zero_trust_tunnel_cloudflared replace; then
  gate "**New credential**: a new tunnel makes a new tunnel token (new-credentials gate). The cluster Secrets job then puts it into the cluster."
fi
if has digitalocean_kubernetes_cluster create || has digitalocean_kubernetes_node_pool create ||
  has digitalocean_kubernetes_cluster replace || has digitalocean_kubernetes_node_pool replace; then
  gate "**Spending**: a cluster or node pool is created or replaced (spending gate, D-337, up to 60 USD a month)."
fi
if has digitalocean_firewall; then
  gate "**Network rules**: the worker firewall changes. A new outbound port needs Didi's approval."
fi
if printf '%s\n' "$rows" | awk -F'\t' '$1 == "delete" || $1 == "replace"' | grep -q .; then
  gate "**Deletes or replaces**: check no data is lost (drop-data gate). The cluster refuses to be destroyed (prevent_destroy)."
fi
if [ "$gates" -eq 0 ]; then
  echo "None: no DNS record, Workers route, tunnel, firewall, new cluster, deletion or replacement."
fi
echo

echo "### Resources that change"
echo
if [ -z "$rows" ]; then
  echo "No changes. Nothing to apply."
else
  echo "| Action | Address |"
  echo "| --- | --- |"
  printf '%s\n' "$rows" | awk -F'\t' '{ printf "| %s | `%s` |\n", $1, $3 }'
fi
echo

echo "### The plan"
echo
echo "Account, zone and record ids, the cluster and tunnel ids, the receiver's host name and the state bucket are shown as placeholders, because this page is public. Each project's host name is public and shown as it is. Sensitive values show as \`(sensitive value)\`."
echo
echo '````text'
cat "$plan_text"
echo '````'
