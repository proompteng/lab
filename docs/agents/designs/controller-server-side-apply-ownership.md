# Controller Server-Side Apply and Field Ownership

Status: Draft (2026-02-07)

## Overview
Controllers currently use `kubectl apply` (client-side) for many operations, and `kubectl apply --server-side --subresource=status` for status updates. Server-side apply (SSA) provides clear field ownership and reduces merge conflicts when multiple actors mutate the same objects.

This doc proposes standardizing SSA usage and setting explicit field managers.

## Goals
- Use SSA for status updates consistently (already present).
- Evaluate SSA for spec/apply operations where multiple writers exist.
- Reduce conflicts and improve auditability of field ownership.

## Non-Goals
- Rewriting controllers to use the Kubernetes Go client.

## Current State
- Kubernetes operations are executed via `kubectl`:
  - `services/jangar/src/server/primitives-kube.ts`
- SSA is currently used only for status apply:
  - `applyStatus`: `kubectl apply --server-side --subresource=status ...`
- Regular `apply` uses `kubectl apply -f -` without SSA.

## Design
### SSA policy
- Continue SSA for status with a stable field manager:
  - Add `--field-manager=jangar-controllers` to SSA calls.
- For spec/apply operations:
  - Use SSA only when controllers should own specific fields and conflicts are likely.
  - Otherwise keep client-side apply to reduce surprise conflicts.

### Implementation changes
- Update `applyStatus` in `primitives-kube.ts` to include `--field-manager`.
- Add an alternate `applyServerSide` method (optional) with the same field manager.

## Config Mapping
| Proposed Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_KUBECTL_FIELD_MANAGER` | `JANGAR_KUBECTL_FIELD_MANAGER` | Allows overriding the field manager name (default `jangar-controllers`). |

## Rollout Plan
1. Add field-manager to SSA status apply (low risk).
2. Canary in non-prod and check managedFields in CR status updates.
3. Evaluate SSA for spec apply paths case-by-case.

Rollback:
- Remove the `--field-manager` flag; SSA still works with default manager.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.managedFields[*].manager}'; echo
```

## Failure Modes and Mitigations
- Field ownership conflicts prevent apply: mitigate with targeted SSA usage and explicit field manager.
- ManagedFields growth increases object size: mitigate by avoiding SSA where unnecessary.

## Acceptance Criteria
- Status updates use a stable field manager name.
- Operators can inspect managed fields to understand what controllers own.

## References
- Kubernetes Server-Side Apply: https://kubernetes.io/docs/reference/using-api/server-side-apply/

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
