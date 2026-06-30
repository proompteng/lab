"""Profitability proof-floor receipts for capital-qualified trading routes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from ...config import settings
from ..discovery.promotion_contract import (
    final_authority_parameter_contract,
    probation_evidence_collection_contract,
)
from ..route_reacquisition import build_route_reacquisition_book

from .proof_floor_core import (
    BLOCKING_STATES,
    LIVE_MICRO_STAGES,
    LIVE_SCALE_STAGES,
    add_repair,
    bool_value,
    decimal_value,
    decimal_text,
    hypothesis_repair_target_summary,
    hypothesis_summary,
    int_value,
    mapping_value,
    parse_timestamp,
    reason_counts,
    route_symbol_filter_enabled,
    route_universe_adverse_slippage_clear,
    slippage_guardrails,
    target_notional_parameter_summary,
    tca_symbol_routes,
    text_value,
    truthy,
)


def build_profitability_proof_floor_receipt(
    *,
    account_label: str | None,
    torghut_revision: str | None,
    trading_mode: str,
    market_session_open: bool | None,
    live_submission_gate: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None = None,
    paper_route_probe_target_symbols: Sequence[object] | None = None,
    now: datetime | None = None,
    tca_max_age_seconds: int = 86400,
) -> dict[str, object]:
    """Build an auditable proof-floor receipt before paper/live capital routing.

    The reducer is intentionally conservative: any degraded proof dimension keeps
    capital at zero and emits ranked repair work instead of authorizing notional.
    """

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    summary = hypothesis_summary(hypothesis_payload)
    reasons = reason_counts(hypothesis_payload)
    dimensions: list[dict[str, object]] = []
    repairs: list[dict[str, object]] = []

    def add_dimension(
        *,
        dimension: str,
        state: str,
        reason: str,
        capital_effect: str,
        source_ref: Mapping[str, object] | None = None,
        freshness_seconds: int | None = None,
        threshold_seconds: int | None = None,
    ) -> None:
        dimensions.append(
            {
                "dimension": dimension,
                "state": state,
                "reason": reason,
                "capital_effect": capital_effect,
                "source_ref": dict(source_ref or {}),
                "freshness_seconds": freshness_seconds,
                "threshold_seconds": threshold_seconds,
            }
        )

    gate_allowed = bool_value(live_submission_gate.get("allowed"))
    gate_reason = text_value(live_submission_gate.get("reason"), "unknown")
    live_mode = trading_mode == "live"
    if live_mode and not gate_allowed:
        add_dimension(
            dimension="live_submission_gate",
            state="fail",
            reason=gate_reason,
            capital_effect="live_hold",
            source_ref={
                "capital_stage": live_submission_gate.get("capital_stage"),
                "blocked_reasons": live_submission_gate.get("blocked_reasons") or [],
            },
        )
        add_repair(
            repairs,
            code="live_submit_gate_closed",
            dimension="live_submission_gate",
            action="keep_submit_disabled_until_proof_floor_passes",
            reason=gate_reason,
            priority=80,
        )
    else:
        add_dimension(
            dimension="live_submission_gate",
            state="pass",
            reason=gate_reason or "allowed",
            capital_effect="none",
            source_ref={"capital_stage": live_submission_gate.get("capital_stage")},
        )

    promotion_eligible_total = int_value(summary.get("promotion_eligible_total"))
    rollback_required_total = int_value(summary.get("rollback_required_total"))
    alpha_repair_target_summary = hypothesis_repair_target_summary(hypothesis_payload)
    if promotion_eligible_total <= 0:
        add_dimension(
            dimension="alpha_readiness",
            state="fail",
            reason="alpha_readiness_not_promotion_eligible",
            capital_effect="paper_hold" if not live_mode else "live_hold",
            source_ref={
                "promotion_eligible_total": promotion_eligible_total,
                "rollback_required_total": rollback_required_total,
                "state_totals": summary.get("state_totals") or {},
                "reason_totals": summary.get("reason_totals") or {},
                "informational_reason_totals": summary.get(
                    "informational_reason_totals"
                )
                or {},
                **alpha_repair_target_summary,
            },
        )
        add_repair(
            repairs,
            code="repair_alpha_readiness",
            dimension="alpha_readiness",
            action="clear_hypothesis_blockers_before_capital",
            reason="alpha_readiness_not_promotion_eligible",
            priority=70,
            expected_unblock_value=max(1, len(reasons)),
        )
    else:
        add_dimension(
            dimension="alpha_readiness",
            state="pass",
            reason="promotion_eligible",
            capital_effect="none",
            source_ref={
                "promotion_eligible_total": promotion_eligible_total,
                **alpha_repair_target_summary,
            },
        )

    target_notional_summary = target_notional_parameter_summary(
        hypothesis_payload, simple_lane_status
    )
    target_notional_raw_state = text_value(target_notional_summary.get("state"), "fail")
    target_notional_state = (
        target_notional_raw_state
        if promotion_eligible_total > 0 or target_notional_raw_state == "pass"
        else "informational"
    )
    target_notional_reason = text_value(
        target_notional_summary.get("reason"), "target_notional_parameters_missing"
    )
    if target_notional_state == "fail":
        add_repair(
            repairs,
            code="repair_target_notional_parameters",
            dimension="target_notional_sizing",
            action="collect_positive_post_cost_expectancy_drawdown_and_capacity_evidence",
            reason=target_notional_reason,
            priority=68,
        )
    add_dimension(
        dimension="target_notional_sizing",
        state=target_notional_state,
        reason=target_notional_reason,
        capital_effect="none"
        if target_notional_state in {"informational", "pass"}
        else "paper_hold"
        if not live_mode
        else "live_hold",
        source_ref={
            **target_notional_summary,
            "raw_state": target_notional_raw_state,
        },
    )

    empirical_health_required = bool(settings.trading_empirical_jobs_health_required)
    empirical_ready = bool_value(empirical_jobs_status.get("ready"))
    empirical_status = text_value(empirical_jobs_status.get("status"), "unknown")
    if empirical_ready:
        empirical_state = "pass"
        empirical_effect = "none"
    elif not empirical_health_required:
        empirical_state = "informational"
        empirical_effect = "none"
    else:
        empirical_state = "degraded"
        empirical_effect = "paper_hold" if not live_mode else "live_hold"
        add_repair(
            repairs,
            code="repair_empirical_jobs",
            dimension="empirical",
            action="refresh_empirical_job_receipts",
            reason=empirical_status,
            priority=50,
        )
    add_dimension(
        dimension="empirical",
        state=empirical_state,
        reason=empirical_status,
        capital_effect=empirical_effect,
        source_ref={
            "candidate_ids": empirical_jobs_status.get("candidate_ids") or [],
            "dataset_snapshot_refs": empirical_jobs_status.get("dataset_snapshot_refs")
            or [],
        },
    )

    quant_required = bool_value(quant_evidence.get("required", True))
    quant_status = text_value(quant_evidence.get("status"), "unknown").lower()
    quant_reason = text_value(quant_evidence.get("reason"), quant_status or "unknown")
    if not quant_required and quant_status not in {
        "ok",
        "healthy",
        "pass",
        "not_required",
    }:
        quant_state = "informational"
    elif not bool_value(quant_evidence.get("ok")):
        quant_state = "fail"
    elif quant_status in {"ok", "healthy", "pass", "not_required"}:
        quant_state = "pass"
    else:
        quant_state = "degraded"
    if quant_required and quant_state != "pass":
        add_repair(
            repairs,
            code="repair_quant_ingestion",
            dimension="quant_ingestion",
            action="settle_quant_pipeline_stage_lag",
            reason=quant_reason,
            priority=60,
        )
    add_dimension(
        dimension="quant_ingestion",
        state=quant_state,
        reason=quant_reason,
        capital_effect="none"
        if quant_state in {"informational", "pass"}
        else "paper_hold"
        if not live_mode
        else "live_hold",
        source_ref={
            "required": quant_required,
            "account": quant_evidence.get("account"),
            "window": quant_evidence.get("window"),
            "blocking_reasons": quant_evidence.get("blocking_reasons") or [],
            "informational_reasons": quant_evidence.get("informational_reasons") or [],
            "latest_metrics_updated_at": quant_evidence.get(
                "latest_metrics_updated_at"
            ),
            "max_stage_lag_seconds": quant_evidence.get("max_stage_lag_seconds"),
        },
    )

    simple_status = mapping_value(simple_lane_status)
    order_feed_lifecycle_required = truthy(
        simple_status.get("order_feed_lifecycle_required")
    )
    order_feed_telemetry_enabled = truthy(
        simple_status.get("order_feed_telemetry_enabled")
    )
    order_feed_ingestion_enabled = truthy(
        simple_status.get("order_feed_ingestion_enabled")
    )
    order_feed_bootstrap_configured = truthy(
        simple_status.get("order_feed_bootstrap_configured")
    )
    order_feed_topic_count = int_value(simple_status.get("order_feed_topic_count"))
    if order_feed_lifecycle_required and not order_feed_telemetry_enabled:
        order_feed_state = "fail"
        order_feed_reason = "order_feed_lifecycle_disabled"
        add_repair(
            repairs,
            code="enable_order_feed_lifecycle",
            dimension="order_feed_lifecycle",
            action="enable_simple_order_feed_ingestion_before_proof_floor_authority",
            reason=order_feed_reason,
            priority=72,
        )
    elif order_feed_lifecycle_required and not order_feed_ingestion_enabled:
        order_feed_state = "fail"
        order_feed_reason = "order_feed_ingestion_disabled"
        add_repair(
            repairs,
            code="enable_order_feed_lifecycle",
            dimension="order_feed_lifecycle",
            action="enable_simple_order_feed_ingestion_before_proof_floor_authority",
            reason=order_feed_reason,
            priority=72,
        )
    elif order_feed_lifecycle_required and not order_feed_bootstrap_configured:
        order_feed_state = "fail"
        order_feed_reason = "order_feed_bootstrap_missing"
        add_repair(
            repairs,
            code="enable_order_feed_lifecycle",
            dimension="order_feed_lifecycle",
            action="configure_order_feed_bootstrap_before_proof_floor_authority",
            reason=order_feed_reason,
            priority=72,
        )
    elif order_feed_lifecycle_required and order_feed_topic_count <= 0:
        order_feed_state = "fail"
        order_feed_reason = "order_feed_topic_missing"
        add_repair(
            repairs,
            code="enable_order_feed_lifecycle",
            dimension="order_feed_lifecycle",
            action="configure_order_feed_topic_before_proof_floor_authority",
            reason=order_feed_reason,
            priority=72,
        )
    elif order_feed_lifecycle_required:
        order_feed_state = "pass"
        order_feed_reason = "order_feed_lifecycle_enabled"
    else:
        order_feed_state = "informational"
        order_feed_reason = "order_feed_lifecycle_not_required"
    add_dimension(
        dimension="order_feed_lifecycle",
        state=order_feed_state,
        reason=order_feed_reason,
        capital_effect="none"
        if order_feed_state in {"informational", "pass"}
        else "paper_hold"
        if not live_mode
        else "live_hold",
        source_ref={
            "simple_lane_enabled": truthy(simple_status.get("enabled")),
            "lifecycle_required": order_feed_lifecycle_required,
            "order_feed_telemetry_enabled": order_feed_telemetry_enabled,
            "order_feed_ingestion_enabled": order_feed_ingestion_enabled,
            "order_feed_bootstrap_configured": order_feed_bootstrap_configured,
            "order_feed_topic_count": order_feed_topic_count,
            "order_feed_assignment_mode": simple_status.get(
                "order_feed_assignment_mode"
            ),
            "order_feed_auto_offset_reset": simple_status.get(
                "order_feed_auto_offset_reset"
            ),
            "order_feed_lifecycle_status": simple_status.get(
                "order_feed_lifecycle_status"
            ),
        },
    )

    market_alert = bool_value(market_context_status.get("alert_active"))
    market_context_stale = reasons.get("market_context_stale", 0)
    market_reason = text_value(
        market_context_status.get("alert_reason")
        or market_context_status.get("last_reason"),
        "ok",
    )
    if market_alert or market_context_stale:
        market_stale = bool(market_context_stale) or "stale" in market_reason
        if market_context_stale and not market_alert:
            market_reason = "market_context_stale"
        if market_session_open is False and market_stale:
            market_state = "informational"
            market_reason = "expected_market_closed_staleness"
            add_repair(
                repairs,
                code="closed_session_market_context_hold",
                dimension="market_context",
                action="verify_market_context_freshness_at_next_market_open",
                reason=market_reason,
                priority=15,
                expected_unblock_value=max(1, market_context_stale),
            )
        else:
            market_state = "stale" if market_stale else "degraded"
            add_repair(
                repairs,
                code="repair_market_context",
                dimension="market_context",
                action="refresh_market_context_domains",
                reason=market_reason,
                priority=55,
                expected_unblock_value=max(1, market_context_stale),
            )
    else:
        market_state = "pass"
    add_dimension(
        dimension="market_context",
        state=market_state,
        reason=market_reason,
        capital_effect="none"
        if market_state in {"pass", "informational"}
        else "paper_hold"
        if not live_mode
        else "live_hold",
        source_ref={
            "last_freshness_seconds": market_context_status.get(
                "last_freshness_seconds"
            ),
            "last_quality_score": market_context_status.get("last_quality_score"),
            "last_domain_states": market_context_status.get("last_domain_states") or {},
            "hypothesis_reason_count": market_context_stale,
        },
        freshness_seconds=int_value(
            market_context_status.get("last_freshness_seconds"), -1
        ),
    )

    tca_last_computed_at = parse_timestamp(tca_summary.get("last_computed_at"))
    latest_execution_created_at = parse_timestamp(
        tca_summary.get("latest_execution_created_at")
    )
    tca_unsettled_execution_count = int_value(
        tca_summary.get("unsettled_execution_count")
    )
    tca_settlement_coverage_known = (
        "latest_execution_created_at" in tca_summary
        or "filled_execution_count" in tca_summary
        or "unsettled_execution_count" in tca_summary
    )
    has_unsettled_execution = tca_unsettled_execution_count > 0
    if (
        latest_execution_created_at is not None
        and tca_last_computed_at is not None
        and latest_execution_created_at > tca_last_computed_at
    ):
        has_unsettled_execution = True
    tca_age_seconds = (
        max(0, int((generated_at - tca_last_computed_at).total_seconds()))
        if tca_last_computed_at is not None
        else None
    )
    tca_order_count = int_value(tca_summary.get("order_count"))
    avg_abs_slippage_bps = decimal_value(tca_summary.get("avg_abs_slippage_bps"))
    guardrails = slippage_guardrails(hypothesis_payload)
    slippage_guardrail = min(guardrails) if guardrails else None
    route_slippage_guardrail = max(guardrails) if guardrails else None
    tca_state = "pass"
    tca_reason = "fresh"
    if tca_order_count <= 0:
        tca_state = "missing"
        tca_reason = "execution_tca_missing"
    elif tca_age_seconds is None or (
        (not tca_settlement_coverage_known or has_unsettled_execution)
        and tca_age_seconds > max(0, tca_max_age_seconds)
    ):
        tca_state = "stale"
        tca_reason = "execution_tca_stale"
    elif (
        avg_abs_slippage_bps is not None
        and slippage_guardrail is not None
        and avg_abs_slippage_bps > slippage_guardrail
    ):
        tca_state = "fail"
        tca_reason = "execution_tca_slippage_guardrail_exceeded"
    aggregate_tca_reason = tca_reason
    tca_source_ref: dict[str, object] = {
        "order_count": tca_order_count,
        "last_computed_at": tca_summary.get("last_computed_at"),
        "filled_execution_count": int_value(tca_summary.get("filled_execution_count")),
        "latest_execution_created_at": tca_summary.get("latest_execution_created_at"),
        "unsettled_execution_count": tca_unsettled_execution_count,
        "avg_abs_slippage_bps": decimal_text(avg_abs_slippage_bps),
        "slippage_guardrail_bps": decimal_text(slippage_guardrail),
    }
    symbol_routes = tca_symbol_routes(
        tca_summary,
        slippage_guardrail=slippage_guardrail,
        route_slippage_guardrail=route_slippage_guardrail,
    )
    if symbol_routes is not None:
        tca_source_ref["symbol_routes"] = symbol_routes
        routeable_symbol_count = int_value(symbol_routes.get("routeable_symbol_count"))
        blocked_symbol_count = int_value(symbol_routes.get("blocked_symbol_count"))
        missing_symbol_count = int_value(symbol_routes.get("missing_symbol_count"))
        scope_symbol_count = int_value(symbol_routes.get("scope_symbol_count"))
        excluded_symbol_count = blocked_symbol_count + missing_symbol_count
        route_filter_enabled = route_symbol_filter_enabled(simple_lane_status)
        route_universe_reason = None
        if scope_symbol_count > 0 and routeable_symbol_count <= 0:
            route_universe_reason = "execution_tca_route_universe_empty"
        elif excluded_symbol_count > 0:
            tca_source_ref["route_universe_exclusions"] = {
                "state": "enforced" if route_filter_enabled else "missing_enforcement",
                "enforcement": "route_symbol_filter",
                "candidate_symbol_count": routeable_symbol_count,
                "excluded_symbol_count": excluded_symbol_count,
                "blocked_symbol_count": blocked_symbol_count,
                "missing_symbol_count": missing_symbol_count,
                "max_notional_for_excluded_symbols": "0",
            }
            route_universe_reason = (
                "execution_tca_route_universe_exclusions_applied"
                if route_filter_enabled
                else "execution_tca_route_universe_incomplete"
            )
        elif route_universe_adverse_slippage_clear(
            symbol_routes,
            route_filter_enabled=route_filter_enabled,
            aggregate_tca_reason=aggregate_tca_reason,
        ):
            tca_source_ref["route_universe_adverse_slippage"] = {
                "state": "clear",
                "enforcement": "route_symbol_filter",
                "candidate_symbol_count": routeable_symbol_count,
                "blocked_symbol_count": blocked_symbol_count,
                "missing_symbol_count": missing_symbol_count,
                "max_notional_for_adverse_symbols": "0",
            }
            route_universe_reason = (
                "execution_tca_route_universe_adverse_slippage_clear"
            )
        if route_universe_reason is not None:
            if route_universe_reason == "execution_tca_route_universe_empty":
                tca_state = "fail"
                tca_reason = route_universe_reason
            elif (
                route_universe_reason
                == "execution_tca_route_universe_adverse_slippage_clear"
            ):
                tca_state = "pass"
                tca_reason = route_universe_reason
            elif route_filter_enabled and aggregate_tca_reason in {
                "fresh",
                "execution_tca_slippage_guardrail_exceeded",
            }:
                tca_state = "pass"
                tca_reason = route_universe_reason
            elif not route_filter_enabled:
                tca_state = "fail"
                tca_reason = route_universe_reason
            if aggregate_tca_reason != "fresh":
                tca_source_ref["aggregate_reason"] = aggregate_tca_reason
            if (
                route_universe_reason
                != "execution_tca_route_universe_adverse_slippage_clear"
            ):
                add_repair(
                    repairs,
                    code="repair_route_universe",
                    dimension="route_universe",
                    action="exclude_missing_or_high_slippage_symbols_before_promotion",
                    reason=route_universe_reason,
                    priority=78,
                    expected_unblock_value=max(
                        1,
                        excluded_symbol_count,
                    ),
                )
    if tca_state != "pass":
        add_repair(
            repairs,
            code="repair_execution_tca",
            dimension="execution_tca",
            action="refresh_execution_tca_settlement",
            reason=tca_reason,
            priority=65,
            expected_unblock_value=max(1, reasons.get("tca_evidence_stale", 0)),
        )
    add_dimension(
        dimension="execution_tca",
        state=tca_state,
        reason=tca_reason,
        capital_effect="none"
        if tca_state == "pass"
        else "paper_hold"
        if not live_mode
        else "live_hold",
        source_ref=tca_source_ref,
        freshness_seconds=tca_age_seconds,
        threshold_seconds=max(0, tca_max_age_seconds),
    )

    feature_rows_missing = reasons.get("feature_rows_missing", 0)
    required_feature_set_unavailable = reasons.get(
        "required_feature_set_unavailable",
        0,
    )
    if feature_rows_missing or required_feature_set_unavailable:
        add_repair(
            repairs,
            code="repair_feature_coverage",
            dimension="features",
            action="backfill_hypothesis_feature_rows",
            reason="feature_rows_missing",
            priority=45,
            expected_unblock_value=feature_rows_missing
            + required_feature_set_unavailable,
        )
    drift_checks_missing = reasons.get("drift_checks_missing", 0)
    if drift_checks_missing:
        add_repair(
            repairs,
            code="repair_drift_governance",
            dimension="drift",
            action="run_hypothesis_drift_checks",
            reason="drift_checks_missing",
            priority=40,
            expected_unblock_value=drift_checks_missing,
        )
    signal_lag_exceeded = reasons.get("signal_lag_exceeded", 0)
    if signal_lag_exceeded:
        if market_session_open:
            add_repair(
                repairs,
                code="repair_signal_freshness",
                dimension="signal_continuity",
                action="restore_actionable_signal_ingestion",
                reason="signal_lag_exceeded",
                priority=75,
                expected_unblock_value=signal_lag_exceeded,
            )
        else:
            add_repair(
                repairs,
                code="closed_session_signal_hold",
                dimension="signal_continuity",
                action="verify_signal_freshness_at_next_market_open",
                reason="expected_market_closed_staleness",
                priority=15,
                expected_unblock_value=signal_lag_exceeded,
            )

    blocking_dimensions = [
        item for item in dimensions if text_value(item.get("state")) in BLOCKING_STATES
    ]
    active_stage = text_value(
        live_submission_gate.get("active_capital_stage")
        or live_submission_gate.get("capital_stage"),
        "shadow",
    )
    configured_max_notional = None
    if isinstance(simple_lane_status, Mapping):
        configured_max_notional = simple_lane_status.get("max_notional_per_order")

    if blocking_dimensions:
        route_state = "repair_only"
        capital_state = "zero_notional"
        floor_state = "repair_only"
        max_notional = "0"
    elif market_session_open is False:
        route_state = "observe_only"
        capital_state = "closed_session_hold"
        floor_state = "shadow_ready"
        max_notional = "0"
    elif live_mode:
        if active_stage in LIVE_SCALE_STAGES:
            route_state = "live_scale_candidate"
        elif active_stage in LIVE_MICRO_STAGES:
            route_state = "live_micro_candidate"
        else:
            route_state = "live_micro_candidate"
        capital_state = "live_allowed"
        floor_state = (
            "live_micro_ready"
            if route_state == "live_micro_candidate"
            else "live_scale_ready"
        )
        max_notional = text_value(configured_max_notional, "configured_by_risk")
    else:
        route_state = "paper_candidate"
        capital_state = "paper_allowed"
        floor_state = "paper_ready"
        max_notional = text_value(configured_max_notional, "configured_by_risk")

    ordered_repairs = sorted(
        repairs,
        key=lambda item: (
            -int_value(item.get("priority")),
            -int_value(item.get("expected_unblock_value")),
            text_value(item.get("code")),
        ),
    )
    blocking_codes = sorted(
        {
            text_value(item.get("reason"))
            for item in blocking_dimensions
            if text_value(item.get("reason"))
        }
    )

    receipt: dict[str, object] = {
        "schema_version": "torghut.profitability-proof-floor.v1",
        "generated_at": generated_at.isoformat(),
        "account_label": account_label,
        "torghut_revision": torghut_revision,
        "market_window": {
            "session_open": market_session_open,
        },
        "floor_state": floor_state,
        "route_state": route_state,
        "capital_state": capital_state,
        "max_notional": max_notional,
        "blocking_reasons": blocking_codes,
        "proof_dimensions": dimensions,
        "repair_ladder": ordered_repairs,
        "fresh_until": None if blocking_dimensions else generated_at.isoformat(),
        "target_notional_parameters": target_notional_summary,
        "promotion_authority_parameters": {
            "final_authority": final_authority_parameter_contract(),
            "probation_evidence_collection": probation_evidence_collection_contract(),
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
        },
    }
    paper_route_probe_enabled = False
    paper_route_probe_allow_live_mode = False
    paper_route_probe_max_notional: object | None = None
    if isinstance(simple_lane_status, Mapping):
        paper_route_probe_enabled = truthy(
            simple_lane_status.get("paper_route_probe_enabled")
        )
        paper_route_probe_allow_live_mode = truthy(
            simple_lane_status.get("paper_route_probe_allow_live_mode")
        )
        paper_route_probe_max_notional = simple_lane_status.get(
            "paper_route_probe_max_notional"
        )
    route_reacquisition_book = build_route_reacquisition_book(
        proof_floor_receipt=receipt,
        trading_mode=trading_mode,
        market_session_open=market_session_open,
        paper_route_probe_enabled=paper_route_probe_enabled,
        paper_route_probe_allow_live_mode=paper_route_probe_allow_live_mode,
        paper_route_probe_max_notional=paper_route_probe_max_notional,
        paper_route_probe_target_symbols=paper_route_probe_target_symbols,
    )
    receipt["route_reacquisition_book"] = route_reacquisition_book
    receipt["paper_route_probe"] = route_reacquisition_book.get("paper_route_probe")
    return receipt


__all__ = ["build_profitability_proof_floor_receipt"]
