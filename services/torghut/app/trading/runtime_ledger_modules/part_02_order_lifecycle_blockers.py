# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime execution ledger primitives for honest post-cost PnL proof."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from ..runtime_cost_authority import is_non_promotion_grade_runtime_cost_basis

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_14 import *


def _order_lifecycle_blockers(
    *,
    lifecycle_rows: Sequence[_NormalizedFill],
    fill_lifecycle_rows: Sequence[_NormalizedFill],
    usable_fills: Sequence[_NormalizedFill],
    decision_count: int,
    submitted_order_count: int,
    rejected_order_count: int,
    unfilled_order_count: int,
    execution_policy_hash_counter: Counter[str],
    cost_model_hash_counter: Counter[str],
    lineage_hash_counter: Counter[str],
) -> list[str]:
    blockers: list[str] = []
    if not lifecycle_rows:
        blockers.append("runtime_order_lifecycle_missing")
    if not fill_lifecycle_rows:
        blockers.append("order_feed_lifecycle_missing")
    if decision_count <= 0:
        blockers.append("runtime_decision_lifecycle_missing")
    if submitted_order_count <= 0:
        blockers.append("submitted_order_lifecycle_missing")
    if not usable_fills:
        blockers.append("zero_fill_runtime_ledger")
        blockers.append("execution_economics_missing")

    submitted_order_ids = {
        row.order_id
        for row in lifecycle_rows
        if row.event_type in _SUBMITTED_ORDER_EVENTS and row.order_id is not None
    }
    submitted_without_decision = [
        row
        for row in lifecycle_rows
        if row.event_type in _SUBMITTED_ORDER_EVENTS and row.decision_id is None
    ]
    if submitted_without_decision:
        blockers.append("order_decision_linkage_missing")

    fill_lifecycle_order_ids = {
        row.order_id for row in fill_lifecycle_rows if row.order_id is not None
    }
    fill_order_ids = {row.order_id for row in usable_fills if row.order_id is not None}
    cancelled_order_ids = {
        row.order_id
        for row in lifecycle_rows
        if row.event_type in _CANCELLED_ORDER_EVENTS and row.order_id is not None
    }
    rejected_order_ids = {
        row.order_id
        for row in lifecycle_rows
        if row.event_type in _REJECTED_ORDER_EVENTS and row.order_id is not None
    }
    unfilled_order_ids = {
        row.order_id
        for row in lifecycle_rows
        if row.event_type in _UNFILLED_ORDER_EVENTS and row.order_id is not None
    }
    terminal_order_ids = (
        fill_lifecycle_order_ids
        | fill_order_ids
        | cancelled_order_ids
        | rejected_order_ids
        | unfilled_order_ids
    )
    if any(row.order_id is None for row in usable_fills):
        blockers.append("fill_order_linkage_missing")
    if any(row.order_id is None for row in fill_lifecycle_rows):
        blockers.append("fill_order_linkage_missing")
    if fill_lifecycle_order_ids - submitted_order_ids:
        blockers.append("fill_order_submission_missing")
    if fill_order_ids - fill_lifecycle_order_ids:
        blockers.append("order_feed_lifecycle_missing")
    unresolved_submitted_order_ids = submitted_order_ids - terminal_order_ids
    if unfilled_order_count > 0:
        blockers.append("unfilled_order_present")
    elif unresolved_submitted_order_ids and not usable_fills:
        blockers.append("unfilled_order_present")
    if rejected_order_count > 0:
        blockers.append("rejected_order_present")

    if not usable_fills or any(
        row.execution_policy_hash is None for row in usable_fills
    ):
        blockers.append("execution_policy_hash_missing")
    if not usable_fills or any(row.cost_model_hash is None for row in usable_fills):
        blockers.append("cost_model_hash_missing")
    if any(
        row.lineage_hash is None and row.replay_data_hash is None
        for row in lifecycle_rows
    ):
        blockers.append("proof_lineage_hash_missing")
    if len(lineage_hash_counter) > 1:
        blockers.append("proof_lineage_hash_ambiguous")
    return blockers


