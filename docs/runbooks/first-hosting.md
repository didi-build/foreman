# First hosting runbook

**Purpose:** the gates Didi passes, in order, to bring up the agent and platform cluster, the state API, the GitHub receiver and its tunnel, and the run watcher, for the first time (ADR 0106, ADR 0110, D-183 to D-195, D-330). Nothing here has been done yet. No agent or runner does any step.

Since D-339, the admin work runs as GitHub Actions jobs that wait for Didi's approval, not from a terminal: Didi creates each credential at its provider, pastes it once into GitHub's secret form for the environment named here, reads each plan in its job's summary, and approves the job that applies it. Three workflows do the work (O-105):

| Workflow                                          | What it does                                                                                                                                                                                                          | Jobs, with their environment                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Images (`.github/workflows/images.yml`)           | Builds the seven images from main and pushes them to `ghcr.io/didi-build` (D-336). Gives each reference pinned by digest.                                                                                             | `build-and-push` (no environment, `packages: write`)                                                                                     |
| Infra apply (`.github/workflows/infra-apply.yml`) | Plans the factory stack and, once Didi approves, applies that exact saved plan. Steps 5, 11 and 11a, and every later infrastructure change.                                                                           | `tofu-plan` (`infra-plan`), `tofu-apply` (`infra`, Didi approves)                                                                        |
| Platform (`.github/workflows/platform.yml`)       | Renders the settings file, diffs it against the cluster and, once Didi approves, applies it and runs the checks; sets the cluster's Secrets. Steps 7, 9 and 10, the cluster Secrets of step 15, and adding a project. | `cluster-facts` and `kubectl-diff` (`platform-plan`), `render` (none), `kubectl-apply` and `cluster-secrets` (`platform`, Didi approves) |

**Rules for every step**

- Never paste a secret value into a file in the repo, a chat, Linear or a log. Paste each one only into GitHub's secret form for its environment (step 3), or into the provider's or Windmill's own form where a step says so. What must be kept goes into the project's Bitwarden vault (D-341): the state encryption passphrase, the providers' logins and two-factor recovery codes, and the planning chat's token. A secret that can be made again at its provider is not kept anywhere else.
- Each gate is approved once, for that one request. Approving a job approves the plan or the diff its summary shows, and nothing more.
- The jobs run only from main. The repository is public, so their logs and summaries are public pages: they show names, counts and plans, with account, zone and resource ids, the receiver's host name and the state bucket replaced by placeholders, and never a secret value (O-105).
- Every `tofu` command the jobs run passes `-input=false` (`infra/README.md`).

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

Read on DigitalOcean's own pages on 2026-11-06 (details in `docs/costs.md` section 1): DOKS is available in `tor1`; the control plane is free (high availability is 40 a month, not used); `s-2vcpu-4gb` is 24 a month with 4,000 GiB of transfer, pooled across nodes, so two nodes are 48; block storage is 0.10 per GiB a month, from 1 GiB, charged hourly while a volume exists. Kubernetes 1.34 left DigitalOcean's support on 2026-10-27 and new clusters can use only the three newest minor releases, so step 5 uses 1.37 (supported until 2027-10-28). Approved by Didi on 2026-11-06: up to 60 a month on DigitalOcean, with the billing alert at 60 (D-337). The images go to GitHub Container Registry as public images, free (D-336).

## 2. DigitalOcean account and spend approval

Spending money gate. Open or confirm the DigitalOcean account, set a billing alert at the approved monthly amount (60, D-337), and record the approval with its date.

## 3. Credentials and the GitHub environments

New-credentials gate, one approval per credential. Creating an account or a paid plan is its own gate, and none is needed here.

### The four environments

In the repository's settings (Settings, Environments), create these four environments. Each one keeps its own secrets, and GitHub gives them only to a job that names the environment and runs from main.

| Environment     | Required reviewers | Deployment branches            | What runs there                                                                          |
| --------------- | ------------------ | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `infra-plan`    | none               | Selected branches: `main` only | The Infra apply workflow's plan (`tofu-plan`)                                            |
| `infra`         | Didi               | Selected branches: `main` only | The infrastructure apply (`tofu-apply`)                                                  |
| `platform-plan` | none               | Selected branches: `main` only | The Platform workflow's cluster read and diff (`cluster-facts`, `kubectl-diff`)          |
| `platform`      | Didi               | Selected branches: `main` only | The platform apply and its checks (`kubectl-apply`), and the Secrets (`cluster-secrets`) |

For `infra` and `platform`, Didi is the only required reviewer. Leave "Prevent self-review" off: Didi starts most runs and is also the one who approves them. Set no wait timer. Set up all four, with these rules, before pasting any secret into one: a run that names an environment that does not exist yet creates it with no protection rule. Until the secrets are there, the jobs stop for want of one before they reach any account, and nothing is applied. Put none of these values in the repository's own secrets: any workflow on any branch could read those, which D-339 rules out.

### The credentials and where each one goes

