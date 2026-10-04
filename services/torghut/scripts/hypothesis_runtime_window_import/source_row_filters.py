from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.runtime_ledger import RuntimeLedgerBucket, RuntimeLedgerFill

from scripts.hypothesis_runtime_window_import.common import (
    _decimal_or_none,
    _execution_row_has_fill,
    _first_positive_decimal,
    _first_text,
    _parse_dt_or_none,
    _position_snapshot_open_position_count,
    _runtime_ledger_event_type,
    _runtime_ledger_row_time,
    _runtime_source_row_symbol,
    _source_identifier_values,
    _source_offset_values,
    _text_or_none,
    _with_canonical_runtime_source_refs,
)
from scripts.hypothesis_runtime_window_import.constants import (
    RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS,
    RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS,
    _EXECUTION_ORDER_EVENT_REF_KEYS,
    _RUNTIME_LEDGER_FILL_EVENTS,
    _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS,
    _SOURCE_WINDOW_REF_KEYS,
)
from scripts.hypothesis_runtime_window_import.execution_costs import (
    _runtime_execution_cost_amount,
    _runtime_execution_cost_basis,
)
from scripts.hypothesis_runtime_window_import.lifecycle_rows import (
    _runtime_lifecycle_ledger_row,
    _runtime_order_id,
)

__all__ = (
    "_runtime_source_row_in_bucket",
    "_runtime_source_row_before_bucket",
    "_runtime_source_decision_ids",
    "_ledger_row_value",
    "_ledger_row_text",
    "_ledger_row_decimal",
    "_ledger_row_time",
    "_ledger_row_event_type",
    "_ledger_row_order_id",
    "_ledger_row_decision_id",
    "_ledger_row_symbol",
    "_ledger_row_position_key",
    "_ledger_row_side_sign",
    "_adjust_carry_in_lot_row",
    "_active_carry_in_ledger_rows",
    "_filter_carry_in_source_rows_for_active_lots",
    "_flat_start_position_snapshot_from_cursor",
    "_runtime_order_rows_for_bucket",
    "_runtime_decision_rows_for_bucket",
    "_runtime_decision_rows_before_bucket",
    "_runtime_unlinked_order_rows_for_bucket",
    "_event_sourced_fill_economics_order_ids",
    "_source_backed_fill_lifecycle_rows",
    "_source_backed_order_lifecycle_rows",
    "_required_order_lifecycle_source_row_count",
    "_source_backed_fill_lifecycle_order_ids",
    "_source_backed_submitted_lifecycle_order_ids",
    "_execution_fill_economics_order_ids",
    "_execution_tca_order_ids",
)


def _runtime_source_row_in_bucket(
    row: Mapping[str, object],
    *,
    bucket: RuntimeLedgerBucket,
) -> bool:
    row_symbol = _runtime_source_row_symbol(row)
    if (
        bucket.symbol is not None
        and row_symbol is not None
        and row_symbol != bucket.symbol
    ):
        return False
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    return (
        event_time is None
        or bucket.bucket_started_at <= event_time < bucket.bucket_ended_at
    )


def _runtime_source_row_before_bucket(
    row: Mapping[str, object],
    *,
    bucket: RuntimeLedgerBucket,
) -> bool:
    row_symbol = _runtime_source_row_symbol(row)
    if (
        bucket.symbol is not None
        and row_symbol is not None
        and row_symbol != bucket.symbol
    ):
        return False
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    return event_time is not None and event_time < bucket.bucket_started_at


def _runtime_source_decision_ids(rows: Sequence[Mapping[str, object]]) -> set[str]:
    identifiers: set[str] = set()
    for row in rows:
        for key in ("trade_decision_id", "decision_id", "decision_hash"):
            value = _text_or_none(row.get(key))
            if value is not None:
                identifiers.add(value)
    return identifiers


def _ledger_row_value(
    row: RuntimeLedgerFill | Mapping[str, object],
    *keys: str,
) -> object | None:
    if isinstance(row, Mapping):
        for key in keys:
            if key in row:
                return row.get(key)
        return None
    for key in keys:
        value = getattr(row, key, None)
        if value is not None:
            return value
    return None


def _ledger_row_text(
    row: RuntimeLedgerFill | Mapping[str, object],
    *keys: str,
) -> str | None:
    for key in keys:
        value = _ledger_row_value(row, key)
        if (text := _text_or_none(value)) is not None:
            return text
    return None


