# The GitHub receiver's Cloudflare Tunnel (D-195, ADR 0106 section 1). A connector pod on the
# cluster's platform pool dials out to Cloudflare, so the cluster opens no inbound port. The tunnel
# routes one host name and one path to the receiver's internal Service, and nothing else. The host
# name is the cluster's one public door, `foreman.didi.build`, and every machine-facing path on it
# is under `/api` (D-343): the webhook path is `/api/github/webhook`.
#
# D-271 adds one more rule on the same tunnel and host name, set only when Didi passes the tunnel
# gate at first hosting: the planning chat's paths to the state API's public Service, whose port
# serves the planning chat's routes and nothing else (`POST /api/plans` and, since D-282, the three
# planning reads under `/api/planning/projects/<slug>/`), with a size and a rate limit
# (src/api/public.ts). The tunnel's ingress rules match host name and path only, not the method,
# and cannot rewrite the path, so the method, size and rate checks and the `/api` prefix are
# handled on that port. The path pattern is fixed here, not a setting, so it cannot be widened by a
# variable. Every other path gets the tunnel's 404.
#
# Gates at first hosting (D-195): the tunnel token is a new credential, and the DNS record is a DNS
# change. The token is kept in (encrypted) state and is a sensitive output. It is piped straight
# into a Kubernetes Secret and never written to a file in this repo (docs/runbooks/first-hosting.md).

variable "receiver_tunnel" {
  description = "The receiver's tunnel: its public host name on the zone, the one path it serves, and the in-cluster Service URL it routes to, and whether to publish its DNS record (a separate DNS gate). Null creates no tunnel."

  type = object({
    hostname    = string
    path        = string
    service_url = string
    publish_dns = bool
  })

  default = null

  validation {
    condition     = var.receiver_tunnel == null || can(regex("^http://[a-z0-9-]+\\.[a-z0-9-]+\\.svc\\.cluster\\.local:[0-9]+$", var.receiver_tunnel.service_url))
    error_message = "The tunnel may route only to an in-cluster Service (http://<service>.<namespace>.svc.cluster.local:<port>)."
  }
}

variable "planning_service_url" {
  description = "The state API's public in-cluster Service the tunnel forwards the planning chat's paths to (D-271, D-282), on the receiver's host name. Null adds no route: set only after Didi's tunnel gate."

  type    = string
  default = null

  validation {
    condition     = var.planning_service_url == null || can(regex("^http://[a-z0-9-]+\\.[a-z0-9-]+\\.svc\\.cluster\\.local:[0-9]+$", var.planning_service_url))
    error_message = "The planning route may forward only to an in-cluster Service (http://<service>.<namespace>.svc.cluster.local:<port>)."
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "receiver" {
  count      = var.receiver_tunnel == null ? 0 : 1
  account_id = var.settings["account_id"]
  name       = "${var.name}-receiver"
  # Remotely managed: the routing below lives in Cloudflare, so the connector needs only its token.
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "receiver" {
  count      = var.receiver_tunnel == null ? 0 : 1
  account_id = var.settings["account_id"]
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.receiver[0].id

  config = {
    ingress = concat(
      [
        {
          hostname = var.receiver_tunnel.hostname
          path     = var.receiver_tunnel.path
          service  = var.receiver_tunnel.service_url
        },
      ],
      # The planning chat's paths (D-271, D-282, D-343): exactly /api/plans and its three reads
      # under /api/planning/projects/<slug>/, on the receiver's host name. The slug pattern is the
      # state API's own (src/api/routes.ts); the public port also checks the method
      # (src/api/public.ts).
      var.planning_service_url == null ? [] : [
        {
          hostname = var.receiver_tunnel.hostname
          path     = "^/api/(plans|planning/projects/[a-z0-9][a-z0-9-]{0,99}/(submissions|feedback|accepted))$"
          service  = var.planning_service_url
        },
      ],
      # Anything else gets 404 at Cloudflare and never reaches the cluster.
      [
        {
          hostname = null
          path     = null
          service  = "http_status:404"
        },
      ],
    )
  }
}

resource "cloudflare_dns_record" "receiver" {
  count   = var.receiver_tunnel == null ? 0 : (var.receiver_tunnel.publish_dns ? 1 : 0)
  zone_id = var.settings["zone_id"]
  name    = var.receiver_tunnel.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.receiver[0].id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # automatic
  comment = "GitHub receiver through its Cloudflare Tunnel (D-195)"
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "receiver" {
  count      = var.receiver_tunnel == null ? 0 : 1
  account_id = var.settings["account_id"]
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.receiver[0].id
}

output "receiver_tunnel_id" {
  description = "The receiver tunnel's id, or null."
  value       = var.receiver_tunnel == null ? null : cloudflare_zero_trust_tunnel_cloudflared.receiver[0].id
}

output "receiver_tunnel_token" {
  description = "The connector's token. A credential: pipe it into the cluster Secret, never into a file in the repo."
  value       = var.receiver_tunnel == null ? null : data.cloudflare_zero_trust_tunnel_cloudflared_token.receiver[0].token
  sensitive   = true
}
