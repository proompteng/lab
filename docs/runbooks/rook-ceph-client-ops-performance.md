# Rook-Ceph Client-Ops Performance

This runbook is the staged client-ops performance plan for the live `galactic` Rook-Ceph cluster.
It is intentionally conservative: do the safe RBD and mClock work now, and do not enable read-primary balancing
until the client compatibility gate is clean.

## Current State

Live evidence captured on 2026-07-06:

1. `ceph -s` reported `HEALTH_OK`, `6 up / 6 in` OSDs, and `409 active+clean` PGs.
1. `ceph balancer status --format json` reported `active=true`, `mode=upmap`, and no current upmap optimization plan.
1. `ceph osd pool ls detail` showed high `read_balance_score` values, including `replicapool=1.50`,
   `objectstore.rgw.buckets.index=3.00`, `cephfs-metadata=1.88`, and `cephfs-data0=1.88`.
1. `ceph features` still showed three `client.csi-rbd-node` sessions at release `luminous`.
1. `ceph osd get-require-min-compat-client` reported `luminous`.
1. `ceph config dump` showed live per-OSD `osd_mclock_max_capacity_iops_hdd=1000` overrides, which were not in GitOps.

That means read-primary balancing is a real performance opportunity, but it is not safe to enable yet.

## Source Basis

1. Ceph read balancer documentation: `read_balance_score > 1` means primary reads are imbalanced, but
   `read` and `upmap-read` use `pg-upmap-primary` and require no pre-Reef clients.
   <https://docs.ceph.com/en/latest/rados/operations/read-balancer/>
1. Ceph balancer documentation: `upmap-read` combines capacity upmap balancing and read-primary balancing;
   `target_max_misplaced_ratio=0.03` is a conservative convergence setting, and
   `mgr/balancer/upmap_max_deviation=1` is described as reasonable and safe for most clusters.
   <https://docs.ceph.com/en/latest/rados/operations/balancer/>
1. Ceph mClock documentation: `high_client_ops` is a built-in profile, and
   `osd_mclock_max_capacity_iops_hdd` models 4 KiB random-write IOPS capacity for rotational media.
   <https://docs.ceph.com/en/latest/rados/configuration/mclock-config-ref/>
1. Rook block storage documentation and local Rook examples support setting `mounter: rbd-nbd` in an RBD
   `StorageClass`.
   <https://rook.io/docs/rook/latest-release/Storage-Configuration/Block-Storage-RBD/block-storage/>
1. Local Rook source under `~/github.com/rook` shows `balancerMode` supports `upmap-read`, but Rook sets
   `set-require-min-compat-client reef` for `read` or `upmap-read`. Do not configure those modes while
   luminous clients are connected.

## Safe Changes Applied

1. Keep `osd_mclock_profile=high_client_ops`.
1. Set `osd_mclock_max_capacity_iops_hdd=275` in GitOps.
1. Keep `osd_mclock_max_sequential_bandwidth_hdd=285212672`.
1. Keep `osd_memory_target=8589934592`.
1. Keep CSI read affinity enabled by `kubernetes.io/hostname`.
1. Set conservative manager balancer convergence keys:
   - `target_max_misplaced_ratio=0.03`
   - `mgr/balancer/upmap_max_deviation=1`
1. Add non-default `rook-ceph-block-nbd-canary`.
1. Leave default `rook-ceph-block` unchanged.
1. Leave live balancer mode at `upmap`, not `upmap-read`.

The `275` IOPS value comes from two fresh `ceph tell osd.* bench` passes on 2026-07-06:

| OSD | Run 1 IOPS | Run 2 IOPS |
| --- | ---: | ---: |
| osd.0 | 277.79 | 265.35 |
| osd.1 | 257.05 | 218.57 |
| osd.2 | 297.34 | 297.85 |
| osd.3 | 249.30 | 259.06 |
| osd.4 | 304.64 | 297.37 |
| osd.5 | 282.49 | 284.30 |

The full-sample median is about 280 IOPS. GitOps uses `275` to stay slightly conservative.

## Live Drift Cleanup

