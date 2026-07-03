"""Profitability proof-floor receipts for capital-qualified trading routes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

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


@dataclass(frozen=True)
class _ProofContext:
    """Immutable context computed from all proof-floor dimensions."""

    generated_at: datetime
    live_mode: bool
    market_session_open: bool | None
    live_submission_gate: Mapping[str, Any]
    simple_lane_status: Mapping[str, Any] | None
    paper_route_probe_target_symbols: Sequence[object] | None

    dimensions: list[dict[str, object]] = field(default_factory=list)
    repairs: list[dict[str, object]] = field(default_factory=list)

    def add_dimension(self, **kwargs: object) -> None:
        self.dimensions.append(kwargs)

    def add_repair(self, **kwargs: object) -> None:
        kwargs.setdefault("priority", 50)
        self.repairs.append(kwargs)


def _add_capital_effect(state: str, live_mode: bool) -> str:
    if state in {"informational", "pass"}:
        return "none"
    return "live_hold" if live_mode else "paper_hold"


def _capital_hold(ctx: _ProofContext) -> str:
    return "live_hold" if ctx.live_mode else "paper_hold"


# ---------------------------------------------------------------------------
# Individual dimension validators
# ---------------------------------------------------------------------------

def _validate_live_submission_gate(
    ctx: _ProofContext,
    gate_allowed: bool,
    gate_reason: str,
) -> None:
    if ctx.live_mode and not gate_allowed:
        ctx.add_dimension(
            dimension="live_submission_gate",
            state="fail",
            reason=gate_reason,
            capital_effect="live_hold",
            source_ref={
                "capital_stage": ctx.live_submission_gate.get("capital_stage"),
                "blocked_reasons": ctx.live_submission_gate.get("blocked_reasons") or [],
            },
        )
        ctx.add_repair(
            code="live_submit_gate_closed",
            dimension="live_submission_gate",
            action="keep_submit_disabled_until_proof_floor_passes",
            reason=gate_reason,
            priority=80,
        )
    else:
        ctx.add_dimension(
            dimension="live_submission_gate",
            state="pass",
            reason=gate_reason or "allowed",
            capital_effect="none",
            source_ref={"capital_stage": ctx.live_submission_gate.get("capital_stage")},
        )


def _validate_alpha_readiness(
    ctx: _ProofContext,
    promotion_eligible_total: int,
    summary: dict[str, Any],
) -> None:
    if promotion_eligible_total <= 0:
        alpha_repair_target_summary = hypothesis_repair_target_summary(
            ctx.live_submission_gate  # type: ignore[arg-type]
        )
        ctx.add_dimension(
            dimension="alpha_readiness",
            state="fail",
            reason="alpha_readiness_not_promotion_eligible",
            capital_effect=_capital_hold(ctx),
            source_ref={
                "promotion_eligible_total": promotion_eligible_total,
                "rollback_required_total": int_value(summary.get("rollback_required_total")),
                "state_totals": summary.get("state_totals") or {},
                "reason_totals": summary.get("reason_totals") or {},
                "informational_reason_totals": summary.get("informational_reason_totals") or {},
                **alpha_repair_target_summary,
            },
        )
        ctx.add_repair(
            code="repair_alpha_readiness",
            dimension="alpha_readiness",
            action="clear_hypothesis_blockers_before_capital",
            reason="alpha_readiness_not_promotion_eligible",
            priority=70,
            expected_unblock_value=max(1, len(reason_counts({}))),
        )
    else:
        ctx.add_dimension(
            dimension="alpha_readiness",
            state="pass",
            reason="promotion_eligible",
            capital_effect="none",
            source_ref={
                "promotion_eligible_total": promotion_eligible_total,
            },
        )


def _validate_target_notional_sizing(
    ctx: _ProofContext,
    hypothesis_payload: Mapping[str, Any],
) -> None:
    target_notional_summary = target_notional_parameter_summary(
        hypothesis_payload, ctx.simple_lane_status
    )
    target_notional_raw_state = text_value(target_notional_summary.get("state"), "fail")
    promotion_eligible_total = int_value(
        hypothesis_summary(hypothesis_payload).get("promotion_eligible_total")
    )
    target_notional_state = (
        target_notional_raw_state
        if promotion_eligible_total > 0 or target_notional_raw_state == "pass"
        else "informational"
    )
    target_notional_reason = text_value(
        target_notional_summary.get("reason"), "target_notional_parameters_missing"
    )
    if target_notional_state == "fail":
        ctx.add_repair(
            code="repair_target_notional_parameters",
            dimension="target_notional_sizing",
            action="collect_positive_post_cost_expectancy_drawdown_and_capacity_evidence",
            reason=target_notional_reason,
            priority=68,
        )
    ctx.add_dimension(
        dimension="target_notional_sizing",
        state=target_notional_state,
        reason=target_notional_reason,
        capital_effect="none"
        if target_notional_state in {"informational", "pass"}
        else _capital_hold(ctx),
        source_ref={
            **target_notional_summary,
            "raw_state": target_notional_raw_state,
        },
    )


def _validate_empirical(
    ctx: _ProofContext,
    empirical_jobs_status: Mapping[str, Any],
) -> None:
    empirical_ready = bool_value(empirical_jobs_status.get("ready"))
    empirical_status = text_value(empirical_jobs_status.get("status"), "unknown")
    if empirical_ready:
        empirical_state = "pass"
        empirical_effect = "none"
    else:
        empirical_state = "degraded"
        empirical_effect = _capital_hold(ctx)
        ctx.add_repair(
            code="repair_empirical_jobs",
            dimension="empirical",
            action="refresh_empirical_job_receipts",
            reason=empirical_status,
            priority=50,
        )
    ctx.add_dimension(
        dimension="empirical",
        state=empirical_state,
        reason=empirical_status,
        capital_effect=empirical_effect,
        source_ref={
            "candidate_ids": empirical_jobs_status.get("candidate_ids") or [],
            "dataset_snapshot_refs": empirical_jobs_status.get("dataset_snapshot_refs") or [],
        },
    )


def _validate_quant_ingestion(
    ctx: _ProofContext,
    quant_evidence: Mapping[str, Any],
) -> None:
    quant_required = bool_value(quant_evidence.get("required", True))
    quant_status = text_value(quant_evidence.get("status"), "unknown").lower()
    quant_reason = text_value(quant_evidence.get("reason"), quant_status or "unknown")

    quant_state: str
    if not quant_required and quant_status not in {"ok", "healthy", "pass", "not_required"}:
        quant_state = "informational"
    elif not bool_value(quant_evidence.get("ok")):
        quant_state = "fail"
    elif quant_status in {"ok", "healthy", "pass", "not_required"}:
        quant_state = "pass"
    else:
        quant_state = "degraded"

    if quant_required and quant_state != "pass":
        ctx.add_repair(
            code="repair_quant_ingestion",
            dimension="quant_ingestion",
            action="settle_quant_pipeline_stage_lag",
            reason=quant_reason,
            priority=60,
        )

    ctx.add_dimension(
        dimension="quant_ingestion",
        state=quant_state,
        reason=quant_reason,
        capital_effect="none" if quant_state in {"informational", "pass"} else _capital_hold(ctx),
        source_ref={
            "required": quant_required,
            "account": quant_evidence.get("account"),
            "window": quant_evidence.get("window"),
            "blocking_reasons": quant_evidence.get("blocking_reasons") or [],
            "informational_reasons": quant_evidence.get("informational_reasons") or [],
            "latest_metrics_updated_at": quant_evidence.get("latest_metrics_updated_at"),
            "max_stage_lag_seconds": quant_evidence.get("max_stage_lag_seconds"),
        },
    )


def _validate_order_feed_lifecycle(
    ctx: _ProofContext,
    simple_status: Mapping[str, Any],
) -> None:
    lifecycle_required = truthy(simple_status.get("order_feed_lifecycle_required"))
    telemetry_enabled = truthy(simple_status.get("order_feed_telemetry_enabled"))
    ingestion_enabled = truthy(simple_status.get("order_feed_ingestion_enabled"))
    bootstrap_configured = truthy(simple_status.get("order_feed_bootstrap_configured"))
    topic_count = int_value(simple_status.get("order_feed_topic_count"))

    if not lifecycle_required:
        state, reason = "informational", "order_feed_lifecycle_not_required"
    elif lifecycle_required and not telemetry_enabled:
        state, reason = "fail", "order_feed_lifecycle_disabled"
        _repair_order_feed(ctx, "enable_order_feed_lifecycle", "enable_simple_order_feed_ingestion_before_proof_floor_authority", reason)
    elif lifecycle_required and not ingestion_enabled:
        state, reason = "fail", "order_feed_ingestion_disabled"
        _repair_order_feed(ctx, "enable_order_feed_lifecycle", "enable_simple_order_feed_ingestion_before_proof_floor_authority", reason)
    elif lifecycle_required and not bootstrap_configured:
        state, reason = "fail", "order_feed_bootstrap_missing"
        _repair_order_feed(ctx, "enable_order_feed_lifecycle", "configure_order_feed_bootstrap_before_proof_floor_authority", reason)
    elif lifecycle_required and topic_count <= 0:
        state, reason = "fail", "order_feed_topic_missing"
        _repair_order_feed(ctx, "enable_order_feed_lifecycle", "configure_order_feed_topic_before_proof_floor_authority", reason)
    elif lifecycle_required:
        state, reason = "pass", "order_feed_lifecycle_enabled"
    else:
        state, reason = "informational", "order_feed_lifecycle_not_required"

    ctx.add_dimension(
        dimension="order_feed_lifecycle",
        state=state,
        reason=reason,
        capital_effect="none" if state in {"informational", "pass"} else _capital_hold(ctx),
        source_ref={
            "simple_lane_enabled": truthy(simple_status.get("enabled")),
            "lifecycle_required": lifecycle_required,
            "order_feed_telemetry_enabled": telemetry_enabled,
            "order_feed_ingestion_enabled": ingestion_enabled,
            "order_feed_bootstrap_configured": bootstrap_configured,
            "order_feed_topic_count": topic_count,
            "order_feed_assignment_mode": simple_status.get("order_feed_assignment_mode"),
            "order_feed_auto_offset_reset": simple_status.get("order_feed_auto_offset_reset"),
            "order_feed_lifecycle_status": simple_status.get("order_feed_lifecycle_status"),
        },
    )


def _repair_order_feed(ctx: _ProofContext, code: str, action: str, reason: str) -> None:
    ctx.add_repair(
        code=code,
        dimension="order_feed_lifecycle",
        action=action,
        reason=reason,
        priority=72,
    )


def _validate_market_context(
    ctx: _ProofContext,
    market_context_status: Mapping[str, Any],
    reasons: dict[str, Any],
) -> None:
    market_alert = bool_value(market_context_status.get("alert_active"))
    market_context_stale = reasons.get("market_context_stale", 0)
    market_reason = text_value(
        market_context_status.get("alert_reason")
        or market_context_status.get("last_reason"),
        "ok",
    )

    if not market_alert and not market_context_stale:
        ctx.add_dimension(
            dimension="market_context",
            state="pass",
            reason=market_reason,
            capital_effect="none",
            source_ref={
                "last_freshness_seconds": market_context_status.get("last_freshness_seconds"),
                "last_quality_score": market_context_status.get("last_quality_score"),
                "last_domain_states": market_context_status.get("last_domain_states") or {},
                "hypothesis_reason_count": market_context_stale,
            },
        )
        return

    market_stale = bool(market_context_stale) or "stale" in market_reason
    if market_context_stale and not market_alert:
        market_reason = "market_context_stale"

    if ctx.market_session_open is False and market_stale:
        market_state = "informational"
        market_reason = "expected_market_closed_staleness"
        ctx.add_repair(
            code="closed_session_market_context_hold",
            dimension="market_context",
            action="verify_market_context_freshness_at_next_market_open",
            reason=market_reason,
            priority=15,
            expected_unblock_value=max(1, market_context_stale),
        )
    else:
        market_state = "stale" if market_stale else "degraded"
        ctx.add_repair(
            code="repair_market_context",
            dimension="market_context",
            action="refresh_market_context_domains",
            reason=market_reason,
            priority=55,
            expected_unblock_value=max(1, market_context_stale),
        )

    ctx.add_dimension(
        dimension="market_context",
        state=market_state,
        reason=market_reason,
        capital_effect="none" if market_state in {"pass", "informational"} else _capital_hold(ctx),
        source_ref={
            "last_freshness_seconds": market_context_status.get("last_freshness_seconds"),
            "last_quality_score": market_context_status.get("last_quality_score"),
            "last_domain_states": market_context_status.get("last_domain_states") or {},
            "hypothesis_reason_count": market_context_stale,
        },
        freshness_seconds=int_value(market_context_status.get("last_freshness_seconds", -1)),
    )


def _tca_age_seconds(tca_summary: Mapping[str, Any], generated_at: datetime) -> int | None:
    tca_last_computed_at = parse_timestamp(tca_summary.get("last_computed_at"))
    tca_last_exec = parse_timestamp(tca_summary.get("latest_execution_created_at"))
    tca_settle_known = (
        "latest_execution_created_at" in tca_summary
        or "filled_execution_count" in tca_summary
        or "unsettled_execution_count" in tca_summary
    )
    has_unsettled = int_value(tca_summary.get("unsettled_execution_count")) > 0
    if tca_last_exec is not None and tca_last_computed_at is not None and tca_last_exec > tca_last_computed_at:
        has_unsettled = True
    if tca_last_computed_at is None:
        return None
    raw = int((generated_at - tca_last_computed_at).total_seconds())
    return max(0, raw) if raw >= 0 else None


def _determine_tca_state(
    tca_summary: Mapping[str, Any],
    tca_age_seconds: int | None,
    tca_max_age_seconds: int,
) -> tuple[str, str]:
    tca_order_count = int_value(tca_summary.get("order_count"))
    tca_unsettled = int_value(tca_summary.get("unsettled_execution_count"))
    tca_settle_known = (
        "latest_execution_created_at" in tca_summary
        or "filled_execution_count" in tca_summary
        or "unsettled_execution_count" in tca_summary
    )
    has_unsettled = tca_unsettled > 0
    tca_last_exec = parse_timestamp(tca_summary.get("latest_execution_created_at"))
    tca_last_computed = parse_timestamp(tca_summary.get("last_computed_at"))
    if tca_last_exec is not None and tca_last_computed is not None and tca_last_exec > tca_last_computed:
        has_unsettled = True

    tca_state: str
    tca_reason: str
    if tca_order_count <= 0:
        tca_state, tca_reason = "missing", "execution_tca_missing"
    elif tca_age_seconds is None or (
        (not tca_settle_known or has_unsettled)
        and tca_age_seconds > max(0, tca_max_age_seconds)
    ):
        tca_state, tca_reason = "stale", "execution_tca_stale"
    else:
        avg_slippage = decimal_value(tca_summary.get("avg_abs_slippage_bps"))
        guardrails = slippage_guardrails({})
        guardrail = min(guardrails) if guardrails else None
        if avg_slippage is not None and guardrail is not None and avg_slippage > guardrail:
            tca_state, tca_reason = "fail", "execution_tca_slippage_guardrail_exceeded"
        else:
            tca_state, tca_reason = "pass", "fresh"
    return tca_state, tca_reason


def _build_tca_source_ref(
    tca_summary: Mapping[str, Any],
    tca_age_seconds: int | None,
) -> dict[str, Any]:
    tca_order_count = int_value(tca_summary.get("order_count"))
    tca_unsettled = int_value(tca_summary.get("unsettled_execution_count"))
    avg_slippage = decimal_value(tca_summary.get("avg_abs_slippage_bps"))
    guardrails = slippage_guardrails({})
    return {
        "order_count": tca_order_count,
        "last_computed_at": tca_summary.get("last_computed_at"),
        "filled_execution_count": int_value(tca_summary.get("filled_execution_count")),
        "latest_execution_created_at": tca_summary.get("latest_execution_created_at"),
        "unsettled_execution_count": tca_unsettled,
        "avg_abs_slippage_bps": decimal_text(avg_slippage),
        "slippage_guardrail_bps": decimal_text(min(guardrails) if guardrails else None),
    }


def _validate_execution_tca(
    ctx: _ProofContext,
    tca_summary: Mapping[str, Any],
    tca_max_age_seconds: int,
) -> None:
    tca_age = _tca_age_seconds(tca_summary, ctx.generated_at)
    tca_state, tca_reason = _determine_tca_state(tca_summary, tca_age, tca_max_age_seconds)
    tca_source_ref = _build_tca_source_ref(tca_summary, tca_age)
    if tca_state != "pass" and tca_reason == "fresh":
        tca_source_ref["aggregate_reason"] = tca_reason
    symbol_routes = tca_symbol_routes(tca_summary, slippage_guardrails({}), slippage_guardrails({}))
    if symbol_routes is not None:
        tca_source_ref["symbol_routes"] = symbol_routes
    _validate_tca_symbol_routes(ctx, tca_summary, tca_state, tca_reason, tca_source_ref, None, 0)
    if tca_state != "pass":
        reasons = reason_counts({})
        ctx.add_repair(
            code="repair_execution_tca",
            dimension="execution_tca",
            action="refresh_execution_tca_settlement",
            reason=tca_reason,
            priority=65,
            expected_unblock_value=max(1, reasons.get("tca_evidence_stale", 0)),
        )
    ctx.add_dimension(
        dimension="execution_tca",
        state=tca_state,
        reason=tca_reason,
        capital_effect="none" if tca_state == "pass" else _capital_hold(ctx),
        source_ref=tca_source_ref,
        freshness_seconds=tca_age,
        threshold_seconds=max(0, tca_max_age_seconds),
    )


def _validate_tca_symbol_routes(
    ctx: _ProofContext,
    tca_summary: Mapping[str, Any],
    tca_state: str,
    tca_reason: str,
    tca_source_ref: dict[str, object],
    avg_abs_slippage_bps: Any,
    tca_order_count: int,
) -> None:
    if tca_state != "pass" and tca_reason == "fresh":
        tca_source_ref["aggregate_reason"] = tca_reason

    symbol_routes = tca_symbol_routes(tca_summary, slippage_guardrails({}), slippage_guardrails({}))
    if symbol_routes is None:
        return

    tca_source_ref["symbol_routes"] = symbol_routes
    routeable_symbol_count = int_value(symbol_routes.get("routeable_symbol_count"))
    blocked_symbol_count = int_value(symbol_routes.get("blocked_symbol_count"))
    missing_symbol_count = int_value(symbol_routes.get("missing_symbol_count"))
    scope_symbol_count = int_value(symbol_routes.get("scope_symbol_count"))
    excluded_symbol_count = blocked_symbol_count + missing_symbol_count
    route_filter_enabled = route_symbol_filter_enabled({})

    route_universe_reason: str | None = None
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
        aggregate_tca_reason=tca_reason,
    ):
        tca_source_ref["route_universe_adverse_slippage"] = {
            "state": "clear",
            "enforcement": "route_symbol_filter",
            "candidate_symbol_count": routeable_symbol_count,
            "blocked_symbol_count": blocked_symbol_count,
            "missing_symbol_count": missing_symbol_count,
            "max_notional_for_adverse_symbols": "0",
        }
        route_universe_reason = "execution_tca_route_universe_adverse_slippage_clear"

    if route_universe_reason is not None:
        _apply_route_universe_result(ctx, route_universe_reason, route_filter_enabled, tca_state, tca_reason, excluded_symbol_count, tca_source_ref)


def _apply_route_universe_result(
    ctx: _ProofContext,
    route_universe_reason: str,
    route_filter_enabled: bool,
    current_tca_state: str,
    aggregate_tca_reason: str,
    excluded_symbol_count: int,
    tca_source_ref: dict[str, object],
) -> None:
    new_state = current_tca_state
    new_reason = aggregate_tca_reason

    if route_universe_reason == "execution_tca_route_universe_empty":
        new_state = "fail"
        new_reason = route_universe_reason
    elif route_universe_reason == "execution_tca_route_universe_adverse_slippage_clear":
        new_state = "pass"
        new_reason = route_universe_reason
    elif route_filter_enabled and aggregate_tca_reason in {"fresh", "execution_tca_slippage_guardrail_exceeded"}:
        new_state = "pass"
        new_reason = route_universe_reason
    elif not route_filter_enabled:
        new_state = "fail"
        new_reason = route_universe_reason

    if new_state != current_tca_state:
        tca_source_ref["aggregate_reason"] = aggregate_tca_reason
    if new_reason != "execution_tca_route_universe_adverse_slippage_clear":
        ctx.add_repair(
            code="repair_route_universe",
            dimension="route_universe",
            action="exclude_missing_or_high_slippage_symbols_before_promotion",
            reason=route_universe_reason,
            priority=78,
            expected_unblock_value=max(1, excluded_symbol_count),
        )


def _validate_gate_and_core(
    ctx: _ProofContext,
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
) -> None:
    summary = hypothesis_summary(hypothesis_payload)
    reasons = reason_counts(hypothesis_payload)
    _validate_live_submission_gate(
        ctx,
        gate_allowed=bool_value(ctx.live_submission_gate.get("allowed")),
        gate_reason=text_value(ctx.live_submission_gate.get("reason"), "unknown"),
    )
    _validate_alpha_readiness(ctx, int_value(summary.get("promotion_eligible_total")), summary)
    _validate_target_notional_sizing(ctx, hypothesis_payload)
    _validate_empirical(ctx, empirical_jobs_status)
    _validate_quant_ingestion(ctx, quant_evidence)
    simple_status = mapping_value(ctx.simple_lane_status) if isinstance(ctx.simple_lane_status, Mapping) else {}
    _validate_order_feed_lifecycle(ctx, simple_status)
    _validate_market_context(ctx, market_context_status, reasons)


def _validate_secondary_repairs(ctx: _ProofContext, reasons: dict[str, Any]) -> None:
    feature_rows_missing = reasons.get("feature_rows_missing", 0)
    required_feature_set_unavailable = reasons.get("required_feature_set_unavailable", 0)
    if feature_rows_missing or required_feature_set_unavailable:
        ctx.add_repair(
            code="repair_feature_coverage",
            dimension="features",
            action="backfill_hypothesis_feature_rows",
            reason="feature_rows_missing",
            priority=45,
            expected_unblock_value=feature_rows_missing + required_feature_set_unavailable,
        )

    drift_checks_missing = reasons.get("drift_checks_missing", 0)
    if drift_checks_missing:
        ctx.add_repair(
            code="repair_drift_governance",
            dimension="drift",
            action="run_hypothesis_drift_checks",
            reason="drift_checks_missing",
            priority=40,
            expected_unblock_value=drift_checks_missing,
        )

    signal_lag_exceeded = reasons.get("signal_lag_exceeded", 0)
    if signal_lag_exceeded:
        if ctx.market_session_open:
            ctx.add_repair(
                code="repair_signal_freshness",
                dimension="signal_continuity",
                action="restore_actionable_signal_ingestion",
                reason="signal_lag_exceeded",
                priority=75,
                expected_unblock_value=signal_lag_exceeded,
            )
        else:
            ctx.add_repair(
                code="closed_session_signal_hold",
                dimension="signal_continuity",
                action="verify_signal_freshness_at_next_market_open",
                reason="expected_market_closed_staleness",
                priority=15,
                expected_unblock_value=signal_lag_exceeded,
            )


# ---------------------------------------------------------------------------
# State computation
# ---------------------------------------------------------------------------

def _determine_route_state(
    ctx: _ProofContext,
    blocking_dimensions: list[dict[str, object]],
    simple_lane_status: Mapping[str, Any] | None,
) -> tuple[str, str, str, str]:
    """Return (route_state, capital_state, floor_state, max_notional)."""
    if blocking_dimensions:
        return ("repair_only", "zero_notional", "repair_only", "0")
    if ctx.market_session_open is False:
        return ("observe_only", "closed_session_hold", "shadow_ready", "0")
    if ctx.live_mode:
        active_stage = text_value(
            ctx.live_submission_gate.get("active_capital_stage")
            or ctx.live_submission_gate.get("capital_stage"),
            "shadow",
        )
        if active_stage in LIVE_SCALE_STAGES:
            route_state = "live_scale_candidate"
        else:
            route_state = "live_micro_candidate"
        floor_state = (
            "live_micro_ready" if route_state == "live_micro_candidate" else "live_scale_ready"
        )
        return (route_state, "live_allowed", floor_state, "0")
    return ("paper_candidate", "paper_allowed", "paper_ready", "0")


def _compute_final_state(
    ctx: _ProofContext,
    simple_lane_status: Mapping[str, Any] | None,
    account_label: str | None,
    torghut_revision: str | None,
) -> dict[str, object]:
    """Assemble the final receipt from all validated dimensions."""

    blocking_dimensions = [
        item for item in ctx.dimensions
        if text_value(item.get("state")) in BLOCKING_STATES
    ]
    route_state, capital_state, floor_state, max_notional = _determine_route_state(
        ctx, blocking_dimensions, simple_lane_status
    )
    if isinstance(simple_lane_status, Mapping):
        max_notional = text_value(
            simple_lane_status.get("max_notional_per_order"), max_notional
        )

    ordered_repairs = sorted(
        ctx.repairs,
        key=lambda item: (
            -int_value(item.get("priority")),
            -int_value(item.get("expected_unblock_value")),
            text_value(item.get("code")),
        ),
    )
    blocking_codes = sorted(
        {text_value(item.get("reason")) for item in blocking_dimensions if text_value(item.get("reason"))}
    )

    return _build_receipt_dict(
        ctx,
        account_label,
        torghut_revision,
        route_state,
        capital_state,
        floor_state,
        max_notional,
        blocking_codes,
        ordered_repairs,
    )


def _build_receipt_dict(
    ctx: _ProofContext,
    account_label: str | None,
    torghut_revision: str | None,
    route_state: str,
    capital_state: str,
    floor_state: str,
    max_notional: str,
    blocking_codes: list[str],
    ordered_repairs: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "schema_version": "torghut.profitability-proof-floor.v1",
        "generated_at": ctx.generated_at.isoformat(),
        "account_label": account_label,
        "torghut_revision": torghut_revision,
        "market_window": {"session_open": ctx.market_session_open},
        "floor_state": floor_state,
        "route_state": route_state,
        "capital_state": capital_state,
        "max_notional": max_notional,
        "blocking_reasons": blocking_codes,
        "proof_dimensions": ctx.dimensions,
        "repair_ladder": ordered_repairs,
        "fresh_until": None if blocking_codes else ctx.generated_at.isoformat(),
        "target_notional_parameters": {},
        "promotion_authority_parameters": {
            "final_authority": final_authority_parameter_contract(),
            "probation_evidence_collection": probation_evidence_collection_contract(),
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
        },
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _assemble_receipt(ctx: _ProofContext, simple_lane_status: Mapping[str, Any] | None, account_label: str | None, torghut_revision: str | None) -> dict[str, object]:
    """Assemble final receipt from context."""
    receipt = _compute_final_state(ctx, simple_lane_status, account_label, torghut_revision)
    _attach_route_book(receipt, simple_lane_status)
    return receipt


def _attach_route_book(receipt: dict[str, object], simple_lane_status: Mapping[str, Any] | None) -> None:
    probe_enabled = False
    probe_allow_live = False
    probe_max_notional: object | None = None
    if isinstance(simple_lane_status, Mapping):
        probe_enabled = truthy(simple_lane_status.get("paper_route_probe_enabled"))
        probe_allow_live = truthy(simple_lane_status.get("paper_route_probe_allow_live_mode"))
        probe_max_notional = simple_lane_status.get("paper_route_probe_max_notional")

    route_reacquisition_book = build_route_reacquisition_book(
        proof_floor_receipt=receipt,
        trading_mode="paper",
        market_session_open=None,
        paper_route_probe_enabled=probe_enabled,
        paper_route_probe_allow_live_mode=probe_allow_live,
        paper_route_probe_max_notional=probe_max_notional,
        paper_route_probe_target_symbols=paper_route_probe_target_symbols,
    )
    receipt["route_reacquisition_book"] = route_reacquisition_book
    receipt["paper_route_probe"] = route_reacquisition_book.get("paper_route_probe")


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
    """Build an auditable proof-floor receipt before paper/live capital routing."""
    return _run_validation(
        trading_mode,
        market_session_open,
        live_submission_gate,
        hypothesis_payload,
        empirical_jobs_status,
        quant_evidence,
        market_context_status,
        tca_summary,
        simple_lane_status,
        paper_route_probe_target_symbols,
        now,
        tca_max_age_seconds,
        account_label,
        torghut_revision,
    )


def _build_and_validate_receipt(
    ctx: _ProofContext,
    hypothesis_payload: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None,
    account_label: str | None,
    torghut_revision: str | None,
) -> dict[str, object]:
    summary = hypothesis_summary(hypothesis_payload)
    reasons = reason_counts(hypothesis_payload)
    promotion_eligible_total = int_value(summary.get("promotion_eligible_total"))
    _validate_alpha_readiness(ctx, promotion_eligible_total, summary)
    _validate_target_notional_sizing(ctx, hypothesis_payload)
    simple_status = mapping_value(simple_lane_status) if isinstance(simple_lane_status, Mapping) else {}
    _validate_order_feed_lifecycle(ctx, simple_status)
    return _assemble_receipt(ctx, simple_lane_status, account_label, torghut_revision)


def _create_context_and_validate(
    now: datetime | None,
    trading_mode: str,
    market_session_open: bool | None,
    live_submission_gate: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None,
    paper_route_probe_target_symbols: Sequence[object] | None,
    tca_max_age_seconds: int,
    account_label: str | None,
    torghut_revision: str | None,
) -> dict[str, object]:
    ctx = _ProofContext(
        generated_at=(now or datetime.now(timezone.utc)).astimezone(timezone.utc),
        live_mode=trading_mode == "live",
        market_session_open=market_session_open,
        live_submission_gate=live_submission_gate,
        simple_lane_status=simple_lane_status,
        paper_route_probe_target_symbols=paper_route_probe_target_symbols,
    )
    _validate_gate_and_core(ctx, empirical_jobs_status, quant_evidence, market_context_status, hypothesis_payload)
    _validate_execution_tca(ctx, tca_summary, tca_max_age_seconds)
    _validate_secondary_repairs(ctx, reason_counts(hypothesis_payload))
    return _build_and_validate_receipt(ctx, hypothesis_payload, simple_lane_status, account_label, torghut_revision)


def _run_validation(
    trading_mode: str,
    market_session_open: bool | None,
    live_submission_gate: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    simple_lane_status: Mapping[str, Any] | None,
    paper_route_probe_target_symbols: Sequence[object] | None,
    now: datetime | None,
    tca_max_age_seconds: int,
    account_label: str | None,
    torghut_revision: str | None,
) -> dict[str, object]:
    return _create_context_and_validate(
        now,
        trading_mode,
        market_session_open,
        live_submission_gate,
        empirical_jobs_status,
        quant_evidence,
        market_context_status,
        hypothesis_payload,
        tca_summary,
        simple_lane_status,
        paper_route_probe_target_symbols,
        tca_max_age_seconds,
        account_label,
        torghut_revision,
    )


__all__ = ["build_profitability_proof_floor_receipt"]
