# 85. Torghut Profit Evidence Leases and Capital Repair Loop (2026-05-05)

Status: Approved for implementation (`plan`)

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

Torghut should publish **ProfitEvidenceLease** objects and consume Jangar's external-capital action lease before any
non-shadow broker admission. A profit evidence lease is a compact, expiring proof cut for one account, window,
hypothesis, strategy family, and market segment. It answers a narrower question than route health: "Is this hypothesis
profitable enough, fresh enough, and operationally safe enough to receive capital right now?"

The current runtime evidence supports this design:

- `/healthz` returned ok and `/db-check` returned schema-current.
- `/trading/health` returned HTTP 503 because the live-submission gate is shadow-only.
- `/trading/status` reported `mode=live`, `execution_lane=simple`, `kill_switch_enabled=false`, but
  `live_submission_gate.allowed=false` with `reason=simple_submit_disabled`.
- The same status payload reported three hypotheses, all in `shadow` or `blocked`, with `promotion_eligible_total=0`
  and `rollback_required_total=3`.
- Jangar dependency quorum blocks on `empirical_jobs_degraded`.
- Empirical jobs were completed on 2026-03-21 but stale under the 86400 second freshness rule.
- TCA last computed on 2026-04-02, with `order_count=13775` and average absolute slippage around `568.6` bps.
- Feature rows, drift checks, and evidence-continuity checks are currently zero in the runtime metrics.
- Jangar quant evidence is not configured in Torghut, and the typed Jangar quant-health route timed out in the current
  plan assessment.

The important point is that Torghut is not broken just because non-shadow capital is held. The system is doing the
right thing by staying in shadow while evidence is stale. The missing architecture is a feedback loop that converts
each blocker into a concrete repair or research job and then leases capital only to cells that clear the measured bar.

The tradeoff is slower capital widening. I accept that trade because the objective is profitable autonomy, not merely a
green trading route.

## Success Metrics

Implementation is successful when:

1. Every non-shadow order warrant cites one `profit_evidence_lease_id` and one Jangar `external_capital` action lease.
2. `/trading/status`, `/trading/health`, scheduler snapshots, and broker admission report the same account/window
   capital decision.
3. Current May 5 evidence yields `shadow_only` or `hold`, not live capital.
4. Stale empirical jobs, stale TCA, missing feature rows, missing drift checks, unconfigured quant evidence, Jangar
   dependency block, and route timeout each produce typed blockers.
5. Each blocker maps to a repair action that keeps observe, replay, and shadow learning running.
6. A hypothesis can earn canary capital only through fresh post-cost evidence, not through route liveness.

## Evidence Snapshot

### Cluster and Rollout Evidence

Read-only Kubernetes checks showed Torghut operational but not quiet:

- `kubectl get pods -n torghut` summarized `Running 27` and `Pending 1`.
- Main Torghut revision `torghut-00216` and sim revision `torghut-sim-00296` were both running.
- Postgres, ClickHouse, Keeper, websocket forwarders, options services, TA services, and exporters were running.
- A database migration job was pending during one sample.
- Events showed recent revision creation, startup/readiness probe failures, migration/backfill jobs, and ClickHouse
  pods matching multiple PodDisruptionBudgets.

Interpretation: the runtime can keep producing evidence, but rollout churn and PDB ambiguity should block capital
widening until they are represented in Jangar action leases.

### Runtime API Evidence

Allowed route evidence was mixed:

