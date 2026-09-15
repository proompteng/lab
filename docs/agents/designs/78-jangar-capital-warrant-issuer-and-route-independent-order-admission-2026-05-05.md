# 78. Jangar Capital Warrant Issuer and Route-Independent Order Admission

Date: 2026-05-05
Author: Gideon Park, Torghut Traders
Status: Accepted for implementation planning

Companion Torghut contract:

- `docs/torghut/design-system/v6/82-torghut-order-admission-warrants-and-replay-capital-auction-2026-05-05.md`

Extends:

- `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`
- `docs/torghut/design-system/v6/81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md`
- `docs/agents/designs/76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`
- `docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`
- `docs/agents/designs/73-jangar-evidence-settlement-and-runtime-freshness-leases-2026-05-05.md`
- `docs/agents/designs/68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md`

## Decision

Jangar should provide a compact capital-warrant issuer and mirror surface instead of asking Torghut to infer external
capital safety from multiple control-plane fields. I am choosing this because the current Jangar plane is serving, but
the evidence is mixed: readiness is HTTP 200, leader election is healthy, controller heartbeats are fresh, and database
migrations are current, while execution trust is degraded, dependency quorum blocks on stale empirical jobs, old swarm
jobs still show `ImagePullBackOff`, and route-specific calls such as memories and quant health can reset or time out.

The selected architecture extends rollout settlement into a `CapitalWarrantDecision` that is scoped to account, window,
swarm, release digest, and action class. Jangar does not sit on the broker submit path and does not replace Torghut's
broker-bound `OrderAdmissionWarrant`. Instead, it signs or mirrors the control-plane side of the proof cut: whether
Jangar allows `external_capital`, which negative evidence forced a hold, when the decision expires, and which proof must
refresh next. Torghut can continue serving and repairing when Jangar is degraded, but it cannot mint a non-shadow
warrant unless the Jangar mirror includes external capital for the relevant scope.

The tradeoff is stricter action separation. Serving green is no longer dispatch green, rollout-widening green, or
external-capital green. That separation is exactly what the current cluster needs.

## Runtime Inputs and Success Metrics

The design is for the `torghut-quant` discover lane on branch `codex/swarm-torghut-quant-discover`, based on `main`.
Success means the next engineer can implement one Jangar contract that:

- allows serving, observe, repair, and verify when those clocks are valid;
- holds dispatch, rollout widening, and external capital when execution trust, event windows, empirical proof, or route
  proof are degraded;
- gives Torghut one digest to bind into each broker-bound order warrant;
- gives deployers a single smoke target before widening or enabling live capital.

## Evidence Captured

### Cluster, Control Plane, and Rollout State

- Jangar `/ready` returns HTTP 200 after rollout churn, with leader election healthy.
- Jangar control-plane status reports healthy database connectivity and migration parity, with 25 applied Kysely
  migrations and latest `20260418_embedding_dimension_4096`.
- The same status reports `dependency_quorum.decision: block` because Torghut empirical jobs are degraded.
- Execution trust is degraded with stale stage clocks and pending requirements. The plane can serve; it has not settled
  enough evidence for downstream capital.
- Events in `agents` and `jangar` show recent scheduling pressure, readiness timeouts, image-pull failures, failed
  mounts, and old scheduled jobs in `ImagePullBackOff`.
- One Jangar rollout recovered to 2/2, but recent event instability means deployment health alone is not enough for
  rollout widening.

### Route and Consumer State

- Torghut live routes return HTTP 200 and report live mode, simple execution lane, and a ready live submission gate.
- The same Torghut status reports no promotion-eligible hypotheses, three rollback-required hypotheses, stale empirical
  jobs from March 21, signal lag above entry budgets, and Jangar dependency blocks.
- Jangar quant-health calls from this runtime are unreliable: one request returned an empty reply after a long wait, and
  earlier requests failed while Jangar was rolling.
- Memory retrieval through `bun run --filter memories retrieve-memory` repeatedly fails with `ECONNRESET` against the
  Jangar memory API. A configured provider is not enough; route-specific proof must be part of action admission.

### Source Architecture and Test Surface

- Jangar already assembles the raw ingredients in separate modules: control-plane status, dependency quorum, execution
  trust, rollout health, database status, watch reliability, workflows, runtime kits, and admission passports.
- The previous rollout-settlement contract defines the right action classes, but it stops before capital-specific
  warrant issuance and mirror semantics.
- Torghut already has a proof-aware submission council, but simple-lane status can bypass it. Jangar must therefore
  expose an external-capital decision that Torghut binds at broker admission, not merely another dashboard field.
