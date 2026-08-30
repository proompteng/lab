# 125. Torghut Profit-Priced Evidence Renewal And Capital Reentry Ledger (2026-05-06)

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

Torghut will publish **profit-priced evidence renewal bids** and settle capital reentry from the Jangar repair-clearing
lane. Torghut still owns hypothesis economics, empirical proof content, market-context requirements, and local
submission safety. It does not self-admit repair work or promote capital from local health alone.

The current runtime state proves the distinction. At `2026-05-06T15:08Z`, Torghut `/healthz` returned HTTP `200` and
`/db-check` returned HTTP `200`. The live revision was running, the scheduler was running, Postgres and ClickHouse were
healthy, Alpaca was reachable, the universe came from a fresh Jangar cache, and the Alembic schema was current. That
is an operating system.

It is not a capital-ready system. `/trading/health` returned HTTP `503`. The live submission gate was blocked by
`simple_submit_disabled`, the active capital stage was `shadow`, all three hypotheses had `capital_multiplier=0`, no
hypothesis was promotion eligible, all three required rollback, and empirical jobs were truthful but stale from
`2026-03-21`. The measured trading data is also stale for reentry: `last_decision_at` was `2026-05-04T17:25:57Z`, and
the TCA summary was last computed on `2026-04-02T20:59:45Z`.

The selected design makes Torghut bid for the evidence renewal that could unlock a named capital step. Jangar decides
whether that repair work is admitted through the companion clearing lane. Torghut then settles the result into a
capital reentry ledger that proves whether paper or live gates should remain shadow-only, advance, or retire.

The tradeoff is that profitable-looking hypotheses may stay in shadow while proof is renewed. I accept that. Profit is
not improved by letting stale proof act as fresh authority. Profit improves when Torghut spends renewal work on the
smallest experiment that can produce fresh, account-scoped, post-cost evidence.

## Evidence Snapshot

All evidence was collected read-only. I did not change trading flags, submit orders, mutate database rows, alter
Kubernetes resources, or change Argo applications.

### Runtime Evidence

- `deployment/torghut-00238-deployment` was `1/1` and serving the active live revision.
- `deployment/torghut-sim-00331-deployment` was `1/1` for the current sim revision.
- Torghut ClickHouse, Keeper, Postgres, live TA, sim TA, options TA, options catalog, options enricher, websocket
  services, guardrail exporters, Alloy, and Symphony pods were running.
- `/healthz` returned HTTP `200` with `{"status":"ok","service":"torghut"}`.
- `/trading/health` returned HTTP `503` with `status=degraded`.
- The service account can read service health through cluster DNS, but cannot list Torghut secrets or statefulsets.
  The contract must therefore depend on explicit Torghut projections, not privileged inspection.

### Database And Schema Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, and `schema_head_delta_count=0`.
- `schema_graph_lineage_ready=true`.
- Known parent-fork warnings remained at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`, but there were no lineage errors, orphan parents, duplicate revisions, missing
  heads, or unexpected heads.
- Account-scope checks were ready, with a warning that checks are bypassed when multi-account trading is disabled.

### Profit And Capital Evidence

- `/trading/status` reported `enabled=true`, `mode=live`, `pipeline_mode=simple`, `execution_lane=simple`, and
  `running=true`.
- The live submission gate reported `allowed=false`, `reason=simple_submit_disabled`, and `capital_stage=shadow`.
- `configured_live_promotion=false`, `autonomy_promotion_eligible=false`, `promotion_eligible_total=0`, and
  `simple_lane.submit_enabled=false`.
- `last_decision_at=2026-05-04T17:25:57.901670Z` and `last_run_at=2026-05-06T15:08:01.448939Z`.
- The TCA summary had `order_count=13775`, average absolute slippage around `568.6` bps, and
  `last_computed_at=2026-04-02T20:59:45.136640Z`, which is too old and too broad to authorize fresh paper or live
  capital.
- Hypotheses summary: total `3`, state totals `blocked=1` and `shadow=2`, capital stage totals `shadow=3`,
  promotion eligible `0`, rollback required `3`, dependency quorum `block` for `empirical_jobs_degraded`.
- `H-CONT-01` had a positive post-cost expectancy proxy but was blocked by Jangar dependency state and signal lag. It
  is the first paper-measurement candidate only after evidence renewal clears the Jangar blocker.
- `H-MICRO-01` was blocked by missing feature rows, missing drift checks, required feature set unavailability, Jangar
  dependency state, and signal lag. It should not receive the first renewal budget.
- `H-REV-01` was blocked by Jangar dependency state, market-context staleness, and signal lag. It needs market-context
  freshness before paper measurement.
- Empirical jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` were
  truthful and promotion-authority eligible when produced, but stale because they were created on
  `2026-03-21T09:03:22Z`.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already builds a live submission gate from hypothesis state,
  empirical readiness, Jangar dependency quorum, typed quant health, capital stage, and trading toggles.
