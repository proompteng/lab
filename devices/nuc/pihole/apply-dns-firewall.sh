#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:---check}"
case "$mode" in --check|--apply|--reconcile|--remove) ;; *) echo 'usage: apply-dns-firewall.sh [--check|--apply]' >&2; exit 2 ;; esac
if [[ "$EUID" -ne 0 ]]; then exec sudo "$0" "$mode"; fi
for tool in iptables ip6tables iptables-restore ip6tables-restore iptables-save ip6tables-save tailscale jq ip systemctl flock; do
  command -v "$tool" >/dev/null || { echo "missing required command: $tool" >&2; exit 1; }
done

hooks() {
  local family table base chain target
  exec 9>/run/lock/galactic-dns-firewall.lock
  flock -x 9
  for family in iptables ip6tables; do
    for entry in 'filter INPUT galactic-dns-in ts-input' 'filter FORWARD galactic-ts-fwd ts-forward' 'nat POSTROUTING galactic-ts-nat ts-postrouting'; do
      read -r table base chain target <<<"$entry"
      if [[ "$mode" == --remove ]]; then
        while "$family" -w -t "$table" -C "$base" -j "$chain" 2>/dev/null; do
          "$family" -w -t "$table" -D "$base" -j "$chain"
        done
        if "$family" -w -t "$table" -S "$chain" >/dev/null 2>&1; then
          "$family" -w -t "$table" -F "$chain"
          "$family" -w -t "$table" -X "$chain"
        fi
        continue
      fi
      "$family" -w -t "$table" -S "$target" >/dev/null
      {
        printf '*%s\n:%s - [0:0]\n-F %s\n' "$table" "$chain" "$chain"
        if [[ "$family" == iptables && "$base" == INPUT ]]; then
          printf '%s\n' '-A galactic-dns-in -i eno1 -s 100.100.244.128/25 -d 100.100.244.148/32 -p udp --dport 53 -j ACCEPT'
          printf '%s\n' '-A galactic-dns-in -i eno1 -s 100.100.244.128/25 -d 100.100.244.148/32 -p tcp --dport 53 -j ACCEPT'
        fi
        printf '%s\n' "-A $chain -j $target" COMMIT
      } | "$family-restore" --wait --noflush
      if ! "$family" -w -t "$table" -C "$base" -j "$chain" 2>/dev/null; then
        "$family" -w -t "$table" -I "$base" 1 -j "$chain"
      fi
    done
  done
}
if [[ "$mode" == --reconcile || "$mode" == --remove ]]; then hooks; exit 0; fi

ip -j address show dev eno1 | jq -e 'any(.[].addr_info[]; .local == "100.100.244.148" and .prefixlen == 25)' >/dev/null
tailscale status --json | jq -e '.BackendState == "Running" and (.Self.TailscaleIPs | index("100.78.240.108"))' >/dev/null
previous_mode="$(tailscale debug prefs | jq -er '.NetfilterMode')"
case "$previous_mode" in 2) previous_mode=on ;; 1) previous_mode=nodivert ;; *) echo 'unexpected Tailscale netfilter mode' >&2; exit 1 ;; esac
for family in iptables ip6tables; do
  "$family" -w -S ts-input >/dev/null
  "$family" -w -S ts-forward >/dev/null
  "$family" -w -t nat -S ts-postrouting >/dev/null
done
if [[ "$mode" == --check ]]; then echo 'NUC identity, provider interface, and IPv4/IPv6 Tailscale chains verified.'; exit 0; fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test -f "$script_dir/galactic-dns-firewall.service"
backup_dir="$(mktemp -d /var/backups/galactic-dns-firewall.XXXXXXXX)"
printf '%s\n' "$previous_mode" >"$backup_dir/netfilter-mode"
iptables-save >"$backup_dir/iptables.rules"
ip6tables-save >"$backup_dir/ip6tables.rules"
for file in /usr/local/sbin/galactic-dns-firewall /etc/systemd/system/galactic-dns-firewall.service; do
  if [[ -f "$file" ]]; then cp -p "$file" "$backup_dir/$(basename "$file")"; fi
done
if [[ "$previous_mode" == nodivert ]]; then
  test -f "$backup_dir/galactic-dns-firewall"
  test -f "$backup_dir/galactic-dns-firewall.service"
  systemctl is-enabled --quiet galactic-dns-firewall.service
fi
rollback() {
  local result=$?
  trap - ERR
  tailscale set --netfilter-mode="$previous_mode"
  systemctl disable --now galactic-dns-firewall.service
  for file in /usr/local/sbin/galactic-dns-firewall /etc/systemd/system/galactic-dns-firewall.service; do
    if [[ -f "$backup_dir/$(basename "$file")" ]]; then
      cp -p "$backup_dir/$(basename "$file")" "$file"
    else
      rm -f -- "$file"
    fi
  done
  systemctl daemon-reload
  if [[ "$previous_mode" == nodivert ]]; then systemctl enable --now galactic-dns-firewall.service; fi
  echo "Firewall apply failed; previous Tailscale mode restored. Receipt: $backup_dir" >&2
  exit "$result"
}
trap rollback ERR
install -m 0755 "$0" /usr/local/sbin/galactic-dns-firewall
install -m 0644 "$script_dir/galactic-dns-firewall.service" /etc/systemd/system/galactic-dns-firewall.service
systemctl daemon-reload
systemctl enable galactic-dns-firewall.service
systemctl restart galactic-dns-firewall.service
tailscale set --netfilter-mode=nodivert
test "$(tailscale debug prefs | jq -er '.NetfilterMode')" = 1
systemctl is-active --quiet galactic-dns-firewall.service
for family in iptables ip6tables; do
  "$family" -w -C INPUT -j galactic-dns-in
  "$family" -w -C FORWARD -j galactic-ts-fwd
  "$family" -w -t nat -C POSTROUTING -j galactic-ts-nat
done
trap - ERR
echo "Provider DNS exception active; all other traffic retains Tailscale filtering. Receipt: $backup_dir"
