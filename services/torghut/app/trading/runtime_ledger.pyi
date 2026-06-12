from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast
from .runtime_cost_authority import is_non_promotion_grade_runtime_cost_basis

POST_COST_PNL_BASIS: Any
EXACT_REPLAY_LEDGER_SCHEMA_VERSION: Any
_BPS_MULTIPLIER: Any
_BUY_SIDES: Any
_SELL_SIDES: Any
_DECISION_EVENTS: Any
_SUBMITTED_ORDER_EVENTS: Any
_FILL_EVENTS: Any
_CANCELLED_ORDER_EVENTS: Any
_REJECTED_ORDER_EVENTS: Any
_UNFILLED_ORDER_EVENTS: Any
_LIFECYCLE_EVENTS: Any
_NON_RUNTIME_PNL_TCA_BASIS_ALIASES: Any
_DELTA_FILL_QUANTITY_BASES: Any
_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS: Any
_NON_PROMOTION_SOURCE_MARKERS: Any
_SOURCE_DECISION_COLLECTION_MARKERS: Any
_EXECUTION_RECONSTRUCTION_MARKERS: Any
_TIGERBEETLE_EXECUTION_COST_JOURNAL_FAILURE_BLOCKER: Any
_TIGERBEETLE_JOURNAL_SUCCESS_STATUSES: Any
_DIAGNOSTIC_EXPECTANCY_SUPPRESSING_BLOCKERS: Any
_POST_COST_EXPECTANCY_SUPPRESSING_BLOCKERS: Any
_SOURCE_REF_BLOCKER_SOURCE_WINDOW_MISSING: Any
_SOURCE_REF_BLOCKER_TRADE_DECISION_MISSING: Any
_SOURCE_REF_BLOCKER_EXECUTION_MISSING: Any
_SOURCE_REF_BLOCKER_EXECUTION_ORDER_EVENT_MISSING: Any
_SOURCE_REF_BLOCKER_SOURCE_OFFSETS_MISSING: Any
_SOURCE_REF_BLOCKER_SOURCE_MATERIALIZATION_MISSING: Any
_SOURCE_REF_BLOCKER_AUTHORITY_CLASS_MISSING: Any
_PROMOTION_GRADE_AUTHORITY_CLASSES: Any

class RuntimeLedgerFill:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    executed_at: datetime
    side: str
    filled_qty: Decimal
    avg_fill_price: Decimal | None
    filled_notional: Decimal | None
    filled_qty_delta: Decimal | None
    filled_notional_delta: Decimal | None
    fill_quantity_basis: str | None
    cost_amount: Decimal | None
    cost_basis: str | None
    account_label: str | None
    strategy_id: str | None
    symbol: str | None
    source: str
    event_type: str | None
    decision_id: str | None
    order_id: str | None
    execution_policy_hash: str | None
    cost_model_hash: str | None
    lineage_hash: str | None
    replay_data_hash: str | None

class RuntimeLedgerBucket:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
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
    diagnostic_closed_trade_expectancy_bps: Decimal | None
    ledger_schema_version: str
    pnl_basis: str

class _NormalizedFill:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
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
    bucket_blockers: tuple[str, ...]
    filled_qty_delta: Decimal | None
    filled_notional_delta: Decimal | None
    fill_quantity_basis: str | None
    lifecycle_only: bool
    order_feed_lifecycle_source: bool
    execution_id: str | None
    execution_order_event_id: str | None
    source_window_id: str | None
    source_offset_present: bool
    source_materialization: str | None
    authority_class: str | None
    def is_usable_fill(*args: Any, **kwargs: Any) -> Any: ...

class _PositionState:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    qty: Decimal
    avg_price: Decimal | None
    entry_cost_remaining: Decimal

class _LedgerAccumulator:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    filled_notional: Decimal
    cost_amount: Decimal
    gross_strategy_pnl: Decimal
    net_strategy_pnl_after_costs: Decimal
    closed_trade_count: int

def build_runtime_ledger_buckets(*args: Any, **kwargs: Any) -> Any: ...
def _build_bucket(*args: Any, **kwargs: Any) -> Any: ...
def _carry_in_rows_before_bucket(*args: Any, **kwargs: Any) -> Any: ...
def _order_lifecycle_blockers(*args: Any, **kwargs: Any) -> Any: ...
def _source_materialization_blockers(*args: Any, **kwargs: Any) -> Any: ...
def _row_requires_promotion_source_authority(*args: Any, **kwargs: Any) -> Any: ...
def _apply_fill_to_position(*args: Any, **kwargs: Any) -> Any: ...
def _open_position(*args: Any, **kwargs: Any) -> Any: ...
def _normalize_fill_row(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_event_type(*args: Any, **kwargs: Any) -> Any: ...
def _row_value(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_fill_quantity_basis(*args: Any, **kwargs: Any) -> Any: ...
def _is_order_feed_lifecycle_source_row(*args: Any, **kwargs: Any) -> Any: ...
def _is_order_feed_source_row(*args: Any, **kwargs: Any) -> Any: ...
def _is_order_feed_source_fill(*args: Any, **kwargs: Any) -> Any: ...
def _is_linked_materialized_order_event_fill(*args: Any, **kwargs: Any) -> Any: ...
def _source_offset_present(*args: Any, **kwargs: Any) -> Any: ...
def _is_non_promotion_runtime_source_row(*args: Any, **kwargs: Any) -> Any: ...
def _runtime_source_collection_mode_blockers(*args: Any, **kwargs: Any) -> Any: ...
def _runtime_source_hard_mode_blockers(*args: Any, **kwargs: Any) -> Any: ...
def _is_order_feed_lifecycle_only_row(*args: Any, **kwargs: Any) -> Any: ...
def _has_tca_pnl_shortcut(*args: Any, **kwargs: Any) -> Any: ...
def _basis_claims_tca_pnl_shortcut(*args: Any, **kwargs: Any) -> Any: ...
def _tigerbeetle_journal_blockers(*args: Any, **kwargs: Any) -> Any: ...
def _group_key(*args: Any, **kwargs: Any) -> Any: ...
def _bucket_field(*args: Any, **kwargs: Any) -> Any: ...
def _normalized_fill_field(*args: Any, **kwargs: Any) -> Any: ...
def _same_direction(*args: Any, **kwargs: Any) -> Any: ...
def _allocate(*args: Any, **kwargs: Any) -> Any: ...
def _utc(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_datetime(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_text(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_side(*args: Any, **kwargs: Any) -> Any: ...
def _positive_decimal(*args: Any, **kwargs: Any) -> Any: ...
def _non_negative_decimal(*args: Any, **kwargs: Any) -> Any: ...
def _decimal(*args: Any, **kwargs: Any) -> Any: ...
def _dedupe(*args: Any, **kwargs: Any) -> Any: ...

__all__: Any
