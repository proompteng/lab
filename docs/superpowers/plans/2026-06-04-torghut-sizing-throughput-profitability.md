# Torghut Sizing Throughput Profitability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the causes of undersized June 4 paper-route trading, then prove source-backed post-cost profitability before any larger capital promotion.

**Architecture:** Broker/account truth controls the paper route. Target-notional orders must carry explicit sizing audit, the account must be flat before bounded source collection, closed-window runtime-ledger import is the PnL authority, and scale increases only from source-backed positive expectancy. TigerBeetle is an accounting and journal dependency here; it does not by itself prove profitability.

**Tech Stack:** Python, FastAPI Torghut service, SQLAlchemy models, CNPG Postgres, Alpaca paper adapter, TigerBeetle refs, pytest, Pyright, GitOps/Argo CD.

---

## Current Evidence At 2026-06-04T17:58Z

- Deployment is no longer the blocker:
  - Argo app `torghut`: `Synced`, `Healthy`, operation `Succeeded`, revision `7ba3abb4d802ee24a124f92a9e8db48a5364ef38`.
  - `torghut-post-deploy-verify` run `26969077700` passed.
  - `torghut` revision `torghut-01078` and `torghut-sim` revision `torghut-sim-01165` both run image digest `sha256:061605fcfad253fe24c07c8e0c8823e7606d15e6725aa198e3a45720e1f64386`.
  - Runtime build reports `TORGHUT_COMMIT=107a3d1794d72a2b03381d6fba6af73118730a06`.
- Today before the rollout, `TORGHUT_SIM` produced `99` trade decisions from `2026-06-04T13:30:19Z` through `2026-06-04T13:59:57Z`:
  - `filled=8`, `planned=3`, `rejected=88`.
  - `with paper_route_target_notional_sizing=0`.
  - post-rollout decisions after `2026-06-04T17:49:00Z`: `0`.
- Execution notional today:
  - `8` filled executions, filled notional `$12,561.7537515069`.
  - AAPL buy `2` fills for `$4,048.9108114752`, INTC round trip near `$3,760` each side, then one-share AAPL/AMZN/NVDA legs.
- Rejection drag today:
  - `paper-route-probe-exit` rejected `87` rows.
  - INTC stale exit sell `34.6997` repeated `56` times.
  - NVDA stale exit sell `1` repeated `29` times.
  - AAPL stale exit sell `1` repeated `2` times.
  - One AMZN source buy at qty `1` rejected.
- TCA today:
  - `8` TCA rows.
  - Average realized shortfall `-15.97672608125 bps`.
  - Total shortfall notional `-$9.01797855`.
  - Worst source was AAPL buys: `-$14.43795652`.
- Account state:
  - Latest position snapshot `2026-06-04T17:57:21Z`: equity `$38,914.51`, cash `$35,439.56`, buying power `$147,693.09`.
  - Open positions: AAPL long `11.9792`, AMZN short `1`.
  - Current open mark in the snapshot is about `-$9.49` unrealized.
- Runtime-ledger authority:
  - June 4 `strategy_runtime_ledger_buckets` for `TORGHUT_SIM` since `2026-06-04T13:30:00Z`: `0`.
  - Therefore there is no source-backed June 4 post-cost PnL proof and no profitability conclusion.
- TigerBeetle:
  - `TigerBeetleCluster/torghut-tigerbeetle`: `Ready=True`, `ClientProtocolHealthy=True`, ready replicas `1`, `Degraded=False`.
  - This proves protocol/storage health, not profitable trading.
- Live logs on `torghut-sim-01165` now show:
  - `Skipping paper-route target source collection because account is not flat for bounded SIM evidence`.
  - `Skipping materialized paper-route target source decision because account is not flat for bounded SIM evidence`.
  - `Skipping generic paper-route probe retries while bounded target-plan evidence collection owns account=TORGHUT_SIM`.
- `/trading/status` still blocks promotion:
  - `promotion_eligible_total=0`, `paper_probation_eligible_total=0`.
  - `continuity_ok=false` because `cursor_tail_stable`.
  - `empirical_jobs_ready=false`.
  - `critical_toggle_parity` diverges on `TRADING_MODE` because sim is correctly paper mode.
  - Rejection drag remains high.

