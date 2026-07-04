# 92. Torghut Proof-Cost Market and Options Catalog Firebreak (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: options data/control lane exists; options trading authority remains separate and gated.
- Matched implementation area: Options lane.
- Current source evidence:
  - `services/torghut/app/options_lane/settings.py`
  - `services/torghut/app/options_lane/catalog_service.py`
  - `services/torghut/app/options_lane/enricher_service.py`
  - `argocd/applications/torghut-options/ws/deployment.yaml`
  - `argocd/applications/torghut-options/ta/flinkdeployment.yaml`
- Design drift note: March/options text must be checked against current `options_lane` source and `torghut-options` GitOps before use.


## Decision

Torghut should add a **ProofCostMarket** and an **OptionsCatalogFirebreak**. Profitability work should compete for
bounded proof capacity by expected information value, not by whichever route or background cycle can run the largest
query first.

The live trading service is safe at the broker boundary today: live submission is blocked, capital is in `shadow`, no
hypothesis is promotion eligible, and all three current hypotheses require rollback. That is good safety. It is not
enough profitability.

The current bottleneck is proof cost and proof freshness. Jangar quant-health routes timed out. Empirical jobs are
stale. The options catalog readiness route failed because a single SQL query tried to resolve a very large option
symbol set and was canceled. Those failures should not be treated as route trivia. They should price proof producers,
hold expensive low-value scans, and fund the next causal replay or catalog repair that has the best chance to unlock
profitable capital safely.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Route Evidence

- Torghut live revision `torghut-00222` was Running and returned HTTP 200 for `/healthz`.
- Live `/readyz` returned HTTP 503 in 3.143s. Dependencies for Postgres, ClickHouse, Alpaca, schema, universe, and
  readiness cache were OK, but live submission was blocked by `simple_submit_disabled` and active capital stage
  `shadow`.
- Live `/trading/status` returned HTTP 200 in 3.535s. It reported build `v0.568.5-16-g59511b6b6`, commit
  `59511b6b6af8b160aaf00b9fb5f44b7a62c61c5c`, active revision `torghut-00222`, and `last_decision_at` on
  2026-05-04.
- The live status payload reported three hypotheses: `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`. All had capital
  multiplier `0`; none were promotion eligible; all required rollback.
- Dependency quorum was blocked with reasons including Jangar/database and empirical job degradation.
- Torghut `/db-check` returned HTTP 200 in 0.091s with current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, no duplicate revisions, and known
  parent-fork lineage warnings.
- Sim `/trading/health` returned HTTP 200, but quant evidence was `unknown` because the Jangar quant-health request
  timed out.
- Direct CNPG SQL was blocked by `pods/exec` RBAC for this service account.

### Options and Data Quality Evidence

- `GET http://torghut-options-catalog.torghut.svc.cluster.local/readyz` returned HTTP 503.
- The catalog readiness payload showed `last_success_ts=null`, `last_error_code=catalog_cycle_failed`, and a canceled
  SQL query over `torghut_options_contract_catalog` using `contract_symbol = ANY(%(symbols)s)`.
- The error payload showed the symbol parameter was truncated at 224,790 characters. The exact row count is not exposed
  by the route, but the query shape is enough to classify the cycle as oversized and high cost.
- Recent Torghut warning events included options-catalog startup probe failures, options-enricher readiness failures,
  Flink recovery suppression, ClickHouse multiple-PDB ambiguity, and readiness probe churn across live and sim
  revisions.
- Jangar quant-health routes for both live and sim accounts timed out after 20 seconds with HTTP 000, so Torghut cannot
  use request-time Jangar quant proof as a capital authority input under current pressure.

### Source Evidence