def _source_materialization_blockers(
    lifecycle_rows: Sequence[_NormalizedFill],
) -> list[str]:
    """Fail closed on order-feed source rows missing row-level runtime refs."""

    blockers: list[str] = []
    for row in lifecycle_rows:
        if not _row_requires_promotion_source_authority(row):
            continue
        if row.event_type not in _SUBMITTED_ORDER_EVENTS | _FILL_EVENTS:
            continue
        if row.source_materialization not in _PROMOTION_GRADE_SOURCE_MATERIALIZATIONS:
            blockers.append(_SOURCE_REF_BLOCKER_SOURCE_MATERIALIZATION_MISSING)
        if row.authority_class not in _PROMOTION_GRADE_AUTHORITY_CLASSES:
            blockers.append(_SOURCE_REF_BLOCKER_AUTHORITY_CLASS_MISSING)
        if row.execution_order_event_id is None:
            blockers.append(_SOURCE_REF_BLOCKER_EXECUTION_ORDER_EVENT_MISSING)
        if row.decision_id is None:
            blockers.append(_SOURCE_REF_BLOCKER_TRADE_DECISION_MISSING)
        if row.event_type in _FILL_EVENTS and row.execution_id is None:
            blockers.append(_SOURCE_REF_BLOCKER_EXECUTION_MISSING)
        if row.source_window_id is None:
            blockers.append(_SOURCE_REF_BLOCKER_SOURCE_WINDOW_MISSING)
        if not row.source_offset_present:
            blockers.append(_SOURCE_REF_BLOCKER_SOURCE_OFFSETS_MISSING)
    return _dedupe(blockers)


def _row_requires_promotion_source_authority(row: _NormalizedFill) -> bool:
    """Return true for source rows that claim promotion-grade runtime authority.

    Lifecycle-only ``order_feed_lifecycle`` rows can prove order state without
    economics or promotion authority. Rows that claim a promotion source
    materialization or authority marker must carry both the marker and all
    source refs before a bucket can become authority.
    """

    return (
        row.source_materialization in _PROMOTION_GRADE_SOURCE_MATERIALIZATIONS
        or row.authority_class in _PROMOTION_GRADE_AUTHORITY_CLASSES
    )


def _apply_fill_to_position(
    *,
    state: _PositionState,
    fill: _NormalizedFill,
    accumulator: _LedgerAccumulator,
) -> None:
    assert fill.side is not None
    assert fill.filled_qty is not None
    assert fill.avg_fill_price is not None
    assert fill.cost_amount is not None

    side_sign = Decimal("1") if fill.side in _BUY_SIDES else Decimal("-1")
    remaining_qty = fill.filled_qty
    remaining_cost = fill.cost_amount

    if state.qty == 0 or _same_direction(state.qty, side_sign):
        _open_position(
            state=state,
            side_sign=side_sign,
            qty=remaining_qty,
            price=fill.avg_fill_price,
            cost_amount=remaining_cost,
        )
        return

    existing_abs_qty = abs(state.qty)
    closing_qty = min(remaining_qty, existing_abs_qty)
    if closing_qty > 0:
        fill_cost_allocated = _allocate(fill.cost_amount, closing_qty, fill.filled_qty)
        entry_cost_allocated = _allocate(
            state.entry_cost_remaining,
            closing_qty,
            existing_abs_qty,
        )
        entry_price = state.avg_price or fill.avg_fill_price
        if state.qty > 0:
            gross_pnl = (fill.avg_fill_price - entry_price) * closing_qty
        else:
            gross_pnl = (entry_price - fill.avg_fill_price) * closing_qty
        accumulator.filled_notional += (
            entry_price * closing_qty + fill.avg_fill_price * closing_qty
        )
        accumulator.cost_amount += entry_cost_allocated + fill_cost_allocated
        accumulator.gross_strategy_pnl += gross_pnl
        accumulator.net_strategy_pnl_after_costs += (
            gross_pnl - entry_cost_allocated - fill_cost_allocated
        )
        accumulator.closed_trade_count += 1

        state.entry_cost_remaining -= entry_cost_allocated
        state.qty += side_sign * closing_qty
        if state.qty == 0:
            state.avg_price = None
            state.entry_cost_remaining = Decimal("0")

        remaining_qty -= closing_qty
        remaining_cost -= fill_cost_allocated

    if remaining_qty > 0:
        _open_position(
            state=state,
            side_sign=side_sign,
            qty=remaining_qty,
            price=fill.avg_fill_price,
            cost_amount=remaining_cost,
        )


