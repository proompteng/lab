# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Bounded H-PAIRS ClusterLOB/OFI candidate prefiltering.

The scores in this module are discovery metadata only. They intentionally rank
candidate specs for a bounded exact-replay handoff and never create promotion
or runtime-ledger authority.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timezone
from decimal import Decimal
from math import exp, isfinite, log, sqrt
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.models import SignalEnvelope

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_24 import *


def _horizon_ofi_features(values: NDArray[np.float64]) -> dict[str, Any]:
    if values.size == 0:
        return _empty_horizon_features()
    horizon_payload: dict[str, dict[str, str]] = {}
    ewma_values: dict[int, float] = {}
    for horizon in HPAIRS_HORIZONS:
        ewma_value = _ewma_last(values, half_life=float(horizon))
        ewma_values[horizon] = ewma_value
        recent = values[-min(values.size, horizon) :]
        baseline = values[: max(0, values.size - horizon)]
        baseline_mean = _mean(baseline)
        shock = _mean(recent) - baseline_mean if baseline.size else _mean(recent)
        horizon_payload[f"{horizon}_microbars"] = {
            "ewma": str(_decimal(ewma_value)),
            "shock": str(_decimal(shock)),
            "memory": str(_decimal(baseline_mean)),
            "sample_count": str(min(values.size, horizon)),
        }
    short = ewma_values[HPAIRS_HORIZONS[0]]
    medium = ewma_values[HPAIRS_HORIZONS[1]]
    long = ewma_values[HPAIRS_HORIZONS[2]]
    shock_score = float(np.clip(short - long, -1.0, 1.0))
    memory_score = float(np.clip(0.65 * medium + 0.35 * long, -1.0, 1.0))
    return {
        "status": "available",
        "horizons": horizon_payload,
        "shock_score": str(_decimal(shock_score)),
        "memory_score": str(_decimal(memory_score)),
        "directional_alignment_score": str(
            _decimal(0.6 * shock_score + 0.4 * memory_score)
        ),
        "source": "available_ofi_or_depth_fields",
    }


def _merged_horizon_features(
    stats: Sequence[_SymbolMicrostructureStats], *, direction: float
) -> dict[str, Any]:
    values = _concat_arrays(tuple(stat.ofi_values for stat in stats))
    features = _horizon_ofi_features(values)
    alignment = float(features["directional_alignment_score"])
    return {
        **features,
        "directional_alignment_score": str(_decimal(direction * alignment)),
        "candidate_direction": "continuation" if direction > 0 else "reversal",
    }


def _empty_horizon_features() -> dict[str, Any]:
    return {
        "status": "missing_inputs",
        "horizons": {},
        "shock_score": "0",
        "memory_score": "0",
        "directional_alignment_score": "0",
        "source": "missing_ofi_or_depth_fields",
    }


def _cluster_behavior(
    *,
    event_labels: Sequence[str],
    ofi_values: NDArray[np.float64],
    microprice_bias_bps: NDArray[np.float64],
    has_cluster_fields: bool,
) -> dict[str, Any]:
    entropy = _normalized_entropy(event_labels)
    pressure = _mean(np.abs(ofi_values))
    burstiness = (
        _percentile(np.abs(np.diff(ofi_values)), 75.0) if ofi_values.size >= 3 else 0.0
    )
    microprice = _mean(microprice_bias_bps)
    cluster_score = float(
        np.clip(
            0.30 * entropy
            + 0.40 * pressure
            + 0.20 * burstiness
            + 0.10 * min(1.0, abs(microprice) / 5.0),
            0.0,
            1.0,
        )
    )
    dominant_label = _dominant_label(event_labels)
    if pressure >= 0.25 and microprice >= 0.0:
        behavior_bucket = "clusterlob_accumulation"
    elif pressure >= 0.25 and microprice < 0.0:
        behavior_bucket = "clusterlob_distribution"
    elif burstiness >= 0.20:
        behavior_bucket = "clusterlob_bursty_order_flow"
    else:
        behavior_bucket = "balanced_microbar_flow"
    source = (
        "cluster_lob_fields" if has_cluster_fields else "microbar_order_flow_fallback"
    )
    return {
        "status": "available" if ofi_values.size else "missing_ofi_inputs",
        "behavior_bucket": behavior_bucket,
        "dominant_event_label": dominant_label,
        "cluster_score": str(_decimal(cluster_score)),
        "event_entropy": str(_decimal(entropy)),
        "ofi_abs_pressure": str(_decimal(pressure)),
        "ofi_burstiness": str(_decimal(burstiness)),
        "microprice_bias_bps": str(_decimal(microprice)),
        "source": source,
    }


