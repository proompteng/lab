# Tailscale IaC (bootstrap skeleton)

This directory intentionally keeps the Tailscale setup minimal. It configures the provider, manages the tailnet ACL, and codifies the DNS preferences so we can expand into auth keys or Serve configs incrementally.

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

DNS settings (MagicDNS on, global resolver `192.168.1.130`) are managed through `tailscale_dns_preferences.tailnet` and `tailscale_dns_nameservers.tailnet`. Adjust the `dns_nameservers` variable if the resolver changes.

> ℹ️ HTTPS certificates remain a manual tailnet toggle today. Enable MagicDNS and HTTPS in the Tailscale admin console under **DNS → HTTPS certificates** before relying on `tailscale serve` or automated cert provisioning.
