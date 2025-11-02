# Altinity ClickHouse Operator (GitOps)

This kustomization deploys the Altinity ClickHouse Operator v0.25.4 via the upstream Helm chart. It uses the co-located `values.yaml` overrides to pin resource requests, expose metrics, seed ClickHouse/Keeper templates, and apply a PodDisruptionBudget for the control plane pods.

> Store GitOps-managed manifests and Helm overrides within `argocd/applications/`; the repository's `kubernetes/` directory is reserved for bootstrap and maintenance tooling.

## Sync expectations
- The ApplicationSet entry is created with `automation: manual`; leave auto-sync disabled until the data platform team validates the operator in a sandbox cluster.
- Sync wave `-1` keeps the operator ahead of dependent ClickHouse installations once it is enabled.
- The values file includes TODOs for storage classes, priority classes, and tolerations—coordination is required before removing manual sync.

## Enabling reconciliation
1. Coordinate with the data platform team to pick Keeper and ClickHouse storage classes and confirm the priority class exists cluster-wide.
2. Remove or resolve the TODOs in `argocd/applications/clickhouse-operator/values.yaml`.
3. Update the ApplicationSet entry to `automation: auto` once the operator has run in a sandbox for 48 hours.
4. After enabling auto-sync, monitor `argocd app get clickhouse-operator` and `kubectl -n clickhouse-operator get pods` for at least one reconciliation cycle.
