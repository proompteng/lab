# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Preview-only queue-survival fill stress for replay candidate ranking.

This module actualizes recent queue-position, fill-probability, and execution-delay
papers into deterministic replay harness inputs. It does not simulate broker
fills, write runtime ledgers, or carry promotion authority.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import exp, isfinite, log1p
from typing import Any, cast

from app.trading.models import SignalEnvelope

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_19 import *
from .part_02_extract_queue_survival_fill_stress import *


def _group_normalized_downside_reward_penalty_bps(
    *,
    rows: Sequence[SignalEnvelope],
    direction: float,
    fallback_spread_bps: float,
) -> float:
    """Downside-aware, group-normalized spread-scaled reward stress.

    arXiv:2605.25527 motivates order-flow state policies with group-normalized
    updates and downside-aware shaping. Torghut keeps this deterministic and
    proof-neutral by ranking replay rows with per-symbol post-cost downside
    dispersion only; it is not model PnL or live-capital authority.
    """

    returns_by_symbol: dict[str, list[float]] = {}
    rows_by_symbol: dict[str, list[SignalEnvelope]] = {}
    for row in rows:
        rows_by_symbol.setdefault(row.symbol, []).append(row)
    for symbol, symbol_rows in rows_by_symbol.items():
        ordered = sorted(symbol_rows, key=lambda item: (item.event_ts, item.seq))
        for current, following in zip(ordered, ordered[1:]):
            current_price = _positive_float(
                _first_payload_value(current.payload, _PRICE_FIELDS)
            )
            next_price = _positive_float(
                _first_payload_value(following.payload, _PRICE_FIELDS)
            )
            if current_price is None or next_price is None:
                continue
            spread_bps = _nonnegative_float(
                _first_payload_value(current.payload, _SPREAD_FIELDS)
            )
            if spread_bps <= 0.0:
                spread_bps = fallback_spread_bps
            signed_post_cost_return_bps = direction * (
                next_price - current_price
            ) / current_price * 10_000.0 - max(0.0, spread_bps)
            returns_by_symbol.setdefault(symbol, []).append(signed_post_cost_return_bps)
    group_penalties: list[float] = []
    for values in returns_by_symbol.values():
        if not values:
            continue
        mean_value = sum(values) / len(values)
        variance = sum((value - mean_value) ** 2 for value in values) / max(
            1, len(values)
        )
        std_dev = variance**0.5
        downside_bps = sum(max(0.0, -value) for value in values) / len(values)
        downside_z = (
            sum(max(0.0, (mean_value - value) / std_dev) for value in values)
            / len(values)
            if std_dev > 0.0
            else 0.0
        )
        group_penalties.append(
            downside_bps * 0.35 + downside_z * max(1.0, fallback_spread_bps) * 0.45
        )
    if not group_penalties:
        return 0.0
    return min(35.0, sum(group_penalties) / len(group_penalties))


def _event_label(payload: Mapping[str, Any]) -> str:
    event = _first_payload_value(payload, _EVENT_FIELDS)
    status = _first_payload_value(payload, _STATUS_FIELDS)
    side = _first_payload_value(payload, _SIDE_FIELDS)
    return " ".join(str(item).lower() for item in (event, status, side) if item)


def _label_has_token(label: str, tokens: frozenset[str]) -> bool:
    return any(token in label for token in tokens)


def _queue_reactive_event_kind(label: str) -> str:
    if _label_has_token(label, _FILL_TOKENS):
        return "trade"
    if _label_has_token(label, _CANCEL_TOKENS | _REJECT_TOKENS):
        return "cancel_or_reject"
    if _label_has_token(label, _ADD_TOKENS):
        return "add"
    return "other"


def _first_payload_value(
    payload: Mapping[str, Any], fields: Sequence[str]
) -> Any | None:
    for field in fields:
        value = payload.get(field)
        if value is not None:
            return value
    return None


def _positive_float(value: object) -> float | None:
    parsed = _float_or_none(value)
    if parsed is None or parsed <= 0.0:
        return None
    return parsed


def _nonnegative_float(value: object) -> float:
    parsed = _float_or_none(value)
    if parsed is None or parsed < 0.0:
        return 0.0
    return parsed


def _float_or_none(value: object) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(cast(Any, value))
    except (TypeError, ValueError):
        return None
    return parsed if isfinite(parsed) else None


def _median(values: Sequence[float]) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    midpoint = len(clean) // 2
    if len(clean) % 2:
        return clean[midpoint]
    return (clean[midpoint - 1] + clean[midpoint]) / 2.0


def _quantile(values: Sequence[float], quantile: float) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    clamped = min(1.0, max(0.0, quantile))
    index = round((len(clean) - 1) * clamped)
    return clean[index]


def _log1p(value: float) -> float:
    return 0.0 if value <= -1.0 else log1p(value)


def _stable_float(value: float) -> str:
    return f"{value:.10f}".rstrip("0").rstrip(".") or "0"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(
        cast(dict[str, Any], payload),
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


__all__ = [name for name in globals() if not name.startswith("__")]
