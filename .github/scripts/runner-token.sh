#!/usr/bin/env bash
# Make the runner's cluster token and write it, with the cluster's endpoint and CA certificate,
# into Windmill's variables (first-hosting runbook step 8, D-352, D-370, O-110, O-120). The
# Platform workflow's `runner-token` job runs it right after fetching its short-lived cluster
# credential.
#
# The token: a `kubernetes.io/service-account-token` Secret for the `foreman-runner` service
# account, which the cluster fills in (Kubernetes' "Manually create a long-lived API token for a
# ServiceAccount"). No decision fixes the token's kind or lifetime, and this matches a token made
# once by hand; expiring tokens are asked in N-93. It is applied server-side under its own field
# manager, so a second run changes nothing in the cluster and writes the same token again. The
# endpoint and the CA certificate come from the credential this job holds, so no job passes them
# on (D-349).
#
# Each value is checked before it is masked, and masked before anything else can print it, so a
# value with a newline never leaves half a mask line; a value that fails its check is refused
# with fixed text and never printed. Each becomes one Windmill variable (D-370): the token a
# secret variable, which Windmill encrypts with the workspace's key, the endpoint and the CA
# certificate plain variables. For each, the script asks Windmill whether the variable exists,
# then creates it (the first run) or updates its value (every run after). The calls are made with
# the Windmill token in WINDMILL_RUNNER_RESOURCES_TOKEN (its name is D-352's), whose only scope
# is `variables:write` on exactly the three paths below. A value goes through stdin into jq, and
# the body from jq through stdin into curl; the Windmill token goes into a header file only this
# user can read, removed on exit. Neither is ever an argument. Windmill's answer is never printed,
# since it could repeat what was sent: only the status of each write, and any status but 2xx, or
# an answer to the existence check other than true or false, stops the run with fixed text.
set -euo pipefail
: "${SETTINGS_FILE:?}" "${RUNNER_TEMP:?}"

# The Kubernetes side (src/adapters/agent-runtime/kubernetes/namespace.ts).
namespace="foreman-runner"
service_account="foreman-runner"
token_secret="foreman-runner-token"
field_manager="foreman-runner-token"
# The Windmill side: the paths flows/windmill.yaml gives (O-110). The token is under its
# `secrets`, so a secret variable; the endpoint and the CA certificate are under its `values`.
token_path="f/foreman/platform/agent-cluster/runner-token"
endpoint_path="f/foreman/agent_cluster_endpoint"
ca_path="f/foreman/agent_cluster_ca_certificate"
description="Written by the Platform workflow's runner-token job (D-352). Run it again rather than editing this by hand."
# How long the cluster has to fill in the token: 30 polls, 2 seconds apart.
poll_seconds="${RUNNER_TOKEN_POLL_SECONDS:-2}"

refuse() {
  echo "::error::$1" >&2
  exit 1
}

if ! [[ "$poll_seconds" =~ ^[0-9]+$ ]]; then
  refuse "RUNNER_TOKEN_POLL_SECONDS must be a whole number of seconds."
fi

# The Windmill token: masked first. A space, newline or control character would break the header.
windmill_token="${WINDMILL_RUNNER_RESOURCES_TOKEN:-}"
if [ -z "$windmill_token" ]; then
  refuse "WINDMILL_RUNNER_RESOURCES_TOKEN is not set in the platform environment (first-hosting runbook step 8)."
fi
if [[ "$windmill_token" =~ [[:space:][:cntrl:]] ]]; then
  refuse "WINDMILL_RUNNER_RESOURCES_TOKEN holds a space, a newline or a control character: paste it again."
fi
echo "::add-mask::$windmill_token"

# The Windmill host and workspace: the settings file's own, checked as the services check them
# (parseWindmillHost and parseWindmillWorkspace in src/adapters/windmill/client.ts).
host="$(jq -r '.platform.windmill.host // ""' "$SETTINGS_FILE")"
workspace="$(jq -r '.platform.windmill.workspace // ""' "$SETTINGS_FILE")"
label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
if [ "${#host}" -gt 253 ] || ! [[ "$host" =~ ^($label\.)+$label$ ]] || [[ "${host##*.}" =~ ^[0-9]+$ ]]; then
  refuse "windmill.host in the settings file is not a plain host name (first-hosting runbook step 7)."
fi
if ! [[ "$workspace" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$ ]]; then
  refuse "windmill.workspace in the settings file is not a workspace id (first-hosting runbook step 7)."
fi

