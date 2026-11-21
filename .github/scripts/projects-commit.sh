#!/usr/bin/env bash
# The settings repository's commit for this run (D-377, D-442, ADR 0118 appendix A, O-157). The
# project list lives in didi-build/foreman-projects, which is public, so its main is read with
# `git ls-remote` and no token. The run uses main's head, never an older commit, so an older list
# is never applied after a newer one. PROJECTS_COMMIT, the optional `projects_commit` input of a
# run started by hand (later, the commit the New project form's file write made), must be that
# head or one of its ancestors: a commit main does not contain stops the run, and so does a value
# that is not a full commit id.
#
#   projects-commit.sh <repository URL>
#
# Sets `commit=<sha>` in $GITHUB_OUTPUT, and names the commit in the job summary when there is
# one. PROJECTS_REPOSITORY is the `owner/name` the summary shows. No credential is used or kept:
# the checkout that follows reads the same commit with `persist-credentials: false`.
set -euo pipefail
url="${1:?the settings repository URL}"
: "${PROJECTS_REPOSITORY:?}" "${GITHUB_OUTPUT:?}"
requested="${PROJECTS_COMMIT:-}"
# A repository that does not exist answers with a sign-in prompt; never wait for one.
export GIT_TERMINAL_PROMPT=0

if ! refs="$(git ls-remote --exit-code "$url" refs/heads/main 2>/dev/null)"; then
  echo "::error::The main branch of $PROJECTS_REPOSITORY could not be read."
  exit 1
fi
head="$(printf '%s\n' "$refs" | awk '$2 == "refs/heads/main" { print $1 }')"
if ! [[ "$head" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::The main branch of $PROJECTS_REPOSITORY did not resolve to one commit."
  exit 1
fi

if [ -n "$requested" ]; then
  if ! [[ "$requested" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::The projects_commit input must be a full commit id: 40 lowercase hexadecimal characters."
    exit 1
  fi
  if [ "$requested" != "$head" ]; then
    # Main's history, into a throwaway repository: the list holds small files only. No filter,
    # so asking about a commit main does not hold never reaches back to the server.
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    git -c init.defaultBranch=main init --quiet "$work"
    if ! git -C "$work" fetch --quiet --no-tags "$url" refs/heads/main 2>/dev/null; then
      echo "::error::The history of $PROJECTS_REPOSITORY's main could not be read."
      exit 1
    fi
    if ! git -C "$work" merge-base --is-ancestor "$requested" "$head" 2>/dev/null; then
      echo "::error::The projects_commit input is not main's head of $PROJECTS_REPOSITORY or one of its ancestors: nothing was planned."
      exit 1
    fi
  fi
fi

echo "commit=$head" >>"$GITHUB_OUTPUT"
echo "The project list is $PROJECTS_REPOSITORY at $head, its main when this run started."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Project list"
    echo
    echo "\`$PROJECTS_REPOSITORY\` at commit \`$head\`, its main when this run started (D-377)."
    if [ -n "$requested" ]; then
      echo "It contains the commit \`$requested\` this run was started with."
    fi
    echo
  } >>"$GITHUB_STEP_SUMMARY"
fi