If live config still has per-OSD `1000` overrides, they mask the GitOps cluster-wide value. Remove them after the
GitOps change is merged or during the same maintenance window:

```bash
for osd in 0 1 2 3 4 5; do
  kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
    ceph config rm "osd.${osd}" osd_mclock_max_capacity_iops_hdd
done

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config set osd osd_mclock_max_capacity_iops_hdd 275

kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config dump | rg 'mclock_max_capacity|mclock_profile|target_max_misplaced|upmap_max_deviation'
```

Acceptance:

1. No `osd.N osd_mclock_max_capacity_iops_hdd 1000` rows remain.
1. One `osd osd_mclock_max_capacity_iops_hdd 275` row exists.
1. `ceph -s` remains `HEALTH_OK`.

## RBD-NBD Canary

`rook-ceph-block-nbd-canary` is non-default and must only be used for disposable proof:

1. fio PVCs.
1. Rebuildable caches.
1. One low-risk workload after fio passes.

Do not move production databases, Kafka, ClickHouse, registry canonical data, or Torghut durable state to the canary
class.

Apply the benchmark assets on demand:

```bash
kubectl apply -k kubernetes/rook-ceph-rbd-canary
kubectl apply -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block.yaml
kubectl apply -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block-nbd-canary.yaml
```

Capture results:

```bash
kubectl -n rook-ceph-benchmarks logs -f job/rook-ceph-block-benchmark
kubectl -n rook-ceph-benchmarks logs -f job/rook-ceph-block-nbd-canary-benchmark
kubectl -n rook-ceph-benchmarks get pods -o wide
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf
```

Restart/remount proof for the canary class:

```bash
kubectl apply -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block-nbd-canary-remount.yaml
kubectl -n rook-ceph-benchmarks logs -f job/rook-ceph-block-nbd-canary-remount
```

The canary passes only if the pod mounts, fio completes, the pod can be recreated, data can be read back, and
`ceph -s` remains healthy.

The first live run on 2026-07-06 passed mount/fio/readback for both classes. Default KRBD was faster than the NBD
canary in that sample, so the default class remains unchanged:

| StorageClass | Randread IOPS | Randread p95 | Mixed read/write IOPS | Seq write BW |
| --- | ---: | ---: | ---: | ---: |
| `rook-ceph-block` | 76.57 | 115.9 ms | 34.85 / 15.64 | 7.28 MB/s |
| `rook-ceph-block-nbd-canary` | 63.38 | 132.6 ms | 24.73 / 11.08 | 7.26 MB/s |

## Read-Primary Balancer Gate

Do not enable `upmap-read` until this command reports no pre-Reef clients:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph features
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph tell mon.* sessions --format json
```

When the luminous clients are gone:

1. Confirm the connected clients are Reef or newer.
1. Confirm no kernel client path still depends on unsupported `pg-upmap-primary` mappings.
1. Set `ceph osd set-require-min-compat-client reef --yes-i-really-mean-it`.
1. Change the Rook mgr balancer module to `balancerMode: upmap-read`.
1. Let Rook reconcile.
1. Verify:
   - `ceph osd get-require-min-compat-client` is `reef`.
   - `ceph balancer status` reports `mode=upmap-read`.
   - `ceph osd dump | rg pg_upmap_primary` shows mappings only after the gate is accepted.
   - hot-pool `read_balance_score` values improve toward `<=1.25`.
   - RBD and CephFS mounts still work.

Rollback if kernel or CSI mounts fail:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph balancer mode upmap
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd rm-pg-upmap-primary-all
```

Do not lower min compat after it has been raised for a feature rollout.

## Validation Checklist

Before merge:

```bash
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/rook-ceph >/tmp/rook-ceph.render.yaml
bun run lint:argocd
```

After sync:

```bash
kubectl get storageclass rook-ceph-block rook-ceph-block-nbd-canary
kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\n"}{end}'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config dump | rg 'mclock_max_capacity|mclock_profile|target_max_misplaced|upmap_max_deviation'
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph balancer status --format json
```

The default class must remain `rook-ceph-block`. The canary class must not be default.
