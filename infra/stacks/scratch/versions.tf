# M0.7 scratch stack (ADR 0110). Throwaway: never point it at a real project, zone or account.
terraform {
  required_version = "~> 1.13.0"

  # Providers are declared by the platform modules, not here (D-146).

  # State in R2 through the S3 backend. The bucket, endpoint and keys are passed at init time:
  #   tofu init -backend-config=bucket=... -backend-config='endpoints={s3="https://<account>.r2.cloudflarestorage.com"}'
  # with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY set to the R2 token. Never written here.
  backend "s3" {
    key                         = "scratch/m0-7.tfstate"
    region                      = "auto"
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }

  # State and plan files are encrypted with a passphrase from the vault (TF_VAR_state_encryption_passphrase).
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
