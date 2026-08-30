# Rook-Ceph RWX Benchmarks

This directory contains apply-on-demand manifests for benchmarking the live RWX-capable storage classes:

1. `rook-cephfs-fuse`
1. `rook-cephfs`

Bootstrap shared resources:

```bash
kubectl apply -k kubernetes/rook-ceph-rwx-benchmarks
```

Run the FUSE job:

```bash
kubectl apply -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-fuse.yaml
```

Run the kernel job only on nodes labeled `storage.proompteng.ai/cephfs-kernel-client=true`:

```bash
kubectl apply -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-kernel.yaml
```

The full workflow, evidence capture commands, and decision gates are documented in `docs/runbooks/rook-ceph-rwx-performance.md`.
