# Turin Local NVMe Scratch

Use this only for rebuildable workloads pinned to `turin`: CI work directories,
model caches, temporary download staging, and other data that can be deleted.

Do not use this storage for databases, registry canonical data, Kafka, Torghut
durable state, or replicated Ceph data. The two 256GB NVMes are single-host
failure domains.

## Live Disk Evidence

Live Talos disk readback on 2026-06-29 showed:

```text
/dev/disk/by-id/nvme-TS256GMTE652T2_I203860329 -> /dev/nvme0n1
/dev/disk/by-id/nvme-INTEL_SSDPEKKF256G8L_BTHH851313AU256B -> /dev/nvme1n1
```

The Transcend device previously had old COS partitions; they were cleared with
`talosctl wipe disk ... --drop-partition` on 2026-06-29. The Intel device was
initially visible as a whole disk, then Talos created `u-turin-nvme-intel` as
GPT partition 1. The kernel briefly exposed that partition as stale
`/dev/nvme1n1p2`; this was corrected without reboot by running `partx -d --nr 2`
and `partx -a --nr 1` from the privileged Turin OSD container. Treat both
devices as local-only and destructive-to-local-state before provisioning scratch
volumes.

Current disk shape from the same live readback:

```text
nvme0n1 256GB TS256GMTE652T2 I203860329
nvme1n1 256GB INTEL SSDPEKKF256G8L BTHH851313AU256B
nvme2n1 1.0TB KINGSTON SNV3S1000G 50026B76878F0B27
nvme3n1 4.1TB ORICO 13CBMEK6HEW8CN2X9AKW
```

The Kingston device is reserved for Ceph BlueStore DB/WAL. The ORICO device is
the Talos OS/EPHEMERAL disk. Do not use either for local-path scratch.

Previously cleared local-only Transcend partitions:

```text
nvme0n1p1 COS_GRUB
nvme0n1p2 COS_OEM
nvme0n1p3 COS_RECOVERY
nvme0n1p4 COS_STATE
nvme0n1p5 COS_PERSISTENT
```

## Talos User-Volume Manifests

- `devices/turin/manifests/local-path-scratch-intel.patch.yaml`
- `devices/turin/manifests/local-path-scratch-transcend.patch.yaml`

These create Talos user volumes mounted by Talos under `/var/mnt/`:

- `/var/mnt/turin-nvme-intel`
- `/var/mnt/turin-nvme-transcend`

The selectors must use stable by-id symlinks, not `/dev/nvmeXn1`, because NVMe
enumeration can change across boot:

```yaml
match: "'/dev/disk/by-id/nvme-INTEL_SSDPEKKF256G8L_BTHH851313AU256B' in disk.symlinks && !system_disk"
match: "'/dev/disk/by-id/nvme-TS256GMTE652T2_I203860329' in disk.symlinks && !system_disk"
```

## Preflight

Run these before applying either patch:

```bash
talosctl -n <turin-ip> get disks -o yaml
talosctl -n <turin-ip> get volumestatus -o yaml
talosctl -n <turin-ip> read /proc/diskstats | rg 'nvme0n1|nvme1n1'
kubectl get pv -A | rg 'local-path|turin'
```

Confirm:

1. `nvme0n1` currently reports Transcend `I203860329`.
1. `nvme1n1` currently reports Intel `BTHH851313AU256B`.
1. The Talos user-volume selectors still match by stable `/dev/disk/by-id/*`
   symlink, not by `/dev/nvmeXn1`.
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
For the current live mapping, the Transcend `TS256GMTE652T2_I203860329` stale
COS partitions were already cleared on 2026-06-29 before enabling the scratch
user volume.

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
  name: local-path-turin-nvme-intel
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
    storage.proompteng.ai/durability: rebuildable
    storage.proompteng.ai/node: turin
provisioner: rancher.io/local-path
parameters:
  nodePath: /var/mnt/turin-nvme-intel
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowedTopologies:
  - matchLabelExpressions:
      - key: kubernetes.io/hostname
        values:
          - turin
```

Only add a `nodePath` after it exists in `nodePathMap`; the provisioner requires
the selected path to be present in the configured path map.

The GitOps storage classes are:

- `local-path-turin-nvme-intel`
- `local-path-turin-nvme-transcend`

Both are non-default, `Delete` reclaim, `WaitForFirstConsumer`, and constrained
to `kubernetes.io/hostname=turin`.

If the local-path provisioner has already been running, restart only that
Deployment after applying the ConfigMap so it reloads the new Turin node paths.
This does not move or remount existing local-path PV data.

## Acceptance

```bash
talosctl -n <turin-ip> get volumestatus -o yaml | rg -n 'turin-scratch|phase:|location:|prettySize:'
kubectl get storageclass local-path-turin-nvme-intel local-path-turin-nvme-transcend
kubectl -n local-path-storage logs deploy/local-path-provisioner --tail=100
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata -f json | jq -r '.[] | select(.hostname=="turin") | [.id,.bluefs_db_devices] | @tsv'
```

Then create a tiny PVC/pod for each StorageClass, pin the pod to `turin`, write
a test file, delete it, and confirm the PV node affinity is
`kubernetes.io/hostname=turin`.

## References

- Talos disk selectors:
  <https://docs.siderolabs.com/talos/v1.13/configure-your-talos-cluster/storage-and-disk-management/disk-management/common>
- Local Path Provisioner:
  <https://github.com/rancher/local-path-provisioner>
