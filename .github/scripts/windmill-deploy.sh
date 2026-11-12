#!/usr/bin/env bash
# Upload the bundle job's scripts, schedules and plain values to Windmill (D-371, O-123). The
# Windmill deploy workflow's `deploy` job runs it once Didi approves, with the folder the bundle
# job uploaded (its manifest.json and bundles/<name>.js):
#
#   windmill-deploy.sh <folder>
#
# Only protected code touches the token: this script uses bash, coreutils, jq and curl, and the
# job runs nothing of the repository's but `.github/`. The manifest comes from a job that runs
# the repository's TypeScript, which a bot can change, so it is checked strictly before any call
# and only fixed fields of it reach Windmill: each script path is `f/foreman/<name>`; each
# script's job token scopes are on this script's own list; each schedule runs a script of the
# manifest at its own path; each value is one of the exact names below, always written as a plain
# variable, never a secret one; the keys are fixed and the sizes bounded; each bundle's sha256 and
# size are what the manifest says. Anything else stops the run with fixed text, before any call.
#
# Then, in this order, with the token in WINDMILL_DEPLOY_TOKEN (scopes `scripts:write:f/foreman/*`,
# `schedules:write:f/foreman/*` and `variables:write` on the exact value paths, first-hosting
# runbook step 15), each call as Windmill's source (version 1.865.0) answers it:
#
#   - each script: one `POST .../scripts/create_snapshot?skip_if_noop=true`, multipart, its JSON
#     first and then its bundle, as a Bun codebase (`codebase` the bundle's sha256, which runs on
#     Node as CommonJS) with `auto_parent`, so the first run creates it and a later one adds a
#     version on top of the current one (Windmill Cloud adds one even when nothing changed, O-123);
#   - each schedule: `GET .../schedules/exists/<path>`, then `POST .../schedules/create` (enabled)
#     or `POST .../schedules/update/<path>` (which leaves a schedule Didi paused paused);
#   - each value: `GET .../variables/exists/<path>`, then `POST .../variables/create` or
#     `POST .../variables/update/<path>`, as runner-token.sh does.
#
# The token goes into a header file only this user can read, removed on exit, and is never an
# argument. Every body is a file or stdin. Windmill's answer is never printed: the log and the
# report name each path and its status only, and any status but 2xx, no answer, or an existence
# answer other than true or false stops the run with fixed text. Nothing is ever deleted.
set -euo pipefail
: "${SETTINGS_FILE:?}" "${RUNNER_TEMP:?}"
dir="${1:?the folder the bundle job uploaded}"

# The plain values this deploy writes, and nothing else (D-371, flows/windmill.yaml `values`
# without `written_by`). The token can write only these paths; none is a secret variable.
value_names=(
  spec_version
  github_developer_app_login
  github_designer_app_login
  github_runner_app_slug
  agent_run_settings
  agent_images
)
# The job token scopes a script may carry (D-371, O-121): reading the folder's variables, and on
# the reconcile flow only, the workspace's execution count.
every_script_scope='variables:read:f/foreman/*'
reconcile_only_scope='workspaces:read'
reconcile_path='f/foreman/reconcile'
description="Written by the Windmill deploy workflow (D-371). Change flows/windmill.yaml and its settings in a pull request rather than editing this by hand."
# Bounds: a bundle is about 1 MB (O-121), a value at most what a Windmill variable holds.
max_scripts=32
max_schedules=8
max_bundle_bytes=16777216
max_content_bytes=65536
max_value_bytes=15000
max_manifest_bytes=4194304

report() {
  if [ -n "${REPORT:-}" ]; then
    printf '%s\n' "$1" >>"$REPORT"
  fi
}

refuse() {
  echo "::error::$1" >&2
  report ""
  report "Stopped: $1"
  exit 1
}

if [ -n "${REPORT:-}" ]; then
  : >"$REPORT"
fi
report "## Windmill deploy"
report ""

# The token: masked first. A space, newline or control character would break the header.
token="${WINDMILL_DEPLOY_TOKEN:-}"
if [ -z "$token" ]; then
  refuse "WINDMILL_DEPLOY_TOKEN is not set in the windmill environment (first-hosting runbook step 15)."
fi
if [[ "$token" =~ [[:space:][:cntrl:]] ]]; then
  refuse "WINDMILL_DEPLOY_TOKEN holds a space, a newline or a control character: paste it again."
fi
echo "::add-mask::$token"

# The Windmill host and workspace: the settings file's own, checked as runner-token.sh checks them.
host="$(jq -r '.platform.windmill.host // ""' "$SETTINGS_FILE")"
workspace="$(jq -r '.platform.windmill.workspace // ""' "$SETTINGS_FILE")"
label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
if [ "${#host}" -gt 253 ] || ! [[ "$host" =~ ^($label\.)+$label$ ]] || [[ "${host##*.}" =~ ^[0-9]+$ ]]; then
  refuse "windmill.host in the settings file is not a plain host name (first-hosting runbook step 7)."
