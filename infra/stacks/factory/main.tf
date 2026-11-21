# The factory stack wires the platform modules with variables only. It names no provider (D-146):
# each provider is declared in its platform module.
#
# It calls the platform modules directly, not through modules/project. The cluster and the tunnel
# are the factory's own platform, not a project deployed onto a target, so there is no deploy
# target to switch on. Each project's staging name and Workers route are made here too, on the
# factory's own zone, from the project list below (D-357, O-112).

locals {
  # The project list is the settings repository didi-build/foreman-projects (D-377, D-442, ADR
  # 0118 appendix A), the one list the Platform workflow renders and the register-project form
  # reads. The Infra workflows check it out at one resolved commit into this fixed, git-ignored
  # folder at the repository's root, so the names Didi approves are that commit's projects
  # (D-357). Locally, clone it there to plan or validate.
  projects_checkout = "${path.module}/../../../foreman-projects"

  # The marker, {"schema": 1}. file() fails the plan when the checkout is missing, so a missing
  # folder never plans an empty list, which would delete every project's name (O-112). A marker
  # with another schema has no entry in this map and fails the plan too.
  projects_folder = {
    "1" = "${local.projects_checkout}/projects"
  }[tostring(jsondecode(file("${local.projects_checkout}/foreman-projects.json")).schema)]

  # One file per project. The Platform workflow's render holds each to every entry rule
  # (src/core/project-entry.ts); here a file that is not JSON, or has no slug or target, fails the
  # plan.
  projects = [
    for name in fileset(local.projects_folder, "*.json") :
    jsondecode(file("${local.projects_folder}/${name}"))
  ]

  # A record and a route only for a project on the Cloudflare target (D-441): a cluster-target
  # project gets neither. A target that is neither has no entry here and fails the plan, so a
  # misspelt target never plans to delete a project's name.
  deploy_target_has_name = { cloudflare = true, cluster = false }
  project_slugs = [
    for project in local.projects : project.slug
    if local.deploy_target_has_name[project.deployTarget]
  ]

  # Each project's staging name is `<slug>.didi.build` (D-345, projectStagingUrl in
  # src/core/register-project.ts).
  project_domain = "didi.build"
}

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

  # D-357: a proxied record and a Workers route for each project. A project whose host name is the
  # receiver's gets neither (O-112).
  project_staging = {
    domain = local.project_domain
    slugs  = local.project_slugs
  }
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
