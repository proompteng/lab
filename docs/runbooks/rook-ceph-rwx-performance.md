# Rook-Ceph RWX Performance

This runbook covers only RWX-capable `StorageClass` objects in the live `galactic` cluster:

1. `rook-cephfs`
1. `rook-cephfs-fuse`

Non-RWX classes such as `rook-ceph-block` and non-POSIX paths such as `rook-ceph-bucket` are intentionally out of scope here.

## Decision Matrix

Use `rook-cephfs-fuse` when:

1. The workload requires shared POSIX semantics.
1. The workload must run on Talos nodes that do not ship the in-kernel CephFS client.
1. Compatibility matters more than peak throughput.

Use `rook-cephfs` when:

1. The workload requires shared POSIX semantics.
1. You have a worker pool with a working kernel CephFS client.
1. The workload is performance-sensitive enough that FUSE overhead matters.

Do not choose between the two classes based on anecdote. Run the same benchmark suite against both classes when a kernel-capable worker pool exists.

## Current Cluster Defaults

Current GitOps defaults are tuned for safe first-pass RWX investigations:

1. The Ceph mgr `stats` module is enabled so `ceph fs perf stats` is available.
1. The live `CephFilesystem` keeps `activeCount: 1` and `activeStandby: true`.
1. The MDS pods have explicit resources: requests `2 CPU / 8Gi`, limits `4 CPU / 16Gi`.
1. Both RWX classes set `mountOptions: [noatime]`.

These defaults do not remove the known topology ceiling:

1. OSD data still lives on HDDs on 2 storage hosts.
1. BlueStore DB/WAL is now offloaded to host-local NVMe on both OSD hosts:
   `nvme1n1` on `talos-192-168-1-85` and `nvme2n1` on `talos-192-168-1-203`.
1. The CephFS client path is still `ceph-fuse` on Talos.
1. `readAffinity` is still disabled.

## Benchmark Assets

Portable benchmark manifests live under:

1. `kubernetes/rook-ceph-rwx-benchmarks`

They are intentionally not part of normal Argo CD sync. Apply them only during an investigation window.

Bootstrap the benchmark namespace and PVCs:

```bash
kubectl apply -k kubernetes/rook-ceph-rwx-benchmarks
```

Run the FUSE benchmark job:

```bash
kubectl apply -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-fuse.yaml
kubectl -n rook-ceph-benchmarks logs -f job/rook-cephfs-fuse-benchmark
```

Run the kernel benchmark job only after labeling a kernel-capable worker pool:

```bash
kubectl label node <node-name> storage.proompteng.ai/cephfs-kernel-client=true
kubectl apply -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-kernel.yaml
kubectl -n rook-ceph-benchmarks logs -f job/rook-cephfs-kernel-benchmark
```

The benchmark suite includes:

1. `fio` large sequential write then read
1. `fio` small-block mixed random read/write
1. metadata create/stat/delete pressure

The metadata phase is a portable shell/Python harness. If you already maintain a curated `mdtest` image, prefer running that tool in the same namespace and on the same PVC for higher-fidelity metadata numbers.

## Evidence Capture

Capture this evidence for every benchmark window:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph mds stat
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph fs perf stats
kubectl -n rook-ceph top pod | rg 'mds|osd|mgr'
kubectl -n rook-ceph-benchmarks get pods -o wide
kubectl -n rook-ceph-benchmarks logs job/rook-cephfs-fuse-benchmark
```

If you are comparing kernel vs FUSE, collect the same evidence set for both runs and keep the dataset size, concurrency, and node placement unchanged.

## Recorded Baselines

### 2026-03-10 `rook-cephfs-fuse` benchmark history

Single-run values captured on the live cluster:

| Phase | Seq write | Seq read | 4k randrw read | 4k randrw write | Metadata create | Metadata stat | Metadata delete |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Before CephFS tuning | ~9.1 MiB/s | ~37.9 MiB/s | ~128 KiB/s | ~56 KiB/s | ~623 ops/s | ~3806 ops/s | ~1265 ops/s |
| After MDS `noatime` / stats tuning | ~6.2 MiB/s | ~29.0 MiB/s | ~177 KiB/s | ~78 KiB/s | ~839 ops/s | ~5050 ops/s | ~1788 ops/s |
| After BlueStore metadata migration | ~27.6 MiB/s | ~97.3 MiB/s | ~928 KiB/s | ~408 KiB/s | ~768 ops/s | ~5008 ops/s | ~1048 ops/s |

Interpretation:

1. The BlueStore metadata migration produced the largest gains in bulk sequential throughput and small-block mixed IO.
1. Metadata `stat` performance stayed near the post-MDS-tuning level.
1. Metadata `create`/`delete` numbers did not improve on this single run, so treat metadata-heavy gains as inconclusive until repeated runs confirm a median.
1. The cluster state around the post-BlueStore run was `HEALTH_OK`, `409 active+clean`, and all `6` OSDs were `up/in`.

## Decision Gates

If `rook-cephfs` materially outperforms `rook-cephfs-fuse`:

1. Keep FUSE as the compatibility class.
1. Migrate only the performance-sensitive RWX workloads to a kernel-capable worker pool.

If both RWX classes are slow and `ceph osd perf` stays high:

1. Prioritize fast metadata media on both storage hosts.
1. Move BlueStore metadata off HDD before increasing CephFS complexity.

If metadata-heavy phases are slow but sequential throughput is acceptable:

1. Keep `activeCount: 1` unless MDS saturation is proven.
1. Prioritize MDS CPU/memory, metadata media, and application file-layout changes.

If MDS CPU or cache pressure saturates before OSD latency:

1. Increase MDS resources further.
1. Consider multiple active MDS ranks only after you have stable benchmark baselines and a fast metadata tier.

## Cleanup

Delete benchmark jobs after each run:

```bash
kubectl -n rook-ceph-benchmarks delete job rook-cephfs-fuse-benchmark --ignore-not-found
kubectl -n rook-ceph-benchmarks delete job rook-cephfs-kernel-benchmark --ignore-not-found
```

Delete and recreate benchmark PVCs if you need a clean filesystem state:

```bash
kubectl -n rook-ceph-benchmarks delete pvc rook-cephfs-fuse-bench --ignore-not-found
kubectl -n rook-ceph-benchmarks delete pvc rook-cephfs-kernel-bench --ignore-not-found
kubectl apply -k kubernetes/rook-ceph-rwx-benchmarks
```
