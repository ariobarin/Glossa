#!/usr/bin/env bash
# Provisions the always-on OpenAI reviewer worker on Ubuntu 24.04.
# Copy this directory to the server and run it as root:
#   sudo bash setup.sh
# Then pair once with: sudo /opt/glossa-review/pair.sh
set -euo pipefail

GLOSSA_VERSION="${GLOSSA_VERSION:-0.2.6}"
FIXTURE_REF="${FIXTURE_REF:-cli-v${GLOSSA_VERSION}}"
NODE_LINE="${NODE_LINE:-latest-v24.x}"
SERVICE_USER=glossa-review
SERVICE_HOME=/var/lib/glossa-review
CHECKOUT="$SERVICE_HOME/glossa"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl git xz-utils e2fsprogs

# A small machine needs swap for npm.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1500000 ] && ! grep -q '^/swapfile ' /etc/fstab; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Official Node.js build, verified against the release checksums.
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
node_file="$(grep -oE "node-v[0-9.]+-linux-${node_arch}\.tar\.xz" "$work/SHASUMS256.txt" | head -n 1)"
if [ -z "$node_file" ]; then
  echo "No Node.js build for linux-${node_arch} in $NODE_LINE." >&2
  exit 1
fi
curl -fsSL "https://nodejs.org/dist/$NODE_LINE/$node_file" -o "$work/$node_file"
(cd "$work" && grep " $node_file\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$work/$node_file" -C /usr/local --strip-components=1 --no-same-owner
node --version

npm install -g --no-fund --no-audit "@ariobarin/glossa@$GLOSSA_VERSION"
glossa --version

# Unprivileged account with no sudo, cloud credentials, SSH keys, or other
# workspaces. Reviewer commands run with exactly this authority.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$SERVICE_HOME" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
chmod 700 "$SERVICE_HOME"

as_service() {
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" "$@"
}

if [ ! -d "$CHECKOUT/.git" ]; then
  as_service git clone --quiet --depth 1 --branch "$FIXTURE_REF" https://github.com/ariobarin/glossa.git "$CHECKOUT"
fi
as_service node "$CHECKOUT/scripts/prepare-app-review-workspace.mjs" --reset
as_service glossa update --policy off

install -d -m 755 /opt/glossa-review
install -m 755 "$HERE/reset.sh" "$HERE/pair.sh" /opt/glossa-review/
install -m 644 "$HERE/glossa-review.service" "$HERE/glossa-review-reset.service" "$HERE/glossa-review-reset.timer" /etc/systemd/system/
# Reviewer commands can only reach public addresses, plus the DNS resolvers.
resolvers="$(awk '/^nameserver/ {print $2}' /etc/resolv.conf | tr '\n' ' ')"
if [ -z "${resolvers// /}" ]; then
  echo "No nameserver in /etc/resolv.conf; reviewer commands would have no DNS." >&2
  exit 1
fi
install -d -m 755 /etc/systemd/system/glossa-review.service.d
printf '[Service]\nIPAddressAllow=%s\n' "$resolvers" > /etc/systemd/system/glossa-review.service.d/dns.conf
systemctl daemon-reload
systemctl enable glossa-review.service glossa-review-reset.timer
systemctl start glossa-review-reset.timer

echo "Provisioned. Pair the worker with: sudo /opt/glossa-review/pair.sh"
