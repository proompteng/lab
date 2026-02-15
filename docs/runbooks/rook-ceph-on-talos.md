# Rook-Ceph on Talos (galactic) Runbook

This runbook documents the current Rook-Ceph configuration for the Talos-based `galactic` cluster.

## Safety

Ceph will **wipe** any disks listed under `cephClusterSpec.storage.nodes[].devices`.

Do not include Talos install disks in the device list.

## Cluster nodes (Talos)

Control plane nodes:
1. `talos-192-168-1-85` (altra)
1. `talos-192-168-1-202` (ampone)
1. `talos-192-168-1-194` (ryzen)

Storage OSD nodes in this configuration:
1. `talos-192-168-1-85`
1. `talos-192-168-1-202`

Monitor placement:
1. `talos-192-168-1-194` is included in MON placement and intentionally not assigned OSDs.

## Disks used for OSDs

`talos-192-168-1-85`:
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA12R7C` (HDD)
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LKW9` (HDD)
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0HS7E` (HDD)

The 4TB NVMe (`nvme-CT4000P3PSSD8_2402E88D0863`, `/dev/nvme1n1`) is detected but intentionally excluded while preparing baseline OSDs due historical prepare hangs in this cluster.

Talos install disk on `talos-192-168-1-85`:
1. `/dev/nvme0n1` (do not use for Ceph)

`talos-192-168-1-202`:
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0NL5D` (HDD)
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0MZ1M` (HDD)
1. `/dev/disk/by-id/ata-ST24000NM000C-3WD103_ZXA0LVM9` (HDD)

## Replication settings (2 storage hosts)

Because OSDs are only on 2 hosts, any pools with `failureDomain: host` must use replicated size `2` (not `3`).

Current values live in:
1. `argocd/applications/rook-ceph/cluster-values.yaml`

## GitOps locations

Rook-Ceph app:
1. `argocd/applications/rook-ceph`

ApplicationSet placement:
1. `argocd/applicationsets/bootstrap.yaml` (contains the `rook-ceph` app entry)

Rook operator and cluster chart versions:
1. `argocd/applications/rook-ceph/kustomization.yaml`

## Install / rollout steps

1. Ensure you have verified the disk inventory on each node (example):
```bash
talosctl -n 192.168.1.85 get disks -o yaml
talosctl -n 192.168.1.202 get disks -o yaml
```

1. Enable `rook-ceph` in `argocd/applicationsets/bootstrap.yaml`.

1. Sync:
```bash
argocd app sync root
argocd app sync rook-ceph
```

1. Verify:
```bash
kubectl -n rook-ceph get pods
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree
```
