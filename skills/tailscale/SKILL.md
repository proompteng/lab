---
name: tailscale-ops
description: Operational guidance for Tailscale networking tasks, including checking tailnet status, DNS names, device tags, ACL/auth key usage, subnet routers, exit nodes, and Serve/Funnel. Use when requests mention Tailscale, ts.net, tailnet, MagicDNS, Tailscale CLI, or connectivity/troubleshooting in a Tailscale-managed network.
---

# Tailscale Ops

## Workflow

1) **Clarify scope**: local machine, server, or Kubernetes cluster? Confirm whether changes are desired or read-only diagnostics are enough.
2) **Gather state (read-only by default)**:
   - `tailscale status --json`
   - `tailscale ip -4` / `tailscale ip -6`
   - `tailscale whois <ip>` (if identifying peers)
   - `tailscale netcheck` (connectivity)
   - `tailscale ping <node>` (reachability)
3) **Interpret results**:
   - Use `Self.DNSName` to confirm the node’s ts.net name.
   - Check `Peer` entries for tags, endpoints, and connectivity.
4) **Only mutate when asked**:
   - Avoid `tailscale up` or ACL changes unless explicitly requested.
   - Never print or commit auth keys/secrets.

## Common tasks

- **Find Tailnet domain / node DNS**:
  - `tailscale status --json` → `Self.DNSName` (strip trailing `.`).
- **Validate MagicDNS name**:
  - Confirm `Self.DNSName` and that MagicDNS is enabled in admin console.
- **Subnet routers**:
  - Check routes in `tailscale status --json` (peer routes).
  - Changes require `tailscale up --advertise-routes=...` and ACL approval.
- **Exit nodes**:
  - Check available exit nodes: `tailscale status`.
  - Enable/disable only with explicit approval.
- **Serve/Funnel**:
  - `tailscale serve status` / `tailscale funnel status`.

## Kubernetes notes

- For Services exposed via Tailscale, check `tailscale.com/hostname` annotations and Service status.
- Confirm the expected ts.net FQDN and TLS termination path.

## Safety

- Treat auth keys and client secrets as sensitive.
- Prefer read-only diagnostics unless the user explicitly asks to change network state.