def _empty_cluster_behavior() -> dict[str, Any]:
    return {
        "status": "missing_inputs",
        "behavior_bucket": "unknown",
        "dominant_event_label": "unknown",
        "cluster_score": "0",
        "event_entropy": "0",
        "ofi_abs_pressure": "0",
        "ofi_burstiness": "0",
        "microprice_bias_bps": "0",
        "source": "missing_cluster_lob_and_order_flow_fields",
    }


def _regime_stress_veto(
    *,
    spread_values: NDArray[np.float64],
    returns_bps: NDArray[np.float64],
    volume_values: NDArray[np.float64],
    stress_values: Sequence[float],
    row_count: int,
) -> dict[str, Any]:
    spread_tail_bps = _percentile(spread_values, 95.0)
    return_tail_bps = _percentile(np.abs(returns_bps), 95.0)
    liquidity_score = _volume_score(volume_values)
    bounded_row_count = max(0, int(row_count))
    stress_sample_count = len(stress_values)
    stress_active_count = sum(1 for value in stress_values if value > 0.0)
    macro_window_concentration = (
        stress_sample_count / bounded_row_count if bounded_row_count > 0 else 0.0
    )
    macro_window_active_share = (
        stress_active_count / bounded_row_count if bounded_row_count > 0 else 0.0
    )
    input_stress_score = (
        float(np.clip(_mean(np.asarray(stress_values, dtype=np.float64)), 0.0, 1.0))
        if stress_values
        else 0.0
    )
    spread_stress = float(np.clip(max(0.0, spread_tail_bps - 12.0) / 38.0, 0.0, 1.0))
    return_stress = float(np.clip(max(0.0, return_tail_bps - 35.0) / 115.0, 0.0, 1.0))
    liquidity_stress = (
        float(np.clip(1.0 - liquidity_score, 0.0, 1.0)) if volume_values.size else 0.0
    )
    veto_score = float(
        np.clip(
            max(
                input_stress_score,
                0.45 * spread_stress + 0.35 * return_stress + 0.20 * liquidity_stress,
            ),
            0.0,
            1.0,
        )
    )
    return {
        "status": "available"
        if stress_values or spread_values.size or returns_bps.size
        else "missing_inputs",
        "veto_score": str(_decimal(veto_score)),
        "veto_active": veto_score >= 0.65,
        "input_stress_score": str(_decimal(input_stress_score)),
        "macro_window_sample_count": stress_sample_count,
        "macro_window_active_count": stress_active_count,
        "macro_window_concentration": str(_decimal(macro_window_concentration)),
        "macro_window_active_share": str(_decimal(macro_window_active_share)),
        "spread_tail_bps": str(_decimal(spread_tail_bps)),
        "return_tail_abs_bps": str(_decimal(return_tail_bps)),
        "liquidity_score": str(_decimal(liquidity_score)),
        "source": "source_fields_plus_microbar_stress_fallback"
        if stress_values
        else "microbar_regime_fallback_missing_explicit_stress_fields",
    }


def _empty_regime_stress_veto() -> dict[str, Any]:
    return {
        "status": "missing_inputs",
        "veto_score": "0",
        "veto_active": False,
        "input_stress_score": "0",
        "macro_window_sample_count": 0,
        "macro_window_active_count": 0,
        "macro_window_concentration": "0",
        "macro_window_active_share": "0",
        "spread_tail_bps": "0",
        "return_tail_abs_bps": "0",
        "liquidity_score": "0",
        "source": "missing_regime_stress_fields",
    }


def _macro_window_stress_from_regime(
    regime_stress_veto: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "status": regime_stress_veto.get("status", "missing_inputs"),
        "concentration": str(
            regime_stress_veto.get("macro_window_concentration") or "0"
        ),
        "active_share": str(regime_stress_veto.get("macro_window_active_share") or "0"),
        "sample_count": int(regime_stress_veto.get("macro_window_sample_count") or 0),
        "active_count": int(regime_stress_veto.get("macro_window_active_count") or 0),
        "stress_score": str(regime_stress_veto.get("input_stress_score") or "0"),
        "veto_score": str(regime_stress_veto.get("veto_score") or "0"),
        "veto_active": bool(regime_stress_veto.get("veto_active")),
        "source": regime_stress_veto.get("source", "missing_regime_stress_fields"),
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
    }


def _empty_macro_window_stress() -> dict[str, Any]:
    return _macro_window_stress_from_regime(_empty_regime_stress_veto())


def _extract_price(signal: SignalEnvelope, *, source_fields: set[str]) -> float | None:
    payload = signal.payload
    for key in ("price", "mid_price", "mid", "mark", "last_price", "close"):
        value = _float_or_none(payload.get(key))
        if value is not None and value > 0.0:
            source_fields.add(key)
            return value
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        source_fields.update(("bid", "ask"))
        return (bid + ask) / 2.0
    return None


