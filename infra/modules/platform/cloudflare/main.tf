# Cloudflare platform module (D-146). The only place in infra/ where Cloudflare resources are declared.
# It is the infrastructure half of the deploy adapter. The provider token comes from CLOUDFLARE_API_TOKEN.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }
}

variable "name" {
  description = "Project or stack name, used to name resources."
  type        = string
}

variable "settings" {
  description = "Cloudflare settings: account_id and zone_id."
  type        = map(string)
}

variable "kv_stores" {
  description = "Key-value stores to create, by short name."
  type        = set(string)
}

variable "txt_records" {
  description = "TXT records to create: host name to content."
  type        = map(string)
}

resource "cloudflare_workers_kv_namespace" "store" {
  for_each   = var.kv_stores
  account_id = var.settings["account_id"]
  title      = "${var.name}-${each.key}"
}

resource "cloudflare_dns_record" "txt" {
  for_each = var.txt_records
  zone_id  = var.settings["zone_id"]
  name     = each.key
  type     = "TXT"
  content  = "\"${each.value}\""
  ttl      = 1 # automatic
}

output "kv_store_ids" {
  value = { for key, store in cloudflare_workers_kv_namespace.store : key => store.id }
}

output "txt_record_ids" {
  value = { for host, record in cloudflare_dns_record.txt : host => record.id }
}
