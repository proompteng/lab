# CRD: AgentRun Idempotency Key Contract

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
AgentRun includes `spec.idempotencyKey`. This field is intended to avoid duplicate runs when clients retry requests. Without a contract (scope, retention, collision handling), the field is under-specified.

This doc defines idempotency behavior and how controllers should implement it.

## Goals
- Ensure a given idempotency key creates at most one effective execution per scope.
- Provide predictable behavior for retries and duplicates.

## Non-Goals
- Exactly-once execution across cluster failures.

## Current State
- Field exists in Go types: `services/jangar/api/agents/v1alpha1/types.go` (`AgentRunSpec.IdempotencyKey`).
- Controller currently deduplicates webhook-driven orchestration submissions via DB store (`orchestration-submit.ts`), but AgentRun idempotency is not explicitly implemented/documented.

## Design
### Scope
- Idempotency key scope is `(namespace, agentRef.name, idempotencyKey)`.

### Behavior
- On creating a new AgentRun:
  - If another AgentRun exists with same scope and is non-terminal: reject creation with a clear error.
  - If terminal: return the existing run reference (or allow new run only if `force=true` via a separate mechanism).

### Implementation approach
- Add an index (DB-side) or controller cache keyed by the tuple above.
- Prefer durable store (DB) so restarts don’t break idempotency.

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_AGENTRUN_IDEMPOTENCY_ENABLED` | toggle | Allows phased rollout (default `true`). |
| `controllers.env.vars.JANGAR_AGENTRUN_IDEMPOTENCY_RETENTION_DAYS` | retention | How long to remember keys after terminal completion. |

## Rollout Plan
1. Implement as best-effort in-controller cache (warn-only) in non-prod.
2. Promote to durable store-based enforcement in prod.

Rollback:
- Disable enforcement and rely on client-side de-dupe.

## Validation
```bash
kubectl -n agents apply -f charts/agents/examples/agentrun-sample.yaml
kubectl -n agents apply -f charts/agents/examples/agentrun-sample.yaml
kubectl -n agents get agentrun -o json | rg -n \"idempotencyKey\"
```

## Failure Modes and Mitigations
- Key collisions across unrelated workloads: mitigate by scoping to agentRef and namespace.
- Retention too short allows duplicates: mitigate by conservative default retention and pruning.

## Acceptance Criteria
- Duplicate creates with same idempotency key do not create duplicate effective runs.
- Behavior is consistent across controller restarts.

## References
- HTTP request idempotency (general definition): https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods
