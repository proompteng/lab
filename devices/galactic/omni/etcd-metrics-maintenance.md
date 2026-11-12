# Galactic etcd disk metrics maintenance proposal

**Status: staged and unapplied.** The adjacent [patch](etcd-loopback-metrics.patch.yaml) is not referenced by
`cluster-template.yaml`. This proposal changes no active Talos or Alloy configuration and does not establish metrics
coverage. Preserve it on the reviewed holding branch until an authorized administrator schedules the maintenance.

## Evidence and intended collection path

At `2026-11-12T17:12:30.858233Z`, successful queries to the existing anonymous Mimir tenant returned no WAL-fsync or
backend-commit histogram series for any of the three members, including both 5-minute and 15-minute windows.
Observation counts, reset counts and percentiles were unavailable, not zero. Slow-fsync log entries cannot establish
the actual p99.

The [deployed acceptance record](../releases/talos-v1.14.5-acceptance.md) identifies Talos 1.14.5 and etcd 3.7.3. Live,
allowlisted command-line reads found an HTTPS client-HTTP listener on port 2383 with client-certificate authentication
and TLS 1.3 on every member, but no `listen-metrics-urls`. Both declared and live Alloy configurations lacked an etcd
scrape. The existing collectors have no etcd client credentials; do not copy or mount administrative credentials to
fill this gap.

The proposed endpoint is **`http://127.0.0.1:2381` only**. In the pinned etcd implementation, `ListenMetricsUrls` creates
a separate HTTP mux for metrics and health, without the KV API or gRPC gateway. Talos accepts this extra argument
without changing its managed client listeners, certificates or authentication. Loopback still permits local host
processes to read these metrics; this is not a new network-facing endpoint.

Primary versioned references:

- [Talos 1.14.5 etcd service and extra-argument handling](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/system/services/etcd.go)
- [Talos 1.14.5 `EtcdClientHTTPPort` constant](https://pkg.go.dev/github.com/siderolabs/talos/pkg/machinery@v1.14.5/constants#EtcdClientHTTPPort)
- [etcd 3.7.3 `createMetricsListener` and `serveMetrics`](https://github.com/etcd-io/etcd/blob/v3.7.3/server/embed/etcd.go#L849-L905)
- [etcd 3.7 metrics-listener configuration](https://etcd.io/docs/v3.7/op-guide/configuration/#profiling-and-monitoring)
- [etcd 3.7 monitoring guidance](https://etcd.io/docs/v3.7/op-guide/monitoring/)

## Preconditions and one-member maintenance sequence

The available investigation transport has Reader authority. Node configuration changes require the existing authorized
administrative Omni maintenance path; this document does not grant that capability or authorize an immediate apply.

1. Record a current, verified recoverable **etcd** backup/snapshot and its recovery procedure. Confirm all three voters
   are healthy, caught up and alarm-free, the API passes consistent reads, and Ceph has healthy monitor quorum. Require
   no missing/unhealthy voter, failing consistent API reads, concurrent upgrade/configuration operation or unrecovered
   rollout. Record existing WAL/apply latency and storage behavior as the maintenance baseline. A Bayn database backup
   does not substitute for an etcd recovery point. Preserve active workspace/session recovery requirements from the existing
   [Omni ownership and rollout instructions](README.md).
2. Review the exact current machine identities, leader and desired/live configuration. Select one member using the
   existing maintenance procedure; handle leadership through that procedure if necessary. Never reconfigure two etcd
   members simultaneously. `upgradeStrategy.maxParallelism: 1` alone does not prove arbitrary configuration updates
   will be serialized.
3. In a separately reviewed source change, add only `cluster.etcd.extraArgs.listen-metrics-urls` from the staged patch
   to that selected Machine's desired configuration. Preserve `quota-backend-bytes: '4294967296'` and every other
   setting. Use the README's secure live-export/render/validate workflow with mode-`0600` temporary files. Never sync
   the checked-in secret-redacted template directly or print credentials in receipts.
4. Require the normal Omni dry-run to show **only the selected Machine's new argument**. No version, installer,
   extension, disk, membership, network, certificate, quota or other machine changes may accompany it. Apply only
   through that reviewed administrative path. An etcd service restart may be required; do not add a manual restart or
   reboot. Stop if the plan requires a broader lifecycle operation than the approved maintenance.
5. Observe the affected member until its original identity is healthy and caught up, all three voters and quorum are
   healthy again, consistent API reads pass, and latency/storage behavior shows no material deterioration from the
   recorded baseline. Abort on loss of member, API, quorum or storage health. Confirm the listener binds only loopback.
   From the existing authorized host-network Alloy transport, make a bounded read of
   `/metrics` with a 5-second deadline and 1 MiB response cap, retaining only the two histogram families and counts.
   No TLS bypass, new host mount, credential access or network-policy exception is needed. If that transport is not
   available, stop and arrange an approved read path instead of weakening access controls.
6. Record the exact source/configuration version, member identity, listener, histogram presence and recovery interval.
   **Do not proceed to another member until all three are healthy.** Stop on health loss or material deterioration from
   the recorded baseline. Repeat the reviewed single-Machine change for each remaining member, rechecking the backup
   and preconditions before every apply.

## Deferred collector change

Only after all three loopback endpoints are proven should a separate reviewed GitOps change add the following blocks
to `argocd/applications/rook-ceph/host-metrics-alloy-config.river`. Do not enable this scrape while the listeners are
absent. The existing `host-metrics-alloy-daemonset.yaml` already uses host networking, non-root UID 473, read-only host
mounts and no service-account token. Preserve its placement, resources, security and rolling availability settings.

The current `storage` metric allowlist admits node metrics only. Use a separate narrow allowlist and the existing
Mimir receiver, retaining the existing storage pipeline unchanged:

```alloy
prometheus.relabel "etcd_disk" {
  forward_to = [prometheus.remote_write.mimir.receiver]

  rule {
    action        = "keep"
    source_labels = ["__name__"]
    regex         = "up|etcd_disk_(wal_fsync|backend_commit)_duration_seconds_(bucket|sum|count)"
  }
}

prometheus.scrape "etcd_disk" {
  job_name = "etcd"
  targets = [{
    "__address__" = "127.0.0.1:2381",
    "node"        = sys.env("NODE_NAME"),
    "instance"    = sys.env("NODE_NAME"),
  }]
  scrape_interval = "30s"
  scrape_timeout  = "5s"
  forward_to      = [prometheus.relabel.etcd_disk.receiver]
}
```

Validate the future River change with the pinned Alloy toolchain and normal repository checks before deployment.
Confirm it targets exactly the three existing control-plane host collectors; revisit discovery if node roles change.
This proposal does not modify the cluster-wide collector, remote-write tenant, TLS endpoints or any credential mount.

## Coverage and measurement acceptance

- Require `up{job="etcd"} == 1` for exactly `turin`, `talos-192-168-1-85` and `talos-192-168-1-194`, with distinct
  `node` and `instance` values. Both histogram families must expose `_bucket`, `_sum` and `_count`, with counts advancing.
- Wait for full 5-minute and 15-minute windows after the last listener/collector restart. At 30-second cadence, report
  actual sample coverage against approximately 10 and 30 scrapes respectively; expose missing or delayed scrapes.
- At one fixed evaluation timestamp, report per-member WAL and backend-commit p99, count increase, observation rate,
  scrape sample count, counter resets and latest sample age for both windows. For example:

```promql
histogram_quantile(0.99,
  sum by (node, le) (
    rate(etcd_disk_wal_fsync_duration_seconds_bucket{job="etcd"}[5m])
  )
)
increase(etcd_disk_wal_fsync_duration_seconds_count{job="etcd"}[5m])
rate(etcd_disk_wal_fsync_duration_seconds_count{job="etcd"}[5m])
count_over_time(etcd_disk_wal_fsync_duration_seconds_count{job="etcd"}[5m])
resets(etcd_disk_wal_fsync_duration_seconds_count{job="etcd"}[15m])
time() - timestamp(etcd_disk_wal_fsync_duration_seconds_count{job="etcd"})
```

Repeat for 15 minutes and `etcd_disk_backend_commit_duration_seconds`. Histogram quantiles are bucket estimates;
counter increases are extrapolated. Disclose resets, short windows and sparse observations. Missing series remain
unavailable and must never be represented as zero latency or zero resets. Establishing coverage alone does not pass
the existing disk-latency or sustained native-build qualification gates; this maintenance includes no benchmark or
extra build load.

## Rollback

Stop at the first failed member and preserve the remaining healthy quorum. If the collector was subsequently enabled,
revert only the two new Alloy blocks through normal GitOps, preserving existing collection and security settings.
Remove only the new `listen-metrics-urls` argument from the affected Machine's authoritative desired configuration;
do not replace the entire `extraArgs` map or restore an older whole-node configuration. Rerender securely, validate and
require an exact single-Machine dry-run through the same administrative path. Removing the listener may also restart
that member, so recover all three healthy voters before any further change. Preserve the quota, identity, TLS,
certificates, durable data and all unrelated configuration. Never force quorum, remove/rejoin a member, wipe storage,
compact data, weaken authentication or reboot blindly as part of this rollback.
