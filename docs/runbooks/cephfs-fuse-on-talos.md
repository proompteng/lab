# CephFS (FUSE) On Talos

This cluster runs Kubernetes on Talos Linux. Talos does not ship the in-kernel CephFS client module, so CephFS mounts must use the FUSE mounter.

This runbook documents:

- How we configure Rook-Ceph / Ceph-CSI for CephFS FUSE on Talos.
- How to migrate an existing CephFS PVC to the FUSE storage class.

## Why FUSE

If the CephFS kernel module (`ceph`) is not present on nodes, CephFS CSI mounts that rely on the in-kernel client will fail (pods stuck in `ContainerCreating` with mount errors). Using the CephFS FUSE mounter avoids needing the kernel module.

## Cluster Configuration (GitOps)

1. Rook-Ceph operator chart values force CephFS kernel client off:

- File: `argocd/applications/rook-ceph/operator-values.yaml`
- Key: `csi.forceCephFSKernelClient: "false"`

Note: this is quoted as a string so Helm renders `CSI_FORCE_CEPHFS_KERNEL_CLIENT: "false"`. Helm `with` blocks skip boolean `false`.

2. A CephFS FUSE `StorageClass` exists:

- File: `argocd/applications/rook-ceph/storageclasses.yaml`
- Name: `rook-cephfs-fuse`
- Key parameter: `parameters.mounter: fuse`

## Using CephFS FUSE In Apps

Set PVCs to use:

- `storageClassName: rook-cephfs-fuse`

Example:

```yaml
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: rook-cephfs-fuse
```

## Migrating Existing PVCs (Wipe/Recreate)

Ceph-CSI-backed PVCs cannot change `storageClassName` in-place. If a PVC was created with the wrong CephFS storage class, you must delete and recreate it.

This process is destructive: deleting the PVC deletes the CephFS subvolume, and the data is not recovered from other “members”.

1. Identify the workloads using the PVC:

```bash
kubectl -n <ns> get pods -o wide
kubectl -n <ns> describe pod <pod>
```

2. Scale down / delete workloads that mount the PVC.

3. Delete the PVC and wait for the PV to be removed:

```bash
kubectl -n <ns> delete pvc <pvc-name>
kubectl get pv | rg <pvc-name> -n || true
```

If the PV remains in `Terminating`, check for finalizers and confirm no pods still reference it.

4. Recreate the PVC via GitOps:

- Ensure the PVC manifest in the repo uses `storageClassName: rook-cephfs-fuse`.
- Sync the owning Argo CD application.

5. Verify the new PVC is bound to `rook-cephfs-fuse`:

```bash
kubectl -n <ns> get pvc <pvc-name> -o wide
kubectl -n <ns> get pvc <pvc-name> -o yaml | rg storageClassName -n
```

## Validation

1. Confirm Rook-Ceph is healthy:

```bash
argocd app get rook-ceph
kubectl -n rook-ceph get pods
```

2. Confirm a pod mounting the PVC starts successfully (no CephFS mount errors) and that the app becomes `Healthy` in Argo CD.

