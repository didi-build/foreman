#!/usr/bin/env bash
# The checks the first-hosting runbook runs after the cluster's standing objects are applied
# (step 7, ADR 0106 checks 1, 4 and 15; D-330), as a table on stdout for the job summary. Exit 1
# if any answer is not the expected one.
#
#   platform-checks.sh <rendered manifests JSON> [rbac|network|pools|all]
#
# rbac:    `kubectl auth can-i` as the run watcher and as the runner, the runbook's list.
# network: default deny holds: a probe pod with no allow policy, in the platform namespace and in
#          each agent namespace, reaches neither cluster DNS, a public address on 443, nor the API
#          server. It lands on its own pool.
# pools:   platform pods run on platform nodes, agent pods on agent nodes, and agent nodes carry
#          the NoSchedule taint.
# The checks read names and answers only, never a Secret or a pod's log beyond the probe's own.
set -euo pipefail
manifests="${1:?the rendered manifests}"
which="${2:-all}"
platform_ns="foreman-platform"
pool_key="foreman/pool"
watcher="system:serviceaccount:foreman-platform:run-watcher"
runner="system:serviceaccount:foreman-runner:foreman-runner"
failures=0

agent_namespaces=()
while IFS= read -r ns; do
  [ -n "$ns" ] && agent_namespaces+=("$ns")
done < <(jq -r '.items[] | select(.kind == "Namespace" and (.metadata.labels["foreman/project"] // "") != "") | .metadata.name' "$manifests")

row() {
  local check="$1" want="$2" got="$3" mark="ok"
  if [ "$want" != "$got" ]; then
    mark="**FAILED**"
    failures=$((failures + 1))
  fi
  printf '| %s | %s | %s | %s |\n' "$check" "$want" "$got" "$mark"
}

table_head() {
  echo
  echo "### $1"
  echo
  echo "| Check | Expected | Answer | |"
  echo "| --- | --- | --- | --- |"
}

# --- RBAC -------------------------------------------------------------------------------------
can_i() {
  local want="$1" who="$2" label="$3" answer
  shift 3
  answer="$(kubectl auth can-i "$@" --as="$who" 2>/dev/null || true)"
  answer="${answer%%[[:space:]]*}"
  case "$answer" in yes | no) ;; *) answer="error" ;; esac
  row "\`$label\` \`can-i $*\`" "$want" "$answer"
}

rbac() {
  table_head "RBAC (runbook step 7, ADR 0106 check 4, D-330)"
  local admin
  admin="$(kubectl auth can-i '*' '*' 2>/dev/null || true)"
  row "this job's credential answers \`can-i\`" "yes" "${admin%%[[:space:]]*}"
  local ns
  for ns in "${agent_namespaces[@]+"${agent_namespaces[@]}"}"; do
    for verb in get list watch; do
      can_i yes "$watcher" run-watcher "$verb" jobs.batch -n "$ns"
    done
    can_i no "$watcher" run-watcher list pods -n "$ns"
    can_i no "$watcher" run-watcher get pods --subresource=log -n "$ns"
    can_i no "$watcher" run-watcher get secrets -n "$ns"
    can_i no "$watcher" run-watcher list secrets -n "$ns"
    can_i no "$watcher" run-watcher delete jobs.batch -n "$ns"
    can_i yes "$runner" runner create jobs.batch -n "$ns"
    can_i yes "$runner" runner get pods --subresource=log -n "$ns"
    can_i yes "$runner" runner create secrets -n "$ns"
    can_i no "$runner" runner get secrets -n "$ns"
    can_i no "$runner" runner list secrets -n "$ns"
    can_i no "$runner" runner create pods -n "$ns"
    can_i no "$runner" runner create roles.rbac.authorization.k8s.io -n "$ns"
    can_i no "$runner" runner create rolebindings.rbac.authorization.k8s.io -n "$ns"
  done
  can_i no "$watcher" run-watcher list jobs.batch -n "$platform_ns"
  can_i no "$watcher" run-watcher list jobs.batch --all-namespaces
  can_i no "$watcher" run-watcher list namespaces
  can_i no "$runner" runner create jobs.batch -n "$platform_ns"
  can_i no "$runner" runner create secrets -n "$platform_ns"
  can_i no "$runner" runner list secrets --all-namespaces
  can_i no "$runner" runner create namespaces
  can_i no "$runner" runner create clusterroles.rbac.authorization.k8s.io
  can_i no "$runner" runner create clusterrolebindings.rbac.authorization.k8s.io
}

