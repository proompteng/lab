# Chart Image Digest/Tag Precedence

Status: Draft (2026-02-07)

## Overview
The Agents chart supports image tags and optional digests for both the control plane and controllers. In production GitOps, digests are preferred for immutability. The chart currently concatenates `repo:tag@digest` when a digest is provided, but the operational contract (and failure modes) are not documented.

## Goals
- Define a clear contract for tag + digest usage.
- Prevent accidental drift (e.g. `tag: latest` without digest).
- Provide a safe upgrade/rollback process.

## Non-Goals
- Introducing an image signing/verification system (covered elsewhere).

## Current State
- Values: `charts/agents/values.yaml` under `image.*`, `controlPlane.image.*`, `controllers.image.*`.
- Template image rendering:
  - Control plane: `charts/agents/templates/deployment.yaml`
  - Controllers: `charts/agents/templates/deployment-controllers.yaml`
- GitOps pins digests in `argocd/applications/agents/values.yaml`.

## Design
### Rendering rules
- If `digest` is non-empty: render `repository:tag@digest`.
- If `digest` is empty: render `repository:tag`.
- Component-specific image blocks override the root `image.*` values for that component.

### Production policy
- Production profiles MUST set `digest` for all images.
- `tag` remains required even when digest is set (for readability), but it is informational-only.

### Chart validation
Add optional enforcement:
- `imagePolicy.requireDigest=true` (default `false`): when enabled, render fails if any enabled component lacks a digest.

## Config Mapping
| Helm value | Rendered field | Behavior |
|---|---|---|
| `image.repository` | `spec.template.spec.containers[].image` | Default repository for control plane and (if unset) controllers. |
| `image.tag` | image string | Used when digest is absent; informational when digest is present. |
| `image.digest` | image string | If set, pins an immutable manifest. |
| `controlPlane.image.*` | control plane image string | Overrides root `image.*`. |
| `controllers.image.*` | controllers image string | Overrides root `image.*`. |

## Rollout Plan
1. Add documentation + schema keys (no behavior change).
2. Enable `imagePolicy.requireDigest=true` in non-prod first.
3. Enable in prod after verifying image promotion pipeline always supplies digests.

Rollback:
- Disable `imagePolicy.requireDigest`.
- Roll back values to prior digests; no template changes required.

## Validation
Render:
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"image:|@sha256:\"
```

Live:
```bash
kubectl -n agents get deploy agents -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
kubectl -n agents get deploy agents-controllers -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

## Failure Modes and Mitigations
- Digest set with wrong tag: safe (digest wins); mitigate confusion by documenting tag informational-only.
- Digest omitted in prod: mitigate via enforcement flag and CI checks on GitOps values.
- Registry garbage-collects unreferenced manifests: mitigate by retaining digests used in GitOps history.

## Acceptance Criteria
- Production values pin digests for all enabled components.
- Optional chart enforcement can be turned on without code changes.

## References
- Kubernetes container image names (tag/digest): https://kubernetes.io/docs/concepts/containers/images/

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
