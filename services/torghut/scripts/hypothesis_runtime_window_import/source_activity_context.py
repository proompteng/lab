from __future__ import annotations

from datetime import datetime, timedelta
from typing import Mapping, Sequence

from app.trading.runtime_ledger import RuntimeLedgerBucket, RuntimeLedgerFill

from scripts.hypothesis_runtime_window_import.common import (
    _alpaca_2026_equity_fee_schedule_hash,
    _cost_basis_is_alpaca_fee_schedule,
    _execution_row_has_fill,
    _execution_signed_qty,
    _first_lineage_digest,
    _first_payload_digest,
    _first_positive_decimal,
    _first_text,
    _metadata_text_list,
    _nonnegative_int,
    _runtime_ledger_equity_denominator_from_rows,
    _runtime_ledger_row_time,
    _source_identifier_values,
    _source_offset_values,
    _text_or_none,
)
from scripts.hypothesis_runtime_window_import.constants import (
    ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER,
    ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER,
    _EXECUTION_ORDER_EVENT_REF_KEYS,
    _SOURCE_WINDOW_REF_KEYS,
)
from scripts.hypothesis_runtime_window_import.execution_costs import (
    _runtime_execution_cost_amount,
    _runtime_execution_cost_basis,
)
from scripts.hypothesis_runtime_window_import.lifecycle_rows import (
    _order_feed_fill_lifecycle_blockers,
    _runtime_order_id,
)
from scripts.hypothesis_runtime_window_import.source_decisions import (
    _source_decision_mode_counts,
    _source_decision_rows_profit_proof_eligible,
    _source_decision_target_notional_sizing_summary,
)
from scripts.hypothesis_runtime_window_import.source_row_filters import (
    _event_sourced_fill_economics_order_ids,
    _execution_fill_economics_order_ids,
    _execution_tca_order_ids,
    _required_order_lifecycle_source_row_count,
    _runtime_decision_rows_before_bucket,
    _runtime_decision_rows_for_bucket,
    _runtime_order_rows_for_bucket,
    _runtime_source_row_before_bucket,
    _runtime_source_row_in_bucket,
    _runtime_unlinked_order_rows_for_bucket,
    _source_backed_fill_lifecycle_order_ids,
    _source_backed_fill_lifecycle_rows,
    _source_backed_order_lifecycle_rows,
    _source_backed_submitted_lifecycle_order_ids,
)
from scripts.hypothesis_runtime_window_import.source_windows import (
    _source_window_classification_counts,
    _source_window_gap_count,
    _source_window_gap_ranges,
    _source_window_status_counts,
)

__all__ = (
    "_runtime_source_context_for_bucket",
    "_source_activity_diagnostics_blockers",
    "_runtime_execution_ledger_fill_from_row",
)


def _runtime_source_context_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    execution_rows: list[dict[str, object]],
    decision_lifecycle_rows: list[dict[str, object]] | None,
    order_lifecycle_rows: list[dict[str, object]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None,
    carry_in_execution_rows: list[dict[str, object]] | None = None,
    carry_in_decision_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_order_lifecycle_rows: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    target_order_rows = _runtime_order_rows_for_bucket(
        bucket=bucket,
        execution_rows=execution_rows,
        order_lifecycle_rows=order_lifecycle_rows,
    )
    bucket_carry_in_order_rows = [
        dict(row)
        for row in carry_in_order_lifecycle_rows or []
        if _runtime_source_row_before_bucket(row, bucket=bucket)
    ]
    bucket_order_rows = [*bucket_carry_in_order_rows, *target_order_rows]
    bucket_order_ids = {
        order_id
        for row in bucket_order_rows
        if (order_id := _runtime_order_id(row)) is not None
    }
    target_execution_rows = [
        dict(row)
        for row in execution_rows
        if _execution_row_has_fill(row)
        and (
            _runtime_source_row_in_bucket(row, bucket=bucket)
            or (
                (order_id := _runtime_order_id(row)) is not None
                and order_id in bucket_order_ids
            )
        )
    ]
    bucket_carry_in_execution_rows = [
        dict(row)
        for row in carry_in_execution_rows or []
        if _execution_row_has_fill(row)
        and _runtime_source_row_before_bucket(row, bucket=bucket)
    ]
    bucket_execution_rows = [*bucket_carry_in_execution_rows, *target_execution_rows]
    target_decision_rows = _runtime_decision_rows_for_bucket(
        bucket=bucket,
        decision_lifecycle_rows=decision_lifecycle_rows,
        source_rows=[*bucket_execution_rows, *bucket_order_rows],
    )
    carry_in_decision_rows = _runtime_decision_rows_before_bucket(
        bucket=bucket,
        decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
        source_rows=[*bucket_execution_rows, *bucket_order_rows],
    )
    bucket_decision_rows = [*carry_in_decision_rows, *target_decision_rows]
    bucket_unlinked_order_rows = _runtime_unlinked_order_rows_for_bucket(
        bucket=bucket,
        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
        bucket_order_ids=bucket_order_ids,
    )
    source_rows = [*bucket_execution_rows, *bucket_decision_rows, *bucket_order_rows]
    source_backed_fill_lifecycle_rows = _source_backed_fill_lifecycle_rows(
        bucket_order_rows
    )
    source_backed_order_lifecycle_rows = _source_backed_order_lifecycle_rows(
        bucket_order_rows
    )
    expected_execution_fill_order_ids = set()
    for row in bucket_execution_rows:
        if (
            _execution_row_has_fill(row)
            and (order_id := _runtime_order_id(row)) is not None
        ):
            expected_execution_fill_order_ids.add(order_id)
    for row in bucket_order_rows:
        if (order_id := _runtime_order_id(row)) is not None:
            expected_execution_fill_order_ids.add(order_id)
    source_backed_fill_lifecycle_order_ids = _source_backed_fill_lifecycle_order_ids(
        source_backed_fill_lifecycle_rows
    )
    source_backed_submitted_lifecycle_order_ids = (
        _source_backed_submitted_lifecycle_order_ids(source_backed_order_lifecycle_rows)
    )
    event_sourced_fill_order_ids = _event_sourced_fill_economics_order_ids(
        source_backed_fill_lifecycle_rows
    )
    execution_fill_order_ids = _execution_fill_economics_order_ids(
        bucket_execution_rows
    )
    execution_tca_order_ids = _execution_tca_order_ids(bucket_execution_rows)
    execution_tca_required = any(
        _execution_row_has_fill(row)
        and any(
            key in row
            for key in (
                "execution_tca_metric_id",
                "execution_tca_metric_ref",
                "execution_tca_id",
                "tca_metric_id",
                "tca_id",
            )
        )
        for row in bucket_execution_rows
    )
    order_feed_fill_economics_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(event_sourced_fill_order_ids)
    execution_fill_economics_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(execution_fill_order_ids)
    execution_tca_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(execution_tca_order_ids)
    execution_tca_satisfied = (not execution_tca_required) or execution_tca_complete
    source_backed_fill_lifecycle_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(
        source_backed_fill_lifecycle_order_ids
    )
    source_backed_submitted_lifecycle_complete = bool(
        expected_execution_fill_order_ids
    ) and expected_execution_fill_order_ids.issubset(
        source_backed_submitted_lifecycle_order_ids
    )
    source_backed_order_lifecycle_complete = (
        source_backed_fill_lifecycle_complete
        and source_backed_submitted_lifecycle_complete
    )
    source_authority_lifecycle_rows = (
        source_backed_order_lifecycle_rows
        if source_backed_order_lifecycle_complete
        else source_backed_fill_lifecycle_rows
    )
    source_authority_lifecycle_times = [
        event_time
        for row in source_authority_lifecycle_rows
        if (
            event_time := _runtime_ledger_row_time(
                {str(key): value for key, value in row.items()}
            )
        )
        is not None
    ]
    source_window_ids = _source_identifier_values(
        source_authority_lifecycle_rows,
        *_SOURCE_WINDOW_REF_KEYS,
    )
    required_order_lifecycle_source_row_count = (
        _required_order_lifecycle_source_row_count(
            bucket_order_rows,
            expected_order_ids=expected_execution_fill_order_ids,
        )
    )
    execution_tca_metric_ids = _source_identifier_values(
        bucket_execution_rows,
        "execution_tca_metric_id",
        "execution_tca_metric_ref",
        "execution_tca_id",
        "tca_metric_id",
        "tca_id",
    )
    source_row_counts = {
        "trade_decisions": len(bucket_decision_rows),
        "executions": len(bucket_execution_rows),
        "execution_order_events": required_order_lifecycle_source_row_count,
    }
    if execution_tca_metric_ids:
        source_row_counts["execution_tca_metrics"] = len(execution_tca_metric_ids)
    if source_window_ids:
        source_row_counts["order_feed_source_windows"] = len(source_window_ids)
    elif required_order_lifecycle_source_row_count > 0:
        source_row_counts["order_feed_source_windows"] = 1
    source_refs = [
        ref
        for table, ref in (
            ("trade_decisions", "postgres:trade_decisions"),
            ("executions", "postgres:executions"),
            ("execution_tca_metrics", "postgres:execution_tca_metrics"),
            ("execution_order_events", "postgres:execution_order_events"),
            ("order_feed_source_windows", "postgres:order_feed_source_windows"),
        )
        if source_row_counts.get(table, 0) > 0
    ]
    source_materialization = None
    authority_class = None
    authority_reason = None
    source_offsets = _source_offset_values(source_authority_lifecycle_rows)
    source_window_status_counts = _source_window_status_counts(
        source_authority_lifecycle_rows
    )
    source_window_classification_counts = _source_window_classification_counts(
        source_authority_lifecycle_rows
    )
    source_window_gap_count = _source_window_gap_count(source_authority_lifecycle_rows)
    source_window_gap_ranges = _source_window_gap_ranges(
        source_authority_lifecycle_rows
    )
    execution_order_event_ids = _source_identifier_values(
        source_authority_lifecycle_rows,
        *_EXECUTION_ORDER_EVENT_REF_KEYS,
    )
    if source_offsets and execution_order_event_ids:
        if order_feed_fill_economics_complete and execution_tca_satisfied:
            source_materialization = "execution_order_events"
            authority_class = "runtime_order_feed_execution_source"
            authority_reason = "event_sourced_runtime_ledger_profit_proof"
        elif (
            execution_fill_economics_complete
            and execution_tca_satisfied
            and source_backed_order_lifecycle_complete
        ):
            source_materialization = "source_execution_lifecycle"
            authority_class = "source_execution_lifecycle_materialized_runtime_ledger"
            authority_reason = "source_execution_lifecycle_materialized_runtime_ledger"
    return {
        "execution_rows": bucket_execution_rows,
        "decision_rows": bucket_decision_rows,
        "order_rows": bucket_order_rows,
        "unlinked_order_rows": bucket_unlinked_order_rows,
        "source_rows": source_rows,
        "source_window_ids": source_window_ids,
        "source_window_start": (
            min(source_authority_lifecycle_times)
            if source_authority_lifecycle_times
            else bucket.bucket_started_at
        ),
        "source_window_end": (
            max(source_authority_lifecycle_times) + timedelta(microseconds=1)
            if source_authority_lifecycle_times
            else bucket.bucket_ended_at
        ),
        "source_row_counts": source_row_counts,
        "source_refs": source_refs,
        "trade_decision_ids": _source_identifier_values(
            source_rows,
            "trade_decision_id",
            "decision_id",
            "decision_hash",
        ),
        "execution_ids": _source_identifier_values(
            [*bucket_execution_rows, *bucket_order_rows],
            "execution_id",
        ),
        "execution_tca_metric_ids": execution_tca_metric_ids,
        "execution_order_event_ids": execution_order_event_ids,
        "source_window_status_counts": source_window_status_counts,
        "source_window_classification_counts": source_window_classification_counts,
        "source_window_gap_count": source_window_gap_count,
        "source_window_gap_ranges": source_window_gap_ranges,
        "source_offsets": source_offsets,
        "source_materialization": source_materialization,
        "authority_class": authority_class,
        "authority_reason": authority_reason,
        "order_feed_lifecycle_complete": source_backed_order_lifecycle_complete,
        "fill_economics_complete": (
            (order_feed_fill_economics_complete or execution_fill_economics_complete)
            and execution_tca_satisfied
        ),
        "execution_tca_required": execution_tca_required,
        "execution_tca_complete": execution_tca_complete,
        "order_feed_fill_lifecycle_blockers": _order_feed_fill_lifecycle_blockers(
            execution_rows=bucket_execution_rows,
            order_lifecycle_rows=bucket_order_rows,
            unlinked_order_lifecycle_rows=bucket_unlinked_order_rows,
        ),
        "source_account_labels": sorted(
            {
                str(row.get("source_account_label") or "").strip()
                for row in source_rows
                if str(row.get("source_account_label") or "").strip()
            }
        ),
        "source_decision_mode_counts": _source_decision_mode_counts(source_rows),
        "source_decision_profit_proof_eligible": (
            _source_decision_rows_profit_proof_eligible(source_rows)
        ),
        "paper_route_target_notional_sizing": (
            _source_decision_target_notional_sizing_summary(source_rows)
        ),
        "equity_denominator": _runtime_ledger_equity_denominator_from_rows(source_rows),
    }


def _source_activity_diagnostics_blockers(
    diagnostics: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []

    def add(blocker: str) -> None:
        if blocker not in blockers:
            blockers.append(blocker)

    if _text_or_none(diagnostics.get("runtime_ledger_source_bucket_unavailable")):
        add("runtime_ledger_source_bucket_unavailable")

    decision_query_count = _nonnegative_int(
        diagnostics.get("decision_rows_before_lineage_filter")
    )
    execution_query_count = _nonnegative_int(
        diagnostics.get("execution_rows_before_lineage_filter")
    )
    order_query_count = _nonnegative_int(
        diagnostics.get("order_lifecycle_rows_before_lineage_filter")
    )
    decision_lineage_count = _nonnegative_int(
        diagnostics.get("decision_rows_after_lineage_filter")
    )
    execution_lineage_count = _nonnegative_int(
        diagnostics.get("execution_rows_after_lineage_filter")
    )
    execution_tca_lineage_count = _nonnegative_int(
        diagnostics.get("execution_tca_rows_after_lineage_filter")
    )
    source_bucket_count = _nonnegative_int(
        diagnostics.get("runtime_ledger_source_bucket_count")
    )
    source_bucket_profit_proof_count = _nonnegative_int(
        diagnostics.get("runtime_ledger_source_bucket_profit_proof_count")
    )
    unlinked_fill_lifecycle_count = _nonnegative_int(
        diagnostics.get("order_feed_unlinked_fill_lifecycle_count")
    )
    if "order_feed_unlinked_strategy_fill_lifecycle_count" in diagnostics:
        strategy_unlinked_fill_lifecycle_count = _nonnegative_int(
            diagnostics.get("order_feed_unlinked_strategy_fill_lifecycle_count")
        )
    else:
        strategy_unlinked_fill_lifecycle_count = unlinked_fill_lifecycle_count

    if (decision_query_count or execution_query_count or order_query_count) and not (
        decision_lineage_count or execution_lineage_count
    ):
        add("source_lineage_filter_excluded_activity")
    elif not (
        decision_query_count
        or execution_query_count
        or order_query_count
        or source_bucket_count
    ):
        add("strategy_account_symbol_window_source_activity_missing")

    if decision_lineage_count > 0 and execution_lineage_count <= 0:
        add("execution_rows_missing_for_matched_decisions")
    if execution_lineage_count > 0 and order_query_count <= 0:
        add(ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER)
    if execution_lineage_count > 0 and execution_tca_lineage_count <= 0:
        add("execution_tca_rows_missing")
    if strategy_unlinked_fill_lifecycle_count > 0:
        add(ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER)
    if source_bucket_count <= 0:
        add("runtime_ledger_source_bucket_missing")
    elif source_bucket_profit_proof_count <= 0:
        add("runtime_ledger_source_bucket_profit_proof_missing")

    for blocker in _metadata_text_list(
        diagnostics.get("runtime_ledger_source_bucket_profit_proof_blockers")
    ):
        add(blocker)

    for blocker in _metadata_text_list(
        diagnostics.get("order_feed_fill_lifecycle_blockers")
    ):
        add(blocker)

    return blockers


def _runtime_execution_ledger_fill_from_row(
    row: Mapping[str, object],
    *,
    order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
    event_sourced_fill_economics_order_ids: set[str] | None = None,
) -> tuple[RuntimeLedgerFill | None, list[datetime]]:
    computed_at = row.get("computed_at")
    execution_event_at = row.get("execution_event_at")
    execution_created_at = row.get("execution_created_at")
    fill_event_at = (
        execution_created_at
        if isinstance(execution_created_at, datetime)
        else computed_at
    )
    if isinstance(execution_event_at, datetime):
        fill_event_at = execution_event_at
    ledger_computed_at = (
        fill_event_at if isinstance(fill_event_at, datetime) else computed_at
    )
    price = _first_positive_decimal(
        row,
        "avg_fill_price",
        "filled_avg_price",
        "filled_average_price",
        "average_fill_price",
        "fill_price",
        "filled_price",
    )
    side = _first_text(row, "side", "order_side") or ""
    signed_qty = _execution_signed_qty(
        side=side,
        qty=_first_positive_decimal(
            row,
            "filled_qty",
            "filled_quantity",
            "qty",
            "quantity",
        ),
    )
    symbol = str(row.get("symbol") or "").strip().upper()
    if not symbol or not isinstance(ledger_computed_at, datetime):
        return None, []
    decision_id = _first_text(row, "decision_id", "trade_decision_id", "decision_hash")
    order_id = _first_text(
        row,
        "order_id",
        "alpaca_order_id",
        "client_order_id",
        "execution_correlation_id",
    )
    execution_policy_hash = _first_text(
        row,
        "execution_policy_hash",
        "execution_policy_sha256",
        "policy_hash",
    ) or _first_payload_digest(
        row,
        "execution_policy",
        "execution_policy_context",
        "execution_advisor",
        "_execution_advice_provenance",
    )
    cost_model_hash = _first_text(
        row, "cost_model_hash", "fee_model_hash", "cost_model_sha256"
    ) or _first_payload_digest(
        row,
        "cost_model",
        "cost_model_config",
        "transaction_cost_model",
        "fee_model",
        "fees_model",
        "model",
    )
    lineage_hash = _first_text(
        row,
        "lineage_hash",
        "candidate_lineage_hash",
        "replay_lineage_hash",
        "candidate_evaluation_key",
    ) or _first_lineage_digest(row)
    replay_data_hash = _first_text(
        row,
        "replay_data_hash",
        "replay_tape_content_sha256",
        "dataset_snapshot_hash",
        "source_query_digest",
    )
    if price is None or price <= 0 or signed_qty == 0:
        return None, []
    event_sourced_order_ids = (
        event_sourced_fill_economics_order_ids
        if event_sourced_fill_economics_order_ids is not None
        else _event_sourced_fill_economics_order_ids(order_lifecycle_rows or [])
    )
    if order_id is not None and order_id in event_sourced_order_ids:
        return None, []
    event_times = [ledger_computed_at]
    if isinstance(fill_event_at, datetime):
        event_times.append(fill_event_at)
    filled_qty = abs(signed_qty)
    filled_notional = filled_qty * price
    cost_amount = _runtime_execution_cost_amount(
        row,
        filled_notional=filled_notional,
        side=side,
        filled_qty=filled_qty,
    )
    cost_basis = _runtime_execution_cost_basis(
        row,
        cost_amount=cost_amount,
        side=side,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    if _cost_basis_is_alpaca_fee_schedule(cost_basis):
        cost_model_hash = _alpaca_2026_equity_fee_schedule_hash()
    return (
        RuntimeLedgerFill(
            executed_at=fill_event_at
            if isinstance(fill_event_at, datetime)
            else ledger_computed_at,
            event_type="fill",
            decision_id=decision_id,
            order_id=order_id,
            execution_policy_hash=execution_policy_hash,
            cost_model_hash=cost_model_hash,
            lineage_hash=lineage_hash,
            replay_data_hash=replay_data_hash,
            side=side,
            filled_qty=filled_qty,
            avg_fill_price=price,
            filled_notional=filled_notional,
            cost_amount=cost_amount,
            cost_basis=cost_basis,
            account_label=str(row.get("account_label") or "") or None,
            strategy_id=str(row.get("strategy_id") or "") or None,
            symbol=symbol,
        ),
        event_times,
    )
