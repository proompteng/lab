"""Preview-only metaorder adverse-selection stress for replay ranking.

This module turns recent 2025-2026 market-microstructure research into
executable replay inputs.  It detects Hawkes-style clustered LOB event flow,
same-direction aggressive trade runs, and liquidity-replenishment gaps that can
make Torghut's intraday candidates vulnerable to opportunistic market makers
when they chase visible metaorder drift.

The output is a deterministic offline ranking stress only.  It never creates
broker fills, writes runtime ledgers, relaxes proof gates, or enables live
capital.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import exp, isfinite
from statistics import median
from typing import Any

from app.trading.models import SignalEnvelope

METAORDER_ADVERSE_SELECTION_STRESS_SCHEMA_VERSION = (
    "torghut.metaorder-adverse-selection-stress.v1"
)
METAORDER_ADVERSE_SELECTION_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.metaorder-adverse-selection-stress-contract.v1"
)
METAORDER_ADVERSE_SELECTION_STRESS_PROOF_SEMANTICS_LABEL = (
    "metaorder_adverse_selection_preview_only_exact_replay_route_tca_"
    "order_lifecycle_runtime_ledger_required"
)
METAORDER_ADVERSE_SELECTION_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2510.27334",
        "url": "https://arxiv.org/abs/2510.27334",
        "title": "When AI Trading Agents Compete: Adverse Selection of Meta-Orders by Reinforcement Learning-Based Market Making",
        "date": "2025-10-31",
        "mechanism": "rl_market_makers_exploit_metaorder_induced_price_drift_and_hawkes_lob_endogeneity",
    },
    {
        "source_id": "doi-10.1007/s10203-026-00570-z",
        "url": "https://link.springer.com/article/10.1007/s10203-026-00570-z",
        "title": "Forecasting Bitcoin price movements using multivariate Hawkes processes and limit order book data",
        "date": "2026-04-17",
        "mechanism": "multivariate_hawkes_lob_event_timing_cross_excitation_base_imbalance_and_return_sign_forecasting",
    },
)

_EVENT_TYPE_FIELDS = (
    "event_type",
    "order_event_type",
    "lob_event_type",
    "action",
    "type",
)
_ORDER_TYPE_FIELDS = (
    "order_type",
    "order_kind",
    "execution_order_type",
    "execution_type",
    "route_order_type",
)
_TRADE_DIRECTION_FIELDS = (
    "trade_direction",
    "authoritative_trade_direction",
    "feed_trade_direction",
    "aggressive_side",
    "initiator_side",
    "side",
    "signed_trade_direction",
)
_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SPREAD_BPS_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_IMBALANCE_FIELDS = (
    "base_imbalance",
    "order_book_imbalance",
    "book_imbalance",
    "bid_ask_imbalance",
    "depth_imbalance",
    "ofi",
    "order_flow_imbalance",
)
_BID_DEPTH_FIELDS = (
    "bid_size",
    "best_bid_size",
    "bid_depth",
    "bid_volume",
    "visible_bid_depth",
)
_ASK_DEPTH_FIELDS = (
    "ask_size",
    "best_ask_size",
    "ask_depth",
    "ask_volume",
    "visible_ask_depth",
)
_SIZE_FIELDS = (
    "trade_size",
    "last_size",
    "fill_qty",
    "filled_qty",
    "quantity",
    "qty",
    "order_qty",
)
_AGGRESSIVE_EVENT_TOKENS = frozenset(
    ("trade", "fill", "execution", "market", "sweep", "take", "taker")
)
_PASSIVE_OR_CANCEL_EVENT_TOKENS = frozenset(
    ("add", "limit", "cancel", "replace", "modify", "delete")
)
_HAWKES_DECAY_SECONDS = 30.0
_METAORDER_STREAK_LENGTH = 3
_HIGH_SPREAD_BPS = 8.0
_LIQUIDITY_DROP_THRESHOLD = 0.35


@dataclass(frozen=True)
class MetaorderAdverseSelectionStressSummary:
    row_count: int
    observed_event_type_count: int
    observed_trade_direction_count: int
    observed_price_count: int
    observed_imbalance_count: int
    aggressive_event_share: float
    event_time_clustering_score: float
    same_direction_aggressive_run_share: float
    metaorder_footprint_share: float
    candidate_chasing_drift_share: float
    adverse_selection_alignment_share: float
    liquidity_replenishment_gap_share: float
    wide_spread_toxic_flow_share: float
    median_metaorder_size: float
    median_adverse_drift_bps: float
    metaorder_adverse_selection_score: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": METAORDER_ADVERSE_SELECTION_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_metaorder_adverse_selection_stress_ranking",
            "source_papers": [
                dict(item)
                for item in METAORDER_ADVERSE_SELECTION_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_event_type_count": self.observed_event_type_count,
            "observed_trade_direction_count": self.observed_trade_direction_count,
            "observed_price_count": self.observed_price_count,
            "observed_imbalance_count": self.observed_imbalance_count,
            "aggressive_event_share": _stable_float(self.aggressive_event_share),
            "event_time_clustering_score": _stable_float(
                self.event_time_clustering_score
            ),
            "same_direction_aggressive_run_share": _stable_float(
                self.same_direction_aggressive_run_share
            ),
            "metaorder_footprint_share": _stable_float(self.metaorder_footprint_share),
            "candidate_chasing_drift_share": _stable_float(
                self.candidate_chasing_drift_share
            ),
            "adverse_selection_alignment_share": _stable_float(
                self.adverse_selection_alignment_share
            ),
            "liquidity_replenishment_gap_share": _stable_float(
                self.liquidity_replenishment_gap_share
            ),
            "wide_spread_toxic_flow_share": _stable_float(
                self.wide_spread_toxic_flow_share
            ),
            "median_metaorder_size": _stable_float(self.median_metaorder_size),
            "median_adverse_drift_bps": _stable_float(self.median_adverse_drift_bps),
            "metaorder_adverse_selection_score": _stable_float(
                self.metaorder_adverse_selection_score
            ),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "aggressive_event_share": _stable_float(self.aggressive_event_share),
                "event_time_clustering_score": _stable_float(
                    self.event_time_clustering_score
                ),
                "same_direction_aggressive_run_share": _stable_float(
                    self.same_direction_aggressive_run_share
                ),
                "metaorder_footprint_share": _stable_float(
                    self.metaorder_footprint_share
                ),
                "candidate_chasing_drift_share": _stable_float(
                    self.candidate_chasing_drift_share
                ),
                "adverse_selection_alignment_share": _stable_float(
                    self.adverse_selection_alignment_share
                ),
                "liquidity_replenishment_gap_share": _stable_float(
                    self.liquidity_replenishment_gap_share
                ),
                "wide_spread_toxic_flow_share": _stable_float(
                    self.wide_spread_toxic_flow_share
                ),
                "median_adverse_drift_bps": _stable_float(
                    self.median_adverse_drift_bps
                ),
                "metaorder_adverse_selection_score": _stable_float(
                    self.metaorder_adverse_selection_score
                ),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "hawkes_event_clustering_preview": True,
            "metaorder_footprint_preview": True,
            "adverse_selection_execution_stress_preview": True,
            "liquidity_replenishment_gap_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": METAORDER_ADVERSE_SELECTION_STRESS_PROOF_SEMANTICS_LABEL,
        }


def metaorder_adverse_selection_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": METAORDER_ADVERSE_SELECTION_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": METAORDER_ADVERSE_SELECTION_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in METAORDER_ADVERSE_SELECTION_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": "hawkes_metaorder_adverse_selection_and_liquidity_replenishment_replay_stress",
        "stress_components": [
            "event_time_clustering_score",
            "same_direction_aggressive_run_share",
            "metaorder_footprint_share",
            "candidate_chasing_drift_share",
            "adverse_selection_alignment_share",
            "liquidity_replenishment_gap_share",
            "wide_spread_toxic_flow_share",
            "median_adverse_drift_bps",
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
            "requires_real_fill_slippage_observations": True,
            "rejects_metaorder_footprint_as_pnl_authority": True,
            "rejects_hawkes_intensity_as_fill_authority": True,
            "rejects_simulated_market_maker_profit_as_torghut_profit_proof": True,
        },
    }


def build_metaorder_adverse_selection_stress_schema_hash() -> str:
    return _stable_hash(metaorder_adverse_selection_stress_contract())


def extract_metaorder_adverse_selection_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
) -> MetaorderAdverseSelectionStressSummary:
    """Extract Hawkes/metaorder adverse-selection stress from replay rows."""

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    warnings: list[str] = []
    event_type_count = 0
    trade_direction_count = 0
    price_count = 0
    imbalance_count = 0
    aggressive_count = 0
    same_direction_run_count = 0
    metaorder_row_count = 0
    chasing_drift_count = 0
    adverse_alignment_count = 0
    liquidity_gap_count = 0
    wide_spread_toxic_count = 0
    candidate_alignment_observation_count = 0
    clustering_weights: list[float] = []
    metaorder_sizes: list[float] = []
    adverse_drifts: list[float] = []

    prices = tuple(_first_float(row.payload, _PRICE_FIELDS) for row in ordered)
    event_signs = tuple(_extract_trade_direction(row.payload) for row in ordered)
    aggressive_flags = tuple(_is_aggressive_event(row.payload) for row in ordered)
    spreads = tuple(_first_float(row.payload, _SPREAD_BPS_FIELDS) for row in ordered)
    imbalances = tuple(_first_float(row.payload, _IMBALANCE_FIELDS) for row in ordered)
    bid_depths = tuple(_first_float(row.payload, _BID_DEPTH_FIELDS) for row in ordered)
    ask_depths = tuple(_first_float(row.payload, _ASK_DEPTH_FIELDS) for row in ordered)

    current_streak_sign = 0.0
    current_streak_length = 0
    previous_aggressive_index: int | None = None
    previous_aggressive_sign = 0.0

    for index, row in enumerate(ordered):
        event_type = _first_text(row.payload, _EVENT_TYPE_FIELDS) or _first_text(
            row.payload, _ORDER_TYPE_FIELDS
        )
        if event_type is not None:
            event_type_count += 1
        price = prices[index]
        if price is not None:
            price_count += 1
        imbalance = imbalances[index]
        if imbalance is not None:
            imbalance_count += 1

        aggressive = aggressive_flags[index]
        sign = event_signs[index]
        if sign is not None:
            trade_direction_count += 1

        if not aggressive:
            if _is_passive_or_cancel_event(row.payload):
                current_streak_sign = 0.0
                current_streak_length = 0
            continue

        aggressive_count += 1
        if sign is None:
            current_streak_sign = 0.0
            current_streak_length = 0
            continue

        if previous_aggressive_index is not None:
            dt_seconds = max(
                0.0,
                (
                    row.event_ts - ordered[previous_aggressive_index].event_ts
                ).total_seconds(),
            )
            clustering_weights.append(exp(-dt_seconds / _HAWKES_DECAY_SECONDS))
            if sign == previous_aggressive_sign:
                same_direction_run_count += 1

        if sign == current_streak_sign:
            current_streak_length += 1
        else:
            current_streak_sign = sign
            current_streak_length = 1
        if current_streak_length >= _METAORDER_STREAK_LENGTH:
            metaorder_row_count += 1
            size = _first_float(row.payload, _SIZE_FIELDS)
            if size is not None and size > 0.0:
                metaorder_sizes.append(size)

        if sign == signed_direction:
            candidate_alignment_observation_count += 1
            drift_bps = _next_return_bps(
                prices, index=index, direction=signed_direction
            )
            signed_imbalance = (
                signed_direction * imbalance if imbalance is not None else None
            )
            if drift_bps is not None and drift_bps > 0.0:
                chasing_drift_count += 1
                adverse_drifts.append(drift_bps)
            if (
                current_streak_length >= _METAORDER_STREAK_LENGTH
                or (signed_imbalance is not None and signed_imbalance > 0.15)
            ) and (drift_bps is not None and drift_bps >= 0.50):
                adverse_alignment_count += 1
            spread = spreads[index]
            if spread is not None and spread >= _HIGH_SPREAD_BPS:
                wide_spread_toxic_count += 1

        if _liquidity_replenishment_gap(
            bid_depths,
            ask_depths,
            index=index,
            trade_sign=sign,
        ):
            liquidity_gap_count += 1

        previous_aggressive_index = index
        previous_aggressive_sign = sign

    row_count = len(ordered)
    if row_count < 2:
        warnings.append("insufficient_metaorder_adverse_selection_rows")
    if event_type_count == 0:
        warnings.append("missing_lob_event_type_evidence")
    if trade_direction_count == 0:
        warnings.append("missing_trade_direction_evidence")
    if price_count < 2:
        warnings.append("missing_price_path_for_adverse_drift")
    if imbalance_count == 0:
        warnings.append("missing_base_imbalance_or_ofi_evidence")

    aggressive_event_share = _share(aggressive_count, row_count)
    event_time_clustering_score = (
        median(clustering_weights) if clustering_weights else 0.0
    )
    same_direction_aggressive_run_share = _share(
        same_direction_run_count, aggressive_count
    )
    metaorder_footprint_share = _share(metaorder_row_count, aggressive_count)
    candidate_chasing_drift_share = _share(
        chasing_drift_count, candidate_alignment_observation_count
    )
    adverse_selection_alignment_share = _share(
        adverse_alignment_count, candidate_alignment_observation_count
    )
    liquidity_replenishment_gap_share = _share(liquidity_gap_count, aggressive_count)
    wide_spread_toxic_flow_share = _share(
        wide_spread_toxic_count, candidate_alignment_observation_count
    )
    median_metaorder_size = median(metaorder_sizes) if metaorder_sizes else 0.0
    median_adverse_drift_bps = median(adverse_drifts) if adverse_drifts else 0.0

    evidence_gap_score = (
        (0.0 if event_type_count > 0 else 1.0)
        + (0.0 if trade_direction_count > 0 else 1.0)
        + (0.0 if price_count >= 2 else 1.0)
        + (0.0 if imbalance_count > 0 else 0.5)
    ) / 3.5
    metaorder_adverse_selection_score = min(
        1.0,
        evidence_gap_score * 0.35
        + event_time_clustering_score * 0.15
        + same_direction_aggressive_run_share * 0.15
        + metaorder_footprint_share * 0.20
        + candidate_chasing_drift_share * 0.15
        + adverse_selection_alignment_share * 0.25
        + liquidity_replenishment_gap_share * 0.15
        + wide_spread_toxic_flow_share * 0.15,
    )
    missing_penalty_bps = 6.0 * len(warnings)
    replay_rank_penalty_bps = (
        missing_penalty_bps
        + metaorder_adverse_selection_score * 12.0
        + median_adverse_drift_bps * 0.50
        + wide_spread_toxic_flow_share * _HIGH_SPREAD_BPS
        + liquidity_replenishment_gap_share * 6.0
        + metaorder_footprint_share * 5.0
    )

    return MetaorderAdverseSelectionStressSummary(
        row_count=row_count,
        observed_event_type_count=event_type_count,
        observed_trade_direction_count=trade_direction_count,
        observed_price_count=price_count,
        observed_imbalance_count=imbalance_count,
        aggressive_event_share=aggressive_event_share,
        event_time_clustering_score=event_time_clustering_score,
        same_direction_aggressive_run_share=same_direction_aggressive_run_share,
        metaorder_footprint_share=metaorder_footprint_share,
        candidate_chasing_drift_share=candidate_chasing_drift_share,
        adverse_selection_alignment_share=adverse_selection_alignment_share,
        liquidity_replenishment_gap_share=liquidity_replenishment_gap_share,
        wide_spread_toxic_flow_share=wide_spread_toxic_flow_share,
        median_metaorder_size=median_metaorder_size,
        median_adverse_drift_bps=median_adverse_drift_bps,
        metaorder_adverse_selection_score=metaorder_adverse_selection_score,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_metaorder_adverse_selection_stress_schema_hash(),
    )


def _is_aggressive_event(payload: Mapping[str, Any]) -> bool:
    values = tuple(
        item.lower().replace("-", "_").replace(" ", "_")
        for item in (
            _first_text(payload, _EVENT_TYPE_FIELDS),
            _first_text(payload, _ORDER_TYPE_FIELDS),
        )
        if item is not None
    )
    return any(
        any(token in value for token in _AGGRESSIVE_EVENT_TOKENS) for value in values
    )


def _is_passive_or_cancel_event(payload: Mapping[str, Any]) -> bool:
    values = tuple(
        item.lower().replace("-", "_").replace(" ", "_")
        for item in (
            _first_text(payload, _EVENT_TYPE_FIELDS),
            _first_text(payload, _ORDER_TYPE_FIELDS),
        )
        if item is not None
    )
    return any(
        any(token in value for token in _PASSIVE_OR_CANCEL_EVENT_TOKENS)
        for value in values
    )


def _extract_trade_direction(payload: Mapping[str, Any]) -> float | None:
    raw = _first_text(payload, _TRADE_DIRECTION_FIELDS)
    if raw is not None:
        normalized = raw.lower().replace("-", "_").replace(" ", "_")
        if normalized in {"buy", "buyer", "bid", "b", "long", "aggressive_buy"}:
            return 1.0
        if normalized in {
            "sell",
            "seller",
            "ask",
            "offer",
            "s",
            "short",
            "aggressive_sell",
        }:
            return -1.0
        if "buy" in normalized:
            return 1.0
        if "sell" in normalized:
            return -1.0
    for field in _TRADE_DIRECTION_FIELDS:
        numeric = _float_or_none(payload.get(field))
        if numeric is not None and numeric != 0.0:
            return 1.0 if numeric > 0.0 else -1.0
    return None


def _next_return_bps(
    prices: Sequence[float | None],
    *,
    index: int,
    direction: float,
) -> float | None:
    current = prices[index]
    if current is None or current <= 0.0:
        return None
    for next_price in prices[index + 1 :]:
        if next_price is not None and next_price > 0.0:
            return direction * (next_price - current) / current * 10_000.0
    return None


def _liquidity_replenishment_gap(
    bid_depths: Sequence[float | None],
    ask_depths: Sequence[float | None],
    *,
    index: int,
    trade_sign: float,
) -> bool:
    if index + 1 >= len(bid_depths):
        return False
    depth_series = ask_depths if trade_sign > 0 else bid_depths
    current = depth_series[index]
    next_depth = depth_series[index + 1]
    if current is None or next_depth is None or current <= 0.0:
        return False
    retained_share = next_depth / current
    return retained_share <= (1.0 - _LIQUIDITY_DROP_THRESHOLD)


def _share(numerator: int | float, denominator: int | float) -> float:
    if denominator <= 0:
        return 0.0
    return min(1.0, max(0.0, float(numerator) / float(denominator)))


def _first_text(payload: Mapping[str, Any], fields: Sequence[str]) -> str | None:
    for field in fields:
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _first_float(payload: Mapping[str, Any], fields: Sequence[str]) -> float | None:
    for field in fields:
        value = payload.get(field)
        parsed = _float_or_none(value)
        if parsed is not None:
            return parsed
    return None


def _float_or_none(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _stable_float(value: float) -> float:
    if not isfinite(value):
        return 0.0
    return float(f"{value:.10f}")


def _stable_hash(payload: Mapping[str, Any]) -> str:
    stable_payload = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(stable_payload.encode("utf-8")).hexdigest()
