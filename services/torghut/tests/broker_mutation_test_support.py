from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Protocol, TypeVar, cast

from sqlalchemy.orm import Session

from app.trading.broker_mutation_receipts.types import (
    BrokerMutationIntent,
    BrokerMutationIoPermit,
    BrokerMutationIoPermitIssueRequest,
    BrokerMutationRiskClass,
    BrokerMutationRoute,
    issue_broker_mutation_io_permit,
)
from app.trading.broker_mutation_receipts.validation import (
    canonical_broker_request_sha256,
)
from app.trading.broker_mutation_receipts import fingerprint_broker_endpoint
from app.trading.broker_mutation_submit_coordinator import (
    BrokerMutationSubmitCoordinator,
    UnlinkedOrderSubmissionCallbacks,
)
from app.trading.firewall import (
    AlpacaSubmitRequest,
    OrderFirewall,
    alpaca_submit_request_payload,
)
from app.hyperliquid_execution.exchange import hyperliquid_submit_request_payload
from app.hyperliquid_execution.models import OrderIntent


_Result = TypeVar("_Result")


class _HyperliquidPermitExchange(Protocol):
    @property
    def account_label(self) -> str: ...

    @property
    def broker_endpoint_url(self) -> str: ...

    def normalize_order_intent(self, intent: OrderIntent) -> OrderIntent: ...


def broker_mutation_test_permit(
    *,
    request_payload: Mapping[str, object] | None = None,
    linked: bool = False,
    broker_route: BrokerMutationRoute | None = None,
    risk_class: str = "risk_increasing",
    account_label: str | None = None,
    endpoint_url: str | None = None,
) -> BrokerMutationIoPermit:
    claim_id = uuid.uuid4() if linked else None
    route = broker_route or ("alpaca" if linked else "hyperliquid")
    resolved_account = account_label or (
        "paper" if route == "alpaca" else "hyperliquid-testnet"
    )
    resolved_endpoint = endpoint_url or (
        "https://paper-api.alpaca.markets"
        if route == "alpaca"
        else "https://api.hyperliquid-testnet.xyz"
    )
    return issue_broker_mutation_io_permit(
        BrokerMutationIoPermitIssueRequest(
            receipt_id=uuid.uuid4(),
            primary_token=uuid.uuid4(),
            primary_epoch=1,
            event_sequence_no=2,
            broker_route=route,
            operation="submit_order",
            risk_class=cast(BrokerMutationRiskClass, risk_class),
            account_label=resolved_account,
            endpoint_fingerprint=fingerprint_broker_endpoint(resolved_endpoint),
            canonical_intent_sha256="a" * 64,
            canonical_request_sha256=canonical_broker_request_sha256(
                request_payload or {"test": "request"}
            ),
            submission_claim_id=claim_id,
            submission_claim_token=uuid.uuid4() if linked else None,
            submission_claim_fencing_epoch=1 if linked else None,
        )
    )


def broker_mutation_test_permit_for_intent(
    intent: BrokerMutationIntent,
) -> BrokerMutationIoPermit:
    return issue_broker_mutation_io_permit(
        BrokerMutationIoPermitIssueRequest(
            receipt_id=uuid.uuid4(),
            primary_token=uuid.uuid4(),
            primary_epoch=1,
            event_sequence_no=2,
            broker_route=intent.broker_route,
            operation=intent.operation,
            risk_class=intent.risk_class,
            account_label=intent.account_label,
            endpoint_fingerprint=intent.endpoint_fingerprint,
            canonical_intent_sha256=intent.canonical_intent_sha256,
            canonical_request_sha256=intent.canonical_request_sha256,
            submission_claim_id=intent.submission_claim_id,
            submission_claim_token=(
                uuid.uuid4() if intent.submission_claim_id is not None else None
            ),
            submission_claim_fencing_epoch=(
                1 if intent.submission_claim_id is not None else None
            ),
        ),
    )


def alpaca_broker_mutation_test_permit(
    firewall: OrderFirewall,
    *,
    symbol: object,
    side: object,
    qty: object,
    order_type: object,
    time_in_force: object,
    limit_price: object = None,
    stop_price: object = None,
    extra_params: dict[str, object] | None = None,
    linked: bool = True,
    risk_class: str = "risk_increasing",
) -> BrokerMutationIoPermit:
    return broker_mutation_test_permit(
        request_payload=alpaca_submit_request_payload(
            AlpacaSubmitRequest(
                symbol=symbol,
                side=side,
                qty=qty,
                order_type=order_type,
                time_in_force=time_in_force,
                limit_price=limit_price,
                stop_price=stop_price,
                extra_params=extra_params,
            )
        ),
        linked=linked,
        broker_route="alpaca",
        risk_class=risk_class,
        account_label=firewall.account_label,
        endpoint_url=firewall.broker_endpoint_url,
    )


def hyperliquid_broker_mutation_test_permit(
    exchange: _HyperliquidPermitExchange,
    intent: OrderIntent,
) -> BrokerMutationIoPermit:
    normalized = exchange.normalize_order_intent(intent)
    return broker_mutation_test_permit(
        request_payload=hyperliquid_submit_request_payload(normalized),
        broker_route="hyperliquid",
        risk_class="risk_increasing",
        account_label=exchange.account_label,
        endpoint_url=exchange.broker_endpoint_url,
    )


class PassthroughBrokerMutationSubmitCoordinator(BrokerMutationSubmitCoordinator):
    """Unit-test seam for repositories backed by SQL-recording fake sessions."""

    def __init__(self) -> None:
        super().__init__("test-passthrough")

    def submit_unlinked_order(
        self,
        session: Session,
        *,
        intent: BrokerMutationIntent,
        callbacks: UnlinkedOrderSubmissionCallbacks[_Result],
    ) -> _Result:
        del session
        result = callbacks.broker_call(broker_mutation_test_permit_for_intent(intent))
        callbacks.persist_terminal(result)
        callbacks.build_settlement(result)
        return result


__all__ = [
    "PassthroughBrokerMutationSubmitCoordinator",
    "alpaca_broker_mutation_test_permit",
    "broker_mutation_test_permit",
    "broker_mutation_test_permit_for_intent",
    "hyperliquid_broker_mutation_test_permit",
]