- `services/torghut/app/trading/empirical_jobs.py` already represents empirical job truthfulness, staleness, candidate
  ids, dataset refs, artifact refs, and promotion authority.
- `services/torghut/app/trading/hypotheses.py` already compiles alpha readiness by hypothesis, including state,
  capital stage, promotion eligibility, rollback requirement, required feature sets, and dependency capabilities.
- `services/torghut/app/trading/scheduler/pipeline.py` already blocks submissions when the live submission gate denies
  action and records shadow capital blockers.
- Existing tests cover submission council behavior, empirical jobs, hypotheses, database status, market context, and
  quant readiness. The missing regression is renewal economics: a stale proof should become a priced renewal bid, not
  an implicit promotion blocker with no clearing path.

## Problem

Torghut knows which proof is stale and which hypotheses might be worth measuring, but it does not yet publish a compact
economic bid that Jangar can use to admit repair work.

That creates two failure modes:

1. stale proof blocks all capital without identifying the best first renewal;
2. local profitability signals can tempt a bypass around Jangar material-action authority.

The answer is not to make Torghut more autonomous in capital admission. The answer is to make Torghut more precise in
the evidence it asks Jangar to repair.

## Alternatives Considered

### Option A: Refresh All Empirical Jobs On A Fixed Cadence

Torghut periodically refreshes the stale empirical jobs and reports the new status to Jangar.

Pros:

- Simple operational model.
- Removes stale proof if the jobs succeed.
- Minimal new interface with Jangar.

Cons:

- Spends work without ranking by hypothesis value.
- Can renew evidence that does not unlock any capital step.
- Does not explain why one job is worth renewing before another.
- Does not address Jangar repair admission or rollout budgets.

Decision: reject. Fixed refresh is a maintenance task, not a profitability architecture.

### Option B: Let Local Hypothesis Scores Drive Paper Reentry

Torghut promotes the best hypothesis to paper when local health is good enough and the expected edge is positive.

Pros:

- Directly optimizes for trading outcomes.
- Keeps capital decisions close to the trading engine.
- Fastest path to paper measurement.

Cons:

- Bypasses Jangar final material-action verdicts.
- Treats stale proof as a local issue instead of a cross-plane blocker.
- Can promote while controller, rollout, or proof authority is still held.
- Makes rollback harder because the decision path is local.

Decision: reject as authority. Local profit scores can bid for repair; they cannot admit capital.

### Option C: Profit-Priced Evidence Renewal Bids

Torghut emits a renewal bid per hypothesis and proof gap. Jangar admits repair through the clearing lane. Torghut
settles the result in a capital reentry ledger and keeps paper/live blocked until the ledger, local gates, and Jangar
verdict all agree.

Pros:

- Ranks proof work by expected profit unlock.
- Keeps Jangar in charge of material-action admission.
- Gives engineers concrete tests and deployers concrete runtime gates.
- Prevents broad refresh work from masking stale capital authority.
- Produces a durable audit trail for why paper measurement was or was not allowed.

Cons:

- Adds a bid projection and settlement projection.
- Requires more conservative shadow behavior while the clearing lane is in observe mode.
- Needs careful metrics so expected profit does not overstate stale or broad TCA evidence.

Decision: select Option C.

## Architecture

Torghut adds a `profit_evidence_renewal_bid` projection.

```text
profit_evidence_renewal_bid
  bid_id
  generated_at
  expires_at
  hypothesis_id
  lane_id
  strategy_family
  candidate_id
  dataset_snapshot_ref
  account
  window
  requested_action_class             # paper_canary, live_micro_canary, live_scale
  missing_or_stale_proof_refs
  required_feature_sets
  required_dependency_capabilities
  expected_profit_unlock_bps
  expected_profit_confidence
  required_sample_count
  max_allowed_slippage_bps
  max_artifact_cost_usd
  max_notional
  local_blocker_codes
  jangar_verdict_ref
  bid_decision                       # propose, hold, withdraw
```

Torghut also adds a `capital_reentry_settlement` projection.

```text
capital_reentry_settlement
  settlement_id
  generated_at
  expires_at
  bid_id
  jangar_repair_item_ref
  hypothesis_id
  account
  window
  action_class
  empirical_job_refs
  quant_health_ref
  market_context_ref
  signal_continuity_ref
  feature_coverage_ref
  measured_sample_count
  measured_post_cost_expectancy_bps
  measured_avg_abs_slippage_bps
  measured_drawdown_bps
  local_submission_gate_ref
  jangar_final_verdict_ref
  decision                           # stay_shadow, paper_allowed, live_allowed, retire
  reason_codes
  rollback_target
```

The bid is not a request to trade. It is a request to spend evidence-renewal capacity. The settlement is the only
object that can later support paper or live reentry.

## First Reentry Ladder

Torghut should bid in this order unless live evidence changes:

1. `H-CONT-01` continuation gets the first paper-renewal bid because it is shadow, has an observed positive post-cost
   expectancy proxy, and lacks feature/drift blockers beyond Jangar dependency state and signal lag.
