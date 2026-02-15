# Harvester → K8s Ceph JBOD Wiring (Jan 12, 2026)

This document is Harvester/KubeVirt-specific and is not the current Ceph wiring for the Talos-based `galactic` cluster.

For the Talos/Rook-Ceph setup, see:
1. `docs/runbooks/rook-ceph-on-talos.md`

## Goal
Expose six 24 TB SAS JBOD disks on host `altra` to three KubeVirt worker VMs (kube-worker-10/11/12) for Rook-Ceph OSDs, without relying on PCI passthrough of the SAS3008 HBA.

## Why not PCI passthrough?
- Only one SAS3008 HBA on `altra`; passthrough binds to `vfio-pci`, so only a single VM can own all disks.
- We accepted the single physical failure domain and prioritized sharing disks across three Ceph VMs for more OSD parallelism.

## Final design
- Disable SAS3008 passthrough (PCIDeviceClaim removed) so disks stay visible on host via `mpt3sas`.
- Create static local PVs (block) for each disk with nodeAffinity to `altra`.
- Bind PVCs (RWO, block) to those PVs in `default` namespace.
- Patch KubeVirt VMs to mount two PVCs each (virtio LUN), all pinned to node `altra`.
- Reboot VMs to pick up new disks.

## Hardware / identifiers
- Host: `altra` (Harvester v1.7.0)
- Disks (by-id):
  - `ata-ST24000NM000C-3WD103_ZXA0MZ1M`
  - `ata-ST24000NM000C-3WD103_ZXA12R7C`
  - `ata-ST24000NM000C-3WD103_ZXA0NL5D`
  - `ata-ST24000NM000C-3WD103_ZXA0LVM9`
  - `ata-ST24000NM000C-3WD103_ZXA0LKW9`
  - `ata-ST24000NM000C-3WD103_ZXA0HS7E`

## File changes
- Added static PV/PVC manifest: `tofu/harvester/templates/osd-local-pvs.yaml`
  - 6 PVs (`pv-osd-01..06`) volumeMode Block, nodeAffinity `kubernetes.io/hostname=altra`, reclaimPolicy Retain.
  - 6 PVCs (`pvc-osd-10-a/b`, `pvc-osd-11-a/b`, `pvc-osd-12-a/b`) bound to those PVs.
- Added VM patch JSONs (now in `tofu/harvester/patches/`):
  - `vm-kube-worker-10-hostdisks.patch.json`
  - `vm-kube-worker-11-hostdisks.patch.json`
  - `vm-kube-worker-12-hostdisks.patch.json`
  - Each sets nodeSelector `kubernetes.io/hostname: altra`, adds two virtio LUN disks, and mounts the corresponding PVCs.
- Kept earlier Ceph scoping change: `argocd/applications/rook-ceph/cluster-values.yaml` now limits storage nodes to kube-worker-10/11/12.
- Left `tofu/harvester/templates/pcideviceclaim-altra-000d01000.yaml` (claim for SAS3008) in repo but **not applied**.

## Commands executed (Harvester cluster, `KUBECONFIG=~/.kube/altra.yaml`)
```bash
# Create PVs/PVCs
kubectl apply -f tofu/harvester/templates/osd-local-pvs.yaml

# Patch VMs to attach PVCs
kubectl patch vm kube-worker-10 -n default --type merge --patch-file tofu/harvester/patches/vm-kube-worker-10-hostdisks.patch.json
kubectl patch vm kube-worker-11 -n default --type merge --patch-file tofu/harvester/patches/vm-kube-worker-11-hostdisks.patch.json
kubectl patch vm kube-worker-12 -n default --type merge --patch-file tofu/harvester/patches/vm-kube-worker-12-hostdisks.patch.json

# Bounce VMs to pick up disks
kubectl patch vm kube-worker-{10,11,12} -n default --type merge -p '{"spec":{"runStrategy":"Halted"}}'
kubectl patch vm kube-worker-{10,11,12} -n default --type merge -p '{"spec":{"runStrategy":"Always"}}'
```

## Verification
- Host sees disks: `lsscsi -g` shows sda–sdf.
- PVs bound: `kubectl get pv pv-osd-*` → all Bound to PVCs.
- VM volume status: `kubectl get vmi kube-worker-10 -n default -o jsonpath='{.status.volumeStatus[*].name}'` → `osd-a osd-b` (similarly for -11/-12).
- Inside VM (`virt-launcher-...`, container compute): `/proc/partitions` shows six ~23.4 TB block devices (sda–sdf).

## To finish Ceph wiring (workload cluster kubeconfig default)
1) In `argocd/applications/rook-ceph/cluster-values.yaml`, set `useAllDevices: false` and list devices explicitly per node:
   - kube-worker-10: sda, sdb
   - kube-worker-11: sdc, sdd
   - kube-worker-12: sde, sdf
2) Sync ArgoCD app `rook-ceph`.
3) Confirm OSD prep/pods: `kubectl -n rook-ceph get pods | grep osd`.
4) Check Ceph tree: `kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd tree`.

## Trade-offs / caveats
- Single physical failure domain (all disks on host `altra`).
- PVs are manual/local; deleting the host or renaming disks requires PV edits.
- Block PVs are unreplicated; Ceph handles redundancy at the OSD layer.
