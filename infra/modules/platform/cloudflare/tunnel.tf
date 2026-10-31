# The GitHub receiver's Cloudflare Tunnel (D-195, ADR 0106 section 1). A connector pod on the
# cluster's platform pool dials out to Cloudflare, so the cluster opens no inbound port. The tunnel
# routes one host name and one path to the receiver's internal Service, and nothing else.
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
    ingress = [
      {
        hostname = var.receiver_tunnel.hostname
        path     = var.receiver_tunnel.path
        service  = var.receiver_tunnel.service_url
      },
      # Anything else gets 404 at Cloudflare and never reaches the cluster.
      {
        service = "http_status:404"
      },
    ]
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