- `services/torghut/app/trading/submission_council.py::build_live_submission_gate_payload` already composes dependency
  quorum, empirical jobs, DSPy live readiness, quant evidence, promotion certificates, capital stage, reason codes,
  segment summaries, lineage references, and evaluated tuples.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` still has a simple pipeline branch that returns a
  local gate for live mode and bypasses the proof-aware submission council.
- `services/torghut/app/trading/empirical_jobs.py::build_empirical_jobs_status` already has the vocabulary for stale
  empirical jobs, dataset snapshots, authority, truthfulness, and promotion eligibility.
- Torghut discovery code already builds dataset snapshot receipts and tests stale/missing-day behavior. The missing
  layer is proof-cost admission across producers and the options catalog.

## Problem

Torghut is not short on candidate strategy ideas. It is short on current, affordable, causal proof that can safely
unlock paper and live capital.

Four failures need one architecture:

1. empirical jobs can be structurally present but stale;
2. Jangar quant-health proof can time out under platform pressure;
3. options catalog proof can issue an oversized query and cancel before producing readiness;
4. simple live mode can still evaluate a local gate path separately from the proof-aware council.

If each proof producer keeps retrying independently, the system spends scarce database and route budget on proof debt
instead of buying the next highest-value unit of evidence. That delays profitable reentry and increases platform
pressure at the same time.

## Alternatives Considered

### Option A: Keep Capital Frozen Until Every Proof Producer Is Green

Do not allow zero-notional replay, paper, or live until empirical jobs, options catalog, quant health, market context,
and Jangar status are all green.

Pros:

- Conservative.
- Prevents accidental broker exposure.
- Easy to explain during incidents.

Cons:

- Starves the proof producers that would repair freshness.
- Treats zero-notional replay like live capital.
- Does not rank proof work by expected value.
- Lets low-value catalog scans block high-value strategy replay.

Decision: keep as emergency posture only.

### Option B: Increase Query Timeouts and Chunk the Options Query Locally

Raise database timeouts and split the options catalog query into smaller batches.

Pros:

- Directly addresses the observed catalog failure.
- Low conceptual overhead.
- Easy to verify with readiness.

Cons:

- Does not govern other proof producers.
- Can still spend proof budget on low-value symbols.
- Does not connect proof cost to capital admission or hypothesis priority.
- Does not consume Jangar brownout authority.

Decision: use as a tactical repair under the selected architecture, not as the architecture.

### Option C: ProofCostMarket and OptionsCatalogFirebreak

Declare a cost receipt for every proof producer, rank work by expected information value and capital unlock potential,
and make the options catalog enforce page, parameter, row, and timeout budgets before readiness can clear.

Pros:

- Converts proof freshness into an allocatable resource.
- Keeps high-value zero-notional replay moving while holding expensive or stale proof loops.
- Gives options work a measurable path from broken catalog readiness to profitable options experiments.
- Lets Jangar brownout posture hold paper/live capital without stopping repair.
- Gives deployers a concrete gate: proof-cost receipts fresh, catalog firebreak clear, capital governor still in
  shadow until evidence is causal and current.

Cons:

- Adds a scheduling/ranking layer.
- Requires careful metrics so proof producers do not game expected information value.
- Requires staged rollout to avoid blocking useful background work too early.

Decision: select Option C.

## Chosen Architecture

### ProofCostReceipt

Every proof producer emits a cost receipt.

```text
proof_cost_receipt
  receipt_id
  producer                 # empirical_jobs, quant_health, options_catalog, replay, market_context, tca
  hypothesis_id
  account_scope
  dataset_scope
  requested_symbols
  rows_read
  rows_written
  parameter_bytes
  database_duration_ms
  route_duration_ms
  timeout_budget_ms
  cost_status              # within_budget, over_budget, timed_out, canceled, blocked_by_jangar
  expected_information_value
  capital_unlock_class     # none, replay, paper_probe, live_probe, live_scaled
  observed_at
  fresh_until
  reason_codes
```

Cost receipts are not just telemetry. They decide which proof producer receives the next repair slot.

### ProofCostMarket

The market ranks proof work by net value:

```text
proof_priority_score =
  expected_information_value
  + capital_unlock_value
  + falsification_value
  - database_cost
  - route_cost
  - stale_retry_penalty
  - jangar_brownout_penalty
```

Rules:

- Zero-notional replay can continue under Jangar `repair_only` when it does not require expensive Jangar route proof.
- Paper/live proof is held when Jangar brownout posture holds `paper_submit` or `live_submit`.
- Stale empirical jobs create proof debt and get priority only when their expected information value beats cheaper
  replay or catalog repair.
- A producer with repeated canceled or timed-out receipts loses priority until its query shape is repaired.

### OptionsCatalogFirebreak

The options catalog must clear a firebreak before readiness can become capital-relevant.

```text
options_catalog_firebreak
  firebreak_id
  symbol_page_size
  max_parameter_bytes
  max_rows_per_cycle
  max_cycle_duration_ms
  max_open_interest_age_seconds
  underlying_universe_ref
  liquidity_filter_ref
  last_success_ts
  last_cost_receipt_id
  decision                 # ready, observe, repair_only, hold
  reason_codes
