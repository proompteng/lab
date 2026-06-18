"""Read-only H-PAIRS runtime authority proof verifier.

This module deliberately only reads durable runtime-ledger buckets and turns them
into a stable JSON-compatible proof report. It does not write promotion
state, upload proof packets, or mutate cluster/database state.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import cast


from app.trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from app.trading.runtime_ledger import (
    POST_COST_PNL_BASIS,
)
from app.trading.runtime_ledger_proof_policy import (
    RuntimeLedgerProofPolicy,
)
from app.trading.runtime_ledger_source_authority import (
    EXECUTION_ECONOMICS_MISSING_BLOCKER,
    ORDER_FEED_LIFECYCLE_MISSING_BLOCKER as ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
)


from .shared_context import (
    AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER,
    AUTHORITY_BUCKET_BLOCKERS_PRESENT,
    AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
    AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER,
    AUTHORITY_COST_MODEL_HASH_BLOCKER,
    AUTHORITY_EVIDENCE_MISSING_BLOCKER,
    AUTHORITY_EXPLICIT_COSTS_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_BLOCKER,
    AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER,
    AUTHORITY_LEDGER_SCHEMA_BLOCKER,
    AUTHORITY_LINEAGE_HASH_BLOCKER,
    AUTHORITY_MEAN_PNL_BLOCKER,
    AUTHORITY_MEDIAN_PNL_BLOCKER,
    AUTHORITY_OPEN_POSITIONS_BLOCKER,
    AUTHORITY_ORDER_LIFECYCLE_MISSING_BLOCKER,
    AUTHORITY_P10_PNL_BLOCKER,
    AUTHORITY_PNL_BASIS_BLOCKER,
    AUTHORITY_POLICY_HASH_BLOCKER,
    AUTHORITY_READ_ERROR_BLOCKER,
    AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
    AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
    AUTHORITY_TRADING_DAYS_BLOCKER,
    AUTHORITY_WORST_DAY_BLOCKER,
    DEFAULT_HPAIRS_ACCOUNT_LABEL as DEFAULT_HPAIRS_ACCOUNT_LABEL,
    DEFAULT_HPAIRS_CANDIDATE_ID as DEFAULT_HPAIRS_CANDIDATE_ID,
    DEFAULT_HPAIRS_HYPOTHESIS_ID as DEFAULT_HPAIRS_HYPOTHESIS_ID,
    DEFAULT_HPAIRS_RUNTIME_STRATEGY as DEFAULT_HPAIRS_RUNTIME_STRATEGY,
    HPAIRS_RUNTIME_AUTHORITY_PROOF_SCHEMA_VERSION as HPAIRS_RUNTIME_AUTHORITY_PROOF_SCHEMA_VERSION,
    RuntimeAuthorityEvidenceRow,
    DailyAccumulator as _DailyAccumulator,
    PROMOTION_GRADE_LEDGER_SCHEMAS as _PROMOTION_GRADE_LEDGER_SCHEMAS,
    build_runtime_authority_report as build_runtime_authority_report,
    load_runtime_authority_rows as load_runtime_authority_rows,
    runtime_authority_report_json as runtime_authority_report_json,
)


def _row_authority_blockers(
    row: RuntimeAuthorityEvidenceRow,
    payload: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = list(row.blockers)
    if row.blockers:
        blockers.append(AUTHORITY_BUCKET_BLOCKERS_PRESENT)
    if row.ledger_schema_version not in _PROMOTION_GRADE_LEDGER_SCHEMAS:
        blockers.append(AUTHORITY_LEDGER_SCHEMA_BLOCKER)
    if row.pnl_basis != POST_COST_PNL_BASIS:
        blockers.append(AUTHORITY_PNL_BASIS_BLOCKER)
    if row.fill_count <= 0:
        blockers.append(AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER)
    if row.decision_count <= 0:
        blockers.append(AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER)
    if row.submitted_order_count <= 0:
        blockers.append(AUTHORITY_ORDER_LIFECYCLE_MISSING_BLOCKER)
    if row.closed_trade_count <= 0:
        blockers.append(AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER)
    if row.open_position_count > 0:
        blockers.append(AUTHORITY_OPEN_POSITIONS_BLOCKER)
    if row.filled_notional <= 0:
        blockers.append(AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER)
    if not _explicit_costs_present(row, payload):
        blockers.append(AUTHORITY_EXPLICIT_COSTS_BLOCKER)
    if not _positive_hash_count(row.execution_policy_hash_counts):
        blockers.append(AUTHORITY_POLICY_HASH_BLOCKER)
    if not _positive_hash_count(row.cost_model_hash_counts):
        blockers.append(AUTHORITY_COST_MODEL_HASH_BLOCKER)
    if not _positive_hash_count(row.lineage_hash_counts):
        blockers.append(AUTHORITY_LINEAGE_HASH_BLOCKER)
    return list(dict.fromkeys(blockers))


def _promotion_payload(row: RuntimeAuthorityEvidenceRow) -> dict[str, object]:
    payload = dict(row.payload)
    payload.update(
        {
            "run_id": row.run_id,
            "candidate_id": row.candidate_id,
            "hypothesis_id": row.hypothesis_id,
            "observed_stage": row.observed_stage,
            "account_label": row.account_label,
            "runtime_strategy_name": row.runtime_strategy_name,
            "strategy_family": row.strategy_family,
            "fill_count": row.fill_count,
            "decision_count": row.decision_count,
            "submitted_order_count": row.submitted_order_count,
            "cancelled_order_count": row.cancelled_order_count,
            "rejected_order_count": row.rejected_order_count,
            "unfilled_order_count": row.unfilled_order_count,
            "closed_trade_count": row.closed_trade_count,
            "open_position_count": row.open_position_count,
            "filled_notional": row.filled_notional,
            "gross_strategy_pnl": row.gross_strategy_pnl,
            "cost_amount": row.cost_amount,
            "net_strategy_pnl_after_costs": row.net_strategy_pnl_after_costs,
            "post_cost_expectancy_bps": row.post_cost_expectancy_bps,
            "ledger_schema_version": row.ledger_schema_version,
            "pnl_basis": row.pnl_basis,
            "execution_policy_hash_counts": row.execution_policy_hash_counts,
            "cost_model_hash_counts": row.cost_model_hash_counts,
            "lineage_hash_counts": row.lineage_hash_counts,
        }
    )
    return payload


def _explicit_costs_present(
    row: RuntimeAuthorityEvidenceRow, payload: Mapping[str, object]
) -> bool:
    if is_non_promotion_grade_runtime_cost_basis(payload.get("cost_basis")):
        return False
    if cost_basis_counts_have_non_promotion_grade_costs(
        payload.get("cost_basis_counts")
    ):
        return False
    cost_basis_counts = _as_mapping(payload.get("cost_basis_counts"))
    return bool(cost_basis_counts) and _positive_hash_count(row.cost_model_hash_counts)


def _daily_payload(item: _DailyAccumulator) -> dict[str, object]:
    return {
        "trading_day": item.trading_day,
        "net_strategy_pnl_after_costs": _decimal_text(
            item.net_strategy_pnl_after_costs
        ),
        "filled_notional": _decimal_text(item.filled_notional),
        "closed_trade_count": item.closed_trade_count,
        "open_position_count": item.open_position_count,
        "fill_count": item.fill_count,
        "decision_count": item.decision_count,
        "submitted_order_count": item.submitted_order_count,
        "bucket_count": item.bucket_count,
        "explicit_cost_bucket_count": item.explicit_cost_bucket_count,
        "source_window_count": item.source_window_count,
        "source_window_id_count": item.source_window_id_count,
        "source_ref_count": item.source_ref_count,
        "source_offset_count": item.source_offset_count,
        "trade_decision_ref_count": item.trade_decision_ref_count,
        "execution_ref_count": item.execution_ref_count,
        "execution_order_event_ref_count": item.execution_order_event_ref_count,
        "source_materialization_count": item.source_materialization_count,
        "authority_class_count": item.authority_class_count,
        "source_authority_bucket_count": item.source_authority_bucket_count,
        "clean_authority_bucket_count": item.clean_authority_bucket_count,
        "clean_authority_net_strategy_pnl_after_costs": _decimal_text(
            item.clean_authority_net_strategy_pnl_after_costs
        ),
        "clean_authority_filled_notional": _decimal_text(
            item.clean_authority_filled_notional
        ),
        "clean_authority_closed_trade_count": item.clean_authority_closed_trade_count,
        "row_refs": sorted(item.row_refs or []),
        "blockers": sorted(item.blockers or []),
    }


def _authority_targets(policy: RuntimeLedgerProofPolicy) -> dict[str, object]:
    return {
        "min_trading_days": policy.authority_min_trading_days,
        "min_mean_daily_net_pnl_after_costs": _decimal_text(
            policy.authority_min_mean_daily_net_pnl_after_costs
        ),
        "min_median_daily_net_pnl_after_costs": _decimal_text(
            policy.authority_min_median_daily_net_pnl_after_costs
        ),
        "min_p10_daily_net_pnl_after_costs": _decimal_text(
            policy.authority_min_p10_daily_net_pnl_after_costs
        ),
        "min_worst_day_net_pnl_after_costs": _decimal_text(
            policy.authority_min_worst_day_net_pnl_after_costs
        ),
        "max_best_day_share": _decimal_text(policy.authority_max_best_day_share),
        "min_filled_notional": _decimal_text(policy.authority_min_filled_notional),
        "min_closed_round_trips": policy.authority_min_closed_round_trips,
    }


def _authority_gaps(
    aggregate: Mapping[str, object],
    *,
    policy: RuntimeLedgerProofPolicy,
) -> dict[str, object]:
    target_total_net = policy.authority_min_mean_daily_net_pnl_after_costs * Decimal(
        policy.authority_min_trading_days
    )
    observed_total_net = _decimal(
        aggregate.get("clean_authority_total_net_strategy_pnl_after_costs")
    )
    return {
        "missing_trading_days": max(
            0,
            policy.authority_min_trading_days
            - _int(aggregate.get("clean_authority_trading_day_count")),
        ),
        "missing_clean_authority_buckets": max(
            0,
            policy.authority_min_trading_days
            - _int(aggregate.get("clean_authority_bucket_count")),
        ),
        "missing_net_pnl_after_costs_to_mean_floor": _decimal_text(
            max(Decimal("0"), target_total_net - observed_total_net)
        ),
        "missing_mean_daily_net_pnl_after_costs": _decimal_text(
            max(
                Decimal("0"),
                policy.authority_min_mean_daily_net_pnl_after_costs
                - _decimal(
                    aggregate.get("clean_authority_mean_daily_net_pnl_after_costs")
                ),
            )
        ),
        "missing_median_daily_net_pnl_after_costs": _decimal_text(
            max(
                Decimal("0"),
                policy.authority_min_median_daily_net_pnl_after_costs
                - _decimal(
                    aggregate.get("clean_authority_median_daily_net_pnl_after_costs")
                ),
            )
        ),
        "missing_p10_daily_net_pnl_after_costs": _decimal_text(
            max(
                Decimal("0"),
                policy.authority_min_p10_daily_net_pnl_after_costs
                - _decimal(
                    aggregate.get("clean_authority_p10_daily_net_pnl_after_costs")
                ),
            )
        ),
        "missing_worst_day_net_pnl_after_costs": _decimal_text(
            max(
                Decimal("0"),
                policy.authority_min_worst_day_net_pnl_after_costs
                - _decimal(
                    aggregate.get("clean_authority_worst_day_net_pnl_after_costs")
                ),
            )
        ),
        "missing_closed_round_trips": max(
            0,
            policy.authority_min_closed_round_trips
            - _int(aggregate.get("clean_authority_closed_round_trips")),
        ),
        "missing_filled_notional": _decimal_text(
            max(
                Decimal("0"),
                policy.authority_min_filled_notional
                - _decimal(aggregate.get("clean_authority_total_filled_notional")),
            )
        ),
        "target_implied_notional_gap": _decimal_text(
            _decimal(aggregate.get("target_implied_notional_gap"))
        ),
    }


def _blocker_counts(
    daily: Sequence[_DailyAccumulator],
    *,
    extra_blockers: Sequence[str],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in daily:
        for blocker in item.blockers or []:
            counts[blocker] = counts.get(blocker, 0) + 1
    for blocker in extra_blockers:
        counts.setdefault(blocker, 1)
    return {key: counts[key] for key in sorted(counts)}


def _next_actions(blockers: Sequence[str]) -> list[str]:
    actions: list[str] = []

    def add(action: str) -> None:
        if action not in actions:
            actions.append(action)

    for blocker in blockers:
        if blocker in {
            RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
            RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
            RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
            RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
            RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
            RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
            RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
            RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
        }:
            add("repair_order_feed_linkage")
        elif blocker == AUTHORITY_TRADING_DAYS_BLOCKER:
            add("wait_for_more_authority_days")
        elif blocker in {
            AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER,
            AUTHORITY_CLOSED_ROUND_TRIP_MISSING_BLOCKER,
        }:
            add("collect_closed_round_trips")
        elif blocker in {
            AUTHORITY_FILLED_NOTIONAL_BLOCKER,
            AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER,
        }:
            add("increase_filled_notional_after_source_linkage")
        elif (
            blocker == AUTHORITY_OPEN_POSITIONS_BLOCKER
            or "unclosed_position" in blocker
        ):
            add("flatten_open_positions")
        elif blocker == AUTHORITY_PNL_BASIS_BLOCKER or "pnl_basis" in blocker:
            add("repair_runtime_pnl_basis")
        elif blocker == AUTHORITY_READ_ERROR_BLOCKER:
            add("restore_runtime_ledger_database_read_access")
        elif blocker == AUTHORITY_EXPLICIT_COSTS_BLOCKER:
            add("repair_explicit_runtime_costs")
        elif blocker in {
            AUTHORITY_MEAN_PNL_BLOCKER,
            AUTHORITY_MEDIAN_PNL_BLOCKER,
            AUTHORITY_P10_PNL_BLOCKER,
        }:
            add("improve_clean_authority_daily_pnl")
        elif blocker == AUTHORITY_WORST_DAY_BLOCKER:
            add("reduce_authority_drawdown")
        elif blocker == AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER:
            add("reduce_best_day_concentration")
        elif blocker in {
            AUTHORITY_RUNTIME_FILLS_MISSING_BLOCKER,
            AUTHORITY_RUNTIME_DECISIONS_MISSING_BLOCKER,
        }:
            add("repair_runtime_decision_execution_linkage")
        elif blocker == AUTHORITY_ORDER_LIFECYCLE_MISSING_BLOCKER:
            add("repair_order_feed_linkage")
        elif blocker == AUTHORITY_LEDGER_SCHEMA_BLOCKER:
            add("regenerate_exact_replay_runtime_ledger_rows")
        elif blocker in {
            AUTHORITY_POLICY_HASH_BLOCKER,
            AUTHORITY_COST_MODEL_HASH_BLOCKER,
            AUTHORITY_LINEAGE_HASH_BLOCKER,
        }:
            add("repair_runtime_ledger_hash_lineage")
        elif blocker == EXECUTION_ECONOMICS_MISSING_BLOCKER:
            add("repair_execution_economics")
        elif blocker == AUTHORITY_EVIDENCE_MISSING_BLOCKER:
            add("collect_source_backed_runtime_ledger_rows")
        elif blocker == AUTHORITY_BUCKET_BLOCKERS_PRESENT:
            add("resolve_runtime_ledger_bucket_blockers")
        elif blocker == "runtime_ledger_expectancy_missing":
            add("repair_runtime_expectancy")
        elif blocker == "source_decision_mode_not_profit_proof_eligible":
            add("collect_profit_proof_eligible_source_decisions")
        elif blocker == "execution_reconstruction_not_runtime_ledger_proof":
            add("repair_order_feed_linkage")
    return actions


def _mean(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    return sum(values, Decimal("0")) / Decimal(len(values))


def _median(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    sorted_values = sorted(values)
    middle = len(sorted_values) // 2
    if len(sorted_values) % 2:
        return sorted_values[middle]
    return (sorted_values[middle - 1] + sorted_values[middle]) / Decimal("2")


def _p10(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    sorted_values = sorted(values)
    index = max(0, ((len(sorted_values) + 9) // 10) - 1)
    return sorted_values[index]


def _max_drawdown(values: Sequence[Decimal]) -> Decimal:
    cumulative = Decimal("0")
    peak = Decimal("0")
    max_drawdown = Decimal("0")
    for value in values:
        cumulative += value
        if cumulative > peak:
            peak = cumulative
        drawdown = peak - cumulative
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    return max_drawdown


def _ref_count(bucket: Mapping[str, object], *keys: str) -> int:
    refs: set[str] = set()
    for key in keys:
        value = bucket.get(key)
        if isinstance(value, Mapping):
            for ref_key, ref_value in cast(Mapping[object, object], value).items():
                if ref_value is None or ref_value is False:
                    continue
                ref_text = _text(ref_value)
                if ref_value is True or ref_text is None:
                    ref_text = _text(ref_key)
                if ref_text is not None:
                    refs.add(ref_text)
        elif isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            for item in cast(Sequence[object], value):
                if (text := _text(item)) is not None:
                    refs.add(text)
        elif (text := _text(value)) is not None:
            refs.add(text)
    return len(refs)


def _source_offset_count(bucket: Mapping[str, object]) -> int:
    offsets = bucket.get("source_offsets")
    if isinstance(offsets, Mapping):
        return int(
            _source_offset_triplet_present(cast(Mapping[object, object], offsets))
        )
    if isinstance(offsets, Sequence) and not isinstance(
        offsets, (str, bytes, bytearray)
    ):
        seen: set[tuple[str, str, str]] = set()
        for item in cast(Sequence[object], offsets):
            if not isinstance(item, Mapping):
                continue
            typed_item = cast(Mapping[object, object], item)
            if _source_offset_triplet_present(typed_item):
                seen.add(
                    (
                        str(typed_item.get("topic")),
                        str(typed_item.get("partition")),
                        str(typed_item.get("offset")),
                    )
                )
        return len(seen)
    return int(
        _text(bucket.get("source_topic")) is not None
        and bucket.get("source_partition") is not None
        and bucket.get("source_offset") is not None
    )


def _source_offset_triplet_present(value: Mapping[object, object]) -> bool:
    return (
        _text(value.get("topic")) is not None
        and value.get("partition") is not None
        and value.get("offset") is not None
    )


def _positive_hash_count(value: Mapping[str, object]) -> bool:
    for item in value.values():
        if _decimal(item) > 0:
            return True
    return False


def _as_mapping(value: object) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): item for key, item in cast(Mapping[object, object], value).items()
    }


def _as_sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    if value is None:
        return ()
    return (value,)


def _string_tuple(values: Sequence[object]) -> tuple[str, ...]:
    normalized: list[str] = []
    for value in values:
        text = _text(value)
        if text is not None and text not in normalized:
            normalized.append(text)
    return tuple(normalized)


def _text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int(value: object) -> int:
    try:
        return int(str(value or "0"))
    except (TypeError, ValueError):
        return 0


def _decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")
    return parsed if parsed.is_finite() else Decimal("0")


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _required_datetime(value: object, *, field_name: str) -> datetime:
    parsed = _parse_datetime(value)
    if parsed is None:
        raise ValueError(f"{field_name}_invalid")
    return parsed


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _isoformat(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _decimal_text(value: Decimal | None) -> str:
    if value is None:
        return "0"
    text = format(value.normalize(), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


row_authority_blockers = _row_authority_blockers
promotion_payload = _promotion_payload
explicit_costs_present = _explicit_costs_present
daily_payload = _daily_payload
authority_targets = _authority_targets
authority_gaps = _authority_gaps
blocker_counts = _blocker_counts
next_actions = _next_actions
mean = _mean
median = _median
p10 = _p10
max_drawdown = _max_drawdown
ref_count = _ref_count
source_offset_count = _source_offset_count
as_mapping = _as_mapping
as_sequence = _as_sequence
string_tuple = _string_tuple
text_value = _text
int_value = _int
decimal_value = _decimal
optional_decimal = _optional_decimal
required_datetime = _required_datetime
utc = _utc
isoformat = _isoformat
decimal_text = _decimal_text


__all__ = [
    "AUTHORITY_BEST_DAY_CONCENTRATION_BLOCKER",
    "AUTHORITY_CLOSED_ROUND_TRIPS_BLOCKER",
    "AUTHORITY_EVIDENCE_MISSING_BLOCKER",
    "AUTHORITY_EXPLICIT_COSTS_BLOCKER",
    "AUTHORITY_FILLED_NOTIONAL_BLOCKER",
    "AUTHORITY_FILLED_NOTIONAL_MISSING_BLOCKER",
    "AUTHORITY_MEAN_PNL_BLOCKER",
    "AUTHORITY_MEDIAN_PNL_BLOCKER",
    "AUTHORITY_OPEN_POSITIONS_BLOCKER",
    "AUTHORITY_P10_PNL_BLOCKER",
    "AUTHORITY_READ_ERROR_BLOCKER",
    "AUTHORITY_TRADING_DAYS_BLOCKER",
    "AUTHORITY_WORST_DAY_BLOCKER",
    "DEFAULT_HPAIRS_ACCOUNT_LABEL",
    "DEFAULT_HPAIRS_CANDIDATE_ID",
    "DEFAULT_HPAIRS_HYPOTHESIS_ID",
    "DEFAULT_HPAIRS_RUNTIME_STRATEGY",
    "EXECUTION_ECONOMICS_MISSING_BLOCKER",
    "HPAIRS_RUNTIME_AUTHORITY_PROOF_SCHEMA_VERSION",
    "ORDER_FEED_LIFECYCLE_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER",
    "RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER",
    "RuntimeAuthorityEvidenceRow",
    "build_runtime_authority_report",
    "load_runtime_authority_rows",
    "runtime_authority_report_json",
]


__all__ = (
    "row_authority_blockers",
    "promotion_payload",
    "explicit_costs_present",
    "daily_payload",
    "authority_targets",
    "authority_gaps",
    "blocker_counts",
    "next_actions",
    "mean",
    "median",
    "p10",
    "max_drawdown",
    "ref_count",
    "source_offset_count",
    "as_mapping",
    "as_sequence",
    "string_tuple",
    "text_value",
    "int_value",
    "decimal_value",
    "optional_decimal",
    "required_datetime",
    "utc",
    "isoformat",
    "decimal_text",
)