## Why Sizing Was Small

1. The target-notional sizing code path was not live when today’s orders were created. Every June 4 decision row has no `paper_route_target_notional_sizing` audit.
2. The live morning path used static/materialized source quantities. Several payloads carried `paper_route_probe_symbol_quantities` of `1`, so one-share orders were expected from that path.
3. Stale exit retries dominated the decision stream. `87/88` rejects were probe-exit retries, including the INTC `34.6997` sell loop.
4. The fixed image is live now, but no post-rollout decisions exist yet because the account is not flat. Open AAPL and AMZN positions correctly block bounded source collection.
5. The `75000` target is a bounded paper collection cap, not automatic `$75k per symbol`. The matched strategy snapshot still reports `max_notional_per_trade=3750`, so scaling must be explicit and source-backed.

## Current Evidence At 2026-06-04T19:10Z

- Deployment and TigerBeetle are operational, but not profitability proof:
  - Argo app `torghut`: `Synced`, `Healthy`, operation `Succeeded`, revision `9aa90dbd85c8e2d6a40cb66319e6bcae17b6195b`.
  - `torghut` revision `torghut-01081` and `torghut-sim` revision `torghut-sim-01168` are ready.
  - `torghut-sim-01168` runs image digest `sha256:10d333b85b2dd2f00cd5e60c26a932b5994e2ee75ea1ecb867e5bdf89cfb0357` with `TORGHUT_COMMIT=3498443e31502173f6eaf7e4dbc0e3efbbf2c3b3`.
  - `TigerBeetleCluster/torghut-tigerbeetle`: `Ready=True`, `ClientProtocolHealthy=True`, `Degraded=False`.
- The current persisted June 4 app-DB performance is zero:
  - DB: `torghut`, not the old simulation DB.
  - `trade_decisions` since `2026-06-04T13:30:00Z`: `23` rows under source account label `PA3SX7FYNUTF`, all `blocked`.
  - `executions` since `2026-06-04T13:30:00Z`: `0`; filled notional `$0`.
  - `strategy_runtime_ledger_buckets` since `2026-06-04T00:00:00Z`: `0`.
- The current target-notional math is no longer tiny:
  - Latest rows use `params.sizing.method=runtime_target_notional`.
  - Most rows request about `$50,000` notional: AAPL around `160` shares, AMZN around `197`, INTC around `448`, NVDA around `228`.
  - The 14:30 pair rows request about `$74.8k` each for AAPL/AMZN.
  - All are blocked at `submission_stage=blocked_live_submission_gate` with `submission_block_reason=simple_submit_disabled`.
- The live submission gate is still shut:
  - `/trading/status` reports `live_submission_gate.allowed=false`.
  - `simple_lane.submit_enabled=true`, but shared gate blockers include `live_submission_gate_status_read_budget_insufficient_remaining`.
  - Capital remains `zero_notional`/`observe`.
  - Empirical proof jobs are stale/ineligible.
  - TCA fill quality is missing because there are no current fills.
  - Route readiness is blocked by `route_universe_empty`, `forecast_registry_degraded`, route identity admission gaps, and read-model degradation.
  - Sim is correctly paper-mode, but status still reports a live-toggle parity divergence on `TRADING_MODE` when evaluating promotion.
- The proof/evidence surface itself is too slow:
  - `/trading/paper-route-evidence?target_limit=5` timed out after a 30s in-pod request.
  - Live logs show statement timeouts in TCA summary, LLM evaluation summary, and paper-route source activity.
  - Source-activity read models query logical account `TORGHUT_SIM`, while June 4 decisions are persisted under source account `PA3SX7FYNUTF`; the alias path has to be made explicit for proof queries.
- Scheduler logs still repeat:
  - `Skipping paper-route target source collection because account is not flat for bounded SIM evidence`.
  - `Skipping materialized paper-route target source decision because account is not flat for bounded SIM evidence`.

## Revised Issue List

