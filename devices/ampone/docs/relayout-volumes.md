# Cordon Ampone (192.168.1.203) and Re-layout Volumes (EPHEMERAL=300GB, local-path=rest)

Goal: on Talos control-plane node `talos-192-168-1-203` (LAN `192.168.1.203`) change the
storage layout to:

- `EPHEMERAL` (system `/var`) = **300GB**
- `local-path-provisioner` user volume = **all remaining available space** (mounted at `/var/mnt/local-path-provisioner`)
- no additional scratch/runtime user volumes on this node

This procedure preserves cluster state by having the node leave etcd before wiping `/var`.

## Preconditions / Safety

- Maintenance window: wiping `/var` restarts workloads on the node. Single-replica workloads will have downtime.
- Keep quorum: do **not** reboot the other control planes (`192.168.1.85`, `192.168.1.194`) during the window.
- Ensure nothing important is stored on local-path before re-laying out volumes:

```bash
kubectl get pv | rg local-path
```

No `Bound` PVs is the safe starting point.

## Step 0: Snapshot and health checks

```bash
# etcd snapshot (store it somewhere safe)
talosctl etcd snapshot -n 192.168.1.85 -e 192.168.1.85 /tmp/ampone-etcd-snap.db

talosctl etcd status -n 192.168.1.85 -e 192.168.1.85
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
kubectl get nodes -o wide
```

## Step 1: Confirm the current layout (baseline)

On `ampone`, `EPHEMERAL` is currently consuming essentially the whole install NVMe (no space left for `u-local-path-provisioner`):

```bash
talosctl get discoveredvolumes -n 192.168.1.203 -e 192.168.1.85 -o yaml | rg -n 'nvme0n1p4|EPHEMERAL|u-local-path'
talosctl -n 192.168.1.203 -e 192.168.1.85 get mounts -o yaml
```

## Step 2: Cordon the node

```bash
kubectl cordon talos-192-168-1-203
kubectl get pods -A -o wide --field-selector spec.nodeName=talos-192-168-1-203
```

## Step 3: Stage the new Talos volume config (no reboot)

Repo patches (apply before wiping so the next boot reprovisions correctly):

- `devices/ampone/manifests/ephemeral-volume.patch.yaml` (`EPHEMERAL` fixed at 300GB)
- `devices/ampone/manifests/local-path.patch.yaml` (user volume grows to consume remaining space)

```bash
talosctl patch machineconfig -n 192.168.1.203 -e 192.168.1.85 --mode=no-reboot \
  --patch @devices/ampone/manifests/ephemeral-volume.patch.yaml

talosctl patch machineconfig -n 192.168.1.203 -e 192.168.1.85 --mode=no-reboot \
  --patch @devices/ampone/manifests/local-path.patch.yaml
```

## Step 4: Remove 203 from etcd

```bash
# If 203 is leader, forfeit leadership first:
talosctl etcd forfeit-leadership -n 192.168.1.203 -e 192.168.1.85

talosctl etcd leave -n 192.168.1.203 -e 192.168.1.85
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
```

Confirm only `192.168.1.85` + `192.168.1.194` remain in etcd before wiping `/var`.

## Step 5: Reprovision the partition layout (required to resize EPHEMERAL)

If `EPHEMERAL` already occupies the whole disk, `talosctl reset --system-labels-to-wipe EPHEMERAL` will wipe data but will not
shrink the partition. To actually resize `EPHEMERAL` to 300GB and create `u-local-path-provisioner`, reprovision the system disk
partition layout from Talos maintenance mode.

Recommended: follow the reinstall path in `devices/ampone/docs/cluster-bootstrap.md` (it applies the volume patches at install time).

1. Reset the system disk so the node boots into Talos maintenance mode (no config):

```bash
talosctl reset -n 192.168.1.203 -e 192.168.1.85 \
  --wipe-mode system-disk \
  --reboot --graceful=false
```

2. Apply config from maintenance mode, including these patches:
- `devices/ampone/manifests/ephemeral-volume.patch.yaml` (`EPHEMERAL` fixed at 300GB)
- `devices/ampone/manifests/local-path.patch.yaml` (`local-path-provisioner` consumes remaining space)

See `devices/ampone/docs/cluster-bootstrap.md` for the exact `talosctl apply-config --insecure` command (it also covers generating
the controlplane config from existing secrets).

Wait for Talos API to come back after install:

```bash
talosctl version -n 192.168.1.203 -e 192.168.1.85
```

## Step 6: Verify volumes and mounts

```bash
talosctl get discoveredvolumes -n 192.168.1.203 -e 192.168.1.85 | rg -n 'EPHEMERAL|u-local-path'
talosctl mounts -n 192.168.1.203 -e 192.168.1.85 | rg -n ' /var$|/var/mnt/local-path-provisioner'
```

Expected:
- `EPHEMERAL` is ~300GB.
- `u-local-path-provisioner` exists and consumes the remaining free space.
- `/var/mnt/local-path-provisioner` is mounted.

## Step 7: Ensure 203 re-joins etcd, then uncordon

```bash
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
kubectl get nodes -o wide

kubectl uncordon talos-192-168-1-203
```

## Pitfall: Duplicate `machine.files` paths break kubelet/bootstrap

Symptom:
- Logs show:
  - `writeUserFiles failed ... resource EtcFileSpecs... already exists`
  - `error writing kubelet PKI ... /etc/kubernetes/bootstrap-kubeconfig: read-only file system`

Cause:
- Machine config contains multiple `machine.files` entries with the same `path`.

Fix:
1. Download the machine config and remove the duplicate file spec.
2. Apply the corrected full config.

```bash
talosctl get machineconfig -n 192.168.1.203 -e 192.168.1.85 -o yaml > /tmp/ampone-machineconfig.yaml

# Edit /tmp/ampone-machineconfig.yaml so each `machine.files[].path` appears only once.

talosctl apply-config -n 192.168.1.203 -e 192.168.1.85 -f /tmp/ampone-machineconfig.yaml --mode=reboot
```

## Acceptance Criteria

- `kubectl get nodes` shows `talos-192-168-1-203` is `Ready`.
- `talosctl etcd members` shows 3 healthy members.
- `talosctl mounts` shows:
  - `/var` on a ~300GB EPHEMERAL partition
  - `/var/mnt/local-path-provisioner` mounted
- No extra user volumes are present on the node besides `local-path-provisioner`.
