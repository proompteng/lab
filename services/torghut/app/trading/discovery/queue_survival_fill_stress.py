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
from math import exp, isfinite, log1p
from typing import Any, cast

from app.trading.models import SignalEnvelope

QUEUE_SURVIVAL_FILL_STRESS_SCHEMA_VERSION = "torghut.queue-survival-fill-stress.v5"
QUEUE_SURVIVAL_FILL_STRESS_CONTRACT_SCHEMA_VERSION = (
    "torghut.queue-survival-fill-stress-contract.v5"
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
        "source_id": "arxiv-2403.02572v2",
        "url": "https://arxiv.org/abs/2403.02572",
        "title": "Fill Probabilities in a Limit Order Book with State-Dependent Stochastic Order Flows",
        "date": "2026-02-06",
        "mechanism": "state_dependent_fill_probability_before_opposite_quote_or_midprice_move",
    },
    {
        "source_id": "arxiv-2507.06345v2",
        "url": "https://arxiv.org/abs/2507.06345",
        "title": "Reinforcement Learning for Trade Execution with Market and Limit Orders",
        "date": "2026-01-26",
        "mechanism": "market_limit_allocation_under_order_book_imbalance_tactical_response",
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
    {
        "source_id": "arxiv-2501.08822",
        "url": "https://arxiv.org/abs/2501.08822",
        "title": "Deep Learning Meets Queue-Reactive: A Framework for Realistic Limit Order Book Simulation",
        "date": "2025-01-15",
        "mechanism": "multidimensional_deep_queue_reactive_event_mix_order_size_replay_parity",
    },
    {
        "source_id": "arxiv-2511.15262",
        "url": "https://arxiv.org/abs/2511.15262",
        "title": "Reinforcement Learning in Queue-Reactive Models: Application to Optimal Execution",
        "date": "2025-11-19",
        "mechanism": "queue_reactive_counterfactual_execution_policy_depth_state_stress",
    },
    {
        "source_id": "ssrn-6574208",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6574208",
        "title": "Random Queue Priority in Continuous Limit Order Books: Evidence from a Large-Scale Controlled Simulation",
        "date": "2026-04-14",
        "mechanism": "allocation_rule_execution_quality_bias_time_priority_sensitivity",
    },
    {
        "source_id": "ssrn-6578978",
        "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6578978",
        "title": "Beyond Time Priority: A Taxonomy of Queue Allocation Mechanisms in Continuous Limit Order Books",
        "date": "2026-04-15",
        "mechanism": "queue_allocation_mechanism_taxonomy_priority_rule_fragility",
    },
    {
        "source_id": "arxiv-2502.18625",
        "url": "https://arxiv.org/abs/2502.18625",
        "title": "The Market Maker's Dilemma: Navigating the Fill Probability vs. Post-Fill Returns Trade-Off",
        "date": "2025-02-25",
        "mechanism": "maker_fill_probability_post_fill_return_tradeoff_and_contrarian_imbalance_reversal",
    },
    {
        "source_id": "arxiv-2605.25527",
        "url": "https://arxiv.org/abs/2605.25527",
        "title": "DeepSeekMath Meets Order Book: Group-Aware Policy Optimization for High-Frequency Directional Trading",
        "date": "2026-05-25",
        "mechanism": "order_flow_state_group_normalized_downside_aware_policy_reward_stress",
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
_ORDER_BOOK_IMBALANCE_FIELDS = (
    "order_book_imbalance",
    "book_imbalance",
    "queue_imbalance",
    "obi",
    "microprice_imbalance",
    "order_flow_imbalance",
    "ofi",
)
_FILL_TOKENS = frozenset(("fill", "filled", "execution", "executed", "trade"))
_CANCEL_TOKENS = frozenset(("cancel", "canceled", "cancelled", "delete", "remove"))
_REJECT_TOKENS = frozenset(
    ("reject", "rejected", "post_only_reject", "post-only-reject")
)
_ADD_TOKENS = frozenset(("add", "new", "insert", "accepted", "open", "quote"))
_QUEUE_REACTIVE_EVENT_KINDS = ("add", "trade", "cancel_or_reject", "other")


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
    queue_reactive_event_mix_l1: float
    order_size_distribution_wasserstein_proxy: float
    queue_reactive_replay_parity_penalty_bps: float
    time_priority_edge_concentration_score: float
    randomized_priority_fill_gap_proxy_bps: float
    queue_allocation_rule_sensitivity_penalty_bps: float
    fill_before_move_trial_count: int
    observed_opportunity_midprice_move_count: int
    opportunity_midprice_move_before_fill_share: float
    state_dependent_fill_before_move_probability: float
    state_dependent_order_flow_gap_score: float
    state_dependent_fill_risk_penalty_bps: float
    observed_order_book_imbalance_count: int
    median_directional_order_book_imbalance: float
    contrarian_reversal_support_score: float
    maker_fill_return_tradeoff_penalty_bps: float
    group_normalized_downside_reward_penalty_bps: float
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
            "queue_reactive_event_mix_l1": _stable_float(
                self.queue_reactive_event_mix_l1
            ),
            "order_size_distribution_wasserstein_proxy": _stable_float(
                self.order_size_distribution_wasserstein_proxy
            ),
            "queue_reactive_replay_parity_penalty_bps": _stable_float(
                self.queue_reactive_replay_parity_penalty_bps
            ),
            "time_priority_edge_concentration_score": _stable_float(
                self.time_priority_edge_concentration_score
            ),
            "randomized_priority_fill_gap_proxy_bps": _stable_float(
                self.randomized_priority_fill_gap_proxy_bps
            ),
            "queue_allocation_rule_sensitivity_penalty_bps": _stable_float(
                self.queue_allocation_rule_sensitivity_penalty_bps
            ),
            "fill_before_move_trial_count": self.fill_before_move_trial_count,
            "observed_opportunity_midprice_move_count": (
                self.observed_opportunity_midprice_move_count
            ),
            "opportunity_midprice_move_before_fill_share": _stable_float(
                self.opportunity_midprice_move_before_fill_share
            ),
            "state_dependent_fill_before_move_probability": _stable_float(
                self.state_dependent_fill_before_move_probability
            ),
            "state_dependent_order_flow_gap_score": _stable_float(
                self.state_dependent_order_flow_gap_score
            ),
            "state_dependent_fill_risk_penalty_bps": _stable_float(
                self.state_dependent_fill_risk_penalty_bps
            ),
            "observed_order_book_imbalance_count": (
                self.observed_order_book_imbalance_count
            ),
            "median_directional_order_book_imbalance": _stable_float(
                self.median_directional_order_book_imbalance
            ),
            "contrarian_reversal_support_score": _stable_float(
                self.contrarian_reversal_support_score
            ),
            "maker_fill_return_tradeoff_penalty_bps": _stable_float(
                self.maker_fill_return_tradeoff_penalty_bps
            ),
            "group_normalized_downside_reward_penalty_bps": _stable_float(
                self.group_normalized_downside_reward_penalty_bps
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
                "queue_reactive_event_mix_l1": _stable_float(
                    self.queue_reactive_event_mix_l1
                ),
                "order_size_distribution_wasserstein_proxy": _stable_float(
                    self.order_size_distribution_wasserstein_proxy
                ),
                "queue_reactive_replay_parity_penalty_bps": _stable_float(
                    self.queue_reactive_replay_parity_penalty_bps
                ),
                "time_priority_edge_concentration_score": _stable_float(
                    self.time_priority_edge_concentration_score
                ),
                "randomized_priority_fill_gap_proxy_bps": _stable_float(
                    self.randomized_priority_fill_gap_proxy_bps
                ),
                "queue_allocation_rule_sensitivity_penalty_bps": _stable_float(
                    self.queue_allocation_rule_sensitivity_penalty_bps
                ),
                "opportunity_midprice_move_before_fill_share": _stable_float(
                    self.opportunity_midprice_move_before_fill_share
                ),
                "state_dependent_fill_before_move_probability": _stable_float(
                    self.state_dependent_fill_before_move_probability
                ),
                "state_dependent_order_flow_gap_score": _stable_float(
                    self.state_dependent_order_flow_gap_score
                ),
                "state_dependent_fill_risk_penalty_bps": _stable_float(
                    self.state_dependent_fill_risk_penalty_bps
                ),
                "median_directional_order_book_imbalance": _stable_float(
                    self.median_directional_order_book_imbalance
                ),
                "contrarian_reversal_support_score": _stable_float(
                    self.contrarian_reversal_support_score
                ),
                "maker_fill_return_tradeoff_penalty_bps": _stable_float(
                    self.maker_fill_return_tradeoff_penalty_bps
                ),
                "group_normalized_downside_reward_penalty_bps": _stable_float(
                    self.group_normalized_downside_reward_penalty_bps
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
            "queue_reactive_replay_parity_preview": True,
            "order_size_distribution_preview": True,
            "queue_allocation_rule_sensitivity_preview": True,
            "state_dependent_fill_before_move_preview": True,
            "maker_fill_return_tradeoff_preview": True,
            "group_normalized_downside_reward_preview": True,
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


@dataclass(frozen=True)
class _FillBeforeMoveStats:
    trial_count: int
    observed_move_count: int
    fill_before_move_share: float
    opportunity_move_before_fill_share: float


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
            "queue_reactive_event_mix_l1",
            "order_size_distribution_wasserstein_proxy",
            "queue_reactive_replay_parity_penalty_bps",
            "time_priority_edge_concentration_score",
            "randomized_priority_fill_gap_proxy_bps",
            "queue_allocation_rule_sensitivity_penalty_bps",
            "opportunity_midprice_move_before_fill_share",
            "state_dependent_fill_before_move_probability",
            "state_dependent_order_flow_gap_score",
            "state_dependent_fill_risk_penalty_bps",
            "median_directional_order_book_imbalance",
            "contrarian_reversal_support_score",
            "maker_fill_return_tradeoff_penalty_bps",
            "group_normalized_downside_reward_penalty_bps",
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
            "requires_queue_reactive_replay_parity": True,
            "requires_queue_allocation_rule_audit": True,
            "requires_state_dependent_fill_before_move_audit": True,
            "requires_maker_fill_return_tradeoff_audit": True,
            "requires_group_downside_reward_out_of_sample_audit": True,
            "requires_runtime_ledger": True,
            "rejects_queue_position_free_fill_assumptions": True,
            "rejects_queue_reactive_replay_parity_as_pnl_proof": True,
            "rejects_order_size_distribution_proxy_as_fill_authority": True,
            "rejects_time_priority_edge_as_mechanism_neutral_pnl_proof": True,
            "rejects_state_dependent_fill_probability_as_fill_authority": True,
            "rejects_opportunity_move_proxy_as_pnl_or_promotion_authority": True,
            "rejects_contrarian_reversal_proxy_as_promotion_authority": True,
            "rejects_order_flow_policy_reward_as_pnl_proof": True,
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
    event_kinds = tuple(_queue_reactive_event_kind(label) for label in event_labels)
    fill_sizes = tuple(
        _nonnegative_float(_first_payload_value(row.payload, _FILL_FIELDS))
        for row in ordered
    )
    order_book_imbalances = tuple(_order_book_imbalance(row.payload) for row in ordered)

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
    if not any(event_labels):
        warnings.append("missing_queue_reactive_event_labels")
    observed_order_book_imbalance_count = sum(
        item is not None for item in order_book_imbalances
    )
    if observed_order_book_imbalance_count == 0:
        warnings.append("missing_order_book_imbalance_for_maker_dilemma")

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
    queue_reactive_event_mix_l1 = _queue_reactive_event_mix_l1(
        event_kinds=event_kinds,
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        execution_turnover_ratio=execution_turnover_ratio,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
    )
    order_size_distribution_wasserstein_proxy = (
        _order_size_distribution_wasserstein_proxy(
            volumes=volumes,
            fill_sizes=fill_sizes,
            executable_depths=executable_depths,
        )
    )
    if order_size_distribution_wasserstein_proxy == 0.0:
        warnings.append("missing_order_size_distribution_for_queue_reactive_parity")
    queue_reactive_replay_parity_penalty_bps = (
        queue_reactive_event_mix_l1 * 4.0
        + order_size_distribution_wasserstein_proxy * 2.0
    )
    estimated_limit_fill_probability = _estimated_fill_probability(
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        execution_turnover_ratio=execution_turnover_ratio,
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
        cancellation_or_reject_share=cancellation_or_reject_share,
        observed_queue_position_count=observed_queue_position_count,
    )
    time_priority_edge_concentration_score = _time_priority_edge_concentration_score(
        median_queue_ahead_ratio=median_queue_ahead_ratio,
        execution_turnover_ratio=execution_turnover_ratio,
        cancellation_or_reject_share=cancellation_or_reject_share,
        fill_probability=estimated_limit_fill_probability,
        observed_queue_position_count=observed_queue_position_count,
    )
    randomized_priority_fill_gap_proxy_bps = _randomized_priority_fill_gap_proxy_bps(
        time_priority_edge_concentration_score=time_priority_edge_concentration_score,
        median_spread_bps=_median(tuple(spread for spread in spreads if spread > 0.0)),
        visible_depth_notional_shortfall_share=visible_depth_notional_shortfall_share,
    )
    queue_allocation_rule_sensitivity_penalty_bps = (
        randomized_priority_fill_gap_proxy_bps
        + time_priority_edge_concentration_score * 5.0
        + queue_reactive_event_mix_l1 * 1.5
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
    fill_before_move_stats = _fill_before_opportunity_move_stats(
        rows=ordered,
        prices=prices,
        event_labels=event_labels,
        direction=signed_direction,
        median_spread_bps=median_spread_bps,
    )
    if fill_before_move_stats.trial_count <= 0:
        warnings.append("missing_state_dependent_fill_before_move_trials")
    if fill_before_move_stats.observed_move_count <= 0 and len(valid_prices) >= 2:
        warnings.append("missing_opportunity_midprice_move_before_fill_observations")
    state_dependent_fill_before_move_probability = _state_dependent_fill_before_move_probability(
        estimated_limit_fill_probability=estimated_limit_fill_probability,
        fill_before_move_trial_count=fill_before_move_stats.trial_count,
        fill_before_move_success_share=fill_before_move_stats.fill_before_move_share,
        queue_reactive_event_mix_l1=queue_reactive_event_mix_l1,
        observed_order_book_imbalance_count=observed_order_book_imbalance_count,
    )
    opportunity_midprice_move_before_fill_share = (
        fill_before_move_stats.opportunity_move_before_fill_share
    )
    state_dependent_order_flow_gap_score = _state_dependent_order_flow_gap_score(
        fill_before_move_trial_count=fill_before_move_stats.trial_count,
        opportunity_midprice_move_before_fill_share=(
            opportunity_midprice_move_before_fill_share
        ),
        queue_reactive_event_mix_l1=queue_reactive_event_mix_l1,
        observed_order_book_imbalance_count=observed_order_book_imbalance_count,
        cancellation_or_reject_share=cancellation_or_reject_share,
    )
    state_dependent_fill_risk_penalty_bps = _state_dependent_fill_risk_penalty_bps(
        state_dependent_fill_before_move_probability=(
            state_dependent_fill_before_move_probability
        ),
        opportunity_midprice_move_before_fill_share=(
            opportunity_midprice_move_before_fill_share
        ),
        state_dependent_order_flow_gap_score=state_dependent_order_flow_gap_score,
        nonfill_opportunity_cost_bps=nonfill_opportunity_cost_bps,
        median_spread_bps=median_spread_bps,
    )
    directional_imbalances = tuple(
        signed_direction * item for item in order_book_imbalances if item is not None
    )
    median_directional_order_book_imbalance = _median(directional_imbalances)
    contrarian_reversal_support_score = _contrarian_reversal_support_score(
        prices=valid_prices,
        direction=signed_direction,
        median_directional_order_book_imbalance=median_directional_order_book_imbalance,
        median_spread_bps=median_spread_bps,
    )
    maker_fill_return_tradeoff_penalty_bps = _maker_fill_return_tradeoff_penalty_bps(
        fill_probability=estimated_limit_fill_probability,
        adverse_selection_after_touch_bps=adverse_selection_after_touch_bps,
        median_directional_order_book_imbalance=median_directional_order_book_imbalance,
        contrarian_reversal_support_score=contrarian_reversal_support_score,
        median_spread_bps=median_spread_bps,
        observed_order_book_imbalance_count=observed_order_book_imbalance_count,
    )
    group_normalized_downside_reward_penalty_bps = (
        _group_normalized_downside_reward_penalty_bps(
            rows=ordered,
            direction=signed_direction,
            fallback_spread_bps=median_spread_bps,
        )
    )
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
        + queue_reactive_replay_parity_penalty_bps
        + queue_allocation_rule_sensitivity_penalty_bps
        + maker_fill_return_tradeoff_penalty_bps
        + group_normalized_downside_reward_penalty_bps
        + nonfill_opportunity_cost_bps
        + adverse_selection_after_touch_bps
        + state_dependent_fill_risk_penalty_bps
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
        queue_reactive_event_mix_l1=queue_reactive_event_mix_l1,
        order_size_distribution_wasserstein_proxy=order_size_distribution_wasserstein_proxy,
        queue_reactive_replay_parity_penalty_bps=queue_reactive_replay_parity_penalty_bps,
        time_priority_edge_concentration_score=time_priority_edge_concentration_score,
        randomized_priority_fill_gap_proxy_bps=randomized_priority_fill_gap_proxy_bps,
        queue_allocation_rule_sensitivity_penalty_bps=queue_allocation_rule_sensitivity_penalty_bps,
        fill_before_move_trial_count=fill_before_move_stats.trial_count,
        observed_opportunity_midprice_move_count=fill_before_move_stats.observed_move_count,
        opportunity_midprice_move_before_fill_share=opportunity_midprice_move_before_fill_share,
        state_dependent_fill_before_move_probability=state_dependent_fill_before_move_probability,
        state_dependent_order_flow_gap_score=state_dependent_order_flow_gap_score,
        state_dependent_fill_risk_penalty_bps=state_dependent_fill_risk_penalty_bps,
        observed_order_book_imbalance_count=observed_order_book_imbalance_count,
        median_directional_order_book_imbalance=median_directional_order_book_imbalance,
        contrarian_reversal_support_score=contrarian_reversal_support_score,
        maker_fill_return_tradeoff_penalty_bps=maker_fill_return_tradeoff_penalty_bps,
        group_normalized_downside_reward_penalty_bps=group_normalized_downside_reward_penalty_bps,
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


def _time_priority_edge_concentration_score(
    *,
    median_queue_ahead_ratio: float,
    execution_turnover_ratio: float,
    cancellation_or_reject_share: float,
    fill_probability: float,
    observed_queue_position_count: int,
) -> float:
    """Bounded proxy for FIFO-specific early-queue ownership reliance.

    Recent queue-allocation mechanism papers show that measured execution
    quality can depend on the priority rule itself. This proxy does not
    estimate fills; it downranks replay rows whose apparent edge is highly
    concentrated in being early in a price-time queue.
    """

    if observed_queue_position_count <= 0:
        return 0.0
    front_of_queue_advantage = max(0.0, 0.50 - median_queue_ahead_ratio) * 2.0
    turnover_support = min(1.0, max(0.0, execution_turnover_ratio) / 2.0)
    cancellation_survival = max(0.0, 1.0 - cancellation_or_reject_share)
    return min(
        1.0,
        front_of_queue_advantage
        * turnover_support
        * cancellation_survival
        * max(0.0, min(1.0, fill_probability)),
    )


def _randomized_priority_fill_gap_proxy_bps(
    *,
    time_priority_edge_concentration_score: float,
    median_spread_bps: float,
    visible_depth_notional_shortfall_share: float,
) -> float:
    """Estimate ranking penalty for mechanism-specific time-priority edge.

    SSRN:6574208 reports that randomized priority reduced the fast/slow
    execution-quality gap by 35.6% in a controlled dual-engine simulation.
    Torghut uses the effect size only as a stress multiplier and never as fill,
    PnL, or promotion authority.
    """

    clob_speed_gap_decline_fraction = 0.356
    spread_floor_bps = max(1.0, median_spread_bps)
    fifo_edge_bps = time_priority_edge_concentration_score * spread_floor_bps * 2.0
    depth_uncertainty_bps = visible_depth_notional_shortfall_share * 1.5
    return min(
        25.0,
        fifo_edge_bps * clob_speed_gap_decline_fraction + depth_uncertainty_bps,
    )


def _fill_before_opportunity_move_stats(
    *,
    rows: Sequence[SignalEnvelope],
    prices: Sequence[float | None],
    event_labels: Sequence[str],
    direction: float,
    median_spread_bps: float,
) -> _FillBeforeMoveStats:
    """Measure whether fills arrive before the intended-side mid-price move.

    arXiv:2403.02572v2 models LOB fill probabilities jointly with the
    probability that prices move first. Torghut keeps this as a deterministic
    replay-ranking proxy: it does not infer actual fills without lifecycle/TCA
    evidence and does not authorize capital.
    """

    if not rows or len(rows) != len(prices) or len(rows) != len(event_labels):
        return _FillBeforeMoveStats(
            trial_count=0,
            observed_move_count=0,
            fill_before_move_share=0.0,
            opportunity_move_before_fill_share=0.0,
        )
    start_indexes = [
        index
        for index, label in enumerate(event_labels)
        if _label_has_token(label, _ADD_TOKENS)
        and not _label_has_token(label, _CANCEL_TOKENS | _REJECT_TOKENS)
    ]
    if not start_indexes and prices[0] is not None:
        start_indexes = [0]
    threshold_bps = max(0.5, median_spread_bps * 0.5)
    trial_count = 0
    fill_before_move_count = 0
    opportunity_move_before_fill_count = 0
    observed_move_count = 0
    for start_index in start_indexes:
        start_price = prices[start_index]
        if start_price is None or start_price <= 0.0:
            continue
        horizon_end = min(len(rows), start_index + 7)
        for index in range(start_index + 1, horizon_end):
            price = prices[index]
            if price is None or price <= 0.0:
                continue
            move_bps = direction * (price - start_price) / start_price * 10_000.0
            label = event_labels[index]
            if _label_has_token(label, _FILL_TOKENS):
                trial_count += 1
                fill_before_move_count += 1
                break
            if move_bps >= threshold_bps:
                trial_count += 1
                observed_move_count += 1
                opportunity_move_before_fill_count += 1
                break
    if trial_count <= 0:
        return _FillBeforeMoveStats(
            trial_count=0,
            observed_move_count=observed_move_count,
            fill_before_move_share=0.0,
            opportunity_move_before_fill_share=0.0,
        )
    return _FillBeforeMoveStats(
        trial_count=trial_count,
        observed_move_count=observed_move_count,
        fill_before_move_share=fill_before_move_count / trial_count,
        opportunity_move_before_fill_share=(
            opportunity_move_before_fill_count / trial_count
        ),
    )


def _state_dependent_fill_before_move_probability(
    *,
    estimated_limit_fill_probability: float,
    fill_before_move_trial_count: int,
    fill_before_move_success_share: float,
    queue_reactive_event_mix_l1: float,
    observed_order_book_imbalance_count: int,
) -> float:
    if fill_before_move_trial_count <= 0:
        source_coverage_penalty = (
            0.15 if observed_order_book_imbalance_count > 0 else 0.30
        )
        return max(0.0, estimated_limit_fill_probability - source_coverage_penalty)
    parity_penalty = min(0.20, queue_reactive_event_mix_l1 * 0.08)
    probability = (
        estimated_limit_fill_probability * 0.45
        + min(1.0, max(0.0, fill_before_move_success_share)) * 0.55
        - parity_penalty
    )
    return min(0.99, max(0.0, probability))


def _state_dependent_order_flow_gap_score(
    *,
    fill_before_move_trial_count: int,
    opportunity_midprice_move_before_fill_share: float,
    queue_reactive_event_mix_l1: float,
    observed_order_book_imbalance_count: int,
    cancellation_or_reject_share: float,
) -> float:
    missing_trial_penalty = 0.35 if fill_before_move_trial_count <= 0 else 0.0
    missing_state_penalty = 0.20 if observed_order_book_imbalance_count <= 0 else 0.0
    raw = (
        missing_trial_penalty
        + missing_state_penalty
        + min(1.0, max(0.0, opportunity_midprice_move_before_fill_share)) * 0.45
        + min(2.0, max(0.0, queue_reactive_event_mix_l1)) * 0.12
        + min(1.0, max(0.0, cancellation_or_reject_share)) * 0.18
    )
    return min(1.0, raw)


def _state_dependent_fill_risk_penalty_bps(
    *,
    state_dependent_fill_before_move_probability: float,
    opportunity_midprice_move_before_fill_share: float,
    state_dependent_order_flow_gap_score: float,
    nonfill_opportunity_cost_bps: float,
    median_spread_bps: float,
) -> float:
    spread_floor_bps = max(1.0, median_spread_bps)
    raw = (
        (1.0 - min(1.0, max(0.0, state_dependent_fill_before_move_probability)))
        * spread_floor_bps
        * 4.0
        + min(1.0, max(0.0, opportunity_midprice_move_before_fill_share))
        * max(spread_floor_bps, nonfill_opportunity_cost_bps)
        * 0.55
        + min(1.0, max(0.0, state_dependent_order_flow_gap_score))
        * spread_floor_bps
        * 2.5
    )
    return min(35.0, max(0.0, raw))


def _queue_reactive_event_mix_l1(
    *,
    event_kinds: Sequence[str],
    median_queue_ahead_ratio: float,
    execution_turnover_ratio: float,
    visible_depth_notional_shortfall_share: float,
) -> float:
    if not event_kinds:
        return 0.0
    observed = {
        kind: sum(1 for item in event_kinds if item == kind) / len(event_kinds)
        for kind in _QUEUE_REACTIVE_EVENT_KINDS
    }
    target_trade = min(
        0.45,
        max(
            0.08,
            0.18
            + min(4.0, execution_turnover_ratio) * 0.07
            - median_queue_ahead_ratio * 0.08,
        ),
    )
    target_cancel_or_reject = min(
        0.60,
        max(
            0.10,
            0.20
            + median_queue_ahead_ratio * 0.25
            + visible_depth_notional_shortfall_share * 0.10,
        ),
    )
    target_other = 0.08
    target_add = max(0.05, 1.0 - target_trade - target_cancel_or_reject - target_other)
    normalizer = target_add + target_trade + target_cancel_or_reject + target_other
    target = {
        "add": target_add / normalizer,
        "trade": target_trade / normalizer,
        "cancel_or_reject": target_cancel_or_reject / normalizer,
        "other": target_other / normalizer,
    }
    return min(
        2.0,
        sum(abs(observed.get(kind, 0.0) - target[kind]) for kind in target),
    )


def _order_size_distribution_wasserstein_proxy(
    *,
    volumes: Sequence[float],
    fill_sizes: Sequence[float],
    executable_depths: Sequence[float],
) -> float:
    ratios = tuple(
        min(25.0, max(volume, fill_size) / depth)
        for volume, fill_size, depth in zip(volumes, fill_sizes, executable_depths)
        if depth > 0.0 and max(volume, fill_size) > 0.0
    )
    if not ratios:
        return 0.0
    median_ratio = _median(ratios)
    p90_ratio = _quantile(ratios, 0.90)
    median_distance = abs(_log1p(median_ratio) - _log1p(0.05))
    tail_distance = abs(_log1p(p90_ratio) - _log1p(0.25))
    return min(2.0, median_distance * 0.55 + tail_distance * 0.45)


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


def _order_book_imbalance(payload: Mapping[str, Any]) -> float | None:
    explicit = _float_or_none(
        _first_payload_value(payload, _ORDER_BOOK_IMBALANCE_FIELDS)
    )
    if explicit is not None:
        return min(1.0, max(-1.0, explicit))
    bid_size = _nonnegative_float(_first_payload_value(payload, _BID_SIZE_FIELDS))
    ask_size = _nonnegative_float(_first_payload_value(payload, _ASK_SIZE_FIELDS))
    total_depth = bid_size + ask_size
    if total_depth <= 0.0:
        return None
    return min(1.0, max(-1.0, (bid_size - ask_size) / total_depth))


def _contrarian_reversal_support_score(
    *,
    prices: Sequence[float],
    direction: float,
    median_directional_order_book_imbalance: float,
    median_spread_bps: float,
) -> float:
    """Bounded support for maker quotes counter-trading a prevailing imbalance.

    arXiv:2502.18625 documents that maker fill probability can be negatively
    correlated with post-fill returns and that viable maker strategies may need
    to counter-trade the prevailing book imbalance. This proxy is only a
    replay-ranking feature: it cannot authorize fills, PnL, or promotion.
    """

    if len(prices) < 2 or prices[0] <= 0.0:
        return 0.0
    contrarian_pressure = max(0.0, -median_directional_order_book_imbalance)
    terminal_move_bps = direction * (prices[-1] - prices[0]) / prices[0] * 10_000.0
    spread_floor_bps = max(1.0, median_spread_bps)
    reversal_strength = max(0.0, terminal_move_bps) / max(4.0, spread_floor_bps * 4.0)
    return min(1.0, contrarian_pressure * min(1.0, reversal_strength))


def _maker_fill_return_tradeoff_penalty_bps(
    *,
    fill_probability: float,
    adverse_selection_after_touch_bps: float,
    median_directional_order_book_imbalance: float,
    contrarian_reversal_support_score: float,
    median_spread_bps: float,
    observed_order_book_imbalance_count: int,
) -> float:
    if observed_order_book_imbalance_count <= 0:
        return 0.0
    same_direction_pressure = max(0.0, median_directional_order_book_imbalance)
    spread_floor_bps = max(1.0, median_spread_bps)
    raw_penalty = fill_probability * (
        same_direction_pressure * spread_floor_bps * 8.0
        + adverse_selection_after_touch_bps * 0.45
    )
    contrarian_relief = 1.0 - min(0.35, contrarian_reversal_support_score * 0.35)
    return min(40.0, max(0.0, raw_penalty * contrarian_relief))


def _group_normalized_downside_reward_penalty_bps(
    *,
    rows: Sequence[SignalEnvelope],
    direction: float,
    fallback_spread_bps: float,
) -> float:
    """Downside-aware, group-normalized spread-scaled reward stress.

    arXiv:2605.25527 motivates order-flow state policies with group-normalized
    updates and downside-aware shaping. Torghut keeps this deterministic and
    proof-neutral by ranking replay rows with per-symbol post-cost downside
    dispersion only; it is not model PnL or live-capital authority.
    """

    returns_by_symbol: dict[str, list[float]] = {}
    rows_by_symbol: dict[str, list[SignalEnvelope]] = {}
    for row in rows:
        rows_by_symbol.setdefault(row.symbol, []).append(row)
    for symbol, symbol_rows in rows_by_symbol.items():
        ordered = sorted(symbol_rows, key=lambda item: (item.event_ts, item.seq))
        for current, following in zip(ordered, ordered[1:]):
            current_price = _positive_float(
                _first_payload_value(current.payload, _PRICE_FIELDS)
            )
            next_price = _positive_float(
                _first_payload_value(following.payload, _PRICE_FIELDS)
            )
            if current_price is None or next_price is None:
                continue
            spread_bps = _nonnegative_float(
                _first_payload_value(current.payload, _SPREAD_FIELDS)
            )
            if spread_bps <= 0.0:
                spread_bps = fallback_spread_bps
            signed_post_cost_return_bps = direction * (
                next_price - current_price
            ) / current_price * 10_000.0 - max(0.0, spread_bps)
            returns_by_symbol.setdefault(symbol, []).append(signed_post_cost_return_bps)
    group_penalties: list[float] = []
    for values in returns_by_symbol.values():
        if not values:
            continue
        mean_value = sum(values) / len(values)
        variance = sum((value - mean_value) ** 2 for value in values) / max(
            1, len(values)
        )
        std_dev = variance**0.5
        downside_bps = sum(max(0.0, -value) for value in values) / len(values)
        downside_z = (
            sum(max(0.0, (mean_value - value) / std_dev) for value in values)
            / len(values)
            if std_dev > 0.0
            else 0.0
        )
        group_penalties.append(
            downside_bps * 0.35 + downside_z * max(1.0, fallback_spread_bps) * 0.45
        )
    if not group_penalties:
        return 0.0
    return min(35.0, sum(group_penalties) / len(group_penalties))


def _event_label(payload: Mapping[str, Any]) -> str:
    event = _first_payload_value(payload, _EVENT_FIELDS)
    status = _first_payload_value(payload, _STATUS_FIELDS)
    side = _first_payload_value(payload, _SIDE_FIELDS)
    return " ".join(str(item).lower() for item in (event, status, side) if item)


def _label_has_token(label: str, tokens: frozenset[str]) -> bool:
    return any(token in label for token in tokens)


def _queue_reactive_event_kind(label: str) -> str:
    if _label_has_token(label, _FILL_TOKENS):
        return "trade"
    if _label_has_token(label, _CANCEL_TOKENS | _REJECT_TOKENS):
        return "cancel_or_reject"
    if _label_has_token(label, _ADD_TOKENS):
        return "add"
    return "other"


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


def _quantile(values: Sequence[float], quantile: float) -> float:
    clean = sorted(value for value in values if isfinite(value))
    if not clean:
        return 0.0
    clamped = min(1.0, max(0.0, quantile))
    index = round((len(clean) - 1) * clamped)
    return clean[index]


def _log1p(value: float) -> float:
    return 0.0 if value <= -1.0 else log1p(value)


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
