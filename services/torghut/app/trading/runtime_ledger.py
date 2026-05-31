"""Runtime execution ledger primitives for honest post-cost PnL proof."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from .runtime_cost_authority import is_non_promotion_grade_runtime_cost_basis

POST_COST_PNL_BASIS = "realized_strategy_pnl_after_explicit_costs"
EXACT_REPLAY_LEDGER_SCHEMA_VERSION = "torghut.exact_replay_ledger.v1"

_BPS_MULTIPLIER = Decimal("10000")
_BUY_SIDES = frozenset({"buy", "buy_to_cover", "cover"})
_SELL_SIDES = frozenset({"sell", "sell_short", "short"})
_DECISION_EVENTS = frozenset({"decision", "trade_decision", "signal_decision"})
_SUBMITTED_ORDER_EVENTS = frozenset(
    {"order_submitted", "submitted_order", "submitted", "accepted", "new"}
)
_FILL_EVENTS = frozenset({"fill", "filled", "partial_fill", "partially_filled"})
_CANCELLED_ORDER_EVENTS = frozenset(
    {"order_cancelled", "order_canceled", "cancelled", "canceled"}
)
_REJECTED_ORDER_EVENTS = frozenset({"order_rejected", "rejected"})
_UNFILLED_ORDER_EVENTS = frozenset(
    {"order_unfilled", "unfilled", "expired", "order_expired"}
)
_LIFECYCLE_EVENTS = (
    _DECISION_EVENTS
    | _SUBMITTED_ORDER_EVENTS
    | _FILL_EVENTS
    | _CANCELLED_ORDER_EVENTS
    | _REJECTED_ORDER_EVENTS
    | _UNFILLED_ORDER_EVENTS
)
_TCA_PNL_BASES = frozenset(
    {
        "tca_shortfall_proxy",
        "tca_shortfall",
        "shortfall_proxy",
        "realized_pnl_proxy_from_tca_shortfall",
        "execution_tca_shortfall_cost",
    }
)
_DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS = frozenset(
    {
        "runtime_fills_missing",
        "zero_fill_runtime_ledger",
        "closed_round_trip_missing",
        "filled_notional_missing",
        "filled_qty_missing_or_non_positive",
        "fill_price_missing",
        "side_missing_or_invalid",
        "explicit_cost_missing",
        "cost_basis_missing",
        "tca_shortfall_not_runtime_pnl",
        "runtime_ledger_cost_basis_non_promotion_grade",
    }
)


@dataclass(frozen=True)
class RuntimeLedgerFill:
    """Typed runtime fill input accepted by the DB-agnostic ledger builder."""

    executed_at: datetime
    side: str
    filled_qty: Decimal
    avg_fill_price: Decimal | None = None
    filled_notional: Decimal | None = None
    cost_amount: Decimal | None = None
    cost_basis: str | None = None
    account_label: str | None = None
    strategy_id: str | None = None
    symbol: str | None = None
    source: str = "runtime_execution"
    event_type: str | None = None
    decision_id: str | None = None
    order_id: str | None = None
    execution_policy_hash: str | None = None
    cost_model_hash: str | None = None
    lineage_hash: str | None = None
    replay_data_hash: str | None = None


@dataclass(frozen=True)
class RuntimeLedgerBucket:
    """Post-cost runtime PnL evidence for one time/group bucket."""

    bucket_started_at: datetime
    bucket_ended_at: datetime
    account_label: str | None
    strategy_id: str | None
    symbol: str | None
    fill_count: int
    decision_count: int
    submitted_order_count: int
    cancelled_order_count: int
    rejected_order_count: int
    unfilled_order_count: int
    closed_trade_count: int
    open_position_count: int
    filled_notional: Decimal
    gross_strategy_pnl: Decimal
    cost_amount: Decimal
    net_strategy_pnl_after_costs: Decimal
    post_cost_expectancy_bps: Decimal | None
    cost_basis_counts: dict[str, int]
    execution_policy_hash_counts: dict[str, int]
    cost_model_hash_counts: dict[str, int]
    lineage_hash_counts: dict[str, int]
    blockers: list[str]
    diagnostic_closed_trade_expectancy_bps: Decimal | None = None
    ledger_schema_version: str = EXACT_REPLAY_LEDGER_SCHEMA_VERSION
    pnl_basis: str = POST_COST_PNL_BASIS


@dataclass(frozen=True)
class _NormalizedFill:
    row_index: int
    executed_at: datetime | None
    account_label: str | None
    strategy_id: str | None
    symbol: str | None
    side: str | None
    filled_qty: Decimal | None
    avg_fill_price: Decimal | None
    filled_notional: Decimal | None
    cost_amount: Decimal | None
    cost_basis: str | None
    event_type: str
    decision_id: str | None
    order_id: str | None
    execution_policy_hash: str | None
    cost_model_hash: str | None
    lineage_hash: str | None
    replay_data_hash: str | None
    blockers: tuple[str, ...]

    @property
    def is_usable_fill(self) -> bool:
        return (
            self.event_type in _FILL_EVENTS
            and self.executed_at is not None
            and self.side is not None
            and self.filled_qty is not None
            and self.filled_qty > 0
            and self.avg_fill_price is not None
            and self.avg_fill_price > 0
            and self.filled_notional is not None
            and self.filled_notional > 0
            and self.cost_amount is not None
            and self.cost_amount >= 0
            and self.cost_basis is not None
            and not self.blockers
        )


@dataclass
class _PositionState:
    qty: Decimal = Decimal("0")
    avg_price: Decimal | None = None
    entry_cost_remaining: Decimal = Decimal("0")


@dataclass
class _LedgerAccumulator:
    filled_notional: Decimal = Decimal("0")
    cost_amount: Decimal = Decimal("0")
    gross_strategy_pnl: Decimal = Decimal("0")
    net_strategy_pnl_after_costs: Decimal = Decimal("0")
    closed_trade_count: int = 0


def build_runtime_ledger_buckets(
    rows: Sequence[RuntimeLedgerFill | Mapping[str, object]],
    *,
    bucket_ranges: Sequence[tuple[datetime, datetime]],
    group_by: Sequence[str] = (),
    require_order_lifecycle: bool = False,
) -> list[RuntimeLedgerBucket]:
    """Aggregate runtime fills into fail-closed post-cost PnL buckets.

    Expectancy is only populated when every row in the bucket carries enough
    runtime fill data and explicit cost data to compute realized strategy PnL
    after costs. TCA shortfall/proxy fields are treated as blockers, not PnL.
    """

    normalized_rows = [
        _normalize_fill_row(row, row_index=index) for index, row in enumerate(rows)
    ]
    normalized_ranges = [(_utc(start), _utc(end)) for start, end in bucket_ranges]
    for start, end in normalized_ranges:
        if end <= start:
            raise ValueError("bucket_end_must_be_after_bucket_start")

    buckets: list[RuntimeLedgerBucket] = []
    if not group_by:
        positions: dict[tuple[str | None, str | None, str | None], _PositionState] = {}
        for bucket_start, bucket_end in normalized_ranges:
            bucket_rows = [
                row
                for row in normalized_rows
                if row.executed_at is not None
                and bucket_start <= row.executed_at < bucket_end
            ]
            buckets.append(
                _build_bucket(
                    bucket_start=bucket_start,
                    bucket_end=bucket_end,
                    rows=bucket_rows,
                    carried_positions=positions,
                    require_order_lifecycle=require_order_lifecycle,
                )
            )
        return buckets

    grouped_positions: dict[
        tuple[str | None, ...],
        dict[tuple[str | None, str | None, str | None], _PositionState],
    ] = {}
    for bucket_start, bucket_end in normalized_ranges:
        bucket_rows = [
            row
            for row in normalized_rows
            if row.executed_at is not None
            and bucket_start <= row.executed_at < bucket_end
        ]
        grouped_rows: dict[tuple[str | None, ...], list[_NormalizedFill]] = {}
        for row in bucket_rows:
            grouped_rows.setdefault(_group_key(row, group_by), []).append(row)
        for key in sorted(grouped_rows):
            buckets.append(
                _build_bucket(
                    bucket_start=bucket_start,
                    bucket_end=bucket_end,
                    rows=grouped_rows[key],
                    group_by=group_by,
                    group_key=key,
                    carried_positions=grouped_positions.setdefault(key, {}),
                    require_order_lifecycle=require_order_lifecycle,
                )
            )
    return buckets


def _build_bucket(
    *,
    bucket_start: datetime,
    bucket_end: datetime,
    rows: Sequence[_NormalizedFill],
    group_by: Sequence[str] = (),
    group_key: tuple[str | None, ...] = (),
    carried_positions: dict[tuple[str | None, str | None, str | None], _PositionState]
    | None = None,
    require_order_lifecycle: bool = False,
) -> RuntimeLedgerBucket:
    blockers: list[str] = []
    for row in rows:
        blockers.extend(row.blockers)

    lifecycle_rows = [row for row in rows if row.event_type in _LIFECYCLE_EVENTS]
    decision_count = sum(1 for row in rows if row.event_type in _DECISION_EVENTS)
    submitted_order_count = sum(
        1 for row in rows if row.event_type in _SUBMITTED_ORDER_EVENTS
    )
    cancelled_order_count = sum(
        1 for row in rows if row.event_type in _CANCELLED_ORDER_EVENTS
    )
    rejected_order_count = sum(
        1 for row in rows if row.event_type in _REJECTED_ORDER_EVENTS
    )
    unfilled_order_count = sum(
        1 for row in rows if row.event_type in _UNFILLED_ORDER_EVENTS
    )
    usable_fills = [row for row in rows if row.is_usable_fill]
    if not usable_fills:
        blockers.append("runtime_fills_missing")

    accumulator = _LedgerAccumulator()
    cost_basis_counter: Counter[str] = Counter()
    execution_policy_hash_counter: Counter[str] = Counter()
    cost_model_hash_counter: Counter[str] = Counter()
    lineage_hash_counter: Counter[str] = Counter()
    for row in lifecycle_rows:
        if row.execution_policy_hash is not None:
            execution_policy_hash_counter[row.execution_policy_hash] += 1
        if (lineage_hash := row.lineage_hash or row.replay_data_hash) is not None:
            lineage_hash_counter[lineage_hash] += 1
    for row in usable_fills:
        if row.cost_model_hash is not None:
            cost_model_hash_counter[row.cost_model_hash] += 1

    positions: dict[tuple[str | None, str | None, str | None], _PositionState] = (
        carried_positions if carried_positions is not None else {}
    )
    for fill in sorted(
        usable_fills,
        key=lambda item: (item.executed_at or bucket_start, item.row_index),
    ):
        assert fill.side is not None
        assert fill.filled_qty is not None
        assert fill.avg_fill_price is not None
        assert fill.filled_notional is not None
        assert fill.cost_amount is not None
        assert fill.cost_basis is not None

        cost_basis_counter[fill.cost_basis] += 1
        if is_non_promotion_grade_runtime_cost_basis(fill.cost_basis):
            blockers.append("runtime_ledger_cost_basis_non_promotion_grade")
        position_key = (fill.account_label, fill.strategy_id, fill.symbol)
        state = positions.setdefault(position_key, _PositionState())
        _apply_fill_to_position(state=state, fill=fill, accumulator=accumulator)

    open_position_count = sum(1 for state in positions.values() if state.qty != 0)
    if usable_fills and accumulator.closed_trade_count <= 0:
        blockers.append("closed_round_trip_missing")
    if open_position_count > 0:
        blockers.append("unclosed_position")
    if accumulator.filled_notional <= 0:
        blockers.append("filled_notional_missing")
    if require_order_lifecycle:
        blockers.extend(
            _order_lifecycle_blockers(
                lifecycle_rows=lifecycle_rows,
                usable_fills=usable_fills,
                decision_count=decision_count,
                submitted_order_count=submitted_order_count,
                rejected_order_count=rejected_order_count,
                unfilled_order_count=unfilled_order_count,
                execution_policy_hash_counter=execution_policy_hash_counter,
                cost_model_hash_counter=cost_model_hash_counter,
                lineage_hash_counter=lineage_hash_counter,
            )
        )

    unique_blockers = _dedupe(blockers)
    post_cost_expectancy_bps: Decimal | None = None
    diagnostic_closed_trade_expectancy_bps: Decimal | None = None
    if (
        accumulator.filled_notional > 0
        and accumulator.closed_trade_count > 0
        and not (_DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS & set(unique_blockers))
    ):
        diagnostic_closed_trade_expectancy_bps = (
            accumulator.net_strategy_pnl_after_costs
            / accumulator.filled_notional
            * _BPS_MULTIPLIER
        )
    if not unique_blockers and accumulator.filled_notional > 0:
        post_cost_expectancy_bps = diagnostic_closed_trade_expectancy_bps

    return RuntimeLedgerBucket(
        bucket_started_at=bucket_start,
        bucket_ended_at=bucket_end,
        account_label=_bucket_field("account_label", rows, group_by, group_key),
        strategy_id=_bucket_field("strategy_id", rows, group_by, group_key),
        symbol=_bucket_field("symbol", rows, group_by, group_key),
        fill_count=len(usable_fills),
        decision_count=decision_count,
        submitted_order_count=submitted_order_count,
        cancelled_order_count=cancelled_order_count,
        rejected_order_count=rejected_order_count,
        unfilled_order_count=unfilled_order_count,
        closed_trade_count=accumulator.closed_trade_count,
        open_position_count=open_position_count,
        filled_notional=accumulator.filled_notional,
        gross_strategy_pnl=accumulator.gross_strategy_pnl,
        cost_amount=accumulator.cost_amount,
        net_strategy_pnl_after_costs=accumulator.net_strategy_pnl_after_costs,
        post_cost_expectancy_bps=post_cost_expectancy_bps,
        cost_basis_counts=dict(sorted(cost_basis_counter.items())),
        execution_policy_hash_counts=dict(
            sorted(execution_policy_hash_counter.items())
        ),
        cost_model_hash_counts=dict(sorted(cost_model_hash_counter.items())),
        lineage_hash_counts=dict(sorted(lineage_hash_counter.items())),
        blockers=unique_blockers,
        diagnostic_closed_trade_expectancy_bps=diagnostic_closed_trade_expectancy_bps,
    )


def _order_lifecycle_blockers(
    *,
    lifecycle_rows: Sequence[_NormalizedFill],
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
    if decision_count <= 0:
        blockers.append("runtime_decision_lifecycle_missing")
    if submitted_order_count <= 0:
        blockers.append("submitted_order_lifecycle_missing")
    if not usable_fills:
        blockers.append("zero_fill_runtime_ledger")

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

    fill_order_ids = {row.order_id for row in usable_fills if row.order_id is not None}
    if any(row.order_id is None for row in usable_fills):
        blockers.append("fill_order_linkage_missing")
    if fill_order_ids - submitted_order_ids:
        blockers.append("fill_order_submission_missing")
    if submitted_order_ids - fill_order_ids:
        blockers.append("unfilled_order_present")
    if rejected_order_count > 0:
        blockers.append("rejected_order_present")
    if unfilled_order_count > 0:
        blockers.append("unfilled_order_present")

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
        )
    )
    cost_basis = _coerce_text(_row_value(row, "cost_basis", "cost_source", "fee_basis"))
    decision_id = _coerce_text(
        _row_value(row, "decision_id", "trade_decision_id", "decision_hash")
    )
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
    if executed_at is None and event_type != "diagnostic":
        blockers.append("executed_at_missing")
    if event_type in _FILL_EVENTS:
        if side is None:
            blockers.append("side_missing_or_invalid")
        if filled_qty is None:
            blockers.append("filled_qty_missing_or_non_positive")
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
        cost_amount=cost_amount,
        cost_basis=cost_basis,
        event_type=event_type,
        decision_id=decision_id,
        order_id=order_id,
        execution_policy_hash=execution_policy_hash,
        cost_model_hash=cost_model_hash,
        lineage_hash=lineage_hash,
        replay_data_hash=replay_data_hash,
        blockers=tuple(_dedupe(blockers)),
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


def _has_tca_pnl_shortcut(row: RuntimeLedgerFill | Mapping[str, object]) -> bool:
    basis = _coerce_text(
        _row_value(
            row,
            "post_cost_expectancy_basis",
            "post_cost_basis",
            "pnl_basis",
            "cost_basis",
        )
    )
    if basis is not None and basis.lower().replace("-", "_") in _TCA_PNL_BASES:
        return True
    return (
        _row_value(row, "post_cost_expectancy_bps") is not None
        and _row_value(row, "shortfall_notional", "realized_pnl_proxy_notional")
        is not None
    )


def _group_key(row: _NormalizedFill, group_by: Sequence[str]) -> tuple[str | None, ...]:
    return tuple(_normalized_fill_field(row, field) for field in group_by)


def _bucket_field(
    field: str,
    rows: Sequence[_NormalizedFill],
    group_by: Sequence[str],
    group_key: tuple[str | None, ...],
) -> str | None:
    if field in group_by:
        return group_key[group_by.index(field)]
    values = {
        value
        for row in rows
        if (value := _normalized_fill_field(row, field)) is not None
    }
    if len(values) == 1:
        return next(iter(values))
    return None


def _normalized_fill_field(row: _NormalizedFill, field: str) -> str | None:
    if field == "account_label":
        return row.account_label
    if field == "strategy_id":
        return row.strategy_id
    if field == "symbol":
        return row.symbol
    return None


def _same_direction(current_qty: Decimal, side_sign: Decimal) -> bool:
    return (current_qty > 0 and side_sign > 0) or (current_qty < 0 and side_sign < 0)


def _allocate(amount: Decimal, qty: Decimal, total_qty: Decimal) -> Decimal:
    if total_qty <= 0:
        return Decimal("0")
    return amount * qty / total_qty


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _coerce_datetime(value: object | None) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _coerce_text(value)
    if text is None:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _coerce_text(value: object | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _coerce_side(value: object | None) -> str | None:
    text = _coerce_text(value)
    if text is None:
        return None
    normalized = text.lower().replace("-", "_")
    if normalized in _BUY_SIDES or normalized in _SELL_SIDES:
        return normalized
    return None


def _positive_decimal(value: object | None) -> Decimal | None:
    parsed = _decimal(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _non_negative_decimal(value: object | None) -> Decimal | None:
    parsed = _decimal(value)
    if parsed is None or parsed < 0:
        return None
    return parsed


def _decimal(value: object | None) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        parsed = value
    else:
        try:
            parsed = Decimal(str(value).strip())
        except Exception:
            return None
    if not parsed.is_finite():
        return None
    return parsed


def _dedupe(items: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(items))


__all__ = [
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "POST_COST_PNL_BASIS",
    "RuntimeLedgerBucket",
    "RuntimeLedgerFill",
    "build_runtime_ledger_buckets",
]
