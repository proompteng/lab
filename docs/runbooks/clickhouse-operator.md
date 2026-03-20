# Altinity ClickHouse Operator Runbook

## Overview

The Altinity ClickHouse Operator implements a Kubernetes-native control plane for ClickHouse workloads. We deploy version 0.25.4 through Argo CD using the upstream Helm chart (`altinity/altinity-clickhouse-operator`). The GitOps application lives at `argocd/applications/clickhouse-operator/`, and Helm overrides are centralized in `argocd/applications/clickhouse-operator/values.yaml`.

## Namespace & Access

- Operator namespace: `clickhouse-operator` (created automatically through the Argo CD `CreateNamespace=true` sync option).
- Service account: defined by the Helm chart; no custom RBAC overlays are required beyond the chart defaults.
- Secrets: the chart seeds an operator credential secret (`clickhouse-operator-altinity-clickhouse-operator`). Rotate the password via Helm values if cross-namespace authentication is required.

## Configuration Highlights

- Resources & reliability: the overrides request 250m CPU / 512Mi memory for the operator, and 100m CPU / 256Mi memory for the metrics exporter. A `PodDisruptionBudget` with `maxUnavailable: 0` protects the singleton deployment during voluntary disruptions.
- Watch scope: `WATCH_NAMESPACES` is left unset so the operator reconciles ClickHouse resources from any namespace. If you need to constrain scope later, set the env var (via Helm values) to a comma-separated list of prefixes or specific namespaces.
- Metrics: built-in Prometheus annotations expose metrics on ports `8888` (ClickHouse) and `9999` (operator). `serviceMonitor.enabled` is disabled by default because the lab cluster lacks the Prometheus Operator CRDs; enable it only after a compatible Prometheus/Alloy stack is ready to consume the ServiceMonitor.
- Templates: `values.yaml` packages baseline `ClickHouseInstallationTemplate` and `ClickHouseKeeperInstallationTemplate` definitions. They default to 2x ClickHouse replicas and 3x Keeper replicas with anti-affinity, tailoring resources for long-running analytics. Persistent volumes bind to the `rook-ceph-block` storage class by default; adjust if the target cluster uses a different provider. The ClickHouse template points at the bundled Keeper service `keeper-lab-default-keeper:2181` for embedded coordination.
- TODO markers must be resolved (storage classes) before enabling auto-sync.

## Creating ClickHouse Clusters

1. Copy the `lab-default-clickhouse` template into an application namespace (e.g., `analytics-clickhouse`) and adjust shard/replica counts, resources, and storage to fit the workload.
2. Deploy Keeper. Either:
   - Instantiate a `ClickHouseKeeperInstallation` from the bundled `lab-default-keeper` template (exposes service `keeper-lab-default-keeper:2181`, already referenced by the ClickHouse template), or
   - Point the ClickHouse template to an existing ZooKeeper-compatible service.
3. Store ClickHouse user secrets in the workload namespace; reference them within the `spec.secrets` section of the installation manifest.
4. Commit the new manifests under a dedicated GitOps path in `argocd/applications/` (e.g., `argocd/applications/analytics-clickhouse/`) so Argo CD manages lifecycle events. Avoid using the repository's `kubernetes/` directory for workload manifests.
5. Trigger an Argo sync for the workload namespace and monitor `kubectl -n <namespace> get pods` until all ClickHouse pods are `Ready`.

## Mandatory Log Tuning For New Clusters

This is not optional. Every new ClickHouse cluster in this repo must ship with explicit system-log limits on day one.

Why:

- ClickHouse system log tables are persisted on disk by default. They are not free just because they live under `system.*`.
- We have now hit the same failure mode in multiple clusters, including Torghut and PostHog: internal log tables consumed the PVC, background merges started failing, and application queries became the next visible victim.
- The Altinity operator is a thin delivery layer for ClickHouse config. It will mount what we tell it to mount, but it will not auto-tune retention, verbosity, or profiler-heavy log tables for us.

The required pattern is:

