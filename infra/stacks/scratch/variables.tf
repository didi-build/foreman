# Ephemeral: never saved in plan files or state, so `tofu show -json` cannot print it (ADR 0110).
variable "state_encryption_passphrase" {
  description = "Passphrase for state and plan encryption. From the vault; at least 16 characters."
  type        = string
  sensitive   = true
  ephemeral   = true
}

variable "account_id" {
  description = "The scratch Cloudflare account id."
  type        = string
}

variable "zone_id" {
  description = "The scratch zone id. Never a zone that serves a real project."
  type        = string
}

variable "txt_content" {
  description = "Content of the scratch TXT record. Change it to prove a plan shows a diff."
  type        = string
  default     = "pf-scratch-m0-7 v1"
}
