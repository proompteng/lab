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

## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart behavior: `charts/agents/values.yaml`, `charts/agents/values.schema.json`, `charts/agents/templates/`
- Chart render-time validation: `charts/agents/templates/validation.yaml`
- GitOps desired state:
  - `agents` app (CRDs + controllers + service): `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
  - `jangar` app (product deployment + primitives): `argocd/applications/jangar/kustomization.yaml`
  - Product enablement: `argocd/applicationsets/product.yaml`

### Values → env var mapping (chart)
- Control plane env var merge + rendering: `charts/agents/templates/deployment.yaml`
- Controllers env var merge + rendering: `charts/agents/templates/deployment-controllers.yaml`
- Common pattern: `.Values.env.vars` are merged with component-specific vars (control plane: `.Values.controlPlane.env.vars`, controllers: `.Values.controllers.env.vars`). Component-specific keys win.

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`, desired state in Git):
- `agents` Argo CD app (namespace `agents`) installs `charts/agents` via kustomize-helm (release `agents`, chart `version: 0.9.1`, `includeCRDs: true`). See `argocd/applications/agents/kustomization.yaml`.
- Images pinned for `agents`:
  - Control plane (`deploy/agents`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` (from `controlPlane.image.*`).
  - Controllers (`deploy/agents-controllers`): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809` (from `image.*`).
- Namespaced reconciliation: `controller.namespaces: [agents]`, `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- `jangar` Argo CD app (namespace `jangar`) deploys the product UI/control plane plus default “primitive” CRs (AgentProvider/Agent/Memory/etc). See `argocd/applications/jangar/kustomization.yaml`.
- Jangar image pinned for `jangar` (`deploy/jangar`): `registry.ide-newton.ts.net/lab/jangar:19448656@sha256:15380bb91e2a1bb4e7c59dce041859c117ceb52a873d18c9120727c8e921f25c` (from `argocd/applications/jangar/kustomization.yaml`).

Render the exact YAML Argo CD applies:

```bash
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/jangar > /tmp/jangar.rendered.yaml
```

Verify live cluster state (requires kubeconfig):

```bash
mise exec kubectl@1.30.6 -- kubectl get application -n argocd agents
mise exec kubectl@1.30.6 -- kubectl get application -n argocd jangar
mise exec kubectl@1.30.6 -- kubectl get ns | rg '^(agents|agents-ci|jangar)\b'
mise exec kubectl@1.30.6 -- kubectl get deploy -n agents
mise exec kubectl@1.30.6 -- kubectl get deploy -n jangar
mise exec kubectl@1.30.6 -- kubectl get crd | rg 'proompteng\.ai'
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl rollout status -n jangar deploy/jangar
```

### Rollout plan (GitOps)
1. Change chart templates/values/schema in `charts/agents/**`.
2. If the chart `version:` changes, keep `charts/agents/Chart.yaml` and `argocd/applications/agents/kustomization.yaml` in sync.
3. Validate rendering locally (no cluster access required):

```bash
mise exec helm@3.15.4 -- helm lint charts/agents
mise exec helm@3.15.4 -- helm template agents charts/agents -n agents -f argocd/applications/agents/values.yaml --include-crds > /tmp/agents.helm.yaml
mise exec helm@3.15.4 kustomize@5.4.3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.rendered.yaml
scripts/agents/validate-agents.sh
```

4. Merge to `main`; Argo CD reconciles.

### Validation (post-merge)
- Confirm Argo sync + workloads healthy:

```bash
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents
mise exec kubectl@1.30.6 -- kubectl rollout status -n agents deploy/agents-controllers
mise exec kubectl@1.30.6 -- kubectl logs -n agents deploy/agents-controllers --tail=200
```
