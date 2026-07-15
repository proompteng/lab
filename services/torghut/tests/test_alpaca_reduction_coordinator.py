from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import cast
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.alpaca_client import TorghutAlpacaClient
from app.config import settings
from app.models import Base, BrokerMutationReceipt, BrokerMutationReceiptEvent
from app.trading.broker_mutation_coordinator import (
    BrokerMutationDeferred,
    BrokerMutationUnresolved,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationReceiptValidationError,
)
from app.trading.execution_adapters import AlpacaExecutionAdapter, OrderSubmission
from app.trading.firewall import OrderFirewall


class _CloseoutBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self) -> None:
        self.close_calls = 0
        self.positions: list[dict[str, object]] = [
            {
                "symbol": "AAPL",
                "qty": "1",
                "side": "long",
                "market_value": "100",
            }
        ]

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)

    def close_position(self, *_args: object, **_kwargs: object) -> dict[str, object]:
        self.close_calls += 1
        self.positions = []
        return {"id": "closeout-order-1", "status": "accepted"}


class _CloseAllBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self, responses: list[dict[str, object]]) -> None:
        self.close_calls = 0
        self.responses = responses
        self.positions: list[dict[str, object]] = [
            {
                "symbol": "AAPL",
                "qty": "1",
                "side": "long",
                "market_value": "100",
            },
            {
                "symbol": "MSFT",
                "qty": "2",
                "side": "short",
                "market_value": "-200",
            },
        ]

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)

    def close_all_positions(self, **_kwargs: object) -> list[dict[str, object]]:
        self.close_calls += 1
        return list(self.responses)


class _UnchangedCloseBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self) -> None:
        self.close_calls = 0
        self.market_value = Decimal("100")

    def list_positions(self) -> list[dict[str, object]]:
        return [
            {
                "symbol": "AAPL",
                "qty": "1",
                "side": "long",
                "market_value": str(self.market_value),
            }
        ]

    def close_position(self, *_args: object, **_kwargs: object) -> dict[str, object]:
        self.close_calls += 1
        return {"id": "closeout-order-1", "status": "accepted"}


class _ReplaceBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self, *, side: str = "buy") -> None:
        self.side = side
        self.replace_calls: list[tuple[str, float]] = []
        self.positions: list[dict[str, object]] = []

    def get_order_by_id_strict(self, order_id: str) -> dict[str, object]:
        return {
            "id": order_id,
            "client_order_id": "client-order-1",
            "symbol": "AAPL",
            "side": self.side,
            "qty": "10",
            "filled_qty": "4",
            "status": "partially_filled",
            "limit_price": "200",
        }

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)

    def replace_order(
        self,
        order_id: str,
        *,
        limit_price: float,
        **_kwargs: object,
    ) -> dict[str, object]:
        self.replace_calls.append((order_id, limit_price))
        return {"id": "replacement-1", "status": "accepted"}


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


def test_broker_enforced_close_is_receipted_and_preflight_deduplicated(
    sessions: sessionmaker[Session],
) -> None:
    broker = _CloseoutBroker()
    firewall = OrderFirewall(broker, account_label="paper")
    adapter = AlpacaExecutionAdapter(
        firewall=firewall,
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )
    submission = OrderSubmission(
        symbol="AAPL",
        side="sell",
        qty=1.0,
        order_type="limit",
        time_in_force="day",
        limit_price=100.0,
        stop_price=None,
        extra_params=None,
    )

    with patch.object(settings, "trading_kill_switch_enabled", False):
        with pytest.raises(
            RuntimeError,
            match="alpaca_entry_submit_requires_durable_order_firewall",
        ):
            adapter.submit_order(submission)
        result = adapter.close_position("AAPL", Decimal("1"))
        duplicate = adapter.close_position("AAPL", Decimal("1"))
        duplicate_again = adapter.close_position("AAPL", Decimal("1"))

    assert result["id"] == "closeout-order-1"
    assert duplicate["status"] == "already_satisfied"
    assert duplicate_again["status"] == "already_satisfied"
    assert broker.close_calls == 1
    with sessions() as session:
        receipts = (
            session.execute(
                select(BrokerMutationReceipt).order_by(BrokerMutationReceipt.created_at)
            )
            .scalars()
            .all()
        )
        assert len(receipts) == 2
        receipt = receipts[0]
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        assert receipt.broker_route == "alpaca"
        assert receipt.operation == "close_position"
        assert receipt.risk_class == "risk_reducing"
        assert receipt.purpose == "closeout"
        assert receipt.submission_claim_id is None
        assert latest.state == "settled"
        assert latest.settlement_outcome == "acknowledged"


