#!/usr/bin/env bash
# The platform plan (D-339, O-105): what applying the rendered objects would create or change on
# the cluster, by kind, namespace and name, as Markdown on stdout for the job summary. Sets
# `changed=true|false` in $GITHUB_OUTPUT.
#
#   platform-plan.sh <rendered manifests JSON>
#
# Objects in a namespace that does not exist yet are listed as created: a server-side dry run
# cannot place them before their namespace exists. Everything else goes through
# `kubectl diff --server-side` with platform-diff.sh as the diff program, which names objects and
# prints none of their content. The render holds no Secret, so no Secret is ever diffed.
set -euo pipefail
manifests="${1:?the rendered manifests}"
: "${FIELD_MANAGER:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

new_namespaces=()
while IFS= read -r ns; do
  [ -n "$ns" ] || continue
  if [ -z "$(kubectl get namespace "$ns" --ignore-not-found --output name)" ]; then
    new_namespaces+=("$ns")
  fi
done < <(jq -r '.items[] | select(.kind == "Namespace") | .metadata.name' "$manifests")
new_json="$(printf '%s\n' "${new_namespaces[@]+"${new_namespaces[@]}"}" | jq -R 'select(length > 0)' | jq -s .)"

in_new='((.kind == "Namespace" and (.metadata.name as $n | $new | index($n) != null))
  or (.metadata.namespace as $ns | $ns != null and ($new | index($ns) != null)))'
jq -r --argjson new "$new_json" \
  ".items[] | select($in_new) | [\"create\", .kind, (.metadata.namespace // \"\"), .metadata.name] | @tsv" \
  "$manifests" >"$work/rows.tsv"
jq --argjson new "$new_json" ".items |= map(select($in_new | not))" "$manifests" >"$work/diffable.json"

if [ "$(jq '.items | length' "$work/diffable.json")" -gt 0 ]; then
  set +e
  KUBECTL_EXTERNAL_DIFF="$here/platform-diff.sh" kubectl diff --server-side \
    --field-manager="$FIELD_MANAGER" --filename "$work/diffable.json" \
    >"$work/diff.txt" 2>"$work/diff-error.txt"
  code=$?
  set -e
  if [ "$code" -gt 1 ]; then
    echo "::error::kubectl diff failed."
    "$here/redact.sh" <"$work/diff-error.txt" >&2
    exit 1
  fi
  # <group.>version.Kind.namespace.name: names and namespaces hold no dot, groups may.
  awk '{ n = split($2, p, "."); printf "%s\t%s\t%s\t%s\n", $1, p[n-2], p[n-1], p[n] }' \
    "$work/diff.txt" >>"$work/rows.tsv"
fi

changes="$(grep -c . "$work/rows.tsv" || true)"
if [ "$changes" -gt 0 ]; then
  echo "changed=true" >>"${GITHUB_OUTPUT:?}"
else
  echo "changed=false" >>"${GITHUB_OUTPUT:?}"
fi

echo "## Platform plan"
echo
echo "Commit \`${GITHUB_SHA:-unknown}\`, settings \`${SETTINGS_FILE:-}\`. The apply runs on exactly these rendered objects, with \`kubectl apply --server-side\`. Objects only change or are created: nothing is deleted, so a project taken out of the settings keeps its namespace."
echo
if [ "$changes" -eq 0 ]; then
  echo "No changes. The \`platform\` apply job does not run."
else
  echo "**${changes} object(s) to create or change.** New namespaces: ${new_namespaces[*]:-none}."
  echo
  echo "| Action | Kind | Namespace | Name |"
  echo "| --- | --- | --- | --- |"
  sort -t$'\t' -k1,1 -k2,2 -k3,3 -k4,4 "$work/rows.tsv" |
    awk -F'\t' '{ printf "| %s | %s | %s | %s |\n", $1, $2, ($3 == "" ? "(cluster)" : $3), $4 }'
fi
echo
echo "### Images in this render"
echo
jq -r '[.items[] | .spec.template.spec.containers[]?.image] | unique | .[] | "- `" + . + "`"' "$manifests"
echo
echo "Check the run watcher's rights: a Role \`run-watcher\` in each agent namespace with get, list and watch on Jobs and nothing else, and no ClusterRole or ClusterRoleBinding (D-330). If anything else grants \`run-watcher\` a right, stop and ask Didi before approving."
