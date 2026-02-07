# Controller Server-Side Apply and Field Ownership

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
Controllers currently use `kubectl apply` (client-side) for many operations, and `kubectl apply --server-side --subresource=status` for status updates. Server-side apply (SSA) provides clear field ownership and reduces merge conflicts when multiple actors mutate the same objects.

This doc proposes standardizing SSA usage and setting explicit field managers.

## Goals
- Use SSA for status updates consistently (already present).
- Evaluate SSA for spec/apply operations where multiple writers exist.
- Reduce conflicts and improve auditability of field ownership.

## Non-Goals
- Rewriting controllers to use the Kubernetes Go client.

## Current State
- Kubernetes operations are executed via `kubectl`:
  - `services/jangar/src/server/primitives-kube.ts`
- SSA is currently used only for status apply:
  - `applyStatus`: `kubectl apply --server-side --subresource=status ...`
- Regular `apply` uses `kubectl apply -f -` without SSA.

## Design
### SSA policy
- Continue SSA for status with a stable field manager:
  - Add `--field-manager=jangar-controllers` to SSA calls.
- For spec/apply operations:
  - Use SSA only when controllers should own specific fields and conflicts are likely.
  - Otherwise keep client-side apply to reduce surprise conflicts.

### Implementation changes
- Update `applyStatus` in `primitives-kube.ts` to include `--field-manager`.
- Add an alternate `applyServerSide` method (optional) with the same field manager.

## Config Mapping
| Proposed Helm value | Env var | Intended behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_KUBECTL_FIELD_MANAGER` | `JANGAR_KUBECTL_FIELD_MANAGER` | Allows overriding the field manager name (default `jangar-controllers`). |

## Rollout Plan
1. Add field-manager to SSA status apply (low risk).
2. Canary in non-prod and check managedFields in CR status updates.
3. Evaluate SSA for spec apply paths case-by-case.

Rollback:
- Remove the `--field-manager` flag; SSA still works with default manager.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.metadata.managedFields[*].manager}'; echo
```

## Failure Modes and Mitigations
- Field ownership conflicts prevent apply: mitigate with targeted SSA usage and explicit field manager.
- ManagedFields growth increases object size: mitigate by avoiding SSA where unnecessary.

## Acceptance Criteria
- Status updates use a stable field manager name.
- Operators can inspect managed fields to understand what controllers own.

## References
- Kubernetes Server-Side Apply: https://kubernetes.io/docs/reference/using-api/server-side-apply/