fi
if ! [[ "$workspace" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$ ]]; then
  refuse "windmill.workspace in the settings file is not a workspace id (first-hosting runbook step 7)."
fi

# The folder and the manifest: plain files, the manifest bounded and checked before anything else.
# The folder's path goes into curl's form arguments, where `;`, `,` and `"` have a meaning.
if ! [[ "$dir" =~ ^[A-Za-z0-9/._-]+$ ]] || [ ! -d "$dir" ] || [ -L "$dir" ]; then
  refuse "The bundle job's folder is not a plain folder."
fi
manifest="$dir/manifest.json"
if [ ! -f "$manifest" ] || [ -L "$manifest" ]; then
  refuse "The bundle job's manifest is missing."
fi
if [ "$(stat -c %s "$manifest")" -gt "$max_manifest_bytes" ]; then
  refuse "The bundle job's manifest is larger than $max_manifest_bytes bytes."
fi
value_list="$(printf '%s\n' "${value_names[@]}" | jq -R . | jq -sc .)"

# One jq program checks the whole manifest and prints `ok` or the first fault, in fixed words
# that name a field and never repeat what it holds.
checks='
  def bytes: utf8bytelength;
  def text($max): type == "string" and length > 0 and bytes <= $max;
  def keys_are($k): type == "object" and (keys == ($k | sort));
  def unique_by_field($f): (map(.[$f]) | length) == (map(.[$f]) | unique | length);
  . as $m
  | [
      (if ($m | keys_are(["commit", "schedules", "scripts", "values", "version"])) then empty
       else "the manifest does not hold exactly commit, schedules, scripts, values and version" end),
      (if $m.version == 1 then empty else "the manifest is not version 1" end),
      (if ($m.commit | type == "string" and test("^[0-9a-f]{40}$")) then empty
       else "the manifest'"'"'s commit is not a full commit id" end),
      (if ($m.scripts | type == "array" and length > 0 and length <= $max_scripts) then empty
       else "the manifest does not list between 1 and \($max_scripts) scripts" end),
      (if ($m.schedules | type == "array" and length <= $max_schedules) then empty
       else "the manifest lists more than \($max_schedules) schedules" end),
      (if ($m.values | type == "array" and length <= ($value_names | length)) then empty
       else "the manifest lists more values than this script writes" end)
    ] as $top
  | if ($top | length) > 0 then $top[0]
    else
      ($m.scripts | map(.path)) as $script_paths
      | [
          ($m.scripts | to_entries[] | .key as $i | .value as $s
            | if ($s | keys_are(["content", "job_token_scopes", "path", "sha256", "size"]) | not) then
                "scripts[\($i)] does not hold exactly content, job_token_scopes, path, sha256 and size"
              elif ($s.path | type == "string" and test("^f/foreman/[a-z_]{1,64}$") | not) then
                "scripts[\($i)].path is not f/foreman/ followed by lowercase letters and underscores"
              elif ($s.content | text($max_content_bytes) | not) then
                "scripts[\($i)].content is empty, not text or larger than \($max_content_bytes) bytes"
              elif ($s.sha256 | type == "string" and test("^[0-9a-f]{64}$") | not) then
                "scripts[\($i)].sha256 is not a sha256"
              elif ($s.size | type == "number" and . == floor and . > 0 and . <= $max_bundle_bytes | not) then
                "scripts[\($i)].size is not a size from 1 to \($max_bundle_bytes) bytes"
              elif ($s.job_token_scopes | type == "array" and length > 0 and all(.[]; type == "string") | not) then
                "scripts[\($i)].job_token_scopes is not a list of scopes"
              elif ($s.job_token_scopes | (unique | length) != length) then
                "scripts[\($i)].job_token_scopes names a scope twice"
              elif ($s.job_token_scopes | index([$every_scope]) == null) then
                "scripts[\($i)].job_token_scopes does not read the folder'"'"'s variables"
              elif ($s.job_token_scopes | all(.[]; . == $every_scope or (. == $reconcile_scope and $s.path == $reconcile_path)) | not) then
                "scripts[\($i)].job_token_scopes holds a scope this script does not allow there"
              else empty end),
          (if ($m.scripts | unique_by_field("path")) then empty else "the manifest names a script path twice" end),
          ($m.schedules | to_entries[] | .key as $i | .value as $s
            | if ($s | keys_are(["path", "schedule", "script_path", "timezone"]) | not) then
                "schedules[\($i)] does not hold exactly path, schedule, script_path and timezone"
              elif ($s.path | type == "string" and test("^f/foreman/[a-z_]{1,64}$") | not) then
                "schedules[\($i)].path is not f/foreman/ followed by lowercase letters and underscores"
              elif ($s.script_path != $s.path) or ($script_paths | index([$s.path]) == null) then
                "schedules[\($i)] does not run the manifest'"'"'s script at its own path"
              elif ($s.schedule | type == "string" and test("^[0-9*/,-]{1,20}( [0-9*/,-]{1,20}){5}$") | not) then
                "schedules[\($i)].schedule is not a cron expression of six fields"
              elif ($s.timezone | type == "string" and test("^[A-Za-z]{1,32}(/[A-Za-z0-9_+-]{1,32}){0,2}$") | not) then
                "schedules[\($i)].timezone is not a time zone name"
              else empty end),
          (if ($m.schedules | unique_by_field("path")) then empty else "the manifest names a schedule twice" end),
          ($m.values | to_entries[] | .key as $i | .value as $v
            | if ($v | keys_are(["name", "value"]) | not) then
                "values[\($i)] does not hold exactly name and value"
              elif ($v.name | type == "string" and ($value_names | index([$v.name]) != null) | not) then
                "values[\($i)].name is not one of the plain values this script writes"
              elif ($v.value | text($max_value_bytes) | not) then
                "values[\($i)].value is empty, not text or larger than \($max_value_bytes) bytes"
              else empty end),
          (if ($m.values | unique_by_field("name")) then empty else "the manifest names a value twice" end)
        ]
      | if length > 0 then .[0] else "ok" end
    end
'
if ! verdict="$(
  jq -r \
    --argjson max_scripts "$max_scripts" --argjson max_schedules "$max_schedules" \
    --argjson max_bundle_bytes "$max_bundle_bytes" --argjson max_content_bytes "$max_content_bytes" \
    --argjson max_value_bytes "$max_value_bytes" --argjson value_names "$value_list" \
    --arg every_scope "$every_script_scope" --arg reconcile_scope "$reconcile_only_scope" \
    --arg reconcile_path "$reconcile_path" \
    "$checks" "$manifest" 2>/dev/null
)"; then
  refuse "The bundle job's manifest is not JSON of the expected shape."
