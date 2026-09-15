#!/usr/bin/env python3
"""Query source runtime activity for hypothesis runtime-window imports."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import psycopg

from scripts.hypothesis_runtime_window_import.common import (
    _attach_source_lineage_context,
    _execution_row_has_fill,
    _flat_start_position_snapshot_authority,
    _metadata_symbol_list,
    _runtime_ledger_event_type,
    _source_identifier_values,
)
from scripts.hypothesis_runtime_window_import.constants import (
    EXECUTION_ELIGIBLE_DECISION_STATUSES,
    RUNTIME_LEDGER_CARRY_IN_LOOKBACK,
    RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD,
    _RUNTIME_LEDGER_FILL_EVENTS,
)
from scripts.hypothesis_runtime_window_import.lifecycle_rows import (
    _order_feed_fill_lifecycle_blockers,
    _strategy_relevant_unlinked_fill_lifecycle_rows,
)
from scripts.hypothesis_runtime_window_import.realized_pnl import (
    _build_realized_strategy_pnl_rows,
)
from scripts.hypothesis_runtime_window_import.row_materialization import (
    _retarget_runtime_ledger_tca_rows,
    _retarget_source_rows_for_materialization,
)
from scripts.hypothesis_runtime_window_import.source_decisions import (
    _filter_source_rows_for_runtime_window,
    _source_row_matches_lineage,
)
from scripts.hypothesis_runtime_window_import.source_row_filters import (
    _flat_start_position_snapshot_from_cursor,
)
from scripts.hypothesis_runtime_window_import.source_windows import (
    _decision_lifecycle_query_row,
    _decision_lifecycle_query_row_has_time,
    _execution_query_row,
    _execution_query_row_has_tca_ref,
    _execution_query_row_has_time,
    _order_lifecycle_query_row,
    _order_lifecycle_query_row_has_time,
)


def _render_source_activity_sql(template_name: str, **clauses: str) -> str:
    template_path = Path(__file__).with_name("sql") / template_name
    return template_path.read_text(encoding="utf-8").format(**clauses)


def _query_timestamps(
    *,
    dsn: str,
    strategy_names: list[str],
    account_label: str,
    target_account_label: str | None = None,
    window_start: datetime,
    window_end: datetime,
    symbols: Sequence[str] | None = None,
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
    require_source_lineage: bool = False,
    allow_authoritative_runtime_ledger_materialization: bool = False,
    source_activity_diagnostics: dict[str, Any] | None = None,
) -> tuple[list[datetime], list[datetime], list[dict[str, object]]]:
    if not strategy_names:
        raise RuntimeError("strategy_name_not_configured")
    source_account_label = account_label
    materialized_account_label = (
        str(target_account_label or "").strip() or source_account_label
    )
    # Source DB queries must stay on the account that produced the real activity.
    # Rows are retargeted below when the governance bucket should be materialized
    # under a distinct account label (for example a paper/live-paper source account
    # feeding the TORGHUT_SIM proof ledger).
    source_query_account_label = source_account_label
    decisions: list[datetime] = []
    executions: list[datetime] = []
    tca_rows: list[dict[str, object]] = []
    execution_rows: list[dict[str, object]] = []
    decision_lifecycle_rows: list[dict[str, object]] = []
    order_lifecycle_rows: list[dict[str, object]] = []
    unlinked_order_lifecycle_rows: list[dict[str, object]] = []
    carry_in_execution_rows: list[dict[str, object]] = []
    carry_in_decision_lifecycle_rows: list[dict[str, object]] = []
    carry_in_order_lifecycle_rows: list[dict[str, object]] = []
    flat_start_position_snapshot: dict[str, object] | None = None
    carry_in_window_start = window_start - RUNTIME_LEDGER_CARRY_IN_LOOKBACK
    source_activity_window_end = (
        window_end + RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD
        if allow_authoritative_runtime_ledger_materialization
        else window_end
    )
    symbol_filter = _metadata_symbol_list(symbols or ())
    if source_activity_diagnostics is not None:
        source_activity_diagnostics.update(
            {
                "strategy_name_candidates": strategy_names,
                "account_label": materialized_account_label,
                "source_account_label": source_account_label,
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "source_activity_window_end": source_activity_window_end.isoformat(),
                "carry_in_window_start": carry_in_window_start.isoformat(),
                "carry_in_window_end": window_start.isoformat(),
                "source_activity_symbol_filter": symbol_filter,
                "candidate_id": candidate_id,
                "hypothesis_id": hypothesis_id,
                "source_lineage_required": require_source_lineage,
                "authoritative_runtime_ledger_materialization_allowed": (
                    allow_authoritative_runtime_ledger_materialization
                ),
            }
        )
    decision_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)" if symbol_filter else ""
    )
    execution_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)"
        "\n                  and upper(e.symbol) = any(%s)"
        if symbol_filter
        else ""
    )
    order_event_symbol_clause = (
        "\n                  and upper(d.symbol) = any(%s)"
        "\n                  and upper(coalesce(oe.symbol, e.symbol, d.symbol)) = any(%s)"
        if symbol_filter
        else ""
    )
    unlinked_order_event_symbol_clause = (
        "\n                  and upper(oe.symbol) = any(%s)" if symbol_filter else ""
    )
    decision_symbol_params: tuple[object, ...] = (
        (symbol_filter,) if symbol_filter else ()
    )
    execution_symbol_params: tuple[object, ...] = (
        (symbol_filter, symbol_filter) if symbol_filter else ()
    )
    order_event_symbol_params: tuple[object, ...] = (
        (symbol_filter, symbol_filter) if symbol_filter else ()
    )
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                _render_source_activity_sql(
                    "decision_lifecycle.sql",
                    decision_symbol_clause=decision_symbol_clause,
                ),
                (
                    strategy_names,
                    source_query_account_label,
                    list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
                    window_start,
                    source_activity_window_end,
                    *decision_symbol_params,
                ),
            )
            decision_lifecycle_rows = [
                _decision_lifecycle_query_row(row)
                for row in cur.fetchall()
                if _decision_lifecycle_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["decision_rows_before_lineage_filter"] = (
                    len(decision_lifecycle_rows)
                )
            cur.execute(
                _render_source_activity_sql(
                    "execution_lifecycle.sql",
                    execution_symbol_clause=execution_symbol_clause,
                ),
                (
                    strategy_names,
                    source_query_account_label,
                    source_query_account_label,
                    window_start,
                    source_activity_window_end,
                    *execution_symbol_params,
                ),
            )
            execution_rows = [
                _execution_query_row(row)
                for row in cur.fetchall()
                if _execution_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics["execution_rows_before_lineage_filter"] = (
                    len(execution_rows)
                )
                source_activity_diagnostics[
                    "fill_execution_rows_before_lineage_filter"
                ] = sum(1 for row in execution_rows if _execution_row_has_fill(row))
                source_activity_diagnostics[
                    "execution_tca_rows_before_lineage_filter"
                ] = sum(
                    1 for row in execution_rows if _execution_query_row_has_tca_ref(row)
                )
            cur.execute(
                _render_source_activity_sql(
                    "order_lifecycle.sql",
                    order_event_symbol_clause=order_event_symbol_clause,
                ),
                (
                    source_query_account_label,
                    source_query_account_label,
                    strategy_names,
                    source_query_account_label,
                    source_account_label,
                    window_start,
                    source_activity_window_end,
                    *order_event_symbol_params,
                ),
            )
            order_lifecycle_rows = [
                _order_lifecycle_query_row(row)
                for row in cur.fetchall()
                if _order_lifecycle_query_row_has_time(row)
            ]
            if source_activity_diagnostics is not None:
                source_activity_diagnostics[
                    "order_lifecycle_rows_before_lineage_filter"
                ] = len(order_lifecycle_rows)
                source_activity_diagnostics[
                    "fill_order_lifecycle_rows_before_lineage_filter"
                ] = sum(
                    1
                    for row in order_lifecycle_rows
                    if _runtime_ledger_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS
                )
            (
                decision_lifecycle_rows,
                execution_rows,
                order_lifecycle_rows,
                post_window_closeout_diagnostics,
            ) = _filter_source_rows_for_runtime_window(
                decision_rows=decision_lifecycle_rows,
                execution_rows=execution_rows,
                order_lifecycle_rows=order_lifecycle_rows,
                window_end=window_end,
                closeout_end=source_activity_window_end,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
                require_source_lineage=require_source_lineage,
            )
            if source_activity_diagnostics is not None:
                source_activity_diagnostics.update(post_window_closeout_diagnostics)
                source_activity_diagnostics["decision_rows_after_lineage_filter"] = len(
                    decision_lifecycle_rows
                )
                source_activity_diagnostics["execution_rows_after_lineage_filter"] = (
                    len(execution_rows)
                )
                source_activity_diagnostics[
                    "fill_execution_rows_after_lineage_filter"
                ] = sum(1 for row in execution_rows if _execution_row_has_fill(row))
                source_activity_diagnostics[
                    "execution_tca_rows_after_lineage_filter"
                ] = sum(
                    1 for row in execution_rows if _execution_query_row_has_tca_ref(row)
                )
                source_activity_diagnostics[
                    "order_lifecycle_rows_after_lineage_filter"
                ] = len(order_lifecycle_rows)
                source_activity_diagnostics[
                    "fill_order_lifecycle_rows_after_lineage_filter"
                ] = sum(
                    1
                    for row in order_lifecycle_rows
                    if _runtime_ledger_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS
                )
            decision_lifecycle_rows = _attach_source_lineage_context(
                decision_lifecycle_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            execution_rows = _attach_source_lineage_context(
                execution_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            order_lifecycle_rows = _attach_source_lineage_context(
                order_lifecycle_rows,
                candidate_id=candidate_id,
                hypothesis_id=hypothesis_id,
            )
            decisions = []
            for row in decision_lifecycle_rows:
                computed_at = row.get("computed_at")
                if isinstance(computed_at, datetime):
                    decisions.append(computed_at)
            executions = []
            for row in execution_rows:
                execution_event_at = row.get("execution_event_at")
                if isinstance(execution_event_at, datetime):
                    executions.append(execution_event_at)
            if allow_authoritative_runtime_ledger_materialization:
                cur.execute(
                    _render_source_activity_sql(
                        "decision_lifecycle.sql",
                        decision_symbol_clause=decision_symbol_clause,
                    ),
                    (
                        strategy_names,
                        source_query_account_label,
                        list(EXECUTION_ELIGIBLE_DECISION_STATUSES),
                        carry_in_window_start,
                        window_start,
                        *decision_symbol_params,
                    ),
                )
                carry_in_decision_lifecycle_rows = [
                    _decision_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _decision_lifecycle_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_decision_rows_before_lineage_filter"
                    ] = len(carry_in_decision_lifecycle_rows)
                carry_in_decision_lifecycle_rows = [
                    row
                    for row in carry_in_decision_lifecycle_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_decision_rows_after_lineage_filter"
                    ] = len(carry_in_decision_lifecycle_rows)
                carry_in_decision_lifecycle_rows = _attach_source_lineage_context(
                    carry_in_decision_lifecycle_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
                cur.execute(
                    _render_source_activity_sql(
                        "execution_lifecycle.sql",
                        execution_symbol_clause=execution_symbol_clause,
                    ),
                    (
                        strategy_names,
                        source_query_account_label,
                        source_query_account_label,
                        carry_in_window_start,
                        window_start,
                        *execution_symbol_params,
                    ),
                )
                carry_in_execution_rows = [
                    _execution_query_row(row)
                    for row in cur.fetchall()
                    if _execution_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_execution_rows_before_lineage_filter"
                    ] = len(carry_in_execution_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_execution_rows_before_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_row_has_fill(row)
                    )
                    source_activity_diagnostics[
                        "carry_in_execution_tca_rows_before_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_query_row_has_tca_ref(row)
                    )
                carry_in_execution_rows = [
                    row
                    for row in carry_in_execution_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_execution_rows_after_lineage_filter"
                    ] = len(carry_in_execution_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_execution_rows_after_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_row_has_fill(row)
                    )
                    source_activity_diagnostics[
                        "carry_in_execution_tca_rows_after_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_execution_rows
                        if _execution_query_row_has_tca_ref(row)
                    )
                carry_in_execution_rows = _attach_source_lineage_context(
                    carry_in_execution_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
                cur.execute(
                    _render_source_activity_sql(
                        "order_lifecycle.sql",
                        order_event_symbol_clause=order_event_symbol_clause,
                    ),
                    (
                        source_query_account_label,
                        source_query_account_label,
                        strategy_names,
                        source_query_account_label,
                        source_account_label,
                        carry_in_window_start,
                        window_start,
                        *order_event_symbol_params,
                    ),
                )
                carry_in_order_lifecycle_rows = [
                    _order_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _order_lifecycle_query_row_has_time(row)
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_order_lifecycle_rows_before_lineage_filter"
                    ] = len(carry_in_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_order_lifecycle_rows_before_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_order_lifecycle_rows
                        if _runtime_ledger_event_type(row)
                        in _RUNTIME_LEDGER_FILL_EVENTS
                    )
                carry_in_order_lifecycle_rows = [
                    row
                    for row in carry_in_order_lifecycle_rows
                    if _source_row_matches_lineage(
                        row,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                        require_source_lineage=require_source_lineage,
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "carry_in_order_lifecycle_rows_after_lineage_filter"
                    ] = len(carry_in_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "carry_in_fill_order_lifecycle_rows_after_lineage_filter"
                    ] = sum(
                        1
                        for row in carry_in_order_lifecycle_rows
                        if _runtime_ledger_event_type(row)
                        in _RUNTIME_LEDGER_FILL_EVENTS
                    )
                carry_in_order_lifecycle_rows = _attach_source_lineage_context(
                    carry_in_order_lifecycle_rows,
                    candidate_id=candidate_id,
                    hypothesis_id=hypothesis_id,
                )
            if symbol_filter:
                cur.execute(
                    _render_source_activity_sql(
                        "unlinked_order_lifecycle.sql",
                        unlinked_order_event_symbol_clause=unlinked_order_event_symbol_clause,
                    ),
                    (
                        source_query_account_label,
                        source_query_account_label,
                        source_account_label,
                        window_start,
                        window_end,
                        *([symbol_filter] if symbol_filter else []),
                    ),
                )
                unlinked_order_lifecycle_rows = [
                    _order_lifecycle_query_row(row)
                    for row in cur.fetchall()
                    if _order_lifecycle_query_row_has_time(row)
                ]
                strategy_unlinked_order_lifecycle_rows = (
                    _strategy_relevant_unlinked_fill_lifecycle_rows(
                        execution_rows=execution_rows,
                        order_lifecycle_rows=order_lifecycle_rows,
                        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
                        candidate_id=candidate_id,
                        hypothesis_id=hypothesis_id,
                    )
                )
                strategy_unlinked_ids = set(
                    _source_identifier_values(
                        strategy_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                )
                unattributed_unlinked_order_lifecycle_rows = [
                    row
                    for row in unlinked_order_lifecycle_rows
                    if not (
                        set(
                            _source_identifier_values(
                                [row],
                                "execution_order_event_id",
                                "event_fingerprint",
                            )
                        )
                        & strategy_unlinked_ids
                    )
                ]
                if source_activity_diagnostics is not None:
                    source_activity_diagnostics[
                        "order_feed_unlinked_fill_lifecycle_count"
                    ] = len(unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unlinked_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                    source_activity_diagnostics[
                        "order_feed_unlinked_strategy_fill_lifecycle_count"
                    ] = len(strategy_unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unlinked_strategy_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        strategy_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                    source_activity_diagnostics[
                        "order_feed_unattributed_fill_lifecycle_count"
                    ] = len(unattributed_unlinked_order_lifecycle_rows)
                    source_activity_diagnostics[
                        "order_feed_unattributed_fill_lifecycle_event_ids"
                    ] = _source_identifier_values(
                        unattributed_unlinked_order_lifecycle_rows,
                        "execution_order_event_id",
                        "event_fingerprint",
                    )
                unlinked_order_lifecycle_rows = strategy_unlinked_order_lifecycle_rows
            if source_activity_diagnostics is not None:
                lifecycle_blockers = _order_feed_fill_lifecycle_blockers(
                    execution_rows=execution_rows,
                    order_lifecycle_rows=order_lifecycle_rows,
                    unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
                )
                source_activity_diagnostics["order_feed_fill_lifecycle_blockers"] = (
                    lifecycle_blockers
                )
            if allow_authoritative_runtime_ledger_materialization:
                try:
                    flat_start_position_snapshot = (
                        _flat_start_position_snapshot_from_cursor(
                            cur,
                            account_label=source_query_account_label,
                            window_start=window_start,
                        )
                    )
                except Exception as exc:
                    flat_start_position_snapshot = None
                    if source_activity_diagnostics is not None:
                        source_activity_diagnostics[
                            "flat_start_position_snapshot_query_error"
                        ] = type(exc).__name__
                if source_activity_diagnostics is not None:
                    flat_start_authority = _flat_start_position_snapshot_authority(
                        flat_start_position_snapshot
                    )
                    source_activity_diagnostics[
                        "flat_start_position_snapshot_present"
                    ] = flat_start_position_snapshot is not None
                    if flat_start_position_snapshot is not None:
                        source_activity_diagnostics.update(
                            {
                                "flat_start_position_snapshot_id": (
                                    flat_start_position_snapshot.get("snapshot_id")
                                ),
                                "flat_start_position_snapshot_as_of": (
                                    flat_start_position_snapshot.get("snapshot_as_of")
                                ),
                                "flat_start_position_snapshot_source": (
                                    flat_start_position_snapshot.get("snapshot_source")
                                ),
                                "flat_start_position_snapshot_offset_seconds": (
                                    flat_start_position_snapshot.get(
                                        "snapshot_offset_seconds"
                                    )
                                ),
                                "flat_start_position_snapshot_flat": (
                                    flat_start_position_snapshot.get("flat")
                                ),
                                "flat_start_position_snapshot_position_count": (
                                    flat_start_position_snapshot.get("position_count")
                                ),
                                "flat_start_position_snapshot_blockers": (
                                    flat_start_position_snapshot.get("blockers")
                                ),
                            }
                        )
                    if flat_start_authority is not None:
                        source_activity_diagnostics.update(flat_start_authority)
    decision_lifecycle_rows = _retarget_source_rows_for_materialization(
        decision_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    execution_rows = _retarget_source_rows_for_materialization(
        execution_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    order_lifecycle_rows = _retarget_source_rows_for_materialization(
        order_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_decision_lifecycle_rows = _retarget_source_rows_for_materialization(
        carry_in_decision_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_execution_rows = _retarget_source_rows_for_materialization(
        carry_in_execution_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    carry_in_order_lifecycle_rows = _retarget_source_rows_for_materialization(
        carry_in_order_lifecycle_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    tca_rows = _retarget_runtime_ledger_tca_rows(
        tca_rows,
        target_account_label=materialized_account_label,
        source_account_label=source_account_label,
    )
    tca_rows.extend(
        _build_realized_strategy_pnl_rows(
            execution_rows,
            decision_lifecycle_rows=decision_lifecycle_rows,
            order_lifecycle_rows=order_lifecycle_rows,
            unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
            carry_in_execution_rows=carry_in_execution_rows,
            carry_in_decision_lifecycle_rows=carry_in_decision_lifecycle_rows,
            carry_in_order_lifecycle_rows=carry_in_order_lifecycle_rows,
            flat_start_position_snapshot=flat_start_position_snapshot,
            allow_authoritative_runtime_ledger_materialization=(
                allow_authoritative_runtime_ledger_materialization
            ),
        )
    )
    return decisions, executions, tca_rows
