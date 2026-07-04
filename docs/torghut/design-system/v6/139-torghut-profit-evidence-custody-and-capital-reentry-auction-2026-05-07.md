# 139. Torghut Profit Evidence Custody And Capital Reentry Auction (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut quant profitability, Jangar custody receipts, forecast authority, quant ingestion, TCA settlement,
promotion readiness, capital reentry, validation, rollout, and rollback.

Companion Jangar contract:

- `docs/agents/designs/135-jangar-rollout-availability-escrow-and-consumer-evidence-custody-2026-05-07.md`

Extends:

- `138-torghut-profit-stats-census-and-tca-reactivation-market-2026-05-07.md`
- `136-torghut-capital-repair-escrow-and-freshness-auction-2026-05-07.md`
- `135-torghut-capital-qualified-alpha-router-and-execution-repair-ladder-2026-05-06.md`
- `129-torghut-bidirectional-quant-proof-receipts-and-profit-reentry-ledger-2026-05-06.md`

## Decision

I am selecting **profit evidence custody with a capital reentry auction** as Torghut's next quant profitability
architecture step.

Torghut can run, but it is not trade-ready. At `2026-05-07T07:13Z`, live revision `torghut-00251` was Running in
`mode=live` with `enabled=true`, `running=true`, `kill_switch_enabled=false`, and aligned critical toggles. Postgres
schema checks passed with Alembic head `0029_whitepaper_embedding_dimension_4096`, and empirical jobs were fresh for
candidate `chip-paper-microbar-composite@execution-proof` on dataset
`torghut-chip-full-day-20260505-5e447b6d-r1`. That is enough to keep the zero-notional repair loop alive.

It is not enough to spend capital. `GET /readyz` and `GET /trading/health` returned `503`. The forecast service was
`degraded` with `registry_empty`. The autonomy bridge source was unavailable and compiled `0` strategy specs. The live
submission gate was closed for `simple_submit_disabled` with `capital_stage=shadow`,
`configured_live_promotion=false`, and `promotion_eligible_total=0`. Quant evidence was degraded: latest metrics were
fresh, but ingestion lag was `48523` seconds and max stage lag was `48523` seconds. The proof floor was
`repair_only`, capital state `zero_notional`, and blocking reasons were `hypothesis_not_promotion_eligible`,
`execution_tca_stale`, and `simple_submit_disabled`. Execution TCA was last computed on
`2026-04-02T20:59:45.136640Z`, with `13775` orders and average absolute slippage around `568.61` bps against an
`8` bps guardrail. Jangar also entered a rollout availability gap during the same pass.

I am not choosing direct paper promotion or a blanket freeze. I am choosing a custody-aware reentry auction: empirical
proof, decision history, and options/market data can bid for zero-notional repair priority, but capital cannot move
from `zero_notional` to paper until Jangar custody, forecast authority, quant ingestion, promotion eligibility, and
TCA settlement are current. The tradeoff is slower paper reentry. I accept that because the current risk is not lack of
ideas; it is stale and contradictory proof around whether any idea survives live costs and control-plane churn.

## Runtime Objective And Success Metrics

This contract increases profitability by making capital reentry a measurable auction over custody-grade evidence
rather than a binary toggle.

Success means:

- Fresh empirical jobs increase repair priority but cannot authorize paper by themselves.
- Forecast `registry_empty`, quant ingestion lag, stale TCA, missing Jangar custody, and zero promotion eligibility are
  hard paper/live holds.
- Torghut can continue observe and zero-notional repair work while Jangar or data-plane evidence is degraded.
- Every paper/live candidate carries a capital reentry auction receipt with blocker refs, expected unblock value,
  validation commands, and rollback target.
- The router can explain the current state for each hypothesis as `research_only`, `repair_bid`, `shadow_ready`,
  `paper_ready`, `live_micro_ready`, or `blocked`.
- Deployer stages have explicit widen, hold, and rollback gates that do not require direct database mutation.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, ClickHouse
tables, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Service Evidence

- Torghut namespace had live `torghut-00251-deployment` and simulation `torghut-sim-00351-deployment` pods `2/2`
  Running.
- ClickHouse, Keeper, Postgres, TA, sim TA, options TA, options catalog, options enricher, WebSocket services,
  guardrail exporters, Alloy, and Symphony were Running.
- Several old live and sim revisions were scaled to `0/0`, and the current revisions had startup/readiness probe
  warnings during warmup before becoming Ready.
