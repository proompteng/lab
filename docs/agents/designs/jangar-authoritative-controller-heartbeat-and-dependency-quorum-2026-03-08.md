# Jangar Authoritative Controller Heartbeat and Dependency Quorum (2026-03-08)

Status: Proposed (2026-03-08)

## Summary

Current `/api/agents/control-plane/status` responses derive controller health from the process that serves the HTTP
request. In a split topology, that is not authoritative.

Live evidence on `2026-03-08` shows:

- the `agents` web service serves control-plane status from pods where controller workloads are disabled;
- the actual controller workloads run in the separate `agents-controllers` deployment;
- Torghut reads dependency quorum from the status route and therefore receives false `agents_controller_unavailable`
  and `workflow_runtime_unavailable` block reasons even while the real controller deployment is healthy.

This design introduces a topology-agnostic heartbeat-backed status contract so any Jangar status-serving pod can return
authoritative controller/runtime truth.

## Objectives

- Make controller and runtime-adapter status truthful across split web/controller deployments.
- Keep `/api/agents/control-plane/status` backward-compatible while improving authority semantics.
- Allow remote consumers such as Torghut to treat dependency quorum as promotion-grade input.
- Avoid requiring consumers to know which deployment currently hosts the authoritative controller workload.

## Problem Statement

The current control-plane status route conflates:

- "this HTTP pod is not running controllers", and
- "the cluster has no healthy controllers for this namespace".

That behavior was acceptable in a single-binary or single-deployment topology, but it is wrong in the current split
deployment layout:

- `agents` deployment: status-serving web surface, controllers disabled
- `agents-controllers` deployment: actual controller workloads enabled

Because dependency quorum is derived from local controller/runtime state, remote consumers can block on a false
negative even when the cluster is operational.

## Evidence

### Live cluster evidence

- `kubectl get deploy -n agents agents agents-controllers -o wide`
- `kubectl get deploy jangar -n jangar -o yaml | rg -n 'JANGAR_.*CONTROLLER_ENABLED' -C 2`
- `kubectl get deploy agents-controllers -n agents -o yaml | rg -n 'JANGAR_.*CONTROLLER_ENABLED' -C 2`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq`

Observed on `2026-03-08`:

- `jangar` and `agents` web services report controllers as `disabled`;
- `agents-controllers` deployment has controller env vars enabled;
- Torghut consumes dependency quorum from a Jangar status URL and therefore treats the dependency as blocked.

### Source evidence

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/agents-controller/index.ts`
- `services/jangar/src/server/orchestration-controller.ts`
- `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/torghut/app/trading/hypotheses.py`

## Chosen Design

### 1. Introduce authoritative heartbeat rows for controller/runtime ownership

Add a shared heartbeat store written by the workloads that actually own controller/runtime authority.

Minimum heartbeat dimensions:

- `namespace`
- `component`
  - `agents-controller`
  - `supporting-controller`
  - `orchestration-controller`
  - `workflow-runtime`
  - optional future runtime adapters
- `workload_role`
  - `web`
  - `controllers`
  - other future roles if needed
- `pod_name`
- `deployment_name`
- `enabled`
- `status`
  - `healthy`
  - `degraded`
  - `disabled`
  - `unknown`
- `message`
- `leadership_state`
  - `leader`
  - `follower`
  - `not-applicable`
- `observed_at`
- `expires_at`

Only workloads that actually own the component may write authoritative heartbeats for that component.

Examples:

- `agents-controllers` may write `agents-controller`, `supporting-controller`, `orchestration-controller`, and
  `workflow-runtime`.
- `agents` web pods may publish `workload_role=web`, but they do not publish authoritative controller heartbeats when
  controllers are disabled locally.

### 2. Compute status from the freshest authoritative heartbeat, not local process flags

Update `control-plane-status.ts` so component status resolution becomes:

1. read the freshest non-expired authoritative heartbeat for the requested namespace/component;
2. if present, use that heartbeat as the status source;
3. if missing, return `status=unknown` with explicit authority-loss metadata;
4. never treat "controller disabled in this web pod" as equivalent to "controller unavailable in cluster" unless the
   web pod is also the authoritative workload for that component.

This preserves fail-closed behavior while removing the current false-disabled outcome.

### 3. Add authority metadata to the status payload

Extend the status payload with an additive `authority` envelope:

