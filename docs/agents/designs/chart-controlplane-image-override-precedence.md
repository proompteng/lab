# Chart Control Plane Image Override Precedence

Status: Draft (2026-02-06)

## Overview
The Agents control plane runs as the `agents` Deployment. The chart supports an explicit `controlPlane.image.*` override separate from `image.*`. This doc defines a contract for selecting that image and recommended promotion paths.

## Goals
- Clarify image selection rules for the control plane.
- Support independent pinning/promotion between control plane and controllers.

## Non-Goals
- Supporting multiple control plane deployments per release.

## Current State
- Template: `charts/agents/templates/deployment.yaml` computes `$imageRepo/$imageTag/$imageDigest` using `controlPlane.image.*` with fallbacks to `image.*`.
- Values: `charts/agents/values.yaml` under `controlPlane.image.*`.
- GitOps pins the control plane image in `argocd/applications/agents/values.yaml`.

## Design
### Precedence for control plane image
1. `controlPlane.image.*` (if field non-empty)
2. `image.*` (root defaults)

### Promotion policy
- Canary controllers first (separate deployment), then promote control plane.
- When changing API behavior that affects CRD reconciliation, promote controllers and control plane in lockstep (same git SHA + digest set).

## Config Mapping
| Helm value | Rendered image for `agents` | Notes |
|---|---|---|
| `controlPlane.image.repository` | repo | Defaults to `image.repository` if empty. |
| `controlPlane.image.tag` | tag | Defaults to `image.tag` if empty. |
| `controlPlane.image.digest` | digest | Defaults to `image.digest` if empty. |
| `controlPlane.image.pullSecrets` | imagePullSecrets | Defaults to `image.pullSecrets` if empty. |

## Rollout Plan
1. Document contract in `charts/agents/README.md`.
2. Add `imagePolicy.requireDigest` enforcement in prod (optional, see `chart-image-digest-tag-precedence.md`).
3. Promote via GitOps value change; wait for rollout status.

Rollback:
- Revert digest and re-sync.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"kind: Deployment|name: agents$|image:\"
kubectl -n agents rollout status deploy/agents
```

## Failure Modes and Mitigations
- Control plane and controllers drift to incompatible versions: mitigate via CI rule enforcing same git SHA tag in prod overlays.
- Digest omitted causes unexpected image pull changes: mitigate with digest enforcement.

## Acceptance Criteria
- Rendered image for `agents` is predictable from values.
- Operators can roll back by reverting a single digest in GitOps.

## References
- Helm best practices for values: https://helm.sh/docs/chart_best_practices/values/


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
