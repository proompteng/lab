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
    fillability_state: str = 'blocked'
    repair_action: str | None = None
    evidence_requirements: tuple[str, ...] = ()

    def to_readback(self) -> dict[str, object]:
        """Return source-backed quote/fillability diagnostics for readiness output."""

        return {
            'valid': self.valid,
            'reason': self.reason,
            'fillability_state': self.fillability_state,
            'repair_action': self.repair_action,
            'evidence_requirements': list(self.evidence_requirements),
            'spread_bps': str(self.spread_bps) if self.spread_bps is not None else None,
            'jump_bps': str(self.jump_bps) if self.jump_bps is not None else None,
            'quote_age_seconds': str(self.quote_age_seconds)
            if self.quote_age_seconds is not None
            else None,
            'source': self.source,
            'price': str(self.price) if self.price is not None else None,
            'bid': str(self.bid) if self.bid is not None else None,
            'ask': str(self.ask) if self.ask is not None else None,
        }


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
        return _status(
            valid=False,
            reason='non_positive_price',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if bid is None and ask is None:
        return _status(
            valid=False,
            reason='missing_executable_quote',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if bid is None:
        return _status(
            valid=False,
            reason='missing_bid',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if ask is None:
        return _status(
            valid=False,
            reason='missing_ask',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if bid <= 0:
        return _status(
            valid=False,
            reason='non_positive_bid',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if ask <= 0:
        return _status(
            valid=False,
            reason='non_positive_ask',
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
        )
    if ask < bid:
        return _status(
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
        return _status(
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
        return _status(
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
        return _status(
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
    return _status(
        valid=True,
        spread_bps=spread_bps,
        jump_bps=jump_bps,
        quote_age_seconds=quote_age_seconds,
        source=source,
        price=price,
        bid=bid,
        ask=ask,
    )


_QUOTE_CONTAINER_KEYS = (
    'price_snapshot',
    'executable_quote',
    'quote',
    'nbbo',
    'market_snapshot',
)
_QUOTE_DECIMAL_KEYS: Mapping[str, tuple[str, ...]] = {
    'price': ('price', 'mid', 'mid_price', 'midpoint'),
    'bid': ('bid', 'bid_px', 'bid_price', 'bp'),
    'ask': ('ask', 'ask_px', 'ask_price', 'ap'),
    'spread': ('spread', 'imbalance_spread'),
}
_REPAIR_ACTIONS: Mapping[str, str] = {
    'non_positive_price': 'collect_positive_executable_reference_price',
    'missing_executable_quote': 'collect_bid_ask_quote_before_routeability_claim',
    'missing_bid': 'collect_bid_quote_before_routeability_claim',
    'missing_ask': 'collect_ask_quote_before_routeability_claim',
    'non_positive_bid': 'refresh_bid_quote_before_routeability_claim',
    'non_positive_ask': 'refresh_ask_quote_before_routeability_claim',
    'crossed_quote': 'refresh_uncrossed_executable_quote_before_routeability_claim',
    'stale_quote': 'refresh_quote_snapshot_and_recompute_route_fillability',
    'spread_bps_exceeded': 'wait_for_tighter_executable_quote_before_routeability_claim',
    'wide_spread_midpoint_jump': 'collect_fresh_tight_quote_and_recheck_midpoint_jump',
}
_EVIDENCE_REQUIREMENTS: Mapping[str, tuple[str, ...]] = {
    'non_positive_price': ('positive_executable_price',),
    'missing_executable_quote': ('bid_px', 'ask_px', 'quote_source', 'quote_as_of'),
    'missing_bid': ('bid_px', 'quote_source', 'quote_as_of'),
    'missing_ask': ('ask_px', 'quote_source', 'quote_as_of'),
    'non_positive_bid': ('positive_bid_px', 'quote_source', 'quote_as_of'),
    'non_positive_ask': ('positive_ask_px', 'quote_source', 'quote_as_of'),
    'crossed_quote': ('uncrossed_bid_ask_quote', 'quote_source', 'quote_as_of'),
    'stale_quote': ('fresh_quote_as_of', 'quote_source'),
    'spread_bps_exceeded': ('tight_executable_spread_bps', 'bid_px', 'ask_px'),
    'wide_spread_midpoint_jump': (
        'fresh_reference_midpoint',
        'tight_executable_spread_bps',
    ),
}


def _status(
    *,
    valid: bool,
    reason: str | None = None,
    spread_bps: Decimal | None = None,
    jump_bps: Decimal | None = None,
    quote_age_seconds: Decimal | None = None,
    source: str | None = None,
    price: Decimal | None = None,
    bid: Decimal | None = None,
    ask: Decimal | None = None,
) -> QuoteQualityStatus:
    if valid:
        return QuoteQualityStatus(
            valid=True,
            reason=None,
            spread_bps=spread_bps,
            jump_bps=jump_bps,
            quote_age_seconds=quote_age_seconds,
            source=source,
            price=price,
            bid=bid,
            ask=ask,
            fillability_state='executable_quote_ready',
            repair_action=None,
            evidence_requirements=(),
        )
    normalized_reason = reason or 'unknown_quote_quality_blocker'
    return QuoteQualityStatus(
        valid=False,
        reason=normalized_reason,
        spread_bps=spread_bps,
        jump_bps=jump_bps,
        quote_age_seconds=quote_age_seconds,
        source=source,
        price=price,
        bid=bid,
        ask=ask,
        fillability_state='blocked',
        repair_action=_REPAIR_ACTIONS.get(
            normalized_reason, 'collect_source_backed_quote_repair_receipt'
        ),
        evidence_requirements=_EVIDENCE_REQUIREMENTS.get(
            normalized_reason,
            ('source_backed_quote_fillability_receipt',),
        ),
    )


def _extract_price(signal: SignalEnvelope) -> Decimal | None:
    direct_price = extract_executable_price(signal.payload)
    if direct_price is not None:
        return direct_price
    snapshot_price = _extract_quote_container_decimal(signal, 'price')
    if snapshot_price is not None:
        return snapshot_price
    bid = _extract_bid(signal)
    ask = _extract_ask(signal)
    if bid is None or ask is None:
        return None
    return (bid + ask) / 2


def _extract_bid(signal: SignalEnvelope) -> Decimal | None:
    bid = optional_decimal(
        payload_value(
            signal.payload,
            'imbalance_bid_px',
            block='imbalance',
            nested_key='bid_px',
        )
    )
    if bid is not None:
        return bid
    bid = optional_decimal(signal.payload.get('bid'))
    if bid is not None:
        return bid
    bid = optional_decimal(signal.payload.get('bid_px'))
    if bid is not None:
        return bid
    return _extract_quote_container_decimal(signal, 'bid')


def _extract_ask(signal: SignalEnvelope) -> Decimal | None:
    ask = optional_decimal(
        payload_value(
            signal.payload,
            'imbalance_ask_px',
            block='imbalance',
            nested_key='ask_px',
        )
    )
    if ask is not None:
        return ask
    ask = optional_decimal(signal.payload.get('ask'))
    if ask is not None:
        return ask
    ask = optional_decimal(signal.payload.get('ask_px'))
    if ask is not None:
        return ask
    return _extract_quote_container_decimal(signal, 'ask')


def _extract_quote_container_decimal(
    signal: SignalEnvelope,
    field: str,
) -> Decimal | None:
    keys = _QUOTE_DECIMAL_KEYS[field]
    for container_key in _QUOTE_CONTAINER_KEYS:
        container = signal.payload.get(container_key)
        if not isinstance(container, Mapping):
            continue
        typed_container = cast(Mapping[str, Any], container)
        for key in keys:
            value = optional_decimal(typed_container.get(key))
            if value is not None:
                return value
    return None


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
    spread = _optional_decimal(
        payload_value(
            signal.payload,
            'imbalance_spread',
            block='imbalance',
            nested_key='spread',
        )
    )
    if spread is not None:
        return spread
    return _extract_quote_container_decimal(signal, 'spread')


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
    for typed_snapshot in _quote_containers(signal):
        for key in ('quote_as_of', 'as_of', 'timestamp', 't'):
            parsed = _parse_datetime(typed_snapshot.get(key))
            if parsed is not None:
                return parsed
    for key in ('quote_as_of', 'executable_quote_as_of'):
        parsed = _parse_datetime(signal.payload.get(key))
        if parsed is not None:
            return parsed
    return None


def _extract_quote_source(signal: SignalEnvelope) -> str | None:
    for typed_snapshot in _quote_containers(signal):
        for key in ('quote_source', 'source', 'feed'):
            source = _optional_text(typed_snapshot.get(key))
            if source is not None:
                return source
    for key in ('quote_source', 'source'):
        source = _optional_text(signal.payload.get(key))
        if source is not None:
            return source
    return None


def _quote_containers(signal: SignalEnvelope) -> tuple[Mapping[str, Any], ...]:
    containers: list[Mapping[str, Any]] = []
    for container_key in _QUOTE_CONTAINER_KEYS:
        container = signal.payload.get(container_key)
        if isinstance(container, Mapping):
            containers.append(cast(Mapping[str, Any], container))
    return tuple(containers)


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