Create each credential at its provider, then paste it once into the secret of each environment the table names for it (GitHub keeps each environment's secrets apart, so a value two environments need is pasted into both, N-88). The value is never shown again.

- A DigitalOcean API token with the narrowest scopes that can create a Kubernetes cluster, its node pools and a firewall, and read the cluster's credentials (`doctl kubernetes cluster kubeconfig`, D-340). Check on DigitalOcean's token form which scopes that is, and record them here with the date.
- A Cloudflare API token for the `didi.build` zone and account, allowed to edit Cloudflare Tunnels and DNS.
- The R2 state bucket's access key and secret, a token for that bucket only, as in ADR 0110.
- The state encryption passphrase, at least 16 characters, generated in Bitwarden and kept there (D-341): losing it makes the state unreadable.

The later steps add the database URLs and the webhook secret (step 10) and the planning token and the three Windmill tokens (step 15).

| Environment              | Secret                        | Where it comes from                                                                            | Step |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| `infra-plan` and `infra` | `DIGITALOCEAN_TOKEN`          | The DigitalOcean API token above                                                               | 3    |
| `infra-plan` and `infra` | `CLOUDFLARE_API_TOKEN`        | The Cloudflare API token above                                                                 | 3    |
| `infra-plan` and `infra` | `R2_STATE_ACCESS_KEY_ID`      | The R2 state bucket token's access key id                                                      | 3    |
| `infra-plan` and `infra` | `R2_STATE_SECRET_ACCESS_KEY`  | The R2 state bucket token's secret access key                                                  | 3    |
| `infra-plan` and `infra` | `STATE_ENCRYPTION_PASSPHRASE` | The passphrase in Bitwarden                                                                    | 3    |
| `platform-plan`          | `DIGITALOCEAN_TOKEN`          | The same DigitalOcean API token                                                                | 3    |
| `platform`               | `DIGITALOCEAN_TOKEN`          | The same DigitalOcean API token                                                                | 3    |
| `platform`               | `R2_STATE_ACCESS_KEY_ID`      | The same R2 access key id (the Secrets job reads the tunnel token from the state)              | 3    |
| `platform`               | `R2_STATE_SECRET_ACCESS_KEY`  | The same R2 secret access key                                                                  | 3    |
| `platform`               | `STATE_ENCRYPTION_PASSPHRASE` | The same passphrase                                                                            | 3    |
| `platform`               | `STATE_API_DATABASE_URL`      | The connection string of the `factory_api` login user, from Supabase                           | 10   |
| `platform`               | `RECEIVER_DATABASE_URL`       | The connection string of the `factory_ingest` login user, from Supabase                        | 10   |
| `platform`               | `RECEIVER_WEBHOOK_SECRET`     | A long random value from Bitwarden's generator, also pasted into the runner App's webhook form | 10   |
| `platform`               | `PLANNING_TOKEN`              | The planning chat's token, kept in Bitwarden                                                   | 15   |
| `platform`               | `STATE_API_WINDMILL_TOKEN`    | The Windmill token that runs only `f/foreman/plan_approval`                                    | 15   |
| `platform`               | `RECEIVER_WINDMILL_TOKEN`     | The Windmill token that runs only the receiver's three flows                                   | 15   |
| `platform`               | `RUN_WATCHER_WINDMILL_TOKEN`  | The Windmill token that runs only `f/foreman/record_run_end`                                   | 15   |

The plain settings are environment variables, not secrets (Settings, Environments, the environment, Environment variables). They are checked against their own pattern before any job uses them, and masked in the logs.

| Environment                          | Variable                | Value                                                                                             |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------- |
| `infra-plan`, `infra` and `platform` | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account id of the `didi.build` zone and of the R2 state bucket (32 hex characters) |
| `infra-plan`, `infra` and `platform` | `STATE_BUCKET`          | The R2 state bucket's name                                                                        |
| `infra-plan` and `infra`             | `CLOUDFLARE_ZONE_ID`    | The `didi.build` zone id (32 hex characters)                                                      |
| `infra-plan` and `infra`             | `RECEIVER_HOSTNAME`     | `foreman.didi.build`, the cluster's one public host name (D-343)                                  |

A secret only the cluster Secrets job reads (the rows of steps 10 and 15) can be removed from the environment once its run has put it in the cluster: the job then leaves that Secret as it is and names it as skipped (step 9).

## 4. Decide the API endpoint allow-list (D-189)

Check whether Windmill Cloud's outbound addresses are fixed. If they are, put them and Didi's address in `api_allowed_addresses`. If not, leave it empty: the runner's RBAC-limited token is the protection.

Checked 2026-11-06: Windmill publishes no list of Windmill Cloud's outbound addresses in its documentation or pricing pages, and its community forum points users to support for a workspace's current addresses, which may change. Decided by Didi on 2026-11-06 (D-338): leave `api_allowed_addresses` empty, and revisit once Windmill is self-hosted in the cluster.

## 5. Create the cluster and the tunnel with the Infra apply workflow

The cluster is the spending gate of step 2. The tunnel creates a new credential, its token: a new-credentials gate.

1. Check the reviewed variables in `infra/stacks/factory/production.tfvars`: `kubernetes_version_prefix` is a version DigitalOcean lists as supported (1.37 on 2026-11-06), `publish_receiver_dns = false` and `expose_planning_route = false`. Any change to them is a pull request Didi reviews. Check that `RECEIVER_HOSTNAME` in the `infra-plan` and `infra` environments is `foreman.didi.build` (D-343): the cluster's one public door, a single-level name that Cloudflare's free certificate covers. Every path the tunnel forwards on it is under `/api` (the webhook at `/api/github/webhook`, the planning chat's paths at step 11a), and every other path gets the tunnel's 404.
2. Start the Infra apply workflow on main (Actions, Infra apply, Run workflow). A push to main that changes `infra/stacks/factory/` or `infra/modules/` starts it too.
3. Its `tofu-plan` job (environment `infra-plan`) runs `tofu init -input=false -lockfile=readonly` against the R2 state and `tofu plan -input=false -var-file=production.tfvars`. Before anything is published it runs the secret-value scan of `infra/README.md` on the plan text and the plan's own output, for the DigitalOcean and Cloudflare tokens, the R2 secret, the passphrase and, once a tunnel exists, the tunnel token. If any is found the job stops and publishes nothing.
4. Read the plan in the `tofu-plan` job's summary: the counts, the gates the plan touches, each resource that changes and the full plan as `tofu show -no-color` prints it. For this first apply: no DNS record yet, one cluster, one more node pool, one firewall, one tunnel and its routing. Values marked sensitive show as `(sensitive value)`; ids, the receiver's host name and the state bucket show as placeholders, because the page is public.
5. If the plan is what is expected, approve the `tofu-apply` job (environment `infra`). It applies the saved plan file and nothing else, then runs the same scan on the apply's output, and on the state (piped from `tofu state pull`, never written to a file) for every secret value but the tunnel token, which the state holds by design (step 0). If the state changed since the plan, OpenTofu refuses the stale plan: start the workflow again. If the plan is not what is expected, reject the job, and nothing changes.

The encrypted plan file is kept for one day: approve within a day, or start the workflow again.

**The managed worker firewall (D-331).** Once the cluster exists, read the firewall DOKS made for the worker nodes in the DigitalOcean control panel's Networking page, and its outbound rules. Read it only: never edit it, and add no deny rule, because DigitalOcean's reconciler owns that firewall by name. If it allows all outbound traffic, our cloud firewall's outbound rules take no effect and the network policies and egress proxies are the only outbound control; if its outbound rules are narrower, ours stay as a second layer. Record which, with the date, here:

- Result: not checked yet.

## 6. No admin kubeconfig is kept (D-340, revising D-188)

Didi downloads and keeps no kubeconfig. Each job that reaches the cluster fetches its own short-lived admin credential with the DigitalOcean token (`doctl kubernetes cluster kubeconfig show foreman --expiry-seconds <the job's time limit in seconds>`, 10 to 20 minutes), masks its token in the log, and removes the file at the job's end; GitHub then discards the runner. The credential never goes to the runner, an agent or Windmill. doctl and DigitalOcean's API set no shortest expiry, so each job asks for its own time limit (O-105). The provider's own credential in the state (D-332, step 0) is unchanged.

## 7. Apply the cluster's standing objects with the Platform workflow

The settings file is `infra/kubernetes/settings/production.json`, in the repository and reviewed like code. It holds no secret: images pinned by digest, the app logins, resource limits (`databasePort` defaults to 5432), the projects and their quotas, and the Windmill host and workspace. The committed file leaves empty what first hosting fills in, so the render refuses it, naming the first setting at fault, until it is filled in one pull request:

- `images.stateApi`, `images.receiver`, `images.egressProxy` and `images.runWatcher`: the references the Images workflow gives, pinned by digest. It runs on each push to main that changes `src/`, or by hand (Actions, Images, Run workflow), and its job summary and its artifact `foreman-images` (`settingsFile.platform.images`) give the four references in this file's shape. `images.egressProxy` is the egress proxy image the agent runs use, the same digest as `proxyImage` in `agent_run_settings`; it runs once more here as the shared Windmill proxy (D-284, D-328). `images.runWatcher` is the run watcher's image (D-330), built from `src/run-watcher/Dockerfile`.
  - The first time, set each of the seven packages the Images workflow pushed (`foreman-agent-opencode`, `foreman-agent-claude-api`, `foreman-repo-map`, `foreman-egress-proxy`, `foreman-state-api`, `foreman-github-receiver`, `foreman-run-watcher`) to public in the organization's Packages page (each package's settings, Change visibility), as D-336 decided. Each image holds only code: the workflow passes no build argument or build secret.
- `resources`: the requests and limits of each platform pod. The file starts every pod at 100m CPU, 128 MiB of memory and 64 MiB of scratch space requested, with limits of 500m, 512 MiB and 256 MiB (O-105). `resources.windmillProxy` is like an agent run's proxy, and `resources.runWatcher` like the receiver's (it holds a few watches open and does little else). Check them against the platform node's allocatable at the first apply.
- `windmill.host`: the Windmill host the state API, the receiver and the run watcher start their flows on, a plain host name with no scheme (for Windmill Cloud, the host name of its app), and `windmill.workspace`: the workspace id. If the workspace does not exist yet, choose its id now and create it with that id in step 15. Both are plain settings, not secrets. The proxy allows this one host and nothing else; it has no model provider, no state API route and no credential.
- `receiver`: the Developer and Designer Apps' logins and the runner App's slug, the names the Apps get in step 13.
- `projects`: each project's slug and quota (see "Adding a project" below).

`kubernetesApi`, where the run watcher reaches the API server as its network policy allows it, is not in the file. A policy sees the address the `kubernetes` Service sends to, not the Service's own, so the Platform workflow's `cluster-facts` job reads the address and port from that Service's EndpointSlice at each run, as this command did by hand:

```bash
kubectl -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*]}{.endpoints[*].addresses}{" "}{.ports[*].port}{"\n"}{end}'
```

It accepts plain IPv4 addresses and one port only, and stops otherwise. The watcher's policy allows exactly these and nothing else on that port. An address that changes after a control-plane upgrade is picked up by the next run's plan, as a change to the run watcher's network policy.

Once the pull request is merged, the Platform workflow runs (or start it by hand: Actions, Platform, Run workflow):

1. `cluster-facts` (environment `platform-plan`) fetches a short-lived credential and reads the address above.
2. `render` (no environment and no secret: the only job that runs the repository's TypeScript) renders the settings file with that address (`node infra/kubernetes/render.ts`) into one list of objects, kept as an artifact for one day. It stops if the list holds a Secret.
3. `kubectl-diff` (environment `platform-plan`) runs `kubectl diff --server-side` against the cluster. Read its summary before approving: each object to create or change by action, kind, namespace and name, and the images in the render. It prints no object's content, so no field of a live object reaches the public log. An object in a namespace that does not exist yet is listed as created. Nothing is ever deleted: a project taken out of the settings keeps its namespace until Didi decides how it goes (a drop-data gate).
4. If the summary is what is expected, approve `kubectl-apply` (environment `platform`). It applies exactly the objects the plan read, with `kubectl apply --server-side`, then runs the checks below and writes each answer to its summary. It runs only when the plan found a change.

This creates the `foreman-platform` namespace and its policies and Deployments (the state API, the receiver, the tunnel connector, the Windmill proxy and the run watcher), the run watcher's ServiceAccount `run-watcher` there, the `foreman-runner` namespace and service account, and each `agents-<slug>` namespace. The platform pods wait for their Secrets (steps 9, 10 and 15). The apply job then runs ADR 0106 checks 1 and 15: default deny holds (a probe pod with no allow policy, in the platform namespace and in each agent namespace, reaches neither cluster DNS, a public address on 443, nor the API server), and pods stay on their own pool (each probe lands on its pool, platform pods run on platform nodes, agent nodes carry the `NoSchedule` taint).

Each `agents-<slug>` namespace also gets the run watcher's RBAC (D-330), next to the runner's: a Role `run-watcher` with get, list and watch on `batch` Jobs and nothing else, and a RoleBinding that gives it to the ServiceAccount `run-watcher` in `foreman-platform`. There is no ClusterRole or ClusterRoleBinding, so the watcher holds nothing in any other namespace. These are the rights Didi approved in D-330, exactly: if a plan or a render shows any other right for `run-watcher`, stop and ask Didi before approving the apply. The apply job checks them with its short-lived credential, and fails, asking for Didi, if any answer differs:

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

It asks the same of the runner's account (`system:serviceaccount:foreman-runner:foreman-runner`), the `can-i` half of ADR 0106 check 4: in each agent namespace it may create Jobs, read pod logs and create Secrets, and it may not get or list Secrets, create Pods, Roles or RoleBindings; it may create nothing in `foreman-platform`, no namespace, ClusterRole or ClusterRoleBinding, and list no Secrets across namespaces.

### Adding a project

A pull request that adds the project to `projects` in the settings file, with its slug and quota. Once it is merged, the Platform workflow's plan shows the new `agents-<slug>` namespace with both Roles, and the run watcher's Deployment changed (its `AGENT_NAMESPACES` gains the namespace, which restarts the watcher). Didi approves the apply, and its checks then cover the new namespace too. The project's own credentials and its first runs stay as their own steps.

## 8. The runner's cluster token (new-credentials gate)

This step stays by hand for now (O-105, N-89). The token goes into Windmill resources, outside the cluster, and a job could take it there only by printing it, which is never done, or with a new Windmill credential that can write resources, held in GitHub: a wider credential than any decision names. Until Didi decides N-89:

Create a token for the `foreman-runner` service account with a short-lived admin credential of its own (`doctl kubernetes cluster kubeconfig show foreman --expiry-seconds 900`, with doctl signed in for this step only, written to a file only for these commands and deleted after), and store it at `platform/agent-cluster/runner-token` in Windmill resources through Windmill's own form, never anywhere else. Store the cluster's endpoint and CA certificate as plain settings: the `server` and `certificate-authority-data` of that credential, the same values as the factory stack's outputs `cluster_endpoint` and `cluster_ca_certificate`. The Platform workflow's apply job runs the `can-i` half of ADR 0106 check 4 (RBAC) after each apply; the half with the token itself (creating a Job in `agents-<slug>` works, and the refused calls are refused) is checked at rehearsal.

## 9. The tunnel token Secret and the cluster Secrets job

The Platform workflow's `cluster-secrets` job (environment `platform`, Didi approves) creates or updates every Secret the platform pods read. Start it by hand: Actions, Platform, Run workflow, with "Also create or update the cluster's Secrets" checked. It runs after the plan and the apply of the same run, and only if both passed or the apply had nothing to do.

For the tunnel token it runs `tofu output -raw receiver_tunnel_token` against the factory stack's state in the same job, into a shell variable that is masked and never printed, and pipes it into the Secret:

```bash
printf '%s' "$RECEIVER_TUNNEL_TOKEN" \
  | kubectl -n foreman-platform create secret generic cloudflared-tunnel-token --from-file=token=/dev/stdin \
      --dry-run=client -o json \
  | kubectl apply --server-side --force-conflicts --field-manager=foreman-cluster-secrets -f -
```

Every other Secret goes in the same way, from its environment secret. The token never touches a file, an argument or the log. The job's summary names each Secret as created or updated, already up to date, skipped (its environment secret is empty, and the Secret is left as it is, which is not a failure), or refused (a value with a space or a newline at either end, or a planning token outside the state API's own rule, never shown); a refused Secret fails the run. It then restarts each deployment whose Secret changed and waits up to 3 minutes for it, naming any that is not ready.

## 10. Supabase role passwords as Secrets (new-credentials gate)

Create the login users for the `factory_api` and `factory_ingest` roles if they do not exist yet, then paste each connection string into its `platform` environment secret, and generate the webhook secret in Bitwarden's generator:

| Environment secret        | Secret in `foreman-platform`     | Key     |
| ------------------------- | -------------------------------- | ------- |
| `STATE_API_DATABASE_URL`  | `state-api-database`             | `url`   |
| `RECEIVER_DATABASE_URL`   | `github-receiver-database`       | `url`   |
| `RECEIVER_WEBHOOK_SECRET` | `github-receiver-webhook-secret` | `value` |

Then run the cluster Secrets job (step 9). The webhook secret is the one the runner App will use in step 13: paste the same value into the App's webhook form there. It can be made again at any time by setting a new value in both places.

## 11. The DNS record (DNS gate)

A pull request sets `publish_receiver_dns = true` in `infra/stacks/factory/production.tfvars`. Once it is merged, the Infra apply workflow plans: check that the summary's gates name exactly one DNS change, and that the plan adds exactly one `cloudflare_dns_record` (the proxied CNAME for `foreman.didi.build`, which the summary shows as its placeholder) and changes nothing else. Then approve the apply.

## 11a. The planning chat's paths on the tunnel (tunnel gate, D-271, D-282, D-343)

This changes the tunnel's routing only: one more rule on the receiver's host name `foreman.didi.build`, for the planning chat's paths exactly (`/api/plans` and `/api/planning/projects/<slug>/{submissions,feedback,accepted}`, D-343), to the state API's public Service (`http://state-api-public.foreman-platform.svc.cluster.local:8081`). That port serves `POST /api/plans` and those three reads as `GET` and nothing else, with a 64 KiB size limit and 20 requests a minute (ADR 0102, O-83, D-282, O-106). No DNS record is added.

A pull request sets `expose_planning_route = true` in `infra/stacks/factory/production.tfvars`. Once it is merged, check the plan changes only `cloudflare_zero_trust_tunnel_cloudflared_config.receiver`, adding exactly one ingress rule with `path = "^/api/(plans|planning/projects/[a-z0-9][a-z0-9-]{0,99}/(submissions|feedback|accepted))$"` before the 404 rule, and nothing else. Then approve the apply. Check from outside: `POST https://foreman.didi.build/api/plans` and `GET https://foreman.didi.build/api/planning/projects/<slug>/submissions` with no token answer 401; `GET /api/plans`, `POST` on a read path, the old paths without `/api` (`POST /plans`, `GET /planning/projects/<slug>/submissions`) and any other path answer 404. Only after step 15 creates the planning token does a submission go through.

## 12. The model key with a spend cap (new-credentials gate)

Create the Anthropic API key for agent runs with a monthly spending limit at the provider (D-143, D-185): 50 USD a month for the rehearsal period (D-342). The first rehearsal runs on Anthropic only. Store it at its secret path in Windmill resources. The runner puts it only into each run's egress proxy Secret; no agent holds it.

The visual task types (`council:visual`, `qa:visual`) have no entry in `model_routing_policy` or `model_output_token_needs` yet, so a visual call or visual QA run is refused with `no_route` until they do. Once the vision model test at this step picks the model, add both entries with a reviewed migration, as 0019 did for the close runs.

## 13. The GitHub Apps (D-178)

Register the GitHub Apps of D-156 together, each with its own identity. The runner App's webhook URL is `https://foreman.didi.build/api/github/webhook` (D-343), with the webhook secret from step 10. It is the receiver's one path: any other path on the host name, the old `/github/webhook` included, answers 404. Their private keys stay with the runner, never on the cluster.

The runner App's permissions are the ones in D-127 plus two read-only ones from D-267: `contents: read` (the repo map's checkout) and `actions: read` (CI's screenshot bundles). Check the App's permission page shows nothing wider before installing it.

The Developer's and Designer's runs open their own pull requests with their run's token (D-235), and a cancelled item's close run comments on and closes one with the same token (D-318, O-98). Both need the Apps' pull request write permission and nothing more; check each App's permission page shows it, and nothing wider than the decisions name. Migration 0019 gives `developer:close` and `designer:close` their role's own route (D-324); if an operator removes those entries, each close run is refused with `no_route` and the daily check shows the pull request waiting for its close run.

In each project repository, protect builder branches against force pushes (a branch ruleset covering the runner's branch names), so the rule in the Developer's and Designer's instructions is also enforced by GitHub (D-245).

The admin workflows' four environments send deployment events like any other; the receiver acts only on deployments to `staging` (O-104), so it records theirs as deliveries and starts nothing.

## 14. Set `agent_cluster_max_active_runs`

Size it to the agents pool: the node's allocatable CPU and memory divided by one run's requests (agent, proxy and, for QA, fetch pods together). Write it as the setting in the store. While it is unset, every dispatch is refused.

The repo map's Job (D-275 (2), O-87) is not a run and this setting does not count it: each map read for Triage adds two short-lived pods (the repo map Job and its proxy) in the project's agent namespace, bounded by the namespace's ResourceQuota. Leave room for them in the quota and on the node. The Scanner's stage 1 (O-92) uses the same Job in scan mode once a day per project, so it adds the same two pods for a few minutes each morning.

## 15. The Windmill workspace and the runner's credentials (new-credentials gate)

The flows (build plan M3.1) are written but not deployed. Each item is its own approval:

- The runner's database login, a user in the `factory_runner` role (ADR 0104), stored at `platform/state-store/runner-database-url` in Windmill resources.
- A Windmill token that can list the workspace's jobs, for the monthly execution count (D-167). Until it exists, the reconcile flow skips the alert check and says so.
- The planning chat's state API token (D-266). It lets the Council's planning chat submit a plan with `POST /api/plans` and read its submissions' status, Didi's feedback and the accepted plans with `GET /api/planning/projects/<slug>/{submissions,feedback,accepted}`, and nothing else (ADR 0102, D-282, D-343). Generate a long random value (at least 32 characters of letters, digits, `-` and `_`) in Bitwarden and keep it there (D-341). Put the value itself into the planning chat's own settings and into the `platform` environment secret `PLANNING_TOKEN`, and nowhere else. The state API holds only its SHA-256: the cluster Secrets job (step 9) makes it exactly as this step did by hand, the token with no trailing newline (a newline changes the hash and the API then refuses the token), through `sha256sum`, the hex only with no newline, piped straight into the Secret:

  ```bash
  printf '%s' "$PLANNING_TOKEN" | sha256sum | cut -d' ' -f1 | tr -d '\n' \
    | kubectl -n foreman-platform create secret generic state-api-planning-token --from-file=sha256=/dev/stdin \
        --dry-run=client -o json \
    | kubectl apply --server-side --force-conflicts --field-manager=foreman-cluster-secrets -f -
  ```

  The hash is masked and never printed, so the job cannot copy it to `platform/state-api/planning-token-sha256` in Windmill resources, where `flows/windmill.yaml` lists it as a kept copy that no flow reads: N-90 asks whether that copy is still kept. The job refuses a token outside the rule above, by name. Then it restarts the state API. The Secret is optional for the state API's pod: until it exists, no planning token is accepted. Once step 11a is applied, the chat's address is `https://foreman.didi.build/api` (D-271, D-282, D-343): it submits at `https://foreman.didi.build/api/plans` and reads at `https://foreman.didi.build/api/planning/projects/<slug>/{submissions,feedback,accepted}`, with the token as a bearer token in the `Authorization` header, never in the address.

- The three Windmill tokens that start flows (D-283, D-291, D-327, D-330, O-101, O-102), each its own approval. Before creating any of them, check on Windmill's token page ("Limit token permissions" and "Restrict paths") that a token can be limited to running exactly the scripts named below and nothing else: no other script, no reading or changing scripts, jobs, resources or variables. **If Windmill cannot narrow a token that far, stop and ask Didi before creating any credential** (D-283, D-291, D-330). Do not create a wider token, and do not use another kind of token (such as a webhook's own token) instead, without asking.
  - The state API's token: exactly the scope `jobs:run:scripts:f/foreman/plan_approval`, stored at `platform/state-api/windmill-plan-approval-token` in Windmill resources and, through the `platform` environment secret `STATE_API_WINDMILL_TOKEN`, in the Secret `state-api-windmill-plan-approval-token` (key `token`).
  - The GitHub receiver's token: exactly the scopes of its flow list (`RECEIVER_FLOW_PATHS` in `src/adapters/windmill/receiver-flows.ts`), the three scopes `jobs:run:scripts:f/foreman/option_capture`, `jobs:run:scripts:f/foreman/advance_item` and `jobs:run:scripts:f/foreman/verify_staging` (D-329, O-101, O-104), stored at `platform/github-receiver/windmill-token` in Windmill resources and, through the `platform` environment secret `RECEIVER_WINDMILL_TOKEN`, in the Secret `github-receiver-windmill-token` (key `token`). A token made earlier with only the first scope is made again with all three, and the old one revoked.
  - The run watcher's token: exactly the scope of its flow list (`RUN_WATCHER_FLOW_PATHS` in `src/adapters/windmill/run-watcher-flows.ts`), only `jobs:run:scripts:f/foreman/record_run_end`, stored at `platform/run-watcher/windmill-token` in Windmill resources and, through the `platform` environment secret `RUN_WATCHER_WINDMILL_TOKEN`, in the Secret `run-watcher-windmill-token` (key `token`).

  Generate each token in Windmill and paste it only into Windmill's resource form at its path and into its `platform` environment secret: never into a file, the shell history, chat, Linear or a log. Each can be made again in Windmill, so it need not be kept in Bitwarden (D-341). Then run the cluster Secrets job (step 9), which puts each one into its Secret through stdin and restarts `state-api`, `github-receiver` and `run-watcher` as their Secrets change.

  None of the three services reaches Windmill directly: all go through the Windmill proxy of step 7, which allows only `windmill.host`, and no pod's network policy allows them public 443 (D-284, D-328, D-330). Until a token exists its service refuses every start (`NotBuiltError`), logs `plan approval flow not started`, `option capture flow not started`, `advance flow not started`, `staging flow not started` or `run end flow not started` with the error's type, and the reconcile pass opens the request, captures the options, advances the item, verifies staging or records the end. The run watcher's restart above then sends the run-end flow for every stopped run Job still present, once each. If the proxy is down, the services' starts fail the same way and the reconcile pass catches up. When usage grows, the proxy can run as several replicas behind its one Service (a change to `infra/kubernetes/platform.ts`, D-328).

Then write the Windmill binding in `flows/lib/windmill.ts` against Windmill's own client, and deploy the flows, schedule and values listed in `flows/windmill.yaml`.

The `agent_run_settings` value names the repo map Job's image (D-275 (2), O-87): the Images workflow builds `src/agent-images/repo-map/Dockerfile` from the repo root and pushes it to GitHub Container Registry as `foreman-repo-map`, public (D-336). Put its reference pinned by digest (the artifact `foreman-images`, `windmill.agent_run_settings.repoMapImage`) in `repoMapImage`, with `resources.repoMap` (it unpacks an archive of up to 200 MiB in memory, so give it at least 1 GiB of memory) and `repoMapMaxMinutes` (5 to start). The same artifact gives `agent_images` (`opencode` and `claude-api`) and `proxyImage`. No new credential: the Job's only token is the runner App's `contents: read` token of step 13, minted per read. The same image serves the Scanner's stage 1 in scan mode (O-92), which also installs the YAML parser from the image's lockfile; nothing else changes. Deploying the flows creates the `f/foreman/scan` schedule (05:00 Toronto time). Migration 0017 (the `scans` table) is applied with the others, after Didi's review.

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

### The receiver's starts on green CI and staging deploys

After it records CI's end on a PR head, the receiver starts `f/foreman/advance_item` for the item when the advance check says its move into In QA review is due, and after it records a finished `deployment_status` to `staging` it starts `f/foreman/verify_staging` with the repository and the commit when an item of that repository is in Verifying on staging (D-329 slice 4, O-104). Both use the receiver's token of step 15 through the Windmill proxy. Built and tested with fakes, without a real Windmill or GitHub. To verify at rehearsal, in the rehearsal project with synthetic data only, and record each result with the date in O-104:

- Green CI: an item In development whose Developer reported done while CI was still pending moves to In QA review within seconds of CI ending green on its head, with no reconcile pass in between, and QA's review run starts for that pull request and head commit. The receiver logs `advance flow started` once, with the delivery id only.
- Not due: a red CI result, a head with no docs note, a pending result (checks starting on a new head), a redelivered webhook and the same CI end from a second event start nothing, and the month's run count does not move.
- The staging deploy: after the runner merges an item, the project's deploy to `staging` on push to main sends a `deployment_status`; the receiver logs `staging flow started` once for its final status, the item is verified in that run, and its dependents' first runs start. The `pending`, `queued` and `in_progress` statuses, a deploy to another environment, and a deploy while no item of the repository is in Verifying on staging start nothing.
- The input: Windmill's run of `f/foreman/verify_staging` shows `{"repo": "<owner/name>", "sha": "<commit>"}` and the run of `f/foreman/advance_item` shows `{"nodeId": "..."}`.
- The token: with its three scopes, a start of each of the three flows is accepted, and a start of any other script, and any other call, are refused.
- The switches: with `dry_run` true, or `kill_switch` true, neither event starts a flow; the evidence and the delivery are still recorded.
- The run budget (D-164): about one run per item whose head's CI ends green with its move due (usually once per item, and once more per fix round), and one per finished staging deploy while an item verifies. The receiver's three starts together stay well inside the about 600 runs a month left beside the schedules.

### Starts inside the flows that took the move

These add no Windmill run: each runs inside the flow run that took the move (D-329 slice 4, O-104). To verify at rehearsal, with synthetic data only, and record each result with the date in O-104:

- QA on the done report: when a Developer's or Designer's report moves the item into In QA review, QA's review run starts in that same run-end flow run, for the pull request and head commit the runner's `ci_run` names. The run-end flow's result lists it under `qaRuns`.
- The visual comparison: on a design item, once QA's review run ends with a pass on the head, the visual comparison run (`qa:visual`) starts in that run's run-end flow run, on the same head.
- The safety net: an item left In QA review with no QA run on its head (for example after a start refused for `cluster_full`) gets QA's run from the next reconcile pass's dispatch step.
- A freed slot: with `agent_cluster_max_active_runs` set to the number of runs active and one item ready, the item starts in the run-end flow run of the next run to end, listed under `freedSlots`, with no reconcile pass in between. With two ready items and one slot freed, the older one starts and the newer one waits.
- Didi's answer: when Didi answers an escalation that returns the item to In development or Building components, the item's fix round starts in the same approval run, listed under `builderRuns`. With `dry_run` or `kill_switch` on, nothing starts.
- Didi's privileged-path Approve (D-334): with an item In QA review whose pull request touches a privileged path, QA passed and Didi's request open, Didi's Approve merges it in that same approval run (`privilegedMerge` in the result), and the item moves to Verifying on staging. A Reject merges nothing and opens no fresh request; an Approve after a new commit merges nothing and asks again for the new head; with `dry_run` or `kill_switch` on, nothing merges and the next merge pass takes it on.
- The merged-change check: after QA's pass report merges an item, the Council is asked about each open item touching the same design feature folder in that same run-end flow run. A pull request merged by hand on GitHub is taken on by the next reconcile pass, whose merge pass completes its move and whose merged-change pass asks the same question.

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

### The admin workflows

The three workflows (D-336, D-339, D-340, O-105) are built and tested with fake tools, without a real cluster, state, registry or GitHub environment. To verify at their first real run, with no real personal data, and record each result with the date in O-105:

- The environments: the `tofu-apply`, `kubectl-apply` and `cluster-secrets` jobs wait for Didi's approval, and the approval page links the run whose plan job's summary Didi reads; the plan jobs start without one. A run started by hand from another branch skips every job, and the environments' branch rule would refuse it anyway.
- The images: the job's own token with `packages: write` can create the seven packages under `didi-build`; whether they arrive private, and that each one, once public, pulls with no login (`docker pull ghcr.io/didi-build/foreman-state-api@sha256:...`) to the digest the summary gave. Each package shows this repository as its source.
- The credential: DigitalOcean accepts `--expiry-seconds` of 600, 900 and 1200; a `kubectl` call with the credential after that time is refused; and whether a credential already fetched stops working when the DigitalOcean token is revoked. The narrowest DigitalOcean token scopes that can plan, apply and fetch the credential (step 3).
- OpenTofu in the jobs: `-lockfile=readonly` passes with the committed lock file; the apply of the saved plan takes the passphrase from `TF_VAR_state_encryption_passphrase` and nothing else; `tofu output -raw receiver_tunnel_token` works in the Secrets job with only the R2 key and the passphrase, and no provider token.
- The published plan: the secret-value scan passes on a real plan; the summary shows no value marked sensitive, and no account, zone or resource id, receiver host name or bucket name, only their placeholders; the plan stays readable and within GitHub's 1 MiB summary limit. Whether GitHub's own masking also covers the job summary (the jobs do not rely on it).
- The platform diff: `kubectl diff --server-side` names its files `<group.>version.Kind.namespace.name`, so each object shows by kind, namespace and name; an object in a new namespace is listed as created; the apply creates each namespace before the objects in it.
- The checks: the `can-i` answers are as the step 7 list says; the probe pod is admitted by Pod Security `restricted` and by the agent namespace's quota, pulls the egress proxy image, and its DNS lookup and both connections fail inside their time limits (default deny on DOKS); each probe lands on its own pool.
- The address: the `kubernetes` EndpointSlice on DOKS lists plain IPv4 addresses and one `https` port, as `cluster-facts` expects.
- The Secrets job: a server-side apply takes over a Secret first made by `kubectl create`; a second run with the same values changes nothing and restarts nothing; an empty environment secret is named as skipped and its Secret is left as it is.
- One run at a time: a second run of a workflow waits while the first's apply waits for Didi, and a third replaces the waiting second.
- The receiver: the deployment events of the four environments are recorded as deliveries and start nothing.

## Verification

Run the remaining checks in ADR 0106 "How success is judged" on the real cluster, and record their output and date in the M3.2 PR. Never paste a secret value, `plan.json` or `state.json`.

### The live reconcile pass and first runs on the move

With `dry_run` false the reconcile pass acts on its plan: release, the first run of each ready item, and the advance from evidence into QA review with QA's run (D-329 slice 3, O-103). Each flow whose move makes an item ready starts the item's first run inside its own run, and the pass is the safety net. Built and tested with fakes, without a real Windmill, cluster or agent. To verify at rehearsal, in the rehearsal project with synthetic data only, and record each result with the date in O-103:

- A release on the move: a Blocked item whose only blocker passes its staging check is released by the staging flow, and its first run starts in that same flow run, with no reconcile pass in between. The item is In development with one run, and the run's result lists it under `firstRuns`. A design item waiting in Ready for design exploration on the same blocker starts the same way.
- A release by the pass: a Blocked item whose blocker was finished with no flow (for example a blocker moved by hand at rehearsal setup) is released by the next reconcile pass, and its first run starts in that pass, before the dispatch step.
- The Triage handoff: once a Triage run's end is recorded, each item the handoff created in a ready state with nothing holding it (no hold, no request for Didi, no open blocker) has its first run started in the same run-end flow run. The held, gated and blocked items start nothing.
- Dry run: with `dry_run` true, a reconcile pass writes only `dry_run` transition rows, no run starts and no agent Job is created. An approval answered meanwhile is recorded and starts nothing.
- The kill switch: with `kill_switch` true, the pass stops first: no GitHub read, no transition and no run, and only the cancel pass runs.
- Once: two reconcile runs started by hand at the same time give one release and one run per item, and a third pass after them starts nothing.
- Advance from evidence: an item In development with CI green on its head and a docs note, whose move was not taken on the Developer's report, moves to In QA review on the next pass, and QA's run starts for that pull request and head commit.
- Refusals: with `agent_cluster_max_active_runs` set to the number of runs already active, the pass reports `cluster_full` for each first run it could not start, and the Windmill run still succeeds.
- The run budget: each reconcile pass adds one run to the month's count, whatever it starts, and a first run started inside another flow adds none (D-164). Each agent run started still adds its run-end flow's run (O-102), as a run started by hand does.