def _open_position(
    *,
    state: _PositionState,
    side_sign: Decimal,
    qty: Decimal,
    price: Decimal,
    cost_amount: Decimal,
) -> None:
    signed_qty = side_sign * qty
    if state.qty == 0 or state.avg_price is None:
        state.qty = signed_qty
        state.avg_price = price
        state.entry_cost_remaining = cost_amount
        return

    existing_abs_qty = abs(state.qty)
    new_abs_qty = existing_abs_qty + qty
    state.avg_price = (
        (existing_abs_qty * state.avg_price) + (qty * price)
    ) / new_abs_qty
    state.qty += signed_qty
    state.entry_cost_remaining += cost_amount


def _normalize_fill_row(
    row: RuntimeLedgerFill | Mapping[str, object],
    *,
    row_index: int,
) -> _NormalizedFill:
    executed_at = _coerce_datetime(
        _row_value(
            row, "executed_at", "filled_at", "event_ts", "created_at", "computed_at"
        )
    )
    account_label = _coerce_text(
        _row_value(row, "account_label", "alpaca_account_label")
    )
    strategy_id = _coerce_text(_row_value(row, "strategy_id", "strategy_name"))
    symbol = _coerce_text(_row_value(row, "symbol"))
    event_type = _coerce_event_type(row)
    side = _coerce_side(_row_value(row, "side", "action", "order_side"))
    filled_qty = _positive_decimal(_row_value(row, "filled_qty", "qty", "quantity"))
    avg_fill_price = _positive_decimal(
        _row_value(row, "avg_fill_price", "filled_avg_price", "fill_price", "price")
    )
    filled_notional = _positive_decimal(
        _row_value(row, "filled_notional", "notional", "fill_notional")
    )
    filled_qty_delta = _positive_decimal(
        _row_value(row, "filled_qty_delta", "fill_qty_delta", "delta_filled_qty")
    )
    filled_notional_delta = _positive_decimal(
        _row_value(
            row,
            "filled_notional_delta",
            "fill_notional_delta",
            "delta_filled_notional",
        )
    )
    fill_quantity_basis = _coerce_fill_quantity_basis(
        _row_value(row, "fill_quantity_basis", "quantity_basis")
    )
    order_feed_lifecycle_source = _is_order_feed_lifecycle_source_row(
        row, event_type=event_type
    )
    order_feed_source_fill = event_type in _FILL_EVENTS and order_feed_lifecycle_source
    lifecycle_only = _is_order_feed_lifecycle_only_row(row, event_type=event_type)
    if event_type in _FILL_EVENTS and order_feed_source_fill:
        if fill_quantity_basis in _DELTA_FILL_QUANTITY_BASES:
            if filled_qty_delta is not None:
                filled_qty = filled_qty_delta
                if filled_notional_delta is not None:
                    filled_notional = filled_notional_delta
                elif avg_fill_price is not None:
                    filled_notional = filled_qty_delta * avg_fill_price
        elif _is_linked_materialized_order_event_fill(row) and (
            filled_notional_delta is not None and avg_fill_price is not None
        ):
            filled_notional = filled_notional_delta
            filled_qty = filled_qty_delta or (filled_notional_delta / avg_fill_price)
            filled_qty_delta = filled_qty
            fill_quantity_basis = "source_notional_delta"
        else:
            filled_qty = None
            filled_notional = None
    if (
        filled_notional is None
        and filled_qty is not None
        and avg_fill_price is not None
    ):
        filled_notional = filled_qty * avg_fill_price
    cost_amount = _non_negative_decimal(
        _row_value(
            row,
            "cost_amount",
            "total_cost",
            "explicit_cost",
            "commission",
            "fees",
            "fee_amount",
            "broker_fee",
            "explicit_cost_amount",
            "total_fees",
            "total_fee_amount",
        )
    )
    cost_basis = _coerce_text(
        _row_value(
            row,
            "cost_basis",
            "cost_source",
            "fee_basis",
            "commission_basis",
            "broker_fee_basis",
        )
    )
    decision_id = _coerce_text(
        _row_value(row, "decision_id", "trade_decision_id", "decision_hash")
    )
    execution_id = _coerce_text(
        _row_value(row, "execution_id", "execution_correlation_id")
    )
    execution_order_event_id = _coerce_text(
        _row_value(row, "execution_order_event_id", "event_fingerprint")
    )
    source_window_id = _coerce_text(
        _row_value(row, "source_window_id", "runtime_ledger_source_window_id")
    )
    source_offset_present = _source_offset_present(row)
    source_materialization = _coerce_text(
        _row_value(row, "source_materialization", "source")
    )
    authority_class = _coerce_text(_row_value(row, "authority_class"))
    order_id = _coerce_text(
        _row_value(
            row,
            "order_id",
            "alpaca_order_id",
            "client_order_id",
            "execution_id",
            "execution_correlation_id",
        )
    )
    execution_policy_hash = _coerce_text(
        _row_value(
            row,
            "execution_policy_hash",
            "execution_policy_sha256",
            "policy_hash",
        )
    )
    cost_model_hash = _coerce_text(
        _row_value(row, "cost_model_hash", "fee_model_hash", "cost_model_sha256")
    )
    lineage_hash = _coerce_text(
        _row_value(
            row,
            "lineage_hash",
            "candidate_lineage_hash",
            "replay_lineage_hash",
            "candidate_evaluation_key",
        )
    )
    replay_data_hash = _coerce_text(
        _row_value(
            row,
            "replay_data_hash",
            "replay_tape_content_sha256",
            "dataset_snapshot_hash",
            "source_query_digest",
        )
    )

    blockers: list[str] = []
    if _has_tca_pnl_shortcut(row):
        blockers.append("tca_shortfall_not_runtime_pnl")
    bucket_blockers = _runtime_source_collection_mode_blockers(row)
    blockers.extend(_runtime_source_hard_mode_blockers(row))
    if _is_non_promotion_runtime_source_row(row):
        blockers.append("runtime_source_not_promotion_authority")
    blockers.extend(_tigerbeetle_journal_blockers(row))
    if executed_at is None and event_type != "diagnostic":
        blockers.append("executed_at_missing")
    if event_type in _FILL_EVENTS and not lifecycle_only:
        if side is None:
            blockers.append("side_missing_or_invalid")
        if filled_qty is None:
            blockers.append("filled_qty_missing_or_non_positive")
        if (
            order_feed_source_fill
            and fill_quantity_basis not in _DELTA_FILL_QUANTITY_BASES
        ):
            blockers.append("fill_quantity_delta_basis_missing")
        elif (
            order_feed_source_fill
            and fill_quantity_basis in {"delta", "cumulative_to_delta"}
            and filled_qty_delta is None
        ):
            blockers.append("fill_quantity_delta_missing")
        if avg_fill_price is None:
            blockers.append("fill_price_missing")
        if filled_notional is None:
            blockers.append("filled_notional_missing")
        if cost_amount is None:
            blockers.append("explicit_cost_missing")
        if cost_basis is None:
            blockers.append("cost_basis_missing")
        elif is_non_promotion_grade_runtime_cost_basis(cost_basis):
            blockers.append("runtime_ledger_cost_basis_non_promotion_grade")

    return _NormalizedFill(
        row_index=row_index,
        executed_at=executed_at,
        account_label=account_label,
        strategy_id=strategy_id,
        symbol=symbol,
        side=side,
        filled_qty=filled_qty,
        avg_fill_price=avg_fill_price,
        filled_notional=filled_notional,
        filled_qty_delta=filled_qty_delta,
        filled_notional_delta=filled_notional_delta,
        fill_quantity_basis=fill_quantity_basis,
        cost_amount=cost_amount,
        cost_basis=cost_basis,
        event_type=event_type,
        decision_id=decision_id,
        order_id=order_id,
        execution_id=execution_id,
        execution_order_event_id=execution_order_event_id,
        source_window_id=source_window_id,
        source_offset_present=source_offset_present,
        source_materialization=source_materialization,
        authority_class=authority_class,
        execution_policy_hash=execution_policy_hash,
        cost_model_hash=cost_model_hash,
        lineage_hash=lineage_hash,
        replay_data_hash=replay_data_hash,
        blockers=tuple(_dedupe(blockers)),
        bucket_blockers=tuple(_dedupe(bucket_blockers)),
        lifecycle_only=lifecycle_only,
        order_feed_lifecycle_source=order_feed_lifecycle_source,
    )


