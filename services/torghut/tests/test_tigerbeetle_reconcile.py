from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Base,
    ExecutionOrderEvent,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
)
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TRANSFER_CODE_FILL_POST,
    TigerBeetleTransferSpec,
)
from app.trading.tigerbeetle_reconcile import (
    BLOCKER_AMOUNT_MISMATCH,
    BLOCKER_CODE_MISMATCH,
    BLOCKER_CLIENT_UNAVAILABLE,
    BLOCKER_CREDIT_ACCOUNT_MISMATCH,
    BLOCKER_DEBIT_ACCOUNT_MISMATCH,
    BLOCKER_LEDGER_MISMATCH,
    BLOCKER_TRANSFER_MISSING,
    BLOCKER_UNLINKED_EVENT,
    _attr,
    latest_tigerbeetle_reconciliation_payload,
    reconcile_tigerbeetle_transfers,
)


class FailingLookupClient(FakeTigerBeetleClient):
    def lookup_transfers(self, ids: list[int]) -> list[object]:
        raise RuntimeError("lookup failed")


def _settings() -> Settings:
    return Settings(TORGHUT_TIGERBEETLE_ENABLED=True)


def _add_ref(
    session: Session,
    *,
    transfer_id: str = "1001",
    amount: Decimal = Decimal("190250000"),
    payload_json: dict[str, object] | None = None,
) -> None:
    session.add(
        TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id=transfer_id,
            transfer_kind="fill_post",
            ledger=LEDGER_USD_MICRO,
            code=TRANSFER_CODE_FILL_POST,
            amount=amount,
            status="created",
            event_fingerprint=f"fingerprint-{transfer_id}",
            payload_json=payload_json,
        )
    )
    session.flush()


def _transfer(
    *, transfer_id: int = 1001, amount: int = 190250000
) -> TigerBeetleTransferSpec:
    return TigerBeetleTransferSpec(
        transfer_id=transfer_id,
        transfer_kind="fill_post",
        debit_account_id=11,
        credit_account_id=12,
        amount=amount,
        ledger=LEDGER_USD_MICRO,
        code=TRANSFER_CODE_FILL_POST,
    )


class TestTigerBeetleReconcile(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def test_reconciliation_passes_when_postgres_refs_match_tigerbeetle(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["blockers"], [])
            self.assertEqual(payload["checked_transfer_count"], 1)

    def test_reconciliation_blocks_missing_tigerbeetle_transfer(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_TRANSFER_MISSING, payload["blockers"])

    def test_reconciliation_blocks_amount_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer(amount=1)

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_AMOUNT_MISMATCH, payload["blockers"])

    def test_reconciliation_blocks_code_and_ledger_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = TigerBeetleTransferSpec(
                transfer_id=1001,
                transfer_kind="fill_post",
                debit_account_id=11,
                credit_account_id=12,
                amount=190250000,
                ledger=999,
                code=999,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_CODE_MISMATCH, payload["blockers"])
            self.assertIn(BLOCKER_LEDGER_MISMATCH, payload["blockers"])

    def test_reconciliation_blocks_account_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(
                session,
                payload_json={"debit_account_id": "11", "credit_account_id": "12"},
            )
            client = FakeTigerBeetleClient()
            client.transfers[1001] = TigerBeetleTransferSpec(
                transfer_id=1001,
                transfer_kind="fill_post",
                debit_account_id=99,
                credit_account_id=98,
                amount=190250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_FILL_POST,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_DEBIT_ACCOUNT_MISMATCH, payload["blockers"])
            self.assertIn(BLOCKER_CREDIT_ACCOUNT_MISMATCH, payload["blockers"])

    def test_reconciliation_blocks_unlinked_order_event(self) -> None:
        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="unlinked-fill",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=1,
                    alpaca_account_label="paper",
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("190.25"),
                    raw_event={"event": "fill"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_EVENT, payload["blockers"])

    def test_reconciliation_ignores_unjournalable_lifecycle_event(self) -> None:
        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="accepted-without-price",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=1,
                    alpaca_account_label="paper",
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    event_type="accepted",
                    status="accepted",
                    qty=Decimal("1"),
                    raw_event={"event": "accepted"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["unlinked_event_count"], 0)

    def test_reconciliation_blocks_client_unavailable(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FailingLookupClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_CLIENT_UNAVAILABLE, payload["blockers"])

    def test_latest_reconciliation_payload_normalizes_blockers(self) -> None:
        with Session(self.engine) as session:
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=2001,
                    started_at=datetime.now(timezone.utc),
                    finished_at=datetime.now(timezone.utc),
                    status="degraded",
                    checked_transfer_count=2,
                    missing_transfer_count=0,
                    mismatched_transfer_count=1,
                    payload_json={"blockers": [BLOCKER_CODE_MISMATCH, 7]},
                )
            )
            session.flush()

            payload = latest_tigerbeetle_reconciliation_payload(
                session,
                cluster_id=2001,
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["blockers"], [BLOCKER_CODE_MISMATCH, "7"])

    def test_attr_helper_supports_mapping_and_transfer_id_fallbacks(self) -> None:
        self.assertEqual(_attr({"transfer_id": 44}, "id"), 44)
        self.assertEqual(_attr(type("TransferId", (), {"transfer_id": 45})(), "id"), 45)
        with self.assertRaises(AttributeError):
            _attr(object(), "id")
