# First hosting runbook

**Purpose:** the gates Didi passes by hand, in order, to bring up the agent and platform cluster, the state API, the GitHub receiver and its tunnel, and the run watcher, for the first time (ADR 0106, ADR 0110, D-183 to D-195, D-330). Nothing here has been done yet. No agent or runner does any step.

**Rules for every step**

- Never paste a secret value into a file in the repo, a chat, Linear or a log. Read each one from the password manager or the vault and pipe it straight in (`--from-file=<key>=/dev/stdin`), so it never lands in a file or the shell history.
- Each gate is approved once, for that one request.
- In Git Bash on Windows, add `-input=false` to every `tofu` command (`infra/README.md`).

## 0. Answer the open questions first

Settle these before the apply in step 5.

Decided on 2026-10-31 by the coordinator: the database is Supabase's session pooler on 5432 (session mode, because the store uses transactions and advisory locks; the pooler is reachable over IPv4, the direct host is IPv6 only), and `cloudflared` reaches Cloudflare's edge on 7844 tcp and udp. Both are in the firewall and the network policies already. Both questions are decided (D-331, D-332):

1. **Whether the cloud firewall limits outbound at all.** Decided by D-331 (Didi, 2026-11-05). DOKS manages its own firewall for the worker nodes, and DigitalOcean combines the allow rules of every firewall on a droplet, so if the managed one allows all outbound traffic, the outbound rules here change nothing. Inside the cluster, network policies and the egress proxies are the real outbound control. At step 5, check what the managed worker firewall allows outbound, keep our cloud firewall as a second layer if its outbound rules take effect, and record the result there. No deny rules are added, and DigitalOcean's managed firewalls are never edited: its reconciler owns them by name.
2. **The admin credential in state.** Decided by D-332 (Didi, 2026-11-05): accepted under ADR 0110 secrets rule 3, as listed in `infra/README.md`. The DigitalOcean provider fetches an admin credential for the cluster and keeps it in state. State is encrypted, the credential expires after 1 hour (`kubeconfig_expire_seconds`) and it is never an output, but it is still an admin key outside the password manager (D-188).

## 1. Read the real prices

On DigitalOcean's own pricing page and availability matrix:

- DOKS is offered in `tor1`.
- The standard control plane is free.
- The `s-2vcpu-4gb` node slug exists for DOKS, and its monthly price.
- Block storage price and minimum size (QA's per-run volume).
- Data transfer allowance.

Two nodes were about 48 USD a month by search-result prices (D-193). A higher amount goes back to Didi before step 2.

## 2. DigitalOcean account and spend approval

Spending money gate. Open or confirm the DigitalOcean account, set a billing alert at the approved monthly amount, and record the approval with its date.

## 3. Credentials for the stack

New-credentials gate, one approval per credential:

- A DigitalOcean API token with the narrowest scopes that can create a Kubernetes cluster and a firewall. Exported as `DIGITALOCEAN_TOKEN` only while applying.
- A Cloudflare API token for the `didi.build` zone and account, allowed to edit Cloudflare Tunnels and DNS. Exported as `CLOUDFLARE_API_TOKEN`.
- The R2 state bucket's access key and secret (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) and the state encryption passphrase (`TF_VAR_state_encryption_passphrase`, at least 16 characters, kept in the vault), as in ADR 0110.

## 4. Decide the API endpoint allow-list (D-189)

Check whether Windmill Cloud's outbound addresses are fixed. If they are, put them and Didi's address in `api_allowed_addresses`. If not, leave it empty: the runner's RBAC-limited token is the protection.

## 5. Create the cluster and the tunnel by applying the stack

The cluster is the spending gate of step 2. The tunnel creates a new credential, its token: a new-credentials gate.

```bash
cd infra/stacks/factory
export TF_VAR_kubernetes_version_prefix=1.34.          # a version DigitalOcean lists as supported
export TF_VAR_cloudflare_settings='{account_id="...",zone_id="..."}'
export TF_VAR_receiver_hostname=...                    # the webhook host name on didi.build
tofu init -input=false -backend-config=bucket=<state bucket> \
  -backend-config='endpoints={s3="https://<account id>.r2.cloudflarestorage.com"}'
tofu plan -input=false -out=plan.out
tofu show -no-color plan.out                           # read it: no DNS record yet, one cluster, one pool, one firewall, one tunnel
tofu apply -input=false plan.out
rm plan.out
```

Then run the secret-value scan on the plan text and state as in `infra/README.md`, step 4 of the M0.7 proof, with the tunnel token among the values scanned for in the plan text.

**The managed worker firewall (D-331).** Once the cluster exists, read the firewall DOKS made for the worker nodes (in the control panel's Networking page, or `doctl compute firewall list`) and its outbound rules. Read it only: never edit it, and add no deny rule, because DigitalOcean's reconciler owns that firewall by name. If it allows all outbound traffic, our cloud firewall's outbound rules take no effect and the network policies and egress proxies are the only outbound control; if its outbound rules are narrower, ours stay as a second layer. Record which, with the date, here:

- Result: not checked yet.

## 6. The admin kubeconfig, kept by Didi only (D-188)

Download the cluster's kubeconfig from the DigitalOcean control panel and keep it only in the password manager. It never goes to the runner, an agent or Windmill. Use it for steps 7 to 10.

## 7. Apply the cluster's standing objects

Write a settings file outside the repo (images pinned by digest, the app logins, resource limits (`databasePort` defaults to 5432), the projects and their quotas; no secrets), then:

- `images.egressProxy`: the egress proxy image the agent runs use, the same digest as `proxyImage` in `agent_run_settings`. It runs once more here as the shared Windmill proxy (D-284, D-328).
- `resources.windmillProxy`: its requests and limits, like an agent run's proxy.
- `windmill.host`: the Windmill host the state API, the receiver and the run watcher start their flows on, a plain host name with no scheme (for Windmill Cloud, the host name of its app), and `windmill.workspace`: the workspace id. If the workspace does not exist yet, choose its id now and create it with that id in step 15. Both are plain settings, not secrets. The proxy allows this one host and nothing else; it has no model provider, no state API route and no credential.
- `images.runWatcher`: the run watcher's image (D-330), built from `src/run-watcher/Dockerfile` at the repo root and pinned by digest, and `resources.runWatcher`: its requests and limits (it holds a few watches open and does little else; start like the receiver's).
- `kubernetesApi`: where the run watcher reaches the API server, as its network policy allows it. A policy sees the address the `kubernetes` Service sends to, not the Service's own, so read the address and port from that Service's EndpointSlice with the admin kubeconfig of step 6, and write them as `{"addresses": ["<address>"], "port": <port>}`:

  ```bash
  kubectl -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
    -o jsonpath='{range .items[*]}{.endpoints[*].addresses}{" "}{.ports[*].port}{"\n"}{end}'
  ```

  Plain IPv4 addresses and a port only, not secrets. The watcher's policy allows exactly these and nothing else on that port.

Then render and apply:

```bash
node infra/kubernetes/render.ts <settings.json> | kubectl apply -f -
```

This creates the `foreman-platform` namespace and its policies and Deployments (the state API, the receiver, the tunnel connector, the Windmill proxy and the run watcher), the run watcher's ServiceAccount `run-watcher` there, the `foreman-runner` namespace and service account, and each `agents-<slug>` namespace. The platform pods wait for their Secrets (steps 8 to 10). Then run ADR 0106 checks 1 and 15: default deny holds, and pods stay on their own pool.

Each `agents-<slug>` namespace also gets the run watcher's RBAC (D-330), next to the runner's: a Role `run-watcher` with get, list and watch on `batch` Jobs and nothing else, and a RoleBinding that gives it to the ServiceAccount `run-watcher` in `foreman-platform`. There is no ClusterRole or ClusterRoleBinding, so the watcher holds nothing in any other namespace. These are the rights Didi approved in D-330, exactly: if a plan or a render shows any other right for `run-watcher`, stop and ask Didi before applying it. Check them with the admin kubeconfig:

```bash
sa=system:serviceaccount:foreman-platform:run-watcher
for verb in get list watch; do kubectl auth can-i "$verb" jobs.batch -n agents-<slug> --as="$sa"; done   # yes, yes, yes
kubectl auth can-i list pods -n agents-<slug> --as="$sa"                    # no
kubectl auth can-i get pods --subresource=log -n agents-<slug> --as="$sa"   # no
kubectl auth can-i get secrets -n agents-<slug> --as="$sa"                  # no
kubectl auth can-i list secrets -n agents-<slug> --as="$sa"                 # no
kubectl auth can-i delete jobs.batch -n agents-<slug> --as="$sa"            # no
kubectl auth can-i list jobs.batch -n foreman-platform --as="$sa"           # no
kubectl auth can-i list jobs.batch --all-namespaces --as="$sa"              # no
kubectl auth can-i list namespaces --as="$sa"                               # no
```

A new project later is the same re-render and apply: it adds the namespace with both Roles and puts the namespace into the watcher's `AGENT_NAMESPACES`, which restarts the watcher.

## 8. The runner's cluster token (new-credentials gate)

Create a token for the `foreman-runner` service account, and store it at `platform/agent-cluster/runner-token` in Windmill resources. Store the cluster's endpoint and CA certificate (`tofu output cluster_endpoint`, `tofu output cluster_ca_certificate`) as plain settings. Then run ADR 0106 check 4 (RBAC).

## 9. The tunnel token Secret

```bash
tofu -chdir=infra/stacks/factory output -raw receiver_tunnel_token \
  | kubectl -n foreman-platform create secret generic cloudflared-tunnel-token --from-file=token=/dev/stdin
```

The token never touches a file.

## 10. Supabase role passwords as Secrets (new-credentials gate)

Create the login users for the `factory_api` and `factory_ingest` roles if they do not exist yet, then put each connection string into its Secret from the password manager:

```bash
kubectl -n foreman-platform create secret generic state-api-database --from-file=url=/dev/stdin
kubectl -n foreman-platform create secret generic github-receiver-database --from-file=url=/dev/stdin
kubectl -n foreman-platform create secret generic github-receiver-webhook-secret --from-file=value=/dev/stdin
```

The webhook secret is the one the runner App will use in step 13.

## 11. The DNS record (DNS gate)

Set `TF_VAR_publish_receiver_dns=true`, plan, and check the plan adds exactly one `cloudflare_dns_record` and changes nothing else. Then apply it.

## 11a. The planning chat's paths on the tunnel (tunnel gate, D-271, D-282)

This changes the tunnel's routing only: one more rule on the receiver's host name, for the planning chat's paths exactly (`/plans` and `/planning/projects/<slug>/{submissions,feedback,accepted}`), to the state API's public Service (`http://state-api-public.foreman-platform.svc.cluster.local:8081`). That port serves `POST /plans` and those three reads as `GET` and nothing else, with a 64 KiB size limit and 20 requests a minute (ADR 0102, O-83, D-282). No DNS record is added.

Set `TF_VAR_expose_planning_route=true`, plan, and check the plan changes only `cloudflare_zero_trust_tunnel_cloudflared_config.receiver`, adding exactly one ingress rule with `path = "^/(plans|planning/projects/[a-z0-9][a-z0-9-]{0,99}/(submissions|feedback|accepted))$"` before the 404 rule, and nothing else. Then apply it. Check from outside: `POST https://<receiver host name>/plans` and `GET https://<receiver host name>/planning/projects/<slug>/submissions` with no token answer 401, and `GET /plans`, `POST` on a read path and any other path answer 404. Only after step 15 creates the planning token does a submission go through.

## 12. The model key with a spend cap (new-credentials gate)

Create the Anthropic API key for agent runs with a monthly spending limit at the provider (D-143, D-185). Store it at its secret path in Windmill resources. The runner puts it only into each run's egress proxy Secret; no agent holds it.

The visual task types (`council:visual`, `qa:visual`) have no entry in `model_routing_policy` or `model_output_token_needs` yet, so a visual call or visual QA run is refused with `no_route` until they do. Once the vision model test at this step picks the model, add both entries with a reviewed migration, as 0019 did for the close runs.

## 13. The GitHub Apps (D-178)

Register the GitHub Apps of D-156 together, each with its own identity. The runner App's webhook URL is `https://<receiver host name>/github/webhook`, with the webhook secret from step 10. Their private keys stay with the runner, never on the cluster.

The runner App's permissions are the ones in D-127 plus two read-only ones from D-267: `contents: read` (the repo map's checkout) and `actions: read` (CI's screenshot bundles). Check the App's permission page shows nothing wider before installing it.

The Developer's and Designer's runs open their own pull requests with their run's token (D-235), and a cancelled item's close run comments on and closes one with the same token (D-318, O-98). Both need the Apps' pull request write permission and nothing more; check each App's permission page shows it, and nothing wider than the decisions name. Migration 0019 gives `developer:close` and `designer:close` their role's own route (D-324); if an operator removes those entries, each close run is refused with `no_route` and the daily check shows the pull request waiting for its close run.

In each project repository, protect builder branches against force pushes (a branch ruleset covering the runner's branch names), so the rule in the Developer's and Designer's instructions is also enforced by GitHub (D-245).

## 14. Set `agent_cluster_max_active_runs`

Size it to the agents pool: the node's allocatable CPU and memory divided by one run's requests (agent, proxy and, for QA, fetch pods together). Write it as the setting in the store. While it is unset, every dispatch is refused.

The repo map's Job (D-275 (2), O-87) is not a run and this setting does not count it: each map read for Triage adds two short-lived pods (the repo map Job and its proxy) in the project's agent namespace, bounded by the namespace's ResourceQuota. Leave room for them in the quota and on the node. The Scanner's stage 1 (O-92) uses the same Job in scan mode once a day per project, so it adds the same two pods for a few minutes each morning.

## 15. The Windmill workspace and the runner's credentials (new-credentials gate)

The flows (build plan M3.1) are written but not deployed. Each item is its own approval:

- The runner's database login, a user in the `factory_runner` role (ADR 0104), stored at `platform/state-store/runner-database-url` in Windmill resources.
- A Windmill token that can list the workspace's jobs, for the monthly execution count (D-167). Until it exists, the reconcile flow skips the alert check and says so.
- The planning chat's state API token (D-266). It lets the Council's planning chat submit a plan with `POST /plans` and read its submissions' status, Didi's feedback and the accepted plans, and nothing else (ADR 0102, D-282). Generate a long random value (at least 32 characters of letters, digits, `-` and `_`) in the password manager and keep it there. Put the value itself only into the planning chat's own settings. The state API holds only its SHA-256: store the hash at `platform/state-api/planning-token-sha256` in Windmill resources, and in the state API's Secret, piped straight in so neither value lands in a file or the shell history:

  ```bash
  # The token comes from the password manager's command line on stdin, with no trailing newline
  # (a newline changes the hash and the API then refuses the token). Only its hash goes on.
  sha256sum | cut -d' ' -f1 | tr -d '\n' \
    | kubectl -n foreman-platform create secret generic state-api-planning-token --from-file=sha256=/dev/stdin
  kubectl -n foreman-platform rollout restart deployment/state-api
  ```

  The Secret is optional for the state API's pod: until it exists, no planning token is accepted. The chat reaches the state API at `https://<receiver host name>/plans` once step 11a is applied (D-271). Its read routes are not reachable from outside (N-75).

- The three Windmill tokens that start flows (D-283, D-291, D-327, D-330, O-101, O-102), each its own approval. Before creating any of them, check on Windmill's token page ("Limit token permissions" and "Restrict paths") that a token can be limited to running exactly the scripts named below and nothing else: no other script, no reading or changing scripts, jobs, resources or variables. **If Windmill cannot narrow a token that far, stop and ask Didi before creating any credential** (D-283, D-291, D-330). Do not create a wider token, and do not use another kind of token (such as a webhook's own token) instead, without asking.
  - The state API's token: exactly the scope `jobs:run:scripts:f/foreman/plan_approval`, stored at `platform/state-api/windmill-plan-approval-token` in Windmill resources and in the Secret `state-api-windmill-plan-approval-token` (key `token`).
  - The GitHub receiver's token: exactly the scopes of its flow list (`RECEIVER_FLOW_PATHS` in `src/adapters/windmill/receiver-flows.ts`), today only `jobs:run:scripts:f/foreman/option_capture`, stored at `platform/github-receiver/windmill-token` in Windmill resources and in the Secret `github-receiver-windmill-token` (key `token`). A later slice that adds a flow to the list creates this token again with the new list (D-329).
  - The run watcher's token: exactly the scope of its flow list (`RUN_WATCHER_FLOW_PATHS` in `src/adapters/windmill/run-watcher-flows.ts`), only `jobs:run:scripts:f/foreman/record_run_end`, stored at `platform/run-watcher/windmill-token` in Windmill resources and in the Secret `run-watcher-windmill-token` (key `token`).

  Generate each token in Windmill, copy it into the password manager, and never paste its value anywhere else: not in a file, the shell history, chat, Linear or a log. Pipe it from the password manager's command line straight into its Secret:

  ```bash
  kubectl -n foreman-platform create secret generic state-api-windmill-plan-approval-token --from-file=token=/dev/stdin
  kubectl -n foreman-platform create secret generic github-receiver-windmill-token --from-file=token=/dev/stdin
  kubectl -n foreman-platform create secret generic run-watcher-windmill-token --from-file=token=/dev/stdin
  kubectl -n foreman-platform rollout restart deployment/state-api deployment/github-receiver deployment/run-watcher
  ```

  None of the three services reaches Windmill directly: all go through the Windmill proxy of step 7, which allows only `windmill.host`, and no pod's network policy allows them public 443 (D-284, D-328, D-330). Until a token exists its service refuses every start (`NotBuiltError`), logs `plan approval flow not started`, `option capture flow not started` or `run end flow not started` with the error's type, and the reconcile pass opens the request, captures the options or records the end. The run watcher's restart above then sends the run-end flow for every stopped run Job still present, once each. If the proxy is down, the services' starts fail the same way and the reconcile pass catches up. When usage grows, the proxy can run as several replicas behind its one Service (a change to `infra/kubernetes/platform.ts`, D-328).

Then write the Windmill binding in `flows/lib/windmill.ts` against Windmill's own client, and deploy the flows, schedule and values listed in `flows/windmill.yaml`.

The `agent_run_settings` value names the repo map Job's image (D-275 (2), O-87): build `src/agent-images/repo-map/Dockerfile` from the repo root, push it to the registry the agent images use, and put its reference pinned by digest in `repoMapImage`, with `resources.repoMap` (it unpacks an archive of up to 200 MiB in memory, so give it at least 1 GiB of memory) and `repoMapMaxMinutes` (5 to start). No new credential: the Job's only token is the runner App's `contents: read` token of step 13, minted per read. The same image serves the Scanner's stage 1 in scan mode (O-92), which also installs the YAML parser from the image's lockfile; nothing else changes. Deploying the flows creates the `f/foreman/scan` schedule (05:00 Toronto time). Migration 0017 (the `scans` table) is applied with the others, after Didi's review.

Then check the approval form on Didi's phone with a throwaway request, as the M0.4 spike did (D-170, D-254). Use a test request with made-up option names and no real data. Record with the date:

- The form shows three fields: Decision (Approve, Request changes, Reject, required), Options and Feedback, and the page's own cancel button is hidden (`hide_cancel`). Check the keys against Windmill's OpenFlow spec.
- The Options field's choices come from the request: the `ask` step returns Windmill's dynamic enums (`{enums: {options: [...]}}` from `approvalFormEnums`), and the page shows exactly the test request's option names, not an empty list and not another request's.
- How the Options field renders: as checkboxes, radio buttons or a dropdown, and whether it lets Didi pick more than one option (an array of strings with enum items should be a multi-select).
- That the optional size field ("this was a small tweak", D-278) can be left blank, and that leaving it blank sends nothing for it.
- Whether the page can show the option screenshots. The screenshots are linked in the approval message either way (D-254).
- An answer that breaks a rule (Approve with no option, Request changes with no feedback) records nothing and a fresh request opens with its one-line note.

If Windmill cannot fill the choices per request, stop and record what it does instead: the form's shape is Didi's decision (D-254), so a different form goes back to Didi.

### Starting flows from the state API and the receiver

The state API starts `f/foreman/plan_approval` after each recorded plan submission (D-283), and the receiver starts `f/foreman/option_capture` after it records CI's end on a design item's PR head, only when a capture is due (D-291, D-327). Both call `src/adapters/windmill/client.ts` through the Windmill proxy. Built from Windmill's docs as read on 2026-11-04, without a real Windmill. To verify at rehearsal, with synthetic data and the two tokens of step 15 only, and record each result with the date in O-101:

- The endpoint: `POST https://<windmill.host>/api/w/<workspace>/jobs/run/p/<script path>` starts the script pushed at that path and answers at once with the job's id. If the entries are deployed as flows rather than scripts, the endpoint is `.../jobs/run/f/<path>`: fix `RUN_BY_PATH_ENDPOINT` in `src/adapters/windmill/client.ts`.
- The arguments: each entry's `main(input)` takes one argument named `input`, so the body is `{"input": {"ideaId": "..."}}` or `{"input": {"nodeId": "..."}}`. Check that Windmill reads the entry's `main` (written `export const main = (input) => ...`) with that one argument, and that the run shows the id.
- The token: the run endpoint takes it as `Authorization: Bearer <token>`.
- The scopes: with each token, a start of its own script is accepted; a start of the other token's script, of any other script, and any other API call (for example listing jobs) are refused. Record the status Windmill gives a refusal (401 or 403).
- The answer: the status of an accepted start (201 is expected). The client accepts any 2xx and never reads the body.
- The proxy: the Windmill host resolves only to public addresses, over IPv4 (the proxy refuses private addresses, and its policy allows public IPv4 on 443). From the state API's and the receiver's pods, a direct HTTPS call to the Windmill host fails, a CONNECT through the proxy to it opens, and one to any other host is refused with 403. The proxy's log names the host and never a token.
- The timing: a start is accepted well inside the client's 5 seconds, so a webhook is still answered within GitHub's 10.
- The runs: each recorded submission and each due capture adds one run to the month's count (D-164); a replayed webhook, a pending CI result and a capture not due add none.
- The workspace id passes the manifest check (letters, digits, `-` and `_`, at most 50).

### Recording run ends with the run watcher

When a run's agent Job, or QA's fetch Job, stops for any reason, the run watcher starts `f/foreman/record_run_end` for that run, once per Job in each process (D-330, O-102). It lists, then watches, each agent namespace's run Jobs with its own ServiceAccount token, and reaches Windmill through the Windmill proxy with its token of step 15. Built from the Kubernetes API's documented list and watch, without a real cluster. To verify at rehearsal, in the rehearsal project with synthetic data only, and record each result with the date in O-102:

- The ends: a Job that finishes, one that crashes (its agent exits with an error), one past its deadline (it outlives `activeDeadlineSeconds`), one killed (`kubectl -n agents-<slug> delete pod <its agent pod>`) and one out of memory (a run over its memory limit) each start the run-end flow once, within a few seconds of the stop. Each run's end is then recorded with the outcome `poll` gives it, and its Job is deleted by the flow's cleanup.
- QA: a review run's fetch Job that succeeds starts the flow once and the review stage starts; one that fails records the run's end as a failed fetch step. A visual comparison run, which has no fetch step, starts the flow once at its end.
- Nothing else starts it: a running Job, a proxy Job and a repo map read start nothing. A run the kill switch cancels is recorded by the cancel-runs flow, and the watcher starts nothing for it.
- A restart: with one run's end recorded and its Job cleaned up, and one stopped Job left unrecorded (for example while the token did not exist yet), `kubectl -n foreman-platform rollout restart deployment/run-watcher` starts the flow for the unrecorded Job only. The month's count of runs goes up by exactly one.
- The watch: it stays open past the API server's 5-minute time limit by resuming without a new list, and after a 410 or a dropped connection it lists again without starting any Job a second time (the count of runs does not move).
- The RBAC: the `kubectl auth can-i` checks of step 7 answer as written there. From the watcher's pod, with its own token, listing Jobs in an agent namespace works; listing Pods, reading a pod's log, reading or listing Secrets, deleting a Job, and listing Jobs in `foreman-platform`, `default` or all namespaces are each refused with 403.
- The token mount: only the watcher's pod has `/var/run/secrets/kubernetes.io/serviceaccount`; the state API's, the receiver's, the connector's and the proxy's pods have none.
- The network: the watcher's pod becomes Ready with no ingress rule (the kubelet's probe comes from the node). From it, `https://kubernetes.default.svc` answers with the mounted CA through the `kubernetesApi` rule only; a direct HTTPS call to Windmill's host, and a call to any other address on the API server's port, fail; a CONNECT through the Windmill proxy to Windmill's host opens. If DOKS's network policies do not let the watcher reach the API server with that one rule, stop and ask Didi: no wider rule is added without asking.
- The address: whether the `kubernetes` EndpointSlice's address changes after a control-plane upgrade. If it does, render and apply again with the new `kubernetesApi`.
- The run budget: each stopped run adds one run to the month's count, and a QA review run two (its fetch step and its review) (D-164). The watcher adds no other run.
- The logs: a refused start logs `run end flow not started` with the step and the status only, and `run end flow start failed; trying again` before it. No line shows a run id, a Job's name or a token.
- The token: with its one scope, a start of `f/foreman/record_run_end` is accepted, and a start of any other script and any other call are refused.

