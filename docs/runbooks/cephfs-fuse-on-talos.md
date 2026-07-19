# CephFS On Talos

The `galactic` Talos nodes provide the in-kernel CephFS client. Use the kernel client for durable, high-churn RWX workloads. Keep `rook-cephfs-fuse` only as an explicit compatibility class.

## Cluster Configuration

Rook configuration is owned by GitOps:

- `argocd/applications/rook-ceph/operator-values.yaml`
- `argocd/applications/rook-ceph/storageclasses.yaml`

The required defaults are:

- `rook-cephfs` uses the kernel mounter with `noatime` and `ms_mode=crc`.
- `rook-cephfs-fuse` explicitly sets `mounter: fuse`.
- The CephFS CSI node plugin requests 1 GiB and is limited to 4 GiB.
- The CephFS CSI node-plugin DaemonSet rolls one node at a time.

`ms_mode=crc` is required for the kernel client to negotiate Ceph messenger v2 with the current cluster. Do not remove it from either the Rook CSI default or the kernel StorageClass without a mount canary.

## Why Kernel Is The Default

FUSE mount processes run inside the CephFS CSI node-plugin container. If that container is OOM-killed, each affected `ceph-fuse` process dies and existing workload mounts return `Transport endpoint is not connected`. Recreating an application pod can then reproduce the same broken node-local mount.

Kernel CephFS mount state is owned by the host kernel instead of a `ceph-fuse` process. A CSI node-plugin restart therefore does not invalidate an established kernel mount. The larger plugin limit still protects workloads that intentionally use the FUSE compatibility class.

## New PVCs

Use the kernel class unless a tested compatibility requirement says otherwise:

```yaml
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: rook-cephfs
```

Use `rook-cephfs-fuse` only after documenting why the kernel client cannot be used.

## Existing Data Migration

A PVC's storage class is immutable. Never delete a data-bearing dynamic CephFS PVC merely to change its mounter: with a `Delete` reclaim policy, that can delete the CephFS subvolume.

For an existing subvolume:

1. Record the source PV's `rootPath`, `volumeHandle`, secret references, capacity, and claim UID.
2. Patch the source PV reclaim policy to `Retain`.
3. Create a static PV with `staticVolume: "true"`, the same `rootPath`, a new unique `volumeHandle`, `mounter: kernel`, and `persistentVolumeReclaimPolicy: Retain`.
4. Bind a new PVC explicitly to that static PV.
5. Mount the new PVC in a canary on every target node and prove read, write, hardlink, and remount behavior.
6. Switch workloads through GitOps and verify their mount type is `ceph`.
7. Remove the old PVC/PV objects only after no pod references them. Never delete the retained CephFS subvolume.

## Validation

```bash
kubectl -n rook-ceph get pods -l app=rook-ceph.cephfs.csi.ceph.com-nodeplugin -o wide
kubectl -n rook-ceph get cephfilesystem cephfs
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph fs status cephfs
kubectl -n <namespace> exec <pod> -- awk '$2 == "/data" { print }' /proc/mounts
```

For a kernel mount, `/proc/mounts` must report filesystem type `ceph`, not `fuse.ceph-fuse`.

Check CSI resource and restart history:

```bash
kubectl -n rook-ceph get pod -l app=rook-ceph.cephfs.csi.ceph.com-nodeplugin -o json \
  | jq '.items[] | {node: .spec.nodeName, plugin: (.status.containerStatuses[] | select(.name == "csi-cephfsplugin") | {restartCount, lastState}), limits: (.spec.containers[] | select(.name == "csi-cephfsplugin") | .resources)}'
```

Any `OOMKilled` termination is a platform incident. Identify FUSE consumers on that node before restarting the node plugin. Kernel-mounted workloads do not need to be recreated after a CSI-only restart.

References:

- [CephFS kernel client](https://docs.ceph.com/en/latest/cephfs/mount-using-kernel-driver/)
- [mount.ceph options](https://docs.ceph.com/en/latest/man/8/mount.ceph/)
- [Ceph CSI static PVCs](https://github.com/ceph/ceph-csi/blob/devel/docs/static-pvc.md)
