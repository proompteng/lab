"""Support helpers for order-executor core methods."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, NamedTuple, cast

from ...models import TradeDecision
from ..models import ExecutionRequest, StrategyDecision


def _extract_execution_policy_context(
    decision: StrategyDecision,
    *,
    decision_row: TradeDecision,
) -> dict[str, Any]:
    from .validate_pre_submit_request import (
        extract_execution_policy_context,
    )

    return extract_execution_policy_context(decision, decision_row=decision_row)


def _coerce_json(value: Any) -> dict[str, Any]:
    from .order_executor_submission_methods import (
        coerce_json,
    )

    return coerce_json(value)


def _coerce_string_list(value: Any) -> list[str]:
    from .order_executor_submission_methods import (
        coerce_string_list,
    )

    return coerce_string_list(value)


def _merge_unique_strings(existing: list[str], updates: list[str]) -> list[str]:
    from .order_executor_submission_methods import (
        merge_unique_strings,
    )

    return merge_unique_strings(existing, updates)


def _merge_decision_metadata(
    target: dict[str, Any], metadata_update: Mapping[str, Any] | None
) -> None:
    from .order_executor_submission_methods import (
        merge_decision_metadata,
    )

    merge_decision_metadata(target, metadata_update)


def _normalize_reject_reasons(reason: str) -> list[Any]:
    from .order_executor_submission_methods import (
        normalize_reject_reasons,
    )

    return normalize_reject_reasons(reason)


def _normalize_submission_block_reasons(reason: str) -> list[str]:
    from .order_executor_submission_methods import (
        normalize_submission_block_reasons,
    )

    return normalize_submission_block_reasons(reason)


def _extract_sizing_debug(decision_json: Mapping[str, Any]) -> dict[str, Any]:
    from .order_executor_submission_methods import (
        extract_sizing_debug,
    )

    return extract_sizing_debug(decision_json)


def _validate_pre_submit_request(*args: Any, **kwargs: Any) -> dict[str, Any] | None:
    from .validate_pre_submit_request import (
        validate_pre_submit_request,
    )

    return validate_pre_submit_request(*args, **kwargs)


def _persist_lean_shadow_event(*args: Any, **kwargs: Any) -> None:
    from .validate_pre_submit_request import (
        persist_lean_shadow_event,
    )

    persist_lean_shadow_event(*args, **kwargs)


def _attach_execution_policy_context(*args: Any, **kwargs: Any) -> None:
    from .validate_pre_submit_request import (
        attach_execution_policy_context,
    )

    attach_execution_policy_context(*args, **kwargs)


def _apply_execution_status(*args: Any, **kwargs: Any) -> None:
    from .validate_pre_submit_request import (
        apply_execution_status,
    )

    apply_execution_status(*args, **kwargs)


def _decision_state_payload(decision: StrategyDecision) -> dict[str, Any]:
    from .order_executor_submission_methods import (
        decision_state_payload,
    )

    return decision_state_payload(decision)


def _unknown_position_sell_inventory_conflict(
    *args: Any, **kwargs: Any
) -> dict[str, Any] | None:
    from .sell_inventory_payloads import (
        unknown_position_sell_inventory_conflict as unknown_position_conflict,
    )

    return unknown_position_conflict(*args, **kwargs)


def _sell_inventory_conflict_payload(
    *args: Any, **kwargs: Any
) -> dict[str, Any] | None:
    from .sell_inventory_payloads import (
        sell_inventory_conflict_payload,
    )

    return sell_inventory_conflict_payload(*args, **kwargs)


def _optional_decimal(value: Any) -> Decimal | None:
    from .validate_pre_submit_request import (
        optional_decimal,
    )

    return optional_decimal(value)


def _resolve_submission_simulation_context(*args: Any, **kwargs: Any) -> Any:
    from .validate_pre_submit_request import (
        resolve_submission_simulation_context,
    )

    return resolve_submission_simulation_context(*args, **kwargs)


def _extract_execution_advice_provenance(
    *args: Any, **kwargs: Any
) -> dict[str, Any] | None:
    from .validate_pre_submit_request import (
        extract_execution_advice_provenance,
    )

    return extract_execution_advice_provenance(*args, **kwargs)


def _extract_execution_metadata(*args: Any, **kwargs: Any) -> dict[str, Any] | None:
    from .validate_pre_submit_request import (
        extract_execution_metadata,
    )

    return extract_execution_metadata(*args, **kwargs)


class _PreparedOrderSubmission(NamedTuple):
    request: ExecutionRequest
    quantity_resolution: Any
    extra_params: dict[str, Any]


class _SellInventoryReservations(NamedTuple):
    held_qty: Decimal
    existing_order_ids: list[str]


class _ResolvedSellInventory(NamedTuple):
    request: ExecutionRequest
    decision: StrategyDecision


def _execution_request_from_decision(
    decision: StrategyDecision,
    decision_row: TradeDecision,
) -> ExecutionRequest:
    return ExecutionRequest(
        decision_id=str(decision_row.id),
        symbol=decision.symbol,
        side=decision.action,
        qty=decision.qty,
        order_type=decision.order_type,
        time_in_force=decision.time_in_force,
        limit_price=decision.limit_price,
        stop_price=decision.stop_price,
        client_order_id=decision_row.decision_hash,
    )


def _submission_extra_params(
    *,
    execution_client: Any,
    decision: StrategyDecision,
    decision_row: TradeDecision,
    execution_policy_context: dict[str, Any],
    request: ExecutionRequest,
) -> dict[str, Any]:
    extra_params: dict[str, Any] = {"client_order_id": request.client_order_id}
    simulation_context = _resolve_submission_simulation_context(
        execution_client=execution_client,
        decision=decision,
        decision_row=decision_row,
        execution_policy_context=execution_policy_context,
    )
    if simulation_context is not None:
        extra_params["simulation_context"] = simulation_context
    return extra_params


def _order_payload_with_execution_metadata(
    order_response: Any,
    decision: StrategyDecision,
    *,
    decision_row: TradeDecision,
    execution_policy_context: dict[str, Any],
) -> dict[str, Any]:
    order_payload = dict(order_response)
    advice_provenance = _extract_execution_advice_provenance(
        decision,
        decision_row=decision_row,
    )
    if advice_provenance is not None:
        order_payload["_execution_advice_provenance"] = advice_provenance
    execution_metadata = _extract_execution_metadata(
        decision,
        decision_row=decision_row,
        execution_policy_context=execution_policy_context,
    )
    if execution_metadata is not None:
        _merge_execution_audit(order_payload, execution_metadata)
    return order_payload


def _merge_execution_audit(
    order_payload: dict[str, Any],
    execution_metadata: Mapping[str, Any],
) -> None:
    existing_audit = order_payload.get("_execution_audit")
    audit_payload = (
        {
            str(key): value
            for key, value in cast(Mapping[object, Any], existing_audit).items()
        }
        if isinstance(existing_audit, Mapping)
        else {}
    )
    audit_payload.update(execution_metadata)
    order_payload["_execution_audit"] = audit_payload


def _sell_inventory_metadata_update(
    adjustment: dict[str, Any] | None,
    recovery: dict[str, Any] | None,
) -> dict[str, Any]:
    metadata_update: dict[str, Any] = {}
    if adjustment is not None:
        metadata_update["broker_precheck_adjustment"] = adjustment
    if recovery is not None:
        metadata_update["broker_precheck_recovery"] = recovery
    return metadata_update


def _sell_inventory_request_symbol(request: ExecutionRequest) -> str | None:
    request_symbol = request.symbol.strip().upper()
    request_side = request.side.strip().lower()
    if not request_symbol or request_side != "sell":
        return None
    return request_symbol


def _open_sell_order_reserves_symbol(
    order: Mapping[str, Any],
    request_symbol: str,
) -> bool:
    symbol = str(order.get("symbol") or "").strip().upper()
    if symbol != request_symbol:
        return False
    side = str(order.get("side") or "").strip().lower()
    if side != "sell":
        return False
    status = str(order.get("status") or "").strip().lower()
    return status not in {"filled", "canceled", "cancelled", "rejected", "expired"}


# Public aliases used by split-module consumers.
PreparedOrderSubmission = _PreparedOrderSubmission
ResolvedSellInventory = _ResolvedSellInventory
SellInventoryReservations = _SellInventoryReservations
apply_execution_status = _apply_execution_status
attach_execution_policy_context = _attach_execution_policy_context
coerce_json = _coerce_json
coerce_string_list = _coerce_string_list
decision_state_payload = _decision_state_payload
extract_execution_advice_provenance = _extract_execution_advice_provenance
extract_execution_metadata = _extract_execution_metadata
extract_execution_policy_context = _extract_execution_policy_context
extract_sizing_debug = _extract_sizing_debug
execution_request_from_decision = _execution_request_from_decision
merge_decision_metadata = _merge_decision_metadata
merge_execution_audit = _merge_execution_audit
merge_unique_strings = _merge_unique_strings
normalize_reject_reasons = _normalize_reject_reasons
normalize_submission_block_reasons = _normalize_submission_block_reasons
open_sell_order_reserves_symbol = _open_sell_order_reserves_symbol
optional_decimal = _optional_decimal
order_payload_with_execution_metadata = _order_payload_with_execution_metadata
persist_lean_shadow_event = _persist_lean_shadow_event
resolve_submission_simulation_context = _resolve_submission_simulation_context
sell_inventory_conflict_payload = _sell_inventory_conflict_payload
sell_inventory_metadata_update = _sell_inventory_metadata_update
sell_inventory_request_symbol = _sell_inventory_request_symbol
submission_extra_params = _submission_extra_params
unknown_position_sell_inventory_conflict = _unknown_position_sell_inventory_conflict
validate_pre_submit_request = _validate_pre_submit_request

__all__ = [
    "PreparedOrderSubmission",
    "ResolvedSellInventory",
    "SellInventoryReservations",
    "apply_execution_status",
    "attach_execution_policy_context",
    "coerce_json",
    "coerce_string_list",
    "decision_state_payload",
    "extract_execution_advice_provenance",
    "extract_execution_metadata",
    "extract_execution_policy_context",
    "extract_sizing_debug",
    "execution_request_from_decision",
    "merge_decision_metadata",
    "merge_execution_audit",
    "merge_unique_strings",
    "normalize_reject_reasons",
    "normalize_submission_block_reasons",
    "open_sell_order_reserves_symbol",
    "optional_decimal",
    "order_payload_with_execution_metadata",
    "persist_lean_shadow_event",
    "resolve_submission_simulation_context",
    "sell_inventory_conflict_payload",
    "sell_inventory_metadata_update",
    "sell_inventory_request_symbol",
    "submission_extra_params",
    "unknown_position_sell_inventory_conflict",
    "validate_pre_submit_request",
]
