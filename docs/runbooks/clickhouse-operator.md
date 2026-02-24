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
- Helm chart source: https://github.com/Altinity/clickhouse-operator/tree/main/deploy/helm/clickhouse-operator
- GitOps application path: `argocd/applications/clickhouse-operator/`
- Values file: `argocd/applications/clickhouse-operator/values.yaml`
