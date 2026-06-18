from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


_SECOND_OOS_WINDOW_ID = "second_oos"


@dataclass(frozen=True)
class FullWindowConsistencyPolicy:
    target_net_per_day: Decimal
    min_daily_net_pnl: Decimal
    min_active_days: int
    min_active_ratio: Decimal
    min_positive_days: int
    max_worst_day_loss: Decimal
    max_negative_days: int
    max_drawdown: Decimal
    max_best_day_share_of_total_pnl: Decimal
    min_avg_filled_notional_per_day: Decimal
    min_avg_filled_notional_per_active_day: Decimal
    require_every_day_active: bool
    min_regime_slice_pass_rate: Decimal = Decimal("0")
    max_symbol_concentration_share: Decimal = Decimal("1")
    max_entry_family_contribution_share: Decimal = Decimal("1")
    max_gross_exposure_pct_equity: Decimal = Decimal("999999999")
    min_cash: Decimal = Decimal("-999999999")
    min_window_weekday_count: int = 0

    def to_payload(self) -> dict[str, Any]:
        return {
            "target_net_per_day": str(self.target_net_per_day),
            "min_daily_net_pnl": str(self.min_daily_net_pnl),
            "min_active_days": self.min_active_days,
            "min_active_ratio": str(self.min_active_ratio),
            "min_positive_days": self.min_positive_days,
            "max_worst_day_loss": str(self.max_worst_day_loss),
            "max_negative_days": self.max_negative_days,
            "max_drawdown": str(self.max_drawdown),
            "max_best_day_share_of_total_pnl": str(
                self.max_best_day_share_of_total_pnl
            ),
            "min_avg_filled_notional_per_day": str(
                self.min_avg_filled_notional_per_day
            ),
            "min_avg_filled_notional_per_active_day": str(
                self.min_avg_filled_notional_per_active_day
            ),
            "require_every_day_active": self.require_every_day_active,
            "min_regime_slice_pass_rate": str(self.min_regime_slice_pass_rate),
            "max_symbol_concentration_share": str(self.max_symbol_concentration_share),
            "max_entry_family_contribution_share": str(
                self.max_entry_family_contribution_share
            ),
            "max_gross_exposure_pct_equity": str(self.max_gross_exposure_pct_equity),
            "min_cash": str(self.min_cash),
            "min_window_weekday_count": self.min_window_weekday_count,
        }


@dataclass(frozen=True)
class OrderTypeAblationPolicy:
    enabled: bool
    max_candidates: int
    min_sample_count: int
    max_opportunity_cost_bps: Decimal

    def to_payload(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "max_candidates": self.max_candidates,
            "min_sample_count": self.min_sample_count,
            "max_opportunity_cost_bps": str(self.max_opportunity_cost_bps),
        }


