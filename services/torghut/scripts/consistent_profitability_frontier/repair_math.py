"""Numeric repair helpers for consistent profitability frontier candidates."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_DOWN
from typing import Any, Mapping

_LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE = Decimal("0.75")
_LOSS_REPAIR_CAPITAL_SAFETY_BUFFER = Decimal("0.95")
_LOSS_REPAIR_MIN_SCALE_QUANTUM = Decimal("0.000001")


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        value = Decimal(text)
    except (InvalidOperation, ValueError):
        return None
    if not value.is_finite():
        return None
    return value


def _decimal_payload(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _tightened_bps(value: Any, *, floor: Decimal) -> str | None:
    current = _decimal_or_none(value)
    if current is None or current <= 0:
        return None
    tightened = max(floor, (current * Decimal("0.75")).quantize(Decimal("0.01")))
    if tightened >= current:
        return None
    return _decimal_payload(tightened)


def _reduced_exposure(
    value: Any,
    *,
    scale: Decimal = _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE,
) -> str | None:
    current = _decimal_or_none(value)
    if current is None or current <= 0:
        return None
    if scale <= 0 or scale >= 1:
        return None
    reduced = (current * scale).quantize(
        _LOSS_REPAIR_MIN_SCALE_QUANTUM, rounding=ROUND_DOWN
    )
    if reduced <= 0 or reduced >= current:
        return None
    return _decimal_payload(reduced)


def _capital_repair_exposure_scale(
    full_window_summary: Mapping[str, Any],
    *,
    policy_required_max_gross_exposure_pct_equity: Decimal | None = None,
    policy_required_min_cash: Decimal | None = None,
) -> Decimal:
    scale = _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE
    max_gross = _decimal_or_none(
        full_window_summary.get("max_gross_exposure_pct_equity")
    )
    required_max_gross = _decimal_or_none(
        full_window_summary.get("max_gross_exposure_pct_equity_required")
        or full_window_summary.get("required_max_gross_exposure_pct_equity")
    )
    if required_max_gross is None or required_max_gross <= 0:
        required_max_gross = Decimal("1")
    if (
        policy_required_max_gross_exposure_pct_equity is not None
        and policy_required_max_gross_exposure_pct_equity > 0
    ):
        required_max_gross = min(
            required_max_gross, policy_required_max_gross_exposure_pct_equity
        )
    if max_gross is not None and max_gross > required_max_gross:
        gross_scale = (
            required_max_gross / max_gross * _LOSS_REPAIR_CAPITAL_SAFETY_BUFFER
        ).quantize(_LOSS_REPAIR_MIN_SCALE_QUANTUM, rounding=ROUND_DOWN)
        scale = min(scale, max(_LOSS_REPAIR_MIN_SCALE_QUANTUM, gross_scale))

    min_cash = _decimal_or_none(full_window_summary.get("min_cash"))
    required_min_cash = _decimal_or_none(
        full_window_summary.get("min_cash_required")
        or full_window_summary.get("required_min_cash")
    )
    if required_min_cash is None:
        required_min_cash = Decimal("0")
    if policy_required_min_cash is not None:
        required_min_cash = max(required_min_cash, policy_required_min_cash)
    if min_cash is not None and min_cash < required_min_cash:
        scale = min(scale, Decimal("0.5"))
    return max(_LOSS_REPAIR_MIN_SCALE_QUANTUM, scale)


__all__ = [
    "_LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE",
    "_LOSS_REPAIR_CAPITAL_SAFETY_BUFFER",
    "_LOSS_REPAIR_MIN_SCALE_QUANTUM",
    "_decimal_or_none",
    "_decimal_payload",
    "_tightened_bps",
    "_reduced_exposure",
    "_capital_repair_exposure_scale",
]
