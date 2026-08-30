# 147. Torghut Profit Repair Leases And Forecast Registry Settlement (2026-05-07)

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

I am selecting **profit repair leases with forecast registry settlement** as Torghut's next architecture direction.

Torghut is operating, but it is not capital-qualified. The live route is enabled, in live mode, and running on revision
`torghut-00254`. Postgres, ClickHouse, Alpaca, the Jangar universe, and empirical jobs are healthy. Direct database
reads show current trade decisions, fresh position snapshots, current empirical job runs, and a current Alembic head.

The same evidence says capital should stay closed. The health route returns HTTP `503`; proof floor is `repair_only`;
capital is `zero_notional`; live submission is blocked by `simple_submit_disabled`; forecast authority is degraded
because the registry is empty; market context has no current checked domain state; TCA is stale from
`2026-04-02T20:59:45.136640Z`; average absolute slippage is around `568.61` bps against an `8` bps guardrail; zero
hypotheses are promotion eligible; and database reads show zero `vnext_feature_view_specs`, zero
`vnext_promotion_decisions`, zero `execution_order_events`, and zero `simulation_run_progress` rows.

The decision is to convert Torghut's repair work into account-scoped profit repair leases. Each lease is a time-boxed
contract that names the hypothesis or route being repaired, the evidence debt being retired, the measurable profit
hypothesis, the Jangar lease ref it depends on, and the exact paper/live gate it can unlock. Forecast registry recovery
is the innovation axis, but it cannot outrank TCA, market context, stage health, or promotion truth. A forecast model
earns authority only when it is calibrated, versioned, expiry-bound, and connected to after-cost execution evidence.

The tradeoff is that paper reentry will be slower than a single flag flip. I accept that because fast paper on stale TCA
and empty forecast authority would produce noisy evidence that cannot graduate to live capital.

## Runtime Objective And Success Metrics

Success means:

- Torghut keeps observe and zero-notional repair open while paper and live remain closed.
- Every repair lease names the account, market window, affected hypothesis IDs, proof blocker, expected after-cost
  benefit, required Jangar lease ref, validation route or command, expiry, and rollback target.
- Forecast authority requires model cards with family, training window, calibration metric, expected shortfall coverage,
  feature contract, drift policy, and expiry.
- TCA renewal must reduce average absolute slippage from the stale `568.61` bps baseline toward the paper guardrail and
  prove route-specific costs before any live candidate.
- Market-context freshness must produce current domain state before context-sensitive hypotheses can promote.
- Paper requires at least one promotion-eligible hypothesis, current TCA, current market context when required, current
  stage health, forecast authority or waiver, and an explicit paper submit flag.
- Live requires paper settlement, after-cost expectancy, expected shortfall coverage, Jangar live action allow, and no
  active capital repair lease.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, broker state, empirical
artifacts, trading flags, or GitOps manifests.

### Cluster And Runtime

- Torghut deployments were available: live revision `00254`, sim revision `00354`, TA, sim TA, options TA, options
  catalog, options enricher, websocket, Alloy, and Symphony.
- Torghut data services were running: `torghut-db-1`, ClickHouse replicas, and Keeper.
- The empirical artifacts retention CronJob completed successfully earlier in the day.
- Rollout events still matter: ClickHouse pods matched multiple PDBs, Keeper PDB had `NoPods`, and Torghut/option
  revisions had transient startup readiness failures during rollout.
- RBAC prevented CNPG exec, Knative serving reads, PDB reads, and ClickHouseInstallation reads. Route and direct
  Postgres client evidence are therefore the practical verifier surfaces for this runner.

### Route Evidence

- `/healthz` returned `status=ok`.
- `/trading/status` reported `enabled=true`, `mode=live`, `running=true`, active revision `torghut-00254`, and build
  commit `ea859490fefb369075fd650ec2ed1ce5595b2d77`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, capital stage `shadow`, and
  promotion-eligible hypotheses `0`.