- Recent Torghut events showed repeated `MultiplePodDisruptionBudgets` warnings for ClickHouse pods.
- The current service account could not exec into Postgres pods or list CNPG clusters, PDBs, Knative services, or Argo
  Workflows in Torghut. Production validation must therefore rely on read-only HTTP routes, Kubernetes objects allowed
  by RBAC, and existing GitOps artifacts rather than manual database sessions.

### Route And Data Evidence

- `GET /healthz` returned `{"status":"ok","service":"torghut"}`.
- `GET /readyz` returned `503`.
- `GET /db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, `schema_head_delta_count=0`, and lineage warnings for known parent
  forks around revisions `0010` and `0015`.
- `GET /trading/health` returned `503`.
- `GET /trading/status` returned `mode=live`, `enabled=true`, `running=true`, `kill_switch_enabled=false`, and live
  revision `torghut-00251`.
- Forecast service status was `degraded`, authority `blocked`, message `registry_empty`, calibration status
  `degraded`, and no promotion-authority eligible models.
- Empirical jobs were `healthy` and fresh with eligible jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- Autonomy was disabled and the bridge source was `unavailable`, with `0` compiled strategy specs and no authoritative
  evidence objects.
- Signal continuity had `universe_status=ok`, `universe_symbols_count=12`, `last_state=expected_market_closed_staleness`,
  and no active alert. That supports closed-session observe, not paper.
- Quant evidence was `degraded` but non-empty: latest metrics count `144`, latest metrics updated at
  `2026-05-07T07:13:15.343Z`, metrics pipeline lag `11` seconds, and max stage lag `48523` seconds.
- The quant ingestion stage was not OK with lag `48523` seconds, while compute and materialization were current.
- Proof floor was `repair_only`; route state was `repair_only`; capital state was `zero_notional`; max notional was
  `0`.
- Execution TCA was stale from `2026-04-02T20:59:45.136640Z`, with `avg_abs_slippage_bps=568.6138848199565249` and no
  expected shortfall coverage.

### Source Evidence

- `services/torghut/app/main.py` composes readiness, trading status, empirical jobs, quant evidence, live submission
  gate, and proof floor in one large FastAPI module.
- `services/torghut/app/trading/submission_council.py` already loads Jangar quant evidence and builds live submission
  gate payloads from dependency quorum, empirical readiness, quant health, market context, TCA, and promotion evidence.
- `services/torghut/app/trading/proof_floor.py` already produces the profitability proof floor receipt and repair
  ladder consumed by status and readiness.
- `services/torghut/app/trading/empirical_jobs.py` already marks jobs promotion-authority eligible only when required
  job families, scorecards, and lineage are truthful.
- `services/torghut/app/trading/tca.py` already aggregates execution metrics, slippage, shortfall, churn, divergence,
  and calibration fields.
- `services/torghut/app/trading/hypotheses.py` already evaluates promotion eligibility and reasons such as stale
  market context and missing dependency capabilities.
- The high-risk source shape remains concentrated: `pipeline.py` is `4349` lines, `workflow.py` is `4473` lines,
  `governance.py` is `1917` lines, and `simple_pipeline.py` is `683` lines. The implementation should add a reducer
  beside existing proof-floor/submission-council logic, not embed more branching in the scheduler.
- Torghut has `153` Python app files and `141` Python test files, with existing focused coverage for empirical jobs,
  scheduler autonomy, trading pipeline, TCA, strategy hypotheses, and readiness.

## Problem

Torghut has several positive signals, but none of them are custody-grade for capital.

The current positive signals are useful:

- the service is live and running;
- database schema lineage is current;
- empirical jobs are fresh and truthful;
- Jangar quant latest metrics are non-empty;
- the enabled universe has 12 symbols;
- closed-session signal staleness is expected.

The current blockers are stronger:

- forecast authority is empty;
- autonomy bridge evidence is unavailable;
- quant ingestion is stale by more than 13 hours;
- TCA is stale by more than a month and slippage is far outside the guardrail;
- no hypothesis is promotion eligible;
- live submission is deliberately disabled;
- Jangar rollout availability and watch reliability are not fully settled.

If Torghut treats fresh empirical proof as sufficient, it risks paper or live tests that cannot explain post-cost edge.
If Torghut freezes all work, it wastes the fresh empirical proof and delays the fastest repair path. The system needs a
custody-aware market that spends engineering and zero-notional runtime on the blockers with the highest capital
unblock value.

## Alternatives Considered

### Option A: Promote The Fresh Empirical Candidate To Paper

Pros:

- Fastest path to new paper observations.
- Uses fresh and truthful empirical jobs.
- Keeps the quant loop visibly active.

Cons:

- Ignores forecast `registry_empty`.
- Ignores stale quant ingestion.
- Ignores stale TCA and high slippage.
- Ignores `promotion_eligible_total=0`.
- Ignores Jangar rollout availability debt.

Decision: reject.

### Option B: Freeze All Torghut Quant Work Until Every Dependency Is Green

Pros:

- Strong capital safety.
- Simple deployer rule.
- Avoids acting on contradictory evidence.

Cons:

- Stops observe and zero-notional repair despite healthy schema and fresh empirical jobs.
- Gives no ordering among forecast, quant ingestion, TCA, promotion, and Jangar custody repairs.
- Lets empirical jobs decay before they can inform repair priority.

Decision: reject.

### Option C: Profit Evidence Custody And Capital Reentry Auction

Pros:

- Keeps paper/live notional at `0` until custody-grade evidence is current.
- Converts fresh empirical proof into repair priority without bypassing capital gates.
- Gives every blocker a score, validation command, and rollback target.
- Makes Jangar rollout and watch reliability part of capital custody rather than an external concern.
- Produces a concrete engineer/deployer handoff.

Cons:

- Requires a new reducer and route payload.
- Requires scoring calibration to avoid arbitrary repair order.
- May delay paper reentry compared with opportunistic empirical promotion.

Decision: select Option C.

## Architecture

Torghut emits one capital reentry auction receipt per account, market window, and revision.

```text
capital_reentry_auction_receipt
  receipt_id
  generated_at
  account_label
  torghut_revision
  market_window
  jangar_custody_ref
  proof_floor_ref
  live_submission_gate_ref
  capital_state             # zero_notional, repair_only, shadow, paper_ready, live_micro_ready
  max_notional
  selected_bid_refs
  blocked_bid_refs
  reason_codes
  fresh_until
  rollback_target
