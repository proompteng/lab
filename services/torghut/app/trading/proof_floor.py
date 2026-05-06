"""Profitability proof-floor receipts for capital-qualified trading routes."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, cast


_BLOCKING_STATES = {"degraded", "fail", "missing", "stale"}
_LIVE_MICRO_STAGES = {"0.10x canary", "0.25x canary"}
_LIVE_SCALE_STAGES = {"0.50x live", "1.00x live"}


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _bool(value: object) -> bool:
    return bool(value)


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value.strip()))
        except ValueError:
            return default
    return default


def _decimal(value: object) -> Decimal | None:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str) and value.strip():
        try:
            return Decimal(value.strip())
        except InvalidOperation:
            return None
    return None


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    normalized = value.normalize()
    rendered = format(normalized, "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _hypothesis_summary(hypothesis_payload: Mapping[str, Any]) -> Mapping[str, Any]:
    summary = hypothesis_payload.get("summary")
    if isinstance(summary, Mapping):
        return cast(Mapping[str, Any], summary)
    return hypothesis_payload


def _hypothesis_items(hypothesis_payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        item
        for item in _sequence(hypothesis_payload.get("items"))
        if isinstance(item, Mapping)
    ]


def _reason_counts(hypothesis_payload: Mapping[str, Any]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for item in _hypothesis_items(hypothesis_payload):
        for reason in _sequence(item.get("reasons")):
            normalized = _text(reason)
            if normalized:
                counts[normalized] += 1
    return counts


def _slippage_guardrail(hypothesis_payload: Mapping[str, Any]) -> Decimal | None:
    guardrails: list[Decimal] = []
    for item in _hypothesis_items(hypothesis_payload):
        contract = _mapping(item.get("promotion_contract"))
        value = _decimal(contract.get("max_avg_abs_slippage_bps"))
        if value is not None:
            guardrails.append(value)
    return min(guardrails) if guardrails else None


def _add_repair(
    repairs: list[dict[str, object]],
    *,
    code: str,
    dimension: str,
    action: str,
    reason: str,
    priority: int,
    expected_unblock_value: int = 1,
    max_notional: str = "0",
) -> None:
    repairs.append(
        {
            "code": code,
            "dimension": dimension,
            "action": action,
            "reason": reason,
            "priority": priority,
            "expected_unblock_value": expected_unblock_value,
            "max_notional": max_notional,
        }
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
    now: datetime | None = None,
    tca_max_age_seconds: int = 86400,
) -> dict[str, object]:
    """Build an auditable proof-floor receipt before paper/live capital routing.

    The reducer is intentionally conservative: any degraded proof dimension keeps
    capital at zero and emits ranked repair work instead of authorizing notional.
    """

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    summary = _hypothesis_summary(hypothesis_payload)
    reasons = _reason_counts(hypothesis_payload)
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

    gate_allowed = _bool(live_submission_gate.get("allowed"))
    gate_reason = _text(live_submission_gate.get("reason"), "unknown")
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
        _add_repair(
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

    promotion_eligible_total = _int(summary.get("promotion_eligible_total"))
    rollback_required_total = _int(summary.get("rollback_required_total"))
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
            },
        )
        _add_repair(
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
            source_ref={"promotion_eligible_total": promotion_eligible_total},
        )

    empirical_ready = _bool(empirical_jobs_status.get("ready"))
    empirical_status = _text(empirical_jobs_status.get("status"), "unknown")
    if empirical_ready:
        empirical_state = "pass"
        empirical_effect = "none"
    else:
        empirical_state = "degraded"
        empirical_effect = "paper_hold" if not live_mode else "live_hold"
        _add_repair(
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

    quant_status = _text(quant_evidence.get("status"), "unknown").lower()
    quant_reason = _text(quant_evidence.get("reason"), quant_status or "unknown")
    if not _bool(quant_evidence.get("ok")):
        quant_state = "fail"
    elif quant_status in {"ok", "healthy", "pass", "not_required"}:
        quant_state = "pass"
    else:
        quant_state = "degraded"
    if quant_state != "pass":
        _add_repair(
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
        if quant_state == "pass"
        else "paper_hold"
        if not live_mode
        else "live_hold",
        source_ref={
            "account": quant_evidence.get("account"),
            "window": quant_evidence.get("window"),
            "latest_metrics_updated_at": quant_evidence.get(
                "latest_metrics_updated_at"
            ),
            "max_stage_lag_seconds": quant_evidence.get("max_stage_lag_seconds"),
        },
    )

    market_alert = _bool(market_context_status.get("alert_active"))
    market_reason = _text(
        market_context_status.get("alert_reason")
        or market_context_status.get("last_reason"),
        "ok",
    )
    if market_alert:
        market_state = "stale" if "stale" in market_reason else "degraded"
        _add_repair(
            repairs,
            code="repair_market_context",
            dimension="market_context",
            action="refresh_market_context_domains",
            reason=market_reason,
            priority=55,
            expected_unblock_value=max(1, reasons.get("market_context_stale", 0)),
        )
    else:
        market_state = "pass"
    add_dimension(
        dimension="market_context",
        state=market_state,
        reason=market_reason,
        capital_effect="none"
        if market_state == "pass"
        else "paper_hold"
        if not live_mode
        else "live_hold",
        source_ref={
            "last_freshness_seconds": market_context_status.get(
                "last_freshness_seconds"
            ),
            "last_quality_score": market_context_status.get("last_quality_score"),
            "last_domain_states": market_context_status.get("last_domain_states") or {},
        },
        freshness_seconds=_int(market_context_status.get("last_freshness_seconds"), -1),
    )

    tca_last_computed_at = _parse_timestamp(tca_summary.get("last_computed_at"))
    tca_age_seconds = (
        max(0, int((generated_at - tca_last_computed_at).total_seconds()))
        if tca_last_computed_at is not None
        else None
    )
    tca_order_count = _int(tca_summary.get("order_count"))
    avg_abs_slippage_bps = _decimal(tca_summary.get("avg_abs_slippage_bps"))
    slippage_guardrail = _slippage_guardrail(hypothesis_payload)
    tca_state = "pass"
    tca_reason = "fresh"
    if tca_order_count <= 0:
        tca_state = "missing"
        tca_reason = "execution_tca_missing"
    elif tca_age_seconds is None or tca_age_seconds > max(0, tca_max_age_seconds):
        tca_state = "stale"
        tca_reason = "execution_tca_stale"
    elif (
        avg_abs_slippage_bps is not None
        and slippage_guardrail is not None
        and avg_abs_slippage_bps > slippage_guardrail
    ):
        tca_state = "fail"
        tca_reason = "execution_tca_slippage_guardrail_exceeded"
    if tca_state != "pass":
        _add_repair(
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
        source_ref={
            "order_count": tca_order_count,
            "last_computed_at": tca_summary.get("last_computed_at"),
            "avg_abs_slippage_bps": _decimal_text(avg_abs_slippage_bps),
            "slippage_guardrail_bps": _decimal_text(slippage_guardrail),
        },
        freshness_seconds=tca_age_seconds,
        threshold_seconds=max(0, tca_max_age_seconds),
    )

    feature_rows_missing = reasons.get("feature_rows_missing", 0)
    required_feature_set_unavailable = reasons.get(
        "required_feature_set_unavailable",
        0,
    )
    if feature_rows_missing or required_feature_set_unavailable:
        _add_repair(
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
        _add_repair(
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
            _add_repair(
                repairs,
                code="repair_signal_freshness",
                dimension="signal_continuity",
                action="restore_actionable_signal_ingestion",
                reason="signal_lag_exceeded",
                priority=75,
                expected_unblock_value=signal_lag_exceeded,
            )
        else:
            _add_repair(
                repairs,
                code="closed_session_signal_hold",
                dimension="signal_continuity",
                action="verify_signal_freshness_at_next_market_open",
                reason="expected_market_closed_staleness",
                priority=15,
                expected_unblock_value=signal_lag_exceeded,
            )

    blocking_dimensions = [
        item for item in dimensions if _text(item.get("state")) in _BLOCKING_STATES
    ]
    active_stage = _text(
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
        if active_stage in _LIVE_SCALE_STAGES:
            route_state = "live_scale_candidate"
        elif active_stage in _LIVE_MICRO_STAGES:
            route_state = "live_micro_candidate"
        else:
            route_state = "live_micro_candidate"
        capital_state = "live_allowed"
        floor_state = (
            "live_micro_ready"
            if route_state == "live_micro_candidate"
            else "live_scale_ready"
        )
        max_notional = _text(configured_max_notional, "configured_by_risk")
    else:
        route_state = "paper_candidate"
        capital_state = "paper_allowed"
        floor_state = "paper_ready"
        max_notional = _text(configured_max_notional, "configured_by_risk")

    ordered_repairs = sorted(
        repairs,
        key=lambda item: (
            -_int(item.get("priority")),
            -_int(item.get("expected_unblock_value")),
            _text(item.get("code")),
        ),
    )
    blocking_codes = sorted(
        {
            _text(item.get("reason"))
            for item in blocking_dimensions
            if _text(item.get("reason"))
        }
    )

    return {
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
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
        },
    }


__all__ = ["build_profitability_proof_floor_receipt"]
