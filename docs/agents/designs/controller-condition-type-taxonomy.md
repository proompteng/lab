# Controller Condition Type Taxonomy

Status: Draft (2026-02-07)

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
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- Controller code: `services/jangar/src/server/` (see the doc’s **Current State** section for the exact files)
- Chart wiring (env/args/volumes): `charts/agents/templates/deployment-controllers.yaml`
- GitOps overlay (prod): `argocd/applications/agents/values.yaml`