- Tests are strong for local Jangar status behavior, but no cross-consumer regression proves that a serving Jangar plane
  with degraded execution trust and stale empirical proof holds Torghut external capital while still allowing repair.

### Database, Schema, Freshness, and Consistency

- Jangar Postgres is reachable over TCP with current migration parity and live `agent_runs` updates.
- Torghut Postgres is reachable and schema-current, but execution and order-feed evidence are stale: live executions
  latest updates are from early April and `execution_order_events` has 0 rows.
- Torghut research proof tables for candidates, metrics, promotions, validation tests, and cost calibrations are empty.
- Empirical job state is the dominant capital blocker: four required jobs are stale from March 21, while the current
  live service is still able to report simple-lane readiness.

## Problem

Jangar has two jobs that are easy to confuse:

1. Keep the control plane available so humans and agents can observe, repair, and verify the system.
2. Tell Torghut whether the control plane evidence is settled enough to risk external capital.

The current status shape does the first job better than the second. A route can be green while execution trust is
degraded. Controller heartbeats can be healthy while old jobs cannot pull images. Database migrations can be current
while route-specific memory calls reset. Torghut empirical proof can be stale while the Torghut live route says ready.

External capital needs one scoped Jangar answer, not a bundle of fields that every consumer interprets differently.

## Options Considered

### Option A: Let Torghut Read Raw Jangar Status Fields

Torghut continues to consume `/api/agents/control-plane/status` and local logic decides whether external capital is
allowed.

Pros:

- Minimal Jangar work.
- Preserves existing observability surfaces.
- Lets Torghut move quickly on route parity.

Cons:

- Every consumer can interpret mixed evidence differently.
- Route resets and action-class distinctions remain implicit.
- Jangar cannot clearly state that serving is allowed while capital is held.

Decision: reject as the long-term authority. Keep raw status as input evidence.

### Option B: Make Jangar Readiness Fail Closed for Any Capital Block

Return non-200 readiness whenever execution trust, empirical jobs, route proof, or rollout event windows are degraded.

Pros:

- Simple for deployers and load balancers.
- Hard to miss in a smoke test.
- Strong incident posture.

Cons:

- Conflates serving health with capital authority.
- Can take away the read and repair surface needed to clear the hold.
- Encourages operators to bypass readiness to recover the system.

Decision: reject for steady state. Keep readiness focused on service availability.

### Option C: CapitalWarrantDecision Issuer and Mirror

Jangar emits a compact, expiring decision for action class `external_capital`, derived from rollout settlement,
execution trust, route probes, workflow artifacts, empirical services, and Torghut proof mirrors. Torghut binds the
decision digest into broker-bound `OrderAdmissionWarrant` objects.

Pros:

- Separates serving, dispatch, widening, verify, repair, and external-capital authority.
- Gives Torghut one stable digest to put on each order warrant.
- Lets Jangar hold capital while staying available for repair.
- Turns negative evidence into explicit repair hints instead of scattered status interpretation.

Cons:

- Requires one new materialized or cached decision surface.
- Requires careful expiry and anti-staleness semantics.
- Requires deployer discipline: a green pod rollout is not a capital-clear signal.

Decision: select Option C.

## Chosen Architecture

### CapitalWarrantDecision

Add a Jangar-produced decision scoped to one capital consumer.

Required fields:

- `decision_id`
- `namespace`
- `swarm`
- `consumer`: `torghut`
- `account`
- `window`
- `release_digest`
- `observed_at`
- `fresh_until`
- `decision`: `allow`, `observe`, `repair_only`, `hold`, or `unknown`
- `allowed_action_classes`
- `external_capital_allowed`
- `rollout_settlement_receipt_id`
- `execution_trust_digest`
- `workflow_artifact_digest`
- `watch_reliability_digest`
- `route_probe_digest`
- `empirical_services_digest`
- `torghut_quant_digest`
- `negative_evidence_refs`
- `repair_hints`
- `manual_override_ref`

The decision is small enough to mirror in `/api/agents/control-plane/status`, `/ready`, and the Torghut quant-health
control-plane route without dumping raw Kubernetes events or large logs.

### Issuer Rules

Jangar may emit `external_capital_allowed: true` only when:

- rollout settlement allows `dispatch`, `widen`, and `external_capital` for the release digest;
- execution trust is not degraded for the relevant swarm/stage;
- workflow artifact clocks are fresh or no workflow artifact is required for the action class;
- watch reliability is inside the configured restart and error budget;
- database migration parity is healthy;
- route probes required for capital are successful in the action window;
- empirical services required by Torghut are fresh and authoritative;
- Torghut quant mirror reports no active capital holdback for the account/window.

