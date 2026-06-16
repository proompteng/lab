# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnusedImport=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportPrivateUsage=false, reportUnsupportedDunderAll=false
"""Sell-inventory conflict payload helpers for order execution."""

from __future__ import annotations

# ruff: noqa: F401,F403,F405,F811,F821

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
    _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    _COST_MODEL_HASH_KEYS,
    _COST_MODEL_PAYLOAD_KEYS,
    _EXECUTION_POLICY_HASH_KEYS,
    _LINEAGE_HASH_KEYS,
    _LINEAGE_PAYLOAD_KEYS,
    _OrderExecutorFields,
    _RUNTIME_COST_AMOUNT_KEYS,
    _RUNTIME_COST_BASIS_KEYS,
    _RUNTIME_COST_PAYLOAD_KEYS,
    _SHORTING_METADATA_CACHE_TTL_SECONDS,
    _TARGET_PLAN_SOURCE_DECISION_MODE,
    _TARGET_PLAN_SOURCE_DECISION_REQUIRED_REFS,
    _has_target_plan_source_decision,
    _mapping_payload,
    _target_plan_ref_value,
    _target_plan_source_decision_mode,
    _target_plan_source_decision_needs_refresh,
    _target_plan_source_metadata,
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
    _OrderExecutorCoreMethods,
    _PreparedOrderSubmission,
    _ResolvedSellInventory,
    _SellInventoryReservations,
    _execution_request_from_decision,
    _merge_execution_audit,
    _open_sell_order_reserves_symbol,
    _order_payload_with_execution_metadata,
    _sell_inventory_metadata_update,
    _sell_inventory_request_symbol,
    _submission_extra_params,
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


__all__ = [name for name in globals() if not name.startswith("__")]
