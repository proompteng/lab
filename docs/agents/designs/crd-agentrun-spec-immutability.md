# CRD: AgentRun Spec Immutability Rules

Status: Draft (2026-02-07)

## Overview
AgentRuns represent a concrete execution request. After a run is accepted and started, mutating most of `spec` should be prohibited to preserve auditability and avoid undefined behavior (e.g., swapping implementation mid-run).

This doc defines which fields are mutable vs immutable and how controllers should enforce that.

## Goals
- Prevent unsafe spec mutations after acceptance/start.
- Provide clear, actionable errors for attempted mutations.

## Non-Goals
- Adding a full admission webhook; controller-side enforcement is sufficient initially.

## Current State
- AgentRun schema: `services/jangar/api/agents/v1alpha1/types.go` and `charts/agents/crds/agents.proompteng.ai_agentruns.yaml`.
- Controller reconciles AgentRuns and transitions phases/conditions:
  - `services/jangar/src/server/agents-controller.ts` (reconcileAgentRun, runtime submission, status updates).
- No explicit immutability enforcement is documented.

## Design
### Immutable after `Accepted=True` or `status.phase != Pending`
- `spec.agentRef`
- `spec.implementationSpecRef` / `spec.implementation`
- `spec.runtime` (type/config)
- `spec.workflow` steps (if present)
- `spec.secrets`
- `spec.systemPrompt` / `spec.systemPromptRef`
- `spec.vcsRef`, `spec.memoryRef`

### Mutable always (safe metadata-only)
- `metadata.labels` and annotations (except controller-owned labels)

### Enforcement
- Controller records a hash of the immutable spec fields in status at accept time, e.g.:
  - `status.specHash`
- On subsequent reconciles, if immutable fields differ:
  - Set `Succeeded=False`/`Ready=False` (resource-specific) and `phase=Failed` with reason `SpecImmutableViolation`.
  - Emit a Kubernetes Event (see controller events design).

## Config Mapping
| Helm value / env var (proposed) | Effect | Behavior |
|---|---|---|
| `controllers.env.vars.JANGAR_AGENTRUN_IMMUTABILITY_ENFORCED` | toggle | Allows phased rollout (default `true` in prod). |

## Rollout Plan
1. Implement in warn-only mode (log + condition) in non-prod.
2. Promote to fail/terminal failure in prod.

Rollback:
- Set `JANGAR_AGENTRUN_IMMUTABILITY_ENFORCED=false` to revert to warn-only.

## Validation
```bash
kubectl -n agents apply -f charts/agents/examples/agentrun-sample.yaml
kubectl -n agents patch agentrun <name> --type=merge -p '{\"spec\":{\"parameters\":{\"x\":\"y\"}}}'
kubectl -n agents get agentrun <name> -o yaml | rg -n \"SpecImmutableViolation|specHash|conditions\"
```

## Failure Modes and Mitigations
- Users rely on mutating pending runs: mitigate by allowing mutation only before acceptance and documenting clearly.
- Controller mis-identifies a harmless change: mitigate with a clearly defined immutable field set and tests.

## Acceptance Criteria
- Once accepted/started, spec mutations are rejected with a clear condition/reason.
- Before acceptance, allowed fields can still be updated safely.

## References
- Kubernetes immutability patterns (general objects): https://kubernetes.io/docs/concepts/overview/working-with-objects/kubernetes-objects/
## Handoff Appendix (Repo + Chart + Cluster)

Shared operational details (cluster desired state, render/validate commands): `docs/agents/designs/handoff-common.md`.

### This design’s touchpoints
- CRDs packaged by chart: `charts/agents/crds/`
- Go types (when generated): `services/jangar/api/agents/v1alpha1/`
- Validation pipeline: `scripts/agents/validate-agents.sh`

