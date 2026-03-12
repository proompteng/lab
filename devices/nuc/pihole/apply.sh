#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  exec sudo --preserve-env=LAN_CIDR,TAILSCALE_INTERFACE "$0" "$@"
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
toml_src="${script_dir}/pihole.toml"
toml_dest="/etc/pihole/pihole.toml"
config_src="${script_dir}/99-kubernetes-split-dns.conf"
config_dest="/etc/dnsmasq.d/99-kubernetes-split-dns.conf"
tailscale_interface="${TAILSCALE_INTERFACE:-tailscale0}"
lan_cidr="${LAN_CIDR:-192.168.1.0/24}"

if [[ ! -f "${toml_src}" ]]; then
  echo "missing config source: ${toml_src}" >&2
  exit 1
fi

if [[ ! -f "${config_src}" ]]; then
  echo "missing config source: ${config_src}" >&2
  exit 1
fi

install -D -o pihole -g pihole -m 0644 "${toml_src}" "${toml_dest}"
install -D -m 0644 "${config_src}" "${config_dest}"

# Pi-hole can only forward cluster.local if this host accepts the kube-node subnet routes.
tailscale set --accept-routes=true

if command -v ufw >/dev/null 2>&1; then
  ufw allow in on "${tailscale_interface}" to any port 53 proto tcp
  ufw allow in on "${tailscale_interface}" to any port 53 proto udp
  ufw allow from "${lan_cidr}" to any port 53 proto tcp
  ufw allow from "${lan_cidr}" to any port 53 proto udp
fi

systemctl restart pihole-FTL

echo "Pi-hole Tailscale DNS configuration applied."
echo "Verification:"
echo "  tailscale status --json | jq '.Self.TailscaleIPs[0], .Self.HostName'"
echo "  grep -E '^(\\[dns\\]|interface|listeningMode|upstreams|\\[dhcp\\]|active|start|end|router)' /etc/pihole/pihole.toml"
echo "  dig +short @127.0.0.1 google.com"
echo "  dig +short @127.0.0.1 kubernetes.default.svc.cluster.local"
echo "  dig +short @$(tailscale ip -4 | head -n1) kubernetes.default.svc.cluster.local"
