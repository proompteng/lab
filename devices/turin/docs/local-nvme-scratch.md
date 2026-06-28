# Turin Local NVMe Scratch

Use this only for rebuildable workloads pinned to `turin`: CI work directories,
model caches, temporary download staging, and other data that can be deleted.

Do not use this storage for databases, registry canonical data, Kafka, Torghut
durable state, or replicated Ceph data. The two 256GB NVMes are single-host
failure domains.

## Live Disk Evidence

Live host-device readback from the `rook-ceph-osd-0` pod on 2026-06-28 showed:

```text
/dev/disk/by-id/nvme-INTEL_SSDPEKKF256G8L_BTHH851313AU256B -> /dev/nvme0n1
/dev/disk/by-id/nvme-TS256GMTE652T2_I203860329 -> /dev/nvme1n1
```

Both devices already had partition tables. Treat them as local-only and
destructive-to-local-state before provisioning scratch volumes.

Current partition shape from the same live readback:

```text
nvme0n1 238.5G INTEL SSDPEKKF256G8L BTHH851313AU256B
├─nvme0n1p1 238G
└─nvme0n1p2 485M

nvme1n1 238.5G TS256GMTE652T2 I203860329
├─nvme1n1p1 64M
├─nvme1n1p2 64M
├─nvme1n1p3 4G
├─nvme1n1p4 8G
└─nvme1n1p5 226.3G
```

## Talos User-Volume Manifests

- `devices/turin/manifests/local-path-scratch-intel.patch.yaml`
- `devices/turin/manifests/local-path-scratch-transcend.patch.yaml`

These create Talos user volumes mounted by Talos under `/var/mnt/`:

- `u-local-path-provisioner-turin-scratch-intel`
- `u-local-path-provisioner-turin-scratch-transcend`

## Preflight

Run these before applying either patch:

```bash
talosctl -n <turin-ip> get disks -o yaml
talosctl -n <turin-ip> get volumestatus -o yaml
talosctl -n <turin-ip> read /proc/diskstats | rg 'nvme0n1|nvme1n1'
kubectl get pv -A | rg 'local-path|turin'
```

Confirm:

1. `nvme0n1` is Intel `BTHH851313AU256B`.
1. `nvme1n1` is Transcend `I203860329`.
1. Neither disk backs Ceph, Talos install, Kafka, registry, Torghut, or another
   durable workload.
1. You are in a maintenance window; applying or fixing user-volume layout may
   require partition cleanup or a reboot.

## Apply

Do not apply while a Ceph OSD is draining or recovering.

```bash
talosctl -n <turin-ip> apply-config --mode no-reboot --file <machineconfig-with-scratch-patches.yaml>
```

If Talos reports existing partitions, stop and explicitly decide whether to wipe
the local-only partitions. Do not wipe the Kingston NVMe
`nvme-KINGSTON_SNV3S1000G_50026B76878F0B27` or the ORICO Talos install disk.

## Kubernetes StorageClass Wiring

After Talos reports both user volumes ready and mounted, add the mount paths to
`argocd/applications/local-path/patches/local-path-config.patch.yaml` under the
`turin` node entry and add a StorageClass using the local-path provisioner's
`nodePath` parameter.

Do not apply this StorageClass before the Talos mount exists. The local-path
helper can create a normal directory on `/var`, which would silently put scratch
data on the wrong disk.

Example:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path-turin-nvme-scratch
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
    storage.proompteng.ai/durability: rebuildable
    storage.proompteng.ai/node: turin
provisioner: rancher.io/local-path
parameters:
  nodePath: /var/mnt/local-path-provisioner-turin-scratch-intel
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

Only add a `nodePath` after it exists in `nodePathMap`; the provisioner requires
the selected path to be present in the configured path map.

## Acceptance

```bash
talosctl -n <turin-ip> get volumestatus -o yaml | rg -n 'turin-scratch|phase:|location:|prettySize:'
kubectl get storageclass local-path-turin-nvme-scratch
kubectl -n local-path-storage logs deploy/local-path-provisioner --tail=100
```

Then create a tiny PVC/pod pinned to `turin`, write a test file, delete it, and
confirm the PV node affinity is `kubernetes.io/hostname=turin`.
