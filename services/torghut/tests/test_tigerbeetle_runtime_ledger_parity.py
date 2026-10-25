from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Base, Execution, ExecutionTCAMetric
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_journal import (
    TigerBeetleLedgerJournal,
    execution_tca_metric_source_id,
)
from app.trading.tigerbeetle_runtime_ledger_parity import (
    PARITY_STATUS_PASS,
    audit_tigerbeetle_runtime_ledger_parity,
)
from app.trading.tigerbeetle_reconcile import reconcile_tigerbeetle_transfers


def _settings() -> Settings:
    return Settings(
        TORGHUT_TIGERBEETLE_ENABLED=True,
        TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
        TORGHUT_TIGERBEETLE_REQUIRED=True,
        TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED=True,
    )


class TestTigerBeetleRuntimeLedgerParity(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def test_parity_reads_revisioned_tca_ref_after_same_metric_retry(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-parity-revision",
                client_order_id="client-parity-revision",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-parity-revision"},
            )
            session.add(execution)
            session.flush()
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            self.assertIsNotNone(journal.journal_execution(session, execution))
            first = journal.journal_execution_tca_metric(session, metric)
            self.assertIsNotNone(first)
            metric.shortfall_notional = Decimal("0.40")
            metric.realized_shortfall_bps = Decimal("2.1")
            session.add(metric)
            session.flush()
            second = journal.journal_execution_tca_metric(session, metric)

            self.assertIsNotNone(second)
            assert second is not None
            self.assertEqual(second.source_id, execution_tca_metric_source_id(metric))
            reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )
            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(),
                client=client,
                limit=1,
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["parity_status"], PARITY_STATUS_PASS)
        samples = payload["samples"]
        assert isinstance(samples, list)
        self.assertEqual(samples[0]["source_id"], second.source_id)
        self.assertEqual(samples[0]["expected_amount_micros"], "400000")
