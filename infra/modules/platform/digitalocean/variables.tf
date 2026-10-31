variable "name" {
  description = "Cluster name, also used to name the firewall."
  type        = string
}

variable "region" {
  description = "DigitalOcean region. Toronto (D-141, ADR 0106 section 1)."
  type        = string
  default     = "tor1"
}

variable "kubernetes_version_prefix" {
  description = "Kubernetes minor version to run, for example \"1.34.\". The newest patch with this prefix is used."
  type        = string
}

variable "node_size" {
  description = "Droplet size of each node. 2 vCPU / 4 GB (D-194). The price is read on DigitalOcean's page at first hosting."
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "platform_node_count" {
  description = "Nodes in the platform pool (D-194: one)."
  type        = number
  default     = 1
}

variable "agents_node_count" {
  description = "Nodes in the agents pool (D-194: one)."
  type        = number
  default     = 1
}

variable "auto_upgrade" {
  description = "Let DigitalOcean apply patch upgrades in the maintenance window."
  type        = bool
  default     = true
}

variable "maintenance_day" {
  description = "Day of the maintenance window: any, or monday to sunday."
  type        = string
  default     = "sunday"
}

variable "maintenance_start_time" {
  description = "Start of the maintenance window, UTC, as HH:MM."
  type        = string
  default     = "04:00"
}

variable "api_allowed_addresses" {
  description = "Source addresses (CIDR) allowed to reach the Kubernetes API (D-189): the runner's and Didi's. Empty means no limit, and the runner's RBAC-limited token is the protection."
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.api_allowed_addresses, "0.0.0.0/0") && !contains(var.api_allowed_addresses, "::/0")
    error_message = "An allow-list that admits every address is not a limit. Leave it empty instead."
  }
}

variable "kubeconfig_expire_seconds" {
  description = "Lifetime of the admin credential the provider fetches and keeps in (encrypted) state. Short, because only Didi holds the admin kubeconfig (D-188)."
  type        = number
  default     = 3600
}

variable "extra_outbound_tcp_ports" {
  description = "Outbound TCP ports the worker firewall allows besides HTTPS, DNS, 5432 and 7844. Empty until Didi approves more (see docs/runbooks/first-hosting.md)."
  type        = list(number)
  default     = []
}
