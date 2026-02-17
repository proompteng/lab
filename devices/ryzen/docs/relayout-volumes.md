# Cordon Ryzen (192.168.1.194) and Re-layout Volumes (EPHEMERAL=200GB, local-path=rest)

Goal: on Talos control-plane node `talos-192-168-1-194` (LAN `192.168.1.194`) change the
storage layout to:

- `EPHEMERAL` (system `/var`) = **200GB**
- `local-path-provisioner` user volume = **all remaining available space** (mounted at `/var/mnt/local-path-provisioner`)
- no additional scratch/runtime user volumes on this node (only `local-path-provisioner`)

This procedure preserves cluster state by having the node leave etcd before wiping `/var`.

## Preconditions / Safety

- Maintenance window: wiping `/var` restarts workloads on the node. Single-replica workloads will have downtime.
- Keep quorum: do **not** reboot the other control planes (`192.168.1.85`, `192.168.1.203`) during the window.
- Ensure nothing important is stored on local-path before re-laying out volumes:

```bash
kubectl get pv | rg local-path
```

No `Bound` PVs is the safe starting point.

## Step 0: Snapshot and health checks

```bash
# etcd snapshot (store it somewhere safe)
talosctl etcd snapshot -n 192.168.1.85 -e 192.168.1.85 /tmp/ryzen-etcd-snap.db

talosctl etcd status -n 192.168.1.85 -e 192.168.1.85
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
kubectl get nodes -o wide
```

If you run Ceph, confirm it can tolerate one control-plane being disrupted.

## Step 1: Cordon the node

```bash
kubectl cordon talos-192-168-1-194
kubectl get pods -A -o wide --field-selector spec.nodeName=talos-192-168-1-194
```

## Step 2: Stage the new Talos volume config (no reboot)

Repo patches (apply before wiping so the next boot reprovisions correctly):

- `devices/ryzen/manifests/ephemeral-volume.patch.yaml` (`EPHEMERAL` fixed at 200GB)
- `devices/ryzen/manifests/local-path.patch.yaml` (user volume grows to consume remaining space)

```bash
talosctl patch machineconfig -n 192.168.1.194 -e 192.168.1.85 --mode=no-reboot \
  --patch @devices/ryzen/manifests/ephemeral-volume.patch.yaml

talosctl patch machineconfig -n 192.168.1.194 -e 192.168.1.85 --mode=no-reboot \
  --patch @devices/ryzen/manifests/local-path.patch.yaml
```

## Step 3: Remove 194 from etcd

```bash
# If 194 is leader, forfeit leadership first:
talosctl etcd forfeit-leadership -n 192.168.1.194 -e 192.168.1.85

talosctl etcd leave -n 192.168.1.194 -e 192.168.1.85
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
```

Confirm only `192.168.1.85` + `192.168.1.203` remain in etcd before wiping `/var`.

## Step 4: Drop old user-volume partitions (free space for the new layout)

Identify existing user-volume partitions (example on Ryzen was `nvme0n1p5` + `nvme0n1p6`):

```bash
talosctl get discoveredvolumes -n 192.168.1.194 -e 192.168.1.85 | rg u-
```

Drop the partitions:

```bash
talosctl wipe disk -n 192.168.1.194 -e 192.168.1.85 --drop-partition nvme0n1p5 nvme0n1p6
```

## Step 5: Wipe EPHEMERAL and reboot (reprovision `/var` to 200GB)

```bash
talosctl reset -n 192.168.1.194 -e 192.168.1.85 \
  --wipe-mode system-disk \
  --system-labels-to-wipe EPHEMERAL \
  --reboot --graceful=false
```

Wait for Talos API to come back:

```bash
talosctl version -n 192.168.1.194 -e 192.168.1.85
```

## Step 6: Verify volumes and mounts

```bash
talosctl get discoveredvolumes -n 192.168.1.194 -e 192.168.1.85 | rg -n 'EPHEMERAL|u-local-path'
talosctl mounts -n 192.168.1.194 -e 192.168.1.85 | rg -n ' /var$|/var/mnt/local-path-provisioner'
```

Expected:
- `EPHEMERAL` is ~200GB.
- `u-local-path-provisioner` exists and consumes the remaining free space.
- `/var/mnt/local-path-provisioner` is mounted.

## Step 7: Fix Talos boot failures caused by duplicate `machine.files` paths (pitfall)

Symptom:
- Node is `NotReady`, `cri`/`kubelet` don’t come up.
- Logs show:
  - `writeUserFiles failed ... resource EtcFileSpecs... already exists`
  - `error writing kubelet PKI ... /etc/kubernetes/bootstrap-kubeconfig: read-only file system`

Cause:
- Machine config contains multiple `machine.files` entries with the same `path`
  (for example `/etc/cri/conf.d/20-customization.part`).

Fix:
1. Download the machine config and remove the duplicate file spec.
2. Apply the corrected full config (multi-document configs are hard to patch surgically).

```bash
talosctl get machineconfig -n 192.168.1.194 -e 192.168.1.85 -o yaml > /tmp/ryzen-machineconfig.yaml

# Edit /tmp/ryzen-machineconfig.yaml so each `machine.files[].path` appears only once.

talosctl apply-config -n 192.168.1.194 -e 192.168.1.85 -f /tmp/ryzen-machineconfig.yaml --mode=reboot
```

Validate services after reboot:

```bash
talosctl services -n 192.168.1.194 -e 192.168.1.85
kubectl get nodes -o wide
```

## Step 8: Ensure 194 re-joins etcd, then uncordon

```bash
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
kubectl get nodes -o wide

kubectl uncordon talos-192-168-1-194
```

## Acceptance Criteria

- `kubectl get nodes` shows `talos-192-168-1-194` is `Ready`.
- `talosctl etcd members` shows 3 healthy members.
- `talosctl mounts` shows:
  - `/var` on a ~200GB EPHEMERAL partition
  - `/var/mnt/local-path-provisioner` mounted
- No extra user volumes are present on the node besides `local-path-provisioner`.
