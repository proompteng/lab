# Controller Condition Type Taxonomy

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
Agents CRDs expose Kubernetes-style conditions (e.g. `Ready`, `Succeeded`, `Blocked`). Without a consistent taxonomy, automation and operator expectations diverge between resources.

This doc defines a minimal, consistent condition set and naming conventions.

## Goals
- Standardize condition types and meanings across Agents CRDs.
- Ensure conditions are stable, machine-consumable signals (not free-form logs).

## Non-Goals
- Defining every possible controller-specific reason code.

## Current State
- CRD types use `[]metav1.Condition`:
  - `services/jangar/api/agents/v1alpha1/types.go`
- Controllers construct and upsert conditions:
  - `services/jangar/src/server/agents-controller.ts` (`buildConditions`, `upsertCondition` usage for `Accepted`, `InProgress`, `Blocked`, etc.)
  - ImplementationSource webhook controller sets conditions similarly: `services/jangar/src/server/implementation-source-webhooks.ts`.
- No centralized spec exists for condition types and transitions.

## Design
### Recommended condition types
Across reconciled resources:
- `Ready`: resource is valid and reconciled.
- For run-like resources:
  - `Accepted`: controller accepted the run.
  - `InProgress`: work in progress.
  - `Succeeded`: terminal success.
  - `Failed`: terminal failure.
  - `Cancelled`: terminal cancellation (when applicable).
- Optional:
  - `Blocked`: policy/concurrency blocked.

### Transition rules
- Only one terminal condition (`Succeeded`/`Failed`/`Cancelled`) may be `True` at a time.
- `Ready` should be `False` when terminal failure is reached, or be omitted if not meaningful.

## Config Mapping
| Surface | Behavior |
|---|---|
| (code only) | Condition taxonomy is a controller contract; enforce via tests and docs. |

## Rollout Plan
1. Document the taxonomy and update controller code to match.
2. Add unit tests that validate terminal condition exclusivity and stable type names.

Rollback:
- Revert controller changes; keep doc and tests for future alignment.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.status.conditions[*].type}'; echo
kubectl -n agents get agentrun <name> -o jsonpath='{.status.conditions[?(@.type==\"Succeeded\")].status}'; echo
```

## Failure Modes and Mitigations
- Multiple terminal conditions become true: mitigate with a shared condition helper enforcing exclusivity.
- Controllers use inconsistent type strings: mitigate by constants and tests.

## Acceptance Criteria
- Condition types are consistent across CRDs and reconciler code.
- Automation can reliably determine run state from conditions alone.

## References
- Kubernetes API conventions (Conditions): https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties

