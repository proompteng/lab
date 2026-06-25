"""Multifactor sections for the trading-loop operator status."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

LATEST_MULTIFACTOR_RUN_SQL = """
SELECT
  id::text,
  lane,
  model_version,
  started_at,
  finished_at,
  status,
  blockers,
  selected_assets
FROM multifactor_runs
ORDER BY finished_at DESC
LIMIT 1
"""

LATEST_FACTOR_SNAPSHOT_SQL = """
SELECT
  run_id::text,
  asset_key,
  venue,
  symbol,
  market_id,
  source_event_at,
  observed_at,
  raw_factors,
  normalized_factors,
  source_lag_seconds,
  quote_lag_seconds,
  freshness_blocker
FROM multifactor_factor_snapshots
ORDER BY observed_at DESC
LIMIT 1
"""

LATEST_FORECAST_SQL = """
SELECT
  run_id::text,
  asset_key,
  model_id,
  horizon_seconds,
  score::text,
  residual_volatility_bps::text,
  information_coefficient::text,
  expected_return_bps::text,
  direction,
  blocker
FROM multifactor_forecasts
ORDER BY updated_at DESC
LIMIT 1
"""

LATEST_RISK_FORECAST_SQL = """
SELECT
  run_id::text,
  asset_key,
  active_risk_bps::text,
  gross_exposure_usd::text,
  symbol_exposure_usd::text,
  liquidity_capacity_usd::text,
  concentration_bps::text,
  blocker
FROM multifactor_risk_forecasts
ORDER BY updated_at DESC
LIMIT 1
"""

LATEST_PORTFOLIO_TARGET_SQL = """
SELECT
  run_id::text,
  asset_key,
  direction,
  current_notional_usd::text,
  target_notional_usd::text,
  delta_notional_usd::text,
  expected_return_bps::text,
  expected_cost_bps::text,
  active_risk_bps::text,
  risk_buffer_bps::text,
  clip_reason
FROM multifactor_portfolio_targets
ORDER BY updated_at DESC
LIMIT 1
"""

LATEST_EXECUTION_INTENT_SQL = """
SELECT
  run_id::text,
  asset_key,
  venue,
  side,
  notional_usd::text,
  idempotency_key,
  status,
  blocker,
  venue_order_id
FROM multifactor_execution_intents
ORDER BY updated_at DESC
LIMIT 1
"""

LATEST_ATTRIBUTION_SQL = """
SELECT
  run_id::text,
  observed_at,
  fill_count,
  realized_pnl_usd::text,
  turnover_usd::text,
  realized_cost_usd::text,
  information_coefficient::text,
  information_ratio::text,
  hit_rate::text
