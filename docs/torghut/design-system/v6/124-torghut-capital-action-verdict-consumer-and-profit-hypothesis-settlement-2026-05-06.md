# 124. Torghut Capital Action Verdict Consumer And Profit Hypothesis Settlement (2026-05-06)

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

Torghut will consume Jangar's final **material action verdict** before it moves any hypothesis from shadow observation
to paper canary, live micro-canary, or live scale. Torghut will keep profit semantics local, but it will not treat
local readiness, empirical freshness, or dependency-quorum text as final capital authority.

The current runtime state makes the need clear. At `2026-05-06T14:25Z`, Torghut was alive: `/trading/status` reported
`enabled=true`, `running=true`, `mode=live`, `pipeline_mode=simple`, and `kill_switch_enabled=false`. `/readyz`
reported scheduler, Postgres, ClickHouse, Alpaca, database schema, and Jangar universe healthy. The active live and
sim Knative revisions were running.

That is not a capital green light. `/readyz` returned HTTP `503` because live submission was blocked by
`simple_submit_disabled` in `capital_stage=shadow`. The hypothesis summary had `3` hypotheses, `0` promotion eligible,
and `3` rollback required. Jangar dependency quorum blocked on `empirical_jobs_degraded`. Torghut empirical jobs were
truthful but stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`,
all tied to candidate `intraday_tsmom_v1@prod` and dataset `torghut-full-day-20260318-884bec35`. Jangar typed quant
health for `account=paper&window=1d` was degraded with an empty latest store.

The selected design makes Torghut a consumer of one Jangar final verdict per capital action class. Torghut still owns
profit hypotheses, candidate scoring, empirical claims, and submission safety. Jangar owns whether a material action is
admissible. Paper and live gates require both sides to agree on the same account, window, hypothesis, and action class.

The tradeoff is that profitable-looking opportunities may wait longer in shadow. I accept that. Profitability improves
when the first paper reentry is backed by fresh proof and unambiguous action authority, not when a local route promotes
because it can see some healthy dependencies.

## Evidence Snapshot

All checks were read-only.

### Runtime Evidence

- Torghut live revision `torghut-00238` and sim revision `torghut-sim-00329` were running.
- ClickHouse, Keeper, Postgres, live TA, sim TA, options TA, options catalog, options enricher, websockets, guardrail
  exporters, Alloy, and Symphony pods were running in namespace `torghut`.
- Recent Torghut events showed previous `torghut-ta-sim` image pull and crash-loop debt recovered into a running
  deployment, plus transient readiness/startup probe failures during revision replacement.
- The runtime service account could not exec into Torghut Postgres, so service-owned projections are the ordinary
  database evidence surface for this lane.
- `/readyz` returned HTTP `503` with `status=degraded`.
- `/healthz` returned HTTP `200` with `status=ok`, which confirms that health and capital readiness are separate
  signals.

### Data And Profit Evidence

- Database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema graph lineage was ready, with known historical parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `/trading/status` reported live submission `allowed=false`, `reason=simple_submit_disabled`, and
  `capital_stage=shadow`.
- The dependency quorum visible to hypotheses returned `decision=block` for `empirical_jobs_degraded`.
- Hypothesis `H-CONT-01` was in shadow, had `capital_multiplier=0`, and was blocked by Jangar dependency state and
  signal lag. Its observed proxy still carried positive post-cost expectancy, so it is a candidate for paper
  measurement only after evidence freshness is repaired.
- Hypothesis `H-MICRO-01` was blocked by missing feature rows, missing drift checks, stale dependency state, and signal
  lag. It requires feature coverage and drift governance before any paper reentry.
- Hypothesis `H-REV-01` was in shadow and blocked by Jangar dependency state, market-context staleness, and signal lag.
  It requires market-context freshness before paper reentry.
- Jangar action SLO budgets held `paper_canary` and blocked `live_micro_canary` and `live_scale` because empirical proof
  is stale.
- Jangar action clocks held `torghut_capital` but allowed `merge_ready`, proving Torghut should consume the final
  material action verdict, not any partial Jangar input.
- Jangar typed quant health for `account=paper&window=1d` returned `status=degraded`, `latestMetricsCount=0`, and
  `emptyLatestStoreAlarm=true`.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already builds the live submission gate from hypothesis state,
  empirical readiness, typed Jangar quant health, and critical toggles.
- `services/torghut/app/trading/empirical_jobs.py` already tracks truthfulness, freshness, candidate ids, dataset refs,
  artifact refs, and promotion authority eligibility.
- `services/torghut/app/trading/hypotheses.py` already represents hypothesis state, capital stage, promotion
  eligibility, rollback requirement, required feature sets, and dependency capabilities.
- `services/torghut/app/trading/scheduler/pipeline.py` already blocks submissions when the live submission gate denies
  action and records `capital_stage_shadow` as a local block.
- Existing tests cover empirical jobs, hypotheses, submission council behavior, trading readiness, database schema
  status, quant readiness, and market context. The missing regression is cross-plane: a local Torghut paper or live
  gate cannot allow unless Jangar's final material action verdict allows the same capital action class.

## Problem

Torghut has local proof semantics but not final action authority.

That separation is correct. Torghut should know which hypothesis might earn money, which empirical jobs are stale, and
which market-context or feature dependencies are missing. Jangar should know whether the control plane is allowed to
merge, widen rollout, or admit capital. The failure mode is when Torghut reads partial Jangar surfaces, or treats a
local readiness improvement as sufficient to move capital state.

The current state has three specific risks:

1. Local health is green enough to run, but capital readiness is correctly degraded.
2. Empirical jobs are truthful but stale, so old proof can look authoritative unless freshness is part of settlement.
3. Jangar surfaces can disagree, so Torghut must bind to the final Jangar material-action verdict rather than a partial
   dependency-quorum or action-clock input.

## Alternatives Considered

### Option A: Torghut Uses `/readyz` As The Capital Contract

Paper or live gates advance when `/readyz` becomes HTTP `200` and local blockers clear.

Pros:

- Simple.
- Keeps the capital path inside Torghut.
- Easy for operators to understand during manual checks.

Cons:

- `/readyz` is an operational readiness route, not Jangar action authority.
- It can turn green without proving merge, paper, or live action parity.
- It does not settle Jangar contradictions.
- It cannot distinguish observation safety from capital admission.

Decision: reject. Keep `/readyz` as an operational signal, not the capital contract.

### Option B: Torghut Self-Certifies Capital Reentry From Empirical Freshness

Torghut marks a hypothesis paper-eligible when required empirical jobs and local feature checks are fresh.

Pros:

- Places trading semantics close to the trading service.
- Lets quant scoring evolve quickly.
- Directly targets the stale-proof blocker.

Cons:

- Fresh proof is necessary but not sufficient for Jangar material action.
- It cannot see Jangar rollout, merge, watch, and action SLO contradictions.
- It risks promoting based on local truth while the control plane is still holding the action class.

Decision: reject as authority. Keep it as a claim generator.

### Option C: Capital Action Verdict Consumer

Torghut keeps a local profit hypothesis ledger and consumes Jangar's final material action verdict for each capital
action. A hypothesis can move only when local profit proof and Jangar final action authority both allow.

Pros:

- Preserves Torghut ownership of profit semantics.
- Preserves Jangar ownership of material action authority.
- Prevents partial Jangar surfaces from becoming accidental capital gates.
- Makes paper reentry measurable by hypothesis, account, window, candidate, and action class.
- Gives deployers one clean rollback point.

Cons:

- Adds a cache and parity checks to submission council.
- Requires conservative shadow behavior while Jangar verdicts are in shadow emission.
- Makes early paper reentry slower.

Decision: select Option C.

## Architecture

Torghut adds a `capital_action_verdict_snapshot` consumed from Jangar.

```text
capital_action_verdict_snapshot
  snapshot_id
  fetched_at
  expires_at
  jangar_epoch_id
  jangar_epoch_digest
  account
  window
  action_class                      # paper_canary, live_micro_canary, live_scale
  jangar_decision                   # allow, repair_only, hold, block, contradicted, unknown
  jangar_reason_codes
  jangar_required_repairs
  local_submission_gate_ref
  local_empirical_claim_refs
  local_quant_health_refs
  local_market_context_refs
  final_capital_decision            # observe, shadow_only, paper_allowed, live_allowed, blocked
  final_reason_codes
