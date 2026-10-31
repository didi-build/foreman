# The factory's own platform (ADR 0110 layout: stacks/factory, state at factory/<env>.tfstate): the
# DOKS cluster with its two node pools and firewall (ADR 0106, D-193, D-194), and the receiver's
# Cloudflare Tunnel (D-195). Never applied by the runner or an agent. Didi applies it at first
# hosting (docs/runbooks/first-hosting.md).
terraform {
  required_version = "~> 1.13.0"

  # Providers are declared by the platform modules, not here (D-146). They read their tokens from
  # DIGITALOCEAN_TOKEN and CLOUDFLARE_API_TOKEN at run time.

  # State in R2 through the S3 backend, as for every stack (ADR 0110). The bucket, endpoint and keys
  # are passed at init time:
  #   tofu init -backend-config=bucket=... -backend-config='endpoints={s3="https://<account>.r2.cloudflarestorage.com"}'
  # with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY set to the R2 token. Never written here.
  backend "s3" {
    key                         = "factory/production.tfstate"
    region                      = "auto"
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }

  # State and plan files are encrypted with a passphrase from the vault
  # (TF_VAR_state_encryption_passphrase). This state holds the tunnel token and a short-lived admin
  # credential for the cluster, so encryption is required, not optional (ADR 0110 secrets rule 3).
  encryption {
    key_provider "pbkdf2" "main" {
      passphrase = var.state_encryption_passphrase
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.main
    }
    state {
      method   = method.aes_gcm.main
      enforced = true
    }
    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }
}
