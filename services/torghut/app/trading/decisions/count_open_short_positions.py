"""Trading decision engine based on TA signals."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any, Optional, cast

from ..models import SignalEnvelope


from .positions_for_strategy_action import (
    position_qty_from_payload,
)


def count_open_short_positions(positions: Optional[list[dict[str, Any]]]) -> int:
    if not positions:
        return 0
    open_symbols: set[str] = set()
    for position in positions:
        symbol = str(position.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        qty = position_qty_from_payload(position)
        if qty is not None:
            if qty < 0:
                open_symbols.add(symbol)
            continue
        raw_value = (
            position.get("market_value")
            or position.get("current_value")
            or position.get("notional")
        )
        if raw_value is None:
            continue
        try:
            market_value = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        side = str(position.get("side") or "").strip().lower()
        if side == "short" and market_value != 0:
            open_symbols.add(symbol)
    return len(open_symbols)


def resolve_signal_timeframe(signal: SignalEnvelope) -> Optional[str]:
    if signal.timeframe is not None:
        return signal.timeframe
    payload_map: dict[str, Any] = signal.payload

    timeframe = payload_map.get("timeframe")
    if isinstance(timeframe, str):
        return _coerce_timeframe(timeframe)

    window = payload_map.get("window")
    if isinstance(window, dict):
        window_payload = cast(dict[str, Any], window)
        window_size = window_payload.get("size")
        if isinstance(window_size, str):
            return _coerce_timeframe(window_size)

    window_size_payload = payload_map.get("window_size")
    if isinstance(window_size_payload, str):
        return _coerce_timeframe(window_size_payload)

    window_step = payload_map.get("window_step")
    if isinstance(window_step, str):
        return _coerce_timeframe(window_step)

    return None


def _coerce_timeframe(value: str) -> Optional[str]:
    legacy_match = re.fullmatch(
        r"(?i)\s*(\d+)\s*(sec|secs|s|min|minute|minutes|m|hour|hours|h)\s*",
        value,
    )
    if legacy_match is not None:
        amount = int(legacy_match.group(1))
        unit = legacy_match.group(2).lower()
        if unit in {"sec", "secs", "s"}:
            return f"{amount}Sec"
        if unit in {"min", "minute", "minutes", "m"}:
            return f"{amount}Min"
        if unit in {"hour", "hours", "h"}:
            return f"{amount}Hour"

    iso_match = re.fullmatch(r"PT(\d+)([SMH])", value)
    if iso_match is not None:
        amount = int(iso_match.group(1))
        unit = iso_match.group(2)
        if unit == "S":
            return f"{amount}Sec"
        if unit == "M":
            return f"{amount}Min"
        if unit == "H":
            return f"{amount}Hour"
    return None


def runtime_enabled() -> bool:
    return True


__all__ = (
    "count_open_short_positions",
    "resolve_signal_timeframe",
    "runtime_enabled",
)
