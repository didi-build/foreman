# First hosting runbook

**Purpose:** the gates Didi passes, in order, to bring up the agent and platform cluster, the state API, the GitHub receiver and its tunnel, and the run watcher, for the first time (ADR 0106, ADR 0110, D-183 to D-195, D-330). Nothing here has been done yet. No agent or runner does any step.

Since D-339, the admin work runs as GitHub Actions jobs that wait for Didi's approval, not from a terminal: Didi creates each credential at its provider, pastes it once into GitHub's secret form for the environment named here, reads each plan in its job's summary, and approves the job that applies it. Four workflows do the work (O-105, O-115):

| Workflow                                                 | What it does                                                                                                                                                                                                                                                       | Jobs, with their environment                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Images (`.github/workflows/images.yml`)                  | Builds the seven images from main and pushes them to `ghcr.io/didi-build` (D-336). Gives each reference pinned by digest.                                                                                                                                          | `build-and-push` (no environment, `packages: write`)                                                                                 |
| Infra apply (`.github/workflows/infra-apply.yml`)        | Plans the factory stack and, once Didi approves, applies that exact saved plan. Steps 5, 11 and 11a, each project's staging name and route, and every later infrastructure change.                                                                                 | `tofu-plan` (`infra-plan`), `tofu-apply` (`infra`, Didi approves)                                                                    |
| Platform (`.github/workflows/platform.yml`)              | Renders the settings file, diffs it against the cluster and, once Didi approves, applies it and runs the checks; sets the cluster's Secrets; writes the runner's cluster token into Windmill. Steps 7 to 10, the cluster Secrets of step 15, and adding a project. | `render` (none), `kubectl-diff` (`platform-plan`), `kubectl-apply`, `cluster-secrets` and `runner-token` (`platform`, Didi approves) |
| Database migrations (`.github/workflows/db-migrate.yml`) | Applies every migration in `db/migrations/` not yet recorded in the state store, in name order, once Didi approves (D-362). Step 9a and every later migration.                                                                                                     | `db-migrate` (`database`, Didi approves)                                                                                             |

**Rules for every step**

- Never paste a secret value into a file in the repo, a chat, Linear or a log. Paste each one only into GitHub's secret form for its environment (step 3), or into the provider's or Windmill's own form where a step says so. What must be kept goes into the project's Bitwarden vault (D-341): the state encryption passphrase, the providers' logins and two-factor recovery codes, and the planning chat's token. A secret that can be made again at its provider is not kept anywhere else.
- Each gate is approved once, for that one request. Approving a job approves the plan or the diff its summary shows, and nothing more.
- The jobs run only from main. The repository is public, so their logs and summaries are public pages: they show names, counts and plans, with account, zone and resource ids, the receiver's host name, the state bucket and IPv4 addresses replaced by placeholders, and never a secret value (O-105). The Kubernetes API's address never appears in them or in their downloads (D-349, O-107).
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

| Environment     | Required reviewers | Deployment branches            | What runs there                                                                                                                      |
| --------------- | ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `infra-plan`    | none               | Selected branches: `main` only | The Infra apply workflow's plan (`tofu-plan`)                                                                                        |
| `infra`         | Didi               | Selected branches: `main` only | The infrastructure apply (`tofu-apply`)                                                                                              |
| `platform-plan` | none               | Selected branches: `main` only | The Platform workflow's diff (`kubectl-diff`)                                                                                        |
| `platform`      | Didi               | Selected branches: `main` only | The platform apply and its checks (`kubectl-apply`), the Secrets (`cluster-secrets`) and the runner's cluster token (`runner-token`) |

For `infra` and `platform`, Didi is the only required reviewer. Leave "Prevent self-review" off: Didi starts most runs and is also the one who approves them. Set no wait timer. Set up all four, with these rules, before pasting any secret into one: a run that names an environment that does not exist yet creates it with no protection rule. Until the secrets are there, the jobs stop for want of one before they reach any account, and nothing is applied. Put none of these values in the repository's own secrets: any workflow on any branch could read those, which D-339 rules out.

Step 9a adds a fifth environment, `database`, with the same rules as `infra` and `platform`, for the database migrations job (D-362).

### The credentials and where each one goes

