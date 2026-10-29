# Project module (D-146, ADR 0111). Target-agnostic: stacks describe what a project needs, and the
# platform module for the chosen deploy target creates it. Adding a target adds one platform module
# and one block here; existing stacks do not change.

variable "name" {
  description = "Project or stack name."
  type        = string
}

variable "deploy_target" {
  description = "Where the project runs. Each target has a platform module under modules/platform/."
  type        = string

  validation {
    condition     = contains(["cloudflare"], var.deploy_target)
    error_message = "Unknown deploy target. Add a platform module under infra/modules/platform/ first."
  }
}

variable "target_settings" {
  description = "Settings the chosen platform module needs, for example account and zone ids."
  type        = map(string)
}

variable "kv_stores" {
  description = "Key-value stores the project needs, by short name."
  type        = set(string)
  default     = []
}

variable "txt_records" {
  description = "TXT records the project needs: host name to content."
  type        = map(string)
  default     = {}
}

module "cloudflare" {
  source = "../platform/cloudflare"
  count  = var.deploy_target == "cloudflare" ? 1 : 0

  name        = var.name
  settings    = var.target_settings
  kv_stores   = var.kv_stores
  txt_records = var.txt_records
}

output "kv_store_ids" {
  value = var.deploy_target == "cloudflare" ? module.cloudflare[0].kv_store_ids : {}
}

output "txt_record_ids" {
  value = var.deploy_target == "cloudflare" ? module.cloudflare[0].txt_record_ids : {}
}
