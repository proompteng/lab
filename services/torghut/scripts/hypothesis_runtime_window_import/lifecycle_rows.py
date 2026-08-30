from __future__ import annotations

from decimal import Decimal
from typing import Mapping, Sequence

from scripts.hypothesis_runtime_window_import.common import (
    _as_mapping,
    _alpaca_2026_equity_fee_schedule_hash,
    _cost_basis_is_alpaca_fee_schedule,
    _decimal_or_none,
    _direct_text,
    _execution_row_has_fill,
    _first_lineage_digest,
    _first_payload_digest,
    _first_positive_decimal,
    _first_text,
    _runtime_ledger_event_type,
    _runtime_ledger_row_time,
    _source_authority_order_event_row,
    _text_values,
)
from scripts.hypothesis_runtime_window_import.constants import (
    ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER,
    ORDER_FEED_FILL_DELTA_MISSING_BLOCKER,
    ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER,
    ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER,
    ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER,
    ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER,
    _RUNTIME_LEDGER_FILL_EVENTS,
    _RUNTIME_LIFECYCLE_IDENTIFIER_KEYS,
)
from scripts.hypothesis_runtime_window_import.execution_costs import (
    _runtime_execution_cost_amount,
    _runtime_execution_cost_basis,
)
from scripts.hypothesis_runtime_window_import.source_decisions import (
    _source_row_matches_lineage,
)

__all__ = (
    "_runtime_lifecycle_ledger_row",
    "_runtime_order_id",
    "_execution_id_by_order_id",
    "_execution_side_by_order_id",
    "_with_linked_execution_id",
    "_runtime_lifecycle_identifier_values",
    "_runtime_lifecycle_strategy_identifier_values",
    "_strategy_relevant_unlinked_fill_lifecycle_rows",
    "_order_feed_fill_lifecycle_blockers",
    "_fill_quantity_basis",
    "_source_order_feed_payload_delta_fill",
    "_order_feed_fill_delta_blockers",
)


