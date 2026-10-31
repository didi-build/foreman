# Plain settings only (ADR 0106 section 1): the cluster's id, API address and CA certificate.
# Never a kubeconfig, a client key or a token (D-188).

output "cluster_id" {
  description = "The DOKS cluster id."
  value       = digitalocean_kubernetes_cluster.this.id
}

output "endpoint" {
  description = "The Kubernetes API address. A plain setting for the runner."
  value       = digitalocean_kubernetes_cluster.this.endpoint
}

output "cluster_ca_certificate" {
  description = "The cluster CA certificate. Public by nature; the provider only marks it sensitive because it sits inside the admin credential."
  value       = nonsensitive(digitalocean_kubernetes_cluster.this.kube_config[0].cluster_ca_certificate)
}
