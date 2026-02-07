# Chart gRPC Enabled: Single Source of Truth

Status: Draft (2026-02-07)

## Overview
The chart has `grpc.enabled` (controls Service + container port) while runtime can also be toggled with `JANGAR_GRPC_ENABLED` (via `env.vars`). When these disagree, the deployment can become confusing: a Service may exist without the server listening, or the server may listen without a Service/port.

This doc defines a single-source-of-truth contract.

## Goals
- Ensure `grpc.enabled` and `JANGAR_GRPC_ENABLED` cannot drift.
- Provide a safe migration path for existing installs.

## Non-Goals
- Changing the gRPC API surface area.

## Current State
- Chart:
  - Service template: `charts/agents/templates/service-grpc.yaml` gated on `grpc.enabled`.
  - Container port for gRPC is gated on `grpc.enabled`: `charts/agents/templates/deployment.yaml`.
  - Controllers deployment defaults `JANGAR_GRPC_ENABLED=0`: `charts/agents/templates/deployment-controllers.yaml`.
- GitOps:
  - `argocd/applications/agents/values.yaml` sets `grpc.enabled: true` and also sets `JANGAR_GRPC_ENABLED: \"true\"` under `env.vars`.

## Design
### Contract
- `grpc.enabled` MUST be the only control-plane switch.
- The chart MUST render `JANGAR_GRPC_ENABLED` for the control plane based on `grpc.enabled` (and ignore user-provided overrides unless explicitly allowed).
- Controllers deployment MUST continue to default-disable gRPC unless there is a concrete use-case.

### Migration
- Introduce `grpc.manageEnvVar` (default `true`):
  - When `true`, template sets `JANGAR_GRPC_ENABLED` from `grpc.enabled`.
  - When `false`, chart does not set it and operators can manage it manually.

## Config Mapping
| Helm value | Rendered env var / object | Intended behavior |
|---|---|---|
| `grpc.enabled=true` | `Service/agents-grpc` + `containerPort: grpc` + `JANGAR_GRPC_ENABLED=1` | Server listens and is reachable via Service. |
| `grpc.enabled=false` | no gRPC Service/port + `JANGAR_GRPC_ENABLED=0` | Server does not expose/listen. |

## Rollout Plan
1. Add `grpc.manageEnvVar` default `true`, but accept existing `env.vars.JANGAR_GRPC_ENABLED` with a warning (no failure).
2. Update GitOps values to remove redundant `JANGAR_GRPC_ENABLED`.
3. After a canary, enforce: render fails if `grpc.manageEnvVar=true` and user sets `JANGAR_GRPC_ENABLED`.

Rollback:
- Set `grpc.manageEnvVar=false` and restore explicit env var management.

## Validation
```bash
helm template agents charts/agents -f argocd/applications/agents/values.yaml | rg -n \"agents-grpc|containerPort: grpc|JANGAR_GRPC_ENABLED\"
kubectl -n agents get svc agents-grpc
kubectl -n agents get endpointslice -l app.kubernetes.io/name=agents
```

## Failure Modes and Mitigations
- gRPC Service exists but server not listening: mitigate by having chart manage the env var.
- Server listens but no Service/port: mitigate by coupling the env var to `grpc.enabled`.

## Acceptance Criteria
- `grpc.enabled` reliably predicts whether gRPC is reachable.
- GitOps values do not need to set `JANGAR_GRPC_ENABLED` manually for the control plane.

## References
- Kubernetes Services: https://kubernetes.io/docs/concepts/services-networking/service/

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
