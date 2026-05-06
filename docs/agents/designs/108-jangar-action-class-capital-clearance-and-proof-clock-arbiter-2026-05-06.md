# 108. Jangar Action-Class Capital Clearance And Proof Clock Arbiter (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane dependency quorum, rollout safety, Torghut quant capital admission, empirical proof
freshness, and action-class clearance receipts.

Companion Torghut contract:

- `docs/torghut/design-system/v6/112-torghut-dual-key-capital-clearance-and-intraday-proof-loop-2026-05-06.md`

Extends:

- `107-jangar-reciprocal-evidence-authority-and-contradiction-escrow-2026-05-06.md`
- `106-jangar-proof-debt-retirement-exchange-and-experiment-lease-arbiter-2026-05-06.md`
- `104-jangar-quant-evidence-clearinghouse-and-capital-action-firewall-2026-05-06.md`

## Decision

I am selecting **action-class capital clearance with proof clocks** as the next Jangar control-plane architecture.

Jangar will no longer publish one broad dependency quorum and leave Torghut to infer which actions are safe. Jangar
will issue short-lived clearance receipts per action class: `serve_readonly`, `dispatch_repair`, `torghut_observe`,
`paper_canary`, `live_micro_canary`, and `live_scale`. Each receipt will carry the exact proof clock used for rollout,
watch reliability, database schema, quant metrics, empirical jobs, and consumer acknowledgment. Torghut may only admit
paper or live capital when the requested action class has a fresh receipt and Torghut returns the same receipt id in its
health, status, and submission-admission surfaces.

The evidence points to this design. At `2026-05-06T09:11Z`, Jangar status showed leader election healthy, `agents` and
`agents-controllers` rollouts healthy, runtime kits healthy, database connected, and Kysely migrations aligned at
`28/28`. The same status still produced `dependency_quorum.decision=block` because watch reliability was degraded
(`1043` events, `28` errors, `33` restarts in `15m`) and empirical jobs were stale. That broad block is correct for
capital, but too coarse for repair and observation.

The tradeoff is that deployment and capital promotion become more explicit. I accept that. A global "blocked" status is
safe but low-leverage: it does not tell engineers whether to repair watches, refresh empirical jobs, prove the sim
account, or keep serving only. Action-class clearance keeps the conservative capital posture while letting repair and
zero-notional learning continue under bounded proof.

## Current Evidence

No Kubernetes resources, database records, broker settings, or runtime flags were mutated during this assessment.

### Cluster And Rollout

- Runtime identity: `system:serviceaccount:agents:agents-sa`.
- `agents` deployment was `1/1`; `agents-controllers` was `2/2`; one controller pod had restarted within the sample
  window and recent events still showed readiness/liveness failures on the new rollout.
- Jangar deployment was `1/1`, active pod `jangar-5c66bfd6cf-l8tp4` was `2/2 Running`, and `/health` returned HTTP
  `200`.
- Torghut live revision `torghut-00234` and sim revision `torghut-sim-00315` were `1/1` deployments with `2/2` pods.
- Recent Torghut events showed two failed Argo analysis teardown-clean jobs and `AnalysisRunFailed` results for sim
  proof teardown checks.
- Torghut ClickHouse pods were running, but events repeatedly warned that ClickHouse pods match multiple
  PodDisruptionBudgets and the Keeper PDB has no matching pods.
- Flink REST showed equity TA, sim TA, and options TA jobs all `RUNNING`; recent events still recorded a status
  modification conflict on `torghut-options-ta`.
- Shared infra risk remains outside this design scope but is relevant for rollout safety: `redis-operator` was
  `CrashLoopBackOff`, three Rook OSD deployments were unavailable, and one Temporal Elasticsearch pod was pending.

### Database And Data

- Direct database shell access is blocked from this worker: `pods/exec is forbidden` for both `torghut-db-1` and
  `jangar-db-1`; CNPG cluster listing is also forbidden. The design therefore treats service-owned read-only
  projections as the required audit surface.
- Jangar status reported its database `configured=true`, `connected=true`, `status=healthy`, `latency_ms=3`, and
  migration consistency `registered_count=28`, `applied_count=28`, `unapplied_count=0`.
- Torghut `/db-check` returned HTTP `200`, `ok=true`, expected/current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no duplicate revisions, no orphan parents, and account scope ready.
- Torghut schema lineage still carries parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; these are warnings, not current head drift.
- Torghut live `/readyz` returned HTTP `503`: Postgres, ClickHouse, Alpaca, database schema, universe, and quant
  evidence were healthy or not required, but `live_submission_gate.ok=false` because `simple_submit_disabled`.
