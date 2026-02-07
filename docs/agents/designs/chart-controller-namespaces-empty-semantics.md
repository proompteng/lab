# Chart Controller Namespaces: Empty Semantics

Status: Draft (2026-02-07)

## Overview
Controllers reconcile CRDs in a set of namespaces. The chart exposes `controller.namespaces`, but it is not documented what an empty list means (disabled? all namespaces? release namespace only?). Ambiguity here creates production risk.

## Goals
- Define an explicit meaning for `controller.namespaces: []`.
- Prevent accidental cluster-wide reconciliation in namespaced installs.
- Make namespace scope observable and testable.

## Non-Goals
- Redesigning multi-namespace support (covered separately).

## Current State
- Values: `charts/agents/values.yaml` exposes `controller.namespaces: []`.
- Template renders namespaces into env vars:
  - `JANGAR_AGENTS_CONTROLLER_NAMESPACES`: `charts/agents/templates/deployment-controllers.yaml`
  - helper: `charts/agents/templates/_helpers.tpl` (`agents.controllerNamespaces`)
- Runtime parsing:
  - `services/jangar/src/server/implementation-source-webhooks.ts` reads `process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES`.
  - Controllers use namespace scoping utilities in `services/jangar/src/server/namespace-scope.ts`.
- Cluster desired state sets `controller.namespaces: [agents]` in `argocd/applications/agents/values.yaml`.

## Design
### Semantics
- `controller.namespaces` MUST be required when `rbac.clusterScoped=false`.
- Empty list MUST mean “no namespaces configured” and controllers SHOULD refuse to start (fail-fast) to avoid a false sense of safety.
- For `rbac.clusterScoped=true`, introduce an explicit value:
  - `controller.namespaces: [\"*\"]` to mean “all namespaces”, rather than interpreting empty as all.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.namespaces: [\"agents\"]` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[\"agents\"]` | Reconcile only `agents` namespace resources. |
| `controller.namespaces: []` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[]` (or unset) | Fail-fast at startup unless clusterScoped=true and explicit wildcard used. |
| `controller.namespaces: [\"*\"]` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES=[\"*\"]` | (When clusterScoped=true) reconcile all namespaces. |

## Rollout Plan
1. Document semantics and recommend non-empty namespaces for prod.
2. Add controller startup validation in `services/jangar/src/server/*`:
   - If env var is empty/unset: exit with clear error.
3. Add chart schema rule: when `controller.enabled=true`, require at least one namespace unless clusterScoped=true and wildcard is used.

Rollback:
- Disable fail-fast validation (code rollback).

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"JANGAR_AGENTS_CONTROLLER_NAMESPACES\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"NAMESPACES|namespace\"
```

## Failure Modes and Mitigations
- Empty list interpreted as “all namespaces” unexpectedly: mitigate by banning that interpretation.
- Controllers start but do nothing due to empty scope: mitigate with fail-fast.
- Wildcard scope used with namespaced RBAC: mitigate by schema validation and startup checks.

## Acceptance Criteria
- Empty namespaces configuration is rejected with a clear, actionable error.
- Wildcard all-namespaces requires explicit `\"*\"` and cluster-scoped RBAC.

## References
- Kubernetes controller patterns (namespace scoping best practices): https://kubernetes.io/docs/concepts/architecture/controller/

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