```

Torghut also adds a `profit_hypothesis_settlement` projection.

```text
profit_hypothesis_settlement
  settlement_id
  generated_at
  expires_at
  hypothesis_id
  lane_id
  candidate_id
  dataset_snapshot_ref
  account
  window
  required_action_class
  jangar_verdict_snapshot_ref
  empirical_job_refs
  quant_health_ref
  market_context_ref
  signal_continuity_ref
  feature_coverage_ref
  expected_profit_hypothesis
  measured_sample_count
  measured_post_cost_expectancy_bps
  measured_avg_abs_slippage_bps
  promotion_decision                # stay_shadow, paper_candidate, live_candidate, retire
  guardrail_reason_codes
```

## Measurable Trading Hypotheses

Torghut must keep the first reentry ladder measurable:

- `H-CONT-01` continuation: paper canary requires fresh empirical jobs, signal lag at or below `90` seconds, at least
  `40` paper samples, post-cost expectancy at least `6` bps, and average absolute slippage at or below `12` bps.
- `H-MICRO-01` microstructure breakout: paper canary requires feature rows present, drift checks present, fresh
  empirical proof, at least `60` paper samples, post-cost expectancy at least `10` bps, and average absolute slippage
  at or below `8` bps.
- `H-REV-01` event reversion: paper canary requires market-context freshness at or below `120` seconds, fresh empirical
  proof, at least `30` paper samples, post-cost expectancy at least `8` bps, and average absolute slippage at or below
  `12` bps.

All three require Jangar final `paper_canary=allow` before paper measurement and Jangar final `live_micro_canary=allow`
before any live notional. Until then, their capital decision is `shadow_only`.

## Guardrails

- If Jangar verdict is `hold`, `block`, `contradicted`, or `unknown`, Torghut capital stays `shadow_only`.
- If Jangar verdict is stale, Torghut treats it as `unknown`.
- If local `/readyz` is degraded for storage, broker, or scheduler, Torghut blocks even if Jangar allows.
- If empirical jobs are stale, paper and live remain blocked even if local health is ok.
- If typed quant latest store is empty for the selected account/window, paper and live remain blocked.
- If market-context freshness is required by the hypothesis and stale, paper and live remain blocked.
- If the kill switch is enabled, all capital decisions are blocked regardless of Jangar verdict.

## Implementation Scope

Engineer stage:

1. Add a Jangar verdict client to `services/torghut/app/trading/submission_council.py` or a small adjacent module.
2. Cache verdict snapshots with explicit expiry and expose the latest snapshot in `/trading/status` and `/readyz`.
3. Extend `build_live_submission_gate_payload` so paper/live decisions require the final Jangar action verdict.
4. Add settlement records for each active hypothesis, account, and window.
5. Add tests proving local empirical freshness cannot promote capital when Jangar final verdict is hold or block.

Deployer stage:

1. Start in observe mode: fetch and display Jangar verdicts without changing capital decisions.
2. Move paper canary enforcement after Jangar emits stable verdict epochs and local tests pass.
3. Move live micro-canary enforcement only after paper settlement meets the measured guardrails above.
4. Keep `TRADING_ENABLED` and the kill switch as hard stop controls.

## Validation Gates

Local validation before merge:

- `uv run --frozen pytest services/torghut/tests/test_submission_council.py -k verdict`
- `uv run --frozen pytest services/torghut/tests/test_empirical_jobs.py`
- `uv run --frozen pytest services/torghut/tests/test_hypotheses.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Runtime validation after rollout:

