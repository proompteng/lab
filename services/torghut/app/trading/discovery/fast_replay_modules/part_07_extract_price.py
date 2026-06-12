# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Preview-only vectorized scoring over manifest-verified replay tapes."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timezone
from decimal import Decimal
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.adaptive_signal_falsification_stress import (
    extract_adaptive_signal_falsification_stress,
)
from app.trading.discovery.bootstrap_robust_optimization_stress import (
    extract_bootstrap_robust_optimization_stress,
)
from app.trading.discovery.adaptive_market_limit_allocation_stress import (
    extract_adaptive_market_limit_allocation_stress,
)
from app.trading.discovery.alpha_decay_predictability_stress import (
    extract_alpha_decay_predictability_stress,
)
from app.trading.discovery.counterfactual_regime_replay_stress import (
    extract_counterfactual_regime_replay_stress,
)
from app.trading.discovery.cost_aware_forecast_filter_stress import (
    extract_cost_aware_forecast_filter_stress,
)
from app.trading.discovery.cluster_lob_features import (
    HPAIRS_CLUSTER_LOB_FEATURE_SCHEMA_VERSION,
    extract_cluster_lob_features,
    extract_hawkes_excitation_summary,
)
from app.trading.discovery.execution_schedule_stress import (
    extract_execution_schedule_stress,
)
from app.trading.discovery.feed_lag_liquidity_stress import (
    extract_feed_lag_liquidity_stress,
)
from app.trading.discovery.hawkes_transient_impact_stress import (
    extract_hawkes_transient_impact_stress,
)
from app.trading.discovery.intraday_jump_burst_stress import (
    extract_intraday_jump_burst_stress,
)
from app.trading.discovery.intraday_price_path_asymmetry_stress import (
    extract_intraday_price_path_asymmetry_stress,
)
from app.trading.discovery.institutional_mechanism_fidelity_stress import (
    extract_institutional_mechanism_fidelity_stress,
)
from app.trading.discovery.lead_lag_cross_asset_stress import (
    extract_lead_lag_cross_asset_stress,
)
from app.trading.discovery.metaorder_adverse_selection_stress import (
    extract_metaorder_adverse_selection_stress,
)
from app.trading.discovery.lob_reality_gap_stress import (
    extract_lob_reality_gap_stress,
)
from app.trading.discovery.microstructure_regime_tokenization_stress import (
    extract_microstructure_regime_tokenization_stress,
)
from app.trading.discovery.microstructure_prefilter import (
    HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL,
    HPAIRS_PREFILTER_PROOF_SOURCE,
    build_hpairs_microstructure_prefilter,
)
from app.trading.discovery.nonlinear_impact_execution_stress import (
    extract_nonlinear_impact_execution_stress,
)
from app.trading.discovery.order_book_observability_stress import (
    extract_order_book_observability_stress,
)
from app.trading.discovery.ofi_response_horizon_stress import (
    extract_ofi_response_horizon_stress,
)
from app.trading.discovery.option_gamma_flow_stress import (
    extract_option_gamma_flow_stress,
)
from app.trading.discovery.order_transition_stress import (
    extract_order_transition_stress,
)
from app.trading.discovery.order_flow_entropy_regime_stress import (
    extract_order_flow_entropy_regime_stress,
)
from app.trading.discovery.queue_survival_fill_stress import (
    extract_queue_survival_fill_stress,
)
from app.trading.discovery.rough_flow_volatility_stress import (
    extract_rough_flow_volatility_stress,
)
from app.trading.discovery.signal_adaptive_execution_resilience_stress import (
    extract_signal_adaptive_execution_resilience_stress,
)
from app.trading.discovery.stochastic_liquidity_resilience_stress import (
    extract_stochastic_liquidity_resilience_stress,
)
from app.trading.discovery.replay_tape import ReplayTapeManifest
from app.trading.models import SignalEnvelope

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_108 import *
from .part_02_fastreplaypreviewresult import *
from .part_03_candidate_clusterlob_feature_lane import *
from .part_04_score_candidate_spec import *
from .part_05_preview_rank_key import *
from .part_06_frontier_selection_blockers_for_row import *


@dataclass(frozen=True)
class _StressPenaltyReason:
    value: Callable[[FastReplayPreviewRow], float]
    risk_flag: str
    ranking_reason: str
    veto_reason: str


_STRESS_PENALTY_REASONS: tuple[_StressPenaltyReason, ...] = (
    _StressPenaltyReason(
        _order_book_observability_rank_penalty_bps,
        "order_book_observability_stress_penalty_active",
        "order_book_observability_stress_downranks_only",
        "order_book_observability_stress_penalty",
    ),
    _StressPenaltyReason(
        _order_transition_rank_penalty_bps,
        "order_transition_stress_penalty_active",
        "order_transition_stress_downranks_only",
        "order_transition_stress_penalty",
    ),
    _StressPenaltyReason(
        _order_flow_entropy_regime_rank_penalty_bps,
        "order_flow_entropy_regime_stress_penalty_active",
        "order_flow_entropy_regime_stress_downranks_only",
        "order_flow_entropy_regime_stress_penalty",
    ),
    _StressPenaltyReason(
        _lead_lag_cross_asset_rank_penalty_bps,
        "lead_lag_cross_asset_stress_penalty_active",
        "lead_lag_cross_asset_stress_downranks_only",
        "lead_lag_cross_asset_stress_penalty",
    ),
    _StressPenaltyReason(
        _queue_survival_fill_rank_penalty_bps,
        "queue_survival_fill_stress_penalty_active",
        "queue_survival_fill_stress_downranks_only",
        "queue_survival_fill_stress_penalty",
    ),
    _StressPenaltyReason(
        _feed_lag_liquidity_rank_penalty_bps,
        "feed_lag_liquidity_stress_penalty_active",
        "feed_lag_liquidity_stress_downranks_only",
        "feed_lag_liquidity_stress_penalty",
    ),
    _StressPenaltyReason(
        _lob_reality_gap_rank_penalty_bps,
        "lob_reality_gap_stress_penalty_active",
        "lob_reality_gap_stress_downranks_only",
        "lob_reality_gap_stress_penalty",
    ),
    _StressPenaltyReason(
        _alpha_decay_predictability_rank_penalty_bps,
        "alpha_decay_predictability_stress_penalty_active",
        "alpha_decay_predictability_stress_downranks_only",
        "alpha_decay_predictability_stress_penalty",
    ),
    _StressPenaltyReason(
        _counterfactual_regime_rank_penalty_bps,
        "counterfactual_regime_replay_stress_penalty_active",
        "counterfactual_regime_replay_stress_downranks_only",
        "counterfactual_regime_replay_stress_penalty",
    ),
    _StressPenaltyReason(
        _nonlinear_impact_execution_rank_penalty_bps,
        "nonlinear_impact_execution_stress_penalty_active",
        "nonlinear_impact_execution_stress_downranks_only",
        "nonlinear_impact_execution_stress_penalty",
    ),
    _StressPenaltyReason(
        _option_gamma_flow_rank_penalty_bps,
        "option_gamma_flow_stress_penalty_active",
        "option_gamma_flow_stress_downranks_only",
        "option_gamma_flow_stress_penalty",
    ),
    _StressPenaltyReason(
        _intraday_jump_burst_rank_penalty_bps,
        "intraday_jump_burst_stress_penalty_active",
        "intraday_jump_burst_stress_downranks_only",
        "intraday_jump_burst_stress_penalty",
    ),
    _StressPenaltyReason(
        _intraday_price_path_asymmetry_rank_penalty_bps,
        "intraday_price_path_asymmetry_stress_penalty_active",
        "intraday_price_path_asymmetry_stress_downranks_only",
        "intraday_price_path_asymmetry_stress_penalty",
    ),
    _StressPenaltyReason(
        _rough_flow_volatility_rank_penalty_bps,
        "rough_flow_volatility_stress_penalty_active",
        "rough_flow_volatility_stress_downranks_only",
        "rough_flow_volatility_stress_penalty",
    ),
    _StressPenaltyReason(
        _institutional_mechanism_fidelity_rank_penalty_bps,
        "institutional_mechanism_fidelity_stress_penalty_active",
        "institutional_mechanism_fidelity_stress_downranks_only",
        "institutional_mechanism_fidelity_stress_penalty",
    ),
    _StressPenaltyReason(
        _signal_adaptive_execution_resilience_rank_penalty_bps,
        "signal_adaptive_execution_resilience_stress_penalty_active",
        "signal_adaptive_execution_resilience_stress_downranks_only",
        "signal_adaptive_execution_resilience_stress_penalty",
    ),
    _StressPenaltyReason(
        _stochastic_liquidity_resilience_rank_penalty_bps,
        "stochastic_liquidity_resilience_stress_penalty_active",
        "stochastic_liquidity_resilience_stress_downranks_only",
        "stochastic_liquidity_resilience_stress_penalty",
    ),
    _StressPenaltyReason(
        _microstructure_regime_tokenization_rank_penalty_bps,
        "microstructure_regime_tokenization_stress_penalty_active",
        "microstructure_regime_tokenization_stress_downranks_only",
        "microstructure_regime_tokenization_stress_penalty",
    ),
    _StressPenaltyReason(
        _cost_aware_forecast_filter_rank_penalty_bps,
        "cost_aware_forecast_filter_stress_penalty_active",
        "cost_aware_forecast_filter_stress_downranks_only",
        "cost_aware_forecast_filter_stress_penalty",
    ),
    _StressPenaltyReason(
        _adaptive_market_limit_allocation_rank_penalty_bps,
        "adaptive_market_limit_allocation_stress_penalty_active",
        "adaptive_market_limit_allocation_stress_downranks_only",
        "adaptive_market_limit_allocation_stress_penalty",
    ),
    _StressPenaltyReason(
        _metaorder_adverse_selection_rank_penalty_bps,
        "metaorder_adverse_selection_stress_penalty_active",
        "metaorder_adverse_selection_stress_downranks_only",
        "metaorder_adverse_selection_stress_penalty",
    ),
    _StressPenaltyReason(
        _hawkes_transient_impact_rank_penalty_bps,
        "hawkes_transient_impact_stress_penalty_active",
        "hawkes_transient_impact_stress_downranks_only",
        "hawkes_transient_impact_stress_penalty",
    ),
    _StressPenaltyReason(
        _ofi_response_horizon_rank_penalty_bps,
        "ofi_response_horizon_stress_penalty_active",
        "ofi_response_horizon_stress_downranks_only",
        "ofi_response_horizon_stress_penalty",
    ),
    _StressPenaltyReason(
        _bootstrap_robust_optimization_rank_penalty_bps,
        "bootstrap_robust_optimization_stress_penalty_active",
        "bootstrap_robust_optimization_stress_downranks_only",
        "bootstrap_robust_optimization_stress_penalty",
    ),
)


