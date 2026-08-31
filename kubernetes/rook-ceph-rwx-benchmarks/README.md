# Rook-Ceph RWX Benchmarks

This directory contains apply-on-demand manifests for benchmarking the live RWX-capable storage classes:

1. `rook-cephfs-fuse`
1. `rook-cephfs`

These resources are an explicit operator-diagnostic exception to normal Argo ownership. Select the authenticated
context once before running the commands below; use `galactic-tailscale` when operating off the LAN. Keep the
`rook-ceph-benchmarks` namespace explicit.

```bash
export GALACTIC_CONTEXT="${GALACTIC_CONTEXT:-galactic-lan}"
case "$GALACTIC_CONTEXT" in
  galactic-lan|galactic-tailscale) ;;
  *) echo "Unsupported GALACTIC_CONTEXT: $GALACTIC_CONTEXT" >&2; exit 2 ;;
esac
kubectl --context "$GALACTIC_CONTEXT" get nodes
```

Bootstrap shared resources:

```bash
kubectl --context "$GALACTIC_CONTEXT" -n rook-ceph-benchmarks apply -k kubernetes/rook-ceph-rwx-benchmarks
```

Run the FUSE job:

```bash
kubectl --context "$GALACTIC_CONTEXT" -n rook-ceph-benchmarks apply \
  -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-fuse.yaml
```

Run the kernel job only on nodes labeled `storage.proompteng.ai/cephfs-kernel-client=true`:

```bash
kubectl --context "$GALACTIC_CONTEXT" -n rook-ceph-benchmarks apply \
  -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-kernel.yaml
```

The full workflow, evidence capture commands, and decision gates are documented in `docs/runbooks/rook-ceph-rwx-performance.md`.
