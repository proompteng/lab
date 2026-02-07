# Chart Controllers Image Override Precedence

Status: Draft (2026-02-07)

## Overview
The Agents chart can run controllers as a separate Deployment (`agents-controllers`) with its own image. Operators need a clear contract for how `controllers.image.*` relates to the root `image.*` and the control plane `controlPlane.image.*`.

## Goals
- Define image selection precedence for `agents-controllers`.
- Enable safe canarying controllers independently from the control plane.

## Non-Goals
- Supporting multiple controller images in a single release (one deployment only).

## Current State
- Controllers deployment template: `charts/agents/templates/deployment-controllers.yaml` computes:
  - `$imageRepo := .Values.controllers.image.repository | default .Values.image.repository`
  - similarly for `tag`, `digest`, `pullPolicy`, `pullSecrets`
- Values surface: `charts/agents/values.yaml` under `controllers.image.*` and `image.*`.
- GitOps currently pins both control plane and controller images in `argocd/applications/agents/values.yaml`.

## Design
### Precedence for controllers
1. `controllers.image.*` (if field non-empty)
2. `image.*` (root defaults)

### Operational policy
- For production: always set `controllers.image.digest` explicitly when `controllers.enabled=true`.
- For canary: bump controllers digest first, validate, then bump control plane digest.

## Config Mapping
| Helm value | Rendered image for `agents-controllers` | Notes |
|---|---|---|
| `controllers.image.repository` | repo | Defaults to `image.repository` if empty. |
| `controllers.image.tag` | tag | Defaults to `image.tag` if empty. |
| `controllers.image.digest` | digest | Defaults to `image.digest` if empty. |
| `controllers.image.pullSecrets` | imagePullSecrets | Defaults to `image.pullSecrets` if empty. |

## Rollout Plan
1. Add this contract to `charts/agents/README.md`.
2. Add a CI check that `controllers.enabled=true` implies `controllers.image.digest` is non-empty in prod overlays.
3. Use an Argo CD canary window (manual sync or progressive wave) before promoting.

Rollback:
- Revert `controllers.image.digest` to the prior known-good digest and re-sync.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"name: agents-controllers|image:\"
kubectl -n agents get deploy agents-controllers -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

## Failure Modes and Mitigations
- Controllers image accidentally inherits `image.tag=latest` without digest: mitigate via validation/enforcement in prod.
- Canary controllers uses incompatible schema vs CRDs: mitigate by bundling CRD changes + controllers changes in one PR when APIs change.

## Acceptance Criteria
- Operators can canary `agents-controllers` without modifying the control plane deployment.
- A prod overlay policy ensures controllers run by digest, not mutable tags.

## References
- Kubernetes container images: https://kubernetes.io/docs/concepts/containers/images/

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
- Argo WorkflowTemplates used by Codex (when applicable):
  - `argocd/applications/froussard/codex-autonomous-workflow-template.yaml`
  - `argocd/applications/froussard/codex-run-workflow-template-jangar.yaml`
  - `argocd/applications/froussard/github-codex-implementation-workflow-template.yaml`
  - `argocd/applications/froussard/github-codex-post-deploy-workflow-template.yaml`

### Current cluster state
As of 2026-02-07 (repo `main` desired state + best-effort live version):
- Argo CD app: `agents` deploys Helm chart `charts/agents` (release `agents`) into namespace `agents` with `includeCRDs: true`. See `argocd/applications/agents/kustomization.yaml`.
- Chart version pinned by GitOps: `0.9.1`. See `argocd/applications/agents/kustomization.yaml`.
- Images pinned by GitOps: control plane `registry.ide-newton.ts.net/lab/jangar-control-plane:5b72ee1e@sha256:e24ef112b615401150220dc303553f47a3cefe793c0c6c28781e9575b98ab9ae` and controllers `registry.ide-newton.ts.net/lab/jangar:5b72ee1e@sha256:96e72f5e649b1738ba4a48f9e786f5cdcb2ad5d63838d4009f5c71c80c2e6809`. See `argocd/applications/agents/values.yaml`.
- Namespaced reconciliation: `controller.namespaces: [agents]` and `rbac.clusterScoped: false`. See `argocd/applications/agents/values.yaml`.
- Live cluster Kubernetes version (from this environment): `v1.35.0+k3s1` (`kubectl version`).

Note: The safest “source of truth” for rollout planning is the desired state (`argocd/applications/**` + `charts/agents/**`). Live inspection may require elevated RBAC.

To verify live cluster state (requires permissions):

```bash
kubectl version --output=yaml | rg -n "serverVersion|gitVersion|platform"
kubectl get application -n argocd agents
kubectl -n agents get deploy
kubectl -n agents get pods
kubectl get crd | rg 'agents\.proompteng\.ai'
kubectl rollout status -n agents deploy/agents
kubectl rollout status -n agents deploy/agents-controllers
```

### Values → env var mapping (chart)
Rendered primarily by `charts/agents/templates/deployment.yaml` (control plane) and `charts/agents/templates/deployment-controllers.yaml` (controllers).

High-signal mappings to remember:
- `env.vars.*` / `controlPlane.env.vars.*` / `controllers.env.vars.*` → container `env:` (merge precedence is defined in `docs/agents/designs/chart-env-vars-merge-precedence.md`)
- `controller.namespaces` → `JANGAR_AGENTS_CONTROLLER_NAMESPACES` and `JANGAR_PRIMITIVES_NAMESPACES`
- `grpc.*` and/or `env.vars.JANGAR_GRPC_*` → `JANGAR_GRPC_{ENABLED,HOST,PORT}`
- `database.*` → `DATABASE_URL` + optional `PGSSLROOTCERT`

### Rollout plan (GitOps)
1. Update code + chart + CRDs together when APIs change:
   - Go types (`services/jangar/api/agents/v1alpha1/types.go`) → regenerate CRDs → `charts/agents/crds/`.
2. Validate locally:
   - `scripts/agents/validate-agents.sh`
   - `bun run lint:argocd`
3. Update the GitOps overlay if rollout requires new values:
   - `argocd/applications/agents/values.yaml`
4. Merge to `main`; Argo CD reconciles the `agents` application.

### Validation (smoke)
- Render the full install (Helm via kustomize): `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents > /tmp/agents.yaml`
- Schema + example validation: `scripts/agents/validate-agents.sh`
- In-cluster (if you have access): apply a minimal `Agent`/`AgentRun` from `charts/agents/examples` and confirm it reaches `Succeeded`.
