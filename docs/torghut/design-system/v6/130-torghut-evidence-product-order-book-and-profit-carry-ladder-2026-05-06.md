# 130. Torghut Evidence Product Order Book And Profit Carry Ladder (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

I am selecting an **evidence product order book with a profit carry ladder** for Torghut capital reentry.

The current state is materially better than yesterday's stale proof baseline, but it is not capital-ready. At
`2026-05-06T17:25Z`, Torghut live `/readyz` returned HTTP `503` only because `simple_submit_disabled` keeps live
submission in `shadow`. Scheduler, Postgres, ClickHouse, Alpaca, database schema, and Jangar universe were OK. The
empirical jobs endpoint was healthy and authoritative for `chip-paper-microbar-composite@execution-proof`, with fresh
benchmark parity, foundation router parity, Janus event CAR, and Janus HGRM reward artifacts.

The capital blockers are narrower and should be priced, not handled as a blanket freeze. Jangar global quant latest was
fresh with `3780` metrics. Scoped `paper/1d` quant latest was empty. Sim `TORGHUT_SIM/15m` quant latest was empty.
Market context was degraded across technicals, fundamentals, news, and regime. Jangar quant alerts returned `213`
open alerts, including critical `metrics_pipeline_lag_seconds` windows. LLM guardrails were reachable and compliant,
but LLM reviews were disabled, effective shadow mode was active, and governance evidence was incomplete.

The selected design makes each Jangar material evidence product a line item in a Torghut order book. The order book
prices the expected profit carry unlocked by repairing that product, then moves hypotheses through a ladder:
`shadow_observe`, `repair_trade`, `paper_canary`, `live_micro_canary`, and `live_scale`.

The tradeoff is that Torghut will not reopen paper or live simply because core routes and empirical jobs are healthy. I
accept that. A fresh empirical proof with empty scoped quant and stale market context is valuable, but it is not enough
to spend capital.

## Runtime Objective And Success Metrics

This contract increases profitability by ranking evidence repair by expected capital value, not by the order in which
status checks happen to fail.

Success means:

- Torghut consumes Jangar `material_evidence_product` records rather than scraping unrelated status fragments.
- Every capital decision cites the product ids for scoped quant, market context, empirical jobs, ClickHouse guardrails,
  LLM governance, TCA, execution settlement, and Jangar action clocks.
- Fresh empirical jobs create positive carry, but cannot override empty scoped quant or stale market context.
- Empty scoped quant creates a high-priority repair order for the exact account/window.
- Open critical quant alerts reduce carry for affected strategy/window pairs until repaired or explicitly waived.
- Market-context repair is ranked by trading-session relevance: technicals and regime first, then news, then
  fundamentals.
- LLM governance evidence must be complete before live micro-canary, even if deterministic policy is compliant.
- The first profitable reentry path is measurable and rollback-safe: zero-notional observe, then paper canary, then
  live micro-canary.

## Evidence Snapshot

All evidence was collected read-only. No Kubernetes resources, database rows, GitOps manifests, broker state, trading
flags, or runtime objects were changed.

### Cluster And Runtime Evidence

- Torghut live `torghut-00241-deployment-d899967d5-hhh6x` was `2/2 Running`.
- Torghut sim `torghut-sim-00337-deployment-75974749bf-h2zh2` was `2/2 Running`.
- Torghut Postgres `torghut-db-1`, ClickHouse replicas, Keeper, TA, sim TA, options TA, options catalog/enricher,
  websockets, guardrail exporters, Symphony, and Alloy were running.
- Recent events showed transient startup/readiness probe failures during live and sim revision warm-up, then Knative
  marked both latest revisions ready.
- ClickHouse guardrail metrics reported both replicas up, disk free ratios near `0.96`, no read-only replica, fresh TA
  timestamps, and last scrape success.
- LLM guardrail metrics reported scrape success, compliant policy resolution, no active policy violation, but
  `torghut_llm_governance_evidence_complete=0`, `torghut_llm_enabled=0`, and effective shadow mode active.

### Database And Data Evidence

- Direct pod exec into Torghut Postgres and ClickHouse was forbidden to the agents service account.
- Repo-declared Torghut Postgres is a single CNPG instance with `50Gi`, `dataChecksums=true`, Barman S3 backups, and
  `14d` retention.
