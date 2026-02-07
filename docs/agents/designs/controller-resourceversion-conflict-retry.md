# Controller ResourceVersion Conflicts and Retry Strategy

Status: Draft (2026-02-07)

## Overview
Controllers patch and apply resources that may also be updated by other actors (users, GitOps, other controllers). Conflicts (HTTP 409) and optimistic concurrency failures should be handled predictably: retry when safe, fail fast when not.

## Goals
- Define a retry policy for resourceVersion conflicts on:
  - status writes
  - metadata patches (finalizers/labels)
- Avoid infinite retry loops.

## Non-Goals
- Solving every conflict scenario; some must surface as errors.

## Current State
- Controllers patch and set status frequently:
  - `services/jangar/src/server/agents-controller.ts` uses `kube.patch(...)` and `setStatus(...)`.
- `kube.patch` uses `kubectl patch --type=merge`:
  - `services/jangar/src/server/primitives-kube.ts`
- Conflict handling is not centralized; retries are largely implicit (if reconciliation loops run again).

## Design
### Retry policy
- For status updates:
  - Use SSA where possible (reduces conflicts) and retry up to N times with jitter on conflict.
- For metadata patches (finalizers):
  - Retry up to N times on conflict; if still conflicting, re-fetch and recompute finalizers.
- N defaults to 3, configurable via env var.

### Implementation approach
- Add a `withConflictRetry` helper used by:
  - finalizer patch paths in `agents-controller.ts`
  - status apply paths (if not already resilient)

## Config Mapping
| Proposed Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_CONTROLLER_CONFLICT_RETRY_ATTEMPTS` | `JANGAR_CONTROLLER_CONFLICT_RETRY_ATTEMPTS` | Max retries on 409/conflict (default `3`). |
| `controllers.env.vars.JANGAR_CONTROLLER_CONFLICT_RETRY_BASE_MS` | `JANGAR_CONTROLLER_CONFLICT_RETRY_BASE_MS` | Base backoff delay (default `200`). |

## Rollout Plan
1. Add helper + defaults (no config needed).
2. Canary in non-prod by simulating concurrent updates and confirming convergence.

Rollback:
- Disable retries by setting attempts to `0` (or reverting code).

## Validation
```bash
kubectl -n agents get agentrun <name> -o yaml | rg -n \"resourceVersion:\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"Conflict|409\"
```

## Failure Modes and Mitigations
- Retry loops amplify load: mitigate with small N and jitter.
- Conflicts hide real logic bugs: mitigate by logging a structured warning after the final retry.

## Acceptance Criteria
- Common conflict cases converge without operator intervention.
- Conflict retries are bounded and observable.

## References
- Kubernetes optimistic concurrency control: https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions

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
