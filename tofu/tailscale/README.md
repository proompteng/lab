# Tailscale IaC (bootstrap skeleton)

This directory intentionally keeps the Tailscale setup minimal. It configures the provider, manages the tailnet ACL, codifies DNS, and approves subnet routes for tagged Kubernetes nodes so the tailnet can reach in-cluster services.

## Prerequisites

- Export a Tailscale API key (`TS_API_KEY`) **or** OAuth client credentials (`TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET`).
- Set the tailnet name via `TF_VAR_tailnet` (defaults to `"-"`, meaning "use the API key's default tailnet").
- Optionally set `TF_VAR_tailscale_api_key` (or place it in `secrets.auto.tfvars`) if you prefer to inject the API key via Terraform variables instead of ambient environment variables.

## Usage

```bash
cd tofu/tailscale
# adjust tailnet if needed, e.g. `export TF_VAR_tailnet=proompteng.ai`
tofu init
# If the tailnet already has a non-default ACL, import it once:
# tofu import tailscale_acl.tailnet acl
tofu plan
```

The ACL rendered at `templates/policy.hujson.tmpl` matches the settings captured from the admin console on 2025-09-19. Update that template (and re-run `tofu plan`) as we tighten access rules or add new tags. Additional resources—auth keys, Serve configs, etc.—can be layered in alongside the ACL resource when needed.

DNS settings are managed centrally through `tailscale_dns_configuration.tailnet`:

- `magic_dns = true`
- global nameservers from `dns_nameservers`
- split DNS from `dns_split_nameservers`
- `override_local_dns` to control whether the global resolvers replace local DNS for non-tailnet queries

The current default global resolver remains `192.168.1.130`. If Pi-hole should be reachable over Tailscale instead of only on the LAN, change that to the Pi-hole node's Tailscale IP after Pi-hole is configured to answer on `tailscale0` and the firewall allows DNS over the tailnet.

Example split DNS for Kubernetes through Pi-hole on the `nuc` device:

```hcl
dns_split_nameservers = {
  "cluster.local" = ["100.88.12.116"]
}
```

Kubernetes subnet routes approved for tagged kube nodes come from `kubernetes_routes`. Keep this aligned with the actual pod and service CIDRs used by the cluster. As of 2026-03-11, the live cluster was observed with `--cluster-cidr=10.244.0.0/16`, `--service-cluster-ip-range=10.96.0.0/12`, and `kube-dns` at `10.96.0.10`, so the defaults include `10.244.0.0/16` and `10.96.0.0/12`.

> ℹ️ HTTPS certificates remain a manual tailnet toggle today. Enable MagicDNS and HTTPS in the Tailscale admin console under **DNS → HTTPS certificates** before relying on `tailscale serve` or automated cert provisioning.
