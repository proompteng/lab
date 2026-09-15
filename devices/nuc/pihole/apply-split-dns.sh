#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: apply-split-dns.sh [--check|--apply]' >&2; exit 2; }
if [[ "$EUID" -ne 0 ]]; then
  exec sudo "$0" "$mode"
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_file="$script_dir/99-kubernetes-split-dns.conf"
destination=/etc/dnsmasq.d/99-kubernetes-split-dns.conf
for tool in pihole-FTL dig ip jq ufw systemctl iptables; do
  command -v "$tool" >/dev/null || { echo "missing required command: $tool" >&2; exit 1; }
done
test -s "$source_file"
test "$(pihole-FTL --config misc.etc_dnsmasq_d)" = true
ip -j address show dev eno1 | jq -e \
  'any(.[].addr_info[]; .local == "100.100.244.148" and .prefixlen == 25)' >/dev/null
pihole-FTL -- --test --conf-file="$source_file"
iptables -w -C INPUT -j galactic-dns-in 2>/dev/null || {
  echo 'install apply-dns-firewall.sh before enabling provider DNS; Tailscale otherwise drops provider CGNAT traffic' >&2
  exit 1
}

answers() {
  dig +time=2 +tries=1 +short "@$1" "$2" A | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print}' | sort -u
}
private_answer="$(answers 100.100.100.100 registry.ide-newton.ts.net)"
test -n "$private_answer" || { echo 'local Tailscale DNS cannot resolve the registry' >&2; exit 1; }
test -n "$(answers 127.0.0.1 github.com)" || { echo 'existing public DNS is unavailable' >&2; exit 1; }
if [[ "$mode" == --check ]]; then
  echo 'Split DNS syntax, listener prerequisite, provider address, and upstream checks passed.'
  exit 0
fi

backup_dir="$(mktemp -d /var/backups/galactic-dns.XXXXXXXX)"
if [[ -f "$destination" ]]; then
  cp -- "$destination" "$backup_dir/99-kubernetes-split-dns.conf"
else
  touch "$backup_dir/previously-absent"
fi
rollback() {
  local result=$?
  trap - ERR
  if [[ -f "$backup_dir/previously-absent" ]]; then
    rm -f -- "$destination"
  else
    install -m 0644 "$backup_dir/99-kubernetes-split-dns.conf" "$destination"
  fi
  systemctl restart pihole-FTL
  echo "DNS update failed; restored the forwarding state recorded in $backup_dir. Provider DNS firewall rules remain available for retry." >&2
  exit "$result"
}
trap rollback ERR
install -D -m 0644 "$source_file" "$destination"
ufw allow in on eno1 from 100.100.244.128/25 to 100.100.244.148 port 53 proto tcp
ufw allow in on eno1 from 100.100.244.128/25 to 100.100.244.148 port 53 proto udp
systemctl restart pihole-FTL
for _attempt in {1..15}; do
  if [[ "$(answers 127.0.0.1 registry.ide-newton.ts.net)" == "$private_answer" ]] \
    && [[ -n "$(answers 127.0.0.1 github.com)" ]] \
    && [[ "$(answers 127.0.0.1 kubernetes.default.svc.cluster.local)" == 10.96.0.1 ]]; then
    trap - ERR
    echo "Public, tailnet, and Kubernetes DNS passed. Previous forwarding state: $backup_dir"
    exit 0
  fi
  sleep 1
done
echo 'DNS acceptance failed after restarting Pi-hole' >&2
false