def _runtime_lifecycle_ledger_row(
    row: Mapping[str, object],
    *,
    event_type: str,
    require_complete_fill: bool = False,
) -> dict[str, object] | None:
    event_time = _runtime_ledger_row_time(
        {str(key): value for key, value in row.items()}
    )
    if event_time is None:
        return None
    symbol = _first_text(row, "symbol", "order_symbol")
    ledger_row: dict[str, object] = {
        "executed_at": event_time,
        "event_type": event_type,
        "account_label": _first_text(row, "account_label", "alpaca_account_label"),
        "strategy_id": _first_text(row, "strategy_id", "strategy_name"),
        "symbol": symbol.strip().upper() if symbol is not None else None,
        "decision_id": _first_text(
            row,
            "decision_id",
            "trade_decision_id",
            "decision_hash",
        ),
        "order_id": _first_text(
            row,
            "order_id",
            "alpaca_order_id",
            "client_order_id",
            "execution_correlation_id",
        ),
        "execution_policy_hash": _first_text(
            row,
            "execution_policy_hash",
            "execution_policy_sha256",
            "policy_hash",
        )
        or _first_payload_digest(
            row,
            "execution_policy",
            "execution_policy_context",
            "execution_advisor",
            "_execution_advice_provenance",
        ),
        "cost_model_hash": _first_text(
            row,
            "cost_model_hash",
            "fee_model_hash",
            "cost_model_sha256",
        )
        or _first_payload_digest(
            row,
            "cost_model",
            "cost_model_config",
            "transaction_cost_model",
            "fee_model",
            "fees_model",
        ),
        "lineage_hash": _first_text(
            row,
            "lineage_hash",
            "candidate_lineage_hash",
            "replay_lineage_hash",
            "candidate_evaluation_key",
            "event_fingerprint",
        )
        or _first_lineage_digest(row),
        "replay_data_hash": _first_text(
            row,
            "replay_data_hash",
            "replay_tape_content_sha256",
            "dataset_snapshot_hash",
            "source_query_digest",
            "source_offset",
        ),
    }
    if _source_authority_order_event_row(row):
        ledger_row["source"] = "execution_order_event"
        ledger_row["source_materialization"] = "execution_order_events"
        ledger_row["authority_class"] = "runtime_order_feed_execution_source"
        for key in (
            "execution_order_event_id",
            "execution_id",
            "source_topic",
            "source_partition",
            "source_offset",
            "source_window_id",
        ):
            if row.get(key) is not None:
                ledger_row[key] = row[key]
    if event_type in _RUNTIME_LEDGER_FILL_EVENTS:
        side = _first_text(row, "side", "action", "order_side")
        source_authority_order_event = _source_authority_order_event_row(row)
        fill_quantity_basis = _fill_quantity_basis(row)
        filled_qty_delta = _first_positive_decimal(
            row,
            "filled_qty_delta",
            "fill_qty_delta",
            "delta_filled_qty",
        )
        filled_qty = _first_positive_decimal(
            row,
            "filled_qty",
            "filled_quantity",
            "qty",
            "quantity",
        )
        avg_fill_price = _first_positive_decimal(
            row,
            "avg_fill_price",
            "filled_avg_price",
            "filled_average_price",
            "average_fill_price",
            "fill_price",
            "filled_price",
            "price",
        )
        source_order_feed_delta_fill = (
            _source_order_feed_payload_delta_fill(row, event_type=event_type)
            if source_authority_order_event and fill_quantity_basis is None
            else None
        )
        if (
            source_authority_order_event
            and fill_quantity_basis in {"delta", "cumulative_to_delta"}
            and filled_qty_delta is not None
        ):
            filled_qty = filled_qty_delta
        filled_notional_delta = _first_positive_decimal(
            row,
            "filled_notional_delta",
            "fill_notional_delta",
            "delta_filled_notional",
        )
        filled_notional = _first_positive_decimal(
            row,
            "filled_notional_delta",
            "fill_notional_delta",
            "delta_filled_notional",
            "filled_notional",
            "notional",
            "fill_notional",
        )
        if source_order_feed_delta_fill is not None:
            delta_qty, delta_price, delta_side = source_order_feed_delta_fill
            side = side or delta_side
            fill_quantity_basis = "delta"
            filled_qty_delta = delta_qty
            filled_qty = delta_qty
            avg_fill_price = delta_price
            filled_notional_delta = delta_qty * delta_price
            filled_notional = filled_notional_delta
        elif source_authority_order_event and fill_quantity_basis not in {
            "delta",
            "cumulative_to_delta",
        }:
            filled_qty = None
            filled_notional = None
        elif (
            source_authority_order_event
            and fill_quantity_basis in {"delta", "cumulative_to_delta"}
            and filled_qty_delta is None
        ):
            filled_qty = None
            filled_notional = None
        if (
            filled_notional is None
            and filled_qty is not None
            and avg_fill_price is not None
        ):
            filled_notional = filled_qty * avg_fill_price
        cost_amount = (
            _runtime_execution_cost_amount(
                row,
                filled_notional=filled_notional,
                side=side,
                filled_qty=filled_qty,
            )
            if filled_notional is not None
            else None
        )
        cost_basis = _runtime_execution_cost_basis(
            row,
            cost_amount=cost_amount,
            side=side,
            filled_qty=filled_qty,
            filled_notional=filled_notional,
        )
        if require_complete_fill and (
            side is None
            or filled_qty is None
            or filled_qty <= 0
            or avg_fill_price is None
            or avg_fill_price <= 0
            or filled_notional is None
            or filled_notional <= 0
            or cost_amount is None
            or cost_amount < 0
            or cost_basis is None
        ):
            return None
        if side is not None:
            ledger_row["side"] = side
        if filled_qty is not None:
            ledger_row["filled_qty"] = filled_qty
        if avg_fill_price is not None:
            ledger_row["avg_fill_price"] = avg_fill_price
        if filled_notional is not None:
            ledger_row["filled_notional"] = filled_notional
        if filled_qty_delta is not None:
            ledger_row["filled_qty_delta"] = filled_qty_delta
        if filled_notional_delta is not None:
            ledger_row["filled_notional_delta"] = filled_notional_delta
        if fill_quantity_basis is not None:
            ledger_row["fill_quantity_basis"] = fill_quantity_basis
        if cost_amount is not None:
            ledger_row["cost_amount"] = cost_amount
        if cost_basis is not None:
            ledger_row["cost_basis"] = cost_basis
        if _cost_basis_is_alpaca_fee_schedule(cost_basis):
            ledger_row["cost_model_hash"] = _alpaca_2026_equity_fee_schedule_hash()
    return ledger_row


def _runtime_order_id(row: Mapping[str, object]) -> str | None:
    return _first_text(
        row,
        "order_id",
        "alpaca_order_id",
        "client_order_id",
        "execution_correlation_id",
    )


def _execution_id_by_order_id(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, str]:
    ids_by_order_id: dict[str, set[str]] = {}
    for row in rows:
        order_id = _runtime_order_id(row)
        execution_id = _first_text(row, "execution_id")
        if order_id is None or execution_id is None:
            continue
        ids_by_order_id.setdefault(order_id, set()).add(execution_id)
    return {
        order_id: next(iter(execution_ids))
        for order_id, execution_ids in ids_by_order_id.items()
        if len(execution_ids) == 1
    }


def _execution_side_by_order_id(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, str]:
    sides_by_order_id: dict[str, set[str]] = {}
    for row in rows:
        order_id = _runtime_order_id(row)
        side = _first_text(row, "side", "order_side")
        if order_id is None or side is None:
            continue
        sides_by_order_id.setdefault(order_id, set()).add(side)
    return {
        order_id: next(iter(sides))
        for order_id, sides in sides_by_order_id.items()
        if len(sides) == 1
    }


def _with_linked_execution_id(
    row: Mapping[str, object],
    *,
    execution_id_by_order_id: Mapping[str, str],
    execution_side_by_order_id: Mapping[str, str] | None = None,
) -> dict[str, object]:
    payload = dict(row)
    order_id = _runtime_order_id(payload)
    if (
        _first_text(payload, "execution_id") is None
        and order_id is not None
        and (execution_id := execution_id_by_order_id.get(order_id))
    ):
        payload["execution_id"] = execution_id
    if (
        _first_text(payload, "side", "order_side") is None
        and order_id is not None
        and execution_side_by_order_id is not None
        and (side := execution_side_by_order_id.get(order_id))
    ):
        payload["side"] = side
    return payload


def _runtime_lifecycle_identifier_values(row: Mapping[str, object]) -> set[str]:
    values = _text_values(row, *_RUNTIME_LIFECYCLE_IDENTIFIER_KEYS)
    return {value for value in values if value}


def _runtime_lifecycle_strategy_identifier_values(
    rows: Sequence[Mapping[str, object]],
) -> set[str]:
    identifiers: set[str] = set()
    for row in rows:
        identifiers.update(_runtime_lifecycle_identifier_values(row))
    return identifiers


def _strategy_relevant_unlinked_fill_lifecycle_rows(
    *,
    execution_rows: Sequence[Mapping[str, object]],
    order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
    unlinked_order_lifecycle_rows: Sequence[Mapping[str, object]] | None,
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
) -> list[dict[str, object]]:
    strategy_identifiers = _runtime_lifecycle_strategy_identifier_values(
        [
            *execution_rows,
            *(order_lifecycle_rows or ()),
        ]
    )
    lineage_filter_present = candidate_id is not None or hypothesis_id is not None
    relevant_rows: list[dict[str, object]] = []
    for row in unlinked_order_lifecycle_rows or ():
        normalized = {str(key): value for key, value in row.items()}
        if _runtime_ledger_event_type(normalized) not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        if lineage_filter_present and _source_row_matches_lineage(
            normalized,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            require_source_lineage=True,
        ):
            relevant_rows.append(normalized)
            continue
        if (
            strategy_identifiers
            and _runtime_lifecycle_identifier_values(normalized) & strategy_identifiers
        ):
            relevant_rows.append(normalized)
    return relevant_rows


