# 158. Torghut Route Reacquisition And Market Context Repair Cells (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

I am selecting route reacquisition and market-context repair cells as the next Torghut architecture direction.

The current system is safe but not profitable. Live Torghut is up, the scheduler is running, Postgres and ClickHouse
are healthy, Alpaca reports the live account active, the Jangar universe is fresh, empirical jobs are fresh, and the
database schema is current. Yet `/trading/health` is degraded and the proof floor is `repair_only` with
`capital_state=zero_notional`.

The blockers are concrete:

- live submission is disabled;
- all three hypotheses are shadow with zero promotion eligibility and three rollback-required states;
- market context is stale because fundamentals and news are stale by weeks;
- live TCA has zero routeable symbols across the eight-symbol universe;
- scoped quant health can be fresh at `15m`, but `1d` account-scoped health showed `missingUpdateAlarm=true`.

This is not a reason to loosen capital. It is a reason to make repair measurable. Torghut should not jump from
zero-notional to paper capital because a generic job completed. It should reacquire routes and market context one
receipt at a time, then promote only the symbols and hypotheses that pass post-cost evidence.

The selected design creates Torghut-side repair cells that consume Jangar-admitted repair receipts. The first paper
candidate is not a new alpha model. It is a route reacquisition program: regain routeable status for the current
semiconductor universe, refresh fundamentals/news context, prove scoped quant pipeline stages, and then let one
hypothesis earn a paper-only warrant under small notional and strict rollback.

The tradeoff is slower visible capital deployment. I accept that. The faster route to durable PnL is to make the repair
loop measurable and symbol-scoped, not to override a proof floor that is correctly saying zero notional.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `route_reacquisition_book` from `/trading/status` and proof-floor source refs.
- Each universe symbol is classified as `routeable`, `blocked`, `missing`, `probing`, or `retired`.
- Market-context repair receipts are visible to proof floor and hypothesis readiness.
- A hypothesis cannot become paper eligible unless market context is fresh, route TCA is routeable for at least one
  scoped symbol, and scoped quant health has current stages.
- Live submit remains disabled until a later live-specific proof floor passes.
- Paper repair notional starts at zero and can rise only to a small bounded probe after the receipts pass.
- The repair loop records what changed, what remained blocked, and which next repair has the highest expected unblock
  value.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records, broker
state, GitOps resources, AgentRun objects, or trading flags.

### Cluster Evidence

- `torghut-00271-deployment` and `torghut-sim-00371-deployment` were both `1/1` available.
- Torghut Postgres, ClickHouse, Keeper, TA, TA simulation, options TA, websocket, options catalog, options enricher,
  guardrail exporters, Symphony, and Alloy pods were running.
- Argo reported `torghut` and `torghut-options` as `Synced` and `Healthy`.
- Recent Torghut events showed rollout churn, DB migration/bootstrap jobs, duplicate ClickHouse PDB warnings, and a
  retained `torghut-whitepaper-autoresearch-profit-target` error pod.
- The active market-context news batch in `agents` failed with a Codex timeout and a runner bytes/string error, which
  explains why stale news remains a live trade blocker.

### Database And Data Evidence

- Live `/db-check` returned `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, lineage ready, and account scope ready.
- Direct DB exec was RBAC-blocked, so Torghut's typed DB check and status endpoints are the available database witness.
- Live `/trading/status` reported build `v0.568.5-390-g959051e8d`, active revision `torghut-00271`,
  `last_run_at=2026-05-07T16:11:15.796174Z`, and no last error.
- Last decision truth was stale relative to the current session: `last_decision_at=2026-05-06T17:44:19.618796Z`.
- Empirical jobs were fresh with eligible jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.
- Live market-context health for `AAPL` was degraded: technicals freshness was about 9 seconds, regime freshness was
  about 9 seconds, but fundamentals and news were stale by multiple weeks.
- Live TCA had 7334 orders, 7245 filled executions, average absolute slippage `13.8203637593029676` bps against an
  `8` bps guardrail, zero routeable symbols, five blocked symbols, and three missing symbols.
- Simulation TCA was less broken but still incomplete: one routeable symbol (`NVDA`) and seven missing symbols.

### Source Evidence

- `services/torghut/app/main.py` is 4186 lines and should not absorb more repair-state logic.
- `services/torghut/app/trading/proof_floor.py` is 680 lines and already owns proof dimensions, blockers, repair
  ladder, route state, and capital state.
- `services/torghut/app/trading/tca.py` is 969 lines and owns execution TCA metric materialization.
- `services/torghut/app/trading/market_context.py` is 290 lines and already maps stale context into blocking flags.
- `services/torghut/app/trading/submission_council.py` is 1199 lines and remains the deterministic final order gate.
- Tests already cover proof-floor market-context stale behavior, zero routeable TCA blockers, TCA refresh, trading API
  status, and market-context degradation. The missing test surface is the repair-cell transition from blocked evidence
  to paper-only route reacquisition.

## Problem

Torghut has a useful proof floor, but the repair path is still too generic. The current repair ladder knows the major
blockers, but it does not create a symbol-scoped operating book that says which route is being repaired, what receipt
would clear it, and how small a paper probe is allowed after repair.

The current failure modes are:

1. Zero routeable symbols blocks capital, but there is no first-class route reacquisition book.
2. Market context is stale, but proof floor does not yet consume Jangar-admitted market-context repair receipts.
3. Quant pipeline health can look fresh in aggregate while a scoped account/window is degraded.
4. Alpha readiness remains shadow, but the system does not tie each shadow hypothesis to the exact route and context
   repair receipts it needs.
5. Simulation has one routeable symbol, live has none, and there is no explicit parity gate for moving a repaired route
   from simulation evidence to live-account paper evidence.

## Alternatives Considered

### Option A: Keep Capital Closed And Wait For A Broad Alpha Upgrade

Pros:

- Safest capital posture.
- Avoids touching the trading path.
- Lets the research factory continue generating candidates.

Cons:

- Does not retire the live blockers.
- Leaves market context and route TCA stale or incomplete.
- Keeps empirical jobs fresh while the current universe remains unusable for capital.

Decision: reject as insufficient. It is safe, but it does not move profitability.

### Option B: Promote The Existing Empirical Candidate Directly To Paper

Pros:

- Fastest visible paper activity.
- Empirical jobs are fresh and truthful.
- Uses the existing chip composite evidence.

Cons:

- Ignores zero routeable live TCA symbols.
- Ignores stale fundamentals/news.
- Ignores that all hypotheses are shadow and rollback-required.
- Would train the organization to override the proof floor when it is doing its job.

Decision: reject as unsafe.

### Option C: Build Route Reacquisition And Market-Context Repair Cells

Pros:

- Directly targets the current blockers.
- Keeps live capital closed while allowing measured paper repair.
- Turns provider/job failures into typed receipts that Torghut can consume.
- Creates a symbol-by-symbol path from missing or blocked TCA to paper candidate.

Cons:

- Adds a new repair book and receipt consumer.
- Requires Jangar and Torghut to agree on receipt schemas.
- Slower than flipping paper submit on.

Decision: select Option C.

## Architecture

Add a Torghut `route_reacquisition_book` reducer under `services/torghut/app/trading/`. It consumes:

- proof-floor execution TCA source refs;
- Jangar `repair_cell_admission` receipts;
- market-context health receipts;
- scoped quant-health receipts;
- hypothesis readiness summaries;
- simulation/live account labels and symbol universe.

`RouteReacquisitionRecord` fields:

- `symbol`
- `account_label`
- `state`: `routeable`, `blocked`, `missing`, `probing`, or `retired`
- `reason`
- `avg_abs_slippage_bps`
- `max_abs_slippage_bps`
- `filled_execution_count`
- `unsettled_execution_count`
- `last_computed_at`
- `market_context_receipt_id`
- `quant_pipeline_receipt_id`
- `hypothesis_ids`
- `paper_probe_notional_limit`
- `rollback_trigger`
- `next_repair_action`

Capital rules:

- Live capital remains `zero_notional` while `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false` or proof floor is
  `repair_only`.
- Paper repair can move from `zero_notional` to a bounded probe only when a symbol is `probing`, market context is
  fresh, scoped quant health has stages, and the relevant hypothesis is no longer rollback-required.
- A symbol can become `routeable` only after two fresh TCA windows pass average slippage at or below `8` bps and no
  unresolved settlement rows remain.
- Missing symbols must be explicitly probed in simulation before live-account paper probes.
- A market-context receipt older than 300 seconds during regular trading hours forces the symbol back to `blocked`.

## Measurable Trading Hypotheses

### H-ROUTE-REENTRY-01: Symbol Route Reacquisition

Hypothesis: route-level TCA, not broad portfolio evidence, is the right unlock unit for the current semiconductor
universe.

Pass gate:

- at least one symbol moves from `missing` or `blocked` to `probing`;
- two fresh TCA windows show average absolute slippage at or below `8` bps;
- unsettled executions are zero or explicitly under settlement grace;
- paper probe notional stays at or below the configured probe cap.

Rollback:

- any fresh TCA window above `8` bps returns the symbol to `blocked`;
- any max slippage above the hard cap retires the probe for the session.

### H-MCTX-REPAIR-01: Fresh Market Context Raises Promotion Quality

Hypothesis: stale fundamentals/news are suppressing alpha readiness and should be fixed before capital.

Pass gate:

- technicals and regime remain fresh;
- fundamentals and news are fresh inside their configured windows;
- bundle quality is at least `0.70`;
- no domain has a hard error flag.

Rollback:

- stale or error market-context receipt removes paper probe eligibility immediately.

### H-QUANT-STAGE-01: Scoped Quant Health Beats Aggregate Health

Hypothesis: aggregate quant health is not enough for capital; account and window scoped stages are required.

Pass gate:

- `account=PA3SX7FYNUTF` and the active window have non-empty stages;
- latest metrics lag stays under 30 seconds during regular trading hours;
- no missing-update alarm.

Rollback:

- a missing update alarm or empty stage set makes the receipt informational only.

### H-SHADOW-TO-PAPER-01: One Hypothesis Earns A Paper Warrant

Hypothesis: after route, market-context, and quant-stage receipts pass, one shadow hypothesis can earn a paper-only
warrant without live capital.

Pass gate:

- promotion eligible total increases from zero to at least one;
- rollback required total decreases for that hypothesis;
- paper probe stays source-bound to the repaired symbol.

Rollback:

- any dependency receipt stale, any TCA failure, or any hypothesis rollback flag returns the warrant to shadow.

## Implementation Scope

Engineer stage:

- Add `route_reacquisition_book` as a pure reducer outside `app/main.py`.
- Add proof-floor source refs for route-reacquisition state and market-context repair receipts.
- Add tests for live zero routeable symbols, sim one-routeable-symbol evidence, stale market-context receipts, and
  scoped quant-health missing-stage receipts.
- Add one fixture that proves a fresh Jangar market-context repair receipt can move a symbol from `missing` to
  `probing` without enabling live submit.

Deployer stage:

- Roll the status fields in shadow mode first.
- Confirm live capital remains `zero_notional`.
- Confirm paper probe caps are zero until the first valid receipt chain exists.
- Only then allow a tiny paper route-reacquisition probe for the selected symbol.

## Validation Gates

- Unit: proof floor still blocks live when route book has no routeable symbols.
- Unit: market-context stale receipt blocks paper and live.
- Unit: scoped quant health with empty stages is informational and cannot unlock paper.
- Unit: route reacquisition can mark `NVDA` as `probing` in sim while live remains blocked.
- Integration: `/trading/status` includes route book summaries without changing existing fields.
- Regression: `test_profitability_proof_floor.py`, `test_market_context.py`, `test_tca_adaptive_policy.py`, and
  `test_trading_api.py` cover the new reducer behavior.

## Rollout And Rollback

Rollout:

1. Add route book and receipt consumers in shadow.
2. Emit Jangar repair-cell receipt ids into Torghut status, but keep paper caps at zero.
3. Recompute route book for live and sim after each TCA refresh.
4. Enable one paper-only probe for the first symbol with fresh route, context, and quant-stage receipts.
5. Require two trading sessions of clean evidence before any wider paper allocation.

Rollback:

- Set paper probe caps back to zero.
- Ignore repair receipts and rely on existing proof floor.
- Keep route book visible for diagnostics.
- Live submit remains disabled and live capital stays `zero_notional`.

## Risks

- Route reacquisition can overfit to tiny paper probes. Require repeated windows and hard max-slippage caps.
- Fresh market context can be high quality but irrelevant to the strategy. Tie receipts to hypothesis ids, not just
  symbols.
- Scoped quant health may be noisy during market open. Use freshness windows and rollback rather than one tick.
- Paper repair can be mistaken for live readiness. Keep live rules separate and explicit.

## Handoff

Engineer acceptance gates:

- `route_reacquisition_book` exists and is covered by tests.
- Proof floor cites route, market-context, and scoped quant receipts.
- No live submit path changes.
- At least one sim fixture shows `NVDA` can be classified separately from missing symbols.

Deployer acceptance gates:

- Live `/trading/health` may remain degraded, but the new route book must explain the highest-value repair.
- Live capital remains `zero_notional` throughout rollout.
- Paper probes stay disabled until Jangar repair-cell receipts are fresh and Torghut route book passes the selected
  symbol gate.
- Any stale market-context or scoped quant receipt rolls the paper probe back to zero.
