# Jangar Control Plane Rollout Health Envelope (Discover Stage)

Status: Discover (2026-03-04)

## Summary

This design extends `/api/agents/control-plane/status` with rollout observability for the control-plane deployment set so operators can quickly identify when rollout health, not just controller/runtime/database checks, is the active control-plane risk.

## Objective

- Keep reliability signals centralized in the control-plane status endpoint.
- Improve triage latency by surfacing deployment rollout health with each status poll.
- Preserve endpoint availability and avoid endpoint failures when rollout checks are blocked by Kubernetes RBAC.

## Problem

`/api/agents/control-plane/status` already reports controller, runtime adapter, database, and watch indicators, but does not include direct rollout/deployment health. In several namespaces, deployment rollout failures occur while other health signals stay green, creating false confidence and delayed remediation.

## Proposed design

Add an additive `rollout_health` object to `ControlPlaneStatus` with:

- `status` (`healthy` | `degraded` | `unknown`)
- `observed_deployments`
- `degraded_deployments`
- `deployments` list (bounded by configured names)

Each deployment item contains:

- `name`, `namespace`
- `status` (`healthy` | `degraded` | `unknown` | `disabled`)
- `desired_replicas`, `ready_replicas`, `available_replicas`, `updated_replicas`, `unavailable_replicas`
- `message`

Implementation in `services/jangar/src/server/control-plane-status.ts`:

- Read deployment names from `JANGAR_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS` (default: `agents`).
- Query Kubernetes `deployments` for the target namespace.
- Evaluate deployment rollout by comparing replicas, unavailable pods, conditions (`Available`, `Progressing`), and observed generation.
- Include rollout status in namespace degraded component list.
- Return `unknown` without throwing if Kubernetes query fails.

## Implementation mapping

- Data contract updates: `services/jangar/src/data/agents-control-plane.ts`
- Server status computation: `services/jangar/src/server/control-plane-status.ts`
- UI rendering: `services/jangar/src/components/agents-control-plane-status.tsx`
- Tests: `services/jangar/src/server/__tests__/control-plane-status.test.ts`

## Alternatives considered

- A) Keep rollout state outside the status endpoint.
  - Pros: zero status contract impact.
  - Cons: continued MTTR increase for rollout-related incidents.
- B) Add a dedicated rollout endpoint.
  - Pros: richer rollout schema and lower coupling with existing status payload.
  - Cons: additional client and UI integration work, duplicate surface.
- C) Add rollout to the existing status envelope (selected).
  - Pros: incremental, minimal rollout risk, immediate operational visibility in one place.
  - Cons: adds one extra Kubernetes resource read dependency and payload growth.

## Tradeoffs and risks

- RBAC can block deployment reads from the current service account (`agents-sa` lacks `deployments.apps` list rights in `agents` namespace today). The implementation is intentionally non-blocking and degrades to `unknown` when access is denied.
- This design uses a configured deployment whitelist, so rollout coverage depends on naming and cluster conventions.

## Validation

- Unit tests cover:
  - healthy rollout path
  - degraded rollout path (replicas unavailable)
  - kube query error fallback (`unknown`)
- Existing status endpoint behavior remains additive and defensive.
