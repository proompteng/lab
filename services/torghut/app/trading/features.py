"""Shared feature extraction for trading signals."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional, cast

from .models import SignalEnvelope

FEATURE_SCHEMA_VERSION_V3 = "3.0.0"


@dataclass(frozen=True)
class SignalFeatures:
    macd: Optional[Decimal]
    macd_signal: Optional[Decimal]
    rsi: Optional[Decimal]
    price: Optional[Decimal]
    volatility: Optional[Decimal]


@dataclass(frozen=True)
class FeatureVectorV3:
    event_ts: datetime
    symbol: str
    timeframe: str
    seq: int
    source: str
    feature_schema_version: str
    values: dict[str, Any]
    normalization_hash: str


class FeatureNormalizationError(ValueError):
    """Raised when signal payload cannot satisfy the v3 feature contract."""


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


def normalize_feature_vector_v3(signal: SignalEnvelope) -> FeatureVectorV3:
    payload = signal.payload or {}
    macd, macd_signal = extract_macd(payload)
    price = extract_price(payload)
    rsi14 = extract_rsi(payload)
    timeframe = signal.timeframe or "1Min"

    values = {
        "price": price,
        "ema12": optional_decimal(payload.get("ema12")),
        "ema26": optional_decimal(payload.get("ema26")),
        "macd": macd,
        "macd_signal": macd_signal,
        "macd_hist": optional_decimal(payload.get("macd_hist")),
        "vwap_session": optional_decimal(payload.get("vwap_session")),
        "vwap_w5m": optional_decimal(payload.get("vwap_w5m")),
        "rsi14": rsi14,
        "boll_mid": optional_decimal(payload.get("boll_mid")),
        "boll_upper": optional_decimal(payload.get("boll_upper")),
        "boll_lower": optional_decimal(payload.get("boll_lower")),
        "vol_realized_w60s": optional_decimal(payload.get("vol_realized_w60s") or payload.get("volatility")),
        "imbalance_spread": optional_decimal(payload.get("imbalance_spread")),
        "spread": optional_decimal(payload.get("spread")),
        "signal_quality_flag": payload.get("signal_quality_flag"),
        "staleness_ms": _staleness_ms(signal.event_ts, signal.ingest_ts),
    }

    required = ("price", "macd", "macd_signal", "rsi14")
    missing = [name for name in required if values.get(name) is None]
    if missing:
        raise FeatureNormalizationError(f"missing_required_features:{'|'.join(sorted(missing))}")

    normalized_payload = {
        "event_ts": signal.event_ts.isoformat(),
        "symbol": signal.symbol,
        "timeframe": timeframe,
        "seq": signal.seq or 0,
        "source": signal.source or "unknown",
        "feature_schema_version": FEATURE_SCHEMA_VERSION_V3,
        "values": {key: _jsonable(values[key]) for key in sorted(values)},
    }
    normalization_hash = hashlib.sha256(
        json.dumps(normalized_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    return FeatureVectorV3(
        event_ts=signal.event_ts,
        symbol=signal.symbol,
        timeframe=timeframe,
        seq=signal.seq or 0,
        source=signal.source or "unknown",
        feature_schema_version=FEATURE_SCHEMA_VERSION_V3,
        values=values,
        normalization_hash=normalization_hash,
    )


def optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ValueError, TypeError, ArithmeticError):
        return None


def _staleness_ms(event_ts: datetime, ingest_ts: datetime | None) -> int:
    # Use event/ingest timestamps only so replayed inputs remain deterministic.
    reference = ingest_ts.astimezone(timezone.utc) if ingest_ts is not None else event_ts.astimezone(timezone.utc)
    delta = reference - event_ts.astimezone(timezone.utc)
    return max(0, int(delta.total_seconds() * 1000))


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    return value


__all__ = [
    "FEATURE_SCHEMA_VERSION_V3",
    "FeatureNormalizationError",
    "FeatureVectorV3",
    "SignalFeatures",
    "extract_signal_features",
    "extract_macd",
    "extract_rsi",
    "extract_price",
    "extract_volatility",
    "normalize_feature_vector_v3",
    "optional_decimal",
]