- Quant evidence was non-required and internally degraded: latest metrics count `144`, latest metrics updated around
  `2026-05-07T11:11Z`, stage count `0`, and reason `quant_pipeline_stages_missing`.
- Signal continuity was acceptable for a closed market: 12 symbols from Jangar, market session closed, and staleness
  classified as expected market-closed staleness.
- Forecast service was configured false, status degraded, authority blocked, message `registry_empty`, with allowed
  model families `chronos`, `financial_tsfm`, and `moment`.
- Lean authority was configured but disabled as a deterministic scaffold.
- `/trading/health` and `/readyz` returned HTTP `503` with proof-floor state `repair_only`, capital state
  `zero_notional`, and blockers for alpha readiness, execution TCA, market context, and simple submission.
- `/trading/empirical-jobs` returned healthy empirical authority with eligible `benchmark_parity`,
  `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` jobs.

### Database And Data

- Direct Postgres read used the application secret without printing secret values. The database was `torghut` with `69`
  public tables and Alembic head `0029_whitepaper_embedding_dimension_4096`.
- `trade_decisions` had `147,623` rows and latest decision `2026-05-06T17:44:19.618Z`.
- `executions` had `13,778` rows and latest update `2026-04-03T05:32:36.212Z`.
- `execution_tca_metrics` had `13,775` rows and latest update `2026-04-03T05:32:36.212Z`.
- `vnext_empirical_job_runs` had `20` rows and latest update `2026-05-06T16:27:32.941Z`.
- `vnext_completion_gate_results` had `6` rows and latest update `2026-05-06T16:27:32.941Z`.
- `strategy_hypotheses` had one persisted source row; runtime expands this into three hypothesis states.
- `strategy_hypothesis_metric_windows` had three rows.
- `position_snapshots` had `42,186` rows and latest snapshot `2026-05-06T20:58:43.888Z`.
- `execution_order_events`, `vnext_feature_view_specs`, `vnext_promotion_decisions`, and `simulation_run_progress`
  each had `0` rows.

### Source And Test Surfaces

- Runtime routes live in `services/torghut/app/main.py`, including `/healthz`, `/readyz`, `/db-check`,
  `/trading/status`, `/trading/empirical-jobs`, and `/trading/health`.
- Proof-floor logic lives in `services/torghut/app/trading/proof_floor.py`.
- Submission gate logic lives in `services/torghut/app/trading/submission_council.py`.
- Empirical job evaluation lives in `services/torghut/app/trading/empirical_jobs.py`.
- Market-context readiness lives in `services/torghut/app/trading/market_context.py`.
- Existing tests cover empirical jobs, forecast service, forecasting, market context, proof floor, promotion truthfulness,
  submission council, TCA adaptive policy, simulation progress, strategy runtime, feature contracts, and quant readiness.
- The missing implementation seam is a pure repair-lease reducer that consumes those existing facts and emits paper/live
  gate decisions without adding more orchestration to `main.py`.

## Problem

Torghut currently knows why it should not trade, but it lacks a capital-aware repair contract that turns that negative
evidence into ranked, measurable work.

The failure modes are:

1. **Fresh empirical jobs are overvalued.** They are necessary evidence, but they do not prove forecast authority, TCA
   quality, market-context freshness, feature coverage, or promotion eligibility.
2. **Forecast authority is binary and empty.** A registry-empty forecast service blocks action, but the system needs
   model-card settlement, not just a non-empty registry.
3. **Execution quality is stale and expensive.** TCA is more than a month stale and shows slippage far outside guardrail.
4. **Promotion is disconnected from data debt.** Zero promotion decisions and zero feature view specs mean hypotheses
   cannot graduate even when jobs are fresh.
5. **Control-plane evidence is fragmented.** Jangar action verdicts, Torghut proof floor, market context, forecast
   readiness, and TCA need one shared lease object for engineer and deployer stages.

## Alternatives Considered

### Option A: Sequentially Clear The Existing Repair Ladder

Pros:

- Simple and compatible with the current proof-floor route.
- Easy for operators to understand.
- Minimal new schema.

Cons:

