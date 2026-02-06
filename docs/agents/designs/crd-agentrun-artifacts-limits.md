# CRD: AgentRun Artifacts Limits and Schema

Status: Draft (2026-02-06)

## Overview
AgentRun status can accumulate artifacts, logs, and metadata. Without limits and schema conventions, status can grow large, exceed Kubernetes object size limits, and create performance issues for controllers and clients.

This doc defines size and count limits plus a recommended artifact schema.

## Goals
- Bound AgentRun status size.
- Keep artifact references lightweight (store large content externally).
- Provide predictable retrieval patterns for operators.

## Non-Goals
- Designing the external artifact store (handled elsewhere).

## Current State
- AgentRun status includes `artifacts []Artifact` in Go types:
  - `services/jangar/api/agents/v1alpha1/types.go`
- Controller writes artifacts into status during run reconciliation:
  - `services/jangar/src/server/agents-controller.ts`
- CRD schema is generated in `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`.

## Design
### Limits (recommended)
- `status.artifacts`:
  - Max entries: 50
  - Max per-entry URL length: 2048
  - No inline binary data
- Enforce limits by:
  - Dropping oldest artifacts beyond limit, or
  - Storing only pointers (S3 URL, object key) in status.

### Schema conventions
Each artifact entry should include:
- `type` (e.g. `log`, `diff`, `report`)
- `uri` (external location)
- `contentType`
- `sizeBytes` (optional)

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_AGENTRUN_ARTIFACTS_MAX` | bound | Caps artifact list length in status. |
| `controllers.env.vars.JANGAR_AGENTRUN_ARTIFACTS_STRICT` | strictness | If true, fail run when artifacts exceed limits (default false). |

## Rollout Plan
1. Implement soft caps (drop oldest) and emit a warning condition.
2. Add optional strict mode for CI environments.

Rollback:
- Disable caps by setting max high (not recommended) or reverting code.

## Validation
```bash
kubectl -n agents get agentrun <name> -o jsonpath='{.status.artifacts}' | wc -c
kubectl -n agents get agentrun <name> -o yaml | rg -n \"artifacts:\"
```

## Failure Modes and Mitigations
- Status exceeds object size limits: mitigate by pointer-only artifacts and strict caps.
- Operators lose needed history due to trimming: mitigate by ensuring external store retains full artifact history.

## Acceptance Criteria
- AgentRun status stays under safe size limits under sustained use.
- Artifacts in status are always external references, not large inline payloads.

## References
- Kubernetes object size limits (etcd considerations): https://kubernetes.io/docs/concepts/overview/working-with-objects/annotations/

