"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast


from ...models import (
    StrategyRuntimeLedgerBucket,
)
from ..hypotheses import (
    HypothesisManifest,
)
from ..runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS
from ..runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from ..runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
    SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER,
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
)
from ..runtime_ledger_proof_policy import runtime_ledger_proof_policy_from_env
from ..runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers as _base_runtime_ledger_promotion_source_authority_blockers,
)


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

RUNTIME_WINDOW_IMPORT_CAPITAL_ONLY_BLOCKERS = frozenset(
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

RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER = (
    "runtime_ledger_authority_class_missing"
)

EXECUTION_TCA_MISSING_BLOCKER = "execution_tca_missing"

RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER = (
    "runtime_ledger_execution_tca_refs_missing"
)

_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
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
class NormalizedTcaRow:
    computed_at: datetime
    bucketed_at: datetime
    abs_slippage_bps: Decimal | None
    post_cost_expectancy_bps: Decimal | None
    post_cost_expectancy_basis: str
    post_cost_promotion_eligible: bool
    runtime_ledger_bucket: dict[str, Any]
    source_decision_mode: str | None = None


def utc_datetime(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def optional_decimal(value: Any) -> Decimal | None:
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


def decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." not in text:
        return text
    return text.rstrip("0").rstrip(".") or "0"


def strategy_family_matches(
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


def text_value(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _promotion_grade_runtime_ledger_authority_marker_present(
    bucket: Mapping[str, Any],
    key: str,
) -> bool:
    marker = text_value(bucket.get(key))
    return (
        marker is not None
        and marker in _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS
    )


def runtime_ledger_promotion_source_authority_blockers(
    bucket: Mapping[str, Any],
) -> list[str]:
    blockers = _base_runtime_ledger_promotion_source_authority_blockers(bucket)
    if not (
        _promotion_grade_runtime_ledger_authority_marker_present(
            bucket, "authority_class"
        )
        and _promotion_grade_runtime_ledger_authority_marker_present(
            bucket, "authority_reason"
        )
    ):
        blockers.append(RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER)
    return list(dict.fromkeys(blockers))


def post_cost_expectancy_basis(value: Any) -> str:
    text = text_value(value)
    if text is None:
        return "post_cost_basis_missing"
    return text.lower().replace("-", "_")


def post_cost_basis_is_promotion_grade(
    *,
    basis: str,
    explicit_value: Any,
) -> bool:
    parsed = observation_bool(explicit_value)
    basis_is_promotion_grade = basis in PROMOTION_GRADE_POST_COST_BASES
    if parsed is False:
        return False
    if parsed is True:
        return basis_is_promotion_grade
    return basis_is_promotion_grade


def parse_observation_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return utc_datetime(value)
    text = text_value(value)
    if text is None:
        return None
    try:
        return utc_datetime(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def observation_bool(value: Any) -> bool | None:
    result: bool | None = None
    if value is None:
        return result
    if isinstance(value, bool):
        result = value
    elif isinstance(value, (int, float, Decimal)):
        result = bool(value)
    elif (text := text_value(value)) is not None:
        normalized = text.lower()
        truthy = {"1", "true", "yes", "on", "pass", "passed", "ok", "ready"}
        falsy = {"0", "false", "no", "off", "fail", "failed", "blocked"}
        if normalized in truthy:
            result = True
        elif normalized in falsy:
            result = False
    return result


def observation_int(value: Any) -> int:
    try:
        return max(0, int(Decimal(str(value))))
    except Exception:
        return 0


def observation_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except Exception:
        return Decimal("0")


def string_list(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        text
        for item in cast(Sequence[object], value)
        if (text := text_value(item)) is not None
    ]


_EXECUTION_TCA_REF_KEYS = (
    "execution_tca_metric_ids",
    "execution_tca_metric_refs",
    "execution_tca_metric_id",
    "execution_tca_metric_ref",
    "execution_tca_metrics",
    "execution_tca_ids",
    "execution_tca_refs",
    "execution_tca_id",
    "execution_tca_ref",
    "runtime_ledger_execution_tca_metric_ids",
    "runtime_ledger_execution_tca_metric_refs",
    "runtime_ledger_execution_tca_metric_id",
    "runtime_ledger_execution_tca_metric_ref",
    "runtime_ledger_execution_tca_ids",
    "runtime_ledger_execution_tca_refs",
    "runtime_ledger_execution_tca_id",
    "runtime_ledger_execution_tca_ref",
    "tca_metric_ids",
    "tca_metric_refs",
    "tca_metric_id",
    "tca_metric_ref",
    "tca_ids",
    "tca_refs",
    "tca_id",
    "tca_ref",
)


def _runtime_ledger_tca_ref_texts(value: Any) -> list[str]:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        for key in _EXECUTION_TCA_REF_KEYS + ("id", "ref"):
            if (text := text_value(mapping.get(key))) is not None:
                return [text]
        return []
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        values: list[str] = []
        for item in cast(Sequence[object], value):
            if isinstance(item, Mapping):
                values.extend(_runtime_ledger_tca_ref_texts(item))
                continue
            if (text := text_value(item)) is not None:
                values.append(text)
        return values
    text = text_value(value)
    return [text] if text is not None else []


def _runtime_ledger_execution_tca_metric_refs(bucket: Mapping[str, Any]) -> list[str]:
    refs: list[str] = []
    for key in _EXECUTION_TCA_REF_KEYS:
        refs.extend(_runtime_ledger_tca_ref_texts(bucket.get(key)))
    return list(dict.fromkeys(refs))


def mapping_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _hash_count(value: Any) -> int:
    if not isinstance(value, Mapping):
        return 0
    mapping = cast(Mapping[object, object], value)
    return sum(1 for key in mapping.keys() if str(key).strip())


def _positive_count_mapping_present(value: Any) -> bool:
    if not isinstance(value, Mapping):
        return False
    for item in cast(Mapping[object, object], value).values():
        try:
            parsed = Decimal(str(item))
        except Exception:
            continue
        if parsed.is_finite() and parsed > 0:
            return True
    return False


def _runtime_ledger_explicit_costs_present(bucket: Mapping[str, Any]) -> bool:
    """Require explicit cost amount and cost basis for promotion-grade proof."""

    cost_amount = optional_decimal(
        bucket.get("cost_amount")
        if bucket.get("cost_amount") is not None
        else bucket.get("runtime_ledger_cost_amount")
    )
    if cost_amount is None or cost_amount < 0:
        return False
    if is_non_promotion_grade_runtime_cost_basis(bucket.get("cost_basis")):
        return False
    if cost_basis_counts_have_non_promotion_grade_costs(
        bucket.get("cost_basis_counts")
    ) or cost_basis_counts_have_non_promotion_grade_costs(
        bucket.get("post_cost_basis_counts")
    ):
        return False
    if _positive_count_mapping_present(bucket.get("cost_basis_counts")):
        return True
    if _positive_count_mapping_present(bucket.get("post_cost_basis_counts")):
        return True
    return (
        text_value(
            bucket.get("cost_basis")
            or bucket.get("cost_source")
            or bucket.get("fee_basis")
            or bucket.get("commission_basis")
            or bucket.get("broker_fee_basis")
        )
        is not None
    )


def persisted_runtime_ledger_bucket_evidence_grade(
    row: StrategyRuntimeLedgerBucket,
) -> bool:
    blockers = string_list(row.blockers_json)
    payload_json = mapping_payload(row.payload_json)
    cost_payload = {
        **payload_json,
        "cost_amount": (
            payload_json.get("cost_amount")
            if payload_json.get("cost_amount") is not None
            else row.cost_amount
        ),
    }
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
        and _runtime_ledger_explicit_costs_present(cost_payload)
        and not cost_basis_counts_have_non_promotion_grade_costs(
            payload_json.get("cost_basis_counts")
        )
        and not runtime_ledger_promotion_source_authority_blockers(payload_json)
        and not blockers
    )


def _runtime_ledger_schema_blockers(bucket: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    ledger_schema_version = text_value(bucket.get("ledger_schema_version"))
    pnl_basis = text_value(bucket.get("pnl_basis"))
    if ledger_schema_version is None:
        blockers.append("runtime_ledger_schema_version_missing")
    elif ledger_schema_version not in RUNTIME_LEDGER_BUCKET_SCHEMAS:
        blockers.append("runtime_ledger_schema_version_invalid")
    if pnl_basis is None:
        blockers.append("runtime_ledger_pnl_basis_missing")
    elif pnl_basis != POST_COST_PNL_BASIS:
        blockers.append("runtime_ledger_pnl_basis_invalid")
    return blockers


def _runtime_ledger_execution_tca_blockers(bucket: Mapping[str, Any]) -> list[str]:
    source_row_counts = mapping_payload(bucket.get("source_row_counts"))
    execution_count = observation_int(source_row_counts.get("executions"))
    tca_count = observation_int(source_row_counts.get("execution_tca_metrics"))
    execution_tca_ref_count = len(_runtime_ledger_execution_tca_metric_refs(bucket))
    execution_tca_required = (
        observation_bool(
            bucket.get("execution_tca_required") or bucket.get("requires_execution_tca")
        )
        is True
        or tca_count > 0
    )
    if not (
        execution_tca_required
        and execution_count > 0
        and (tca_count < execution_count or execution_tca_ref_count < execution_count)
    ):
        return []
    return [
        EXECUTION_TCA_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER,
    ]


def _runtime_ledger_activity_blockers(bucket: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if observation_int(bucket.get("fill_count")) <= 0:
        blockers.append("runtime_fills_missing")
    if observation_int(bucket.get("decision_count")) <= 0:
        blockers.append("runtime_decision_lifecycle_missing")
    if observation_int(bucket.get("submitted_order_count")) <= 0:
        blockers.append("submitted_order_lifecycle_missing")
    if observation_int(bucket.get("closed_trade_count")) <= 0:
        blockers.append("closed_round_trip_missing")
    if bucket.get("open_position_count") is None:
        blockers.append("runtime_ledger_open_position_count_missing")
    elif observation_int(bucket.get("open_position_count")) > 0:
        blockers.append("unclosed_position")
    if (optional_decimal(bucket.get("filled_notional")) or Decimal("0")) <= 0:
        blockers.append("filled_notional_missing")
    return blockers


def _runtime_ledger_cost_blockers(bucket: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not _runtime_ledger_explicit_costs_present(bucket):
        blockers.append("runtime_ledger_explicit_costs_missing")
    cost_amount = optional_decimal(bucket.get("cost_amount"))
    if cost_amount is None or cost_amount < 0:
        blockers.append("explicit_cost_missing")
    non_promotion_grade_cost_basis = is_non_promotion_grade_runtime_cost_basis(
        bucket.get("cost_basis")
    ) or cost_basis_counts_have_non_promotion_grade_costs(
        bucket.get("cost_basis_counts")
    )
    if non_promotion_grade_cost_basis:
        blockers.append("runtime_ledger_cost_basis_non_promotion_grade")
    return blockers


def _runtime_ledger_source_decision_blockers(bucket: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    source_decision_mode = normalize_source_decision_mode(
        bucket.get("source_decision_mode")
    )
    profit_proof_eligible = observation_bool(bucket.get("profit_proof_eligible"))
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
    return blockers


def _runtime_ledger_expectancy_blockers(bucket: Mapping[str, Any]) -> list[str]:
    post_cost_expectancy = optional_decimal(bucket.get("post_cost_expectancy_bps"))
    diagnostic_closed_trade_expectancy = optional_decimal(
        bucket.get("diagnostic_closed_trade_expectancy_bps")
    )
    if post_cost_expectancy is None:
        return [
            "runtime_ledger_expectancy_not_promotion_grade"
            if diagnostic_closed_trade_expectancy is not None
            else "runtime_ledger_expectancy_missing"
        ]
    return []


def _runtime_ledger_hash_blockers(bucket: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if _hash_count(bucket.get("execution_policy_hash_counts")) <= 0:
        blockers.append("runtime_ledger_execution_policy_hash_missing")
    if _hash_count(bucket.get("cost_model_hash_counts")) <= 0:
        blockers.append("runtime_ledger_cost_model_hash_missing")
    if _hash_count(bucket.get("lineage_hash_counts")) <= 0:
        blockers.append("runtime_ledger_lineage_hash_missing")
    return blockers


def runtime_ledger_bucket_blockers(bucket: Mapping[str, Any]) -> list[str]:
    blockers = string_list(bucket.get("blockers"))
    blockers.extend(_runtime_ledger_schema_blockers(bucket))
    blockers.extend(runtime_ledger_promotion_source_authority_blockers(bucket))
    blockers.extend(_runtime_ledger_execution_tca_blockers(bucket))
    blockers.extend(_runtime_ledger_activity_blockers(bucket))
    blockers.extend(_runtime_ledger_cost_blockers(bucket))
    blockers.extend(_runtime_ledger_source_decision_blockers(bucket))
    blockers.extend(_runtime_ledger_expectancy_blockers(bucket))
    blockers.extend(_runtime_ledger_hash_blockers(bucket))
    return list(dict.fromkeys(blockers))


def runtime_ledger_bucket_payload(value: Any) -> dict[str, Any]:
    bucket = mapping_payload(value)
    if not bucket:
        return {}
    return {**bucket, "blockers": runtime_ledger_bucket_blockers(bucket)}


def runtime_ledger_row_is_promotion_grade(row: NormalizedTcaRow) -> bool:
    return (
        row.post_cost_expectancy_bps is not None
        and row.post_cost_promotion_eligible
        and (
            row.source_decision_mode is None
            or source_decision_mode_is_profit_proof_eligible(row.source_decision_mode)
        )
        and row.post_cost_expectancy_basis == POST_COST_PNL_BASIS
        and bool(row.runtime_ledger_bucket)
        and not runtime_ledger_bucket_blockers(row.runtime_ledger_bucket)
    )


def runtime_ledger_post_cost_from_rows(
    rows: Sequence[NormalizedTcaRow],
) -> tuple[Decimal | None, Decimal, Decimal, int]:
    total_net = Decimal("0")
    total_notional = Decimal("0")
    sample_count = 0
    for row in rows:
        if not runtime_ledger_row_is_promotion_grade(row):
            continue
        net_pnl = optional_decimal(
            row.runtime_ledger_bucket.get("net_strategy_pnl_after_costs")
        )
        filled_notional = optional_decimal(
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


def paper_probation_blocking_reasons(runtime_payload: Mapping[str, Any]) -> list[str]:
    target_metadata = mapping_payload(runtime_payload.get("target_metadata"))
    runtime_ledger_import_satisfied = (
        runtime_payload.get("runtime_ledger_profit_proof_present") is True
    )

    def target_blockers(value: Any) -> list[str]:
        blockers = string_list(value)
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

    paper_probation_authorized = observation_bool(
        target_metadata.get("paper_probation_authorized")
    )
    evidence_collection_stage = text_value(
        target_metadata.get("evidence_collection_stage")
    )
    if paper_probation_authorized is True and evidence_collection_stage == "paper":
        reasons.append("paper_probation_evidence_collection_only")
    if observation_bool(target_metadata.get("promotion_allowed")) is False:
        reasons.append("candidate_board_promotion_not_allowed")
    if observation_bool(target_metadata.get("final_promotion_authorized")) is False:
        reasons.append("final_promotion_not_authorized")
    if observation_bool(target_metadata.get("final_promotion_allowed")) is False:
        reasons.append("final_promotion_not_allowed")
    return list(dict.fromkeys(reasons))
