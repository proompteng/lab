"""Preview-only microstructure regime/tokenization replay stress.

This module converts current 2025-2026 market-microstructure papers into
executable replay-ranking inputs. It checks whether a candidate's local replay
rows contain enough event-time, scale-invariant, multi-modal order-flow, and
structured LOB message-lifecycle context to support early latent-regime
detection and realistic trade-flow/token replay.

The output is a deterministic offline prefilter only. It never generates
synthetic market paths, treats model rollouts as PnL proof, writes runtime
ledgers, relaxes promotion gates, or enables live capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from math import isfinite
from statistics import median
from typing import Any, cast

from app.trading.models import SignalEnvelope


def _stable_float(value: float) -> float:
    from .microstructure_observation import stable_float as impl

    return impl(value)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    from .microstructure_observation import stable_hash as impl

    return impl(payload)


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
    {
        "source_id": "arxiv-2511.12563",
        "url": "https://arxiv.org/abs/2511.12563",
        "title": "LOBERT: Generative AI Foundation Model for Limit Order Book Messages",
        "date": "2025-11-16",
        "mechanism": (
            "message_level_lob_lifecycle_tokenization_continuous_price_"
            "volume_time_embeddings_irregular_event_timing"
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

_ORDER_ID_FIELDS = (
    "order_id",
    "order_ref",
    "order_reference_number",
    "lob_order_id",
    "exchange_order_id",
    "message_order_id",
)

_MESSAGE_TIME_DELTA_FIELDS = (
    "delta_time_ns",
    "delta_time_us",
    "delta_time_ms",
    "event_time_delta_ns",
    "event_time_delta_us",
    "event_time_delta_ms",
    "inter_event_time_ns",
    "inter_event_time_us",
    "inter_event_time_ms",
)

_POST_MESSAGE_SNAPSHOT_PRICE_FIELDS = (
    "best_bid",
    "best_ask",
    "bid_price",
    "ask_price",
    "best_bid_price",
    "best_ask_price",
    "post_message_best_bid",
    "post_message_best_ask",
)

_LOBERT_LIFECYCLE_ACTIONS = (
    "add",
    "new",
    "submit",
    "limit",
    "modify",
    "replace",
    "update",
    "cancel",
    "delete",
    "remove",
    "trade",
    "fill",
    "execute",
    "market",
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
    observed_order_id_count: int
    observed_lifecycle_action_count: int
    observed_time_delta_count: int
    observed_post_message_snapshot_count: int
    event_alphabet_size: int
    dominant_event_type_share: float
    scale_invariant_feature_coverage_score: float
    universal_tokenization_gap_score: float
    byte_stream_precision_gap_score: float
    lobert_message_semantics_gap_score: float
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
            "observed_order_id_count": self.observed_order_id_count,
            "observed_lifecycle_action_count": self.observed_lifecycle_action_count,
            "observed_time_delta_count": self.observed_time_delta_count,
            "observed_post_message_snapshot_count": (
                self.observed_post_message_snapshot_count
            ),
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
            "lobert_message_semantics_gap_score": _stable_float(
                self.lobert_message_semantics_gap_score
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
                "lobert_message_semantics_gap_score": _stable_float(
                    self.lobert_message_semantics_gap_score
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
            "lobert_message_semantics_preview": True,
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
            "lobert_message_semantics_gap_score",
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
            "rejects_lobert_message_model_as_runtime_ledger_authority": True,
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

    from .microstructure_observation import (
        MicrostructureObservation as _MicrostructureObservation,
        attach_computed_returns as _attach_computed_returns,
        depth_proxy as _depth_proxy,
        event_type as _event_type,
        first_number as _first_number,
        first_value as _first_value,
        has_lobert_lifecycle_action as _has_lobert_lifecycle_action,
        has_post_message_snapshot as _has_post_message_snapshot,
        latent_regime_early_warning as _latent_regime_early_warning,
        number_or_none as _number_or_none,
        stylized_fact_gap as _stylized_fact_gap,
    )

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
            observed_order_id_count=0,
            observed_lifecycle_action_count=0,
            observed_time_delta_count=0,
            observed_post_message_snapshot_count=0,
            event_alphabet_size=0,
            dominant_event_type_share=0.0,
            scale_invariant_feature_coverage_score=0.0,
            universal_tokenization_gap_score=1.0,
            byte_stream_precision_gap_score=1.0,
            lobert_message_semantics_gap_score=1.0,
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
    observed_order_id_count = 0
    observed_lifecycle_action_count = 0
    observed_time_delta_count = 0
    observed_post_message_snapshot_count = 0
    binned_numeric_field_count = 0
    numeric_field_count = 0
    returns_bps: list[float] = []
    by_symbol: dict[str, list[_MicrostructureObservation]] = {}
    prior_event_ts_by_symbol: dict[str, datetime] = {}
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
        order_id = _first_value(payload, _ORDER_ID_FIELDS)
        explicit_time_delta = _first_number(payload, _MESSAGE_TIME_DELTA_FIELDS)

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
        if order_id is not None:
            observed_order_id_count += 1
        if _has_lobert_lifecycle_action(event_type):
            observed_lifecycle_action_count += 1
        prior_event_ts = prior_event_ts_by_symbol.get(row.symbol)
        if explicit_time_delta is not None or (
            prior_event_ts is not None
            and (row.event_ts - prior_event_ts).total_seconds() >= 0.0
        ):
            observed_time_delta_count += 1
        prior_event_ts_by_symbol[row.symbol] = row.event_ts
        if _has_post_message_snapshot(payload, spread=spread, depth=depth):
            observed_post_message_snapshot_count += 1

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
    if observed_order_id_count < row_count:
        warnings.add("missing_order_ids_for_lobert_message_lifecycle")
    if observed_lifecycle_action_count == 0:
        warnings.add("missing_lifecycle_actions_for_lobert_message_tokens")
    if observed_time_delta_count < max(1, row_count - len(by_symbol)):
        warnings.add("missing_time_deltas_for_lobert_irregular_event_timing")
    if observed_post_message_snapshot_count < row_count:
        warnings.add("missing_post_message_lob_snapshot_for_lobert_conditioning")

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
    order_id_coverage = observed_order_id_count / row_count
    lifecycle_action_coverage = observed_lifecycle_action_count / row_count
    time_delta_coverage = min(
        1.0,
        observed_time_delta_count / max(1, row_count - len(by_symbol)),
    )
    post_message_snapshot_coverage = observed_post_message_snapshot_count / row_count
    continuous_price_volume_time_coverage = (
        observed_price_count + observed_size_count + row_count
    ) / max(1, row_count * 3)
    if continuous_price_volume_time_coverage < 1.0:
        warnings.add("missing_continuous_price_volume_time_for_lobert_embeddings")
    lobert_message_semantics_gap_score = min(
        1.0,
        1.0
        - (
            order_id_coverage * 0.25
            + lifecycle_action_coverage * 0.22
            + time_delta_coverage * 0.18
            + continuous_price_volume_time_coverage * 0.20
            + post_message_snapshot_coverage * 0.15
        )
        + binned_numeric_field_share * 0.10,
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
        + byte_stream_precision_gap_score * 0.18
        + lobert_message_semantics_gap_score * 0.16
        + binned_numeric_field_share * 0.08
        + min(1.0, dominant_gap) * 0.06
        + early_warning.reactive_gap_score * 0.18
        + stylized.gap_score * 0.10,
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
        observed_order_id_count=observed_order_id_count,
        observed_lifecycle_action_count=observed_lifecycle_action_count,
        observed_time_delta_count=observed_time_delta_count,
        observed_post_message_snapshot_count=observed_post_message_snapshot_count,
        event_alphabet_size=event_alphabet_size,
        dominant_event_type_share=dominant_event_type_share,
        scale_invariant_feature_coverage_score=scale_invariant_feature_coverage_score,
        universal_tokenization_gap_score=universal_tokenization_gap_score,
        byte_stream_precision_gap_score=byte_stream_precision_gap_score,
        lobert_message_semantics_gap_score=lobert_message_semantics_gap_score,
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


# Public aliases used by split-module consumers.
BINNED_FIELD_TOKENS = _BINNED_FIELD_TOKENS
DEPTH_FIELDS = _DEPTH_FIELDS
EARLY_WARNING_LOOKAHEAD = _EARLY_WARNING_LOOKAHEAD
EVENT_TYPE_FIELDS = _EVENT_TYPE_FIELDS
LOBERT_LIFECYCLE_ACTIONS = _LOBERT_LIFECYCLE_ACTIONS
MESSAGE_TIME_DELTA_FIELDS = _MESSAGE_TIME_DELTA_FIELDS
MIN_EARLY_WARNING_ROWS = _MIN_EARLY_WARNING_ROWS
OFI_FIELDS = _OFI_FIELDS
ORDER_ID_FIELDS = _ORDER_ID_FIELDS
POST_MESSAGE_SNAPSHOT_PRICE_FIELDS = _POST_MESSAGE_SNAPSHOT_PRICE_FIELDS
PRICE_FIELDS = _PRICE_FIELDS
RAW_EVENT_FIELDS = _RAW_EVENT_FIELDS
RETURN_BPS_FIELDS = _RETURN_BPS_FIELDS
SIDE_FIELDS = _SIDE_FIELDS
SIZE_FIELDS = _SIZE_FIELDS
SPREAD_FIELDS = _SPREAD_FIELDS


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "BINNED_FIELD_TOKENS",
    "DEPTH_FIELDS",
    "EARLY_WARNING_LOOKAHEAD",
    "EVENT_TYPE_FIELDS",
    "LOBERT_LIFECYCLE_ACTIONS",
    "MESSAGE_TIME_DELTA_FIELDS",
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_CONTRACT_SCHEMA_VERSION",
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PRIMARY_SOURCES",
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_PROOF_SEMANTICS_LABEL",
    "MICROSTRUCTURE_REGIME_TOKENIZATION_STRESS_SCHEMA_VERSION",
    "MIN_EARLY_WARNING_ROWS",
    "Mapping",
    "MicrostructureRegimeTokenizationStressSummary",
    "OFI_FIELDS",
    "ORDER_ID_FIELDS",
    "POST_MESSAGE_SNAPSHOT_PRICE_FIELDS",
    "PRICE_FIELDS",
    "RAW_EVENT_FIELDS",
    "RETURN_BPS_FIELDS",
    "SIDE_FIELDS",
    "SIZE_FIELDS",
    "SPREAD_FIELDS",
    "Sequence",
    "SignalEnvelope",
    "_BINNED_FIELD_TOKENS",
    "_DEPTH_FIELDS",
    "_EARLY_WARNING_LOOKAHEAD",
    "_EVENT_TYPE_FIELDS",
    "_LOBERT_LIFECYCLE_ACTIONS",
    "_MESSAGE_TIME_DELTA_FIELDS",
    "_MIN_EARLY_WARNING_ROWS",
    "_OFI_FIELDS",
    "_ORDER_ID_FIELDS",
    "_POST_MESSAGE_SNAPSHOT_PRICE_FIELDS",
    "_PRICE_FIELDS",
    "_RAW_EVENT_FIELDS",
    "_RETURN_BPS_FIELDS",
    "_SIDE_FIELDS",
    "_SIZE_FIELDS",
    "_SPREAD_FIELDS",
    "_stable_float",
    "_stable_hash",
    "annotations",
    "build_microstructure_regime_tokenization_stress_schema_hash",
    "cast",
    "dataclass",
    "datetime",
    "extract_microstructure_regime_tokenization_stress",
    "hashlib",
    "isfinite",
    "json",
    "median",
    "microstructure_regime_tokenization_stress_contract",
)
