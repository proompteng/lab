# Incident Report: Altra Volume Re-layout + etcd Rejoin Failures

- **Date**: 2026-02-18 (UTC)
- **Node**: `talos-192-168-1-85` (`192.168.1.85`)
- **Cluster**: `ryzen`
- **Scope**: Talos storage layout (`EPHEMERAL`, local-path volumes), boot sequencing, etcd membership
- **Final outcome**: recovered; node rejoined etcd and Kubernetes, desired two-device local-path layout in place

## Target State (What We Needed)

- `EPHEMERAL` fixed at `300GB` on OS disk (`/dev/nvme0n1p4`)
- `u-local-path-provisioner` on remainder of OS disk (`/dev/nvme0n1p5`)
- `u-local-path-provisioner-extra` on extra NVMe (`/dev/nvme1n1p1`)
- node rejoined as healthy etcd voting member

## Failure Modes Observed During Session

### FM-1: Wrong disk selected for `local-path-provisioner-extra`

Symptom:

- Talos repeatedly reported:
  - `no disks matched for volume ... 1 have not enough space`

Observed cause:

- Selector for `local-path-provisioner-extra` pointed at OS disk WWID (`eui.6479a79aa0000025`) instead of the extra disk.
- On this node that WWID belongs to `/dev/nvme0n1`.

Fix applied:

- Switched selector to `disk.dev_path == '/dev/nvme1n1'` in both live config and repo manifests.

Prevention:

- Use `disk.dev_path` selectors on this host to avoid WWID mix-ups.
- Always run `talosctl -n 192.168.1.85 get disks -o yaml` before any apply.

### FM-2: Extra disk locked by active wipe process

Symptom:

- Error changed to:
  - `no disks matched ... 1 have other issues`
  - `failed to acquire shared lock while probing blockdevice`

Observed cause:

- `/dev/nvme1n1` was still being written by a prior ZEROES wipe operation.
- `/proc/diskstats` counters for `nvme1n1` were increasing continuously.

Fix applied:

- Rebooted node to terminate stale wipe lock.
- After reboot, Talos successfully created `/dev/nvme1n1p1` for `u-local-path-provisioner-extra`.

Prevention:

- Never start/leave a long wipe running while Talos volume manager is expected to provision.
- If lock appears, confirm with diskstats before further config churn.

### FM-3: Invalid config source for `apply-config`

Symptom:

- `error decoding document ... missing kind`

Observed cause:

- Attempted to apply raw output from `talosctl get machineconfig -o yaml`.

Fix applied:

- Applied a proper full machine config document instead.

Prevention:

- Treat `talosctl get machineconfig` as introspection output, not a direct apply artifact.

### FM-4: etcd join loop due to stale member entry

Symptom:

- `85` stuck in booting; `machined` logs repeated:
  - `etcd is waiting to join the cluster`
  - `error adding member: etcdserver: Peer URLs already exists`

Observed cause:

- Existing stale learner in etcd had peer URL for `85`.

Fix applied:

1. Listed members from healthy node (`194`/`203`).
2. Removed stale member ID: `5c6345e482e04419`.
3. `85` re-added automatically as learner.
4. Talos promoted learner to voting member (`successfully promoted etcd member`).
5. Peer URL updated to tailscale endpoint `https://100.108.8.111:2380`.

Prevention:

- Before rejoining a rebuilt control-plane node, check etcd members and clear stale entry first.

### FM-5: Temporary `ready: false` after etcd recovery

Symptom:

- `MachineStatus`: `stage: running`, `ready: false`
- unmet condition: static control-plane pods pending

Observed cause:

- Post-recovery control-plane static pods were still starting/pulling.

Fix applied:

- Waited for `kube-apiserver`, `kube-controller-manager`, `kube-scheduler` on `85` to reach `Running`.

Prevention:

- Do not treat immediate post-etcd state as terminal failure; validate pod readiness first.

### FM-6: Bootloader instability signals and confusion

Symptoms observed in session:

- Installer error during one attempt:
  - `failed to install bootloader: write ... LoaderEntryDefault ... input/output error`
- Concern about multiple boot entries.

Findings:

- Firmware had multiple `Boot####` entries (normal on many systems).
- Active loader variables showed Talos entries selected.

Operational guidance:

- Verify active loader vars (`LoaderEntryDefault`, `LoaderEntrySelected`, `LoaderImageIdentifier`) instead of assuming every extra firmware entry is wrong.
- Avoid repeated reinstall loops while troubleshooting unrelated volume issues.

## Final Verified State

Verified on `2026-02-18` after recovery:

- `EPHEMERAL`: `ready`, `/dev/nvme0n1p4`, `300 GB`
- `u-local-path-provisioner`: `ready`, `/dev/nvme0n1p5`, `3.7 TB`
- `u-local-path-provisioner-extra`: `ready`, `/dev/nvme1n1p1`, `4.0 TB`
- etcd members: 3, all voting (`LEARNER=false`)
- node `talos-192-168-1-85`: `Ready` in Kubernetes

## Reproducible Recovery Sequence (Copy/Paste Order)

```bash
# 1) Preflight disks and etcd health
 talosctl -n 192.168.1.85 get disks -o yaml
 talosctl -n 192.168.1.194 etcd members

# 2) Cordon
 kubectl cordon talos-192-168-1-85

# 3) Apply full machine config with these selectors:
#    EPHEMERAL -> /dev/nvme0n1 (300GB fixed)
#    local-path -> /dev/nvme0n1 (grow)
#    local-path-extra -> /dev/nvme1n1 (grow)
 talosctl -n 192.168.1.85 apply-config --mode no-reboot --file <machineconfig.yaml>

# 4) Validate volume config + status
 talosctl -n 192.168.1.85 get volumeconfig u-local-path-provisioner-extra -o yaml
 talosctl -n 192.168.1.85 get volumestatus -o yaml | rg 'EPHEMERAL|u-local-path-provisioner'

# 5) If lock errors on nvme1n1, clear stale wipe lock
 talosctl -n 192.168.1.85 logs machined | rg 'failed to acquire shared lock'
 talosctl -n 192.168.1.85 reboot

# 6) If etcd join says "Peer URLs already exists", remove stale member
 talosctl -n 192.168.1.194 etcd members
 talosctl -n 192.168.1.194 etcd remove-member <stale-member-id>

# 7) Final health and uncordon
 talosctl -n 192.168.1.85 get machinestatus -o yaml | rg 'stage:|ready:'
 kubectl get nodes -o wide
 kubectl uncordon talos-192-168-1-85
```

## Files Updated During This Recovery

- `devices/altra/manifests/local-path-extra.patch.yaml`
- `devices/altra/docs/relayout-volumes.md`
- `docs/incidents/2026-02-18-altra-volume-relayout-etcd-rejoin.md`
