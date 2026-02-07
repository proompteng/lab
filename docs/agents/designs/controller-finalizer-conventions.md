# Controller Finalizer Conventions

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
Finalizers ensure controllers can perform cleanup before an object is fully deleted (e.g., deleting external runtimes). Inconsistent finalizer naming and behavior can cause stuck deletions or skipped cleanup.

This doc defines naming conventions and lifecycle behavior for Agents controllers.

## Goals
- Standardize finalizer naming and behavior.
- Ensure deletion cleanup is best-effort but does not deadlock deletion.

## Non-Goals
- Guaranteeing cleanup success in all cases (network outages, permission failures).

## Current State
- AgentRun uses a runtime cleanup finalizer:
  - `services/jangar/src/server/agents-controller.ts` uses finalizer `agents.proompteng.ai/runtime-cleanup`.
- Cleanup attempts call `cancelRuntime(...)` and then remove the finalizer via patch.
- Other CRDs may not use finalizers consistently.

## Design
### Naming
- Format: `<group>/<purpose>` under the API group domain, e.g.:
  - `agents.proompteng.ai/runtime-cleanup`
  - `orchestration.proompteng.ai/runtime-cleanup` (if needed)

### Behavior
- On deletion timestamp:
  - Attempt cleanup with bounded timeouts.
  - Never re-add finalizers once deletion has started.
  - Always remove the finalizer after cleanup attempt, even on failure (log error).

## Config Mapping
| Proposed env var | Intended behavior |
|---|---|
| `JANGAR_CONTROLLER_FINALIZER_CLEANUP_TIMEOUT_MS` | Upper bound for cleanup steps before removing finalizer anyway. |

## Rollout Plan
1. Document naming conventions and current AgentRun behavior.
2. Add bounded-time cleanup and ensure finalizer removal happens even on failure.
3. Add tests covering deletion paths for AgentRun (and others if applicable).

Rollback:
- Revert cleanup timeout logic; keep naming conventions.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.finalizers}'; echo
kubectl -n agents delete agentrun <name> --wait=false
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.deletionTimestamp}'; echo
```

## Failure Modes and Mitigations
- Finalizer never removed, object stuck deleting: mitigate with bounded cleanup time and “remove anyway” behavior.
- Cleanup fails silently: mitigate with explicit logs/events on cleanup failure.

## Acceptance Criteria
- Deleting an AgentRun does not deadlock due to cleanup failures.
- Finalizer names are consistent and documented.

## References
- Kubernetes finalizers: https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/

