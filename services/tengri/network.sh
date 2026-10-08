#!/bin/sh
set -eu

[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 1 ] || {
  echo 'Pod forwarding is disabled; refusing a node configuration workaround' >&2
  exit 1
}
[ "$(ip -4 route show default | awk '{print $5}')" = eth0 ]
if ip -4 route show | awk '{print $1}' | grep -q '^10\.250\.'; then
  echo 'Guest subnet overlaps an existing Pod route' >&2
  exit 1
fi

ip tuntap add dev tengri0 mode tap user 65532
ip address add 10.250.0.1/30 dev tengri0
ip link set dev tengri0 up

dns_rules=''
while read -r kind resolver _; do
  [ "$kind" = nameserver ] || continue
  case "$resolver" in *[!0-9.]*|'') echo 'Slot requires a reviewed IPv4 resolver' >&2; exit 1 ;; esac
  dns_rules="$dns_rules
    ip daddr $resolver udp dport 53 accept
    ip daddr $resolver tcp dport 53 accept"
done < /etc/resolv.conf
[ -n "$dns_rules" ]
nft -f - <<EOF
table inet tengri {
  set protected {
    type ipv4_addr
    flags interval
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
      169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
      192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24,
      203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 }
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "tengri0" drop
  }
  chain guest {
    meta nfproto != ipv4 drop
    ip saddr != 10.250.0.2 drop
    $dns_rules
    ip daddr @protected drop
    accept
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "tengri0" jump guest
    oifname "tengri0" ct state established,related accept
    oifname "tengri0" drop
  }
  chain nat {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr 10.250.0.2 oifname "eth0" masquerade
  }
}
EOF
