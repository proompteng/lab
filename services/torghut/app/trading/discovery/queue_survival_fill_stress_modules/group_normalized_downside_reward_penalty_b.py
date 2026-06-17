# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Preview-only queue-survival fill stress for replay candidate ranking.

This module actualizes recent queue-position, fill-probability, and execution-delay
papers into deterministic replay harness inputs. It does not simulate broker
fills, write runtime ledgers, or carry promotion authority.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from math import isfinite, log1p
from typing import Any, cast

from app.trading.models import SignalEnvelope


from .shared_context import (
    ADD_TOKENS_split_export as _ADD_TOKENS,
    CANCEL_TOKENS_split_export as _CANCEL_TOKENS,
    EVENT_FIELDS_split_export as _EVENT_FIELDS,
    FILL_TOKENS_split_export as _FILL_TOKENS,
    PRICE_FIELDS_split_export as _PRICE_FIELDS,
    REJECT_TOKENS_split_export as _REJECT_TOKENS,
    SIDE_FIELDS_split_export as _SIDE_FIELDS,
    SPREAD_FIELDS_split_export as _SPREAD_FIELDS,
    STATUS_FIELDS_split_export as _STATUS_FIELDS,
)


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


# Public aliases used by split-module consumers.
event_label = _event_label
first_payload_value = _first_payload_value
float_or_none = _float_or_none
group_normalized_downside_reward_penalty_bps = (
    _group_normalized_downside_reward_penalty_bps
)
label_has_token = _label_has_token
median = _median
nonnegative_float = _nonnegative_float
positive_float = _positive_float
quantile = _quantile
queue_reactive_event_kind = _queue_reactive_event_kind
stable_float = _stable_float
stable_hash = _stable_hash
__all__ = (
    "event_label",
    "first_payload_value",
    "float_or_none",
    "group_normalized_downside_reward_penalty_bps",
    "label_has_token",
    "median",
    "nonnegative_float",
    "positive_float",
    "quantile",
    "queue_reactive_event_kind",
    "stable_float",
    "stable_hash",
)