### Reading the daily check

The daily check is a page Didi opens, with no alert (D-319, D-320, O-100). It is the result of the `f/foreman/daily_check` flow's own run, behind Windmill's sign-in. On the phone, signed in to Windmill, open the flow's run list (its runs in the workspace's runs page, filtered to `f/foreman/daily_check`), bookmark it, and tap the latest run each morning after 06:00 Toronto time. The run's result shows the check as a page, then the check as JSON and as plain text.

To verify at rehearsal, with a check built from synthetic data only, and record each result with the date in O-100:

- The address of the flow's run list to bookmark (Windmill's runs page filtered to `f/foreman/daily_check`), and that the latest run comes first.
- That Windmill renders the result as the page and then the JSON: a result whose only key is `render_all` holding an `html` view and a `json` view. If it shows only JSON, record what it does instead.
- Whether Windmill sanitizes the page's HTML, and what it strips. The page needs only `div`, `section`, `h2` to `h4`, `p`, `ul`, `li`, `a` and inline `style`.
- Whether the links can be tapped and where they open: the staging address (`https:` only), and each held item's link to the fresh release request page.
- Whether that relative link, `/scripts/get/f/foreman/hold_release_request`, resolves to the Windmill origin and opens the right page signed in, and whether it needs the workspace (`?workspace=<id>`). If the entry is deployed as a flow rather than a script, the page may be `/flows/get/...` instead: fix `HOLD_RELEASE_REQUEST_PAGE` in `flows/lib/held-items.ts`.
- Whether the page fills in the item's id. It is not relied on: the page shows the flow's path and the input (`{"nodeId": "..."}`) beside each link, so Didi can type or paste it.
- That the page reads well on Didi's phone, in light and dark mode, with no sideways scrolling.

## Verification

Run the remaining checks in ADR 0106 "How success is judged" on the real cluster, and record their output and date in the M3.2 PR. Never paste a secret value, `plan.json` or `state.json`.
