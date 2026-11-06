# Infrastructure as code

OpenTofu 1.13, state in Cloudflare R2, state and plans encrypted. Why and how: [ADR 0110](../docs/decisions/0110-infrastructure-as-code.md).

| Path                             | What                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stacks/scratch/`                | The M0.7 proof. Throwaway: never a real project, zone or account.                                                                                                               |
| `stacks/factory/`                | The factory's own platform: the agent and platform cluster and the receiver's tunnel, and `production.tfvars`, its reviewed variables. Never applied yet.                       |
| `modules/project/`               | Target-agnostic: stacks call it with a `deploy_target`.                                                                                                                         |
| `modules/platform/cloudflare/`   | The only place Cloudflare is declared (D-146, checked by `npm run infra-boundaries`).                                                                                           |
| `modules/platform/digitalocean/` | The only place DigitalOcean is declared (D-146, checked by `npm run infra-boundaries`).                                                                                         |
| `kubernetes/`                    | The cluster's standing Kubernetes objects as typed data, `render.ts`, which prints them to apply, and `settings/production.json`, the reviewed settings they are rendered from. |

CI (`.github/workflows/infra.yml`) checks formatting and validates every stack on each PR that touches `infra/`. It uses no credentials and no backend.

The applies run as GitHub Actions jobs that wait for Didi's approval, only from main and never on a pull request (D-339, O-105):

- `.github/workflows/infra-apply.yml` plans the factory stack in the environment `infra-plan`, runs the secret-value scan below on the plan text before anything is published, writes the readable plan to the job summary, and keeps the encrypted plan file for one day. Its apply job, in the environment `infra` with Didi as the required reviewer, applies that saved plan file and nothing else.
- `.github/workflows/platform.yml` renders `kubernetes/settings/production.json`, diffs it against the cluster in the environment `platform-plan`, and applies it in the environment `platform` once Didi approves, then runs the first-hosting checks. Its cluster Secrets job, also in `platform`, creates the Secrets the platform pods read.
- Each job that reaches the cluster fetches its own short-lived admin credential with the DigitalOcean token (`doctl kubernetes cluster kubeconfig show --expiry-seconds`, for the job's time limit) and removes it at its end (D-340). Nothing long-lived is kept for cluster access. Each stack commits its `.terraform.lock.hcl` (hashes for Linux, Windows and macOS), and CI fails if providers drift from it. A new stack without one gets it generated and printed by CI, to commit.

## Secrets per stack

No secret value is ever written in a `.tf` or `.tfvars` file in this repo.

| Stack     | Secret                             | Where it comes from                                                                                                                  | Stored in state? |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `scratch` | Cloudflare API token               | `CLOUDFLARE_API_TOKEN` at run time                                                                                                   | No               |
| `scratch` | R2 access key and secret           | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` at run time                                                                             | No               |
| `scratch` | State encryption passphrase        | `TF_VAR_state_encryption_passphrase` at run time                                                                                     | No               |
| `factory` | DigitalOcean API token             | `DIGITALOCEAN_TOKEN` at run time, from the environments' secret `DIGITALOCEAN_TOKEN`                                                 | No               |
| `factory` | Cloudflare API token               | `CLOUDFLARE_API_TOKEN` at run time, from the secret `CLOUDFLARE_API_TOKEN`                                                           | No               |
| `factory` | R2 access key and secret           | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` at run time, from the secrets `R2_STATE_ACCESS_KEY_ID` and `R2_STATE_SECRET_ACCESS_KEY` | No               |
| `factory` | State encryption passphrase        | `TF_VAR_state_encryption_passphrase` at run time, from the secret `STATE_ENCRYPTION_PASSPHRASE` (kept in Bitwarden, D-341)           | No               |
| `factory` | Receiver tunnel token              | Made by Cloudflare; read by a data source                                                                                            | Yes, encrypted   |
| `factory` | Cluster admin credential           | Fetched by the DigitalOcean provider, 1 hour lifetime                                                                                | Yes, encrypted   |
| `factory` | The admin jobs' cluster credential | Fetched by each job with `doctl`, for the job's time limit, then removed (D-340)                                                     | No               |

The two "Yes" rows are accepted only because state and plan are encrypted (ADR 0110, secrets rule 3). Neither is ever an output in plain form: the tunnel token is a sensitive output that the cluster Secrets job pipes into a cluster Secret, and the admin credential is never an output at all (D-188). The Cloudflare account and zone ids, the receiver's host name and the state bucket's name are not secrets: they are the environments' variables, checked against their own patterns before use and kept out of the public logs and summaries (O-105). The stack's other non-secret values are in `stacks/factory/production.tfvars`, so a change to them is a pull request.

## The factory stack: the cluster and the receiver's tunnel

Nothing here has been applied or planned against a real account. The Infra apply workflow plans it and, once Didi approves, applies it at first hosting, step by step as [docs/runbooks/first-hosting.md](../docs/runbooks/first-hosting.md) says (D-339).

What it declares (ADR 0106 section 1, D-193 to D-195):

- One DOKS cluster in `tor1`, standard control plane (D-194), with auto-upgrade and a maintenance window as variables.
- Two node pools of one `s-2vcpu-4gb` node each (D-194; the price is confirmed on DigitalOcean's page at first hosting). `platform` carries the label `foreman/pool=platform`. `agents` carries `foreman/pool=agents` and the `NoSchedule` taint with the same key and value, exactly what the Kubernetes agent runtime adapter sets on run pods (`AGENTS_POOL`).
- The API endpoint allow-list (D-189) as `api_allowed_addresses`. Empty means no limit, and the runner's RBAC-limited token is the protection.
- A cloud firewall on the worker nodes with no inbound rule. Outbound: HTTPS, DNS, Supabase's session pooler (5432/tcp) and Cloudflare's tunnel edge (7844 tcp and udp). Any other outbound port is added to `extra_outbound_tcp_ports` with Didi's approval. Inside the cluster, network policies limit 5432 to the state API and the receiver, and 7844 to the `cloudflared` pod.
- DOKS keeps its own firewall on the worker nodes, and DigitalOcean combines the allow rules of every firewall on a droplet. If the managed one allows all outbound traffic, these outbound rules change nothing. Decided by D-331: inside the cluster, the network policies and the egress proxies are the real outbound control. At first hosting, step 5, Didi checks what the managed worker firewall allows outbound and records the result in the runbook; this firewall stays as a second layer if its outbound rules take effect. No deny rule is added, and DigitalOcean's managed firewalls are never edited: its reconciler owns them by name.
- The DigitalOcean provider keeps an admin credential for the cluster in state. It is set to expire after 1 hour (`kubeconfig_expire_seconds`), and state is encrypted. It is never an output. Didi accepted this under ADR 0110 secrets rule 3 (D-332).
- The receiver's Cloudflare Tunnel, routing one host name, the cluster's one public door `foreman.didi.build` (D-343), and the webhook path `/api/github/webhook` to the receiver's in-cluster Service only, everything else to 404. Every machine-facing path on that host name is under `/api`; the future frontend will own the rest. Its DNS record is created only when `publish_receiver_dns = true` (a separate DNS gate).
- Once Didi passes the tunnel gate (`expose_planning_route = true`, D-271), one more rule on the same host name: exactly the planning chat's paths `/api/plans` and `/api/planning/projects/<slug>/{submissions,feedback,accepted}` (D-282, D-343), to the state API's public Service, whose port serves those routes only, with a size and a rate limit (O-83, O-106). No new DNS record.
- Outputs: the cluster id, its API address and its CA certificate, which are plain settings for the runner, and the tunnel token as a sensitive output. Never a kubeconfig or token for the cluster.

The stack calls the two platform modules directly, not through `modules/project`: the cluster and the tunnel are the factory's own platform, not a project deployed onto a target. It still names no provider (D-146). Its state is `factory/production.tfstate` in the same R2 bucket.

The Kubernetes objects that run on the cluster (the `foreman-platform` namespace, its default-deny policies, the state API, the receiver, the `cloudflared` connector, the shared Windmill egress proxy (D-328) and the run watcher with its ServiceAccount (D-330), the runner's namespace and the agent namespaces with the runner's and the run watcher's Roles) are in `kubernetes/`. The run watcher's Role, in each agent namespace only, is get, list and watch on Jobs and nothing else; its network policy reaches only cluster DNS, the API server's own address and port (`kubernetesApi` in the settings file) and the Windmill proxy. They are typed data like the agent namespace objects of M3.2 slice 3, so the pool labels, Service names and ports are shared constants and the tests check both sides against them. The Platform workflow renders them from `kubernetes/settings/production.json`, with the API server's address read from the cluster at run time, in a job with no secret, and applies them once Didi approves, with a short-lived credential (D-339, D-340). The render on its own, with the settings file plus `kubernetesApi`:

```bash
node infra/kubernetes/render.ts <settings.json>
```

No Secret is declared there. Every Secret is referenced by name and created by the Platform workflow's cluster Secrets job from the `platform` environment's secrets.

Not validated in this repo yet: `tofu fmt`, `tofu init` and `tofu validate` on the factory stack, because OpenTofu and the provider registry were not reachable when it was written. CI runs them on the first PR, and generates the stack's lock file for it to be committed (see above).

## Running the M0.7 proof on the scratch stack

Moved to the start of M3.7, on the rehearsal project (D-174). The steps below stay as the reference for that run.

Needs (gates for Didi): a scratch Cloudflare account or zone, an API token scoped to it, an R2 bucket for state with versioning on, an R2 token scoped to that bucket, and a passphrase of at least 16 characters kept in the vault. Install OpenTofu 1.13 (`winget install --exact --id=OpenTofu.Tofu` on Windows).

In Git Bash, add `-input=false` to every command, and set `MSYS_NO_PATHCONV=1` if an argument starts with `/`.

```bash
cd infra/stacks/scratch
export CLOUDFLARE_API_TOKEN=...  AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...
export TF_VAR_state_encryption_passphrase=...
export TF_VAR_target_settings='{account_id="...",zone_id="..."}'   # the scratch account only
tofu init -input=false -backend-config=bucket=<state bucket> \
  -backend-config='endpoints={s3="https://<account id>.r2.cloudflarestorage.com"}'

