from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Base, Execution
from app.snapshots import (
    _preserve_existing_execution_audit,
    _runtime_ledger_cost_payload_from_order,
    sync_order_to_db,
)


class TestSnapshotRuntimeCostCoverage(TestCase):
    def test_runtime_cost_requires_basis_for_unknown_amount_field(self) -> None:
        self.assertIsNone(
            _runtime_ledger_cost_payload_from_order({"cost_amount": "0.25"})
        )

    def test_runtime_cost_uses_explicit_basis_for_unknown_amount_field(self) -> None:
        payload = _runtime_ledger_cost_payload_from_order(
            {
                "cost_amount": "0.25",
                "cost_basis": "broker_reported_fees",
            }
        )

        self.assertEqual(
            payload,
            {
                "cost_amount": "0.25",
                "cost_basis": "broker_reported_fees",
                "source_field": "cost_amount",
            },
        )

    def test_runtime_cost_skips_negative_amount_and_uses_broker_basis(self) -> None:
        payload = _runtime_ledger_cost_payload_from_order(
            {
                "cost_amount": "-1",
                "commission": "0",
            }
        )

        self.assertEqual(
            payload,
            {
                "cost_amount": "0",
                "cost_basis": "broker_reported_commission",
                "source_field": "commission",
            },
        )

    def test_preserve_existing_execution_audit_ignores_non_mapping_audit(self) -> None:
        data = {"execution_audit_json": {"cost_basis": "broker_reported_fees"}}
        existing = Execution(
            alpaca_account_label="paper",
            alpaca_order_id="order-non-mapping-audit",
            symbol="AAPL",
            side="buy",
            order_type="market",
            time_in_force="day",
            submitted_qty=Decimal("1"),
            filled_qty=Decimal("0"),
            status="accepted",
            execution_audit_json=None,
            raw_order={},
        )

        self.assertIs(
            _preserve_existing_execution_audit(existing=existing, data=data),
            data,
        )

    def test_sync_order_integrity_race_updates_existing_order(self) -> None:
        with TemporaryDirectory() as tmpdir:
            engine = create_engine(
                f"sqlite+pysqlite:///{Path(tmpdir) / 'torghut.db'}",
                future=True,
            )
            Base.metadata.create_all(engine)
            try:
                with Session(engine) as session:
                    original_commit = session.commit
                    state = {"raced": False}

                    def racing_commit() -> None:
                        if not state["raced"]:
                            state["raced"] = True
                            with Session(engine) as competing_session:
                                competing_session.add(
                                    Execution(
                                        alpaca_account_label="paper",
                                        alpaca_order_id="race-order",
                                        symbol="AAPL",
                                        side="buy",
                                        order_type="market",
                                        time_in_force="day",
                                        submitted_qty=Decimal("1"),
                                        filled_qty=Decimal("0"),
                                        status="accepted",
                                        raw_order={},
                                    )
                                )
                                competing_session.commit()
                        original_commit()

                    session.commit = racing_commit  # type: ignore[method-assign]

                    execution = sync_order_to_db(
                        session,
                        {
                            "id": "race-order",
                            "symbol": "AAPL",
                            "side": "buy",
                            "type": "market",
                            "time_in_force": "day",
                            "qty": "1",
                            "filled_qty": "1",
                            "filled_avg_price": "100",
                            "status": "filled",
                            "commission": "0",
                        },
                    )

                    self.assertEqual(execution.alpaca_order_id, "race-order")
                    self.assertEqual(execution.status, "filled")
                    self.assertEqual(execution.filled_qty, Decimal("1.00000000"))
            except IntegrityError:
                self.fail("sync_order_to_db did not recover the unique-order race")
            finally:
                engine.dispose()
