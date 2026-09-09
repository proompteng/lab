# 49. Jangar Control-Plane Authority Ledger and Expiry Watchdog (2026-03-19)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-19`
Owner: Victor Chen (Jangar Engineering Architecture)
Related mission: `codex/swarm-jangar-control-plane-discover`
Swarm: `jangar-control-plane`
Supersedes/extends:

- `44-jangar-control-plane-segmented-failure-domain-and-safe-rollout-contract-2026-03-16.md`
- `47-jangar-control-plane-resilience-and-torghut-profitability-architecture-2026-03-16.md`
- `48-jangar-control-plane-resilience-and-torghut-profitability-implementation-contract-2026-03-16.md`

## Executive summary

Jangar currently exposes a control-plane truth gap:

- the swarm object is still `Frozen` on `2026-03-19` even though `status.freeze.until` expired on `2026-03-11`,
- the service-level `/ready` and `/api/agents/control-plane/status` endpoints still report healthy rollout/database state,
- `execution_trust` remains absent from live status because it is disabled by default,
- operator RBAC is not broad enough to assume ad hoc cluster inspection will always fill the gap.

The architecture change in this document is to make rollout safety depend on an **Authority Ledger** rather than a loose mix of deployment rollout health, stale `Swarm.status.phase`, and optional trust wiring. The ledger becomes the single control-plane source of truth for stage freshness, freeze expiry, schedule authority, and safe canary progression.

## Assessment snapshot

### Cluster health, rollout, and events

Fresh evidence captured during this discover run:

- `kubectl get swarm -n agents jangar-control-plane -o jsonpath='{.status.phase}|{.status.freeze.reason}|{.status.requirements.pending}|{.status.statusUpdatedAt}|{.status.conditions[?(@.type=="Ready")].status}'`
  - returned `Frozen|StageStaleness|5||False`
- `kubectl get swarm -n agents jangar-control-plane -o yaml`
  - `status.freeze.until: 2026-03-11T16:36:12.630Z`
  - `status.updatedAt: 2026-03-11T15:48:11.742Z`
  - all stage last-run timestamps still anchored on `2026-03-08`
  - result: the freeze TTL is expired, but the swarm still presents as frozen/stale
