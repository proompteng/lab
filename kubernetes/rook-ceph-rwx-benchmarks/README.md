# Rook-Ceph RWX Benchmarks

This directory contains apply-on-demand manifests for benchmarking the live RWX-capable storage classes:

1. `rook-cephfs-fuse`
1. `rook-cephfs`

These resources are an explicit operator-diagnostic exception to normal Argo ownership. Verify the target context
before every command and keep the `rook-ceph-benchmarks` namespace explicit.

Bootstrap shared resources:

```bash
kubectl --context galactic-lan -n rook-ceph-benchmarks apply -k kubernetes/rook-ceph-rwx-benchmarks
```

Run the FUSE job:

```bash
kubectl --context galactic-lan -n rook-ceph-benchmarks apply \
  -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-fuse.yaml
```

Run the kernel job only on nodes labeled `storage.proompteng.ai/cephfs-kernel-client=true`:

```bash
kubectl --context galactic-lan -n rook-ceph-benchmarks apply \
  -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-kernel.yaml
```

The full workflow, evidence capture commands, and decision gates are documented in `docs/runbooks/rook-ceph-rwx-performance.md`.
