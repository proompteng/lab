"""Order execution and idempotency helpers."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional, cast

from sqlalchemy.orm import Session

from ...models import (
    Execution,
    LeanExecutionShadowEvent,
    TradeDecision,
    coerce_json_payload,
)
from ..models import ExecutionRequest, StrategyDecision
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    qty_has_valid_increment,
    qty_step_for_symbol,
)
from ..simulation import (
    resolve_simulation_context,
    simulation_context_enabled,
)
from ..time_source import trading_now


from .shared_context import (
    COST_MODEL_HASH_KEYS as _COST_MODEL_HASH_KEYS,
    COST_MODEL_PAYLOAD_KEYS as _COST_MODEL_PAYLOAD_KEYS,
    EXECUTION_POLICY_HASH_KEYS as _EXECUTION_POLICY_HASH_KEYS,
    LINEAGE_HASH_KEYS as _LINEAGE_HASH_KEYS,
    LINEAGE_PAYLOAD_KEYS as _LINEAGE_PAYLOAD_KEYS,
    RUNTIME_COST_AMOUNT_KEYS as _RUNTIME_COST_AMOUNT_KEYS,
    RUNTIME_COST_BASIS_KEYS as _RUNTIME_COST_BASIS_KEYS,
    RUNTIME_COST_PAYLOAD_KEYS as _RUNTIME_COST_PAYLOAD_KEYS,
)
from .order_executor_submission_methods import (
    OrderExecutor as OrderExecutor,
    coerce_json as _coerce_json,
    copy_mapping as _copy_mapping,
    first_mapping_text as _first_mapping_text,
    first_mapping_value as _first_mapping_value,
    first_param_mapping as _first_param_mapping,
    first_param_text as _first_param_text,
    first_param_value as _first_param_value,
    stable_payload_hash as _stable_payload_hash,
)


def _validate_pre_submit_request(
    request: ExecutionRequest,
    *,
    quantity_resolution: Any,
) -> dict[str, Any] | None:
    if request.qty <= 0:
        return {
            "source": "local_pre_submit",
            "code": "local_qty_non_positive",
            "reject_reason": "qty must be positive",
            "symbol": request.symbol,
            "qty": str(request.qty),
            "quantity_resolution": quantity_resolution.to_payload(),
        }
    min_qty = min_qty_for_symbol(
        request.symbol,
        fractional_equities_enabled=bool(quantity_resolution.fractional_allowed),
    )
    if request.qty < min_qty:
        return {
            "source": "local_pre_submit",
            "code": "local_qty_below_min",
            "reject_reason": f"qty below minimum increment {min_qty}",
            "symbol": request.symbol,
            "qty": str(request.qty),
            "min_qty": str(min_qty),
            "quantity_resolution": quantity_resolution.to_payload(),
        }
    if not qty_has_valid_increment(
        request.symbol,
        request.qty,
        fractional_equities_enabled=bool(quantity_resolution.fractional_allowed),
    ):
        step = qty_step_for_symbol(
            request.symbol,
            fractional_equities_enabled=bool(quantity_resolution.fractional_allowed),
        )
        quantized_qty = quantize_qty_for_symbol(
            request.symbol,
            request.qty,
            fractional_equities_enabled=bool(quantity_resolution.fractional_allowed),
        )
        return {
            "source": "local_pre_submit",
            "code": "local_qty_invalid_increment",
            "reject_reason": f"qty increment invalid; step={step}",
            "symbol": request.symbol,
            "qty": str(request.qty),
            "qty_step": str(step),
            "quantized_qty": str(quantized_qty),
            "quantity_resolution": quantity_resolution.to_payload(),
        }
    return None


def _extract_execution_policy_context(
    decision: StrategyDecision,
    *,
    decision_row: Optional[TradeDecision] = None,
) -> dict[str, Any]:
    execution_policy: Any = None
    decision_json: Mapping[str, Any] = {}
    decision_params: Mapping[str, Any] | None = None
    if decision_row is not None:
        decision_json = _coerce_json(decision_row.decision_json)
        params_value = decision_json.get("params")
        if isinstance(params_value, Mapping):
            decision_params = cast(Mapping[str, Any], params_value)
            execution_policy = decision_params.get("execution_policy")
            execution_advisor = decision_params.get("execution_advisor")
            execution_microstructure = decision_params.get("execution_microstructure")
        else:
            execution_advisor = None
            execution_microstructure = None
    else:
        execution_advisor = None
        execution_microstructure = None
    if not isinstance(execution_policy, Mapping):
        execution_policy = decision.params.get("execution_policy")
        execution_advisor = decision.params.get("execution_advisor")
        execution_microstructure = decision.params.get("execution_microstructure")
    if not isinstance(decision_params, Mapping):
        decision_params = decision.params
    policy_map: dict[str, Any] = {}
    if isinstance(execution_policy, Mapping):
        policy_map = {
            str(key): value
            for key, value in cast(Mapping[object, Any], execution_policy).items()
        }
    adaptive = policy_map.get("adaptive")
    adaptive_payload: dict[str, Any] = {}
    if isinstance(adaptive, Mapping):
        adaptive_payload = {
            str(key): value for key, value in cast(Mapping[str, Any], adaptive).items()
        }
    has_explicit_advisor = isinstance(execution_advisor, Mapping) or isinstance(
        decision_params.get("execution_advisor"), Mapping
    )
    has_explicit_microstructure = isinstance(
        execution_microstructure, Mapping
    ) or isinstance(decision_params.get("execution_microstructure"), Mapping)
    if (
        not policy_map
        and not adaptive_payload
        and not has_explicit_advisor
        and not has_explicit_microstructure
    ):
        return {}
    context: dict[str, Any] = {
        "selected_order_type": str(
            policy_map.get("selected_order_type") or decision.order_type
        ),
        "adaptive": adaptive_payload,
    }
    if isinstance(execution_advisor, Mapping):
        context["execution_advisor"] = {
            str(key): value
            for key, value in cast(Mapping[str, Any], execution_advisor).items()
        }
    elif isinstance(decision_params.get("execution_advisor"), Mapping):
        context["execution_advisor"] = {
            str(key): value
            for key, value in cast(
                Mapping[str, Any], decision_params.get("execution_advisor")
            ).items()
        }

    if isinstance(execution_microstructure, Mapping):
        context["execution_microstructure"] = {
            str(key): value
            for key, value in cast(Mapping[str, Any], execution_microstructure).items()
        }
    elif isinstance(decision_params.get("execution_microstructure"), Mapping):
        context["execution_microstructure"] = {
            str(key): value
            for key, value in cast(
                Mapping[str, Any], decision_params.get("execution_microstructure")
            ).items()
        }
    return context


def _resolve_submission_simulation_context(
    *,
    execution_client: Any,
    decision: StrategyDecision,
    decision_row: TradeDecision,
    execution_policy_context: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    adapter_name = str(getattr(execution_client, "name", "") or "").strip().lower()
    if adapter_name != "simulation" and not simulation_context_enabled():
        return None
    source_context = decision.params.get("simulation_context")
    source_context_payload: dict[str, Any] | None = None
    if isinstance(source_context, Mapping):
        source_context_payload = {
            str(key): value
            for key, value in cast(Mapping[object, Any], source_context).items()
        }
    simulated_fill_price = _resolve_decision_simulated_fill_price(decision)
    if simulated_fill_price is not None:
        if source_context_payload is None:
            source_context_payload = {}
        rendered_price = str(simulated_fill_price)
        source_context_payload.setdefault("simulated_fill_price", rendered_price)
        source_context_payload.setdefault("arrival_price", rendered_price)
    policy_simulation_context = _simulation_queue_context_from_execution_policy(
        execution_policy_context
    )
    if policy_simulation_context:
        if source_context_payload is None:
            source_context_payload = {}
        for key, value in policy_simulation_context.items():
            source_context_payload.setdefault(key, value)
    return resolve_simulation_context(
        source=source_context_payload,
        decision_id=str(decision_row.id),
        decision_hash=decision_row.decision_hash,
    )


def _simulation_queue_context_from_execution_policy(
    execution_policy_context: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if not isinstance(execution_policy_context, Mapping):
        return {}
    microstructure = execution_policy_context.get("execution_microstructure")
    if not isinstance(microstructure, Mapping):
        return {}
    microstructure_payload = cast(Mapping[str, Any], microstructure)
    context: dict[str, Any] = {}
    queue_context_keys = (
        "depth_at_limit",
        "limit_depth_qty",
        "available_depth_qty",
        "queue_ahead_qty",
        "queue_position_qty",
        "queue_fill_probability",
        "fill_probability",
        "passive_fill_probability",
        "simulated_fill_ratio",
        "fill_ratio",
        "queue_fill_ratio",
        "cancel_intensity",
        "queue_cancel_intensity",
        "market_order_intensity",
        "opposing_market_order_intensity",
    )
    nested_context = microstructure_payload.get("simulation_context")
    if isinstance(nested_context, Mapping):
        nested_payload = cast(Mapping[str, Any], nested_context)
        for key in queue_context_keys:
            value = _nonnegative_decimal(nested_payload.get(key))
            if value is not None:
                context[key] = str(value)
    for key in queue_context_keys:
        value = _nonnegative_decimal(microstructure_payload.get(key))
        if value is not None:
            context.setdefault(key, str(value))
    if context:
        context.setdefault("queue_fill_model", "execution_policy_microstructure_v1")
    return context


def _resolve_decision_simulated_fill_price(
    decision: StrategyDecision,
) -> Decimal | None:
    for candidate in (
        decision.limit_price,
        decision.stop_price,
        decision.params.get("simulated_fill_price"),
        decision.params.get("fill_price"),
        decision.params.get("arrival_price"),
        decision.params.get("price"),
    ):
        value = _positive_decimal(candidate)
        if value is not None:
            return value

    price_snapshot = decision.params.get("price_snapshot")
    if isinstance(price_snapshot, Mapping):
        snapshot_payload = cast(Mapping[object, Any], price_snapshot)
        value = _positive_decimal(snapshot_payload.get("price"))
        if value is not None:
            return value
    return None


def _nonnegative_decimal(value: Any) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return parsed


def _attach_execution_policy_context(
    execution: Execution, context: dict[str, Any]
) -> None:
    if not context:
        return
    raw_order = _coerce_json(execution.raw_order)
    raw_order["execution_policy"] = context
    execution.raw_order = raw_order


def _extract_execution_advice_provenance(
    decision: StrategyDecision,
    *,
    decision_row: Optional[TradeDecision] = None,
) -> dict[str, Any] | None:
    persisted_params: Mapping[str, Any] = {}
    if decision_row is not None:
        decision_json = _coerce_json(decision_row.decision_json)
        params_value = decision_json.get("params")
        if isinstance(params_value, Mapping):
            persisted_params = cast(Mapping[str, Any], params_value)

    for key in ("execution_advisor", "execution_advice"):
        payload = persisted_params.get(key)
        if not isinstance(payload, Mapping):
            payload = decision.params.get(key)
        if isinstance(payload, Mapping):
            return {
                str(item_key): item_value
                for item_key, item_value in cast(
                    Mapping[object, object], payload
                ).items()
            }
    return None


def _extract_execution_metadata(
    decision: StrategyDecision,
    *,
    decision_row: Optional[TradeDecision] = None,
    execution_policy_context: Mapping[str, Any] | None = None,
) -> dict[str, Any] | None:
    persisted_params: Mapping[str, Any] = {}
    if decision_row is not None:
        decision_json = _coerce_json(decision_row.decision_json)
        params_value = decision_json.get("params")
        if isinstance(params_value, Mapping):
            persisted_params = cast(Mapping[str, Any], params_value)

    params_candidates = (persisted_params, decision.params)
    execution_lane = persisted_params.get("execution_lane") or decision.params.get(
        "execution_lane"
    )
    submit_path = persisted_params.get("submit_path") or decision.params.get(
        "submit_path"
    )
    metadata: dict[str, Any] = {}
    if execution_lane is not None:
        metadata["execution_lane"] = str(execution_lane)
    if submit_path is not None:
        metadata["submit_path"] = str(submit_path)

    if execution_policy_context:
        policy_context = _copy_mapping(execution_policy_context)
        metadata["execution_policy"] = policy_context
        execution_policy_hash = _first_param_text(
            params_candidates, *_EXECUTION_POLICY_HASH_KEYS
        ) or _stable_payload_hash(policy_context)
    else:
        execution_policy_hash = _first_param_text(
            params_candidates, *_EXECUTION_POLICY_HASH_KEYS
        )
    if execution_policy_hash is not None:
        metadata["execution_policy_hash"] = execution_policy_hash

    cost_model_payload = _first_param_mapping(
        params_candidates, *_COST_MODEL_PAYLOAD_KEYS
    )
    cost_model_hash = _first_param_text(params_candidates, *_COST_MODEL_HASH_KEYS)
    if cost_model_payload is not None:
        metadata["cost_model"] = cost_model_payload
        cost_model_hash = cost_model_hash or _stable_payload_hash(cost_model_payload)
    if cost_model_hash is not None:
        metadata["cost_model_hash"] = cost_model_hash

    lineage_payload = _first_param_mapping(params_candidates, *_LINEAGE_PAYLOAD_KEYS)
    lineage_hash = _first_param_text(params_candidates, *_LINEAGE_HASH_KEYS)
    if lineage_payload is not None:
        metadata["lineage"] = lineage_payload
        lineage_hash = lineage_hash or _stable_payload_hash(lineage_payload)
    if lineage_hash is not None:
        metadata["lineage_hash"] = lineage_hash
    candidate_evaluation_key = _first_param_text(
        params_candidates, "candidate_evaluation_key"
    )
    if candidate_evaluation_key is not None:
        metadata["candidate_evaluation_key"] = candidate_evaluation_key
    replay_data_hash = _first_param_text(
        params_candidates,
        "replay_data_hash",
        "replay_tape_content_sha256",
        "dataset_snapshot_hash",
        "source_query_digest",
    )
    if replay_data_hash is not None:
        metadata["replay_data_hash"] = replay_data_hash

    cost_payload = _first_param_mapping(params_candidates, *_RUNTIME_COST_PAYLOAD_KEYS)
    if cost_payload is not None:
        metadata["runtime_ledger_cost"] = cost_payload
        cost_amount = _first_mapping_value(cost_payload, *_RUNTIME_COST_AMOUNT_KEYS)
        cost_basis = _first_mapping_text(cost_payload, *_RUNTIME_COST_BASIS_KEYS)
    else:
        cost_amount = _first_param_value(params_candidates, *_RUNTIME_COST_AMOUNT_KEYS)
        cost_basis = _first_param_text(params_candidates, *_RUNTIME_COST_BASIS_KEYS)
    if cost_amount is not None and cost_basis is not None:
        metadata["cost_amount"] = cost_amount
        metadata["cost_basis"] = cost_basis
    return metadata or None


def _apply_execution_status(
    decision_row: TradeDecision,
    execution: Execution,
    account_label: str,
    submitted_at: Optional[datetime] = None,
    status_override: Optional[str] = None,
) -> None:
    applied_status = status_override or execution.status or "submitted"
    decision_row.status = applied_status
    decision_row.alpaca_account_label = account_label
    decision_json = _coerce_json(decision_row.decision_json)
    decision_json["submission_stage"] = applied_status
    decision_row.decision_json = decision_json
    if submitted_at is not None and decision_row.executed_at is None:
        decision_row.executed_at = submitted_at
    if execution.status == "filled" and decision_row.executed_at is None:
        simulation_payload = getattr(execution, "simulation_json", None)
        simulation_context = (
            cast(Mapping[str, Any], simulation_payload)
            if isinstance(simulation_payload, Mapping)
            else None
        )
        signal_event_ts = (
            simulation_context.get("signal_event_ts")
            if simulation_context is not None
            else None
        )
        if isinstance(signal_event_ts, str) and signal_event_ts.strip():
            normalized = (
                f"{signal_event_ts[:-1]}+00:00"
                if signal_event_ts.endswith("Z")
                else signal_event_ts
            )
            try:
                parsed = datetime.fromisoformat(normalized)
            except ValueError:
                parsed = None
            if parsed is not None:
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                decision_row.executed_at = parsed.astimezone(timezone.utc)
                return
        decision_row.executed_at = trading_now(account_label=account_label)


def _persist_lean_shadow_event(
    session: Session,
    *,
    execution: Execution,
    order_payload: Mapping[str, Any],
    decision: StrategyDecision,
) -> None:
    raw_shadow = order_payload.get("_lean_shadow")
    if not isinstance(raw_shadow, Mapping):
        return
    shadow = cast(Mapping[str, Any], raw_shadow)

    parity_status = str(shadow.get("parity_status") or "unknown").strip() or "unknown"
    event = LeanExecutionShadowEvent(
        correlation_id=str(order_payload.get("_execution_correlation_id") or "").strip()
        or None,
        trade_decision_id=execution.trade_decision_id,
        execution_id=execution.id,
        symbol=decision.symbol,
        side=decision.action,
        qty=decision.qty,
        intent_notional=_optional_decimal(shadow.get("intent_notional")),
        simulated_fill_price=_optional_decimal(shadow.get("simulated_fill_price")),
        simulated_slippage_bps=_optional_decimal(shadow.get("simulated_slippage_bps")),
        parity_delta_bps=_optional_decimal(shadow.get("parity_delta_bps")),
        parity_status=parity_status,
        failure_taxonomy=(str(shadow.get("failure_taxonomy") or "").strip() or None),
        simulation_json=coerce_json_payload(dict(shadow)),
    )
    session.add(event)


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _positive_decimal(value: Any) -> Decimal | None:
    parsed = _optional_decimal(value)
    if parsed is None:
        return None
    if parsed.is_finite() and parsed > 0:
        return parsed
    return None


__all__ = ["OrderExecutor"]


# Public aliases used by split-module consumers.
apply_execution_status = _apply_execution_status
attach_execution_policy_context = _attach_execution_policy_context
extract_execution_advice_provenance = _extract_execution_advice_provenance
extract_execution_metadata = _extract_execution_metadata
extract_execution_policy_context = _extract_execution_policy_context
optional_decimal = _optional_decimal
persist_lean_shadow_event = _persist_lean_shadow_event
resolve_submission_simulation_context = _resolve_submission_simulation_context
validate_pre_submit_request = _validate_pre_submit_request

__all__ = (
    "apply_execution_status",
    "attach_execution_policy_context",
    "extract_execution_advice_provenance",
    "extract_execution_metadata",
    "extract_execution_policy_context",
    "optional_decimal",
    "persist_lean_shadow_event",
    "resolve_submission_simulation_context",
    "validate_pre_submit_request",
)
