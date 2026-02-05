# Multi-Namespace Controller Guardrails

Status: Draft (2026-02-05)

## Current State

- Code: namespace-scope.assertClusterScopedForWildcard enforces rbac.clusterScoped for '*' in agents-controller and webhook ingestion.
- Chart: rbac.clusterScoped and controller.namespaces map to JANGAR_RBAC_CLUSTER_SCOPED and JANGAR_AGENTS_CONTROLLER_NAMESPACES.
- Cluster: rbac.clusterScoped=false and controller.namespaces=[agents].


## Problem
Misconfigured namespaces can lead to missed resources or RBAC errors.

## Goals

- Validate namespace scopes at startup.
- Provide clear errors for missing RBAC.

## Non-Goals

- Automatic RBAC escalation.

## Design

- Check namespace list and RBAC at startup.
- Refuse to start on invalid config.

## Chart Changes

- Add validations in values.schema.json.

## Controller Changes

- Add startup checks for namespace permissions.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.

## Validation

- Exercise the primary flow and confirm expected status, logs, or metrics.
- Confirm no regression in existing workflows, CI checks, or chart rendering.

## Acceptance Criteria

- Misconfigurations are reported before reconcile.
- Controllers start only with valid scopes.
