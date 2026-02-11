"""Shared feature extraction for trading signals."""

from __future__ import annotations

import hashlib
import json
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


@dataclass(frozen=True)
class FeatureVectorV3:
    schema_version: str
    mapper_version: str
    normalization_version: str
    symbol: str
    timeframe: str
    event_ts: str
    macd: Optional[Decimal]
    macd_signal: Optional[Decimal]
    rsi: Optional[Decimal]
    price: Optional[Decimal]
    volatility: Optional[Decimal]
    source: str
    seq: Optional[int]

    def to_payload(self) -> dict[str, Any]:
        return {
            'schema_version': self.schema_version,
            'mapper_version': self.mapper_version,
            'normalization_version': self.normalization_version,
            'symbol': self.symbol,
            'timeframe': self.timeframe,
            'event_ts': self.event_ts,
            'macd': _decimal_to_string(self.macd),
            'macd_signal': _decimal_to_string(self.macd_signal),
            'rsi': _decimal_to_string(self.rsi),
            'price': _decimal_to_string(self.price),
            'volatility': _decimal_to_string(self.volatility),
            'source': self.source,
            'seq': self.seq,
        }

    def parity_hash(self) -> str:
        payload = json.dumps(self.to_payload(), sort_keys=True, separators=(',', ':'))
        return hashlib.sha256(payload.encode('utf-8')).hexdigest()


@dataclass(frozen=True)
class FeatureContractResult:
    vector: FeatureVectorV3
    parity_hash: str
    required_features: tuple[str, ...]
    missing_required_features: tuple[str, ...]
    valid: bool
    reasons: tuple[str, ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            'vector': self.vector.to_payload(),
            'parity_hash': self.parity_hash,
            'required_features': list(self.required_features),
            'missing_required_features': list(self.missing_required_features),
            'valid': self.valid,
            'reasons': list(self.reasons),
        }


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


def normalize_feature_vector_v3(
    signal: SignalEnvelope,
    *,
    schema_version: str = 'v3',
    mapper_version: str = 'v1',
    normalization_version: str = 'v1',
    required_features: tuple[str, ...] = ('macd', 'macd_signal', 'rsi'),
) -> FeatureContractResult:
    features = extract_signal_features(signal)
    timeframe = signal.timeframe or 'unknown'
    source = signal.source or 'ta_signal'
    vector = FeatureVectorV3(
        schema_version=schema_version,
        mapper_version=mapper_version,
        normalization_version=normalization_version,
        symbol=signal.symbol,
        timeframe=timeframe,
        event_ts=signal.event_ts.isoformat(),
        macd=features.macd,
        macd_signal=features.macd_signal,
        rsi=features.rsi,
        price=features.price,
        volatility=features.volatility,
        source=source,
        seq=signal.seq,
    )
    missing = _missing_required_features(vector, required_features)
    reasons: list[str] = []
    if timeframe == 'unknown':
        reasons.append('missing_timeframe')
    if missing:
        reasons.append('missing_required_features')
    return FeatureContractResult(
        vector=vector,
        parity_hash=vector.parity_hash(),
        required_features=required_features,
        missing_required_features=missing,
        valid=not reasons,
        reasons=tuple(reasons),
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


def _decimal_to_string(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def _missing_required_features(vector: FeatureVectorV3, required: tuple[str, ...]) -> tuple[str, ...]:
    missing: list[str] = []
    for feature in required:
        if feature == 'macd' and vector.macd is None:
            missing.append(feature)
        elif feature == 'macd_signal' and vector.macd_signal is None:
            missing.append(feature)
        elif feature == 'rsi' and vector.rsi is None:
            missing.append(feature)
        elif feature == 'price' and vector.price is None:
            missing.append(feature)
        elif feature == 'volatility' and vector.volatility is None:
            missing.append(feature)
    return tuple(missing)


__all__ = [
    "SignalFeatures",
    'FeatureVectorV3',
    'FeatureContractResult',
    "extract_signal_features",
    "extract_macd",
    "extract_rsi",
    "extract_price",
    "extract_volatility",
    'normalize_feature_vector_v3',
    "optional_decimal",
]