- `/trading/status` shows the latest Jangar material action verdict epoch id and expiry.
- With stale empirical jobs, final Torghut capital remains `shadow_only`.
- With Jangar `paper_canary=hold`, no hypothesis reports `paper_allowed`.
- With Jangar `live_micro_canary=block`, live submission remains blocked even if local proof is otherwise fresh.
- When a verdict expires, Torghut treats it as `unknown` and blocks capital.

## Rollout Plan

1. Observe: fetch and expose Jangar verdict snapshots; do not enforce them.
2. Paper enforce: require `paper_canary=allow` plus local proof before paper measurement.
3. Live shadow audit: require `live_micro_canary=allow` in shadow for at least one full session with zero attempted
   live submissions.
4. Live micro-canary: enable only with fresh empirical proof, nonempty typed quant latest store, required market
   context freshness, and Jangar final verdict allow.
5. Scale: require a separate `live_scale=allow` verdict and paper/live performance evidence.

## Rollback Plan

- If verdict fetching fails, keep capital in shadow and continue local observation.
- If verdict enforcement blocks unexpectedly, turn off enforcement and keep snapshots visible for debugging.
- If verdict enforcement allows unexpectedly, enable the kill switch, force capital to shadow, and revert the consumer
  PR before reattempting.
- Do not mutate empirical job rows or hypothesis history during rollback; append a rollback note or receipt instead.

## Risks

- The first implementation may over-block paper measurement. That is acceptable while proof freshness is stale.
- Jangar verdict latency can become a trading dependency. Cache expiry must be explicit and short enough to fail
  closed.
- Hypothesis-level metrics can look profitable while capital remains blocked. Operators need the settlement projection,
  not only strategy metrics.
- A broad submission-council patch can become risky; keep the Jangar client and settlement reducer small.

## Handoff

Engineer acceptance gates:

- Submission council tests prove Jangar hold/block/contradicted/unknown keeps capital in shadow.
- Hypothesis settlement tests prove each active hypothesis cites account, window, candidate, empirical refs, and Jangar
  verdict.
- Expired verdict snapshots fail closed.
- Existing readiness and empirical job tests still pass.

Deployer acceptance gates:

- Observe-mode rollout exposes verdict snapshots without changing capital state.
- Paper enforcement is not enabled until Jangar final `paper_canary=allow` is visible and local proof is fresh.
- Live enforcement is not enabled until paper settlement evidence meets the measured thresholds.
- Rollback instructions include the exact enforcement flag and kill-switch path.
