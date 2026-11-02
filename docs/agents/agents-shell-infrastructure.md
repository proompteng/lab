# Host and BMC inspection through Agent Shell

Agent Shell exposes `talosctl` and `omnictl` through one read-only `infrastructure` MCP tool. It requires no repository session.
The tunnel forwards to the same Agent Shell server; it does not run a separate tool installation.

The `bmc` tool exposes fixed hardware inspections for Altra and Turin. It has no repository session,
arbitrary address, credential, protocol or command arguments. Examples:

```json
{ "node": "turin", "operation": "identity", "maxOutputBytes": 4096 }
{ "node": "altra", "operation": "fan_state", "maxOutputBytes": 8192 }
```

Supported operations are `identity`, `sensors`, `events`, `inventory` and `power_status` on both nodes,
plus `module_sensors` and `fan_state` on Altra. Events are bounded to the last 50 entries.
Power status does not expose power controls. The shell image includes IPMI and SSH clients.

IPMI uses dedicated `agents-reader` accounts with channel privilege USER, level 2. The client explicitly requests
an encrypted `lanplus` cipher-suite-17 USER session. Slot 3 on channel 1 was verified unused before provisioning
on 2026-11-01. Channel readback and actual reader sessions confirmed the privilege and five standard operations.
The macOS `ipmitool 1.8.19` client crashed during Altra's bridged `module_sensors` operation; Linux behavior requires
its own runtime check. There is no protocol or privilege fallback.

Altra's `fan_state` uses a dedicated Ed25519 SSH key and a pinned BMC host key. Its authorization entry on the BMC is:

```text
restrict,command="/conf/agents-shell/inspect" <dedicated public key>
```

The key authenticates as `sysadmin`, UID 0 on this BMC, but the server forces the fixed
[inspection script](../../devices/altra/scripts/agents-shell-inspect.sh). It reads carrier PWM/tachometer channels
0, 1, 3 and 4, exact `thermalmgr` process names and three named cooling configuration files.
It ignores the requested SSH command and stdin. OpenSSH `restrict` disables PTY, forwarding and user rc execution.
No administrator password, arbitrary shell or fan controls are delivered to Agent Shell. Verify the server-side
restriction with a harmless alternate command and a rejected forwarding request after provisioning.

The `infra/agents-shell-bmc` 1Password item supplies `altra-password`, `turin-password`, `altra-ssh-key` and
`altra-known-hosts` through the existing `onepassword-infra` store and `agents-shell-bmc` ExternalSecret.
Files are mounted read-only with mode `0440` at `/var/run/secrets/agents-shell-bmc`, readable by the existing
non-root pod's `fsGroup: 1000`. Passwords and private keys stay out of arguments, environment values, receipts and
logs. `AGENTS_SHELL_BMC_SECRET_DIR` selects the server-owned directory for local verification.
Operator credentials stay outside the image and Secret.

Altra's BMC uses DHCP on the provider LAN, currently `100.100.244.132/25`, with MAC `00:30:64:33:87:e5` and gateway
`100.100.244.129`. The authorized migration on 2026-11-01 verified DHCP discovery/request, the existing SSH host key
at the new address, native network readback and pod reachability. This is a DHCP allocation, not a static reservation.
Turin's BMC remains `100.100.244.170`. A changed DHCP lease requires verifying the same BMC identity and updating the
fixed target and host pin. There is no old-address fallback. Workstation and pod TCP checks do not establish deployed
MCP or Oracle acceptance; exercise the real tools after delivery.

These inspection tools cannot change network addresses, routes, firmware, power or fans. Follow the owning hardware
runbooks for separately authorized administration.

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
