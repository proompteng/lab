# Ampone volume relayout (EPHEMERAL=300GB, local-path=rest)

This runbook changes the Talos disk layout on the AmpereOne control-plane node
`talos-192-168-1-203` ("ampone", LAN `192.168.1.203`) to:

- `EPHEMERAL` (`/var`) = 300GB
- `local-path-provisioner` user volume mounted at `/var/mnt/local-path-provisioner` = remainder

The intent is to keep Talos system disk usage bounded while providing a large
node-local filesystem for the local-path provisioner.

## Preconditions

- Maintenance window: ampone is a control-plane node; it will be unavailable
  during the relayout.
- Do not reboot `192.168.1.85` (altra) or `192.168.1.194` (ryzen) during the
  window.
- Confirm no critical local-path PVs are bound to ampone (they would be lost if
  they were placed on the node-local path):

```bash
kubectl get pv -o json | jq -r '
  .items[]
  | select(.spec.storageClassName=="local-path")
  | [.metadata.name, .status.phase]
  | @tsv'
```

## 0) Ensure GitOps local-path config supports ampone

The local-path provisioner uses a per-node path map. Ensure it contains:

- `talos-192-168-1-203` -> `/var/mnt/local-path-provisioner`

Source of truth:

- `/Users/gregkonush/.codex/worktrees/0133/lab/argocd/applications/local-path/patches/local-path-config.patch.yaml`

## 1) Snapshot etcd + verify health

```bash
talosctl etcd snapshot -n 192.168.1.85 -e 192.168.1.85 -f /tmp/ampone-etcd-snap.db
talosctl etcd status -n 192.168.1.85 -e 192.168.1.85
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
```

## 2) Cordon and drain ampone

```bash
kubectl cordon talos-192-168-1-203
kubectl drain talos-192-168-1-203 --ignore-daemonsets --delete-emptydir-data
kubectl get pods -A -o wide --field-selector spec.nodeName=talos-192-168-1-203
```

## 3) Remove ampone from etcd

If ampone is the leader:

```bash
talosctl etcd forfeit-leadership -n 192.168.1.203 -e 192.168.1.85
```

Then:

```bash
talosctl etcd leave -n 192.168.1.203 -e 192.168.1.85
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
```

## 4) Reset ampone into maintenance mode

This wipes the system disk state on ampone. Cluster state remains on the other
control-plane nodes.

```bash
talosctl reset -n 192.168.1.203 -e 192.168.1.85 --wipe-mode system-disk --reboot --graceful=false
```

When the node comes back in maintenance mode, use `--insecure` for operations on
`192.168.1.203`.

## 5) Drop the current large EPHEMERAL partition

On the existing layout, `EPHEMERAL` consumes most of the disk (typically
`/dev/nvme0n1p4`). Confirm before dropping:

```bash
talosctl --insecure get discoveredvolumes -n 192.168.1.203 -e 192.168.1.203 | rg 'nvme0n1p[0-9]+|EPHEMERAL'
```

Drop the EPHEMERAL partition:

```bash
talosctl --insecure wipe disk -n 192.168.1.203 -e 192.168.1.203 --drop-partition nvme0n1p4
```

## 6) Apply config patches and reboot

Apply the same patches used for install/join, including the volume configs:

- `/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/install-nvme0n1.patch.yaml`
- `/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/controlplane-endpoint-nuc.patch.yaml`
- `/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/hostname.patch.yaml`
- `/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/ephemeral-volume.patch.yaml`
- `/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/local-path.patch.yaml`

```bash
talosctl --insecure apply-config -n 192.168.1.203 -e 192.168.1.203 \
  -f /Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/controlplane.yaml \
  --config-patch @/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/install-nvme0n1.patch.yaml \
  --config-patch @/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/controlplane-endpoint-nuc.patch.yaml \
  --config-patch @/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/hostname.patch.yaml \
  --config-patch @/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/ephemeral-volume.patch.yaml \
  --config-patch @/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/local-path.patch.yaml \
  --mode=reboot
```

## 7) Validate new layout and mounts

```bash
talosctl get discoveredvolumes -n 192.168.1.203 -e 192.168.1.85 | rg 'EPHEMERAL|u-local-path-provisioner|nvme0n1p'
talosctl mounts -n 192.168.1.203 -e 192.168.1.85 | rg ' /var$|/var/mnt/local-path-provisioner'
talosctl get volumestatuses -n 192.168.1.203 -e 192.168.1.85 | rg 'EPHEMERAL|u-local-path-provisioner'
```

Expected:

- `EPHEMERAL` ~300GB mounted at `/var`
- `u-local-path-provisioner` uses the remainder mounted at `/var/mnt/local-path-provisioner`

## 8) Ensure etcd returns to 3 members + uncordon

```bash
kubectl get nodes -o wide
talosctl etcd members -n 192.168.1.85 -e 192.168.1.85
kubectl uncordon talos-192-168-1-203
```

## Notes: preventing "overgrow"

Talos volume growth behavior is controlled by the volume config:

- `grow: false` keeps the user volume size stable on subsequent boots (no
  auto-resize if the disk size changes).
- If `maxSize` is unset, the initial provisioning can use all remaining space.

Source of truth:

- `/Users/gregkonush/.codex/worktrees/0133/lab/devices/ampone/manifests/local-path.patch.yaml`
