# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Trading decision engine based on TA signals."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Any, Optional, cast

from ...config import settings
from ..features import (
    SignalFeatures,
    extract_signal_features,
)
from ..models import SignalEnvelope


from .shared_context import (
    DecisionRuntimeTelemetry,
)
from .decision_engine_runtime_methods import (
    DecisionEngine,
)
from .positions_for_strategy_action import (
    position_qty_from_payload as _position_qty_from_payload,
)


def _count_open_short_positions(positions: Optional[list[dict[str, Any]]]) -> int:
    if not positions:
        return 0
    open_symbols: set[str] = set()
    for position in positions:
        symbol = str(position.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        qty = _position_qty_from_payload(position)
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


def _int_param(value: Any) -> int:
    if value is None:
        return 0
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _bool_param(value: Any) -> bool | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "f", "no", "n", "off"}:
        return False
    return None


def _resolve_signal_timeframe(signal: SignalEnvelope) -> Optional[str]:
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


def _runtime_enabled() -> bool:
    mode = settings.trading_strategy_runtime_mode
    if mode == "plugin_v3":
        return True
    if mode == "scheduler_v3":
        return settings.trading_strategy_scheduler_enabled
    return False


__all__ = [
    "DecisionEngine",
    "DecisionRuntimeTelemetry",
    "SignalFeatures",
    "extract_signal_features",
]


# Public aliases used by split-module consumers.
count_open_short_positions = _count_open_short_positions
resolve_signal_timeframe = _resolve_signal_timeframe
runtime_enabled = _runtime_enabled

__all__ = (
    "count_open_short_positions",
    "resolve_signal_timeframe",
    "runtime_enabled",
)