Create each credential at its provider, then paste it once into the secret of each environment the table names for it (GitHub keeps each environment's secrets apart, so a value two environments need is pasted into both, D-350). The value is never shown again.

- A DigitalOcean API token with the narrowest scopes that can create a Kubernetes cluster, its node pools and a firewall, and read the cluster's credentials (`doctl kubernetes cluster kubeconfig`, D-340). Made 2026-11-08 as `foreman-admin-jobs`, custom scopes, expiring after one year: `kubernetes:create`, `kubernetes:read`, `kubernetes:update`, `kubernetes:delete`, `kubernetes:access_cluster`, `firewall:create`, `firewall:read`, `firewall:update`, `firewall:delete`, `tag:create`, `tag:read`, `vpc:read`, `regions:read`, `sizes:read` and `droplet:read`, plus `actions:read`, `image:read` and `snapshot:read`, which DigitalOcean's form added as required. The first apply proved them: the cluster, its node pools and the firewall were created on 2026-11-08. A first token without `tag:create` was refused at the cluster's creation (401, "tagging requires tag:create permission"), because DigitalOcean tags the cluster's nodes, which the firewall targets. A missing scope answers 401 or 403 naming it, and since a token's scopes cannot be edited, the fix is a new token with that scope added, pasted into the same four environments, and the old token deleted.
- A Cloudflare API token for the `didi.build` account and zone, with exactly three permissions: Cloudflare One Connector: cloudflared: Edit on the account, and DNS: Edit and Workers Routes: Edit on the `didi.build` zone only. Made 2026-11-08 as an account-owned token, `foreman-infra`, expiring after one year, in Cloudflare's policy form: one policy on the account for the tunnel permission, one on the `didi.build` zone for the other two. Cloudflare's API accepts any of Cloudflare One Connector: cloudflared, Cloudflare One Connectors or Cloudflare Tunnel for the tunnel calls the stack makes (create, configure, read its token; API reference, read 2026-11-08); the first is the narrowest, covering cloudflared tunnels only, and older forms show the third as Argo Tunnel (Legacy). The tunnel and DNS permissions make the receiver's tunnel and record; DNS and Workers Routes make each project's staging name `<slug>.didi.build` and its Worker route (D-357, O-112). Give it all three when creating it. Before saving, check that its summary lists these three and nothing else.
- The R2 state bucket's access key and secret, a token for that bucket only, as in ADR 0110.
- The state encryption passphrase, at least 16 characters, generated in Bitwarden and kept there (D-341): losing it makes the state unreadable.

The later steps add the Windmill token that writes the runner's cluster token into Windmill (step 8), the migration connection string (step 9a), the database URLs and the webhook secret (step 10), and the planning token and the three Windmill tokens that start flows (step 15).

| Environment              | Secret                            | Where it comes from                                                                                       | Step |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------- | ---- |
| `infra-plan` and `infra` | `DIGITALOCEAN_TOKEN`              | The DigitalOcean API token above                                                                          | 3    |
| `infra-plan` and `infra` | `CLOUDFLARE_API_TOKEN`            | The Cloudflare API token above                                                                            | 3    |
| `infra-plan` and `infra` | `R2_STATE_ACCESS_KEY_ID`          | The R2 state bucket token's access key id                                                                 | 3    |
| `infra-plan` and `infra` | `R2_STATE_SECRET_ACCESS_KEY`      | The R2 state bucket token's secret access key                                                             | 3    |
| `infra-plan` and `infra` | `STATE_ENCRYPTION_PASSPHRASE`     | The passphrase in Bitwarden                                                                               | 3    |
| `platform-plan`          | `DIGITALOCEAN_TOKEN`              | The same DigitalOcean API token                                                                           | 3    |
| `platform`               | `DIGITALOCEAN_TOKEN`              | The same DigitalOcean API token                                                                           | 3    |
| `platform`               | `R2_STATE_ACCESS_KEY_ID`          | The same R2 access key id (the Secrets job reads the tunnel token from the state)                         | 3    |
| `platform`               | `R2_STATE_SECRET_ACCESS_KEY`      | The same R2 secret access key                                                                             | 3    |
| `platform`               | `STATE_ENCRYPTION_PASSPHRASE`     | The same passphrase                                                                                       | 3    |
| `platform`               | `WINDMILL_RUNNER_RESOURCES_TOKEN` | The Windmill token whose only scope is `resources:write` on the runner's three resource paths             | 8    |
| `database`               | `MIGRATION_DATABASE_URL`          | The Supabase session pooler's connection string for the `postgres` user, with its password from Bitwarden | 9a   |
| `platform`               | `STATE_API_DATABASE_URL`          | The connection string of the `factory_api` login user, from Supabase                                      | 10   |
| `platform`               | `RECEIVER_DATABASE_URL`           | The connection string of the `factory_ingest` login user, from Supabase                                   | 10   |
| `platform`               | `RECEIVER_WEBHOOK_SECRET`         | A long random value from Bitwarden's generator, also pasted into the runner App's webhook form            | 10   |
| `platform`               | `PLANNING_TOKEN`                  | The planning chat's token, kept in Bitwarden                                                              | 15   |
| `platform`               | `STATE_API_WINDMILL_TOKEN`        | The Windmill token that runs only `f/foreman/plan_approval`                                               | 15   |
| `platform`               | `RECEIVER_WINDMILL_TOKEN`         | The Windmill token that runs only the receiver's three flows                                              | 15   |
| `platform`               | `RUN_WATCHER_WINDMILL_TOKEN`      | The Windmill token that runs only `f/foreman/record_run_end`                                              | 15   |

The account id, the zone id and the bucket name are identifiers, not keys, so they live outside the environments as secrets, and GitHub masks them in every log (D-361). The two Cloudflare ids are organization secrets shared with `foreman` only (the organization's Settings, Secrets and variables, Actions, New organization secret, Repository access: Selected repositories). The bucket name is a repository secret (the repository's Settings, Secrets and variables, Actions, New repository secret). A job reads an environment secret first, then a repository secret, then an organization secret, so none of the three needs wiring per environment. The R2 key pair stays in the environments, behind their protection rules. `RECEIVER_HOSTNAME` is public and stays an environment variable (Settings, Environments, the environment, Environment variables). Each is checked against its own pattern before any job uses it.

| Where                                            | Name                    | Value                                                                                             |
| ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------- |
| Organization secret, shared with `foreman` only  | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account id of the `didi.build` zone and of the R2 state bucket (32 hex characters) |
| Organization secret, shared with `foreman` only  | `CLOUDFLARE_ZONE_ID`    | The `didi.build` zone id (32 hex characters)                                                      |
| Repository secret                                | `STATE_BUCKET`          | The R2 state bucket's name                                                                        |
| Environment variable in `infra-plan` and `infra` | `RECEIVER_HOSTNAME`     | `foreman.didi.build`, the cluster's one public host name (D-343)                                  |

A secret only the cluster Secrets job reads (the rows of steps 10 and 15) can be removed from the environment once its run has put it in the cluster: the job then leaves that Secret as it is and names it as skipped (step 9).

## 4. Decide the API endpoint allow-list (D-189)

Check whether Windmill Cloud's outbound addresses are fixed. If they are, put them and Didi's address in `api_allowed_addresses`. If not, leave it empty: the runner's RBAC-limited token is the protection.

Checked 2026-11-06: Windmill publishes no list of Windmill Cloud's outbound addresses in its documentation or pricing pages, and its community forum points users to support for a workspace's current addresses, which may change. Decided by Didi on 2026-11-06 (D-338): leave `api_allowed_addresses` empty, and revisit once Windmill is self-hosted in the cluster.

## 5. Create the cluster and the tunnel with the Infra apply workflow

The cluster is the spending gate of step 2. The tunnel creates a new credential, its token: a new-credentials gate.

1. Check the reviewed variables in `infra/stacks/factory/production.tfvars`: `kubernetes_version_prefix` is a version DigitalOcean lists as supported (1.37 on 2026-11-06), `publish_receiver_dns = false` and `expose_planning_route = false`. Any change to them is a pull request Didi reviews. Check that `RECEIVER_HOSTNAME` in the `infra-plan` and `infra` environments is `foreman.didi.build` (D-343): the cluster's one public door, a single-level name that Cloudflare's free certificate covers. Every path the tunnel forwards on it is under `/api` (the webhook at `/api/github/webhook`, the planning chat's paths at step 11a), and every other path gets the tunnel's 404.
2. Start the Infra apply workflow on main (Actions, Infra apply, Run workflow). A push to main that changes `infra/stacks/factory/`, `infra/modules/` or the settings file `infra/kubernetes/settings/production.json` starts it too: the stack reads its project list there (D-357).
3. Its `tofu-plan` job (environment `infra-plan`) runs `tofu init -input=false -lockfile=readonly` against the R2 state and `tofu plan -input=false -var-file=production.tfvars`. Before anything is published it runs the secret-value scan of `infra/README.md` on the plan text and the plan's own output, for the DigitalOcean and Cloudflare tokens, the R2 secret, the passphrase and, once a tunnel exists, the tunnel token. If any is found the job stops and publishes nothing.
4. Read the plan in the `tofu-plan` job's summary: the counts, the gates the plan touches, each resource that changes and the full plan as `tofu show -no-color` prints it. For this first apply: no DNS record yet, one cluster, one more node pool, one firewall, one tunnel and its routing. If the settings file already lists projects, the plan also makes each one's staging name and route, as "Adding a project" below describes. Values marked sensitive show as `(sensitive value)`; ids, the receiver's host name and the state bucket show as placeholders, because the page is public.
5. If the plan is what is expected, approve the `tofu-apply` job (environment `infra`). It applies the saved plan file and nothing else, then runs the same scan on the apply's output, and on the state (piped from `tofu state pull`, never written to a file) for every secret value but the tunnel token, which the state holds by design (step 0). If the state changed since the plan, OpenTofu refuses the stale plan: start the workflow again. If the plan is not what is expected, reject the job, and nothing changes.

The encrypted plan file is kept for one day: approve within a day, or start the workflow again.

**The managed worker firewall (D-331).** Once the cluster exists, read the firewall DOKS made for the worker nodes in the DigitalOcean control panel's Networking page, and its outbound rules. Read it only: never edit it, and add no deny rule, because DigitalOcean's reconciler owns that firewall by name. If it allows all outbound traffic, our cloud firewall's outbound rules take no effect and the network policies and egress proxies are the only outbound control; if its outbound rules are narrower, ours stay as a second layer. Record which, with the date, here:

- Result, read by Didi on 2026-11-08: DOKS made two firewalls next to ours (`foreman-workers`), both on the cluster's two nodes. `k8s-<cluster id>-worker` allows inbound ICMP, all TCP and all UDP only from the private ranges (10.0.0.0/8, 172.16.0.0/12 and one more), and allows **all outbound** traffic (ICMP, all TCP, all UDP, to all IPv4 and IPv6). `k8s-public-access-<cluster id>` has **no inbound rule** and also allows all outbound. Cloud firewalls add up, so our firewall's outbound rules take no effect: the network policies and the egress proxies are the only outbound control, as D-331 foresaw. Nothing on the internet can open a connection to a node.

## 6. No admin kubeconfig is kept (D-340, revising D-188)

Didi downloads and keeps no kubeconfig. Each job that reaches the cluster fetches its own short-lived admin credential with the DigitalOcean token (`doctl kubernetes cluster kubeconfig show foreman --expiry-seconds <the job's time limit in seconds>`, 10 to 20 minutes), masks in the log its token and the API server's URL, host name and the IPv4 addresses that name resolves to (D-349), and removes the file at the job's end; GitHub then discards the runner. The credential never goes to the runner, an agent or Windmill. doctl and DigitalOcean's API set no shortest expiry, so each job asks for its own time limit (O-105). The provider's own credential in the state (D-332, step 0) is unchanged.

## 7. Apply the cluster's standing objects with the Platform workflow

The settings file is `infra/kubernetes/settings/production.json`, in the repository and reviewed like code. It holds no secret: images pinned by digest, the app logins, resource limits (`databasePort` defaults to 5432), the projects and their quotas, and the Windmill host and workspace. The committed file leaves empty what first hosting fills in, so the render refuses it, naming the first setting at fault, until it is filled in one pull request:

- `images.stateApi`, `images.receiver`, `images.egressProxy` and `images.runWatcher`: the references the Images workflow gives, pinned by digest. It runs on each push to main that changes `src/`, or by hand (Actions, Images, Run workflow), and its job summary and its artifact `foreman-images` (`settingsFile.platform.images`) give the four references in this file's shape. `images.egressProxy` is the egress proxy image the agent runs use, the same digest as `proxyImage` in `agent_run_settings`; it runs once more here as the shared Windmill proxy (D-284, D-328). `images.runWatcher` is the run watcher's image (D-330), built from `src/run-watcher/Dockerfile`.
  - The first time, set each of the seven packages the Images workflow pushed (`foreman-agent-opencode`, `foreman-agent-claude-api`, `foreman-repo-map`, `foreman-egress-proxy`, `foreman-state-api`, `foreman-github-receiver`, `foreman-run-watcher`) to public in the organization's Packages page (each package's settings, Change visibility), as D-336 decided. Each image holds only code: the workflow passes no build argument or build secret.
- `resources`: the requests and limits of each platform pod. The file starts every pod at 100m CPU, 128 MiB of memory and 64 MiB of scratch space requested, with limits of 500m, 512 MiB and 256 MiB (O-105). `resources.windmillProxy` is like an agent run's proxy, and `resources.runWatcher` like the receiver's (it holds a few watches open and does little else). Check them against the platform node's allocatable at the first apply.
- `windmill.host`: the Windmill host the state API, the receiver and the run watcher start their flows on, a plain host name with no scheme (for Windmill Cloud, the host name of its app), and `windmill.workspace`: the workspace id. If the workspace does not exist yet, choose its id now and create it with that id in step 15. Both are plain settings, not secrets. The proxy allows this one host and nothing else; it has no model provider, no state API route and no credential.
- `receiver`: the Developer and Designer Apps' logins and the runner App's slug, the names the Apps get in step 13.
- `projects`: each project's slug and quota (see "Adding a project" below).

`kubernetesApi`, where the run watcher reaches the API server as its network policy allows it, is not in the file. A policy sees the address the `kubernetes` Service sends to, not the Service's own. The repository is public, and with the allow-list empty (step 4, D-338) the API takes connections from anywhere, so its address never appears in the workflow's logs, summaries or downloads (D-349, O-107). The `render` job writes a placeholder, `192.0.2.1` on port 443 (a documentation address that is never routed), so the `platform-manifests` download holds only that. Each job that holds the cluster credential, `kubectl-diff` and `kubectl-apply`, reads the real address and port from that Service's EndpointSlice right after fetching its credential, masks each address in its log before anything can print it, and puts them into its own copy of the rendered objects (`.github/scripts/api-server-address.sh`), as this command did by hand:

```bash
kubectl -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*]}{.endpoints[*].addresses}{" "}{.ports[*].port}{"\n"}{end}'
```

It accepts plain IPv4 addresses and one port only, and stops otherwise. It also stops, with a fixed message that names no address, when the render holds no rule for the placeholder or more than one, or when the placeholder is still there after the swap. It prints only the number of addresses, and the copy with the real address is never uploaded or printed. The watcher's policy allows exactly these and nothing else on that port. An address that changes after a control-plane upgrade is picked up by the next run's plan, as a change to the run watcher's network policy. Each job reads the address itself, so if it changed between the plan and the apply, the apply uses the one it read.

Once the pull request is merged, the Platform workflow runs (or start it by hand: Actions, Platform, Run workflow):

1. `render` (no environment and no secret: the only job that runs the repository's TypeScript) renders the settings file with the placeholder address (`node infra/kubernetes/render.ts`) into one list of objects, kept as the artifact `platform-manifests` for one day. It stops if the list holds a Secret.
2. `kubectl-diff` (environment `platform-plan`) fetches a short-lived credential, puts the API server's address into its own copy of the objects as above, and runs `kubectl diff --server-side` against the cluster. Read its summary before approving: each object to create or change by action, kind, namespace and name, and the images in the render. It prints no object's content, so no field of a live object reaches the public log. An object in a namespace that does not exist yet is listed as created. Nothing is ever deleted: a project taken out of the settings keeps its namespace until Didi decides how it goes (a drop-data gate).
3. If the summary is what is expected, approve `kubectl-apply` (environment `platform`). It puts the address into its own copy the same way, applies the objects the plan read, with `kubectl apply --server-side`, then runs the checks below on that copy and writes each answer to its summary. It runs only when the plan found a change.

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

Six steps, in this order (D-345, D-357, D-358, O-109, O-112, O-114):

1. A pull request adds the project to `projects` in the settings file, with its slug and quota. The slug is also the repository's name and follows the project-slug rule: lowercase letters, digits and hyphens, starting with a letter or digit. The file is under `infra/**`, a privileged path in every project (D-344, D-345), so the runner never merges it without Didi's approval.
2. Once it is merged, the Platform workflow's plan shows the new `agents-<slug>` namespace with both Roles, and the run watcher's Deployment changed (its `AGENT_NAMESPACES` gains the namespace, which restarts the watcher). Didi approves the apply, and its checks then cover the new namespace too.
3. The same merge starts the Infra apply workflow, because the factory stack reads its project list from the settings file (D-357). This is the project's DNS change, approved on its own. In the `tofu-plan` job's summary, the gates must list exactly `create <slug>.didi.build` under the DNS change and `create <slug>.didi.build/*` under the Workers route change, and nothing else may change. The full plan shows the record with `type = "AAAA"`, `content = "100::"` and `proxied = true` (the placeholder Cloudflare documents for a name with no origin: only the Worker answers), and the route with `pattern = "<slug>.didi.build/*"` and `script = "<slug>-staging"`. If the name is one the `didi.build` zone already uses for something else, reject the job. Otherwise approve `tofu-apply` (environment `infra`).
   - The route names the project's assets-only Worker `<slug>-staging`, which the staging deploy (D-353, not built yet) creates with its first upload. Until then the name serves no content. Whether Cloudflare accepts a route to a Worker that does not exist yet is not confirmed (see "A project's staging name and route" below). If it refuses, the apply stops at the route, with the record already made: start the Infra apply workflow again (Actions, Infra apply, Run workflow) after the first staging upload, and approve its plan, which then shows only that route.
   - A project named `foreman` gets no record and no route: its host name is the receiver's, `foreman.didi.build`, the cluster's one public door (D-343). Its plan shows nothing for it. How Foreman's own frontend shares that host name is N-96.
4. Didi runs `f/foreman/register_project` from its page in the Windmill workspace, signed in, with the slug and a one-line description, which becomes the repository's description. With dry run on, it only says what it would do. With both switches off, it checks that the slug is listed in the settings file on main, creates `didi-build/<slug>` from the `didi-build/launchpad` template, public (D-348), with the description, and records the project with staging at `https://<slug>.didi.build` and no production. Then it adds the repository to `BOOTSTRAP_TOKEN`'s selected repositories and starts Bootstrap again on main, each with a token narrowed to the new repository (D-358, O-114). Run again, it answers `already_registered` once the project's setup finished well; while Bootstrap's restarted run is going it changes nothing (`bootstrap_running`); otherwise (no restart yet, or one that failed) it checks the repository as it checks one to reuse, then grants and restarts again (`setup_restarted`). If an earlier run created the repository but did not record the project, the next run reuses it. Each refusal says which step stopped it, nothing is tried again with a wider token, and a refusal after the project is recorded says that running the form again picks up where it stopped.
5. Launchpad's Bootstrap workflow sets up the new repository (`docs/runbooks/bootstrap.md`). Its first run, on the template's initial commit that the create makes, starts before the repository has access to the organization secret `BOOTSTRAP_TOKEN`, so it fails; the form's restart is the run that sets the repository up. The secret is a fine-grained personal access token with Administration, Contents and Issues read and write, created through its own new-credentials gate and shared with selected repositories only, normally none (step 13, D-358). When the restarted run ends, whatever its conclusion, the receiver starts `f/foreman/remove_bootstrap_access`, which removes the repository from the list, and the reconcile pass removes any repository outside a project's first hour. If the run failed, the daily check says "Bootstrap failed for <slug>; run the register form again": fix the cause, then run the form again, which grants and restarts again. Do not start Bootstrap by hand from the Actions tab: without access it fails, and the end of any run started that way removes the access.
   - `LAUNCHPAD_COLLECTS_PERSONAL_DATA` is a repository variable Bootstrap reads when it initializes the repository. Unset, it counts as `true`: init also runs `@didi-build/nodrift init`, and the project's `npm run check` then runs `npm run nodrift`. Set to `false`, init skips it. It must be set before init runs. Bootstrap also takes `yes`, `no`, `1` and `0`; any other value fails its plan. The form sets no variable, and it restarts Bootstrap as soon as the project is recorded, so a project registered this way starts with the personal-data scaffolding on. How a project opts out is N-92.
6. Then the project's own credentials (its secrets under `projects/<slug>/...`, such as its model key) and its first runs, each as its own step.

## 8. The runner's cluster token (new-credentials gate)

A job of the Platform workflow makes the token and writes it into Windmill (D-352, O-110). No terminal is needed and nothing is printed. Two approvals: the new Windmill token, a new credential and its own gate, and then the run.

1. **Create the Windmill token, limited to exactly three resource paths.** In the Windmill workspace that `windmill.workspace` names in the settings file (step 7), with its folder `foreman` (if the workspace or the folder does not exist yet, create it now with that id and name; step 15 deploys the flows into that folder). Open Account settings (your user name in the side menu, then Account settings) and give the new token a label, for example `foreman runner-token job`. Turn on **Limit token permissions**, open **Resources** and choose **Write**, then click **Restrict paths** and enter exactly these three paths, and nothing else:
   - `f/foreman/platform/agent-cluster/runner-token`
   - `f/foreman/agent_cluster_endpoint`
   - `f/foreman/agent_cluster_ca_certificate`

   Check that the selected scopes read exactly `resources:write:f/foreman/platform/agent-cluster/runner-token,f/foreman/agent_cluster_endpoint,f/foreman/agent_cluster_ca_certificate` and nothing more, then click **New token**. (These are the controls Windmill's user token docs name, read 2026-11-07; if the page is laid out differently, the scope must still read exactly as above.) A write scope also reads the same paths, so the token can read these three resources back and nothing else. An expiration date is optional: once it passes, the job is refused until a new token is pasted. **If Windmill cannot limit a token to exactly these paths, stop and ask Didi before creating any credential.** Do not create a wider token.

2. **Paste it once** into the `platform` environment as the secret `WINDMILL_RUNNER_RESOURCES_TOKEN` (step 3), and nowhere else: not into Bitwarden (it can be made again, D-341), a file, chat, Linear or a log.
3. **Run the job.** Actions, Platform, Run workflow on main, with "Also write the runner's cluster token into Windmill" ticked. The `runner-token` job (environment `platform`) runs after the plan and the apply of the same run, only if both passed or the apply had nothing to do, and waits for Didi's approval. Approve it.

What the job does (`.github/scripts/runner-token.sh`):

- It fetches its own short-lived cluster credential (step 6), which masks the API server's URL, host name and addresses, and removes it at its end.
- It checks that the service account `foreman-runner` exists (step 7 creates it), then applies, server-side, the Secret `foreman-runner-token` in the namespace `foreman-runner`, of type `kubernetes.io/service-account-token` for that account. The cluster fills it in with a token for the account. It waits up to a minute for the token, checks its shape and masks it before anything else.
- It writes three Windmill resources, each of type `foreman_text` with the value `{"content": "<value>"}`: the token at `f/foreman/platform/agent-cluster/runner-token`, the cluster's endpoint (the credential's `server`, `https://host[:port]`, masked like the token) at `f/foreman/agent_cluster_endpoint`, and its CA certificate (the credential's `certificate-authority-data`, in PEM) at `f/foreman/agent_cluster_ca_certificate`. Each is one call of Windmill's API, `POST https://<windmill.host>/api/w/<workspace>/resources/create?update_if_exists=true`, which creates the resource or replaces its value. The values go through stdin and a file only the job can read, never an argument. The log shows only the paths and Windmill's status. Any status other than success stops the run without showing Windmill's answer, which could repeat what was sent.

The endpoint and the CA certificate are the same values as the factory stack's outputs `cluster_endpoint` (sensitive, D-349) and `cluster_ca_certificate`; nothing reads those outputs. The token does not expire: no decision fixes its lifetime, and N-93 asks whether to move to expiring tokens re-written on a schedule. Running the job again writes the same token, endpoint and CA certificate again, so it also brings Windmill up to date after the cluster's endpoint or CA certificate changes; it does not make a new token. Windmill keeps each resource's past values, readable by anyone who can read the resource, so after a token is ever replaced, use "Clear past versions" in that resource's History.

The Platform workflow's apply job runs the `can-i` half of ADR 0106 check 4 (RBAC) after each apply; the half with the token itself (creating a Job in `agents-<slug>` works, and the refused calls are refused) is checked at rehearsal.

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

## 9a. The database migrations job (new-credentials gate, D-362)

The migrations run as a GitHub Actions job Didi approves, never from a terminal (D-362, O-115). `0001_factory_schema.sql` was applied with `npm run db:migrate` on 2026-10-29 (D-173) and is recorded in `factory_meta.schema_migrations`; this job applies the others. Do it before step 10: the login users there belong to roles the migrations make (`factory_ingest` comes with `0002`).

1. **Create the environment `database`.** In the repository's settings (Settings, Environments, New environment), name it `database`. Required reviewers: Didi only. Deployment branches: Selected branches, `main` only. Set no wait timer. Leave "Prevent self-review" off: Didi starts the run and is also the one who approves it. Create it, with these rules, before pasting the secret: a run that names an environment that does not exist yet creates it with no protection rule.
2. **Take the connection string.** In Supabase's dashboard, open the project's Connect panel and copy the session pooler's connection string (session mode, port 5432) for the `postgres` user, the database owner. It reads `postgresql://postgres.<project ref>:[YOUR-PASSWORD]@<pooler host>:5432/postgres`. Put the `postgres` user's password in place of `[YOUR-PASSWORD]`, brackets included. Didi keeps that password in Bitwarden, moved there from the old password manager (D-341). An `@`, `/`, `?`, `#` or `%` in the password must be percent-encoded (`%40`, `%2F`, `%3F`, `%23`, `%25`). Add nothing after `/postgres`: the job requires SSL itself, and refuses anything after the database name.
3. **Paste it once** into the environment `database` as the secret `MIGRATION_DATABASE_URL` (Settings, Environments, `database`, Add environment secret). This is the new-credentials gate: one approval, for this one secret. Paste it nowhere else: not a file, a chat, Linear or a log. Nothing new is kept: the password stays in Bitwarden.
4. **Start the job and approve it.** Actions, Database migrations, Run workflow on `main`. Its `db-migrate` job waits for Didi's approval. Approve it.
5. **Read the summary.** The job's summary lists the migrations applied, in order. For this first run that is `0002_github_ingest.sql` to `0021_ingest_preview_check.sql`, and not `0001`. If the run stops instead, the summary and the log say why, with the connection's values replaced (`***`, or `<DATABASE_HOST>` and `<DATABASE_USER>` in psql's own error): a migration that failed is rolled back and nothing after it is applied; a recorded migration whose file was edited or removed is refused before anything is applied. If it refuses `0001_factory_schema.sql` as changed, stop and ask Didi: the file in the repository is not the one applied on 2026-10-29.

What the job does (`.github/workflows/db-migrate.yml`, `.github/scripts/db-migrate.sh`):

- It checks out `.github/` and `db/migrations/` only, keeps no GitHub credential, and runs only that script, with bash and the runner image's `psql`. No npm, no Node and none of the repository's TypeScript run beside the connection string, since a bot can change those without Didi's approval.
- It checks the connection string, then masks it, with its password, user and host, before anything else prints. psql gets it in its own environment only, never as an argument, with SSL required.
- It takes the same advisory lock as `npm run db:migrate`, in one session for the whole run, so two runs never overlap. It refuses to run if a recorded migration's file is missing or was edited, then applies each migration not yet recorded, in name order, each in its own transaction with its record row, and stops at the first failure.

**Every later migration** is a pull request, which Didi approves because `db/migrations/` is a privileged path (D-344), then this job, which starts when the pull request is merged and waits for Didi's approval. A waiting run blocks no merge and no other workflow. Nothing goes live on its own, so approve a migration's run before, or together with, the rollout of code that needs it (D-362). One run goes at a time: if a run is still waiting when another migration is merged, the newer run waits behind it. Reject the older one, and the newer one then waits in its place and applies every pending migration in order, with one approval.

**To verify at the first real run,** and record each result with the date in O-115:

- The environment: the `db-migrate` job waits for Didi's approval; a run started by hand from another branch skips the job, and the environment's branch rule would refuse it anyway.
- psql: the runner image ships the PostgreSQL client (GitHub's software list for Ubuntu 24.04, image 20261101.360.1, lists PostgreSQL 16.15, read 2026-11-08), so the log shows no `psql: command not found`.
- SSL: the job connects through the session pooler with SSL required. If the pooler refuses it, record psql's error as the log shows it (never the connection string) and stop.
- The masking: the log and the summary show no connection string, password, user (`postgres.<project ref>`, which names the project) or pooler host, only `***` or the placeholders.
- The rows: in Supabase's SQL editor, `select name from factory_meta.schema_migrations order by name` lists `0001_factory_schema.sql` to `0021_ingest_preview_check.sql`.
- The lock: after the run, `select count(*) from pg_locks where locktype = 'advisory' and objid = 7104001` in the SQL editor answers 0. Whether the session pooler lets the lock go when a run fails: psql then ends its session with the failed transaction open. If a later run waits at the lock until its time limit, record it in O-115.
- A second run, started by hand right after the first, starts at once and applies nothing: its summary says "Nothing to apply".

## 10. Supabase role passwords as Secrets (new-credentials gate)

Create the login users for the `factory_api` and `factory_ingest` roles (the migrations make the roles, step 9a) if they do not exist yet, then paste each connection string into its `platform` environment secret, and generate the webhook secret in Bitwarden's generator:

| Environment secret        | Secret in `foreman-platform`     | Key     |
| ------------------------- | -------------------------------- | ------- |
| `STATE_API_DATABASE_URL`  | `state-api-database`             | `url`   |
| `RECEIVER_DATABASE_URL`   | `github-receiver-database`       | `url`   |
| `RECEIVER_WEBHOOK_SECRET` | `github-receiver-webhook-secret` | `value` |

Then run the cluster Secrets job (step 9). The webhook secret is the one the runner App will use in step 13: paste the same value into the App's webhook form there. It can be made again at any time by setting a new value in both places.

## 11. The DNS record (DNS gate)

A pull request sets `publish_receiver_dns = true` in `infra/stacks/factory/production.tfvars`. Once it is merged, the Infra apply workflow plans: check that the summary's DNS change lists exactly one record, the receiver's (`module.edge.cloudflare_dns_record.receiver[0]`) as `create`, that the plan adds exactly one `cloudflare_dns_record` (the proxied CNAME for `foreman.didi.build`, which the summary shows as its placeholder) and changes nothing else, and that no Workers route changes. Then approve the apply.

Each project's staging name is its own DNS change, in its own plan (step 7, "Adding a project"). A project named `foreman` never gets a second record on this host name (O-112).

## 11a. The planning chat's paths on the tunnel (tunnel gate, D-271, D-282, D-343)

This changes the tunnel's routing only: one more rule on the receiver's host name `foreman.didi.build`, for the planning chat's paths exactly (`/api/plans` and `/api/planning/projects/<slug>/{submissions,feedback,accepted}`, D-343), to the state API's public Service (`http://state-api-public.foreman-platform.svc.cluster.local:8081`). That port serves `POST /api/plans` and those three reads as `GET` and nothing else, with a 64 KiB size limit and 20 requests a minute (ADR 0102, O-83, D-282, O-106). No DNS record is added.

A pull request sets `expose_planning_route = true` in `infra/stacks/factory/production.tfvars`. Once it is merged, check the plan changes only `cloudflare_zero_trust_tunnel_cloudflared_config.receiver`, adding exactly one ingress rule with `path = "^/api/(plans|planning/projects/[a-z0-9][a-z0-9-]{0,99}/(submissions|feedback|accepted))$"` before the 404 rule, and nothing else. Then approve the apply. Check from outside: `POST https://foreman.didi.build/api/plans` and `GET https://foreman.didi.build/api/planning/projects/<slug>/submissions` with no token answer 401; `GET /api/plans`, `POST` on a read path, the old paths without `/api` (`POST /plans`, `GET /planning/projects/<slug>/submissions`) and any other path answer 404. Only after step 15 creates the planning token does a submission go through.

## 12. The model key with a spend cap (new-credentials gate)

Create the Anthropic API key for agent runs with a monthly spending limit at the provider (D-143, D-185): 50 USD a month for the rehearsal period (D-342). The first rehearsal runs on Anthropic only. Store it at its secret path in Windmill resources. The runner puts it only into each run's egress proxy Secret; no agent holds it.

The visual task types (`council:visual`, `qa:visual`) have no entry in `model_routing_policy` or `model_output_token_needs` yet, so a visual call or visual QA run is refused with `no_route` until they do. Once the vision model test at this step picks the model, add both entries with a reviewed migration, as 0019 did for the close runs.

## 13. The GitHub Apps (D-178)

Register the GitHub Apps of D-156 together, each with its own identity. The runner App's webhook URL is `https://foreman.didi.build/api/github/webhook` (D-343), with the webhook secret from step 10. It is the receiver's one path: any other path on the host name, the old `/github/webhook` included, answers 404. Their private keys stay with the runner, never on the cluster.

Subscribe the runner App to the events the receiver reads (`HANDLED_EVENTS` in `src/core/github-ingest.ts`, ADR 0113): Pull request, Check suite, Workflow run, Deployment status and Push. GitHub lets an App subscribe to Workflow run with "Actions" read, which the runner App has (D-267; GitHub's webhook docs, read 2026-11-07). Its `completed` event for Bootstrap's restart is what removes a repository's access to `BOOTSTRAP_TOKEN` (O-114).

The runner App's permissions are the ones in D-127, two read-only ones from D-267, `contents: read` (the repo map's checkout, and the register-project form's reads of the settings file and of an existing project repository) and `actions: read` (CI's screenshot bundles, and Bootstrap's runs for project setup, O-114), "Repository creation: write" from D-346, for the register-project form only, and "Organization secrets: write" and "Actions: write" from D-358, for `BOOTSTRAP_TOKEN`'s access only. It does not get "Administration". Only the form's token carries the creation permission: every token the runner mints names the permissions and repositories of its one step, and the form's names `contents: read` and `repository_creation: write` on `didi-build/launchpad` only (O-109). Only the register form's setup step and the removal step mint tokens that carry the two D-358 permissions (O-114):

- the change token, `organization_secrets: write` and `metadata: read` on the one repository: the form's grant, and each removal, once Bootstrap's restart ends or in the reconcile pass's backstop;
- the list token, `organization_secrets: read` on `didi-build/foreman` only (GitHub gives a token without a repository list every repository): the backstop's list of the secret's repositories;
- the restart token, `actions: write` on the new repository only: the form's restart of Bootstrap.

Neither permission can read a secret's value (GitHub's API never returns one) or delete a repository. "Organization secrets: write" can also create, replace or delete an organization secret, which is why its token is minted for one call and never kept. Check the App's permission page shows exactly these and nothing wider before installing it.

The organization secret `BOOTSTRAP_TOKEN` (D-358 lock (2)) is created through its own new-credentials gate (`docs/runbooks/bootstrap.md`). In the organization's Settings, Secrets and variables, Actions, set its Repository access to "Selected repositories" with no repository selected. Foreman, Launchpad and existing projects then have no access. The register form adds each new repository for its setup, Foreman removes it once Bootstrap's restart ends, and the reconcile pass removes any repository outside a project's first hour. Never select a repository by hand (the backstop's rehearsal check in "Registering a project" is the one exception), and never share the secret with all or private repositories: the form refuses (`secret_not_selected`) when GitHub answers that the secret is not shared with selected repositories.

Install the runner, Developer, Designer and QA Apps on all repositories of `didi-build` (D-347), so a repository the register-project form creates is reachable at once with no extra step. The installation is wide, the tokens are not: a run's token covers its one repository (O-60), and each runner token the permissions and repositories of its one step (D-346). `foreman` and `launchpad` stay protected by the privileged-path guard and Didi's merge approvals.

The Developer's and Designer's runs open their own pull requests with their run's token (D-235), and a cancelled item's close run comments on and closes one with the same token (D-318, O-98). Both need the Apps' pull request write permission and nothing more; check each App's permission page shows it, and nothing wider than the decisions name. Migration 0019 gives `developer:close` and `designer:close` their role's own route (D-324); if an operator removes those entries, each close run is refused with `no_route` and the daily check shows the pull request waiting for its close run.

In each project repository, protect builder branches against force pushes (a branch ruleset covering the runner's branch names), so the rule in the Developer's and Designer's instructions is also enforced by GitHub (D-245).

The admin workflows' five environments send deployment events like any other; the receiver acts only on deployments to `staging` (O-104), so it records theirs as deliveries and starts nothing.

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

  The hash is masked and never printed, and it is kept nowhere else: not in Windmill, not in Bitwarden (D-351). The job refuses a token outside the rule above, by name. Then it restarts the state API. The Secret is optional for the state API's pod: until it exists, no planning token is accepted. Once step 11a is applied, the chat's address is `https://foreman.didi.build/api` (D-271, D-282, D-343): it submits at `https://foreman.didi.build/api/plans` and reads at `https://foreman.didi.build/api/planning/projects/<slug>/{submissions,feedback,accepted}`, with the token as a bearer token in the `Authorization` header, never in the address.

- The three Windmill tokens that start flows (D-283, D-291, D-327, D-330, O-101, O-102), each its own approval. Before creating any of them, check on Windmill's token page ("Limit token permissions" and "Restrict paths") that a token can be limited to running exactly the scripts named below and nothing else: no other script, no reading or changing scripts, jobs, resources or variables. **If Windmill cannot narrow a token that far, stop and ask Didi before creating any credential** (D-283, D-291, D-330). Do not create a wider token, and do not use another kind of token (such as a webhook's own token) instead, without asking.
  - The state API's token: exactly the scope `jobs:run:scripts:f/foreman/plan_approval`, put through the `platform` environment secret `STATE_API_WINDMILL_TOKEN` into the Secret `state-api-windmill-plan-approval-token` (key `token`).
  - The GitHub receiver's token: exactly the scopes of its flow list (`RECEIVER_FLOW_PATHS` in `src/adapters/windmill/receiver-flows.ts`), the four scopes `jobs:run:scripts:f/foreman/option_capture`, `jobs:run:scripts:f/foreman/advance_item`, `jobs:run:scripts:f/foreman/verify_staging` and `jobs:run:scripts:f/foreman/remove_bootstrap_access` (D-329, O-101, O-104, O-114), put through the `platform` environment secret `RECEIVER_WINDMILL_TOKEN` into the Secret `github-receiver-windmill-token` (key `token`). A token made earlier with fewer scopes is made again with all four, and the old one revoked.
  - The run watcher's token: exactly the scope of its flow list (`RUN_WATCHER_FLOW_PATHS` in `src/adapters/windmill/run-watcher-flows.ts`), only `jobs:run:scripts:f/foreman/record_run_end`, put through the `platform` environment secret `RUN_WATCHER_WINDMILL_TOKEN` into the Secret `run-watcher-windmill-token` (key `token`).

  Generate each token in Windmill and paste it only into its `platform` environment secret: never into Windmill's resources, a file, the shell history, chat, Linear or a log. Each token lives only in that environment secret and in its Secret on the cluster (D-351). Each can be made again in Windmill, so it need not be kept in Bitwarden (D-341). Then run the cluster Secrets job (step 9), which puts each one into its Secret through stdin and restarts `state-api`, `github-receiver` and `run-watcher` as their Secrets change.

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
- The address: whether the `kubernetes` EndpointSlice's address changes after a control-plane upgrade. If it does, run the Platform workflow again: its plan and apply read the new address themselves.
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

### Registering a project

The register-project form (D-345, D-346, D-348, O-109) and `BOOTSTRAP_TOKEN`'s access during setup only (D-358, O-114) are built and tested with fakes, without a real GitHub, runner App or Windmill. To verify at its first real run, with no real personal data, and record each result with the date in O-109, or for the secret's access in O-114:

- The permission key: GitHub accepts `repository_creation: write` in the installation token request's `permissions`, beside `contents: read`, with `repositories: ["launchpad"]`. GitHub's documented keys for that request (read 2026-11-07) list none for "Repository creation", so the name is unproven. The token's answer should list `contents: read`, `metadata: read` and `repository_creation: write`, `repository_selection: selected` and `launchpad` only; the form refuses a token granted wider. If GitHub refuses the key, or names it differently, the form stops with `creation_token_refused` and creates nothing: record the answer's status and message (never the token), then stop and ask Didi. Do not mint the token without `permissions`, without `repositories`, or with "Administration".
- The narrowed create: with that token, narrowed to `launchpad`, `POST /repos/didi-build/launchpad/generate` creates the new repository in the organization and answers 201. Whether a token narrowed to the template may create a repository outside its list is unproven. If GitHub refuses it, the form stops with `create_refused` and records nothing: stop and ask Didi, and do not widen the token.
- The organization's repository creation setting: whether the setting that limits which members may create public repositories also applies to the runner App's create.
- The new repository: public, with the description, generated from `didi-build/launchpad` with only its default branch, and `GET /repos/didi-build/<slug>` names `template_repository.full_name` `didi-build/launchpad` (the reuse check reads it). Whether GitHub answers 422 to a create whose name is already taken, which is what leads the form to its reuse check.
- Bootstrap: its first run starts on the new repository's initial commit, before the repository is on `BOOTSTRAP_TOKEN`'s list, and fails for lack of the token.
- The secret (D-358, O-114): before the first registration, `BOOTSTRAP_TOKEN`'s page shows "Selected repositories" with none selected.
- The permission keys: GitHub accepts these installation token requests, and each answer lists exactly the permissions asked for (with `metadata: read`), `repository_selection: selected` and the one repository: `{"repositories":["<slug>"],"permissions":{"organization_secrets":"write","metadata":"read"}}`, `{"repositories":["foreman"],"permissions":{"organization_secrets":"read"}}` and `{"repositories":["<slug>"],"permissions":{"actions":"write"}}`. If GitHub refuses one, or names a key differently, the step stops (`grant_token_refused`, `restart_token_refused`, or the removal's and the backstop's `token`) and nothing is widened: record the answer's status and message (never the token), then stop and ask Didi.
- The grant: `GET /repos/didi-build/<slug>` with the change token (its `metadata: read`) answers the repository's `id`, and `PUT /orgs/didi-build/actions/secrets/BOOTSTRAP_TOKEN/repositories/<id>` answers 204. The secret's page then lists exactly the new repository.
- The restart: `POST /repos/didi-build/<slug>/actions/workflows/bootstrap.yml/dispatches` with `{"ref":"main"}` answers 204, a Bootstrap run started by `workflow_dispatch` on main appears at once, reads the secret and sets the repository up. `GET /repos/didi-build/<slug>/actions/workflows/bootstrap.yml/runs?event=workflow_dispatch&per_page=1` names that run first, with its `path` as `.github/workflows/bootstrap.yml`, with or without `@main`.
- The removal on finish: when the restarted run ends, the receiver logs `bootstrap access removal flow started` once, the flow answers `removed`, and the secret's page lists no repository. At rehearsal, once more with a restarted run that fails (cancel it from the Actions tab): the access is removed, the daily check says "Bootstrap failed for <slug>; run the register form again", and the form run again grants and restarts again. Record what GitHub answers to a `DELETE` for a repository that is not on the list.
- The backstop: at rehearsal, add `launchpad` to the secret's list by hand, then run the reconcile flow with dry run on: it reports `launchpad` as `would_remove` and removes nothing; with dry run off it removes it (`not_a_project`). A project's repository left on the list for an hour after registration is removed by the next pass (`window_passed`).
- No other repository keeps access: after a project's setup and the next reconcile pass, the secret's page lists no repository, `foreman` and `launchpad` included.
- The kill switch: with it on, the receiver starts no removal and the reconcile pass removes nothing (N-100).
- The settings read: `GET /repos/didi-build/foreman/contents/infra/kubernetes/settings/production.json?ref=main`, with the `contents: read` token minted for `didi-build/foreman` only, answers the file in base64, and the form lists the slugs from it.
- Nothing shows a token: the run's logs and result in Windmill hold no token and no GitHub answer body.
- Bootstrap's token job sees no repository code (D-358 lock 1, O-113): in the new repository's Bootstrap run, the `apply` job runs only `actions/checkout`, `actions/download-artifact` and `node .github/scripts/...`, with no `npm`, `npx` or `setup-node` step, and only its push and settings steps receive the token. Record the result with the date in O-113, with the other checks in `docs/runbooks/bootstrap.md` ("To verify at the first real run").
- Foreman's pushes stay no-ops: Bootstrap's run on Foreman's next push to `main` ends in the `decide` job (_Already initialized_), with `prepare` and `apply` skipped. Record it in O-113.

### A project's staging name and route

Each project's DNS record and Workers route (D-357, O-112) are built and tested with fixture plans, without a real Cloudflare zone or token. To verify at the first project's plan and apply, with no real personal data, and record each result with the date in O-112:

- The token: its summary page lists Cloudflare One Connector: cloudflared: Edit on the account and DNS: Edit and Workers Routes: Edit on the `didi.build` zone, and nothing else (step 3).
- The summary: the gates list `<slug>.didi.build` and `<slug>.didi.build/*` by name, each as `create`, and the plan changes nothing else.
- The record is proxied: Cloudflare's DNS records page shows `<slug>` as `AAAA` `100::`, Proxied, and a public lookup (`dig AAAA <slug>.didi.build`) answers Cloudflare's addresses, never `100::`. A second plan right after the apply shows no change, so Cloudflare keeps the content as written.
- The route before the Worker (not confirmed): whether Cloudflare accepts a route that names `<slug>-staging` before that Worker exists. Cloudflare's routes page lists "a Worker to invoke" among what a route needs, and its API reference marks the Worker optional and says nothing of one that does not exist (read 2026-11-07). If the apply refuses the route, record the error's code and message (never an id) and follow step 3 of "Adding a project".
- Before the first staging upload, `https://<slug>.didi.build/` serves no content: record the status and Cloudflare's error number it answers with (not confirmed which).
- After the first staging upload, `https://<slug>.didi.build/` serves the uploaded files, through the route.
- `foreman.didi.build` is untouched: the project plans change neither the receiver's record nor the tunnel, and after the apply the runner App's webhook deliveries to `https://foreman.didi.build/api/github/webhook` still reach the receiver (the App's Advanced page shows them delivered). If the settings file lists `foreman`, its plan has no record or route for it.

### The admin workflows

The three workflows (D-336, D-339, D-340, O-105) are built and tested with fake tools, without a real cluster, state, registry, Windmill or GitHub environment. To verify at their first real run, with no real personal data, and record each result with the date in O-105 (the runner token job's in O-110):

- The environments: the `tofu-apply`, `kubectl-apply`, `cluster-secrets` and `runner-token` jobs wait for Didi's approval, and the approval page links the run whose plan job's summary Didi reads; the plan jobs start without one. A run started by hand from another branch skips every job, and the environments' branch rule would refuse it anyway.
- The images: the job's own token with `packages: write` can create the seven packages under `didi-build`; whether they arrive private, and that each one, once public, pulls with no login (`docker pull ghcr.io/didi-build/foreman-state-api@sha256:...`) to the digest the summary gave. Each package shows this repository as its source.
- The credential: DigitalOcean accepts `--expiry-seconds` of 600, 900 and 1200; a `kubectl` call with the credential after that time is refused; and whether a credential already fetched stops working when the DigitalOcean token is revoked. The narrowest DigitalOcean token scopes that can plan, apply and fetch the credential (step 3).
- OpenTofu in the jobs: `-lockfile=readonly` passes with the committed lock file; the apply of the saved plan takes the passphrase from `TF_VAR_state_encryption_passphrase` and nothing else; `tofu output -raw receiver_tunnel_token` works in the Secrets job with only the R2 key and the passphrase, and no provider token.
- The published plan: the secret-value scan passes on a real plan; the summary shows no value marked sensitive, and no account, zone or resource id, receiver host name or bucket name, only their placeholders; the plan stays readable and within GitHub's 1 MiB summary limit. Whether GitHub's own masking also covers the job summary (the jobs do not rely on it).
- The platform diff: `kubectl diff --server-side` names its files `<group.>version.Kind.namespace.name`, so each object shows by kind, namespace and name; an object in a new namespace is listed as created; the apply creates each namespace before the objects in it.
- The checks: the `can-i` answers are as the step 7 list says; the probe pod is admitted by Pod Security `restricted` and by the agent namespace's quota, pulls the egress proxy image, and its DNS lookup and both connections fail inside their time limits (default deny on DOKS); each probe lands on its own pool.
- The address: the `kubernetes` EndpointSlice on DOKS lists plain IPv4 addresses and one `https` port, as `api-server-address.sh` expects.
- The API address stays hidden (D-349, O-107): the logs and the job summaries of the Infra apply and Platform runs, and the `platform-manifests` download, show no API server address (the download holds only the placeholder `192.0.2.1`); the factory stack's plan and apply show `cluster_endpoint` as a sensitive value and every other IPv4 address as `<ip>`; and a `kubectl` error that names the server (such as `Unable to connect to the server`, if one happens) shows its URL, host name and address masked (`***`). Whether `getent ahostsv4` resolves the API's host name on GitHub's runner, or the job prints its note that it does not.
- The Secrets job: a server-side apply takes over a Secret first made by `kubectl create`; a second run with the same values changes nothing and restarts nothing; an empty environment secret is named as skipped and its Secret is left as it is.
- The runner token job (D-352, O-110): the Windmill token's page shows exactly the one scope `resources:write:` with the three paths of step 8. The path limit holds: with that token, writing any other resource path, reading any other resource, listing resources, reading or writing a variable, and any other API call (for example listing jobs or running a script) are each refused; record the status (401 or 403). The job's three writes are accepted, both the first time and on a second run; record the status (201 expected). Windmill accepts the resource type `foreman_text`, which no resource type defines (a resource names its type without a foreign key in Windmill's code), and the workspace's resources page lists the three resources. DOKS fills in the Secret `foreman-runner-token` with a token within the job's minute. The logs show no token, endpoint or Windmill token, only `***` where one would be.
- The runner reads the written values: once the Windmill binding is written at step 15 (`flows/lib/windmill.ts`), it reads the token, the endpoint (`https://host[:port]`) and the CA certificate (PEM) from those three resources as `flows/windmill.yaml` describes them, and with them the runner's token creates a Job in `agents-<slug>` while the refused calls are refused (ADR 0106 check 4, at rehearsal).
- One run at a time: a second run of a workflow waits while the first's apply waits for Didi, and a third replaces the waiting second.
- The receiver: the deployment events of the five environments are recorded as deliveries and start nothing.
- The database migrations job (D-362, O-115): the list in step 9a, recorded in O-115.

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
