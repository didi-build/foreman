#!/usr/bin/env bash
# Build and push the nine images first hosting needs (D-336, O-105, O-124, D-432) to GitHub
# Container Registry as public images, each tagged with the commit, and write their references
# pinned by digest: a Markdown table on stdout for the job summary, and <images.json> in the shapes
# the settings take (the cluster's settings file and Windmill's `agent_images` and
# `agent_run_settings`). The weekly test job's image (`foreman-eval`, ADR 0117) is in `images`
# only: no setting takes it yet, and the slice that starts its Job pins it.
#
#   build-images.sh <images.json>
#
# An image holds only code, never a secret (D-336): no build argument and no build secret is
# passed, and test/admin-workflows.test.ts checks each Dockerfile declares neither. Not built: the
# Claude Code agent image (a fallback no bot file dispatches, D-222) and the sample service (the
# ADR 0111 reference, never deployed). CI's container checks still build both.
set -euo pipefail
out="${1:?the images file to write}"
: "${REGISTRY:?}" "${COMMIT:?}" "${SOURCE_URL:?}"
if ! [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::COMMIT must be a full commit id." >&2
  exit 1
fi

#        image name                 Dockerfile
IMAGES=(
  "foreman-agent-opencode     src/agent-images/opencode/Dockerfile"
  "foreman-agent-claude-api   src/agent-images/claude-api/Dockerfile"
  "foreman-repo-map           src/agent-images/repo-map/Dockerfile"
  "foreman-qa-fetch           src/agent-images/qa-fetch/Dockerfile"
  "foreman-eval               src/agent-images/eval/Dockerfile"
  "foreman-egress-proxy       src/egress-proxy/Dockerfile"
  "foreman-state-api          src/api/Dockerfile"
  "foreman-github-receiver    src/github-receiver/Dockerfile"
  "foreman-run-watcher        src/run-watcher/Dockerfile"
)

# GitHub's registry now and then refuses a push partway, for example with "unknown blob" while it
# mounts a layer that another image shares (the Images run of 2026-11-18). Each push is tried up
# to three times, 10 and then 30 seconds apart, so a passing hiccup does not fail the job; one that
# lasts through all three tries still does.
push_image() {
  local ref="$1" attempt wait
  for attempt in 1 2 3; do
    if docker push "$ref" >&2; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      if [ "$attempt" -eq 1 ]; then wait=10; else wait=30; fi
      echo "::warning::Pushing $ref failed (try $attempt of 3); trying again in $wait seconds." >&2
      sleep "$wait"
    fi
  done
  echo "::error::Pushing $ref failed three times." >&2
  return 1
}

refs='{}'
for entry in "${IMAGES[@]}"; do
  read -r name dockerfile <<<"$entry"
  image="$REGISTRY/$name"
  echo "::group::$name" >&2
  docker build --file "$dockerfile" --platform linux/amd64 \
    --label "org.opencontainers.image.source=$SOURCE_URL" \
    --label "org.opencontainers.image.revision=$COMMIT" \
    --tag "$image:$COMMIT" . >&2
  push_image "$image:$COMMIT"
  # The digest as the registry serves it, which is what the cluster pulls.
  digest="$(docker buildx imagetools inspect "$image:$COMMIT" --format '{{json .Manifest}}' | jq -r '.digest')"
  echo "::endgroup::" >&2
  if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::The registry gave no digest for $name." >&2
    exit 1
  fi
  refs="$(jq -c --arg name "$name" --arg ref "$image@$digest" '. + {($name): $ref}' <<<"$refs")"
done

jq -n --arg commit "$COMMIT" --argjson r "$refs" '{
  commit: $commit,
  images: $r,
  settingsFile: { platform: { images: {
    stateApi: $r["foreman-state-api"],
    receiver: $r["foreman-github-receiver"],
    egressProxy: $r["foreman-egress-proxy"],
    runWatcher: $r["foreman-run-watcher"]
  } } },
  windmill: {
    agent_images: { opencode: $r["foreman-agent-opencode"], "claude-api": $r["foreman-agent-claude-api"] },
    agent_run_settings: {
      proxyImage: $r["foreman-egress-proxy"],
      fetchImage: $r["foreman-qa-fetch"],
      repoMapImage: $r["foreman-repo-map"]
    }
  }
}' >"$out"

echo "## Images"
echo
echo "Built from commit \`$COMMIT\` and pushed to \`$REGISTRY\`. Pin these references, never a tag (D-336). The artifact \`foreman-images\` holds them as JSON, in the shapes of the settings file (\`platform.images\`) and of Windmill's \`agent_images\` and \`agent_run_settings\`."
echo
echo "| Image | Reference |"
echo "| --- | --- |"
jq -r '.images | to_entries[] | "| \(.key) | `\(.value)` |"' "$out"