# --- Default deny -----------------------------------------------------------------------------
read -r -d '' PROBE_SCRIPT <<'EOF' || true
const dns = require("node:dns");
const net = require("node:net");
const within = (ms, p) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
const resolves = () => new Promise((r) => {
  const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
  resolver.resolve4("kubernetes.default.svc.cluster.local", (error) => r(!error));
});
const connects = (host, port) => new Promise((r) => {
  const socket = net.connect({ host, port });
  socket.setTimeout(3000);
  socket.on("connect", () => { socket.destroy(); r(true); });
  socket.on("timeout", () => { socket.destroy(); r(false); });
  socket.on("error", () => r(false));
});
(async () => {
  const reached = { dns: await within(5000, resolves()) };
  for (const t of JSON.parse(process.env.PROBE_TARGETS)) {
    reached[`${t.host}:${t.port}`] = await within(5000, connects(t.host, t.port));
  }
  console.log(JSON.stringify(reached));
  process.exit(Object.values(reached).some(Boolean) ? 1 : 0);
})();
EOF

probe_name="default-deny-probe"
probed_namespaces=()
cleanup_probes() {
  local ns
  for ns in "${probed_namespaces[@]+"${probed_namespaces[@]}"}"; do
    kubectl delete pod "$probe_name" -n "$ns" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
}
trap cleanup_probes EXIT

node_pool() {
  kubectl get node "$1" --output json | jq -r --arg k "$pool_key" '.metadata.labels[$k] // ""'
}

probe() {
  local ns="$1" pool="$2" image="$3" targets="$4" phase="" waited=0 node
  probed_namespaces+=("$ns")
  kubectl delete pod "$probe_name" -n "$ns" --ignore-not-found --wait=true >/dev/null
  jq -n --arg name "$probe_name" --arg ns "$ns" --arg pool "$pool" --arg key "$pool_key" \
    --arg image "$image" --arg script "$PROBE_SCRIPT" --arg targets "$targets" '{
      apiVersion: "v1", kind: "Pod",
      metadata: { name: $name, namespace: $ns, labels: { app: $name } },
      spec: {
        restartPolicy: "Never",
        activeDeadlineSeconds: 120,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        nodeSelector: { ($key): $pool },
        tolerations: (if $pool == "agents"
          then [{ key: $key, operator: "Equal", value: $pool, effect: "NoSchedule" }]
          else [] end),
        securityContext: {
          runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" }
        },
        containers: [{
          name: "probe", image: $image,
          command: ["node", "-e", $script],
          env: [{ name: "PROBE_TARGETS", value: $targets }],
          resources: {
            requests: { cpu: "50m", memory: "128Mi", "ephemeral-storage": "16Mi" },
            limits: { cpu: "50m", memory: "128Mi", "ephemeral-storage": "16Mi" }
          },
          securityContext: {
            runAsNonRoot: true, allowPrivilegeEscalation: false, privileged: false,
            readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }
          }
        }]
      }
    }' | kubectl create --filename - >/dev/null
  while [ "$waited" -lt 180 ]; do
    phase="$(kubectl get pod "$probe_name" -n "$ns" --output 'jsonpath={.status.phase}')"
    case "$phase" in Succeeded | Failed) break ;; esac
    sleep 3
    waited=$((waited + 3))
  done
  case "$phase" in
    Succeeded) row "default deny in \`$ns\`: the probe reaches nothing" "blocked" "blocked" ;;
    Failed)
      row "default deny in \`$ns\`: the probe reaches nothing" "blocked" "reached something"
      echo "Probe result in $ns: $(kubectl logs "$probe_name" -n "$ns" --tail=1 2>/dev/null | jq -c 'select(type == "object")' 2>/dev/null || echo unreadable)" >&2
      ;;
    *) row "default deny in \`$ns\`: the probe reaches nothing" "blocked" "probe did not finish (${phase:-no phase})" ;;
  esac
  node="$(kubectl get pod "$probe_name" -n "$ns" --output 'jsonpath={.spec.nodeName}')"
  row "probe in \`$ns\` lands on the $pool pool" "$pool" "$([ -n "$node" ] && node_pool "$node" || echo "not scheduled")"
}

