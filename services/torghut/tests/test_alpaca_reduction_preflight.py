from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import cast
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.alpaca_client import TorghutAlpacaClient
from app.models import Base, BrokerMutationReceipt
from app.trading.execution_adapters import AlpacaExecutionAdapter
from app.trading.firewall import OrderFirewall


class _EmptyOrderBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self) -> None:
        self.cancel_all_calls = 0

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        del status, limit
        return []

    def cancel_all_orders(self, **_kwargs: object) -> list[dict[str, object]]:
        self.cancel_all_calls += 1
        return []


def test_empty_cancel_all_preflight_survives_restart_and_scopes_purpose() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    broker = _EmptyOrderBroker()

    def adapter() -> AlpacaExecutionAdapter:
        return AlpacaExecutionAdapter(
            firewall=OrderFirewall(broker, account_label="paper"),
            read_client=cast(TorghutAlpacaClient, broker),
            session_factory=sessions,
            account_label="paper",
            endpoint_url=broker.endpoint_url,
        )

    with patch("app.trading.alpaca_reduction_mutations.datetime") as clock:
        clock.now.side_effect = [
            datetime(2026, 7, 15, 19, 45, tzinfo=timezone.utc),
            datetime(2026, 7, 15, 19, 57, tzinfo=timezone.utc),
            datetime(2026, 7, 15, 20, 0, tzinfo=timezone.utc),
        ]
        assert adapter().cancel_all_orders(purpose="closeout") == []
        assert adapter().cancel_all_orders(purpose="closeout") == []
        assert adapter().cancel_all_orders(purpose="kill_switch") == []

    assert broker.cancel_all_calls == 0
    with sessions() as session:
        receipts = session.execute(select(BrokerMutationReceipt)).scalars().all()
    assert len(receipts) == 2
    assert {receipt.purpose for receipt in receipts} == {"closeout", "kill_switch"}
    for receipt in receipts:
        request = json.loads(receipt.canonical_intent_json)["request"]
        assert request == {
            "already_satisfied": True,
            "observation": {"complete": True, "orders": []},
            "schema_version": "torghut.alpaca-reduction-preflight.v1",
        }
    engine.dispose()