def _coerce_event_type(row: RuntimeLedgerFill | Mapping[str, object]) -> str:
    raw = _coerce_text(
        _row_value(
            row,
            "ledger_event_type",
            "runtime_ledger_event_type",
            "lifecycle_event",
            "event_type",
            "order_event_type",
            "order_status",
            "status",
        )
    )
    if raw is not None:
        normalized = raw.lower().replace("-", "_").replace(" ", "_")
        aliases = {
            "trade_decision": "decision",
            "signal_decision": "decision",
            "new_order": "order_submitted",
            "submitted": "order_submitted",
            "accepted": "order_submitted",
            "new": "order_submitted",
            "filled": "fill",
            "partial_fill": "partial_fill",
            "partially_filled": "partial_fill",
            "canceled": "order_cancelled",
            "cancelled": "order_cancelled",
            "rejected": "order_rejected",
            "expired": "order_unfilled",
        }
        candidate = aliases.get(normalized, normalized)
        if candidate in _LIFECYCLE_EVENTS:
            return candidate

    if (
        _row_value(row, "filled_qty", "qty", "quantity", "avg_fill_price", "fill_price")
        is not None
    ):
        return "fill"
    if _row_value(row, "alpaca_order_id", "client_order_id", "order_id") is not None:
        return "order_submitted"
    if _row_value(row, "decision_id", "trade_decision_id", "decision_hash") is not None:
        return "decision"
    return "diagnostic"


