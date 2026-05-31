from __future__ import annotations

import sys
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    Strategy,
    TigerBeetleTransferRef,
    TradeDecision,
)
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_journal import (
    TigerBeetleLedgerJournal,
    _account_specs,
    _event_amount_usd,
    _lookup_payload_decimal,
    _result_status,
    _transfer_attr,
    _transfer_flag,
    _transfer_spec,
    event_transfer_id,
)
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TRANSFER_KIND_CANCEL_VOID,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_SUBMITTED_PENDING,
    TigerBeetleTransferSpec,
    decimal_usd_to_micros,
)


def _settings(*, enabled: bool = True, journal_enabled: bool = True) -> Settings:
    return Settings(
        TORGHUT_TIGERBEETLE_ENABLED=enabled,
        TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=journal_enabled,
    )


def _create_fill_event(
    session: Session, *, fingerprint: str = "fingerprint-1"
) -> ExecutionOrderEvent:
    strategy = Strategy(
        name=f"demo-{fingerprint}",
        description="demo strat",
        enabled=True,
        base_timeframe="1Min",
        universe_type="symbols_list",
        universe_symbols=["AAPL"],
    )
    session.add(strategy)
    session.flush()

    decision = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label="paper",
        symbol="AAPL",
        timeframe="1Min",
        decision_json={"side": "buy"},
        decision_hash=f"decision-{fingerprint}",
    )
    session.add(decision)
    session.flush()

    execution = Execution(
        trade_decision_id=decision.id,
        alpaca_account_label="paper",
        alpaca_order_id=f"order-{fingerprint}",
        client_order_id=f"client-{fingerprint}",
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("1"),
        avg_fill_price=Decimal("190.25"),
        status="filled",
        raw_order={"id": f"order-{fingerprint}"},
    )
    session.add(execution)
    session.flush()

    event = ExecutionOrderEvent(
        event_fingerprint=fingerprint,
        source_topic="torghut.trade-updates.v1",
        source_partition=0,
        source_offset=sum(ord(ch) for ch in fingerprint),
        alpaca_account_label="paper",
        event_ts=datetime.now(timezone.utc),
        symbol="AAPL",
        alpaca_order_id=execution.alpaca_order_id,
        client_order_id=execution.client_order_id,
        event_type="fill",
        status="filled",
        qty=Decimal("1"),
        filled_qty=Decimal("1"),
        avg_fill_price=Decimal("190.25"),
        raw_event={"event": "fill"},
        execution_id=execution.id,
        trade_decision_id=decision.id,
    )
    session.add(event)
    session.flush()
    return event


