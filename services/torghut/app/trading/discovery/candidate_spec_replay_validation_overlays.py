"""Replay and validation mechanism overlays for candidate spec compilation."""

from __future__ import annotations

from .candidate_spec_mechanism_overlay_state import MechanismOverlayState


def _apply_simulation_reality_gap_implementation_risk_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "reality gap",
            "simulation reality",
            "sim-to-live",
            "simulation-to-live",
            "simulation parity",
            "simulation_parity",
            "synthetic lob",
            "lob simulation",
            "limit-order-book simulation",
            "limit order book simulation",
            "fill outcomes",
            "fill_outcomes",
            "adverse-selection",
            "adverse selection",
            "adverse_selection_stress",
        )
    ):
        overlay_ids.append("simulation_reality_gap_implementation_risk")
        overlay_contracts.append(
            {
                "overlay_id": "simulation_reality_gap_implementation_risk",
                "required_evidence": [
                    "simulation_live_parity_metrics",
                    "lob_event_stream",
                    "fill_outcomes",
                    "route_tca",
                    "live_paper_parity",
                    "adverse_selection_stress",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": (
                    "post_cost_net_pnl_after_simulation_reality_gap_stress"
                ),
                "evidence_policy": (
                    "synthetic_lob_fillability_requires_live_paper_parity"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_simulation_live_parity_metrics": True,
                "required_lob_event_stream": True,
                "required_fill_outcome_evidence": True,
                "required_replay_harness_implementation_trace": True,
                "required_min_simulation_parity_sample_count": "120",
                "required_max_simulation_live_fill_error_bps": "8",
                "required_max_adverse_selection_error_bps": "8",
            }
        )
        promotion_contract.update(
            {
                "requires_simulation_live_parity_metrics": True,
                "requires_lob_event_stream": True,
                "requires_fill_outcomes": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "requires_adverse_selection_stress": True,
                "requires_replay_harness_implementation_trace": True,
                "requires_implementation_uncertainty_stability": True,
                "rejects_synthetic_lob_fillability_as_capital_gate": True,
                "rejects_simulated_fillability_without_route_tca": True,
            }
        )


def _apply_implementation_risk_backtest_stability_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "implementation risk",
            "implementation-risk",
            "engine sensitivity",
            "engine_sensitivity",
            "implementation uncertainty",
            "implementation_uncertainty_interval",
            "conclusion stability",
            "conclusion_stability",
            "divergence amplification",
            "divergence_amplification",
            "multi-engine replay",
            "multi_engine_replay",
            "backtest engine",
            "portfolio backtesting",
        )
    ):
        overlay_ids.append("implementation_risk_backtest_stability")
        overlay_contracts.append(
            {
                "overlay_id": "implementation_risk_backtest_stability",
                "required_evidence": [
                    "multi_engine_replay",
                    "engine_sensitivity",
                    "implementation_uncertainty_interval",
                    "conclusion_stability",
                    "transaction_cost_stress",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": "implementation_uncertainty_lower_net_pnl_per_day",
                "evidence_policy": (
                    "promotion_requires_stable_conclusion_across_replay_engines"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_multi_engine_replay": True,
                "required_min_implementation_uncertainty_model_count": "2",
                "required_implementation_uncertainty_lower_bound_above_target": True,
                "required_conclusion_stability_index": "1.00",
                "required_replay_harness_implementation_trace": True,
            }
        )
        promotion_contract.update(
            {
                "requires_implementation_uncertainty_stability": True,
                "requires_implementation_risk_backtest_stability": True,
                "requires_multi_engine_replay": True,
                "requires_engine_sensitivity_report": True,
                "requires_conclusion_stability": True,
                "rejects_single_engine_backtest_proof": True,
                "rejects_flat_cost_only_implementation_proof": True,
            }
        )


def _apply_replay_paper_live_semantic_parity_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "finrl-x",
            "finrl x",
            "deployment-consistent",
            "deployment consistent",
            "deployment consistency",
            "weight-centric",
            "weight centric",
            "broker execution",
            "broker-integrated execution",
            "backtesting and broker execution",
            "data processing, strategy construction, backtesting",
            "unified protocol",
            "downstream execution semantics",
            "replay paper live",
            "replay-paper-live",
            "signal payload parity",
            "signal_payload_parity",
            "order sizing parity",
            "order_sizing_parity",
            "route constraint parity",
            "route_constraint_parity",
            "broker_execution_semantics",
            "portfolio risk overlay parity",
            "portfolio_risk_overlay_parity",
        )
    ):
        overlay_ids.append("replay_paper_live_semantic_parity")
        overlay_contracts.append(
            {
                "overlay_id": "replay_paper_live_semantic_parity",
                "required_evidence": [
                    "signal_payload_parity",
                    "order_sizing_parity",
                    "route_constraint_parity",
                    "broker_execution_semantics",
                    "portfolio_weight_trace",
                    "portfolio_risk_overlay_parity",
                    "live_paper_parity",
                    "replay_harness_implementation_trace",
                ],
                "rank_metric": "post_cost_net_pnl_after_semantic_parity",
                "evidence_policy": (
                    "promotion_requires_same_replay_paper_live_execution_semantics"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_replay_paper_live_semantic_parity": True,
                "required_signal_payload_parity": True,
                "required_order_sizing_parity": True,
                "required_route_constraint_parity": True,
                "required_broker_execution_semantics_trace": True,
                "required_portfolio_risk_overlay_parity": True,
                "required_replay_harness_implementation_trace": True,
                "required_adapter_behavior_drift_count": "0",
            }
        )
        promotion_contract.update(
            {
                "requires_replay_paper_live_semantic_parity": True,
                "requires_signal_payload_parity": True,
                "requires_order_sizing_parity": True,
                "requires_route_constraint_parity": True,
                "requires_broker_execution_semantics": True,
                "requires_portfolio_risk_overlay_parity": True,
                "requires_live_paper_parity": True,
                "rejects_adapter_only_execution_behavior": True,
                "rejects_backtest_only_strategy_protocol": True,
            }
        )


def _apply_intraday_volume_periodicity_execution_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "intraday volume",
            "volume forecasting",
            "volume forecast",
            "vwap",
            "volume weighted average price",
            "volume-weighted average price",
            "u-shape",
            "u shaped",
            "u-shaped",
            "volume periodicity",
            "periodic volume",
            "morning afternoon volume",
            "execution schedule",
        )
    ):
        overlay_ids.append("intraday_volume_periodicity_execution")
        overlay_contracts.append(
            {
                "overlay_id": "intraday_volume_periodicity_execution",
                "required_evidence": [
                    "intraday_volume_forecast",
                    "clock_bucket_vwap_tracking_error",
                    "fillable_notional_by_clock_bucket",
                    "route_tca",
                ],
                "rank_metric": "post_cost_net_pnl_after_volume_periodicity_capacity",
                "evidence_policy": "capacity_must_follow_intraday_volume_profile",
            }
        )
        hard_vetoes.update(
            {
                "required_intraday_volume_forecast": True,
                "required_min_clock_bucket_capacity_sample_count": "60",
                "required_max_vwap_tracking_error_bps": "12",
                "required_min_volume_periodicity_capacity_ratio": "1.00",
            }
        )
        promotion_contract.update(
            {
                "requires_intraday_volume_forecast": True,
                "requires_clock_bucket_capacity": True,
                "requires_vwap_tracking_error": True,
                "requires_route_tca": True,
                "rejects_pooled_all_day_capacity_assumptions": True,
            }
        )


