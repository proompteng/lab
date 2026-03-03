# Torghut Shorts + Sizing Remediation (2026-03-03)

## Objective

Reduce non-kill-switch rejections by:

1. Enabling short intents safely with Alpaca-compatible prechecks.
2. Eliminating misleading `qty_below_min` rejects when symbol capacity is already exhausted.

## Root Cause Summary

### Shorts

- `shorts_not_allowed` rejects were deterministic local policy rejects when short-increasing sells were evaluated with `TRADING_ALLOW_SHORTS=false`.
- This did not validate Alpaca short prerequisites (`account shorting enabled`, `shortable`, `easy_to_borrow`) because shorts were disabled before broker capability checks were needed.

### `qty_below_min`

- Rejects labeled `qty_below_min` were primarily not quantity-step defects.
- The portfolio sizing audit showed `cap_per_symbol_zero` and `final_qty=0`, then downstream minimum-qty validation labeled the rejection as `qty_below_min`.
- For March 2 examples, this happened when the symbol already exceeded configured per-symbol capacity, so adding exposure was impossible.

## Implemented Changes

### 1) Alpaca-aligned short prechecks

Files:

- `services/torghut/app/trading/execution.py`
- `services/torghut/app/alpaca_client.py`

Behavior:

- For short-increasing sells, local pre-submit checks now enforce:
  - account has `shorting_enabled=true` (when available),
  - asset is `tradable=true` (when available),
  - asset is `shortable=true` (when available),
  - asset is `easy_to_borrow=true` (when available).
- Rejects now return explicit local codes:
  - `local_account_shorting_disabled`
  - `local_symbol_not_tradable`
  - `local_symbol_not_shortable`
  - `local_symbol_not_easy_to_borrow`

Notes:

- In `TRADING_MODE=live`, account/asset eligibility metadata must be available; unknown metadata is fail-closed with explicit local codes.
- In `TRADING_MODE=paper`, metadata lookup failures remain fail-open so local/testing execution is not blocked.

### 2) Capacity-exhaustion reason fix in portfolio sizing

File:

- `services/torghut/app/trading/portfolio.py`

Behavior:

- Zero-cap sizing methods now produce explicit capacity reasons instead of falling through to `qty_below_min`:
  - `cap_per_symbol_zero` -> `symbol_capacity_exhausted`
  - `cap_gross_exposure_zero` -> `gross_exposure_capacity_exhausted`
  - `cap_net_exposure_zero` -> `net_exposure_capacity_exhausted`
  - `cap_sell_inventory_zero` -> `sell_inventory_unavailable`

### 3) Shorts enabled in feature flags

File:

- `argocd/applications/feature-flags/gitops/default/features.yaml`

Change:

- `torghut_trading_allow_shorts` set to `enabled: true`.

## Validation Plan

### 1. Unit tests

Run:

```bash
uv run --frozen pytest services/torghut/tests/test_order_idempotency.py services/torghut/tests/test_portfolio_sizing.py
```

Expected:

- New short precheck tests pass.
- Capacity-exhaustion reason test passes.

### 2. Runtime validation (post-deploy)

### Rejection taxonomy

```sql
WITH reasons AS (
  SELECT jsonb_array_elements_text(COALESCE(td.decision_json::jsonb->'risk_reasons','[]'::jsonb)) AS reason
  FROM trade_decisions td
  WHERE td.created_at >= now() - interval '24 hours'
    AND td.status='rejected'
)
SELECT reason, count(*) FROM reasons GROUP BY reason ORDER BY count(*) DESC;
```

Acceptance:

- `shorts_not_allowed` trends to near-zero.
- `qty_below_min` materially drops.
- If exposure limits bind, rejections appear as explicit capacity reasons.

### Short capability rejects

Monitor for:

- `local_pre_submit_rejected code=local_account_shorting_disabled`
- `local_pre_submit_rejected code=local_symbol_not_shortable`
- `local_pre_submit_rejected code=local_symbol_not_easy_to_borrow`
- `local_pre_submit_rejected code=local_account_metadata_unavailable`
- `local_pre_submit_rejected code=local_account_shorting_status_unknown`
- `local_pre_submit_rejected code=local_symbol_metadata_unavailable`
- `local_pre_submit_rejected code=local_symbol_tradability_unknown`
- `local_pre_submit_rejected code=local_symbol_shortability_unknown`
- `local_pre_submit_rejected code=local_symbol_borrow_status_unknown`

These are expected safety rejects for symbols/accounts that cannot short or for live lanes that cannot verify required short-eligibility metadata.

### 3. Rollback

Immediate rollback if:

- Broker reject rate spikes materially after enabling shorts.
- Unexpected short inventory behavior appears.

Rollback actions:

1. Set `torghut_trading_allow_shorts` to `false`.
2. Redeploy/reconcile.
3. Confirm rejection mix returns to baseline.