def _ledger_row_decimal(
    row: RuntimeLedgerFill | Mapping[str, object],
    *keys: str,
) -> Decimal | None:
    for key in keys:
        value = _ledger_row_value(row, key)
        if (parsed := _decimal_or_none(value)) is not None:
            return parsed
    return None


def _ledger_row_time(row: RuntimeLedgerFill | Mapping[str, object]) -> datetime | None:
    if isinstance(row, Mapping):
        return _runtime_ledger_row_time({str(key): value for key, value in row.items()})
    value = getattr(row, "executed_at", None)
    return value if isinstance(value, datetime) else None


def _ledger_row_event_type(row: RuntimeLedgerFill | Mapping[str, object]) -> str:
    if isinstance(row, Mapping):
        return _runtime_ledger_event_type(
            {str(key): value for key, value in row.items()}
        )
    return str(getattr(row, "event_type", "") or "").strip().lower()


def _ledger_row_order_id(row: RuntimeLedgerFill | Mapping[str, object]) -> str | None:
    return _ledger_row_text(
        row,
        "order_id",
        "alpaca_order_id",
        "client_order_id",
        "execution_correlation_id",
    )


def _ledger_row_decision_id(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> str | None:
    return _ledger_row_text(row, "decision_id", "trade_decision_id", "decision_hash")


def _ledger_row_symbol(row: RuntimeLedgerFill | Mapping[str, object]) -> str | None:
    symbol = _ledger_row_text(row, "symbol", "ticker")
    return symbol.upper() if symbol is not None else None


def _ledger_row_position_key(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> tuple[str | None, str | None, str | None]:
    return (
        _ledger_row_text(row, "account_label", "alpaca_account_label"),
        _ledger_row_text(row, "strategy_id", "strategy_name"),
        _ledger_row_symbol(row),
    )


def _ledger_row_side_sign(row: RuntimeLedgerFill | Mapping[str, object]) -> Decimal:
    side = (_ledger_row_text(row, "side", "order_side") or "").strip().lower()
    if side in {"buy", "long", "b"}:
        return Decimal("1")
    if side in {"sell", "short", "s"}:
        return Decimal("-1")
    return Decimal("0")


def _adjust_carry_in_lot_row(
    row: RuntimeLedgerFill | Mapping[str, object],
    *,
    remaining_qty: Decimal,
    original_qty: Decimal,
) -> RuntimeLedgerFill | dict[str, object]:
    ratio = remaining_qty / original_qty if original_qty > 0 else Decimal("1")
    price = _ledger_row_decimal(
        row,
        "avg_fill_price",
        "filled_avg_price",
        "filled_average_price",
        "average_fill_price",
        "fill_price",
        "filled_price",
    )
    filled_notional = remaining_qty * price if price is not None else None
    cost_amount = _ledger_row_decimal(row, "cost_amount")
    adjusted_cost = cost_amount * ratio if cost_amount is not None else None
    if isinstance(row, RuntimeLedgerFill):
        return replace(
            row,
            filled_qty=remaining_qty,
            filled_notional=filled_notional,
            cost_amount=adjusted_cost,
        )
    adjusted = dict(row)
    adjusted["filled_qty"] = remaining_qty
    if "filled_qty_delta" in adjusted:
        adjusted["filled_qty_delta"] = remaining_qty
    if filled_notional is not None:
        adjusted["filled_notional"] = filled_notional
        if "filled_notional_delta" in adjusted:
            adjusted["filled_notional_delta"] = filled_notional
    if adjusted_cost is not None:
        adjusted["cost_amount"] = adjusted_cost
    return adjusted


def _active_carry_in_ledger_rows(
    rows: Sequence[RuntimeLedgerFill | Mapping[str, object]],
    *,
    bucket_start: datetime,
) -> tuple[list[RuntimeLedgerFill | dict[str, object]], set[str], set[str]]:
    lots_by_key: dict[
        tuple[str | None, str | None, str | None],
        list[dict[str, object]],
    ] = {}
    for row in sorted(
        rows,
        key=lambda item: (
            _ledger_row_time(item) or bucket_start,
            _ledger_row_order_id(item) or "",
        ),
    ):
        event_time = _ledger_row_time(row)
        if event_time is None or event_time >= bucket_start:
            continue
        if _ledger_row_event_type(row) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        side_sign = _ledger_row_side_sign(row)
        if side_sign == 0:
            continue
        qty = _ledger_row_decimal(
            row, "filled_qty", "filled_quantity", "qty", "quantity"
        )
        price = _ledger_row_decimal(
            row,
            "avg_fill_price",
            "filled_avg_price",
            "filled_average_price",
            "average_fill_price",
            "fill_price",
            "filled_price",
        )
        if qty is None or qty <= 0 or price is None or price <= 0:
            continue
        key = _ledger_row_position_key(row)
        lots = lots_by_key.setdefault(key, [])
        remaining_qty = qty
        for lot in list(lots):
            if remaining_qty <= 0:
                break
            if cast(Decimal, lot["side_sign"]) == side_sign:
                continue
            lot_qty = cast(Decimal, lot["remaining_qty"])
            close_qty = min(remaining_qty, lot_qty)
            lot["remaining_qty"] = lot_qty - close_qty
            remaining_qty -= close_qty
            if cast(Decimal, lot["remaining_qty"]) <= 0:
                lots.remove(lot)
        if remaining_qty > 0:
            lots.append(
                {
                    "row": row,
                    "side_sign": side_sign,
                    "remaining_qty": remaining_qty,
                    "original_qty": qty,
                }
            )

    active_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    active_order_ids: set[str] = set()
    active_decision_ids: set[str] = set()
    for lots in lots_by_key.values():
        for lot in lots:
            remaining_qty = cast(Decimal, lot["remaining_qty"])
            original_qty = cast(Decimal, lot["original_qty"])
            if remaining_qty <= 0 or original_qty <= 0:
                continue
            row = cast(RuntimeLedgerFill | Mapping[str, object], lot["row"])
            adjusted = _adjust_carry_in_lot_row(
                row,
                remaining_qty=remaining_qty,
                original_qty=original_qty,
            )
            active_rows.append(adjusted)
            if (order_id := _ledger_row_order_id(adjusted)) is not None:
                active_order_ids.add(order_id)
            if (decision_id := _ledger_row_decision_id(adjusted)) is not None:
                active_decision_ids.add(decision_id)
    linked_lifecycle_rows: list[RuntimeLedgerFill | dict[str, object]] = []
    for row in rows:
        event_time = _ledger_row_time(row)
        if event_time is None or event_time >= bucket_start:
            continue
        if _ledger_row_event_type(row) in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        order_id = _ledger_row_order_id(row)
        decision_id = _ledger_row_decision_id(row)
        if (order_id is not None and order_id in active_order_ids) or (
            decision_id is not None and decision_id in active_decision_ids
        ):
            linked_lifecycle_rows.append(dict(row) if isinstance(row, Mapping) else row)
    return [*linked_lifecycle_rows, *active_rows], active_order_ids, active_decision_ids


def _filter_carry_in_source_rows_for_active_lots(
    rows: list[dict[str, object]] | None,
    *,
    active_order_ids: set[str],
    active_decision_ids: set[str],
) -> list[dict[str, object]] | None:
    if not rows or (not active_order_ids and not active_decision_ids):
        return None
    filtered = [
        row
        for row in rows
        if (
            (order_id := _runtime_order_id(row)) is not None
            and order_id in active_order_ids
        )
        or bool(_runtime_source_decision_ids([row]) & active_decision_ids)
    ]
    return filtered or None


def _flat_start_position_snapshot_from_cursor(
    cur: Any,
    *,
    account_label: str,
    window_start: datetime,
) -> dict[str, object] | None:
    window_start_utc = (
        window_start.astimezone(timezone.utc)
        if window_start.tzinfo is not None
        else window_start.replace(tzinfo=timezone.utc)
    )
    cur.execute(
        """
        with before_snapshot as (
            select
                id::text,
                as_of,
                positions,
                'latest_before_window_start' as snapshot_source
            from position_snapshots
            where alpaca_account_label = %s
              and as_of <= %s
            order by as_of desc
            limit 1
        ),
        after_snapshot as (
            select
                id::text,
                as_of,
                positions,
                'first_after_window_start' as snapshot_source
            from position_snapshots
            where alpaca_account_label = %s
              and as_of > %s
              and as_of <= %s
            order by as_of asc
            limit 1
        )
        select id, as_of, positions, snapshot_source, 0 as snapshot_priority
        from before_snapshot
        union all
        select id, as_of, positions, snapshot_source, 1 as snapshot_priority
        from after_snapshot
        order by snapshot_priority
        limit 1
        """,
        (
            account_label,
            window_start_utc,
            account_label,
            window_start_utc,
            window_start_utc
            + timedelta(
                seconds=RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS
            ),
        ),
    )
    rows = list(cur.fetchall())
    if not rows:
        return None
    snapshot_id, snapshot_as_of, positions, snapshot_source, _snapshot_priority = rows[
        0
    ]
    parsed_as_of = _parse_dt_or_none(snapshot_as_of)
    if parsed_as_of is None:
        return None
    offset_seconds = int((parsed_as_of - window_start_utc).total_seconds())
    blockers: list[str] = []
    if offset_seconds < -RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS:
        blockers.append("runtime_ledger_flat_start_position_snapshot_stale")
    position_count = _position_snapshot_open_position_count(positions)
    if position_count is None:
        blockers.append("runtime_ledger_flat_start_position_snapshot_positions_invalid")
        position_count = 0
    if position_count > 0:
        blockers.append("runtime_ledger_flat_start_position_snapshot_not_flat")
    return {
        "schema_version": "torghut.runtime-ledger-flat-start-position-snapshot.v1",
        "scope": "account_position_snapshot_at_runtime_window_start",
        "account_label": account_label,
        "snapshot_id": str(snapshot_id),
        "snapshot_as_of": parsed_as_of.isoformat(),
        "snapshot_source": str(snapshot_source or "position_snapshots"),
        "snapshot_offset_seconds": offset_seconds,
        "flat": position_count == 0 and not blockers,
        "position_count": position_count,
        "blockers": blockers,
    }


def _runtime_order_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    execution_rows: list[dict[str, object]],
    order_lifecycle_rows: list[dict[str, object]] | None,
) -> list[dict[str, object]]:
    bucket_execution_order_ids = {
        order_id
        for row in execution_rows
        if _runtime_source_row_in_bucket(row, bucket=bucket)
        and _execution_row_has_fill(row)
        and (order_id := _runtime_order_id(row)) is not None
    }
    bucket_fill_order_ids = {
        order_id
        for row in order_lifecycle_rows or []
        if _runtime_source_row_in_bucket(row, bucket=bucket)
        and _runtime_ledger_event_type({str(key): value for key, value in row.items()})
        in _RUNTIME_LEDGER_FILL_EVENTS
        and (order_id := _runtime_order_id(row)) is not None
    }
    bucket_order_ids = bucket_execution_order_ids | bucket_fill_order_ids
    rows: list[dict[str, object]] = []
    for row in order_lifecycle_rows or []:
        if not _runtime_source_row_in_bucket(row, bucket=bucket):
            continue
        order_id = _runtime_order_id(row)
        if bucket_order_ids and order_id not in bucket_order_ids:
            continue
        rows.append(dict(row))
    return rows


def _runtime_decision_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    decision_lifecycle_rows: list[dict[str, object]] | None,
    source_rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    decision_ids = _runtime_source_decision_ids(source_rows)
    rows: list[dict[str, object]] = []
    for row in decision_lifecycle_rows or []:
        if not _runtime_source_row_in_bucket(row, bucket=bucket):
            continue
        row_ids = _runtime_source_decision_ids([row])
        if decision_ids and not (row_ids & decision_ids):
            continue
        rows.append(dict(row))
    return rows


def _runtime_decision_rows_before_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    decision_lifecycle_rows: list[dict[str, object]] | None,
    source_rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    decision_ids = _runtime_source_decision_ids(source_rows)
    rows: list[dict[str, object]] = []
    for row in decision_lifecycle_rows or []:
        if not _runtime_source_row_before_bucket(row, bucket=bucket):
            continue
        row_ids = _runtime_source_decision_ids([row])
        if decision_ids and not (row_ids & decision_ids):
            continue
        rows.append(dict(row))
    return rows


def _runtime_unlinked_order_rows_for_bucket(
    *,
    bucket: RuntimeLedgerBucket,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None,
    bucket_order_ids: set[str],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for row in unlinked_order_lifecycle_rows or []:
        if _runtime_source_row_in_bucket(row, bucket=bucket):
            rows.append(dict(row))
            continue
        row_symbol = _runtime_source_row_symbol(row)
        if (
            bucket.symbol is not None
            and row_symbol is not None
            and row_symbol != bucket.symbol
        ):
            continue
        order_id = _runtime_order_id(row)
        if order_id is not None and order_id in bucket_order_ids:
            rows.append(dict(row))
    return rows


def _event_sourced_fill_economics_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in rows:
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if (
            _runtime_lifecycle_ledger_row(
                normalized,
                event_type=_runtime_ledger_event_type(normalized),
                require_complete_fill=True,
            )
            is None
        ):
            continue
        order_id = _runtime_order_id(normalized)
        if order_id is not None:
            order_ids.add(order_id)
    return order_ids


def _source_backed_fill_lifecycle_rows(
    rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    source_backed_rows: list[dict[str, object]] = []
    for row in rows:
        normalized = _with_canonical_runtime_source_refs(row)
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if _runtime_order_id(normalized) is None:
            continue
        if not _source_identifier_values(
            [normalized],
            *_EXECUTION_ORDER_EVENT_REF_KEYS,
        ):
            continue
        if not _source_identifier_values([normalized], *_SOURCE_WINDOW_REF_KEYS):
            continue
        if not _source_offset_values([normalized]):
            continue
        source_backed_rows.append(dict(normalized))
    return source_backed_rows


def _source_backed_order_lifecycle_rows(
    rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    source_backed_rows: list[dict[str, object]] = []
    for row in rows:
        normalized = _with_canonical_runtime_source_refs(row)
        if (
            _runtime_ledger_event_type(normalized)
            not in _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS
        ):
            continue
        if _runtime_order_id(normalized) is None:
            continue
        if not _source_identifier_values(
            [normalized],
            *_EXECUTION_ORDER_EVENT_REF_KEYS,
        ):
            continue
        if not _source_identifier_values([normalized], *_SOURCE_WINDOW_REF_KEYS):
            continue
        if not _source_offset_values([normalized]):
            continue
        source_backed_rows.append(dict(normalized))
    return source_backed_rows


def _required_order_lifecycle_source_row_count(
    rows: Sequence[Mapping[str, object]],
    *,
    expected_order_ids: set[str],
) -> int:
    if not expected_order_ids:
        return 0
    count = 0
    for row in rows:
        normalized = {str(key): value for key, value in row.items()}
        if (
            _runtime_ledger_event_type(normalized)
            not in _RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS
        ):
            continue
        order_id = _runtime_order_id(normalized)
        if order_id is None or order_id not in expected_order_ids:
            continue
        count += 1
    return max(count, len(expected_order_ids))


def _source_backed_fill_lifecycle_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    return {
        order_id
        for row in _source_backed_fill_lifecycle_rows(rows)
        if (order_id := _runtime_order_id(row)) is not None
    }


def _source_backed_submitted_lifecycle_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in _source_backed_order_lifecycle_rows(rows):
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) != "order_submitted":
            continue
        order_id = _runtime_order_id(normalized)
        if order_id is not None:
            order_ids.add(order_id)
    return order_ids


def _execution_fill_economics_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in rows:
        if not _execution_row_has_fill(row):
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            continue
        filled_notional = _first_positive_decimal(
            row, "filled_notional", "notional", "turnover_notional"
        ) or Decimal("0")
        if filled_notional <= 0:
            price = _first_positive_decimal(
                row,
                "avg_fill_price",
                "filled_avg_price",
                "filled_average_price",
                "average_fill_price",
                "fill_price",
                "filled_price",
            )
            qty = _first_positive_decimal(
                row, "filled_qty", "filled_quantity", "qty", "quantity"
            )
            if price is None or qty is None or price <= 0 or qty <= 0:
                continue
            filled_notional = price * qty
        cost_amount = _runtime_execution_cost_amount(
            row,
            filled_notional=filled_notional,
            side=_first_text(row, "side", "order_side") or "",
            filled_qty=(
                _first_positive_decimal(
                    row, "filled_qty", "filled_quantity", "qty", "quantity"
                )
                or Decimal("0")
            ),
        )
        cost_basis = _runtime_execution_cost_basis(
            row,
            cost_amount=cost_amount,
            side=_first_text(row, "side", "order_side") or "",
            filled_qty=(
                _first_positive_decimal(
                    row, "filled_qty", "filled_quantity", "qty", "quantity"
                )
                or Decimal("0")
            ),
            filled_notional=filled_notional,
        )
        if cost_amount is not None and cost_amount >= 0 and cost_basis is not None:
            order_ids.add(order_id)
    return order_ids


def _execution_tca_order_ids(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    order_ids: set[str] = set()
    for row in rows:
        if not _execution_row_has_fill(row):
            continue
        if (
            _first_text(
                row,
                "execution_tca_metric_id",
                "execution_tca_metric_ref",
                "execution_tca_id",
                "tca_metric_id",
                "tca_id",
            )
            is None
        ):
            continue
        order_id = _runtime_order_id(row)
        if order_id is not None:
            order_ids.add(order_id)
    return order_ids
