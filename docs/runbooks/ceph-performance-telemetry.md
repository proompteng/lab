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

## Diagnose the bottleneck

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

Correlate `node` with `ceph osd metadata` before attributing an OSD to an HDD or its shared NVMe DB device.
Do not infer per-application latency from a shared OSD metric. Existing pod-level RBD I/O series identify noisy
clients; application histograms or a separately authorized disposable-PVC benchmark establish application tails.

## Remove stale recovery overrides

Ceph's monitor configuration database is persistent. Removing an entry from GitOps is not proof that an old live
override has disappeared. The normal source configuration deliberately omits the five keys below. The mClock
profile remains `high_client_ops`, with the measured per-OSD IOPS values unchanged.

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

The scrub window remains 08:00-12:00 UTC with `osd_max_scrubs=1`. mClock disables `osd_scrub_sleep`, so retaining
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
