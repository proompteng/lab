"""Deterministic factor normalization utilities."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP


_THREE = Decimal("3")
_FOUR_DECIMALS = Decimal("0.0001")


def clamp(value: Decimal, lower: Decimal, upper: Decimal) -> Decimal:
    """Clamp a decimal to a bounded interval."""

    return max(lower, min(upper, value))


def quantize_bps(value: Decimal) -> Decimal:
    """Keep bps values stable in JSON and DB assertions."""

    return value.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


def bounded_score(value: Decimal, scale: Decimal) -> Decimal:
    """Scale a raw descriptor to a winsorized score."""

    if scale <= Decimal("0"):
        return Decimal("0")
    return clamp(value / scale, -_THREE, _THREE).quantize(
        _FOUR_DECIMALS, rounding=ROUND_HALF_UP
    )


def positive_quality_score(value: Decimal, floor: Decimal, scale: Decimal) -> Decimal:
    """Map quality descriptors where larger is better into a bounded score."""

    return bounded_score(value - floor, scale)


def negative_quality_score(value: Decimal, cap: Decimal, scale: Decimal) -> Decimal:
    """Map cost/risk descriptors where smaller is better into a bounded score."""

    return bounded_score(cap - value, scale)
