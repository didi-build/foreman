#!/usr/bin/env bash
# The add-only check of the Platform plan (D-378, D-444, ADR 0118 appendix B, O-158): whether
# applying the rendered objects only adds standard-size projects, so that the apply may run in
# the environment `platform-add-project`, which has no reviewer. Markdown for the job summary on
# stdout.
#
#   platform-add-only.sh <rendered manifests JSON> <candidates JSON>
#
# Exit 0: add-only. It then writes `projects=<slug>,<slug>` to $GITHUB_OUTPUT. Any other exit, a
# refusal (1, its fixed reason in the summary) or an error, means the run waits for Didi's
# approval as for any other change: the caller treats only 0 as add-only (fail closed).
#
# The steps (the decisions are in add-only.mjs, Node's built-ins only):
# 1. The new namespaces: those of the render the cluster lacks, as platform-plan.sh finds them.
# 2. Each must be a candidate's (the render job's list of standard-size, Cloudflare-target
#    projects), one to three, and hold exactly the objects of a standard-size project already
#    rendered, with only its namespace and project label changed. The base list is the render
#    without them, and with the run watcher's AGENT_NAMESPACES as it was before them.
# 3. `kubectl diff --server-side` of the base list must find no change at all: the cluster matches
#    main and the existing projects exactly, with no pending image and no drift.
# 4. The rest of the render (without the new namespaces' objects, whose namespace does not exist
#    yet, so they can only be created) must change exactly the run watcher's Deployment.
# EXPECTED_PROJECTS, when set (the add-only apply's second check), must equal what it finds.
#
# It reads names only: platform-diff.sh prints none of an object's content, and no diff or
# kubectl error reaches the summary (the log gets kubectl's errors redacted).
set -euo pipefail
manifests="${1:?the rendered manifests}"
candidates="${2:?the candidates}"
: "${FIELD_MANAGER:?}" "${GITHUB_OUTPUT:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

heading() {
  echo "## Add-only check (D-378)"
  echo
}

refuse() {
  heading
  echo "**Not add-only:** ${1:-the add-only check did not finish}. The reviewed apply waits for Didi's approval, as for any other change."
  exit 1
}

[ -f "$candidates" ] || refuse "the render's list of standard-size projects is missing"

# 1. The namespaces the cluster lacks. A failed read is a doubt, never a missing namespace.
: >"$work/new.txt"
while IFS= read -r ns; do
  [ -n "$ns" ] || continue
  if ! found="$(kubectl get namespace "$ns" --ignore-not-found --output name 2>/dev/null)"; then
    refuse "a namespace could not be read on the cluster"
  fi
  [ -n "$found" ] || printf '%s\n' "$ns" >>"$work/new.txt"
done < <(jq -r '.items[] | select(.kind == "Namespace") | .metadata.name' "$manifests")

# 2. The lists.
if ! projects="$(node "$here/add-only.mjs" platform-lists "$manifests" "$candidates" "$work")"; then
  refuse "$projects"
fi

# 3 and 4. The diffs, by name only.
diff_names() {
  local list="$1" out="$2" code
  set +e
  KUBECTL_EXTERNAL_DIFF="$here/platform-diff.sh" kubectl diff --server-side \
    --field-manager="$FIELD_MANAGER" --filename "$list" >"$out" 2>"$work/diff-error.txt"
  code=$?
  set -e
  if [ "$code" -gt 1 ]; then
    "$here/redact.sh" <"$work/diff-error.txt" >&2
    refuse "kubectl diff failed"
  fi
}
diff_names "$work/base.json" "$work/base-diff.txt"
diff_names "$work/rest.json" "$work/rest-diff.txt"

if ! projects="$(node "$here/add-only.mjs" platform-verdict "$work")"; then
  refuse "$projects"
fi
if [ -n "${EXPECTED_PROJECTS+set}" ] && [ "$projects" != "$EXPECTED_PROJECTS" ]; then
  refuse "the new projects are not those the plan found, so the cluster changed since the plan"
fi

namespaces="$(tr ',' '\n' <<<"$projects" | sed 's/^/`agents-/; s/$/`/' | paste -sd ' ' -)"
heading
echo "**Add-only:** the plan only adds the standard objects of ${namespaces}, and the run watcher's namespace list gains them (its Deployment restarts). The cluster matches main and the existing projects exactly. New projects: \`${projects}\`."
echo "projects=$projects" >>"$GITHUB_OUTPUT"