1. **Small sizing is fixed for new rows, but not proven through fills.** Current decisions are target-notional sized; all are blocked before submission.
2. **Submission/profitability is blocked by gate state, not order quantity.** `simple_submit_disabled` is coming from the shared live-submission gate, zero-notional capital state, stale empirical proof, missing TCA, route readiness, and read-model timeout debt.
3. **The account lifecycle is jammed.** Bounded source collection is correctly blocked while the paper account is non-flat, so flatten/closed-window import is required before the next clean proof cycle.
4. **Account identity is split.** The logical account is `TORGHUT_SIM`, but current source rows are persisted under Alpaca account id `PA3SX7FYNUTF`; proof/read-model queries must include the source-account alias or canonicalize rows before promotion decisions.
5. **Read-model latency blocks operations.** A status/evidence surface that times out cannot be the authority packet for profitability or promotion.
6. **There is no June 4 runtime-ledger PnL authority yet.** Zero fills and zero buckets means profitability today is not established.

## Implementation Checkpoint At 2026-06-04T19:28Z

- Fresh branch: `codex/torghut-gate-first-read-model-20260604` from current `origin/main`.
- Local fix:
  - `/trading/status` now builds a live-submission gate before TCA, LLM evaluation, and hypothesis-runtime reads.
  - The early gate receives an explicit deferred hypothesis payload with `hypothesis_runtime_deferred_until_after_live_submission_gate`.
  - If the full hypothesis runtime read completes with enough budget remaining, `/trading/status` refreshes the gate with the full payload so specific blockers such as quant-store and lineage failures are not masked by the deferred fallback.
  - `/trading/paper-route-evidence` and `/trading/paper-route-target-plan` now build/cache the gate before optional proof-floor/TCA/hypothesis expansion, and defer those expensive reads when a route-reacquisition book is already available.
- Regression coverage:
  - Budget-pressure status tests assert the live gate is still built once and is no longer skipped by late status-budget exhaustion.
  - Existing blocker-priority tests still pass, proving deferred hypothesis fallback does not mask `quant_latest_metrics_empty` or lineage/table blockers when full read models are healthy.
- Local validation:
  - `uv run --frozen pytest tests/test_trading_api.py -q` -> `175 passed`.
  - `uv run --frozen ruff check app/main.py tests/test_trading_api.py` -> clean.
  - `uv run --frozen ruff format --check app/main.py tests/test_trading_api.py` -> clean.
  - `uv sync --frozen --extra dev` -> clean.
  - `uv run --frozen pyright --project pyrightconfig.json` -> clean.
  - `uv run --frozen pyright --project pyrightconfig.alpha.json` -> clean.
  - `uv run --frozen pyright --project pyrightconfig.scripts.json` -> clean.
- Proof boundary:
  - This is not profitability proof yet.
  - It only removes a status/evidence read-path bottleneck that was preventing the live submission gate and target-plan proof surfaces from becoming useful authority surfaces.
  - Remaining required proof: deploy via GitOps, verify `/trading/status` and target-plan/evidence endpoints return on the live pod, clear account-alias/proof-query misses, flatten/import the June 4 window after settlement readiness, reconcile runtime-ledger/TigerBeetle, and prove post-cost closed/flat PnL.

## File Map

- Modify: `services/torghut/app/trading/scheduler/simple_pipeline.py`
  - Already fixed stale broker-flat exit retry handling.
  - Target-notional source decisions now fail closed when sizing audit is absent or only quantity fallback.
- Modify: `services/torghut/tests/test_simple_pipeline.py`
  - Already contains stale-exit retry regressions.
  - Added regression for target-notional source decisions refusing unaudited quantity fallback submissions.
- Operational: `services/torghut/scripts/flatten_paper_account_positions.py`
  - Flatten the paper account after the target window or controlled exit point.
- Operational: `services/torghut/scripts/renew_latest_empirical_promotion_jobs.py`
  - Import the closed June 4 runtime window after settlement readiness.

### Task 1: Finish Stale Exit Retry Rollout

**Files:**

- Modified: `services/torghut/app/trading/scheduler/simple_pipeline.py`
- Modified: `services/torghut/tests/test_trading_pipeline.py`

- [x] **Step 1: Ship broker-position truth for exits**

Merged PR `#10439`, `fix(torghut): prevent stale paper-route exit retries`.

- [x] **Step 2: Promote a containing image**

Image digest `sha256:061605fcfad253fe24c07c8e0c8823e7606d15e6725aa198e3a45720e1f64386` from commit `107a3d1794d72a2b03381d6fba6af73118730a06` is live on `torghut` and `torghut-sim`.

- [x] **Step 3: Verify post-deploy**

`torghut-post-deploy-verify` run `26969077700` passed.

### Task 2: Prove The New Sizing Path Has A Live Row

**Files:** none unless verification fails.

- [x] **Step 1: Query for fresh post-rollout decisions**

Run:

```bash
kubectl cnpg psql -n torghut torghut-db -- -d torghut -P pager=off -c "select created_at, symbol, decision_json->>'action' as action, (decision_json->>'qty')::numeric as qty, (decision_json#>>'{params,price}')::numeric as price, round(((decision_json->>'qty')::numeric * (decision_json#>>'{params,price}')::numeric), 2) as requested_notional, decision_json->>'submission_block_reason' as submission_block_reason, decision_json->>'submission_stage' as submission_stage from trade_decisions where alpaca_account_label='PA3SX7FYNUTF' and created_at >= timestamptz '2026-06-04 13:30:00+00' order by created_at desc;"
```

Observed at `2026-06-04T19:10Z`: `23` fresh target-notional decisions, requested notional about `$50k` to `$75k`, all blocked by `simple_submit_disabled`.

- [x] **Step 2: Confirm account-flat blocker**

Run:

```bash
kubectl logs -n torghut -l serving.knative.dev/revision=torghut-sim-01168 --since=2h --tail=400 | rg "account is not flat|target source collection"
```

Observed while AAPL/AMZN remain open: account-flat skip messages.

- [ ] **Step 3: Re-run after flatten**

Expected after controlled flatten/import readiness: at least one fresh target-source decision carries runtime target-notional sizing and reaches submission/fill, not merely blocked decision persistence.

### Task 3: Fail Closed On Unaudited Target-Notional Source Submissions

**Files:**

- Modify: `services/torghut/app/trading/scheduler/simple_pipeline.py`
- Test: `services/torghut/tests/test_trading_pipeline.py`

- [x] **Step 1: Add regression**

Add a test near the existing paper-route target-source decision tests that builds a target with `target_notional="75000"` and forces missing price/budget resolution. Assert `_paper_route_target_source_decisions` emits no executable decision when `paper_route_target_notional_sizing.sizing_source != "target_notional"`.

- [x] **Step 2: Add guard**

After `_paper_route_target_quantity_resolution(...)` returns in both target-source paths, skip the decision unless:

```python
quantity_resolution.audit.get("sizing_source") == "target_notional"
```

Log the blocker so the next audit can distinguish safe fail-closed behavior from no signal.

