# 0106. Agent execution environment and budget enforcement

- **Status:** proposed. Review point: Didi reviews it, and M3.2 does not start until it is accepted (build plan M3.2). Resolves O-03 once accepted.
- **Date:** 2026-10-30
- **Related:** O-03, [build plan M3.2](../build-plan.md#m32-dispatch-adapters-and-runs), `docs/architecture/technical-architecture.md` sections 2.8, 4, 6 and 7, D-120, D-141, D-142, D-143, D-156, D-158, D-159, D-164, D-165, D-172, D-178, D-180, N-29, [ADR 0102](./0102-state-api-hosting-and-agent-auth.md), [ADR 0107](./0107-agent-dispatch-adapters.md), [ADR 0111](./0111-kubernetes-ready-conventions.md), [ADR 0112](./0112-qa-runtime-github-access-and-independence.md), [ADR 0113](./0113-github-evidence-ingestion.md), [M0.2 spike record](../spikes/m0.2-agent-dispatch.md)

## Context

The runner dispatches five kinds of agent: the Developer (Claude Code), QA (Claude with a read-only file tool, D-158), the Designer (Claude with the MagicPath MCP), and the Council and Triage (Claude). ADR 0107 fixes the adapter interface (`start`, `poll`, `cancel` under `RunLimits`). ADR 0112 relies on a rule this ADR must state: QA's container reaches only the model endpoint and the state API. M3.2 needs four more answers before it starts: where the agent containers run, how their network is limited, how budgets are enforced from outside the agent, and which credentials each run holds.

What is known:

- The M0.2 spike (D-172) started Claude Code headless with `--output-format json`, `--max-turns` and `--max-budget-usd`, and read back status, turns and cost. A trivial task took 3 turns, 16 seconds and about 0.02 USD. It ran on Didi's Windows laptop, which is not a place to run agents unattended.
- The state API and the GitHub receiver share one DigitalOcean host in Toronto (D-141, D-180). The product (App Platform or a droplet) and the monthly amount are approved at first hosting. Nothing is created yet.
- Windmill Cloud stays on the free tier with 1,000 executions a month, and the reconcile pass runs every 2 hours until Kubernetes exists (D-163, D-164).
- The architecture's guidance is that always-on services fit the droplet and bursty work fits on-demand compute (section 7). Kubernetes on DigitalOcean is the second release (D-165).
- Agents get no production access and no credential that reaches real personal data (essentials, section 4 of the architecture).

## Options

| Option                                              | For                                                                                                                                     | Against                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A separate DigitalOcean droplet for agent runs**  | Docker on our own host gives a per-run network we control, so the QA egress rule can be enforced and tested. Flat monthly cost. Toronto | One more host to patch and pay for. Idle most of the day                                                                                                                                                                                                                                                                  |
| Agent runs on the state API and receiver host       | No second bill                                                                                                                          | Starting containers needs the Docker socket, which is root on that host. An agent that escapes its container would reach the receiver's `factory_ingest` role, which writes evidence a guard trusts (essential 6, ADR 0113). Also impossible if that host turns out to be App Platform, which does not run our containers |
| On-demand compute (a machine or container per run)  | Pays only while agents run, which suits bursty work                                                                                     | The runner would hold a cloud token that can create machines (wider permissions). Boot time per run. Egress control differs per provider and was not proven by any spike. Per-second billing is harder to cap than a flat amount                                                                                          |
| Windmill workers                                    | No new host                                                                                                                             | Windmill Cloud's shared workers do not run our containers or a per-run network. Long agent runs would also press on the free tier (D-163, D-164)                                                                                                                                                                          |
| GitHub Actions                                      | Already used for CI                                                                                                                     | Hosted runners have open egress, so the QA rule cannot hold. The model key would become a repository secret in each project. Council and Triage have no repository                                                                                                                                                        |
| Hosted agent sandbox services, or Didi's own laptop | Little to build                                                                                                                         | A sandbox service is a new vendor, account and paid plan, not researched. The laptop is not always on and holds personal data                                                                                                                                                                                             |

## Decision

### 1. Where agents run: one agent host

In the first release every agent run is a container on one DigitalOcean droplet used only for agent runs, the **agent host**, in the Toronto region (D-141). It is separate from the host of the state API and the GitHub receiver.

- A small service on the agent host, the **agent launcher** (`src/agent-launcher/`), starts, watches and stops run containers. The `AgentRuntime` adapters (ADR 0107) call it: `start` asks the launcher for a run, `poll` reads its status, `cancel` stops it. The launcher follows every ADR 0111 service rule.
- The launcher is the only process with access to Docker. No run container gets the Docker socket.
- The launcher accepts requests only from the runner, over HTTPS, with its own bearer token (a new secret at `platform/agent-launcher/runner-token`). It keeps no secrets on disk: the runner sends each run's credentials in the start request, and the launcher holds them in memory until the run ends.
- The host is declared as infrastructure code (ADR 0110). A DigitalOcean cloud firewall allows inbound HTTPS only, and outbound only HTTPS and DNS. SSH access, if any, is set in the same code.
- If the runs table later shows the host idle most of the time and on-demand compute cheaper, moving is a change to the launcher's deploy, not to the adapters.

### 2. One run is two containers on one private network

For each run the launcher creates:

1. A Docker network created as `--internal`, so it has no route out of the host.
2. An **egress proxy** container (`src/egress-proxy/`, Node built-ins only, ADR 0111 rules) attached to that network and to the outside. It reads the run's allow-list from its environment.
3. The **agent container**, attached only to the internal network. Its `HTTPS_PROXY` points at the proxy, and nothing else can leave the network even if the agent ignores that setting.

The proxy:

- Accepts `CONNECT host:443` only, to a host on the run's allow-list. Anything else is refused and logged with the host name, never the payload.
- Resolves the name itself and refuses loopback, private, link-local and metadata addresses (including `169.254.169.254`), so a rebinding trick cannot reach the host or the droplet's metadata service.
- Does not decrypt TLS. It filters by host name. It never sees the GitHub token or the state API token, which travel inside the tunnel.
- Serves the model endpoint as a plain HTTP address inside the network and forwards it over TLS to the real endpoint, adding the model API key (section 5). This is the one exception to "does not decrypt", and it applies only to the model endpoint.

The agent container gets no DNS server that resolves outside names, so DNS cannot be used to send data out.

### 3. Egress allow-list per role

| Role               | May reach                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA                 | The model endpoint and the state API. Nothing else (ADR 0112)                                                                                                       |
| Council and Triage | The model endpoint and the state API                                                                                                                                |
| Developer          | The model endpoint, the state API, the GitHub hosts git and the API need, and the package registries named in the project's settings (for example the npm registry) |
| Designer           | The Developer's list, plus the MagicPath MCP host named in the Designer's bot file                                                                                  |

- The model endpoint and the state API host come from settings (the bot file and the platform settings). The exact GitHub host list is fixed in M3.2 by a test that clones, pushes and opens a PR through the proxy, and nothing more is added.
- The proxy limits hosts, and the token limits the repository: the Developer's GitHub token works for one repository only (section 5). The proxy cannot see which repository a request names.
- Package registries are a supply-chain risk and a possible way to send data out. The registry list is per project and starts with only what the project's lockfile uses.
- QA needs the repository but has no GitHub egress. So the launcher fetches the repository at the run's `head_sha` in a separate step before the agent starts, using the read-only QA token (ADR 0112). That step removes deny-listed paths and runs the secret-value scan (`scripts/find-secret-values.mjs`); a hit fails the run closed. The cleaned tree is mounted read-only into the QA container, with no `.git` credentials. The QA token is used by that step only and never enters the agent container.

### 4. Container hardening

Every agent image and every run container follows these rules, in addition to the ADR 0111 image rules (base image pinned by digest, non-root user, Dependabot entry):

- `--cap-drop ALL`, `--security-opt no-new-privileges`, no `--privileged`, no host mounts except the run's own work folder.
- Read-only root filesystem, with a writable work folder and `/tmp` that are deleted when the run ends.
- Memory, CPU and process-count limits per container, from settings.
- The agent CLI is pinned to an exact version in the image. The adapter calls it by its path, with no shell (the D-172 finding does not arise on Linux, but the rule stands).
- Agent images are jobs, not services: they have no `PORT` and no `/health`. They exit with a status and print one JSON result. The launcher and the egress proxy are services and meet every ADR 0111 rule.

### 5. Credentials per run

| Credential                | Who creates it                                                                      | Inside the agent container?                                                                      | Ends                                                                |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| State API token           | The runner, per run (ADR 0102)                                                      | Yes, in the environment. Readable by the agent by design. Its reach is one role, project and run | Revoked when the run ends. Expiry is the minute limit plus a margin |
| GitHub installation token | The runner, from the role's App key, for one repository (ADR 0112, D-156, D-159)    | Developer and Designer: yes, for git and the API. QA: no (section 3). Council and Triage: none   | Revoked when the run ends. GitHub caps it at 1 hour                 |
| Model API key             | The runner resolves the bot file's secret path (D-143) and sends it to the launcher | No. Only the egress proxy holds it and adds it to model requests                                 | Gone when the proxy container is removed                            |
| Anything else             | Not issued. Production, real personal data and remote databases are never reachable | No                                                                                               |                                                                     |

- The agent's runtime is pointed at the proxy's model address (for Claude Code, `ANTHROPIC_BASE_URL`, which Claude Code documents for routing through a gateway that keeps the provider key on the server side; code.claude.com/docs/en/llm-gateway, read 2026-10-30). The agent holds a placeholder value, and the proxy replaces it. M3.2 confirms this works with the pinned CLI version.
- If a runtime cannot use a base address setting, its key goes into the agent's environment and is readable by the agent. That runtime then gets a dedicated per-project key (D-143) and is listed in the runtime table of ADR 0107 as an exception.
- The App private keys stay with the runner (ADR 0112). The launcher never holds them.
- Because a GitHub installation token lasts at most 1 hour, the Developer and Designer minute limits start below 60 (section 6). A longer limit needs token refresh, which is built only if the runs table shows runs reaching the limit.
- Secrets are never logged. The launcher and the proxy log run ids, host names, durations and outcomes. Before the launcher stores any agent output (the final text, stderr), it removes every credential value it issued for the run, as the spike's `printRecord` does. Transcripts stay inside the container and are deleted with it unless `transcript_ref` says otherwise in a later decision.

### 6. Budgets, enforced from outside the agent

Each run carries `RunLimits` (turns, minutes, dollars) from the bot file, recorded in `runs.budget`. The model inside the run cannot change them.

| Limit   | Enforced by                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turns   | The runtime's own flag (`--max-turns` for Claude Code), set by the launcher. Backstop: the proxy counts model requests and refuses more than twice the turn limit           |
| Dollars | The runtime's own flag (`--max-budget-usd`), set by the launcher. Backstop: the request ceiling above and the wall clock. Cost is read from the result into `runs.cost_usd` |
| Minutes | The launcher's own timer on the agent host. At the limit it stops the agent container. It does not wait for the 2-hour reconcile pass (D-164)                               |

Proposed starting values. They are settings in each bot file, generous on purpose (D-120), and tuned in M6.4 from the runs table:

| Role      | Turns | Minutes | Dollars |
| --------- | ----- | ------- | ------- |
| Developer | 100   | 50      | 10      |
| Designer  | 100   | 50      | 10      |
| QA        | 50    | 20      | 3       |
| Council   | 40    | 20      | 5       |
| Triage    | 40    | 20      | 3       |

**Stopping a run never splits a transition.** Agents never write transitions. The runner writes each one as a single database transaction (essential 3), and each agent call to the state API is one request in its own transaction. So the launcher may stop an agent container at any moment, and the store holds only whole rows. What "never kill a run mid-transition" requires is this order:

1. At a limit, or on `cancel` (kill switch, a new commit for QA), the launcher sends SIGTERM to the agent container, waits a grace period (30 seconds, a setting), then stops it.
2. The launcher reports the outcome to `poll`: `timeout`, `budget_exceeded` or `cancelled`.
3. Only then does the runner, in its own flow, record the run's end, revoke its tokens and decide any transition through its guards. The launcher never touches the store and never cancels a runner step.

Work the agent did not push before it stopped is lost. The next run starts from the branch. An item that ran over budget follows the contract: Escalated to Council (spec, failure modes table).

**Usage exhausted.** The adapter maps a provider rate-limit or capacity response to `usage_exhausted` (ADR 0107). The run ends with that outcome, the failure counter does not move (FR-11), and the dispatch is queued: the node keeps its state, and the runner dispatches it again at the next reconcile pass or event after a wait (setting `usage_exhausted_wait_minutes`, default 30, or the provider's retry-after time if longer). With the 2-hour pass (D-164), a resume can be up to 2 hours late. An out-of-credit response is also `usage_exhausted`, and the runner raises an alert for Didi, because only money fixes it. No new table is needed: a queued dispatch is a node whose latest run ended `usage_exhausted`.

### 7. How many runs at once

The runner checks these at dispatch, from the `runs` table, inside the transaction that creates the run row, so two dispatches cannot both pass:

- One active agent per item.
- At most 3 active Developer runs per project (spec section 2).
- One active QA run per project, pull request and head commit. A duplicate event is ignored, and a new commit cancels the active run (ADR 0112).
- A host-wide cap on active runs (setting `agent_host_max_active_runs`, sized to the droplet). The launcher refuses a start above it, and the runner queues the dispatch as for `usage_exhausted`, without an alert.

### 8. Kubernetes in the second release

This maps one to one to Kubernetes. Nothing here is built now (ADR 0111).

| First release                         | Second release                                                          |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Agent host and launcher               | The runner creates a Job per run in the project's namespace             |
| Internal Docker network per run       | A NetworkPolicy that lets the agent pod reach only its egress proxy pod |
| Egress proxy container per run        | An egress proxy pod per run, the only pod allowed out on 443            |
| Container limits and hardening flags  | Pod security context, resource limits and the namespace's quota         |
| Launcher's minute timer               | The Job's `activeDeadlineSeconds`, plus the same grace period           |
| Credentials sent in the start request | Secrets from Vault by the same paths (D-143)                            |
| Proxy adds the model key              | The model gateway pod (D-142) adds it, and the proxy only forwards      |

NetworkPolicy filters by address, not host name, so the egress proxy stays in the second release.

## Constraints

- Only the runner starts, stops and records runs. The launcher reports; the runner decides (essential 1).
- No agent gets production credentials, database credentials or any credential that reaches real personal data.
- QA's container reaches only the model endpoint and the state API.
- No secret value in logs, the `runs` table, transcripts, PR bodies or Linear.
- No host, account, paid plan or credential is created before Didi approves it. The agent host, its monthly amount and the launcher token are gates at first hosting, as D-180 sets for the API host.
- No Kubernetes code, manifests or cluster (ADR 0111).

## How success is judged

M3.2 cannot start until this ADR is accepted. In M3.2 these checks pass:

1. **Egress, QA:** from a QA container, a request to the model endpoint and to the state API works; a request to `github.com`, to any other host, to a raw IP address, to `169.254.169.254` and to the state API host's private address fails; a DNS lookup of an outside name fails; a direct connection that ignores `HTTPS_PROXY` fails.
2. **Egress, Developer and Designer:** a clone, a push to the run's branch and a PR open work through the proxy for the one repository; a push to a second repository fails on the token; a host off the list fails. The Designer reaches the MagicPath host and the Developer does not.
3. **Model key:** the agent container's environment and filesystem do not contain the model key, and a model call from inside the container still works.
4. **Credentials:** tokens are revoked when a run ends, and a call with them afterwards fails. The QA container has no GitHub token.
5. **Logs:** a run whose agent prints its tokens leaves no token value in the launcher's logs or the `runs` row.
6. **Budgets:** a run that loops stops at its turn limit and records `budget_exceeded`; a run that sleeps stops at its minute limit and records `timeout`; a cancelled run records `cancelled`; in each case the store has no partial transition and the runner's next step runs after the stop.
7. **Usage exhausted:** a simulated rate-limit response records `usage_exhausted`, leaves the failure counter unchanged, and the dispatch resumes after the wait (build plan M3.2).
8. **Limits:** a fourth Developer dispatch in a project waits; a second dispatch for the same item waits; a duplicate QA event gives one run.
9. **Containers:** the CI check from ADR 0111 covers the launcher and the egress proxy; a test checks every agent image pins its base by digest and runs as non-root.
10. **End to end:** each adapter starts an agent on a trivial task in the rehearsal project and records a run with model, turns, minutes, cost and outcome (build plan M3.2).

## Reasons

- A host we control is the only option here where the QA egress rule can be enforced with known tools and tested, which ADR 0112 requires before M3.2.
- Keeping agents off the API and receiver host means an agent that escapes its container still cannot write trusted evidence or reach the store's roles.
- A flat monthly amount is easier for Didi to approve and cap than per-second billing, and needs no cloud credential that can create machines.
- Per-run networks and a per-run proxy keep each project's boundary explicit (ADR 0111 section 3), and they map directly to a Job, a NetworkPolicy and a proxy pod later.
- Budgets set by the launcher, a request ceiling at the proxy, and a timer on the host keep every limit outside the model's reach, without relying on the 2-hour reconcile pass.

## Consequences

- Three new pieces to build in M3.2: the launcher, the egress proxy and the agent images. One new host to patch.
- The runner gains a launcher client in the agent runtime adapters, and one more secret (the launcher token).
- ADR 0112's line that the QA token goes through the agent's environment becomes: the QA token is used by the fetch step before the agent starts, and never enters the agent container. ADR 0112 is updated to say so when this ADR is accepted.
- A proxy that adds the model key is close to a model gateway, which D-142 places in the second release. It does no routing, budgets or logging of prompts, and it is replaced by the gateway pod then.
- Runs that stop leave unpushed work behind. Agent instructions should push small commits.

## Cost

| Cost                                       | Known or to check                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model usage                                | Pay per token, already in use (D-171). The spike's trivial task cost about 0.02 USD. Real runs cost more; the per-run limits above bound each one, and M4.5 adds the daily roll-up                                                                                                                                                                                                                                                               |
| Agent host                                 | **To check at first hosting.** Third-party pages read on 2026-10-30 list a DigitalOcean Basic droplet with 2 vCPU and 4 GB at 24 USD a month and 4 vCPU and 8 GB at 48 USD a month (vpsbenchmarks.com/hosters/digitalocean/plans/87, frontdeskreview.com/software/vps-hosting/digitalocean/). DigitalOcean's own pricing page could not be opened from this session, and some sources disagree, so the price must be read there at first hosting |
| Data transfer, backups, monitoring add-ons | To check at first hosting                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GitHub Apps, Docker, the proxy             | No charge known                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Open questions for Didi

| Question                                                                                                       | Recommended answer                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A separate droplet for agents (a second bill), or agents on the API host?                                   | A separate droplet. Sharing the host lets an escaped agent reach the role that writes trusted evidence                                                                                             |
| 2. Size and monthly amount of the agent host                                                                   | Decide at first hosting, after reading DigitalOcean's page. Start with 2 vCPU and 4 GB for the single rehearsal project, and resize from the runs table. It is a paid plan, so it is your decision |
| 3. May the egress proxy add the model key, so agents never hold it, though this is close to the D-142 gateway? | Yes. It is the only way to keep the key away from an agent that has a shell, and the gateway replaces it in the second release                                                                     |
| 4. The QA token is used before the agent starts and never enters the QA container (a tightening of ADR 0112)   | Yes. With no GitHub egress the token would be useless inside, and keeping it out removes one credential from QA's reach                                                                            |
| 5. The starting budgets in section 6                                                                           | Accept them as generous starting values (D-120). Per-run dollars are money, so they need your yes                                                                                                  |
| 6. Which package registries a project's Developer may reach                                                    | Only those its lockfile uses, listed per project. For `foreman` and the rehearsal project, the npm registry only                                                                                   |
| 7. The launcher's inbound address needs a host name and certificate, which is a DNS change                     | Approve it as its own DNS gate at first hosting, together with the host                                                                                                                            |
| 8. The Designer's MagicPath credential                                                                         | A new-credentials gate when the Designer adapter is first run. Until then the Designer adapter is tested without MagicPath                                                                         |