2. `H-REV-01` gets the second bid only after market-context freshness is repaired because event reversion depends on
   timely context.
3. `H-MICRO-01` stays blocked until feature coverage and drift checks exist; it should not consume the first stale-job
   renewal budget.

Paper measurement gates:

- Jangar final `paper_canary=allow`;
- Jangar repair-clearing item admitted and settled;
- renewed empirical jobs are truthful, non-stale, and promotion-authority eligible;
- typed quant latest store is nonempty for the account/window;
- signal lag is at or below the hypothesis threshold;
- measured sample count reaches the hypothesis threshold;
- measured post-cost expectancy and average absolute slippage meet the hypothesis contract.

Live micro-canary gates:

- all paper gates pass;
- Jangar final `live_micro_canary=allow`;
- paper settlement is fresh;
- local live submission gate allows;
- kill switch is off;
- max notional is explicitly nonzero and lower than the paper-measured risk budget.

## Implementation Scope

Engineer stage:

1. Add a small profit-bid builder near `services/torghut/app/trading/submission_council.py` or a focused adjacent
   module.
2. Expose `profit_evidence_renewal_bids` and `capital_reentry_settlements` in `/trading/status`.
3. Include bid summaries in `/trading/health` without making them liveness blockers.
4. Add a Jangar repair-clearing consumer that records the latest admitted repair item and expiry.
5. Add tests proving stale empirical proof creates bids, missing feature/drift requirements suppress bids, expired
   Jangar repair items fail closed, and paper/live stay shadow-only without settlement.
6. Keep order submission code unchanged until settlement enforcement is explicitly enabled.

Deployer stage:

1. Roll out in observe mode with bid emission only.
2. Verify `H-CONT-01` is the first bid candidate in the current evidence and `H-MICRO-01` remains held.
3. Enable paper settlement only after Jangar admits a matching repair-clearing item.
4. Enable live micro-canary only after paper settlement meets the measured thresholds.

## Validation Gates

Local validation before merge:

- `uv run --frozen pytest services/torghut/tests/test_submission_council.py -k renewal`
- `uv run --frozen pytest services/torghut/tests/test_empirical_jobs.py`
- `uv run --frozen pytest services/torghut/tests/test_hypotheses.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Runtime validation after rollout:

- `/trading/status` shows renewal bids with hypothesis id, candidate id, account, window, stale proof refs, and expiry.
- With current stale proof, bids may be `propose`, but capital settlement remains `stay_shadow`.
- `H-CONT-01` is prioritized before `H-MICRO-01` until feature coverage and drift checks exist.
- Expired or missing Jangar repair-clearing items keep paper/live blocked.
- No live submission occurs unless Jangar final verdict, local gate, renewed empirical proof, quant health, and
  settlement all agree.

## Rollout Plan

1. Observe: emit bids and settlements without changing capital behavior.
2. Paper settlement: require Jangar repair-clearing admission and renewed empirical proof before paper measurement.
3. Paper canary: allow paper only for the top settled hypothesis with explicit sample and slippage budgets.
4. Live shadow audit: require live verdicts in shadow for a full session with zero live submissions.
5. Live micro-canary: enable only after fresh paper settlement and explicit notional limits.

## Rollback Plan

- If bid generation is wrong, disable bid emission and leave capital in shadow.
- If settlement enforcement blocks unexpectedly, disable enforcement but keep bid telemetry visible.
- If settlement enforcement allows unexpectedly, enable the kill switch, force capital to shadow, and revert the
  settlement consumer.
- Do not delete empirical job history or hypothesis records during rollback; append a rollback receipt.
- If Jangar clearing data is stale or missing, Torghut treats it as `unknown` and blocks paper/live.

## Risks

- Expected profit can be overstated by stale or broad TCA data. Bids must mark confidence and require fresh settlement
  before capital movement.
- Observe-mode bid emission may look like approval to operators. The UI and status payload must label bids as repair
  requests, not trading authorization.
- Paper measurement can be delayed by Jangar repair admission. That is acceptable while proof is stale.
- A broad submission-council patch can be risky. Keep bid construction and settlement reduction small and covered by
  tests.

## Handoff

Engineer acceptance gates:

- A fixture matching the current state emits an `H-CONT-01` renewal bid and keeps final capital decision
  `stay_shadow`.
- A fixture for `H-MICRO-01` with missing feature rows and drift checks emits `hold`, not `propose`.
- A fixture with stale empirical jobs but no Jangar repair-clearing item keeps paper and live blocked.
- A fixture with fresh settlement but Jangar `live_micro_canary=block` keeps live blocked.
- Status and health payloads expose bids without changing liveness semantics.

Deployer acceptance gates:

- Observe-mode rollout shows bids and no change to order submission behavior.
- Paper settlement enforcement is enabled only after Jangar admits the matching repair item.
- Live micro-canary remains disabled until paper settlement and Jangar live verdict are both fresh.
- Rollback instructions include the exact enforcement flag, kill-switch path, and revert PR.
