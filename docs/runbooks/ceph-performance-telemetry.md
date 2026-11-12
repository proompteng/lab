# Ceph performance telemetry and steady-state cleanup

## Ownership and boundaries

The `observability` Argo application scrapes each `rook-ceph-exporter` pod, retaining node and OSD identity.
The `rook-ceph` application runs one `rook-ceph-host-metrics-alloy` pod per Linux node. Its embedded Unix
exporter reads only host `/proc` and `/sys`, scrapes over Alloy's in-memory transport, and remote-writes to the
existing Mimir gateway. Host networking is required for host NIC counters, but its HTTP listener is bound only
to `127.0.0.1:12346`. It has no Kubernetes token, privileged container, host PID access, or writable host mount.
No Service, ingress, namespace-policy change, or new RBAC grant is required.

Both collectors use the already deployed `grafana/alloy:v1.19.2` image. The host ConfigMap has a Kustomize content
hash; the central collector's existing SHA annotation must change when its River configuration changes.
All scraping is passive. This rollout does not change networking, replicas, PGs, client affinity, OSD memory,
per-OSD mClock calibration, the scrub window, or Ceph images. Do not restart OSDs to remove runtime config overrides.

## Live acceptance

After reviewed merge and automatic Argo reconciliation, verify both applications' exact revisions, not only health:

