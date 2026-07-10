"""Trading pipeline implementation."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any


logger = logging.getLogger(__name__)

REJECTED_SIGNAL_OUTCOME_FOLLOWUP_HORIZON = timedelta(minutes=5)

REJECTED_SIGNAL_OUTCOME_LABEL_LIMIT = 25

RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIER = Decimal("0.50")

RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE = Decimal("0.05")

RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS = 120

RUNTIME_REGIME_CONFIDENCE_DEFAULT_THRESHOLDS = (Decimal("0.75"), Decimal("0.55"))

STRATEGY_POSITION_TAG_TOLERANCE = Decimal("0.0001")

STRATEGY_POSITION_TAG_LOOKBACK = timedelta(days=7)


def normalized_symbol(symbol: object) -> str:
    return str(symbol or "").strip().upper()


def aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def same_side_position_exposure(position_qty: Decimal, exposure_qty: Decimal) -> bool:
    if position_qty == 0 or exposure_qty == 0:
        return False
    return (position_qty > 0 and exposure_qty > 0) or (
        position_qty < 0 and exposure_qty < 0
    )


class TradingPipelineBase:
    """Typed contract shared by scheduler pipeline mixins."""

    alpaca_client: Any
    order_firewall: Any
    ingestor: Any
    decision_engine: Any
    risk_engine: Any
    executor: Any
    execution_adapter: Any
    reconciler: Any
    universe_resolver: Any
    state: Any
    account_label: str
    session_factory: Callable[[], Any]
    price_fetcher: Any
    strategy_catalog: Any
    execution_policy: Any
    order_feed_ingestor: Any
    market_context_client: Any
    lean_lane_manager: Any
    llm_review_engine: Any
    _snapshot_cache: Any
    _snapshot_cached_at: Any
    _last_live_submission_gate: Any
    _signal_quote_quality: Any
    _session_context_warmup_day: Any
    _runtime_window_account_snapshot_day: Any

    def _append_autonomy_gate_report_uncertainty_candidate(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _append_direct_runtime_uncertainty_candidate(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _append_forecast_audit_uncertainty_candidate(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _append_runtime_payload_uncertainty_candidate(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _apply_allocation_results(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _apply_bounded_collection_exit_window_audit(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _apply_bounded_collection_target_sizing_audit(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _apply_llm_policy_verdict(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _apply_llm_review(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _apply_portfolio_sizing(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _apply_quote_lookup_diagnostic_reason(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _apply_runtime_uncertainty_gate(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _apply_simple_projected_buying_power(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _apply_simple_projected_position(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _attach_current_session_strategy_position_tags(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _attach_strategy_position_tag(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _attach_strategy_position_tags(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _block_decision_submission(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _bounded_collection_exit_window_elapsed(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _bounded_collection_exit_window_guarded_decision(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _bounded_collection_target_notional_sized_decision(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _bounded_collection_target_sizing_payload(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _bounded_degraded_qty(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _build_llm_response_json(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _build_market_snapshot(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _build_rejected_signal_outcome_payload(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _build_run_context(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _cancel_conflicting_precheck_order(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _capture_runtime_window_account_snapshot_if_due(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _classify_dspy_live_runtime_block(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _decision_has_executable_quote_payload(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _decision_lifecycle_metadata(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _decision_quote_snapshot_for_target_sizing(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _decision_row_age_seconds(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _degrade_llm_runtime_block_qty(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _degrade_runtime_uncertainty_gate_decision(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _dspy_runtime_gate_status(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _emit_domain_telemetry(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _ensure_decision_price(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _ensure_pending_decision_row(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _ensure_signal_executable_price(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _evaluate_execution_policy_outcome(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _evaluate_lean_canary_guard(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _evaluate_signal_decisions(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _execution_client_for_symbol(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _execution_client_name(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _expire_stale_planned_decision(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _feature_quality_failure_payload(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _fetch_market_context(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _finalize_llm_review_outcome(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _get_account_snapshot(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_decision(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_execution_fallback(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_llm_circuit_open(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_llm_dspy_live_runtime_block(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_llm_guardrail_block(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_llm_review_error(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_llm_unavailable(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_order_firewall_block(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _handle_order_submit_exception(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _ingest_order_feed(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _is_actionable_no_signal_reason(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _is_trading_submission_allowed(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _label_mature_rejected_signal_outcome_events(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _live_submission_gate(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _llm_runtime_model_identifier(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _llm_runtime_prompt_identifier(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _load_strategies(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _map_submit_exception(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _maybe_handle_market_context_block(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _maybe_record_lean_strategy_shadow(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _normalize_target_plan_action(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_decision_requires_executable_quote(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_params_with_quote_snapshot(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_price_snapshot_payload(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_quote_routeability(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_quote_routeability_payload(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_quote_routeability_retry_metadata(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _active_bounded_paper_route_target_window(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_probe_exit_metadata(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_probe_context(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_probe_capped_decision(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_retry_transition(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _profitability_proof_floor(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _proof_floor_submission_block_reason(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _proof_floor_symbol_block_reason(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _align_prechecked_paper_route_probe_cap(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _trading_now(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_target_plan_source_mismatch(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_target_quantity_resolution(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_target_sizing_price(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _passes_risk_verdict(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _persist_llm_adjusted_decision(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _persist_llm_review(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _persist_rejected_signal_outcome_event(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _persist_runtime_uncertainty_gate_payload(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _position_qty_for_symbol(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _prepare_batch_for_decisions(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _prepare_decision_for_submission(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _prepare_run_once(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _process_batch_signals(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _quality_gate_signals(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _recheck_runtime_uncertainty_gate_after_llm(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _record_decision_rejection(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_ingest_window(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_lean_shadow_from_execution(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_llm_committee_metrics(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_llm_policy_resolution_metrics(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_llm_token_metrics(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_llm_verdict_counter(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_local_pre_submit_rejection_metrics(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _record_market_context_observation(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_quantity_resolution_metrics(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_rejected_signal_outcome_event(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_runtime_uncertainty_gate_result(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _record_simulation_position_state(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _reject_submit(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _rejected_signal_outcome_event_id(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _relevant_signal_symbols(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _reopen_rejected_paper_route_quote_routeability_decision(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _resolve_execution_context_open_orders(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_execution_context_positions(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_llm_fallback(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_pre_llm_executability_reject(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_regime_confidence_thresholds(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_runtime_regime_confidence_gate(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_runtime_regime_gate(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_runtime_regime_gate_from_hmm(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_runtime_uncertainty_degrade_profile(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _resolve_runtime_uncertainty_gate(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _resolve_runtime_uncertainty_gate_components(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _resolve_runtime_uncertainty_gate_from_inputs(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _resolve_strategy_context(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _run_llm_review_request(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def same_side_position_exposure(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _sell_inventory_context(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _should_degrade_runtime_uncertainty_fail(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _should_degrade_runtime_uncertainty_fail_from_payload(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _simple_shortability_reason(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _split_strategy_position_tags(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _strategy_tagged_position(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _submission_capital_stage(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _submission_control_plane_snapshot(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _submit_decision_execution(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _submit_order_with_handling(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _sync_lean_observability(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _target_plan_action_for_symbol(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _warm_session_context_from_open(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def is_market_session_open(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def reconcile(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def record_no_signal_batch(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def run_once(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _bounded_paper_route_execution_metadata(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _build_empirical_jobs_status(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _build_hypothesis_runtime_summary(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _build_profitability_proof_floor_receipt(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _build_submission_gate_market_context_status(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _build_tca_gate_inputs(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _load_quant_evidence_status(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _is_market_session_open(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_materialized_candidate(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_materialized_decision_with_execution_metadata(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_materialized_planned_candidate(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_materialized_planning_context(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_positions_without_materialized_open_order_projections(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_probe_reference_price(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_target_strategy(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_target_strategy_symbols(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_target_account_has_open_exposure(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_target_source_decision_metadata(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_target_source_cap(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    def _paper_route_target_symbol_has_open_position(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_target_symbol_has_open_profit_proof_exposure(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _paper_route_target_symbol_has_open_strategy_exposure(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _reopen_rejected_paper_route_probe_exit_decision(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _reopen_rejected_paper_route_target_price_decision(
        self, *args: Any, **kwargs: Any
    ) -> Any:
        raise NotImplementedError

    def _with_paper_route_target_lineage(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError
