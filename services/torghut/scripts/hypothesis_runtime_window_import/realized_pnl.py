from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Mapping, cast

from app.trading.runtime_ledger import RuntimeLedgerFill, build_runtime_ledger_buckets
from app.trading.runtime_decision_authority import (
    SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER,
)

from scripts.hypothesis_runtime_window_import.common import (
    _first_text,
    _flat_start_position_snapshot_authority,
    _metadata_text_list,
    _runtime_ledger_event_type,
    _runtime_ledger_row_time,
    _runtime_source_row_symbol,
    _source_authority_order_event_row,
    _with_canonical_runtime_source_refs,
)
from scripts.hypothesis_runtime_window_import.constants import (
    EXECUTION_TCA_MISSING_BLOCKER,
    POST_COST_BASIS_EXECUTION_RECONSTRUCTION,
    POST_COST_BASIS_RUNTIME_LEDGER,
    RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER,
    _RUNTIME_LEDGER_FILL_EVENTS,
)
from scripts.hypothesis_runtime_window_import.lifecycle_rows import (
    _execution_id_by_order_id,
    _execution_side_by_order_id,
    _runtime_lifecycle_ledger_row,
    _runtime_order_id,
    _with_linked_execution_id,
)
from scripts.hypothesis_runtime_window_import.runtime_ledger_authority import (
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_tca_row_from_bucket,
    _with_runtime_ledger_source_authority_context,
    runtime_ledger_promotion_source_authority_blockers,
)
from scripts.hypothesis_runtime_window_import.source_activity_context import (
    _runtime_execution_ledger_fill_from_row,
    _runtime_source_context_for_bucket,
)
from scripts.hypothesis_runtime_window_import.source_decisions import (
    _partition_runtime_source_rows_by_decision_mode,
)
from scripts.hypothesis_runtime_window_import.source_row_filters import (
    _active_carry_in_ledger_rows,
    _event_sourced_fill_economics_order_ids,
    _filter_carry_in_source_rows_for_active_lots,
    _runtime_source_decision_ids,
)

__all__ = ("_build_realized_strategy_pnl_rows",)