def _extract_spread_bps(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
    payload = signal.payload
    explicit = _float_or_none(payload.get("spread_bps"))
    if explicit is not None:
        source_fields.add("spread_bps")
        return max(0.0, explicit)
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask >= bid:
        source_fields.update(("bid", "ask"))
        return (ask - bid) / ((ask + bid) / 2.0) * 10_000.0
    spread = _float_or_none(payload.get("spread"))
    price = _extract_price(signal, source_fields=source_fields)
    if spread is not None and price is not None and price > 0.0:
        source_fields.add("spread")
        return max(0.0, spread / price * 10_000.0)
    return None


def _extract_ofi_pressure(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
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
        value = _float_or_none(payload.get(key))
        if value is None:
            continue
        source_fields.add(key)
        if -1.0 <= value <= 1.0:
            return value
        return float(np.tanh(value / 100.0))
    return _extract_quote_depth_imbalance(signal, source_fields=source_fields)


def _extract_quote_depth_imbalance(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
    payload = signal.payload
    bid_size, bid_key = _first_float_with_key(
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
    ask_size, ask_key = _first_float_with_key(
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
    if bid_key is not None:
        source_fields.add(bid_key)
    if ask_key is not None:
        source_fields.add(ask_key)
    return float(np.clip((bid_size - ask_size) / (bid_size + ask_size), -1.0, 1.0))


def _extract_microprice_bias_bps(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
    payload = signal.payload
    bid, bid_key = _first_float_with_key(
        payload, ("bid", "best_bid", "bid_price", "best_bid_price")
    )
    ask, ask_key = _first_float_with_key(
        payload, ("ask", "best_ask", "ask_price", "best_ask_price")
    )
    explicit_microprice, microprice_key = _first_float_with_key(
        payload, ("microprice", "micro_price")
    )
    price = _extract_price(signal, source_fields=source_fields)
    if explicit_microprice is not None and price is not None and price > 0.0:
        if microprice_key is not None:
            source_fields.add(microprice_key)
        return (explicit_microprice - price) / price * 10_000.0

    bid_size, bid_size_key = _first_float_with_key(
        payload, ("bid_size", "bid_qty", "best_bid_size", "best_bid_qty")
    )
    ask_size, ask_size_key = _first_float_with_key(
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
    for key in (bid_key, ask_key, bid_size_key, ask_size_key):
        if key is not None:
            source_fields.add(key)
    mid = (bid + ask) / 2.0
    microprice = (ask * bid_size + bid * ask_size) / (bid_size + ask_size)
    return (microprice - mid) / mid * 10_000.0


def _extract_volume(signal: SignalEnvelope, *, source_fields: set[str]) -> float | None:
    payload = signal.payload
    value, key = _first_float_with_key(
        payload,
        ("microbar_volume", "bar_volume", "trade_volume", "volume", "qty", "size"),
        positive=True,
    )
    if value is not None and key is not None:
        source_fields.add(key)
    return value


def _event_label(signal: SignalEnvelope, *, source_fields: set[str]) -> str:
    payload = signal.payload
    for key in (
        "cluster_lob_label",
        "order_cluster",
        "lob_event_type",
        "event_type",
        "order_event_type",
        "side",
        "liquidity_side",
    ):
        value = str(payload.get(key) or "").strip().lower()
        if value:
            source_fields.add(key)
            return value
    return "unknown"


def _extract_regime_stress(
    signal: SignalEnvelope, *, source_fields: set[str]
) -> float | None:
    payload = signal.payload
    for key in (
        "regime_stress_score",
        "stress_veto_score",
        "macro_news_stress_score",
        "macro_stress_score",
        "news_stress_score",
        "macro_event_window",
        "macro_announcement_window",
        "news_event_window",
        "stress_veto_window",
        "volatility_shock_veto",
    ):
        if key not in payload:
            continue
        source_fields.add(key)
        value = payload.get(key)
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        parsed = _float_or_none(value)
        if parsed is not None:
            return float(np.clip(parsed, 0.0, 1.0))
        text = str(value).strip().lower()
        if text in {"yes", "true", "macro", "news", "event", "stress", "veto"}:
            return 1.0
        if text in {"no", "false", "none", "normal"}:
            return 0.0
    return None


def _candidate_symbols(spec: CandidateSpec) -> tuple[str, ...]:
    raw = spec.strategy_overrides.get("universe_symbols")
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes, bytearray)):
        raw_symbols = cast(Sequence[Any], raw)
        symbols = tuple(
            sorted({_string(item).upper() for item in raw_symbols if _string(item)})
        )
        if symbols:
            return symbols
    return (spec.runtime_strategy_name.upper(),)


def _timestamp_key(signal: SignalEnvelope) -> int:
    event_ts = signal.event_ts
    if event_ts.tzinfo is None:
        event_ts = event_ts.replace(tzinfo=timezone.utc)
    return int(event_ts.astimezone(timezone.utc).timestamp() * 1_000_000)


def _candidate_direction(spec: CandidateSpec) -> float:
    params = _mapping(spec.strategy_overrides.get("params"))
    text = " ".join(
        item
        for item in (
            spec.runtime_strategy_name,
            spec.family_template_id,
            _string(params.get("selection_mode")),
            _string(params.get("signal_motif")),
            _string(params.get("rank_feature")),
        )
        if item
    ).lower()
    if any(
        token in text for token in ("reversal", "rebound", "washout", "mean_revert")
    ):
        return -1.0
    return 1.0


def _is_hpairs_candidate(spec: CandidateSpec) -> bool:
    return (
        spec.family_template_id == HPAIRS_FAMILY_TEMPLATE_ID
        or spec.runtime_strategy_name == HPAIRS_RUNTIME_STRATEGY_NAME
    )


def _candidate_notional(spec: CandidateSpec) -> float:
    return _float_or_none(spec.strategy_overrides.get("max_notional_per_trade")) or 0.0


def _capacity_penalty_bps(
    *,
    spec: CandidateSpec,
    median_price: float,
    median_volume: float,
    median_spread_bps: float,
) -> float:
    notional = _candidate_notional(spec)
    if notional <= 0.0:
        return 0.0
    dollar_volume = max(0.0, median_price) * max(0.0, median_volume)
    if dollar_volume <= 0.0:
        return 25.0 + median_spread_bps
    participation = notional / dollar_volume
    return float(
        np.clip(
            sqrt(max(0.0, participation)) * 100.0 + median_spread_bps * 0.25, 0.0, 500.0
        )
    )


def _impact_capacity_lineage(
    *,
    spec: CandidateSpec,
    median_price: float,
    median_volume: float,
    median_spread_bps: float,
    capacity_penalty_bps: float,
) -> dict[str, Any]:
    """Return square-root/power-law impact context as non-authoritative metadata."""

    notional = _candidate_notional(spec)
    dollar_volume = max(0.0, median_price) * max(0.0, median_volume)
    participation_rate_proxy = notional / dollar_volume if dollar_volume > 0.0 else None
    blockers: list[str] = []
    if notional <= 0.0:
        blockers.append("candidate_notional_missing")
    if median_price <= 0.0:
        blockers.append("median_price_missing")
    if median_volume <= 0.0:
        blockers.append("median_volume_missing")
    return {
        "schema_version": "torghut.hpairs-impact-capacity-lineage.v1",
        "status": "available"
        if dollar_volume > 0.0 and notional > 0.0
        else "missing_inputs",
        "model": "square_root_power_law_impact_proxy",
        "source": "replay_tape_price_volume_spread_fields",
        "candidate_notional": str(_decimal(notional)),
        "median_price": str(_decimal(median_price)),
        "median_volume": str(_decimal(median_volume)),
        "dollar_volume_proxy": str(_decimal(dollar_volume)),
        "participation_rate_proxy": str(_decimal(participation_rate_proxy))
        if participation_rate_proxy is not None
        else None,
        "median_spread_bps": str(_decimal(median_spread_bps)),
        "capacity_penalty_bps": str(_decimal(capacity_penalty_bps)),
        "blockers": blockers,
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
        "requires_source_backed_adv": True,
    }


def _pair_convergence_risk(
    stats: Sequence[_SymbolMicrostructureStats],
) -> dict[str, Any]:
    """Return aligned-pair convergence risk for H-PAIRS ranking only."""

    if len(stats) < 2:
        return _empty_pair_convergence_risk(status="not_applicable_single_symbol")

    pair_payloads: list[dict[str, Any]] = []
    for left_index, left in enumerate(stats):
        for right in stats[left_index + 1 :]:
            payload = _pair_convergence_payload(left, right)
            if payload is not None:
                pair_payloads.append(payload)

    if not pair_payloads:
        return _empty_pair_convergence_risk(status="missing_common_price_timestamps")

    risk_scores = [
        _float_or_none(item.get("risk_score")) or 0.0 for item in pair_payloads
    ]
    convergence_scores = [
        _float_or_none(item.get("convergence_score")) or 0.0 for item in pair_payloads
    ]
    worst_pair = max(
        pair_payloads,
        key=lambda item: (
            _float_or_none(item.get("risk_score")) or 0.0,
            str(item.get("pair") or ""),
        ),
    )
    return {
        "schema_version": "torghut.hpairs-pair-convergence-risk.v1",
        "status": "available",
        "source": "aligned_replay_tape_mid_prices",
        "pair_count": len(pair_payloads),
        "common_sample_count": min(
            int(item.get("common_sample_count") or 0) for item in pair_payloads
        ),
        "risk_score": str(_decimal(max(risk_scores))),
        "convergence_score": str(_decimal(min(convergence_scores))),
        "worst_pair": worst_pair.get("pair"),
        "worst_pair_risk_score": worst_pair.get("risk_score"),
        "pair_details": pair_payloads,
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
        "final_promotion_allowed": False,
    }


def _pair_convergence_payload(
    left: _SymbolMicrostructureStats,
    right: _SymbolMicrostructureStats,
) -> dict[str, Any] | None:
    common_keys = sorted(
        set(left.price_by_timestamp).intersection(right.price_by_timestamp)
    )
    if len(common_keys) < 4:
        return None

    left_log = np.asarray(
        [log(left.price_by_timestamp[key]) for key in common_keys],
        dtype=np.float64,
    )
    right_log = np.asarray(
        [log(right.price_by_timestamp[key]) for key in common_keys],
        dtype=np.float64,
    )
    spread = left_log - right_log
    centered = spread - _mean(spread)
    lagged = centered[:-1]
    forward = centered[1:]
    denominator = float(np.sum(lagged * lagged))
    phi = float(np.sum(lagged * forward) / denominator) if denominator > 0.0 else 1.0
    phi_abs = min(abs(phi), 2.0)
    spread_change_bps = np.diff(spread) * 10_000.0
    spread_abs_bps = np.abs(centered) * 10_000.0
    spread_vol_bps = float(np.std(spread_change_bps)) if spread_change_bps.size else 0.0
    tail_abs_spread_bps = _percentile(spread_abs_bps, 95.0)
    mean_abs_spread_bps = _mean(spread_abs_bps)
    phi_risk = float(np.clip((phi_abs - 0.65) / 0.55, 0.0, 1.0))
    vol_risk = float(np.clip((spread_vol_bps - 5.0) / 35.0, 0.0, 1.0))
    level_risk = float(np.clip((tail_abs_spread_bps - 20.0) / 80.0, 0.0, 1.0))
    sample_penalty = float(np.clip((8.0 - len(common_keys)) / 8.0, 0.0, 1.0)) * 0.20
    risk_score = float(
        np.clip(
            0.50 * phi_risk + 0.30 * vol_risk + 0.20 * level_risk + sample_penalty,
            0.0,
            1.0,
        )
    )
    mean_reversion_score = float(np.clip(1.0 - min(phi_abs, 1.25) / 1.25, 0.0, 1.0))
    convergence_score = float(
        np.clip(
            0.70 * mean_reversion_score
            + 0.20 * (1.0 - vol_risk)
            + 0.10 * (1.0 - level_risk),
            0.0,
            1.0,
        )
    )
    return {
        "pair": f"{left.symbol}/{right.symbol}",
        "common_sample_count": len(common_keys),
        "ar1_phi": str(_decimal(phi)),
        "ar1_phi_abs": str(_decimal(phi_abs)),
        "mean_reversion_score": str(_decimal(mean_reversion_score)),
        "spread_vol_bps": str(_decimal(spread_vol_bps)),
        "mean_abs_spread_bps": str(_decimal(mean_abs_spread_bps)),
        "tail_abs_spread_bps": str(_decimal(tail_abs_spread_bps)),
        "risk_score": str(_decimal(risk_score)),
        "convergence_score": str(_decimal(convergence_score)),
    }


def _empty_pair_convergence_risk(*, status: str = "missing_inputs") -> dict[str, Any]:
    return {
        "schema_version": "torghut.hpairs-pair-convergence-risk.v1",
        "status": status,
        "source": "aligned_replay_tape_mid_prices",
        "pair_count": 0,
        "common_sample_count": 0,
        "risk_score": "0",
        "convergence_score": "0",
        "pair_details": [],
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
        "final_promotion_allowed": False,
    }


def _volume_score(values: NDArray[np.float64]) -> float:
    if values.size == 0:
        return 0.0
    return float(
        np.clip(log(1.0 + max(0.0, _percentile(values, 50.0))) / 12.0, 0.0, 1.0)
    )


__all__ = [name for name in globals() if not name.startswith("__")]
