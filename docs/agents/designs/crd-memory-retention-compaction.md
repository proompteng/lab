# CRD: Memory Retention and Compaction

Status: Draft (2026-02-06)

## Overview
The `Memory` CRD represents stored context/embeddings. Without retention controls and compaction, memory stores can grow without bound, increasing storage cost and slowing queries. This doc defines retention and compaction semantics managed by controllers.

## Goals
- Provide per-Memory retention policy.
- Define compaction behavior and safety controls.

## Non-Goals
- Defining embedding model selection (separate concern).

## Current State
- Memory CRD exists:
  - Go: `services/jangar/api/agents/v1alpha1/types.go` (Memory types)
  - CRD: `charts/agents/crds/agents.proompteng.ai_memories.yaml`
- Memory runtime and storage code lives in:
  - `services/jangar/src/server/memories.ts`
  - `services/jangar/src/server/memories-store.ts`
- Chart values do not expose memory retention controls.

## Design
### API shape
Add to Memory spec:
```yaml
spec:
  retention:
    maxItems: 10000
    maxAgeDays: 90
  compaction:
    enabled: true
    strategy: "drop-oldest"
```

### Controller behavior
- Periodically scan Memory objects and enforce:
  - Drop items older than `maxAgeDays`
  - Drop oldest beyond `maxItems`
- Emit conditions/events when compaction occurs.

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_MEMORY_COMPACTION_ENABLED` | toggle | Enables background compaction loop. |
| `controllers.env.vars.JANGAR_MEMORY_COMPACTION_INTERVAL` | schedule | Controls how often compaction runs. |

## Rollout Plan
1. Add API fields with defaults that preserve current behavior (no compaction unless enabled).
2. Canary in non-prod with a small Memory and verify compaction.
3. Enable in prod with conservative defaults and monitoring.

Rollback:
- Disable compaction loop; stop enforcing retention fields.

## Validation
```bash
kubectl -n agents get memory -o yaml | rg -n \"retention:|compaction:|conditions\"
kubectl -n agents logs deploy/agents-controllers | rg -n \"compaction|retention\"
```

## Failure Modes and Mitigations
- Over-aggressive retention deletes useful context: mitigate with conservative defaults and “dry-run mode” first.
- Compaction loop increases DB load: mitigate with interval controls and batching.

## Acceptance Criteria
- Memory growth can be bounded by policy.
- Compaction is observable and reversible (disable loop).

## References
- Kubernetes controllers (background reconciliation): https://kubernetes.io/docs/concepts/architecture/controller/

