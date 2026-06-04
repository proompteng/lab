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

- [ ] **Step 1: Query for fresh post-rollout decisions**

Run:

```bash
kubectl cnpg psql -n torghut torghut-db -- -d torghut_sim_default -P pager=off -c "select count(*) filter (where decision_json::text like '%paper_route_target_notional_sizing%') as with_sizing, count(*) filter (where created_at >= timestamptz '2026-06-04 17:49:00+00') as after_rollout, count(*) as total_today from trade_decisions where alpaca_account_label='TORGHUT_SIM' and created_at >= timestamptz '2026-06-04 13:30:00+00';"
```

Expected before flatten: `after_rollout=0` or no source rows while open AAPL/AMZN positions exist.

- [ ] **Step 2: Confirm account-flat blocker**

Run:

```bash
kubectl logs -n torghut deploy/torghut-sim-01165-deployment -c user-container --tail=200 | rg "account is not flat|target source collection"
```

Expected while AAPL/AMZN remain open: account-flat skip messages.

- [ ] **Step 3: Re-run after flatten**

Expected after controlled flatten/import readiness: at least one fresh target-source decision carries `paper_route_target_notional_sizing.sizing_source == "target_notional"` before any scale claim.

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

- [ ] **Step 1: Continuity**

Clear `cursor_tail_stable` by proving the market data cursor is moving or by diagnosing the feed stall. Do not bypass this gate.

- [ ] **Step 2: Rejection drag**

After the stale-exit fix has live rows, verify seven-day rejection drag drops. If stale exit retries still appear after commit `107a3d179`, treat that as a regression.

- [ ] **Step 3: Empirical jobs**

Repair stale/ineligible empirical jobs only through source-linked jobs. Do not mark empirical readiness from old replay-only candidates.

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
