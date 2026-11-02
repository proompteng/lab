# Host and BMC inspection through Agent Shell

Agent Shell exposes `talosctl` and `omnictl` through one read-only `infrastructure` MCP tool. It requires no repository session.
The tunnel forwards to the same Agent Shell server; it does not run a separate tool installation.

The `bmc` tool adds fixed, read-only IPMI operations for Altra and Turin. It has no repository session,
arbitrary address, credential, protocol, or command arguments. Examples:

```json
{ "node": "turin", "operation": "identity", "maxOutputBytes": 4096 }
{ "node": "altra", "operation": "module_sensors", "maxOutputBytes": 8192 }
```

Supported operations are `identity`, `sensors`, `events`, `inventory`, and `power_status` on both nodes,
plus `module_sensors` on Altra. Events are bounded to the last 50 entries. Power status does not expose power controls.
The image includes the pinned Nixpkgs `ipmitool`; the Docker development target includes the same executable.

Each BMC uses its dedicated `agents-reader` account with IPMI channel privilege `USER` (level 2).
The client explicitly requests an encrypted `lanplus` cipher-suite-17 USER session. There is no fallback to
unencrypted IPMI, elevated privileges, operator credentials, raw OEM commands, or a different target.
Provisioning must verify the unused account slot, reader login and channel privilege before delivery.

The `infra/agents-shell-bmc` 1Password item supplies `altra-password` and `turin-password` through the existing
`onepassword-infra` store and `agents-shell-bmc` ExternalSecret. Password files are mounted read-only with mode
`0440` at `/var/run/secrets/agents-shell-bmc`, readable by the non-root pod's existing `fsGroup: 1000`.
`ipmitool -f` reads them without including the password in arguments,
environment variables, command receipts, or audit logs. The operator's local BMC credential files remain outside
the image and Secret. `AGENTS_SHELL_BMC_SECRET_DIR` selects the server-owned directory for local verification.

Altra's BMC is `192.168.0.100`, on its separate management subnet. Turin's BMC is `100.100.244.170`.
Workstation access does not establish pod access. Verify both endpoints from the deployed Agent Shell before
claiming Oracle can inspect them. Do not change BMC addresses, Talos networking, routes, fan controls, or power
settings as a workaround for an unreachable target. Follow the owning hardware runbooks for separately authorized changes.

Reader provisioning on 2026-11-01 used slot 3 on IPMI channel 1 on each BMC after verifying the slots were unused.
Channel readback confirmed USER privilege; encrypted reader sessions passed identity, carrier sensors, event logs,
inventory and power-status reads through the local MCP server from the workstation with only the read scope.
The server rejected a power-cycle operation before invoking a process. The macOS `ipmitool 1.8.19` process crashed during Altra's
bridged module-sensor read; this does not establish whether the deployed Linux client supports that operation.
Altra's management endpoint was unreachable from Agent Shell, so workstation checks do not establish its remote availability.

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
and each available BMC through the private tunnel and the intended ChatGPT conversation. Test a rejected mutation at the tool boundary
without sending an actual mutation to a host. Record catalog refresh failures separately from backend authorization.

The image rollout restarts Agent Shell and ends its in-memory sessions and running commands. Check for active work
before rollout. This feature does not authorize changes to Talos machines, firmware, PCIe settings or Ceph tuning.