- `curl -fsS http://jangar.jangar.svc.cluster.local/ready`
  - returned `{"status":"ok", ...}`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '{database,watch_reliability,agentrun_ingestion,rollout_health,has_execution_trust:(has("execution_trust"))}'`
  - database healthy, rollout health healthy, watch reliability healthy, `agentrun_ingestion.status = "unknown"`, `has_execution_trust = false`
- `kubectl get events -A --field-selector type=Warning --sort-by='.lastTimestamp' | tail -n 80`
  - still shows active warning churn in adjacent workloads, especially Torghut readiness failures and restart loops

### Source architecture and test gaps

Current source surfaces already contain the raw ingredients for stronger control, but they are not yet authoritative:

- `services/jangar/src/server/control-plane-status.ts`
  - live default is `DEFAULT_EXECUTION_TRUST_ENABLED = false`
  - rollout health, watch reliability, migration consistency, and stage-derived trust exist, but the trust surface is optional
- `services/jangar/src/server/control-plane-watch-reliability.ts`
  - watch evidence is still maintained in a process-local map, which means restart/split-topology behavior can erase the same evidence that should keep rollout blocked
- `services/jangar/src/routes/ready.tsx`
  - readiness only blocks on execution trust when execution trust is enabled
- `services/jangar/src/server/control-plane-heartbeat-publisher.ts`
  - heartbeats already exist, but they are not yet the sole authority for stage freshness and freeze clearance
- `services/jangar/src/server/orchestration-controller.ts`
  - rollout metadata is emitted, but there is no immutable authority log for block/clear transitions
- `services/jangar/src/server/supporting-primitives-controller.ts` and `services/jangar/src/server/orchestration-controller.ts`
  - still compute freeze/policy behavior locally rather than consuming one authoritative trust contract

Coverage gaps that still matter:

- no regression proving an expired `freeze.until` cannot leave the swarm effectively frozen forever
- no end-to-end test tying `Swarm.status.phase`, stage cadence freshness, and canary progression to one deterministic decision surface
- no evidence-bundle contract proving which source overruled which when rollout remains blocked

### Database / data continuity assessment

Live control-plane reads show the Jangar database itself is healthy:

- `/api/agents/control-plane/status`
  - `database.connected = true`
  - `latency_ms = 7`
  - `migration_consistency.applied_count = 24`
  - `migration_consistency.unapplied_count = 0`
- direct read-only Postgres checks against `jangar-db-app`
  - `torghut_symbols = 12`
  - `torghut_market_context_snapshots.max(updated_at) = 2026-03-16T19:37:55.367Z`
  - `torghut_market_context_dispatch_state.count = 0`
  - `torghut_control_plane.simulation_runs.max(updated_at) = 2026-03-19T10:08:32.162Z`
  - `torghut_control_plane.simulation_lane_leases.max(last_heartbeat_at) = 2026-03-19T10:08:32.191Z`

The database issue is therefore not core storage health. The issue is that authority is still reconstructed from transient object status and process-local summaries even while persisted control-plane tables show mixed freshness across segments. The architecture needs a durable ledger that can distinguish fresh simulation authority from stale market-context or stage authority.

## Problem framing

1. A stale swarm can outlive its own freeze TTL, which means `Swarm.status.phase` is not reliable enough to govern rollout on its own.
2. `/ready` can remain green while stage cadence is dead, because rollout health and trust health are separate concepts today.
3. Optional `execution_trust` is too weak for production-safe rollout decisions; when disabled, the safe path disappears entirely.
4. Operators cannot assume broad cluster RBAC during incident triage, so the swarm and status surfaces themselves must carry authoritative evidence.

## Architecture alternatives

### Option A: enable the existing execution-trust feature as-is

Pros:

- smallest code delta
- reuses current status model

Cons:

- still no durable authority record for freeze-expiry and stage-lease decisions
- still vulnerable to stale swarm status outliving its truth window

### Option B: add a freeze-expiry janitor only

Pros:

- directly addresses the expired-freeze symptom
- low implementation cost

Cons:

- does not solve rollout truth split between rollout health, stage freshness, and readiness
- gives no auditable decision history

### Option C: introduce an Authority Ledger with expiry watchdog and rollout write-ahead log

Pros:

- one authoritative decision surface for stage freshness, freeze expiry, and canary gating
- durable evidence for block, hold, clear, and replay
- works even when operator RBAC is narrow

Cons:

- larger implementation scope across status, controllers, and persistence

## Decision

Adopt **Option C**.

The March 19 evidence is not just an observability nuisance. It shows the current architecture can report healthy deployments while leaving the swarm operationally frozen with no fresh stage activity. That is a control-plane truth failure, so the fix must be architectural rather than cosmetic.

## Proposed architecture

### 1. Authority Ledger as the source of truth

Introduce a durable ledger owned by Jangar with three records:

- `control_plane_authority_leases`
  - one row per `{swarm, stage, authority_source}`
  - fields: `observed_at`, `lease_expires_at`, `cadence_ms`, `source_kind`, `source_id`, `confidence`, `evidence_ref`
- `control_plane_authority_decisions`
  - one row per evaluated swarm decision
  - fields: `decision_id`, `authority_state`, `blocking_class`, `freeze_state`, `reason_codes`, `evidence_bundle_id`
- `control_plane_evidence_bundles`
  - immutable references to the swarm snapshot, warning-event digest, heartbeat summary, rollout digest, and requirement queue digest used in the decision

The control-plane UI/API may still project the current status from Kubernetes objects, but rollout control must read from the ledger summary, not directly from `Swarm.status.phase`.

### 2. Expiry watchdog with explicit post-expiry states

Replace the current binary mental model of `frozen` versus `not frozen` with explicit post-expiry states:

- `freeze_active`
- `freeze_expired_unreconciled`
- `hold_shadow_catchup`
- `recovering`
- `healthy`

When `freeze.until` passes, the watchdog must do one of two things within one reconciliation window:

1. transition to `recovering` if fresh stage leases and evidence bundles exist
2. transition to `freeze_expired_unreconciled` if stage leases are still stale

The important rule is that a swarm cannot remain indefinitely in `Frozen` without a fresh authority decision.

### 3. Stage lease quorum and synthetic catch-up

Each stage (`discover`, `plan`, `implement`, `verify`) must publish a lease entry on start and completion.

Rollout safety rules:

- if any required stage lease is stale beyond `2x cadence`, canary progression is blocked
- if a freeze expires while required stages are still stale, Jangar must queue a **shadow catch-up** run rather than auto-clearing to healthy
- shadow catch-up runs must not mutate production state; they only restore authority truth and evidence continuity

This keeps stale schedules from silently becoming “healthy by omission.”

### 4. Rollout write-ahead log

Before any canary step, write an intent record:

- `desired_weight`
- `current_weight`
- `authority_decision_id`
- `required_clearance_window_ms`
- `expected_recovery_conditions`

If rollout cannot continue, the controller writes a terminal hold/block record with the same `authority_decision_id`. That gives engineer and deployer stages a deterministic replay chain instead of reconstructing intent from logs.

### 5. Readiness and status contract changes

`/ready` and `/api/agents/control-plane/status` must both consume the ledger summary:

- `/ready`
  - non-200 when `authority_state in {blocked, freeze_expired_unreconciled, hold_shadow_catchup}`
- `/api/agents/control-plane/status`
  - always includes `authority_ledger`
  - no feature flag for the authoritative view
  - exposes `decision_age_ms`, `required_stage_leases`, `expired_freeze_count`, `evidence_bundle_refs`

Deployment rollout health remains informative, but never overrides ledger truth.

## Validation gates

Engineer gates:

- add unit coverage in `services/jangar/src/server/control-plane-status.test.ts` for:
  - expired freeze -> `freeze_expired_unreconciled`
  - fresh leases + expired freeze -> `recovering`
  - stale stage lease -> canary block even when deployment rollout is healthy
- add readiness-route coverage in `services/jangar/src/routes/__tests__/ready.test.ts`
  - readiness must fail when authority ledger says `freeze_expired_unreconciled`
- add controller tests around rollout WAL behavior in `services/jangar/src/server/orchestration-controller.test.ts`
- add persistence tests for evidence bundle immutability

Deployer gates:

- no canary progression when `authority_state != healthy`
- one forced schedule-staleness drill must generate:
  - an authority decision
  - a bundle of evidence refs
  - a shadow catch-up run
- one freeze-expiry drill must prove the system moves to `recovering` or `freeze_expired_unreconciled`, never silently remains frozen

## Rollout plan

1. Add ledger tables and write-paths behind additive schema changes.
2. Emit ledger summaries into status responses while keeping legacy fields.
3. Switch `/ready` to authority-ledger mode in canary.
4. Switch rollout controller predicates from deployment-health-first to ledger-first.
5. Remove the execution-trust feature flag once ledger-backed authority is stable.

## Rollback plan

If rollout of the ledger itself causes false blocks:

- keep writing ledger rows
- revert predicate consumption to advisory mode
- preserve evidence bundles and WAL rows for replay analysis

Do not delete the ledger rows during rollback. They are part of the incident record.

## Risks and tradeoffs

- More persistence means more schema and retention management.
- Bad lease TTL tuning could create noisy false holds.
- Shadow catch-up runs add execution cost.

Mitigations:

- use bounded TTL defaults from observed stage cadence
- version the evidence bundle schema
- cap shadow catch-up frequency and emit explicit anti-flap cooldowns

## Engineer and deployer handoff contract

Engineer must deliver:

1. ledger schema and authoritative decision builder
2. freeze-expiry watchdog with explicit post-expiry states
3. readiness/status consumption of the ledger
4. rollout WAL and evidence bundles
5. regression coverage for expiry, stale leases, and canary blocking

Deployer must validate:

1. healthy deployments alone do not clear stale schedule authority
2. expired freezes become explicit recovery/hold states
3. shadow catch-up runs are non-mutating
4. canary progression only occurs after ledger-backed healthy decisions

## Success criteria

- the swarm cannot remain frozen past `freeze.until` without a fresh authority decision
- `/ready` and canary rollout agree on the same authority state
- operators can explain a hold/block decision from a single evidence bundle without broad cluster RBAC
- stage freshness becomes durable, replayable, and auditable
