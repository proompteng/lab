# Controller Failed Reconcile: Kubernetes Events

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
When reconciles fail, the current primary signal is logs (and possibly status conditions). Kubernetes Events are a useful operational tool (visible via `kubectl describe`) and can improve MTTR, especially for failures like missing secrets, RBAC, or invalid spec fields.

## Goals
- Emit Kubernetes Events for actionable reconcile failures.
- Avoid noisy event storms for transient errors.

## Non-Goals
- Replacing logs or status conditions.

## Current State
- Controllers update status for many CRDs via `setStatus(...)` helpers:
  - `services/jangar/src/server/agents-controller.ts`
  - `services/jangar/src/server/implementation-source-webhooks.ts` (status updates)
- Kubernetes client wrapper currently supports listing Events but not creating them:
  - `services/jangar/src/server/primitives-kube.ts` includes `listEvents(...)` but no `createEvent(...)`.
- The chart does not configure event emission.

## Design
### Event emission rules
- For non-retryable spec/config errors:
  - Emit `Warning` event with a stable reason (e.g. `InvalidSpec`, `MissingSecret`, `Forbidden`).
- For transient errors:
  - Update status condition + log; emit an event only on first occurrence and then rate-limit (per-object).

### Implementation approach
- Extend `KubernetesClient` in `primitives-kube.ts` to support creating Events:
  - Use `events.k8s.io/v1` if available; fall back to `v1` Events if necessary.
- Add an event helper in controllers to avoid duplication and to enforce rate limiting.

## Config Mapping
| Helm value (proposed) | Env var (proposed) | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_CONTROLLER_EVENTS_ENABLED` | `JANGAR_CONTROLLER_EVENTS_ENABLED` | Enables/disables event emission (default `true`). |
| `controllers.env.vars.JANGAR_CONTROLLER_EVENTS_RATE_LIMIT_PER_MIN` | `JANGAR_CONTROLLER_EVENTS_RATE_LIMIT_PER_MIN` | Caps event spam per object. |

## Rollout Plan
1. Add event emission behind `JANGAR_CONTROLLER_EVENTS_ENABLED=true` with conservative rate limits.
2. Canary in non-prod and confirm event volume is manageable.
3. Enable in prod; document common reasons in runbooks.

Rollback:
- Set `JANGAR_CONTROLLER_EVENTS_ENABLED=false`.

## Validation
```bash
kubectl -n agents get events --sort-by=.metadata.creationTimestamp | tail -n 50
kubectl -n agents describe agentrun <name> | rg -n \"Events:\"
```

## Failure Modes and Mitigations
- Event storms during reconcile loops: mitigate with strict per-object rate limiting and “first occurrence only” logic.
- Events leak sensitive info: mitigate by sanitizing messages and never including secret values.

## Acceptance Criteria
- Non-retryable spec errors produce a Kubernetes Event with a stable reason.
- Event volume remains bounded under failure conditions.

## References
- Kubernetes Events: https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.30/#event-v1-core

