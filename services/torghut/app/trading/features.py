"""Shared feature extraction for trading signals."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional, cast

from .models import SignalEnvelope


@dataclass(frozen=True)
class SignalFeatures:
    macd: Optional[Decimal]
    macd_signal: Optional[Decimal]
    rsi: Optional[Decimal]
    price: Optional[Decimal]
    volatility: Optional[Decimal]


def extract_signal_features(signal: SignalEnvelope) -> SignalFeatures:
    payload = signal.payload or {}
    macd, macd_signal = extract_macd(payload)
    rsi = extract_rsi(payload)
    price = extract_price(payload)
    volatility = extract_volatility(payload)
    return SignalFeatures(macd=macd, macd_signal=macd_signal, rsi=rsi, price=price, volatility=volatility)


def extract_macd(payload: dict[str, Any]) -> tuple[Optional[Decimal], Optional[Decimal]]:
    macd_block = payload.get("macd")
    if isinstance(macd_block, dict):
        macd_dict = cast(dict[str, Any], macd_block)
        macd_val = macd_dict.get("macd")
        signal_val = macd_dict.get("signal")
    else:
        macd_val = payload.get("macd")
        signal_val = payload.get("macd_signal")
    return optional_decimal(macd_val), optional_decimal(signal_val)


def extract_rsi(payload: dict[str, Any]) -> Optional[Decimal]:
    return optional_decimal(payload.get("rsi14") or payload.get("rsi"))


def extract_price(payload: dict[str, Any]) -> Optional[Decimal]:
    for key in ("price", "close", "c", "last"):
        if key in payload:
            return optional_decimal(payload.get(key))
    return None


def extract_volatility(payload: dict[str, Any]) -> Optional[Decimal]:
    for key in ("volatility", "vol", "sigma"):
        if key in payload:
            return optional_decimal(payload.get(key))
    return None


def optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ValueError, TypeError, ArithmeticError):
        return None


__all__ = [
    "SignalFeatures",
    "extract_signal_features",
    "extract_macd",
    "extract_rsi",
    "extract_price",
    "extract_volatility",
    "optional_decimal",
]