- `authority.mode`: `heartbeat | local | unknown`
- `authority.namespace`
- `authority.source_deployment`
- `authority.source_pod`
- `authority.observed_at`
- `authority.fresh`
- `authority.message`

This makes topology truth visible to operators and downstream consumers.

### 4. Derive dependency quorum from authoritative rows

`buildDependencyQuorum()` should consume the resolved authoritative component states rather than directly reading local
controller/runtime health objects from the serving pod.

Behavior change:

- authoritative `healthy` keeps current semantics;
- authoritative `degraded` keeps current `delay` / `block` classification;
- missing authority becomes `unknown` with explicit reason such as `agents_controller_status_unknown`;
- false local `disabled` no longer causes `agents_controller_unavailable`.

### 5. Preserve route compatibility for remote consumers

Keep the existing status route shape and query semantics:

- `/api/agents/control-plane/status?namespace=agents`

This allows Torghut and other consumers to keep their current integration shape while gaining truthful results after
the new contract lands.

## Storage Choice

Preferred implementation: persist heartbeats in the Jangar database.

Rationale:

- any status-serving pod can read the same shared state;
- existing control-plane status already depends on database-backed context;
- DB rows support freshness windows and historical debugging better than in-memory state;
- no new service discovery hop is required for consumers.

Alternative acceptable implementation:

- shared ConfigMap or lease-backed heartbeat with bounded freshness metadata.

Not selected as the primary design:

- direct proxying from web pods to controller pods/services.

That would couple the route to deployment topology and service discovery more tightly than necessary.

## Alternatives Considered

- Alternative A: point Torghut directly at the controller deployment.
  - Pros: fast to wire if a dedicated service exists.
  - Cons: hard-codes topology and still leaves status-serving web surfaces untruthful for other consumers.
- Alternative B: keep local status semantics and document the limitation.
  - Pros: zero implementation work.
  - Cons: not acceptable for promotion-grade readiness decisions.
- Alternative C: proxy status requests from web pods to controller pods.
  - Pros: closer to authoritative truth than local flags.
  - Cons: adds another availability dependency and keeps topology as part of the API contract.
- Alternative D: chosen approach, heartbeat-backed authoritative state.
  - Pros: topology-agnostic, cacheable, debuggable, and safe for remote consumers.
  - Cons: requires shared-state schema and heartbeat writers.

## Proposed Implementation Slices

1. Add shared heartbeat storage and types.
2. Teach authoritative workloads to write heartbeats on start, leadership changes, and periodic refresh.
3. Refactor `control-plane-status.ts` to resolve component state from heartbeats.
4. Add `authority` metadata to the status payload and UI/consumer types.
5. Update Torghut and other consumers to treat `unknown` authority as non-promotable.
6. Add regression tests for split-deployment topology where web pods are disabled locally but controllers are healthy
   elsewhere.

## Validation Plan

- Unit tests:
  - heartbeat freshness/expiry resolution
  - authoritative-vs-local precedence
  - dependency quorum classification from heartbeat state
- Integration tests:
  - split topology with web deployment `controllers disabled` and separate controller deployment `controllers enabled`
  - route still returns healthy dependency quorum when authoritative heartbeat is fresh
  - route returns `unknown`, not false `disabled`, when heartbeat authority is missing
- Manual cluster checks:
  - compare `/api/agents/control-plane/status?namespace=agents` against `kubectl get deploy agents-controllers -n agents`
  - verify Torghut stops blocking on false `agents_controller_unavailable`

## Risks

- Heartbeat expiry thresholds that are too aggressive can convert transient delays into `unknown`.
- If multiple authoritative writers exist accidentally, precedence rules must remain deterministic.
- Database outages will degrade status authority; the route should fail closed to `unknown`, not invent healthy state.

## Recommended Rollout

1. Land heartbeat-backed status resolution in Jangar.
2. Verify both `jangar` and `agents` web surfaces return the same authoritative result for `namespace=agents`.
3. Update Torghut to continue using the status route only after the authoritative contract is live.
4. Treat any missing or stale authority as a promotion block until freshness recovers.

## Handoff

- Jangar owners: implement heartbeat storage, writers, and status-route resolution.
- Torghut owners: keep dependency quorum fail-closed and validate that promotion decisions now reflect the actual
  `agents` controller topology.
