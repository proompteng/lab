# Torghut Sizing Throughput Profitability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the blockers that kept June 4 paper-route sizing tiny, then prove source-backed post-cost profitability before any larger capital promotion.

**Architecture:** Keep the route safe: broker-position truth wins over cached state, target-notional sizing must be visible in decision payloads, closed-window runtime-ledger import creates the authoritative PnL buckets, and scale only follows positive post-cost expectancy. TigerBeetle is accounting parity, not profitability authority.

**Tech Stack:** Python, FastAPI Torghut service, SQLAlchemy models, CNPG Postgres, Alpaca paper adapter, TigerBeetle refs, pytest, Pyright.

---

## Current Evidence

- Live service: `torghut-sim-01161`, `TORGHUT_COMMIT=ea5e179e1f8c7caa3ae24a0974c0c2fe1cb14860`, image digest `sha256:3d3c4554f1b110a22815418b36c06e435b9ffc5601df7e6ef8ceb8b75b63e46f`.
- June 4 `TORGHUT_SIM` decisions since `2026-06-04T04:00:00Z`: `filled=8`, `planned=3`, `rejected=88`.
- Reject reasons: `invalid_qty_increment=56`, `broker_submit_failed=32`.
- Filled notional: `$12,561.7537515069`; TCA shortfall total: `-$9.01797855`; latest open positions: AAPL long `11.9792`, AMZN short `1`.
- Runtime-ledger buckets for June 4: `0`; proof-distance readback is blocked by missing runtime-ledger rows and zero observed daily net PnL.
- TigerBeetle reconciliation is healthy and account-scoped: `runtime_ledger_missing_signed_ref_count=0`, `runtime_ledger_missing_account_ref_count=0`.
- Root cause of tiny sizing: morning decisions had zero `paper_route_target_notional_sizing` audits and used 1-share/static fallback before the current target-notional path could prove a fresh window. Repeated exit retries then wasted cycles on stale inventory.

## File Map

- Modify: `services/torghut/app/trading/scheduler/simple_pipeline.py`
  - Broker-position refresh for paper-route exits and retry paths.
  - Target-notional audit persistence for bounded collection source decisions.
- Modify: `services/torghut/tests/test_trading_pipeline.py`
  - Regression tests for stale broker inventory, target-notional sizing audits, and retry behavior.
- Modify if needed: `services/torghut/app/trading/paper_route_evidence.py`
  - Scope contamination/readiness to source windows after closed-window import.
- Modify if needed: `services/torghut/app/trading/execution.py`
  - Attach unambiguous execution-policy hash/cost lineage to executions if TCA lineage remains blocked.
- Operational runner: `services/torghut/scripts/renew_latest_empirical_promotion_jobs.py`
  - Import June 4 closed runtime window after `2026-06-04T21:00:00Z`.
- Operational runner: `services/torghut/scripts/flatten_paper_account_positions.py`
  - Flatten paper account after the runtime window closes, then persist zero-position evidence.

### Task 1: Stop Stale Exit Retry Spam

**Files:**
- Modify: `services/torghut/app/trading/scheduler/simple_pipeline.py`
- Test: `services/torghut/tests/test_trading_pipeline.py`

- [x] **Step 1: Write the failing regression**

Test case added:

```python
def test_simple_pipeline_skips_probe_exit_retry_without_broker_inventory(self) -> None:
    decision = StrategyDecision(
        strategy_id=str(uuid4()),
        symbol="INTC",
        event_ts=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        timeframe="1Sec",
        action="sell",
        qty=Decimal("34.6997"),
        rationale="paper-route-probe-exit",
        params={
            "price": Decimal("108.37"),
            "paper_route_probe_exit": {
                "mode": "paper_route_exit",
                "db_open_qty": "34.69970000",
                "db_open_side": "long",
            },
            "simple_lane": {"quantity_resolution": {"position_qty": "34.6997"}},
        },
    )
    prepared = SimpleTradingPipeline._prepare_paper_route_probe_exit_position(
        [{"symbol": "INTC", "qty": "34.6997", "side": "long"}],
        decision,
        execution_adapter=PositionedAlpacaClient([]),
        trading_mode="paper",
    )
    self.assertIsNone(prepared)
```

- [x] **Step 2: Implement broker-position refresh**

Implementation added:

```python
broker_positions = SimpleTradingPipeline._execution_adapter_positions(execution_adapter)
current_qty = position_qty_for_symbol(
    broker_positions if broker_positions is not None else positions,
    decision.symbol,
)
```

