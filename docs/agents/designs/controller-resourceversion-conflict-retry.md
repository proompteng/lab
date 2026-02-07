# Controller ResourceVersion Conflicts and Retry Strategy

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

