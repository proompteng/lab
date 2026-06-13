"""Simulation order fill and event helpers."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from ..time_source import trading_now
from .order_text import optional_decimal, positive_decimal


def resolve_simulated_fill_price(
    *,
    limit_price: float | None,
    stop_price: float | None,
    simulation_context: Mapping[str, Any] | None = None,
) -> float:
    for candidate in (limit_price, stop_price):
        value = positive_decimal(candidate)
        if value is not None:
            return float(value)
    if isinstance(simulation_context, Mapping):
        for key in ("simulated_fill_price", "fill_price", "arrival_price", "price"):
            value = positive_decimal(simulation_context.get(key))
            if value is not None:
                return float(value)
        price_snapshot = simulation_context.get("price_snapshot")
        if isinstance(price_snapshot, Mapping):
            snapshot_payload = cast(Mapping[object, Any], price_snapshot)
            value = positive_decimal(snapshot_payload.get("price"))
            if value is not None:
                return float(value)
    return 1.0


def resolve_simulated_filled_qty(
    *,
    requested_qty: float,
    simulation_context: Mapping[str, Any] | None = None,
) -> float:
    qty = max(float(requested_qty), 0.0)
    if qty <= 0:
        return 0.0
    if not isinstance(simulation_context, Mapping):
        return qty
    explicit_qty = _first_nonnegative_decimal(
        simulation_context,
        ("simulated_filled_qty", "filled_qty", "fill_qty", "queue_filled_qty"),
    )
    if explicit_qty is not None:
        return float(min(Decimal(str(qty)), explicit_qty))
    ratios: list[Decimal] = []
    explicit_ratio = _first_nonnegative_decimal(
        simulation_context,
        ("simulated_fill_ratio", "fill_ratio", "queue_fill_ratio"),
    )
    if explicit_ratio is not None:
        ratios.append(explicit_ratio)
    queue_fill_probability = _first_nonnegative_decimal(
        simulation_context,
        ("queue_fill_probability", "fill_probability", "passive_fill_probability"),
    )
    if queue_fill_probability is not None:
        ratios.append(queue_fill_probability)
    depth_at_limit = _first_nonnegative_decimal(
        simulation_context,
        ("depth_at_limit", "limit_depth_qty", "available_depth_qty"),
    )
    if depth_at_limit is not None:
        queue_ahead_qty = _first_nonnegative_decimal(
            simulation_context,
            ("queue_ahead_qty", "queue_position_qty"),
        ) or Decimal("0")
        fillable_qty = max(Decimal("0"), depth_at_limit - queue_ahead_qty)
        ratios.append(fillable_qty / Decimal(str(qty)))
    cancel_intensity = _first_nonnegative_decimal(
        simulation_context,
        ("cancel_intensity", "queue_cancel_intensity"),
    )
    market_order_intensity = _first_nonnegative_decimal(
        simulation_context,
        ("market_order_intensity", "opposing_market_order_intensity"),
    )
    if (
        cancel_intensity is not None
        and market_order_intensity is not None
        and cancel_intensity + market_order_intensity > 0
    ):
        ratios.append(
            market_order_intensity / (market_order_intensity + cancel_intensity)
        )
    if not ratios:
        return qty
    fill_ratio = min(Decimal("1"), max(Decimal("0"), min(ratios)))
    return float(Decimal(str(qty)) * fill_ratio)


def _first_nonnegative_decimal(
    payload: Mapping[str, Any],
    keys: tuple[str, ...],
) -> Decimal | None:
    for key in keys:
        value = optional_decimal(payload.get(key))
        if value is not None and value >= 0:
            return value
    return None


def simulated_order_status(*, requested_qty: float, filled_qty: float) -> str:
    if requested_qty <= 0 or filled_qty <= 0:
        return "accepted"
    if filled_qty >= requested_qty:
        return "filled"
    return "partially_filled"


def simulated_trade_update_event(*, requested_qty: float, filled_qty: float) -> str:
    if requested_qty <= 0 or filled_qty <= 0:
        return "new"
    if filled_qty >= requested_qty:
        return "fill"
    return "partial_fill"


def resolve_simulation_event_ts(
    *,
    simulation_context: Mapping[str, Any],
    account_label: str,
) -> datetime:
    raw = simulation_context.get("signal_event_ts")
    if isinstance(raw, str) and raw.strip():
        normalized = f"{raw[:-1]}+00:00" if raw.endswith("Z") else raw
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            parsed = None
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
    return trading_now(account_label=account_label)


__all__ = [
    "resolve_simulated_fill_price",
    "resolve_simulated_filled_qty",
    "resolve_simulation_event_ts",
    "simulated_order_status",
    "simulated_trade_update_event",
]
