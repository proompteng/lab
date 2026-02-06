# Chart namespaceOverride vs Release Namespace Behavior

Status: Draft (2026-02-06)

## Overview
The chart uses `namespaceOverride` to force all rendered resources into a namespace different from `.Release.Namespace`. This is useful in some GitOps setups but can be hazardous if only part of a release is overridden (e.g. CRDs are cluster-scoped, but Roles/RoleBindings are namespaced).

This doc defines safe usage and guardrails.

## Goals
- Make namespace selection behavior explicit for all chart resources.
- Prevent accidental “split-brain” installs (resources in multiple namespaces).

## Non-Goals
- Supporting multi-namespace installs from a single Helm release.

## Current State
- Value: `charts/agents/values.yaml` → `namespaceOverride`.
- Most templates set `metadata.namespace: {{ .Values.namespaceOverride | default .Release.Namespace }}`:
  - Examples: `charts/agents/templates/deployment.yaml`, `charts/agents/templates/service.yaml`, `charts/agents/templates/rbac.yaml`.
- GitOps typically installs into namespace `agents` and does not set `namespaceOverride` explicitly.

## Design
### Contract
- If `namespaceOverride` is set, it MUST be used consistently across all namespaced resources in the chart.
- Chart MUST fail render if:
  - `namespaceOverride` is set to an empty/whitespace string.
  - `namespaceOverride` is set but `.Release.Namespace` differs and `createNamespace=false` (optional guardrail depending on GitOps practice).

### Documentation requirement
Add a README section:
- “Do not set `namespaceOverride` unless Argo/Helm release namespace is locked.”

## Config Mapping
| Helm value | Rendered namespace | Intended behavior |
|---|---|---|
| `namespaceOverride: \"\"` | `.Release.Namespace` | Normal Helm behavior. |
| `namespaceOverride: agents` | `agents` | Forces all namespaced resources into `agents`. |

## Rollout Plan
1. Document contract and guardrails.
2. Add schema validation (`minLength: 1` when set).
3. Add template validation for common foot-guns.

Rollback:
- Remove `namespaceOverride`; rely on `.Release.Namespace`.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"namespace:\"
kubectl get ns agents
```

## Failure Modes and Mitigations
- Resources created in unexpected namespace: mitigate via render review + guardrail validation.
- Argo CD app sync fails due to namespace mismatch: mitigate by keeping release namespace and override aligned.

## Acceptance Criteria
- Rendered manifests place all namespaced resources in exactly one namespace.
- Invalid override values are rejected at render time.

## References
- Helm template rendering concepts: https://helm.sh/docs/chart_template_guide/


## Handoff Appendix (Repo + Chart + Cluster)

### Source of truth
- Helm chart: `charts/agents` (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`, `crds/`)
- GitOps application (desired state): `argocd/applications/agents/application.yaml`, `argocd/applications/agents/kustomization.yaml`, `argocd/applications/agents/values.yaml`
- Product appset enablement: `argocd/applicationsets/product.yaml`
- CRD Go types and codegen: `services/jangar/api/agents/v1alpha1/types.go`, `scripts/agents/validate-agents.sh`
- Controllers:
  - Agents/AgentRuns: `services/jangar/src/server/agents-controller.ts`
  - Orchestrations: `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/orchestration-submit.ts`
  - Supporting primitives: `services/jangar/src/server/supporting-primitives-controller.ts`
  - Policy checks (budgets/approval/etc): `services/jangar/src/server/primitives-policy.ts`
- Codex runners (when applicable): `services/jangar/scripts/codex/codex-implement.ts`, `packages/codex/src/runner.ts`
- Argo WorkflowTemplates used by Codex (when applicable): `argocd/applications/froussard/*.yaml`, `argocd/applications/argo-workflows/*.yaml`

### Current cluster state (from GitOps manifests)
As of 2026-02-06 (repo `main`):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps (see `argocd/applications/agents/values.yaml`):
  - Control plane (`charts/agents/templates/deployment.yaml` via `.Values.controlPlane.image.*`): `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae`
  - Controllers (`charts/agents/templates/deployment-controllers.yaml` via `.Values.image.*` unless `.Values.controllers.image.*` is set): `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Controllers enabled: `controllers.enabled: true` (separate `agents-controllers` deployment). See `argocd/applications/agents/values.yaml`.
- gRPC enabled: chart `grpc.enabled: true` and runtime `JANGAR_GRPC_ENABLED: "true"` in `.Values.env.vars`. See `argocd/applications/agents/values.yaml`.
- Database configured via SecretRef: `database.secretRef.name: jangar-db-app` and `database.secretRef.key: uri` (rendered as `DATABASE_URL`). See `argocd/applications/agents/values.yaml` and `charts/agents/templates/deployment.yaml`.

Note: Treat `charts/agents/**` and `argocd/applications/**` as the desired state. To verify live cluster state, run:

```bash
kubectl get application -n argocd agents
kubectl get application -n argocd froussard
kubectl get ns | rg '^(agents|agents-ci|jangar|froussard)\b'
kubectl get deploy -n agents
kubectl get crd | rg 'proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Rollout plan (GitOps)
1. Update code + chart + CRDs in one PR when changing APIs:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `scripts/argo-lint.sh`
   - `scripts/kubeconform.sh argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access):
  - `kubectl get pods -n agents`
  - `kubectl logs -n agents deploy/agents-controllers --tail=200`
  - Apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
