# 144. Torghut State-Coherent Profit Auction And TCA Renewal Governor (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut quant profitability, state-coherent capital proof, TCA renewal, forecast authority, feature/drift
coverage, Jangar state exchange consumption, validation, rollout, and rollback.

Companion Jangar contract:

- `docs/agents/designs/140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`

Extends:

- `140-torghut-endpoint-parity-profit-repair-and-capital-route-auction-2026-05-07.md`
- `139-torghut-profit-evidence-custody-and-capital-reentry-auction-2026-05-07.md`
- `138-torghut-profit-stats-census-and-tca-reactivation-market-2026-05-07.md`
- `136-torghut-capital-repair-escrow-and-freshness-auction-2026-05-07.md`

## Decision

I am selecting **a state-coherent profit auction with a TCA renewal governor** as Torghut's next quant architecture
step.

The current system has enough positive evidence to keep learning, but not enough to spend capital. Torghut live
revision `torghut-00252` is Running in `mode=live`; the matching sim revision `torghut-sim-00352` is also Running;
Postgres, ClickHouse, Alpaca, and the Jangar universe dependency are healthy; empirical jobs are fresh enough for
repair priority; and the current quant latest store is not empty. That supports observation and zero-notional repair.

It does not support paper or live capital. At `2026-05-07T09:29Z`, Torghut proof floor was `repair_only`,
`capital_state=zero_notional`, with blocking reasons `hypothesis_not_promotion_eligible`,
`execution_tca_stale`, and `simple_submit_disabled`. TCA was last computed on `2026-04-02T20:59:45.136640Z`, average
absolute slippage was about `568.61` bps against an `8` bps guardrail, and expected shortfall coverage was `0`. All
three hypotheses were shadow or blocked with capital multiplier `0`, zero promotion eligible, and three rollback
required. Feature batch rows, drift checks, and evidence continuity checks were all `0`. Forecast authority was blocked
with `registry_empty`; LEAN authority was disabled as a deterministic scaffold. Jangar dependency quorum was delayed or
blocked by watch reliability, depending on the control-plane route sampled.

I am not choosing a blanket freeze. I am also not choosing opportunistic paper promotion from fresh empirical jobs. I am
choosing a state-coherent auction: every repair bid must name the capital state it can unlock, the fresh Jangar state
exchange receipt it depends on, the data witness it renews, the measurable profit hypothesis it advances, and the
rollback target if the proof regresses.

The tradeoff is slower paper reentry. I accept that because the current bottleneck is not candidate generation. It is
truthful, fresh, account-scoped evidence that a candidate can survive trading costs and control-plane churn.

## Runtime Objective And Success Metrics

Success means:

- Torghut can continue observation and zero-notional repair while paper and live capital remain held.
- Fresh empirical jobs increase repair priority but never bypass TCA, feature, drift, forecast, Jangar, or submission
  gates.
- The auction emits one receipt per account, revision, and market window.
- Every bid has a measurable hypothesis, expected profit unlock, data freshness debt, evidence cost, capital state
  target, validation commands, and rollback target.
- Paper capital cannot open unless TCA is fresh, Jangar state exchange allows paper, forecast authority is non-empty or
  explicitly waived, feature/drift counters are non-zero for the selected hypothesis, and the live submission gate is
  intentionally enabled for paper.
- Live capital cannot open unless paper settlement is fresh, average absolute slippage is inside the hypothesis
  guardrail, expected shortfall coverage is present, and Jangar live action state is allow.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, ClickHouse tables, broker
state, trading flags, GitOps resources, empirical artifacts, or AgentRun records.

### Cluster And Rollout Evidence

- `kubectl get pods -n torghut -o wide` showed the current live revision `torghut-00252-deployment` and simulation
  revision `torghut-sim-00352-deployment` `2/2` Running.
- ClickHouse, Keeper, Postgres, TA, sim TA, options TA, options catalog, options enricher, WebSocket services,
  guardrail exporters, Alloy, and Symphony were Running.
- Older live revisions `torghut-00247` through `torghut-00251` and older sim revisions `torghut-sim-00347` through
  `torghut-sim-00351` were scaled to `0/0`.
- Torghut events showed database migrations and whitepaper/empirical backfill jobs completed during the rollout, and
  the `torghut-00252` and `torghut-sim-00352` revisions became ready after transient startup/readiness probe failures.
