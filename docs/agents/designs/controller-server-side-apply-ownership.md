# Controller Server-Side Apply and Field Ownership

Status: Draft (2026-02-07)
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

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
