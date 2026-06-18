from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from decimal import Decimal
from typing import Any, cast

from ....config import settings
from ...models import SignalEnvelope, StrategyDecision
from ...prices import MarketSnapshot
from ...quote_quality import (
    QuoteQualityPolicy,
    QuoteQualityStatus,
    assess_signal_quote_quality,
)
from ..target_plan_helpers import (
    decimal_from_mapping,
    first_decimal,
    optional_decimal,
    parse_target_datetime,
    target_metadata_quote_snapshot,
    text_from_mapping,
)

from .shared import QuoteRouteabilityInputs, QuoteRouteabilityValues


def quote_routeability_inputs(
    decision: StrategyDecision,
    snapshot: MarketSnapshot | None,
) -> QuoteRouteabilityInputs:
    price_snapshot_raw = decision.params.get("price_snapshot")
    price_snapshot = (
        cast(Mapping[str, Any], price_snapshot_raw)
        if isinstance(price_snapshot_raw, Mapping)
        else cast(Mapping[str, Any], {})
    )
    target_quote_snapshot = target_metadata_quote_snapshot(
        decision.params,
        symbol=decision.symbol,
    )
    target_price_snapshot = target_quote_snapshot or cast(Mapping[str, Any], {})
    if not price_snapshot and target_quote_snapshot is not None:
        price_snapshot = target_quote_snapshot
    return QuoteRouteabilityInputs(
        price_snapshot=price_snapshot,
        target_price_snapshot=target_price_snapshot,
        target_quote_snapshot=target_quote_snapshot,
        snapshot=snapshot,
    )


def quote_routeability_values(
    decision: StrategyDecision,
    inputs: QuoteRouteabilityInputs,
) -> QuoteRouteabilityValues:
    bid = _routeability_bid(decision, inputs)
    ask = _routeability_ask(decision, inputs)
    spread = _routeability_spread(decision, inputs, bid=bid, ask=ask)
    using_target_quote = _uses_target_executable_quote(inputs)
    return QuoteRouteabilityValues(
        price=_routeability_price(decision, inputs),
        bid=bid,
        ask=ask,
        spread=spread,
        source=_routeability_source(inputs, using_target_quote=using_target_quote),
        quote_as_of=_routeability_quote_as_of(
            inputs,
            using_target_quote=using_target_quote,
        ),
        quote_lookup_diagnostics=(
            inputs.snapshot.quote_lookup_diagnostics
            if inputs.snapshot is not None
            else None
        ),
    )


def assess_paper_route_quote_status(
    decision: StrategyDecision,
    values: QuoteRouteabilityValues,
) -> QuoteQualityStatus:
    return assess_signal_quote_quality(
        signal=SignalEnvelope(
            event_ts=decision.event_ts,
            symbol=decision.symbol,
            payload={
                "price": values.price,
                "imbalance_bid_px": values.bid,
                "imbalance_ask_px": values.ask,
                "spread": values.spread,
                "price_snapshot": {
                    "source": values.source,
                    "quote_source": values.source,
                    "as_of": values.quote_as_of.isoformat()
                    if values.quote_as_of is not None
                    else None,
                    "quote_as_of": values.quote_as_of.isoformat()
                    if values.quote_as_of is not None
                    else None,
                    "price": str(values.price) if values.price is not None else None,
                    "bid": str(values.bid) if values.bid is not None else None,
                    "ask": str(values.ask) if values.ask is not None else None,
                    "spread": str(values.spread) if values.spread is not None else None,
                },
            },
            timeframe=decision.timeframe,
        ),
        previous_price=None,
        policy=QuoteQualityPolicy(
            max_executable_spread_bps=settings.trading_signal_max_executable_spread_bps,
            max_quote_mid_jump_bps=settings.trading_signal_max_quote_mid_jump_bps,
            max_jump_with_wide_spread_bps=settings.trading_signal_max_jump_with_wide_spread_bps,
            max_executable_quote_age_seconds=settings.trading_executable_quote_lookback_seconds,
        ),
    )


def _routeability_price(
    decision: StrategyDecision,
    inputs: QuoteRouteabilityInputs,
) -> Decimal | None:
    return first_decimal(
        inputs.snapshot.price if inputs.snapshot is not None else None,
        decimal_from_mapping(
            inputs.price_snapshot,
            ("price", "mid", "mid_price", "midpoint"),
        ),
        decimal_from_mapping(
            inputs.target_price_snapshot,
            ("price", "mid", "mid_price", "midpoint"),
        ),
        optional_decimal(decision.params.get("price")),
    )


