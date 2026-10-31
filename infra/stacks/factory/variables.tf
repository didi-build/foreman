# Ephemeral: never saved in plan files or state, so `tofu show -json` cannot print it (ADR 0110).
variable "state_encryption_passphrase" {
  description = "Passphrase for state and plan encryption. From the vault; at least 16 characters."
  type        = string
  sensitive   = true
  ephemeral   = true

  validation {
    condition     = length(var.state_encryption_passphrase) >= 16
    error_message = "The state encryption passphrase must be at least 16 characters."
  }
}

variable "cluster_name" {
  description = "The DOKS cluster's name."
  type        = string
  default     = "foreman"
}

variable "kubernetes_version_prefix" {
  description = "Kubernetes minor version, for example \"1.34.\". Read the supported versions on DigitalOcean at first hosting."
  type        = string
}

variable "node_size" {
  description = "Droplet size of each node (D-194: 2 vCPU / 4 GB). Confirm the slug and its price on DigitalOcean's page at first hosting."
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "maintenance_day" {
  description = "Day of the cluster's maintenance window."
  type        = string
  default     = "sunday"
}

variable "maintenance_start_time" {
  description = "Start of the maintenance window, UTC, as HH:MM."
  type        = string
  default     = "04:00"
}

variable "auto_upgrade" {
  description = "Let DigitalOcean apply patch upgrades in the maintenance window."
  type        = bool
  default     = true
}

variable "api_allowed_addresses" {
  description = "Source addresses (CIDR) allowed to reach the Kubernetes API (D-189). Empty: no limit, RBAC is the protection."
  type        = list(string)
  default     = []
}

variable "extra_outbound_tcp_ports" {
  description = "Outbound TCP ports the worker firewall allows besides HTTPS and DNS. Each one needs Didi's approval."
  type        = list(number)
  default     = []
}

variable "cloudflare_settings" {
  description = "account_id and zone_id of the didi.build zone on Cloudflare. Ids, not secrets; passed at run time, never committed."
  type        = map(string)
}

variable "receiver_hostname" {
  description = "The receiver's public webhook host name on didi.build. Creating its DNS record is a DNS gate (D-195)."
  type        = string
}

variable "publish_receiver_dns" {
  description = "Create the receiver's DNS record. False until Didi approves the DNS change (D-195); then one apply adds one record."
  type        = bool
  default     = false
}

variable "receiver_service_url" {
  description = "The receiver's in-cluster Service. Must match infra/kubernetes/platform.ts (test/infra-cluster.test.ts checks it)."
  type        = string
  default     = "http://github-receiver.foreman-platform.svc.cluster.local:8080"
}

variable "receiver_webhook_path" {
  description = "The one path the tunnel forwards: the receiver's webhook route (src/github-receiver/handler.ts)."
  type        = string
  default     = "^/github/webhook$"
}