1. Deliver log tuning through `.spec.configuration.files` so the operator writes a `config.d/*.xml` override into the pod.
2. Prefer `config.d/99-logging-overrides.xml` or an app-specific equivalent such as `config.d/posthog-system-logs.xml`.
3. Keep the main image defaults intact and use ClickHouse merge semantics (`replace="1"` and `remove="1"`) to override only the sections we intend to own.
4. If the workload does not explicitly need profiler-derived system tables, disable them up front.

### First-Install Baseline

For a brand new cluster, start conservative and only widen retention or verbosity after you have measured actual need.

- Set root `<logger><level>` to `information` or `warning`. Do not run production clusters at `debug` unless you are actively debugging and have a rollback window.
- Bound `text_log`, `query_log`, `part_log`, and `query_views_log` with explicit TTLs and bounded in-memory buffers.
- Disable `metric_log`, `asynchronous_metric_log`, `processors_profile_log`, and `trace_log` unless the application has a hard dependency on them.
- If you disable `trace_log`, also disable the sampling profilers in `users.d` so ClickHouse does not keep generating trace data that nobody intends to retain.
- Size PVCs for user data plus merge overhead plus bounded internal logs. Do not treat internal logs as negligible.

Recommended starter policy for small to medium clusters:

- `logger.level`: `information` or `warning`
- `text_log`: `1-3` day TTL
- `query_log`: `3-7` day TTL
- `query_views_log`: `3` day TTL if the workload uses materialized views heavily, otherwise remove it
- `part_log`: `1-2` day TTL
- `trace_log`: remove unless you are actively using sampling/profiling
- `metric_log`: remove unless you have a concrete consumer for historical metrics
- `asynchronous_metric_log`: remove by default
- `processors_profile_log`: remove by default

### Operator-Safe Baseline Snippet

Use this pattern in `ClickHouseInstallation.spec.configuration.files` for new clusters:

```yaml
configuration:
  files:
    config.d/99-logging-overrides.xml: |-
      <clickhouse>
        <logger>
          <level>information</level>
        </logger>

        <text_log>
          <level>information</level>
          <engine>Engine = MergeTree PARTITION BY event_date ORDER BY event_time TTL event_date + INTERVAL 3 DAY</engine>
          <flush_interval_milliseconds>15000</flush_interval_milliseconds>
          <max_size_rows>262144</max_size_rows>
          <reserved_size_rows>8192</reserved_size_rows>
          <buffer_size_rows_flush_threshold>131072</buffer_size_rows_flush_threshold>
          <flush_on_crash>false</flush_on_crash>
        </text_log>

        <query_log>
          <engine>Engine = MergeTree PARTITION BY event_date ORDER BY event_time TTL event_date + INTERVAL 7 DAY</engine>
          <flush_interval_milliseconds>15000</flush_interval_milliseconds>
          <max_size_rows>262144</max_size_rows>
          <reserved_size_rows>8192</reserved_size_rows>
          <buffer_size_rows_flush_threshold>131072</buffer_size_rows_flush_threshold>
          <flush_on_crash>false</flush_on_crash>
        </query_log>

        <part_log>
          <engine>Engine = MergeTree PARTITION BY event_date ORDER BY event_time TTL event_date + INTERVAL 2 DAY</engine>
          <flush_interval_milliseconds>15000</flush_interval_milliseconds>
          <max_size_rows>131072</max_size_rows>
          <reserved_size_rows>4096</reserved_size_rows>
          <buffer_size_rows_flush_threshold>65536</buffer_size_rows_flush_threshold>
          <flush_on_crash>false</flush_on_crash>
        </part_log>

        <query_views_log>
          <engine>Engine = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (event_date, event_time) TTL event_date + INTERVAL 3 DAY</engine>
          <flush_interval_milliseconds>15000</flush_interval_milliseconds>
          <max_size_rows>131072</max_size_rows>
          <reserved_size_rows>4096</reserved_size_rows>
          <buffer_size_rows_flush_threshold>65536</buffer_size_rows_flush_threshold>
          <flush_on_crash>false</flush_on_crash>
        </query_views_log>

        <metric_log remove="1"/>
        <asynchronous_metric_log remove="1"/>
        <processors_profile_log remove="1"/>
        <trace_log remove="1"/>
      </clickhouse>
    users.d/99-profile-overrides.xml: |-
      <clickhouse>
        <profiles>
          <default>
            <query_profiler_real_time_period_ns>0</query_profiler_real_time_period_ns>
            <query_profiler_cpu_time_period_ns>0</query_profiler_cpu_time_period_ns>
            <log_profile_events>0</log_profile_events>
          </default>
        </profiles>
      </clickhouse>
```

