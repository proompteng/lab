# Chart Rollback Behavior and Safe Defaults

Status: Draft (2026-02-06)

## Overview
In GitOps, “rollback” typically means reverting values/manifests and letting Argo CD sync. Operators still rely on Helm semantics when debugging template behavior or when performing emergency rollbacks in non-GitOps contexts.

This doc defines rollback-safe defaults and what must remain backward compatible across chart versions.

## Goals
- Ensure the chart is rollback-safe (values changes can be reverted cleanly).
- Avoid one-way migrations in templates.
- Document the operational rollback procedure for GitOps.

## Non-Goals
- Documenting full disaster recovery scenarios (handled elsewhere).

## Current State
- Chart includes CRDs under `charts/agents/crds/` and installs them when `includeCRDs: true` (GitOps).
- GitOps desired state: `argocd/applications/agents/kustomization.yaml` (includes chart + CRDs).
- Templates avoid Helm hooks by default; optional Argo CD hooks exist under `charts/agents/templates/argocd-hooks.yaml`.

## Design
### Rollback-safe principles
- Never delete CRDs automatically on rollback.
- Additive-only changes to templates by default (new resources gated behind flags).
- Avoid renaming resources unless a migration plan exists.

### GitOps rollback procedure
1. Revert the GitOps values/manifests commit.
2. Sync Argo CD application.
3. Validate both Deployments rolled back to the prior image digests.

## Config Mapping
| Change type | Rollback risk | Mitigation |
|---|---:|---|
| New optional resource gated by flag | low | Default flag `false` and schema documentation. |
| Rename of a Service/Deployment | high | Avoid; if required, provide migration doc + dual-write period. |
| CRD schema breaking change | very high | Use versioned CRDs + conversion strategy (separate design). |

## Rollout Plan
1. Add a chart README section: “Rollback: what is safe to revert”.
2. Add CI check ensuring new templates are gated behind feature flags when appropriate.

Rollback:
- Apply the GitOps rollback procedure above.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml >/tmp/agents.yaml
kubectl -n agents rollout status deploy/agents
kubectl -n agents rollout status deploy/agents-controllers
```

## Failure Modes and Mitigations
- Rollback leaves new resources behind: mitigate by gating and by keeping selectors stable.
- Rollback reintroduces old defaults unexpectedly: mitigate by documenting default changes and versioning values.

## Acceptance Criteria
- Rolling back GitOps values returns pods to prior images and behavior within one sync.
- Chart upgrades do not require manual cleanup for optional features.

## References
- Helm template guide: https://helm.sh/docs/chart_template_guide/

