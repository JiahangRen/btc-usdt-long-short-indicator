#!/usr/bin/env bash
# One-time Ubuntu 24.04 server preparation. Run as root, or through sudo.
# It intentionally does not start this application or change any web-server
# ports: inspect the current host proxy first, then run the deployment.
set -Eeuo pipefail

DEPLOY_ACCOUNT="${1:-${SUDO_USER:-}}"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "This script supports Ubuntu only; detected: ${ID:-unknown}." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl rsync
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

if [ -n "$DEPLOY_ACCOUNT" ]; then
  usermod -aG docker "$DEPLOY_ACCOUNT"
  echo "Added $DEPLOY_ACCOUNT to the docker group; reconnect SSH before deploying."
fi

docker version --format '{{.Server.Version}}'
docker compose version
