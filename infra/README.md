# Infrastructure as code

OpenTofu 1.13, state in Cloudflare R2, state and plans encrypted. Why and how: [ADR 0110](../docs/decisions/0110-infrastructure-as-code.md).

| Path              | What                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `stacks/scratch/` | The M0.7 proof. Throwaway: never a real project, zone or account.             |
| `modules/`        | Platform and project modules (ADR 0111). Created when a real stack needs one. |

CI (`.github/workflows/infra.yml`) checks formatting and validates every stack on each PR that touches `infra/`. It uses no credentials and no backend. Each stack commits its `.terraform.lock.hcl` (hashes for Linux, Windows and macOS), and CI fails if providers drift from it. A new stack without one gets it generated and printed by CI, to commit.

## Secrets per stack

No secret value is ever written in a `.tf` or `.tfvars` file in this repo.

| Stack     | Secret                      | Where it comes from                                      | Stored in state? |
| --------- | --------------------------- | -------------------------------------------------------- | ---------------- |
| `scratch` | Cloudflare API token        | `CLOUDFLARE_API_TOKEN` at run time                       | No               |
| `scratch` | R2 access key and secret    | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` at run time | No               |
| `scratch` | State encryption passphrase | `TF_VAR_state_encryption_passphrase` at run time         | No               |

## Running the M0.7 proof on the scratch stack

Needs (gates for Didi): a scratch Cloudflare account or zone, an API token scoped to it, an R2 bucket for state with versioning on, an R2 token scoped to that bucket, and a passphrase of at least 16 characters kept in the vault. Install OpenTofu 1.13 (`winget install --exact --id=OpenTofu.Tofu` on Windows).

In Git Bash, add `-input=false` to every command, and set `MSYS_NO_PATHCONV=1` if an argument starts with `/`.

```bash
cd infra/stacks/scratch
export CLOUDFLARE_API_TOKEN=...  AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...
export TF_VAR_state_encryption_passphrase=...  TF_VAR_account_id=...  TF_VAR_zone_id=...
tofu init -input=false -backend-config=bucket=<state bucket> \
  -backend-config='endpoints={s3="https://<account id>.r2.cloudflarestorage.com"}'

# 1. Apply, then a second plan must be a no-op (exit 0).
tofu apply -input=false
tofu plan -input=false -detailed-exitcode; echo "exit $?"

# 2. A deliberate change must show as a diff (exit 2, one update on cloudflare_dns_record).
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
