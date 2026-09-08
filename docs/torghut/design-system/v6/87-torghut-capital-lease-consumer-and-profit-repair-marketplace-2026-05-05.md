# 87. Torghut Capital Lease Consumer and Profit Repair Marketplace (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

Torghut should consume Jangar `ControlPlaneActionLease` decisions as the control-plane prerequisite for paper and live
capital, then allocate repair work through a profit repair marketplace. Shadow learning continues when leases are held.
Paper and live capital do not. A profitable hypothesis must buy its way back to capital with fresh Jangar authority,
fresh empirical proof, current execution/TCA samples, and a rollback bundle that has already been rehearsed.

I am choosing this over resuming paper trading from service health or passively waiting for every empirical job to
recover. The service is live, the schema route is current, and signal continuity had recovered in the sampled status.
Those facts are necessary, but they are not capital authority. The same evidence shows live submission disabled,
empirical jobs stale from 2026-03-21, all three hypotheses capped at shadow or blocked, zero promotion eligibility, and
zero executions or TCA samples in the last 72 hours.

The tradeoff is that Torghut will spend some market sessions in shadow while it repairs proof. That is acceptable. The
system needs to maximize expected post-cost learning and preserve capital, not maximize order count.

## Scope and Success Metrics

This contract defines how Torghut consumes Jangar leases and ranks repair work. It does not replace Torghut's local
strategy gates, broker prechecks, or kill switches. It makes Jangar authority a required upstream input for capital.

Success means:

1. `/trading/status`, `/trading/health`, broker-bound submission, scheduler decisions, and repair auctions all consume
   the same Jangar lease digest for an account, release, and window.
2. Missing, expired, held, wrong-account, wrong-release, or wrong-window leases keep paper and live capital disabled.
3. Shadow decisions, replay, counterfactual fills, and repair backfills remain allowed while capital is held.
4. Every blocked capital window creates a repair marketplace entry with expected post-cost edge, opportunity cost,
   proof gap, data freshness debt, execution sample gap, TCA sample gap, and rollback readiness.
5. Paper and live promotion require both Torghut local profit proof and Jangar capital leases.

## Evidence Snapshot

All checks were read-only.

### Cluster and Runtime Evidence

- `kubectl get pods -n torghut --sort-by=.status.startTime` showed Torghut live, Torghut sim, Postgres, ClickHouse,
  Keeper, TA workers, options services, websocket forwarders, and exporters running.
- Recent Torghut events showed Knative live revision `torghut-00218` and sim revision `torghut-sim-00299` becoming
  ready after startup/readiness probe delays.
- Recent Torghut events also showed Flink options TA restart exceptions before returning to running, and multiple PDB
  matches on ClickHouse pods. These are not direct capital blockers, but they belong in the control-plane evidence
  window.
- The agents namespace still had older scheduled Jangar and Torghut pods with image platform pull failures and failed
  jobs. Torghut should not treat Jangar service liveness alone as paper or live capital authority.

### Database and Data Evidence

- `GET http://torghut.torghut.svc.cluster.local/db-check` returned `ok=true`, `schema_current=true`, current and
  expected head `0029_whitepaper_embedding_dimension_4096`, and lineage ready.
- The same route reported historical migration parent-fork warnings for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Direct CNPG and SQL checks were unavailable to the current service account because CNPG cluster reads and `pods/exec`
  are forbidden. Torghut capital proof therefore must remain route-backed and least-privilege safe.
- `GET /trading/health` returned HTTP 503 with `status=degraded` because the live submission gate was closed with
  `simple_submit_disabled`, even though scheduler, Postgres, ClickHouse, Alpaca, universe, and optional quant evidence
  checks were usable.
- `GET /trading/status` reported `mode=live`, `execution_lane=simple`, `capital_stage=shadow`,
  `live_submission_gate.allowed=false`, zero promotion eligible hypotheses, and three rollback-required hypotheses.
- The three sampled hypotheses were `H-CONT-01` in shadow, `H-MICRO-01` blocked, and `H-REV-01` in shadow.
- `GET /trading/empirical-jobs` reported four completed, truthful, stale jobs: `benchmark_parity`,
  `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`, all created on
  `2026-03-21T09:03:22Z`.
- `GET /trading/profitability/runtime?hours=72` reported 8 decisions, 0 executions, 0 TCA samples, and zero realized
  PnL proxy for the sampled window.

### Source and Test Evidence

- `services/torghut/app/trading/submission_council.py` already centralizes live submission gate logic and is the right
  integration point for Jangar capital leases.
- `services/torghut/app/trading/hypotheses.py` already computes hypothesis state, promotion eligibility, rollback
  requirements, capital-stage totals, dependency quorum, and local blockers.
