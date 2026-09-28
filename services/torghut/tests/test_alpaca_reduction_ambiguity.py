from __future__ import annotations

import json
from collections.abc import Iterator
from types import SimpleNamespace
from typing import cast

import pytest
from alpaca.common.exceptions import APIError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.alpaca_client import TorghutAlpacaClient
from app.models import Base, BrokerMutationReceipt, BrokerMutationReceiptEvent
from app.trading.broker_mutation_coordinator import BrokerMutationUnresolved
from app.trading.execution_adapters import AlpacaExecutionAdapter
from app.trading.firewall import OrderFirewall


class _HttpErrorCancelBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self, *, status_code: int) -> None:
        self.status_code = status_code
        self.cancel_calls: list[str] = []

    def get_order_by_id_strict(self, order_id: str) -> dict[str, object]:
        return {
            "id": order_id,
            "client_order_id": "ordinary-client-1",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "1",
            "filled_qty": "0",
            "status": "new",
            "limit_price": "1",
        }

    def cancel_order(self, order_id: str, **_kwargs: object) -> bool:
        self.cancel_calls.append(order_id)
        raise APIError(
            json.dumps(
                {
                    "code": f"{self.status_code}10000",
                    "message": "ambiguous reduction response",
                }
            ),
            SimpleNamespace(
                response=SimpleNamespace(status_code=self.status_code),
                request=None,
            ),
        )


@pytest.fixture
def sessions() -> Iterator[sessionmaker[Session]]:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.mark.parametrize("status_code", (404, 422))
def test_cancel_http_rejection_keeps_receipt_unresolved(
    sessions: sessionmaker[Session],
    status_code: int,
) -> None:
    broker = _HttpErrorCancelBroker(status_code=status_code)
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    with pytest.raises(BrokerMutationUnresolved, match="broker_io_unresolved"):
        adapter.cancel_order("order-1")

    assert broker.cancel_calls == ["order-1"]
    with sessions() as session:
        receipt = session.execute(
            select(BrokerMutationReceipt).where(
                BrokerMutationReceipt.operation == "cancel_order"
            )
        ).scalar_one()
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    assert latest.state == "broker_io"
    assert latest.settlement_outcome is None
