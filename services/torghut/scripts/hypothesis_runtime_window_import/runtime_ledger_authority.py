from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Mapping, Sequence, cast

from app.trading.runtime_cost_authority import (
    cost_basis_counts_have_non_promotion_grade_costs,
    is_non_promotion_grade_runtime_cost_basis,
)
from app.trading.runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
    SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER,
    normalize_source_decision_mode,
    source_decision_mode_counts_have_non_profit_proof_modes,
    source_decision_mode_counts_have_profit_proof_modes,
    source_decision_mode_is_profit_proof_eligible,
)
from app.trading.runtime_ledger import RuntimeLedgerBucket
from app.trading.runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers as _base_runtime_ledger_promotion_source_authority_blockers,
)
from scripts.hypothesis_runtime_window_import.common import (
    _as_mapping,
    _decimal_or_none,
    _first_bool,
    _metadata_text_list,
    _merge_count_mappings,
    _nonnegative_int,
    _runtime_ledger_execution_tca_metric_refs,
    _text_or_none,
)
from scripts.hypothesis_runtime_window_import.constants import (
    EXECUTION_ECONOMICS_MISSING_BLOCKER,
    EXECUTION_TCA_MISSING_BLOCKER,
    ORDER_FEED_LIFECYCLE_MISSING_BLOCKER,
    POST_COST_BASIS_RUNTIME_LEDGER,
    RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
    RUNTIME_LEDGER_BUCKET_SCHEMAS,
    RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER,
    _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS,
    _RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS,
)


def _promotion_grade_runtime_ledger_authority_marker_present(
    bucket: Mapping[str, object],
    key: str,
) -> bool:
    marker = _text_or_none(bucket.get(key))
    return (
        marker is not None
        and marker in _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS
    )


def runtime_ledger_promotion_source_authority_blockers(
    bucket: Mapping[str, object],
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


def runtime_ledger_promotion_source_authority_present(
    bucket: Mapping[str, object],
) -> bool:
    return not runtime_ledger_promotion_source_authority_blockers(bucket)


def _runtime_ledger_bucket_payload(bucket: RuntimeLedgerBucket) -> dict[str, object]:
    return {
        "bucket_started_at": bucket.bucket_started_at.isoformat(),
        "bucket_ended_at": bucket.bucket_ended_at.isoformat(),
        "account_label": bucket.account_label,
        "strategy_id": bucket.strategy_id,
        "symbol": bucket.symbol,
        "fill_count": bucket.fill_count,
        "decision_count": bucket.decision_count,
        "submitted_order_count": bucket.submitted_order_count,
        "cancelled_order_count": bucket.cancelled_order_count,
        "rejected_order_count": bucket.rejected_order_count,
        "unfilled_order_count": bucket.unfilled_order_count,
        "closed_trade_count": bucket.closed_trade_count,
        "open_position_count": bucket.open_position_count,
        "filled_notional": str(bucket.filled_notional),
        "gross_strategy_pnl": str(bucket.gross_strategy_pnl),
        "cost_amount": str(bucket.cost_amount),
        "net_strategy_pnl_after_costs": str(bucket.net_strategy_pnl_after_costs),
        "post_cost_expectancy_bps": (
            str(bucket.post_cost_expectancy_bps)
            if bucket.post_cost_expectancy_bps is not None
            else None
        ),
        "diagnostic_closed_trade_expectancy_bps": (
            str(bucket.diagnostic_closed_trade_expectancy_bps)
            if bucket.diagnostic_closed_trade_expectancy_bps is not None
            else None
        ),
        "diagnostic_closed_trade_expectancy_basis": (
            "realized_closed_trips_after_explicit_costs_not_promotion_grade"
            if bucket.diagnostic_closed_trade_expectancy_bps is not None
            else None
        ),
        "cost_basis_counts": bucket.cost_basis_counts,
        "execution_policy_hash_counts": bucket.execution_policy_hash_counts,
        "cost_model_hash_counts": bucket.cost_model_hash_counts,
        "lineage_hash_counts": bucket.lineage_hash_counts,
        "blockers": bucket.blockers,
        "ledger_schema_version": bucket.ledger_schema_version,
        "pnl_basis": bucket.pnl_basis,
    }


def _mapping_hash_count(value: object) -> int:
    if not isinstance(value, Mapping):
        return 0
    return sum(1 for key in value.keys() if str(key).strip())


def _positive_count_mapping_present(value: object) -> bool:
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


def _runtime_ledger_explicit_costs_present(bucket: Mapping[str, object]) -> bool:
    cost_amount = _decimal_or_none(
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
        _text_or_none(
            bucket.get("cost_basis")
            or bucket.get("cost_source")
            or bucket.get("fee_basis")
            or bucket.get("commission_basis")
            or bucket.get("broker_fee_basis")
        )
        is not None
    )


def _runtime_ledger_bucket_profit_proof_blockers(
    bucket: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []

    def add(blocker: str) -> None:
        if blocker not in blockers:
            blockers.append(blocker)

    filled_notional = _decimal_or_none(bucket.get("filled_notional"))
    cost_amount = _decimal_or_none(bucket.get("cost_amount"))
    post_cost_expectancy = _decimal_or_none(bucket.get("post_cost_expectancy_bps"))
    diagnostic_closed_trade_expectancy = _decimal_or_none(
        bucket.get("diagnostic_closed_trade_expectancy_bps")
    )
    if bucket.get("pnl_basis") != POST_COST_BASIS_RUNTIME_LEDGER:
        add("runtime_ledger_pnl_basis_not_runtime_ledger")
    if bucket.get("ledger_schema_version") not in RUNTIME_LEDGER_BUCKET_SCHEMAS:
        add("runtime_ledger_schema_not_supported")
    for blocker in runtime_ledger_promotion_source_authority_blockers(bucket):
        add(blocker)
    execution_count = _nonnegative_int(
        _as_mapping(bucket.get("source_row_counts")).get("executions")
    )
    tca_count = _nonnegative_int(
        _as_mapping(bucket.get("source_row_counts")).get("execution_tca_metrics")
    )
    execution_tca_ref_count = len(_runtime_ledger_execution_tca_metric_refs(bucket))
    execution_tca_required = (
        _first_bool(bucket, "execution_tca_required", "requires_execution_tca") is True
        or tca_count > 0
    )
    if (
        execution_tca_required
        and execution_count > 0
        and (tca_count < execution_count or execution_tca_ref_count < execution_count)
    ):
        add(EXECUTION_TCA_MISSING_BLOCKER)
        add(RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER)
    for blocker in _metadata_text_list(bucket.get("blockers")):
        add(blocker)
    if _first_bool(bucket, "order_feed_lifecycle_complete") is False:
        add(ORDER_FEED_LIFECYCLE_MISSING_BLOCKER)
    if _first_bool(bucket, "execution_economics_complete") is False:
        add(EXECUTION_ECONOMICS_MISSING_BLOCKER)
    if _nonnegative_int(bucket.get("fill_count")) <= 0:
        add("runtime_fills_missing")
    if _nonnegative_int(bucket.get("decision_count")) <= 0:
        add("runtime_decision_lifecycle_missing")
    if _nonnegative_int(bucket.get("submitted_order_count")) <= 0:
        add("submitted_order_lifecycle_missing")
    if _nonnegative_int(bucket.get("closed_trade_count")) <= 0:
        add("closed_round_trip_missing")
    if bucket.get("open_position_count") is None:
        add("runtime_ledger_open_position_count_missing")
    if _nonnegative_int(bucket.get("open_position_count")) > 0:
        add("unclosed_position")
    if filled_notional is None or filled_notional <= 0:
        add("filled_notional_missing")
    if not _runtime_ledger_explicit_costs_present(bucket):
        add("runtime_ledger_explicit_costs_missing")
    if cost_amount is None or cost_amount < 0:
        add(
            "runtime_ledger_cost_amount_missing"
            if cost_amount is None
            else "runtime_ledger_cost_amount_negative"
        )
    if is_non_promotion_grade_runtime_cost_basis(bucket.get("cost_basis")):
        add("runtime_ledger_cost_basis_non_promotion_grade")
    if cost_basis_counts_have_non_promotion_grade_costs(
        bucket.get("cost_basis_counts")
    ):
        add("runtime_ledger_cost_basis_non_promotion_grade")
    source_decision_mode = normalize_source_decision_mode(
        bucket.get("source_decision_mode")
    )
    profit_proof_eligible = _first_bool(bucket, "profit_proof_eligible")
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
        add(SOURCE_DECISION_MODE_PROFIT_PROOF_MISSING_BLOCKER)
    if source_decision_mode and not source_decision_mode_is_profit_proof_eligible(
        source_decision_mode
    ):
        add(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if source_decision_mode_counts_have_non_profit_proof_modes(
        source_decision_mode_counts
    ):
        add(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if profit_proof_eligible is False:
        add(SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER)
    if post_cost_expectancy is None:
        add(
            "runtime_ledger_post_cost_expectancy_not_promotion_grade"
            if diagnostic_closed_trade_expectancy is not None
            else "runtime_ledger_post_cost_expectancy_missing"
        )
    if _mapping_hash_count(bucket.get("execution_policy_hash_counts")) <= 0:
        add("runtime_ledger_execution_policy_hash_missing")
    if _mapping_hash_count(bucket.get("cost_model_hash_counts")) <= 0:
        add("runtime_ledger_cost_model_hash_missing")
    if _mapping_hash_count(bucket.get("lineage_hash_counts")) <= 0:
        add("runtime_ledger_lineage_hash_missing")
    return blockers


def _runtime_ledger_bucket_profit_proof_present(
    bucket: Mapping[str, object],
) -> bool:
    return not _runtime_ledger_bucket_profit_proof_blockers(bucket)


def _runtime_ledger_tca_row_from_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    computed_at: datetime | None = None,
) -> dict[str, object]:
    payload = _runtime_ledger_bucket_payload(bucket)
    promotion_eligible = _runtime_ledger_bucket_profit_proof_present(payload)
    return {
        "computed_at": computed_at
        or max(
            bucket.bucket_started_at,
            bucket.bucket_ended_at - timedelta(microseconds=1),
        ),
        "abs_slippage_bps": None,
        "explicit_cost_bps": (
            (bucket.cost_amount / bucket.filled_notional) * Decimal("10000")
            if bucket.filled_notional > 0
            else None
        ),
        "post_cost_expectancy_bps": bucket.post_cost_expectancy_bps,
        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
        "post_cost_promotion_eligible": promotion_eligible,
        "diagnostic_closed_trade_expectancy_bps": (
            bucket.diagnostic_closed_trade_expectancy_bps
        ),
        "diagnostic_closed_trade_expectancy_basis": (
            "realized_closed_trips_after_explicit_costs_not_promotion_grade"
            if bucket.diagnostic_closed_trade_expectancy_bps is not None
            else None
        ),
        "realized_gross_pnl": bucket.gross_strategy_pnl,
        "realized_net_pnl": bucket.net_strategy_pnl_after_costs,
        "turnover_notional": bucket.filled_notional,
        "runtime_ledger_blockers": bucket.blockers,
        "runtime_ledger_cost_basis_counts": bucket.cost_basis_counts,
        "runtime_ledger_pnl_basis": bucket.pnl_basis,
        "runtime_ledger_bucket": payload,
    }


def _append_runtime_ledger_tca_row_blocker(
    *,
    tca_rows: list[dict[str, object]],
    blocker: str,
) -> None:
    for row in tca_rows:
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, Mapping):
            continue
        bucket_payload = {str(key): item for key, item in bucket.items()}
        blockers = _metadata_text_list(bucket_payload.get("blockers"))
        if blocker not in blockers:
            blockers.append(blocker)
        bucket_payload["blockers"] = blockers
        row["runtime_ledger_bucket"] = bucket_payload
        row["runtime_ledger_blockers"] = blockers
        row["post_cost_promotion_eligible"] = False


def _with_runtime_ledger_source_authority_context(
    bucket: Mapping[str, object],
    *,
    source_window_start: datetime,
    source_window_end: datetime,
    source_refs: Sequence[str],
    source_row_counts: Mapping[str, int],
    trade_decision_ids: Sequence[object] = (),
    execution_ids: Sequence[object] = (),
    execution_tca_metric_ids: Sequence[object] = (),
    execution_order_event_ids: Sequence[object] = (),
    source_window_ids: Sequence[object] = (),
    source_offsets: Sequence[Mapping[str, object]] = (),
    source_window_status_counts: Mapping[str, int] | None = None,
    source_window_classification_counts: Mapping[str, int] | None = None,
    source_window_gap_count: int = 0,
    source_window_gap_ranges: Sequence[Mapping[str, object]] = (),
    order_feed_lifecycle_complete: bool | None = None,
    execution_economics_complete: bool | None = None,
    execution_tca_required: bool | None = None,
    source_materialization: str | None = None,
    authority_class: str | None = None,
    authority_reason: str | None = None,
) -> dict[str, object]:
    payload = dict(bucket)
    payload.setdefault("source_window_start", source_window_start.isoformat())
    payload.setdefault("source_window_end", source_window_end.isoformat())
    if source_refs:
        existing_refs = _metadata_text_list(payload.get("source_refs"))
        payload["source_refs"] = list(dict.fromkeys([*existing_refs, *source_refs]))
    for key, values in (
        ("trade_decision_ids", trade_decision_ids),
        ("execution_ids", execution_ids),
        ("execution_tca_metric_ids", execution_tca_metric_ids),
        ("execution_order_event_ids", execution_order_event_ids),
        ("source_window_ids", source_window_ids),
    ):
        merged_values = _metadata_text_list(payload.get(key))
        merged_values.extend(
            _text for value in values if (_text := _text_or_none(value))
        )
        if merged_values:
            payload[key] = list(dict.fromkeys(merged_values))
    for source_key, alias_keys in (
        (
            "trade_decision_ids",
            ("trade_decision_refs", "decision_ids", "decision_refs"),
        ),
        ("execution_ids", ("execution_refs", "runtime_ledger_execution_ids")),
        (
            "execution_tca_metric_ids",
            (
                "execution_tca_metric_refs",
                "runtime_ledger_execution_tca_metric_ids",
                "runtime_ledger_execution_tca_metric_refs",
            ),
        ),
        (
            "execution_order_event_ids",
            (
                "execution_order_event_refs",
                "runtime_ledger_execution_order_event_ids",
                "runtime_ledger_execution_order_event_refs",
            ),
        ),
        (
            "source_window_ids",
            (
                "source_window_refs",
                "runtime_ledger_source_window_ids",
                "runtime_ledger_source_window_refs",
            ),
        ),
    ):
        values = _metadata_text_list(payload.get(source_key))
        if not values:
            continue
        for alias_key in alias_keys:
            existing_values = _metadata_text_list(payload.get(alias_key))
            payload[alias_key] = list(dict.fromkeys([*existing_values, *values]))
    if source_offsets:
        existing_offsets = [
            dict(item)
            for item in cast(Sequence[object], payload.get("source_offsets") or [])
            if isinstance(item, Mapping)
        ]
        seen_offsets = {
            (
                str(item.get("topic") or ""),
                str(item.get("partition") or ""),
                str(item.get("offset") or ""),
            )
            for item in existing_offsets
        }
        for item in source_offsets:
            offset = {
                "topic": item.get("topic"),
                "partition": item.get("partition"),
                "offset": item.get("offset"),
            }
            topic = offset.get("topic")
            partition = offset.get("partition")
            source_offset = offset.get("offset")
            key = (
                str(topic or ""),
                "" if partition is None else str(partition),
                "" if source_offset is None else str(source_offset),
            )
            if all(key) and key not in seen_offsets:
                existing_offsets.append(offset)
                seen_offsets.add(key)
        if existing_offsets:
            payload["source_offsets"] = existing_offsets
    if source_window_status_counts:
        payload["source_window_status_counts"] = _merge_count_mappings(
            _as_mapping(payload.get("source_window_status_counts")),
            source_window_status_counts,
        )
    if source_window_classification_counts:
        payload["source_window_classification_counts"] = _merge_count_mappings(
            _as_mapping(payload.get("source_window_classification_counts")),
            source_window_classification_counts,
        )
    if source_window_gap_count > 0:
        payload["source_window_gap_count"] = max(
            _nonnegative_int(payload.get("source_window_gap_count")),
            source_window_gap_count,
        )
    if source_window_gap_ranges:
        existing_gap_ranges = [
            dict(item)
            for item in cast(
                Sequence[object], payload.get("source_window_gap_ranges") or []
            )
            if isinstance(item, Mapping)
        ]
        existing_gap_ranges.extend(dict(item) for item in source_window_gap_ranges)
        if existing_gap_ranges:
            payload["source_window_gap_ranges"] = existing_gap_ranges
    if order_feed_lifecycle_complete is not None:
        payload["order_feed_lifecycle_complete"] = order_feed_lifecycle_complete
    if execution_economics_complete is not None:
        payload["execution_economics_complete"] = execution_economics_complete
    if execution_tca_required is not None:
        payload["execution_tca_required"] = execution_tca_required
    if source_materialization:
        payload["source_materialization"] = source_materialization
    if authority_class:
        payload["authority_class"] = authority_class
    if authority_reason:
        payload["authority_reason"] = authority_reason
    existing_counts = _as_mapping(payload.get("source_row_counts"))
    merged_counts: dict[str, int] = {
        str(key): _nonnegative_int(value) for key, value in existing_counts.items()
    }
    for key, value in source_row_counts.items():
        table_name = str(key)
        merged_counts[table_name] = max(
            merged_counts.get(table_name, 0),
            max(0, int(value)),
        )
    if merged_counts:
        payload["source_row_counts"] = dict(sorted(merged_counts.items()))
    existing_blockers = _metadata_text_list(payload.get("blockers"))
    if existing_blockers:
        refreshed_source_blockers = set(
            runtime_ledger_promotion_source_authority_blockers(payload)
        )
        refreshed_blockers = [
            blocker
            for blocker in existing_blockers
            if (
                blocker not in _RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS
                or blocker in refreshed_source_blockers
            )
        ]
        for blocker in refreshed_source_blockers:
            if blocker not in refreshed_blockers:
                refreshed_blockers.append(blocker)
        payload["blockers"] = refreshed_blockers
    return payload


__all__ = [
    "_promotion_grade_runtime_ledger_authority_marker_present",
    "runtime_ledger_promotion_source_authority_blockers",
    "runtime_ledger_promotion_source_authority_present",
    "_runtime_ledger_bucket_payload",
    "_mapping_hash_count",
    "_positive_count_mapping_present",
    "_runtime_ledger_explicit_costs_present",
    "_runtime_ledger_bucket_profit_proof_blockers",
    "_runtime_ledger_bucket_profit_proof_present",
    "_runtime_ledger_tca_row_from_bucket",
    "_append_runtime_ledger_tca_row_blocker",
    "_with_runtime_ledger_source_authority_context",
]