def _build_realized_strategy_pnl_rows(
    execution_rows: list[dict[str, object]],
    *,
    decision_lifecycle_rows: list[dict[str, object]] | None = None,
    order_lifecycle_rows: list[dict[str, object]] | None = None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_execution_rows: list[dict[str, object]] | None = None,
    carry_in_decision_lifecycle_rows: list[dict[str, object]] | None = None,
    carry_in_order_lifecycle_rows: list[dict[str, object]] | None = None,
    flat_start_position_snapshot: Mapping[str, object] | None = None,
    allow_authoritative_runtime_ledger_materialization: bool = False,
    split_mixed_source_decision_modes: bool = True,
) -> list[dict[str, object]]:
    flat_start_authority = _flat_start_position_snapshot_authority(
        flat_start_position_snapshot
    )
    if flat_start_authority is not None:
        carry_in_execution_rows = None
        carry_in_decision_lifecycle_rows = None
        carry_in_order_lifecycle_rows = None
    if split_mixed_source_decision_modes:
        partitions = _partition_runtime_source_rows_by_decision_mode(
            execution_rows=execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
        )
        if partitions is not None:
            partition_rows: list[dict[str, object]] = []
            for (
                mode_key,
                partition_execution_rows,
                partition_decision_rows,
                partition_order_rows,
                partition_unlinked_order_rows,
                partition_carry_in_execution_rows,
                partition_carry_in_decision_rows,
                partition_carry_in_order_rows,
            ) in partitions:
                for row in _build_realized_strategy_pnl_rows(
                    partition_execution_rows,
                    decision_lifecycle_rows=partition_decision_rows,
                    order_lifecycle_rows=partition_order_rows,
                    unlinked_order_lifecycle_rows=partition_unlinked_order_rows,
                    carry_in_execution_rows=partition_carry_in_execution_rows,
                    carry_in_decision_lifecycle_rows=partition_carry_in_decision_rows,
                    carry_in_order_lifecycle_rows=partition_carry_in_order_rows,
                    flat_start_position_snapshot=flat_start_position_snapshot,
                    allow_authoritative_runtime_ledger_materialization=(
                        allow_authoritative_runtime_ledger_materialization
                    ),
                    split_mixed_source_decision_modes=False,
                ):
                    row["source_decision_mode_partition"] = mode_key
                    bucket = row.get("runtime_ledger_bucket")
                    if isinstance(bucket, Mapping):
                        row["runtime_ledger_bucket"] = {
                            **dict(bucket),
                            "source_decision_mode_partition": mode_key,
                        }
                    partition_rows.append(row)
            return partition_rows

    if not (
        execution_rows
        or decision_lifecycle_rows
        or carry_in_execution_rows
        or carry_in_decision_lifecycle_rows
    ):
        return []

    ledger_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    carry_in_ledger_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    event_times: list[datetime] = []
    execution_order_ids = {
        order_id for row in execution_rows if (order_id := _runtime_order_id(row))
    }
    execution_ids = {
        execution_id
        for row in execution_rows
        if (execution_id := _first_text(row, "execution_id"))
    }
    execution_symbols = {
        symbol
        for row in execution_rows
        if (symbol := _runtime_source_row_symbol(row)) is not None
    }
    decision_lifecycle_ids = _runtime_source_decision_ids(decision_lifecycle_rows or [])
    carry_in_execution_order_ids = {
        order_id
        for row in carry_in_execution_rows or []
        if (order_id := _runtime_order_id(row))
    }
    carry_in_execution_ids = {
        execution_id
        for row in carry_in_execution_rows or []
        if (execution_id := _first_text(row, "execution_id"))
    }
    carry_in_execution_symbols = {
        symbol
        for row in carry_in_execution_rows or []
        if (symbol := _runtime_source_row_symbol(row)) is not None
    }
    carry_in_decision_lifecycle_ids = _runtime_source_decision_ids(
        carry_in_decision_lifecycle_rows or []
    )
    execution_id_by_order_id = _execution_id_by_order_id(execution_rows)
    carry_in_execution_id_by_order_id = _execution_id_by_order_id(
        carry_in_execution_rows or []
    )
    execution_side_by_order_id = _execution_side_by_order_id(execution_rows)
    carry_in_execution_side_by_order_id = _execution_side_by_order_id(
        carry_in_execution_rows or []
    )
    order_lifecycle_rows = [
        _with_canonical_runtime_source_refs(
            _with_linked_execution_id(
                row,
                execution_id_by_order_id=execution_id_by_order_id,
                execution_side_by_order_id=execution_side_by_order_id,
            )
        )
        for row in order_lifecycle_rows or []
    ]
    carry_in_order_lifecycle_rows = [
        _with_canonical_runtime_source_refs(
            _with_linked_execution_id(
                row,
                execution_id_by_order_id=carry_in_execution_id_by_order_id,
                execution_side_by_order_id=carry_in_execution_side_by_order_id,
            )
        )
        for row in carry_in_order_lifecycle_rows or []
    ]
    event_sourced_fill_economics_order_ids = _event_sourced_fill_economics_order_ids(
        order_lifecycle_rows
    )
    for row in decision_lifecycle_rows or []:
        lifecycle_row = _runtime_lifecycle_ledger_row(row, event_type="decision")
        if lifecycle_row is None:
            continue
        ledger_rows.append(lifecycle_row)
        event_time = lifecycle_row.get("executed_at")
        if isinstance(event_time, datetime):
            event_times.append(event_time)
    for row in order_lifecycle_rows:
        row_order_id = _runtime_order_id(row)
        row_execution_id = _first_text(row, "execution_id")
        row_symbol = _runtime_source_row_symbol(row)
        if (
            (execution_order_ids or execution_ids or execution_symbols)
            and row_order_id not in execution_order_ids
            and row_execution_id not in execution_ids
            and row_symbol not in execution_symbols
        ):
            continue
        if (
            not (execution_order_ids or execution_ids or execution_symbols)
            and decision_lifecycle_ids
        ):
            row_decision_ids = _runtime_source_decision_ids([row])
            if row_decision_ids and not (row_decision_ids & decision_lifecycle_ids):
                continue
        event_type = _runtime_ledger_event_type(
            {str(key): value for key, value in row.items()}
        )
        if event_type in _RUNTIME_LEDGER_FILL_EVENTS:
            lifecycle_row = _runtime_lifecycle_ledger_row(
                row,
                event_type=event_type,
                require_complete_fill=True,
            )
            if lifecycle_row is None:
                if (
                    row_order_id in execution_order_ids
                    or row_execution_id in execution_ids
                    or (
                        not execution_order_ids
                        and not execution_ids
                        and not execution_symbols
                        and _source_authority_order_event_row(row)
                    )
                ):
                    lifecycle_row = _runtime_lifecycle_ledger_row(
                        row,
                        event_type=event_type,
                    )
                    if lifecycle_row is not None:
                        lifecycle_row["source"] = "order_feed_lifecycle"
            if lifecycle_row is not None:
                ledger_rows.append(lifecycle_row)
                event_time = lifecycle_row.get("executed_at")
                if isinstance(event_time, datetime):
                    event_times.append(event_time)
                continue
            event_time = _runtime_ledger_row_time(row)
            if isinstance(event_time, datetime):
                event_times.append(event_time)
            continue
        lifecycle_row = _runtime_lifecycle_ledger_row(
            row,
            event_type=event_type,
        )
        if lifecycle_row is None:
            continue
        ledger_rows.append(lifecycle_row)
        event_time = lifecycle_row.get("executed_at")
        if isinstance(event_time, datetime):
            event_times.append(event_time)
    for row in execution_rows:
        ledger_fill, ledger_event_times = _runtime_execution_ledger_fill_from_row(
            row,
            order_lifecycle_rows=order_lifecycle_rows,
            event_sourced_fill_economics_order_ids=(
                event_sourced_fill_economics_order_ids
            ),
        )
        if ledger_fill is None:
            continue
        ledger_rows.append(ledger_fill)
        event_times.extend(ledger_event_times)

    for row in carry_in_decision_lifecycle_rows or []:
        lifecycle_row = _runtime_lifecycle_ledger_row(row, event_type="decision")
        if lifecycle_row is not None:
            carry_in_ledger_rows.append(lifecycle_row)
    for row in carry_in_order_lifecycle_rows:
        row_order_id = _runtime_order_id(row)
        row_execution_id = _first_text(row, "execution_id")
        row_symbol = _runtime_source_row_symbol(row)
        if (
            (
                carry_in_execution_order_ids
                or carry_in_execution_ids
                or carry_in_execution_symbols
            )
            and row_order_id not in carry_in_execution_order_ids
            and row_execution_id not in carry_in_execution_ids
            and row_symbol not in carry_in_execution_symbols
        ):
            continue
        if (
            not (
                carry_in_execution_order_ids
                or carry_in_execution_ids
                or carry_in_execution_symbols
            )
            and carry_in_decision_lifecycle_ids
        ):
            row_decision_ids = _runtime_source_decision_ids([row])
            if row_decision_ids and not (
                row_decision_ids & carry_in_decision_lifecycle_ids
            ):
                continue
        event_type = _runtime_ledger_event_type(
            {str(key): value for key, value in row.items()}
        )
        lifecycle_row = _runtime_lifecycle_ledger_row(
            row,
            event_type=event_type,
            require_complete_fill=event_type in _RUNTIME_LEDGER_FILL_EVENTS,
        )
        if lifecycle_row is None and event_type in _RUNTIME_LEDGER_FILL_EVENTS:
            if (
                row_order_id in carry_in_execution_order_ids
                or row_execution_id in carry_in_execution_ids
                or (
                    not carry_in_execution_order_ids
                    and not carry_in_execution_ids
                    and not carry_in_execution_symbols
                    and _source_authority_order_event_row(row)
                )
            ):
                lifecycle_row = _runtime_lifecycle_ledger_row(
                    row,
                    event_type=event_type,
                )
                if lifecycle_row is not None:
                    lifecycle_row["source"] = "order_feed_lifecycle"
        if lifecycle_row is not None:
            carry_in_ledger_rows.append(lifecycle_row)
    combined_order_lifecycle_rows = [
        *(carry_in_order_lifecycle_rows or []),
        *(order_lifecycle_rows or []),
    ]
    combined_event_sourced_fill_economics_order_ids = (
        _event_sourced_fill_economics_order_ids(combined_order_lifecycle_rows)
    )
    for row in carry_in_execution_rows or []:
        ledger_fill, _ledger_event_times = _runtime_execution_ledger_fill_from_row(
            row,
            order_lifecycle_rows=combined_order_lifecycle_rows,
            event_sourced_fill_economics_order_ids=(
                combined_event_sourced_fill_economics_order_ids
            ),
        )
        if ledger_fill is not None:
            carry_in_ledger_rows.append(ledger_fill)
    if not event_times:
        return []
    unique_times = sorted(set(event_times))
    (
        carry_in_ledger_rows,
        active_carry_in_order_ids,
        active_carry_in_decision_ids,
    ) = _active_carry_in_ledger_rows(
        carry_in_ledger_rows,
        bucket_start=unique_times[0],
    )
    carry_in_execution_rows = _filter_carry_in_source_rows_for_active_lots(
        carry_in_execution_rows,
        active_order_ids=active_carry_in_order_ids,
        active_decision_ids=active_carry_in_decision_ids,
    )
    carry_in_decision_lifecycle_rows = _filter_carry_in_source_rows_for_active_lots(
        carry_in_decision_lifecycle_rows,
        active_order_ids=active_carry_in_order_ids,
        active_decision_ids=active_carry_in_decision_ids,
    )
    carry_in_order_lifecycle_rows = _filter_carry_in_source_rows_for_active_lots(
        carry_in_order_lifecycle_rows,
        active_order_ids=active_carry_in_order_ids,
        active_decision_ids=active_carry_in_decision_ids,
    )
    bucket_ranges = [(unique_times[0], unique_times[-1] + timedelta(microseconds=1))]
    realized_rows: list[dict[str, object]] = []
    for bucket in build_runtime_ledger_buckets(
        ledger_rows,
        bucket_ranges=bucket_ranges,
        group_by=("symbol",),
        require_order_lifecycle=True,
        carry_in_rows=carry_in_ledger_rows,
    ):
        if bucket.closed_trade_count <= 0 and not bucket.blockers:
            continue
        row = _runtime_ledger_tca_row_from_bucket(
            bucket=bucket,
            computed_at=unique_times[-1],
        )
        bucket_payload = row.get("runtime_ledger_bucket")
        source_context = _runtime_source_context_for_bucket(
            bucket=bucket,
            execution_rows=execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
        )
        source_account_labels = cast(list[str], source_context["source_account_labels"])
        source_decision_mode_counts = cast(
            dict[str, int], source_context["source_decision_mode_counts"]
        )
        source_decision_profit_proof_eligible = bool(
            source_context["source_decision_profit_proof_eligible"]
        )
        target_notional_sizing = cast(
            dict[str, object], source_context["paper_route_target_notional_sizing"]
        )
        target_notional_sizing_blockers = _metadata_text_list(
            target_notional_sizing.get("blockers")
        )
        source_refs = cast(list[str], source_context["source_refs"])
        source_row_counts = cast(dict[str, int], source_context["source_row_counts"])
        trade_decision_ids = cast(list[str], source_context["trade_decision_ids"])
        execution_ids = cast(list[str], source_context["execution_ids"])
        execution_tca_metric_ids = cast(
            list[str], source_context["execution_tca_metric_ids"]
        )
        execution_order_event_ids = cast(
            list[str], source_context["execution_order_event_ids"]
        )
        source_window_ids = cast(list[str], source_context["source_window_ids"])
        source_window_status_counts = cast(
            dict[str, int], source_context["source_window_status_counts"]
        )
        source_window_classification_counts = cast(
            dict[str, int], source_context["source_window_classification_counts"]
        )
        source_window_gap_count = int(source_context["source_window_gap_count"] or 0)
        source_window_gap_ranges = cast(
            list[Mapping[str, object]], source_context["source_window_gap_ranges"]
        )
        source_window_start = cast(datetime, source_context["source_window_start"])
        source_window_end = cast(datetime, source_context["source_window_end"])
        source_offsets = cast(
            list[Mapping[str, object]], source_context["source_offsets"]
        )
        source_materialization = cast(
            str | None, source_context["source_materialization"]
        )
        authority_class = cast(str | None, source_context["authority_class"])
        authority_reason = cast(str | None, source_context["authority_reason"])
        order_feed_lifecycle_complete = bool(
            source_context["order_feed_lifecycle_complete"]
        )
        fill_economics_complete = bool(source_context["fill_economics_complete"])
        execution_tca_required = bool(source_context["execution_tca_required"])
        execution_tca_complete = bool(source_context["execution_tca_complete"])
        bucket_order_feed_fill_lifecycle_blockers = cast(
            list[str], source_context["order_feed_fill_lifecycle_blockers"]
        )
        bucket_source_materialization_blockers = list(
            bucket_order_feed_fill_lifecycle_blockers
        )
        if (
            execution_tca_required
            and not execution_tca_complete
            and EXECUTION_TCA_MISSING_BLOCKER
            not in bucket_source_materialization_blockers
        ):
            bucket_source_materialization_blockers.append(EXECUTION_TCA_MISSING_BLOCKER)
        if (
            execution_tca_required
            and not execution_tca_complete
            and RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER
            not in bucket_source_materialization_blockers
        ):
            bucket_source_materialization_blockers.append(
                RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER
            )
        equity_denominator = cast(
            tuple[Decimal, str] | None, source_context["equity_denominator"]
        )
        if flat_start_authority is not None and isinstance(bucket_payload, Mapping):
            row.update(flat_start_authority)
            bucket_payload = {
                **dict(bucket_payload),
                **flat_start_authority,
            }
            row["runtime_ledger_bucket"] = bucket_payload
        if source_account_labels and isinstance(bucket_payload, Mapping):
            bucket_payload = {
                **dict(bucket_payload),
                "source_account_labels": source_account_labels,
            }
            if len(source_account_labels) == 1:
                bucket_payload["source_account_label"] = source_account_labels[0]
            row["runtime_ledger_bucket"] = bucket_payload
        if source_decision_mode_counts:
            row["source_decision_mode_counts"] = source_decision_mode_counts
            row["profit_proof_eligible"] = source_decision_profit_proof_eligible
            if isinstance(bucket_payload, Mapping):
                source_decision_mode = next(
                    iter(source_decision_mode_counts),
                    None,
                )
                bucket_payload = {
                    **dict(bucket_payload),
                    "source_decision_mode_counts": source_decision_mode_counts,
                    "profit_proof_eligible": source_decision_profit_proof_eligible,
                }
                if len(source_decision_mode_counts) == 1:
                    row["source_decision_mode"] = source_decision_mode
                    bucket_payload["source_decision_mode"] = source_decision_mode
                if not source_decision_profit_proof_eligible:
                    blockers = list(bucket_payload.get("blockers") or [])
                    if (
                        SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                        not in blockers
                    ):
                        blockers.append(
                            SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                        )
                    bucket_payload["blockers"] = blockers
                    row["runtime_ledger_blockers"] = blockers
                    row["post_cost_promotion_eligible"] = False
                    row["promotion_blocker"] = (
                        SOURCE_DECISION_MODE_NOT_PROFIT_PROOF_ELIGIBLE_BLOCKER
                    )
                row["runtime_ledger_bucket"] = bucket_payload
        if target_notional_sizing.get("requires_target_notional_sizing"):
            row["paper_route_target_notional_sizing"] = target_notional_sizing
            if isinstance(bucket_payload, Mapping):
                bucket_payload = {
                    **dict(bucket_payload),
                    "paper_route_target_notional_sizing": target_notional_sizing,
                }
                if target_notional_sizing_blockers:
                    blockers = list(bucket_payload.get("blockers") or [])
                    for blocker in target_notional_sizing_blockers:
                        if blocker not in blockers:
                            blockers.append(blocker)
                    bucket_payload["blockers"] = blockers
                    row["runtime_ledger_blockers"] = blockers
                    row["post_cost_promotion_eligible"] = False
                    row["promotion_blocker"] = target_notional_sizing_blockers[0]
                row["runtime_ledger_bucket"] = bucket_payload
        if isinstance(bucket_payload, Mapping):
            bucket_payload = _with_runtime_ledger_source_authority_context(
                bucket_payload,
                source_window_start=source_window_start,
                source_window_end=source_window_end,
                source_refs=source_refs,
                source_row_counts=source_row_counts,
                trade_decision_ids=trade_decision_ids,
                execution_ids=execution_ids,
                execution_tca_metric_ids=execution_tca_metric_ids,
                execution_order_event_ids=execution_order_event_ids,
                source_window_ids=source_window_ids,
                source_offsets=source_offsets,
                source_window_status_counts=source_window_status_counts,
                source_window_classification_counts=source_window_classification_counts,
                source_window_gap_count=source_window_gap_count,
                source_window_gap_ranges=source_window_gap_ranges,
                order_feed_lifecycle_complete=order_feed_lifecycle_complete,
                execution_economics_complete=fill_economics_complete,
                execution_tca_required=execution_tca_required,
                source_materialization=source_materialization,
                authority_class=authority_class,
                authority_reason=authority_reason,
            )
            row["runtime_ledger_bucket"] = bucket_payload
            row["runtime_ledger_blockers"] = _metadata_text_list(
                bucket_payload.get("blockers")
            )
        source_backed_runtime_ledger = (
            allow_authoritative_runtime_ledger_materialization
            and fill_economics_complete
            and not bucket_source_materialization_blockers
            and isinstance(bucket_payload, Mapping)
            and not runtime_ledger_promotion_source_authority_blockers(bucket_payload)
        )
        event_sourced_runtime_ledger = (
            source_backed_runtime_ledger
            and isinstance(bucket_payload, Mapping)
            and _runtime_ledger_bucket_profit_proof_present(bucket_payload)
        )
        if event_sourced_runtime_ledger:
            row["authoritative"] = True
            row["authority_reason"] = "event_sourced_runtime_ledger_profit_proof"
            row["pnl_derivation"] = "execution_order_events_runtime_ledger"
            row["post_cost_promotion_eligible"] = True
            row["runtime_ledger_blockers"] = []
            row.pop("promotion_blocker", None)
            if isinstance(bucket_payload, Mapping):
                runtime_bucket = {
                    **dict(bucket_payload),
                    "authoritative": True,
                    "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                    "pnl_derivation": "execution_order_events_runtime_ledger",
                    "source_materialization": (
                        source_materialization or "source_execution_lifecycle"
                    ),
                }
                if equity_denominator is not None:
                    runtime_bucket["account_equity"] = str(equity_denominator[0])
                    runtime_bucket["account_equity_source"] = equity_denominator[1]
                row["runtime_ledger_bucket"] = runtime_bucket
        elif source_backed_runtime_ledger:
            row["post_cost_expectancy_basis"] = POST_COST_BASIS_RUNTIME_LEDGER
            row["post_cost_promotion_eligible"] = False
            row["authoritative"] = False
            row["authority_reason"] = (
                "source_execution_lifecycle_materialized_runtime_ledger"
            )
            row["pnl_derivation"] = "execution_order_events_runtime_ledger"
            blockers = list(row.get("runtime_ledger_blockers") or [])
            row["runtime_ledger_blockers"] = blockers
            if blockers:
                row["promotion_blocker"] = blockers[0]
            else:
                row.pop("promotion_blocker", None)
            if isinstance(bucket_payload, Mapping):
                runtime_bucket = {
                    **dict(bucket_payload),
                    "blockers": blockers,
                    "pnl_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                    "authoritative": False,
                    "authority_reason": (
                        "source_execution_lifecycle_materialized_runtime_ledger"
                    ),
                    "pnl_derivation": "execution_order_events_runtime_ledger",
                    "source_materialization": (
                        source_materialization or "source_execution_lifecycle"
                    ),
                }
                if equity_denominator is not None:
                    runtime_bucket["account_equity"] = str(equity_denominator[0])
                    runtime_bucket["account_equity_source"] = equity_denominator[1]
                row["runtime_ledger_bucket"] = runtime_bucket
        else:
            row["post_cost_expectancy_basis"] = POST_COST_BASIS_EXECUTION_RECONSTRUCTION
            row["post_cost_promotion_eligible"] = False
            row["authoritative"] = False
            row["authority_reason"] = (
                "execution_reconstruction_not_runtime_ledger_proof"
            )
            row["pnl_derivation"] = "execution_reconstructed_from_execution_rows"
            row["promotion_blocker"] = (
                "execution_reconstruction_not_runtime_ledger_proof"
            )
            blockers = list(row.get("runtime_ledger_blockers") or [])
            for blocker in bucket_source_materialization_blockers:
                if blocker not in blockers:
                    blockers.append(blocker)
            if isinstance(bucket_payload, Mapping):
                for blocker in runtime_ledger_promotion_source_authority_blockers(
                    bucket_payload
                ):
                    if blocker not in blockers:
                        blockers.append(blocker)
            if "execution_reconstruction_not_runtime_ledger_proof" not in blockers:
                blockers.append("execution_reconstruction_not_runtime_ledger_proof")
            row["runtime_ledger_blockers"] = blockers
            if isinstance(bucket_payload, Mapping):
                bucket_payload = dict(bucket_payload)
                bucket_payload["blockers"] = blockers
                bucket_payload["pnl_basis"] = POST_COST_BASIS_EXECUTION_RECONSTRUCTION
                bucket_payload["authoritative"] = False
                bucket_payload["authority_reason"] = (
                    "execution_reconstruction_not_runtime_ledger_proof"
                )
                if equity_denominator is not None:
                    bucket_payload["account_equity"] = str(equity_denominator[0])
                    bucket_payload["account_equity_source"] = equity_denominator[1]
                row["runtime_ledger_bucket"] = bucket_payload
        realized_rows.append(row)
    return realized_rows