- `/healthz` returned `{"status":"ok","service":"torghut"}`.
- `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- `/trading/health` returned HTTP 503 with status `degraded` because `live_submission_gate.ok=false` and
  `detail=simple_submit_disabled`.
- `/trading/status` reported a live process loop and current reconcile timestamps, but live submission was held:
  `allowed=false`, `reason=simple_submit_disabled`, `capital_stage=shadow`.
- Hypothesis summary reported `hypotheses_total=3`, `state_totals.shadow=2`, `state_totals.blocked=1`,
  `capital_stage_totals.shadow=3`, `promotion_eligible_total=0`, and `rollback_required_total=3`.
- Jangar dependency quorum for hypotheses was `block` with reason `empirical_jobs_degraded`.

Interpretation: route liveness and schema health are useful repair signals. They are not capital permission.

### Database and Profit Evidence

Direct database SQL was not available from the plan runner because `pods/exec` is forbidden in the `torghut` namespace.
The application status routes still exposed enough data-quality evidence to make a capital decision:

- `last_decision_at=2026-05-04T17:25:57.901670Z`;
- empirical job artifacts from `torghut-full-day-20260318-884bec35`, created 2026-03-21, all stale;
- TCA sample size `13775`, but last computed 2026-04-02 and average absolute slippage far above current promotion
  contracts;
- `feature_batch_rows_total=0`;
- `drift_detection_checks_total=0`;
- `evidence_continuity_checks_total=0`;
- quant evidence `status=not_required` and `reason=quant_health_not_configured`;
- Jangar market context for `NVDA` had fresh technicals/regime but stale fundamentals/news and overall `degraded`.

Interpretation: Torghut has enough evidence to keep learning, but not enough current evidence to widen capital.

## Problem

Torghut's route and database surfaces answer "can the system run?" better than they answer "which hypothesis deserves
capital?" That distinction matters. A service can be healthy while every hypothesis is still shadow, blocked, stale,
or missing key proof.

Three concrete failure modes remain:

1. **Capital evidence is not leased.** Broker admission can see current process state, but it does not yet cite one
   expiring profit proof cut that can be reconciled with Jangar's platform lease.
2. **Repair is not first-class.** Blockers such as stale empirical jobs or missing drift checks explain why capital is
   held, but they do not automatically become a prioritized repair loop.
3. **Profit hypotheses compete weakly.** The system has hypotheses and a marketplace direction, but promotion still
   needs a crisp lease that binds post-cost expectancy, slippage, sample size, data quality, and platform proof.

## Alternatives Considered

### Option A: Keep Shadow Until All Global Health Is Green

Torghut would remain shadow-only until empirical jobs, market context, quant health, TCA, feature rows, drift checks,
and Jangar quorum are all healthy.

Pros:

- safest capital posture;
- easy to reason about during incidents;
- avoids live capital under stale proof.

Cons:

- treats every hypothesis and market segment the same;
- does not prioritize the repair work that gets a cell to profit;
- can leave capital idle even when one narrow cell is ready.

Decision: keep as the emergency default, not the architecture.

### Option B: Let the Capital Guardrail Marketplace Decide Directly

The existing capital marketplace would read raw Torghut status, metrics, and Jangar routes, then allocate shadow,
canary, or live budgets.

Pros:

- moves toward profitability quickly;
- uses the existing marketplace vocabulary;
- gives hypotheses a competition surface.

Cons:

- makes marketplace evaluation a heavy synchronous read path;
- repeats Jangar route-time proof problems inside Torghut;
- does not give broker admission one durable warrant input;
- makes replay and live decisions harder to audit.

Decision: useful after proof is leased, but not before.

### Option C: Profit Evidence Leases With a Capital Repair Loop

Torghut continuously computes compact ProfitEvidenceLease objects for each hypothesis/account/window. The leases cite
Jangar action leases, empirical artifacts, TCA, quant health, feature coverage, drift checks, market context, and
route health. If a lease holds capital, it also emits a repair target.

Pros:

- separates "keep learning" from "risk capital";
- makes every blocker actionable;
- gives broker admission one proof id to cite;
- lets strong narrow hypotheses earn canary capital without waiting for unrelated cells;
- makes stale or missing evidence cheap to return and easy to test.

Cons:

- adds storage and reconciler work;
- requires proof freshness contracts per hypothesis family;
- delays live widening until repair loops close.

Decision: select Option C.

## Chosen Architecture

### ProfitEvidenceLease

Torghut should persist and expose a compact lease:

```text
profit_evidence_lease
  lease_id
  lease_digest
  account
  window
  hypothesis_id
  strategy_family
  market_segment
  capital_stage_requested
  capital_stage_allowed
  decision                     # allow_shadow, allow_canary, allow_live, hold, quarantine
  jangar_external_capital_lease_id
  empirical_bundle_ref
  tca_window_ref
  quant_health_ref
  market_context_ref
  feature_quality_ref
  drift_check_ref
  expected_edge_bps
  avg_abs_slippage_bps
  sample_count
  max_notional
  blocked_reasons
  repair_targets
  observed_at
  fresh_until