- Torghut events repeatedly reported `MultiplePodDisruptionBudgets` for ClickHouse pods, which means disruption
  policy is ambiguous even though ClickHouse pods are Running.
- The runtime service account cannot exec into Postgres or ClickHouse pods and cannot get CNPG clusters. Direct
  database/data inspection is therefore limited to typed runtime status routes and source schema artifacts in this run.

### Runtime And Data Evidence

- `GET /healthz` returned `{"status":"ok","service":"torghut"}`.
- `GET /trading/health` returned overall `status=degraded`.
- The dependency block showed Postgres `ok`, ClickHouse `ok`, Alpaca `ok`, universe `ok`, empirical jobs `ok`, DSPy
  runtime informational, and quant evidence informational.
- Alpha readiness reported `hypotheses_total=3`, state totals `blocked=1` and `shadow=2`,
  `promotion_eligible_total=0`, `rollback_required_total=3`, and dependency quorum delayed by
  `watch_reliability_degraded`.
- Live submission gate was closed for `simple_submit_disabled`, with capital stage `shadow`.
- Profitability proof floor was `repair_only`, capital state `zero_notional`, and max notional `0`.
- Proof dimensions showed empirical jobs passing, quant ingestion informational because ingestion lag was stale, market
  context passing in this closed-session sample, and execution TCA stale.
- TCA had `13775` orders, average slippage about `-13.78` bps, average absolute slippage about `568.61` bps,
  expected shortfall sample count `0`, and last computed timestamp `2026-04-02T20:59:45.136640Z`.
- Quant evidence had `latest_metrics_count=144`, latest update `2026-05-07T09:29:21.477Z`, pipeline lag `8` seconds,
  `stage_count=3`, and max stage lag `56,689` seconds because ingestion was stale while compute and materialization
  were current.
- `GET /trading/status` showed `feature_batch_rows_total=0`, `drift_detection_checks_total=0`,
  `evidence_continuity_checks_total=0`, `no_signal_windows_total=218`, and signal lag around `45,051` seconds during a
  closed market session.
- Forecast service was degraded with authority `blocked`, message `registry_empty`, no registry ref, and no
  promotion-authority eligible models.
- LEAN authority was disabled and explicitly marked `deterministic scaffold only`.
- Empirical jobs were fresh and truthful for `chip-paper-microbar-composite@execution-proof` on dataset
  `torghut-chip-full-day-20260505-5e447b6d-r1`.

### Source And Test Evidence

- `services/torghut/app/main.py` is about `4124` lines and composes readiness, status, TCA, proof floor, empirical
  jobs, decisions, executions, and API payloads.
- `services/torghut/app/trading/autonomy/lane.py` is about `7377` lines and
  `services/torghut/app/trading/autonomy/policy_checks.py` is about `6072` lines.
- `services/torghut/app/models/entities.py` is about `3064` lines and contains the persistence backbone for decisions,
  executions, TCA, promotions, research, and empirical jobs.
- The app has `153` Python source files and tests have `149` Python test files.
- Focused tests already exist for proof floor, empirical jobs, TCA adaptive policy, feature quality, forecasting,
  scheduler safety, autonomy, and readiness.
- The gap is not "no tests." The gap is no single state-coherent auction fixture that ties Jangar action state, TCA
  renewal, feature/drift counters, forecast authority, and hypothesis capital state into one paper/live decision.
- Alembic migrations under `services/torghut/migrations/versions` include `31` migration files through
  `0029_whitepaper_embedding_dimension_4096.py`.

## Problem

Torghut currently has useful evidence fragments but not a capital-state proof that is coherent enough for profitability
decisions.

The positive fragments are real:

- runtime dependencies are reachable;
- empirical jobs are fresh and truthful;
- the enabled universe has 12 symbols;
- quant latest metrics are updating;
- service liveness is good.

The blockers are more important:

- TCA is stale by more than a month;
- slippage is far outside the guardrail;
- expected shortfall coverage is zero;
- feature and drift counters are zero;
- forecast authority has no eligible model registry;
- LEAN remains a deterministic scaffold;
- Jangar state is degraded by watch reliability;
- no hypothesis is promotion eligible.

If Torghut acts on the positive fragments alone, it will run paper or live experiments that cannot explain after-cost
edge. If it freezes everything, it wastes fresh empirical jobs and stops collecting zero-notional evidence. The system
needs an auction that keeps capital safe while making the next highest-value repair obvious.

## Alternatives Considered

