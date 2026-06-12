# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Archive bundle and proof helpers for historical profitability validation."""

from __future__ import annotations

import hashlib
import json
import math
import random
import shutil
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from statistics import NormalDist
from typing import Any, Mapping, Sequence, cast

import psycopg
import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import VNextDatasetSnapshot
from ..evidence_contracts import ArtifactProvenance

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_25 import *
from .part_02_archive_historical_simulation_run import *


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
    reality_check_bootstrap_replicates: int = _REALITY_CHECK_BOOTSTRAP_REPLICATES,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    blockers: list[str] = []
    if selected_candidate_id is None:
        blockers.append("selected_candidate_missing")
    selected_bundles = _proof_eligible_bundles(
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

    average_daily = _decimal_mean(test_day_values)
    median_daily = _decimal_median(test_day_values)
    profitable_ratio = _safe_decimal_ratio(
        Decimal(sum(1 for value in test_day_values if value > 0)),
        Decimal(len(test_day_values)),
    )
    after_cost_positive = sum(test_day_values, Decimal("0")) > 0

    trial_count = _as_int(trial_ledger.get("trial_count"))
    candidate_daily_net_pnl_by_day = _candidate_daily_net_pnl_by_day(bundles)
    fold_rows = _fold_selection_rows(
        candidate_daily_net_pnl_by_day=candidate_daily_net_pnl_by_day,
        folds=folds,
    )
    pbo = _estimate_pbo(fold_rows)
    selected_oos_days = sorted(
        {day for fold in folds for day in fold.test_days if day in selected_by_day}
    )
    dsr_payload = _estimate_deflated_sharpe_ratio(
        selected_values=test_day_values,
        candidate_daily_net_pnl_by_day=candidate_daily_net_pnl_by_day,
        oos_days=selected_oos_days,
        trial_count=trial_count,
    )
    dsr = cast(float | None, dsr_payload.get("deflated_sharpe_ratio"))
    dsr_z_score = cast(float | None, dsr_payload.get("deflated_sharpe_z_score"))
    reality_check_p_value: float | None = None
    if trial_count < 2:
        blockers.append("selection_bias_metrics_unavailable_due_to_trial_count")
    else:
        reality_check_p_value = _estimate_reality_check_p_value(
            candidate_daily_net_pnl_by_day=candidate_daily_net_pnl_by_day,
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

    performance_degradation_beta = _fit_slope(
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
        "generated_at": (generated_at or datetime.now(_UTC))
        .astimezone(_UTC)
        .isoformat(),
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
            "selected_daily_sharpe_ratio": dsr_payload.get(
                "selected_daily_sharpe_ratio"
            ),
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
            for item in _as_list(data_sufficiency.get("blockers"))
            if str(item).strip()
        ]
    )
    status = CERTIFICATE_STATUS_INSUFFICIENT_HISTORY
    sufficiency_status = (
        _as_text(data_sufficiency.get("status"))
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
        "generated_at": (generated_at or datetime.now(_UTC))
        .astimezone(_UTC)
        .isoformat(),
        "status": status,
        "candidate_id": selected_candidate_id,
        "sleeve_ids": [selected_candidate_id] if selected_candidate_id else [],
        "profit_target_daily_net_usd": format(profit_target_daily_net_usd, "f"),
        "data_sufficiency": dict(data_sufficiency),
        "proof_window": dict(_as_dict(statistical_validity_report.get("proof_window"))),
        "trial_count": _as_int(trial_ledger.get("trial_count")),
        "promotion_blockers": sorted(set(promotion_blockers)),
        "historical_metrics": dict(
            _as_dict(statistical_validity_report.get("metrics"))
        ),
        "paper_metrics": {},
        "execution_realism_summary": {},
        "dataset_snapshot_refs": sorted(
            {
                str(ref)
                for entry in _as_list(trial_ledger.get("entries"))
                for ref in _as_list(_as_dict(entry).get("dataset_snapshot_refs"))
                if str(ref).strip()
            }
        ),
        "artifact_refs": sorted(
            {str(path) for path in artifact_refs if str(path).strip()}
        ),
    }


def _min_retention_days(bundles: Sequence[ArchivedTradingDayBundle]) -> int | None:
    days: list[int] = []
    for bundle in bundles:
        raw = _as_dict(
            bundle.market_day_inventory.get("source_topic_retention_ms_by_topic")
        )
        for value in raw.values():
            retention_ms = _as_int(value)
            if retention_ms > 0:
                days.append(max(retention_ms // 86_400_000, 0))
    if not days:
        return None
    return min(days)


def _missing_business_days(trading_days: Sequence[str]) -> list[str]:
    if not trading_days:
        return []
    ordered = sorted({date.fromisoformat(item) for item in trading_days})
    missing: list[str] = []
    cursor = ordered[0]
    end = ordered[-1]
    available = set(ordered)
    while cursor <= end:
        if cursor.weekday() < 5 and cursor not in available:
            missing.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return missing


def _decimal_mean(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    return sum(values, Decimal("0")) / Decimal(len(values))


def _decimal_median(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / Decimal("2")


def _safe_decimal_ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= 0:
        return Decimal("0")
    return numerator / denominator


def _mean_optional_floats(values: Sequence[float | None]) -> float | None:
    resolved = [value for value in values if value is not None]
    if not resolved:
        return None
    return sum(resolved) / len(resolved)


__all__ = [
    "ARCHIVE_STATUS_ARCHIVED",
    "ARCHIVE_STATUS_INSUFFICIENT",
    "ARCHIVE_STATUS_PARTIAL",
    "ArchiveWalkForwardFold",
    "ArchivedTradingDayBundle",
    "CERTIFICATE_STATUS_HISTORICAL_PROVEN",
    "CERTIFICATE_STATUS_INSUFFICIENT_HISTORY",
    "CERTIFICATE_STATUS_LIVE_CAPPED",
    "CERTIFICATE_STATUS_LIVE_FULL",
    "CERTIFICATE_STATUS_PAPER_PROVEN",
    "CERTIFICATE_STATUS_RESEARCH_ONLY",
    "DATA_SUFFICIENCY_SCHEMA_VERSION",
    "EXECUTION_DAY_INVENTORY_SCHEMA_VERSION",
    "MARKET_DAY_INVENTORY_SCHEMA_VERSION",
    "PROFITABILITY_CERTIFICATE_SCHEMA_VERSION",
    "REPLAY_DAY_MANIFEST_SCHEMA_VERSION",
    "STATISTICAL_VALIDITY_SCHEMA_VERSION",
    "SUFFICIENCY_STATUS_HISTORICAL_READY",
    "SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY",
    "SUFFICIENCY_STATUS_PAPER_READY",
    "SUFFICIENCY_STATUS_RESEARCH_ONLY",
    "TRIAL_LEDGER_SCHEMA_VERSION",
    "archive_historical_simulation_run",
    "build_execution_day_inventory",
    "build_market_day_inventory",
    "build_profitability_certificate",
    "build_replay_day_manifest",
    "build_statistical_validity_report",
    "build_trial_ledger",
    "collect_simulation_postgres_counts",
    "copy_archive_artifacts",
    "generate_archive_walkforward_folds",
    "load_archived_trading_day_bundles",
    "summarize_data_sufficiency",
    "upsert_dataset_snapshot",
]


__all__ = [name for name in globals() if not name.startswith("__")]
