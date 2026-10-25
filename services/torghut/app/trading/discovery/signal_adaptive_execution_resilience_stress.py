"""Preview-only signal-adaptive execution and liquidity-resilience stress.

This module converts recent optimal-execution papers into deterministic replay
ranking inputs. It tests whether a candidate's replay edge is robust after
accounting for signal-adaptive limit-order quoting, execution risk, inventory
risk, market impact, and stochastic liquidity resilience/regime shifts.

The output is a local offline replay prefilter only. It never models broker
fills as proof, writes runtime ledgers, relaxes promotion gates, or enables live
capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, log1p
from statistics import median
from typing import Any, cast

from app.trading.models import SignalEnvelope

SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_SCHEMA_VERSION = (
    "torghut.signal-adaptive-execution-resilience-stress.v1"
)
SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.signal-adaptive-execution-resilience-stress-contract.v1"
)
SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_PROOF_SEMANTICS_LABEL = (
    "signal_adaptive_execution_resilience_stress_preview_only_"
    "exact_replay_route_tca_order_lifecycle_runtime_ledger_required"
)
SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_PRIMARY_SOURCES: tuple[
    Mapping[str, str], ...
] = (
    {
        "source_id": "arxiv-2605.24242",
        "url": "https://arxiv.org/abs/2605.24242",
        "title": "Explicit Signal-Adaptive Sequential Optimal Execution Quotes",
        "date": "2026-05-22",
        "mechanism": (
            "signal_dependent_drift_limit_order_quotes_fill_intensity_"
            "inventory_risk_execution_risk_price_impact"
        ),
    },
    {
        "source_id": "arxiv-2506.11813",
        "url": "https://arxiv.org/abs/2506.11813",
        "title": "Optimal Execution under Liquidity Uncertainty",
        "date": "2025-06-13",
        "mechanism": (
            "general_lob_shape_market_impact_resilience_volume_effect_"
            "regime_switching_liquidity"
        ),
    },
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SIGNAL_FIELDS = (
    "signal_bps",
    "alpha_bps",
    "expected_return_bps",
    "predicted_return_bps",
    "drift_bps",
    "forecast_return_bps",
    "microprice_bias_bps",
)
_OFI_FIELDS = ("ofi", "order_flow_imbalance", "ofi_score", "signed_ofi")
_SPREAD_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_QUOTE_OFFSET_FIELDS = (
    "quote_offset_bps",
    "limit_quote_offset_bps",
    "passive_quote_offset_bps",
    "limit_offset_bps",
    "reservation_price_offset_bps",
)
_FILL_INTENSITY_FIELDS = (
    "fill_intensity",
    "fill_probability",
    "limit_fill_probability",
    "fill_rate",
    "arrival_intensity",
)
_INVENTORY_FIELDS = ("inventory", "position", "current_inventory", "net_position")
_TARGET_INVENTORY_FIELDS = ("target_inventory", "desired_inventory", "inventory_target")
_MAX_INVENTORY_FIELDS = (
    "max_inventory",
    "inventory_limit",
    "position_limit",
    "max_position",
)
_DEPTH_FIELDS = (
    "bid_size",
    "ask_size",
    "best_bid_size",
    "best_ask_size",
    "bid_depth",
    "ask_depth",
    "visible_depth",
    "book_depth",
)
_VOLUME_FIELDS = (
    "microbar_volume",
    "volume",
    "qty",
    "quantity",
    "trade_size",
    "last_size",
)
_IMPACT_FIELDS = ("impact_bps", "estimated_impact_bps", "market_impact_bps")
_EVENT_FIELDS = ("event_type", "order_event_type", "lob_event_type", "action", "type")
_SHOCK_TOKENS = frozenset(("trade", "fill", "execution", "market", "sweep"))
_MIN_FILL_PROBABILITY = 0.15
_DEPTH_SWITCH_LOG_THRESHOLD = 0.60
_SIGNAL_COST_BUFFER_BPS = 0.25


@dataclass(frozen=True)
class SignalAdaptiveExecutionResilienceStressSummary:
    row_count: int
    observed_signal_count: int
    observed_quote_offset_count: int
    observed_fill_intensity_count: int
    observed_inventory_count: int
    observed_depth_count: int
    median_signal_edge_bps: float
    median_quote_offset_bps: float
    median_fill_intensity: float
    signal_cost_mismatch_share: float
    quote_adaptation_gap_share: float
    fill_intensity_shortfall_share: float
    inventory_risk_pressure_score: float
    liquidity_regime_switch_share: float
    resilience_recovery_failure_share: float
    impact_resilience_mismatch_share: float
    missing_execution_metadata_score: float
    execution_resilience_gap_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_signal_adaptive_execution_resilience_stress_ranking",
            "source_papers": [
                dict(item)
                for item in SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_signal_count": self.observed_signal_count,
            "observed_quote_offset_count": self.observed_quote_offset_count,
            "observed_fill_intensity_count": self.observed_fill_intensity_count,
            "observed_inventory_count": self.observed_inventory_count,
            "observed_depth_count": self.observed_depth_count,
            "median_signal_edge_bps": _stable_float(self.median_signal_edge_bps),
            "median_quote_offset_bps": _stable_float(self.median_quote_offset_bps),
            "median_fill_intensity": _stable_float(self.median_fill_intensity),
            "signal_cost_mismatch_share": _stable_float(
                self.signal_cost_mismatch_share
            ),
            "quote_adaptation_gap_share": _stable_float(
                self.quote_adaptation_gap_share
            ),
            "fill_intensity_shortfall_share": _stable_float(
                self.fill_intensity_shortfall_share
            ),
            "inventory_risk_pressure_score": _stable_float(
                self.inventory_risk_pressure_score
            ),
            "liquidity_regime_switch_share": _stable_float(
                self.liquidity_regime_switch_share
            ),
            "resilience_recovery_failure_share": _stable_float(
                self.resilience_recovery_failure_share
            ),
            "impact_resilience_mismatch_share": _stable_float(
                self.impact_resilience_mismatch_share
            ),
            "missing_execution_metadata_score": _stable_float(
                self.missing_execution_metadata_score
            ),
            "execution_resilience_gap_score": _stable_float(
                self.execution_resilience_gap_score
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "signal_cost_mismatch_share": _stable_float(
                    self.signal_cost_mismatch_share
                ),
                "quote_adaptation_gap_share": _stable_float(
                    self.quote_adaptation_gap_share
                ),
                "fill_intensity_shortfall_share": _stable_float(
                    self.fill_intensity_shortfall_share
                ),
                "inventory_risk_pressure_score": _stable_float(
                    self.inventory_risk_pressure_score
                ),
                "liquidity_regime_switch_share": _stable_float(
                    self.liquidity_regime_switch_share
                ),
                "resilience_recovery_failure_share": _stable_float(
                    self.resilience_recovery_failure_share
                ),
                "impact_resilience_mismatch_share": _stable_float(
                    self.impact_resilience_mismatch_share
                ),
                "missing_execution_metadata_score": _stable_float(
                    self.missing_execution_metadata_score
                ),
                "execution_resilience_gap_score": _stable_float(
                    self.execution_resilience_gap_score
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "signal_adaptive_quote_preview": True,
            "fill_intensity_execution_risk_preview": True,
            "inventory_risk_preview": True,
            "liquidity_resilience_regime_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def signal_adaptive_execution_resilience_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item)
            for item in SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "signal_adaptive_quote_and_liquidity_resilience_replay_stress",
        "stress_components": [
            "signal_cost_mismatch_share",
            "quote_adaptation_gap_share",
            "fill_intensity_shortfall_share",
            "inventory_risk_pressure_score",
            "liquidity_regime_switch_share",
            "resilience_recovery_failure_share",
            "impact_resilience_mismatch_share",
            "missing_execution_metadata_score",
        ],
        "output_scope": "preview_replay_ranking_only",
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_signal_drift_as_fill_or_pnl_authority": True,
            "rejects_modeled_fill_intensity_as_runtime_ledger_authority": True,
            "rejects_liquidity_resilience_proxy_as_cost_proof": True,
        },
    }


def build_signal_adaptive_execution_resilience_stress_schema_hash() -> str:
    return _stable_hash(signal_adaptive_execution_resilience_stress_contract())


def extract_signal_adaptive_execution_resilience_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> SignalAdaptiveExecutionResilienceStressSummary:
    """Extract deterministic signal-adaptive execution stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    )
    schema_hash = build_signal_adaptive_execution_resilience_stress_schema_hash()
    if not ordered:
        return SignalAdaptiveExecutionResilienceStressSummary(
            row_count=0,
            observed_signal_count=0,
            observed_quote_offset_count=0,
            observed_fill_intensity_count=0,
            observed_inventory_count=0,
            observed_depth_count=0,
            median_signal_edge_bps=0.0,
            median_quote_offset_bps=0.0,
            median_fill_intensity=0.0,
            signal_cost_mismatch_share=0.0,
            quote_adaptation_gap_share=0.0,
            fill_intensity_shortfall_share=0.0,
            inventory_risk_pressure_score=0.0,
            liquidity_regime_switch_share=0.0,
            resilience_recovery_failure_share=0.0,
            impact_resilience_mismatch_share=0.0,
            missing_execution_metadata_score=1.0,
            execution_resilience_gap_score=1.0,
            replay_rank_penalty_bps=35.0,
            warnings=(
                "empty_replay_rows_for_signal_adaptive_execution_resilience_stress",
            ),
            feature_schema_hash=schema_hash,
        )

    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    warnings: set[str] = set()
    signal_edges: list[float] = []
    quote_offsets: list[float] = []
    fill_intensities: list[float] = []
    inventory_pressures: list[float] = []
    depths: list[float] = []
    impact_rows = 0
    mismatch_count = 0
    quote_gap_count = 0
    short_fill_count = 0
    impact_resilience_mismatch_count = 0
    prior_depth_by_symbol: dict[str, float] = {}
    prior_event_shock_by_symbol: dict[str, tuple[float, float]] = {}
    depth_switch_count = 0
    resilience_failure_count = 0
    depth_transition_count = 0

    for row in ordered:
        payload = row.payload
        signal_edge = _signal_edge_bps(payload, signed_direction)
        spread = _first_number(payload, _SPREAD_FIELDS)
        quote_offset = _first_number(payload, _QUOTE_OFFSET_FIELDS)
        fill_intensity = _first_number(payload, _FILL_INTENSITY_FIELDS)
        inventory_pressure = _inventory_pressure(payload)
        depth = _depth_proxy(payload)
        impact = _first_number(payload, _IMPACT_FIELDS)

        if signal_edge is not None:
            signal_edges.append(signal_edge)
        if quote_offset is not None:
            quote_offsets.append(abs(quote_offset))
        if fill_intensity is not None:
            fill_intensities.append(max(0.0, fill_intensity))
        if inventory_pressure is not None:
            inventory_pressures.append(inventory_pressure)
        if depth is not None and depth > 0.0:
            depths.append(depth)
            prior_depth = prior_depth_by_symbol.get(row.symbol)
            if prior_depth is not None and prior_depth > 0.0:
                depth_transition_count += 1
                if (
                    abs(log1p(depth) - log1p(prior_depth))
                    >= _DEPTH_SWITCH_LOG_THRESHOLD
                ):
                    depth_switch_count += 1
            shock = prior_event_shock_by_symbol.get(row.symbol)
            if shock is not None:
                shock_depth, shock_impact = shock
                if shock_depth > 0.0 and depth < shock_depth * 0.75:
                    resilience_failure_count += 1
                if shock_impact > 0.0 and depth < shock_depth * 0.75:
                    impact_resilience_mismatch_count += 1
            prior_depth_by_symbol[row.symbol] = depth

        if signal_edge is not None:
            cost_floor = (spread or 0.0) * 0.5 + abs(quote_offset or 0.0)
            if signal_edge <= cost_floor + _SIGNAL_COST_BUFFER_BPS:
                mismatch_count += 1
            if quote_offset is not None and abs(quote_offset) > max(
                0.5, abs(signal_edge) * 0.8
            ):
                quote_gap_count += 1
        if fill_intensity is not None and fill_intensity < _MIN_FILL_PROBABILITY:
            short_fill_count += 1
        if impact is not None:
            impact_rows += 1
        if depth is not None and impact is not None and _is_shock_event(payload):
            prior_event_shock_by_symbol[row.symbol] = (depth, abs(impact))

    signal_count = len(signal_edges)
    quote_count = len(quote_offsets)
    fill_count = len(fill_intensities)
    inventory_count = len(inventory_pressures)
    depth_count = len(depths)

    if signal_count == 0:
        warnings.add("missing_signal_drift_or_alpha_fields")
    if quote_count == 0:
        warnings.add("missing_limit_quote_offset_fields")
    if fill_count == 0:
        warnings.add("missing_fill_intensity_or_probability_fields")
    if inventory_count == 0:
        warnings.add("missing_inventory_risk_fields")
    if depth_count < 2:
        warnings.add("insufficient_depth_rows_for_liquidity_resilience_stress")
    if impact_rows == 0:
        warnings.add("missing_price_impact_fields_for_resilience_mismatch")

    observed_components = sum(
        1
        for count in (
            signal_count,
            quote_count,
            fill_count,
            inventory_count,
            depth_count,
            impact_rows,
        )
        if count > 0
    )
    missing_execution_metadata_score = 1.0 - observed_components / 6.0
    signal_cost_mismatch_share = mismatch_count / max(1, signal_count)
    quote_adaptation_gap_share = quote_gap_count / max(
        1, min(signal_count, quote_count)
    )
    fill_intensity_shortfall_share = short_fill_count / max(1, fill_count)
    liquidity_regime_switch_share = depth_switch_count / max(1, depth_transition_count)
    resilience_recovery_failure_share = resilience_failure_count / max(
        1, depth_transition_count
    )
    impact_resilience_mismatch_share = impact_resilience_mismatch_count / max(
        1, impact_rows
    )
    inventory_risk_pressure_score = (
        median(inventory_pressures) if inventory_pressures else 0.0
    )

    execution_resilience_gap_score = min(
        1.0,
        missing_execution_metadata_score * 0.20
        + signal_cost_mismatch_share * 0.18
        + quote_adaptation_gap_share * 0.14
        + fill_intensity_shortfall_share * 0.14
        + inventory_risk_pressure_score * 0.12
        + liquidity_regime_switch_share * 0.10
        + resilience_recovery_failure_share * 0.08
        + impact_resilience_mismatch_share * 0.04,
    )
    replay_rank_penalty_bps = min(95.0, 7.0 + execution_resilience_gap_score * 88.0)

    return SignalAdaptiveExecutionResilienceStressSummary(
        row_count=len(ordered),
        observed_signal_count=signal_count,
        observed_quote_offset_count=quote_count,
        observed_fill_intensity_count=fill_count,
        observed_inventory_count=inventory_count,
        observed_depth_count=depth_count,
        median_signal_edge_bps=median(signal_edges) if signal_edges else 0.0,
        median_quote_offset_bps=median(quote_offsets) if quote_offsets else 0.0,
        median_fill_intensity=median(fill_intensities) if fill_intensities else 0.0,
        signal_cost_mismatch_share=signal_cost_mismatch_share,
        quote_adaptation_gap_share=quote_adaptation_gap_share,
        fill_intensity_shortfall_share=fill_intensity_shortfall_share,
        inventory_risk_pressure_score=inventory_risk_pressure_score,
        liquidity_regime_switch_share=liquidity_regime_switch_share,
        resilience_recovery_failure_share=resilience_recovery_failure_share,
        impact_resilience_mismatch_share=impact_resilience_mismatch_share,
        missing_execution_metadata_score=missing_execution_metadata_score,
        execution_resilience_gap_score=execution_resilience_gap_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(warnings)),
        feature_schema_hash=schema_hash,
    )


def _signal_edge_bps(payload: Mapping[str, Any], direction: float) -> float | None:
    signal = _first_number(payload, _SIGNAL_FIELDS)
    if signal is not None:
        return direction * signal
    ofi = _first_number(payload, _OFI_FIELDS)
    if ofi is None:
        return None
    return direction * max(-10.0, min(10.0, ofi * 8.0))


def _inventory_pressure(payload: Mapping[str, Any]) -> float | None:
    inventory = _first_number(payload, _INVENTORY_FIELDS)
    if inventory is None:
        return None
    target = _first_number(payload, _TARGET_INVENTORY_FIELDS) or 0.0
    limit = _first_number(payload, _MAX_INVENTORY_FIELDS)
    denominator = max(
        1.0,
        abs(limit)
        if limit is not None and limit != 0.0
        else abs(inventory) + abs(target),
    )
    return min(1.0, abs(inventory - target) / denominator)


def _depth_proxy(payload: Mapping[str, Any]) -> float | None:
    explicit = _first_number(payload, _DEPTH_FIELDS)
    if explicit is not None:
        return explicit
    bid = _first_number(payload, ("bid_size", "bid_qty", "best_bid_size", "bid_depth"))
    ask = _first_number(payload, ("ask_size", "ask_qty", "best_ask_size", "ask_depth"))
    if bid is not None or ask is not None:
        return max(0.0, (bid or 0.0) + (ask or 0.0))
    return _first_number(payload, _VOLUME_FIELDS)


def _is_shock_event(payload: Mapping[str, Any]) -> bool:
    value = str(_first_value(payload, _EVENT_FIELDS) or "").lower()
    if any(token in value for token in _SHOCK_TOKENS):
        return True
    volume = _first_number(payload, _VOLUME_FIELDS)
    depth = _depth_proxy(payload)
    return volume is not None and depth is not None and volume > depth * 0.5


def _first_value(payload: Mapping[str, Any], fields: Sequence[str]) -> Any | None:
    for field in fields:
        if field in payload and payload[field] is not None:
            return payload[field]
    return None


def _first_number(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    value = _first_value(payload, fields)
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(number):
        return None
    return number


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return round(float(value), 6)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        _json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_ready(value: Any) -> Any:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[Any, Any], value)
        return {
            str(key): _json_ready(mapping[key])
            for key in sorted(mapping.keys(), key=str)
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_ready(item) for item in cast(Sequence[Any], value)]
    return value


__all__ = [
    "SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_PRIMARY_SOURCES",
    "SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_PROOF_SEMANTICS_LABEL",
    "SIGNAL_ADAPTIVE_EXECUTION_RESILIENCE_STRESS_SCHEMA_VERSION",
    "SignalAdaptiveExecutionResilienceStressSummary",
    "build_signal_adaptive_execution_resilience_stress_schema_hash",
    "extract_signal_adaptive_execution_resilience_stress",
    "signal_adaptive_execution_resilience_stress_contract",
]
