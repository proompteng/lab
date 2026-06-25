from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any, cast

from app.trading.paper_route_target_plan import mapping_items as shared_mapping_items
from app.trading.paper_route_target_plan import (
    paper_route_target_plan_from_payload as shared_paper_route_target_plan_from_payload,
)

from ...config import settings

_PROMOTION_KEYS = (
    "promotion_allowed",
    "final_promotion_allowed",
    "final_promotion_authorized",
)


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _append_symbol(symbols: list[str], raw_symbol: object) -> None:
    symbol = str(raw_symbol or "").strip().upper()
    if symbol and symbol not in symbols:
        symbols.append(symbol)


def _symbols_from_target(target: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for field in (
        "paper_route_probe_symbols",
        "paper_route_probe_raw_target_symbols",
        "symbols",
        "target_symbols",
    ):
        raw_symbols = target.get(field)
        if isinstance(raw_symbols, str):
            values: Sequence[object] = raw_symbols.split(",")
        elif isinstance(raw_symbols, Sequence) and not isinstance(
            raw_symbols,
            (str, bytes, bytearray),
        ):
            values = cast(Sequence[object], raw_symbols)
        else:
            values = ()
        for raw_symbol in values:
            _append_symbol(symbols, raw_symbol)
    for field in (
        "paper_route_probe_symbol_actions",
        "paper_route_probe_symbol_quantities",
        "symbol_actions",
        "target_symbol_actions",
        "target_symbol_quantities",
    ):
        raw_mapping = target.get(field)
        if not isinstance(raw_mapping, Mapping):
            continue
        for raw_symbol in cast(Mapping[object, object], raw_mapping):
            _append_symbol(symbols, raw_symbol)
    return symbols


def bounded_paper_route_probe_target_symbols(
    live_submission_gate: Mapping[str, Any],
) -> list[str]:
    plan = shared_paper_route_target_plan_from_payload(live_submission_gate)
    targets = [
        cast(Mapping[str, Any], target)
        for target in shared_mapping_items(plan.get("targets"))
    ]
    if not targets:
        return []

    if any(_truthy(plan.get(key)) for key in _PROMOTION_KEYS):
        return []

    authorized_targets: list[Mapping[str, Any]] = []
    for target in targets:
        if any(_truthy(target.get(key)) for key in _PROMOTION_KEYS):
            return []
        if _truthy(target.get("bounded_live_paper_collection_authorized")) or _truthy(
            target.get("source_collection_authorized")
        ):
            authorized_targets.append(target)
    if not authorized_targets:
        return []

    symbols: list[str] = []
    for target in authorized_targets:
        for symbol in _symbols_from_target(target):
            _append_symbol(symbols, symbol)
    if symbols:
        return symbols

    for raw_symbol in settings.trading_static_symbols:
        _append_symbol(symbols, raw_symbol)
    return symbols


__all__ = ["bounded_paper_route_probe_target_symbols"]
