# Pi-hole + Tailscale DNS (NUC)

This bundle tracks the NUC Pi-hole changes needed for Kubernetes split DNS over Tailscale.

Desired state:

- Pi-hole on `nuc` remains the DNS server for the LAN.
- Tailscale clients use the NUC Tailscale IP (`100.88.12.116` as observed on 2026-03-11) for `cluster.local` split DNS.
- Pi-hole forwards `cluster.local` to the in-cluster CoreDNS service at `10.96.0.10`.
- `nuc` accepts Tailscale subnet routes so it can reach the cluster pod/service CIDRs.
- UFW allows DNS (`53/tcp` and `53/udp`) on `tailscale0`.
- Pi-hole non-secret settings are sourced from this repo, not edited ad hoc on the host.

Files:

- `pihole.toml` is the non-secret Pi-hole source of truth:
  - upstream resolvers
  - local DNS hosts and CNAMEs
  - DHCP scope and static leases
  - web UI ports/theme
  - Tailscale-safe DNS listener mode (`listeningMode = 'ALL'` with firewall restriction)
- `99-kubernetes-split-dns.conf` installs the Pi-hole dnsmasq forwarding rule for `cluster.local`.
- Pi-hole v6 requires `misc.etc_dnsmasq_d = true` in `pihole.toml` or it will ignore files in `/etc/dnsmasq.d/`.
- `apply.sh` installs both `pihole.toml` and `99-kubernetes-split-dns.conf`, enables `tailscale --accept-routes`, opens DNS on `tailscale0`, and restarts Pi-hole.

Not stored in Git:

- `/etc/pihole/cli_pw`
- `/etc/pihole/tls.pem`, `/etc/pihole/tls.crt`, `/etc/pihole/tls_ca.crt`
- gravity database contents (`gravity.db`, `pihole-FTL.db`)

Those are runtime secrets/state, not desired configuration.

## Deploy to NUC

```bash
ssh kalmyk@192.168.1.130 'mkdir -p ~/pihole'
scp devices/nuc/pihole/pihole.toml kalmyk@192.168.1.130:~/pihole/pihole.toml
scp devices/nuc/pihole/99-kubernetes-split-dns.conf kalmyk@192.168.1.130:~/pihole/99-kubernetes-split-dns.conf
scp devices/nuc/pihole/apply.sh kalmyk@192.168.1.130:~/pihole/apply.sh
ssh kalmyk@192.168.1.130 'chmod +x ~/pihole/apply.sh && sudo ~/pihole/apply.sh'
```

## Verify on NUC

```bash
tailscale status --json | jq '.Self.TailscaleIPs[0], .Self.HostName'
tailscale debug prefs | jq '{CorpDNS, RouteAll}'
grep -E '^(\\[dns\\]|interface|listeningMode|upstreams|\\[dhcp\\]|active|start|end|router)' /etc/pihole/pihole.toml
dig +short @127.0.0.1 google.com
dig +short @127.0.0.1 kubernetes.default.svc.cluster.local
dig +short @100.88.12.116 kubernetes.default.svc.cluster.local
```

## Verify from another tailnet client

After the Tailscale split DNS rule is applied from [tofu/tailscale/main.tf](/Users/gregkonush/.codex/worktrees/630f/lab/tofu/tailscale/main.tf#L30):

```bash
dig +short kubernetes.default.svc.cluster.local
dig +short @100.88.12.116 kubernetes.default.svc.cluster.local
```

If these fail:

- confirm `tailscale status` on `nuc` still shows the same Tailscale IP,
- confirm `tailscale debug prefs | jq '.RouteAll'` is `true`,
- confirm `ufw status` includes `53/tcp` and `53/udp` on `tailscale0`,
- confirm `kubectl get svc -n kube-system kube-dns -o wide` still reports `10.96.0.10`.
