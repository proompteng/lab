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

## Non-Network Performance Pass

The 2026-07-06 non-network performance pass keeps the existing NICs and network topology. It does not require a
Talos OS upgrade, host-network migration, Multus, or a new storage subnet.

Stage 1 GitOps target:

1. Persist `rbd_default_map_options=ms_mode=prefer-crc`.
1. Persist the mgr balancer module in `upmap` mode, not `upmap-read`.
1. Keep the default RBD class on KRBD; keep `rook-ceph-block-nbd-canary` non-default.
1. Add `mountOptions: [noatime]` to RBD StorageClasses.
1. Mark the hot data pools as bulk and pin them at `128` PGs:
   - `replicapool`
   - `cephfs-data0`
   - `objectstore.rgw.buckets.data`

Do not combine Stage 1 with an image rollout while the PG split is remapping. The patch upgrade remains justified,
but it is Stage 2:

1. Wait until `ceph -s` reports `HEALTH_OK`, zero misplaced objects, zero remapped PGs, and no
   `active+remapped+backfilling` or `active+remapped+backfill_wait` PGs.
1. Upgrade the Rook charts and operator image from `v1.19.5` to `v1.19.7`.
1. Upgrade the Ceph image from `v19.2.3` to `v19.2.4`.
1. Let Argo roll the patch upgrade and verify `ceph versions`, operator image, CSI pods, and app smoke checks.

Live pool tuning applied on 2026-07-06:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set replicapool bulk true
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set cephfs-data0 bulk true
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set objectstore.rgw.buckets.data pg_num_min 128
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set replicapool pg_num_min 128
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool set cephfs-data0 pg_num_min 128
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph balancer mode upmap
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set global rbd_default_map_options ms_mode=prefer-crc
```

The first `pg_num_min` attempts for `replicapool` and `cephfs-data0` failed while those pools were still at
`pg_num=32`; Ceph does not allow `pg_num_min` to exceed current `pg_num`. Setting `bulk=true` gave the autoscaler
the correct signal, and it raised both pools to `pg_num=128`; after that, `pg_num_min=128` was valid and was pinned.

The expected temporary side effect is remap/backfill while the PG split completes. Do not run final fio or OSD bench
proof while any of these are non-zero:

```text
misplaced objects
active+remapped+backfilling
active+remapped+backfill_wait
```

Rerun IOPS and fio only after:

```text
ceph -s: HEALTH_OK
0 misplaced objects
0 remapped/backfilling/backfill_wait PGs
replicapool pg_num=128 pgp_num=128
cephfs-data0 pg_num=128 pgp_num=128
objectstore.rgw.buckets.data pg_num=128 pgp_num=128
```

## Temporary Recovery-Surge Mode

If the hot-pool PG split remains active for many hours, switch from client-biased QoS to recovery-biased QoS until
the split completes. This is temporary maintenance mode, not the final client-ops posture.

Durable GitOps settings for recovery surge:

```yaml
osd_mclock_profile: "high_recovery_ops"
osd_mclock_max_capacity_iops_hdd: "500"
osd_mclock_override_recovery_settings: "true"
osd_max_backfills: "3"
osd_recovery_max_active_hdd: "6"
osd_recovery_sleep_hdd: "0"
```

Live command equivalent:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_mclock_profile high_recovery_ops
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_mclock_max_capacity_iops_hdd 500
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_mclock_override_recovery_settings true
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_max_backfills 3
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_recovery_max_active_hdd 6
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_recovery_sleep_hdd 0
```

Why these knobs:

1. `high_recovery_ops` is Ceph's built-in mClock profile for prioritizing recovery and backfill over client ops.
1. `osd_mclock_max_capacity_iops_hdd=500` temporarily prevents the scheduler from under-modeling recovery capacity
   during the surge. The steady-state client setting remains `275`, based on local OSD bench samples.
1. With mClock active, Ceph resets or ignores legacy recovery/backfill concurrency changes unless
   `osd_mclock_override_recovery_settings=true`.
1. `osd_max_backfills=3` is a bounded surge value that increases per-OSD backfill reservations beyond the default
   `1` without using unbounded concurrency.
1. `osd_recovery_max_active_hdd=6` doubles the HDD active recovery limit from the default `3`.
1. `osd_recovery_sleep_hdd=0` removes the default HDD sleep between recovery/backfill operations for the
   maintenance window.

Monitor every 30-60 seconds:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd perf
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd pool ls detail | \
  rg 'replicapool|cephfs-data0|objectstore.rgw.buckets.data'
```

Rollback the surge immediately if OSDs start flapping, client mounts fail, or BlueStore slow ops expand beyond a
single known OSD:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_mclock_profile high_client_ops
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config set osd osd_mclock_max_capacity_iops_hdd 275
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config rm osd osd_mclock_override_recovery_settings
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config rm osd osd_max_backfills
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config rm osd osd_recovery_max_active_hdd
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config rm osd osd_recovery_sleep_hdd
```

After `ceph -s` reports zero misplaced objects and zero remapped/backfilling/backfill-wait PGs, restore client mode
in GitOps:

```yaml
osd_mclock_profile: "high_client_ops"
osd_mclock_max_capacity_iops_hdd: "275"
```

Remove the recovery override keys from GitOps at the same time:

```yaml
osd_mclock_override_recovery_settings
osd_max_backfills
osd_recovery_max_active_hdd
osd_recovery_sleep_hdd
```

Benchmark sequence after clean:

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph tell 'osd.*' bench
kubectl apply -k kubernetes/rook-ceph-rbd-canary
kubectl apply -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block.yaml
kubectl apply -f kubernetes/rook-ceph-rbd-canary/job-rook-ceph-block-nbd-canary.yaml
kubectl apply -k kubernetes/rook-ceph-rwx-benchmarks
kubectl apply -f kubernetes/rook-ceph-rwx-benchmarks/job-rook-cephfs-fuse.yaml
```

Do not roll the Ceph image upgrade while the PG split is still remapping unless there is an urgent security or data
integrity reason. Let the hot-pool PG split settle first, then roll the Rook/Ceph patch upgrade through Argo as a
separate change.

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
