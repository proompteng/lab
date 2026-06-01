"""Executable quote-quality validation shared by live and replay paths."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from .features import extract_executable_price, optional_decimal, payload_value
from .models import SignalEnvelope

DEFAULT_MAX_EXECUTABLE_SPREAD_BPS = Decimal('50')
DEFAULT_MAX_QUOTE_MID_JUMP_BPS = Decimal('150')
DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS = Decimal('25')


@dataclass(frozen=True)
class QuoteQualityPolicy:
    max_executable_spread_bps: Decimal = DEFAULT_MAX_EXECUTABLE_SPREAD_BPS
    max_quote_mid_jump_bps: Decimal = DEFAULT_MAX_QUOTE_MID_JUMP_BPS
    max_jump_with_wide_spread_bps: Decimal = DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS
    max_executable_quote_age_seconds: int | None = None


@dataclass(frozen=True)
class QuoteQualityStatus:
    valid: bool
    reason: str | None = None
    spread_bps: Decimal | None = None
    jump_bps: Decimal | None = None
    quote_age_seconds: Decimal | None = None
    source: str | None = None
    price: Decimal | None = None
    bid: Decimal | None = None
    ask: Decimal | None = None


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
    source = _extract_quote_source(signal)
    quote_age_seconds = _signal_quote_age_seconds(signal)
    if price is None or price <= 0:
        return QuoteQualityStatus(
            valid=False,
            reason='non_positive_price',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if bid is None and ask is None:
        return QuoteQualityStatus(
            valid=False,
            reason='missing_executable_quote',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if bid is None:
        return QuoteQualityStatus(
            valid=False,
            reason='missing_bid',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if ask is None:
        return QuoteQualityStatus(
            valid=False,
            reason='missing_ask',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if bid <= 0:
        return QuoteQualityStatus(
            valid=False,
            reason='non_positive_bid',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if ask <= 0:
        return QuoteQualityStatus(
            valid=False,
            reason='non_positive_ask',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if ask < bid:
        return QuoteQualityStatus(
            valid=False,
            reason='crossed_quote',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )

    spread_bps = _signal_spread_bps(signal=signal, price=price)
    if (
        quote_age_seconds is not None
        and effective_policy.max_executable_quote_age_seconds is not None
        and quote_age_seconds
        > Decimal(str(effective_policy.max_executable_quote_age_seconds))
    ):
        return QuoteQualityStatus(
            valid=False,
            reason='stale_quote',
            spread_bps=spread_bps,
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if (
        spread_bps is not None
        and spread_bps > effective_policy.max_executable_spread_bps
    ):
        return QuoteQualityStatus(
            valid=False,
            reason='spread_bps_exceeded',
            spread_bps=spread_bps,
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
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
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    return QuoteQualityStatus(
        valid=True,
        spread_bps=spread_bps,
        jump_bps=jump_bps,
        quote_age_seconds=quote_age_seconds,
        source=source,
        price=price,
        bid=bid,
        ask=ask,
    )


def _extract_price(signal: SignalEnvelope) -> Decimal | None:
    return extract_executable_price(signal.payload)


def _extract_bid(signal: SignalEnvelope) -> Decimal | None:
    return optional_decimal(
        payload_value(
            signal.payload,
            'imbalance_bid_px',
            block='imbalance',
            nested_key='bid_px',
        )
    )


def _extract_ask(signal: SignalEnvelope) -> Decimal | None:
    return optional_decimal(
        payload_value(
            signal.payload,
            'imbalance_ask_px',
            block='imbalance',
            nested_key='ask_px',
        )
    )


def _signal_spread_bps(
    *,
    signal: SignalEnvelope,
    price: Decimal | None,
) -> Decimal | None:
    if price is None or price <= 0:
        return None
    spread = _extract_explicit_spread(signal)
    if spread is None:
        bid = _extract_bid(signal)
        ask = _extract_ask(signal)
        if bid is not None and ask is not None:
            spread = ask - bid
    if spread is None:
        return None
    return (abs(spread) / price) * Decimal('10000')


def _extract_explicit_spread(signal: SignalEnvelope) -> Decimal | None:
    spread = _optional_decimal(signal.payload.get('spread'))
    if spread is not None:
        return spread
    return _optional_decimal(
        payload_value(
            signal.payload,
            'imbalance_spread',
            block='imbalance',
            nested_key='spread',
        )
    )


def _signal_mid_jump_bps(
    *,
    price: Decimal | None,
    reference_price: Decimal | None,
) -> Decimal | None:
    if price is None or price <= 0 or reference_price is None or reference_price <= 0:
        return None
    return (abs(price - reference_price) / reference_price) * Decimal('10000')


def _signal_quote_age_seconds(signal: SignalEnvelope) -> Decimal | None:
    quote_ts = _extract_quote_timestamp(signal)
    if quote_ts is None:
        return None
    event_ts = signal.event_ts
    if event_ts.tzinfo is None:
        event_ts = event_ts.replace(tzinfo=timezone.utc)
    if quote_ts.tzinfo is None:
        quote_ts = quote_ts.replace(tzinfo=timezone.utc)
    age_seconds = (
        event_ts.astimezone(timezone.utc) - quote_ts.astimezone(timezone.utc)
    ).total_seconds()
    return Decimal(str(max(age_seconds, 0.0)))


def _extract_quote_timestamp(signal: SignalEnvelope) -> datetime | None:
    price_snapshot = signal.payload.get('price_snapshot')
    if isinstance(price_snapshot, Mapping):
        typed_snapshot = cast(Mapping[str, Any], price_snapshot)
        for key in ('quote_as_of', 'as_of'):
            parsed = _parse_datetime(typed_snapshot.get(key))
            if parsed is not None:
                return parsed
    for key in ('quote_as_of', 'executable_quote_as_of'):
        parsed = _parse_datetime(signal.payload.get(key))
        if parsed is not None:
            return parsed
    return None


def _extract_quote_source(signal: SignalEnvelope) -> str | None:
    price_snapshot = signal.payload.get('price_snapshot')
    if isinstance(price_snapshot, Mapping):
        typed_snapshot = cast(Mapping[str, Any], price_snapshot)
        for key in ('quote_source', 'source'):
            source = _optional_text(typed_snapshot.get(key))
            if source is not None:
                return source
    return _optional_text(signal.payload.get('quote_source'))


def _parse_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text.replace('Z', '+00:00'))
        except ValueError:
            return None
    return None


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_decimal(value: Any) -> Decimal | None:
    return optional_decimal(value)


__all__ = [
    'DEFAULT_MAX_EXECUTABLE_SPREAD_BPS',
    'DEFAULT_MAX_JUMP_WITH_WIDE_SPREAD_BPS',
    'DEFAULT_MAX_QUOTE_MID_JUMP_BPS',
    'QuoteQualityPolicy',
    'QuoteQualityStatus',
    'SignalQuoteQualityTracker',
    'assess_signal_quote_quality',
]
