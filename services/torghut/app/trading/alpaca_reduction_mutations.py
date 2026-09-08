"""Fenced Alpaca cancel, replace, and broker-enforced close operations."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Protocol, TypeVar, cast

from sqlalchemy.orm import Session

from ..alpaca_client import AlpacaSubmitRequest
from .alpaca_observations import (
    alpaca_order_observation,
    alpaca_order_references,
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
from .infrastructure_validation import (
    is_infrastructure_validation_lifecycle_plan_schema,
)
from .infrastructure_validation_records import (
    InfrastructureValidationEvidence,
    infrastructure_validation_lineage_payload,
    load_infrastructure_validation_evidence,
    require_infrastructure_validation_position_evidence,
)
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
    SubmitCloseOrderPlan,
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
_ORDER_CREATING_OPERATIONS = frozenset(
    {"submit_order", "replace_order", "close_position", "close_all_positions"}
)
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


class AlpacaReductionReadClient(Protocol):
    """Broker observations required to authorize Alpaca reductions."""

    def get_order_by_id_strict(
        self,
        order_id: str,
    ) -> dict[str, object] | None: ...

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]: ...

    def list_positions(self) -> list[dict[str, object]]: ...


@dataclass(frozen=True, slots=True)
class _MutationSpec:
    operation: BrokerMutationOperation
    risk_class: BrokerMutationRiskClass
    purpose: BrokerMutationPurpose
    target_kind: BrokerMutationTargetKind
    target_key: str
    request_payload: Mapping[str, object]
    client_request_id: str | None = None


class AlpacaReductionMutationExecutor:
    """Translate fresh Alpaca state into the shared mutation protocol."""

    def __init__(
        self,
        *,
        firewall: OrderFirewall,
        read_client: AlpacaReductionReadClient,
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

    def submit_crypto_close_order(
        self,
        symbol: str,
        quantity: Decimal,
        *,
        limit_price: Decimal,
        validation_evidence: InfrastructureValidationEvidence | None = None,
    ) -> dict[str, object]:
        """Place one observed-position-bounded crypto close limit order."""

        self._require_validation_evidence_scope(
            validation_evidence,
            require_position_ancestry=True,
        )
        normalized_symbol = symbol.strip().upper()
        if "/" not in normalized_symbol:
            raise RiskReductionPermitError(
                "alpaca_close_limit_requires_non_shortable_crypto"
            )
        observed_at = datetime.now(timezone.utc)
        positions = tuple(
            alpaca_position_observation(position)
            for position in self._read_client.list_positions()
        )
        position = next(
            (value for value in positions if value.symbol == normalized_symbol),
            None,
        )
        if position is None or position.signed_quantity <= 0:
            raise RiskReductionPermitError(
                "alpaca_close_limit_requires_long_crypto_position"
            )
        self._require_position_evidence(validation_evidence, position)
        raw_orders = self._read_client.list_orders(
            status="open",
            limit=_OPEN_ORDER_LIMIT,
        )
        orders = tuple(alpaca_order_observation(order) for order in raw_orders)
        authorization = authorize_risk_reduction(
            self._snapshot(
                observed_at=observed_at,
                complete=len(raw_orders) < _OPEN_ORDER_LIMIT,
                orders=orders,
                positions=positions,
            ),
            SubmitCloseOrderPlan(
                leg=PositionCloseLeg(
                    symbol=normalized_symbol,
                    side="sell",
                    quantity=quantity,
                ),
                limit_price=limit_price,
            ),
            now=observed_at,
        )
        base_payload = _request_payload(
            authorization,
            broker_request={
                "extra_params": {},
                "limit_price": _decimal_text(limit_price),
                "order_type": "limit",
                "qty": _decimal_text(quantity),
                "side": "sell",
                "stop_price": None,
                "symbol": normalized_symbol,
                "time_in_force": "gtc",
            },
            validation_evidence=validation_evidence,
        )
        client_order_id = risk_reduction_request_id(
            "submit_order",
            base_payload,
            target_kind="order",
            target_key=normalized_symbol,
        )
        request_payload = {
            **base_payload,
            "extra_params": {"client_order_id": client_order_id},
        }
        return self._execute(
            _MutationSpec(
                operation="submit_order",
                risk_class="risk_reducing",
                purpose="closeout",
                target_kind="order",
                target_key=normalized_symbol,
                request_payload=request_payload,
                client_request_id=client_order_id,
            ),
            broker_call=lambda mutation_permit: (
                self._firewall.submit_risk_reducing_order(
                    AlpacaSubmitRequest(
                        symbol=normalized_symbol,
                        side="sell",
                        qty=quantity,
                        order_type="limit",
                        time_in_force="gtc",
                        limit_price=limit_price,
                        stop_price=None,
                        extra_params={"client_order_id": client_order_id},
                    ),
                    authority=RiskReductionMutationAuthority(
                        request_payload=request_payload,
                        mutation_permit=mutation_permit,
                        reduction_permit=authorization.permit,
                    ),
                )
            ),
        )

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
            validation_evidence = self._validation_evidence_for_order(order)
            self._settle_already_satisfied(
                _MutationSpec(
                    operation="cancel_order",
                    risk_class="risk_neutral",
                    purpose=purpose,
                    target_kind="order",
                    target_key=order_id,
                    request_payload=_already_satisfied_request(
                        observation,
                        validation_evidence=validation_evidence,
                    ),
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
            validation_evidence=self._validation_evidence_for_order(order),
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
        if not any(order.open for order in snapshot.orders):
            observation: Mapping[str, object] = {
                "complete": snapshot.complete,
                "orders": [],
            }
            self._settle_already_satisfied(
                _MutationSpec(
                    operation="cancel_all_orders",
                    risk_class="risk_neutral",
                    purpose=purpose,
                    target_kind="account",
                    target_key=self._account_label,
                    request_payload=_already_satisfied_request(observation),
                ),
                observation=observation,
            )
            return []
        request_payload = _request_payload(
            authorization,
            broker_request={
                "target_order_ids": sorted(
                    order.order_id for order in snapshot.orders if order.open
                )
            },
        )
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
            validation_evidence=self._validation_evidence_for_order(order),
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
        validation_evidence: InfrastructureValidationEvidence | None = None,
    ) -> dict[str, object]:
        self._require_validation_evidence_scope(
            validation_evidence,
            require_position_ancestry=True,
        )
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
                    request_payload=_already_satisfied_request(
                        observation,
                        validation_evidence=validation_evidence,
                    ),
                ),
                observation=observation,
            )
            return {"status": "already_satisfied", "symbol": normalized_symbol}
        self._require_position_evidence(validation_evidence, position)
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
        broker_symbol = str(position.broker_symbol or "").strip()
        if not broker_symbol or "/" in broker_symbol:
            raise RuntimeError("alpaca_close_position_broker_symbol_invalid")
        request_payload = _request_payload(
            authorization,
            broker_request={
                "broker_symbol": broker_symbol,
                "quantity": _decimal_text(quantity),
                "symbol": normalized_symbol,
            },
            validation_evidence=validation_evidence,
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
                broker_symbol=broker_symbol,
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
        validation_evidence: InfrastructureValidationEvidence | None = None,
    ) -> list[dict[str, object]]:
        self._require_validation_evidence_scope(
            validation_evidence,
            require_position_ancestry=True,
        )
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
                    request_payload=_already_satisfied_request(
                        observation,
                        validation_evidence=validation_evidence,
                    ),
                ),
                observation=observation,
            )
            return []
        if validation_evidence is not None and len(positions) != 1:
            raise RuntimeError("infrastructure_validation_position_scope_mismatch")
        if positions:
            self._require_position_evidence(validation_evidence, positions[0])
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
            validation_evidence=validation_evidence,
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

    def _validation_evidence_for_order(
        self,
        order: BrokerOrderObservation,
    ) -> InfrastructureValidationEvidence | None:
        client_order_id = str(order.client_order_id or "").strip()
        with self._session_factory() as session:
            evidence = load_infrastructure_validation_evidence(
                session,
                account_label=self._account_label,
                client_order_id=client_order_id,
                alpaca_order_id=order.order_id,
                endpoint_fingerprint=self._endpoint_fingerprint,
            )
        if evidence is None and client_order_id.startswith("ivp-"):
            raise RuntimeError("infrastructure_validation_order_lineage_missing")
        return evidence

    def _require_validation_evidence_scope(
        self,
        evidence: InfrastructureValidationEvidence | None,
        *,
        require_position_ancestry: bool = False,
    ) -> None:
        if evidence is None:
            return
        if (
            evidence.account_label != self._account_label
            or evidence.endpoint_fingerprint != self._endpoint_fingerprint
        ):
            raise RuntimeError("infrastructure_validation_lineage_scope_mismatch")
        if (
            require_position_ancestry
            and not is_infrastructure_validation_lifecycle_plan_schema(
                evidence.root_plan_schema
            )
        ):
            raise RuntimeError("infrastructure_validation_position_ancestry_missing")

    def _require_position_evidence(
        self,
        evidence: InfrastructureValidationEvidence | None,
        position: BrokerPositionObservation,
    ) -> None:
        if evidence is None:
            return
        with self._session_factory() as session:
            require_infrastructure_validation_position_evidence(
                session,
                evidence=evidence,
                symbol=position.symbol,
                signed_quantity=position.signed_quantity,
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
        request_id = spec.client_request_id or risk_reduction_request_id(
            spec.operation,
            spec.request_payload,
            target_kind=spec.target_kind,
            target_key=spec.target_key,
            purpose=spec.purpose,
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
    validation_evidence: InfrastructureValidationEvidence | None = None,
) -> Mapping[str, object]:
    payload: dict[str, object] = {
        **broker_request,
        "risk_reduction": authorization.evidence_payload,
        "schema_version": _REQUEST_SCHEMA_VERSION,
    }
    if validation_evidence is not None:
        payload["infrastructure_validation_lineage"] = (
            infrastructure_validation_lineage_payload(validation_evidence)
        )
    return payload


def _already_satisfied_request(
    observation: Mapping[str, object],
    *,
    validation_evidence: InfrastructureValidationEvidence | None = None,
) -> Mapping[str, object]:
    payload: dict[str, object] = {
        "already_satisfied": True,
        "observation": observation,
        "schema_version": _PREFLIGHT_SCHEMA_VERSION,
    }
    if validation_evidence is not None:
        payload["infrastructure_validation_lineage"] = (
            infrastructure_validation_lineage_payload(validation_evidence)
        )
    return payload


def _terminal_settlement(
    *,
    operation: BrokerMutationOperation,
    client_request_id: str,
    response: object,
) -> BrokerMutationSettlement:
    rejected = _response_rejected(response)
    broker_reference = _broker_reference(response)
    if (
        not rejected
        and operation in _ORDER_CREATING_OPERATIONS
        and not broker_reference
    ):
        raise ValueError("alpaca_reduction_broker_reference_missing")
    if not broker_reference:
        broker_reference = client_request_id
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
    references = alpaca_order_references(response)
    return references[0] if references else None


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


__all__ = ["AlpacaReductionMutationExecutor", "AlpacaReductionReadClient"]