# The endpoint, as the runner reads it: https://host[:port] and nothing else. Masked before any
# other kubectl call, as cluster-credential.sh already did in this job (O-107).
endpoint="$(kubectl config view --raw --output 'jsonpath={.clusters[0].cluster.server}')"
if ! [[ "$endpoint" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]; then
  refuse "The cluster credential's server address is not https://host[:port], as the runner reads it."
fi
echo "::add-mask::$endpoint"

umask 077
work="$(mktemp -d "$RUNNER_TEMP/runner-token.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The CA certificate in PEM, as the runner reads it. Not secret, and never printed.
kubectl config view --raw --output 'jsonpath={.clusters[0].cluster.certificate-authority-data}' |
  base64 --decode >"$work/ca.pem"
if [ "$(head -n 1 "$work/ca.pem")" != "-----BEGIN CERTIFICATE-----" ] ||
  [ "$(tail -n 1 "$work/ca.pem")" != "-----END CERTIFICATE-----" ]; then
  refuse "The cluster credential holds no CA certificate in PEM."
fi

# The token, from a Secret the cluster fills in for the runner's service account.
if ! kubectl get serviceaccount "$service_account" --namespace "$namespace" --output name >/dev/null; then
  refuse "The service account $namespace/$service_account is not there: apply the platform objects first (first-hosting runbook step 7)."
fi
kubectl apply --server-side --field-manager="$field_manager" --filename - >/dev/null <<EOF
{
  "apiVersion": "v1",
  "kind": "Secret",
  "metadata": {
    "name": "$token_secret",
    "namespace": "$namespace",
    "annotations": { "kubernetes.io/service-account.name": "$service_account" }
  },
  "type": "kubernetes.io/service-account-token"
}
EOF
token=""
for _ in $(seq 1 30); do
  token="$(kubectl get secret "$token_secret" --namespace "$namespace" --output 'jsonpath={.data.token}' | base64 --decode)"
  if [ -n "$token" ]; then
    break
  fi
  sleep "$poll_seconds"
done
if [ -z "$token" ]; then
  refuse "The cluster did not fill in the Secret $namespace/$token_secret with a token in time. Run the job again."
fi
# A service account token is a JSON Web Token: three base64url parts and two dots.
if ! [[ "$token" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
  refuse "The Secret $namespace/$token_secret holds no usable token."
fi
echo "::add-mask::$token"

printf 'Authorization: Bearer %s\n' "$windmill_token" >"$work/headers"
api="https://$host/api/w/$workspace/variables"

# One variable, its value read from stdin, secret or not as the second argument says (true or
# false). Windmill's create refuses a path that exists and its update one that does not, so the
# script asks first: `exists` answers true or false. Windmill's route check lets any token with a
# variables scope ask it, for any path (that check is blind to paths, and write includes read),
# and the handler adds no check of its own; it tells only whether a path exists. The answer
# file is emptied first, so an earlier path's answer is never read again.
write_variable() {
  local path="$1" is_secret="$2" status body url done_text
  : >"$work/exists"
  if ! status="$(
    curl --silent --show-error --proto '=https' --max-time 30 \
      --header @"$work/headers" \
      --output "$work/exists" \
      --write-out '%{http_code}' \
      "$api/exists/$path" </dev/null
  )"; then
    refuse "Windmill could not be reached to check $path (curl's own error is above; it shows no value)."
  fi
  if ! [[ "$status" =~ ^2[0-9]{2}$ ]]; then
    if ! [[ "$status" =~ ^[0-9]{3}$ ]]; then
      status="none"
    fi
    refuse "Windmill refused checking $path (HTTP status $status). Its answer is not shown. A 401 or 403 means the token is wrong, expired or not limited to these paths (first-hosting runbook step 8)."
  fi
  case "$(cat "$work/exists")" in
    false)
      url="$api/create"
      body='{path: $path, value: ., is_secret: $is_secret, description: $description}'
      done_text="Created"
      ;;
    true)
      url="$api/update/$path"
      body='{value: ., is_secret: $is_secret, description: $description}'
      done_text="Updated"
      ;;
    *)
      refuse "Windmill's answer to checking $path is neither true nor false. It is not shown."
      ;;
  esac
  if ! status="$(
    jq --raw-input --slurp --compact-output \
      --arg path "$path" --argjson is_secret "$is_secret" --arg description "$description" \
      "$body" |
      curl --silent --show-error --proto '=https' --max-time 30 \
        --request POST \
        --header @"$work/headers" \
        --header 'Content-Type: application/json' \
        --data-binary @- \
        --output /dev/null \
        --write-out '%{http_code}' \
        "$url"
  )"; then
    refuse "Windmill could not be reached to write $path (curl's own error is above; it shows no value)."
  fi
  if ! [[ "$status" =~ ^2[0-9]{2}$ ]]; then
    if ! [[ "$status" =~ ^[0-9]{3}$ ]]; then
      status="none"
    fi
    refuse "Windmill refused writing $path (HTTP status $status). Its answer is not shown, since it could repeat what was sent. A 401 or 403 means the token is wrong, expired or not limited to these paths (first-hosting runbook step 8)."
  fi
  echo "$done_text $path in Windmill (HTTP status $status)."
}

printf '%s' "$token" | write_variable "$token_path" true
printf '%s' "$endpoint" | write_variable "$endpoint_path" false
write_variable "$ca_path" false <"$work/ca.pem"
echo "The runner's cluster token, the cluster's endpoint and its CA certificate are in Windmill."