def _order_feed_fill_lifecycle_blockers(
    *,
    execution_rows: list[dict[str, object]],
    order_lifecycle_rows: list[dict[str, object]] | None,
    unlinked_order_lifecycle_rows: list[dict[str, object]] | None = None,
) -> list[str]:
    expected_order_ids: set[str] = set()
    missing_execution_order_id = False
    for row in execution_rows:
        if not _execution_row_has_fill(row):
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            missing_execution_order_id = True
            continue
        expected_order_ids.add(order_id)

    if not expected_order_ids and not missing_execution_order_id:
        return []

    observed_fill_order_ids: set[str] = set()
    for row in order_lifecycle_rows or []:
        normalized = {str(key): value for key, value in row.items()}
        event_type = _runtime_ledger_event_type(normalized)
        if event_type not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        order_id = _runtime_order_id(row)
        if order_id is None:
            continue
        observed_fill_order_ids.add(order_id)

    blockers: list[str] = []
    if _strategy_relevant_unlinked_fill_lifecycle_rows(
        execution_rows=execution_rows,
        order_lifecycle_rows=order_lifecycle_rows,
        unlinked_order_lifecycle_rows=unlinked_order_lifecycle_rows,
    ):
        blockers.append(ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER)
    if missing_execution_order_id:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER)
    if not observed_fill_order_ids:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER)
    elif expected_order_ids - observed_fill_order_ids:
        blockers.append(ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER)
    return blockers


def _fill_quantity_basis(row: Mapping[str, object]) -> str | None:
    raw = _first_text(row, "fill_quantity_basis", "quantity_basis")
    if raw is None:
        return None
    normalized = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in {"delta", "fill_delta", "filled_delta"}:
        return "delta"
    if normalized in {"cumulative_to_delta", "cumulative_delta", "cum_to_delta"}:
        return "cumulative_to_delta"
    if normalized in {"cumulative", "cum"}:
        return "cumulative"
    if normalized in {"unknown", "cumulative_non_increasing"}:
        return normalized
    return normalized or None


def _source_order_feed_payload_delta_fill(
    row: Mapping[str, object], *, event_type: str
) -> tuple[Decimal, Decimal, str | None] | None:
    if (
        _runtime_ledger_event_type({"event_type": event_type})
        not in _RUNTIME_LEDGER_FILL_EVENTS
    ):
        return None
    raw_event = _as_mapping(row.get("raw_event"))
    if not raw_event:
        return None

    payload_candidates: list[Mapping[str, object]] = []
    for key in ("payload", "data"):
        payload = _as_mapping(raw_event.get(key))
        if payload:
            payload_candidates.append(payload)
    if _as_mapping(raw_event.get("order")):
        payload_candidates.append(raw_event)

    for payload in payload_candidates:
        payload_event = _runtime_ledger_event_type(
            {
                "event_type": _direct_text(payload, "event", "event_type")
                or event_type,
                "status": _direct_text(payload, "status"),
            }
        )
        if payload_event not in _RUNTIME_LEDGER_FILL_EVENTS:
            continue
        qty = _decimal_or_none(payload.get("qty"))
        price = _decimal_or_none(payload.get("price"))
        if qty is None or qty <= 0 or price is None or price <= 0:
            continue
        order = _as_mapping(payload.get("order"))
        side = _direct_text(payload, "side", "order_side") or _direct_text(
            order, "side"
        )
        return qty, price, side
    return None


def _order_feed_fill_delta_blockers(row: Mapping[str, object]) -> list[str]:
    if not _source_authority_order_event_row(row):
        return []
    if _source_order_feed_payload_delta_fill(
        row, event_type=_runtime_ledger_event_type(row)
    ):
        return []
    basis = _fill_quantity_basis(row)
    if basis not in {"delta", "cumulative_to_delta"}:
        return [ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER]
    if (
        _first_positive_decimal(
            row,
            "filled_qty_delta",
            "fill_qty_delta",
            "delta_filled_qty",
        )
        is None
    ):
        return [ORDER_FEED_FILL_DELTA_MISSING_BLOCKER]
    return []