- Torghut live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage was ready. Known parent-fork warnings remained for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut live `/readyz` returned HTTP `503` because the live submission gate was blocked by
  `simple_submit_disabled`; Postgres, ClickHouse, Alpaca live account, database schema, and universe were OK.
- Torghut sim `/readyz` returned HTTP `200`, but its quant evidence was degraded because the scoped latest store was
  empty.
- Torghut empirical jobs were fresh and authoritative with candidate
  `chip-paper-microbar-composite@execution-proof` and dataset snapshot `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Jangar global quant health was fresh with `latestMetricsCount=3780` and second-level lag.
- Jangar scoped quant health for `paper/1d` had `latestMetricsCount=0`, `latestMetricsUpdatedAt=null`, and
  `emptyLatestStoreAlarm=true`.
- Jangar market-context health was degraded with stale technicals, fundamentals, news, and regime.
- Jangar quant alerts returned `213` open alerts. Critical examples included `metrics_pipeline_lag_seconds` for
  `1m`, `5m`, `15m`, `1h`, `1d`, `5d`, and `20d` windows.

### Source Evidence

- `services/torghut/app/main.py` assembles `/readyz`, `/trading/health`, empirical jobs, quant evidence, market
  context, hypothesis readiness, and live submission gate payloads.
- `services/torghut/app/trading/submission_council.py` already consumes Jangar quant health and combines dependency
  quorum, empirical jobs, market context, TCA, promotion decisions, and active capital stage.
- `services/torghut/app/trading/empirical_jobs.py` already verifies artifact authority, truthfulness, lineage,
  freshness, and promotion eligibility for the four empirical job types.
- `services/torghut/app/trading/market_context.py` already grades stale, low-quality, disabled, error, and degraded
  last-good market context.
- The missing reducer is not proof generation. It is a price-and-rank layer that turns Jangar evidence products into
  capital and repair sequencing.

## Problem

Torghut now has some high-quality proof and some hard gaps at the same time.

The empirical proof surface is fresh enough to matter. The core runtime is healthy enough to observe. The data surfaces
required for capital are not fresh enough to spend notional. Without an order book, Torghut has two bad choices:

1. stay shadow-only until every product is green, which wastes fresh empirical proof and delays repair; or
2. reopen paper based on core dependency health, which ignores empty scoped quant, stale context, and critical alerts.

Both are weak. Torghut needs to price evidence products by expected profit carry and repair cost.

## Alternatives Considered

### Option A: Reopen Paper As Soon As Empirical Jobs And Core Dependencies Are Green

Pros:

- Fastest route back to paper activity.
- Uses the newly fresh empirical artifacts.
- Keeps implementation local to submission council thresholds.

Cons:

- Ignores empty scoped `paper/1d` quant evidence.
- Ignores stale market context.
- Ignores open critical quant alerts.
- Repeats the failure mode of equating route readiness with capital readiness.

Decision: reject.

### Option B: Keep Shadow-Only Until Every Evidence Domain Is Green

Pros:

- Strong capital safety.
- Simple operating rule.
- Avoids accidental live exposure.

Cons:

- Does not prioritize repair.
- Treats fresh empirical jobs and stale context as equally unusable.
- Gives no measurable path to reentry.
- Blocks zero-notional hypothesis learning that could improve profitability.

Decision: reject.

### Option C: Evidence Product Order Book With Profit Carry Ladder

Torghut consumes Jangar evidence products, ranks each repair by expected profit carry unlocked, and moves hypotheses
through explicit capital stages.

Pros:

- Turns partial proof into useful ranked work.
- Keeps notional blocked until scoped data is current.
- Gives Jangar and deployer lanes product ids for audit.
- Allows zero-notional learning while repair is underway.
- Makes profitability hypotheses measurable before paper or live reentry.

Cons:

- Adds a reducer and scoring model.
- Requires careful calibration to avoid overfitting one session.
- Requires product schema compatibility with Jangar.

Decision: select Option C.

## Architecture

### EvidenceProductOrder

Torghut creates one order per missing, stale, degraded, or repairable product.

```text
evidence_product_order
  order_id
  generated_at
  evidence_product_id
  product_class
  account_label
  strategy_id
  hypothesis_id
  window
  current_decision             # allow, observe_only, repair_only, hold, block, unavailable
  current_state                # fresh, stale, empty, missing, degraded, shadow
  stale_age_seconds
  max_freshness_seconds
  open_alert_refs
  expected_capital_stage_unlocked
  expected_profit_carry_bps
  confidence
  repair_cost_score
  priority_score
  repair_lane
  settlement_receipt_ref
  rollback_target
