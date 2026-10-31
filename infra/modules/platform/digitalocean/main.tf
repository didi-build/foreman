# One DOKS cluster with two node pools (ADR 0106 section 1, D-193, D-194). Never applied by the
# runner or an agent: Didi applies it at first hosting (D-188).
#
# Pool labels and the agents taint must match what the Kubernetes agent runtime adapter sets on
# every run pod (AGENTS_POOL in src/adapters/agent-runtime/kubernetes/manifests.ts) and what the
# platform manifests select (PLATFORM_POOL in infra/kubernetes/platform.ts). test/infra-cluster.test.ts
# checks both.

data "digitalocean_kubernetes_versions" "this" {
  version_prefix = var.kubernetes_version_prefix
}

resource "digitalocean_kubernetes_cluster" "this" {
  name    = var.name
  region  = var.region
  version = data.digitalocean_kubernetes_versions.this.latest_version

  # Standard control plane, not high availability (D-194).
  ha                   = false
  auto_upgrade         = var.auto_upgrade
  surge_upgrade        = true
  registry_integration = false

  # The provider fetches an admin credential and keeps it in state (encrypted, ADR 0110). Keep its
  # life short. It is never an output: the admin kubeconfig is Didi's only (D-188).
  kubeconfig_expire_seconds = var.kubeconfig_expire_seconds

  maintenance_policy {
    day        = var.maintenance_day
    start_time = var.maintenance_start_time
  }

  # D-189: limit the API endpoint to listed addresses when there are any.
  control_plane_firewall {
    enabled           = length(var.api_allowed_addresses) > 0
    allowed_addresses = var.api_allowed_addresses
  }

  # The platform pool: the state API, the GitHub receiver and the tunnel connector (D-193, D-195).
  node_pool {
    name       = "platform"
    size       = var.node_size
    node_count = var.platform_node_count
    auto_scale = false

    labels = {
      "foreman/pool" = "platform"
    }
  }

  lifecycle {
    # A version change that DigitalOcean cannot apply in place replaces the cluster. Refuse that.
    prevent_destroy = true
  }
}

# The agents pool: agent pods only. Tainted so nothing without the toleration schedules there.
resource "digitalocean_kubernetes_node_pool" "agents" {
  cluster_id = digitalocean_kubernetes_cluster.this.id
  name       = "agents"
  size       = var.node_size
  node_count = var.agents_node_count
  auto_scale = false

  labels = {
    "foreman/pool" = "agents"
  }

  taint {
    key    = "foreman/pool"
    value  = "agents"
    effect = "NoSchedule"
  }
}

# The cloud firewall on every worker node (ADR 0106 section 1, D-195). No inbound rule: nothing on
# the cluster takes traffic from the internet, because the receiver is reached through an outbound
# Cloudflare Tunnel. Outbound: HTTPS and DNS, plus any TCP port Didi approves.
resource "digitalocean_firewall" "workers" {
  name = "${var.name}-workers"
  tags = ["k8s:${digitalocean_kubernetes_cluster.this.id}"]

  outbound_rule {
    protocol              = "tcp"
    port_range            = "443"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "53"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  dynamic "outbound_rule" {
    for_each = toset(var.extra_outbound_tcp_ports)
    content {
      protocol              = "tcp"
      port_range            = tostring(outbound_rule.value)
      destination_addresses = ["0.0.0.0/0", "::/0"]
    }
  }
}
