# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnusedImport=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false
"""Sell-inventory conflict payload helpers for order execution."""

from __future__ import annotations

# ruff: noqa: F401,F811,F821

from .shared_context import (
    Any,
    Decimal,
    Execution,
    ExecutionRequest,
    IntegrityError,
    LeanExecutionShadowEvent,
    Mapping,
    NamedTuple,
    Optional,
    Sequence,
    Session,
    Strategy,
    StrategyDecision,
    TradeDecision,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE as _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    COST_MODEL_HASH_KEYS as _COST_MODEL_HASH_KEYS,
    COST_MODEL_PAYLOAD_KEYS as _COST_MODEL_PAYLOAD_KEYS,
    EXECUTION_POLICY_HASH_KEYS as _EXECUTION_POLICY_HASH_KEYS,
    LINEAGE_HASH_KEYS as _LINEAGE_HASH_KEYS,
    LINEAGE_PAYLOAD_KEYS as _LINEAGE_PAYLOAD_KEYS,
    OrderExecutorFields as _OrderExecutorFields,
    RUNTIME_COST_AMOUNT_KEYS as _RUNTIME_COST_AMOUNT_KEYS,
    RUNTIME_COST_BASIS_KEYS as _RUNTIME_COST_BASIS_KEYS,
    RUNTIME_COST_PAYLOAD_KEYS as _RUNTIME_COST_PAYLOAD_KEYS,
    SHORTING_METADATA_CACHE_TTL_SECONDS as _SHORTING_METADATA_CACHE_TTL_SECONDS,
    TARGET_PLAN_SOURCE_DECISION_MODE as _TARGET_PLAN_SOURCE_DECISION_MODE,
    TARGET_PLAN_SOURCE_DECISION_REQUIRED_REFS as _TARGET_PLAN_SOURCE_DECISION_REQUIRED_REFS,
    has_target_plan_source_decision as _has_target_plan_source_decision,
    mapping_payload as _mapping_payload,
    target_plan_ref_value as _target_plan_ref_value,
    target_plan_source_decision_mode as _target_plan_source_decision_mode,
    target_plan_source_decision_needs_refresh as _target_plan_source_decision_needs_refresh,
    target_plan_source_metadata as _target_plan_source_metadata,
    cast,
    coerce_json_payload,
    datetime,
    decision_hash,
    hashlib,
    json,
    logger,
    logging,
    min_qty_for_symbol,
    qty_has_valid_increment,
    qty_step_for_symbol,
    quantize_qty_for_symbol,
    resolve_event_persisted_at,
    resolve_order_route_metadata,
    resolve_quantity_resolution,
    resolve_simulation_context,
    select,
    settings,
    should_retry_order_error,
    simulation_context_enabled,
    sync_order_to_db,
    time,
    timezone,
    trading_now,
    upsert_execution_tca_metric,
)
from .order_executor_core_methods import (
    OrderExecutorCoreMethods as _OrderExecutorCoreMethods,
)
from .order_executor_core_support import (
    PreparedOrderSubmission as _PreparedOrderSubmission,
    ResolvedSellInventory as _ResolvedSellInventory,
    SellInventoryReservations as _SellInventoryReservations,
    execution_request_from_decision as _execution_request_from_decision,
    merge_execution_audit as _merge_execution_audit,
    open_sell_order_reserves_symbol as _open_sell_order_reserves_symbol,
    order_payload_with_execution_metadata as _order_payload_with_execution_metadata,
    sell_inventory_metadata_update as _sell_inventory_metadata_update,
    sell_inventory_request_symbol as _sell_inventory_request_symbol,
    submission_extra_params as _submission_extra_params,
)


def _unknown_position_sell_inventory_conflict(
    request: ExecutionRequest,
    *,
    request_symbol: str,
    reservations: _SellInventoryReservations,
) -> dict[str, Any] | None:
    if request.qty > reservations.held_qty:
        return None
    return {
        "source": "broker_precheck",
        "code": "precheck_sell_qty_exceeds_available",
        "reject_reason": (
            "sell qty may exceed available inventory; position lookup unavailable and "
            "open sell reservations cover requested qty"
        ),
        "symbol": request_symbol,
        "qty": str(request.qty),
        "position_qty": None,
        "held_for_open_sells": str(reservations.held_qty),
        "available_qty": None,
        "existing_order_id": _first_order_id(reservations),
        "existing_order_ids": reservations.existing_order_ids,
    }


def _sell_inventory_conflict_payload(
    request: ExecutionRequest,
    *,
    request_symbol: str,
    reservations: _SellInventoryReservations,
    position_qty: Decimal,
    available_qty: Decimal,
) -> dict[str, Any]:
    return {
        "source": "broker_precheck",
        "code": "precheck_sell_qty_exceeds_available",
        "reject_reason": "sell qty exceeds available inventory after open sell reservations",
        "symbol": request_symbol,
        "qty": str(request.qty),
        "position_qty": str(position_qty),
        "held_for_open_sells": str(reservations.held_qty),
        "available_qty": str(available_qty),
        "existing_order_id": _first_order_id(reservations),
        "existing_order_ids": reservations.existing_order_ids,
    }


def _first_order_id(reservations: _SellInventoryReservations) -> str | None:
    if not reservations.existing_order_ids:
        return None
    return reservations.existing_order_ids[0]


# Public aliases used by split-module consumers.
sell_inventory_conflict_payload = _sell_inventory_conflict_payload
unknown_position_sell_inventory_conflict = _unknown_position_sell_inventory_conflict

__all__ = (
    "sell_inventory_conflict_payload",
    "unknown_position_sell_inventory_conflict",
)
