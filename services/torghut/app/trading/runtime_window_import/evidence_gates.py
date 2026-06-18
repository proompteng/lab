"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast
from zoneinfo import ZoneInfo


from ..hypotheses import (
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    load_hypothesis_registry,
)

from .common import (
    RUNTIME_LEDGER_PROOF_POLICY,
    US_EQUITIES_REGULAR_CLOSE,
    US_EQUITIES_REGULAR_OPEN,
    US_EQUITIES_REGULAR_TIMEZONE,
    RUNTIME_WINDOW_IMPORT_CAPITAL_ONLY_BLOCKERS,
    decimal_text,
    observation_bool,
    observation_decimal,
    observation_int,
    optional_decimal,
    parse_observation_datetime,
    strategy_family_matches,
    string_list,
    text_value,
    utc_datetime,
)


@dataclass(frozen=True)
class RuntimeWindowProofBlockerRequest:
    promotion_blocking_reasons: Sequence[str]
    runtime_payload: Mapping[str, Any]
    candidate_id: str | None
    hypothesis_id: str
    observed_stage: str
    window_start: datetime
    window_end: datetime


@dataclass(frozen=True)
class RuntimePromotionInputs:
    observed_stage: str
    inserted: int
    total_session_samples: int
    total_decision_count: int
    total_trade_count: int
    total_order_count: int
    total_post_cost_promotion_sample_count: int
    runtime_ledger_notional_weighted_sample_count: int
    total_post_cost_basis_counts: Mapping[str, int]
    average_slippage: Decimal
    average_post_cost: Decimal
    runtime_ledger_daily_summary: Mapping[str, Any]
    latest_three_budget_ok: bool
    all_continuity_ok: bool
    all_drift_ok: bool
    dependency_quorum_allowed: bool
    manifest: HypothesisManifest
    budget: Decimal


@dataclass(frozen=True)
class _RuntimeAuthorityMetrics:
    observed_trading_days: int
    mean_daily_net_pnl: Decimal
    median_daily_net_pnl: Decimal
    p10_daily_net_pnl: Decimal
    worst_day_net_pnl: Decimal
    max_intraday_drawdown: Decimal
    best_day_share: Decimal | None
    avg_daily_filled_notional: Decimal


@dataclass(frozen=True)
class _RegularSessionWindow:
    start_utc: datetime
    end_utc: datetime
    zone: ZoneInfo
    bucket_delta: timedelta
    sample_delta: timedelta


def _delay_adjusted_depth_stress_report(
    runtime_payload: Mapping[str, Any],
) -> Mapping[str, Any]:
    raw_report = runtime_payload.get("delay_adjusted_depth_stress_report")
    if isinstance(raw_report, Mapping):
        return cast(Mapping[str, Any], raw_report)
    return {}


def _delay_adjusted_depth_stress_check_count(
    runtime_payload: Mapping[str, Any],
    report: Mapping[str, Any],
) -> int:
    return max(
        observation_int(
            runtime_payload.get("delay_adjusted_depth_stress_checks_total")
        ),
        observation_int(runtime_payload.get("delay_depth_stress_checks_total")),
        observation_int(report.get("stress_case_count")),
        observation_int(report.get("case_count")),
        observation_int(report.get("trading_day_count")),
    )


def _delay_adjusted_depth_stress_passed(
    runtime_payload: Mapping[str, Any],
    report: Mapping[str, Any],
) -> bool | None:
    runtime_value = runtime_payload.get("delay_adjusted_depth_stress_passed")
    return observation_bool(
        runtime_value
        if runtime_value is not None
        else report.get("passed", report.get("ok"))
    )


def _delay_adjusted_depth_stress_checked_at(
    runtime_payload: Mapping[str, Any],
    report: Mapping[str, Any],
) -> datetime | None:
    return (
        parse_observation_datetime(
            runtime_payload.get("delay_adjusted_depth_stress_checked_at")
        )
        or parse_observation_datetime(report.get("generated_at"))
        or parse_observation_datetime(report.get("checked_at"))
    )


