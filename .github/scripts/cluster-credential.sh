#!/usr/bin/env bash
# Fetch a short-lived admin credential for the cluster with the DigitalOcean token (D-340, O-105)
# into $RUNNER_TEMP/kubeconfig, a file only this user can read, point KUBECONFIG at it for the
# job's later steps, and mask its token in the job's log.
#
# doctl's `--expiry-seconds` takes any whole number of seconds above 0 (doctl 1.186.0 and its API
# client set no minimum, and DigitalOcean's API documents none). The job passes its own time limit
# (CREDENTIAL_SECONDS = timeout-minutes x 60), so the credential cannot outlive the longest the
# job may run by more than its setup steps. The job removes the file at its end, and GitHub
# discards the runner. Nothing long-lived is kept for cluster access.
set -euo pipefail
: "${DIGITALOCEAN_ACCESS_TOKEN:?is not set in this environment}"
: "${CLUSTER_NAME:?}" "${CREDENTIAL_SECONDS:?}"
if ! [[ "$CREDENTIAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::CREDENTIAL_SECONDS must be a whole number of seconds." >&2
  exit 1
fi

export KUBECONFIG="${RUNNER_TEMP:?}/kubeconfig"
echo "KUBECONFIG=$KUBECONFIG" >>"${GITHUB_ENV:?}"
umask 077
doctl kubernetes cluster kubeconfig show "$CLUSTER_NAME" \
  --expiry-seconds "$CREDENTIAL_SECONDS" >"$KUBECONFIG"

token="$(kubectl config view --raw --output 'jsonpath={.users[0].user.token}')"
if [ -z "$token" ]; then
  echo "::error::The cluster credential holds no token." >&2
  exit 1
fi
echo "::add-mask::$token"
echo "Short-lived cluster credential fetched; it expires after ${CREDENTIAL_SECONDS} seconds."
