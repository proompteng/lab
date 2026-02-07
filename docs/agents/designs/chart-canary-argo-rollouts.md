# Chart Canary with Argo Rollouts (Optional Integration)

Status: Draft (2026-02-07)
## Overview
Today the Agents chart uses Kubernetes Deployments. For safer production changes (especially to controllers), operators may want progressive delivery. This doc proposes a chart-compatible integration path with Argo Rollouts without making it a hard dependency.

## Goals
- Provide a supported canary rollout pattern for `agents` and `agents-controllers`.
- Keep default behavior as plain Deployments.

## Non-Goals
- Replacing Argo CD as the GitOps orchestrator.
- Adding bespoke rollout tooling.

## Current State
- Chart renders `kind: Deployment` only:
  - `charts/agents/templates/deployment.yaml`
  - `charts/agents/templates/deployment-controllers.yaml`
- GitOps desired state for install lives in:
  - `argocd/applications/agents/application.yaml`
  - `argocd/applications/agents/kustomization.yaml`

## Design
### Proposed values
Add:
- `progressiveDelivery.enabled` (default `false`)
- `progressiveDelivery.provider: argo-rollouts`
- `progressiveDelivery.canarySteps` (list)

When enabled:
- Render `kind: Rollout` (Argo Rollouts CRD) instead of `Deployment`.
- Keep Services/selectors stable.

### Safety defaults
- Default to 1-step canary with manual pause.
- Keep max surge/unavailable conservative.

## Config Mapping
| Helm value | Rendered object | Intended behavior |
|---|---|---|
| `progressiveDelivery.enabled=false` | `Deployment` | Current behavior. |
| `progressiveDelivery.enabled=true` | `Rollout` | Progressive delivery driven by Argo Rollouts controller. |

## Rollout Plan
1. Add chart support behind `progressiveDelivery.enabled=false`.
2. Install Argo Rollouts in a non-prod cluster; enable for controllers only.
3. After stable, enable for control plane if desired.

Rollback:
- Disable `progressiveDelivery.enabled` to fall back to Deployments (requires careful migration; document as “one-time switch”).

## Validation
```bash
helm template agents charts/agents --set progressiveDelivery.enabled=true | rg -n \"kind: Rollout\"
kubectl get crd | rg \"rollouts\\.argoproj\\.io\"
kubectl -n agents get rollout
```

## Failure Modes and Mitigations
- Rollouts CRD not installed: mitigate by render-time validation when feature enabled.
- Switching kinds breaks `kubectl rollout` workflows: mitigate by documenting operational differences and migration steps.

## Acceptance Criteria
- Enabling the flag renders valid manifests and does not break the default install path.
- Controllers can be canaried progressively without changing Services.

## References
- Argo Rollouts documentation: https://argo-rollouts.readthedocs.io/

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
