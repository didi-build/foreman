# Ephemeral: never saved in plan files or state, so `tofu show -json` cannot print it (ADR 0110).
variable "state_encryption_passphrase" {
  description = "Passphrase for state and plan encryption. From the vault; at least 16 characters."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = length(var.state_encryption_passphrase) >= 16
    error_message = "The state encryption passphrase must be at least 16 characters."
  }
}

variable "deploy_target" {
  description = "Deploy target for the scratch stack."
  type        = string
  default     = "cloudflare"
}

variable "target_settings" {
  description = "Settings for the deploy target. For cloudflare: account_id and zone_id of the scratch account. Never a real project's."
  type        = map(string)
}

variable "txt_content" {
  description = "Content of the scratch TXT record. Change it to prove a plan shows a diff."
  type        = string
  default     = "pf-scratch-m0-7 v1"
}