If any input is missing, stale, or contradictory, the decision must hold external capital and name the smallest missing
proof in `repair_hints`.

### Failure-Mode Reduction

The issuer reduces specific failure modes:

- A serving Jangar pod with degraded execution trust can keep `serve` and `repair` while holding `dispatch` and
  `external_capital`.
- A healthy deployment with recent image-pull or probe events can keep serving while holding rollout widening.
- A current database schema with route resets can keep database-backed reads while holding action classes that require
  that route.
- Stale Torghut empirical jobs can hold external capital without blocking unrelated platform repair work.
- Torghut simple-lane readiness cannot clear capital unless it binds this decision digest into a broker-bound warrant.

### Consumer Contract

Torghut consumes only the compact capital decision on its hot path. Raw Jangar status remains useful for diagnostics,
but not for broker admission.

Consumer rules:

- a missing or expired Jangar capital decision blocks non-shadow warrants;
- a decision without `external_capital` blocks non-shadow warrants;
- a decision scoped to the wrong account, window, swarm, or release digest blocks non-shadow warrants;
- a newer hold decision invalidates older allow decisions for the same scope;
- manual override decisions must include reason, expiry, account/window scope, max notional, and approver reference.

## Engineer Scope

Implement in this order:

1. Extend the rollout settlement builder with capital-scoped decision output.
2. Add an issuer module under `services/jangar/src/server/` that converts settlement, execution trust, workflow,
   database, route, and empirical inputs into `CapitalWarrantDecision`.
3. Add the compact decision to control-plane status and the Torghut quant-health route.
4. Cache or persist the latest decision with expiry. If the database is unavailable, emit an in-memory hold decision and
   include a database-unavailable negative evidence ref.
5. Add tests proving action-class separation across serving, repair, dispatch, widening, and external capital.
6. Add documentation examples for deployer smoke and Torghut consumer binding.

## Validation Gates

- Unit tests cover `allow`, `observe`, `repair_only`, `hold`, and `unknown` capital decisions.
- Regression tests prove HTTP 200 readiness can coexist with `external_capital_allowed: false`.
- Regression tests prove stale empirical jobs hold external capital even when rollout health and database parity are
  healthy.
- Regression tests prove recent image-pull, probe, or backoff events hold `widen` until the settlement window clears.
- Route tests prove memory or quant-health resets degrade only the action classes that require those routes.
- Consumer tests prove a missing, expired, or mismatched decision digest blocks Torghut non-shadow warrants.
- Snapshot tests prove negative evidence is compact and does not dump raw event logs, secrets, or large payloads.

## Rollout and Rollback

Roll out in three phases:

1. Shadow emit `capital_warrant_decision` and compare with current dependency quorum and Torghut live gate for at least
   one market session or three Jangar rollouts.
2. Make Torghut status and Jangar quant-health display the shadow decision without broker enforcement.
3. Enforce Torghut non-shadow warrants only after route parity and broker rejection tests are green.

Rollback is configuration-only:

- disable capital-decision enforcement in Torghut and keep Jangar emitting the decision in observe mode;
- keep serving, observe, repair, and verify action classes available when their own clocks are valid;
- keep external capital held unless a manual override decision names scope, max notional, approver, reason, and expiry;
- preserve cached or persisted decisions for audit.

## Risks and Tradeoffs

- If Jangar decision expiry is too long, stale control-plane confidence can leak into capital. Keep expiry short and
  require a newer closing proof after any hold.
- If the decision includes too much raw evidence, route payloads become unreliable and may leak operational detail. Keep
  negative evidence compact and link to durable artifacts.
- If Torghut treats the Jangar decision as sufficient by itself, it recreates a single-plane authority. The broker
  warrant still needs Torghut proof clocks, replay/shadow proof, and TCA budgets.
- If all capital is held, the desk must still be able to observe, replay, and repair. Capital holds must not disable the
  paths required to recover proof.

## Handoff

Engineer acceptance gate: in the current May 5 state, Jangar should serve and allow repair, but the capital decision
must set `external_capital_allowed: false` because empirical jobs are stale, execution trust is degraded, route proof is
unreliable, and Torghut has no promotion-eligible hypothesis for the live account/window.

Deployer acceptance gate: do not widen Jangar or enable Torghut non-shadow capital on pod readiness alone. Widen only
when the settlement window is clear, and enable capital only when `CapitalWarrantDecision.external_capital_allowed` is
true for the exact Torghut account/window and the companion Torghut broker warrant smoke rejects missing-warrant orders.
