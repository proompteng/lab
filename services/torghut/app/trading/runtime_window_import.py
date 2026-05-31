"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ..config import settings
from ..models import (
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    VNextDatasetSnapshot,
)
from .hypotheses import (
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    load_hypothesis_registry,
)
from .runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS
from .runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from .runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
    SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER,
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
)
from .runtime_ledger_proof_policy import runtime_ledger_proof_policy_from_env
from .runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers,
)
from .tigerbeetle_journal import TigerBeetleLedgerJournal

logger = logging.getLogger(__name__)

US_EQUITIES_REGULAR_TIMEZONE = "America/New_York"
US_EQUITIES_REGULAR_OPEN = time(hour=9, minute=30)
US_EQUITIES_REGULAR_CLOSE = time(hour=16, minute=0)
PROMOTION_GRADE_POST_COST_BASES = frozenset(
    {
        POST_COST_PNL_BASIS,
    }
)
RUNTIME_LEDGER_PROOF_POLICY = runtime_ledger_proof_policy_from_env()
_RUNTIME_LEDGER_PROOF_SATISFIED_METADATA_BLOCKERS = frozenset(
    {
        "paper_route_runtime_ledger_import_pending",
    }
)
_RUNTIME_WINDOW_IMPORT_CAPITAL_ONLY_BLOCKERS = frozenset(
    {
        "candidate_board_promotion_not_allowed",
        "drift_checks_not_ok",
        "final_promotion_not_authorized",
        "final_promotion_not_allowed",
        "live_runtime_ledger_required",
        "paper_probation_evidence_collection_only",
        "paper_stage_evidence_collection_only",
        "post_cost_expectancy_below_manifest_threshold",
        "post_cost_expectancy_non_positive",
        "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor",
        "runtime_ledger_best_day_share_above_limit",
        "runtime_ledger_max_intraday_drawdown_above_limit",
        "runtime_ledger_mean_daily_net_pnl_after_costs_below_target",
        "runtime_ledger_median_daily_net_pnl_after_costs_below_floor",
        "runtime_ledger_observed_trading_day_count_below_authority_minimum",
        "runtime_ledger_p10_daily_net_pnl_after_costs_below_floor",
        "runtime_ledger_stage_not_live",
        "runtime_ledger_worst_day_net_pnl_after_costs_below_floor",
        "sample_count_below_canary_minimum",
        "slippage_budget_exceeded",
        "recent_slippage_budget_exceeded",
    }
)
RUNTIME_LEDGER_BUCKET_SCHEMAS = frozenset(
    {
        EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "torghut.runtime-ledger-bucket.v1",
    }
)


@dataclass(frozen=True)
class ObservedRuntimeBucket:
    window_started_at: datetime
    window_ended_at: datetime
    market_session_count: int
    decision_count: int
    trade_count: int
    order_count: int
    decision_alignment_ratio: Decimal
    avg_abs_slippage_bps: Decimal
    post_cost_expectancy_bps: Decimal
    post_cost_promotion_sample_count: int
    post_cost_basis_counts: dict[str, int]
    continuity_ok: bool
    drift_ok: bool
    dependency_quorum_decision: str
    payload_json: dict[str, Any]


@dataclass(frozen=True)
class _NormalizedTcaRow:
    computed_at: datetime
    abs_slippage_bps: Decimal | None
    post_cost_expectancy_bps: Decimal | None
    post_cost_expectancy_basis: str
    post_cost_promotion_eligible: bool
    runtime_ledger_bucket: dict[str, Any]
    source_decision_mode: str | None = None


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except Exception:
        return None


def _decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." not in text:
        return text
    return text.rstrip("0").rstrip(".") or "0"


def _strategy_family_matches(
    *,
    manifest: HypothesisManifest,
    strategy_family: str | None,
) -> bool:
    if strategy_family is None:
        return True
    normalized_manifest = manifest.strategy_family.replace("-", "_").lower()
    normalized_input = strategy_family.replace("-", "_").lower()
    if normalized_manifest == normalized_input:
        return True
    return (
        normalized_input in normalized_manifest
        or normalized_manifest in normalized_input
    )


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _post_cost_expectancy_basis(value: Any) -> str:
    text = _text(value)
    if text is None:
        return "tca_shortfall_proxy"
    return text.lower().replace("-", "_")


def _post_cost_basis_is_promotion_grade(
    *,
    basis: str,
    explicit_value: Any,
) -> bool:
    parsed = _observation_bool(explicit_value)
    basis_is_promotion_grade = basis in PROMOTION_GRADE_POST_COST_BASES
    if parsed is False:
        return False
    if parsed is True:
        return basis_is_promotion_grade
    return basis_is_promotion_grade


def _parse_observation_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _observation_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return bool(value)
    text = _text(value)
    if text is None:
        return None
    normalized = text.lower()
    if normalized in {"1", "true", "yes", "on", "pass", "passed", "ok", "ready"}:
        return True
    if normalized in {"0", "false", "no", "off", "fail", "failed", "blocked"}:
        return False
    return None


def _observation_int(value: Any) -> int:
    try:
        return max(0, int(Decimal(str(value))))
    except Exception:
        return 0


def _observation_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except Exception:
        return Decimal("0")


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        text
        for item in cast(Sequence[object], value)
        if (text := _text(item)) is not None
    ]


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _hash_count(value: Any) -> int:
    if not isinstance(value, Mapping):
        return 0
    mapping = cast(Mapping[object, object], value)
    return sum(1 for key in mapping.keys() if str(key).strip())


def _persisted_runtime_ledger_bucket_evidence_grade(
    row: StrategyRuntimeLedgerBucket,
) -> bool:
    blockers = _string_list(row.blockers_json)
    payload_json = _mapping(row.payload_json)
    return (
        row.pnl_basis == POST_COST_PNL_BASIS
        and int(row.fill_count or 0) > 0
        and int(row.submitted_order_count or 0) > 0
        and int(row.closed_trade_count or 0) > 0
        and int(row.open_position_count or 0) == 0
        and row.filled_notional > 0
        and row.post_cost_expectancy_bps is not None
        and _hash_count(row.execution_policy_hash_counts) > 0
        and _hash_count(row.cost_model_hash_counts) > 0
        and _hash_count(row.lineage_hash_counts) > 0
        and not cost_basis_counts_have_non_promotion_grade_costs(
            payload_json.get("cost_basis_counts")
        )
        and not runtime_ledger_promotion_source_authority_blockers(payload_json)
        and not blockers
    )


