"""Helpers for recording Alpaca state into the torghut database."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional, cast

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .alpaca_client import TorghutAlpacaClient
from .models import Execution, PositionSnapshot, coerce_json_payload
from .trading.route_metadata import (
    coerce_route_text,
    coerce_route_int,
    normalize_route_provenance,
)
from .trading.simulation import resolve_simulation_context

logger = logging.getLogger(__name__)

_RUNTIME_COST_AMOUNT_FIELDS = (
    "cost_amount",
    "explicit_cost",
    "commission",
    "fees",
    "fee_amount",
    "broker_fee",
)
_RUNTIME_COST_BASIS_FIELDS = (
    "cost_basis",
    "cost_source",
    "fee_basis",
    "commission_basis",
    "broker_fee_basis",
)
_RUNTIME_COST_MODEL_PAYLOAD_FIELDS = (
    "cost_model",
    "cost_model_config",
    "transaction_cost_model",
    "fee_model",
    "market_impact_cost_model",
)
_AUTHORITATIVE_EXISTING_COST_SOURCES = frozenset(
    {
        "broker_order_response",
        "broker_reported_order_response",
        "alpaca_broker_order_response",
        "runtime_order_feed",
        "broker_reconciliation",
    }
)
_BROKER_COST_BASIS_BY_FIELD = {
    "commission": "broker_reported_commission",
    "fees": "broker_reported_fees",
    "fee_amount": "broker_reported_fees",
    "broker_fee": "broker_reported_fees",
}


def snapshot_account_and_positions(
    session: Session, client: TorghutAlpacaClient, alpaca_account_label: str
) -> PositionSnapshot:
    """Fetch account + positions and persist a PositionSnapshot."""

    account = client.get_account()
    positions = client.list_positions()

    snapshot = PositionSnapshot(
        alpaca_account_label=alpaca_account_label,
        as_of=datetime.now(timezone.utc),
        equity=Decimal(str(account.get("equity"))),
        cash=Decimal(str(account.get("cash"))),
        buying_power=Decimal(str(account.get("buying_power"))),
        positions=coerce_json_payload(positions),
    )
    session.add(snapshot)
    session.commit()
    session.refresh(snapshot)
    return snapshot


def sync_order_to_db(
    session: Session,
    order_response: dict[str, Any],
    trade_decision_id: Optional[str] = None,
    alpaca_account_label: Optional[str] = None,
    *,
    execution_expected_adapter: str | None = None,
    execution_actual_adapter: str | None = None,
    execution_fallback_reason: str | None = None,
    execution_fallback_count: int | None = None,
) -> Execution:
    """Create or update an Execution row from an Alpaca order response."""

    alpaca_order_id = order_response.get("id") or order_response.get("order_id")
    if alpaca_order_id is None:
        raise ValueError("order_response must include an 'id' field")

    (
        resolved_expected_adapter,
        resolved_actual_adapter,
        resolved_fallback_reason,
        resolved_fallback_count,
    ) = _resolve_execution_route_metadata(
        order_response=order_response,
        execution_expected_adapter=execution_expected_adapter,
        execution_actual_adapter=execution_actual_adapter,
        execution_fallback_reason=execution_fallback_reason,
        execution_fallback_count=execution_fallback_count,
    )

    account_label = _resolve_account_label(
        alpaca_account_label=alpaca_account_label,
        order_response=order_response,
    )
    account_label_explicit = _account_label_explicit(
        alpaca_account_label=alpaca_account_label,
        order_response=order_response,
    )
    client_order_id = order_response.get("client_order_id")
    existing = _find_existing_execution(
        session=session,
        alpaca_order_id=alpaca_order_id,
        account_label=account_label,
        client_order_id=client_order_id,
        warn_on_reuse=True,
    )

    data = _build_execution_payload(
        order_response=order_response,
        trade_decision_id=trade_decision_id,
        account_label=account_label,
        account_label_explicit=account_label_explicit,
        alpaca_order_id=alpaca_order_id,
        resolved_expected_adapter=resolved_expected_adapter,
        resolved_actual_adapter=resolved_actual_adapter,
        resolved_fallback_reason=resolved_fallback_reason,
        resolved_fallback_count=resolved_fallback_count,
    )
    if existing is not None:
        return _persist_existing_execution(
            session=session, existing=existing, data=data
        )

    execution = Execution(**data)
    session.add(execution)
    try:
        session.commit()
        session.refresh(execution)
        return execution
    except IntegrityError:
        session.rollback()
        existing = _find_existing_execution(
            session=session,
            alpaca_order_id=alpaca_order_id,
            account_label=account_label,
            client_order_id=client_order_id,
            warn_on_reuse=False,
        )
        if existing is None:
            raise
        return _persist_existing_execution(
            session=session, existing=existing, data=data
        )


def _resolve_execution_route_metadata(
    *,
    order_response: dict[str, Any],
    execution_expected_adapter: str | None,
    execution_actual_adapter: str | None,
    execution_fallback_reason: str | None,
    execution_fallback_count: int | None,
) -> tuple[str, str, str | None, int]:
    resolved_expected_adapter = (
        execution_expected_adapter
        or coerce_route_text(order_response.get("execution_expected_adapter"))
        or coerce_route_text(order_response.get("execution_actual_adapter"))
        or coerce_route_text(order_response.get("_execution_route_expected"))
        or coerce_route_text(order_response.get("_execution_route_actual"))
        or coerce_route_text(order_response.get("_execution_adapter"))
    )
    resolved_actual_adapter = (
        execution_actual_adapter
        or coerce_route_text(order_response.get("execution_actual_adapter"))
        or coerce_route_text(order_response.get("_execution_route_actual"))
        or coerce_route_text(order_response.get("execution_expected_adapter"))
        or coerce_route_text(order_response.get("_execution_adapter"))
    )
    resolved_fallback_reason = (
        execution_fallback_reason
        or _coerce_text(order_response.get("_execution_fallback_reason"))
        or _coerce_text(order_response.get("_fallback_reason"))
    )
    raw_fallback_count = (
        execution_fallback_count
        if execution_fallback_count is not None
        else coerce_route_int(order_response.get("_execution_fallback_count"))
    )
    return normalize_route_provenance(
        expected_adapter=resolved_expected_adapter,
        actual_adapter=resolved_actual_adapter,
        fallback_reason=resolved_fallback_reason,
        fallback_count=raw_fallback_count,
    )


def _resolve_account_label(
    *,
    alpaca_account_label: str | None,
    order_response: dict[str, Any],
) -> str:
    account_label = (
        alpaca_account_label
        or order_response.get("alpaca_account_label")
        or order_response.get("account_label")
    )
    if not account_label:
        return "paper"
    return str(account_label)


def _account_label_explicit(
    *,
    alpaca_account_label: str | None,
    order_response: Mapping[str, Any],
) -> bool:
    return any(
        _coerce_text(value) is not None
        for value in (
            alpaca_account_label,
            order_response.get("alpaca_account_label"),
            order_response.get("account_label"),
        )
    )


def _find_existing_execution(
    *,
    session: Session,
    alpaca_order_id: Any,
    account_label: str,
    client_order_id: Any,
    warn_on_reuse: bool,
) -> Execution | None:
    stmt = select(Execution).where(
        Execution.alpaca_order_id == alpaca_order_id,
        Execution.alpaca_account_label == account_label,
    )
    existing = session.execute(stmt).scalar_one_or_none()
    if existing is not None or not client_order_id:
        return existing

    stmt = select(Execution).where(
        Execution.client_order_id == client_order_id,
        Execution.alpaca_account_label == account_label,
    )
    existing = session.execute(stmt).scalar_one_or_none()
    if (
        warn_on_reuse
        and existing is not None
        and existing.alpaca_order_id != alpaca_order_id
    ):
        logger.warning("Execution client_order_id reused with new alpaca_order_id")
    return existing


def _build_execution_payload(
    *,
    order_response: dict[str, Any],
    trade_decision_id: str | None,
    account_label: str,
    account_label_explicit: bool,
    alpaca_order_id: Any,
    resolved_expected_adapter: str,
    resolved_actual_adapter: str,
    resolved_fallback_reason: str | None,
    resolved_fallback_count: int,
) -> dict[str, Any]:
    raw_order_payload = dict(order_response)
    raw_audit = order_response.get("_execution_audit")
    audit_payload: dict[str, Any] = {}
    if isinstance(raw_audit, Mapping):
        audit_payload = {
            str(key): value
            for key, value in cast(Mapping[object, Any], raw_audit).items()
        }

    source_context: dict[str, Any] | None = None
    for candidate in (
        order_response.get("_simulation_context"),
        order_response.get("simulation_context"),
        audit_payload.get("simulation_context"),
    ):
        if isinstance(candidate, Mapping):
            source_context = {
                str(key): value
                for key, value in cast(Mapping[object, Any], candidate).items()
            }
            break
    simulation_context = resolve_simulation_context(
        source=source_context,
        decision_id=trade_decision_id,
        decision_hash=_coerce_text(order_response.get("client_order_id")),
    )
    if simulation_context is not None:
        audit_payload["simulation_context"] = simulation_context
        raw_order_payload["simulation_context"] = simulation_context
    _attach_runtime_ledger_cost_payload(
        order_response=order_response,
        account_label=account_label,
        account_label_explicit=account_label_explicit,
        audit_payload=audit_payload,
        raw_order_payload=raw_order_payload,
    )

    return {
        "trade_decision_id": trade_decision_id,
        "alpaca_account_label": account_label,
        "alpaca_order_id": alpaca_order_id,
        "client_order_id": order_response.get("client_order_id"),
        "symbol": order_response.get("symbol"),
        "side": order_response.get("side"),
        "order_type": order_response.get("type") or order_response.get("order_type"),
        "time_in_force": order_response.get("time_in_force"),
        "submitted_qty": Decimal(str(order_response.get("qty", 0))),
        "filled_qty": Decimal(str(order_response.get("filled_qty", 0))),
        "avg_fill_price": _optional_decimal(order_response.get("filled_avg_price")),
        "status": order_response.get("status"),
        "execution_expected_adapter": resolved_expected_adapter,
        "execution_actual_adapter": resolved_actual_adapter,
        "execution_fallback_reason": resolved_fallback_reason,
        "execution_fallback_count": resolved_fallback_count,
        "execution_correlation_id": _coerce_text(
            order_response.get("_execution_correlation_id")
        ),
        "execution_idempotency_key": _coerce_text(
            order_response.get("_execution_idempotency_key")
        ),
        "execution_audit_json": coerce_json_payload(audit_payload),
        "raw_order": coerce_json_payload(raw_order_payload),
        "last_update_at": datetime.now(timezone.utc),
    }


def _persist_existing_execution(
    *,
    session: Session,
    existing: Execution,
    data: dict[str, Any],
) -> Execution:
    data = _preserve_existing_execution_audit(existing=existing, data=data)
    for key, value in data.items():
        setattr(existing, key, value)
    session.add(existing)
    session.commit()
    session.refresh(existing)
    return existing


def _attach_runtime_ledger_cost_payload(
    *,
    order_response: Mapping[str, Any],
    account_label: str,
    account_label_explicit: bool,
    audit_payload: dict[str, Any],
    raw_order_payload: dict[str, Any],
) -> None:
    cost_payload = _runtime_ledger_cost_payload_from_order(order_response)
    if cost_payload is None:
        cost_payload = _runtime_ledger_cost_payload_from_existing_metadata(
            audit_payload,
            raw_order_payload,
        )
    if cost_payload is None and _modeled_paper_cost_allowed(
        order_response=order_response,
        account_label=account_label,
        account_label_explicit=account_label_explicit,
        audit_payload=audit_payload,
    ):
        modeled_cost_payload = _runtime_ledger_cost_payload_from_cost_model(
            order_response=order_response,
            audit_payload=audit_payload,
        )
        if modeled_cost_payload is not None:
            audit_payload.setdefault(
                "modeled_paper_cost_estimate", modeled_cost_payload
            )
            raw_order_payload.setdefault(
                "modeled_paper_cost_estimate", modeled_cost_payload
            )
        return
    if cost_payload is None:
        return

    if cost_payload.get("source") == "broker_order_response":
        audit_payload["runtime_ledger_cost"] = cost_payload
        raw_order_payload["runtime_ledger_cost"] = cost_payload
        audit_payload["cost_amount"] = cost_payload["cost_amount"]
        audit_payload["cost_basis"] = cost_payload["cost_basis"]
        raw_order_payload["cost_amount"] = cost_payload["cost_amount"]
        raw_order_payload["cost_basis"] = cost_payload["cost_basis"]
    else:
        audit_payload.setdefault("runtime_ledger_cost", cost_payload)
        raw_order_payload.setdefault("runtime_ledger_cost", cost_payload)
        audit_payload.setdefault("cost_amount", cost_payload["cost_amount"])
        audit_payload.setdefault("cost_basis", cost_payload["cost_basis"])
        raw_order_payload.setdefault("cost_amount", cost_payload["cost_amount"])
        raw_order_payload.setdefault("cost_basis", cost_payload["cost_basis"])

    fee_model = {
        "source": cost_payload.get("source", "broker_order_response"),
        "source_field": cost_payload["source_field"],
        "cost_basis": cost_payload["cost_basis"],
    }
    audit_payload.setdefault("fee_model", fee_model)
    raw_order_payload.setdefault("fee_model", fee_model)


def _runtime_ledger_cost_payload_from_order(
    order_response: Mapping[str, Any],
) -> dict[str, str] | None:
    return _runtime_cost_payload_from_mapping(
        order_response,
        source="broker_order_response",
        source_field_prefix="",
    )


def _runtime_ledger_cost_payload_from_existing_metadata(
    *payloads: Mapping[str, Any],
) -> dict[str, str] | None:
    for payload in payloads:
        for key in ("runtime_ledger_cost", "execution_cost", "explicit_execution_cost"):
            nested = payload.get(key)
            if not isinstance(nested, Mapping):
                continue
            nested_payload = {
                str(item_key): item
                for item_key, item in cast(Mapping[object, Any], nested).items()
            }
            cost_payload = _runtime_cost_payload_from_mapping(
                nested_payload,
                source=str(nested_payload.get("source") or ""),
                source_field_prefix=f"{key}.",
            )
            if (
                cost_payload is not None
                and cost_payload["source"] in _AUTHORITATIVE_EXISTING_COST_SOURCES
            ):
                return cost_payload
    return None


def _runtime_ledger_cost_payload_from_cost_model(
    *,
    order_response: Mapping[str, Any],
    audit_payload: Mapping[str, Any],
) -> dict[str, str] | None:
    for model_key, payload in _iter_cost_model_payloads(audit_payload, order_response):
        estimate = payload.get("estimate")
        if not isinstance(estimate, Mapping):
            continue
        estimate_payload = {
            str(key): value
            for key, value in cast(Mapping[object, Any], estimate).items()
        }
        total_cost = _optional_decimal(
            estimate_payload.get("total_cost")
            or estimate_payload.get("estimated_total_cost")
            or estimate_payload.get("modeled_total_cost")
        )
        source_field = f"{model_key}.estimate.total_cost"
        if total_cost is None:
            total_cost_bps = _optional_decimal(
                estimate_payload.get("total_cost_bps")
                or estimate_payload.get("estimated_total_cost_bps")
            )
            notional = _optional_decimal(
                estimate_payload.get("notional") or payload.get("notional")
            )
            if (
                total_cost_bps is not None
                and total_cost_bps >= 0
                and notional is not None
                and notional > 0
            ):
                total_cost = notional * total_cost_bps / Decimal("10000")
                source_field = f"{model_key}.estimate.total_cost_bps"
        if total_cost is None or total_cost < 0:
            continue
        return {
            "cost_amount": str(total_cost),
            "cost_basis": "modeled_paper_cost_budget",
            "source_field": source_field,
            "source": "paper_cost_model_estimate",
        }
    return None


def _runtime_cost_payload_from_mapping(
    payload: Mapping[str, Any],
    *,
    source: str,
    source_field_prefix: str,
) -> dict[str, str] | None:
    basis = _first_text(payload, *_RUNTIME_COST_BASIS_FIELDS)
    for amount_key in _RUNTIME_COST_AMOUNT_FIELDS:
        amount = _optional_decimal(payload.get(amount_key))
        if amount is None or amount < 0:
            continue
        resolved_basis = basis or _BROKER_COST_BASIS_BY_FIELD.get(amount_key)
        if resolved_basis is None:
            continue
        return {
            "cost_amount": str(amount),
            "cost_basis": resolved_basis,
            "source_field": f"{source_field_prefix}{amount_key}",
            "source": source,
        }
    return None


def _modeled_paper_cost_allowed(
    *,
    order_response: Mapping[str, Any],
    account_label: str,
    account_label_explicit: bool,
    audit_payload: Mapping[str, Any],
) -> bool:
    resolved_label = account_label.strip().lower()
    if not account_label_explicit:
        return False
    if "live" in resolved_label:
        return False
    if resolved_label == "paper":
        return False
    if not any(token in resolved_label for token in ("paper", "sim", "simulation")):
        return False

    markers: list[str] = []
    for payload in _iter_nested_mappings(order_response, audit_payload, max_depth=2):
        for key in (
            "alpaca_account_label",
            "account_label",
            "execution_lane",
            "submit_path",
            "adapter",
            "execution_adapter",
            "_execution_adapter",
            "_execution_route_actual",
        ):
            text = _coerce_text(payload.get(key))
            if text is not None:
                markers.append(text.lower())

    if any("live" in marker and "paper" not in marker for marker in markers):
        return False
    if any(
        token in marker
        for marker in markers
        for token in ("paper", "sim", "simulation", "route_probe", "dry_run", "shadow")
    ):
        return True
    return False


def _iter_cost_model_payloads(
    *values: object,
) -> list[tuple[str, dict[str, Any]]]:
    payloads: list[tuple[str, dict[str, Any]]] = []
    for payload in _iter_nested_mappings(*values, max_depth=3):
        for key in _RUNTIME_COST_MODEL_PAYLOAD_FIELDS:
            nested = payload.get(key)
            if not isinstance(nested, Mapping):
                continue
            payloads.append(
                (
                    key,
                    {
                        str(item_key): item
                        for item_key, item in cast(Mapping[object, Any], nested).items()
                    },
                )
            )
    return payloads


def _iter_nested_mappings(
    *values: object,
    max_depth: int = 4,
) -> list[dict[str, Any]]:
    mappings: list[dict[str, Any]] = []

    def append(value: object, *, depth: int) -> None:
        if not isinstance(value, Mapping):
            return
        payload = {
            str(key): item for key, item in cast(Mapping[object, Any], value).items()
        }
        mappings.append(payload)
        if depth <= 0:
            return
        for child in payload.values():
            append(child, depth=depth - 1)

    for value in values:
        append(value, depth=max_depth)
    return mappings


def _preserve_existing_execution_audit(
    *,
    existing: Execution,
    data: dict[str, Any],
) -> dict[str, Any]:
    existing_audit = existing.execution_audit_json
    incoming_audit = data.get("execution_audit_json")
    if not isinstance(existing_audit, Mapping):
        return data
    merged = {
        str(key): value
        for key, value in cast(Mapping[object, Any], existing_audit).items()
    }
    if isinstance(incoming_audit, Mapping):
        merged.update(
            {
                str(key): value
                for key, value in cast(Mapping[object, Any], incoming_audit).items()
            }
        )
    updated = dict(data)
    updated["execution_audit_json"] = coerce_json_payload(merged)
    return updated


def _coerce_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    return None


def _first_text(payload: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        text = _coerce_text(payload.get(key))
        if text is not None:
            return text
    return None


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


__all__ = ["snapshot_account_and_positions", "sync_order_to_db"]
