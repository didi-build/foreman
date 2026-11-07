#!/usr/bin/env bash
# Fetch a short-lived admin credential for the cluster with the DigitalOcean token (D-340, O-105)
# into $RUNNER_TEMP/kubeconfig, a file only this user can read, point KUBECONFIG at it for the
# job's later steps, and mask in the job's log its token and the API server's URL, host name and
# IPv4 addresses (D-349).
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

# The API server's address never shows in the public log (D-349, O-107): mask the credential's
# server URL, its host name and each IPv4 address the host name resolves to here, before any
# kubectl call can print one in an error. None of them is printed.
server="$(kubectl config view --raw --output 'jsonpath={.clusters[0].cluster.server}')"
if [ -z "$server" ] || [[ "$server" =~ [[:space:][:cntrl:]] ]]; then
  echo "::error::The cluster credential holds no usable server address." >&2
  exit 1
fi
echo "::add-mask::$server"
host="${server#*://}"
host="${host%%/*}"
host="${host##*@}"
if [[ "$host" == \[* ]]; then
  host="${host#\[}"
  host="${host%%\]*}"
else
  host="${host%%:*}"
fi
if [ -z "$host" ]; then
  echo "::error::The cluster credential's server address holds no host name." >&2
  exit 1
fi
echo "::add-mask::$host"
if resolved="$(getent ahostsv4 "$host" 2>/dev/null)"; then
  while IFS= read -r address; do
    if [[ "$address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      echo "::add-mask::$address"
    fi
  done < <(awk '{ print $1 }' <<<"$resolved" | sort -u)
else
  echo "The cluster's host name does not resolve on this runner, so only the name and the URL are masked."
fi
echo "Short-lived cluster credential fetched; it expires after ${CREDENTIAL_SECONDS} seconds."