- Torghut live `/trading/health` returned HTTP `503` with `promotion_eligible_total=0`, `rollback_required_total=3`,
  and dependency quorum blocked by `watch_reliability_blocked` and `empirical_jobs_degraded`.
- Jangar typed quant health returned HTTP `200`, `latestMetricsCount=3780`, `metricsPipelineLagSeconds=0`, and a fresh
  `latestMetricsUpdatedAt` for the unscoped latest-store view.
- Torghut sim consumed the typed quant-health endpoint for `TORGHUT_SIM`, but that account view was empty:
  `quant_latest_metrics_empty`, `empty_latest_store_alarm=true`, and `stage_count=0`.
- Live empirical jobs were stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`; sim empirical jobs were missing for the same four job types.
- Direct ClickHouse HTTP access without credentials returned `401`, which is appropriate; service projections and
  guardrail exporters remain the intended read-only data evidence path.

### Source

- `services/jangar/src/server/control-plane-workflows.ts` converts degraded watch reliability into a global dependency
  quorum block once error or restart thresholds are crossed.
- `services/jangar/src/server/control-plane-status.ts` already assembles controllers, runtime adapters, database,
  watch reliability, workflows, failure-domain leases, runtime kits, and empirical service health into one status
  payload.
- `services/jangar/src/server/control-plane-empirical-services.ts` classifies Torghut empirical job staleness from the
  Torghut status payload and feeds it back into Jangar dependency quorum.
- The high-risk gap is not a missing probe. It is that Jangar has enough evidence to know _why_ a capital action is
  unsafe, but the current API exposes that as one global decision instead of a scoped clearance ledger.

## Problem

The control plane now has three different duties that should not share one decision bit:

1. Keep serving read-only surfaces during degraded evidence.
2. Dispatch repair or observation work that can reduce proof debt.
3. Admit paper or live capital only when all capital proof is fresh.

The current global dependency quorum is conservative, but it collapses those duties. When watch streams degrade, all
downstream consumers see a block even if read-only serving is healthy. When empirical jobs are stale, Jangar can say
"capital is blocked" but not "repair is allowed and this proof clock expires at this time." That makes deployers read
several status surfaces and infer the action class manually.

Torghut compounds the issue because live route uptime, local DB readiness, Jangar quant metrics, empirical job
freshness, and broker submission are exposed through different surfaces. Jangar needs to become the arbiter of the
action class, not just a status aggregator.

## Alternatives Considered

### Option A: Keep The Existing Global Quorum

Pros:

- It is already implemented and fail-closed for capital.
- It requires no new consumer contract.
- It is easy to explain during an incident.

Cons:

- It blocks observation and repair in the same language as capital.
- It does not tell Torghut which proof clock must be refreshed first.
- It tempts deployers to bypass the global block with local service health.

Decision: reject as the next step. Keep it as a compatibility projection during rollout.

### Option B: Let Torghut Interpret Jangar Status Locally

Pros:

- Fastest to implement in Torghut.
- Keeps Jangar status shape stable.
- Lets Torghut optimize for market-session timing.

Cons:

- Recreates per-service policy drift.
- Makes Jangar watch and rollout failures advisory instead of authoritative.
- Leaves no durable receipt for deployer and auditor review.

Decision: reject. Capital admission is cross-plane and needs cross-plane evidence.

### Option C: Action-Class Clearance Receipts With Proof Clocks

Pros:

- Separates read-only serving, repair, observation, paper, live micro-canary, and scale.
- Makes stale empirical jobs and empty sim quant evidence actionable without granting capital.
- Gives Torghut one receipt id to cite in health, status, and submission admission.
- Lets Jangar degrade watch reliability without losing the ability to dispatch bounded repair.
- Creates a safer rollout path because widening requires fresh action-class proof, not just a running pod.

Cons:

- Adds a projection and receipt ledger to the control plane.
- Requires Torghut consumer acknowledgments before capital admission.
- Requires a short shadow phase to learn normal receipt churn.

Decision: select Option C.

## Architecture

Jangar adds a `capital_clearance_receipt` projection:

```text
capital_clearance_receipt
  receipt_id
  action_class
  decision                  # allow, hold, repair_only, observe_only
  issued_at
  fresh_until
  proof_clock_id
  proof_window
  required_evidence
  accepted_evidence_refs
  missing_or_stale_refs
  contradiction_case_ids
  rollout_ref
  watch_reliability_ref
  database_ref
  source_schema_ref
  quant_health_ref
  empirical_job_refs
  consumer_ack_required
  consumer_ack_status
  rollback_target
