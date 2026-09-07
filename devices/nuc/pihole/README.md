# Pi-hole + Tailscale DNS (NUC)

This bundle tracks the NUC Pi-hole changes needed for Kubernetes split DNS over Tailscale.

Desired state:

- Pi-hole on `nuc` remains the DNS server for the LAN.
- Tailscale clients use the NUC Tailscale IP (`100.78.240.108` as observed on 2026-08-22) for `cluster.local` split DNS.
- Tailscale clients also use the same NUC Tailscale IP for `k8s.proompteng.ai` split DNS.
- Pi-hole forwards `cluster.local` to the in-cluster CoreDNS service at `10.96.0.10`.
- Pi-hole forwards `ide-newton.ts.net` to the NUC's local Tailscale resolver at `100.100.100.100`.
- Galactic nodes use Pi-hole at provider-LAN address `100.100.244.148`, which is reachable before Tailscale starts.
  Public queries use Pi-hole's public upstreams. Do not mix public upstreams into the nodes' resolver list: they return
  NXDOMAIN for private tailnet names. The NUC is the shared upstream DNS dependency for these nodes.
- Pi-hole serves curated `*.k8s.proompteng.ai` CNAMEs that target `traefik.traefik.svc.cluster.local` for private HTTPS ingress.
- `nuc` accepts Tailscale subnet routes so it can reach the cluster pod/service CIDRs.
- UFW allows DNS (`53/tcp` and `53/udp`) on `tailscale0`.
- UFW also permits DNS on `eno1` from `100.100.244.128/25` to `100.100.244.148`.
- Tailscale uses `nodivert`; `galactic-dns-firewall.service` installs explicit IPv4/IPv6 input, forwarding, and NAT
  hooks. Only provider-LAN DNS to this NUC bypasses the CGNAT drop rule. All other traffic retains the existing
  Tailscale chains and UFW rules. The service restores hooks after boot or a Tailscale/UFW service restart.
- Pi-hole non-secret settings are sourced from this repo, not edited ad hoc on the host.

Files:

- `pihole.toml` is the non-secret Pi-hole source of truth:
  - upstream resolvers
  - local DNS hosts and CNAMEs
  - DHCP scope and static leases
  - web UI ports/theme
  - Tailscale-safe DNS listener mode (`listeningMode = 'ALL'` with firewall restriction)
- `99-kubernetes-split-dns.conf` contains the Kubernetes and tailnet forwarding rules.
- Pi-hole v6 requires `misc.etc_dnsmasq_d = true` in `pihole.toml` or it will ignore files in `/etc/dnsmasq.d/`.
- `apply.sh` installs both `pihole.toml` and `99-kubernetes-split-dns.conf`, enables `tailscale --accept-routes`, opens DNS on `tailscale0`, and restarts Pi-hole.
- `apply-split-dns.sh --check` validates only the forwarding rules and current NUC prerequisites. Its `--apply` mode
  backs up and installs those rules, opens the bounded provider-LAN DNS rules, restarts Pi-hole, and requires public,
  registry, and Kubernetes A-record answers. Failure restores the previous forwarding file. It preserves the existing
  Pi-hole settings, DHCP leases, credentials, databases, and Tailscale preferences.
- `apply-dns-firewall.sh --check` verifies the NUC identity and current Tailscale chains. Its `--apply` mode backs up
  the firewall state, installs the service, and changes only Tailscale's netfilter mode to `nodivert`. It preserves
  the existing Tailscale chains through separately named hooks that Tailscale does not remove or reposition.
  On failure it restores the previous mode and helper/service files.

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
scp devices/nuc/pihole/apply-split-dns.sh kalmyk@192.168.1.130:~/pihole/apply-split-dns.sh
scp devices/nuc/pihole/apply-dns-firewall.sh devices/nuc/pihole/galactic-dns-firewall.service kalmyk@192.168.1.130:~/pihole/
ssh kalmyk@192.168.1.130 'chmod +x ~/pihole/apply*.sh && sudo ~/pihole/apply.sh'
```

For the Talos 1.14 maintenance repair, copy the committed forwarding file, both narrow helpers, and the firewall
service. Run `apply-dns-firewall.sh --check`, then `--apply`, followed by `apply-split-dns.sh --check` and `--apply`.
Verify public, private registry, and Kubernetes names from a cluster node over the
provider LAN before syncing the Omni `ResolverConfig`. Repeat the probes through each CoreDNS replica and from a
pod on each node afterward; require a real registry push from CI. This keeps CoreDNS under Talos ownership.

The helper prints its backup directory. Recovery restores the saved file to `/etc/dnsmasq.d/99-kubernetes-split-dns.conf`
(or removes it when the backup has a `previously-absent` marker) and restarts `pihole-FTL`.
The provider DNS firewall rules remain after a failed apply so the same repair can be
retried. Revert the Omni resolver change before removing those rules or stopping the NUC DNS service.

To undo the firewall integration after reverting the nodes' resolver change, restore Tailscale's prior mode
(`sudo tailscale set --netfilter-mode=on` for the recorded NUC baseline), then
`sudo systemctl disable --now galactic-dns-firewall.service`. Stop removes only the six owned wrapper chains/hooks.
Verify Tailscale's direct input, forwarding, and NAT hooks are restored. Do not restore a complete iptables snapshot
over live Docker or UFW changes; the saved snapshots are audit evidence.

The provider subnet is inside `100.64.0.0/10`, so an ordinary UFW allow is insufficient while Tailscale's automatic
input hook runs first. See [Tailscale netfilter modes](https://tailscale.com/docs/reference/netfilter-modes).

## Verify on NUC

```bash
tailscale status --json | jq '.Self.TailscaleIPs[0], .Self.HostName'
tailscale debug prefs | jq '{CorpDNS, RouteAll}'
grep -E '^(\\[dns\\]|interface|listeningMode|upstreams|\\[dhcp\\]|active|start|end|router)' /etc/pihole/pihole.toml
dig +short @127.0.0.1 google.com
dig +short @127.0.0.1 kubernetes.default.svc.cluster.local
dig +short @100.78.240.108 kubernetes.default.svc.cluster.local
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

After the Tailscale split DNS rule is applied from [tofu/tailscale/main.tf](../../../tofu/tailscale/main.tf):

```bash
dig +short kubernetes.default.svc.cluster.local
dig +short @100.78.240.108 kubernetes.default.svc.cluster.local
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
