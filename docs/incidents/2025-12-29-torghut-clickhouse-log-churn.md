# Torghut ClickHouse log churn + etcd slow-apply (2025-12-28 PST)

## Summary
- Intermittent etcd "apply request took too long" warnings on kalmyk masters tied to host IO saturation.
- Root cause was ClickHouse system log churn (trace/text/metric logs + query profiling) creating constant merges on Longhorn volumes.
- fstrim was already disabled and not the cause.

## Impact
- No outage, but etcd read/write latency warnings and increased disk IO on Harvester host `altra`.

## Root cause
- ClickHouse logging defaults were too chatty for an idle cluster:
  - `logger` at `debug` and `text_log` at `trace`.
  - `metric_log`/`text_log` collect/flush every 1s; `trace_log`/`latency_log` enabled.
  - query profiler logging enabled.
- System log tables grew large (multi-GB) and merged continuously, driving Longhorn IO on `nvme1n1`.

## Fix
- Reduce ClickHouse logging verbosity and system log cadence.
- Disable high-volume system logs (trace/latency/query_metric) and query profiler logging.
- Truncate large system log tables to stop merges and reclaim space.
- Roll ClickHouse pods to pick up the config.

## Changes (GitOps)
- Manifest updates:
  - `argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml`
    - `config.d/zz-logger.xml`: set logger level to `warning`.
    - `config.d/zz-system-logs.xml`: set system log flush/collect to 60s; disable trace/latency/query_metric logs.
    - `users.d/zz-profile-logging.xml`: disable query profiler logging.

## Rollout (manual, GitOps deviation)
- **2025-12-28 21:50–21:52 PST**: applied updated CHI manifest directly to the cluster to immediately reduce IO churn.
- Rolled ClickHouse statefulsets:
  - `chi-torghut-clickhouse-default-0-0`
  - `chi-torghut-clickhouse-default-0-1`
- Truncated system log tables:
  - `system.trace_log`, `system.text_log`, `system.metric_log`, `system.asynchronous_metric_log`, `system.latency_log`

## Verification (PST)
- ClickHouse pods restarted cleanly by 2025-12-28 21:52 PST.
- System log tables returned no active parts after truncation.
- etcd slow-apply counts (last 30m after rollout):
  - kube-master-00: 3 (last warning 2025-12-28 21:46:13 PST)
  - kube-master-01: 2 (last warning 2025-12-28 21:45:54 PST)
  - kube-master-02: 14 (last warning 2025-12-28 21:46:04 PST)
- Host IO snapshot on `altra` (2025-12-28 21:52 PST): `nvme1n1` still busy (w/s ~3.5–4.2k, ~85–108 MB/s, ~83–84% util). Continue monitoring.

## Follow-ups
- Merge PR and sync ArgoCD `torghut` to remove OutOfSync state.
- Re-check etcd slow-apply counts over the next few hours to confirm sustained reduction.
- If IO remains high, profile other Longhorn volumes for heavy writers.