```

The lease should be small enough for `/trading/status`, `/trading/health`, scheduler snapshots, and broker admission to
share it without recomputing the evidence.

### Hypothesis-Specific Gates

The first gates should reflect the current loaded hypotheses:

- `H-CONT-01` may remain shadow while it repairs Jangar dependency quorum. Canary requires fresh empirical jobs,
  feature rows, TCA less than 24 hours old, at least 40 samples in the current proof window, post-cost expectancy above
  6 bps, and average absolute slippage below 12 bps.
- `H-MICRO-01` stays blocked until microstructure and order-book feature rows are present, drift checks are fresh,
  Jangar dependency quorum is not blocking, and average absolute slippage is below 8 bps.
- `H-REV-01` stays shadow until market-context freshness is under 120 seconds for the traded segment, Jangar dependency
  quorum is not blocking, empirical jobs are fresh, and post-cost expectancy is above 8 bps.

These thresholds can be tuned later, but they must be explicit. A hypothesis with zero feature rows, stale empirical
jobs, and stale TCA should not receive capital because a route is alive.

### Capital Repair Loop

Every held lease should emit repair targets:

- `empirical_jobs_stale`: enqueue or surface the empirical refresh for the exact candidate and dataset snapshot.
- `tca_stale`: run or verify the TCA refresh for the account/window.
- `feature_rows_missing`: route to the feature producer and record the required feature set.
- `drift_checks_missing`: run drift governance for the strategy family.
- `quant_health_not_configured` or `quant_health_timeout`: wire or repair the typed Jangar quant-health route.
- `jangar_dependency_block`: wait for or repair the Jangar action lease dependency.
- `market_context_stale`: refresh the domain source that blocks the hypothesis.

Repair targets should preserve shadow learning. They are not a reason to disable the scheduler unless the scheduler
itself is unsafe.

### Broker Admission

Broker admission must require:

- a fresh ProfitEvidenceLease for the account/window/hypothesis;
- a Jangar `external_capital` action lease in `allow` or configured `warn` mode;
- an OrderAdmissionWarrant whose digest matches both leases;
- no stale or unknown proof for required fields.

If any required proof is missing, the broker path rejects non-shadow capital with a typed reason and keeps observe or
paper replay available.

## Validation Gates

Engineer stage acceptance gates:

- Unit tests for the lease evaluator covering all current blocker reasons from the May 5 status payload.
- Route parity tests proving `/trading/status` and `/trading/health` expose the same lease decision and digest.
- Scheduler tests proving shadow/replay work continues when non-shadow capital is held.
- Broker admission tests proving a missing Jangar external-capital lease, stale empirical jobs, stale TCA, missing
  feature rows, missing drift checks, or quant-health timeout blocks non-shadow orders.
- Regression test proving `simple_submit_disabled` maps to `shadow_only`, not a silent scheduler failure.

Deployer stage acceptance gates:

- Confirm current evidence produces `capital_stage_allowed=shadow` for all three loaded hypotheses.
- Confirm every held lease has at least one repair target.
- Confirm the typed Jangar quant-health route either answers quickly from projection or returns fast negative evidence.
- Confirm broker admission logs one compact blocker set per rejected non-shadow attempt and does not leak raw payloads.
- Confirm rollback can disable enforcement while keeping lease emission and repair targets active.

## Rollout Plan

1. **Shadow lease emission.** Persist or compute leases in memory and expose them on status routes without changing
   broker behavior.
2. **Route parity.** Make `/trading/status`, `/trading/health`, and scheduler snapshots report the same lease digest.
3. **Repair loop.** Emit repair targets for held leases and wire the highest-value refresh jobs.
4. **Broker warn mode.** Broker admission logs the lease decision it would enforce but does not block beyond existing
   switches.
5. **Broker enforcement.** Require the profit lease and Jangar external-capital lease for non-shadow orders.
6. **Canary widening.** Allow canary capital only for hypotheses with fresh leases and bounded notional.

## Rollback Plan

Rollback is configuration-only:

- set profit-lease enforcement to `off` or `warn`;
- keep lease emission and repair targets active;
- keep existing kill switch and simple-submit controls unchanged;
- do not delete proof rows or replay evidence;
- if the Jangar action lease route is unavailable, capital falls back to shadow-only while repair continues.

## Risks and Mitigations

- **Risk: the repair loop creates too many jobs.** Mitigation: dedupe by account/window/hypothesis/blocker and enforce
  per-family backoff.
- **Risk: thresholds are initially too strict.** Mitigation: start in shadow and publish would-have-promoted counts
  before enforcement.
- **Risk: broker admission and status drift.** Mitigation: both consume the same lease digest, with route parity tests.
- **Risk: slow Jangar proof blocks opportunity.** Mitigation: keep paper/replay/shadow work active and make Jangar
  route timeout a typed repair target.
- **Risk: profitability proxy is misleading.** Mitigation: require post-cost evidence, TCA freshness, sample count,
  and slippage caps together, not one metric alone.

## Handoff Contract

Engineer:

- implement the ProfitEvidenceLease evaluator as a pure function first;
- add route parity tests before broker enforcement;
- wire repair targets for the current blocker reasons;
- make broker admission cite both profit and Jangar action leases before non-shadow orders;
- keep observe, replay, paper, and shadow work running under held capital.

Deployer:

- do not enable broker enforcement until status, health, scheduler, and broker paths show the same lease digest;
- do not enable canary capital until at least one hypothesis has fresh empirical, TCA, feature, drift, quant, and Jangar
  proof;
- rollback through enforcement mode, not by disabling diagnostics or deleting evidence.
