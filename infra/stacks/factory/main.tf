# The factory stack wires the platform modules with variables only. It names no provider (D-146):
# each provider is declared in its platform module.
#
# It calls the platform modules directly, not through modules/project. The cluster and the tunnel
# are the factory's own platform, not a project deployed onto a target, so there is no deploy
# target to switch on.

module "cluster" {
  source = "../../modules/platform/digitalocean"

  name                      = var.cluster_name
  region                    = "tor1"
  kubernetes_version_prefix = var.kubernetes_version_prefix
  node_size                 = var.node_size
  platform_node_count       = 1
  agents_node_count         = 1
  auto_upgrade              = var.auto_upgrade
  maintenance_day           = var.maintenance_day
  maintenance_start_time    = var.maintenance_start_time
  api_allowed_addresses     = var.api_allowed_addresses
  extra_outbound_tcp_ports  = var.extra_outbound_tcp_ports
}

module "edge" {
  source = "../../modules/platform/cloudflare"

  name     = var.cluster_name
  settings = var.cloudflare_settings

  receiver_tunnel = {
    hostname    = var.receiver_hostname
    path        = var.receiver_webhook_path
    service_url = var.receiver_service_url
    publish_dns = var.publish_receiver_dns
  }

  # D-271, D-282, D-343: the planning chat's routes under /api on the same tunnel and host name,
  # only once Didi passes the tunnel gate at first hosting.
  planning_service_url = var.expose_planning_route ? var.planning_service_url : null
}

output "cluster_id" {
  value = module.cluster.cluster_id
}

# Not a secret, but the plan and the apply of a public repository never show it (D-349): with the
# allow-list empty (D-338), the API takes connections from anywhere. `tofu output -raw` still
# prints it.
output "cluster_endpoint" {
  value     = module.cluster.endpoint
  sensitive = true
}

output "cluster_ca_certificate" {
  value = module.cluster.cluster_ca_certificate
}

output "receiver_tunnel_id" {
  value = module.edge.receiver_tunnel_id
}

# A credential (D-195). Read it only to pipe it into the cluster Secret:
#   tofu output -raw receiver_tunnel_token | kubectl create secret generic ... --from-file=token=/dev/stdin
output "receiver_tunnel_token" {
  value     = module.edge.receiver_tunnel_token
  sensitive = true
}
