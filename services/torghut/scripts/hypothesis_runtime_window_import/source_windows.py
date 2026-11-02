from __future__ import annotations

from typing import Mapping, Sequence, cast

from scripts.hypothesis_runtime_window_import.common import (
    _first_text,
    _nonnegative_int,
    _text_or_none,
)


def _unique_source_window_rows(
    rows: Sequence[Mapping[str, object]] | None,
) -> list[Mapping[str, object]]:
    unique_rows: list[Mapping[str, object]] = []
    seen: set[str] = set()
    for row in rows or ():
        source_window_id = _text_or_none(row.get("source_window_id"))
        if source_window_id is None:
            continue
        if source_window_id in seen:
            continue
        seen.add(source_window_id)
        unique_rows.append(row)
    return unique_rows


def _source_window_status_counts(
    rows: Sequence[Mapping[str, object]] | None,
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in _unique_source_window_rows(rows):
        status = _text_or_none(row.get("source_window_status"))
        if status is None:
            continue
        counts[status] = counts.get(status, 0) + 1
    return dict(sorted(counts.items()))


def _source_window_classification_counts(
    rows: Sequence[Mapping[str, object]] | None,
) -> dict[str, int]:
    field_names = {
        "inserted": "source_window_inserted_count",
        "duplicate": "source_window_duplicate_count",
        "malformed_json": "source_window_malformed_count",
        "missing_trade_update_payload": "source_window_missing_payload_count",
        "missing_order_identity": "source_window_missing_identity_count",
        "out_of_scope_account": "source_window_out_of_scope_account_count",
        "unlinked_execution": "source_window_unlinked_execution_count",
        "unlinked_decision": "source_window_unlinked_decision_count",
        "failed_unhandled": "source_window_failed_unhandled_count",
        "dropped": "source_window_dropped_count",
    }
    counts: dict[str, int] = {}
    for row in _unique_source_window_rows(rows):
        for classification, field_name in field_names.items():
            count = _nonnegative_int(row.get(field_name))
            if count > 0:
                counts[classification] = counts.get(classification, 0) + count
    return dict(sorted(counts.items()))


def _source_window_gap_count(
    rows: Sequence[Mapping[str, object]] | None,
) -> int:
    return sum(
        _nonnegative_int(row.get("source_window_gap_count"))
        for row in _unique_source_window_rows(rows)
    )


def _source_window_gap_ranges(
    rows: Sequence[Mapping[str, object]] | None,
) -> list[dict[str, object]]:
    ranges: list[dict[str, object]] = []
    for row in _unique_source_window_rows(rows):
        gap_ranges = row.get("source_window_gap_ranges")
        if not isinstance(gap_ranges, Sequence) or isinstance(
            gap_ranges, (str, bytes, bytearray)
        ):
            continue
        for item in cast(Sequence[object], gap_ranges):
            if isinstance(item, Mapping):
                ranges.append(dict(item))
    return ranges


def _decision_lifecycle_query_row(row: Sequence[object]) -> dict[str, object]:
    if len(row) >= 7:
        return {
            "trade_decision_id": str(row[0]),
            "computed_at": row[1],
            "event_type": "decision",
            "symbol": row[2],
            "account_label": row[3],
            "strategy_id": row[4],
            "decision_hash": row[5],
            "decision_json": row[6],
        }
    return {
        "trade_decision_id": str(row[4]),
        "computed_at": row[0],
        "event_type": "decision",
        "symbol": row[1],
        "account_label": row[2],
        "strategy_id": row[3],
        "decision_hash": row[4],
        "decision_json": row[5],
    }


def _decision_lifecycle_query_row_has_time(row: Sequence[object]) -> bool:
    return (row[1] if len(row) >= 7 else row[0]) is not None


def _execution_query_row(row: Sequence[object]) -> dict[str, object]:
    if len(row) >= 20:
        return {
            "execution_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "decision_created_at": row[2],
            "computed_at": row[3],
            "execution_event_at": row[3],
            "execution_created_at": row[4],
            "symbol": row[5],
            "side": row[6],
            "filled_qty": row[7],
            "avg_fill_price": row[8],
            "shortfall_notional": row[9],
            "execution_audit_json": row[10],
            "raw_order": row[11],
            "account_label": row[12],
            "strategy_id": row[13],
            "decision_hash": row[14],
            "decision_json": row[15],
            "alpaca_order_id": row[16],
            "client_order_id": row[17],
            "order_status": row[18],
            "execution_tca_metric_id": str(row[19]) if row[19] is not None else None,
        }
    if len(row) >= 19:
        return {
            "execution_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "decision_created_at": row[2],
            "computed_at": row[3],
            "execution_event_at": row[3],
            "execution_created_at": row[4],
            "symbol": row[5],
            "side": row[6],
            "filled_qty": row[7],
            "avg_fill_price": row[8],
            "shortfall_notional": row[9],
            "execution_audit_json": row[10],
            "raw_order": row[11],
            "account_label": row[12],
            "strategy_id": row[13],
            "decision_hash": row[14],
            "decision_json": row[15],
            "alpaca_order_id": row[16],
            "client_order_id": row[17],
            "order_status": row[18],
        }
    return {
        "execution_id": None,
        "trade_decision_id": str(row[12]),
        "decision_created_at": row[0],
        "computed_at": row[1],
        "execution_event_at": row[1],
        "execution_created_at": row[2],
        "symbol": row[3],
        "side": row[4],
        "filled_qty": row[5],
        "avg_fill_price": row[6],
        "shortfall_notional": row[7],
        "execution_audit_json": row[8],
        "raw_order": row[9],
        "account_label": row[10],
        "strategy_id": row[11],
        "decision_hash": row[12],
        "decision_json": row[13],
        "alpaca_order_id": row[14],
        "client_order_id": row[15],
        "order_status": row[16],
    }


def _execution_query_row_has_time(row: Sequence[object]) -> bool:
    return (row[3] if len(row) >= 19 else row[1]) is not None


def _execution_query_row_has_tca_ref(row: Mapping[str, object]) -> bool:
    return (
        _first_text(
            row,
            "execution_tca_metric_id",
            "execution_tca_metric_ref",
            "execution_tca_id",
        )
        is not None
    )


def _source_window_query_context(
    row: Sequence[object],
    *,
    start_index: int,
) -> dict[str, object]:
    if len(row) < start_index + 15:
        return {}
    return {
        "source_window_status": row[start_index],
        "source_window_status_reason": row[start_index + 1],
        "source_window_consumed_count": row[start_index + 2],
        "source_window_inserted_count": row[start_index + 3],
        "source_window_duplicate_count": row[start_index + 4],
        "source_window_malformed_count": row[start_index + 5],
        "source_window_missing_payload_count": row[start_index + 6],
        "source_window_missing_identity_count": row[start_index + 7],
        "source_window_out_of_scope_account_count": row[start_index + 8],
        "source_window_unlinked_execution_count": row[start_index + 9],
        "source_window_unlinked_decision_count": row[start_index + 10],
        "source_window_failed_unhandled_count": row[start_index + 11],
        "source_window_dropped_count": row[start_index + 12],
        "source_window_gap_count": row[start_index + 13],
        "source_window_gap_ranges": row[start_index + 14],
    }


def _order_lifecycle_query_row(row: Sequence[object]) -> dict[str, object]:
    if len(row) >= 28:
        return {
            "execution_order_event_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "execution_id": str(row[2]) if row[2] is not None else None,
            "event_ts": row[3],
            "symbol": row[4],
            "account_label": row[5],
            "strategy_id": row[6],
            "decision_hash": row[7],
            "decision_json": row[8],
            "alpaca_order_id": row[9],
            "client_order_id": row[10],
            "event_type": row[11],
            "order_status": row[12],
            "side": row[13],
            "qty": row[14],
            "filled_qty": row[15],
            "filled_qty_delta": row[16],
            "avg_fill_price": row[17],
            "filled_notional_delta": row[18],
            "fill_quantity_basis": row[19],
            "event_fingerprint": row[20],
            "source_topic": row[21],
            "source_partition": row[22],
            "source_offset": row[23],
            "source_window_id": str(row[24]) if row[24] is not None else None,
            "raw_event": row[25],
            "execution_audit_json": row[26],
            "raw_order": row[27],
            **_source_window_query_context(row, start_index=28),
        }
    if len(row) >= 25:
        return {
            "execution_order_event_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "execution_id": str(row[2]) if row[2] is not None else None,
            "event_ts": row[3],
            "symbol": row[4],
            "account_label": row[5],
            "strategy_id": row[6],
            "decision_hash": row[7],
            "decision_json": row[8],
            "alpaca_order_id": row[9],
            "client_order_id": row[10],
            "event_type": row[11],
            "order_status": row[12],
            "side": row[13],
            "qty": row[14],
            "filled_qty": row[15],
            "avg_fill_price": row[16],
            "event_fingerprint": row[17],
            "source_topic": row[18],
            "source_partition": row[19],
            "source_offset": row[20],
            "source_window_id": str(row[21]) if row[21] is not None else None,
            "raw_event": row[22],
            "execution_audit_json": row[23],
            "raw_order": row[24],
        }
    if len(row) >= 21:
        return {
            "execution_order_event_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "execution_id": str(row[2]) if row[2] is not None else None,
            "event_ts": row[3],
            "symbol": row[4],
            "account_label": row[5],
            "strategy_id": row[6],
            "decision_hash": row[7],
            "decision_json": row[8],
            "alpaca_order_id": row[9],
            "client_order_id": row[10],
            "event_type": row[11],
            "order_status": row[12],
            "event_fingerprint": row[13],
            "source_topic": row[14],
            "source_partition": row[15],
            "source_offset": row[16],
            "source_window_id": str(row[17]) if row[17] is not None else None,
            "raw_event": row[18],
            "execution_audit_json": row[19],
            "raw_order": row[20],
        }
    if len(row) >= 20:
        return {
            "execution_order_event_id": str(row[0]),
            "trade_decision_id": str(row[1]),
            "execution_id": str(row[2]) if row[2] is not None else None,
            "event_ts": row[3],
            "symbol": row[4],
            "account_label": row[5],
            "strategy_id": row[6],
            "decision_hash": row[7],
            "decision_json": row[8],
            "alpaca_order_id": row[9],
            "client_order_id": row[10],
            "event_type": row[11],
            "order_status": row[12],
            "event_fingerprint": row[13],
            "source_topic": row[14],
            "source_partition": row[15],
            "source_offset": row[16],
            "source_window_id": None,
            "raw_event": row[17],
            "execution_audit_json": row[18],
            "raw_order": row[19],
        }
    return {
        "execution_order_event_id": str(row[10]),
        "trade_decision_id": str(row[4]),
        "execution_id": None,
        "event_ts": row[0],
        "symbol": row[1],
        "account_label": row[2],
        "strategy_id": row[3],
        "decision_hash": row[4],
        "decision_json": row[5],
        "alpaca_order_id": row[6],
        "client_order_id": row[7],
        "event_type": row[8],
        "order_status": row[9],
        "event_fingerprint": row[10],
        "source_topic": row[11],
        "source_partition": row[12],
        "source_offset": row[13],
        "source_window_id": None,
        "raw_event": row[14],
        "execution_audit_json": row[15],
        "raw_order": row[16],
    }


def _order_lifecycle_query_row_has_time(row: Sequence[object]) -> bool:
    return (row[3] if len(row) >= 20 else row[0]) is not None


__all__ = [
    "_unique_source_window_rows",
    "_source_window_status_counts",
    "_source_window_classification_counts",
    "_source_window_gap_count",
    "_source_window_gap_ranges",
    "_decision_lifecycle_query_row",
    "_decision_lifecycle_query_row_has_time",
    "_execution_query_row",
    "_execution_query_row_has_time",
    "_execution_query_row_has_tca_ref",
    "_source_window_query_context",
    "_order_lifecycle_query_row",
    "_order_lifecycle_query_row_has_time",
]