Notes:

- If you need to fully replace an existing generated section, use `replace="1"` on the target node.
- If you only need to delete a default section, use `remove="1"`.
- If you want to source secrets or Kafka credentials from pod env, use `from_env` in the XML and inject the env var in the pod template. This is the same pattern we use for named collections.

### Workload-Specific Variants

Do not blindly copy one cluster's logging profile into another. Start from the baseline above, then adapt:

- PostHog-compatible baseline:
  Keep `query_views_log` because PostHog makes heavy use of materialized views and migration/view diagnostics are useful during self-hosted recovery. On 4-8Gi pods, prefer the stricter profile: disable `trace_log`, `metric_log`, and `processors_profile_log`, disable the sampling profilers in `users.d`, and leave `query_views_log` as the only extra retained system log beyond `text_log`, `query_log`, and `part_log`. See [clickhouse-cluster.yaml](/Users/gregkonush/.codex/worktrees/e1b4/lab/argocd/applications/posthog/clickhouse-cluster.yaml).
- Torghut baseline:
  Prefer the stricter profile: disable `trace_log`, `metric_log`, `asynchronous_metric_log`, and `processors_profile_log`, keep `text_log` and `query_log` bounded, and keep `part_log` short. See [clickhouse-cluster.yaml](/Users/gregkonush/.codex/worktrees/4467/lab/argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml).

Rule:

- Application analytics cluster with fragile PVC budget: disable more.
- User-facing product cluster where migrations and view debugging matter: keep only the minimum extra logs with explicit TTLs.

### Validation Right After First Install

After the first sync of any new ClickHouse cluster, validate the logging profile immediately:

```bash
kubectl -n <ns> exec <clickhouse-pod> -- clickhouse-client --query "SHOW CREATE TABLE system.text_log"
kubectl -n <ns> exec <clickhouse-pod> -- clickhouse-client --query "SHOW CREATE TABLE system.query_log"
kubectl -n <ns> exec <clickhouse-pod> -- clickhouse-client --query "SHOW TABLES FROM system LIKE '%log'"
kubectl -n <ns> exec <clickhouse-pod> -- clickhouse-client --query "
SELECT
  table,
  formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE active AND database = 'system'
GROUP BY table
ORDER BY sum(bytes_on_disk) DESC
LIMIT 20"
kubectl -n <ns> exec <clickhouse-pod> -- bash -lc 'df -h /var/lib/clickhouse'
```

What to confirm:

- `system.text_log`, `system.query_log`, and any other retained log tables show the expected TTL in `SHOW CREATE TABLE`.
- Removed tables are actually absent, or only tiny current tables remain.
- `system.parts` is not dominated by `text_log_0`, `trace_log_0`, `query_views_log_0`, or metric tables.
- PVC usage has enough headroom for normal merges and mutations.

### Warning Signs

Treat the following as early indicators of the same failure mode:

- `system.*` tables are among the largest tables on disk.
- `df -h /var/lib/clickhouse` is high even though user tables are small.
- `system.parts` shows `text_log`, `trace_log`, `query_views_log`, `background_schedule_pool_log`, or metric tables dominating bytes on disk.
- ClickHouse logs start showing `NOT_ENOUGH_SPACE` or merge scheduling failures.
- Application startup checks fail against ClickHouse even though the user dataset is small.