```

The proof clock is the core invariant. Every required evidence item must be fresh inside the same clock window for
capital actions. Repair and observe actions can use partial proof, but they must list the missing or stale refs they are
intended to repair.

Action classes:

- `serve_readonly`: allow when route and database read projections are available.
- `dispatch_repair`: allow when runtime kit, source schema, and target repair inputs are safe enough to run.
- `torghut_observe`: allow when route, DB schema, universe, and zero-notional data feeds are safe, even if empirical
  jobs are stale.
- `paper_canary`: require fresh sim account quant evidence, empirical jobs, TCA, source schema, rollback target, and
  Torghut acknowledgment.
- `live_micro_canary`: require everything from `paper_canary` plus live account quant health, broker/account scope,
  submission gate agreement, and no open contradiction cases.
- `live_scale`: require sustained `live_micro_canary` proof across consecutive market sessions and no open watch,
  rollout, or empirical degradation.

## Implementation Scope

Engineer stage:

- Add a receipt reducer beside Jangar control-plane status that derives action-class receipts from the existing status
  ingredients.
- Extend `/api/agents/control-plane/status` with `capital_clearance_receipts` while keeping the current global
  `dependency_quorum` for compatibility.
- Emit a stable `proof_clock_id` and `fresh_until` on each receipt.
- Add explicit watch-reliability evidence refs so watch degradation can hold capital without blocking repair.
- Add a Torghut consumer-ack endpoint or persisted acknowledgment row for receipt use.
- Add tests for global quorum blocked while `dispatch_repair` and `torghut_observe` remain allowed.

Deployer stage:

- Keep receipts in shadow for one deploy cycle.
- Require a fresh `paper_canary` receipt before widening sim canaries.
- Require a fresh `live_micro_canary` receipt before any live broker submission flag can be enabled.
- Do not treat `serve_readonly` or `torghut_observe` as capital permission.

## Validation Gates

- Unit: watch reliability degraded above the block threshold produces `live_micro_canary.decision=hold` and
  `dispatch_repair.decision=repair_only`.
- Unit: stale empirical jobs produce `paper_canary.decision=hold` and include all stale job refs.
- Unit: empty `TORGHUT_SIM` quant health holds `paper_canary` even when the unscoped latest-store view is fresh.
- Unit: healthy database plus forbidden direct DB exec still allows service-owned DB projections as valid evidence.
- Integration: Jangar status and Torghut `/trading/health` cite the same receipt id for the requested action class.
- Rollout: receipt `fresh_until` expires within the configured proof window and is never reused for a later market
  session.

## Rollout And Rollback

Phase 0: publish receipts in shadow with no behavior change. Rollback is to hide the additive field.

Phase 1: require receipts for deployer documentation and Jangar UI display. Rollback is to keep global quorum as the
only enforced field.

Phase 2: require `paper_canary` receipts before sim account promotions. Rollback is to return sim promotions to
manual hold while keeping read-only and repair receipts visible.

Phase 3: require `live_micro_canary` and `live_scale` receipts before enabling live broker submission. Rollback is to
force all capital receipts to `hold` and leave `serve_readonly`, `dispatch_repair`, and `torghut_observe` available.

## Risks

- Receipt churn can become noisy if proof windows are too short. Start with `15m` for route/quant evidence and `24h`
  for empirical job freshness, then tune from observed market-session behavior.
- A repair-only receipt could be misread as promotion. The decision names must stay explicit: `repair_only` and
  `observe_only` are not `allow`.
- Watch reliability can block capital even when trading data is fresh. That is intentional until Jangar can prove the
  control-plane stream did not miss material updates.
- RBAC limits direct DB inspection. Service-owned projections must stay strong, timestamped, and schema-versioned.

## Handoff Contract

Engineer acceptance gate:

- Implement additive Jangar receipt projection and tests.
- Prove `dispatch_repair` and `torghut_observe` can remain available while capital is held.
- Expose receipt ids and proof clocks in the status payload without removing current quorum fields.

Deployer acceptance gate:

- Do not widen Torghut paper or live capital unless the requested action class has a fresh receipt.
- Confirm Torghut echoes the same receipt id in `/readyz`, `/trading/health`, `/trading/status`, and submission
  admission.
- Roll back by forcing capital receipts to `hold`; do not disable read-only serving or proof repair unless those action
  classes are explicitly unsafe.
