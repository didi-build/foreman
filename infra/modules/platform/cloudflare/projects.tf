# Each project's staging name (D-345, D-353, D-357, O-112): a proxied DNS record for
# `<slug>.didi.build` and a Workers route `<slug>.didi.build/*` to the project's assets-only Worker
# `<slug>-staging`, which the runner's staging deploy uploads to (D-353). Only this module makes
# them, in the factory stack's plan that Didi approves, so every DNS change keeps its own
# approval. The staging deploy's token makes no name (D-357).
#
# The Worker answers every path, so the record has no origin. Its content is the placeholder
# Cloudflare documents for an originless proxied record, `100::` from the IPv6 discard prefix
# (developers.cloudflare.com, "Create DNS records", Originless setups, and the Workers best
# practices page: "If you do not have a real origin, add a proxied AAAA record pointing to 100::
# as a placeholder"; both read 2026-11-07). The record is proxied, so no request reaches that
# address.
#
# The route names the Worker before the first staging upload creates it. Cloudflare's docs do not
# say whether a route may name a Worker that does not exist yet, so that is on the first-hosting
# runbook's first-run list. The route waits for its record, the order Cloudflare's routes page
# gives ("Set up a route": a proxied DNS record for the host name, then the route).
#
# A project whose host name is the receiver's (`foreman.didi.build`, D-343) gets neither: that
# name is the cluster's one public door, its record is the receiver's CNAME behind its own DNS
# gate, and a route on it would send `/api` to a Worker. It is skipped, not refused, because the
# `foreman` project is listed in the settings file like any other (D-344, D-345). How Foreman's own
# frontend shares that host name is N-96.

variable "project_staging" {
  description = "Each project's staging name and Workers route (D-357): the zone they are under and the project slugs from the platform settings file. Null makes none."

  type = object({
    domain = string
    slugs  = list(string)
  })

  default = null

  # The project-slug rule the code uses (PROJECT_SLUG, src/core/register-project.ts).
  validation {
    condition     = alltrue([for slug in try(var.project_staging.slugs, []) : can(regex("^[a-z0-9][a-z0-9-]{0,99}$", slug))])
    error_message = "Each project slug in infra/kubernetes/settings/production.json must follow the project-slug rule: lowercase letters, digits and hyphens, starting with a letter or a digit, at most 100 characters."
  }

  validation {
    condition     = length(distinct(try(var.project_staging.slugs, []))) == length(try(var.project_staging.slugs, []))
    error_message = "A project slug is listed more than once in infra/kubernetes/settings/production.json."
  }

  validation {
    condition     = var.project_staging == null || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.project_staging.domain))
    error_message = "The projects' domain must be a lowercase DNS name, such as didi.build."
  }
}

locals {
  receiver_hostname = var.receiver_tunnel == null ? null : lower(var.receiver_tunnel.hostname)

  # Each project's host name to its slug, without the receiver's own host name.
  project_hosts = {
    for slug in try(var.project_staging.slugs, []) : "${slug}.${var.project_staging.domain}" => slug
    if "${slug}.${var.project_staging.domain}" != local.receiver_hostname
  }
}

resource "cloudflare_dns_record" "project" {
  for_each = local.project_hosts
  zone_id  = var.settings["zone_id"]
  name     = each.key
  type     = "AAAA"
  content  = "100::"
  proxied  = true
  ttl      = 1 # automatic
  comment  = "A project's staging name, served by its Worker route (D-357)"
}

resource "cloudflare_workers_route" "project" {
  for_each = local.project_hosts
  zone_id  = var.settings["zone_id"]
  pattern  = "${each.key}/*"
  script   = "${each.value}-staging"

  depends_on = [cloudflare_dns_record.project]
}