- Treats every blocker as a queue item instead of a profit/capital constraint.
- Does not distinguish high-leverage TCA repair from low-impact route cleanup.
- Does not make forecast model authority measurable.

Decision: reject as the primary design, keep the current ladder as an input.

### Option B: Forecast Registry First

Pros:

- Directly addresses `registry_empty`.
- Opens the door to innovative model families like Chronos, MOMENT, and financial TSFM.
- Creates a clean research lane for measurable alpha.

Cons:

- Forecast authority alone cannot overcome stale TCA, stale market context, missing feature specs, or zero promotion
  decisions.
- It risks optimizing signal quality while execution costs destroy expectancy.
- It does not consume Jangar controller witness or action-class gates.

Decision: reject as a standalone direction, select it as a required lease dimension.

### Option C: Profit Repair Leases With Forecast Registry Settlement

Pros:

- Ranks repair work by expected after-cost capital unlock.
- Keeps zero-notional repair active while preventing paper/live shortcuts.
- Makes forecast authority a calibrated model-card contract.
- Ties Torghut's proof floor to Jangar's controller and action-class leases.
- Produces concrete acceptance gates for engineer and deployer stages.

Cons:

- Requires a new reducer, route contract, and eventually persistence.
- Requires calibration policy before model cards become authority.
- Keeps paper closed while evidence debt is retired.

Decision: select Option C.

## Architecture

Torghut consumes the current Jangar profit repair lease and emits its own account-scoped repair lease portfolio.

```text
torghut_profit_repair_lease
  lease_id
  jangar_lease_ref
  account_label
  market_window
  hypothesis_ids[]
  blocker_code
  proof_dimension
  current_state
  target_state
  expected_after_cost_bps
  expected_shortfall_coverage
  required_receipts[]
  validation_gate
  unlocks
  expires_at
  rollback_target
```

Required receipt families:

- `controller_witness_receipt` from Jangar;
- `forecast_model_card`;
- `stage_health_receipt`;
- `tca_renewal_receipt`;
- `market_context_receipt`;
- `feature_view_receipt`;
- `promotion_decision_receipt`;
- `paper_settlement_receipt`.

## Forecast Registry Settlement

Forecast authority becomes a model-card registry. A model card is eligible only when it includes:

- model family: `chronos`, `financial_tsfm`, `moment`, or an explicitly approved local baseline;
- training window and holdout window;
- feature contract version;
- target label and horizon;
- calibration metric and threshold;
- directional hit-rate or information-coefficient threshold;
- expected shortfall coverage;
- drift test and expiry;
- owner and rollback target.

Initial thresholds for paper candidate status:

- directional hit rate above `52%` on the current holdout or positive information coefficient with p-value policy
  documented;
- expected shortfall coverage at least `1.5x` the paper risk budget;
- calibration error not degraded from deterministic baseline;
- feature coverage at least `99%` for required fields;
- model card expires no later than the next market close unless renewed.

These thresholds are starting gates, not promises of profitability. They prevent the registry from becoming a string
presence check.

## Trading Hypotheses

The lease portfolio should carry measurable hypotheses:

- `H-FCAST-REG-01`: calibrated forecast registry improves shadow directional quality without increasing drift debt.
  Gate: eligible model card, current feature receipts, and shadow hit-rate/information coefficient above baseline.
- `H-TCA-REPAIR-01`: route and execution repair reduce average absolute slippage from the stale `568.61` bps baseline
  toward less than `25` bps in shadow and less than `8` bps before live scale.
  Gate: current TCA renewal receipt, route-specific sample size, and no hidden reject-rate increase.
- `H-MC-REVERSAL-01`: current market context reduces false reversal entries during news or fundamentals conflicts.
  Gate: current domain state, contradiction receipt, and improved after-cost expectancy versus context-blind baseline.
- `H-STAGE-HEALTH-01`: bounded stage receipts prevent promotions when metric rows are fresh but required stages are
  absent.
  Gate: all required stages current for account, strategy, and market window.

## Submission Quorum

Paper candidate requires:

