"""Archive bundle and proof helpers for historical profitability validation."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from .archive_models import (
    ArchiveWalkForwardFold,
    ArchivedTradingDayBundle,
    CERTIFICATE_STATUS_HISTORICAL_PROVEN,
    CERTIFICATE_STATUS_INSUFFICIENT_HISTORY,
    CERTIFICATE_STATUS_LIVE_CAPPED,
    CERTIFICATE_STATUS_LIVE_FULL,
    CERTIFICATE_STATUS_PAPER_PROVEN,
    CERTIFICATE_STATUS_RESEARCH_ONLY,
    PROFITABILITY_CERTIFICATE_SCHEMA_VERSION,
    STATISTICAL_VALIDITY_SCHEMA_VERSION,
    SUFFICIENCY_STATUS_HISTORICAL_READY,
    SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY,
    SUFFICIENCY_STATUS_PAPER_READY,
    SUFFICIENCY_STATUS_RESEARCH_ONLY,
    REALITY_CHECK_BOOTSTRAP_REPLICATES,
    UTC,
    as_dict,
    as_int,
    as_list,
    as_text,
    decimal_mean,
    decimal_median,
    safe_decimal_ratio,
)

from .historical_run_archive import (
    candidate_daily_net_pnl_by_day,
    estimate_deflated_sharpe_ratio,
    estimate_pbo,
    estimate_reality_check_p_value,
    fit_slope,
    fold_selection_rows,
    proof_eligible_bundles,
)


def build_statistical_validity_report(
    *,
    selected_candidate_id: str | None,
    bundles: Sequence[ArchivedTradingDayBundle],
    trial_ledger: Mapping[str, Any],
    data_sufficiency: Mapping[str, Any],
    folds: Sequence[ArchiveWalkForwardFold],
    profit_target_daily_net_usd: Decimal = Decimal("250"),
    median_target_daily_net_usd: Decimal = Decimal("125"),
    profitable_day_ratio_target: Decimal = Decimal("0.60"),
    reality_check_bootstrap_replicates: int = REALITY_CHECK_BOOTSTRAP_REPLICATES,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    blockers: list[str] = []
    if selected_candidate_id is None:
        blockers.append("selected_candidate_missing")
    selected_bundles = proof_eligible_bundles(
        bundles, candidate_id=selected_candidate_id
    )
    selected_by_day = {bundle.trading_day: bundle for bundle in selected_bundles}
    if not folds:
        blockers.append("walkforward_folds_unavailable")
    test_day_values: list[Decimal] = []
    for fold in folds:
        for trading_day in fold.test_days:
            bundle = selected_by_day.get(trading_day)
            if bundle is not None:
                test_day_values.append(bundle.net_pnl_estimated)
    if not test_day_values:
        blockers.append("walkforward_test_days_empty")

    average_daily = decimal_mean(test_day_values)
    median_daily = decimal_median(test_day_values)
    profitable_ratio = safe_decimal_ratio(
        Decimal(sum(1 for value in test_day_values if value > 0)),
        Decimal(len(test_day_values)),
    )
    after_cost_positive = sum(test_day_values, Decimal("0")) > 0

    trial_count = as_int(trial_ledger.get("trial_count"))
    candidate_daily_net_pnl = candidate_daily_net_pnl_by_day(bundles)
    fold_rows = fold_selection_rows(
        candidate_daily_net_pnl_by_day=candidate_daily_net_pnl,
        folds=folds,
    )
    pbo = estimate_pbo(fold_rows)
    selected_oos_days = sorted(
        {day for fold in folds for day in fold.test_days if day in selected_by_day}
    )
    dsr_payload = estimate_deflated_sharpe_ratio(
        selected_values=test_day_values,
        candidate_daily_net_pnl_by_day=candidate_daily_net_pnl,
        oos_days=selected_oos_days,
        trial_count=trial_count,
    )
    dsr = cast(float | None, dsr_payload.get("deflated_sharpe_ratio"))
    dsr_z_score = cast(float | None, dsr_payload.get("deflated_sharpe_z_score"))
    reality_check_p_value: float | None = None
    if trial_count < 2:
        blockers.append("selection_bias_metrics_unavailable_due_to_trial_count")
    else:
        reality_check_p_value = estimate_reality_check_p_value(
            candidate_daily_net_pnl_by_day=candidate_daily_net_pnl,
            oos_days=selected_oos_days,
            bootstrap_replicates=max(reality_check_bootstrap_replicates, 50),
        )
    if average_daily < profit_target_daily_net_usd:
        blockers.append("average_daily_net_pnl_below_target")
    if median_daily < median_target_daily_net_usd:
        blockers.append("median_daily_net_pnl_below_target")
    if profitable_ratio < profitable_day_ratio_target:
        blockers.append("profitable_day_ratio_below_target")
    if not after_cost_positive:
        blockers.append("after_cost_net_pnl_not_positive")
    if pbo is None:
        blockers.append("pbo_unavailable")
    elif pbo > 0.20:
        blockers.append("pbo_above_threshold")
    if dsr is None or dsr_z_score is None:
        blockers.append("dsr_unavailable")
    elif dsr_z_score <= 0:
        blockers.append("dsr_below_threshold")
    if reality_check_p_value is None:
        blockers.append("reality_check_unavailable")
    elif reality_check_p_value >= 0.05:
        blockers.append("reality_check_p_value_above_threshold")
    historical_gate_passed = not blockers

    performance_degradation_beta = fit_slope(
        [float(row.get("is_avg_daily_net_pnl") or 0.0) for row in fold_rows],
        [float(row.get("oos_avg_daily_net_pnl") or 0.0) for row in fold_rows],
    )
    probability_of_loss = None
    if fold_rows:
        probability_of_loss = sum(
            1
            for row in fold_rows
            if float(row.get("oos_avg_daily_net_pnl") or 0.0) < 0.0
        ) / len(fold_rows)

    return {
        "schema_version": STATISTICAL_VALIDITY_SCHEMA_VERSION,
        "generated_at": (generated_at or datetime.now(UTC)).astimezone(UTC).isoformat(),
        "candidate_id": selected_candidate_id,
        "status": "passed" if historical_gate_passed else "blocked",
        "historical_gate_passed": historical_gate_passed,
        "blockers": sorted(set(blockers)),
        "proof_window": {
            "fold_count": len(folds),
            "folds": [fold.to_payload() for fold in folds],
            "test_days": sorted({day for fold in folds for day in fold.test_days}),
        },
        "metrics": {
            "average_daily_net_pnl": format(average_daily, "f"),
            "median_daily_net_pnl": format(median_daily, "f"),
            "profitable_day_ratio": format(profitable_ratio, "f"),
            "after_cost_net_pnl_positive": after_cost_positive,
        },
        "selection_bias_metrics": {
            "trial_count": trial_count,
            "fold_sample_size": len(fold_rows),
            "pbo_method": "forward_walk_relative_rank_logit",
            "pbo": pbo,
            "performance_degradation_beta": performance_degradation_beta,
            "probability_of_loss": probability_of_loss,
            "dsr_method": "deflated_sharpe_ratio_daily_oos",
            "dsr": dsr,
            "dsr_z_score": dsr_z_score,
            "selecteddaily_sharpe_ratio": dsr_payload.get("selecteddaily_sharpe_ratio"),
            "benchmark_sharpe_threshold": dsr_payload.get("benchmark_sharpe_threshold"),
            "reality_check_method": "moving_block_bootstrap_max_mean",
            "reality_check_p_value": reality_check_p_value,
            "fold_rows": fold_rows,
        },
        "thresholds": {
            "profit_target_daily_net_usd": format(profit_target_daily_net_usd, "f"),
            "median_target_daily_net_usd": format(median_target_daily_net_usd, "f"),
            "profitable_day_ratio_target": format(profitable_day_ratio_target, "f"),
            "pbo_max": "0.20",
            "dsr_min": "0",
            "reality_check_p_value_max": "0.05",
        },
        "data_sufficiency": dict(data_sufficiency),
    }


def build_profitability_certificate(
    *,
    selected_candidate_id: str | None,
    data_sufficiency: Mapping[str, Any],
    trial_ledger: Mapping[str, Any],
    statistical_validity_report: Mapping[str, Any],
    artifact_refs: Sequence[str],
    profit_target_daily_net_usd: Decimal = Decimal("250"),
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    promotion_blockers = list(
        cast(list[str], statistical_validity_report.get("blockers") or [])
    )
    promotion_blockers.extend(
        [
            str(item)
            for item in as_list(data_sufficiency.get("blockers"))
            if str(item).strip()
        ]
    )
    status = CERTIFICATE_STATUS_INSUFFICIENT_HISTORY
    sufficiency_status = (
        as_text(data_sufficiency.get("status"))
        or SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY
    )
    historical_gate_passed = bool(
        statistical_validity_report.get("historical_gate_passed", False)
    )
    if sufficiency_status == SUFFICIENCY_STATUS_RESEARCH_ONLY:
        status = CERTIFICATE_STATUS_RESEARCH_ONLY
    elif sufficiency_status == SUFFICIENCY_STATUS_HISTORICAL_READY:
        status = (
            CERTIFICATE_STATUS_HISTORICAL_PROVEN
            if historical_gate_passed
            else CERTIFICATE_STATUS_RESEARCH_ONLY
        )
    elif sufficiency_status == SUFFICIENCY_STATUS_PAPER_READY:
        status = (
            CERTIFICATE_STATUS_HISTORICAL_PROVEN
            if historical_gate_passed
            else CERTIFICATE_STATUS_RESEARCH_ONLY
        )

    return {
        "schema_version": PROFITABILITY_CERTIFICATE_SCHEMA_VERSION,
        "generated_at": (generated_at or datetime.now(UTC)).astimezone(UTC).isoformat(),
        "status": status,
        "candidate_id": selected_candidate_id,
        "sleeve_ids": [selected_candidate_id] if selected_candidate_id else [],
        "profit_target_daily_net_usd": format(profit_target_daily_net_usd, "f"),
        "data_sufficiency": dict(data_sufficiency),
        "proof_window": dict(as_dict(statistical_validity_report.get("proof_window"))),
        "trial_count": as_int(trial_ledger.get("trial_count")),
        "promotion_blockers": sorted(set(promotion_blockers)),
        "historical_metrics": dict(as_dict(statistical_validity_report.get("metrics"))),
        "paper_metrics": {},
        "execution_realism_summary": {},
        "dataset_snapshot_refs": sorted(
            {
                str(ref)
                for entry in as_list(trial_ledger.get("entries"))
                for ref in as_list(as_dict(entry).get("dataset_snapshot_refs"))
                if str(ref).strip()
            }
        ),
        "artifact_refs": sorted(
            {str(path) for path in artifact_refs if str(path).strip()}
        ),
    }


__all__ = [
    "ArchiveWalkForwardFold",
    "ArchivedTradingDayBundle",
    "CERTIFICATE_STATUS_HISTORICAL_PROVEN",
    "CERTIFICATE_STATUS_INSUFFICIENT_HISTORY",
    "CERTIFICATE_STATUS_LIVE_CAPPED",
    "CERTIFICATE_STATUS_LIVE_FULL",
    "CERTIFICATE_STATUS_PAPER_PROVEN",
    "CERTIFICATE_STATUS_RESEARCH_ONLY",
    "PROFITABILITY_CERTIFICATE_SCHEMA_VERSION",
    "STATISTICAL_VALIDITY_SCHEMA_VERSION",
    "SUFFICIENCY_STATUS_HISTORICAL_READY",
    "SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY",
    "SUFFICIENCY_STATUS_PAPER_READY",
    "SUFFICIENCY_STATUS_RESEARCH_ONLY",
    "build_profitability_certificate",
    "build_statistical_validity_report",
]
