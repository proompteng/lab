# Rook-Ceph RBD Canary

Apply-on-demand assets for comparing the default kernel RBD path with the non-default
`rook-ceph-block-nbd-canary` StorageClass.

These resources are an explicit operator-diagnostic exception to normal Argo ownership. Verify the target context
before every command and keep the `rook-ceph-benchmarks` namespace explicit.

Bootstrap the namespace, script, and PVCs:

```bash
kubectl --context galactic-lan -n rook-ceph-benchmarks apply -k kubernetes/rook-ceph-rbd-canary
```

Run the default RBD job:

```bash
kubectl --context galactic-lan -n rook-ceph-benchmarks apply \
  -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block.yaml
kubectl --context galactic-lan -n rook-ceph-benchmarks logs -f job/rook-ceph-block-benchmark
```

Run the NBD canary job:

```bash
kubectl --context galactic-lan -n rook-ceph-benchmarks apply \
  -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block-nbd-canary.yaml
kubectl --context galactic-lan -n rook-ceph-benchmarks logs -f job/rook-ceph-block-nbd-canary-benchmark
```

Run the NBD remount/readback job after the NBD canary job has completed:

```bash
kubectl --context galactic-lan -n rook-ceph-benchmarks apply \
  -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block-nbd-canary-remount.yaml
kubectl --context galactic-lan -n rook-ceph-benchmarks logs -f job/rook-ceph-block-nbd-canary-remount
```

The full workflow and gates live in
`docs/runbooks/rook-ceph-client-ops-performance.md`.
