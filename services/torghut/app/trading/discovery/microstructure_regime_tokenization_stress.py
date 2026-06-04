"""Preview-only microstructure regime/tokenization replay stress.

This module converts current 2025-2026 market-microstructure papers into
executable replay-ranking inputs. It checks whether a candidate's local replay
rows contain enough event-time, scale-invariant, multi-modal order-flow context
to support early latent-regime detection and realistic trade-flow/token replay.

The output is a deterministic offline prefilter only. It never generates
synthetic market paths, treats model rollouts as PnL proof, writes runtime
ledgers, relaxes promotion gates, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from statistics import median
from typing import Any, cast

from app.trading.models import SignalEnvelope

MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_SCHEMA_VERSION = (
    "torghut.microstructure-regime-tokenization-stress.v1"
)
MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.microstructure-regime-tokenization-stress-contract.v1"
)
MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PROOF_SEMANTICS_LABEL = (
    "microstructure_regime_tokenization_stress_preview_only_"
    "exact_replay_route_tca_order_lifecycle_runtime_ledger_required"
)
MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PRIMARY_SOURCES: tuple[
    Mapping[str, str], ...
] = (
    {
        "source_id": "arxiv-2604.20949",
        "url": "https://arxiv.org/abs/2604.20949",
        "title": "Early Detection of Latent Microstructure Regimes in Limit Order Books",
        "date": "2026-04-22",
        "mechanism": (
            "latent_build_up_regime_rising_edge_adaptive_threshold_"
            "positive_lead_time_detection"
        ),
    },
    {
        "source_id": "arxiv-2602.23784",
        "url": "https://arxiv.org/abs/2602.23784",
        "title": "TradeFM: A Generative Foundation Model for Trade-flow and Market Microstructure",
        "date": "2026-02-27",
        "mechanism": (
            "scale_invariant_trade_flow_features_universal_tokenization_"
            "stylized_fact_replay_alignment"
        ),
    },
    {
        "source_id": "arxiv-2508.02247",
        "url": "https://arxiv.org/abs/2508.02247",
        "title": "ByteGen: A Tokenizer-Free Generative Model for Orderbook Events in Byte Space",
        "date": "2025-08-07",
        "mechanism": (
            "raw_orderbook_event_precision_message_sequence_fidelity_"
            "without_lossy_binning"
        ),
    },
)

_EVENT_TYPE_FIELDS = (
    "event_type",
    "order_event_type",
    "lob_event_type",
    "message_type",
    "action",
    "type",
)
_SIDE_FIELDS = (
    "side",
    "trade_side",
    "aggressor_side",
    "trade_direction",
    "execution_side",
)
_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SIZE_FIELDS = (
    "trade_size",
    "trade_qty",
    "last_size",
    "qty",
    "quantity",
    "volume",
    "microbar_volume",
)
_SPREAD_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
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
_OFI_FIELDS = (
    "ofi",
    "order_flow_imbalance",
    "order_flow_imbalance_score",
    "signed_order_flow",
    "trade_imbalance",
    "queue_imbalance",
    "book_imbalance",
)
_RETURN_BPS_FIELDS = (
    "signed_return_bps",
    "return_bps",
    "future_return_bps",
    "realized_return_bps",
    "next_return_bps",
)
_RAW_EVENT_FIELDS = (
    "raw_event_bytes",
    "raw_message_bytes",
    "packed_event_bytes",
    "message_bytes",
    "raw_lob_event",
    "raw_message",
    "event_payload_bytes",
)
_BINNED_FIELD_TOKENS = ("bin", "bucket", "quantile", "token")
_MIN_EARLY_WARNING_ROWS = 4
_EARLY_WARNING_LOOKAHEAD = 4


@dataclass(frozen=True)
class MicrostructureRegimeTokenizationStressSummary:
    row_count: int
    observed_event_type_count: int
    observed_side_count: int
    observed_price_count: int
    observed_size_count: int
    observed_spread_count: int
    observed_depth_count: int
    observed_ofi_count: int
    observed_raw_event_count: int
    observed_sequence_count: int
    event_alphabet_size: int
    dominant_event_type_share: float
    scale_invariant_feature_coverage_score: float
    universal_tokenization_gap_score: float
    byte_stream_precision_gap_score: float
    binned_numeric_field_share: float
    latent_regime_trigger_count: int
    latent_regime_stress_event_count: int
    latent_regime_lead_coverage: float
    mean_positive_lead_steps: float
    reactive_detection_gap_score: float
    stylized_fact_gap_score: float
    signed_return_autocorr_abs: float
    abs_return_clustering_score: float
    tail_event_share: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_microstructure_regime_tokenization_stress_ranking",
            "source_papers": [
                dict(item)
                for item in MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_event_type_count": self.observed_event_type_count,
            "observed_side_count": self.observed_side_count,
            "observed_price_count": self.observed_price_count,
            "observed_size_count": self.observed_size_count,
            "observed_spread_count": self.observed_spread_count,
            "observed_depth_count": self.observed_depth_count,
            "observed_ofi_count": self.observed_ofi_count,
            "observed_raw_event_count": self.observed_raw_event_count,
            "observed_sequence_count": self.observed_sequence_count,
            "event_alphabet_size": self.event_alphabet_size,
            "dominant_event_type_share": _stable_float(self.dominant_event_type_share),
            "scale_invariant_feature_coverage_score": _stable_float(
                self.scale_invariant_feature_coverage_score
            ),
            "universal_tokenization_gap_score": _stable_float(
                self.universal_tokenization_gap_score
            ),
            "byte_stream_precision_gap_score": _stable_float(
                self.byte_stream_precision_gap_score
            ),
            "binned_numeric_field_share": _stable_float(
                self.binned_numeric_field_share
            ),
            "latent_regime_trigger_count": self.latent_regime_trigger_count,
            "latent_regime_stress_event_count": self.latent_regime_stress_event_count,
            "latent_regime_lead_coverage": _stable_float(
                self.latent_regime_lead_coverage
            ),
            "mean_positive_lead_steps": _stable_float(self.mean_positive_lead_steps),
            "reactive_detection_gap_score": _stable_float(
                self.reactive_detection_gap_score
            ),
            "stylized_fact_gap_score": _stable_float(self.stylized_fact_gap_score),
            "signed_return_autocorr_abs": _stable_float(
                self.signed_return_autocorr_abs
            ),
            "abs_return_clustering_score": _stable_float(
                self.abs_return_clustering_score
            ),
            "tail_event_share": _stable_float(self.tail_event_share),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "universal_tokenization_gap_score": _stable_float(
                    self.universal_tokenization_gap_score
                ),
                "byte_stream_precision_gap_score": _stable_float(
                    self.byte_stream_precision_gap_score
                ),
                "binned_numeric_field_share": _stable_float(
                    self.binned_numeric_field_share
                ),
                "dominant_event_type_share": _stable_float(
                    self.dominant_event_type_share
                ),
                "latent_regime_lead_coverage": _stable_float(
                    self.latent_regime_lead_coverage
                ),
                "mean_positive_lead_steps": _stable_float(
                    self.mean_positive_lead_steps
                ),
                "reactive_detection_gap_score": _stable_float(
                    self.reactive_detection_gap_score
                ),
                "stylized_fact_gap_score": _stable_float(self.stylized_fact_gap_score),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "latent_regime_early_warning_preview": True,
            "scale_invariant_tokenization_preview": True,
            "raw_event_precision_fidelity_preview": True,
            "stylized_fact_replay_alignment_preview": True,
            "synthetic_rollout_generation": False,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": (
                MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PROOF_SEMANTICS_LABEL
            ),
        }


def microstructure_regime_tokenization_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item)
            for item in MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "latent_regime_early_warning_and_tradeflow_tokenization_replay_stress",
        "stress_components": [
            "universal_tokenization_gap_score",
            "byte_stream_precision_gap_score",
            "binned_numeric_field_share",
            "dominant_event_type_share",
            "latent_regime_lead_coverage",
            "reactive_detection_gap_score",
            "stylized_fact_gap_score",
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
            "rejects_synthetic_rollouts_as_pnl_authority": True,
            "rejects_tokenized_tradeflow_as_runtime_ledger_authority": True,
            "rejects_latent_regime_trigger_as_promotion_proof": True,
        },
    }


def build_microstructure_regime_tokenization_stress_schema_hash() -> str:
    return _stable_hash(microstructure_regime_tokenization_stress_contract())


def extract_microstructure_regime_tokenization_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> MicrostructureRegimeTokenizationStressSummary:
    """Extract deterministic event-stream/regime stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    )
    schema_hash = build_microstructure_regime_tokenization_stress_schema_hash()
    if not ordered:
        return MicrostructureRegimeTokenizationStressSummary(
            row_count=0,
            observed_event_type_count=0,
            observed_side_count=0,
            observed_price_count=0,
            observed_size_count=0,
            observed_spread_count=0,
            observed_depth_count=0,
            observed_ofi_count=0,
            observed_raw_event_count=0,
            observed_sequence_count=0,
            event_alphabet_size=0,
            dominant_event_type_share=0.0,
            scale_invariant_feature_coverage_score=0.0,
            universal_tokenization_gap_score=1.0,
            byte_stream_precision_gap_score=1.0,
            binned_numeric_field_share=0.0,
            latent_regime_trigger_count=0,
            latent_regime_stress_event_count=0,
            latent_regime_lead_coverage=0.0,
            mean_positive_lead_steps=0.0,
            reactive_detection_gap_score=1.0,
            stylized_fact_gap_score=1.0,
            signed_return_autocorr_abs=0.0,
            abs_return_clustering_score=0.0,
            tail_event_share=0.0,
            replay_rank_penalty_bps=45.0,
            warnings=(
                "empty_replay_rows_for_microstructure_regime_tokenization_stress",
            ),
            feature_schema_hash=schema_hash,
        )

    row_count = len(ordered)
    warnings: set[str] = set()
    event_type_counts: dict[str, int] = {}
    observed_event_type_count = 0
    observed_side_count = 0
    observed_price_count = 0
    observed_size_count = 0
    observed_spread_count = 0
    observed_depth_count = 0
    observed_ofi_count = 0
    observed_raw_event_count = 0
    observed_sequence_count = 0
    binned_numeric_field_count = 0
    numeric_field_count = 0
    returns_bps: list[float] = []
    by_symbol: dict[str, list[_MicrostructureObservation]] = {}
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0

    for row in ordered:
        payload = row.payload
        event_type = _event_type(payload)
        side = _first_value(payload, _SIDE_FIELDS)
        price = _first_number(payload, _PRICE_FIELDS)
        size = _first_number(payload, _SIZE_FIELDS)
        spread = _first_number(payload, _SPREAD_FIELDS)
        depth = _depth_proxy(payload)
        ofi = _first_number(payload, _OFI_FIELDS)
        explicit_return = _first_number(payload, _RETURN_BPS_FIELDS)
        raw_event = _first_value(payload, _RAW_EVENT_FIELDS)

        if event_type:
            observed_event_type_count += 1
            event_type_counts[event_type] = event_type_counts.get(event_type, 0) + 1
        if side is not None:
            observed_side_count += 1
        if price is not None:
            observed_price_count += 1
        if size is not None:
            observed_size_count += 1
        if spread is not None:
            observed_spread_count += 1
        if depth is not None:
            observed_depth_count += 1
        if ofi is not None:
            observed_ofi_count += 1
        if raw_event is not None:
            observed_raw_event_count += 1
        if (
            row.seq is not None
            or _first_value(payload, ("sequence", "sequence_number", "event_seq"))
            is not None
        ):
            observed_sequence_count += 1

        for key, value in payload.items():
            number = _number_or_none(value)
            if number is None:
                continue
            numeric_field_count += 1
            if any(token in str(key).lower() for token in _BINNED_FIELD_TOKENS):
                binned_numeric_field_count += 1

        by_symbol.setdefault(row.symbol, []).append(
            _MicrostructureObservation(
                price=price,
                spread_bps=spread,
                depth=depth,
                ofi=ofi,
                explicit_return_bps=explicit_return,
            )
        )

    computed_returns_by_symbol = _attach_computed_returns(by_symbol, signed_direction)
    for symbol_returns in computed_returns_by_symbol.values():
        returns_bps.extend(symbol_returns)

    if observed_event_type_count == 0:
        warnings.add("missing_event_type_for_universal_tokenization")
    if observed_side_count == 0:
        warnings.add("missing_trade_or_order_side_for_multimodal_event_stream")
    if observed_price_count == 0:
        warnings.add("missing_price_for_scale_invariant_tradeflow_features")
    if observed_size_count == 0:
        warnings.add("missing_size_or_volume_for_scale_invariant_tradeflow_features")
    if observed_ofi_count == 0:
        warnings.add("missing_order_flow_imbalance_for_latent_regime_detector")
    if observed_raw_event_count == 0:
        warnings.add("missing_raw_event_message_bytes_for_byte_stream_fidelity")
    if observed_sequence_count < row_count:
        warnings.add("missing_sequence_numbers_for_event_time_replay_fidelity")

    event_alphabet_size = len(event_type_counts)
    dominant_event_type_share = (
        max(event_type_counts.values()) / max(1, observed_event_type_count)
        if event_type_counts
        else 0.0
    )
    binned_numeric_field_share = binned_numeric_field_count / max(
        1, numeric_field_count
    )
    observed_components = sum(
        1
        for count in (
            observed_event_type_count,
            observed_side_count,
            observed_price_count,
            observed_size_count,
            observed_spread_count,
            observed_depth_count,
            observed_ofi_count,
        )
        if count > 0
    )
    scale_invariant_feature_coverage_score = observed_components / 7.0
    alphabet_gap = 0.0 if event_alphabet_size >= 3 else (3 - event_alphabet_size) / 3.0
    dominant_gap = max(0.0, dominant_event_type_share - 0.80) / 0.20
    universal_tokenization_gap_score = min(
        1.0,
        (1.0 - scale_invariant_feature_coverage_score) * 0.70
        + min(1.0, alphabet_gap) * 0.18
        + min(1.0, dominant_gap) * 0.12,
    )
    raw_event_coverage = observed_raw_event_count / row_count
    sequence_coverage = observed_sequence_count / row_count
    structured_coverage = scale_invariant_feature_coverage_score
    byte_stream_precision_gap_score = min(
        1.0,
        1.0
        - (
            raw_event_coverage * 0.45
            + sequence_coverage * 0.25
            + structured_coverage * 0.30
        )
        + binned_numeric_field_share * 0.20,
    )

    early_warning = _latent_regime_early_warning(by_symbol)
    if early_warning.stress_event_count == 0:
        warnings.add("no_latent_regime_stress_events_observed_for_lead_time_check")
    if sum(len(items) for items in by_symbol.values()) < _MIN_EARLY_WARNING_ROWS:
        warnings.add("insufficient_rows_for_latent_regime_early_warning_check")

    stylized = _stylized_fact_gap(returns_bps)
    if len(returns_bps) < 4:
        warnings.add("insufficient_returns_for_tradeflow_stylized_fact_alignment")

    replay_gap_score = min(
        1.0,
        universal_tokenization_gap_score * 0.24
        + byte_stream_precision_gap_score * 0.22
        + binned_numeric_field_share * 0.10
        + min(1.0, dominant_gap) * 0.08
        + early_warning.reactive_gap_score * 0.22
        + stylized.gap_score * 0.14,
    )
    replay_rank_penalty_bps = min(100.0, 6.0 + replay_gap_score * 94.0)

    return MicrostructureRegimeTokenizationStressSummary(
        row_count=row_count,
        observed_event_type_count=observed_event_type_count,
        observed_side_count=observed_side_count,
        observed_price_count=observed_price_count,
        observed_size_count=observed_size_count,
        observed_spread_count=observed_spread_count,
        observed_depth_count=observed_depth_count,
        observed_ofi_count=observed_ofi_count,
        observed_raw_event_count=observed_raw_event_count,
        observed_sequence_count=observed_sequence_count,
        event_alphabet_size=event_alphabet_size,
        dominant_event_type_share=dominant_event_type_share,
        scale_invariant_feature_coverage_score=scale_invariant_feature_coverage_score,
        universal_tokenization_gap_score=universal_tokenization_gap_score,
        byte_stream_precision_gap_score=byte_stream_precision_gap_score,
        binned_numeric_field_share=binned_numeric_field_share,
        latent_regime_trigger_count=early_warning.trigger_count,
        latent_regime_stress_event_count=early_warning.stress_event_count,
        latent_regime_lead_coverage=early_warning.lead_coverage,
        mean_positive_lead_steps=early_warning.mean_positive_lead_steps,
        reactive_detection_gap_score=early_warning.reactive_gap_score,
        stylized_fact_gap_score=stylized.gap_score,
        signed_return_autocorr_abs=stylized.signed_return_autocorr_abs,
        abs_return_clustering_score=stylized.abs_return_clustering_score,
        tail_event_share=stylized.tail_event_share,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(sorted(warnings)),
        feature_schema_hash=schema_hash,
    )


