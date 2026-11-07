#!/usr/bin/env bash
# Install kubectl and doctl at exact versions for the admin jobs (D-339, D-340, O-105). Each
# download is checked against the sha256 written here, read on 2026-11-06 from the release's own
# checksum (kubectl from dl.k8s.io, doctl from its GitHub release) and checked against the
# downloaded file. kubectl's minor version matches the cluster's (1.37, the factory stack's
# kubernetes_version_prefix). A new version changes the version and the hash together, in a pull
# request Didi reviews (`.github/` is a privileged path).
set -euo pipefail

KUBECTL_VERSION="v1.37.2"
KUBECTL_SHA256="c04487523e7aa7d1493f7808174c899db93d7a9cf57531420cd76b9bd415f8f4"
DOCTL_VERSION="1.186.0"
DOCTL_SHA256="a36f2ae5e672160c3a20ab46e8cef79c9b24e8055417f4beb790a897c532d241"

bin="${RUNNER_TEMP:?}/cluster-tools"
mkdir -p "$bin"

fetch() {
  curl --fail --silent --show-error --location --retry 3 --output "$1" "$2"
}

fetch "$bin/kubectl" "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
echo "${KUBECTL_SHA256}  $bin/kubectl" | sha256sum --check --strict --quiet
chmod 0755 "$bin/kubectl"

fetch "$bin/doctl.tar.gz" \
  "https://github.com/digitalocean/doctl/releases/download/v${DOCTL_VERSION}/doctl-${DOCTL_VERSION}-linux-amd64.tar.gz"
echo "${DOCTL_SHA256}  $bin/doctl.tar.gz" | sha256sum --check --strict --quiet
tar -xzf "$bin/doctl.tar.gz" -C "$bin" doctl
rm "$bin/doctl.tar.gz"

echo "$bin" >>"${GITHUB_PATH:?}"
echo "kubectl ${KUBECTL_VERSION} and doctl ${DOCTL_VERSION} installed, checksums verified."
