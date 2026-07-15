"""Fenced Alpaca cancel, replace, and broker-enforced close operations."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import TypeVar, cast

from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from .alpaca_observations import (
    alpaca_order_observation,
    alpaca_position_observation,
)
from .broker_mutation_coordinator import (
    BrokerMutationAlreadyProcessed,
    BrokerMutationCoordinator,
    UnlinkedMutationCallbacks,
)
from .broker_mutation_receipts import (
    BrokerMutationIntent,
    BrokerMutationIntentRequest,
    BrokerMutationIoPermit,
    BrokerMutationOperation,
    BrokerMutationPurpose,
    BrokerMutationRiskClass,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    BrokerMutationTargetKind,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
    fingerprint_broker_endpoint,
)
from .firewall import OrderFirewall
from .risk_reduction import (
    BrokerOrderObservation,
    BrokerPositionObservation,
    BrokerReductionSnapshot,
    CancelAllOrdersPlan,
    CancelOrderPlan,
    ClosePositionPlan,
    PositionCloseLeg,
    ReplaceOrderPlan,
    RiskReductionAuthorization,
    RiskReductionPermitError,
    authorize_risk_reduction,
    flatten_observed_positions,
)
from .risk_reduction_mutation_authority import (
    RiskReductionMutationAuthority,
    risk_reduction_request_id,
)


_Result = TypeVar("_Result")
_OPEN_ORDER_LIMIT = 500
_REQUEST_SCHEMA_VERSION = "torghut.alpaca-reduction-request.v1"
_PREFLIGHT_SCHEMA_VERSION = "torghut.alpaca-reduction-preflight.v1"
_ACCEPTED_ORDER_STATUSES = frozenset(
    {
        "accepted",
        "accepted_for_bidding",
        "filled",
        "new",
        "partially_filled",
        "pending_new",
        "pending_replace",
        "replaced",
    }
)
_REJECTED_ORDER_STATUSES = frozenset(
    {
        "canceled",
        "cancelled",
        "done_for_day",
        "expired",
        "rejected",
        "stopped",
        "suspended",
    }
)


@dataclass(frozen=True, slots=True)
class _MutationSpec:
    operation: BrokerMutationOperation
    risk_class: BrokerMutationRiskClass
    purpose: BrokerMutationPurpose
    target_kind: BrokerMutationTargetKind
    target_key: str
    request_payload: Mapping[str, object]


class AlpacaReductionMutationExecutor:
    """Translate fresh Alpaca state into the shared mutation protocol."""

    def __init__(
        self,
        *,
        firewall: OrderFirewall,
        read_client: TorghutAlpacaClient,
        session_factory: Callable[[], Session],
        account_label: str,
        endpoint_url: str,
        coordinator: BrokerMutationCoordinator,
    ) -> None:
        self._firewall = firewall
        self._read_client = read_client
        self._session_factory = session_factory
        self._account_label = account_label.strip()
        self._endpoint_url = endpoint_url.strip()
        self._endpoint_fingerprint = fingerprint_broker_endpoint(endpoint_url)
        self._coordinator = coordinator

    def cancel_order(
        self,
        order_id: str,
        *,
        purpose: BrokerMutationPurpose = "operator",
    ) -> bool:
        observed_at = datetime.now(timezone.utc)
        raw_order = self._read_client.get_order_by_id_strict(order_id)
        if raw_order is None:
            observation = {"order_id": order_id, "status": "absent"}
            self._settle_already_satisfied(
                _MutationSpec(
                    operation="cancel_order",
                    risk_class="risk_neutral",
                    purpose=purpose,
                    target_kind="order",
                    target_key=order_id,
                    request_payload=_already_satisfied_request(observation),
                ),
                observation=observation,
            )
            return False
        order = alpaca_order_observation(raw_order)
        if order.order_id != order_id:
            raise RiskReductionPermitError("alpaca_cancel_order_identity_mismatch")
        if not order.open:
            observation = {"order": dict(raw_order)}
            self._settle_already_satisfied(
                _MutationSpec(
                    operation="cancel_order",
                    risk_class="risk_neutral",
                    purpose=purpose,
                    target_kind="order",
                    target_key=order_id,
                    request_payload=_already_satisfied_request(observation),
                ),
                observation=observation,
            )
            return False
        authorization = authorize_risk_reduction(
            self._snapshot(observed_at=observed_at, orders=(order,)),
            CancelOrderPlan(order_id),
            now=observed_at,
        )
        request_payload = _request_payload(
            authorization,
            broker_request={"order_id": order_id},
        )
        return self._execute(
            _MutationSpec(
                operation="cancel_order",
                risk_class="risk_neutral",
                purpose=purpose,
                target_kind="order",
                target_key=order_id,
                request_payload=request_payload,
            ),
            broker_call=lambda mutation_permit: self._firewall.cancel_order(
                order_id,
                authority=RiskReductionMutationAuthority(
                    request_payload=request_payload,
                    mutation_permit=mutation_permit,
                    reduction_permit=authorization.permit,
                ),
            ),
        )

    def cancel_all_orders(
        self,
        *,
        purpose: BrokerMutationPurpose = "operator",
    ) -> list[dict[str, object]]:
        observed_at = datetime.now(timezone.utc)
        raw_orders = self._read_client.list_orders(
            status="open", limit=_OPEN_ORDER_LIMIT
        )
        snapshot = self._snapshot(
            observed_at=observed_at,
            complete=len(raw_orders) < _OPEN_ORDER_LIMIT,
            orders=tuple(alpaca_order_observation(order) for order in raw_orders),
        )
        authorization = authorize_risk_reduction(
            snapshot,
            CancelAllOrdersPlan(),
            now=observed_at,
        )
        request_payload = _request_payload(
            authorization,
            broker_request={
                "target_order_ids": sorted(
                    order.order_id for order in snapshot.orders if order.open
                )
            },
        )
        if not any(order.open for order in snapshot.orders):
            self._settle_authorized_preflight(
                _MutationSpec(
                    operation="cancel_all_orders",
                    risk_class="risk_neutral",
                    purpose=purpose,
                    target_kind="account",
                    target_key=self._account_label,
                    request_payload=request_payload,
                )
            )
            return []
        return self._execute(
            _MutationSpec(
                operation="cancel_all_orders",
                risk_class="risk_neutral",
                purpose=purpose,
                target_kind="account",
                target_key=self._account_label,
                request_payload=request_payload,
            ),
            broker_call=lambda mutation_permit: self._firewall.cancel_all_orders(
                authority=RiskReductionMutationAuthority(
                    request_payload=request_payload,
                    mutation_permit=mutation_permit,
                    reduction_permit=authorization.permit,
                ),
            ),
        )

    def replace_order(
        self,
        order_id: str,
        *,
        limit_price: Decimal,
    ) -> dict[str, object]:
        observed_at = datetime.now(timezone.utc)
        raw_order = self._read_client.get_order_by_id_strict(order_id)
        if raw_order is None:
            raise RiskReductionPermitError("alpaca_replace_order_not_observed")
        order = alpaca_order_observation(raw_order)
        if order.order_id != order_id:
            raise RiskReductionPermitError("alpaca_replace_order_identity_mismatch")
        positions = tuple(
            alpaca_position_observation(position)
            for position in self._read_client.list_positions()
        )
        authorization = authorize_risk_reduction(
            self._snapshot(
                observed_at=observed_at,
                complete=True,
                orders=(order,),
                positions=positions,
            ),
            ReplaceOrderPlan(order_id=order_id, limit_price=limit_price),
            now=observed_at,
        )
        request_payload = _request_payload(
            authorization,
            broker_request={
                "limit_price": _decimal_text(limit_price),
                "order_id": order_id,
            },
        )
        return self._execute(
            _MutationSpec(
                operation="replace_order",
                risk_class="risk_neutral",
                purpose="repricing",
                target_kind="order",
                target_key=order_id,
                request_payload=request_payload,
            ),
            broker_call=lambda mutation_permit: self._firewall.replace_order(
                order_id,
                limit_price=limit_price,
                authority=RiskReductionMutationAuthority(
                    request_payload=request_payload,
                    mutation_permit=mutation_permit,
                    reduction_permit=authorization.permit,
                ),
            ),
        )

    def close_position(
        self,
        symbol: str,
        quantity: Decimal,
        *,
        purpose: BrokerMutationPurpose = "closeout",
    ) -> dict[str, object]:
        observed_at = datetime.now(timezone.utc)
        positions = tuple(
            alpaca_position_observation(position)
            for position in self._read_client.list_positions()
        )
        normalized_symbol = symbol.strip().upper()
        position = next(
            (value for value in positions if value.symbol == normalized_symbol),
            None,
        )
        if position is None:
            observation: Mapping[str, object] = {"positions": []}
            self._settle_already_satisfied(
                _MutationSpec(
                    operation="close_position",
                    risk_class="risk_reducing",
                    purpose=purpose,
                    target_kind="position",
                    target_key=normalized_symbol,
                    request_payload=_already_satisfied_request(observation),
                ),
                observation=observation,
            )
            return {"status": "already_satisfied", "symbol": normalized_symbol}
        leg = PositionCloseLeg(
            symbol=normalized_symbol,
            side="sell" if position.signed_quantity > 0 else "buy",
            quantity=quantity,
        )
        authorization = authorize_risk_reduction(
            self._snapshot(
                observed_at=observed_at,
                complete=True,
                positions=positions,
            ),
            ClosePositionPlan(leg),
            now=observed_at,
        )
        request_payload = _request_payload(
            authorization,
            broker_request={
                "quantity": _decimal_text(quantity),
                "symbol": normalized_symbol,
            },
        )
        return self._execute(
            _MutationSpec(
                operation="close_position",
                risk_class="risk_reducing",
                purpose=purpose,
                target_kind="position",
                target_key=normalized_symbol,
                request_payload=request_payload,
            ),
            broker_call=lambda mutation_permit: self._firewall.close_position(
                normalized_symbol,
                quantity,
                authority=RiskReductionMutationAuthority(
                    request_payload=request_payload,
                    mutation_permit=mutation_permit,
                    reduction_permit=authorization.permit,
                ),
            ),
        )

    def close_all_positions(
        self,
        *,
        purpose: BrokerMutationPurpose = "flatten",
    ) -> list[dict[str, object]]:
        observed_at = datetime.now(timezone.utc)
        positions = tuple(
            alpaca_position_observation(position)
            for position in self._read_client.list_positions()
        )
        if not positions:
            observation: Mapping[str, object] = {"positions": []}
            self._settle_already_satisfied(
                _MutationSpec(
                    operation="close_all_positions",
                    risk_class="risk_reducing",
                    purpose=purpose,
                    target_kind="account",
                    target_key=self._account_label,
                    request_payload=_already_satisfied_request(observation),
                ),
                observation=observation,
            )
            return []
        snapshot = self._snapshot(
            observed_at=observed_at,
            complete=True,
            positions=positions,
        )
        authorization = authorize_risk_reduction(
            snapshot,
            flatten_observed_positions(snapshot),
            now=observed_at,
        )
        request_payload = _request_payload(
            authorization,
            broker_request={
                "symbols": sorted(position.symbol for position in positions),
            },
        )
        return self._execute(
            _MutationSpec(
                operation="close_all_positions",
                risk_class="risk_reducing",
                purpose=purpose,
                target_kind="account",
                target_key=self._account_label,
                request_payload=request_payload,
            ),
            broker_call=lambda mutation_permit: self._firewall.close_all_positions(
                authority=RiskReductionMutationAuthority(
                    request_payload=request_payload,
                    mutation_permit=mutation_permit,
                    reduction_permit=authorization.permit,
                ),
            ),
        )

    def _snapshot(
        self,
        *,
        observed_at: datetime,
        complete: bool = False,
        orders: tuple[BrokerOrderObservation, ...] = (),
        positions: tuple[BrokerPositionObservation, ...] = (),
    ) -> BrokerReductionSnapshot:
        return BrokerReductionSnapshot(
            broker_route="alpaca",
            account_label=self._account_label,
            endpoint_fingerprint=self._endpoint_fingerprint,
            observed_at=observed_at,
            complete=complete,
            orders=orders,
            positions=positions,
        )

    def _execute(
        self,
        spec: _MutationSpec,
        *,
        broker_call: Callable[[BrokerMutationIoPermit], _Result],
    ) -> _Result:
        intent = self._intent(spec)
        with self._session_factory() as session:
            return self._coordinator.execute_unlinked_mutation(
                session,
                intent=intent,
                callbacks=UnlinkedMutationCallbacks(
                    broker_call=broker_call,
                    persist_terminal=lambda _response: None,
                    build_settlement=lambda response: _terminal_settlement(
                        operation=spec.operation,
                        client_request_id=intent.client_request_id,
                        response=response,
                    ),
                ),
            )

    def _intent(self, spec: _MutationSpec) -> BrokerMutationIntent:
        request_id = risk_reduction_request_id(
            spec.operation,
            spec.request_payload,
            target_kind=spec.target_kind,
            target_key=spec.target_key,
        )
        return build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label=self._account_label,
                endpoint_fingerprint=self._endpoint_fingerprint,
                operation=spec.operation,
                risk_class=spec.risk_class,
                purpose=spec.purpose,
                workflow_id=request_id,
                client_request_id=request_id,
                target=BrokerMutationTarget(
                    kind=spec.target_kind,
                    key=spec.target_key,
                ),
                request_payload=spec.request_payload,
            )
        )

    def _settle_authorized_preflight(
        self,
        spec: _MutationSpec,
    ) -> None:
        self._settle_preflight_intent(
            self._intent(spec),
            observation={"reason": "empty_complete_snapshot"},
        )

    def _settle_already_satisfied(
        self,
        spec: _MutationSpec,
        *,
        observation: Mapping[str, object],
    ) -> None:
        self._settle_preflight_intent(
            self._intent(spec),
            observation=observation,
        )

    def _settle_preflight_intent(
        self,
        intent: BrokerMutationIntent,
        *,
        observation: Mapping[str, object],
    ) -> None:
        settlement = build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="preflight",
                outcome="already_satisfied",
                broker_reference=None,
                execution_id=None,
                evidence_payload={
                    "operation": intent.operation,
                    "observation": observation,
                    "schema_version": _PREFLIGHT_SCHEMA_VERSION,
                },
            )
        )
        with self._session_factory() as session:
            try:
                self._coordinator.settle_preflight(
                    session,
                    intent=intent,
                    settlement=settlement,
                )
            except BrokerMutationAlreadyProcessed:
                return


def _request_payload(
    authorization: RiskReductionAuthorization,
    *,
    broker_request: Mapping[str, object],
) -> Mapping[str, object]:
    return {
        **broker_request,
        "risk_reduction": authorization.evidence_payload,
        "schema_version": _REQUEST_SCHEMA_VERSION,
    }


def _already_satisfied_request(
    observation: Mapping[str, object],
) -> Mapping[str, object]:
    return {
        "already_satisfied": True,
        "observation": observation,
        "schema_version": _PREFLIGHT_SCHEMA_VERSION,
    }


def _terminal_settlement(
    *,
    operation: BrokerMutationOperation,
    client_request_id: str,
    response: object,
) -> BrokerMutationSettlement:
    rejected = _response_rejected(response)
    broker_reference = _broker_reference(response) or client_request_id
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="rejected" if rejected else "acknowledged",
            broker_reference=None if rejected else broker_reference,
            execution_id=None,
            evidence_payload={
                "client_request_id": client_request_id,
                "operation": operation,
                "response": _json_value(response),
                "schema_version": "torghut.alpaca-reduction-terminal.v1",
            },
        )
    )


def _response_rejected(response: object) -> bool:
    if response is True:
        return False
    if response is False:
        return True
    response_map = _string_mapping(response)
    if response_map is not None:
        return _mapping_response_rejected(response_map)
    if isinstance(response, Sequence) and not isinstance(response, (str, bytes)):
        items = tuple(cast(Sequence[object], response))
        if not items:
            raise ValueError("alpaca_reduction_response_empty")
        verdicts: list[bool] = []
        for item in items:
            item_map = _string_mapping(item)
            if item_map is None:
                raise ValueError("alpaca_reduction_response_item_invalid")
            verdicts.append(_mapping_response_rejected(item_map))
        if all(verdicts):
            return True
        if any(verdicts):
            raise ValueError("alpaca_reduction_response_partial")
        return False
    raise ValueError("alpaca_reduction_response_invalid")


def _mapping_response_rejected(response: Mapping[str, object]) -> bool:
    status = response.get("status")
    if type(status) is int:
        status_code = status
        if 200 <= status_code < 300:
            return False
        if 400 <= status_code < 600:
            return True
        raise ValueError("alpaca_reduction_http_status_indeterminate")
    normalized = str(status or "").strip().lower()
    if normalized in _ACCEPTED_ORDER_STATUSES:
        return False
    if normalized in _REJECTED_ORDER_STATUSES:
        return True
    raise ValueError("alpaca_reduction_order_status_indeterminate")


def _broker_reference(response: object) -> str | None:
    response_map = _string_mapping(response)
    if response_map is not None:
        value = response_map.get("id") or response_map.get("order_id")
        return str(value).strip() if value else None
    if isinstance(response, Sequence) and not isinstance(response, (str, bytes)):
        for item in cast(Sequence[object], response):
            reference = _broker_reference(item)
            if reference:
                return reference
    return None


def _string_mapping(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    return cast(Mapping[str, object], value)


def _json_value(value: object) -> object:
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError) as exc:
        raise ValueError("alpaca_reduction_response_not_serializable") from exc


def _decimal_text(value: Decimal) -> str:
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


__all__ = ["AlpacaReductionMutationExecutor"]
