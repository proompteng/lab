"""Microstructure and execution-advice contracts for bounded execution policy."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast


@dataclass(frozen=True)
class MicrostructureStateV5:
    schema_version: str
    symbol: str
    event_ts: datetime
    spread_bps: Decimal
    depth_top5_usd: Decimal
    order_flow_imbalance: Decimal
    latency_ms_estimate: int
    fill_hazard: Decimal
    liquidity_regime: str


@dataclass(frozen=True)
class ExecutionAdviceV1:
    urgency_tier: str
    max_participation_rate: Decimal | None
    preferred_order_type: str | None
    quote_offset_bps: Decimal | None
    adverse_selection_risk: Decimal | None
    event_ts: datetime | None
    latency_ms: int | None
    simulator_version: str | None
    expected_shortfall_bps_p50: Decimal | None
    expected_shortfall_bps_p95: Decimal | None


def _coalesce_text(raw: Mapping[str, Any], *paths: str) -> str | None:
    for path in paths:
        value = raw.get(path)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def _coalesce_numeric(raw: Mapping[str, Any], *paths: str) -> Any:
    for path in paths:
        value = raw.get(path)
        if value is None:
            continue
        try:
            return Decimal(str(value))
        except (ArithmeticError, TypeError, ValueError):
            continue
    return None


def _coalesce_int(raw: Mapping[str, Any], *paths: str) -> int | None:
    for path in paths:
        value = raw.get(path)
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def _coalesce_payload_value(
    raw: Mapping[str, Any], *paths: tuple[str, ...]
) -> Any:
    for path in paths:
        value = raw.get(path)
        if value is not None:
            return value
    return None


def _normalize_deeplob_payload(payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    feature_quality_status = _coalesce_text(
        payload,
        "feature_quality_status",
    )
    if feature_quality_status is None or feature_quality_status.strip().lower() != "pass":
        return None

    quality_schema = _coalesce_text(payload, "uncertainty_band")
    fill_hazard = _coalesce_numeric(payload, "fill_hazard", "adverse_selection_risk")
    if fill_hazard is None and quality_schema is not None:
        fill_hazard = {
            "low": Decimal("0.30"),
            "medium": Decimal("0.55"),
            "high": Decimal("0.80"),
        }.get(quality_schema.lower(), Decimal("0.55"))

    liquidity_regime = _coalesce_text(payload, "liquidity_state", "liquidity_regime")
    regime = (liquidity_regime or "normal").lower()
    if regime not in {"normal", "compressed", "stressed"}:
        regime = "normal"

    direction_probabilities = _coalesce_payload_value(payload, "direction_probabilities")
    direction_map = (
        cast(Mapping[str, Any], direction_probabilities)
        if isinstance(direction_probabilities, Mapping)
        else None
    )
    order_flow_imbalance = _coalesce_numeric(payload, "order_flow_imbalance")
    if order_flow_imbalance is None and direction_map is not None:
        buy_side = _coalesce_numeric(direction_map, "buy", "up", "bullish")
        sell_side = _coalesce_numeric(direction_map, "sell", "down", "bearish")
        if buy_side is not None and sell_side is not None:
            order_flow_imbalance = buy_side - sell_side

    spread_bps = _coalesce_numeric(
        payload,
        "spread_bps",
        "expected_spread_impact_bps",
        "spread_impact_bps",
    )
    if spread_bps is None:
        raw_spread = _coalesce_numeric(payload, "expected_slippage_bps")
        if raw_spread is not None:
            spread_bps = abs(raw_spread)

    depth_top5_usd = _coalesce_numeric(payload, "depth_top5_usd", "depth_usd")
    if depth_top5_usd is None:
        raw_depth = _coalesce_payload_value(payload, "depth")
        if isinstance(raw_depth, Mapping):
            depth_top5_usd = _coalesce_numeric(
                cast(Mapping[str, Any], raw_depth), "top5_usd", "top5", "usd"
            )

    normalized_payload: dict[str, Any] = {
        "schema_version": "microstructure_state_v1",
        "symbol": _coalesce_text(payload, "symbol") or "",
        "event_ts": _coalesce_text(payload, "event_ts") or _coalesce_text(payload, "ts"),
        "spread_bps": str(spread_bps) if spread_bps is not None else None,
        "depth_top5_usd": str(depth_top5_usd) if depth_top5_usd is not None else None,
        "order_flow_imbalance": str(order_flow_imbalance)
        if order_flow_imbalance is not None
        else None,
        "latency_ms_estimate": 0,
        "fill_hazard": str(fill_hazard) if fill_hazard is not None else None,
        "liquidity_regime": regime,
    }
    latency_ms_estimate = _coalesce_int(payload, "latency_ms_estimate", "latency_ms")
    if latency_ms_estimate is not None:
        normalized_payload["latency_ms_estimate"] = latency_ms_estimate
    return normalized_payload


def parse_microstructure_state(payload: Any, *, expected_symbol: str | None = None) -> MicrostructureStateV5 | None:
    if not isinstance(payload, Mapping):
        return None
    raw = cast(Mapping[str, Any], payload)
    schema_version = str(raw.get('schema_version') or '').strip().lower()
    data: Mapping[str, Any]
    if schema_version == 'microstructure_signal_v1':
        normalized = _normalize_deeplob_payload(raw)
        if normalized is None:
            return None
        data = normalized
    elif schema_version == 'microstructure_state_v1':
        data = raw
    else:
        return None

    symbol = str(data.get('symbol') or '').strip().upper()
    if not symbol:
        return None
    if expected_symbol and symbol != expected_symbol.strip().upper():
        return None

    event_ts = _dt(data.get('event_ts'))
    spread_bps = _dec(data.get('spread_bps'))
    depth_top5_usd = _dec(data.get('depth_top5_usd'))
    imbalance = _dec(data.get('order_flow_imbalance'))
    latency_ms_estimate = _int(data.get('latency_ms_estimate'))
    fill_hazard = _dec(data.get('fill_hazard'))
    liquidity_regime = str(data.get('liquidity_regime') or '').strip().lower()
    if None in (event_ts, spread_bps, depth_top5_usd, imbalance, latency_ms_estimate, fill_hazard):
        return None
    if liquidity_regime not in {'normal', 'compressed', 'stressed'}:
        return None
    return MicrostructureStateV5(
        'microstructure_state_v1',
        symbol,
        cast(datetime, event_ts),
        cast(Decimal, spread_bps),
        cast(Decimal, depth_top5_usd),
        cast(Decimal, imbalance),
        cast(int, latency_ms_estimate),
        cast(Decimal, fill_hazard),
        liquidity_regime,
    )

def parse_execution_advice(payload: Any) -> ExecutionAdviceV1 | None:
    if not isinstance(payload, Mapping):
        return None
    data = cast(Mapping[str, Any], payload)
    urgency = str(data.get('urgency_tier') or '').strip().lower()
    preferred = data.get('preferred_order_type')
    preferred_str = str(preferred).strip().lower() if preferred is not None else None
    if urgency not in {'low', 'normal', 'high'}:
        return None
    if preferred_str is not None and preferred_str not in {'market', 'limit', 'stop', 'stop_limit'}:
        return None
    return ExecutionAdviceV1(
        urgency,
        _dec(data.get('max_participation_rate')),
        preferred_str,
        _dec(data.get('quote_offset_bps')),
        _dec(data.get('adverse_selection_risk')),
        _dt(data.get('event_ts')),
        _int(data.get('latency_ms')),
        _text(data.get('simulator_version')),
        _dec(data.get('expected_shortfall_bps_p50')),
        _dec(data.get('expected_shortfall_bps_p95')),
    )

def is_microstructure_stale(state: MicrostructureStateV5 | None, *, reference_ts: datetime, max_staleness_seconds: int) -> bool:
    if state is None:
        return True
    age = (reference_ts.astimezone(timezone.utc) - state.event_ts.astimezone(timezone.utc)).total_seconds()
    return age > max(max_staleness_seconds, 0)

def _dec(value: Any) -> Decimal | None:
    try:
        return None if value is None else Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None

def _int(value: Any) -> int | None:
    try:
        return None if value is None else int(value)
    except (TypeError, ValueError):
        return None

def _dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None

def _text(value: Any) -> str | None:
    if value is None:
        return None
    value_str = str(value).strip()
    return value_str or None

__all__ = ['ExecutionAdviceV1', 'MicrostructureStateV5', 'is_microstructure_stale', 'parse_execution_advice', 'parse_microstructure_state']
