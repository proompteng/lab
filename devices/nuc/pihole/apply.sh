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
coredns_ip="${COREDNS_IP:-10.96.0.10}"
kubernetes_probe="${KUBERNETES_PROBE_NAME:-kubernetes.default.svc.cluster.local}"

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

# Pi-hole can only forward cluster.local if this host accepts the advertised cluster routes.
tailscale set --accept-routes=true

if ! tailscale debug prefs | grep -Eq '"RouteAll":[[:space:]]*true'; then
  echo "tailscale routes are not enabled after tailscale set --accept-routes=true" >&2
  exit 1
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow in on "${tailscale_interface}" to any port 53 proto tcp
  ufw allow in on "${tailscale_interface}" to any port 53 proto udp
  ufw allow from "${lan_cidr}" to any port 53 proto tcp
  ufw allow from "${lan_cidr}" to any port 53 proto udp
fi

systemctl restart pihole-FTL

if ! timeout 5 bash -lc "until ip route get ${coredns_ip} >/dev/null 2>&1; do sleep 1; done"; then
  echo "no route to CoreDNS service IP ${coredns_ip} after enabling tailscale routes" >&2
  exit 1
fi

if ! dig +time=2 +tries=1 @"${coredns_ip}" "${kubernetes_probe}" >/dev/null; then
  echo "CoreDNS at ${coredns_ip} is not reachable from this host" >&2
  exit 1
fi

if ! dig +time=2 +tries=1 @127.0.0.1 "${kubernetes_probe}" >/dev/null; then
  echo "Pi-hole did not resolve ${kubernetes_probe} via CoreDNS forwarding" >&2
  exit 1
fi

echo "Pi-hole Tailscale DNS configuration applied."
echo "Verification:"
echo "  tailscale status --json | jq '.Self.TailscaleIPs[0], .Self.HostName'"
echo "  grep -E '^(\\[dns\\]|interface|listeningMode|upstreams|\\[dhcp\\]|active|start|end|router)' /etc/pihole/pihole.toml"
echo "  dig +short @127.0.0.1 google.com"
echo "  dig +short @127.0.0.1 kubernetes.default.svc.cluster.local"
echo "  dig +short @$(tailscale ip -4 | head -n1) kubernetes.default.svc.cluster.local"
