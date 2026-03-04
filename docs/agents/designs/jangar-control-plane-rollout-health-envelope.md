# Jangar Control Plane Rollout Health Envelope (Discover Stage)

Status: Implemented (2026-03-04)

## Summary

This design extends `/api/agents/control-plane/status` with rollout observability for the control-plane deployment set so operators can quickly identify when rollout health, not just controller/runtime/database checks, is the active control-plane risk. It has been implemented in PR `#4040` with defensive fallback behavior when cluster read access is restricted.

## Objective

- Keep reliability signals centralized in the control-plane status endpoint.
- Improve triage latency by surfacing deployment rollout health with each status poll.
- Preserve endpoint availability and avoid endpoint failures when rollout checks are blocked by Kubernetes RBAC.

## Problem

`/api/agents/control-plane/status` already reports controller, runtime adapter, database, and watch indicators, but did not include direct rollout/deployment health. In this cluster, deployment rollout instability (including repeated implement `BackoffLimitExceeded` events) is only visible through logs/events, while other status surfaces can remain green. In addition, `deployments.apps` reads can fail for the current service account, so rollout signals were missing entirely from status.

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

## Assessment context

- Cluster evidence collected (read-only):
  - `schedules.schedules.proompteng.ai` shows `discover`, `implement`, `plan`, and `verify` schedules in `Active`.
  - `CronJob` objects for all four stages are present and not suspended.
  - Events include repeated implement-stage backoff failures (`BackoffLimitExceeded`) for jobs like `jangar-control-plane-implement-sched-z5lgp`.
  - `kubectl` against `deployments.apps` with the in-cluster `agents-sa` service account returns `forbidden` in `agents` namespace.
- Source/data findings:
  - `services/jangar/src/server/control-plane-status.ts` already has robust degradation patterns, so rollout health can be added without endpoint fragility.
  - Data contract updates are additive in `services/jangar/src/data/agents-control-plane.ts`.
  - Deployment rollout view is rendered by existing UI component in `services/jangar/src/components/agents-control-plane-status.tsx`.
  - Tests were added in `services/jangar/src/server/__tests__/control-plane-status.test.ts` for healthy, degraded, and fallback paths.
- Data/schema review:
  - Existing migration consistency signal is preserved in status (`migration_consistency`).
  - No schema migration is required for rollout health because it is read-only and derived from runtime APIs.

## Implementation mapping

- Data contract updates: `services/jangar/src/data/agents-control-plane.ts`
- Server status computation: `services/jangar/src/server/control-plane-status.ts`
- UI rendering: `services/jangar/src/components/agents-control-plane-status.tsx`
- Tests: `services/jangar/src/server/__tests__/control-plane-status.test.ts`

## Alternatives considered

- A) Keep rollout state outside the status endpoint.
  - Pros: zero status contract impact.
  - Cons: continued MTTR increase for rollout-related incidents and poor visibility in primary operators’ workflow.
- B) Add a dedicated rollout endpoint.
  - Pros: richer rollout schema and lower coupling with existing status payload.
  - Cons: additional client integration work and duplicate operational surfaces.
- C) Add rollout to the existing status envelope (selected).
  - Pros: incremental, minimal rollout risk, immediate operational visibility in one place.
  - Cons: adds one extra Kubernetes resource read dependency and payload growth.
- D) Defer rollout signals and rely on external monitoring tools.
  - Pros: no API contract changes.
  - Cons: no unified reliability envelope and late discovery during incidents.

## Tradeoffs and risks

- RBAC can block deployment reads from the current service account (`agents-sa` lacks `deployments.apps` list rights in `agents` namespace). The implementation is intentionally non-blocking and degrades to `unknown`.
- Rollout coverage depends on the configured deployment whitelist (`JANGAR_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS`), so missing names create blind spots.
- Health visibility remains bounded by schedule cadence and API propagation timing for some edge transitions.
- Increased payload size is constrained and additive, but still introduces another status surface for clients to display.

## Validation

- Unit tests cover:
  - healthy rollout path
  - degraded rollout path (replicas unavailable)
  - kube query error fallback (`unknown`)
  - existing schedule health path unaffected
- Existing status endpoint behavior remains additive and defensive.

## Merge status

- PR: https://github.com/proompteng/lab/pull/4040
- Code and design update: implemented and aligned with source.
- Current CI status at latest poll: all required checks pass except repository `integration`.
