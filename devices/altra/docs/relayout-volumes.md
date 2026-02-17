# Cordon Altra (192.168.1.85) and Re-layout Volumes (EPHEMERAL=300GB, local-path=rest)

Goal: on Talos control-plane node `talos-192-168-1-85` (LAN `192.168.1.85`) change the
storage layout to:

- `EPHEMERAL` (system `/var`) = **300GB**
- `local-path-provisioner` user volume = **all remaining available space** (mounted at `/var/mnt/local-path-provisioner`)
- no additional scratch/runtime user volumes on this node

This procedure preserves cluster state by having the node leave etcd before wiping `/var`.

## Preconditions / Safety

- Maintenance window: wiping `/var` restarts workloads on the node. Single-replica workloads will have downtime.
- Keep quorum: do **not** reboot the other control planes (`192.168.1.194`, `192.168.1.203`) during the window.
- Ensure nothing important is stored on local-path before re-laying out volumes:

```bash
kubectl get pv | rg local-path
```

No `Bound` PVs is the safe starting point.

## Step 0: Snapshot and health checks

```bash
# etcd snapshot (store it somewhere safe)
talosctl etcd snapshot -n 192.168.1.85 -e 192.168.1.85 /tmp/altra-etcd-snap.db

talosctl etcd status -n 192.168.1.85 -e 192.168.1.85
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
kubectl get nodes -o wide
```

## Step 1: Confirm the current layout (baseline)

On `altra`, `EPHEMERAL` is currently consuming essentially the whole install NVMe (no space left for `u-local-path-provisioner`):

```bash
talosctl get discoveredvolumes -n 192.168.1.85 -e 192.168.1.85 -o yaml | rg -n 'nvme0n1p4|EPHEMERAL|u-local-path'
talosctl -n 192.168.1.85 -e 192.168.1.85 get mounts -o yaml
```

## Step 2: Cordon the node

```bash
kubectl cordon talos-192-168-1-85
kubectl get pods -A -o wide --field-selector spec.nodeName=talos-192-168-1-85
```

## Step 3: Stage the new Talos volume config (no reboot)

Repo patches (apply before wiping so the next boot reprovisions correctly):

- `devices/altra/manifests/ephemeral-volume.patch.yaml` (`EPHEMERAL` fixed at 300GB)
- `devices/altra/manifests/local-path.patch.yaml` (user volume grows to consume remaining space)

```bash
talosctl patch machineconfig -n 192.168.1.85 -e 192.168.1.85 --mode=no-reboot \
  --patch @devices/altra/manifests/ephemeral-volume.patch.yaml

talosctl patch machineconfig -n 192.168.1.85 -e 192.168.1.85 --mode=no-reboot \
  --patch @devices/altra/manifests/local-path.patch.yaml
```

## Step 4: Wipe EPHEMERAL and reboot (reprovision `/var` to 300GB)

Because this is the etcd endpoint node, rely on `talosctl reset --graceful` to cordon/drain and leave etcd.

```bash
talosctl reset -n 192.168.1.85 -e 192.168.1.85 \
  --wipe-mode system-disk \
  --system-labels-to-wipe EPHEMERAL \
  --reboot
```

Wait for Talos API to come back:

```bash
talosctl version -n 192.168.1.85 -e 192.168.1.85
```

## Step 5: Verify volumes and mounts

```bash
talosctl get discoveredvolumes -n 192.168.1.85 -e 192.168.1.85 | rg -n 'EPHEMERAL|u-local-path'
talosctl mounts -n 192.168.1.85 -e 192.168.1.85 | rg -n ' /var$|/var/mnt/local-path-provisioner'
kubectl get nodes -o wide
```

Expected:
- `EPHEMERAL` is ~300GB.
- `u-local-path-provisioner` exists and consumes the remaining free space.
- `/var/mnt/local-path-provisioner` is mounted.

If `EPHEMERAL` stays full-disk sized after the reboot, the partition table did not get reprovisioned. At that point:
1. put the node into Talos maintenance mode, and
2. `talosctl wipe disk --insecure --drop-partition nvme0n1p4` to drop the EPHEMERAL partition, then reboot.

## Acceptance Criteria

- `kubectl get nodes` shows `talos-192-168-1-85` is `Ready`.
- `talosctl etcd members` shows 3 healthy members.
- `talosctl mounts` shows:
  - `/var` on a ~300GB EPHEMERAL partition
  - `/var/mnt/local-path-provisioner` mounted
- No extra user volumes are present on the node besides `local-path-provisioner`.