### Option A: Keep The Existing Proof Floor And Repair Ladder

Pros:

- Already implemented and exposed in `/trading/health` and `/trading/status`.
- Correctly keeps current capital at zero notional.
- Gives deployers direct blocker reasons.

Cons:

- The repair ladder is not state-coherent with Jangar action receipts.
- It does not make feature/drift/forecast/TCA repair bids compete by expected profit unlock.
- It cannot explain why a fresh empirical job should outrank or not outrank a TCA renewal job.

Decision: reject as the complete architecture.

### Option B: Promote Fresh Empirical Jobs To Paper After Jangar Watch Reliability Recovers

Pros:

- Fast path to new paper observations.
- Uses the freshest positive evidence in the current system.
- Easy to explain to stakeholders asking for trading progress.

Cons:

- Ignores stale TCA and high slippage.
- Ignores zero feature and drift counters.
- Ignores `forecast.registry_empty`.
- Treats watch reliability as the only missing gate.
- Risks spending paper effort on a candidate that cannot survive after-cost validation.

Decision: reject.

### Option C: State-Coherent Profit Auction And TCA Renewal Governor

Pros:

- Keeps paper/live capital blocked while allowing observe and repair.
- Prices each repair by the capital state it can unlock.
- Makes Jangar action state an input, not an afterthought.
- Forces TCA freshness and slippage guardrails before any paper/live promotion.
- Converts fresh empirical jobs into priority evidence without bypassing data quality.

Cons:

- Requires a new reducer and route payload.
- Requires scoring calibration to avoid arbitrary repair order.
- Requires deployer discipline to treat the auction receipt as the paper/live passport.

Decision: select Option C.

## Architecture

Torghut emits one profit-state auction receipt per account, revision, and market window.

```text
profit_state_auction_receipt
  receipt_id
  generated_at
  fresh_until
  account_label
  torghut_revision
  market_window
  jangar_state_exchange_ref
  current_capital_state
  selected_state_target
  bids[]
  blocked_capital_states[]
  rollback_target
```

Each bid is explicit and measurable.

```text
profit_state_bid
  bid_id
  hypothesis_id
  repair_domain             # tca, feature_coverage, drift, forecast_registry, quant_stage_witness,
                            # market_context, paper_settlement, jangar_state
  current_state             # observe, repair, shadow, paper_hold, live_block
  target_state              # repair_ready, paper_ready, live_micro_ready, live_scale_ready
  expected_profit_unlock_bps
  expected_drawdown_reduction_bps
  evidence_cost_units
  data_freshness_debt_seconds
  guardrail_failures[]
  required_jangar_action_state
  validation_refs[]
  rollback_target
  decision                  # select, defer, reject
  reason_codes[]
```

Auction score:

```text
score =
  expected_profit_unlock_bps
  + expected_drawdown_reduction_bps
  - evidence_cost_units
  - freshness_debt_penalty
  - control_plane_degradation_penalty
  - guardrail_failure_penalty
```

The score is only used for repair ordering. It must never override a hard capital guardrail.

## Measurable Trading Hypotheses And Guardrails

### H-CONT-01: Intraday Continuation

Hypothesis: continuation can earn positive after-cost expectancy when signal lag is under `90` seconds during market
open and TCA is current.

Paper gate:

- Jangar paper action state is `allow`.
- TCA computed within `24` hours.
- Average absolute slippage is `<= 12` bps.
- Expected shortfall coverage is non-zero and increasing.
- Post-cost expectancy proxy is `>= 6` bps.
- Feature rows are present for the session.

Rollback:

- Return to zero notional if signal lag breaches `90` seconds during market open, TCA age exceeds `24` hours, or
  average absolute slippage exceeds `12` bps.

### H-MICRO-01: Microstructure Breakout

Hypothesis: microstructure breakout can justify the highest repair priority only when order-book and feature coverage
become real, not synthetic.

Paper gate:

- Feature batch rows are `> 0`.
- Feature null rate is `< 2%`.
- Drift checks are `> 0` for the session.
- Average absolute slippage is `<= 8` bps.
- Minimum paper sample count is `60`.
- Post-cost expectancy proxy is `>= 10` bps.

Rollback:

- Return to repair-only if feature rows go to `0`, drift checks are missing, or slippage breaches `8` bps.

### H-REV-01: Event Reversion

Hypothesis: event reversion is only worth paper capital when market context freshness is current and Jangar state is
not degraded.

