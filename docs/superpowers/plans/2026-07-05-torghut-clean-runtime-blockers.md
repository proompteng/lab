# Torghut Clean Runtime Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining hidden fixed-cap/runtime-proof garbage from the Hyperliquid execution path so Torghut has one understandable margin-aware risk path and live status shows the exact reason when trading stops.

**Architecture:** Keep order submission in the existing Hyperliquid v2 service. Daily loss is decided once inside the multifactor risk model using an effective limit of `max(config.max_daily_loss_usd, account_equity * target_margin_utilization)`, so the old absolute `$100` floor cannot silently stop a margin-backed testnet account by itself. Position reconciliation compares managed runtime positions to managed exchange positions and reports unmanaged external positions separately.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy, pytest, pyright, Argo CD GitOps.

---

### Task 1: Single-Source Daily Loss Risk

**Files:**
- Modify: `services/torghut/app/hyperliquid_execution/risk.py`
- Modify: `services/torghut/app/trading/multifactor/risk_model.py`
- Test: `services/torghut/tests/hyperliquid_execution/test_strategy_risk_universe.py`

- [x] **Step 1: Add failing tests**

Add tests proving a UTC-day loss just past the configured floor does not block when the margin-derived limit is higher, and a loss past the effective margin-derived limit still blocks.

Run: `cd services/torghut && uv run --frozen pytest tests/hyperliquid_execution/test_strategy_risk_universe.py -q`
Expected: FAIL before implementation.

- [x] **Step 2: Implement effective daily loss limit**

In `risk.py`, add a helper that returns `max(config.max_daily_loss_usd, max(account_value_usd, withdrawable_usd) * config.target_margin_utilization)` and pass it into `RiskLimits`.

Remove the duplicate `daily_loss_stop` check from `_blocked_reason`; strict operational gates stay there, risk gates stay in `build_risk_forecast`.

- [x] **Step 3: Run targeted risk tests**

Run: `cd services/torghut && uv run --frozen pytest tests/hyperliquid_execution/test_strategy_risk_universe.py -q`
Expected: PASS.

### Task 2: Make Runtime Status Honest

**Files:**
- Modify: `services/torghut/app/hyperliquid_execution/api.py`
- Modify: `services/torghut/app/hyperliquid_execution/service.py`
- Test: `services/torghut/tests/hyperliquid_execution/test_runtime_surfaces.py`

- [x] **Step 1: Expose configured risk floor**

Add `max_daily_loss_usd` to `/trading/status.config` and `/report` config payload.

- [x] **Step 2: Expose cycle risk inputs**

Add `daily_realized_pnl_usd`, `account_value_usd`, `withdrawable_usd`, and `effective_daily_loss_limit_usd` to the latest cycle `universe` details after `risk_state` is loaded.

- [x] **Step 3: Run targeted status tests**

Run: `cd services/torghut && uv run --frozen pytest tests/hyperliquid_execution/test_runtime_surfaces.py -q`
Expected: PASS.

### Task 3: Reconcile Managed Positions Only

**Files:**
- Modify: `services/torghut/app/trading/loop_status.py`
- Test: `services/torghut/tests/test_trading_loop_status.py`

- [x] **Step 1: Add regression for unmanaged exchange positions**

Update the existing nested-dex test so an exchange-only `xyz:NVDA` position appears under `position.unmanaged_exchange_positions` and does not emit `hyperliquid_position_reconciliation_missing` when the managed persisted positions match the managed raw positions.

- [x] **Step 2: Implement managed/external split**

Compare persisted positions only to raw exchange positions whose coin appears in the managed persisted position set. Keep all raw positions in the payload and add an unmanaged list for diagnostics.

- [x] **Step 3: Run loop-status tests**

Run: `cd services/torghut && uv run --frozen pytest tests/test_trading_loop_status.py -q`
Expected: PASS.

### Task 4: Validate And Roll Out

**Files:**
- Modified files from Tasks 1-3
- Modify: `.github/PULL_REQUEST_TEMPLATE.md` only if the template itself is broken; otherwise copy it to a temp PR body file.

- [x] **Step 1: Run Torghut validation**

Run:
`cd services/torghut && uv sync --frozen --extra dev`
`cd services/torghut && uv run --frozen pytest tests/hyperliquid_execution/test_strategy_risk_universe.py tests/hyperliquid_execution/test_runtime_surfaces.py tests/test_trading_loop_status.py -q`
`cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
`cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
`cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`
`bun run lint:argocd`

Expected: all PASS.

- [ ] **Step 2: Open, merge, promote, and verify**

Create a semantic PR from `codex/torghut-clean-runtime-blockers`, wait for green checks, squash merge, wait for image build and release promotion, merge the promotion PR, refresh Argo, and verify live `/readyz`, `/trading/status`, and `/trading/loop/status`.

Expected live proof: Argo Synced/Healthy at promoted revision, runtime deployment rolled out, `/trading/status.operational_submission_gate.allowed=true`, no `daily_loss_stop` from the old fixed floor, and no `hyperliquid_position_reconciliation_missing` caused only by unmanaged `xyz:*` residue.