def _row_value(
    row: RuntimeLedgerFill | Mapping[str, object],
    *keys: str,
) -> object | None:
    if isinstance(row, Mapping):
        for key in keys:
            if key in row:
                return row[key]
        return None
    for key in keys:
        value = getattr(row, key, None)
        if value is not None:
            return value
    return None


def _coerce_fill_quantity_basis(value: object | None) -> str | None:
    text = _coerce_text(value)
    if text is None:
        return None
    normalized = text.lower().replace("-", "_").replace(" ", "_")
    if normalized in {"delta", "fill_delta", "filled_delta"}:
        return "delta"
    if normalized in {"cumulative_to_delta", "cumulative_delta", "cum_to_delta"}:
        return "cumulative_to_delta"
    if normalized in {"cumulative", "cum"}:
        return "cumulative"
    if normalized in {"unknown", "cumulative_non_increasing"}:
        return normalized
    return normalized or None


def _is_order_feed_lifecycle_source_row(
    row: RuntimeLedgerFill | Mapping[str, object],
    *,
    event_type: str,
) -> bool:
    if event_type not in _LIFECYCLE_EVENTS:
        return False
    return _is_order_feed_source_row(row)


def _is_order_feed_source_row(row: RuntimeLedgerFill | Mapping[str, object]) -> bool:
    source = _coerce_text(
        _row_value(row, "source", "pnl_derivation", "source_materialization")
    )
    authority_class = _coerce_text(_row_value(row, "authority_class"))
    if source in {
        "order_feed_lifecycle",
        "execution_order_event",
        "execution_order_events",
        "execution_order_events_runtime_ledger",
        "runtime_order_feed_execution_source",
        "source_execution_lifecycle",
    }:
        return True
    if authority_class in {
        "runtime_order_feed_execution_source",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }:
        return True
    return any(
        _row_value(row, key) is not None
        for key in (
            "execution_order_event_id",
            "event_fingerprint",
            "source_window_id",
            "source_offset",
        )
    )


def _is_order_feed_source_fill(row: RuntimeLedgerFill | Mapping[str, object]) -> bool:
    return _is_order_feed_source_row(row)


def _is_linked_materialized_order_event_fill(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> bool:
    """Return true for row-level order-feed fills with source/economics lineage.

    This is intentionally stricter than general order-feed source detection so
    cumulative/aggregate rows do not become fill authority merely because they
    carry a quantity. A linked order-event fill can infer delta quantity from a
    positive filled_notional_delta and avg price only when the row also carries
    execution, decision, source-window, offset, and materialization lineage.
    """

    if _is_non_promotion_runtime_source_row(row):
        return False
    materialization = _coerce_text(
        _row_value(row, "source_materialization", "authority_class", "source")
    )
    if materialization not in _PROMOTION_GRADE_SOURCE_MATERIALIZATIONS:
        return False
    return (
        _row_value(row, "execution_order_event_id", "event_fingerprint") is not None
        and _row_value(row, "execution_id", "execution_correlation_id") is not None
        and _row_value(row, "trade_decision_id", "decision_id", "decision_hash")
        is not None
        and _row_value(row, "source_window_id", "runtime_ledger_source_window_id")
        is not None
        and _source_offset_present(row)
    )


def _source_offset_present(row: RuntimeLedgerFill | Mapping[str, object]) -> bool:
    source_offsets = _row_value(row, "source_offsets")
    if isinstance(source_offsets, Mapping):
        typed_offsets = cast(Mapping[str, object], source_offsets)
        return (
            _row_value(typed_offsets, "topic") is not None
            and _row_value(typed_offsets, "partition") is not None
            and _row_value(typed_offsets, "offset") is not None
        )
    return (
        _row_value(row, "source_topic") is not None
        and _row_value(row, "source_partition") is not None
        and _row_value(row, "source_offset") is not None
    ) or _row_value(row, "source_offset") is not None


def _is_non_promotion_runtime_source_row(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> bool:
    promotion_authority = _row_value(
        row, "promotion_authority", "promotion_authority_eligible"
    )
    if promotion_authority is False:
        return True
    if _runtime_source_hard_mode_blockers(row):
        return True
    for key in (
        "authority_class",
        "authority_reason",
        "pnl_derivation",
        "route_mode",
        "source",
        "source_kind",
        "source_materialization",
        "promotion_authority",
    ):
        text = _coerce_text(_row_value(row, key))
        if text is None:
            continue
        normalized = text.lower().replace("-", "_")
        if normalized in {"0", "false", "no", "n"} and key == "promotion_authority":
            return True
        if any(marker in normalized for marker in _NON_PROMOTION_SOURCE_MARKERS):
            return True
    return False


def _runtime_source_collection_mode_blockers(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []
    for key in (
        "authority_class",
        "authority_mode",
        "authority_reason",
        "decision_mode",
        "materialization_mode",
        "pnl_derivation",
        "proof_mode",
        "route_mode",
        "source",
        "source_kind",
        "source_materialization",
        "source_mode",
    ):
        text = _coerce_text(_row_value(row, key))
        if text is None:
            continue
        normalized = text.lower().replace("-", "_").replace(" ", "_")
        if any(marker in normalized for marker in _SOURCE_DECISION_COLLECTION_MARKERS):
            blockers.append("source_decision_mode_not_profit_proof_eligible")
    return _dedupe(blockers)


def _runtime_source_hard_mode_blockers(
    row: RuntimeLedgerFill | Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []
    for key in (
        "authority_class",
        "authority_mode",
        "authority_reason",
        "decision_mode",
        "materialization_mode",
        "pnl_derivation",
        "proof_mode",
        "route_mode",
        "source",
        "source_kind",
        "source_materialization",
        "source_mode",
    ):
        text = _coerce_text(_row_value(row, key))
        if text is None:
            continue
        normalized = text.lower().replace("-", "_").replace(" ", "_")
        if any(marker in normalized for marker in _EXECUTION_RECONSTRUCTION_MARKERS):
            blockers.append("execution_reconstruction_not_runtime_ledger_proof")
    return _dedupe(blockers)


__all__ = [name for name in globals() if not name.startswith("__")]
