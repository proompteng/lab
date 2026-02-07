# Chart Extra Volumes/Mounts Contract

Status: Draft (2026-02-07)

## Overview
The chart supports `.Values.extraVolumes` and `.Values.extraVolumeMounts`, which are injected into both the control plane and controllers pod specs. This is a powerful escape hatch but needs a documented contract to prevent accidental conflicts with chart-managed volumes (e.g. DB CA cert).

## Goals
- Define the intended use cases and constraints for extra volumes/mounts.
- Prevent collisions with reserved volume names.
- Make behavior consistent across control plane and controllers.

## Non-Goals
- Building a plugin system; extra volumes remain a low-level escape hatch.

## Current State
- Values: `charts/agents/values.yaml` exposes `extraVolumes` and `extraVolumeMounts`.
- Templates:
  - Control plane mounts/volumes: `charts/agents/templates/deployment.yaml`
  - Controllers mounts/volumes: `charts/agents/templates/deployment-controllers.yaml`
- Chart-managed volume today:
  - `db-ca-cert` when `database.caSecret.name` is set (both deployments).

## Design
### Contract
- Extra volume/mount entries MUST NOT use reserved names:
  - `db-ca-cert` (and any future chart-managed names)
- Extra volumes are applied to both deployments (current behavior). If operators need per-component volumes, add:
  - `controlPlane.extraVolumes`, `controlPlane.extraVolumeMounts`
  - `controllers.extraVolumes`, `controllers.extraVolumeMounts`

### Validation
- Add validation in `charts/agents/templates/validation.yaml`:
  - Fail render if a reserved name is used.
  - Fail render if a mount references a volume name that does not exist (best-effort check).

## Config Mapping
| Helm value | Rendered field | Behavior |
|---|---|---|
| `extraVolumes[].name` + `extraVolumes[].volume` | `spec.template.spec.volumes[]` | Appends volumes to both pod specs. |
| `extraVolumeMounts[].name` + `mountPath` | `containers[].volumeMounts[]` | Appends mounts to both containers. |
| `database.caSecret.*` | `db-ca-cert` secret volume + mount | Chart-managed reserved name. |

## Rollout Plan
1. Document reserved names and recommended usage in `charts/agents/README.md`.
2. Add validation (warn-only first if Helm supports; otherwise gated by a values flag).
3. Introduce per-component extras if required by production use-cases.

Rollback:
- Disable validation and/or remove per-component keys; existing global keys remain.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"volumes:|volumeMounts:|db-ca-cert\"
kubectl -n agents get deploy agents -o yaml | rg -n \"extra|db-ca-cert|volumes:|volumeMounts:\"
```

## Failure Modes and Mitigations
- Collision with `db-ca-cert` breaks DB TLS: mitigate with reserved-name validation.
- Mount references missing volume: mitigate with render-time validation.
- Extra volumes unintentionally affect both deployments: mitigate by adding component-scoped keys.

## Acceptance Criteria
- Chart fails render on reserved-name collisions.
- Operators have a documented path for adding CA bundles, SSH known_hosts, or custom credentials.

## References
- Kubernetes volumes: https://kubernetes.io/docs/concepts/storage/volumes/

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