def test_mark_price_change_cannot_create_a_second_identical_close(
    sessions: sessionmaker[Session],
) -> None:
    broker = _UnchangedCloseBroker()
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    adapter.close_position("AAPL", Decimal("1"))
    broker.market_value = Decimal("101")
    with pytest.raises(BrokerMutationDeferred, match="receipt_unavailable"):
        adapter.close_position("AAPL", Decimal("1"))

    assert broker.close_calls == 1
    with sessions() as session:
        assert len(session.execute(select(BrokerMutationReceipt.id)).all()) == 1


def test_repricing_uses_complete_observation_and_exact_broker_request(
    sessions: sessionmaker[Session],
) -> None:
    broker = _ReplaceBroker()
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    result = adapter.replace_order("order-1", limit_price=Decimal("190.25"))

    assert result == {"id": "replacement-1", "status": "accepted"}
    assert broker.replace_calls == [("order-1", 190.25)]
    with sessions() as session:
        receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    assert receipt.operation == "replace_order"
    assert receipt.risk_class == "risk_neutral"
    assert receipt.purpose == "repricing"
    assert latest.state == "settled"
    assert latest.settlement_outcome == "acknowledged"


def test_repricing_cannot_cross_an_observed_position(
    sessions: sessionmaker[Session],
) -> None:
    broker = _ReplaceBroker(side="sell")
    broker.positions = [
        {
            "symbol": "AAPL",
            "qty": "5",
            "side": "long",
            "market_value": "1000",
        }
    ]
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    with pytest.raises(
        BrokerMutationReceiptValidationError,
        match="replacement_would_cross_position_zero",
    ):
        adapter.replace_order("order-1", limit_price=Decimal("190.25"))

    assert broker.replace_calls == []
    with sessions() as session:
        assert (
            session.execute(select(BrokerMutationReceipt)).scalar_one_or_none() is None
        )


@pytest.mark.parametrize(
    ("responses", "expected_state", "expected_outcome"),
    [
        ([{"status": 422}, {"status": 500}], "settled", "rejected"),
        (
            [
                {"order_id": "close-aapl", "status": 200},
                {"order_id": "close-msft", "status": 200},
            ],
            "settled",
            "acknowledged",
        ),
        (
            [{"order_id": "close-aapl", "status": 200}, {"status": 422}],
            "broker_io",
            None,
        ),
        ([], "broker_io", None),
    ],
)
def test_close_all_settlement_reflects_every_broker_response(
    sessions: sessionmaker[Session],
    responses: list[dict[str, object]],
    expected_state: str,
    expected_outcome: str | None,
) -> None:
    broker = _CloseAllBroker(responses)
    firewall = OrderFirewall(broker, account_label="paper")
    adapter = AlpacaExecutionAdapter(
        firewall=firewall,
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )

    if expected_state == "settled":
        assert adapter.close_all_positions() == responses
    else:
        with pytest.raises(BrokerMutationUnresolved, match="terminal_unresolved"):
            adapter.close_all_positions()

    assert broker.close_calls == 1
    with sessions() as session:
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    assert latest.state == expected_state
    assert latest.settlement_outcome == expected_outcome