def _apply_macro_announcement_dvar_momentum_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "macro announcement",
            "macro_announcement",
            "macroeconomic announcement",
            "macroeconomic news",
            "macro news",
            "public information",
            "incremental information",
            "dvar",
            "difference in abnormal return variance",
            "event/non-event",
            "event non-event",
        )
    ):
        overlay_ids.append("macro_announcement_dvar_momentum")
        overlay_contracts.append(
            {
                "overlay_id": "macro_announcement_dvar_momentum",
                "required_evidence": [
                    "macro_announcement_calendar",
                    "dvar_incremental_information",
                    "event_non_event_holdout_replay",
                    "relative_volume",
                    "route_tca",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_macro_event_holdout",
                "evidence_policy": "macro_momentum_requires_event_non_event_replay",
            }
        )
        hard_vetoes.update(
            {
                "required_macro_announcement_calendar": True,
                "required_dvar_incremental_information": True,
                "required_event_non_event_holdout_replay": True,
                "required_min_macro_event_window_count": "20",
                "required_min_macro_non_event_holdout_count": "60",
                "required_min_macro_event_split_pass_rate": "0.60",
                "required_max_macro_event_best_day_share": "0.25",
                "required_min_route_tca_sample_count": "60",
            }
        )
        promotion_contract.update(
            {
                "requires_macro_announcement_calendar": True,
                "requires_dvar_incremental_information": True,
                "requires_event_non_event_holdout_replay": True,
                "requires_relative_volume_confirmation": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "rejects_pooled_macro_and_non_macro_replay": True,
            }
        )


def _apply_ofi_lob_continuation_response_overlay(state: MechanismOverlayState) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "order-flow imbalance",
            "order flow imbalance",
            "order_flow_imbalance",
            "ofi",
            "ofi memory",
            "ofi_memory",
            "response-ratio",
            "response ratio",
            "lob response",
            "lob_response",
            "horizon-dependent",
            "horizon dependent",
        )
    ):
        overlay_ids.append("ofi_lob_continuation_response")
        overlay_contracts.append(
            {
                "overlay_id": "ofi_lob_continuation_response",
                "required_evidence": [
                    "order_flow_imbalance",
                    "microprice_bias",
                    "forecast_horizon",
                    "route_tca",
                    "walk_forward_replay",
                ],
                "rank_metric": "post_cost_net_pnl_after_ofi_response_horizon",
                "evidence_policy": "ofi_response_requires_executable_lob_or_quote_evidence",
            }
        )
        hard_vetoes.update(
            {
                "required_min_ofi_response_sample_count": "120",
                "required_min_ofi_response_stable_split_pass_rate": "0.60",
                "required_max_ofi_response_best_split_share": "0.35",
                "required_executable_quote_evidence": True,
            }
        )
        promotion_contract.update(
            {
                "requires_ofi_response_horizon_selection": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "rejects_ohlcv_only_ofi_proxies": True,
            }
        )


def _apply_order_flow_filtration_parent_trade_obi_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "order-flow filtration",
            "order flow filtration",
            "structural filters",
            "structural filter",
            "parent orders",
            "parent order",
            "parent_order",
            "order lifetime",
            "order_lifetime",
            "modification count",
            "modification timing",
            "filtered obi",
            "filtered orderbook imbalance",
            "filtered_orderbook_imbalance",
            "transient orders",
        )
    ):
        overlay_ids.append("order_flow_filtration_parent_trade_obi")
        overlay_contracts.append(
            {
                "overlay_id": "order_flow_filtration_parent_trade_obi",
                "required_evidence": [
                    "parent_order_trade_linkage",
                    "order_lifetime_filter",
                    "order_modification_count",
                    "filtered_orderbook_imbalance",
                    "route_tca",
                    "walk_forward_replay",
                ],
                "rank_metric": "post_cost_net_pnl_after_filtered_parent_order_obi",
                "evidence_policy": (
                    "parent_trade_obi_requires_structural_order_filter_evidence"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_parent_order_trade_linkage": True,
                "required_min_filtered_obi_sample_count": "120",
                "required_min_filtered_obi_stable_split_pass_rate": "0.60",
                "required_max_filtered_obi_best_split_share": "0.35",
            }
        )
        promotion_contract.update(
            {
                "requires_parent_order_trade_linkage": True,
                "requires_structural_order_flow_filters": True,
                "requires_filtered_orderbook_imbalance_replay": True,
                "rejects_unfiltered_obi_only_promotion": True,
            }
        )


def _apply_rejected_signal_outcome_calibration_overlay(
    state: MechanismOverlayState,
) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "rejected trading event",
            "rejected event",
            "rejected-event",
            "rejected signal",
            "rejected_signal",
            "skipped signal",
            "skipped-signal",
            "counterfactual training",
            "counterfactual outcome",
            "counterfactual return",
            "outcome labels",
            "outcome_labels",
            "veto calibration",
            "vetoes discard",
            "discard profitable",
        )
    ):
        overlay_ids.append("rejected_signal_outcome_calibration")
        overlay_contracts.append(
            {
                "overlay_id": "rejected_signal_outcome_calibration",
                "required_evidence": [
                    "rejected_signal_log",
                    "outcome_labels",
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                    "executable_quote",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_rejected_signal_replay",
                "evidence_policy": (
                    "rejected_events_require_labeled_counterfactual_outcomes"
                ),
            }
        )
        hard_vetoes.update(
            {
                "required_min_rejected_signal_outcome_label_count": "120",
                "required_min_rejected_signal_reason_coverage": "0.80",
                "required_max_rejected_signal_outcome_pending_ratio": "0.05",
                "required_rejected_signal_counterfactual_fields": [
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                    "executable_quote",
                ],
                "required_rejected_signal_outcome_persistence_state": "ok",
            }
        )
        promotion_contract.update(
            {
                "requires_rejected_signal_outcome_learning": True,
                "requires_rejected_signal_outcome_labels": True,
                "requires_rejected_signal_reason_coverage": True,
                "requires_rejected_signal_counterfactual_replay": True,
                "requires_counterfactual_executable_quote": True,
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "rejects_pending_rejected_signal_outcome_labels": True,
                "rejects_unlabeled_reject_relaxation": True,
                "promotion_impact": "repair_only_until_labeled",
            }
        )


def _apply_delay_adjusted_depth_stress_overlay(state: MechanismOverlayState) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "delay-adjusted depth",
            "delay adjusted depth",
            "execution delay",
            "execution_delay",
            "market depth",
            "market_depth",
            "depth state",
            "depth_state",
            "latency stress",
            "latency_stress",
            "fillable",
            "fillability",
            "limit_fill_probability",
        )
    ):
        overlay_ids.append("delay_adjusted_depth_stress")
        overlay_contracts.append(
            {
                "overlay_id": "delay_adjusted_depth_stress",
                "required_evidence": [
                    "depth_proxy",
                    "execution_delay",
                    "fill_model",
                    "route_tca",
                    "live_paper_parity",
                ],
                "rank_metric": "post_cost_net_pnl_after_delay_adjusted_depth_stress",
                "evidence_policy": "no_delay_fill_assumptions_are_not_promotion_proof",
            }
        )
        hard_vetoes.update(
            {
                "required_delay_adjusted_depth_stress": True,
                "required_max_route_latency_ms": "250",
                "required_min_delay_depth_sample_count": "60",
            }
        )
        promotion_contract.update(
            {
                "requires_delay_adjusted_depth_stress": True,
                "requires_execution_delay_replay": True,
                "requires_depth_proxy_fill_model": True,
                "requires_route_tca": True,
                "rejects_no_delay_fill_assumptions": True,
            }
        )


def _apply_ohlcv_only_falsification_overlay(state: MechanismOverlayState) -> None:
    has_any = state.has_any
    overlay_ids = state.overlay_ids
    overlay_contracts = state.overlay_contracts
    hard_vetoes = state.hard_vetoes
    promotion_contract = state.promotion_contract

    if has_any(
        (
            "ohlcv-only",
            "ohlcv only",
            "ohlcv_derived",
            "ohlcv-derived",
            "bar-only",
            "bar only",
            "systematic falsification",
        )
    ):
        overlay_ids.append("ohlcv_only_falsification")
        overlay_contracts.append(
            {
                "overlay_id": "ohlcv_only_falsification",
                "required_evidence": [
                    "walk_forward_replay",
                    "executable_quote_evidence",
                    "route_tca",
                    "live_paper_parity",
                ],
                "evidence_policy": "ohlcv_only_is_falsification_not_promotion_proof",
            }
        )
        hard_vetoes.update(
            {
                "required_min_ohlcv_falsification_trade_count": "120",
                "required_min_ohlcv_walk_forward_split_count": "4",
                "required_min_ohlcv_stable_split_pass_rate": "0.60",
                "required_max_ohlcv_best_split_share": "0.35",
                "required_min_route_tca_sample_count": "60",
                "required_executable_quote_evidence": True,
            }
        )
        promotion_contract.update(
            {
                "rejects_ohlcv_only_promotion_evidence": True,
                "requires_walk_forward_replay": True,
                "requires_executable_quote_evidence": True,
                "requires_route_tca": True,
                "requires_minimum_trade_count": True,
                "requires_multi_year_stability_check": True,
                "rejects_naive_gross_ohlcv_backtests": True,
                "positive_control_policy": (
                    "gap_continuation_only_until_post_cost_live_paper_proof"
                ),
            }
        )


def apply_replay_validation_mechanism_overlays(state: MechanismOverlayState) -> None:
    _apply_simulation_reality_gap_implementation_risk_overlay(state)
    _apply_implementation_risk_backtest_stability_overlay(state)
    _apply_replay_paper_live_semantic_parity_overlay(state)
    _apply_intraday_volume_periodicity_execution_overlay(state)
    _apply_macro_announcement_dvar_momentum_overlay(state)
    _apply_ofi_lob_continuation_response_overlay(state)
    _apply_order_flow_filtration_parent_trade_obi_overlay(state)
    _apply_rejected_signal_outcome_calibration_overlay(state)
    _apply_delay_adjusted_depth_stress_overlay(state)
    _apply_ohlcv_only_falsification_overlay(state)


__all__ = ["apply_replay_validation_mechanism_overlays"]