def _routeability_bid(
    decision: StrategyDecision,
    inputs: QuoteRouteabilityInputs,
) -> Decimal | None:
    return first_decimal(
        inputs.snapshot.bid if inputs.snapshot is not None else None,
        decimal_from_mapping(
            inputs.price_snapshot,
            ("bid", "bid_px", "bid_price", "bp"),
        ),
        decimal_from_mapping(
            inputs.target_price_snapshot,
            ("bid", "bid_px", "bid_price", "bp"),
        ),
        optional_decimal(decision.params.get("imbalance_bid_px")),
    )


def _routeability_ask(
    decision: StrategyDecision,
    inputs: QuoteRouteabilityInputs,
) -> Decimal | None:
    return first_decimal(
        inputs.snapshot.ask if inputs.snapshot is not None else None,
        decimal_from_mapping(
            inputs.price_snapshot,
            ("ask", "ask_px", "ask_price", "ap"),
        ),
        decimal_from_mapping(
            inputs.target_price_snapshot,
            ("ask", "ask_px", "ask_price", "ap"),
        ),
        optional_decimal(decision.params.get("imbalance_ask_px")),
    )


def _routeability_spread(
    decision: StrategyDecision,
    inputs: QuoteRouteabilityInputs,
    *,
    bid: Decimal | None,
    ask: Decimal | None,
) -> Decimal | None:
    computed_spread = ask - bid if bid is not None and ask is not None else None
    return first_decimal(
        inputs.snapshot.spread if inputs.snapshot is not None else None,
        decimal_from_mapping(inputs.price_snapshot, ("spread", "imbalance_spread")),
        decimal_from_mapping(
            inputs.target_price_snapshot,
            ("spread", "imbalance_spread"),
        ),
        optional_decimal(decision.params.get("spread")),
        computed_spread,
    )


def _uses_target_executable_quote(inputs: QuoteRouteabilityInputs) -> bool:
    return (
        inputs.target_quote_snapshot is not None
        and (inputs.snapshot is None or inputs.snapshot.bid is None)
        and (inputs.snapshot is None or inputs.snapshot.ask is None)
        and decimal_from_mapping(
            inputs.price_snapshot,
            ("bid", "bid_px", "bid_price", "bp"),
        )
        is None
        and decimal_from_mapping(
            inputs.price_snapshot,
            ("ask", "ask_px", "ask_price", "ap"),
        )
        is None
        and decimal_from_mapping(
            inputs.target_price_snapshot,
            ("bid", "bid_px", "bid_price", "bp"),
        )
        is not None
        and decimal_from_mapping(
            inputs.target_price_snapshot,
            ("ask", "ask_px", "ask_price", "ap"),
        )
        is not None
    )


def _routeability_quote_as_of(
    inputs: QuoteRouteabilityInputs,
    *,
    using_target_quote: bool,
) -> datetime | None:
    target_quote_as_of = (
        parse_target_datetime(inputs.target_price_snapshot.get("quote_as_of"))
        or parse_target_datetime(inputs.target_price_snapshot.get("as_of"))
        or parse_target_datetime(inputs.target_price_snapshot.get("timestamp"))
    )
    price_snapshot_quote_as_of = (
        parse_target_datetime(inputs.price_snapshot.get("quote_as_of"))
        or parse_target_datetime(inputs.price_snapshot.get("as_of"))
        or parse_target_datetime(inputs.price_snapshot.get("timestamp"))
    )
    if using_target_quote and target_quote_as_of is not None:
        return target_quote_as_of
    if inputs.snapshot is not None and inputs.snapshot.quote_as_of is not None:
        return inputs.snapshot.quote_as_of
    return price_snapshot_quote_as_of or target_quote_as_of


def _routeability_source(
    inputs: QuoteRouteabilityInputs,
    *,
    using_target_quote: bool,
) -> str | None:
    target_source = text_from_mapping(
        inputs.target_price_snapshot,
        ("quote_source", "source", "feed"),
    )
    price_snapshot_source = text_from_mapping(
        inputs.price_snapshot,
        ("quote_source", "source", "feed"),
    )
    if using_target_quote and target_source is not None:
        return target_source
    snapshot_source = inputs.snapshot.source if inputs.snapshot is not None else ""
    snapshot_quote_source = (
        inputs.snapshot.quote_source
        if inputs.snapshot is not None and inputs.snapshot.quote_source is not None
        else None
    )
    return (
        str(
            snapshot_quote_source
            or price_snapshot_source
            or target_source
            or snapshot_source
            or ""
        ).strip()
        or None
    )
