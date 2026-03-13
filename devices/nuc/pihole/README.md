# Pi-hole + Tailscale DNS (NUC)

This bundle tracks the NUC Pi-hole changes needed for Kubernetes split DNS over Tailscale.

Desired state:

- Pi-hole on `nuc` remains the DNS server for the LAN.
- Tailscale clients use the NUC Tailscale IP (`100.88.12.116` as observed on 2026-03-11) for `cluster.local` split DNS.
- Tailscale clients also use the same NUC Tailscale IP for `k8s.proompteng.ai` split DNS.
- Pi-hole forwards `cluster.local` to the in-cluster CoreDNS service at `10.96.0.10`.
- Pi-hole serves curated `*.k8s.proompteng.ai` CNAMEs that target `traefik.traefik.svc.cluster.local` for private HTTPS ingress.
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
dig +short @127.0.0.1 grafana.k8s.proompteng.ai
dig +short @127.0.0.1 argocd.k8s.proompteng.ai
dig +short @127.0.0.1 ceph.k8s.proompteng.ai
dig +short @127.0.0.1 jangar.k8s.proompteng.ai
dig +short @127.0.0.1 workflows.k8s.proompteng.ai
dig +short @127.0.0.1 feature-flags.k8s.proompteng.ai
dig +short @127.0.0.1 flink.k8s.proompteng.ai
dig +short @127.0.0.1 headlamp.k8s.proompteng.ai
dig +short @127.0.0.1 kafka-ui.k8s.proompteng.ai
dig +short @127.0.0.1 sealed-secrets.k8s.proompteng.ai
dig +short @127.0.0.1 temporal.k8s.proompteng.ai
dig +short @127.0.0.1 pgadmin.k8s.proompteng.ai
dig +short @127.0.0.1 inngest.k8s.proompteng.ai
dig +short @127.0.0.1 forgejo.k8s.proompteng.ai
dig +short @127.0.0.1 coder.k8s.proompteng.ai
dig +short @127.0.0.1 registry.k8s.proompteng.ai
dig +short @127.0.0.1 openwebui.k8s.proompteng.ai
```

## Verify from another tailnet client

After the Tailscale split DNS rule is applied from [tofu/tailscale/main.tf](/Users/gregkonush/.codex/worktrees/630f/lab/tofu/tailscale/main.tf#L30):

```bash
dig +short kubernetes.default.svc.cluster.local
dig +short @100.88.12.116 kubernetes.default.svc.cluster.local
dig +short grafana.k8s.proompteng.ai
dig +short argocd.k8s.proompteng.ai
dig +short ceph.k8s.proompteng.ai
dig +short jangar.k8s.proompteng.ai
dig +short workflows.k8s.proompteng.ai
dig +short feature-flags.k8s.proompteng.ai
dig +short flink.k8s.proompteng.ai
dig +short headlamp.k8s.proompteng.ai
dig +short kafka-ui.k8s.proompteng.ai
dig +short sealed-secrets.k8s.proompteng.ai
dig +short temporal.k8s.proompteng.ai
dig +short pgadmin.k8s.proompteng.ai
dig +short inngest.k8s.proompteng.ai
dig +short forgejo.k8s.proompteng.ai
dig +short coder.k8s.proompteng.ai
dig +short registry.k8s.proompteng.ai
dig +short openwebui.k8s.proompteng.ai
```

If these fail:

- confirm `tailscale status` on `nuc` still shows the same Tailscale IP,
- confirm `tailscale debug prefs | jq '.RouteAll'` is `true`,
- confirm `ufw status` includes `53/tcp` and `53/udp` on `tailscale0`,
- confirm `kubectl get svc -n kube-system kube-dns -o wide` still reports `10.96.0.10`.
