# Orchestration Submit Deduplication (Delivery ID)

Status: Draft (2026-02-06)

## Overview
Orchestration run submission is triggered by external events (e.g., webhooks). Duplicate deliveries are common. The current system deduplicates submissions by `deliveryId` using the primitives store.

This doc formalizes the dedupe contract and proposes chart/controller knobs to keep it safe in production.

## Goals
- Guarantee idempotent orchestration submissions per `(namespace, orchestrationRef, deliveryId)`.
- Ensure dedupe state is durable across controller restarts.

## Non-Goals
- Exactly-once processing across multiple clusters.

## Current State
- Submission code: `services/jangar/src/server/orchestration-submit.ts`
  - Looks up `store.getOrchestrationRunByDeliveryId(input.deliveryId)` and returns existing run if present.
  - Applies an `OrchestrationRun` resource with label `jangar.proompteng.ai/delivery-id`.
- Store layer: `services/jangar/src/server/primitives-store.ts` (durable DB-backed store).
- Chart wiring for DB URL is required for controllers: `charts/agents/templates/deployment-controllers.yaml`.

## Design
### Contract
- `deliveryId` MUST be treated as globally unique per provider.
- If a duplicate `deliveryId` is received:
  - Return the existing `OrchestrationRun` record and (if present) the external CR state.
- Dedupe retention:
  - Keep dedupe records for a minimum window (e.g. 7 days) to handle delayed retries.

### Proposed config
- `JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` (default `7`)
- Store cleanup job (optional) to prune old dedupe rows.

## Config Mapping
| Proposed Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` | `JANGAR_ORCHESTRATION_DEDUPE_RETENTION_DAYS` | How long to retain dedupe records. |

## Rollout Plan
1. Document dedupe semantics and label usage.
2. Add retention config and a safe default.
3. Add a periodic cleanup job (optional) once validated in staging.

Rollback:
- Disable cleanup job and keep retention high.

## Validation
```bash
kubectl -n agents get orchestrationrun -l jangar.proompteng.ai/delivery-id --show-labels
kubectl -n agents logs deploy/agents-controllers | rg -n \"deliveryId|idempotent\"
```

## Failure Modes and Mitigations
- Dedupe table grows unbounded: mitigate with retention + cleanup job.
- deliveryId collisions between providers: mitigate by namespacing deliveryId with provider prefix if needed.

## Acceptance Criteria
- Duplicate deliveries do not create duplicate orchestration runs.
- Dedupe state survives controller restarts.

## References
- HTTP request idempotency (general definition): https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods

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