fi
if [ "$verdict" != "ok" ]; then
  # The verdict is one of the fixed texts above: it names a field and holds no manifest text.
  refuse "The bundle job's manifest is refused: $verdict."
fi

# Each bundle: a plain file at bundles/<name>.js with the size and sha256 the manifest gives.
script_count="$(jq '.scripts | length' "$manifest")"
for ((i = 0; i < script_count; i++)); do
  path="$(jq -r --argjson i "$i" '.scripts[$i].path' "$manifest")"
  name="${path#f/foreman/}"
  bundle="$dir/bundles/$name.js"
  if [ ! -f "$bundle" ] || [ -L "$bundle" ]; then
    refuse "The bundle of $path is missing."
  fi
  if [ "$(stat -c %s "$bundle")" != "$(jq -r --argjson i "$i" '.scripts[$i].size' "$manifest")" ] ||
    [ "$(sha256sum "$bundle" | cut -d' ' -f1)" != "$(jq -r --argjson i "$i" '.scripts[$i].sha256' "$manifest")" ]; then
    refuse "The bundle of $path is not the one the manifest names (its size or sha256 differs)."
  fi
done

umask 077
work="$(mktemp -d "$RUNNER_TEMP/windmill-deploy.XXXXXX")"
trap 'rm -rf "$work"' EXIT
printf 'Authorization: Bearer %s\n' "$token" >"$work/headers"
api="https://$host/api/w/$workspace"
commit="$(jq -r '.commit' "$manifest")"

# Any status but 2xx stops the run; Windmill's answer is never shown, since it could repeat what
# was sent.
check_status() {
  local status="$1" what="$2"
  if ! [[ "$status" =~ ^2[0-9]{2}$ ]]; then
    if ! [[ "$status" =~ ^[0-9]{3}$ ]]; then
      status="none"
    fi
    refuse "Windmill refused $what (HTTP status $status). Its answer is not shown. A 401 or 403 means the token is wrong, expired or not limited to these paths (first-hosting runbook step 15)."
  fi
}

# Asks whether a schedule or variable exists: `exists` answers true or false. The answer file is
# emptied first, so an earlier path's answer is never read again.
exists() {
  local kind="$1" path="$2" status
  : >"$work/exists"
  if ! status="$(
    curl --silent --show-error --proto '=https' --max-time 30 \
      --header @"$work/headers" \
      --output "$work/exists" \
      --write-out '%{http_code}' \
      "$api/$kind/exists/$path" </dev/null
  )"; then
    refuse "Windmill could not be reached to check $path (curl's own error is above; it shows no value)."
  fi
  check_status "$status" "checking $path"
  case "$(cat "$work/exists")" in
    true | false) cat "$work/exists" ;;
    *) refuse "Windmill's answer to checking $path is neither true nor false. It is not shown." ;;
  esac
}