FROM multifactor_attribution_snapshots
ORDER BY observed_at DESC
LIMIT 1
"""


def alpha_model_payload(rows: Any, summary: Any) -> dict[str, object]:
    return {
        "present": summary.multifactor_run_present and summary.alpha_forecast_present,
        "run_id": _optional_text(rows.latest_multifactor_run.get("id")),
        "model_id": _optional_text(rows.latest_forecast.get("model_id")),
        "factor_snapshot_present": summary.factor_snapshot_present,
        "forecast_present": summary.alpha_forecast_present,
        "expected_return_bps": _optional_text(
            rows.latest_forecast.get("expected_return_bps")
        ),
        "expected_edge_above_cost": summary.alpha_edge_above_cost,
        "score": _optional_text(rows.latest_forecast.get("score")),
        "information_coefficient": _optional_text(
            rows.latest_forecast.get("information_coefficient")
        ),
        "residual_volatility_bps": _optional_text(
            rows.latest_forecast.get("residual_volatility_bps")
        ),
        "direction": _optional_text(rows.latest_forecast.get("direction")),
        "freshness": _freshness_payload(rows.latest_factor_snapshot),
        "raw_factors": _mapping_payload(rows.latest_factor_snapshot.get("raw_factors")),
        "normalized_factors": _mapping_payload(
            rows.latest_factor_snapshot.get("normalized_factors")
        ),
    }


def risk_forecast_payload(rows: Any, summary: Any) -> dict[str, object]:
    return {
        "present": summary.risk_forecast_present,
        "active_risk_bps": _optional_text(
            rows.latest_risk_forecast.get("active_risk_bps")
        ),
        "gross_exposure_usd": _optional_text(
            rows.latest_risk_forecast.get("gross_exposure_usd")
        ),
        "symbol_exposure_usd": _optional_text(
            rows.latest_risk_forecast.get("symbol_exposure_usd")
        ),
        "liquidity_capacity_usd": _optional_text(
            rows.latest_risk_forecast.get("liquidity_capacity_usd")
        ),
        "concentration_bps": _optional_text(
            rows.latest_risk_forecast.get("concentration_bps")
        ),
        "blocker": _optional_text(rows.latest_risk_forecast.get("blocker")),
    }


def portfolio_target_payload(rows: Any, summary: Any) -> dict[str, object]:
    return {
        "present": summary.portfolio_target_present,
        "target_notional_positive": summary.target_notional_positive,
        "direction": _optional_text(rows.latest_portfolio_target.get("direction")),
        "target_notional_usd": _optional_text(
            rows.latest_portfolio_target.get("target_notional_usd")
        ),
        "delta_notional_usd": _optional_text(
            rows.latest_portfolio_target.get("delta_notional_usd")
        ),
        "expected_return_bps": _optional_text(
            rows.latest_portfolio_target.get("expected_return_bps")
        ),
        "expected_cost_bps": _optional_text(
            rows.latest_portfolio_target.get("expected_cost_bps")
        ),
        "active_risk_bps": _optional_text(
            rows.latest_portfolio_target.get("active_risk_bps")
        ),
        "risk_buffer_bps": _optional_text(
            rows.latest_portfolio_target.get("risk_buffer_bps")
        ),
        "clip_reason": _optional_text(rows.latest_portfolio_target.get("clip_reason")),
    }


def execution_intent_payload(rows: Any, summary: Any) -> dict[str, object]:
    return {
        "present": summary.execution_intent_present,
        "venue": _optional_text(rows.latest_execution_intent.get("venue")),
        "side": _optional_text(rows.latest_execution_intent.get("side")),
        "notional_usd": _optional_text(
            rows.latest_execution_intent.get("notional_usd")
        ),
        "idempotency_key": _optional_text(
            rows.latest_execution_intent.get("idempotency_key")
        ),
        "status": _optional_text(rows.latest_execution_intent.get("status")),
        "venue_order_id": _optional_text(
            rows.latest_execution_intent.get("venue_order_id")
        ),
        "blocker": _optional_text(rows.latest_execution_intent.get("blocker")),
    }


def attribution_payload(rows: Any) -> dict[str, object]:
    return {
        "present": bool(rows.latest_attribution),
        "observed_at": _iso(
            _datetime_value(rows.latest_attribution.get("observed_at"))
        ),
        "fill_count": _int(rows.latest_attribution.get("fill_count")),
        "realized_pnl_usd": _optional_text(
            rows.latest_attribution.get("realized_pnl_usd")
        ),
        "turnover_usd": _optional_text(rows.latest_attribution.get("turnover_usd")),
        "realized_cost_usd": _optional_text(
            rows.latest_attribution.get("realized_cost_usd")
        ),
        "hit_rate": _optional_text(rows.latest_attribution.get("hit_rate")),
    }


def _freshness_payload(row: Mapping[str, object]) -> dict[str, object]:
    return {
        "source_lag_seconds": _optional_int(row.get("source_lag_seconds")),
        "quote_lag_seconds": _optional_int(row.get("quote_lag_seconds")),
        "freshness_blocker": _optional_text(row.get("freshness_blocker")),
    }


def _mapping_payload(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value)
    if isinstance(value, str):
        try:
            loaded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(loaded, Mapping):
            return cast(Mapping[str, object], loaded)
    return {}


def _datetime_value(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _ensure_aware(value)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return _ensure_aware(parsed)
    return None


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if value is None:
        return 0
    try:
        return int(Decimal(str(value)))
    except Exception:
        return 0


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(Decimal(str(value)))
    except Exception:
        return None


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text_value = str(value).strip()
    return text_value or None