- [x] **Step 3: Validate targeted tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_trading_pipeline.py -k 'target_notional or probe_exit' -q
```

Observed: full `tests/test_simple_pipeline.py` passed; focused materialized target-plan and probe-exit tests in `tests/test_trading_pipeline.py` passed; Ruff and all three Pyright profiles passed.

### Task 4: Flatten The Account Without Polluting Proof

**Files:**

- Operational: `services/torghut/scripts/flatten_paper_account_positions.py`

- [ ] **Step 1: Wait for the proof window or configured exit**

Do not call profitability complete while AAPL/AMZN are open. If the configured exit closes them before `2026-06-04T20:00:00Z`, use the resulting zero-position snapshot. Otherwise flatten after the regular-session window ends.

- [ ] **Step 2: Persist zero-position evidence**

Run the existing flatten runner with persistence enabled for `TORGHUT_SIM`.

Expected DB readback: latest `position_snapshots.positions` is an empty array or every position has zero quantity.

### Task 5: Import June 4 Runtime-Ledger Window

**Files:**

- Operational: `services/torghut/scripts/renew_latest_empirical_promotion_jobs.py`

- [ ] **Step 1: Wait for import readiness**

Do not import the June 4 regular-session window before `2026-06-04T21:00:00Z`, one hour after the `2026-06-04T20:00:00Z` market-window close.

- [ ] **Step 2: Import the runtime window**

Run the existing runtime-window import path with target-plan required and settlement seconds `3600`.

- [ ] **Step 3: Verify buckets**

Run:

```bash
kubectl cnpg psql -n torghut torghut-db -- -d torghut_sim_default -P pager=off -c "select count(*), sum(filled_notional), sum(net_strategy_pnl_after_costs), sum(closed_trade_count), sum(open_position_count) from strategy_runtime_ledger_buckets where account_label='TORGHUT_SIM' and bucket_started_at >= timestamptz '2026-06-04 13:30:00+00';"
```

Expected: positive bucket count, explicit filled notional, explicit post-cost PnL, closed trades or zero open positions.

### Task 6: Clear Promotion Blockers Before Any Scale Increase

**Files:** code only if the blocker is a false-positive readback bug.

- [ ] **Step 1: Make read models fast enough to be authority surfaces**

Fix the timeout debt before trusting status/proof output:

```text
/trading/paper-route-evidence?target_limit=5 must return inside its bounded budget.
/trading/status must not degrade live_submission_gate on status_read_budget_insufficient_remaining for ordinary proof reads.
TCA, LLM evaluation, and source-activity summaries must fail closed independently without poisoning unrelated gate checks.
```

- [ ] **Step 2: Canonicalize or alias account labels in proof queries**

All proof queries that evaluate `TORGHUT_SIM` must include the current source account label `PA3SX7FYNUTF` or use the existing alias metadata. Promotion gates must not miss current source rows because they filter only on the logical label.

- [ ] **Step 3: Continuity**

Clear `cursor_tail_stable` by proving the market data cursor is moving or by diagnosing the feed stall. Do not bypass this gate.

- [ ] **Step 4: Rejection drag**

After the stale-exit fix has live rows, verify seven-day rejection drag drops. If stale exit retries still appear after commit `107a3d179`, treat that as a regression.

- [ ] **Step 5: Empirical jobs**

Repair stale/ineligible empirical jobs only through source-linked jobs. Do not mark empirical readiness from old replay-only candidates.

- [ ] **Step 6: Route identity and universe admission**

Clear `route_identity_admission_account_missing`, `route_identity_admission_window_missing`, `route_identity_admission_trading_mode_missing`, `route_universe_empty`, and `forecast_registry_degraded` from source-backed state. Do not bypass routeability acceptance.

- [ ] **Step 7: Capital posture**

Keep `repair_only` and `zero_notional` until closed-window source evidence, TCA, and runtime-ledger buckets show positive post-cost expectancy. Then move only to bounded paper collection, not live promotion.

### Task 7: Scale From Runtime-Ledger Expectancy

**Files:**

- Modify if needed: `services/torghut/app/trading/risk.py`
- Modify if needed: `services/torghut/app/trading/proof_floor.py`
- Test if modified: `services/torghut/tests/test_profitability_proof_floor.py`

- [ ] **Step 1: Compute required daily notional**

After the runtime-ledger bucket exists:

```text
required_daily_notional = 500 / (observed_post_cost_expectancy_bps / 10000)
```

- [ ] **Step 2: Bound by account and drawdown**

Use account equity, buying power, per-symbol liquidity, and drawdown cap. Current account readback is about `$38.9k` equity and `$147.7k` buying power, so a `$75k` collection cap must still be risk-bounded.

- [ ] **Step 3: Produce the next cap**

Allowed states:

```text
repair_only -> no new capital
bounded paper collection -> source-plan cap with explicit sizing audit
promotion candidate -> min(capacity_daily_notional, required_daily_notional) only after source-backed positive post-cost expectancy
```

### Task 8: Completion Gate

**Files:** none.

- [ ] **Step 1: Build proof packet**

The proof packet must include real decisions, executions, fills, TCA/cost refs, runtime-ledger buckets, TigerBeetle reconciliation refs, source-window ids, closed round trips or flat positions, and post-cost net PnL.

- [ ] **Step 2: Apply the goal threshold**

Only mark the active goal complete if the proof packet shows at least `$500/day` post-cost, promotion authority is green, and no gate was weakened to get there.