def _positive_stress_risk_flags(row: FastReplayPreviewRow) -> list[str]:
    return [
        reason.risk_flag for reason in _STRESS_PENALTY_REASONS if reason.value(row) > 0
    ]


def _positive_stress_ranking_reasons(row: FastReplayPreviewRow) -> list[str]:
    return [
        reason.ranking_reason
        for reason in _STRESS_PENALTY_REASONS
        if reason.value(row) > 0
    ]


def _positive_stress_veto_reasons(row: FastReplayPreviewRow) -> list[str]:
    return [
        reason.veto_reason
        for reason in _STRESS_PENALTY_REASONS
        if reason.value(row) > 0
    ]


def _adaptive_signal_falsification(row: FastReplayPreviewRow) -> dict[str, Any]:
    return _mapping(row.adaptive_signal_falsification_stress)


def _adaptive_signal_falsification_failed(row: FastReplayPreviewRow) -> bool:
    stress = _adaptive_signal_falsification(row)
    return bool(stress) and not bool(stress.get("adaptive_signal_falsification_passed"))


def _extract_price(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    for key in ("price", "mid_price", "mid", "mark", "last_price", "close"):
        value = _float_or_none(payload.get(key))
        if value is not None and value > 0.0:
            return value
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        return (bid + ask) / 2.0
    return None


def _extract_spread_bps(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    explicit = _float_or_none(payload.get("spread_bps"))
    if explicit is not None:
        return max(0.0, explicit)
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask >= bid:
        return (ask - bid) / ((ask + bid) / 2.0) * 10_000.0
    spread = _float_or_none(payload.get("spread"))
    price = _extract_price(signal)
    if spread is not None and price is not None and price > 0.0:
        return max(0.0, spread / price * 10_000.0)
    return None


def _bounded_ofi_pressure(value: float | None) -> float | None:
    if value is None:
        return None
    if -1.0 <= value <= 1.0:
        return value
    return float(np.tanh(value / 100.0))


def _extract_payload_ofi_pressure(payload: Mapping[str, Any]) -> float | None:
    for key in (
        "ofi_pressure_score",
        "order_flow_imbalance",
        "ofi",
        "signed_order_flow_imbalance",
        "queue_imbalance",
        "book_imbalance",
        "depth_imbalance",
    ):
        pressure = _bounded_ofi_pressure(_float_or_none(payload.get(key)))
        if pressure is not None:
            return pressure
    return None


def _mean_bounded_ofi_pressure(values: Sequence[float]) -> float | None:
    if not values:
        return None
    mean_value = float(np.mean(np.asarray(values, dtype=np.float64)))
    return _bounded_ofi_pressure(mean_value)


def _hpairs_ofi_values(signal: SignalEnvelope) -> list[float]:
    hpairs_ofi = _mapping(
        _hpairs_replay_tape_features(signal).get("order_flow_imbalance_horizons")
    )
    values = [
        value
        for horizon in ("instant", "1", "3", "12", "36")
        if (value := _float_or_none(hpairs_ofi.get(horizon))) is not None
    ]
    if values:
        return values
    return [
        parsed
        for value in hpairs_ofi.values()
        if (parsed := _float_or_none(value)) is not None
    ]


def _hpairs_ofi_memory_values(signal: SignalEnvelope) -> list[float]:
    hpairs_memory_regime = _mapping(
        _hpairs_replay_tape_features(signal).get("ofi_memory_regime_slices")
    )
    hpairs_memory_horizons = _mapping(hpairs_memory_regime.get("horizons"))
    return [
        value
        for horizon in ("instant", "short", "medium", "long")
        if (value := _float_or_none(hpairs_memory_horizons.get(horizon))) is not None
    ]


def _extract_ofi_pressure(signal: SignalEnvelope) -> float | None:
    payload_pressure = _extract_payload_ofi_pressure(signal.payload)
    if payload_pressure is not None:
        return payload_pressure
    hpairs_pressure = _mean_bounded_ofi_pressure(_hpairs_ofi_values(signal))
    if hpairs_pressure is not None:
        return hpairs_pressure
    memory_pressure = _mean_bounded_ofi_pressure(_hpairs_ofi_memory_values(signal))
    if memory_pressure is not None:
        return memory_pressure
    return _extract_quote_depth_imbalance(signal)


def _extract_ofi_memory_regime_score(signal: SignalEnvelope) -> float | None:
    hpairs_features = _hpairs_replay_tape_features(signal)
    memory_regime = _mapping(hpairs_features.get("ofi_memory_regime_slices"))
    for key in ("directional_alignment_score", "memory_score", "shock_score"):
        value = _float_or_none(memory_regime.get(key))
        if value is not None:
            return float(np.clip(value, -1.0, 1.0))
    decay_memory = _mapping(hpairs_features.get("ofi_decay_memory"))
    values = [
        value
        for item in decay_memory.values()
        if (value := _float_or_none(item)) is not None
    ]
    if not values:
        return None
    return float(np.clip(np.mean(np.asarray(values, dtype=np.float64)), -1.0, 1.0))


def _extract_quote_depth_imbalance(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    bid_size = _first_float(
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
    ask_size = _first_float(
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


def _extract_microprice_bias_bps(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    bid = _first_float(payload, ("bid", "best_bid", "bid_price", "best_bid_price"))
    ask = _first_float(payload, ("ask", "best_ask", "ask_price", "best_ask_price"))
    explicit_microprice = _first_float(payload, ("microprice", "micro_price"))
    price = _extract_price(signal)
    if explicit_microprice is not None and price is not None and price > 0.0:
        return (explicit_microprice - price) / price * 10_000.0

    bid_size = _first_float(
        payload, ("bid_size", "bid_qty", "best_bid_size", "best_bid_qty")
    )
    ask_size = _first_float(
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


def _extract_volume(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    return _first_float(
        payload,
        ("microbar_volume", "bar_volume", "trade_volume", "volume", "qty", "size"),
        positive=True,
    )


def _impact_liquidity_penalty_bps(
    *, median_spread_bps: float, spread_tail_bps: float, median_volume: float
) -> float:
    volume_penalty = 25.0 / max(1.0, np.log1p(max(0.0, median_volume)))
    return max(0.0, median_spread_bps * 0.5 + spread_tail_bps * 0.5 + volume_penalty)


def _weighted_average(values: Sequence[tuple[float, int]]) -> float:
    total_weight = sum(max(0, weight) for _, weight in values)
    if total_weight <= 0:
        return 0.0
    return sum(value * max(0, weight) for value, weight in values) / total_weight


def _first_float(
    payload: Mapping[str, Any], keys: Sequence[str], *, positive: bool = False
) -> float | None:
    for key in keys:
        value = _float_or_none(payload.get(key))
        if value is None:
            continue
        if positive and value <= 0.0:
            continue
        return value
    return None


def _float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(parsed):
        return None
    return parsed


def _hpairs_replay_tape_features(signal: SignalEnvelope) -> dict[str, Any]:
    raw = signal.payload.get("hpairs_replay_tape_features") or signal.payload.get(
        "hpairs_features"
    )
    if not isinstance(raw, Mapping):
        return {}
    return dict(cast(Mapping[str, Any], raw))


def _decimal_from_float(value: float) -> Decimal:
    return Decimal(str(round(float(value), 8)))


def _decimal_string_from_float(value: float) -> str:
    return str(_decimal_from_float(value))


def _observed_post_cost_expectancy_bps(row: FastReplayPreviewRow) -> Decimal:
    return (
        row.signed_return_bps - row.median_spread_bps - row.impact_liquidity_penalty_bps
    )


def _required_daily_notional_for_target(expectancy_bps: Decimal) -> Decimal | None:
    if expectancy_bps <= 0:
        return None
    return FAST_REPLAY_TARGET_NET_PNL_PER_DAY / (expectancy_bps / Decimal("10000"))


def _lineage_blockers_for_row(row: FastReplayPreviewRow) -> tuple[str, ...]:
    blockers = [
        "source_backed_adv_missing",
        "adv_as_of_missing",
        "source_backed_cost_impact_model_required",
        "exact_replay_required",
        "live_paper_runtime_ledger_required",
    ]
    blockers.extend(_exact_replay_selection_blockers_for_row(row))
    cache_identity = _mapping(row.replay_tape_cache_identity)
    if cache_identity:
        blockers.extend(
            str(blocker)
            for blocker in _string_tuple(cache_identity.get("blockers"))
            if str(blocker).strip()
        )
    if _observed_post_cost_expectancy_bps(row) <= 0:
        blockers.append("positive_post_cost_expectancy_missing")
        blockers.append("target_implied_notional_blocked_non_positive_expectancy")
    source_input_blockers = row.microstructure_prefilter.get("source_input_blockers")
    if isinstance(source_input_blockers, Sequence) and not isinstance(
        source_input_blockers, (str, bytes, bytearray)
    ):
        if source_input_blockers:
            blockers.append("hpairs_prefilter_source_inputs_missing")
    return tuple(blockers)


def _risk_flags_for_row(
    row: FastReplayPreviewRow, *, lineage_blockers: Sequence[str]
) -> tuple[str, ...]:
    flags = set(lineage_blockers)
    if row.macro_stress_veto_score > 0:
        flags.add("macro_news_stress_veto_active")
    if row.conformal_tail_risk_penalty_bps > 0:
        flags.add("conformal_tail_risk_penalty_active")
    if row.square_root_impact_capacity_penalty_bps > 0:
        flags.add("square_root_impact_capacity_penalty_active")
    flags.update(_positive_stress_risk_flags(row))
    if _adaptive_signal_falsification_failed(row):
        flags.add("adaptive_signal_falsification_incomplete_or_failed")
    if row.matched_symbol_count < row.requested_symbol_count:
        flags.add("partial_symbol_coverage")
    if row.trading_day_count <= 0:
        flags.add("no_trading_day_coverage")
    if row.selection_reason == "insufficient_replay_tape_rows":
        flags.add("insufficient_replay_tape_rows")
    return tuple(sorted(flags))


def _ranking_only_reasons_for_row(
    row: FastReplayPreviewRow, *, lineage_blockers: Sequence[str]
) -> tuple[str, ...]:
    reasons = {
        "preview_rank_score_is_prefilter_only",
        "clusterlob_ofi_regime_news_impact_bootstrap_conformal_features_rank_only",
        "exact_replay_required_before_any_promotion_claim",
        "runtime_ledger_required_before_any_profitability_claim",
    }
    if row.robust_lower_percentile_post_cost_utility_bps != 0:
        reasons.add("robust_lower_percentile_post_cost_utility_used_for_ranking")
    if row.bootstrap_lower_percentile_post_cost_utility_bps != 0:
        reasons.add("bootstrap_lower_percentile_post_cost_utility_used_for_ranking")
    if row.macro_stress_veto_score > 0:
        reasons.add("macro_news_ofi_stress_slice_downranks_only")
    if row.conformal_tail_risk_penalty_bps > 0:
        reasons.add("conformal_tail_risk_buffer_downranks_only")
    if row.square_root_impact_capacity_penalty_bps > 0:
        reasons.add("square_root_impact_capacity_cap_downranks_only")
    reasons.update(_positive_stress_ranking_reasons(row))
    adaptive_signal_falsification = _adaptive_signal_falsification(row)
    if adaptive_signal_falsification:
        reasons.add("adaptive_signal_falsification_evidence_collection_only")
        if not bool(
            adaptive_signal_falsification.get("adaptive_signal_falsification_passed")
        ):
            reasons.add("adaptive_signal_falsification_incomplete_blocks_promotion")
    if row.selection_reason == "insufficient_replay_tape_rows":
        reasons.add("missing_replay_tape_source_data_explicit_blocker")
    if lineage_blockers:
        reasons.add("lineage_blockers_reported_not_fabricated")
    return tuple(sorted(reasons))


def _risk_veto_reasons_for_row(
    row: FastReplayPreviewRow,
    *,
    risk_flags: Sequence[str],
    lineage_blockers: Sequence[str],
) -> tuple[str, ...]:
    vetoes = {str(flag) for flag in risk_flags if str(flag).strip()}
    vetoes.update(str(blocker) for blocker in lineage_blockers if str(blocker).strip())
    if row.macro_stress_veto_score > 0:
        vetoes.add("macro_news_stress_slice_veto_or_downrank")
    if row.liquidity_regime_score <= 0 and row.matched_row_count > 0:
        vetoes.add("liquidity_regime_unobserved_or_weak")
    if row.square_root_impact_capacity_penalty_bps > 0:
        vetoes.add("square_root_impact_capacity_penalty")
    vetoes.update(_positive_stress_veto_reasons(row))
    if _adaptive_signal_falsification_failed(row):
        vetoes.add("adaptive_signal_falsification_incomplete_or_failed")
    if row.robust_lower_percentile_post_cost_utility_bps <= 0:
        vetoes.add("robust_lower_percentile_post_cost_utility_not_positive")
    return tuple(sorted(vetoes))


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return ()
    sequence = cast(Sequence[Any], value)
    return tuple(str(item) for item in sequence if str(item).strip())


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        _json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_ready(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        mapping = cast(Mapping[Any, Any], value)
        ready: dict[str, Any] = {}
        for key in sorted(mapping.keys(), key=str):
            ready[str(key)] = _json_ready(mapping[key])
        return ready
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        sequence = cast(Sequence[Any], value)
        return [_json_ready(item) for item in sequence]
    return value


def _string(value: Any) -> str:
    return str(value or "").strip()


__all__ = [
    "FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION",
    "FAST_REPLAY_PREVIEW_SCHEMA_VERSION",
    "FAST_REPLAY_PROOF_SEMANTICS_LABEL",
    "FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT",
    "FAST_REPLAY_DEFAULT_EXPLORATION_COUNT",
    "FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP",
    "FAST_REPLAY_WHITEPAPER_MECHANISMS",
    "FastReplayPreviewResult",
    "FastReplayPreviewRow",
    "build_fast_replay_preview",
]


__all__ = [name for name in globals() if not name.startswith("__")]
