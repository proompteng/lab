"""Durable risk-reduction authority for Hyperliquid broker mutations."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal
from typing import TypeVar

from sqlalchemy.orm import Session

from ..trading.broker_mutation_coordinator import (
    BrokerMutationAlreadyProcessed,
    BrokerMutationCoordinator,
    UnlinkedMutationCallbacks,
)
from ..trading.broker_mutation_receipts import (
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
from ..trading.risk_reduction import (
    BrokerReductionSnapshot,
    CancelOrderPlan,
    ClosePositionPlan,
    PositionCloseLeg,
    RiskReductionAuthorization,
    authorize_risk_reduction,
)
from ..trading.risk_reduction_mutation_authority import (
    RiskReductionMutationAuthority,
    risk_reduction_request_id,
)
from .exchange import HyperliquidExecutionExchange
from .models import AccountState, OpenOrder, OrderResult


_Result = TypeVar("_Result")
_REQUEST_SCHEMA_VERSION = "torghut.hyperliquid-reduction-request.v1"
_PREFLIGHT_SCHEMA_VERSION = "torghut.hyperliquid-reduction-preflight.v1"


@dataclass(frozen=True, slots=True)
class _MutationSpec:
    operation: BrokerMutationOperation
    risk_class: BrokerMutationRiskClass
    purpose: BrokerMutationPurpose
    target_kind: BrokerMutationTargetKind
    target_key: str
    request_payload: Mapping[str, object]


class HyperliquidReductionMutationExecutor:
    """Seal exchange observations before invoking the SDK mutation adapter."""

    def __init__(
        self,
        *,
        exchange: HyperliquidExecutionExchange,
        session: Session,
        coordinator: BrokerMutationCoordinator,
        account_label: str,
        endpoint_url: str,
    ) -> None:
        self._exchange = exchange
        self._session = session
        self._coordinator = coordinator
        self._account_label = account_label.strip()
        self._endpoint_fingerprint = fingerprint_broker_endpoint(endpoint_url)

    def reconcile_account(self, market_id_by_coin: dict[str, str]) -> AccountState:
        return self._exchange.reconcile_account(market_id_by_coin)

    def cancel_order(
        self,
        order: OpenOrder,
        *,
        purpose: BrokerMutationPurpose = "operator",
    ) -> OrderResult:
        target_key = str(order.exchange_order_id or order.cloid).strip()
        observed_at = datetime.now(timezone.utc)
        observed_order = self._exchange.observe_open_order(order)
        if observed_order is None:
            self._settle_preflight(
                _MutationSpec(
                    operation="cancel_order",
                    risk_class="risk_neutral",
                    purpose=purpose,
                    target_kind="order",
                    target_key=target_key,
                    request_payload={
                        "already_satisfied": True,
                        "cloid": order.cloid,
                        "exchange_order_id": order.exchange_order_id,
                        "schema_version": _PREFLIGHT_SCHEMA_VERSION,
                    },
                )
            )
            return OrderResult(
                status="cancelled",
                exchange_order_id=order.exchange_order_id,
                raw_response={"already_satisfied": True},
            )
        broker_order = (
            order
            if order.exchange_order_id == observed_order.order_id
            else replace(order, exchange_order_id=observed_order.order_id)
        )
        snapshot = BrokerReductionSnapshot(
            broker_route="hyperliquid",
            account_label=self._account_label,
            endpoint_fingerprint=self._endpoint_fingerprint,
            observed_at=observed_at,
            complete=False,
            orders=(observed_order,),
        )
        authorization = authorize_risk_reduction(
            snapshot,
            CancelOrderPlan(observed_order.order_id),
            now=observed_at,
        )
        request_payload = _request_payload(
            authorization,
            broker_request={
                "cloid": order.cloid,
                "coin": order.coin,
                "dex": order.dex,
                "order_id": observed_order.order_id,
            },
        )
        spec = _MutationSpec(
            operation="cancel_order",
            risk_class="risk_neutral",
            purpose=purpose,
            target_kind="order",
            target_key=observed_order.order_id,
            request_payload=request_payload,
        )
        return self._execute(
            spec,
            lambda mutation_permit: self._exchange.cancel_order(
                broker_order,
                authority=RiskReductionMutationAuthority(
                    request_payload=request_payload,
                    mutation_permit=mutation_permit,
                    reduction_permit=authorization.permit,
                ),
            ),
        )

    def close_position_reduce_only(
        self,
        coin: str,
        *,
        size: Decimal | None = None,
        slippage: Decimal = Decimal("0.05"),
        expected_signed_quantity: Decimal | None = None,
        purpose: BrokerMutationPurpose = "closeout",
    ) -> OrderResult:
        observed_at, positions = self._exchange.observe_reduction_positions()
        broker_coin = coin.strip()
        normalized_coin = broker_coin.upper()
        normalized_slippage = Decimal(slippage)
        if (
            not normalized_slippage.is_finite()
            or normalized_slippage < 0
            or normalized_slippage >= 1
        ):
            raise ValueError("hyperliquid_close_slippage_invalid")
        position = next(
            (value for value in positions if value.symbol == normalized_coin),
            None,
        )
        if position is None:
            self._settle_preflight(
                _MutationSpec(
                    operation="close_position",
                    risk_class="risk_reducing",
                    purpose=purpose,
                    target_kind="position",
                    target_key=normalized_coin,
                    request_payload={
                        "already_satisfied": True,
                        "coin": normalized_coin,
                        "schema_version": _PREFLIGHT_SCHEMA_VERSION,
                    },
                )
            )
            return OrderResult(
                status="filled",
                exchange_order_id=None,
                raw_response={"already_satisfied": True},
            )
        if position.broker_symbol != broker_coin:
            raise ValueError("hyperliquid_position_broker_symbol_changed")
        expected_quantity = (
            None
            if expected_signed_quantity is None
            else Decimal(expected_signed_quantity)
        )
        if expected_quantity is not None:
            if not expected_quantity.is_finite() or expected_quantity == 0:
                raise ValueError("hyperliquid_expected_position_quantity_invalid")
            if position.signed_quantity.is_signed() != expected_quantity.is_signed():
                raise ValueError("hyperliquid_position_direction_changed")
        if size is None:
            close_size = abs(position.signed_quantity)
        else:
            close_size = Decimal(size)
            if not close_size.is_finite() or close_size <= 0:
                raise ValueError("hyperliquid_close_size_invalid")
            close_size = close_size.normalize()
        leg = PositionCloseLeg(
            symbol=normalized_coin,
            side="sell" if position.signed_quantity > 0 else "buy",
            quantity=close_size,
        )
        snapshot = BrokerReductionSnapshot(
            broker_route="hyperliquid",
            account_label=self._account_label,
            endpoint_fingerprint=self._endpoint_fingerprint,
            observed_at=observed_at,
            complete=True,
            positions=positions,
        )
        authorization = authorize_risk_reduction(
            snapshot,
            ClosePositionPlan(leg),
            now=datetime.now(timezone.utc),
            max_observation_age_seconds=5,
        )
        request_payload = _request_payload(
            authorization,
            broker_request={
                "coin": broker_coin,
                "expected_signed_quantity": (
                    None
                    if expected_quantity is None
                    else _decimal_text(expected_quantity)
                ),
                "size": _decimal_text(close_size),
                "slippage": _decimal_text(normalized_slippage),
            },
        )
        spec = _MutationSpec(
            operation="close_position",
            risk_class="risk_reducing",
            purpose=purpose,
            target_kind="position",
            target_key=normalized_coin,
            request_payload=request_payload,
        )
        return self._execute(
            spec,
            lambda mutation_permit: self._exchange.close_position_reduce_only(
                broker_coin,
                size=close_size,
                slippage=normalized_slippage,
                authority=RiskReductionMutationAuthority(
                    request_payload=request_payload,
                    mutation_permit=mutation_permit,
                    reduction_permit=authorization.permit,
                ),
            ),
        )

    def _execute(
        self,
        spec: _MutationSpec,
        broker_call: Callable[[BrokerMutationIoPermit], _Result],
    ) -> _Result:
        intent = self._intent(spec)
        return self._coordinator.execute_unlinked_mutation(
            self._session,
            intent=intent,
            callbacks=UnlinkedMutationCallbacks(
                broker_call=broker_call,
                persist_terminal=lambda _response: None,
                build_settlement=lambda response: _terminal_settlement(
                    spec.operation,
                    intent.client_request_id,
                    response,
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
                broker_route="hyperliquid",
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

    def _settle_preflight(self, spec: _MutationSpec) -> None:
        intent = self._intent(spec)
        settlement = build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="preflight",
                outcome="already_satisfied",
                broker_reference=None,
                execution_id=None,
                evidence_payload={
                    "operation": spec.operation,
                    "schema_version": _PREFLIGHT_SCHEMA_VERSION,
                    "target_key": spec.target_key,
                },
            )
        )
        try:
            self._coordinator.settle_preflight(
                self._session,
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


def _terminal_settlement(
    operation: BrokerMutationOperation,
    client_request_id: str,
    response: object,
) -> BrokerMutationSettlement:
    if not isinstance(response, OrderResult):
        raise ValueError("hyperliquid_reduction_result_invalid")
    rejected = response.status == "rejected"
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="rejected" if rejected else "acknowledged",
            broker_reference=(
                None if rejected else response.exchange_order_id or client_request_id
            ),
            execution_id=None,
            evidence_payload={
                "client_request_id": client_request_id,
                "operation": operation,
                "raw_response": response.raw_response,
                "rejection_reason": response.rejection_reason,
                "schema_version": "torghut.hyperliquid-reduction-terminal.v1",
                "status": response.status,
            },
        )
    )


def _decimal_text(value: Decimal) -> str:
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


__all__ = ["HyperliquidReductionMutationExecutor"]