- current Jangar lease with no controller-witness blocker for paper;
- `simple_submit_disabled=false` only after all evidence debts close;
- forecast model card ready or a signed waiver with expiry;
- TCA renewal current and inside paper guardrail;
- market context current for hypotheses that consume context;
- required feature views present;
- current stage receipts;
- at least one promotion decision eligible for paper;
- empirical jobs healthy and truthful;
- paper risk budget and expected shortfall coverage present.

Live candidate requires:

- paper settlement fresh;
- after-cost expectancy positive after slippage and fees;
- live Jangar action allow;
- no active capital repair lease;
- live submit intentionally enabled;
- rollback target tested.

## Implementation Scope

Engineer stage owns:

1. Add a pure `profit_repair_lease` reducer under `services/torghut/app/trading/`.
2. Feed it from existing status/proof-floor, submission council, forecast service, empirical jobs, market context, TCA,
   feature coverage, promotion decision, and Jangar lease payloads.
3. Add a route surface that exposes the current lease portfolio without broad database scans.
4. Add tests for fresh empirical jobs with empty forecast registry, stale TCA, missing feature view specs, missing
   promotion decisions, stale market context, missing Jangar lease, and full paper candidate success.
5. Keep the first implementation zero-notional. Do not enable paper or live as part of the reducer change.

Deployer stage owns:

1. Verify route latency and proof freshness after rollout.
2. Confirm Jangar lease and Torghut lease agree on action class.
3. Confirm `capital_state=zero_notional` until paper quorum passes.
4. Confirm rollback keeps `simple_submit_disabled` and live disabled.
5. Capture ClickHouse and Keeper PDB risk if the deployment touches data services.

## Validation Gates

Required local checks for code changes:

- `uv sync --frozen --extra dev`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- targeted `pytest` for reducer, forecast, TCA, market context, and submission quorum tests.

Required route checks before paper candidate:

- `/trading/health` proof floor no longer reports stale TCA, stale market context, or no promotion eligible.
- `/trading/status` reports forecast authority ready or waivered with expiry.
- `/trading/empirical-jobs` remains healthy and truthful.
- Jangar current lease endpoint returns no paper blocker.
- Current Torghut lease portfolio has no expired required receipt.

## Rollout

1. Ship the reducer and route as observe-only.
2. Compare lease blockers with the existing proof-floor repair ladder for one full market session.
3. Add persistence only after the route proves bounded and low latency.
4. Allow paper candidate status only after forecast model cards, TCA renewal, market context, and promotion decisions are
   current.
5. Allow live candidate status only after paper settlement proves after-cost expectancy and expected shortfall coverage.

## Rollback

Rollback is explicit:

- keep observe active;
- keep repair jobs active if they do not submit orders;
- keep `capital_state=zero_notional`;
- keep `simple_submit_disabled=true`;
- mark all active leases expired if Jangar lease is missing or controller witness split returns;
- block paper and live until fresh leases are reissued and Torghut proof quorum passes.

## Risks

- Model-card theater: a non-empty forecast registry can look authoritative unless calibration, drift, and expiry are
  enforced.
- TCA sample bias: stale executions may not represent current route behavior, so renewal needs current samples before
  live decisions.
- Lease inflation: every warning should not become a capital lease. Only evidence debts that affect action class,
  hypothesis promotion, or after-cost expectancy belong in the lease portfolio.
- RBAC gaps: verifier lanes cannot rely on CNPG exec or Knative reads today.
- Market-session closure: signal staleness during closed markets should not automatically block repair, but it also
  cannot be used as fresh promotion evidence.

## Handoff

Engineer should start with the pure reducer and tests. The first implementation target is not paper activation; it is a
truthful lease portfolio that names why paper is still closed and which repair retires the most capital-relevant debt.

Deployer should treat the lease route as a capital gate, not a rollout gate. It is acceptable to widen serving traffic
while leases remain `repair_only`; it is not acceptable to open paper or live until both Jangar and Torghut lease
contracts settle and the proof quorum passes.