```

Priority scoring starts conservative:

```text
priority_score =
  expected_profit_carry_bps
  + capital_stage_unlock_weight
  + freshness_debt_weight
  + proof_truthfulness_weight
  - repair_cost_score
  - open_critical_alert_penalty
  - observation_right_penalty
```

Initial repair lane ordering from current evidence:

1. `scoped_quant_rehydrate` for `paper/1d` and `TORGHUT_SIM/15m`.
2. `quant_alert_settlement` for critical `metrics_pipeline_lag_seconds` windows.
3. `market_context_refresh` for technicals and regime, then news, then fundamentals.
4. `llm_governance_closeout` for governance evidence completeness before live micro-canary.
5. `tca_execution_settlement` for live micro-canary and live scale.

### ProfitCarryLadder

Each hypothesis moves through a ladder only when required product sets are fresh.

```text
profit_carry_ladder_decision
  decision_id
  generated_at
  hypothesis_id
  strategy_id
  account_label
  current_stage
  next_stage
  max_notional
  consumed_product_ids
  blocking_product_ids
  expected_profit_carry_bps
  max_drawdown_budget_bps
  stop_loss_conditions
  rollback_target
```

Stage rules:

- `shadow_observe`: allowed when core routes and empirical jobs are healthy, notional is `0`, and no product requires
  destructive repair.
- `repair_trade`: allowed for zero-notional or simulated repair evidence only.
- `paper_canary`: requires fresh scoped quant, fresh empirical proof, settled critical quant alerts for the account and
  windows used, and market context not stale for session-critical domains.
- `live_micro_canary`: requires paper settlement plus TCA, expected shortfall, live-submission policy, LLM governance,
  and no open rollback debt.
- `live_scale`: requires live micro-canary post-cost profit, fillability evidence, no unresolved execution settlement
  debt, and deployer-approved capital receipt.

## Measurable Trading Hypotheses

H-EP-01, scoped quant rehydration unlocks paper:

- Hypothesis: repairing `paper/1d` and `TORGHUT_SIM/15m` latest stores reduces time-to-paper-canary by at least
  `70%` compared with waiting for all domains to self-heal.
- Measurement: time from order creation to fresh scoped product, latest metrics count, alert resolution count, and
  first paper-canary eligibility timestamp.
- Guardrail: no paper notional while scoped latest count is `0` or critical pipeline-lag alerts are open for the
  requested strategy/window.

H-EP-02, empirical-fresh plus scoped-quant-fresh beats empirical-only:

- Hypothesis: `chip-paper-microbar-composite@execution-proof` only has positive expected carry after scoped quant is
  fresh; empirical proof alone overstates readiness.
- Measurement: paper replay or paper canary post-cost return, slippage, fill ratio, and drawdown against the same
  candidate with empirical-only gating.
- Guardrail: paper max notional remains `0` until scoped quant and market context products are fresh.

H-EP-03, context freshness is worth more intraday than stale fundamentals:

- Hypothesis: refreshing technicals and regime first improves intraday decision quality more than refreshing
  fundamentals first during the same session.
- Measurement: route from context product repair to signal quality, market-context risk flags, and paper decision
  rejection rate.
- Guardrail: stale news or fundamentals may permit zero-notional observe, but stale technicals or regime block
  paper-canary for intraday strategies.

H-EP-04, LLM governance should be a live-only gate:

- Hypothesis: LLM governance incompleteness should not block shadow observe or deterministic paper repair, but it must
  block live micro-canary.
- Measurement: shadow and paper deterministic decisions continue while live actions hold; no live action occurs with
  `torghut_llm_governance_evidence_complete=0`.
- Guardrail: live max notional stays `0` until governance evidence is complete and policy resolution remains
  compliant.

## Implementation Scope

Engineer stage:

- Add Torghut order-book models and pure reducers that consume Jangar evidence product payloads.
- Extend submission council status with `evidence_product_orders` and `profit_carry_ladder`.
- Add fixtures for the current state: empirical fresh, scoped quant empty, critical quant alerts open, market context
  stale, LLM governance incomplete, live submission shadow.
- Keep broker, database, and Kubernetes access read-only for validation.

Jangar dependency:

- Jangar must publish evidence products for scoped quant, market context, empirical jobs, ClickHouse guardrails, LLM
  guardrails, action clocks, and controller/database status.
- Until Jangar products exist, Torghut can build shadow products from current route payloads and label them
  `producer=torghut.shadow_adapter`.

## Validation Gates

Local gates:

- `uv run --frozen pytest tests/test_submission_council.py tests/test_empirical_jobs.py tests/test_market_context.py`
- `uv run --frozen pytest tests/test_trading_api.py tests/test_torghut_quant_readiness.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Behavior gates:

- Empty scoped quant creates a `scoped_quant_rehydrate` order and blocks `paper_canary`.
- Fresh empirical jobs create positive carry but do not override scoped quant or market-context blockers.
- Critical quant alerts reduce priority confidence and block paper for matching windows.
- LLM governance incomplete blocks `live_micro_canary` but not `shadow_observe` or zero-notional repair.
- `simple_submit_disabled` keeps live notional at `0` even when other products are fresh.

Read-only cluster gates:

- Torghut live `/readyz` and `/trading/health` explain capital state without database exec.
- Jangar quant health and alerts routes provide scoped products for account/window decisions.
- Guardrail metrics for ClickHouse and LLM are consumed as products, not manual operator notes.

## Rollout Plan

Phase 0, shadow order book:

- Add the reducers and route payload fields behind a feature flag.
- Build products from existing routes with `shadow_adapter` producer ids.
- Keep live and paper capital decisions unchanged.

Phase 1, Jangar product consumption:

- Replace shadow-adapter products with Jangar product ids when available.
- Show order priority, expected carry, and blocked products in `/trading/health`.
- Keep paper/live enforcement unchanged.

Phase 2, paper enforcement:

- Enforce product-order gates for `paper_canary`.
- Allow zero-notional observe and repair when paper is blocked.
- Require deployer signoff for the first paper-canary window.

Phase 3, live micro-canary:

- Enforce LLM governance, TCA, execution settlement, and live-submission products.
- Start with max notional `0` until paper settlement proves post-cost edge.
- Widen only through Jangar material action receipts.

## Rollback

- Disable order-book enforcement and keep the order book visible in shadow.
- Keep `simple_submit_disabled` as the live-submission brake.
- Revert paper-canary to zero notional if scoped quant, market context, or alert settlement products regress.
- Do not replace product gaps with direct database or broker inspection.
- Preserve all emitted order ids and ladder decisions for audit.

## Risks

- Expected carry scoring can overfit if calibrated only on the current `chip-paper` candidate.
- A product schema mismatch between Jangar and Torghut can create false holds.
- Stale but truthful empirical proof can look too attractive if scoped quant remains empty.
- Market-context repairs can consume budget without improving intraday fillability if context domains are ranked
  poorly.
- LLM governance can become a permanent live blocker unless the closeout work is given a bounded owner and date.

## Handoff To Engineer

Implement the order book as pure reducers first. Do not change broker submission behavior in the first implementation
PR. Use the current evidence as fixtures and make the reducer prove that empirical freshness raises carry while empty
scoped quant and critical alerts keep paper blocked.

Acceptance gates:

- Evidence-product fixtures cover current live, sim, and paper-scoped gaps.
- The first reducer PR changes no live-submission flag and no broker adapter code.
- Tests prove `paper_canary` stays blocked until scoped quant is non-empty and critical matching alerts are settled.
- Tests prove LLM governance incomplete blocks only live stages.

## Handoff To Deployer

Deploy shadow mode first and verify `/trading/health` exposes the order book without changing capital decisions. Do not
enable paper enforcement until Jangar product ids are present and the order book names the exact products blocking or
allowing the candidate.

Rollback gate:

- If paper or live actions move without consumed product ids, disable enforcement immediately and return to shadow.
- If scoped quant becomes empty again after paper starts, force `paper_canary` max notional to `0` and create a fresh
  rehydrate order before continuing.
