"""Runtime execution ledger primitives for honest post-cost PnL proof."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from ..runtime_cost_authority import is_non_promotion_grade_runtime_cost_basis


def _row_helper_module() -> object:
    from . import is_order_feed_lifecycle_only_row

    return is_order_feed_lifecycle_only_row


def _lifecycle_helper_module() -> object:
    from . import order_lifecycle_blockers

    return order_lifecycle_blockers


def _utc(value: datetime) -> datetime:
    return getattr(_row_helper_module(), "_utc")(value)


def _group_key(row: _NormalizedFill, group_by: Sequence[str]) -> tuple[str | None, ...]:
    return getattr(_row_helper_module(), "_group_key")(row, group_by)


def _bucket_field(
    name: str,
    rows: Sequence[_NormalizedFill],
    group_by: Sequence[str],
    group_key: tuple[str | None, ...] | None,
) -> str | None:
    return getattr(_row_helper_module(), "_bucket_field")(
        name, rows, group_by, group_key
    )


def _dedupe(items: Sequence[str]) -> list[str]:
    return getattr(_row_helper_module(), "_dedupe")(items)


def _row_requires_promotion_source_authority(row: _NormalizedFill) -> bool:
    return getattr(
        _lifecycle_helper_module(), "_row_requires_promotion_source_authority"
    )(row)


def _apply_fill_to_position(
    *,
    state: _PositionState,
    fill: _NormalizedFill,
    accumulator: _LedgerAccumulator,
) -> None:
    getattr(_lifecycle_helper_module(), "_apply_fill_to_position")(
        state=state,
        fill=fill,
        accumulator=accumulator,
    )


def _order_lifecycle_blockers(*args: object, **kwargs: object) -> list[str]:
    return getattr(_lifecycle_helper_module(), "_order_lifecycle_blockers")(
        *args, **kwargs
    )


def _source_materialization_blockers(
    lifecycle_rows: Sequence[_NormalizedFill],
) -> list[str]:
    return getattr(_lifecycle_helper_module(), "_source_materialization_blockers")(
        lifecycle_rows
    )


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

_NON_RUNTIME_PNL_TCA_BASIS_ALIASES = frozenset(
    {
        "tca_shortfall",
        "shortfall_proxy",
        "realized_pnl_proxy_from_tca_shortfall",
        "execution_tca_shortfall_cost",
    }
)

_DELTA_FILL_QUANTITY_BASES = frozenset(
    {"delta", "cumulative_to_delta", "source_notional_delta"}
)

_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS = frozenset(
    {
        "execution_order_event",
        "execution_order_events",
        "execution_order_events_runtime_ledger",
        "runtime_order_feed_execution_source",
        "source_execution_lifecycle",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }
)

_NON_PROMOTION_SOURCE_MARKERS = frozenset(
    {
        "aggregate_only",
        "artifact_only",
        "paper_route_probe",
        "probe",
        "recovery",
        "replay_artifact",
        "route_acquisition",
        "route_reacquisition",
        "simulation_source_replay_only",
    }
)

_SOURCE_DECISION_COLLECTION_MARKERS = frozenset(
    {
        "source_decision",
        "source_decision_mode",
        "decision_source",
        "evidence_collection",
        "evidence_collection_mode",
        "paper_collection",
        "probation",
        "probationary",
    }
)

_EXECUTION_RECONSTRUCTION_MARKERS = frozenset(
    {
        "execution_reconstruction",
        "execution_reconstruction_basis",
        "execution_reconstructed",
        "reconstructed_execution",
        "reconstructed_from_execution",
    }
)

_TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER = (
    "tigerbeetle_execution_cost_journal_failed"
)

_TIGERBEETLE_JOURNAL_SUCCESS_STATUSES = frozenset(
    {"", "pass", "passed", "success", "succeeded", "journaled", "created", "exists"}
)

_DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS = frozenset(
    {
        "runtime_fills_missing",
        "execution_economics_missing",
        "zero_fill_runtime_ledger",
        "closed_round_trip_missing",
        "filled_notional_missing",
        "filled_qty_missing_or_non_positive",
        "fill_quantity_delta_basis_missing",
        "fill_quantity_delta_missing",
        "fill_price_missing",
        "side_missing_or_invalid",
        "explicit_cost_missing",
        "cost_basis_missing",
        "runtime_ledger_expectancy_missing",
        "tca_shortfall_not_runtime_pnl",
        "runtime_ledger_cost_basis_non_promotion_grade",
    }
)

_POST_COST_EXPECTANCY_SUPPRESSING_BLOCKERS = (
    _DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS
    | frozenset(
        {
            "unclosed_position",
            "runtime_order_lifecycle_missing",
            "order_feed_lifecycle_missing",
            "runtime_decision_lifecycle_missing",
            "submitted_order_lifecycle_missing",
            "order_decision_linkage_missing",
            "fill_order_linkage_missing",
            "fill_order_submission_missing",
            "runtime_ledger_source_window_ids_missing",
            "runtime_ledger_trade_decision_refs_missing",
            "runtime_ledger_execution_refs_missing",
            "runtime_ledger_execution_order_event_refs_missing",
            "runtime_ledger_source_offsets_missing",
            "runtime_ledger_source_materialization_missing",
            "runtime_ledger_authority_class_missing",
            "source_decision_mode_not_profit_proof_eligible",
            "runtime_source_not_promotion_authority",
            "execution_reconstruction_not_runtime_ledger_proof",
            _TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER,
        }
    )
)

_SOURCE_REF_BLOCKER_SOURCE_WINDOW_MISSING = "runtime_ledger_source_window_ids_missing"

_SOURCE_REF_BLOCKER_TRADE_DECISION_MISSING = (
    "runtime_ledger_trade_decision_refs_missing"
)

_SOURCE_REF_BLOCKER_EXECUTION_MISSING = "runtime_ledger_execution_refs_missing"

_SOURCE_REF_BLOCKER_EXECUTION_ORDER_EVENT_MISSING = (
    "runtime_ledger_execution_order_event_refs_missing"
)

_SOURCE_REF_BLOCKER_SOURCE_OFFSETS_MISSING = "runtime_ledger_source_offsets_missing"

_SOURCE_REF_BLOCKER_SOURCE_MATERIALIZATION_MISSING = (
    "runtime_ledger_source_materialization_missing"
)

_SOURCE_REF_BLOCKER_AUTHORITY_CLASS_MISSING = "runtime_ledger_authority_class_missing"

_PROMOTION_GRADE_AUTHORITY_CLASSES = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
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
    filled_qty_delta: Decimal | None = None
    filled_notional_delta: Decimal | None = None
    fill_quantity_basis: str | None = None
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
    bucket_blockers: tuple[str, ...] = ()
    filled_qty_delta: Decimal | None = None
    filled_notional_delta: Decimal | None = None
    fill_quantity_basis: str | None = None
    lifecycle_only: bool = False
    order_feed_lifecycle_source: bool = False
    execution_id: str | None = None
    execution_order_event_id: str | None = None
    source_window_id: str | None = None
    source_offset_present: bool = False
    source_materialization: str | None = None
    authority_class: str | None = None

    @property
    def is_usable_fill(self) -> bool:
        return (
            self.event_type in _FILL_EVENTS
            and not self.lifecycle_only
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
    carry_in_rows: Sequence[RuntimeLedgerFill | Mapping[str, object]] = (),
) -> list[RuntimeLedgerBucket]:
    """Aggregate runtime fills into fail-closed post-cost PnL buckets.

    Expectancy is only populated when every row in the bucket carries enough
    runtime fill data and explicit cost data to compute realized strategy PnL
    after costs. TCA shortfall/proxy fields are treated as blockers, not PnL.
    """

    from .order_lifecycle_blockers import (
        normalize_fill_row as _normalize_fill_row,
    )

    normalized_rows = [
        _normalize_fill_row(row, row_index=index) for index, row in enumerate(rows)
    ]
    normalized_carry_in_rows = [
        _normalize_fill_row(row, row_index=-(index + 1))
        for index, row in enumerate(carry_in_rows)
    ]
    normalized_ranges = [(_utc(start), _utc(end)) for start, end in bucket_ranges]
    for start, end in normalized_ranges:
        if end <= start:
            raise ValueError("bucket_end_must_be_after_bucket_start")

    buckets: list[RuntimeLedgerBucket] = []
    if not group_by:
        positions: dict[tuple[str | None, str | None, str | None], _PositionState] = {}
        applied_carry_in_row_indexes: set[int] = set()
        for bucket_start, bucket_end in normalized_ranges:
            bucket_rows = [
                row
                for row in normalized_rows
                if row.executed_at is not None
                and bucket_start <= row.executed_at < bucket_end
            ]
            bucket_carry_in_rows = _carry_in_rows_before_bucket(
                normalized_carry_in_rows,
                bucket_start=bucket_start,
                applied_row_indexes=applied_carry_in_row_indexes,
            )
            buckets.append(
                _build_bucket(
                    bucket_start=bucket_start,
                    bucket_end=bucket_end,
                    rows=bucket_rows,
                    carry_in_rows=bucket_carry_in_rows,
                    carried_positions=positions,
                    require_order_lifecycle=require_order_lifecycle,
                )
            )
        return buckets

    grouped_positions: dict[
        tuple[str | None, ...],
        dict[tuple[str | None, str | None, str | None], _PositionState],
    ] = {}
    grouped_applied_carry_in_row_indexes: set[int] = set()
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
            bucket_carry_in_rows = _carry_in_rows_before_bucket(
                [
                    row
                    for row in normalized_carry_in_rows
                    if _group_key(row, group_by) == key
                ],
                bucket_start=bucket_start,
                applied_row_indexes=grouped_applied_carry_in_row_indexes,
            )
            buckets.append(
                _build_bucket(
                    bucket_start=bucket_start,
                    bucket_end=bucket_end,
                    rows=grouped_rows[key],
                    carry_in_rows=bucket_carry_in_rows,
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
    carry_in_rows: Sequence[_NormalizedFill] = (),
    group_by: Sequence[str] = (),
    group_key: tuple[str | None, ...] = (),
    carried_positions: dict[tuple[str | None, str | None, str | None], _PositionState]
    | None = None,
    require_order_lifecycle: bool = False,
) -> RuntimeLedgerBucket:
    blockers: list[str] = []
    for row in [*carry_in_rows, *rows]:
        blockers.extend(row.blockers)
        blockers.extend(row.bucket_blockers)

    lifecycle_rows = [
        row for row in [*carry_in_rows, *rows] if row.event_type in _LIFECYCLE_EVENTS
    ]
    source_authority_claimed = any(
        _row_requires_promotion_source_authority(row) for row in lifecycle_rows
    )
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
    carry_in_usable_fills = [row for row in carry_in_rows if row.is_usable_fill]
    all_usable_fills = [*carry_in_usable_fills, *usable_fills]
    current_bucket_filled_notional = sum(
        (
            row.filled_notional
            for row in usable_fills
            if row.filled_notional is not None
        ),
        Decimal("0"),
    )
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
    for row in all_usable_fills:
        if row.cost_model_hash is not None:
            cost_model_hash_counter[row.cost_model_hash] += 1

    positions: dict[tuple[str | None, str | None, str | None], _PositionState] = (
        carried_positions if carried_positions is not None else {}
    )
    carry_in_accumulator = _LedgerAccumulator()
    for fill in sorted(
        carry_in_usable_fills,
        key=lambda item: (item.executed_at or bucket_start, item.row_index),
    ):
        assert fill.side is not None
        assert fill.filled_qty is not None
        assert fill.avg_fill_price is not None
        assert fill.filled_notional is not None
        assert fill.cost_amount is not None
        assert fill.cost_basis is not None

        cost_basis_counter[fill.cost_basis] += 1
        position_key = (fill.account_label, fill.strategy_id, fill.symbol)
        state = positions.setdefault(position_key, _PositionState())
        _apply_fill_to_position(
            state=state,
            fill=fill,
            accumulator=carry_in_accumulator,
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
    if (
        usable_fills or source_authority_claimed
    ) and accumulator.closed_trade_count <= 0:
        blockers.append("closed_round_trip_missing")
    if open_position_count > 0:
        blockers.append("unclosed_position")
    reported_filled_notional = max(
        accumulator.filled_notional,
        current_bucket_filled_notional,
    )
    if reported_filled_notional <= 0:
        blockers.append("filled_notional_missing")
    if require_order_lifecycle or source_authority_claimed:
        source_lifecycle_present = any(
            row.order_feed_lifecycle_source for row in lifecycle_rows
        )
        blockers.extend(
            _order_lifecycle_blockers(
                lifecycle_rows=lifecycle_rows,
                fill_lifecycle_rows=[
                    row
                    for row in lifecycle_rows
                    if row.event_type in _FILL_EVENTS
                    and (
                        row.order_feed_lifecycle_source or not source_lifecycle_present
                    )
                ],
                usable_fills=all_usable_fills,
                decision_count=decision_count,
                submitted_order_count=submitted_order_count,
                rejected_order_count=rejected_order_count,
                unfilled_order_count=unfilled_order_count,
                execution_policy_hash_counter=execution_policy_hash_counter,
                cost_model_hash_counter=cost_model_hash_counter,
                lineage_hash_counter=lineage_hash_counter,
            )
        )
    blockers.extend(_source_materialization_blockers(lifecycle_rows))

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
    # Realized post-cost expectancy is an economic measurement. Keep it populated
    # when the closed-trip economics are complete even if separate lifecycle or
    # source-authority blockers still prevent promotion.
    if diagnostic_closed_trade_expectancy_bps is not None and not (
        _POST_COST_EXPECTANCY_SUPPRESSING_BLOCKERS & set(unique_blockers)
    ):
        post_cost_expectancy_bps = diagnostic_closed_trade_expectancy_bps
    if source_authority_claimed and diagnostic_closed_trade_expectancy_bps is None:
        unique_blockers = _dedupe(
            [*unique_blockers, "runtime_ledger_expectancy_missing"]
        )

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
        filled_notional=reported_filled_notional,
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


def _carry_in_rows_before_bucket(
    rows: Sequence[_NormalizedFill],
    *,
    bucket_start: datetime,
    applied_row_indexes: set[int],
) -> list[_NormalizedFill]:
    bucket_rows = [
        row
        for row in rows
        if row.row_index not in applied_row_indexes
        and row.executed_at is not None
        and row.executed_at < bucket_start
    ]
    applied_row_indexes.update(row.row_index for row in bucket_rows)
    return bucket_rows


# Public aliases used by split-module consumers.
BPS_MULTIPLIER = _BPS_MULTIPLIER
BUY_SIDES = _BUY_SIDES
CANCELLED_ORDER_EVENTS = _CANCELLED_ORDER_EVENTS
DECISION_EVENTS = _DECISION_EVENTS
DELTA_FILL_QUANTITY_BASES = _DELTA_FILL_QUANTITY_BASES
DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS = _DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS
EXECUTION_RECONSTRUCTION_MARKERS = _EXECUTION_RECONSTRUCTION_MARKERS
FILL_EVENTS = _FILL_EVENTS
LIFECYCLE_EVENTS = _LIFECYCLE_EVENTS
LedgerAccumulator = _LedgerAccumulator
NON_PROMOTION_SOURCE_MARKERS = _NON_PROMOTION_SOURCE_MARKERS
NON_RUNTIME_PNL_TCA_BASIS_ALIASES = _NON_RUNTIME_PNL_TCA_BASIS_ALIASES
NormalizedFill = _NormalizedFill
POST_COST_EXPECTANCY_SUPPRESSING_BLOCKERS = _POST_COST_EXPECTANCY_SUPPRESSING_BLOCKERS
PROMOTION_GRADE_AUTHORITY_CLASSES = _PROMOTION_GRADE_AUTHORITY_CLASSES
PROMOTION_GRADE_SOURCE_MATERIALIZATIONS = _PROMOTION_GRADE_SOURCE_MATERIALIZATIONS
PositionState = _PositionState
REJECTED_ORDER_EVENTS = _REJECTED_ORDER_EVENTS
SELL_SIDES = _SELL_SIDES
SOURCE_DECISION_COLLECTION_MARKERS = _SOURCE_DECISION_COLLECTION_MARKERS
SOURCE_REF_BLOCKER_AUTHORITY_CLASS_MISSING = _SOURCE_REF_BLOCKER_AUTHORITY_CLASS_MISSING
SOURCE_REF_BLOCKER_EXECUTION_MISSING = _SOURCE_REF_BLOCKER_EXECUTION_MISSING
SOURCE_REF_BLOCKER_EXECUTION_ORDER_EVENT_MISSING = (
    _SOURCE_REF_BLOCKER_EXECUTION_ORDER_EVENT_MISSING
)
SOURCE_REF_BLOCKER_SOURCE_MATERIALIZATION_MISSING = (
    _SOURCE_REF_BLOCKER_SOURCE_MATERIALIZATION_MISSING
)
SOURCE_REF_BLOCKER_SOURCE_OFFSETS_MISSING = _SOURCE_REF_BLOCKER_SOURCE_OFFSETS_MISSING
SOURCE_REF_BLOCKER_SOURCE_WINDOW_MISSING = _SOURCE_REF_BLOCKER_SOURCE_WINDOW_MISSING
SOURCE_REF_BLOCKER_TRADE_DECISION_MISSING = _SOURCE_REF_BLOCKER_TRADE_DECISION_MISSING
SUBMITTED_ORDER_EVENTS = _SUBMITTED_ORDER_EVENTS
TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER = (
    _TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER
)
TIGERBEETLE_JOURNAL_SUCCESS_STATUSES = _TIGERBEETLE_JOURNAL_SUCCESS_STATUSES
UNFILLED_ORDER_EVENTS = _UNFILLED_ORDER_EVENTS
build_bucket = _build_bucket
carry_in_rows_before_bucket = _carry_in_rows_before_bucket

__all__ = (
    "POST_COST_PNL_BASIS",
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "RuntimeLedgerFill",
    "RuntimeLedgerBucket",
    "build_runtime_ledger_buckets",
    "BPS_MULTIPLIER",
    "BUY_SIDES",
    "CANCELLED_ORDER_EVENTS",
    "DECISION_EVENTS",
    "DELTA_FILL_QUANTITY_BASES",
    "DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS",
    "EXECUTION_RECONSTRUCTION_MARKERS",
    "FILL_EVENTS",
    "LIFECYCLE_EVENTS",
    "LedgerAccumulator",
    "NON_PROMOTION_SOURCE_MARKERS",
    "NON_RUNTIME_PNL_TCA_BASIS_ALIASES",
    "NormalizedFill",
    "POST_COST_EXPECTANCY_SUPPRESSING_BLOCKERS",
    "PROMOTION_GRADE_AUTHORITY_CLASSES",
    "PROMOTION_GRADE_SOURCE_MATERIALIZATIONS",
    "PositionState",
    "REJECTED_ORDER_EVENTS",
    "SELL_SIDES",
    "SOURCE_DECISION_COLLECTION_MARKERS",
    "SOURCE_REF_BLOCKER_AUTHORITY_CLASS_MISSING",
    "SOURCE_REF_BLOCKER_EXECUTION_MISSING",
    "SOURCE_REF_BLOCKER_EXECUTION_ORDER_EVENT_MISSING",
    "SOURCE_REF_BLOCKER_SOURCE_MATERIALIZATION_MISSING",
    "SOURCE_REF_BLOCKER_SOURCE_OFFSETS_MISSING",
    "SOURCE_REF_BLOCKER_SOURCE_WINDOW_MISSING",
    "SOURCE_REF_BLOCKER_TRADE_DECISION_MISSING",
    "SUBMITTED_ORDER_EVENTS",
    "TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER",
    "TIGERBEETLE_JOURNAL_SUCCESS_STATUSES",
    "UNFILLED_ORDER_EVENTS",
    "build_bucket",
    "carry_in_rows_before_bucket",
)


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "BPS_MULTIPLIER",
    "BUY_SIDES",
    "CANCELLED_ORDER_EVENTS",
    "Counter",
    "DECISION_EVENTS",
    "DELTA_FILL_QUANTITY_BASES",
    "DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS",
    "Decimal",
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "EXECUTION_RECONSTRUCTION_MARKERS",
    "FILL_EVENTS",
    "LIFECYCLE_EVENTS",
    "LedgerAccumulator",
    "Mapping",
    "NON_PROMOTION_SOURCE_MARKERS",
    "NON_RUNTIME_PNL_TCA_BASIS_ALIASES",
    "NormalizedFill",
    "POST_COST_EXPECTANCY_SUPPRESSING_BLOCKERS",
    "POST_COST_PNL_BASIS",
    "PROMOTION_GRADE_AUTHORITY_CLASSES",
    "PROMOTION_GRADE_SOURCE_MATERIALIZATIONS",
    "PositionState",
    "REJECTED_ORDER_EVENTS",
    "RuntimeLedgerBucket",
    "RuntimeLedgerFill",
    "SELL_SIDES",
    "SOURCE_DECISION_COLLECTION_MARKERS",
    "SOURCE_REF_BLOCKER_AUTHORITY_CLASS_MISSING",
    "SOURCE_REF_BLOCKER_EXECUTION_MISSING",
    "SOURCE_REF_BLOCKER_EXECUTION_ORDER_EVENT_MISSING",
    "SOURCE_REF_BLOCKER_SOURCE_MATERIALIZATION_MISSING",
    "SOURCE_REF_BLOCKER_SOURCE_OFFSETS_MISSING",
    "SOURCE_REF_BLOCKER_SOURCE_WINDOW_MISSING",
    "SOURCE_REF_BLOCKER_TRADE_DECISION_MISSING",
    "SUBMITTED_ORDER_EVENTS",
    "Sequence",
    "TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER",
    "TIGERBEETLE_JOURNAL_SUCCESS_STATUSES",
    "UNFILLED_ORDER_EVENTS",
    "_BPS_MULTIPLIER",
    "_BUY_SIDES",
    "_CANCELLED_ORDER_EVENTS",
    "_DECISION_EVENTS",
    "_DELTA_FILL_QUANTITY_BASES",
    "_DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS",
    "_EXECUTION_RECONSTRUCTION_MARKERS",
    "_FILL_EVENTS",
    "_LIFECYCLE_EVENTS",
    "_LedgerAccumulator",
    "_NON_PROMOTION_SOURCE_MARKERS",
    "_NON_RUNTIME_PNL_TCA_BASIS_ALIASES",
    "_NormalizedFill",
    "_POST_COST_EXPECTANCY_SUPPRESSING_BLOCKERS",
    "_PROMOTION_GRADE_AUTHORITY_CLASSES",
    "_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS",
    "_PositionState",
    "_REJECTED_ORDER_EVENTS",
    "_SELL_SIDES",
    "_SOURCE_DECISION_COLLECTION_MARKERS",
    "_SOURCE_REF_BLOCKER_AUTHORITY_CLASS_MISSING",
    "_SOURCE_REF_BLOCKER_EXECUTION_MISSING",
    "_SOURCE_REF_BLOCKER_EXECUTION_ORDER_EVENT_MISSING",
    "_SOURCE_REF_BLOCKER_SOURCE_MATERIALIZATION_MISSING",
    "_SOURCE_REF_BLOCKER_SOURCE_OFFSETS_MISSING",
    "_SOURCE_REF_BLOCKER_SOURCE_WINDOW_MISSING",
    "_SOURCE_REF_BLOCKER_TRADE_DECISION_MISSING",
    "_SUBMITTED_ORDER_EVENTS",
    "_TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER",
    "_TIGERBEETLE_JOURNAL_SUCCESS_STATUSES",
    "_UNFILLED_ORDER_EVENTS",
    "_apply_fill_to_position",
    "_bucket_field",
    "_build_bucket",
    "_carry_in_rows_before_bucket",
    "_dedupe",
    "_group_key",
    "_lifecycle_helper_module",
    "_order_lifecycle_blockers",
    "_row_helper_module",
    "_row_requires_promotion_source_authority",
    "_source_materialization_blockers",
    "_utc",
    "annotations",
    "build_bucket",
    "build_runtime_ledger_buckets",
    "carry_in_rows_before_bucket",
    "cast",
    "dataclass",
    "datetime",
    "is_non_promotion_grade_runtime_cost_basis",
    "timezone",
)