# 1. Apply, then a second plan must be a no-op (exit 0).
tofu apply -input=false
tofu plan -input=false -detailed-exitcode; echo "exit $?"

# 2. A deliberate change must show as a diff (exit 2, one update on the cloudflare_dns_record in the platform module).
tofu plan -input=false -detailed-exitcode -var 'txt_content=pf-scratch-m0-7 v2'; echo "exit $?"

# 3. Locking: start two plans at once. One must wait or fail on the state lock.
tofu plan -input=false -lock-timeout=0s & tofu plan -input=false -lock-timeout=0s; wait

# 4. No secret value in plan output or state. Run from the repo root.
tofu plan -input=false -out=plan.out
tofu show -no-color plan.out > plan.txt
tofu show -json plan.out > plan.json        # contains sensitive values in plain text: delete after the scan
tofu state pull > state.json
cd ../../..
SECRET_ENV_NAMES=CLOUDFLARE_API_TOKEN,AWS_SECRET_ACCESS_KEY,TF_VAR_state_encryption_passphrase \
  node scripts/find-secret-values.mjs infra/stacks/scratch/plan.txt infra/stacks/scratch/plan.json infra/stacks/scratch/state.json
rm infra/stacks/scratch/plan.json infra/stacks/scratch/plan.out

# 5. Clean up.
cd infra/stacks/scratch && tofu destroy -input=false
```

Also download the raw state object from the R2 bucket and confirm it is ciphertext, not JSON. Paste the outputs of steps 1 to 5 into the M0.7 PR, with the date. Never paste `plan.json` or `state.json` themselves.