- [x] **Step 3: Validate**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_trading_pipeline.py::TestTradingPipeline::test_simple_pipeline_skips_probe_exit_retry_without_broker_inventory tests/test_trading_pipeline.py::TestTradingPipeline::test_simple_pipeline_reopens_rejected_paper_route_probe_exit tests/test_trading_pipeline.py::TestTradingPipeline::test_simple_pipeline_does_not_exit_without_broker_inventory tests/test_trading_pipeline.py::TestTradingPipeline::test_simple_pipeline_restores_simulation_exit_position_from_db_open_qty -q
```

Expected: `4 passed`.

### Task 2: Make Target-Notional Sizing Auditable In The Next Live Window

**Files:**
- Modify: `services/torghut/app/trading/scheduler/simple_pipeline.py`
- Test: `services/torghut/tests/test_trading_pipeline.py`

- [ ] **Step 1: Add a regression for source decisions**

Create a test that calls `_paper_route_target_source_decisions` with a target containing `paper_route_probe_next_session_max_notional="75000"` and symbols `["AAPL", "AMZN"]`. Assert each emitted decision contains `params.paper_route_target_notional_sizing.sizing_source == "target_notional"` and non-null `resolved_notional`.

- [ ] **Step 2: Fail closed if the audit is missing**

In source-decision creation, reject or skip bounded collection decisions when `quantity_resolution.audit["sizing_source"] != "target_notional"` unless the audit carries an explicit blocker such as `paper_route_target_notional_price_missing`.

- [ ] **Step 3: Validate the next window**

After deployment and market activity, run:

```bash
kubectl cnpg psql -n torghut torghut-db -- -d torghut_sim_default -P pager=off -c "select count(*) filter (where decision_json->'params'->'paper_route_target_notional_sizing' is not null) from trade_decisions where alpaca_account_label='TORGHUT_SIM' and created_at >= now() - interval '1 day';"
```

Expected: count is positive for fresh target-source decisions.

### Task 3: Import The Closed June 4 Runtime Window

**Files:**
- Operational: `services/torghut/scripts/renew_latest_empirical_promotion_jobs.py`
- Operational: `services/torghut/scripts/flatten_paper_account_positions.py`

- [ ] **Step 1: Wait for import readiness**

Do not import before `2026-06-04T21:00:00Z`; that is one hour after the `2026-06-04T20:00:00Z` market-window close.

- [ ] **Step 2: Flatten and persist zero-position evidence**

Run the existing flatten handoff with `--persist-snapshot --apply` against `TORGHUT_SIM` after the window closes.

- [ ] **Step 3: Import runtime window**

Run `renew_latest_empirical_promotion_jobs.py` with `--runtime-window-import --runtime-window-target-plan-url --runtime-window-target-plan-exclusive --runtime-window-target-plan-required --runtime-window-target-plan-settlement-seconds 3600`.

- [ ] **Step 4: Verify proof buckets**

Expected SQL after import:

```sql
select count(*), sum(filled_notional), sum(net_strategy_pnl_after_costs)
from strategy_runtime_ledger_buckets
where account_label='TORGHUT_SIM'
  and observed_stage='paper'
  and bucket_started_at >= '2026-06-04T00:00:00Z';
```

The count must be positive before any profitability claim.

### Task 4: Clear Contamination Without Weakening Gates

**Files:**
- Modify if evidence shows false-positive contamination: `services/torghut/app/trading/paper_route_evidence.py`
- Test: `services/torghut/tests/test_paper_route_evidence.py`

- [ ] **Step 1: Inspect contamination rows**

Use `paper-route-evidence` and SQL to list `observed_from_contaminated_target` pairs for H-PAIRS and H-TSMOM.

- [ ] **Step 2: Classify the blocker**

If the same proof window contains cross-strategy source activity, keep `paper_route_account_contamination_detected` and start a clean next window. If old rows outside the selected source window are leaking into the current target, scope the query by selected source refs/window IDs.

- [ ] **Step 3: Add regression**

Create one test where two strategies trade in the same selected proof window and contamination remains blocked, and one test where older foreign rows outside the selected source refs do not contaminate a fresh clean window.

### Task 5: Clear TCA Cost-Lineage Ambiguity

**Files:**
- Modify: `services/torghut/app/trading/execution.py`
- Test: `services/torghut/tests/test_trading_pipeline.py` or `services/torghut/tests/test_execution_policy.py`

- [ ] **Step 1: Preserve execution policy identity**

Ensure each execution created from bounded collection decisions persists a stable execution-policy hash in `execution_audit_json` or TCA lineage inputs.

- [ ] **Step 2: Verify lineage**

Run:

```bash
kubectl -n torghut exec deploy/torghut-sim -- curl -sS http://127.0.0.1:8181/trading/tca
```

Expected: `runtime_ledger_lineage.blockers` no longer includes `execution_policy_hash_ambiguous` for fresh fills.

### Task 6: Scale Only From Source-Backed Positive Expectancy

**Files:**
- Modify if needed: `services/torghut/app/trading/risk.py`
- Modify if needed: `services/torghut/app/trading/proof_floor.py`
- Test: `services/torghut/tests/test_profitability_proof_floor.py`

- [ ] **Step 1: Use runtime-ledger expectancy**

After import, compute:

```text
required_daily_notional = 500 / (observed_post_cost_expectancy_bps / 10000)
```

- [ ] **Step 2: Require drawdown budget**

Keep `target_drawdown_budget_missing` blocking until the imported runtime-ledger bucket provides drawdown evidence within the configured cap.

- [ ] **Step 3: Produce scale ladder**

Allowed next caps:

```text
repair_only -> 0 live notional
bounded paper collection -> target cap from source plan, currently 75000
promotion candidate -> min(capacity_daily_notional, required_daily_notional) only when post-cost expectancy is positive and source-backed
```

### Task 7: Full Validation Before PR

**Files:** all changed Torghut files.

- [ ] **Step 1: Run targeted tests**

```bash
cd services/torghut
uv run --frozen pytest tests/test_trading_pipeline.py::TestTradingPipeline::test_simple_pipeline_skips_probe_exit_retry_without_broker_inventory -q
```

- [ ] **Step 2: Run Torghut type checks**

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

- [ ] **Step 3: Open PR**

Use `.github/PULL_REQUEST_TEMPLATE.md`, semantic title `fix(torghut): prevent stale paper-route exit retries`, and include the June 4 SQL evidence above.
