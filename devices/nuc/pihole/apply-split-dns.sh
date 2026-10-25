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
resolver_source="$script_dir/10-galactic-resolver-owner.conf"
resolver_destination=/etc/systemd/system/tailscaled.service.d/10-galactic-resolver-owner.conf
for tool in pihole-FTL dig ip jq ufw systemctl iptables; do
  command -v "$tool" >/dev/null || { echo "missing required command: $tool" >&2; exit 1; }
done
test -s "$source_file"
test -s "$resolver_source"
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
negative_answers() {
  local type
  for type in A AAAA; do
    dig +time=2 +tries=1 +noall +comments "@$1" github.com.ide-newton.ts.net "$type" \
      | grep -q 'status: NXDOMAIN,' || return 1
  done
}
private_answer="$(answers 100.100.100.100 registry.ide-newton.ts.net)"
test -n "$private_answer" || { echo 'local Tailscale DNS cannot resolve the registry' >&2; exit 1; }
test -n "$(answers 127.0.0.1 github.com)" || { echo 'existing public DNS is unavailable' >&2; exit 1; }
negative_answers 100.100.100.100 || { echo 'Tailscale DNS must return NXDOMAIN for an absent tailnet name; follow the resolver recovery in README.md' >&2; exit 1; }
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
if [[ -f "$resolver_destination" ]]; then
  cp -- "$resolver_destination" "$backup_dir/10-galactic-resolver-owner.conf"
else
  touch "$backup_dir/resolver-previously-absent"
fi
rollback() {
  local result=$?
  trap - ERR
  if [[ -f "$backup_dir/previously-absent" ]]; then
    rm -f -- "$destination"
  else
    install -m 0644 "$backup_dir/99-kubernetes-split-dns.conf" "$destination"
  fi
  if [[ -f "$backup_dir/resolver-previously-absent" ]]; then
    rm -f -- "$resolver_destination"
  else
    install -m 0644 "$backup_dir/10-galactic-resolver-owner.conf" "$resolver_destination"
  fi
  systemctl daemon-reload
  systemctl restart pihole-FTL
  echo "DNS update failed; restored the forwarding state recorded in $backup_dir. Provider DNS firewall rules remain available for retry." >&2
  exit "$result"
}
trap rollback ERR
install -D -m 0644 "$source_file" "$destination"
install -D -m 0644 "$resolver_source" "$resolver_destination"
systemctl daemon-reload
ufw allow in on eno1 from 100.100.244.128/25 to 100.100.244.148 port 53 proto tcp
ufw allow in on eno1 from 100.100.244.128/25 to 100.100.244.148 port 53 proto udp
systemctl restart pihole-FTL
for _attempt in {1..15}; do
  if [[ "$(answers 127.0.0.1 registry.ide-newton.ts.net)" == "$private_answer" ]] \
    && [[ -n "$(answers 127.0.0.1 github.com)" ]] \
    && negative_answers 127.0.0.1 \
    && [[ "$(answers 127.0.0.1 kubernetes.default.svc.cluster.local)" == 10.96.0.1 ]]; then
    trap - ERR
    echo "Public, tailnet, negative-tailnet, and Kubernetes DNS passed. Previous forwarding state: $backup_dir"
    exit 0
  fi
  sleep 1
done
echo 'DNS acceptance failed after restarting Pi-hole' >&2
false