- `services/torghut/app/trading/profitability_archive.py` and the runtime profitability route expose enough evidence
  to rank proof repair work, but they do not currently consume Jangar action leases.
- `services/torghut/app/trading/execution.py` persists blocked and submitted decisions. It should attach lease digest,
  repair marketplace id, and opportunity-cost labels to rejected capital actions.
- The missing test shape is route parity: the same lease digest must be visible in `/trading/status`,
  `/trading/health`, scheduler output, submission council decisions, and repair marketplace records.

## Problem

Torghut is not simply unavailable. It is capital-ineligible. The live service is up, the database schema is current, and
market-session learning can continue. But the system has no fresh basis to put paper or live capital at risk.

Three failure modes matter:

1. **Liveness can be misread as capital authority.** A healthy route and current schema do not prove a hypothesis can
   trade profitably after costs.
2. **Freezing capital can freeze learning.** If all blocked decisions disappear, Torghut loses the opportunity-cost
   signal needed to prioritize repair.
3. **Jangar and Torghut can drift.** Jangar may hold dispatch or widening while Torghut sees local route health and
   reopens paper independently.

The design needs to keep capital closed, keep learning open, and rank repair work by expected profit impact.

## Alternatives Considered

### Option A: Resume Paper When Service and Schema Are Healthy

Allow paper submissions when `/trading/health` dependencies and `/db-check` are green.

Pros:

- fastest way to create execution and TCA samples;
- exercises broker paths and runtime order plumbing;
- easy operational toggle.

Cons:

- ignores stale empirical proof and closed live submission authority;
- converts route health into capital authority;
- can create paper fills without Jangar rollout or dispatch proof;
- does not prioritize which hypothesis deserves the first repair budget.

Decision: reject. It creates activity before proof.

### Option B: Wait Until All Empirical Jobs Are Fresh

Keep all hypotheses in shadow and perform no paper, live, or repair marketplace work until empirical jobs are fresh.

Pros:

- safest capital posture;
- easy to audit;
- no risk of stale proof being misused.

Cons:

- wastes live market sessions;
- loses opportunity-cost evidence from blocked decisions;
- gives no ranking for which stale proof to repair first;
- does not use Jangar lease authority as a control-plane input.

Decision: reject. Capital should freeze, but learning should not.

### Option C: Capital Lease Consumer with Profit Repair Marketplace

Require Jangar `paper_submit` and `live_submit` leases for capital, while Torghut records shadow decisions and ranks
repair bids by expected post-cost value and proof gap.

Pros:

- aligns Torghut capital with Jangar control-plane authority;
- keeps counterfactual learning open while capital is held;
- turns stale empirical jobs and missing TCA samples into ranked repair work;
- preserves a least-privilege proof path;
- gives deployers a single capital handoff contract.

Cons:

- requires new persistence and route parity tests;
- opportunity-cost estimates can be noisy;
- paper recovery may be slower than a manual submit toggle.

Decision: select Option C.

## Chosen Architecture

### JangarCapitalLeaseConsumer

Torghut reads Jangar leases into an account-window projection:

```text
jangar_capital_lease_consumer
  account
  trading_window
  release_digest
  lease_bundle_digest
  paper_submit_lease_id
  paper_submit_decision
  live_submit_lease_id
  live_submit_decision
  dispatch_lease_id
  dispatch_decision
  observed_at
  fresh_until
  blocked_reasons
  evidence_refs
```

Missing, expired, wrong-account, wrong-window, or held leases keep paper and live capital disabled. Shadow decisions,
counterfactual replay, and empirical repair remain allowed.

### ProfitRepairMarketplace

Each control-plane cycle creates a marketplace snapshot:

```text
profit_repair_marketplace
  marketplace_id
  account
  trading_window
  release_digest
  generated_at
  lease_bundle_digest
  capital_state               # shadow, paper_hold, paper_allowed, live_hold, live_allowed
  no_capital_reason
  bids:
    hypothesis_id
    strategy_family
    current_state
    capital_stage_ceiling
    proof_gap
    expected_post_cost_edge_bps
    opportunity_cost_proxy
    data_freshness_debt_seconds
    execution_sample_gap
    tca_sample_gap
    lease_blockers
    local_guardrail_blockers
    repair_action
    rollback_readiness
    bid_score
  winner
```

This marketplace does not guarantee profitability. It prioritizes repair. Capital still requires fresh proof and the
correct Jangar lease.

### Initial Hypotheses and Guardrails

`H-CONT-01` continuation repair:

- Repair action: restore empirical freshness and current TCA samples for continuation strategies.
- Paper gate: fresh Jangar `paper_submit` lease, empirical jobs fresh inside 24 hours, at least 40 paper executions,
  average absolute slippage under 12 bps, and post-cost expectancy above 6 bps.
