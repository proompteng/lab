"""Shared feature extraction for trading signals."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Optional, cast

from .models import SignalEnvelope

FEATURE_SCHEMA_VERSION_V3 = '3.0.0'
FEATURE_VECTOR_V3_REQUIRED_FIELDS = ('price', 'macd', 'macd_signal', 'rsi14')
FEATURE_VECTOR_V3_VALUE_FIELDS = (
    'price',
    'ema12',
    'ema26',
    'macd',
    'macd_signal',
    'macd_hist',
    'vwap_session',
    'vwap_w5m',
    'rsi14',
    'boll_mid',
    'boll_upper',
    'boll_lower',
    'vol_realized_w60s',
    'imbalance_spread',
    'spread',
    'signal_quality_flag',
    'route_regime_label',
    'staleness_ms',
)
FEATURE_VECTOR_V3_IDENTITY_FIELDS = (
    'event_ts',
    'symbol',
    'timeframe',
    'seq',
    'source',
    'feature_schema_version',
)
FEATURE_VECTOR_V3_ALL_FIELDS = FEATURE_VECTOR_V3_IDENTITY_FIELDS + FEATURE_VECTOR_V3_VALUE_FIELDS


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
    macd_block = payload.get('macd')
    if isinstance(macd_block, dict):
        macd_dict = cast(dict[str, Any], macd_block)
        macd_val = macd_dict.get('macd')
        signal_val = macd_dict.get('signal')
    else:
        macd_val = payload.get('macd')
        signal_val = payload.get('macd_signal')
    return optional_decimal(macd_val), optional_decimal(signal_val)


def extract_rsi(payload: dict[str, Any]) -> Optional[Decimal]:
    return optional_decimal(payload.get('rsi14') or payload.get('rsi'))


def extract_price(payload: dict[str, Any]) -> Optional[Decimal]:
    payload_map = payload

    vwap = payload_map.get('vwap')
    if isinstance(vwap, dict):
        vwap_map = cast(dict[str, Any], vwap)
        for key in ('session', 'w5m'):
            if key in vwap_map:
                value = optional_decimal(vwap_map.get(key))
                if value is not None:
                    return value

    for key in ('price', 'close', 'c', 'last', 'vwap', 'vwap_session', 'vwap_w5m'):
        if key in payload_map:
            return optional_decimal(payload_map.get(key))

    imbalance = payload_map.get('imbalance')
    if isinstance(imbalance, dict):
        imbalance_payload = cast(dict[str, Any], imbalance)
        bid_px = imbalance_payload.get('bid_px')
        ask_px = imbalance_payload.get('ask_px')
        if bid_px is not None and ask_px is not None:
            try:
                bid = optional_decimal(bid_px)
                ask = optional_decimal(ask_px)
                if bid is not None and ask is not None:
                    return (bid + ask) / 2
            except (TypeError, ArithmeticError):
                pass
    return None


def extract_volatility(payload: dict[str, Any]) -> Optional[Decimal]:
    vol_realized = payload.get('vol_realized')
    if isinstance(vol_realized, dict):
        nested = optional_decimal(cast(dict[str, Any], vol_realized).get('w60s'))
        if nested is not None:
            return nested
    for key in ('vol_realized_w60s', 'volatility', 'vol', 'sigma'):
        if key in payload:
            return optional_decimal(payload.get(key))
    return None


def normalize_feature_vector_v3(signal: SignalEnvelope) -> FeatureVectorV3:
    _validate_signal_schema_version(signal)
    values = map_feature_values_v3(signal)
    timeframe = signal.timeframe or '1Min'

    missing = [name for name in FEATURE_VECTOR_V3_REQUIRED_FIELDS if values.get(name) is None]
    if missing:
        raise FeatureNormalizationError(f"missing_required_features:{'|'.join(sorted(missing))}")

    normalized_payload = {
        'event_ts': signal.event_ts.isoformat(),
        'symbol': signal.symbol,
        'timeframe': timeframe,
        'seq': signal.seq or 0,
        'source': signal.source or 'unknown',
        'feature_schema_version': FEATURE_SCHEMA_VERSION_V3,
        'values': {key: _jsonable(values[key]) for key in sorted(values)},
    }
    normalization_hash = hashlib.sha256(
        json.dumps(normalized_payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()

    return FeatureVectorV3(
        event_ts=signal.event_ts,
        symbol=signal.symbol,
        timeframe=timeframe,
        seq=signal.seq or 0,
        source=signal.source or 'unknown',
        feature_schema_version=FEATURE_SCHEMA_VERSION_V3,
        values=values,
        normalization_hash=normalization_hash,
    )


def map_feature_values_v3(signal: SignalEnvelope) -> dict[str, Any]:
    payload = signal.payload or {}
    macd, macd_signal = extract_macd(payload)

    return {
        'price': extract_price(payload),
        'ema12': optional_decimal(payload.get('ema12') or _nested(payload, 'ema', 'ema12')),
        'ema26': optional_decimal(payload.get('ema26') or _nested(payload, 'ema', 'ema26')),
        'macd': macd,
        'macd_signal': macd_signal,
        'macd_hist': optional_decimal(payload.get('macd_hist') or _nested(payload, 'macd', 'hist')),
        'vwap_session': optional_decimal(payload.get('vwap_session') or _nested(payload, 'vwap', 'session')),
        'vwap_w5m': optional_decimal(payload.get('vwap_w5m') or _nested(payload, 'vwap', 'w5m')),
        'rsi14': extract_rsi(payload),
        'boll_mid': optional_decimal(payload.get('boll_mid') or _nested(payload, 'boll', 'mid')),
        'boll_upper': optional_decimal(payload.get('boll_upper') or _nested(payload, 'boll', 'upper')),
        'boll_lower': optional_decimal(payload.get('boll_lower') or _nested(payload, 'boll', 'lower')),
        'vol_realized_w60s': extract_volatility(payload),
        'imbalance_spread': optional_decimal(payload.get('imbalance_spread') or _nested(payload, 'imbalance', 'spread')),
        'spread': optional_decimal(payload.get('spread')),
        'signal_quality_flag': payload.get('signal_quality_flag'),
        'route_regime_label': _route_regime_label(payload, macd=macd, macd_signal=macd_signal),
        'staleness_ms': _staleness_ms(signal.event_ts, signal.ingest_ts),
    }


def validate_declared_features(declared_features: Iterable[str]) -> tuple[bool, list[str]]:
    declared = {item.strip() for item in declared_features if item.strip()}
    allowed = set(FEATURE_VECTOR_V3_VALUE_FIELDS)
    unknown = sorted([item for item in declared if item not in allowed])
    return len(unknown) == 0, unknown


def signal_declares_compatible_schema(signal: SignalEnvelope) -> bool:
    payload = signal.payload or {}
    declared = payload.get('feature_schema_version')
    if declared is None:
        return True
    major = _extract_major_version(str(declared))
    if major is None:
        return True
    return major == 3


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


def _nested(payload: dict[str, Any], block: str, key: str) -> Any:
    item = payload.get(block)
    if isinstance(item, dict):
        item_map = cast(dict[str, Any], item)
        return item_map.get(key)
    return None


def _route_regime_label(
    payload: dict[str, Any],
    *,
    macd: Decimal | None,
    macd_signal: Decimal | None,
) -> str:
    explicit = payload.get('regime_label')
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    if macd is None or macd_signal is None:
        return 'unknown'
    delta = macd - macd_signal
    if delta >= Decimal('0.02'):
        return 'trend'
    if delta <= Decimal('-0.02'):
        return 'mean_revert'
    return 'range'


def _validate_signal_schema_version(signal: SignalEnvelope) -> None:
    if signal_declares_compatible_schema(signal):
        return
    payload = signal.payload or {}
    declared = payload.get('feature_schema_version')
    raise FeatureNormalizationError(f'incompatible_feature_schema:{declared}')


def _extract_major_version(raw: str) -> int | None:
    cleaned = raw.strip().lower()
    if cleaned.startswith('v'):
        cleaned = cleaned[1:]
    head = cleaned.split('.', 1)[0]
    if head.isdigit():
        return int(head)
    return None


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    return value


__all__ = [
    'FEATURE_SCHEMA_VERSION_V3',
    'FEATURE_VECTOR_V3_ALL_FIELDS',
    'FEATURE_VECTOR_V3_IDENTITY_FIELDS',
    'FEATURE_VECTOR_V3_REQUIRED_FIELDS',
    'FEATURE_VECTOR_V3_VALUE_FIELDS',
    'FeatureNormalizationError',
    'FeatureVectorV3',
    'SignalFeatures',
    'extract_signal_features',
    'extract_macd',
    'extract_price',
    'extract_rsi',
    'extract_volatility',
    'map_feature_values_v3',
    'normalize_feature_vector_v3',
    'optional_decimal',
    'signal_declares_compatible_schema',
    'validate_declared_features',
]
