# Infrastructure as code

OpenTofu 1.13, state in Cloudflare R2, state and plans encrypted. Why and how: [ADR 0110](../docs/decisions/0110-infrastructure-as-code.md).

| Path                             | What                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `stacks/scratch/`                | The M0.7 proof. Throwaway: never a real project, zone or account.                                        |
| `stacks/factory/`                | The factory's own platform: the agent and platform cluster and the receiver's tunnel. Never applied yet. |
| `modules/project/`               | Target-agnostic: stacks call it with a `deploy_target`.                                                  |
| `modules/platform/cloudflare/`   | The only place Cloudflare is declared (D-146, checked by `npm run infra-boundaries`).                    |
| `modules/platform/digitalocean/` | The only place DigitalOcean is declared (D-146, checked by `npm run infra-boundaries`).                  |
| `kubernetes/`                    | The cluster's standing Kubernetes objects as typed data, and `render.ts`, which prints them to apply.    |

CI (`.github/workflows/infra.yml`) checks formatting and validates every stack on each PR that touches `infra/`. It uses no credentials and no backend. Each stack commits its `.terraform.lock.hcl` (hashes for Linux, Windows and macOS), and CI fails if providers drift from it. A new stack without one gets it generated and printed by CI, to commit.

## Secrets per stack

No secret value is ever written in a `.tf` or `.tfvars` file in this repo.

| Stack     | Secret                      | Where it comes from                                      | Stored in state? |
| --------- | --------------------------- | -------------------------------------------------------- | ---------------- |
| `scratch` | Cloudflare API token        | `CLOUDFLARE_API_TOKEN` at run time                       | No               |
| `scratch` | R2 access key and secret    | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` at run time | No               |
| `scratch` | State encryption passphrase | `TF_VAR_state_encryption_passphrase` at run time         | No               |
| `factory` | DigitalOcean API token      | `DIGITALOCEAN_TOKEN` at run time                         | No               |
| `factory` | Cloudflare API token        | `CLOUDFLARE_API_TOKEN` at run time                       | No               |
| `factory` | R2 access key and secret    | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` at run time | No               |
| `factory` | State encryption passphrase | `TF_VAR_state_encryption_passphrase` at run time         | No               |
| `factory` | Receiver tunnel token       | Made by Cloudflare; read by a data source                | Yes, encrypted   |
| `factory` | Cluster admin credential    | Fetched by the DigitalOcean provider, 1 hour lifetime    | Yes, encrypted   |

The two "Yes" rows are accepted only because state and plan are encrypted (ADR 0110, secrets rule 3). Neither is ever an output in plain form: the tunnel token is a sensitive output that is piped into a cluster Secret, and the admin credential is never an output at all (D-188).

## The factory stack: the cluster and the receiver's tunnel

Nothing here has been applied or planned against a real account. Didi applies it at first hosting, step by step, in [docs/runbooks/first-hosting.md](../docs/runbooks/first-hosting.md).

What it declares (ADR 0106 section 1, D-193 to D-195):

- One DOKS cluster in `tor1`, standard control plane (D-194), with auto-upgrade and a maintenance window as variables.
- Two node pools of one `s-2vcpu-4gb` node each (D-194; the price is confirmed on DigitalOcean's page at first hosting). `platform` carries the label `foreman/pool=platform`. `agents` carries `foreman/pool=agents` and the `NoSchedule` taint with the same key and value, exactly what the Kubernetes agent runtime adapter sets on run pods (`AGENTS_POOL`).
- The API endpoint allow-list (D-189) as `api_allowed_addresses`. Empty means no limit, and the runner's RBAC-limited token is the protection.
- A cloud firewall on the worker nodes with no inbound rule, and outbound HTTPS and DNS only. Any other outbound port is added to `extra_outbound_tcp_ports` with Didi's approval.
- The receiver's Cloudflare Tunnel, routing one host name and the webhook path to the receiver's in-cluster Service only, everything else to 404. Its DNS record is created only when `publish_receiver_dns = true` (a separate DNS gate).
- Outputs: the cluster id, its API address and its CA certificate, which are plain settings for the runner, and the tunnel token as a sensitive output. Never a kubeconfig or token for the cluster.

The stack calls the two platform modules directly, not through `modules/project`: the cluster and the tunnel are the factory's own platform, not a project deployed onto a target. It still names no provider (D-146). Its state is `factory/production.tfstate` in the same R2 bucket.

The Kubernetes objects that run on the cluster (the `foreman-platform` namespace, its default-deny policies, the state API, the receiver and the `cloudflared` connector, the runner's namespace and the agent namespaces) are in `kubernetes/`. They are typed data like the agent namespace objects of M3.2 slice 3, so the pool labels, Service names and ports are shared constants and the tests check both sides against them. Didi renders and applies them with his admin kubeconfig:

```bash
node infra/kubernetes/render.ts <settings.json outside the repo> | kubectl apply -f -
```

No Secret is declared there. Every Secret is referenced by name and created by Didi.

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
