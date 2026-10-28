# The API token comes from CLOUDFLARE_API_TOKEN in the environment, scoped to the scratch account.
provider "cloudflare" {}

resource "cloudflare_workers_kv_namespace" "scratch" {
  account_id = var.account_id
  title      = "pf-scratch-m0-7"
}

resource "cloudflare_dns_record" "scratch" {
  zone_id = var.zone_id
  name    = "pf-scratch-m0-7"
  type    = "TXT"
  content = "\"${var.txt_content}\""
  ttl     = 1 # automatic
}

output "kv_namespace_id" {
  value = cloudflare_workers_kv_namespace.scratch.id
}

output "dns_record_id" {
  value = cloudflare_dns_record.scratch.id
}