# One JSON body from stdin to Windmill; prints the status.
post_json() {
  local url="$1" what="$2" status
  if ! status="$(
    curl --silent --show-error --proto '=https' --max-time 30 \
      --request POST \
      --header @"$work/headers" \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      --output /dev/null \
      --write-out '%{http_code}' \
      "$url"
  )"; then
    refuse "Windmill could not be reached to write $what (curl's own error is above; it shows no value)."
  fi
  check_status "$status" "writing $what"
  printf '%s' "$status"
}

# The scripts: each as a codebase script, its JSON first and then its bundle (the order
# `create_snapshot` requires). Only fixed fields go into the JSON: no lock, schema, worker tag,
# identity or any other setting, so Windmill infers the form from `main` and keeps nothing else.
for ((i = 0; i < script_count; i++)); do
  path="$(jq -r --argjson i "$i" '.scripts[$i].path' "$manifest")"
  name="${path#f/foreman/}"
  jq -c --argjson i "$i" --arg description "$description" --arg commit "$commit" '
    .scripts[$i] as $s
    | {
        path: $s.path,
        summary: ($s.path | ltrimstr("f/foreman/")),
        description: $description,
        content: $s.content,
        language: "bun",
        codebase: $s.sha256,
        auto_parent: true,
        job_token_scopes: $s.job_token_scopes,
        deployment_message: "Windmill deploy workflow, commit \($commit)"
      }' "$manifest" >"$work/script.json"
  if ! status="$(
    curl --silent --show-error --proto '=https' --max-time 120 \
      --request POST \
      --header @"$work/headers" \
      --form "script=<$work/script.json;type=application/json" \
      --form "file=@$dir/bundles/$name.js;type=application/javascript" \
      --output /dev/null \
      --write-out '%{http_code}' \
      "$api/scripts/create_snapshot?skip_if_noop=true" </dev/null
  )"; then
    refuse "Windmill could not be reached to deploy $path (curl's own error is above; it shows no value)."
  fi
  check_status "$status" "deploying $path"
  echo "Deployed script $path in Windmill (HTTP status $status)."
  report "- Deployed script \`$path\` (HTTP status $status)."
done

# The schedules: created enabled; an update changes its cron and time zone, never whether it runs.
schedule_count="$(jq '.schedules | length' "$manifest")"
for ((i = 0; i < schedule_count; i++)); do
  path="$(jq -r --argjson i "$i" '.schedules[$i].path' "$manifest")"
  # Assigned first, so a refusal inside the check stops the run (set -e).
  present="$(exists schedules "$path")"
  if [ "$present" = "false" ]; then
    url="$api/schedules/create"
    body='{path: $s.path, schedule: $s.schedule, timezone: $s.timezone, script_path: $s.script_path, is_flow: false, args: {}, enabled: true, cron_version: "v2", description: $description}'
    done_text="Created"
  else
    url="$api/schedules/update/$path"
    body='{schedule: $s.schedule, timezone: $s.timezone, args: {}, cron_version: "v2", description: $description}'
    done_text="Updated"
  fi
  status="$(
    jq -c --argjson i "$i" --arg description "$description" ".schedules[\$i] as \$s | $body" "$manifest" |
      post_json "$url" "$path"
  )"
  echo "$done_text schedule $path in Windmill (HTTP status $status)."
  report "- $done_text schedule \`$path\` (HTTP status $status)."
done

# The plain values: each `is_secret` false, on create and on update.
value_count="$(jq '.values | length' "$manifest")"
for ((i = 0; i < value_count; i++)); do
  name="$(jq -r --argjson i "$i" '.values[$i].name' "$manifest")"
  path="f/foreman/$name"
  present="$(exists variables "$path")"
  if [ "$present" = "false" ]; then
    url="$api/variables/create"
    body='{path: $path, value: $v.value, is_secret: false, description: $description}'
    done_text="Created"
  else
    url="$api/variables/update/$path"
    body='{value: $v.value, is_secret: false, description: $description}'
    done_text="Updated"
  fi
  status="$(
    jq -c --argjson i "$i" --arg path "$path" --arg description "$description" ".values[\$i] as \$v | $body" "$manifest" |
      post_json "$url" "$path"
  )"
  echo "$done_text variable $path in Windmill (HTTP status $status)."
  report "- $done_text variable \`$path\` (HTTP status $status)."
done

echo "Every script, schedule and plain value in the manifest is in Windmill."
report ""
report "Every script, schedule and plain value in the manifest of commit \`$commit\` is in Windmill."