network() {
  table_head "Default deny (ADR 0106 check 1)"
  local image targets ns
  image="$(jq -r '.items[] | select(.kind == "Deployment" and .metadata.name == "windmill-proxy") | .spec.template.spec.containers[0].image' "$manifests")"
  if [ -z "$image" ]; then
    row "the egress proxy image is in the render" "yes" "no"
    return
  fi
  # The API server's addresses and port, from the run watcher's policy in the swapped file
  # (api-server-address.sh, D-349). The rendered file itself holds only the placeholder 192.0.2.1,
  # which no probe could reach anyway, so the check refuses it.
  local api
  api="$(jq -c --arg ns "$platform_ns" '[.items[]
    | select(.kind == "NetworkPolicy" and .metadata.namespace == $ns and .metadata.name == "run-watcher")
    | .spec.egress[]
    | select((.to | length) > 0 and all(.to[]; (.ipBlock.cidr // "") | endswith("/32")))
    | .ports[0].port as $port
    | .to[] | { host: (.ipBlock.cidr | rtrimstr("/32")), port: $port }]' "$manifests")"
  if jq -e 'length == 0 or any(.[]; .host == "192.0.2.1")' <<<"$api" >/dev/null; then
    row "the API server's address is in the rendered objects" "yes" "no"
    return
  fi
  targets="$(jq -c '[{ host: "1.1.1.1", port: 443 }] + .' <<<"$api")"
  probe "$platform_ns" platform "$image" "$targets"
  for ns in "${agent_namespaces[@]+"${agent_namespaces[@]}"}"; do
    probe "$ns" agents "$image" "$targets"
  done
}

# --- Pools ------------------------------------------------------------------------------------
pools() {
  table_head "Node pools (ADR 0106 check 15, D-193)"
  local nodes ns
  nodes="$(kubectl get nodes --output json)"
  while IFS=$'\t' read -r name pool tainted; do
    [ -n "$name" ] || continue
    if [ "$pool" = "agents" ]; then
      row "agent node \`$name\` carries the NoSchedule taint" "yes" "$tainted"
    else
      row "node \`$name\` (pool ${pool:-none}) has no agents taint" "no" "$tainted"
    fi
  done < <(jq -r --arg k "$pool_key" '.items[] | [
      .metadata.name,
      (.metadata.labels[$k] // ""),
      (if any(.spec.taints[]?; .key == $k and .value == "agents" and .effect == "NoSchedule") then "yes" else "no" end)
    ] | @tsv' <<<"$nodes")
  for ns in "$platform_ns" "${agent_namespaces[@]+"${agent_namespaces[@]}"}"; do
    local want="agents"
    [ "$ns" = "$platform_ns" ] && want="platform"
    while IFS=$'\t' read -r pod node; do
      [ -n "$pod" ] || continue
      row "pod \`$ns/$pod\` runs on the $want pool" "$want" \
        "$(jq -r --arg n "$node" --arg k "$pool_key" '.items[] | select(.metadata.name == $n) | .metadata.labels[$k] // "none"' <<<"$nodes")"
    done < <(kubectl get pods -n "$ns" --output json |
      jq -r --arg probe "$probe_name" '.items[] | select(.spec.nodeName != null and .metadata.name != $probe) | [.metadata.name, .spec.nodeName] | @tsv')
  done
}

case "$which" in
  rbac) rbac ;;
  network) network ;;
  pools) pools ;;
  all)
    rbac
    network
    pools
    ;;
  *)
    echo "usage: platform-checks.sh <manifests> [rbac|network|pools|all]" >&2
    exit 2
    ;;
esac

echo
if [ "$failures" -gt 0 ]; then
  echo "**${failures} check(s) failed.** Stop and ask Didi before going on (runbook step 7)."
  exit 1
fi
echo "All checks passed."
