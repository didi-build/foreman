# First hosting runbook

**Purpose:** the gates Didi passes by hand, in order, to bring up the agent and platform cluster, the state API, the GitHub receiver and its tunnel for the first time (ADR 0106, ADR 0110, D-183 to D-195). Nothing here has been done yet. No agent or runner does any step.

**Rules for every step**

- Never paste a secret value into a file in the repo, a chat, Linear or a log. Read each one from the password manager or the vault and pipe it straight in (`--from-file=<key>=/dev/stdin`), so it never lands in a file or the shell history.
- Each gate is approved once, for that one request.
- In Git Bash on Windows, add `-input=false` to every `tofu` command (`infra/README.md`).

## 0. Answer the open questions first

These are not decided. Each one changes what the apply in step 5 does, so settle them before it.

1. **Database port.** The state API and the receiver connect to Supabase. The cloud firewall allows outbound HTTPS and DNS only, so the database port must be added to `extra_outbound_tcp_ports`, and it is the `databasePort` setting of the platform objects. Recommended: the Supabase pooler's port only (5432 in session mode, or 6543 in transaction mode, whichever the services use), nothing else.
2. **Tunnel port.** `cloudflared` reaches Cloudflare's edge on port 7844 (TCP and UDP), not 443. The connector's network policy and the cloud firewall allow 443 only, so the tunnel will not connect as written. Recommended: allow TCP and UDP 7844 to public addresses for the `cloudflared` pod only, and add 7844 to the cloud firewall.
3. **Whether the cloud firewall limits outbound at all.** DOKS manages its own firewall for the worker nodes. DigitalOcean combines the allow rules of every firewall on a droplet, so if the managed one allows all outbound traffic, the outbound rules here change nothing. Network policies stay the real egress control either way. Recommended: read DigitalOcean's docs on the DOKS managed firewall at this step, and keep the rules here as a second layer only if they take effect.
4. **The admin credential in state.** The DigitalOcean provider fetches an admin credential for the cluster and keeps it in state. State is encrypted and the credential is set to expire after 1 hour, but it is still an admin key outside the password manager (D-188). Recommended: accept it under ADR 0110 secrets rule 3, as listed in `infra/README.md`.

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

## 6. The admin kubeconfig, kept by Didi only (D-188)

Download the cluster's kubeconfig from the DigitalOcean control panel and keep it only in the password manager. It never goes to the runner, an agent or Windmill. Use it for steps 7 to 10.

## 7. Apply the cluster's standing objects

Write a settings file outside the repo (images pinned by digest, the app logins, the database port from step 0, resource limits, the projects and their quotas; no secrets), then:

```bash
node infra/kubernetes/render.ts <settings.json> | kubectl apply -f -
```

This creates the `foreman-platform` namespace and its policies and Deployments, the `foreman-runner` namespace and service account, and each `agents-<slug>` namespace. The platform pods wait for their Secrets (steps 8 to 10). Then run ADR 0106 checks 1 and 15: default deny holds, and pods stay on their own pool.

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

## 12. The model key with a spend cap (new-credentials gate)

Create the Anthropic API key for agent runs with a monthly spending limit at the provider (D-143, D-185). Store it at its secret path in Windmill resources. The runner puts it only into each run's egress proxy Secret; no agent holds it.

## 13. The GitHub Apps (D-178)

Register the GitHub Apps of D-156 together, each with its own identity. The runner App's webhook URL is `https://<receiver host name>/github/webhook`, with the webhook secret from step 10. Their private keys stay with the runner, never on the cluster.

## 14. Set `agent_cluster_max_active_runs`

Size it to the agents pool: the node's allocatable CPU and memory divided by one run's requests (agent, proxy and, for QA, fetch pods together). Write it as the setting in the store. While it is unset, every dispatch is refused.

## Verification

Run the remaining checks in ADR 0106 "How success is judged" on the real cluster, and record their output and date in the M3.2 PR. Never paste a secret value, `plan.json` or `state.json`.
