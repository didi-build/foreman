# 0106. Agent execution environment and budget enforcement

- **Status:** proposed. Review point: Didi reviews it, and M3.2 does not start until it is accepted (build plan M3.2). Resolves O-03 once accepted.
- **Date:** 2026-10-30
- **Related:** O-03, [build plan M3.2](../build-plan.md#m32-dispatch-adapters-and-runs), `docs/architecture/technical-architecture.md` sections 2.8, 2.10, 4, 6 and 7, D-120, D-141, D-142, D-143, D-156, D-158, D-159, D-164, D-165, D-172, D-178, D-180, N-29, [ADR 0102](./0102-state-api-hosting-and-agent-auth.md), [ADR 0107](./0107-agent-dispatch-adapters.md), [ADR 0110](./0110-infrastructure-as-code.md), [ADR 0111](./0111-kubernetes-ready-conventions.md), [ADR 0112](./0112-qa-runtime-github-access-and-independence.md), [ADR 0113](./0113-github-evidence-ingestion.md), [M0.2 spike record](../spikes/m0.2-agent-dispatch.md)

## Context

The runner dispatches five kinds of agent: the Developer (Claude Code), QA (Claude with a read-only file tool, D-158), the Designer (Claude with the MagicPath MCP), and the Council and Triage (Claude). ADR 0107 fixes the adapter interface (`start`, `poll`, `cancel` under `RunLimits`). ADR 0112 relies on a rule this ADR must state: QA's container reaches only the model endpoint and the state API. M3.2 needs four more answers before it starts: where the agent containers run, how their network is limited, how budgets are enforced from outside the agent, and which credentials each run holds.

What is known:

- The M0.2 spike (D-172) started Claude Code headless with `--output-format json`, `--max-turns` and `--max-budget-usd`, and read back status, turns and cost. A trivial task took 3 turns, 16 seconds and about 0.02 USD. It ran on Didi's Windows laptop, which is not a place to run agents unattended.
- The state API and the GitHub receiver share one DigitalOcean host in Toronto (D-141, D-180). The product (App Platform or a droplet) and the monthly amount are approved at first hosting. Nothing is created yet.
- Windmill Cloud stays on the free tier with 1,000 executions a month, and the reconcile pass runs every 2 hours until Kubernetes exists (D-163, D-164).
- Kubernetes on DigitalOcean is the second release (D-165).
- Agents get no production access and no credential that reaches real personal data (essentials, section 4 of the architecture).

### Decided by Didi, 2026-10-30

Agents get their own server, and it is not a droplet: a small DigitalOcean Kubernetes (DOKS) cluster that runs only agent jobs in the first release. Didi: "own server but not droplet. this was a reason why I wanted to use k8s". The state API, the GitHub receiver and Windmill Cloud stay where they are and move onto Kubernetes in the second release, as planned (D-165). This is an exception to "no cluster in the first release" (ADR 0111, build plan M0.8), limited to agent runs.

## Options

| Option                                              | For                                                                                                                                                        | Against                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A small DOKS cluster for agent runs only**        | Didi's choice. Jobs, NetworkPolicy, quotas and pod security are standard and testable. The agent design carries into the second release unchanged. Toronto | Kubernetes-specific code in the first release, in two places only (Constraints). A cluster to keep updated. Node cost is paid whether agents run or not                                                                                                              |
| A DigitalOcean droplet with our own launcher        | Docker per-run networks. One flat price                                                                                                                    | Didi chose Kubernetes. The launcher service would be thrown away in the second release                                                                                                                                                                               |
| Agent runs on the state API and receiver host       | No second bill                                                                                                                                             | Starting containers needs the Docker socket, which is root on that host. An agent that escapes its container would reach the receiver's `factory_ingest` role, which writes evidence a guard trusts (essential 6, ADR 0113). Impossible if that host is App Platform |
| On-demand compute (a machine or container per run)  | Pays only while agents run                                                                                                                                 | The runner would hold a cloud token that can create machines (wider permissions). Boot time per run. Egress control differs per provider and was not proven by any spike                                                                                             |
| Windmill workers                                    | No new host                                                                                                                                                | Windmill Cloud's shared workers do not run our containers or a per-run network. Long agent runs would press on the free tier (D-163, D-164)                                                                                                                          |
| GitHub Actions                                      | Already used for CI                                                                                                                                        | Hosted runners have open egress, so the QA rule cannot hold. The model key would become a repository secret in each project. Council and Triage have no repository                                                                                                   |
| Hosted agent sandbox services, or Didi's own laptop | Little to build                                                                                                                                            | A sandbox service is a new vendor, account and paid plan, not researched. The laptop is not always on and holds personal data                                                                                                                                        |

## Decision

### 1. Where agents run: an agents-only cluster

In the first release every agent run is a Kubernetes Job on one small DOKS cluster, the **agent cluster**, in the Toronto region (`tor1`, D-141). Nothing else runs on it.

- **One namespace per project**, named `agents-<slug>`. This matches ADR 0111 section 3, where each project's boundary becomes a namespace with its own network policies and quota. A label `foreman/project=<slug>` is set as well, for queries.
- **No launcher service.** The `AgentRuntime` adapters (ADR 0107) talk to the Kubernetes API directly: `start` creates the run's objects, `poll` reads the Job's status and the pod's log, `cancel` deletes the Job. They call the API over HTTPS. Whether that is plain `fetch` or a pinned client library is settled in M3.2; plain `fetch` adds no dependency.
- **The runner's credential** is a token for one ServiceAccount, `foreman-runner`, in its own namespace. RBAC gives it, in each `agents-<slug>` namespace only, a Role with these rights and nothing more:

| Object                 | Verbs                            | Why                                                                    |
| ---------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Jobs                   | create, get, list, watch, delete | One Job per run, and one for the QA fetch step                         |
| Pods, and `pods/log`   | get, list, watch                 | Read status and the agent's JSON result                                |
| Secrets                | create, delete                   | The run's credentials. No get or list, so it cannot read old ones back |
| NetworkPolicies        | create, delete                   | The per-run policy that links an agent pod to its proxy                |
| Services               | create, delete                   | A fixed address for the run's egress proxy (section 2)                 |
| PersistentVolumeClaims | create, delete                   | QA's fetched tree (section 5)                                          |

- It has no ClusterRole, cannot create namespaces, Roles or RoleBindings, and has no rights outside agent namespaces.
- The token is stored like any other platform secret, at `platform/agent-cluster/runner-token`, read through the secrets interface (Windmill resources now, Vault later). The cluster's address and CA certificate are plain settings. Creating the token is a **new-credentials gate** (approve-once).
- The cluster admin kubeconfig is not given to the runner or to any agent (open question 6).
- The cluster, its node pool, the namespaces, RBAC, default policies, quotas and Pod Security labels are infrastructure code (ADR 0110). Adding a project's namespace is an infrastructure change, not something the runner does.

### 2. Network: default deny, one proxy per run

Each agent namespace has a default-deny NetworkPolicy for ingress and egress, declared in infrastructure code. For each run the runner creates:

1. An **egress proxy** Job (`src/egress-proxy/`, Node built-ins only, ADR 0111 rules) with a ClusterIP Service in front. It reads the run's allow-list from its environment. Its deadline is a little longer than the agent's, so it ends by itself if the runner does not clean up.
2. A NetworkPolicy that lets the agent pod reach only that proxy's pod, on the proxy port, and lets the proxy pod accept only that agent pod. The proxy pod may reach cluster DNS and the outside on 443. Its `ipBlock` excludes private ranges and `169.254.169.254/32`.
3. The **agent Job**. Its `HTTPS_PROXY` holds the proxy Service's IP address, not a name, so the agent pod needs no DNS. It has no DNS egress, so outside names do not resolve and DNS cannot carry data out.

A NetworkPolicy applies to a whole pod, so the proxy is its own pod, not a sidecar.

The proxy:

- Accepts `CONNECT host:443` only, to a host on the run's allow-list. Anything else is refused and logged with the host name, never the payload.
- Resolves the name itself and refuses loopback, private, link-local and metadata addresses. DOKS nodes are droplets, and droplets have a metadata service at `169.254.169.254`, so it is blocked twice: by the proxy and by the NetworkPolicy.
- Does not decrypt TLS. It filters by host name. It never sees the GitHub token or the state API token, which travel inside the tunnel.
- Serves each model provider in the run's provider list as a plain HTTP address inside the namespace, and forwards it over TLS to that provider's real endpoint, adding the provider's credential (section 5). This is the one exception to "does not decrypt", and it applies only to model traffic.

**What DOKS enforces.** DOKS runs Cilium as its network plugin, and Cilium enforces standard Kubernetes NetworkPolicy (DigitalOcean's tutorial on Cilium network policies in DOKS, and a 2020 eBPF Summit talk by a DigitalOcean engineer saying all DOKS clusters run Cilium; both found by search on 2026-10-30). This was not read on DigitalOcean's own product docs, which this session could not open, so check 1 in "How success is judged" proves enforcement on the real cluster before any agent runs. Whether Cilium's host name rules (`toFQDNs`) work on DOKS was not confirmed. The proxy is kept either way, because standard NetworkPolicy filters by address, not by host name.

### 3. Egress allow-list per role

| Role               | May reach                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA                 | The model endpoint and the state API. Nothing else (ADR 0112)                                                                                                       |
| Council and Triage | The model endpoint and the state API                                                                                                                                |
| Developer          | The model endpoint, the state API, the GitHub hosts git and the API need, and the package registries named in the project's settings (for example the npm registry) |
| Designer           | The Developer's list, plus the MagicPath MCP host named in the Designer's bot file                                                                                  |
| QA fetch step      | The GitHub hosts needed to fetch one commit. Nothing else                                                                                                           |

- The model endpoint and the state API host come from settings (the bot file and the platform settings). The exact GitHub host list is fixed in M3.2 by a test that clones, pushes and opens a PR through the proxy, and nothing more is added.
- The proxy limits hosts, and the token limits the repository: a GitHub token works for one repository only (section 5). The proxy cannot see which repository a request names.
- Package registries are a supply-chain risk and a possible way to send data out. The registry list is per project and starts with only what the project's lockfile uses.

### 4. Pod hardening

Every agent, fetch and proxy pod follows these rules, on top of the ADR 0111 image rules (base image pinned by digest, non-root user, Dependabot entry):

- Security context: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, capabilities `drop: ["ALL"]`, `seccompProfile: RuntimeDefault`.
- `automountServiceAccountToken: false`, so a pod cannot talk to the Kubernetes API.
- No `hostPath`, `hostNetwork`, `hostPID` or privileged containers. The writable work folder and `/tmp` are `emptyDir` volumes, gone with the pod.
- CPU, memory and ephemeral storage requests and limits on every container, from settings.
- Each agent namespace has a ResourceQuota (pods, CPU, memory, storage) and the Pod Security Admission label `pod-security.kubernetes.io/enforce: restricted`, so a pod that breaks these rules is refused at creation.
- The agent CLI is pinned to an exact version in the image and called by its path, with no shell (the D-172 finding does not arise on Linux, but the rule stands).
- Agent images are jobs, not services: they have no `PORT` and no `/health`. They exit with a status and print one JSON result. The egress proxy is a service and meets every ADR 0111 rule.

### 5. Credentials per run

The runner creates one Kubernetes Secret per run for each pod that needs one, and deletes them when the run ends. A Secret is mounted only into the pod that uses it.

| Credential                | Who creates it                                                                      | Mounted into                                                                                              | Ends                                                                |
| ------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| State API token           | The runner, per run (ADR 0102)                                                      | The agent pod. Readable by the agent by design. Its reach is one role, project and run                    | Revoked when the run ends. Expiry is the minute limit plus a margin |
| GitHub installation token | The runner, from the role's App key, for one repository (ADR 0112, D-156, D-159)    | Developer and Designer: the agent pod. QA: the fetch pod only, never the QA pod. Council and Triage: none | Revoked when the run ends. GitHub caps it at 1 hour                 |
| Model credential          | The runner resolves the secret path of each provider in the run's list (D-143)      | The egress proxy pod only. The proxy adds it to model requests                                            | Secret deleted when the run ends                                    |
| Anything else             | Not issued. Production, real personal data and remote databases are never reachable | Nothing                                                                                                   |                                                                     |

- **The model credential. Rule: an agent never holds a model credential.** The egress proxy adds each provider's credential from settings. The proxy code knows nothing about any one provider: each provider is a settings entry with three fields, the upstream address, how the credential is sent (for example an `x-api-key` header for Anthropic, `Authorization: Bearer` for OpenAI-style APIs and most self-hosted model servers), and the credential's secret path (D-143). A self-hosted model needs no entry for a credential if it checks the run's identity itself (below). Adding a provider, including one hosted on the cluster, is a settings change, not new code.
- The agent's runtime is pointed at the proxy's address for its provider by the runtime's own base address setting (for Claude Code, `ANTHROPIC_BASE_URL`, documented for routing through a gateway that keeps the provider key on the server side, code.claude.com/docs/en/llm-gateway, read 2026-10-30; OpenAI-style tools use `OPENAI_BASE_URL`). The agent holds a placeholder, and the proxy replaces it. M3.2 confirms this with the pinned CLI version. Tying a runtime to one provider is the runtime adapter's concern (ADR 0107), not the proxy's.
- **Identity federation, later.** Where a provider accepts a workload identity (a short-lived Kubernetes service account token exchanged for short-lived access), the proxy uses it and holds no long-lived credential at all. The first use is self-hosted models on the cluster, which can check each run's identity directly. Whether Anthropic's API and DOKS support this for outside providers is not checked yet. The agent never holds a federated token either, because a tricked agent could still leak it while it is valid.
- **A runtime that cannot use a base address** breaks the rule. It is not used until Didi accepts it as a listed exception in ADR 0107, and it then gets a dedicated per-project credential with a spending cap at the provider (D-143).
- **The QA fetch step is a separate Job, not an init container.** A NetworkPolicy covers a whole pod, so an init container that reaches GitHub would give the QA pod GitHub egress for its whole life, which breaks the QA rule. The fetch Job mounts the read-only QA token, fetches the repository at the run's `head_sha`, removes deny-listed paths, runs the secret-value scan (`scripts/find-secret-values.mjs`), and writes the cleaned tree to a small per-run volume (a PersistentVolumeClaim), with no `.git` credentials. A scan hit fails the run closed. The QA Job then mounts that volume read-only. The volume is deleted with the run.
- The App private keys stay with the runner (ADR 0112). Nothing on the cluster holds them.
- Because a GitHub installation token lasts at most 1 hour, the Developer and Designer minute limits start below 60 (section 6). A longer limit needs token refresh, which is built only if the runs table shows runs reaching the limit.
- **Secrets are never logged.** The proxy logs run ids, host names, durations and outcomes. Before the runner stores any agent output (the final text, an error), it removes every credential value it issued for the run, as the spike's `printRecord` does. Transcripts stay in the pod's `emptyDir` and are deleted with it, unless a later decision sets `transcript_ref`.

### 6. Budgets, enforced from outside the agent

Each run carries `RunLimits` (turns, minutes, dollars) from the bot file, recorded in `runs.budget`. The runner writes them into the Job spec. The model inside the run cannot change them.

| Limit   | Enforced by                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turns   | The runtime's own flag (`--max-turns` for Claude Code), set in the Job spec. Backstop: the proxy counts model requests and refuses more than twice the turn limit         |
| Dollars | The runtime's own flag (`--max-budget-usd`), set in the Job spec. Backstop: the request ceiling above and the deadline. Cost is read from the result into `runs.cost_usd` |
| Minutes | The Job's `activeDeadlineSeconds`. Kubernetes stops the pod at the deadline by itself, so it does not wait for the 2-hour reconcile pass (D-164)                          |

Every agent Job also sets:

- `terminationGracePeriodSeconds`: the grace period between SIGTERM and the forced stop (setting, 30 seconds to start).
- `backoffLimit: 0` and `restartPolicy: Never`: Kubernetes never retries a run by itself. Only the runner decides whether to dispatch again.
- `ttlSecondsAfterFinished`: Kubernetes removes a finished Job and its pod after a delay (setting, 1 hour to start), long enough for the runner to read the result. The runner deletes them sooner once it has.

Rehearsal values (D-185). They are settings in each bot file. The dollar caps are tighter than a generous start (D-120) to halve the worst case during the rehearsal; they are raised if real runs keep reaching them, and tuned in M6.4 from the runs table:

| Role      | Turns | Minutes | Dollars |
| --------- | ----- | ------- | ------- |
| Developer | 100   | 50      | 5       |
| Designer  | 100   | 50      | 5       |
| QA        | 50    | 20      | 2       |
| Council   | 40    | 20      | 3       |
| Triage    | 40    | 20      | 3       |

**Models.** Runs start on the lower-cost models (D-185): Claude Sonnet 5.5 by default, and Claude Haiku 5.5 for a role where a rehearsal comparison shows it holds quality (Triage is the first candidate). The model is a setting in each bot file. The QA model must differ from the Developer's (D-158).

**Prompt caching is required** (D-185). Each run resends its conversation every turn, so caching is the largest saving. Every runtime must use it: Claude Code does by default, and any runtime that calls a model API directly marks the stable part of its prompt for caching. The egress proxy forwards model request bodies byte for byte and changes only the credential header, because any change to the body breaks the cache. Each run records its cached and uncached token counts in `runs.tokens`.

**Stopping a run never splits a transition.** Agents never write transitions. The runner writes each one as a single database transaction (essential 3), and each agent call to the state API is one request in its own transaction. So an agent pod may be stopped at any moment, and the store holds only whole rows. What "never kill a run mid-transition" requires is this order:

1. At a limit (the deadline, or the runtime's own turn or dollar cap), or on `cancel` (kill switch, a new commit for QA), the agent pod gets SIGTERM, then is stopped after the grace period.
2. `poll` reports the outcome: `timeout` (deadline exceeded), `budget_exceeded` or `cancelled`.
3. Only then does the runner, in its own flow, record the run's end, revoke its tokens, delete its Secrets and decide any transition through its guards. Nothing on the cluster touches the store or interrupts a runner step.

Work the agent did not push before it stopped is lost. The next run starts from the branch. An item that ran over budget follows the contract: Escalated to Council (spec, failure modes table).

**Usage exhausted.** The adapter maps a provider rate-limit or capacity response to `usage_exhausted` (ADR 0107). The run ends with that outcome, the failure counter does not move (FR-11), and the dispatch is queued: the node keeps its state, and the runner dispatches it again at the next reconcile pass or event after a wait (setting `usage_exhausted_wait_minutes`, 30 to start, or the provider's retry-after time if longer). With the 2-hour pass (D-164), a resume can be up to 2 hours late. An out-of-credit response is also `usage_exhausted`, and the runner raises an alert for Didi, because only money fixes it. No new table is needed: a queued dispatch is a node whose latest run ended `usage_exhausted`.

### 7. How many runs at once

The runner checks these at dispatch, from the `runs` table, inside the transaction that creates the run row, so two dispatches cannot both pass:

- One active agent per item.
- At most 3 active Developer runs per project (spec section 2).
- One active QA run per project, pull request and head commit. A duplicate event is ignored, and a new commit cancels the active run (ADR 0112).
- At most `agent_cluster_max_active_runs` active runs across the cluster (a setting, sized to the node pool). Above it, the dispatch is queued as for `usage_exhausted`, without an alert.

Each namespace's ResourceQuota is the backstop. If a Job's pod cannot be created within a few minutes (setting), the runner deletes the Job and queues the dispatch.

### 8. What the second release adds

The agent design does not change in the second release. It adds around it:

- The state API, the GitHub receiver and a self-hosted Windmill move onto Kubernetes (D-163, D-165), on this cluster grown or on a larger one, decided then.
- Vault replaces Windmill resources behind the same secret paths (D-143). The runner's cluster token and the per-run Secrets keep their paths.
- The self-hosted model gateway (D-142) takes over model routing, fallbacks, cost tracking and the provider credentials. The egress proxy then stops adding credentials: it forwards model traffic to the gateway with the run's identity, and keeps its security job for all other traffic. The proxy's provider list shrinks to one entry, the gateway. Bringing the gateway forward onto the agent cluster is possible now that the cluster exists, and is a separate decision.
- Monitoring, GitOps and per-project namespaces for the projects' own deploys (build plan M7).

## Constraints

- Only the runner starts, stops and records runs. Kubernetes reports; the runner decides (essential 1).
- No agent gets production credentials, database credentials or any credential that reaches real personal data. No agent pod gets a Kubernetes API token.
- QA's pod reaches only the model endpoint and the state API.
- No secret value in logs, the `runs` table, transcripts, PR bodies or Linear.
- No cluster, node pool, paid plan or credential is created before Didi approves it. The cluster, its monthly amount and the runner's cluster token are gates at first hosting, as D-180 sets for the API host.
- Kubernetes-specific code is allowed in the first release only in the Kubernetes agent runtime adapter (`src/adapters/agent-runtime/`) and the agent cluster's infrastructure code, and only for agent runs. Everything else stays Kubernetes-ready but not Kubernetes-specific (ADR 0111). ADR 0111, the build plan (M0.8, M3.2, M7) and `AGENTS.md` section 4a are amended to say so when this ADR is accepted.

## How success is judged

M3.2 cannot start until this ADR is accepted. In M3.2 these checks pass on the real agent cluster:

1. **NetworkPolicy is enforced:** a test pod with no allow policy cannot reach anything, so the default deny works on DOKS.
2. **Egress, QA:** from a QA pod, a request to the model endpoint and to the state API works through the proxy; a request to `github.com`, to any other host, to a raw IP address and to `169.254.169.254` fails; a DNS lookup of an outside name fails; a direct connection that ignores `HTTPS_PROXY` fails.
3. **Egress, Developer and Designer:** a clone, a push to the run's branch and a PR open work through the proxy for the one repository; a push to a second repository fails on the token; a host off the list fails. The Designer reaches the MagicPath host and the Developer does not.
4. **RBAC:** with the runner's token, creating a Job in `agents-<slug>` works; reading or listing Secrets in any namespace, creating anything in a non-agent namespace, and creating a namespace, ClusterRole, Role or RoleBinding all fail.
5. **Pod security:** a pod that asks to run as root, to be privileged or to mount a host path is refused by the namespace.
6. **Model credential:** the agent pod's environment and filesystem do not contain any model credential, and a model call from inside the pod still works. A second provider entry in settings (a fake upstream) works with no code change.
7. **Credentials:** tokens are revoked and Secrets deleted when a run ends, and a call with the tokens afterwards fails. The QA pod has no GitHub token. The fetch step's tree contains no deny-listed path.
8. **Logs:** a run whose agent prints its tokens leaves no token value in the proxy's logs or the `runs` row.
9. **Budgets:** a run that loops stops at its turn limit and records `budget_exceeded`; a run that sleeps is stopped by `activeDeadlineSeconds` and records `timeout`; a cancelled run records `cancelled`; a failed pod is not retried by Kubernetes; in each case the store has no partial transition and the runner's next step runs after the stop.
10. **Usage exhausted:** a simulated rate-limit response records `usage_exhausted`, leaves the failure counter unchanged, and the dispatch resumes after the wait (build plan M3.2).
11. **Limits:** a fourth Developer dispatch in a project waits; a second dispatch for the same item waits; a duplicate QA event gives one run.
12. **Images:** the ADR 0111 CI check covers the egress proxy; a test checks every agent image pins its base by digest and runs as non-root.
13. **End to end:** each adapter starts an agent on a trivial task in the rehearsal project and records a run with model, turns, minutes, cost and outcome (build plan M3.2).
14. **Prompt caching:** in a run of more than one turn through the proxy, the turns after the first report cached input tokens above zero, and `runs.tokens` records them.

## Reasons

- Didi chose a cluster, and it gives every control this ADR needs as standard objects: a Job deadline, no retries, NetworkPolicy, quotas and Pod Security, all testable.
- An agents-only cluster means an agent that escapes its pod still finds no state API, receiver or database role on that cluster, so it cannot write trusted evidence.
- No launcher to build and throw away. The adapters create Jobs, and the same Jobs run in the second release.
- One namespace per project keeps each project's boundary explicit (ADR 0111 section 3) from the first release.
- Budgets set in the Job spec, a request ceiling at the proxy and a deadline enforced by Kubernetes keep every limit outside the model's reach, without relying on the 2-hour reconcile pass.

## Consequences

- Kubernetes arrives early, for agent runs only. ADR 0111, the build plan and `AGENTS.md` need the narrowed rule above.
- ADR 0110 and the infrastructure layout need a DigitalOcean provider for the cluster (and a Kubernetes provider for the namespaces and policies), next to the Cloudflare-only platform module. This ADR does not design that; it is a follow-up to ADR 0110.
- New pieces to build in M3.2: the Kubernetes agent runtime adapter, the egress proxy, the agent images and the QA fetch image. A cluster to keep on supported Kubernetes versions.
- ADR 0112 now says the QA token is used only by the fetch Job and never enters the QA pod (D-184).
- A proxy that adds model credentials does one small part of a model gateway's job (D-142). It does no routing, fallbacks, budgets or logging of prompts, and the gateway takes that part over in the second release. Keeping it to a provider list in settings stops it growing into a second gateway.
- QA runs take a little longer: a fetch Job and a volume come before the agent starts.
- Runs that stop leave unpushed work behind. Agent instructions should push small commits.

## Cost

All prices below come from search results read on 2026-10-30. DigitalOcean's own pages (www.digitalocean.com and docs.digitalocean.com) could not be opened from this session. **Every figure must be read on DigitalOcean's pricing page at first hosting.**

| Cost                   | Known or to check                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model usage            | Pay per token, already in use (D-171). The spike's trivial task cost about 0.02 USD. The per-run limits above bound each run, and M4.5 adds the daily roll-up                                                                                              |
| Control plane          | Reported free for the standard control plane, and 40 USD a month for the high-availability control plane (DigitalOcean's pricing page and its blog post on the HA control plane, as summarised by search). To check                                        |
| Worker nodes           | Reported billed like droplets, per second at the droplet price. Third-party pages list 2 vCPU / 4 GB at 24 USD a month and 4 vCPU / 8 GB at 48 USD a month (vpsbenchmarks.com, frontdeskreview.com). The smallest node size and minimum count are to check |
| QA fetch volumes       | Block storage, billed while each per-run volume exists. Price and minimum size to check                                                                                                                                                                    |
| Load balancer          | None needed. Agents take no inbound traffic, and the runner calls the Kubernetes API endpoint                                                                                                                                                              |
| Data transfer          | To check                                                                                                                                                                                                                                                   |
| GitHub Apps, the proxy | No charge known                                                                                                                                                                                                                                            |

The `tor1` region is reported to offer DOKS (a 2019 DigitalOcean release note and current status-page entries for Kubernetes in TOR1, found by search). Confirm it on DigitalOcean's availability matrix at first hosting.

## Open questions for Didi

| Question                                                                                                                                     | Recommended answer                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Cluster size: node size and count, high-availability control plane or not, and the monthly amount                                         | **Decided (D-183):** one fixed node pool of one 2 vCPU / 4 GB node, no HA control plane. The price is read on DigitalOcean's page when the cluster is created                     |
| 2. Accept the rule that an agent never holds a model credential, with the proxy adding each provider's credential from settings (section 5)? | Yes. It keeps credentials away from an agent that has a shell, it works the same for any provider and for self-hosted models, and the gateway takes it over in the second release |
| 3. The QA token is mounted only into the fetch Job, never the QA pod (a tightening of ADR 0112)                                              | **Decided (D-184):** yes. ADR 0112 is updated to match                                                                                                                            |
| 4. The starting budgets in section 6                                                                                                         | **Decided (D-185):** the tighter rehearsal dollar caps, Sonnet 5.5 by default with Haiku 5.5 where it holds quality, and prompt caching required                                  |
| 5. Which package registries a project's Developer may reach                                                                                  | Only those its lockfile uses, listed per project. For `foreman` and the rehearsal project, the npm registry only                                                                  |
| 6. Who holds the cluster admin kubeconfig?                                                                                                   | You only, in your password manager. Never the runner, an agent or Windmill. Infrastructure applies to the cluster are yours, like other production applies                        |
| 7. Should the Kubernetes API endpoint be limited to known source addresses?                                                                  | Yes if DOKS offers it and Windmill Cloud's outbound addresses are fixed, both to check at first hosting. Otherwise rely on the RBAC-limited runner token                          |
| 8. The Designer's MagicPath credential                                                                                                       | A new-credentials gate when the Designer adapter is first run. Until then the Designer adapter is tested without MagicPath                                                        |
