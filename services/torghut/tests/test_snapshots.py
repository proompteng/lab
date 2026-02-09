from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, List
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Execution
from app.snapshots import snapshot_account_and_positions, sync_order_to_db


class DummyAlpacaClient:
    def __init__(self) -> None:
        self.positions: List[dict[str, Any]] = [
            {"symbol": "AAPL", "qty": "1"},
        ]

    def get_account(self) -> dict[str, Any]:  # pragma: no cover - simple stub
        return {
            "equity": "10000",
            "cash": "5000",
            "buying_power": "20000",
        }

    def list_positions(self) -> List[dict[str, Any]]:  # pragma: no cover - simple stub
        return self.positions


class TestSnapshots(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_snapshot_account_and_positions_inserts_row(self) -> None:
        client = DummyAlpacaClient()
        with Session(self.engine) as session:
            snapshot = snapshot_account_and_positions(session, client, "paper")

            rows = session.execute(select(type(snapshot))).scalars().all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(snapshot.equity, Decimal("10000"))
            self.assertEqual(snapshot.cash, Decimal("5000"))
            self.assertEqual(snapshot.buying_power, Decimal("20000"))
            self.assertEqual(len(snapshot.positions), 1)

    def test_snapshot_account_and_positions_serializes_uuid_payloads(self) -> None:
        client = DummyAlpacaClient()
        sample_id = uuid.uuid4()
        client.positions = [
            {
                "symbol": "AAPL",
                "qty": "1",
                "position_id": sample_id,
                "nested": {"order_id": sample_id},
            },
        ]
        with Session(self.engine) as session:
            snapshot = snapshot_account_and_positions(session, client, "paper")

            def contains_uuid(value: Any) -> bool:
                if isinstance(value, uuid.UUID):
                    return True
                if isinstance(value, dict):
                    return any(contains_uuid(item) for item in value.values())
                if isinstance(value, list):
                    return any(contains_uuid(item) for item in value)
                return False

            self.assertFalse(contains_uuid(snapshot.positions))
            self.assertEqual(snapshot.positions[0]["position_id"], str(sample_id))

    def test_sync_order_create_and_update(self) -> None:
        with Session(self.engine) as session:
            first = sync_order_to_db(
                session,
                {
                    "id": "order-xyz",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                },
            )

            self.assertEqual(first.filled_qty, Decimal("0"))

            updated = sync_order_to_db(
                session,
                {
                    "id": "order-xyz",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "1",
                    "filled_avg_price": "10.50",
                    "status": "filled",
                },
            )

            self.assertEqual(first.id, updated.id)
            self.assertEqual(updated.filled_qty, Decimal("1"))
            self.assertEqual(updated.avg_fill_price, Decimal("10.50"))

    def test_sync_order_to_db_serializes_uuid_payloads(self) -> None:
        sample_id = uuid.uuid4()
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-uuid-test",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "client_order_id": "client-order-1",
                    "meta": {"strategy_run_id": sample_id},
                },
            )

            self.assertEqual(execution.raw_order["meta"]["strategy_run_id"], str(sample_id))
