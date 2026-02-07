# Chart Kubernetes API Host/Port Override

Status: Draft (2026-02-07)

## Overview
The chart exposes `kubernetesApi.host` and `kubernetesApi.port` which map to `KUBERNETES_SERVICE_HOST` and `KUBERNETES_SERVICE_PORT`. This is a sharp tool: it can help run outside-cluster or in unusual networking environments, but can also break in-cluster discovery if misused.

## Goals
- Document when and how to use the override safely.
- Add guardrails to prevent accidental use in normal in-cluster deployments.

## Non-Goals
- Providing full out-of-cluster deployment support.

## Current State
- Values: `charts/agents/values.yaml` includes `kubernetesApi.host` and `kubernetesApi.port`.
- Templates set env vars for both deployments:
  - `charts/agents/templates/deployment.yaml`
  - `charts/agents/templates/deployment-controllers.yaml`
- Default is empty (Kubernetes default service env vars apply).

## Design
### Contract
- In-cluster installs SHOULD leave `kubernetesApi.*` empty.
- If either `kubernetesApi.host` or `kubernetesApi.port` is set, both MUST be set.
- The chart SHOULD validate the above in `values.schema.json`.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `kubernetesApi.host` | `KUBERNETES_SERVICE_HOST` | Overrides API endpoint host. |
| `kubernetesApi.port` | `KUBERNETES_SERVICE_PORT` | Overrides API endpoint port. |

## Rollout Plan
1. Add schema validation requiring both host and port together.
2. Add README guidance and examples (in-cluster vs special cases).

Rollback:
- Clear the override values and re-sync.

## Validation
```bash
helm template agents charts/agents | rg -n \"KUBERNETES_SERVICE_HOST|KUBERNETES_SERVICE_PORT\"
kubectl -n agents get deploy agents -o yaml | rg -n \"KUBERNETES_SERVICE_HOST|KUBERNETES_SERVICE_PORT\"
```

## Failure Modes and Mitigations
- Override breaks in-cluster API access: mitigate by default empty + schema guardrails.
- Only host or port set causes confusing behavior: mitigate by schema enforcement.

## Acceptance Criteria
- It is impossible (via schema) to set only one of host/port.
- Operators can identify overrides in rendered manifests.

## References
- Kubernetes in-cluster configuration: https://kubernetes.io/docs/tasks/run-application/access-api-from-pod/

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
