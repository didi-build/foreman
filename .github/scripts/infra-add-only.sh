#!/usr/bin/env bash
# The add-only check of the saved infrastructure plan (D-378, D-444, ADR 0118 appendix B, O-158):
# whether the plan only creates new standard-size projects' DNS records and Workers routes, so
# that its apply may run in the environment `infra-add-project`, which has no reviewer. Markdown
# for the job summary on stdout. Run after `tofu init`, with the saved plan at $STACK/plan.out and
# the settings repository checked out at $PROJECTS_DIR, by the plan job and again by the add-only
# apply job, on the same saved plan.
#
#   infra-add-only.sh
#
# Exit 0: add-only. It then writes `projects=<slug>,<slug>` to $GITHUB_OUTPUT. Any other exit, a
# refusal (1, its fixed reason in the summary) or an error, means the run waits for Didi's
# approval as for any other change: the caller treats only 0 as add-only (fail closed).
#
# It reads what the plan job already reads (ADR 0110 secrets rule 5): each resource change's
# address, mode, type and actions, and each output change's name and actions, from the plan's
# JSON form through a pipe, never kept whole; and the plan's own "Plan:" line. The candidates are
# the project files with the standard size of the platform settings file and the Cloudflare
# target (add-only.mjs). EXPECTED_PROJECTS, when set, must equal what it finds.
set -euo pipefail
: "${STACK:?}" "${PROJECTS_DIR:?}" "${GITHUB_OUTPUT:?}"
settings="${SETTINGS_FILE:-infra/kubernetes/settings/production.json}"
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

if ! node "$here/add-only.mjs" candidates "$settings" "$PROJECTS_DIR" >"$work/candidates.json"; then
  refuse "the list of standard-size projects could not be read"
fi

# Addresses, modes, types and actions only, through a pipe: the JSON form is never kept.
if ! tofu -chdir="$STACK" show -json plan.out 2>/dev/null |
  jq -c '{
    resource_changes: [.resource_changes[]? | {address, mode, type, actions: .change.actions}],
    output_changes: [(.output_changes // {}) | to_entries[] | {name: .key, actions: .value.actions}]
  }' >"$work/changes.json" 2>/dev/null; then
  refuse "the plan could not be read"
fi
# The plan's own count, the one line of its text that is kept.
if ! plan_line="$(tofu -chdir="$STACK" show -no-color plan.out 2>/dev/null | grep -E '^Plan: ' | head -n 1)"; then
  refuse "the plan's own count could not be read"
fi

if ! projects="$(node "$here/add-only.mjs" infra "$work/changes.json" "$work/candidates.json" "$plan_line")"; then
  refuse "$projects"
fi
if [ -n "${EXPECTED_PROJECTS+set}" ] && [ "$projects" != "$EXPECTED_PROJECTS" ]; then
  refuse "the new projects are not those the plan job found"
fi

names="$(tr ',' '\n' <<<"$projects" | sed 's/.*/`&.didi.build`/' | paste -sd ' ' -)"
heading
echo "**Add-only:** the plan only creates the DNS record and the Workers route of ${names}, new projects with the standard size and the Cloudflare target. Nothing is changed or deleted. New projects: \`${projects}\`."
echo "projects=$projects" >>"$GITHUB_OUTPUT"
