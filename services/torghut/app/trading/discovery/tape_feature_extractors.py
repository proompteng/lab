"""Shared microstructure feature extractors for replay tape research."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np

from app.trading.models import SignalEnvelope


def extract_price(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    for key in ("price", "mid_price", "mid", "mark", "last_price", "close"):
        value = float_or_none(payload.get(key))
        if value is not None and value > 0.0:
            return value
    bid = float_or_none(payload.get("bid"))
    ask = float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        return (bid + ask) / 2.0
    return None


def extract_spread_bps(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    explicit = float_or_none(payload.get("spread_bps"))
    if explicit is not None:
        return max(0.0, explicit)
    bid = float_or_none(payload.get("bid"))
    ask = float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask >= bid:
        return (ask - bid) / ((ask + bid) / 2.0) * 10_000.0
    spread = float_or_none(payload.get("spread"))
    price = extract_price(signal)
    if spread is not None and price is not None and price > 0.0:
        return max(0.0, spread / price * 10_000.0)
    return None


def extract_ofi_pressure(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    for key in (
        "ofi_pressure_score",
        "order_flow_imbalance",
        "ofi",
        "signed_order_flow_imbalance",
        "queue_imbalance",
        "book_imbalance",
        "depth_imbalance",
    ):
        value = float_or_none(payload.get(key))
        if value is None:
            continue
        if -1.0 <= value <= 1.0:
            return value
        return float(np.tanh(value / 100.0))
    return extract_quote_depth_imbalance(signal)


def extract_quote_depth_imbalance(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    bid_size = first_float(
        payload,
        (
            "bid_size",
            "bid_qty",
            "best_bid_size",
            "best_bid_qty",
            "bid_depth",
            "bid_volume",
        ),
    )
    ask_size = first_float(
        payload,
        (
            "ask_size",
            "ask_qty",
            "best_ask_size",
            "best_ask_qty",
            "ask_depth",
            "ask_volume",
        ),
    )
    if (
        bid_size is None
        or ask_size is None
        or bid_size < 0.0
        or ask_size < 0.0
        or bid_size + ask_size <= 0.0
    ):
        return None
    return float(np.clip((bid_size - ask_size) / (bid_size + ask_size), -1.0, 1.0))


def extract_microprice_bias_bps(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    bid = first_float(payload, ("bid", "best_bid", "bid_price", "best_bid_price"))
    ask = first_float(payload, ("ask", "best_ask", "ask_price", "best_ask_price"))
    explicit_microprice = first_float(payload, ("microprice", "micro_price"))
    price = extract_price(signal)
    if explicit_microprice is not None and price is not None and price > 0.0:
        return (explicit_microprice - price) / price * 10_000.0

    bid_size = first_float(
        payload, ("bid_size", "bid_qty", "best_bid_size", "best_bid_qty")
    )
    ask_size = first_float(
        payload, ("ask_size", "ask_qty", "best_ask_size", "best_ask_qty")
    )
    if (
        bid is None
        or ask is None
        or bid <= 0.0
        or ask <= 0.0
        or ask < bid
        or bid_size is None
        or ask_size is None
        or bid_size < 0.0
        or ask_size < 0.0
        or bid_size + ask_size <= 0.0
    ):
        return None
    mid = (bid + ask) / 2.0
    microprice = (ask * bid_size + bid * ask_size) / (bid_size + ask_size)
    return (microprice - mid) / mid * 10_000.0


def extract_volume(signal: SignalEnvelope) -> float | None:
    return first_float(
        signal.payload,
        (
            "microbar_volume",
            "bar_volume",
            "trade_volume",
            "volume",
            "qty",
            "size",
        ),
        positive=True,
    )


def first_float(
    payload: Mapping[str, Any], keys: Sequence[str], *, positive: bool = False
) -> float | None:
    for key in keys:
        value = float_or_none(payload.get(key))
        if value is None:
            continue
        if positive and value <= 0.0:
            continue
        return value
    return None


def float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(parsed):
        return None
    return parsed


__all__ = [
    "extract_microprice_bias_bps",
    "extract_ofi_pressure",
    "extract_price",
    "extract_quote_depth_imbalance",
    "extract_spread_bps",
    "extract_volume",
    "first_float",
    "float_or_none",
]