def _delay_adjusted_depth_stress_freshness_blockers(
    *,
    manifest: HypothesisManifest,
    checked_at: datetime | None,
    now: datetime,
) -> list[str]:
    requirements = manifest.entry_requirements
    if checked_at is None:
        return ["delay_adjusted_depth_stress_missing"]
    max_age_minutes = requirements.max_delay_adjusted_depth_stress_age_minutes
    if max_age_minutes is not None and checked_at < now - timedelta(
        minutes=max_age_minutes
    ):
        return ["delay_adjusted_depth_stress_stale"]
    return []


def _delay_adjusted_depth_stress_summary_blockers(
    summary: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    if observation_bool(summary.get("tail_coverage_passed")) is not True:
        blockers.append("delay_adjusted_depth_tail_coverage_missing")
    if observation_decimal(summary.get("p10_active_day_fillable_notional")) <= 0:
        blockers.append("delay_adjusted_depth_p10_fillable_non_positive")
    if observation_decimal(summary.get("worst_active_day_fillable_notional")) <= 0:
        blockers.append("delay_adjusted_depth_worst_fillable_non_positive")
    if observation_decimal(summary.get("stress_net_pnl_per_day")) <= 0:
        blockers.append("delay_adjusted_depth_stress_net_pnl_non_positive")
    if observation_bool(summary.get("fill_survival_evidence_present")) is not True:
        blockers.append("fill_survival_evidence_missing")
    if observation_int(summary.get("fill_survival_sample_count")) <= 0:
        blockers.append("fill_survival_sample_count_zero")
    if (
        observation_bool(summary.get("queue_ahead_depletion_evidence_present"))
        is not True
    ):
        blockers.append("queue_ahead_depletion_evidence_missing")
    if observation_int(summary.get("queue_ahead_depletion_sample_count")) <= 0:
        blockers.append("queue_ahead_depletion_sample_count_zero")
    return blockers


def delay_adjusted_depth_stress_blocking_reasons(
    *,
    manifest: HypothesisManifest,
    runtime_payload: Mapping[str, Any],
    now: datetime,
) -> list[str]:
    requirements = manifest.entry_requirements
    if not requirements.require_delay_adjusted_depth_stress:
        return []

    report = _delay_adjusted_depth_stress_report(runtime_payload)
    check_count = _delay_adjusted_depth_stress_check_count(runtime_payload, report)
    passed = _delay_adjusted_depth_stress_passed(runtime_payload, report)
    checked_at = _delay_adjusted_depth_stress_checked_at(runtime_payload, report)
    reasons: list[str] = []
    if check_count < requirements.min_delay_adjusted_depth_stress_checks:
        reasons.append("delay_adjusted_depth_stress_missing")
    elif passed is not True:
        reasons.append("delay_adjusted_depth_stress_failed")
    reasons.extend(
        _delay_adjusted_depth_stress_freshness_blockers(
            manifest=manifest,
            checked_at=checked_at,
            now=now,
        )
    )
    if not reasons:
        reasons.extend(
            _delay_adjusted_depth_stress_summary_blockers(
                delay_adjusted_depth_stress_summary(runtime_payload)
            )
        )
    return list(dict.fromkeys(reasons))


def delay_adjusted_depth_stress_summary(
    runtime_payload: Mapping[str, Any],
) -> dict[str, object]:
    raw_report = runtime_payload.get("delay_adjusted_depth_stress_report")
    report: Mapping[str, Any]
    if isinstance(raw_report, Mapping):
        report = cast(Mapping[str, Any], raw_report)
    else:
        report = {}
    check_count = max(
        observation_int(
            runtime_payload.get("delay_adjusted_depth_stress_checks_total")
        ),
        observation_int(runtime_payload.get("delay_depth_stress_checks_total")),
        observation_int(report.get("stress_case_count")),
        observation_int(report.get("case_count")),
        observation_int(report.get("trading_day_count")),
    )
    checked_at = (
        parse_observation_datetime(
            runtime_payload.get("delay_adjusted_depth_stress_checked_at")
        )
        or parse_observation_datetime(report.get("generated_at"))
        or parse_observation_datetime(report.get("checked_at"))
    )
    latency_grid_ms = (
        string_list(runtime_payload.get("delay_adjusted_depth_latency_grid_ms"))
        or string_list(report.get("delay_adjusted_depth_latency_grid_ms"))
        or string_list(report.get("latency_grid_ms"))
    )
    return {
        "checks_total": check_count,
        "passed": observation_bool(
            runtime_payload.get("delay_adjusted_depth_stress_passed")
            if runtime_payload.get("delay_adjusted_depth_stress_passed") is not None
            else report.get("passed", report.get("ok"))
        ),
        "checked_at": checked_at.isoformat() if checked_at is not None else None,
        "artifact_ref": text_value(
            runtime_payload.get("delay_adjusted_depth_stress_artifact_ref")
        )
        or text_value(report.get("artifact_ref")),
        "latency_grid_ms": latency_grid_ms,
        "grid_max_stress_ms": text_value(
            runtime_payload.get("delay_adjusted_depth_grid_max_stress_ms")
        )
        or text_value(report.get("delay_adjusted_depth_grid_max_stress_ms"))
        or text_value(report.get("grid_max_stress_ms")),
        "worst_grid_fillable_notional_per_day": text_value(
            runtime_payload.get(
                "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
            )
        )
        or text_value(
            report.get("delay_adjusted_depth_worst_grid_fillable_notional_per_day")
        )
        or text_value(report.get("worst_grid_fillable_notional_per_day")),
        "worst_active_day_fillable_notional": text_value(
            runtime_payload.get(
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            )
        )
        or text_value(
            report.get("delay_adjusted_depth_worst_active_day_fillable_notional")
        )
        or text_value(report.get("worst_active_day_fillable_notional")),
        "p10_active_day_fillable_notional": text_value(
            runtime_payload.get("delay_adjusted_depth_p10_active_day_fillable_notional")
        )
        or text_value(
            report.get("delay_adjusted_depth_p10_active_day_fillable_notional")
        )
        or text_value(report.get("p10_active_day_fillable_notional")),
        "tail_coverage_passed": observation_bool(
            runtime_payload.get("delay_adjusted_depth_tail_coverage_passed")
            if runtime_payload.get("delay_adjusted_depth_tail_coverage_passed")
            is not None
            else report.get(
                "delay_adjusted_depth_tail_coverage_passed",
                report.get("tail_coverage_passed"),
            )
        ),
        "fillable_ratio": text_value(
            runtime_payload.get("delay_adjusted_depth_fillable_ratio")
        )
        or text_value(report.get("delay_adjusted_depth_fillable_ratio"))
        or text_value(report.get("fillable_ratio")),
        "survival_adjusted_fillable_ratio": text_value(
            runtime_payload.get("delay_adjusted_depth_survival_adjusted_fillable_ratio")
        )
        or text_value(
            report.get("delay_adjusted_depth_survival_adjusted_fillable_ratio")
        )
        or text_value(report.get("survival_adjusted_fillable_ratio")),
        "unfillable_notional_per_day": text_value(
            runtime_payload.get("delay_adjusted_depth_unfillable_notional_per_day")
        )
        or text_value(report.get("delay_adjusted_depth_unfillable_notional_per_day"))
        or text_value(report.get("unfillable_notional_per_day")),
        "stress_net_pnl_per_day": text_value(
            runtime_payload.get("delay_adjusted_depth_stress_net_pnl_per_day")
        )
        or text_value(report.get("delay_adjusted_depth_stress_net_pnl_per_day"))
        or text_value(report.get("stress_net_pnl_per_day")),
        "fill_survival_evidence_present": observation_bool(
            runtime_payload.get("delay_adjusted_depth_fill_survival_evidence_present")
            if runtime_payload.get(
                "delay_adjusted_depth_fill_survival_evidence_present"
            )
            is not None
            else report.get(
                "delay_adjusted_depth_fill_survival_evidence_present",
                report.get("fill_survival_evidence_present"),
            )
        ),
        "fill_survival_sample_count": max(
            observation_int(
                runtime_payload.get("delay_adjusted_depth_fill_survival_sample_count")
            ),
            observation_int(
                report.get("delay_adjusted_depth_fill_survival_sample_count")
            ),
            observation_int(report.get("fill_survival_sample_count")),
        ),
        "fill_survival_rate": text_value(
            runtime_payload.get("delay_adjusted_depth_fill_survival_rate")
        )
        or text_value(report.get("delay_adjusted_depth_fill_survival_rate"))
        or text_value(report.get("fill_survival_rate")),
        "queue_ratio_p95": text_value(
            runtime_payload.get("delay_adjusted_depth_queue_ratio_p95")
        )
        or text_value(report.get("delay_adjusted_depth_queue_ratio_p95"))
        or text_value(report.get("queue_ratio_p95")),
        "queue_ahead_depletion_evidence_present": observation_bool(
            runtime_payload.get(
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
            )
            if runtime_payload.get(
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
            )
            is not None
            else report.get(
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present",
                report.get("queue_ahead_depletion_evidence_present"),
            )
        ),
        "queue_ahead_depletion_sample_count": max(
            observation_int(
                runtime_payload.get(
                    "delay_adjusted_depth_queue_ahead_depletion_sample_count"
                )
            ),
            observation_int(
                report.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
            ),
            observation_int(report.get("queue_ahead_depletion_sample_count")),
        ),
    }


def capital_stage_for_runtime_import(
    *,
    observed_stage: str,
    promotion_allowed: bool,
    session_samples: int,
    manifest: HypothesisManifest,
) -> str:
    if observed_stage == "paper" or not promotion_allowed:
        return "shadow"
    if session_samples >= manifest.min_sample_count_for_scale_up:
        return "0.50x live"
    return "0.10x canary"


def capital_multiplier_for_stage(stage: str) -> str:
    return {
        "shadow": "0",
        "0.10x canary": "0.10",
        "0.25x canary": "0.25",
        "0.50x live": "0.50",
        "1.00x live": "1.00",
    }.get(stage, "0")


def _runtime_window_proof_blocker_payload(
    request: RuntimeWindowProofBlockerRequest,
    code: str,
) -> dict[str, Any]:
    return {
        "blocker": code,
        "hypothesis_id": request.hypothesis_id,
        "candidate_id": request.candidate_id,
        "observed_stage": request.observed_stage,
        "window_start": request.window_start.isoformat(),
        "window_end": request.window_end.isoformat(),
        "promotion_authority": text_value(
            request.runtime_payload.get("promotion_authority")
        )
        or "unknown",
        "authority_reason": text_value(request.runtime_payload.get("authority_reason")),
        "runtime_ledger_profit_proof_present": bool(
            request.runtime_payload.get("runtime_ledger_profit_proof_present")
        ),
        "remediation": (
            "Inspect the imported runtime-window ledger rows and repair route, "
            "TCA, fill, cost, or lineage evidence before treating this target as "
            "promotion proof."
        ),
    }


def _proof_blocker_request_from_kwargs(
    inputs: Mapping[str, Any],
) -> RuntimeWindowProofBlockerRequest:
    return RuntimeWindowProofBlockerRequest(
        promotion_blocking_reasons=cast(
            Sequence[str],
            inputs["promotion_blocking_reasons"],
        ),
        runtime_payload=cast(Mapping[str, Any], inputs["runtime_payload"]),
        candidate_id=cast(str | None, inputs["candidate_id"]),
        hypothesis_id=cast(str, inputs["hypothesis_id"]),
        observed_stage=cast(str, inputs["observed_stage"]),
        window_start=cast(datetime, inputs["window_start"]),
        window_end=cast(datetime, inputs["window_end"]),
    )


def runtime_window_import_proof_blockers(**inputs: Any) -> list[dict[str, Any]]:
    request = _proof_blocker_request_from_kwargs(inputs)
    blockers: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_blocker(reason: str) -> None:
        code = text_value(reason)
        if not code or code in seen:
            return
        seen.add(code)
        blockers.append(_runtime_window_proof_blocker_payload(request, code))

    for reason in request.promotion_blocking_reasons:
        add_blocker(reason)

    if (
        request.runtime_payload
        and request.runtime_payload.get("authoritative") is False
    ):
        add_blocker(
            text_value(request.runtime_payload.get("authority_reason"))
            or "runtime_observation_not_authoritative"
        )

    return blockers


def runtime_window_import_evidence_blocking_reasons(
    promotion_blocking_reasons: Sequence[str],
) -> list[str]:
    return [
        reason
        for reason in promotion_blocking_reasons
        if reason not in RUNTIME_WINDOW_IMPORT_CAPITAL_ONLY_BLOCKERS
    ]


def runtime_ledger_authority_gate_targets(
    *,
    average_post_cost_bps: Decimal,
) -> dict[str, Any]:
    target_implied_notional = (
        RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
        * Decimal("10000")
        / average_post_cost_bps
        if average_post_cost_bps > 0
        else None
    )
    return {
        "min_observed_trading_days": (
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_trading_days
        ),
        "min_mean_daily_net_pnl_after_costs": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
        ),
        "min_median_daily_net_pnl_after_costs": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
        ),
        "min_p10_daily_net_pnl_after_costs": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
        ),
        "min_worst_day_net_pnl_after_costs": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
        ),
        "max_intraday_drawdown": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
        ),
        "max_best_day_share": str(
            RUNTIME_LEDGER_PROOF_POLICY.authority_max_best_day_share
        ),
        "target_implied_avg_daily_filled_notional": (
            decimal_text(target_implied_notional)
            if target_implied_notional is not None
            else None
        ),
        "target_implied_avg_daily_filled_notional_basis": (
            "min_mean_daily_net_pnl_after_costs / observed_post_cost_expectancy_bps"
            if target_implied_notional is not None
            else None
        ),
    }


