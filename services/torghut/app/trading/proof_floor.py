"""Profitability proof-floor receipts for capital-qualified trading routes."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from .route_reacquisition import build_route_reacquisition_book


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


def _strings(value: object) -> list[str]:
    return sorted({_text(item) for item in _sequence(value) if _text(item)})


def _truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "pass", "ready"}
    return bool(value)


def _hypothesis_repair_target_summary(
    hypothesis_payload: Mapping[str, Any],
) -> dict[str, object]:
    hypothesis_ids: set[str] = set()
    promotion_eligible_ids: set[str] = set()
    blocked_ids: set[str] = set()
    repair_targets: list[dict[str, object]] = []

    for item in _hypothesis_items(hypothesis_payload):
        lineage_ref = _mapping(item.get("lineage_ref"))
        hypothesis_id = _text(
            item.get("hypothesis_id"), _text(lineage_ref.get("hypothesis_id"))
        )
        if not hypothesis_id:
            continue
        if hypothesis_id in hypothesis_ids:
            continue

        hypothesis_ids.add(hypothesis_id)
        promotion_eligible = _truthy(item.get("promotion_eligible"))
        if promotion_eligible:
            promotion_eligible_ids.add(hypothesis_id)
        else:
            blocked_ids.add(hypothesis_id)

        candidate_id = _text(
            item.get("candidate_id"), _text(lineage_ref.get("candidate_id"))
        )
        strategy_id = _text(
            item.get("strategy_id"), _text(lineage_ref.get("strategy_id"))
        )
        lane_id = _text(item.get("lane_id"), _text(lineage_ref.get("lane_id")))
        strategy_family = _text(
            item.get("strategy_family"), _text(lineage_ref.get("strategy_family"))
        )
        target: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "state": _text(item.get("state"), "unknown"),
            "promotion_eligible": promotion_eligible,
            "reasons": _strings(item.get("reasons")),
            "informational_reasons": _strings(item.get("informational_reasons")),
        }
        if candidate_id:
            target["candidate_id"] = candidate_id
        if strategy_id:
            target["strategy_id"] = strategy_id
        if lane_id:
            target["lane_id"] = lane_id
        if strategy_family:
            target["strategy_family"] = strategy_family
        if len(repair_targets) < 5:
            repair_targets.append(target)

    return {
        "hypothesis_ids": sorted(hypothesis_ids),
        "blocked_hypothesis_ids": sorted(blocked_ids),
        "promotion_eligible_hypothesis_ids": sorted(promotion_eligible_ids),
        "repair_target_count": len(hypothesis_ids),
        "blocked_repair_target_count": len(blocked_ids),
        "promotion_eligible_repair_target_count": len(promotion_eligible_ids),
        "repair_targets": repair_targets,
    }


def _reason_counts(hypothesis_payload: Mapping[str, Any]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for item in _hypothesis_items(hypothesis_payload):
        for reason in _sequence(item.get("reasons")):
            normalized = _text(reason)
            if normalized:
                counts[normalized] += 1
    return counts


def _slippage_guardrails(hypothesis_payload: Mapping[str, Any]) -> list[Decimal]:
    guardrails: list[Decimal] = []
    for item in _hypothesis_items(hypothesis_payload):
        contract = _mapping(item.get("promotion_contract"))
        value = _decimal(contract.get("max_avg_abs_slippage_bps"))
        if value is not None:
            guardrails.append(value)
    return guardrails


def _tca_symbol_routes(
    tca_summary: Mapping[str, Any],
    *,
    slippage_guardrail: Decimal | None,
    route_slippage_guardrail: Decimal | None = None,
) -> dict[str, object] | None:
    rows: list[Mapping[str, Any]] = []
    for item in _sequence(tca_summary.get("symbol_breakdown")):
        if isinstance(item, Mapping):
            rows.append(cast(Mapping[str, Any], item))
    if not rows:
        return None

    routeable_symbols: list[dict[str, object]] = []
    blocked_symbols: list[dict[str, object]] = []
    missing_symbols: list[str] = []
    for row in rows:
        symbol = _text(row.get("symbol"))
        if not symbol:
            continue
        order_count = _int(row.get("order_count"))
        avg_abs_slippage = _decimal(row.get("avg_abs_slippage_bps"))
        avg_realized_shortfall = _decimal(row.get("avg_realized_shortfall_bps"))
        route_adverse_slippage = (
            max(avg_realized_shortfall, Decimal("0"))
            if avg_realized_shortfall is not None
            else avg_abs_slippage
        )
        symbol_payload: dict[str, object] = {
            "symbol": symbol,
            "order_count": order_count,
            "avg_abs_slippage_bps": _decimal_text(avg_abs_slippage),
            "avg_realized_shortfall_bps": _decimal_text(avg_realized_shortfall),
            "route_adverse_slippage_bps": _decimal_text(route_adverse_slippage),
            "route_slippage_basis": "signed_realized_shortfall_bps"
            if avg_realized_shortfall is not None
            else "avg_abs_slippage_bps_fallback",
            "max_abs_slippage_bps": _decimal_text(
                _decimal(row.get("max_abs_slippage_bps"))
            ),
            "last_computed_at": row.get("last_computed_at"),
        }
        if order_count <= 0:
            missing_symbols.append(symbol)
            continue
        route_guardrail = route_slippage_guardrail or slippage_guardrail
        if (
            route_guardrail is not None
            and route_adverse_slippage is not None
            and route_adverse_slippage > route_guardrail
        ):
            blocked_symbols.append(symbol_payload)
            continue
        routeable_symbols.append(symbol_payload)

    payload: dict[str, object] = {
        "scope_symbols": list(_sequence(tca_summary.get("scope_symbols"))),
        "scope_symbol_count": _int(tca_summary.get("scope_symbol_count")),
        "slippage_guardrail_bps": _decimal_text(slippage_guardrail),
        "routeable_symbol_count": len(routeable_symbols),
        "blocked_symbol_count": len(blocked_symbols),
        "missing_symbol_count": len(missing_symbols),
        "routeable_symbols": routeable_symbols,
        "blocked_symbols": blocked_symbols,
        "missing_symbols": missing_symbols,
    }
    if (
        route_slippage_guardrail is not None
        and route_slippage_guardrail != slippage_guardrail
    ):
        payload["route_slippage_guardrail_bps"] = _decimal_text(
            route_slippage_guardrail
        )
    return payload


def _route_symbol_filter_enabled(
    simple_lane_status: Mapping[str, Any] | None,
) -> bool:
    if not isinstance(simple_lane_status, Mapping):
        return False
    value = simple_lane_status.get("route_symbol_filter_enabled")
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "enabled"}
    return bool(value)


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
    alpha_repair_target_summary = _hypothesis_repair_target_summary(hypothesis_payload)
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
            source_ref={
                "promotion_eligible_total": promotion_eligible_total,
                **alpha_repair_target_summary,
            },
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

    quant_required = _bool(quant_evidence.get("required", True))
    quant_status = _text(quant_evidence.get("status"), "unknown").lower()
    quant_reason = _text(quant_evidence.get("reason"), quant_status or "unknown")
    if not quant_required and quant_status not in {
        "ok",
        "healthy",
        "pass",
        "not_required",
    }:
        quant_state = "informational"
    elif not _bool(quant_evidence.get("ok")):
        quant_state = "fail"
    elif quant_status in {"ok", "healthy", "pass", "not_required"}:
        quant_state = "pass"
    else:
        quant_state = "degraded"
    if quant_required and quant_state != "pass":
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

    simple_status = _mapping(simple_lane_status)
    order_feed_lifecycle_required = _truthy(
        simple_status.get("order_feed_lifecycle_required")
    )
    order_feed_telemetry_enabled = _truthy(
        simple_status.get("order_feed_telemetry_enabled")
    )
    if order_feed_lifecycle_required and not order_feed_telemetry_enabled:
        order_feed_state = "fail"
        order_feed_reason = "order_feed_lifecycle_disabled"
        _add_repair(
            repairs,
            code="enable_order_feed_lifecycle",
            dimension="order_feed_lifecycle",
            action="enable_simple_order_feed_ingestion_before_proof_floor_authority",
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
            "simple_lane_enabled": _truthy(simple_status.get("enabled")),
            "lifecycle_required": order_feed_lifecycle_required,
            "order_feed_telemetry_enabled": order_feed_telemetry_enabled,
            "order_feed_lifecycle_status": simple_status.get(
                "order_feed_lifecycle_status"
            ),
        },
    )

    market_alert = _bool(market_context_status.get("alert_active"))
    market_context_stale = reasons.get("market_context_stale", 0)
    market_reason = _text(
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
            _add_repair(
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
            _add_repair(
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
        freshness_seconds=_int(market_context_status.get("last_freshness_seconds"), -1),
    )

    tca_last_computed_at = _parse_timestamp(tca_summary.get("last_computed_at"))
    latest_execution_created_at = _parse_timestamp(
        tca_summary.get("latest_execution_created_at")
    )
    tca_unsettled_execution_count = _int(tca_summary.get("unsettled_execution_count"))
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
    tca_order_count = _int(tca_summary.get("order_count"))
    avg_abs_slippage_bps = _decimal(tca_summary.get("avg_abs_slippage_bps"))
    slippage_guardrails = _slippage_guardrails(hypothesis_payload)
    slippage_guardrail = min(slippage_guardrails) if slippage_guardrails else None
    route_slippage_guardrail = max(slippage_guardrails) if slippage_guardrails else None
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
        "filled_execution_count": _int(tca_summary.get("filled_execution_count")),
        "latest_execution_created_at": tca_summary.get("latest_execution_created_at"),
        "unsettled_execution_count": tca_unsettled_execution_count,
        "avg_abs_slippage_bps": _decimal_text(avg_abs_slippage_bps),
        "slippage_guardrail_bps": _decimal_text(slippage_guardrail),
    }
    symbol_routes = _tca_symbol_routes(
        tca_summary,
        slippage_guardrail=slippage_guardrail,
        route_slippage_guardrail=route_slippage_guardrail,
    )
    if symbol_routes is not None:
        tca_source_ref["symbol_routes"] = symbol_routes
        routeable_symbol_count = _int(symbol_routes.get("routeable_symbol_count"))
        blocked_symbol_count = _int(symbol_routes.get("blocked_symbol_count"))
        missing_symbol_count = _int(symbol_routes.get("missing_symbol_count"))
        scope_symbol_count = _int(symbol_routes.get("scope_symbol_count"))
        excluded_symbol_count = blocked_symbol_count + missing_symbol_count
        route_filter_enabled = _route_symbol_filter_enabled(simple_lane_status)
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
        if route_universe_reason is not None:
            if route_universe_reason == "execution_tca_route_universe_empty":
                tca_state = "fail"
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
            _add_repair(
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
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
        },
    }
    paper_route_probe_enabled = False
    paper_route_probe_max_notional: object | None = None
    if isinstance(simple_lane_status, Mapping):
        paper_route_probe_enabled = _truthy(
            simple_lane_status.get("paper_route_probe_enabled")
        )
        paper_route_probe_max_notional = simple_lane_status.get(
            "paper_route_probe_max_notional"
        )
    route_reacquisition_book = build_route_reacquisition_book(
        proof_floor_receipt=receipt,
        trading_mode=trading_mode,
        market_session_open=market_session_open,
        paper_route_probe_enabled=paper_route_probe_enabled,
        paper_route_probe_max_notional=paper_route_probe_max_notional,
    )
    receipt["route_reacquisition_book"] = route_reacquisition_book
    receipt["paper_route_probe"] = route_reacquisition_book.get("paper_route_probe")
    return receipt


__all__ = ["build_profitability_proof_floor_receipt"]