```

Each blocker becomes a repair bid.

```text
capital_reentry_bid
  bid_id
  blocker_code              # forecast_empty, quant_ingestion_stale, tca_stale, promotion_empty, jangar_custody_gap
  evidence_family
  current_state
  current_value
  threshold
  expected_unblock_value
  empirical_support_refs
  validation_command_ref
  max_notional              # always 0 until the receipt is paper_ready
  selected
  reason_codes
```

### Initial Auction Scoring

```text
score =
  blocker_severity
  + expected_unblock_value
  + empirical_support_bonus
  + market_session_value
  - repair_cost
  - operational_risk
```

Initial selected bid order from the current evidence:

1. `tca_stale`: refresh execution TCA settlement for active decision symbols; it is the highest post-cost capital
   blocker.
2. `quant_ingestion_stale`: repair upstream ingestion lag while preserving current compute/materialization.
3. `forecast_empty`: seed forecast registry or mark deterministic fallback as explicitly non-authoritative.
4. `promotion_empty`: convert truthful empirical jobs into at least one promotion-eligible shadow candidate.
5. `jangar_custody_gap`: consume Jangar rollout availability escrow and watch reliability receipts before paper.

### Capital Semantics

- `zero_notional` is mandatory while TCA is stale, forecast is empty, promotion eligibility is zero, or Jangar custody
  is missing.
- `repair_only` allows observe, replay, and bounded repair jobs with `max_notional=0`.
- `shadow` requires current Jangar custody and current proof-floor receipt, but may still lack paper settlement.
- `paper_ready` requires current TCA, current quant ingestion, non-empty forecast or explicit non-authoritative
  fallback, at least one promotion-eligible candidate, and current Jangar custody.
- `live_micro_ready` requires paper settlement plus `paper_ready`.

## Measurable Trading Hypotheses

1. **TCA-first reentry hypothesis:** refreshing execution TCA for the current active symbol set will reduce false
   positives from empirical jobs and identify strategies that survive slippage. Target: TCA computed within one
   trading session and average absolute slippage inside guardrail before paper.
2. **Ingestion-gap repair hypothesis:** current quant compute with stale ingestion means the bottleneck is upstream
   material arrival, not metric calculation. Target: ingestion stage lag below the configured quant window and no
   missing update alarm for one full open-market interval.
3. **Forecast-custody hypothesis:** a forecast registry with at least one eligible model family or an explicitly
   non-authoritative fallback improves promotion precision without bypassing empirical proof. Target: forecast
   custody state moves from `registry_empty` to `current` or `fallback_non_authoritative` with calibration status
   recorded.
4. **Empirical-to-promotion hypothesis:** the fresh `chip-paper-microbar-composite@execution-proof` evidence can
   produce at least one promotion-eligible shadow candidate only after TCA and ingestion receipts are current. Target:
   promotion-eligible total increases from `0` to `>=1` with no rollback-required candidate.
5. **Jangar-custody hypothesis:** paper trials launched only under current rollout/watch custody have fewer false
   aborts and clearer rollback evidence than trials launched under generic Healthy/Synced status. Target: every paper
   trial has a Jangar custody receipt id and no zero-endpoint availability gap.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a `capital_reentry_auction` reducer beside proof-floor/submission-council logic.
- Feed the reducer from existing proof floor, live submission gate, empirical jobs, quant evidence, forecast service,
  TCA status, hypothesis summary, and Jangar custody receipt.
- Expose the receipt on `/trading/status`, `/trading/health`, and metrics without changing live submission behavior
  in the first release.
- Add tests for:
  - fresh empirical jobs plus stale TCA stays `zero_notional`;
  - quant latest metrics with stale ingestion selects `quant_ingestion_stale` as a repair bid;
  - forecast `registry_empty` blocks paper but allows repair;
  - missing Jangar custody holds paper/live and allows observe;
  - all custody gates current and at least one promotion-eligible candidate yields `paper_ready` with bounded notional
    still controlled by existing live submission toggles.

## Validation Gates

Engineer validation:

- `cd services/torghut && uv run --frozen pytest tests/test_empirical_jobs.py tests/test_trading_api.py tests/test_trading_pipeline.py`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`

Read-only deployer validation:

- `curl -fsS http://torghut.torghut.svc.cluster.local/db-check`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.proof_floor,.live_submission_gate,.capital_reentry_auction'`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.rollout_availability_escrow,.consumer_evidence_custody'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m'`

Acceptance gates:

- Paper and live remain blocked while TCA is stale from `2026-04-02`.
- Paper and live remain blocked while forecast is `registry_empty`.
- Paper and live remain blocked while quant ingestion lag exceeds its configured freshness budget.
- Paper and live remain blocked while Jangar custody is missing, stale, or in `availability_gap`.
- Observe and zero-notional repair remain allowed while schema, runtime, empirical jobs, and Jangar read-only custody
  are current.

## Rollout And Rollback

Rollout is staged:

1. Emit capital reentry auction receipts in shadow mode and compare their capital state against the current proof
   floor and live submission gate.
2. Make `/trading/health` include the auction result as additive diagnostic evidence while keeping existing readiness
   semantics.
3. Gate paper canary eligibility on the auction receipt after one clean shadow cycle through market open and close.
4. Gate live micro only after paper settlement evidence is current and no receipt contradiction remains.

Rollback is simple:

- If the reducer over-holds repair work, disable enforcement and keep receipt emission in shadow mode.
- If a data source is noisy, mark that bid `diagnostic_only` and keep paper/live held by existing proof-floor gates.
- If Jangar custody is unavailable, Torghut falls back to `observe_only` and `max_notional=0`.
- If paper/live is ever authorized with stale TCA, stale quant ingestion, or missing Jangar custody, immediately return
  to `zero_notional` and publish the contradiction refs.

## Risks And Tradeoffs

- The auction score can become performative if expected unblock values are not calibrated from outcomes. Engineer must
  log selected and rejected bids so later stages can compare score to actual unblock.
- TCA repair may expose that the current empirical candidate is not profitable after costs. That is a useful result,
  but it will delay paper.
- Jangar custody creates a cross-service dependency for capital. The design intentionally allows observe and repair to
  continue so Jangar churn does not freeze the whole trading system.
- The first implementation should avoid unbounded SQL counts and should reuse existing status builders wherever
  possible.

## Handoff

Engineer owns the reducer, route payload, tests, and metrics. The first slice should be additive and shadow-only; it
must not enable live submission.

Deployer owns the acceptance gates. Do not widen Torghut beyond shadow while `/readyz` or `/trading/health` return
`503`, while TCA is stale, while quant ingestion is degraded, while forecast is `registry_empty`, or while Jangar
custody is missing or in availability gap.

The next capital action is not paper. The next capital action is zero-notional repair: refresh TCA, repair quant
ingestion, establish forecast custody, convert fresh empirical proof into a promotion-eligible shadow candidate, then
ask Jangar for current custody before paper.