@dataclass(frozen=True)
class _MicrostructureObservation:
    price: float | None
    spread_bps: float | None
    depth: float | None
    ofi: float | None
    explicit_return_bps: float | None
    computed_return_bps: float = 0.0


@dataclass(frozen=True)
class _EarlyWarningSummary:
    trigger_count: int
    stress_event_count: int
    lead_coverage: float
    mean_positive_lead_steps: float
    reactive_gap_score: float


@dataclass(frozen=True)
class _StylizedFactSummary:
    gap_score: float
    signed_return_autocorr_abs: float
    abs_return_clustering_score: float
    tail_event_share: float


def _attach_computed_returns(
    by_symbol: Mapping[str, Sequence[_MicrostructureObservation]],
    direction: float,
) -> dict[str, list[float]]:
    returns_by_symbol: dict[str, list[float]] = {}
    for symbol, observations in by_symbol.items():
        symbol_returns: list[float] = []
        prior_price: float | None = None
        for observation in observations:
            value = observation.explicit_return_bps
            if value is None and observation.price is not None:
                if prior_price is not None and prior_price > 0.0:
                    value = (
                        direction
                        * (observation.price - prior_price)
                        / prior_price
                        * 10_000.0
                    )
                prior_price = observation.price
            elif observation.price is not None:
                prior_price = observation.price
            if value is not None and isfinite(value):
                symbol_returns.append(float(value))
        returns_by_symbol[symbol] = symbol_returns
    return returns_by_symbol


