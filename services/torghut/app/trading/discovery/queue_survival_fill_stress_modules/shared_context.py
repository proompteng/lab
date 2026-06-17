# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F811,F821


def _stable_float(value: float) -> str:
    from .group_normalized_downside_reward_penalty_b import stable_float as impl

    return impl(value)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    from .group_normalized_downside_reward_penalty_b import stable_hash as impl

    return impl(payload)


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


# Public aliases used by split-module consumers.
ADD_TOKENS = _ADD_TOKENS
ASK_SIZE_FIELDS = _ASK_SIZE_FIELDS
BID_SIZE_FIELDS = _BID_SIZE_FIELDS
CANCEL_TOKENS = _CANCEL_TOKENS
EVENT_FIELDS = _EVENT_FIELDS
FILL_FIELDS = _FILL_FIELDS
FILL_TOKENS = _FILL_TOKENS
FillBeforeMoveStats = _FillBeforeMoveStats
ORDER_BOOK_IMBALANCE_FIELDS = _ORDER_BOOK_IMBALANCE_FIELDS
PRICE_FIELDS = _PRICE_FIELDS
QUEUE_POSITION_FIELDS = _QUEUE_POSITION_FIELDS
QUEUE_RATIO_FIELDS = _QUEUE_RATIO_FIELDS
QUEUE_REACTIVE_EVENT_KINDS = _QUEUE_REACTIVE_EVENT_KINDS
REJECT_TOKENS = _REJECT_TOKENS
SIDE_FIELDS = _SIDE_FIELDS
SPREAD_FIELDS = _SPREAD_FIELDS
STATUS_FIELDS = _STATUS_FIELDS
VOLUME_FIELDS = _VOLUME_FIELDS

ADD_TOKENS_split_export = _ADD_TOKENS
ASK_SIZE_FIELDS_split_export = _ASK_SIZE_FIELDS
BID_SIZE_FIELDS_split_export = _BID_SIZE_FIELDS
CANCEL_TOKENS_split_export = _CANCEL_TOKENS
EVENT_FIELDS_split_export = _EVENT_FIELDS
FILL_FIELDS_split_export = _FILL_FIELDS
FILL_TOKENS_split_export = _FILL_TOKENS
FillBeforeMoveStats_split_export = _FillBeforeMoveStats
ORDER_BOOK_IMBALANCE_FIELDS_split_export = _ORDER_BOOK_IMBALANCE_FIELDS
PRICE_FIELDS_split_export = _PRICE_FIELDS
QUEUE_POSITION_FIELDS_split_export = _QUEUE_POSITION_FIELDS
QUEUE_RATIO_FIELDS_split_export = _QUEUE_RATIO_FIELDS
QUEUE_REACTIVE_EVENT_KINDS_split_export = _QUEUE_REACTIVE_EVENT_KINDS
REJECT_TOKENS_split_export = _REJECT_TOKENS
SIDE_FIELDS_split_export = _SIDE_FIELDS
SPREAD_FIELDS_split_export = _SPREAD_FIELDS
STATUS_FIELDS_split_export = _STATUS_FIELDS
VOLUME_FIELDS_split_export = _VOLUME_FIELDS
__all__ = [name for name in globals() if not name.startswith("__")]
