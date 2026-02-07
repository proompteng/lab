# Orchestration Submit Deduplication (Delivery ID)

Status: Draft (2026-02-06)

## Production / GitOps (source of truth)
These design notes are kept consistent with the live *production desired state* (GitOps) and the in-repo `charts/agents` chart.

### Current production deployment (desired state)
- Namespace: `agents`
- Argo CD app: `argocd/applications/agents/application.yaml`
- Helm via kustomize: `argocd/applications/agents/kustomization.yaml` (chart `charts/agents`, chart version `0.9.1`, release `agents`)
- Values overlay: `argocd/applications/agents/values.yaml` (pins images + digests, DB SecretRef, gRPC, and `envFromSecretRefs`)
- Additional in-cluster resources (GitOps-managed): `argocd/applications/agents/*.yaml` (Agent/Provider, SecretBinding, VersionControlProvider, samples)

### Chart + code (implementation)
- Chart entrypoint: `charts/agents/Chart.yaml`
- Values + schema: `charts/agents/values.yaml`, `charts/agents/values.schema.json`
- Templates: `charts/agents/templates/`
- CRDs installed by the chart: `charts/agents/crds/`
- Example CRs: `charts/agents/examples/`
- Control plane + controllers code: `services/jangar/src/server/`

### Values ↔ env mapping (common)
- `.Values.env.vars` → base Pod `env:` for control plane + controllers (merged; component-local values win).
- `.Values.controlPlane.env.vars` → control plane-only overrides.
- `.Values.controllers.env.vars` → controllers-only overrides.
- `.Values.envFromSecretRefs[]` → Pod `envFrom.secretRef` (Secret keys become env vars at runtime).

### Rollout + validation (production)
- Rollout path: edit `argocd/applications/agents/` (and/or `charts/agents/`), commit, and let Argo CD sync.
- Render exactly like Argo CD (Helm v3 + kustomize):
  ```bash
  helm lint charts/agents
  mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.rendered.yaml
  ```
- Validate in-cluster (requires RBAC allowing reads in `agents`):
  ```bash
  kubectl -n agents get deploy,svc,pdb,cm
  kubectl -n agents describe deploy agents
  kubectl -n agents describe deploy agents-controllers || true
  kubectl -n agents logs deploy/agents --tail=200
  kubectl -n agents logs deploy/agents-controllers --tail=200 || true
  ```

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
