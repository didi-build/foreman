# First hosting runbook

**Purpose:** the gates Didi passes by hand, in order, to bring up the agent and platform cluster, the state API, the GitHub receiver and its tunnel for the first time (ADR 0106, ADR 0110, D-183 to D-195). Nothing here has been done yet. No agent or runner does any step.

**Rules for every step**

- Never paste a secret value into a file in the repo, a chat, Linear or a log. Read each one from the password manager or the vault and pipe it straight in (`--from-file=<key>=/dev/stdin`), so it never lands in a file or the shell history.
- Each gate is approved once, for that one request.
- In Git Bash on Windows, add `-input=false` to every `tofu` command (`infra/README.md`).

## 0. Answer the open questions first

Settle these before the apply in step 5.

Decided on 2026-10-31 by the coordinator: the database is Supabase's session pooler on 5432 (session mode, because the store uses transactions and advisory locks; the pooler is reachable over IPv4, the direct host is IPv6 only), and `cloudflared` reaches Cloudflare's edge on 7844 tcp and udp. Both are in the firewall and the network policies already. Still open, each needing Didi:

1. **Whether the cloud firewall limits outbound at all.** DOKS manages its own firewall for the worker nodes. DigitalOcean combines the allow rules of every firewall on a droplet, so if the managed one allows all outbound traffic, the outbound rules here change nothing. Network policies stay the real egress control either way. Recommended: read DigitalOcean's docs on the DOKS managed firewall at this step, and keep the rules here as a second layer only if they take effect.
2. **The admin credential in state.** The DigitalOcean provider fetches an admin credential for the cluster and keeps it in state. State is encrypted and the credential is set to expire after 1 hour, but it is still an admin key outside the password manager (D-188). Recommended: accept it under ADR 0110 secrets rule 3, as listed in `infra/README.md`.

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

Write a settings file outside the repo (images pinned by digest, the app logins, resource limits (`databasePort` defaults to 5432), the projects and their quotas; no secrets), then:

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

## 11a. The planning chat's paths on the tunnel (tunnel gate, D-271, D-282)

This changes the tunnel's routing only: one more rule on the receiver's host name, for the planning chat's paths exactly (`/plans` and `/planning/projects/<slug>/{submissions,feedback,accepted}`), to the state API's public Service (`http://state-api-public.foreman-platform.svc.cluster.local:8081`). That port serves `POST /plans` and those three reads as `GET` and nothing else, with a 64 KiB size limit and 20 requests a minute (ADR 0102, O-83, D-282). No DNS record is added.

Set `TF_VAR_expose_planning_route=true`, plan, and check the plan changes only `cloudflare_zero_trust_tunnel_cloudflared_config.receiver`, adding exactly one ingress rule with `path = "^/(plans|planning/projects/[a-z0-9][a-z0-9-]{0,99}/(submissions|feedback|accepted))$"` before the 404 rule, and nothing else. Then apply it. Check from outside: `POST https://<receiver host name>/plans` and `GET https://<receiver host name>/planning/projects/<slug>/submissions` with no token answer 401, and `GET /plans`, `POST` on a read path and any other path answer 404. Only after step 15 creates the planning token does a submission go through.

## 12. The model key with a spend cap (new-credentials gate)

Create the Anthropic API key for agent runs with a monthly spending limit at the provider (D-143, D-185). Store it at its secret path in Windmill resources. The runner puts it only into each run's egress proxy Secret; no agent holds it.

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

- The state API's Windmill credential for the plan-approval flow (D-273 (2)). First check that Windmill can issue a token that can run `f/foreman/plan_approval` and nothing else (N-76); if it cannot, stop and ask Didi. The state API also needs egress on 443 to Windmill, a wider permission for its pod (N-76). Store the token at `platform/state-api/windmill-plan-approval-token` in Windmill resources and in the state API's Secret, piped straight in:

  ```bash
  kubectl -n foreman-platform create secret generic state-api-windmill-plan-approval-token --from-file=token=/dev/stdin
  kubectl -n foreman-platform rollout restart deployment/state-api
  ```

  Then write the Windmill call in `src/adapters/windmill/plan-approval-flow.ts` against Windmill's own API. Until then every start is refused, the API logs `plan approval flow not started` with the error's type, and the reconcile pass opens the request.

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

## Verification

Run the remaining checks in ADR 0106 "How success is judged" on the real cluster, and record their output and date in the M3.2 PR. Never paste a secret value, `plan.json` or `state.json`.
