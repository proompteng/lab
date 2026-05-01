"""Shared feature extraction for trading signals."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Optional, cast

from .models import SignalEnvelope
from .regime_hmm import resolve_hmm_context, resolve_regime_route_label
from .simulation import simulation_context_enabled

FEATURE_SCHEMA_VERSION_V3 = '3.0.0'
FEATURE_VECTOR_V3_REQUIRED_FIELDS = ('price', 'macd', 'macd_signal', 'rsi14')
FEATURE_VECTOR_V3_VALUE_FIELDS = (
    'price',
    'mid_price',
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
    'imbalance_bid_px',
    'imbalance_ask_px',
    'imbalance_bid_sz',
    'imbalance_ask_sz',
    'imbalance_pressure',
    'spread',
    'spread_bps',
    'vwap_w5m_vs_session_bps',
    'price_vs_vwap_w5m_bps',
    'session_open_price',
    'prev_session_close_price',
    'session_high_price',
    'session_low_price',
    'opening_range_high',
    'opening_range_low',
    'opening_window_close_price',
    'opening_range_width_bps',
    'session_range_bps',
    'price_vs_session_open_bps',
    'price_vs_prev_session_close_bps',
    'opening_window_return_bps',
    'opening_window_return_from_prev_close_bps',
    'price_vs_session_high_bps',
    'price_vs_session_low_bps',
    'price_vs_opening_range_high_bps',
    'price_vs_opening_range_low_bps',
    'price_vs_opening_window_close_bps',
    'price_position_in_session_range',
    'recent_spread_bps_avg',
    'recent_spread_bps_max',
    'recent_imbalance_pressure_avg',
    'recent_quote_invalid_ratio',
    'recent_quote_jump_bps_avg',
    'recent_quote_jump_bps_max',
    'recent_microprice_bias_bps_avg',
    'recent_above_opening_range_high_ratio',
    'recent_above_opening_window_close_ratio',
    'recent_above_vwap_w5m_ratio',
    'recent_15m_return_bps',
    'microbar_volume',
    'cross_section_session_open_rank',
    'cross_section_prev_session_close_rank',
    'cross_section_opening_window_return_rank',
    'cross_section_opening_window_return_from_prev_close_rank',
    'cross_section_prev_day_open45_return_rank',
    'cross_section_prev_day_open60_return_rank',
    'cross_section_range_position_rank',
    'cross_section_vwap_w5m_rank',
    'cross_section_vwap_w5m_stretch_rank',
    'cross_section_recent_15m_return_rank',
    'cross_section_microbar_volume_rank',
    'cross_section_recent_imbalance_rank',
    'cross_section_rsi14_rank',
    'cross_section_macd_hist_rank',
    'cross_section_positive_session_open_ratio',
    'cross_section_positive_prev_session_close_ratio',
    'cross_section_positive_opening_window_return_ratio',
    'cross_section_positive_opening_window_return_from_prev_close_ratio',
    'cross_section_positive_prev_day_open45_return_ratio',
    'cross_section_positive_prev_day_open60_return_ratio',
    'cross_section_above_vwap_w5m_ratio',
    'cross_section_positive_recent_imbalance_ratio',
    'cross_section_continuation_breadth',
    'cross_section_continuation_rank',
    'cross_section_reversal_rank',
    'session_minutes_elapsed',
    'signal_quality_flag',
    'hmm_state_posterior',
    'hmm_entropy',
    'hmm_entropy_band',
    'hmm_regime_id',
    'hmm_transition_shock',
    'hmm_guardrail',
    'hmm_artifact_model_id',
    'hmm_artifact_feature_schema',
    'hmm_artifact_training_run_id',
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


@dataclass(frozen=True)
class MicrostructureFeaturesV1:
    schema_version: str
    symbol: str
    event_ts: datetime
    spread_bps: Decimal
    depth_top5_usd: Decimal
    order_flow_imbalance: Decimal
    latency_ms_estimate: int
    fill_hazard: Decimal
    liquidity_regime: str


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
    return optional_decimal(payload_value(payload, 'rsi14', nested_key='rsi'))


def extract_price(payload: dict[str, Any]) -> Optional[Decimal]:
    executable_price = extract_executable_price(payload)
    if executable_price is not None:
        return executable_price

    vwap_price = _extract_price_from_vwap(payload)
    if vwap_price is not None:
        return vwap_price

    return _extract_price_from_vwap_keys(payload)


def extract_executable_price(payload: dict[str, Any]) -> Optional[Decimal]:
    direct_price = _extract_price_from_trade_keys(payload)
    if direct_price is not None:
        return direct_price
    return _extract_price_from_imbalance(payload)


def _extract_price_from_vwap(payload: dict[str, Any]) -> Decimal | None:
    vwap = payload.get('vwap')
    if not isinstance(vwap, dict):
        return None
    vwap_map = cast(dict[str, Any], vwap)
    for key in ('session', 'w5m'):
        if key not in vwap_map:
            continue
        value = optional_decimal(vwap_map.get(key))
        if value is not None:
            return value
    return None


def _extract_price_from_trade_keys(payload: dict[str, Any]) -> Decimal | None:
    for key in ('price', 'close', 'c', 'last'):
        if key in payload:
            return optional_decimal(payload.get(key))
    return None


def _extract_price_from_vwap_keys(payload: dict[str, Any]) -> Decimal | None:
    for key in ('vwap', 'vwap_session', 'vwap_w5m'):
        if key in payload:
            return optional_decimal(payload.get(key))
    return None


def _extract_price_from_imbalance(payload: dict[str, Any]) -> Decimal | None:
    bid = optional_decimal(
        payload_value(payload, 'imbalance_bid_px', block='imbalance', nested_key='bid_px')
    )
    ask = optional_decimal(
        payload_value(payload, 'imbalance_ask_px', block='imbalance', nested_key='ask_px')
    )
    if bid is None or ask is None:
        return None
    return (bid + ask) / 2


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


def extract_microstructure_features_v1(signal: SignalEnvelope) -> MicrostructureFeaturesV1:
    payload = signal.payload or {}
    spread_bps = optional_decimal(payload.get('spread_bps'))
    if spread_bps is None:
        spread = optional_decimal(payload_value(payload, 'spread', block='imbalance', nested_key='spread'))
        price = extract_price(payload)
        if spread is not None and price is not None and price > 0:
            spread_bps = (spread / price) * Decimal('10000')
        else:
            spread_bps = Decimal('0')

    depth_top5_usd = optional_decimal(payload.get('depth_top5_usd'))
    if depth_top5_usd is None:
        depth_top5_usd = optional_decimal(nested_payload_value(payload, 'depth', 'top5_usd')) or Decimal('0')

    imbalance = optional_decimal(payload.get('order_flow_imbalance'))
    if imbalance is None:
        imbalance = optional_decimal(
            payload_value(payload, 'imbalance_spread', block='imbalance', nested_key='value')
        )
    order_flow_imbalance = imbalance or Decimal('0')

    latency_ms_estimate = (
        _optional_int(payload_value(payload, 'latency_ms_estimate', nested_key='latency_ms'))
        or 0
    )
    fill_hazard = optional_decimal(
        payload_value(payload, 'fill_hazard', block='execution', nested_key='fill_hazard')
    )
    if fill_hazard is None:
        fill_hazard = optional_decimal(payload.get('signal_quality_flag')) or Decimal('0.5')

    liquidity_regime = str(payload.get('liquidity_regime') or '').strip().lower()
    if liquidity_regime not in {'normal', 'compressed', 'stressed'}:
        liquidity_regime = 'normal'

    return MicrostructureFeaturesV1(
        schema_version='microstructure_state_v1',
        symbol=signal.symbol.upper(),
        event_ts=signal.event_ts,
        spread_bps=spread_bps,
        depth_top5_usd=depth_top5_usd,
        order_flow_imbalance=order_flow_imbalance,
        latency_ms_estimate=latency_ms_estimate,
        fill_hazard=fill_hazard,
        liquidity_regime=liquidity_regime,
    )


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
    regime_context = resolve_hmm_context(payload)
    price = extract_price(payload)
    vwap_session = optional_decimal(payload_value(payload, 'vwap_session', block='vwap', nested_key='session'))
    vwap_w5m = optional_decimal(payload_value(payload, 'vwap_w5m', block='vwap', nested_key='w5m'))

    return {
        'price': price,
        'mid_price': _extract_mid_price(payload),
        'ema12': optional_decimal(payload_value(payload, 'ema12', block='ema', nested_key='ema12')),
        'ema26': optional_decimal(payload_value(payload, 'ema26', block='ema', nested_key='ema26')),
        'macd': macd,
        'macd_signal': macd_signal,
        'macd_hist': optional_decimal(payload_value(payload, 'macd_hist', block='macd', nested_key='hist')),
        'vwap_session': vwap_session,
        'vwap_w5m': vwap_w5m,
        'rsi14': extract_rsi(payload),
        'boll_mid': optional_decimal(payload_value(payload, 'boll_mid', block='boll', nested_key='mid')),
        'boll_upper': optional_decimal(payload_value(payload, 'boll_upper', block='boll', nested_key='upper')),
        'boll_lower': optional_decimal(payload_value(payload, 'boll_lower', block='boll', nested_key='lower')),
        'vol_realized_w60s': extract_volatility(payload),
        'imbalance_spread': optional_decimal(
            payload_value(payload, 'imbalance_spread', block='imbalance', nested_key='spread')
        ),
        'imbalance_bid_px': optional_decimal(
            payload_value(payload, 'imbalance_bid_px', block='imbalance', nested_key='bid_px')
        ),
        'imbalance_ask_px': optional_decimal(
            payload_value(payload, 'imbalance_ask_px', block='imbalance', nested_key='ask_px')
        ),
        'imbalance_bid_sz': optional_decimal(
            payload_value(payload, 'imbalance_bid_sz', block='imbalance', nested_key='bid_sz')
        ),
        'imbalance_ask_sz': optional_decimal(
            payload_value(payload, 'imbalance_ask_sz', block='imbalance', nested_key='ask_sz')
        ),
        'imbalance_pressure': _imbalance_pressure(payload),
        'spread': optional_decimal(payload.get('spread')),
        'spread_bps': _spread_bps(payload),
        'vwap_w5m_vs_session_bps': _bps_delta(vwap_w5m, vwap_session),
        'price_vs_vwap_w5m_bps': _bps_delta(price, vwap_w5m),
        'session_open_price': optional_decimal(payload.get('session_open_price')),
        'prev_session_close_price': optional_decimal(payload.get('prev_session_close_price')),
        'session_high_price': optional_decimal(payload.get('session_high_price')),
        'session_low_price': optional_decimal(payload.get('session_low_price')),
        'opening_range_high': optional_decimal(payload.get('opening_range_high')),
        'opening_range_low': optional_decimal(payload.get('opening_range_low')),
        'opening_window_close_price': optional_decimal(payload.get('opening_window_close_price')),
        'opening_range_width_bps': optional_decimal(payload.get('opening_range_width_bps')),
        'session_range_bps': optional_decimal(payload.get('session_range_bps')),
        'price_vs_session_open_bps': optional_decimal(payload.get('price_vs_session_open_bps')),
        'price_vs_prev_session_close_bps': optional_decimal(payload.get('price_vs_prev_session_close_bps')),
        'opening_window_return_bps': optional_decimal(payload.get('opening_window_return_bps')),
        'opening_window_return_from_prev_close_bps': optional_decimal(
            payload.get('opening_window_return_from_prev_close_bps')
        ),
        'price_vs_session_high_bps': optional_decimal(payload.get('price_vs_session_high_bps')),
        'price_vs_session_low_bps': optional_decimal(payload.get('price_vs_session_low_bps')),
        'price_vs_opening_range_high_bps': optional_decimal(payload.get('price_vs_opening_range_high_bps')),
        'price_vs_opening_range_low_bps': optional_decimal(payload.get('price_vs_opening_range_low_bps')),
        'price_vs_opening_window_close_bps': optional_decimal(payload.get('price_vs_opening_window_close_bps')),
        'price_position_in_session_range': optional_decimal(payload.get('price_position_in_session_range')),
        'recent_spread_bps_avg': optional_decimal(payload.get('recent_spread_bps_avg')),
        'recent_spread_bps_max': optional_decimal(payload.get('recent_spread_bps_max')),
        'recent_imbalance_pressure_avg': optional_decimal(payload.get('recent_imbalance_pressure_avg')),
        'recent_quote_invalid_ratio': optional_decimal(payload.get('recent_quote_invalid_ratio')),
        'recent_quote_jump_bps_avg': optional_decimal(payload.get('recent_quote_jump_bps_avg')),
        'recent_quote_jump_bps_max': optional_decimal(payload.get('recent_quote_jump_bps_max')),
        'recent_microprice_bias_bps_avg': optional_decimal(payload.get('recent_microprice_bias_bps_avg')),
        'recent_above_opening_range_high_ratio': optional_decimal(
            payload.get('recent_above_opening_range_high_ratio')
        ),
        'recent_above_opening_window_close_ratio': optional_decimal(
            payload.get('recent_above_opening_window_close_ratio')
        ),
        'recent_above_vwap_w5m_ratio': optional_decimal(
            payload.get('recent_above_vwap_w5m_ratio')
        ),
        'recent_15m_return_bps': optional_decimal(payload.get('recent_15m_return_bps')),
        'microbar_volume': optional_decimal(payload.get('microbar_volume')),
        'cross_section_session_open_rank': optional_decimal(payload.get('cross_section_session_open_rank')),
        'cross_section_prev_session_close_rank': optional_decimal(
            payload.get('cross_section_prev_session_close_rank')
        ),
        'cross_section_opening_window_return_rank': optional_decimal(payload.get('cross_section_opening_window_return_rank')),
        'cross_section_opening_window_return_from_prev_close_rank': optional_decimal(
            payload.get('cross_section_opening_window_return_from_prev_close_rank')
        ),
        'cross_section_prev_day_open45_return_rank': optional_decimal(
            payload.get('cross_section_prev_day_open45_return_rank')
        ),
        'cross_section_prev_day_open60_return_rank': optional_decimal(
            payload.get('cross_section_prev_day_open60_return_rank')
        ),
        'cross_section_range_position_rank': optional_decimal(payload.get('cross_section_range_position_rank')),
        'cross_section_vwap_w5m_rank': optional_decimal(payload.get('cross_section_vwap_w5m_rank')),
        'cross_section_vwap_w5m_stretch_rank': optional_decimal(
            payload.get('cross_section_vwap_w5m_stretch_rank')
        ),
        'cross_section_recent_15m_return_rank': optional_decimal(
            payload.get('cross_section_recent_15m_return_rank')
        ),
        'cross_section_microbar_volume_rank': optional_decimal(
            payload.get('cross_section_microbar_volume_rank')
        ),
        'cross_section_recent_imbalance_rank': optional_decimal(payload.get('cross_section_recent_imbalance_rank')),
        'cross_section_rsi14_rank': optional_decimal(payload.get('cross_section_rsi14_rank')),
        'cross_section_macd_hist_rank': optional_decimal(payload.get('cross_section_macd_hist_rank')),
        'cross_section_positive_session_open_ratio': optional_decimal(payload.get('cross_section_positive_session_open_ratio')),
        'cross_section_positive_prev_session_close_ratio': optional_decimal(
            payload.get('cross_section_positive_prev_session_close_ratio')
        ),
        'cross_section_positive_opening_window_return_ratio': optional_decimal(
            payload.get('cross_section_positive_opening_window_return_ratio')
        ),
        'cross_section_positive_opening_window_return_from_prev_close_ratio': optional_decimal(
            payload.get('cross_section_positive_opening_window_return_from_prev_close_ratio')
        ),
        'cross_section_positive_prev_day_open45_return_ratio': optional_decimal(
            payload.get('cross_section_positive_prev_day_open45_return_ratio')
        ),
        'cross_section_positive_prev_day_open60_return_ratio': optional_decimal(
            payload.get('cross_section_positive_prev_day_open60_return_ratio')
        ),
        'cross_section_above_vwap_w5m_ratio': optional_decimal(payload.get('cross_section_above_vwap_w5m_ratio')),
        'cross_section_positive_recent_imbalance_ratio': optional_decimal(
            payload.get('cross_section_positive_recent_imbalance_ratio')
        ),
        'cross_section_continuation_breadth': optional_decimal(payload.get('cross_section_continuation_breadth')),
        'cross_section_continuation_rank': optional_decimal(payload.get('cross_section_continuation_rank')),
        'cross_section_reversal_rank': optional_decimal(payload.get('cross_section_reversal_rank')),
        'session_minutes_elapsed': _optional_int(payload.get('session_minutes_elapsed')),
        'signal_quality_flag': payload.get('signal_quality_flag'),
        'hmm_state_posterior': regime_context.posterior,
        'hmm_entropy': regime_context.entropy,
        'hmm_entropy_band': regime_context.entropy_band,
        'hmm_regime_id': regime_context.regime_id,
        'hmm_transition_shock': regime_context.transition_shock,
        'hmm_guardrail': regime_context.guardrail.to_payload(),
        'hmm_artifact_model_id': regime_context.artifact.model_id,
        'hmm_artifact_feature_schema': regime_context.artifact.feature_schema,
        'hmm_artifact_training_run_id': regime_context.artifact.training_run_id,
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
        return False
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


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _staleness_ms(event_ts: datetime, ingest_ts: datetime | None) -> int:
    # Historical replay writes ingest_ts at replay wall-clock time, so simulation
    # freshness must remain anchored to the historical event timestamp.
    if simulation_context_enabled():
        reference = event_ts.astimezone(timezone.utc)
    else:
        reference = (
            ingest_ts.astimezone(timezone.utc)
            if ingest_ts is not None
            else event_ts.astimezone(timezone.utc)
        )
    delta = reference - event_ts.astimezone(timezone.utc)
    return max(0, int(delta.total_seconds() * 1000))


def nested_payload_value(payload: dict[str, Any], block: str, key: str) -> Any:
    item = payload.get(block)
    if isinstance(item, dict):
        item_map = cast(dict[str, Any], item)
        return item_map.get(key)
    return None


def payload_value(
    payload: dict[str, Any],
    key: str,
    *,
    block: str | None = None,
    nested_key: str | None = None,
) -> Any:
    direct_value = payload.get(key)
    if direct_value is not None:
        return direct_value
    if block is not None and nested_key is not None:
        return nested_payload_value(payload, block, nested_key)
    if nested_key is not None:
        return payload.get(nested_key)
    return None


def _route_regime_label(
    payload: dict[str, Any],
    *,
    macd: Decimal | None,
    macd_signal: Decimal | None,
) -> str:
    return resolve_regime_route_label(payload, macd=macd, macd_signal=macd_signal)


def _extract_mid_price(payload: dict[str, Any]) -> Decimal | None:
    bid = optional_decimal(payload_value(payload, 'imbalance_bid_px', block='imbalance', nested_key='bid_px'))
    ask = optional_decimal(payload_value(payload, 'imbalance_ask_px', block='imbalance', nested_key='ask_px'))
    if bid is None or ask is None:
        return None
    return (bid + ask) / 2


def _spread_bps(payload: dict[str, Any]) -> Decimal | None:
    direct_spread_bps = optional_decimal(payload.get('spread_bps'))
    if direct_spread_bps is not None:
        return abs(direct_spread_bps)
    spread = optional_decimal(payload_value(payload, 'spread'))
    if spread is None:
        spread = optional_decimal(
            payload_value(payload, 'imbalance_spread', block='imbalance', nested_key='spread')
        )
    price = extract_price(payload)
    if spread is None or price is None or price <= 0:
        return None
    return (spread / price) * Decimal('10000')


def _bps_delta(price: Decimal | None, reference: Decimal | None) -> Decimal | None:
    if price is None or reference is None or reference == 0:
        return None
    return ((price - reference) / reference) * Decimal('10000')


def _imbalance_pressure(payload: dict[str, Any]) -> Decimal | None:
    bid_sz = optional_decimal(payload_value(payload, 'imbalance_bid_sz', block='imbalance', nested_key='bid_sz'))
    ask_sz = optional_decimal(payload_value(payload, 'imbalance_ask_sz', block='imbalance', nested_key='ask_sz'))
    if bid_sz is None or ask_sz is None:
        return None
    total = bid_sz + ask_sz
    if total <= 0:
        return None
    return (bid_sz - ask_sz) / total


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
    'MicrostructureFeaturesV1',
    'SignalFeatures',
    'extract_microstructure_features_v1',
    'extract_signal_features',
    'extract_macd',
    'extract_executable_price',
    'extract_price',
    'extract_rsi',
    'extract_volatility',
    'map_feature_values_v3',
    'normalize_feature_vector_v3',
    'optional_decimal',
    'payload_value',
    'signal_declares_compatible_schema',
    'nested_payload_value',
    'validate_declared_features',
]