```sh
kubectl -n argocd get applications rook-ceph observability \
  -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision
kubectl -n rook-ceph rollout status daemonset/rook-ceph-host-metrics-alloy --timeout=180s
kubectl -n observability rollout status deployment/observability-cluster-metrics-alloy --timeout=180s
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

Query the existing Mimir tenant (`X-Scope-OrgID: anonymous`). At the current three-node/six-OSD topology,
require three healthy exporter targets, three healthy host targets, six OSD counter sets, and successful collectors.
Check sample timestamps and advancing counters; pod readiness alone does not prove ingestion.

```promql
count by (job) (up{job=~"ceph-exporter|node-storage"} == 1)
count(count by (ceph_daemon) (ceph_osd_op_latency_count{job="ceph-exporter"}))
min by (node, collector) (node_scrape_collector_success{job="node-storage"})
count by (node, device) (node_disk_io_time_seconds_total{job="node-storage"})
node_network_speed_bytes{job="node-storage"} * 8 / 1000000000
time() - timestamp(up{job=~"ceph-exporter|node-storage"})
```

Confirm `ceph-performance.rules` is loaded by the existing Mimir rule-loader, all rule health values are `ok`,
and its recording series are available after enough samples for `rate`. Inspect host-collector logs for remote-write
errors. `NodeStorageMetricsMissing` compares ingestion against Kubernetes' node inventory; `NodeStorageCollectorFailed`
also detects a successful HTTP scrape whose underlying collector failed. `CephOsdPerformanceMetricsMissing` compares
performance counters against the manager's inventory of up OSDs.

## Storage NIC hardware counters

The host collector refreshes ethtool hardware statistics every 30 seconds for Altra's `enp1s0f1np1`
and Turin's `ens1f1np1`. It retains aggregate physical packets/bytes, discards, receive-buffer starvation,
PAUSE frames, CRC/symbol errors, and queue error/recovery counters. Per-queue series are excluded.
The existing non-root collector needs no additional capabilities or permissions. On other nodes the
interface filter matches nothing; require actual series for both storage NICs as well as collector success.

mlx5's generic `node_network_receive_drop_total` can include stale cached physical-discard counts.
A hardware-statistics read refreshes that cache, so the initial refresh can produce a large generic-counter
jump. Establish a new baseline before using rates. Use the fresh hardware series to time physical loss;
do not interpret an initial generic-counter jump as a new loss burst. The exporter normalizes `rx` to
`received` and `tx` to `transmitted`; PHY counters retain their driver names without a `_total` suffix.

```promql
node_ethtool_info{job="node-storage"}
node_scrape_collector_success{job="node-storage",collector="ethtool"}
time() - timestamp(node_ethtool_received_discards_phy{job="node-storage"})
rate(node_ethtool_received_discards_phy{job="node-storage"}[5m])
rate(node_ethtool_received_out_of_buffer{job="node-storage"}[5m])
rate(node_ethtool_transmitted_pause_ctrl_phy{job="node-storage"}[5m])
```

Verify fresh timestamps and advancing PHY packet/byte counters for both interfaces in Mimir. Compare
bounded native GET-only ethtool snapshots against the exported counters, accounting for scrape timestamps.
Physical discards, out-of-buffer events and PAUSE frames measure different events; do not add them into
one packet-loss total. Check collector and remote-write errors after the content-hashed ConfigMap rollout.
If collection fails or needs broader permissions, revert the collector configuration through GitOps.
This telemetry change does not repair PCIe training or establish a client-latency improvement.

## Diagnose the bottleneck

### Investigate retained BlueStore slow-operation warnings

For `CephClusterHealthWarning`, start with `ceph health detail` and identify the affected OSD and check name.
`BLUESTORE_SLOW_OP_ALERT` retains slow-operation indications for `bluestore_slow_ops_warn_lifetime` seconds.
The current default is 86400 seconds, with a threshold of one indication. Read both effective values before
interpreting an alert's age. A retained warning can outlast the slow operation by a day.
See [Ceph's health-check reference](https://docs.ceph.com/en/umbrella/rados/operations/health-checks/#bluestore-slow-op-alert).

For an affected `osd.0`, run these read-only commands. Replace the OSD ID with the one reported by health detail.

```sh
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph health detail
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph config get osd.0 bluestore_slow_ops_warn_lifetime
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph config get osd.0 bluestore_slow_ops_warn_threshold
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph tell osd.0 dump_ops_in_flight
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph tell osd.0 dump_scrub_reservations
kubectl --context galactic-tailscale -n rook-ceph exec deploy/rook-ceph-tools -- ceph osd metadata 0 -f json
```

Read the affected pod's `/var/log/ceph/ceph-osd.0.log` and rotated `.gz` files.
Container stdout can omit an older event after rotation. Use `zgrep` for `slow operation observed` and `slow aio`,
then sort by the log timestamp. Record the last event's function, duration, and I/O count.
`ceph healthcheck history ls` reports when a check was last observed active, not when the underlying operation occurred.
The manager's health metric timestamp also measures the scrape, so neither timestamp establishes a new slow operation.

Compare the event window with the OSD's client latency, scrub read bytes, host disk queue, and BlueFS fsync means below.
The four `ceph_bluestore_slow_*_count` counters identify some slow paths, but do not cover every BlueStore warning.
An empty `dump_ops_in_flight` or a zero commit-latency snapshot does not exclude intermittent delays.
For completed client stalls, inspect `dump_historic_ops` and separate local commit time from replica acknowledgement time.

Use `bluestore_bdev_dev_node`, `bluefs_db_dev_node`, and `device_ids` from OSD metadata to locate the data and DB devices.
Resolve both device-mapper paths with `lsblk -s -o NAME,TYPE,ROTA` inside the affected OSD pod before reading SMART data.
Run `smartctl -a -j` against each verified parent device and compare error counters with an earlier sample.
HDD data with an NVMe DB still requires HDD reads during deep scrub. Healthy NVMe latency does not prove healthy data reads.
A passing SMART summary does not exclude a storage fault. Check media errors, pending sectors, timeouts, link errors,
temperature, and kernel errors alongside the latency evidence.

Keep detection thresholds, retention, integrity checks, and the committed scrub policy while investigating.
Before a scrub or mClock experiment, capture equal-duration client latency and scrub-progress baselines under representative load.
Change one setting through reviewed GitOps, verify its effective value, and require advancing deep-scrub completion timestamps.
Reject a candidate that worsens application deadlines or scrub debt, and restore the exact previous value through GitOps.
The previous single-object scrub-batch trial was reverted to the explicit five-object baseline in
[PR #15463](https://github.com/proompteng/lab/pull/15463). Review that evidence before repeating the same change.

### Metadata-device latency and scrub progress

Retain the native BlueFS SST/WAL write bytes, read bytes, log-compaction duration,
BlueStore transaction-throttle duration, and replicated-scrub read/intersection/blocked counters.
These counters are already exposed by the OSD exporters; their collection needs no OSD restart,
additional permissions, RocksDB tracing, or change to `osd_max_scrubs=3`.
The central Alloy allowlist retains 13 additional metric names, bounded by existing daemon identity.

```promql
ceph_storage:bluefs_sst_write_bytes_per_second:rate5m
ceph_storage:bluefs_wal_write_bytes_per_second:rate5m
ceph_storage:bluefs_read_bytes_per_second:rate5m
ceph_storage:bluefs_fsync_seconds:mean5m
ceph_storage:bluestore_throttle_seconds:mean5m
ceph_storage:osd_scrub_read_bytes_per_second:rate5m
ceph_storage:osd_scrub_blocked_ops_per_second:rate5m
```

Resolve each OSD's `block.db` through its actual device-mapper slaves before comparing its
BlueFS fsync and metadata-write rates with NVMe latency. Device names can change after reboot.
SST writes include both memtable flush and RocksDB compaction; they do not identify the cause alone.
BlueFS `compact_lat` and `compact_lock_lat` describe BlueFS **log** compaction, not RocksDB
SST compaction. Missing RocksDB statistics are not evidence of zero compaction.
The exporter labels cumulative latency sums as gauges; use their paired cumulative counts,
verify continuity, and exclude reset windows for literal first/last comparisons. Never interpret
these means as request percentiles or subtract unrelated latency populations.

Scrub read bytes include replica reads. Their cluster sum is not unique logical coverage, and a
successful-scrub counter can include shallow scrubs. Check PG deep-scrub completion timestamps
and reservation age independently. Zero direct scrub-blocked operations does not exclude shared
disk contention. Preserve normal useful workload and all integrity checks during comparisons.

After the configuration-digest rollout, require fresh advancing series from all six OSDs in Mimir
and successful rule evaluation. Verify active byte counters rather than just `up`. Removing the
added allowlist alternatives and recording rules through GitOps rolls back this instrumentation;
it does not change Ceph scheduling or repair a hardware fault.

The objectstore gateways use Beast with `tcp_nodelay=1` through `gateway.rgwCommandFlags.rgw_frontends` in
`argocd/applications/rook-ceph/cluster-values.yaml`. The explicit frontend retains Rook's existing container port
8080 behind Service port 80; update that override when changing gateway listeners. Ceph's
[frontend option](https://docs.ceph.com/en/tentacle/radosgw/frontends/#tcp-nodelay) disables Nagle's packet batching.
Compare exact-byte S3 readback's response-header and body-completion times before and after rollout. A short successful
read does not qualify sustained original capture capacity or resolve slow backend PUT acknowledgement. Preserve the
native write deadline and unknown-outcome handling. Rook rolls the two gateways one at a time; verify both effective
frontend arguments, ready endpoints, existing client writes and fresh telemetry before accepting the change.

The recording rules use seconds, ratios, and queue depth, not milliseconds or percentages. Useful queries are:

```promql
ceph_storage:osd_read_latency_seconds:mean5m * 1000
ceph_storage:osd_write_latency_seconds:mean5m * 1000
ceph_storage:osd_queue_wait_seconds:estimated_mean5m * 1000
ceph_storage:bluefs_fsync_seconds:mean5m * 1000
ceph_storage:bluestore_kv_sync_seconds:mean5m * 1000
ceph_storage:host_disk_read_seconds:mean5m * 1000
ceph_storage:host_disk_write_seconds:mean5m * 1000
ceph_storage:host_disk_busy_ratio:rate5m
ceph_storage:host_disk_queue_depth:mean5m
ceph_storage:host_network_receive_ratio:rate5m
ceph_storage:host_network_transmit_ratio:rate5m
rate(node_network_receive_drop_total{job="node-storage"}[5m])
rate(node_network_transmit_drop_total{job="node-storage"}[5m])
rate(node_pressure_io_stalled_seconds_total{job="node-storage"}[5m])
ceph_bluefs_slow_used_bytes{job="ceph-exporter",ceph_daemon=~"osd[.].+"}
```

These are counter-derived means, not individual-operation p95/p99 values. A percentile over a commit-latency gauge
is a percentile of sampled averages, not application tail latency. Queue wait is an estimate from total operation
latency minus processing latency; it is not a direct mClock histogram. Zero-operation denominators are filtered,
not clamped to one or rendered as zero. Network directions are separate because Ethernet is full duplex. Unknown
or negative link speeds produce no utilization ratio. Weighted disk I/O time estimates average outstanding work;
disk busy time alone does not establish saturation on a parallel NVMe device.

`CephHostReadLatencyHigh` fires when the highest OSD five-minute mean client read latency on a host stays above
500 ms for five minutes. One incident per node survives OSD rotation, and the annotation lists the currently slow
OSDs and their means. Per-OSD recording metrics retain diagnostic detail. The incident holds recovery for ten
minutes; a relapse during that hold continues the same incident. Its dedicated email route sends the first message
after ten seconds, batches group updates every fifteen minutes, and repeats unchanged incidents every four hours.
`CephClusterHealthError`, `CephSlowOps`, and `CephOsdCommitLatencyCritical` retain their general critical route.
`CephOsdQueueWaitHigh` warns when estimated mean queue wait stays above 100 ms for ten minutes and retains
node/OSD identity. Missing or idle reads
produce no latency estimate; use the existing exporter and OSD performance missing-data alerts for telemetry loss.
Compare reads and processing time with scrub work, mapped RBD activity, and host queues. A low commit-latency
gauge does not rule out delayed reads. These alerts do not authorize workload throttling or changing scrub policy.

Correlate `node` with `ceph osd metadata` before attributing an OSD to an HDD or its shared NVMe DB device.
Do not infer per-application latency from a shared OSD metric. The host agent retains kernel `rbd` device counters
alongside physical disks under `job="node-storage"`. These identify client-volume work after mapping the device to a PVC.
Resolve the PVC's PV and its CSI `volumeAttributes.imageName`, then match that image to the host's
`/sys/bus/rbd/devices/*/name` and `block/rbd*`. The agent's read-only sysfs mount exposes these paths under `/host/sys`.
Archive that mapping with a timestamp during each session and after a remount; `rbd` device numbers are temporary.
Keep client RBD and physical OSD disk measurements separate when calculating totals. Correlate the SQL trace's
backend PID and lifetime with PostgreSQL waits for a specific stall. Application histograms or a separately authorized
disposable-PVC benchmark establish application tails; block counters remain sampled storage context.

## Tengri replica-read comparison

The October 11, 2026 read-only probe compared client-local `localize`, `balance`, and `default` policies against
one retained Tengri home on Turin. Each pass read the same 48 seeded 4 KiB offsets with the librbd client cache
disabled and a 200-IOPS ceiling. Twenty-eight offsets contained nonzero data. The order was `localize`, `balance`,
`default`, then the reverse order. No image writes, Ceph configuration changes or workload limits were applied.

| Policy     | First pass mean / p95 | Reverse pass mean / p95 |
| ---------- | --------------------- | ----------------------- |
| `localize` | 773 / 2,986 ms        | 414 / 1,438 ms          |
| `balance`  | 122 / 619 ms          | 172 / 1,005 ms          |
| `default`  | 146 / 1,156 ms        | 146 / 752 ms            |

Localizing reads had worse tails in both orders. Server caches and concurrent workload activity were uncontrolled;
these small librbd samples do not establish the guest kernel RBD distribution or a reliable winner between balance
and default. The current CSI read-affinity setting appends localization after StorageClass map options, so adding
a StorageClass balance option alone would not change the effective mapping. Retain the existing policy until a
kernel-client comparison and a bounded adoption path are qualified. Do not disable read affinity cluster-wide
based on this probe.

Scrubs remained enabled during the comparison. Their marginal latency cost was not isolated, so this evidence does
not justify changing scrub concurrency or scheduler shares. Keep the shared Ceph workloads together and use the
read/queue metrics to qualify any later scheduler change.

## Remove stale recovery overrides

Ceph's monitor configuration database is persistent. Removing an entry from GitOps is not proof that an old live
override has disappeared. The normal source configuration deliberately omits the five keys below. The mClock
profile is `high_client_ops`, with the measured per-OSD IOPS values unchanged. Remove prior custom scheduler overrides
through the explicitly authorized profile-migration procedure, and preserve scrub concurrency documented in [the scrub catch-up posture](rook-ceph-on-talos.md#scrub-catch-up-posture).

Before the one-time authorized cleanup, save the relevant rows from `ceph config dump -f json` and each OSD's
effective configuration outside Git. Require `HEALTH_OK`, all OSDs up/in, and all PGs active+clean with no recovery,
backfill, remap, degraded, or misplaced work. Recheck immediately before mutation.

```sh
# Remove only the reviewed type-scoped entries, not arbitrary per-daemon settings.
for key in osd_max_backfills osd_recovery_max_active osd_recovery_max_active_hdd osd_scrub_sleep; do
  kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph config rm osd "$key"
done
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- \
  ceph config rm osd osd_mclock_override_recovery_settings
```

Verify those explicit rows are absent in `ceph config dump`. Then use `ceph config show osd.N -f json` for every
OSD, because effective configuration can differ from stored configuration. On Tentacle the expected effective
values are `osd_mclock_override_recovery_settings=false`, `osd_recovery_max_active=0`,
`osd_recovery_max_active_hdd=3`, `osd_max_backfills=1`, and `osd_scrub_sleep=0`.
The zero generic recovery value selects the media-specific defaults; it does not disable recovery.

Scrubs remain eligible all day with `osd_max_scrubs=3` to catch up with overdue deep scrubs. Compare scrub progress with
database WAL latency because concurrent scans share the HDDs. mClock disables `osd_scrub_sleep`, so retaining
`0.1` would misrepresent the effective behavior. Removing these overrides is configuration hygiene, not a claim of
measured throughput gain. Do not alter IOPS capacities without a separately controlled calibration.

If live health or client I/O regresses, stop and inspect the evidence. Restore only the saved keys/values that
caused the regression, enabling the recovery override flag before restoring custom concurrency. Do not change
replication, disable scrubbing, or downgrade Ceph as a rollback. Reverting the telemetry commit removes its
collectors and rules through Argo; it does not restore removed monitor-database overrides automatically.

## References

- https://docs.ceph.com/en/tentacle/mgr/prometheus/
- https://docs.ceph.com/en/tentacle/rados/configuration/mclock-config-ref/
- https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.unix/
