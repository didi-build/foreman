# 0110. Infrastructure as code: tool, state, secrets and layout

- **Status:** proposed. O-08 is "decide during build"; reviewed with the other Milestone 0 ADRs at the end of M0. The scratch-project proof waits for a scratch Cloudflare account or zone and a token, which are gates for Didi.
- **Date:** 2026-10-28
- **Related:** O-08, D-133, D-134, [build plan M0.7](../build-plan.md#m07-infrastructure-as-code-baseline-proposed-d-133), `docs/architecture/technical-architecture.md` sections 2.9 and 2.10

## Context

Infrastructure is declared as code (D-133). A plan is the exact diff a gate shows Didi. Plans and state must never contain secret values. Production applies are Didi's. Kubernetes comes in the second release (D-134), so modules must separate the platform from projects and take a deploy target.

Facts below were read on 2026-10-28 from primary sources: tool and provider changelogs, provider source code, the OpenTofu registry repository, and Cloudflare's R2 documentation. Several registry and documentation sites could not be opened from this cloud session, so some points rely on those sources' GitHub copies.

## Decision

### Tool: OpenTofu 1.13

Pinned with `required_version = "~> 1.13.0"`. Reasons:

- Built-in state and plan encryption (since 1.7). Terraform has none, and relies on the backend's own encryption.
- MPL-2.0 licence. Terraform is BSL 1.1.
- The providers we need are in the OpenTofu registry: Cloudflare v5, Supabase v1, GitHub v6.
- Ephemeral variables and write-only attributes are supported (since 1.11).

Code stays compatible with Terraform apart from the `encryption` block, so switching later is cheap.

### State: one Cloudflare R2 bucket, encrypted, with locking

- A dedicated R2 bucket for state, with versioning, through the `s3` backend with the flags Cloudflare documents for R2.
- `use_lockfile = true` for locking. R2 supports the conditional writes it needs. That this works end to end on R2 is not yet proven, so the scratch proof tests two plans at once.
- One state file per stack and environment: `projects/<slug>/<env>.tfstate`, and `factory/<env>.tfstate` for the factory's own resources.
- **Encryption enforced** for both state and plan files, with the `pbkdf2` key provider. The passphrase comes from the vault at run time (`TF_ENCRYPTION`). A stronger key provider (a KMS or OpenBao transit) replaces it when the vault offers one (Vault arrives with Kubernetes).
- Backend credentials come from environment variables, never from the backend block.
- The passphrase variable is `ephemeral`, because a plain variable's value is saved in plan files and `tofu show -json` prints it. Not yet confirmed: that OpenTofu accepts an ephemeral variable inside the `encryption` block. If it does not, the key provider moves into the `TF_ENCRYPTION` environment variable instead. The scratch proof's secret scan settles it either way.

Free tier: R2's free storage covers this many times over.

**R2 stays until Kubernetes exists (D-144).** The outside review pointed out that keeping state in R2 ties the record of all infrastructure to the vendor we plan to leave. Didi decided to keep R2 for the first release and move state once the Kubernetes platform is set up (`tofu init -migrate-state`, one command). Encryption means Cloudflare cannot read the state meanwhile.

**Providers are locked.** Each stack commits its `.terraform.lock.hcl`, with hashes for Linux, Windows and macOS. CI runs `tofu init -lockfile=readonly`, so a provider version or hash that differs from the lock file fails the build. If a stack has no lock file, CI generates one, prints it and fails until it is committed.

### Secrets: never in code; encrypted where a provider insists on storing them

1. Secret values are never written in `.tf` files or `.tfvars` in the repo.
2. Worker secrets are set at deploy time from the vault (for example `wrangler secret put` in the deploy job), not declared in IaC. Cloudflare provider v5 ignores secrets it does not manage, so this causes no drift. Secrets Store bindings, which name a secret and never hold its value, are the preferred form where they fit.
3. Some resources store a sensitive value in state whatever we do: an API token's value, a Hyperdrive origin password, a Supabase database password. Those either stay out of IaC (created by hand or by the deploy adapter, then referenced by id) or are accepted only because state and plan are encrypted. Each case is listed in the stack's README.
4. Variables that must carry a secret are declared `ephemeral = true`.
5. CI posts only the human-readable `tofu show -no-color` output, which redacts sensitive values. The JSON form of a plan prints sensitive values in plain text, so it is never uploaded or logged. Scripts read only resource types and actions from it.
6. A scan of plan output and state for known secret values (canaries in tests, real values in the deploy job) fails the run if any value appears. `scripts/lib/find-secret-values.mjs` matches each secret as is, JSON-escaped (as in `state.json`), URL-encoded, and base64 or base64url encoded at every alignment, and never prints what it found. The passphrase variable has a validation block requiring at least 16 characters. The scan becomes a CI step in the deploy adapter's plan job (M3.7); until then it is run by hand as in `infra/README.md`.

### Layout

```
infra/
  README.md                    how to run, Windows notes, the secrets list per stack
  stacks/
    scratch/                   M0.7 proof only; never a real project
    factory/<env>/             the factory's own resources (later)
    projects/<slug>/<env>/     one per project and environment (later)
  modules/                     platform and project modules, shaped by ADR 0111 (M0.8)
```

Only `infra/stacks/scratch/` is created in M0.7. The module split between platform and project, with a deploy target, is an ADR 0111 convention and is built when the first real stack needs it.

Plan classification (DNS changes, deletions, new secrets, wider permissions opening their gates) belongs to the deploy adapter in M3.7, not here. The JSON fields it will use are recorded in the research notes: `resource_changes[].type` and `change.actions`.

### Windows (Didi's machine)

Install with `winget install --exact --id=OpenTofu.Tofu`. In Git Bash, run with `-input=false`, and set `MSYS_NO_PATHCONV=1` when an argument starts with `/`. `.gitattributes` keeps `.tf` files and the provider lock file on LF line endings. The lock file holds hashes for both Windows and Linux (`tofu providers lock -platform=windows_amd64 -platform=linux_amd64`).

## Constraints

- Scratch project only in M0. No real project, zone or account is touched.
- Creating the scratch Cloudflare token, the R2 bucket and its keys, and the encryption passphrase is the new-credentials gate: Didi does it.
- Production applies are never run by the runner or an agent.
- Cloudflare-specific application code lives only in `src/adapters/deploy/` (essential 9), enforced by lint for every code folder (ADR 0101). `infra/` declares Cloudflare resources as configuration. Whether that, and Launchpad's gallery Worker config, is acceptable under essential 9 is open for Didi (N-20).

## How success is judged

The M0.7 checks, run on the scratch stack once the credentials exist:

1. After `tofu apply`, a second `tofu plan -detailed-exitcode` exits 0 (no changes).
2. Changing the scratch DNS record's content gives exit 2 and a single update on `cloudflare_dns_record`.
3. Two plans started at once: one waits or fails on the state lock.
4. A canary value passed as an ephemeral variable is not found in the plan text, the plan JSON, the pulled state, or the raw object in R2 (which must be ciphertext).
5. `tofu destroy` cleans the scratch stack up.

Before credentials exist: `tofu fmt -check` passes, and the secret-value scanner has tests that pass and fail.

## Reasons

- OpenTofu's encryption is the only built-in way to keep provider-stored secrets out of readable state.
- R2 keeps state with a provider already in use, costs nothing at this size, and needs no new vendor.
- Setting Worker secrets at deploy time keeps the largest class of secrets out of state entirely.

Alternatives considered:

- Terraform with HCP Terraform state: the free tier changed in 2026, needs an account, and stores state readable by HashiCorp. Not needed.
- The Postgres backend on the state store's own database: mixes infrastructure state with the system's own data, and its locking needs a session connection.
- Terraform with R2: no client-side encryption, so provider-stored secrets sit in readable state.

## Consequences

- Every apply needs the encryption passphrase. Losing it makes state unreadable, so it is backed up in the vault.
- Some resources stay outside IaC on purpose (those that only store a secret). They are listed, so nothing is hidden.
- Existing resources of current projects are imported after cutover, per the architecture.