def _write_json_output(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _replay_tape_selection_metadata(
    validation: Mapping[str, Any] | None,
) -> dict[str, Any]:
    payload = dict(validation or {})
    return {
        "content_sha256": str(payload.get("content_sha256") or ""),
        "dataset_snapshot_ref": str(payload.get("dataset_snapshot_ref") or ""),
        "source_query_digest": str(payload.get("source_query_digest") or ""),
        "source_table_versions": dict(
            cast(Mapping[str, Any], payload.get("source_table_versions") or {})
        ),
        "feature_schema_hash": str(payload.get("feature_schema_hash") or ""),
        "cost_model_hash": str(payload.get("cost_model_hash") or ""),
        "strategy_family": str(payload.get("strategy_family") or ""),
        "feature_versions": dict(
            cast(Mapping[str, Any], payload.get("feature_versions") or {})
        ),
        "replay_cache_key": str(payload.get("replay_cache_key") or ""),
        "cache_identity": dict(
            cast(Mapping[str, Any], payload.get("cache_identity") or {})
        ),
        "selected_symbols": list(
            cast(Sequence[Any], payload.get("selected_symbols") or ())
        ),
        "selected_row_count": int(payload.get("selected_row_count") or 0),
        "validation_status": str(payload.get("status") or ""),
        "manifest_start_date": str(payload.get("manifest_start_date") or ""),
        "manifest_end_date": str(payload.get("manifest_end_date") or ""),
    }


def _resolve_full_window(
    *,
    args: argparse.Namespace,
    train_days: tuple[date, ...],
    holdout_days: tuple[date, ...],
) -> tuple[date, date]:
    if str(args.full_window_start_date or "").strip():
        start = date.fromisoformat(str(args.full_window_start_date))
    else:
        start = train_days[0]
    if str(args.full_window_end_date or "").strip():
        end = date.fromisoformat(str(args.full_window_end_date))
    else:
        end = holdout_days[-1]
    if start > end:
        raise ValueError("full_window_invalid_range")
    return (start, end)


def _max_drawdown_from_daily_net(daily_net: Mapping[str, Decimal]) -> Decimal:
    equity = Decimal("0")
    peak = Decimal("0")
    max_drawdown = Decimal("0")
    for trading_day in sorted(daily_net):
        equity += daily_net[trading_day]
        if equity > peak:
            peak = equity
        drawdown = peak - equity
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    return max_drawdown


def _daily_filled_notional(payload: Mapping[str, Any]) -> dict[str, Decimal]:
    daily_payload = cast(Mapping[str, Any], payload.get("daily") or {})
    filled_notional: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        if not isinstance(value, Mapping):
            continue
        value_mapping = cast(Mapping[str, Any], value)
        filled_notional[str(day)] = Decimal(
            str(value_mapping.get("filled_notional", "0"))
        )
    return filled_notional


def _daily_liquidity_notional(payload: Mapping[str, Any]) -> dict[str, Decimal]:
    daily_payload = cast(Mapping[str, Any], payload.get("daily") or {})
    liquidity_notional: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        if not isinstance(value, Mapping):
            continue
        value_mapping = cast(Mapping[str, Any], value)
        raw_value = (
            value_mapping.get("adv_notional")
            or value_mapping.get("daily_adv_notional")
            or value_mapping.get("depth_notional")
            or value_mapping.get("fillable_depth_notional")
        )
        if raw_value is None:
            continue
        liquidity_notional[str(day)] = Decimal(str(raw_value))
    return liquidity_notional


def _daily_decimal_metric(payload: Mapping[str, Any], key: str) -> dict[str, Decimal]:
    daily_payload = cast(Mapping[str, Any], payload.get("daily") or {})
    values: dict[str, Decimal] = {}
    for day, value in daily_payload.items():
        if not isinstance(value, Mapping):
            continue
        raw_value = cast(Mapping[str, Any], value).get(key)
        if raw_value is None:
            continue
        values[str(day)] = Decimal(str(raw_value))
    return values


def _daily_int_metric(payload: Mapping[str, Any], key: str) -> dict[str, int]:
    daily_payload = cast(Mapping[str, Any], payload.get("daily") or {})
    values: dict[str, int] = {}
    for day, value in daily_payload.items():
        if not isinstance(value, Mapping):
            continue
        raw_value = cast(Mapping[str, Any], value).get(key)
        if raw_value is None:
            continue
        values[str(day)] = int(raw_value)
    return values


def _int_mapping(value: Any) -> dict[str, int]:
    if not isinstance(value, Mapping):
        return {}
    counts: dict[str, int] = {}
    for key, item in cast(Mapping[Any, Any], value).items():
        try:
            count = int(float(str(item or 0)))
        except (TypeError, ValueError):
            count = 0
        normalized_key = str(key or "").strip().lower()
        if normalized_key:
            counts[normalized_key] = count
    return counts


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _optional_decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    return Decimal(str(value))


def _nonnegative_int_metric(value: Any) -> int:
    if value in (None, ""):
        return 0
    try:
        return max(0, int(Decimal(str(value))))
    except (InvalidOperation, ValueError):
        return 0


def _truthy_metric(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "pass", "passed"}


__all__ = [
    "_SECOND_OOS_WINDOW_ID",
    "FullWindowConsistencyPolicy",
    "OrderTypeAblationPolicy",
    "_write_json_output",
    "_replay_tape_selection_metadata",
    "_resolve_full_window",
    "_max_drawdown_from_daily_net",
    "_daily_filled_notional",
    "_daily_liquidity_notional",
    "_daily_decimal_metric",
    "_daily_int_metric",
    "_int_mapping",
    "_mapping",
    "_optional_decimal",
    "_nonnegative_int_metric",
    "_truthy_metric",
]
