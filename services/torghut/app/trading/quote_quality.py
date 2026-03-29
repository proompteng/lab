"""Executable quote-quality validation shared by live and replay paths."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, cast

from .features import extract_executable_price, optional_decimal
from .models import SignalEnvelope

DEFAULT_MAX_EXECUTABLE_SPREAD_BPS = Decimal('50')
DEFAULT_MAX_QUOTE_MID_JUMP_BPS = Decimal('150')
DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS = Decimal('25')


@dataclass(frozen=True)
class QuoteQualityPolicy:
    max_executable_spread_bps: Decimal = DEFAULT_MAX_EXECUTABLE_SPREAD_BPS
    max_quote_mid_jump_bps: Decimal = DEFAULT_MAX_QUOTE_MID_JUMP_BPS
    max_jump_with_wide_spread_bps: Decimal = DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS


@dataclass(frozen=True)
class QuoteQualityStatus:
    valid: bool
    reason: str | None = None
    spread_bps: Decimal | None = None
    jump_bps: Decimal | None = None


class SignalQuoteQualityTracker:
    """Track last executable prices and reject non-executable quote states."""

    def __init__(self, *, policy: QuoteQualityPolicy | None = None) -> None:
        self.policy = policy or QuoteQualityPolicy()
        self._last_valid_price_by_symbol: dict[str, Decimal] = {}

    def assess(self, signal: SignalEnvelope) -> QuoteQualityStatus:
        symbol = signal.symbol.strip().upper()
        previous_price = self._last_valid_price_by_symbol.get(symbol)
        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=previous_price,
            policy=self.policy,
        )
        if status.valid:
            price = _extract_price(signal)
            if price is not None and price > 0:
                self._last_valid_price_by_symbol[symbol] = price
        return status


def assess_signal_quote_quality(
    *,
    signal: SignalEnvelope,
    previous_price: Decimal | None,
    policy: QuoteQualityPolicy | None = None,
) -> QuoteQualityStatus:
    effective_policy = policy or QuoteQualityPolicy()
    price = _extract_price(signal)
    bid = _extract_bid(signal)
    ask = _extract_ask(signal)
    if price is None or price <= 0:
        return QuoteQualityStatus(valid=False, reason='non_positive_price')
    if bid is not None and bid <= 0:
        return QuoteQualityStatus(valid=False, reason='non_positive_bid')
    if ask is not None and ask <= 0:
        return QuoteQualityStatus(valid=False, reason='non_positive_ask')
    if bid is not None and ask is not None and ask < bid:
        return QuoteQualityStatus(valid=False, reason='crossed_quote')

    spread_bps = _signal_spread_bps(signal=signal, price=price)
    if (
        spread_bps is not None
        and spread_bps > effective_policy.max_executable_spread_bps
    ):
        return QuoteQualityStatus(
            valid=False,
            reason='spread_bps_exceeded',
            spread_bps=spread_bps,
        )

    jump_bps = _signal_mid_jump_bps(price=price, reference_price=previous_price)
    if (
        jump_bps is not None
        and jump_bps > effective_policy.max_quote_mid_jump_bps
        and spread_bps is not None
        and spread_bps > effective_policy.max_jump_with_wide_spread_bps
    ):
        return QuoteQualityStatus(
            valid=False,
            reason='wide_spread_midpoint_jump',
            spread_bps=spread_bps,
            jump_bps=jump_bps,
        )
    return QuoteQualityStatus(valid=True, spread_bps=spread_bps, jump_bps=jump_bps)


def _extract_price(signal: SignalEnvelope) -> Decimal | None:
    return extract_executable_price(signal.payload)


def _extract_bid(signal: SignalEnvelope) -> Decimal | None:
    return optional_decimal(
        _payload_value(signal.payload, 'imbalance_bid_px', 'imbalance', 'bid_px')
    )


def _extract_ask(signal: SignalEnvelope) -> Decimal | None:
    return optional_decimal(
        _payload_value(signal.payload, 'imbalance_ask_px', 'imbalance', 'ask_px')
    )


def _signal_spread_bps(
    *,
    signal: SignalEnvelope,
    price: Decimal | None,
) -> Decimal | None:
    if price is None or price <= 0:
        return None
    spread = _optional_decimal(signal.payload.get('spread'))
    if spread is None:
        spread = _optional_decimal(
            _payload_value(
                signal.payload,
                'imbalance_spread',
                'imbalance',
                'spread',
            )
        )
    if spread is None:
        bid = _extract_bid(signal)
        ask = _extract_ask(signal)
        if bid is not None and ask is not None:
            spread = ask - bid
    if spread is None:
        return None
    return (abs(spread) / price) * Decimal('10000')


def _signal_mid_jump_bps(
    *,
    price: Decimal | None,
    reference_price: Decimal | None,
) -> Decimal | None:
    if price is None or price <= 0 or reference_price is None or reference_price <= 0:
        return None
    return (abs(price - reference_price) / reference_price) * Decimal('10000')


def _optional_decimal(value: Any) -> Decimal | None:
    return optional_decimal(value)


def _nested(payload: dict[str, Any], block: str, key: str) -> Any:
    item = payload.get(block)
    if isinstance(item, dict):
        return cast(Mapping[str, Any], item).get(key)
    return None


def _payload_value(
    payload: dict[str, Any],
    key: str,
    block: str,
    nested_key: str,
) -> Any:
    direct_value = payload.get(key)
    if direct_value is not None:
        return direct_value
    return _nested(payload, block, nested_key)


__all__ = [
    'DEFAULT_MAX_EXECUTABLE_SPREAD_BPS',
    'DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS',
    'DEFAULT_MAX_QUOTE_MID_JUMP_BPS',
    'QuoteQualityPolicy',
    'QuoteQualityStatus',
    'SignalQuoteQualityTracker',
    'assess_signal_quote_quality',
]
