# Controllers Deployment: gRPC Disabled by Default

Status: Draft (2026-02-06)

## Overview
The chart renders a separate controllers deployment that forces `JANGAR_GRPC_ENABLED=0` unless explicitly overridden. This is a good safety default (controllers do not need to expose gRPC externally), but it is undocumented and can be surprising when operators expect agentctl gRPC to be available everywhere.

This doc defines the intended behavior and introduces a controlled enablement path if needed.

## Goals
- Document why gRPC is disabled in controllers.
- Provide a safe opt-in for controller gRPC only when required.

## Non-Goals
- Making controllers gRPC publicly accessible.

## Current State
- Chart forces defaults in `charts/agents/templates/deployment-controllers.yaml`:
  - Sets `JANGAR_GRPC_ENABLED` to `"0"` unless present in `controllers.env.vars`.
- Control plane gRPC behavior is implemented in:
  - `services/jangar/src/server/control-plane-grpc.ts`
  - `services/jangar/src/server/agentctl-grpc.ts`
- Cluster desired state sets gRPC enabled for control plane in `argocd/applications/agents/values.yaml`.

## Design
### Contract
- Controllers gRPC remains disabled by default.
- If controller gRPC is needed (e.g., for internal debugging), enable it explicitly with:
  - `controllers.env.vars.JANGAR_GRPC_ENABLED: "true"`
and require `controllers.service.enabled=true` (see chart design) to avoid “listening but unreachable” states.

### Additional guardrails
- Add a startup log line in controllers indicating whether gRPC server started.
- Add chart validation: if `controllers.env.vars.JANGAR_GRPC_ENABLED=true`, require `controllers.service.enabled=true`.

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_GRPC_ENABLED` | `JANGAR_GRPC_ENABLED` | Explicit opt-in for controllers gRPC server. |
| (unset) | `JANGAR_GRPC_ENABLED=0` | Default: controllers do not start gRPC server. |

## Rollout Plan
1. Document current forced default.
2. Add guardrails and optional Service support.
3. If needed, canary-enable controller gRPC in non-prod only.

Rollback:
- Remove the explicit env var and disable controller Service.

## Validation
```bash
helm template agents charts/agents --set controllers.enabled=true | rg -n \"JANGAR_GRPC_ENABLED\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"gRPC|Agentctl\"
```

## Failure Modes and Mitigations
- Operators think gRPC is enabled due to `grpc.enabled=true`: mitigate by documenting that it affects only the control plane.
- gRPC enabled without Service: mitigate with render-time validation and an opt-in Service template.

## Acceptance Criteria
- It is clear (from values + render) whether controllers will run gRPC.
- Enabling controller gRPC requires explicit opt-in and is not accidental.

## References
- gRPC basics: https://grpc.io/docs/what-is-grpc/introduction/


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