def _runtime_ledger_bucket_blockers(bucket: Mapping[str, Any]) -> list[str]:
    blockers = _string_list(bucket.get("blockers"))
    ledger_schema_version = _text(bucket.get("ledger_schema_version"))
    pnl_basis = _text(bucket.get("pnl_basis"))
    filled_notional = _optional_decimal(bucket.get("filled_notional"))
    cost_amount = _optional_decimal(bucket.get("cost_amount"))
    post_cost_expectancy = _optional_decimal(bucket.get("post_cost_expectancy_bps"))
    diagnostic_closed_trade_expectancy = _optional_decimal(
        bucket.get("diagnostic_closed_trade_expectancy_bps")
    )

    if ledger_schema_version is None:
        blockers.append("runtime_ledger_schema_version_missing")
    elif ledger_schema_version not in RUNTIME_LEDGER_BUCKET_SCHEMAS:
        blockers.append("runtime_ledger_schema_version_invalid")
    if pnl_basis is None:
        blockers.append("runtime_ledger_pnl_basis_missing")
    elif pnl_basis != POST_COST_PNL_BASIS:
        blockers.append("runtime_ledger_pnl_basis_invalid")
    blockers.extend(runtime_ledger_promotion_source_authority_blockers(bucket))
    if _observation_int(bucket.get("fill_count")) <= 0:
        blockers.append("runtime_fills_missing")
    if _observation_int(bucket.get("decision_count")) <= 0:
        blockers.append("runtime_decision_lifecycle_missing")
    if _observation_int(bucket.get("submitted_order_count")) <= 0:
        blockers.append("submitted_order_lifecycle_missing")
    if _observation_int(bucket.get("closed_trade_count")) <= 0:
        blockers.append("closed_round_trip_missing")
    if bucket.get("open_position_count") is None:
        blockers.append("runtime_ledger_open_position_count_missing")
    elif _observation_int(bucket.get("open_position_count")) > 0:
        blockers.append("unclosed_position")
    if filled_notional is None or filled_notional <= 0:
        blockers.append("filled_notional_missing")
    if cost_amount is None or cost_amount < 0:
        blockers.append("explicit_cost_missing")
    non_promotion_grade_cost_basis = is_non_promotion_grade_runtime_cost_basis(
        bucket.get("cost_basis")
    ) or cost_basis_counts_have_non_promotion_grade_costs(
        bucket.get("cost_basis_counts")
    )
    if non_promotion_grade_cost_basis:
        blockers.append("runtime_ledger_cost_basis_non_promotion_grade")
    source_decision_mode = normalize_source_decision_mode(
        bucket.get("source_decision_mode")
    )
    profit_proof_eligible = _observation_bool(bucket.get("profit_proof_eligible"))
    source_decision_mode_counts = bucket.get("source_decision_mode_counts")
    if (
        source_decision_mode is None
        and not source_decision_mode_counts_have_profit_proof_modes(
            source_decision_mode_counts
        )
        and not source_decision_mode_counts_have_non_profit_proof_modes(
            source_decision_mode_counts
        )
        and profit_proof_eligible is not True
    ):
        blockers.append(SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER)
    if source_decision_mode and not source_decision_mode_is_profit_proof_eligible(
        source_decision_mode
    ):
        blockers.append(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if source_decision_mode_counts_have_non_profit_proof_modes(
        source_decision_mode_counts
    ):
        blockers.append(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if profit_proof_eligible is False:
        blockers.append(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if post_cost_expectancy is None:
        blockers.append(
            "runtime_ledger_expectancy_not_promotion_grade"
            if diagnostic_closed_trade_expectancy is not None
            else "runtime_ledger_expectancy_missing"
        )
    if _hash_count(bucket.get("execution_policy_hash_counts")) <= 0:
        blockers.append("runtime_ledger_execution_policy_hash_missing")
    if _hash_count(bucket.get("cost_model_hash_counts")) <= 0:
        blockers.append("runtime_ledger_cost_model_hash_missing")
    if _hash_count(bucket.get("lineage_hash_counts")) <= 0:
        blockers.append("runtime_ledger_lineage_hash_missing")
    return list(dict.fromkeys(blockers))


def _runtime_ledger_bucket_payload(value: Any) -> dict[str, Any]:
    bucket = _mapping(value)
    if not bucket:
        return {}
    return {**bucket, "blockers": _runtime_ledger_bucket_blockers(bucket)}


def _runtime_ledger_row_is_promotion_grade(row: _NormalizedTcaRow) -> bool:
    return (
        row.post_cost_expectancy_bps is not None
        and row.post_cost_promotion_eligible
        and (
            row.source_decision_mode is None
            or source_decision_mode_is_profit_proof_eligible(row.source_decision_mode)
        )
        and row.post_cost_expectancy_basis == POST_COST_PNL_BASIS
        and bool(row.runtime_ledger_bucket)
        and not _runtime_ledger_bucket_blockers(row.runtime_ledger_bucket)
    )


def _runtime_ledger_post_cost_from_rows(
    rows: Sequence[_NormalizedTcaRow],
) -> tuple[Decimal | None, Decimal, Decimal, int]:
    total_net = Decimal("0")
    total_notional = Decimal("0")
    sample_count = 0
    for row in rows:
        if not _runtime_ledger_row_is_promotion_grade(row):
            continue
        net_pnl = _optional_decimal(
            row.runtime_ledger_bucket.get("net_strategy_pnl_after_costs")
        )
        filled_notional = _optional_decimal(
            row.runtime_ledger_bucket.get("filled_notional")
        )
        if net_pnl is None or filled_notional is None or filled_notional <= 0:
            continue
        total_net += net_pnl
        total_notional += filled_notional
        sample_count += 1
    if sample_count <= 0 or total_notional <= 0:
        return None, total_net, total_notional, sample_count
    return (
        (total_net / total_notional) * Decimal("10000"),
        total_net,
        total_notional,
        sample_count,
    )


def _paper_probation_blocking_reasons(runtime_payload: Mapping[str, Any]) -> list[str]:
    target_metadata = _mapping(runtime_payload.get("target_metadata"))
    runtime_ledger_import_satisfied = (
        runtime_payload.get("runtime_ledger_profit_proof_present") is True
    )

    def target_blockers(value: Any) -> list[str]:
        blockers = _string_list(value)
        if not runtime_ledger_import_satisfied:
            return blockers
        return [
            blocker
            for blocker in blockers
            if blocker not in _RUNTIME_LEDGER_PROOF_SATISFIED_METADATA_BLOCKERS
        ]

    reasons: list[str] = []
    reasons.extend(
        target_blockers(runtime_payload.get("runtime_ledger_target_metadata_blockers"))
    )
    reasons.extend(
        target_blockers(target_metadata.get("runtime_ledger_target_metadata_blockers"))
    )
    if not target_metadata:
        return list(dict.fromkeys(reasons))

    paper_probation_authorized = _observation_bool(
        target_metadata.get("paper_probation_authorized")
    )
    evidence_collection_stage = _text(target_metadata.get("evidence_collection_stage"))
    if paper_probation_authorized is True and evidence_collection_stage == "paper":
        reasons.append("paper_probation_evidence_collection_only")
    if _observation_bool(target_metadata.get("promotion_allowed")) is False:
        reasons.append("candidate_board_promotion_not_allowed")
    if _observation_bool(target_metadata.get("final_promotion_authorized")) is False:
        reasons.append("final_promotion_not_authorized")
    if _observation_bool(target_metadata.get("final_promotion_allowed")) is False:
        reasons.append("final_promotion_not_allowed")
    return list(dict.fromkeys(reasons))


def _delay_adjusted_depth_stress_blocking_reasons(
    *,
    manifest: HypothesisManifest,
    runtime_payload: Mapping[str, Any],
    now: datetime,
) -> list[str]:
    requirements = manifest.entry_requirements
    if not requirements.require_delay_adjusted_depth_stress:
        return []

    raw_report = runtime_payload.get("delay_adjusted_depth_stress_report")
    report: Mapping[str, Any]
    if isinstance(raw_report, Mapping):
        report = cast(Mapping[str, Any], raw_report)
    else:
        report = {}
    check_count = max(
        _observation_int(
            runtime_payload.get("delay_adjusted_depth_stress_checks_total")
        ),
        _observation_int(runtime_payload.get("delay_depth_stress_checks_total")),
        _observation_int(report.get("stress_case_count")),
        _observation_int(report.get("case_count")),
        _observation_int(report.get("trading_day_count")),
    )
    passed = _observation_bool(
        runtime_payload.get("delay_adjusted_depth_stress_passed")
        if runtime_payload.get("delay_adjusted_depth_stress_passed") is not None
        else report.get("passed", report.get("ok"))
    )
    checked_at = (
        _parse_observation_datetime(
            runtime_payload.get("delay_adjusted_depth_stress_checked_at")
        )
        or _parse_observation_datetime(report.get("generated_at"))
        or _parse_observation_datetime(report.get("checked_at"))
    )

    reasons: list[str] = []
    if check_count < requirements.min_delay_adjusted_depth_stress_checks:
        reasons.append("delay_adjusted_depth_stress_missing")
    elif passed is not True:
        reasons.append("delay_adjusted_depth_stress_failed")
    if checked_at is None:
        reasons.append("delay_adjusted_depth_stress_missing")
    elif (
        requirements.max_delay_adjusted_depth_stress_age_minutes is not None
        and checked_at
        < now
        - timedelta(minutes=requirements.max_delay_adjusted_depth_stress_age_minutes)
    ):
        reasons.append("delay_adjusted_depth_stress_stale")
    if not reasons:
        summary = _delay_adjusted_depth_stress_summary(runtime_payload)
        if _observation_bool(summary.get("tail_coverage_passed")) is not True:
            reasons.append("delay_adjusted_depth_tail_coverage_missing")
        if _observation_decimal(summary.get("p10_active_day_fillable_notional")) <= 0:
            reasons.append("delay_adjusted_depth_p10_fillable_non_positive")
        if _observation_decimal(summary.get("worst_active_day_fillable_notional")) <= 0:
            reasons.append("delay_adjusted_depth_worst_fillable_non_positive")
        if _observation_decimal(summary.get("stress_net_pnl_per_day")) <= 0:
            reasons.append("delay_adjusted_depth_stress_net_pnl_non_positive")
        if _observation_bool(summary.get("fill_survival_evidence_present")) is not True:
            reasons.append("fill_survival_evidence_missing")
        if _observation_int(summary.get("fill_survival_sample_count")) <= 0:
            reasons.append("fill_survival_sample_count_zero")
        if (
            _observation_bool(summary.get("queue_ahead_depletion_evidence_present"))
            is not True
        ):
            reasons.append("queue_ahead_depletion_evidence_missing")
        if _observation_int(summary.get("queue_ahead_depletion_sample_count")) <= 0:
            reasons.append("queue_ahead_depletion_sample_count_zero")
    return list(dict.fromkeys(reasons))


def _delay_adjusted_depth_stress_summary(
    runtime_payload: Mapping[str, Any],
) -> dict[str, object]:
    raw_report = runtime_payload.get("delay_adjusted_depth_stress_report")
    report: Mapping[str, Any]
    if isinstance(raw_report, Mapping):
        report = cast(Mapping[str, Any], raw_report)
    else:
        report = {}
    check_count = max(
        _observation_int(
            runtime_payload.get("delay_adjusted_depth_stress_checks_total")
        ),
        _observation_int(runtime_payload.get("delay_depth_stress_checks_total")),
        _observation_int(report.get("stress_case_count")),
        _observation_int(report.get("case_count")),
        _observation_int(report.get("trading_day_count")),
    )
    checked_at = (
        _parse_observation_datetime(
            runtime_payload.get("delay_adjusted_depth_stress_checked_at")
        )
        or _parse_observation_datetime(report.get("generated_at"))
        or _parse_observation_datetime(report.get("checked_at"))
    )
    latency_grid_ms = (
        _string_list(runtime_payload.get("delay_adjusted_depth_latency_grid_ms"))
        or _string_list(report.get("delay_adjusted_depth_latency_grid_ms"))
        or _string_list(report.get("latency_grid_ms"))
    )
    return {
        "checks_total": check_count,
        "passed": _observation_bool(
            runtime_payload.get("delay_adjusted_depth_stress_passed")
            if runtime_payload.get("delay_adjusted_depth_stress_passed") is not None
            else report.get("passed", report.get("ok"))
        ),
        "checked_at": checked_at.isoformat() if checked_at is not None else None,
        "artifact_ref": _text(
            runtime_payload.get("delay_adjusted_depth_stress_artifact_ref")
        )
        or _text(report.get("artifact_ref")),
        "latency_grid_ms": latency_grid_ms,
        "grid_max_stress_ms": _text(
            runtime_payload.get("delay_adjusted_depth_grid_max_stress_ms")
        )
        or _text(report.get("delay_adjusted_depth_grid_max_stress_ms"))
        or _text(report.get("grid_max_stress_ms")),
        "worst_grid_fillable_notional_per_day": _text(
            runtime_payload.get(
                "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
            )
        )
        or _text(
            report.get("delay_adjusted_depth_worst_grid_fillable_notional_per_day")
        )
        or _text(report.get("worst_grid_fillable_notional_per_day")),
        "worst_active_day_fillable_notional": _text(
            runtime_payload.get(
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            )
        )
        or _text(report.get("delay_adjusted_depth_worst_active_day_fillable_notional"))
        or _text(report.get("worst_active_day_fillable_notional")),
        "p10_active_day_fillable_notional": _text(
            runtime_payload.get("delay_adjusted_depth_p10_active_day_fillable_notional")
        )
        or _text(report.get("delay_adjusted_depth_p10_active_day_fillable_notional"))
        or _text(report.get("p10_active_day_fillable_notional")),
        "tail_coverage_passed": _observation_bool(
            runtime_payload.get("delay_adjusted_depth_tail_coverage_passed")
            if runtime_payload.get("delay_adjusted_depth_tail_coverage_passed")
            is not None
            else report.get(
                "delay_adjusted_depth_tail_coverage_passed",
                report.get("tail_coverage_passed"),
            )
        ),
        "fillable_ratio": _text(
            runtime_payload.get("delay_adjusted_depth_fillable_ratio")
        )
        or _text(report.get("delay_adjusted_depth_fillable_ratio"))
        or _text(report.get("fillable_ratio")),
        "survival_adjusted_fillable_ratio": _text(
            runtime_payload.get("delay_adjusted_depth_survival_adjusted_fillable_ratio")
        )
        or _text(report.get("delay_adjusted_depth_survival_adjusted_fillable_ratio"))
        or _text(report.get("survival_adjusted_fillable_ratio")),
        "unfillable_notional_per_day": _text(
            runtime_payload.get("delay_adjusted_depth_unfillable_notional_per_day")
        )
        or _text(report.get("delay_adjusted_depth_unfillable_notional_per_day"))
        or _text(report.get("unfillable_notional_per_day")),
        "stress_net_pnl_per_day": _text(
            runtime_payload.get("delay_adjusted_depth_stress_net_pnl_per_day")
        )
        or _text(report.get("delay_adjusted_depth_stress_net_pnl_per_day"))
        or _text(report.get("stress_net_pnl_per_day")),
        "fill_survival_evidence_present": _observation_bool(
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
            _observation_int(
                runtime_payload.get("delay_adjusted_depth_fill_survival_sample_count")
            ),
            _observation_int(
                report.get("delay_adjusted_depth_fill_survival_sample_count")
            ),
            _observation_int(report.get("fill_survival_sample_count")),
        ),
        "fill_survival_rate": _text(
            runtime_payload.get("delay_adjusted_depth_fill_survival_rate")
        )
        or _text(report.get("delay_adjusted_depth_fill_survival_rate"))
        or _text(report.get("fill_survival_rate")),
        "queue_ratio_p95": _text(
            runtime_payload.get("delay_adjusted_depth_queue_ratio_p95")
        )
        or _text(report.get("delay_adjusted_depth_queue_ratio_p95"))
        or _text(report.get("queue_ratio_p95")),
        "queue_ahead_depletion_evidence_present": _observation_bool(
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
            _observation_int(
                runtime_payload.get(
                    "delay_adjusted_depth_queue_ahead_depletion_sample_count"
                )
            ),
            _observation_int(
                report.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
            ),
            _observation_int(report.get("queue_ahead_depletion_sample_count")),
        ),
    }


def _capital_stage_for_runtime_import(
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


def _capital_multiplier_for_stage(stage: str) -> str:
    return {
        "shadow": "0",
        "0.10x canary": "0.10",
        "0.25x canary": "0.25",
        "0.50x live": "0.50",
        "1.00x live": "1.00",
    }.get(stage, "0")


def _runtime_window_import_proof_blockers(
    *,
    promotion_blocking_reasons: Sequence[str],
    runtime_payload: Mapping[str, Any],
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    window_start: datetime,
    window_end: datetime,
) -> list[dict[str, Any]]:
    blockers: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_blocker(reason: str) -> None:
        code = _text(reason)
        if not code or code in seen:
            return
        seen.add(code)
        blockers.append(
            {
                "blocker": code,
                "hypothesis_id": hypothesis_id,
                "candidate_id": candidate_id,
                "observed_stage": observed_stage,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "promotion_authority": _text(runtime_payload.get("promotion_authority"))
                or "unknown",
                "authority_reason": _text(runtime_payload.get("authority_reason")),
                "runtime_ledger_profit_proof_present": bool(
                    runtime_payload.get("runtime_ledger_profit_proof_present")
                ),
                "remediation": (
                    "Inspect the imported runtime-window ledger rows and repair route, "
                    "TCA, fill, cost, or lineage evidence before treating this target as "
                    "promotion proof."
                ),
            }
        )

    for reason in promotion_blocking_reasons:
        add_blocker(reason)

    if runtime_payload and runtime_payload.get("authoritative") is False:
        add_blocker(
            _text(runtime_payload.get("authority_reason"))
            or "runtime_observation_not_authoritative"
        )

    return blockers


def _runtime_window_import_evidence_blocking_reasons(
    promotion_blocking_reasons: Sequence[str],
) -> list[str]:
    return [
        reason
        for reason in promotion_blocking_reasons
        if reason not in _RUNTIME_WINDOW_IMPORT_CAPITAL_ONLY_BLOCKERS
    ]


def _runtime_ledger_authority_gate_targets(
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
            _decimal_text(target_implied_notional)
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
    return _optional_decimal(runtime_ledger_daily_summary.get(key)) or Decimal("0")


def _runtime_promotion_blocking_reasons(
    *,
    observed_stage: str,
    inserted: int,
    total_session_samples: int,
    total_decision_count: int,
    total_trade_count: int,
    total_order_count: int,
    total_post_cost_promotion_sample_count: int,
    runtime_ledger_notional_weighted_sample_count: int,
    total_post_cost_basis_counts: Mapping[str, int],
    average_slippage: Decimal,
    average_post_cost: Decimal,
    runtime_ledger_daily_summary: Mapping[str, Any],
    latest_three_budget_ok: bool,
    all_continuity_ok: bool,
    all_drift_ok: bool,
    dependency_quorum_allowed: bool,
    manifest: HypothesisManifest,
    budget: Decimal,
) -> list[str]:
    reasons: list[str] = []
    if observed_stage == "paper":
        reasons.append("paper_stage_evidence_collection_only")
    if inserted <= 0:
        reasons.append("runtime_window_evidence_missing")
    if total_session_samples < manifest.min_sample_count_for_live_canary:
        reasons.append("sample_count_below_canary_minimum")
    if total_decision_count <= 0:
        reasons.append("runtime_decision_count_zero")
    if total_order_count <= 0:
        reasons.append("runtime_order_count_zero")
    if total_trade_count <= 0:
        reasons.append("runtime_trade_count_zero")
    if average_slippage > budget:
        reasons.append("slippage_budget_exceeded")
    if not latest_three_budget_ok:
        reasons.append("recent_slippage_budget_exceeded")
    if not all_continuity_ok:
        reasons.append("evidence_continuity_not_ok")
    if not all_drift_ok:
        reasons.append("drift_checks_not_ok")
    if not dependency_quorum_allowed:
        reasons.append("dependency_quorum_not_allow")
    if total_post_cost_promotion_sample_count <= 0:
        reasons.append("post_cost_pnl_basis_missing")
    if (
        runtime_ledger_notional_weighted_sample_count <= 0
        or runtime_ledger_notional_weighted_sample_count
        < total_post_cost_promotion_sample_count
    ):
        reasons.append("runtime_ledger_pnl_basis_missing")
    if average_post_cost <= Decimal("0"):
        reasons.append("post_cost_expectancy_non_positive")
    elif average_post_cost < manifest.expected_gross_edge_bps:
        reasons.append("post_cost_expectancy_below_manifest_threshold")
    observed_trading_days = int(
        _runtime_summary_decimal(
            runtime_ledger_daily_summary,
            "runtime_ledger_observed_trading_day_count",
        )
    )
    mean_daily_net_pnl = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_mean_daily_net_pnl_after_costs",
    )
    median_daily_net_pnl = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_median_daily_net_pnl_after_costs",
    )
    p10_daily_net_pnl = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_p10_daily_net_pnl_after_costs",
    )
    worst_day_net_pnl = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_worst_day_net_pnl_after_costs",
    )
    max_intraday_drawdown = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_max_intraday_drawdown",
    )
    best_day_share = _optional_decimal(
        runtime_ledger_daily_summary.get("runtime_ledger_best_day_share")
    )
    avg_daily_filled_notional = _runtime_summary_decimal(
        runtime_ledger_daily_summary,
        "runtime_ledger_avg_daily_filled_notional",
    )

    if observed_trading_days < RUNTIME_LEDGER_PROOF_POLICY.authority_min_trading_days:
        reasons.append(
            "runtime_ledger_observed_trading_day_count_below_authority_minimum"
        )
    if (
        mean_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_mean_daily_net_pnl_after_costs_below_target")
    if (
        median_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_median_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_median_daily_net_pnl_after_costs_below_floor")
    if (
        p10_daily_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_p10_daily_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_p10_daily_net_pnl_after_costs_below_floor")
    if (
        worst_day_net_pnl
        < RUNTIME_LEDGER_PROOF_POLICY.authority_min_worst_day_net_pnl_after_costs
    ):
        reasons.append("runtime_ledger_worst_day_net_pnl_after_costs_below_floor")
    if (
        max_intraday_drawdown
        > RUNTIME_LEDGER_PROOF_POLICY.authority_max_intraday_drawdown
    ):
        reasons.append("runtime_ledger_max_intraday_drawdown_above_limit")
    if (
        best_day_share is not None
        and best_day_share > RUNTIME_LEDGER_PROOF_POLICY.authority_max_best_day_share
    ):
        reasons.append("runtime_ledger_best_day_share_above_limit")
    if average_post_cost > 0:
        target_implied_notional = (
            RUNTIME_LEDGER_PROOF_POLICY.authority_min_mean_daily_net_pnl_after_costs
            * Decimal("10000")
            / average_post_cost
        )
        if avg_daily_filled_notional < target_implied_notional:
            reasons.append(
                "runtime_ledger_avg_daily_filled_notional_below_target_implied_floor"
            )
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
    if not _strategy_family_matches(manifest=manifest, strategy_family=strategy_family):
        raise RuntimeError(
            f"hypothesis_strategy_family_mismatch:{hypothesis_id}:{manifest.strategy_family}:{strategy_family}"
        )
    return registry, manifest


def build_regular_session_buckets(
    *,
    window_start: datetime,
    window_end: datetime,
    bucket_minutes: int,
    sample_minutes: int,
    timezone_name: str = US_EQUITIES_REGULAR_TIMEZONE,
) -> list[tuple[datetime, datetime, int]]:
    if bucket_minutes <= 0:
        raise RuntimeError("bucket_minutes_must_be_positive")
    if sample_minutes <= 0:
        raise RuntimeError("sample_minutes_must_be_positive")
    start_utc = _utc(window_start)
    end_utc = _utc(window_end)
    if end_utc <= start_utc:
        raise RuntimeError("window_end_must_be_after_window_start")

    zone = ZoneInfo(timezone_name)
    bucket_delta = timedelta(minutes=bucket_minutes)
    sample_delta = timedelta(minutes=sample_minutes)
    buckets: list[tuple[datetime, datetime, int]] = []

    current_day = start_utc.astimezone(zone).date()
    final_day = (end_utc - timedelta(microseconds=1)).astimezone(zone).date()
    while current_day <= final_day:
        if current_day.weekday() >= 5:
            current_day += timedelta(days=1)
            continue
        session_start_local = datetime.combine(
            current_day, US_EQUITIES_REGULAR_OPEN, tzinfo=zone
        )
        session_end_local = datetime.combine(
            current_day, US_EQUITIES_REGULAR_CLOSE, tzinfo=zone
        )
        bucket_start = max(start_utc, session_start_local.astimezone(timezone.utc))
        session_end = min(end_utc, session_end_local.astimezone(timezone.utc))
        while bucket_start < session_end:
            bucket_end = min(bucket_start + bucket_delta, session_end)
            duration = max(bucket_end - bucket_start, timedelta())
            sample_count = max(
                int(duration.total_seconds() // sample_delta.total_seconds()), 1
            )
            buckets.append((bucket_start, bucket_end, sample_count))
            bucket_start = bucket_end
        current_day += timedelta(days=1)
    return buckets


def build_observed_runtime_buckets(
    *,
    bucket_ranges: Sequence[tuple[datetime, datetime, int]],
    decision_times: Sequence[datetime],
    execution_times: Sequence[datetime],
    tca_rows: Sequence[Mapping[str, Any]],
    continuity_ok: bool,
    drift_ok: bool,
    dependency_quorum_decision: str,
) -> list[ObservedRuntimeBucket]:
    normalized_decisions = [_utc(item) for item in decision_times]
    normalized_executions = [_utc(item) for item in execution_times]
    normalized_tca_rows: list[_NormalizedTcaRow] = []
    for row in tca_rows:
        computed_at_raw = row.get("computed_at")
        if not isinstance(computed_at_raw, datetime):
            continue
        basis = _post_cost_expectancy_basis(
            row.get("post_cost_expectancy_basis") or row.get("post_cost_basis")
        )
        runtime_ledger_bucket = _runtime_ledger_bucket_payload(
            row.get("runtime_ledger_bucket")
        )
        source_decision_mode = normalize_source_decision_mode(
            row.get("source_decision_mode")
            or runtime_ledger_bucket.get("source_decision_mode")
        )
        source_decision_mode_eligible = (
            source_decision_mode is None
            or source_decision_mode_is_profit_proof_eligible(source_decision_mode)
        )
        normalized_tca_rows.append(
            _NormalizedTcaRow(
                computed_at=_utc(computed_at_raw),
                abs_slippage_bps=_optional_decimal(row.get("abs_slippage_bps")),
                post_cost_expectancy_bps=_optional_decimal(
                    row.get("post_cost_expectancy_bps")
                ),
                post_cost_expectancy_basis=basis,
                post_cost_promotion_eligible=_post_cost_basis_is_promotion_grade(
                    basis=basis,
                    explicit_value=row.get("post_cost_promotion_eligible"),
                )
                and source_decision_mode_eligible,
                runtime_ledger_bucket=runtime_ledger_bucket,
                source_decision_mode=source_decision_mode,
            )
        )

    buckets: list[ObservedRuntimeBucket] = []
    for bucket_start, bucket_end, market_session_count in bucket_ranges:
        decisions = [
            item for item in normalized_decisions if bucket_start <= item < bucket_end
        ]
        executions = [
            item for item in normalized_executions if bucket_start <= item < bucket_end
        ]
        bucket_tca = [
            row
            for row in normalized_tca_rows
            if bucket_start <= row.computed_at < bucket_end
        ]
        runtime_ledger_decision_count = sum(
            _observation_int(row.runtime_ledger_bucket.get("decision_count"))
            for row in bucket_tca
            if row.runtime_ledger_bucket
        )
        runtime_ledger_trade_count = sum(
            _observation_int(row.runtime_ledger_bucket.get("fill_count"))
            for row in bucket_tca
            if row.runtime_ledger_bucket
        )
        runtime_ledger_order_count = sum(
            _observation_int(row.runtime_ledger_bucket.get("submitted_order_count"))
            for row in bucket_tca
            if row.runtime_ledger_bucket
        )
        decision_count = max(len(decisions), runtime_ledger_decision_count)
        trade_count = max(len(executions), runtime_ledger_trade_count)
        order_count = max(len(executions), runtime_ledger_order_count)
        if decision_count <= 0 and trade_count <= 0:
            decision_alignment_ratio = Decimal("1")
        elif decision_count <= 0:
            decision_alignment_ratio = Decimal("0")
        else:
            decision_alignment_ratio = Decimal(trade_count) / Decimal(decision_count)
        slippage_values = [
            row.abs_slippage_bps
            for row in bucket_tca
            if row.abs_slippage_bps is not None
        ]
        promotion_post_cost_rows = [
            row for row in bucket_tca if _runtime_ledger_row_is_promotion_grade(row)
        ]
        runtime_ledger_post_cost_bps: Decimal | None
        runtime_ledger_net: Decimal
        runtime_ledger_notional: Decimal
        runtime_ledger_sample_count: int
        (
            runtime_ledger_post_cost_bps,
            runtime_ledger_net,
            runtime_ledger_notional,
            runtime_ledger_sample_count,
        ) = _runtime_ledger_post_cost_from_rows(promotion_post_cost_rows)
        basis_counts = dict(
            sorted(
                Counter(row.post_cost_expectancy_basis for row in bucket_tca).items()
            )
        )
        runtime_ledger_buckets = [
            row.runtime_ledger_bucket for row in bucket_tca if row.runtime_ledger_bucket
        ]
        if slippage_values:
            avg_abs_slippage_bps = sum(slippage_values) / Decimal(len(slippage_values))
        else:
            avg_abs_slippage_bps = Decimal("0")
        if runtime_ledger_post_cost_bps is not None:
            post_cost_expectancy_bps = runtime_ledger_post_cost_bps
            post_cost_expectancy_aggregation = "runtime_ledger_notional_weighted"
        else:
            post_cost_expectancy_bps = Decimal("0")
            post_cost_expectancy_aggregation = "no_runtime_ledger_post_cost_rows"
        buckets.append(
            ObservedRuntimeBucket(
                window_started_at=bucket_start,
                window_ended_at=bucket_end,
                market_session_count=max(market_session_count, 1),
                decision_count=decision_count,
                trade_count=trade_count,
                order_count=order_count,
                decision_alignment_ratio=decision_alignment_ratio,
                avg_abs_slippage_bps=avg_abs_slippage_bps,
                post_cost_expectancy_bps=post_cost_expectancy_bps,
                post_cost_promotion_sample_count=len(promotion_post_cost_rows),
                post_cost_basis_counts=basis_counts,
                continuity_ok=continuity_ok,
                drift_ok=drift_ok,
                dependency_quorum_decision=dependency_quorum_decision,
                payload_json={
                    "bucket_start": bucket_start.isoformat(),
                    "bucket_end": bucket_end.isoformat(),
                    "market_session_count": market_session_count,
                    "decision_count": decision_count,
                    "trade_count": trade_count,
                    "order_count": order_count,
                    "tca_row_count": len(bucket_tca),
                    "slippage_sample_count": len(slippage_values),
                    "post_cost_promotion_sample_count": len(promotion_post_cost_rows),
                    "post_cost_expectancy_aggregation": post_cost_expectancy_aggregation,
                    "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
                    "runtime_ledger_filled_notional": str(runtime_ledger_notional),
                    "runtime_ledger_net_strategy_pnl_after_costs": str(
                        runtime_ledger_net
                    ),
                    "post_cost_basis_counts": basis_counts,
                    "runtime_ledger_buckets": runtime_ledger_buckets,
                },
            )
        )
    return buckets


def _runtime_ledger_bucket_payloads(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw_payloads = payload.get("runtime_ledger_buckets")
    if isinstance(raw_payloads, Sequence) and not isinstance(
        raw_payloads, (str, bytes, bytearray)
    ):
        payloads: list[dict[str, Any]] = []
        for item in cast(Sequence[object], raw_payloads):
            payload = _runtime_ledger_bucket_payload(item)
            if payload:
                payloads.append(payload)
        return payloads
    single_payload = _runtime_ledger_bucket_payload(
        payload.get("runtime_ledger_bucket")
    )
    return [single_payload] if single_payload else []


def _runtime_ledger_bucket_replacement_scopes(
    *,
    buckets: Sequence[ObservedRuntimeBucket],
    runtime_payload: Mapping[str, Any],
) -> list[tuple[datetime, datetime, str | None, str | None]]:
    scopes: list[tuple[datetime, datetime, str | None, str | None]] = []
    seen: set[tuple[datetime, datetime, str | None, str | None]] = set()

    def add_scope(
        *,
        started_at: datetime,
        ended_at: datetime,
        account_label: str | None,
        runtime_strategy_name: str | None,
    ) -> None:
        if ended_at <= started_at:
            return
        scope = (started_at, ended_at, account_label, runtime_strategy_name)
        if scope not in seen:
            seen.add(scope)
            scopes.append(scope)

    for bucket in buckets:
        for ledger_payload in _runtime_ledger_bucket_payloads(bucket.payload_json):
            bucket_started_at = (
                _parse_observation_datetime(ledger_payload.get("bucket_started_at"))
                or bucket.window_started_at
            )
            bucket_ended_at = (
                _parse_observation_datetime(ledger_payload.get("bucket_ended_at"))
                or bucket.window_ended_at
            )
            account_label = _text(ledger_payload.get("account_label")) or _text(
                runtime_payload.get("account_label")
            )
            runtime_strategy_name = _text(ledger_payload.get("strategy_id")) or _text(
                runtime_payload.get("strategy_name")
            )
            add_scope(
                started_at=bucket_started_at,
                ended_at=bucket_ended_at,
                account_label=account_label,
                runtime_strategy_name=runtime_strategy_name,
            )
            source_window_started_at = _parse_observation_datetime(
                ledger_payload.get("source_window_start")
            )
            source_window_ended_at = _parse_observation_datetime(
                ledger_payload.get("source_window_end")
            )
            if (
                source_window_started_at is not None
                and source_window_ended_at is not None
            ):
                add_scope(
                    started_at=source_window_started_at,
                    ended_at=source_window_ended_at,
                    account_label=account_label,
                    runtime_strategy_name=runtime_strategy_name,
                )
    return scopes


def _delete_replaced_runtime_ledger_buckets(
    *,
    session: Session,
    run_id: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    replacement_scopes: Sequence[tuple[datetime, datetime, str | None, str | None]],
) -> int:
    if not replacement_scopes:
        return 0
    overlap_predicates = [
        and_(
            StrategyRuntimeLedgerBucket.bucket_started_at < bucket_ended_at,
            StrategyRuntimeLedgerBucket.bucket_ended_at > bucket_started_at,
            StrategyRuntimeLedgerBucket.account_label == account_label,
            StrategyRuntimeLedgerBucket.runtime_strategy_name == runtime_strategy_name,
        )
        for (
            bucket_started_at,
            bucket_ended_at,
            account_label,
            runtime_strategy_name,
        ) in replacement_scopes
    ]
    result = session.execute(
        delete(StrategyRuntimeLedgerBucket).where(
            StrategyRuntimeLedgerBucket.run_id != run_id,
            StrategyRuntimeLedgerBucket.candidate_id == candidate_id,
            StrategyRuntimeLedgerBucket.hypothesis_id == hypothesis_id,
            StrategyRuntimeLedgerBucket.observed_stage == observed_stage,
            or_(*overlap_predicates),
        )
    )
    return int(getattr(result, "rowcount", 0) or 0)


def _runtime_ledger_post_cost_from_observed_buckets(
    buckets: Sequence[ObservedRuntimeBucket],
) -> tuple[Decimal | None, Decimal, Decimal, int]:
    total_net = Decimal("0")
    total_notional = Decimal("0")
    sample_count = 0
    for bucket in buckets:
        for ledger_payload in _runtime_ledger_bucket_payloads(bucket.payload_json):
            if _runtime_ledger_bucket_blockers(ledger_payload):
                continue
            net_pnl = _optional_decimal(
                ledger_payload.get("net_strategy_pnl_after_costs")
            )
            filled_notional = _optional_decimal(ledger_payload.get("filled_notional"))
            if net_pnl is None or filled_notional is None or filled_notional <= 0:
                continue
            total_net += net_pnl
            total_notional += filled_notional
            sample_count += 1
    if sample_count <= 0 or total_notional <= 0:
        return None, total_net, total_notional, sample_count
    return (
        (total_net / total_notional) * Decimal("10000"),
        total_net,
        total_notional,
        sample_count,
    )


def _runtime_ledger_trading_day_key(dt: datetime) -> str:
    return (
        _utc(dt).astimezone(ZoneInfo(US_EQUITIES_REGULAR_TIMEZONE)).date().isoformat()
    )


def _median_decimal(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    sorted_values = sorted(values)
    middle = len(sorted_values) // 2
    if len(sorted_values) % 2:
        return sorted_values[middle]
    return (sorted_values[middle - 1] + sorted_values[middle]) / Decimal("2")


def _p10_decimal(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    sorted_values = sorted(values)
    index = max(0, ((len(sorted_values) + 9) // 10) - 1)
    return sorted_values[index]


_RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS = (
    "account_equity",
    "portfolio_equity",
    "start_equity",
    "starting_equity",
    "equity",
    "portfolio_value",
    "net_liquidation",
    "net_liquidation_value",
)
_RUNTIME_LEDGER_SYMBOL_KEYS = ("symbol", "ticker")
_RUNTIME_LEDGER_SYMBOL_PNL_KEYS = (
    "net_pnl_by_symbol",
    "symbol_net_pnl_after_costs",
    "net_strategy_pnl_after_costs_by_symbol",
)


def _runtime_ledger_equity_denominator(
    bucket: Mapping[str, Any],
) -> tuple[Decimal, str] | None:
    for key in _RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS:
        value = _optional_decimal(bucket.get(key))
        if value is not None and value > 0:
            return value, key
    return None


def _runtime_ledger_symbol(bucket: Mapping[str, Any]) -> str | None:
    for key in _RUNTIME_LEDGER_SYMBOL_KEYS:
        symbol = _text(bucket.get(key))
        if symbol is not None:
            return symbol.upper()
    return None


def _runtime_ledger_symbol_pnl_items(
    bucket: Mapping[str, Any],
    *,
    net_pnl: Decimal | None,
) -> list[tuple[str, Decimal]]:
    for key in _RUNTIME_LEDGER_SYMBOL_PNL_KEYS:
        raw_mapping = bucket.get(key)
        if not isinstance(raw_mapping, Mapping):
            continue
        items: list[tuple[str, Decimal]] = []
        for raw_symbol, raw_pnl in cast(Mapping[object, object], raw_mapping).items():
            symbol = str(raw_symbol).strip().upper()
            pnl = _optional_decimal(raw_pnl)
            if symbol and pnl is not None:
                items.append((symbol, pnl))
        if items:
            return items

    symbol = _runtime_ledger_symbol(bucket)
    if symbol is None or net_pnl is None:
        return []
    return [(symbol, net_pnl)]


def _uuid_values(values: Sequence[str]) -> list[UUID]:
    uuids: list[UUID] = []
    for value in values:
        try:
            uuids.append(UUID(value))
        except ValueError:
            continue
    return uuids


def _tigerbeetle_transfer_account_ids(row: TigerBeetleTransferRef) -> list[str]:
    payload = _mapping(row.payload_json)
    account_ids: list[str] = []
    for key in ("debit_account_id", "credit_account_id"):
        account_id = _text(payload.get(key))
        if account_id is not None:
            account_ids.append(account_id)
    return account_ids


def _tigerbeetle_account_refs_for_ids(
    *,
    session: Session,
    cluster_ids: Sequence[int],
    account_ids: Sequence[str],
) -> list[TigerBeetleAccountRef]:
    if not cluster_ids or not account_ids:
        return []
    return list(
        session.execute(
            select(TigerBeetleAccountRef)
            .where(
                TigerBeetleAccountRef.cluster_id.in_(cluster_ids),
                TigerBeetleAccountRef.account_id.in_(account_ids),
            )
            .order_by(
                TigerBeetleAccountRef.cluster_id.asc(),
                TigerBeetleAccountRef.account_key.asc(),
            )
        )
        .scalars()
        .all()
    )


def _tigerbeetle_refs_for_ledger_payload(
    session: Session,
    ledger_payload: Mapping[str, Any],
) -> dict[str, Any]:
    event_ids = _uuid_values(
        [
            *_string_list(ledger_payload.get("execution_order_event_ids")),
            *_string_list(
                ledger_payload.get("runtime_ledger_execution_order_event_ids")
            ),
        ]
    )
    event_fingerprints = [
        *_string_list(ledger_payload.get("execution_order_event_fingerprints")),
        *_string_list(ledger_payload.get("event_fingerprints")),
    ]
    predicates: list[ColumnElement[bool]] = []
    if event_ids:
        predicates.append(
            cast(
                ColumnElement[bool],
                TigerBeetleTransferRef.execution_order_event_id.in_(event_ids),
            )
        )
    if event_fingerprints:
        predicates.append(
            cast(
                ColumnElement[bool],
                TigerBeetleTransferRef.event_fingerprint.in_(event_fingerprints),
            )
        )
    if not predicates:
        return {}

    rows = (
        session.execute(
            select(TigerBeetleTransferRef)
            .where(or_(*predicates))
            .order_by(TigerBeetleTransferRef.created_at.asc())
        )
        .scalars()
        .all()
    )
    if not rows:
        return {}
    account_ids = sorted(
        {
            account_id
            for row in rows
            for account_id in _tigerbeetle_transfer_account_ids(row)
        }
    )
    account_rows = _tigerbeetle_account_refs_for_ids(
        session=session,
        cluster_ids=sorted({row.cluster_id for row in rows}),
        account_ids=account_ids,
    )
    account_ref_keys = {(row.cluster_id, row.account_id) for row in account_rows}
    missing_account_ids = sorted(
        {
            account_id
            for row in rows
            for account_id in _tigerbeetle_transfer_account_ids(row)
            if (row.cluster_id, account_id) not in account_ref_keys
        }
    )
    return {
        "schema_version": "torghut.tigerbeetle-ledger-refs.v1",
        "cluster_ids": sorted({row.cluster_id for row in rows}),
        "account_count": len(account_rows),
        "account_ids": sorted({row.account_id for row in account_rows}),
        "account_keys": sorted({row.account_key for row in account_rows}),
        "accounts": [
            {
                "cluster_id": row.cluster_id,
                "account_id": row.account_id,
                "account_key": row.account_key,
                "ledger": row.ledger,
                "code": row.code,
                "account_label": row.account_label,
                "symbol": row.symbol,
                "strategy_id": row.strategy_id,
            }
            for row in account_rows
        ],
        "missing_account_ids": missing_account_ids,
        "transfer_count": len(rows),
        "transfer_ids": sorted({row.transfer_id for row in rows}),
        "transfers": [
            {
                "cluster_id": row.cluster_id,
                "transfer_id": row.transfer_id,
                "transfer_kind": row.transfer_kind,
                "ledger": row.ledger,
                "code": row.code,
                "amount": str(row.amount),
                "status": row.status,
                "execution_order_event_id": str(row.execution_order_event_id)
                if row.execution_order_event_id
                else None,
                "event_fingerprint": row.event_fingerprint,
            }
            for row in rows
        ],
    }


def _ledger_payload_with_tigerbeetle_refs(
    session: Session,
    ledger_payload: dict[str, Any],
) -> dict[str, Any]:
    tigerbeetle_refs = _tigerbeetle_refs_for_ledger_payload(session, ledger_payload)
    if not tigerbeetle_refs:
        return ledger_payload
    source_refs = _string_list(ledger_payload.get("source_refs"))
    if "postgres:tigerbeetle_transfer_refs" not in source_refs:
        source_refs.append("postgres:tigerbeetle_transfer_refs")
    source_row_counts = _mapping(ledger_payload.get("source_row_counts"))
    source_row_counts["tigerbeetle_transfer_refs"] = tigerbeetle_refs["transfer_count"]
    if tigerbeetle_refs.get("account_count"):
        if "postgres:tigerbeetle_account_refs" not in source_refs:
            source_refs.append("postgres:tigerbeetle_account_refs")
        source_row_counts["tigerbeetle_account_refs"] = tigerbeetle_refs[
            "account_count"
        ]
    return {
        **ledger_payload,
        "source_refs": source_refs,
        "source_row_counts": source_row_counts,
        "tigerbeetle": tigerbeetle_refs,
        "tigerbeetle_account_ids": tigerbeetle_refs["account_ids"],
        "tigerbeetle_account_keys": tigerbeetle_refs["account_keys"],
        "tigerbeetle_transfer_ids": tigerbeetle_refs["transfer_ids"],
    }


def _journal_tigerbeetle_runtime_ledger_bucket(
    session: Session,
    row: StrategyRuntimeLedgerBucket,
) -> None:
    if not settings.tigerbeetle_enabled or not settings.tigerbeetle_journal_enabled:
        return
    session.flush()
    try:
        with session.begin_nested():
            TigerBeetleLedgerJournal().journal_runtime_ledger_bucket(session, row)
    except Exception as exc:
        if settings.tigerbeetle_required:
            raise
        logger.warning(
            "TigerBeetle runtime-ledger journal failed for bucket_id=%s run_id=%s: %s",
            row.id,
            row.run_id,
            exc,
        )


def _runtime_ledger_daily_summary_from_observed_buckets(
    buckets: Sequence[ObservedRuntimeBucket],
) -> dict[str, Any]:
    ordered_buckets = sorted(buckets, key=lambda item: item.window_started_at)
    trading_days = sorted(
        {
            _runtime_ledger_trading_day_key(bucket.window_started_at)
            for bucket in ordered_buckets
        }
    )
    net_pnl_by_day = {day: Decimal("0") for day in trading_days}
    filled_notional_by_day = {day: Decimal("0") for day in trading_days}
    closed_trade_count_by_day = {day: 0 for day in trading_days}
    cumulative_by_day = {day: Decimal("0") for day in trading_days}
    peak_by_day = {day: Decimal("0") for day in trading_days}
    max_intraday_drawdown = Decimal("0")
    symbol_net_pnl: dict[str, Decimal] = {}
    equity_denominators: list[tuple[Decimal, str]] = []

    for bucket in ordered_buckets:
        day = _runtime_ledger_trading_day_key(bucket.window_started_at)
        bucket_net_pnl = Decimal("0")
        for ledger_payload in _runtime_ledger_bucket_payloads(bucket.payload_json):
            if _runtime_ledger_bucket_blockers(ledger_payload):
                continue
            net_pnl = _optional_decimal(
                ledger_payload.get("net_strategy_pnl_after_costs")
            )
            filled_notional = _optional_decimal(ledger_payload.get("filled_notional"))
            if net_pnl is not None:
                bucket_net_pnl += net_pnl
                net_pnl_by_day[day] += net_pnl
            if filled_notional is not None and filled_notional > 0:
                filled_notional_by_day[day] += filled_notional
            closed_trade_count_by_day[day] += _observation_int(
                ledger_payload.get("closed_trade_count")
            )
            for symbol, pnl in _runtime_ledger_symbol_pnl_items(
                ledger_payload,
                net_pnl=net_pnl,
            ):
                symbol_net_pnl[symbol] = symbol_net_pnl.get(symbol, Decimal("0")) + pnl
            equity_denominator = _runtime_ledger_equity_denominator(ledger_payload)
            if equity_denominator is not None:
                equity_denominators.append(equity_denominator)
        cumulative_by_day[day] += bucket_net_pnl
        if cumulative_by_day[day] > peak_by_day[day]:
            peak_by_day[day] = cumulative_by_day[day]
        drawdown = peak_by_day[day] - cumulative_by_day[day]
        if drawdown > max_intraday_drawdown:
            max_intraday_drawdown = drawdown

    day_count = len(trading_days)
    daily_net_values = [net_pnl_by_day[day] for day in trading_days]
    total_daily_net_pnl = sum(daily_net_values, Decimal("0"))
    total_filled_notional = sum(
        (filled_notional_by_day[day] for day in trading_days),
        Decimal("0"),
    )
    mean_daily_net_pnl = (
        total_daily_net_pnl / Decimal(day_count) if day_count > 0 else Decimal("0")
    )
    avg_daily_filled_notional = (
        total_filled_notional / Decimal(day_count) if day_count > 0 else Decimal("0")
    )
    positive_daily_values = [value for value in daily_net_values if value > 0]
    total_positive_daily_net_pnl = sum(positive_daily_values, Decimal("0"))
    summary: dict[str, Any] = {
        "runtime_ledger_observed_trading_day_count": day_count,
        "runtime_ledger_net_pnl_by_trading_day": {
            day: str(net_pnl_by_day[day]) for day in trading_days
        },
        "runtime_ledger_mean_daily_net_pnl_after_costs": str(mean_daily_net_pnl),
        "runtime_ledger_median_daily_net_pnl_after_costs": str(
            _median_decimal(daily_net_values)
        ),
        "runtime_ledger_p10_daily_net_pnl_after_costs": str(
            _p10_decimal(daily_net_values)
        ),
        "runtime_ledger_worst_day_net_pnl_after_costs": str(
            min(daily_net_values) if daily_net_values else Decimal("0")
        ),
        "runtime_ledger_max_intraday_drawdown": str(max_intraday_drawdown),
        "runtime_ledger_avg_daily_filled_notional": str(avg_daily_filled_notional),
        "runtime_ledger_closed_trade_count_by_day": {
            day: closed_trade_count_by_day[day] for day in trading_days
        },
    }
    if total_positive_daily_net_pnl > 0:
        summary["runtime_ledger_best_day_share"] = str(
            max(positive_daily_values) / total_positive_daily_net_pnl
        )

    if equity_denominators:
        equity_denominator, equity_source = min(
            equity_denominators, key=lambda item: item[0]
        )
        summary["runtime_ledger_drawdown_pct_equity"] = str(
            max_intraday_drawdown / equity_denominator
        )
        summary["runtime_ledger_max_drawdown_pct_equity"] = summary[
            "runtime_ledger_drawdown_pct_equity"
        ]
        summary["runtime_ledger_drawdown_pct_equity_source"] = equity_source

    symbol_abs_pnl = {
        symbol: abs(value) for symbol, value in symbol_net_pnl.items() if value != 0
    }
    total_symbol_abs_pnl = sum(symbol_abs_pnl.values(), Decimal("0"))
    if total_symbol_abs_pnl > 0:
        summary["runtime_ledger_net_pnl_by_symbol"] = {
            symbol: str(symbol_net_pnl[symbol]) for symbol in sorted(symbol_net_pnl)
        }
        summary["runtime_ledger_symbol_concentration_share"] = str(
            max(symbol_abs_pnl.values()) / total_symbol_abs_pnl
        )
        summary["runtime_ledger_symbol_concentration_basis"] = "absolute_net_pnl"

    return summary


def persist_observed_runtime_windows(
    *,
    session: Session,
    run_id: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_family: str | None,
    source_manifest_ref: str | None,
    buckets: Sequence[ObservedRuntimeBucket],
    slippage_budget_bps: Decimal | None = None,
    runtime_observation_payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if observed_stage not in {"paper", "live"}:
        raise RuntimeError(f"invalid_observed_stage:{observed_stage}")
    registry, manifest = resolve_hypothesis_manifest(
        hypothesis_id=hypothesis_id,
        strategy_family=strategy_family,
    )
    budget = slippage_budget_bps or manifest.max_allowed_slippage_bps

    existing_hypothesis = session.execute(
        select(StrategyHypothesis).where(
            StrategyHypothesis.hypothesis_id == hypothesis_id
        )
    ).scalar_one_or_none()
    if existing_hypothesis is None:
        session.add(
            StrategyHypothesis(
                hypothesis_id=hypothesis_id,
                lane_id=manifest.lane_id,
                strategy_family=manifest.strategy_family,
                source_manifest_ref=source_manifest_ref or registry.path,
                active=True,
                payload_json=manifest.model_dump(mode="json"),
            )
        )
    version_key = f"{manifest.schema_version}:{manifest.lane_id}"
    existing_version = session.execute(
        select(StrategyHypothesisVersion).where(
            StrategyHypothesisVersion.hypothesis_id == hypothesis_id,
            StrategyHypothesisVersion.version_key == version_key,
        )
    ).scalar_one_or_none()
    if existing_version is None:
        session.add(
            StrategyHypothesisVersion(
                hypothesis_id=hypothesis_id,
                version_key=version_key,
                source_manifest_ref=source_manifest_ref or registry.path,
                active=True,
                payload_json=manifest.model_dump(mode="json"),
            )
        )

    runtime_payload = dict(runtime_observation_payload or {})
    delay_depth_stress_summary = _delay_adjusted_depth_stress_summary(runtime_payload)
    artifact_refs = _string_list(runtime_payload.get("artifact_refs"))
    dataset_snapshot_ref = _text(runtime_payload.get("dataset_snapshot_ref")) or next(
        (ref for ref in artifact_refs if ref), None
    )
    dataset_source = _text(runtime_payload.get("source_kind")) or (
        "paper_runtime_observed"
        if observed_stage == "paper"
        else "live_runtime_observed"
    )
    if candidate_id is not None and dataset_snapshot_ref is not None:
        existing_dataset = session.execute(
            select(VNextDatasetSnapshot).where(
                VNextDatasetSnapshot.run_id == run_id,
                VNextDatasetSnapshot.dataset_id == f"runtime-window-{run_id}",
            )
        ).scalar_one_or_none()
        if existing_dataset is None:
            session.add(
                VNextDatasetSnapshot(
                    run_id=run_id,
                    candidate_id=candidate_id,
                    dataset_id=f"runtime-window-{run_id}",
                    source=dataset_source,
                    dataset_version=run_id,
                    dataset_from=min(
                        (bucket.window_started_at for bucket in buckets), default=None
                    ),
                    dataset_to=max(
                        (bucket.window_ended_at for bucket in buckets), default=None
                    ),
                    artifact_ref=dataset_snapshot_ref,
                    payload_json={
                        "observed_stage": observed_stage,
                        "hypothesis_id": hypothesis_id,
                        "strategy_family": manifest.strategy_family,
                        "runtime_observation": runtime_payload,
                    },
                )
            )

    session.execute(
        delete(StrategyHypothesisMetricWindow).where(
            StrategyHypothesisMetricWindow.run_id == run_id,
            StrategyHypothesisMetricWindow.hypothesis_id == hypothesis_id,
            StrategyHypothesisMetricWindow.observed_stage == observed_stage,
        )
    )
    session.execute(
        delete(StrategyCapitalAllocation).where(
            StrategyCapitalAllocation.run_id == run_id,
            StrategyCapitalAllocation.hypothesis_id == hypothesis_id,
        )
    )
    session.execute(
        delete(StrategyPromotionDecision).where(
            StrategyPromotionDecision.run_id == run_id,
            StrategyPromotionDecision.hypothesis_id == hypothesis_id,
            StrategyPromotionDecision.promotion_target == observed_stage,
        )
    )
    session.execute(
        delete(StrategyRuntimeLedgerBucket).where(
            StrategyRuntimeLedgerBucket.run_id == run_id,
            StrategyRuntimeLedgerBucket.hypothesis_id == hypothesis_id,
            StrategyRuntimeLedgerBucket.observed_stage == observed_stage,
        )
    )

    evidence_provenance = (
        "paper_runtime_observed"
        if observed_stage == "paper"
        else "live_runtime_observed"
    )
    raw_buckets = sorted(buckets, key=lambda item: item.window_ended_at)
    sorted_buckets = [
        bucket
        for bucket in raw_buckets
        if bucket.decision_count > 0 or bucket.trade_count > 0 or bucket.order_count > 0
    ]
    replaced_runtime_ledger_bucket_count = _delete_replaced_runtime_ledger_buckets(
        session=session,
        run_id=run_id,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        observed_stage=observed_stage,
        replacement_scopes=_runtime_ledger_bucket_replacement_scopes(
            buckets=sorted_buckets,
            runtime_payload=runtime_payload,
        ),
    )
    raw_window_count = len(raw_buckets)
    skipped_zero_activity_window_count = raw_window_count - len(sorted_buckets)
    runtime_ledger_daily_summary = _runtime_ledger_daily_summary_from_observed_buckets(
        raw_buckets
    )
    inserted = len(sorted_buckets)
    total_session_samples = sum(
        bucket.market_session_count for bucket in sorted_buckets
    )
    total_weight = sum(
        (Decimal(bucket.market_session_count) for bucket in sorted_buckets),
        Decimal("0"),
    )
    total_decision_count = sum(bucket.decision_count for bucket in sorted_buckets)
    total_trade_count = sum(bucket.trade_count for bucket in sorted_buckets)
    total_order_count = sum(bucket.order_count for bucket in sorted_buckets)
    total_post_cost_promotion_sample_count = sum(
        bucket.post_cost_promotion_sample_count for bucket in sorted_buckets
    )
    total_post_cost_basis_counter: Counter[str] = Counter()
    for bucket in sorted_buckets:
        total_post_cost_basis_counter.update(bucket.post_cost_basis_counts)
    total_post_cost_basis_counts = dict(sorted(total_post_cost_basis_counter.items()))
    latest_three_budget_ok = (
        all(bucket.avg_abs_slippage_bps <= budget for bucket in sorted_buckets[-3:])
        if sorted_buckets
        else False
    )
    all_continuity_ok = (
        all(bucket.continuity_ok for bucket in sorted_buckets)
        if sorted_buckets
        else False
    )
    all_drift_ok = (
        all(bucket.drift_ok for bucket in sorted_buckets) if sorted_buckets else False
    )
    dependency_quorum_allowed = (
        all(
            str(bucket.dependency_quorum_decision or "").strip().lower() == "allow"
            for bucket in sorted_buckets
        )
        if sorted_buckets
        else False
    )
    (
        runtime_ledger_average_post_cost,
        runtime_ledger_net_strategy_pnl_after_costs,
        runtime_ledger_filled_notional,
        runtime_ledger_sample_count,
    ) = _runtime_ledger_post_cost_from_observed_buckets(sorted_buckets)
    if runtime_ledger_average_post_cost is not None:
        average_post_cost = runtime_ledger_average_post_cost
        post_cost_expectancy_aggregation = "runtime_ledger_notional_weighted"
    else:
        average_post_cost = Decimal("0")
        post_cost_expectancy_aggregation = "no_runtime_ledger_post_cost_rows"
    runtime_ledger_promotion_gate_targets = _runtime_ledger_authority_gate_targets(
        average_post_cost_bps=average_post_cost
    )
    runtime_ledger_daily_summary = {
        **runtime_ledger_daily_summary,
        "runtime_ledger_promotion_gate_targets": runtime_ledger_promotion_gate_targets,
    }
    average_slippage = (
        sum(
            (
                bucket.avg_abs_slippage_bps * Decimal(bucket.market_session_count)
                for bucket in sorted_buckets
            ),
            Decimal("0"),
        )
        / total_weight
        if total_weight > 0
        else Decimal("0")
    )
    promotion_blocking_reasons = _runtime_promotion_blocking_reasons(
        observed_stage=observed_stage,
        inserted=inserted,
        total_session_samples=total_session_samples,
        total_decision_count=total_decision_count,
        total_trade_count=total_trade_count,
        total_order_count=total_order_count,
        total_post_cost_promotion_sample_count=total_post_cost_promotion_sample_count,
        runtime_ledger_notional_weighted_sample_count=runtime_ledger_sample_count,
        total_post_cost_basis_counts=total_post_cost_basis_counts,
        average_slippage=average_slippage,
        average_post_cost=average_post_cost,
        runtime_ledger_daily_summary=runtime_ledger_daily_summary,
        latest_three_budget_ok=latest_three_budget_ok,
        all_continuity_ok=all_continuity_ok,
        all_drift_ok=all_drift_ok,
        dependency_quorum_allowed=dependency_quorum_allowed,
        manifest=manifest,
        budget=budget,
    )
    latest_observation_at = max(
        (bucket.window_ended_at for bucket in sorted_buckets),
        default=max(
            (bucket.window_ended_at for bucket in raw_buckets),
            default=datetime.now(timezone.utc),
        ),
    )
    import_window_start = min(
        (bucket.window_started_at for bucket in raw_buckets),
        default=latest_observation_at,
    )
    import_window_end = max(
        (bucket.window_ended_at for bucket in raw_buckets),
        default=latest_observation_at,
    )
    promotion_blocking_reasons = list(
        dict.fromkeys(
            [
                *promotion_blocking_reasons,
                *_paper_probation_blocking_reasons(runtime_payload),
                *_delay_adjusted_depth_stress_blocking_reasons(
                    manifest=manifest,
                    runtime_payload=runtime_payload,
                    now=latest_observation_at,
                ),
            ]
        )
    )
    promotion_allowed = not promotion_blocking_reasons
    evidence_blocking_reasons = _runtime_window_import_evidence_blocking_reasons(
        promotion_blocking_reasons
    )
    proof_blockers = _runtime_window_import_proof_blockers(
        promotion_blocking_reasons=evidence_blocking_reasons,
        runtime_payload=runtime_payload,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        observed_stage=observed_stage,
        window_start=import_window_start,
        window_end=import_window_end,
    )
    proof_status = "blocked" if proof_blockers else "ok"
    runtime_materialization_target: dict[str, Any] = {
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "strategy_family": manifest.strategy_family,
        "account_label": _text(runtime_payload.get("account_label")),
        "strategy_name": _text(runtime_payload.get("strategy_name")),
        "window_start": import_window_start.isoformat(),
        "window_end": import_window_end.isoformat(),
        "runtime_ledger_profit_proof_present": bool(
            runtime_payload.get("runtime_ledger_profit_proof_present")
        ),
        "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
        "runtime_ledger_filled_notional": str(runtime_ledger_filled_notional),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            runtime_ledger_net_strategy_pnl_after_costs
        ),
        "runtime_ledger_daily_summary": runtime_ledger_daily_summary,
        "proof_status": proof_status,
        "proof_blockers": proof_blockers,
        "evidence_blocking_reasons": evidence_blocking_reasons,
        "capital_promotion_allowed": promotion_allowed,
        "capital_promotion_blocking_reasons": promotion_blocking_reasons,
    }
    metric_window_rows: list[StrategyHypothesisMetricWindow] = []
    runtime_ledger_rows: list[StrategyRuntimeLedgerBucket] = []
    running_session_samples = 0
    for bucket in sorted_buckets:
        running_session_samples += bucket.market_session_count
        capital_stage = _capital_stage_for_runtime_import(
            observed_stage=observed_stage,
            promotion_allowed=promotion_allowed,
            session_samples=running_session_samples,
            manifest=manifest,
        )
        metric_window_row = StrategyHypothesisMetricWindow(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            observed_stage=observed_stage,
            window_started_at=bucket.window_started_at,
            window_ended_at=bucket.window_ended_at,
            market_session_count=bucket.market_session_count,
            decision_count=bucket.decision_count,
            trade_count=bucket.trade_count,
            order_count=bucket.order_count,
            evidence_provenance=evidence_provenance,
            evidence_maturity="empirically_validated",
            decision_alignment_ratio=str(bucket.decision_alignment_ratio),
            avg_abs_slippage_bps=str(bucket.avg_abs_slippage_bps),
            slippage_budget_bps=str(budget),
            post_cost_expectancy_bps=str(bucket.post_cost_expectancy_bps),
            continuity_ok=bucket.continuity_ok,
            drift_ok=bucket.drift_ok,
            dependency_quorum_decision=bucket.dependency_quorum_decision,
            capital_stage=capital_stage,
            payload_json={
                **bucket.payload_json,
                "source_manifest_ref": source_manifest_ref or registry.path,
                "runtime_observation": runtime_payload,
            },
        )
        session.add(metric_window_row)
        metric_window_rows.append(metric_window_row)
        for raw_ledger_payload in _runtime_ledger_bucket_payloads(bucket.payload_json):
            ledger_payload = _ledger_payload_with_tigerbeetle_refs(
                session,
                raw_ledger_payload,
            )
            bucket_started_at = (
                _parse_observation_datetime(ledger_payload.get("bucket_started_at"))
                or bucket.window_started_at
            )
            bucket_ended_at = (
                _parse_observation_datetime(ledger_payload.get("bucket_ended_at"))
                or bucket.window_ended_at
            )
            runtime_ledger_row = StrategyRuntimeLedgerBucket(
                run_id=run_id,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                observed_stage=observed_stage,
                bucket_started_at=bucket_started_at,
                bucket_ended_at=bucket_ended_at,
                account_label=_text(ledger_payload.get("account_label"))
                or _text(runtime_payload.get("account_label")),
                runtime_strategy_name=_text(ledger_payload.get("strategy_id"))
                or _text(runtime_payload.get("strategy_name")),
                strategy_family=manifest.strategy_family,
                fill_count=_observation_int(ledger_payload.get("fill_count")),
                decision_count=_observation_int(ledger_payload.get("decision_count")),
                submitted_order_count=_observation_int(
                    ledger_payload.get("submitted_order_count")
                ),
                cancelled_order_count=_observation_int(
                    ledger_payload.get("cancelled_order_count")
                ),
                rejected_order_count=_observation_int(
                    ledger_payload.get("rejected_order_count")
                ),
                unfilled_order_count=_observation_int(
                    ledger_payload.get("unfilled_order_count")
                ),
                closed_trade_count=_observation_int(
                    ledger_payload.get("closed_trade_count")
                ),
                open_position_count=_observation_int(
                    ledger_payload.get("open_position_count")
                ),
                filled_notional=_observation_decimal(
                    ledger_payload.get("filled_notional")
                ),
                gross_strategy_pnl=_observation_decimal(
                    ledger_payload.get("gross_strategy_pnl")
                ),
                cost_amount=_observation_decimal(ledger_payload.get("cost_amount")),
                net_strategy_pnl_after_costs=_observation_decimal(
                    ledger_payload.get("net_strategy_pnl_after_costs")
                ),
                post_cost_expectancy_bps=_optional_decimal(
                    ledger_payload.get("post_cost_expectancy_bps")
                ),
                ledger_schema_version=_text(ledger_payload.get("ledger_schema_version"))
                or "unknown",
                pnl_basis=_text(ledger_payload.get("pnl_basis")) or "unknown",
                execution_policy_hash_counts=_mapping(
                    ledger_payload.get("execution_policy_hash_counts")
                )
                or None,
                cost_model_hash_counts=_mapping(
                    ledger_payload.get("cost_model_hash_counts")
                )
                or None,
                lineage_hash_counts=_mapping(ledger_payload.get("lineage_hash_counts"))
                or None,
                blockers_json=_string_list(ledger_payload.get("blockers")),
                payload_json={
                    **ledger_payload,
                    "runtime_ledger_daily_summary": runtime_ledger_daily_summary,
                },
            )
            session.add(runtime_ledger_row)
            _journal_tigerbeetle_runtime_ledger_bucket(session, runtime_ledger_row)
            runtime_ledger_rows.append(runtime_ledger_row)

    final_capital_stage = _capital_stage_for_runtime_import(
        observed_stage=observed_stage,
        promotion_allowed=promotion_allowed,
        session_samples=total_session_samples,
        manifest=manifest,
    )
    reason_summary = (
        "runtime_evidence_thresholds_satisfied"
        if promotion_allowed
        else ",".join(promotion_blocking_reasons)[:255]
    )
    session.add(
        StrategyCapitalAllocation(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            prior_stage="shadow",
            stage=final_capital_stage,
            capital_multiplier=_capital_multiplier_for_stage(final_capital_stage),
            rollback_target_stage="shadow",
            payload_json={
                "imported": True,
                "observed_stage": observed_stage,
                "raw_window_count": raw_window_count,
                "window_count": inserted,
                "skipped_zero_activity_window_count": skipped_zero_activity_window_count,
                "market_session_samples": total_session_samples,
                "decision_count": total_decision_count,
                "trade_count": total_trade_count,
                "order_count": total_order_count,
                "post_cost_promotion_sample_count": total_post_cost_promotion_sample_count,
                "post_cost_basis_counts": total_post_cost_basis_counts,
                "post_cost_expectancy_aggregation": post_cost_expectancy_aggregation,
                "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
                "runtime_ledger_filled_notional": str(runtime_ledger_filled_notional),
                "runtime_ledger_net_strategy_pnl_after_costs": str(
                    runtime_ledger_net_strategy_pnl_after_costs
                ),
                **runtime_ledger_daily_summary,
                "promotion_allowed": promotion_allowed,
                "promotion_blocking_reasons": promotion_blocking_reasons,
                "evidence_blocking_reasons": evidence_blocking_reasons,
                "delay_adjusted_depth_stress": delay_depth_stress_summary,
                "runtime_observation": runtime_payload,
            },
        )
    )
    promotion_decision_row = StrategyPromotionDecision(
        run_id=run_id,
        candidate_id=candidate_id,
        hypothesis_id=hypothesis_id,
        promotion_target=observed_stage,
        state=final_capital_stage,
        allowed=promotion_allowed,
        reason_summary=reason_summary,
        payload_json={
            "imported": True,
            "observed_stage": observed_stage,
            "raw_window_count": raw_window_count,
            "window_count": inserted,
            "skipped_zero_activity_window_count": skipped_zero_activity_window_count,
            "market_session_samples": total_session_samples,
            "decision_count": total_decision_count,
            "trade_count": total_trade_count,
            "order_count": total_order_count,
            "post_cost_promotion_sample_count": total_post_cost_promotion_sample_count,
            "post_cost_basis_counts": total_post_cost_basis_counts,
            "avg_abs_slippage_bps": str(average_slippage),
            "avg_post_cost_expectancy_bps": str(average_post_cost),
            "post_cost_expectancy_aggregation": post_cost_expectancy_aggregation,
            "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
            "runtime_ledger_filled_notional": str(runtime_ledger_filled_notional),
            "runtime_ledger_net_strategy_pnl_after_costs": str(
                runtime_ledger_net_strategy_pnl_after_costs
            ),
            **runtime_ledger_daily_summary,
            "latest_three_within_budget": latest_three_budget_ok,
            "promotion_allowed": promotion_allowed,
            "promotion_blocking_reasons": promotion_blocking_reasons,
            "evidence_blocking_reasons": evidence_blocking_reasons,
            "delay_adjusted_depth_stress": delay_depth_stress_summary,
            "runtime_observation": runtime_payload,
        },
    )
    session.add(promotion_decision_row)
    session.flush()
    evidence_grade_runtime_ledger_rows = [
        row
        for row in runtime_ledger_rows
        if _persisted_runtime_ledger_bucket_evidence_grade(row)
    ]
    materialization_counts = {
        "metric_window_count": len(metric_window_rows),
        "promotion_decision_count": 1,
        "runtime_ledger_bucket_count": len(runtime_ledger_rows),
        "evidence_grade_runtime_ledger_bucket_count": len(
            evidence_grade_runtime_ledger_rows
        ),
        "replaced_runtime_ledger_bucket_count": replaced_runtime_ledger_bucket_count,
        "runtime_ledger_fill_count": sum(
            max(0, int(row.fill_count or 0)) for row in runtime_ledger_rows
        ),
        "runtime_ledger_submitted_order_count": sum(
            max(0, int(row.submitted_order_count or 0)) for row in runtime_ledger_rows
        ),
        "runtime_ledger_closed_trade_count": sum(
            max(0, int(row.closed_trade_count or 0)) for row in runtime_ledger_rows
        ),
        "runtime_ledger_open_position_count": sum(
            max(0, int(row.open_position_count or 0)) for row in runtime_ledger_rows
        ),
    }
    materialization_blockers: list[str] = []
    if not metric_window_rows:
        materialization_blockers.append("runtime_window_import_metric_window_missing")
    if runtime_payload.get("runtime_ledger_profit_proof_present") is True:
        if not runtime_ledger_rows:
            materialization_blockers.append(
                "runtime_window_import_runtime_ledger_bucket_missing"
            )
        if not evidence_grade_runtime_ledger_rows:
            materialization_blockers.append(
                "runtime_window_import_evidence_grade_runtime_ledger_bucket_missing"
            )
    for blocker in materialization_blockers:
        if blocker not in {str(item.get("blocker")) for item in proof_blockers}:
            proof_blockers.append(
                {
                    "blocker": blocker,
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "observed_stage": observed_stage,
                    "window_start": import_window_start.isoformat(),
                    "window_end": import_window_end.isoformat(),
                    "promotion_authority": _text(
                        runtime_payload.get("promotion_authority")
                    )
                    or "unknown",
                    "authority_reason": _text(runtime_payload.get("authority_reason")),
                    "runtime_ledger_profit_proof_present": bool(
                        runtime_payload.get("runtime_ledger_profit_proof_present")
                    ),
                    "remediation": (
                        "Persist the scoped metric window, promotion decision, and "
                        "evidence-grade runtime-ledger bucket before treating this "
                        "runtime-window import target as proof."
                    ),
                }
            )
    proof_status = "blocked" if proof_blockers else "ok"
    runtime_materialization_target.update(
        {
            "proof_status": proof_status,
            "proof_blockers": proof_blockers,
            "materialized": not proof_blockers,
            "materialization_blockers": materialization_blockers,
            **materialization_counts,
            "metric_window_ids": [str(row.id) for row in metric_window_rows],
            "promotion_decision_id": str(promotion_decision_row.id),
            "runtime_ledger_bucket_ids": [str(row.id) for row in runtime_ledger_rows],
            "evidence_grade_runtime_ledger_bucket_ids": [
                str(row.id) for row in evidence_grade_runtime_ledger_rows
            ],
            "replaced_runtime_ledger_bucket_count": (
                replaced_runtime_ledger_bucket_count
            ),
        }
    )
    return {
        "run_id": run_id,
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "raw_window_count": raw_window_count,
        "window_count": inserted,
        "skipped_zero_activity_window_count": skipped_zero_activity_window_count,
        "market_session_samples": total_session_samples,
        "decision_count": total_decision_count,
        "trade_count": total_trade_count,
        "order_count": total_order_count,
        "post_cost_promotion_sample_count": total_post_cost_promotion_sample_count,
        "post_cost_basis_counts": total_post_cost_basis_counts,
        "avg_abs_slippage_bps": str(average_slippage),
        "avg_post_cost_expectancy_bps": str(average_post_cost),
        "post_cost_expectancy_aggregation": post_cost_expectancy_aggregation,
        "runtime_ledger_notional_weighted_sample_count": runtime_ledger_sample_count,
        "runtime_ledger_filled_notional": str(runtime_ledger_filled_notional),
        "runtime_ledger_net_strategy_pnl_after_costs": str(
            runtime_ledger_net_strategy_pnl_after_costs
        ),
        **runtime_ledger_daily_summary,
        "latest_three_within_budget": latest_three_budget_ok,
        "slippage_budget_bps": str(budget),
        "promotion_allowed": promotion_allowed,
        "promotion_blocking_reasons": promotion_blocking_reasons,
        "evidence_blocking_reasons": evidence_blocking_reasons,
        "proof_status": proof_status,
        "proof_blockers": proof_blockers,
        "replaced_runtime_ledger_bucket_count": replaced_runtime_ledger_bucket_count,
        "runtime_materialization_target": runtime_materialization_target,
        "runtime_observation": runtime_payload,
        "delay_adjusted_depth_stress": delay_depth_stress_summary,
    }


__all__ = [
    "ObservedRuntimeBucket",
    "build_observed_runtime_buckets",
    "build_regular_session_buckets",
    "persist_observed_runtime_windows",
    "resolve_hypothesis_manifest",
]
