# Controller Status: Timestamps + observedGeneration

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
Many Agents CRDs include `status.updatedAt` and `status.observedGeneration`. Consistent semantics across controllers are essential for debugging, automation, and eventual UI/CLI behavior.

This doc defines a consistent contract and identifies places in code that should be aligned.

## Goals
- Define consistent meanings for:
  - `status.observedGeneration`
  - `status.updatedAt`
  - `status.startedAt` / `status.finishedAt` where relevant
- Ensure controllers update these fields in a predictable way.

## Non-Goals
- Redesigning full status schemas for every CRD.

## Current State
- CRD types include these fields in Go:
  - `services/jangar/api/agents/v1alpha1/types.go` (e.g. `AgentStatus`, `AgentRunStatus`)
- Controllers update status using helpers (varies by resource):
  - `services/jangar/src/server/agents-controller.ts` uses `setStatus(...)` patterns and sets `observedGeneration` and timestamps in many flows.
  - Webhook status updates in `services/jangar/src/server/implementation-source-webhooks.ts` set `observedGeneration` for ImplementationSource.
- Chart does not map any values for this behavior (code-defined).

## Design
### Contract
- `observedGeneration`:
  - Set to `.metadata.generation` of the last reconciled spec that produced the current status.
- `updatedAt`:
  - Update whenever the controller writes status (even if phase unchanged).
- `startedAt` / `finishedAt`:
  - `startedAt`: first transition into Running.
  - `finishedAt`: first transition into a terminal phase.
  - Must be immutable once set.

### Implementation alignment
- Add a shared helper module for timestamp/observedGeneration updates and use it across controllers.
- Add unit tests to lock semantics (parallel to existing `agents-controller.test.ts`).

## Config Mapping
| Config surface | Behavior |
|---|---|
| (code only) | Status semantics are not configurable; must be consistent by convention and tests. |

## Rollout Plan
1. Document semantics and add tests enforcing immutability of startedAt/finishedAt.
2. Refactor controllers to use shared helpers.

Rollback:
- Revert refactor; keep tests/docs.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.generation} {.status.observedGeneration} {.status.startedAt} {.status.finishedAt} {.status.updatedAt}'; echo
```

## Failure Modes and Mitigations
- observedGeneration lag makes status misleading: mitigate by updating observedGeneration on every successful reconcile of spec.
- updatedAt not updated hides active reconciliation: mitigate with shared helper and tests.

## Acceptance Criteria
- All controllers follow the same semantics for observedGeneration and timestamps.
- startedAt/finishedAt are immutable once set.

## References
- Kubernetes generation and status patterns: https://kubernetes.io/docs/concepts/overview/working-with-objects/kubernetes-objects/