class TestTigerBeetleLedgerJournal(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def test_disabled_journal_is_noop(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session)
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNone(ref)
            self.assertEqual(client.transfers, {})

    def test_repeated_same_event_creates_one_transfer_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session)
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            first = journal.journal_order_event(session, event)
            second = journal.journal_order_event(session, event)

            self.assertIsNotNone(first)
            self.assertEqual(first, second)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 1)
            self.assertEqual(refs[0].amount, Decimal("190250000"))
            self.assertEqual(refs[0].ledger, LEDGER_USD_MICRO)
            self.assertEqual(len(client.transfers), 1)

    def test_duplicate_transfer_exists_is_verified_before_ref_persist(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-exists")
            client = FakeTigerBeetleClient()
            amount = decimal_usd_to_micros(
                _event_amount_usd(event, TRANSFER_KIND_FILL_POST) or Decimal("0")
            )
            accounts = {spec.account_key: spec for spec in _account_specs(event)}
            expected = _transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                amount=amount,
                accounts=accounts,
            )
            client.transfers[expected.transfer_id] = expected

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNotNone(ref)
            self.assertEqual(ref.status, "exists")
            self.assertEqual(ref.transfer_id, str(expected.transfer_id))

    def test_duplicate_transfer_conflict_fails_hard(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-conflict")
            client = FakeTigerBeetleClient()
            transfer_id = event_transfer_id(event, TRANSFER_KIND_FILL_POST)
            client.transfers[transfer_id] = TigerBeetleTransferSpec(
                transfer_id=transfer_id,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                debit_account_id=1,
                credit_account_id=2,
                amount=99,
                ledger=LEDGER_USD_MICRO,
                code=2001,
            )

            with self.assertRaisesRegex(
                RuntimeError, "tigerbeetle_duplicate_transfer_conflict"
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=client
                ).journal_order_event(
                    session,
                    event,
                )

    def test_helper_edge_paths_are_deterministic(self) -> None:
        self.assertEqual(
            _result_status(SimpleNamespace(status="Result.CREATED")), "created"
        )
        self.assertEqual(_transfer_attr({"transfer_id": 123}, "id"), 123)
        self.assertEqual(_transfer_attr(SimpleNamespace(transfer_id=456), "id"), 456)
        with self.assertRaises(AttributeError):
            _transfer_attr(object(), "id")
        self.assertIsNone(_lookup_payload_decimal({"amount": "bad"}, ("amount",)))

    def test_event_amount_uses_notional_and_payload_fallbacks(self) -> None:
        notional_event = ExecutionOrderEvent(
            event_fingerprint="amount-notional",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"notional": "-12.34"},
        )
        self.assertEqual(
            _event_amount_usd(notional_event, TRANSFER_KIND_FILL_POST),
            Decimal("12.34"),
        )

        raw_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-raw",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"notional": "bad", "qty": "2", "price": "10"},
        )
        self.assertEqual(
            _event_amount_usd(raw_payload_event, TRANSFER_KIND_FILL_POST),
            Decimal("20"),
        )

        nested_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-nested",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="submitted",
            status="submitted",
            qty=Decimal("3"),
            raw_event={"order": {"price": "11"}},
        )
        self.assertEqual(
            _event_amount_usd(nested_payload_event, TRANSFER_KIND_SUBMITTED_PENDING),
            Decimal("33"),
        )

        missing_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-missing",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"event": "fill"},
        )
        self.assertIsNone(
            _event_amount_usd(missing_payload_event, TRANSFER_KIND_FILL_POST)
        )

    def test_transfer_specs_cover_pending_and_void_paths(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-submitted")
            accounts = {spec.account_key: spec for spec in _account_specs(event)}

            submitted = _transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                amount=100,
                accounts=accounts,
            )
            canceled = _transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_CANCEL_VOID,
                amount=100,
                accounts=accounts,
            )

        self.assertEqual(submitted.transfer_kind, TRANSFER_KIND_SUBMITTED_PENDING)
        self.assertEqual(canceled.transfer_kind, TRANSFER_KIND_CANCEL_VOID)
        self.assertNotEqual(canceled.pending_id, 0)

    def test_transfer_flag_handles_missing_module_and_missing_flags(self) -> None:
        with patch.dict(sys.modules, {"tigerbeetle": None}):
            self.assertEqual(_transfer_flag("PENDING"), 0)
        with patch.dict(sys.modules, {"tigerbeetle": SimpleNamespace()}):
            self.assertEqual(_transfer_flag("PENDING"), 0)
        self.assertEqual(_transfer_flag("DOES_NOT_EXIST"), 0)

    def test_journal_reuses_existing_account_refs_for_distinct_events(self) -> None:
        with Session(self.engine) as session:
            first = _create_fill_event(session, fingerprint="fingerprint-ref-1")
            second = _create_fill_event(session, fingerprint="fingerprint-ref-2")
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            journal.journal_order_event(session, first)
            journal.journal_order_event(session, second)

            cash_refs = [
                ref
                for ref in client.accounts.values()
                if getattr(ref, "account_key", "") == "cash:paper:usd"
            ]
            self.assertEqual(len(cash_refs), 1)

    def test_journal_ignores_non_transfer_and_missing_amount_events(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-non-transfer")
            event.event_type = "trade_update"
            event.status = "pending_replace"
            event.raw_event = {"event": "pending_replace"}

            self.assertIsNone(
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_order_event(session, event)
            )

            missing = _create_fill_event(session, fingerprint="fingerprint-missing")
            missing.raw_event = {"event": "fill"}
            missing.qty = None
            missing.filled_qty = None
            missing.avg_fill_price = None

            self.assertIsNone(
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_order_event(session, missing)
            )

    def test_journal_fails_on_create_transfer_error_status(self) -> None:
        class ErrorTransferClient(FakeTigerBeetleClient):
            def create_transfers(self, transfers: list[object]) -> list[object]:
                return [{"status": "limit_exceeded"}]

        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-error-status")

            with self.assertRaisesRegex(
                RuntimeError, "tigerbeetle_create_transfer_failed:limit_exceeded"
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(),
                    client=ErrorTransferClient(),
                ).journal_order_event(session, event)
