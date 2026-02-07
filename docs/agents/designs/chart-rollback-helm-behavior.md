# Chart Rollback Behavior and Safe Defaults

Status: Draft (2026-02-06)

## Production / GitOps (source of truth)
These design notes are kept consistent with the live *production desired state* (GitOps) and the in-repo `charts/agents` chart.

### Current production deployment (desired state)
- Namespace: `agents`
- Argo CD app: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml` (chart `charts/agents`, chart version `0.9.1`, release `agents`)
- Values overlay: `argocd/applications/agents/values.yaml` (pins images + digests, DB SecretRef, gRPC, and `envFromSecretRefs`)
- Additional in-cluster resources (GitOps-managed): `argocd/applications/agents/*.yaml` (Agent/Provider, SecretBinding, VersionControlProvider, samples)

### Chart + code (implementation)
- Chart entrypoint: `charts/agents/Chart.yaml`
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- Templates: `charts/agents/templates/`
- CRDs installed by the chart: `charts/agents/crds/`
- Example CRs: `charts/agents/examples/`
- Control plane + controllers code: `services/jangar/src/server/`

### Values ↔ env mapping (common)
- `.Values.env.vars` → base Pod `env:` for control plane + controllers (merged; component-local values win).
- `.Values.controlPlane.env.vars` → control plane-only overrides.
- `.Values.controllers.env.vars` → controllers-only overrides.
- `.Values.envFromSecretRefs[]` → Pod `envFrom.secretRef` (Secret keys become env vars at runtime).

### Rollout + validation (production)
- Rollout path: edit `argocd/applications/agents/` (and/or `charts/agents/`), commit, and let Argo CD sync.
- Render exactly like Argo CD (Helm v3 + kustomize):
  ```bash
  helm lint charts/agents
  mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.rendered.yaml
  ```
- Validate in-cluster (requires RBAC allowing reads in `agents`):
  ```bash
  kubectl -n agents get deploy,svc,pdb,cm
  kubectl -n agents describe deploy agents
  kubectl -n agents describe deploy agents-controllers || true
  kubectl -n agents logs deploy/agents --tail=200
  kubectl -n agents logs deploy/agents-controllers --tail=200 || true
  ```

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