def _runtime_summary_decimal(
    runtime_ledger_daily_summary: Mapping[str, Any],
    key: str,
) -> Decimal:
    return optional_decimal(runtime_ledger_daily_summary.get(key)) or Decimal("0")


def _runtime_sample_blockers(inputs: RuntimePromotionInputs) -> list[str]:
    reasons: list[str] = []
    if inputs.observed_stage == "paper":
        reasons.append("paper_stage_evidence_collection_only")
    if inputs.inserted <= 0:
        reasons.append("runtime_window_evidence_missing")
    if inputs.total_session_samples < inputs.manifest.min_sample_count_for_live_canary:
        reasons.append("sample_count_below_canary_minimum")
    if inputs.total_decision_count <= 0:
        reasons.append("runtime_decision_count_zero")
    if inputs.total_order_count <= 0:
        reasons.append("runtime_order_count_zero")
    if inputs.total_trade_count <= 0:
        reasons.append("runtime_trade_count_zero")
    if inputs.average_slippage > inputs.budget:
        reasons.append("slippage_budget_exceeded")
    if not inputs.latest_three_budget_ok:
        reasons.append("recent_slippage_budget_exceeded")
    if not inputs.all_continuity_ok:
        reasons.append("evidence_continuity_not_ok")
    if not inputs.all_drift_ok:
        reasons.append("drift_checks_not_ok")
    if not inputs.dependency_quorum_allowed:
        reasons.append("dependency_quorum_not_allow")
    return reasons