Paper gate:

- Jangar state exchange is fresh and paper action state is `allow`.
- Market-context freshness is `<= 120` seconds for regime and `<= 300` seconds for news during market open.
- TCA computed within `24` hours.
- Minimum paper sample count is `30`.
- Post-cost expectancy proxy is `>= 8` bps.

Rollback:

- Return to zero notional when market context is stale, Jangar state exchange is hold/block, or TCA is stale.

### Forecast Challenger

Hypothesis: forecast-assisted routing can improve capital efficiency only after model registry and calibration evidence
exist.

Paper gate:

- Forecast registry is non-empty.
- At least one model is promotion-authority eligible.
- Calibration status is healthy or explicitly waived for shadow-only use.
- Runtime fallback rate is under `1%`.
- Forecast calibration error is below the policy threshold for the model family.

Rollback:

- Disable forecast authority and keep deterministic fallback if registry is empty, calibration is degraded, or fallback
  rate exceeds threshold.

## Implementation Scope For Engineer

1. Add a pure auction reducer near the existing proof-floor and submission-council boundaries.
2. Feed it from existing status inputs: proof floor, TCA summary, hypothesis readiness, forecast service, quant
   evidence, feature/drift counters, empirical jobs, and Jangar state exchange.
3. Expose the receipt in `/trading/health` and `/trading/status`.
4. Add a compact route or existing payload block for deployer inspection.
5. Keep direct DB work out of request paths; use bounded summary reads and existing indexes.
6. Add tests that prove fresh empirical jobs cannot bypass stale TCA, zero feature/drift counters, forecast
   `registry_empty`, or Jangar hold/block states.

## Validation Gates

Engineer acceptance:

- Unit tests cover all alternatives in this document as fixtures.
- Regression tests prove current evidence maps to `zero_notional` and selects TCA renewal before paper promotion.
- Tests prove H-MICRO-01 is rejected when feature rows and drift checks are `0`.
- Tests prove H-REV-01 is rejected when Jangar state exchange is hold/block.
- Tests prove empirical jobs can raise repair priority but cannot authorize paper by themselves.
- Type checks and the relevant Torghut test subset pass.

Deployer acceptance:

- `curl -sS http://torghut.torghut.svc.cluster.local/trading/health | jq '.profit_state_auction_receipt'` returns a
  fresh receipt.
- The current degraded state keeps `capital_state=zero_notional`.
- TCA renewal is selected or explicitly deferred with a reason code.
- Paper stays held until Jangar state exchange allows paper, TCA is fresh, feature/drift counters are non-zero for the
  selected hypothesis, and forecast authority is non-empty or waived.
- Live stays blocked until paper settlement and live Jangar action state are fresh.

## Rollout

1. Ship the auction receipt in shadow mode.
2. Compare auction-selected repairs against the existing proof-floor repair ladder for one full market session.
3. Enforce the auction for paper readiness only after the shadow comparison shows no false paper allows.
4. Keep live enforcement blocked until at least one paper route bond settles with fresh TCA and post-cost evidence.
5. Add deployer runbook checks that cite the receipt id before any paper or live flag change.

## Rollback

If the auction creates false holds:

- leave the receipt visible in shadow mode;
- fall back to the existing proof-floor repair ladder;
- keep paper/live capital disabled until the scoring defect is fixed.

If the auction creates a false allow:

- force all paper/live targets to `zero_notional`;
- disable auction enforcement;
- require a fixture reproducing the false allow before reenabling;
- publish the failed receipt id in the deployer handoff.

## Risks

- Score calibration can become arbitrary if expected profit unlock is not tied to observed after-cost evidence.
- Fresh empirical jobs can decay while TCA repair is underway.
- Direct database and ClickHouse reads remain unavailable from this agent runtime, so initial deployer checks must use
  typed HTTP status and source schema artifacts.
- Feature and drift counters are currently zero, which means the first implementation may mostly rank repairs instead
  of unlocking paper immediately.

## Handoff

Engineer should implement the auction as a pure reducer over existing status evidence and keep it close to
`proof_floor` and `submission_council`. The first production behavior should be shadow-only receipt emission plus tests
that pin the current degraded state.

Deployer should treat the auction receipt as the paper/live passport. Observation and repair can continue under zero
notional. Paper and live must stay held until the receipt names fresh Jangar state, fresh TCA, non-zero feature/drift
evidence, and hypothesis-specific guardrail pass reasons.