```

Rules:

- The catalog may not run one unbounded `ANY(symbols)` query for the full option universe.
- Queries must page by underlying, expiry, option type, and liquidity filter.
- Readiness should distinguish `serve_catalog_cache` from `capital_relevant_catalog_current`.
- A canceled catalog cycle is negative evidence for options promotion, not for all Torghut replay.
- The firebreak should emit a repair hint: lower page size, narrow expiries, rebuild liquidity filter, or defer options
  experiments.

### Capital Integration

Torghut's `CapitalReentryGovernor` should consume:

- Jangar `BrownoutGovernor` posture;
- proof-cost receipts for empirical jobs, quant health, replay, market context, TCA, and options catalog;
- options catalog firebreak decision;
- promotion certificate and hypothesis window evidence;
- existing kill switch and broker safety toggles.

The simple pipeline live gate must route through the proof-aware submission council before any paper/live reentry is
allowed. Local toggles may still hold capital. They should not allow capital without the council.

## Engineer Scope

1. Add a pure proof-cost scoring module with tests for expected information value, stale retry penalty, Jangar brownout
   penalty, and capital unlock value.
2. Add cost receipt fields to empirical jobs, quant health, replay, market-context, TCA, and options catalog producers.
3. Refactor the options catalog cycle to page by underlying, expiry, option type, and liquidity filters with hard
   parameter-byte and row budgets.
4. Persist the latest options catalog firebreak decision and expose it through `/readyz` without running a deep proof
   scan on the request path.
5. Route simple live mode through `submission_council.build_live_submission_gate_payload` before it can allow capital.
6. Add Jangar brownout posture as an input to the submission council.
7. Keep order submission disabled until proof-cost receipts and the firebreak have run in shadow for two market
   sessions.

## Validation Gates

- Unit test: a canceled options catalog query with oversized parameter bytes emits `cost_status=canceled` and
  `decision=repair_only`.
- Unit test: options catalog readiness can serve cached catalog data while holding
  `capital_relevant_catalog_current`.
- Unit test: Jangar `capital_hold` posture blocks paper and live while allowing zero-notional replay.
- Unit test: simple pipeline live mode cannot bypass the proof-aware submission council.
- Unit test: stale empirical jobs produce proof debt and do not clear capital.
- Integration test: proof-cost market prioritizes a low-cost replay repair over a high-cost repeated catalog scan when
  both are stale.
- Integration test: `/readyz` does not execute the full catalog proof query.
- Backtest/proof validation: every promoted hypothesis includes gross PnL, net PnL, turnover, slippage, drawdown,
  counterfactual lift, and proof-cost receipt IDs.

## Rollout Plan

1. Ship proof-cost scoring, receipt projection, and catalog firebreak in observe mode.
2. Run one full market session with no enforcement and record producer cost receipts.
3. Enforce options catalog query budgets and keep catalog readiness `repair_only` until a successful bounded cycle.
4. Route simple live mode through the proof-aware council while still holding capital in shadow.
5. Enable paper-probe shadow only after proof-cost receipts are fresh and Jangar brownout posture is not holding
   capital.
6. Enforce paper-probe before live; live remains disabled until two market sessions show zero false paper allows and
   post-cost proof is positive.

## Rollback Plan

- Disable proof-cost enforcement and leave receipt projection enabled.
- Revert options catalog to cache-only readiness if the firebreak blocks API serving.
- If receipt writes pressure the database, switch cost receipts to in-memory latest state and sample to durable storage.
- If simple live council routing regresses, keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and hold capital in shadow while
  the council path is fixed.
- If Jangar brownout posture is unavailable, fail closed for paper/live and keep zero-notional replay bounded by local
  cost budgets.

## Handoff Contract

Engineer acceptance:

- The options catalog must not issue unbounded full-universe `ANY(symbols)` queries.
- Proof-cost receipts must be generated in pure unit tests before wiring producer persistence.
- Simple live mode must not be able to allow capital without the proof-aware submission council.

Deployer acceptance:

- Before paper or live reentry, verify Jangar brownout posture is not holding capital, options firebreak is not
  `repair_only`, empirical jobs are fresh, and proof-cost receipts are within budget.
- A green `/db-check` is necessary but not sufficient for capital. Fresh proof-cost receipts and capital governor output
  are required.
- Roll back by disabling proof-cost enforcement first; only revert code if route serving or scheduler liveness
  regresses.

Open risks:

- Expected information value can be gamed if producers self-report too much value. Initial scoring should use static
  policy weights and audited receipts.
- Options query budgets may slow catalog coverage. That is acceptable until the catalog can prove profitable, bounded
  options experiments.
- Direct SQL evidence is currently blocked by RBAC, so deployer validation depends on exported route and event
  evidence.