def _runtime_post_cost_blockers(inputs: RuntimePromotionInputs) -> list[str]:
    reasons: list[str] = []
    if inputs.total_post_cost_promotion_sample_count <= 0:
        reasons.append("post_cost_pnl_basis_missing")
    if (
        inputs.runtime_ledger_notional_weighted_sample_count <= 0
        or inputs.runtime_ledger_notional_weighted_sample_count
        < inputs.total_post_cost_promotion_sample_count
    ):
        reasons.append("runtime_ledger_pnl_basis_missing")
    if inputs.average_post_cost <= Decimal("0"):
        reasons.append("post_cost_expectancy_non_positive")
    elif inputs.average_post_cost < inputs.manifest.expected_gross_edge_bps:
        reasons.append("post_cost_expectancy_below_manifest_threshold")
    return reasons


def _runtime_authority_metric_blockers(
    inputs: RuntimePromotionInputs,
    metrics: _RuntimeAuthorityMetrics,
) -> list[str]:
    reasons: list[str] = []
    if (
        metrics.observed_trading_days
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_trading_days
    ):
        reasons.append(
            "runtime_ledger_observed_trading_day_count_below_authority_minimum"
        )
    if (
        metrics.mean_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_mean_daily_net_pnl_after_costs_below_target")
    if (
        metrics.median_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_median_daily_net_pnl_after_costs_below_floor")
    if (
        metrics.p10_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_p10_daily_net_pnl_after_costs_below_floor")
    if (
        metrics.worst_day_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_worst_day_net_pnl_after_costs_below_floor")
    if (
        metrics.max_intraday_drawdown
        > RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
    ):
        reasons.append("runtime_ledger_max_intraday_drawdown_above_limit")
    return reasons


def _runtime_authority_size_blockers(
    inputs: RuntimePromotionInputs,
    metrics: _RuntimeAuthorityMetrics,
) -> list[str]:
    reasons: list[str] = []
    if (
        metrics.best_day_share is not None
        and metrics.best_day_share
        > RUNTIME_LEDGER_PROOF_POLICY.authority_max_best_day_share
    ):
        reasons.append("runtime_ledger_best_day_share_above_limit")
    if inputs.average_post_cost > 0:
        target_implied_notional = (
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
            * Decimal("10000")
            / inputs.average_post_cost
        )
        if metrics.avg_daily_filled_notional < target_implied_notional:
            reasons.append(
                "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor"
            )
    return reasons


def _runtime_authority_metrics(
    inputs: RuntimePromotionInputs,
) -> _RuntimeAuthorityMetrics:
    summary = inputs.runtime_ledger_daily_summary
    return _RuntimeAuthorityMetrics(
        observed_trading_days=int(
            _runtime_summary_decimal(
                summary,
                "runtime_ledger_observed_trading_day_count",
            )
        ),
        mean_daily_net_pnl=_runtime_summary_decimal(
            summary,
            "runtime_ledger_mean_daily_net_pnl_after_costs",
        ),
        median_daily_net_pnl=_runtime_summary_decimal(
            summary,
            "runtime_ledger_median_daily_net_pnl_after_costs",
        ),
        p10_daily_net_pnl=_runtime_summary_decimal(
            summary,
            "runtime_ledger_p10_daily_net_pnl_after_costs",
        ),
        worst_day_net_pnl=_runtime_summary_decimal(
            summary,
            "runtime_ledger_worst_day_net_pnl_after_costs",
        ),
        max_intraday_drawdown=_runtime_summary_decimal(
            summary,
            "runtime_ledger_max_intraday_drawdown",
        ),
        best_day_share=optional_decimal(summary.get("runtime_ledger_best_day_share")),
        avg_daily_filled_notional=_runtime_summary_decimal(
            summary,
            "runtime_ledger_avg_daily_filled_notional",
        ),
    )


def _runtime_authority_blockers(inputs: RuntimePromotionInputs) -> list[str]:
    metrics = _runtime_authority_metrics(inputs)
    return [
        *_runtime_authority_metric_blockers(inputs, metrics),
        *_runtime_authority_size_blockers(inputs, metrics),
    ]


def runtime_promotion_blocking_reasons(
    inputs: RuntimePromotionInputs,
) -> list[str]:
    reasons: list[str] = []
    reasons.extend(_runtime_sample_blockers(inputs))
    reasons.extend(_runtime_post_cost_blockers(inputs))
    reasons.extend(_runtime_authority_blockers(inputs))
    return reasons


def resolve_hypothesis_manifest(
    *,
    hypothesis_id: str,
    strategy_family: str | None = None,
) -> tuple[HypothesisRegistryLoadResult, HypothesisManifest]:
    registry = load_hypothesis_registry(raise_on_error=True)
    manifest = next(
        (item for item in registry.items if item.hypothesis_id == hypothesis_id), None
    )
    if manifest is None:
        raise RuntimeError(f"hypothesis_manifest_not_found:{hypothesis_id}")
    if not strategy_family_matches(manifest=manifest, strategy_family=strategy_family):
        raise RuntimeError(
            f"hypothesis_strategy_family_mismatch:{hypothesis_id}:{manifest.strategy_family}:{strategy_family}"
        )
    return registry, manifest


def _regular_session_window(
    *,
    window_start: datetime,
    window_end: datetime,
    bucket_minutes: int,
    sample_minutes: int,
    timezone_name: str,
) -> _RegularSessionWindow:
    if bucket_minutes <= 0:
        raise RuntimeError("bucket_minutes_must_be_positive")
    if sample_minutes <= 0:
        raise RuntimeError("sample_minutes_must_be_positive")
    start_utc = utc_datetime(window_start)
    end_utc = utc_datetime(window_end)
    if end_utc <= start_utc:
        raise RuntimeError("window_end_must_be_after_window_start")
    return _RegularSessionWindow(
        start_utc=start_utc,
        end_utc=end_utc,
        zone=ZoneInfo(timezone_name),
        bucket_delta=timedelta(minutes=bucket_minutes),
        sample_delta=timedelta(minutes=sample_minutes),
    )


def _session_bounds_for_day(
    session: _RegularSessionWindow,
    current_day: date,
) -> tuple[datetime, datetime]:
    session_start_local = datetime.combine(
        current_day,
        US_EQUITIES_REGULAR_OPEN,
        tzinfo=session.zone,
    )
    session_end_local = datetime.combine(
        current_day,
        US_EQUITIES_REGULAR_CLOSE,
        tzinfo=session.zone,
    )
    bucket_start = max(
        session.start_utc,
        session_start_local.astimezone(timezone.utc),
    )
    bucket_end = min(
        session.end_utc,
        session_end_local.astimezone(timezone.utc),
    )
    return bucket_start, bucket_end


def _bucket_sample_count(
    session: _RegularSessionWindow,
    *,
    bucket_start: datetime,
    bucket_end: datetime,
) -> int:
    duration = max(bucket_end - bucket_start, timedelta())
    return max(int(duration.total_seconds() // session.sample_delta.total_seconds()), 1)


def _regular_session_buckets_for_day(
    session: _RegularSessionWindow,
    current_day: date,
) -> list[tuple[datetime, datetime, int]]:
    if current_day.weekday() >= 5:
        return []
    bucket_start, session_end = _session_bounds_for_day(session, current_day)
    buckets: list[tuple[datetime, datetime, int]] = []
    while bucket_start < session_end:
        bucket_end = min(bucket_start + session.bucket_delta, session_end)
        buckets.append(
            (
                bucket_start,
                bucket_end,
                _bucket_sample_count(
                    session,
                    bucket_start=bucket_start,
                    bucket_end=bucket_end,
                ),
            )
        )
        bucket_start = bucket_end
    return buckets


def build_regular_session_buckets(
    *,
    window_start: datetime,
    window_end: datetime,
    bucket_minutes: int,
    sample_minutes: int,
    timezone_name: str = US_EQUITIES_REGULAR_TIMEZONE,
) -> list[tuple[datetime, datetime, int]]:
    session = _regular_session_window(
        window_start=window_start,
        window_end=window_end,
        bucket_minutes=bucket_minutes,
        sample_minutes=sample_minutes,
        timezone_name=timezone_name,
    )
    buckets: list[tuple[datetime, datetime, int]] = []
    current_day = session.start_utc.astimezone(session.zone).date()
    final_day = (
        (session.end_utc - timedelta(microseconds=1)).astimezone(session.zone).date()
    )
    while current_day <= final_day:
        buckets.extend(_regular_session_buckets_for_day(session, current_day))
        current_day += timedelta(days=1)
    return buckets
