# Talos and Omni inspection through Agent Shell

Agent Shell exposes `talosctl` and `omnictl` through one read-only `infrastructure` MCP tool. It requires no repository session.
The tunnel forwards to the same Agent Shell server; it does not run a separate tool installation.

## Runtime and identity

The shell image includes Talos CLI 1.14.5 and Omni CLI 1.11.0, matching the deployed host and Omni backend versions.
Official release checksums pin Linux AMD64/ARM64 and Darwin CLI packages in `nix/packages.nix`. The shell image
includes the Linux packages through `nix/images/agents.nix`; the Docker development target installs the same versions.

Production connects to `https://nuc.ide-newton.ts.net:443` with the dedicated `agents-shell-reader` Omni service account.
Its role is `Reader`. It does not reuse the operator's personal login, PGP directory or admin Talos certificates.
The initial key expires on 2027-11-01 UTC. Keep renewal within the same identity and secret-sync path.

The `infra/agents-shell-omni` 1Password item supplies `service-account-key` and `talosconfig` through the
`onepassword-infra` ClusterSecretStore and `agents-shell-omni` ExternalSecret. The deployment mounts the Talos
configuration read-only and supplies the signing key through `OMNI_SERVICE_ACCOUNT_KEY` and
`SIDEROV1_SERVICE_ACCOUNT_KEY`. Never print the signing key, dump the process environment, or commit credentials.

## Consumer checks

Enable Agent Shell Tunnel in the intended ChatGPT conversation. Verify its actual catalog includes the infrastructure tool;
installation in the server alone does not prove a conversation has refreshed its connector catalog.

Call `infrastructure` with:

```json
{ "command": "omnictl", "args": ["get", "clusters", "galactic", "-o", "json"], "maxOutputBytes": 4096 }
```

For Talos PCI device inspection:

```json
{
  "command": "talosctl",
  "args": ["get", "pcidevices", "0000:00:01.0", "--nodes", "12345678-9abc-deff-1234-56789abcdeff", "-o", "json"],
  "maxOutputBytes": 4096
}
```

Use the Omni machine UUIDs in [the Galactic inventory](../../devices/galactic/README.md). Pass the inspection verb
first. The server checks allowed verbs and flags before invoking the executable with argv, without a shell.
Existing output bounds, timeouts, OAuth checks and command auditing apply. Resource inspection, kernel/service
logs and supported runtime counters are available. Configuration overrides, TLS bypass, raw file reads, credential
management, reboots, upgrades, service controls and other mutations are excluded from these MCP tools.

Omni's Reader role independently limits the backend. Talos protects raw file APIs and sensitive resources; this
feature does not grant access to those by labeling them read-only. Report authorization errors instead of switching
to an operator identity. Existing Kubernetes inspection has its own identity and permissions.

## Delivery and acceptance

Follow [release automation](../release-automation.md). Verify the exact merged source, successful image publication,
Agents Freight, `kargo/agents` revision, Argo reconciliation, and deployed shell digest. Then exercise both CLIs
through the private tunnel and the intended ChatGPT conversation. Test a rejected mutation at the tool boundary
without sending an actual mutation to a host. Record catalog refresh failures separately from backend authorization.

The image rollout restarts Agent Shell and ends its in-memory sessions and running commands. Check for active work
before rollout. This feature does not authorize changes to Talos machines, firmware, PCIe settings or Ceph tuning.