def _latent_regime_early_warning(
    by_symbol: Mapping[str, Sequence[_MicrostructureObservation]],
) -> _EarlyWarningSummary:
    trigger_count = 0
    stress_event_count = 0
    covered_stress_events = 0
    positive_leads: list[int] = []

    for observations in by_symbol.values():
        if len(observations) < _MIN_EARLY_WARNING_ROWS:
            continue
        returns = _series_returns(observations)
        if len(returns) != len(observations):
            continue
        channel_values = _regime_channel_values(observations)
        channel_threshold = min(0.75, _robust_threshold(channel_values, floor=0.35))
        return_threshold = _robust_threshold([abs(item) for item in returns], floor=6.0)
        spread_values = [
            item.spread_bps for item in observations if item.spread_bps is not None
        ]
        spread_threshold = (
            _robust_threshold(spread_values, floor=4.0) if spread_values else 0.0
        )

        trigger_indices: list[int] = []
        for index, value in enumerate(channel_values):
            prior = channel_values[index - 1] if index > 0 else 0.0
            if value >= channel_threshold and value > prior * 1.05:
                trigger_indices.append(index)
        trigger_count += len(trigger_indices)

        stress_indices = [
            index
            for index, (observation, return_bps) in enumerate(
                zip(observations, returns, strict=True)
            )
            if abs(return_bps) >= return_threshold
            or (
                spread_threshold > 0.0
                and observation.spread_bps is not None
                and observation.spread_bps >= spread_threshold
            )
        ]
        stress_event_count += len(stress_indices)
        for stress_index in stress_indices:
            lead_candidates = [
                stress_index - trigger_index
                for trigger_index in trigger_indices
                if 0 < stress_index - trigger_index <= _EARLY_WARNING_LOOKAHEAD
            ]
            if lead_candidates:
                covered_stress_events += 1
                positive_leads.append(min(lead_candidates))

    lead_coverage = covered_stress_events / max(1, stress_event_count)
    mean_positive_lead_steps = median(positive_leads) if positive_leads else 0.0
    lead_depth_score = min(1.0, mean_positive_lead_steps / _EARLY_WARNING_LOOKAHEAD)
    if stress_event_count == 0:
        reactive_gap_score = 0.35
    else:
        reactive_gap_score = min(
            1.0, (1.0 - lead_coverage) * 0.75 + (1.0 - lead_depth_score) * 0.25
        )
    return _EarlyWarningSummary(
        trigger_count=trigger_count,
        stress_event_count=stress_event_count,
        lead_coverage=lead_coverage,
        mean_positive_lead_steps=mean_positive_lead_steps,
        reactive_gap_score=reactive_gap_score,
    )


def _series_returns(observations: Sequence[_MicrostructureObservation]) -> list[float]:
    returns: list[float] = []
    prior_price: float | None = None
    for observation in observations:
        if observation.explicit_return_bps is not None:
            returns.append(observation.explicit_return_bps)
            if observation.price is not None:
                prior_price = observation.price
            continue
        if observation.price is None or prior_price is None or prior_price <= 0.0:
            returns.append(0.0)
        else:
            returns.append((observation.price - prior_price) / prior_price * 10_000.0)
        if observation.price is not None:
            prior_price = observation.price
    return returns


def _regime_channel_values(
    observations: Sequence[_MicrostructureObservation],
) -> list[float]:
    spreads = [item.spread_bps or 0.0 for item in observations]
    depths = [item.depth or 0.0 for item in observations]
    ofis = [abs(item.ofi or 0.0) for item in observations]
    median_spread = (
        median([item for item in spreads if item > 0.0]) if any(spreads) else 1.0
    )
    median_depth = (
        median([item for item in depths if item > 0.0]) if any(depths) else 1.0
    )
    channel_values: list[float] = []
    prior_depth: float | None = None
    for spread, depth, ofi in zip(spreads, depths, ofis, strict=True):
        spread_channel = min(1.0, max(0.0, spread / max(1.0, median_spread * 2.0)))
        ofi_channel = min(1.0, ofi if ofi <= 1.0 else ofi / 10.0)
        depth_erosion = 0.0
        if prior_depth is not None and prior_depth > 0.0 and depth > 0.0:
            depth_erosion = min(
                1.0, max(0.0, (prior_depth - depth) / max(prior_depth, median_depth))
            )
        if depth > 0.0:
            prior_depth = depth
        channel_values.append(max(ofi_channel, spread_channel, depth_erosion))
    return channel_values


def _stylized_fact_gap(returns_bps: Sequence[float]) -> _StylizedFactSummary:
    clean = [float(item) for item in returns_bps if isfinite(float(item))]
    if len(clean) < 4:
        return _StylizedFactSummary(
            gap_score=0.45,
            signed_return_autocorr_abs=0.0,
            abs_return_clustering_score=0.0,
            tail_event_share=0.0,
        )
    signed_autocorr_abs = abs(_lag1_corr(clean))
    abs_returns = [abs(item) for item in clean]
    abs_clustering = max(0.0, _lag1_corr(abs_returns))
    median_abs = median(abs_returns) if abs_returns else 0.0
    tail_threshold = max(2.0, median_abs * 3.0)
    tail_event_share = sum(1 for item in abs_returns if item >= tail_threshold) / len(
        abs_returns
    )
    autocorr_gap = min(1.0, signed_autocorr_abs / 0.45)
    clustering_gap = max(0.0, 0.08 - abs_clustering) / 0.08
    if tail_event_share < 0.02:
        tail_gap = (0.02 - tail_event_share) / 0.02
    elif tail_event_share > 0.45:
        tail_gap = (tail_event_share - 0.45) / 0.55
    else:
        tail_gap = 0.0
    return _StylizedFactSummary(
        gap_score=min(
            1.0, autocorr_gap * 0.40 + clustering_gap * 0.35 + tail_gap * 0.25
        ),
        signed_return_autocorr_abs=signed_autocorr_abs,
        abs_return_clustering_score=abs_clustering,
        tail_event_share=tail_event_share,
    )


def _robust_threshold(values: Sequence[float], *, floor: float) -> float:
    clean = [float(value) for value in values if isfinite(float(value))]
    if not clean:
        return floor
    center = median(clean)
    deviations = [abs(value - center) for value in clean]
    mad = median(deviations) if deviations else 0.0
    return max(floor, center + max(mad * 1.5, center * 0.10))


def _lag1_corr(values: Sequence[float]) -> float:
    if len(values) < 3:
        return 0.0
    left = list(values[:-1])
    right = list(values[1:])
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum(
        (a - left_mean) * (b - right_mean) for a, b in zip(left, right, strict=True)
    )
    left_var = sum((a - left_mean) ** 2 for a in left)
    right_var = sum((b - right_mean) ** 2 for b in right)
    denominator = (left_var * right_var) ** 0.5
    if denominator <= 0.0:
        return 0.0
    return numerator / denominator


def _event_type(payload: Mapping[str, Any]) -> str:
    value = _first_value(payload, _EVENT_TYPE_FIELDS)
    return str(value).strip().lower() if value is not None else ""


def _depth_proxy(payload: Mapping[str, Any]) -> float | None:
    explicit = _first_number(payload, _DEPTH_FIELDS)
    if explicit is not None:
        return explicit
    bid = _first_number(payload, ("bid_size", "bid_qty", "best_bid_size", "bid_depth"))
    ask = _first_number(payload, ("ask_size", "ask_qty", "best_ask_size", "ask_depth"))
    if bid is not None or ask is not None:
        return max(0.0, (bid or 0.0) + (ask or 0.0))
    return None


def _first_value(payload: Mapping[str, Any], fields: Sequence[str]) -> Any | None:
    for field in fields:
        if field in payload and payload[field] is not None:
            return payload[field]
    return None


def _first_number(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    value = _first_value(payload, fields)
    return _number_or_none(value)


def _number_or_none(value: Any) -> float | None:
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
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PRIMARY_SOURCES",
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PROOF_SEMANTICS_LABEL",
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_SCHEMA_VERSION",
    "MicrostructureRegimeTokenizationStressSummary",
    "build_microstructure_regime_tokenization_stress_schema_hash",
    "extract_microstructure_regime_tokenization_stress",
    "microstructure_regime_tokenization_stress_contract",
]
