"""Preview-only queue-survival fill stress for replay candidate ranking.

This module actualizes recent queue-position, fill-probability, and execution-delay
papers into deterministic replay harness inputs. It does not simulate broker
fills, write runtime ledgers, or carry promotion authority.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import exp, isfinite
from typing import Any, cast

from app.trading.models import SignalEnvelope

QUEUE_SURVIVAL_FILL_STRESS_SCHEMA_VERSION = "torghut.queue-survival-fill-stress.v1"
QUEUE_SURVIVAL_FILL_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.queue-survival-fill-stress-contract.v1"
)
QUEUE_SURVIVAL_FILL_STRESS_PROOF_SEMANTICS_LABEL = "queue_survival_fill_stress_preview_only_exact_replay_route_tca_order_lifecycle_runtime_ledger_required"
QUEUE_SURVIVAL_FILL_STRESS_PRIMARY_SOURCES: tuple[Mapping[str, str], ...] = (
    {
        "source_id": "arxiv-2512.05734",
        "url": "https://arxiv.org/abs/2512.05734",
        "title": "KANFormer for Predicting Fill Probabilities via Survival Analysis in Limit Order Books",
        "date": "2025-12-05",
        "mechanism": "queue_position_survival_time_to_fill_probability_features",
    },
    {
        "source_id": "ssrn-6440898",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6440898",
        "title": "Market Depth and Execution Delays",
        "date": "2026-03-19",
        "mechanism": "market_depth_execution_delay_queue_length_penalty",
    },
    {
        "source_id": "ssrn-6730443",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6730443",
        "title": "Latency-Aware Order Routing Under Queue Position Uncertainty",
        "date": "2026-05-07",
        "mechanism": "latency_aware_queue_position_reroute_threshold_context",
    },
)

_PRICE_FIELDS = ("price", "mid_price", "mid", "mark", "last_price", "close")
_SPREAD_FIELDS = ("spread_bps", "quoted_spread_bps", "effective_spread_bps")
_VOLUME_FIELDS = (
    "microbar_volume",
    "volume",
    "qty",
    "quantity",
    "size",
    "trade_size",
    "last_size",
)
_BID_SIZE_FIELDS = ("bid_size", "bid_qty", "best_bid_size", "best_bid_qty", "bid_depth")
_ASK_SIZE_FIELDS = ("ask_size", "ask_qty", "best_ask_size", "best_ask_qty", "ask_depth")
_QUEUE_POSITION_FIELDS = (
    "queue_position",
    "queue_ahead",
    "queue_ahead_qty",
    "queue_ahead_size",
    "queue_rank",
    "limit_queue_position",
)
_QUEUE_RATIO_FIELDS = ("queue_ratio", "queue_ahead_ratio", "queue_position_ratio")
_FILL_FIELDS = ("fill_qty", "filled_qty", "executed_qty", "filled_size", "fill_size")
_STATUS_FIELDS = ("order_status", "status", "execution_status")
_EVENT_FIELDS = ("event_type", "order_event_type", "lob_event_type", "action", "type")
_SIDE_FIELDS = ("side", "order_side", "trade_side", "aggressor_side")
_FILL_TOKENS = frozenset(("fill", "filled", "execution", "executed", "trade"))
_CANCEL_TOKENS = frozenset(("cancel", "canceled", "cancelled", "delete", "remove"))
_REJECT_TOKENS = frozenset(
    ("reject", "rejected", "post_only_reject", "post-only-reject")
)


@dataclass(frozen=True)
class QueueSurvivalFillStressSummary:
    row_count: int
    observed_queue_position_count: int
    observed_depth_count: int
    observed_fill_count: int
    observed_cancel_or_reject_count: int
    median_queue_ahead_ratio: float
    median_visible_executable_depth_notional: float
    visible_depth_notional_shortfall_share: float
    execution_turnover_ratio: float
    cancellation_or_reject_share: float
    estimated_limit_fill_probability: float
    nonfill_opportunity_cost_bps: float
    adverse_selection_after_touch_bps: float
    queue_delay_penalty_bps: float
    replay_rank_penalty_bps: float
    warnings: tuple[str, ...]
    feature_schema_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": QUEUE_SURVIVAL_FILL_STRESS_SCHEMA_VERSION,
            "feature_schema_hash": self.feature_schema_hash,
            "status": "preview_only_queue_survival_fill_stress_ranking",
            "source_papers": [
                dict(item) for item in QUEUE_SURVIVAL_FILL_STRESS_PRIMARY_SOURCES
            ],
            "row_count": self.row_count,
            "observed_queue_position_count": self.observed_queue_position_count,
            "observed_depth_count": self.observed_depth_count,
            "observed_fill_count": self.observed_fill_count,
            "observed_cancel_or_reject_count": self.observed_cancel_or_reject_count,
            "median_queue_ahead_ratio": _stable_float(self.median_queue_ahead_ratio),
            "median_visible_executable_depth_notional": _stable_float(
                self.median_visible_executable_depth_notional
            ),
            "visible_depth_notional_shortfall_share": _stable_float(
                self.visible_depth_notional_shortfall_share
            ),
            "execution_turnover_ratio": _stable_float(self.execution_turnover_ratio),
            "cancellation_or_reject_share": _stable_float(
                self.cancellation_or_reject_share
            ),
            "estimated_limit_fill_probability": _stable_float(
                self.estimated_limit_fill_probability
            ),
            "nonfill_opportunity_cost_bps": _stable_float(
                self.nonfill_opportunity_cost_bps
            ),
            "adverse_selection_after_touch_bps": _stable_float(
                self.adverse_selection_after_touch_bps
            ),
            "queue_delay_penalty_bps": _stable_float(self.queue_delay_penalty_bps),
            "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            "warnings": list(self.warnings),
            "ranking_features": {
                "estimated_limit_fill_probability": _stable_float(
                    self.estimated_limit_fill_probability
                ),
                "median_queue_ahead_ratio": _stable_float(
                    self.median_queue_ahead_ratio
                ),
                "visible_depth_notional_shortfall_share": _stable_float(
                    self.visible_depth_notional_shortfall_share
                ),
                "execution_turnover_ratio": _stable_float(
                    self.execution_turnover_ratio
                ),
                "nonfill_opportunity_cost_bps": _stable_float(
                    self.nonfill_opportunity_cost_bps
                ),
                "adverse_selection_after_touch_bps": _stable_float(
                    self.adverse_selection_after_touch_bps
                ),
                "queue_delay_penalty_bps": _stable_float(self.queue_delay_penalty_bps),
                "replay_rank_penalty_bps": _stable_float(self.replay_rank_penalty_bps),
            },
            "resource_scope": "local_offline_replay_tape_or_fixture_rows_only",
            "queue_position_survival_preview": True,
            "execution_delay_depth_preview": True,
            "limit_fill_probability_preview": True,
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
            "proof_semantics_label": QUEUE_SURVIVAL_FILL_STRESS_PROOF_SEMANTICS_LABEL,
        }


def queue_survival_fill_stress_contract() -> dict[str, Any]:
    return {
        "schema_version": QUEUE_SURVIVAL_FILL_STRESS_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": QUEUE_SURVIVAL_FILL_STRESS_SCHEMA_VERSION,
        "source_papers": [
            dict(item) for item in QUEUE_SURVIVAL_FILL_STRESS_PRIMARY_SOURCES
        ],
        "stress_policy": (
            "queue_position_survival_fill_probability_with_market_depth_execution_delay"
        ),
        "stress_components": [
            "median_queue_ahead_ratio",
            "estimated_limit_fill_probability",
            "visible_depth_notional_shortfall_share",
            "execution_turnover_ratio",
            "nonfill_opportunity_cost_bps",
            "adverse_selection_after_touch_bps",
        ],
        "queue_position_fields": list(_QUEUE_POSITION_FIELDS + _QUEUE_RATIO_FIELDS),
        "depth_fields": list(_BID_SIZE_FIELDS + _ASK_SIZE_FIELDS),
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
            "rejects_queue_position_free_fill_assumptions": True,
        },
    }


def build_queue_survival_fill_stress_schema_hash() -> str:
    return _stable_hash(queue_survival_fill_stress_contract())


def extract_queue_survival_fill_stress(
    records: Sequence[SignalEnvelope],
    *,
    direction: int | float = 1,
    max_notional: int | float | str | None = None,
) -> QueueSurvivalFillStressSummary:
    """Extract deterministic queue-survival fill stress from replay rows.

    The output is a replay-ranking stress input only. Exact replay, route TCA,
    real order-lifecycle fill evidence, and runtime-ledger proof remain
    authoritative.
    """

    ordered = tuple(
        sorted(records, key=lambda item: (item.event_ts, item.symbol, item.seq))
    )
    signed_direction = 1.0 if float(direction) >= 0.0 else -1.0
    notional = _nonnegative_float(max_notional)
    prices = tuple(
        _positive_float(_first_payload_value(row.payload, _PRICE_FIELDS))
        for row in ordered
    )
    spreads = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _SPREAD_FIELDS))
        for row in ordered
    )
    executable_depths = tuple(
        _executable_side_depth(row.payload, direction=signed_direction)
        for row in ordered
    )
    queue_ratios = tuple(
        _queue_ahead_ratio(row.payload, executable_depth=depth)
        for row, depth in zip(ordered, executable_depths)
    )
    volumes = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _VOLUME_FIELDS))
        for row in ordered
    )
    event_labels = tuple(_event_label(row.payload) for row in ordered)
    fill_sizes = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _FILL_FIELDS))
        for row in ordered
    )

    warnings: list[str] = []
    if len(ordered) < 3:
        warnings.append("insufficient_queue_survival_rows")
    observed_queue_position_count = sum(item is not None for item in queue_ratios)
    if observed_queue_position_count == 0:
        warnings.append("missing_queue_position_fields")
    observed_depth_count = sum(depth > 0.0 for depth in executable_depths)
    if observed_depth_count == 0:
        warnings.append("missing_executable_side_depth")
    valid_prices = tuple(price for price in prices if price is not None and price > 0.0)
    if len(valid_prices) < 2:
        warnings.append("missing_price_path_for_nonfill_cost")
    if notional <= 0.0:
        warnings.append("missing_candidate_notional_for_queue_stress")

    observed_fill_count = sum(
        1
        for label, fill_size in zip(event_labels, fill_sizes)
        if fill_size > 0.0 or _label_has_token(label, _FILL_TOKENS)
    )
    observed_cancel_or_reject_count = sum(
        1
        for label in event_labels
        if _label_has_token(label, _CANCEL_TOKENS | _REJECT_TOKENS)
    )
    usable_queue_ratios = tuple(item for item in queue_ratios if item is not None)
    median_queue_ahead_ratio = _median(usable_queue_ratios)
    executable_notional_samples = tuple(
        depth * price
        for depth, price in zip(executable_depths, prices)
        if depth > 0.0 and price is not None and price > 0.0
    )
    median_visible_executable_depth_notional = _median(executable_notional_samples)
    visible_depth_notional_shortfall_share = (
        max(0.0, notional - median_visible_executable_depth_notional) / notional
        if notional > 0.0
        else 0.0
    )
    visible_depth_notional_shortfall_share = min(
        1.0, visible_depth_notional_shortfall_share
    )
    total_execution_flow = sum(volumes) + sum(fill_sizes)
    median_executable_depth = _median(
        tuple(depth for depth in executable_depths if depth > 0.0)
    )
    execution_turnover_ratio = (
        min(4.0, total_execution_flow / max(1.0, median_executable_depth))
        if median_executable_depth > 0.0
        else 0.0
    )
    cancellation_or_reject_share = observed_cancel_or_reject_count / max(
        1, len(ordered)
    )
    estimated_limit_fill_probability = _estimated_fill_probability(
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        execution_turnover_ratio=execution_turnover_ratio,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
        cancellation_or_reject_share=cancellation_or_reject_share,
        observed_queue_position_count=observed_queue_position_count,
    )
    nonfill_opportunity_cost_bps = _nonfill_opportunity_cost_bps(
        valid_prices,
        direction=signed_direction,
        fill_probability=estimated_limit_fill_probability,
    )
    adverse_selection_after_touch_bps = _adverse_selection_after_touch_bps(
        valid_prices,
        direction=signed_direction,
        fill_probability=estimated_limit_fill_probability,
    )
    median_spread_bps = _median(tuple(spread for spread in spreads if spread > 0.0))
    queue_delay_penalty_bps = (
        median_queue_ahead_ratio * 10.0
        + visible_depth_notional_shortfall_share * 12.0
        + (1.0 - estimated_limit_fill_probability) * 9.0
        + cancellation_or_reject_share * 6.0
        + max(0.0, median_spread_bps - 4.0) * 0.35
    )
    missing_penalty_bps = 6.0 * len(warnings)
    replay_rank_penalty_bps = (
        queue_delay_penalty_bps
        + nonfill_opportunity_cost_bps
        + adverse_selection_after_touch_bps
        + missing_penalty_bps
    )
    return QueueSurvivalFillStressSummary(
        row_count=len(ordered),
        observed_queue_position_count=observed_queue_position_count,
        observed_depth_count=observed_depth_count,
        observed_fill_count=observed_fill_count,
        observed_cancel_or_reject_count=observed_cancel_or_reject_count,
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        median_visible_executable_depth_notional=median_visible_executable_depth_notional,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
        execution_turnover_ratio=execution_turnover_ratio,
        cancellation_or_reject_share=cancellation_or_reject_share,
        estimated_limit_fill_probability=estimated_limit_fill_probability,
        nonfill_opportunity_cost_bps=nonfill_opportunity_cost_bps,
        adverse_selection_after_touch_bps=adverse_selection_after_touch_bps,
        queue_delay_penalty_bps=queue_delay_penalty_bps,
        replay_rank_penalty_bps=replay_rank_penalty_bps,
        warnings=tuple(dict.fromkeys(warnings)),
        feature_schema_hash=build_queue_survival_fill_stress_schema_hash(),
    )


def _executable_side_depth(payload: Mapping[str, Any], *, direction: float) -> float:
    fields = _BID_SIZE_FIELDS if direction >= 0.0 else _ASK_SIZE_FIELDS
    return _nonnegative_float(_first_payload_value(payload, fields))


def _queue_ahead_ratio(
    payload: Mapping[str, Any], *, executable_depth: float
) -> float | None:
    ratio = _float_or_none(_first_payload_value(payload, _QUEUE_RATIO_FIELDS))
    if ratio is not None:
        return min(1.0, max(0.0, ratio))
    queue_ahead = _float_or_none(_first_payload_value(payload, _QUEUE_POSITION_FIELDS))
    if queue_ahead is None:
        return None
    if executable_depth <= 0.0:
        return min(1.0, max(0.0, queue_ahead))
    return min(1.0, max(0.0, queue_ahead / executable_depth))


def _estimated_fill_probability(
    *,
    median_queue_ahead_ratio: float,
    execution_turnover_ratio: float,
    visible_depth_notional_shortfall_share: float,
    cancellation_or_reject_share: float,
    observed_queue_position_count: int,
) -> float:
    if observed_queue_position_count <= 0:
        return 0.0
    logit = (
        -1.1
        - median_queue_ahead_ratio * 2.4
        - visible_depth_notional_shortfall_share * 2.2
        - cancellation_or_reject_share * 1.4
        + min(4.0, execution_turnover_ratio) * 0.85
    )
    probability = 1.0 / (1.0 + exp(-logit))
    return min(0.98, max(0.02, probability))


def _nonfill_opportunity_cost_bps(
    prices: Sequence[float], *, direction: float, fill_probability: float
) -> float:
    if len(prices) < 2:
        return 0.0
    arrival = prices[0]
    terminal = prices[-1]
    if arrival <= 0.0:
        return 0.0
    favorable_move_bps = direction * (terminal - arrival) / arrival * 10_000.0
    return max(0.0, favorable_move_bps) * max(0.0, 1.0 - fill_probability)


def _adverse_selection_after_touch_bps(
    prices: Sequence[float], *, direction: float, fill_probability: float
) -> float:
    if len(prices) < 3:
        return 0.0
    touched = prices[len(prices) // 2]
    terminal = prices[-1]
    if touched <= 0.0:
        return 0.0
    adverse_move_bps = -direction * (terminal - touched) / touched * 10_000.0
    return max(0.0, adverse_move_bps) * max(0.0, fill_probability)


def _event_label(payload: Mapping[str, Any]) -> str:
    event = _first_payload_value(payload, _EVENT_FIELDS)
    status = _first_payload_value(payload, _STATUS_FIELDS)
    side = _first_payload_value(payload, _SIDE_FIELDS)
    return " ".join(str(item).lower() for item in (event, status, side) if item)


def _label_has_token(label: str, tokens: frozenset[str]) -> bool:
    return any(token in label for token in tokens)


def _first_payload_value(
    payload: Mapping[str, Any], fields: Sequence[str]
) -> Any | None:
    for field in fields:
        value = payload.get(field)
        if value is not None:
            return value
    return None


def _positive_float(value: object) -> float | None:
    parsed = _float_or_none(value)
    if parsed is None or parsed <= 0.0:
        return None
    return parsed


def _nonnegative_float(value: object) -> float:
    parsed = _float_or_none(value)
    if parsed is None or parsed < 0.0:
        return 0.0
    return parsed


def _float_or_none(value: object) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(cast(Any, value))
    except (TypeError, ValueError):
        return None
    return parsed if isfinite(parsed) else None


def _median(values: Sequence[float]) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    midpoint = len(clean) // 2
    if len(clean) % 2:
        return clean[midpoint]
    return (clean[midpoint - 1] + clean[midpoint]) / 2.0


def _stable_float(value: float) -> str:
    return f"{value:.10f}".rstrip("0").rstrip(".") or "0"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(
        cast(dict[str, Any], payload),
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
