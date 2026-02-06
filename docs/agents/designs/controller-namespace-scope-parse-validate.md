# Controller Namespace Scope: Parse + Validate

Status: Draft (2026-02-06)

## Overview
Namespace scoping is a primary safety control for Agents controllers. The controllers accept a namespaces list via env vars (`JANGAR_AGENTS_CONTROLLER_NAMESPACES`, `JANGAR_PRIMITIVES_NAMESPACES`). Invalid JSON or ambiguous inputs can lead to unexpected reconciliation scope.

This doc proposes strict parsing and validation rules plus chart-side guardrails.

## Goals
- Ensure namespace scope parsing is strict, deterministic, and observable.
- Prevent accidental broad scopes due to parsing fallbacks.

## Non-Goals
- Multi-namespace controller architecture changes.

## Current State
- Chart renders namespace lists into env vars:
  - `charts/agents/templates/deployment-controllers.yaml` sets `JANGAR_PRIMITIVES_NAMESPACES` and `JANGAR_AGENTS_CONTROLLER_NAMESPACES` via `agents.controllerNamespaces`.
- Runtime parsing helpers exist in `services/jangar/src/server/agents-controller.ts`:
  - `parseEnvArray`, `parseEnvList`, `parseEnvStringList`.
- Namespace scoping helpers live in `services/jangar/src/server/namespace-scope.ts`.

## Design
### Accepted formats
Support exactly:
- JSON array: `["agents","agents-ci"]`
- Comma-separated list: `agents,agents-ci`

### Validation rules (fail-fast)
- Empty list is invalid unless `rbac.clusterScoped=true` and wildcard `*` is explicitly present.
- Reject invalid JSON (do not silently fall back to CSV).
- Reject namespaces with whitespace or invalid DNS label characters.

### Observability
- Log the resolved namespace list at startup.
- Expose it via a controller health endpoint (if available).

## Config Mapping
| Helm value | Env var | Intended behavior |
|---|---|---|
| `controller.namespaces` | `JANGAR_AGENTS_CONTROLLER_NAMESPACES` | Canonical scope for agents reconciliation. |
| `controller.namespaces` | `JANGAR_PRIMITIVES_NAMESPACES` | Canonical scope for primitives reconciliation. |

## Rollout Plan
1. Add strict parsing behind a feature flag (warn-only mode).
2. Canary in non-prod by intentionally injecting invalid values and confirming rejection.
3. Promote to fail-fast in prod.

Rollback:
- Disable strict parsing flag.

## Validation
```bash
kubectl -n agents get deploy agents-controllers -o yaml | rg -n \"JANGAR_AGENTS_CONTROLLER_NAMESPACES|JANGAR_PRIMITIVES_NAMESPACES\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"namespaces\"
```

## Failure Modes and Mitigations
- Silent fallback expands scope: mitigate by rejecting invalid JSON rather than falling back.
- Mis-typed namespace blocks controllers startup: mitigate by clear error messages and GitOps revertability.

## Acceptance Criteria
- Invalid namespace scope config results in a clear startup failure.
- Resolved namespaces are logged and testable.

## References
- Kubernetes namespace naming: https://kubernetes.io/docs/concepts/overview/working-with-objects/names/


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
