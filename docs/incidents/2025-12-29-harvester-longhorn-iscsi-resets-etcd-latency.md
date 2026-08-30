# 2025-12-29 Harvester Longhorn iSCSI Resets -> etcd Slow Apply

## Summary

The K3s control planes reported repeated etcd slow-apply warnings. The root cause was **iSCSI session resets on the Harvester host `altra`**, which dropped the **Longhorn-backed root volumes** for all three masters. That caused transient block device errors and etcd stalls across the control plane.

## Scope / Environment

- Harvester host: `altra` (192.168.1.85), single-node Harvester
- K3s control planes (VMs): 192.168.1.150, 192.168.1.151, 192.168.1.152
- Storage: Longhorn on `altra` using iSCSI
- Timezone: **PST** (UTC-8)

## Evidence (PST)

### iSCSI session resets on `altra`

From `iscsid` logs on `altra`:

- **Dec 27 15:10:50 PST** — mass **NOP timeouts** across iSCSI connections, followed by recovery.
- **Dec 27 16:51:55–16:52:07 PST** — multiple **Longhorn target shutdowns**, including master root volumes.

### Kernel I/O errors on iSCSI devices

From `journalctl -k` on `altra`:

- **Dec 27 16:52:05–16:52:06 PST** — **Buffer I/O errors** on Longhorn iSCSI devices (e.g., `sdi`, `sdo16`, `sdad`).

### etcd slow-apply across all masters

From `journalctl -u k3s` on control planes:

- **Dec 27 16:46:45 PST** — all three masters report **ReadIndex took too long** and **apply request took too long**.
- **Dec 27 16:54:25–16:55:33 PST** — raft publish timeouts and continued slow-apply warnings.

### Master root volumes affected

Longhorn volume mapping on `altra`:

- `pvc-928c70bb-e3b9-47d5-9bde-e0d05c29a6f0` -> `kube-master-00-root-2qcjn`
- `pvc-7a5ad083-1caa-4fee-9a12-043569536a00` -> `kube-master-01-root-52gqg`
- `pvc-397611d9-e598-48a3-a3d8-cc6b25ee4b85` -> `kube-master-02-root-t8xft`

Command to verify:

```bash
kubectl --kubeconfig ~/.kube/altra.yaml -n longhorn-system get volumes.longhorn.io pvc-928c70bb-e3b9-47d5-9bde-e0d05c29a6f0 -o yaml | rg -n "pvcName"
kubectl --kubeconfig ~/.kube/altra.yaml -n longhorn-system get volumes.longhorn.io pvc-7a5ad083-1caa-4fee-9a12-043569536a00 -o yaml | rg -n "pvcName"
kubectl --kubeconfig ~/.kube/altra.yaml -n longhorn-system get volumes.longhorn.io pvc-397611d9-e598-48a3-a3d8-cc6b25ee4b85 -o yaml | rg -n "pvcName"
```

## Root Cause

**Longhorn iSCSI sessions on the Harvester host `altra` were flapping**, which reset the block devices backing the master root volumes. Those resets caused kernel I/O errors and stalled etcd apply/ReadIndex on all three control planes.

## Fix (GitOps)

### 1) Add a second Longhorn disk on `altra` (nvme0)

Manifest added to the Harvester templates directory:

- `tofu/harvester/templates/longhorn-altra-disk.yaml`

Apply:

```bash
kubectl --kubeconfig ~/.kube/altra.yaml apply -f tofu/harvester/templates/longhorn-altra-disk.yaml
```

This registers `/usr/local/longhorn-disk` (on `nvme0`) as an additional Longhorn disk
without pinning any volumes to a specific disk.

## Validation

After migration:

- `journalctl -k` on `altra` shows **no new iSCSI NOP timeouts** or **buffer I/O errors**.
- `journalctl -u k3s` on masters shows **no new slow-apply warnings** over a 30–60 minute window.
