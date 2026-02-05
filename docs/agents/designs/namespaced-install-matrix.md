# Namespaced vs Cluster-Scoped Install Matrix

Status: Current (2026-02-05)

## Purpose
Define the supported install modes and their RBAC implications for the Agents control plane.

## Current State

- Chart configuration:
  - `rbac.clusterScoped` toggles Role vs ClusterRole in `charts/agents/templates/rbac.yaml`.
  - `controller.namespaces` controls the namespaces reconciled by the agents controller.
- Runtime enforcement: `services/jangar/src/server/namespace-scope.ts` rejects `controller.namespaces: ["*"]`
  unless `JANGAR_RBAC_CLUSTER_SCOPED=true`.
- Cluster: The `agents` ArgoCD app sets `controller.namespaces: [agents]` and `rbac.clusterScoped: false`, so
  reconciliation is namespaced.

## Install Matrix
| Install mode | controller.namespaces | rbac.clusterScoped | Expected RBAC |
| --- | --- | --- | --- |
| Namespaced (single) | `[]` or `["agents"]` | `false` | Role + RoleBinding in namespace |
| Multi-namespace | `["team-a", "team-b"]` | `true` | ClusterRole + ClusterRoleBinding |
| Wildcard | `["*"]` | `true` | ClusterRole + ClusterRoleBinding |

## Behavior

- Namespaced installs only watch the configured namespace(s).
- Cluster-scoped installs watch multiple namespaces or wildcarded namespaces.
- The controller fails fast on wildcard namespaces without cluster-scoped RBAC.

## Validation

- Render `charts/agents` with each install mode and confirm RBAC manifests.
- In cluster, confirm `JANGAR_RBAC_CLUSTER_SCOPED` matches the RBAC mode.
- For wildcard installs, verify the controller process exits with a clear error when RBAC is misconfigured.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.