### Emergency Recovery

If a cluster is already full because internal log tables consumed the PVC:

1. Ship the bounded logging config first so the next restart comes back with sane defaults.
2. If SQL `TRUNCATE` or `ALTER ... DROP PART` still works, clear the oversized `system.*` log tables.
3. If the disk is so full that ClickHouse cannot reserve scratch space for truncation, you may need an emergency manual cleanup of the backing store directories for safe system log tables, followed by a restart.
4. Only do filesystem deletion for tables that are explicitly safe to truncate or drop, such as `text_log`, `trace_log`, `query_log`, `query_views_log`, `background_schedule_pool_log`, `metric_log`, `asynchronous_metric_log`, `processors_profile_log`, and `part_log`.
5. Document the deviation from GitOps in the incident and follow with a manifest-backed permanent fix.

This is an emergency-only path, but it is now a known one. Waiting for the cluster to "self-heal" once the PVC is full is not realistic.

## Prometheus & Observability

- ServiceMonitor: disabled by default. If/when you deploy the Prometheus Operator, set `serviceMonitor.enabled: true` and ensure the Prometheus stack watches `clickhouse-operator`.
- Grafana: add dashboards from the Altinity repo (e.g., ClickHouse Overview, Keeper health) by pulling them into the observability stack after the operator provisions metrics.
- Metrics pipeline: the lab’s observability stack relies on Grafana Mimir (metrics storage) and Alloy or Prometheus agents for scraping. To record ClickHouse metrics today, deploy an Alloy scraper (patterned after `argocd/applications/argocd/alloy-configmap.yaml`) targeting `clickhouse-operator` and forward via `prometheus.remote_write` to `observability-mimir-nginx`. Alternatively, add a Prometheus Operator release in the `observability` namespace, configure remote write to Mimir, and create a matching `ServiceMonitor`.
- Alerting: configure alert rules for Keeper quorum loss, ClickHouse replica lag, and operator reconciliation failures.

## Sync Lifecycle

1. Initial rollout: keep the ApplicationSet entry at `automation: manual`. Apply a manual sync in a sandbox cluster and observe for 48 hours.
2. Pre-production checklist:
   - Confirm the `rook-ceph-block` storage class (or your chosen override) exists in each target cluster.
   - Capture validation output for `bun run lint:argocd` and `scripts/kubeconform.sh argocd` in the issue.
3. Enable automation by switching the ApplicationSet entry to `automation: auto` once sign-off is complete.
4. Operational monitoring: use `argocd app get clickhouse-operator --watch` and `kubectl -n clickhouse-operator get pods` after each chart or values change.

## Rollback

- Helm chart rollback: `argocd app rollback clickhouse-operator <ID>` reverts to a previous revision while keeping the namespace intact.
- Namespace recovery: if a change introduces broken CRDs or controllers, disable auto-sync, delete the `clickhouse-operator` namespace, and re-sync the application after values are corrected.
- Keeper & cluster CRDs: versioned CRDs are pinned to chart v0.25.4. Regenerate schemas via `scripts/download_crd_schema.py` before upgrading to maintain kubeconform coverage.

## References

- Altinity Operator documentation: https://docs.altinity.com/altinitykubernetesoperator/
- Altinity cluster settings (`.spec.configuration.files`): https://docs.altinity.com/altinitykubernetesoperator/kubernetesoperatorguide/clustersettings/
- ClickHouse configuration files and merge semantics: https://clickhouse.com/docs/operations/configuration-files
- ClickHouse server settings for logger and system log tables: https://clickhouse.com/docs/operations/server-configuration-parameters/settings
- ClickHouse system tables overview: https://clickhouse.com/blog/clickhouse-debugging-issues-with-system-tables
- Helm chart source: https://github.com/Altinity/clickhouse-operator/tree/main/deploy/helm/clickhouse-operator
- GitOps application path: `argocd/applications/clickhouse-operator/`
- Values file: `argocd/applications/clickhouse-operator/values.yaml`