- Live gate: all paper gates, fresh Jangar `live_submit` lease, no open high-severity capital clearance cells, and
  rollback rehearsal complete.

`H-REV-01` event reversion repair:

- Repair action: refresh market-context proof and news/fundamental freshness for event reversion.
- Paper gate: fresh Jangar `paper_submit` lease, no stale market-context dependency, at least 30 paper executions
  across two market sessions, and post-cost expectancy above 5 bps.
- Live gate: all paper gates plus TCA sample count above 30 and no unresolved route-timeout lease blockers.

`H-MICRO-01` microstructure repair:

- Repair action: rebuild microstructure proof and execution-quality samples before any paper widening.
- Paper gate: fresh Jangar `paper_submit` lease, no Flink TA data-quality blocker, at least 50 paper executions,
  average absolute slippage under 8 bps, and adverse excursion p95 inside policy.
- Live gate: all paper gates plus live canary notional capped at the lowest capital sleeve.

## Implementation Plan

1. Add a Jangar lease client in Torghut with strict account, window, and release-digest matching.
2. Persist capital lease consumption beside existing hypothesis runtime status and submission council output.
3. Add the profit repair marketplace projection and route.
4. Attach lease digest, marketplace id, and opportunity-cost labels to blocked decisions in execution persistence.
5. Update `/trading/status` and `/trading/health` to expose the same lease digest and capital state.
6. Update submission council so paper/live submission fail closed when the Jangar lease is missing, expired, held, or
   wrong-scope.
7. Add route parity tests across status, health, scheduler, submission council, and execution persistence.
8. Run shadow mode for seven days before any paper capital reopening depends on the new lease consumer.

## Validation Gates

Engineer acceptance:

- Unit tests prove missing, expired, wrong-account, wrong-window, and held leases block paper and live submission.
- Route tests prove `/trading/status` and `/trading/health` report the same lease bundle digest and capital state.
- Submission council tests prove local green health cannot override a held Jangar capital lease.
- Execution tests prove blocked decisions retain lease digest, marketplace id, and normalized opportunity-cost labels.
- Marketplace tests prove stale empirical jobs, zero executions, zero TCA samples, and rollback gaps change bid score.

Deployer acceptance:

- The first deployment runs in observe mode and publishes lease mismatch counts.
- Shadow mode runs for seven days with no unexplained mismatch between route status and submission council decisions.
- Paper canary is not enabled until a fresh `paper_submit` lease and Torghut local profit proof are both present.
- Live canary is not enabled until the paper gate passes, a fresh `live_submit` lease exists, and rollback dry runs are
  recorded for kill switch, GitOps revert, and strategy disable.

## Rollout

Phase 0 is design merge.

Phase 1 adds the lease client, persistence, and read-only route projections. Capital behavior remains unchanged.

Phase 2 adds shadow submission council evaluation and mismatch metrics.

Phase 3 makes paper submission require the Jangar `paper_submit` lease while live remains disabled.

Phase 4 allows live canary only after paper evidence, Jangar `live_submit` lease, and rollback rehearsal all pass.

Phase 5 lets the marketplace allocate repair budgets automatically inside explicit compute and broker-risk limits.

## Rollback

- Disable lease enforcement and return to current shadow-only capital defaults.
- Keep the lease consumer route and marketplace in observe mode for debugging.
- Disable automatic repair-budget allocation while keeping manual marketplace ranking available.
- Use existing Torghut kill switch, GitOps revert, and strategy-disable mechanisms for any paper/live regression.
- Preserve blocked decision, lease, and marketplace history for post-incident review.

## Risks

- Marketplace bid scores can look more precise than they are. They are prioritization signals, not realized edge.
- If Jangar lease routes become slow, Torghut could block capital for control-plane latency rather than trading risk.
- Seven days of shadow data may not cover enough market regimes. Deployer should extend shadow mode if mismatch counts
  are high or market sessions are sparse.
- Hypothesis-specific sample thresholds need tuning after current TCA samples exist again.
- Operators may be tempted to reopen paper from route health alone. The runbook must make that a policy violation.

## Handoff Contract

Engineer stage owns the Torghut lease client, persistence, marketplace projection, route parity tests, submission
council integration, and blocked-decision labels.

Deployer stage owns observe/shadow/enforce rollout, mismatch dashboards, paper canary proof, live canary proof, and
rollback rehearsal evidence.

No Torghut paper or live capital widening is acceptable unless the PR evidence includes the Jangar lease digest, local
profit proof digest, empirical freshness proof, TCA/execution sample proof, and rollback bundle.
