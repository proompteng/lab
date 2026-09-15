from __future__ import annotations

from unittest.mock import MagicMock

from sqlalchemy.orm import Session

from app.trading.tigerbeetle_client import TigerBeetleClientTimeoutError
from app.trading.tigerbeetle_journal import TigerBeetleLedgerJournal

from tests.order_idempotency.support import (
    Decimal,
    Execution,
    FakeAlpacaClient,
    Reconciler,
    Strategy,
    TradeDecision,
    _TestOrderIdempotencyBase,
    patch,
    settings,
)


class TestReconcilerTigerBeetleClientLifecycle(_TestOrderIdempotencyBase):
    def setUp(self) -> None:
        super().setUp()
        self._orig_tigerbeetle_enabled = settings.tigerbeetle_enabled
        self._orig_tigerbeetle_journal_enabled = settings.tigerbeetle_journal_enabled
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

    def tearDown(self) -> None:
        settings.tigerbeetle_enabled = self._orig_tigerbeetle_enabled
        settings.tigerbeetle_journal_enabled = self._orig_tigerbeetle_journal_enabled
        super().tearDown()

    def _seed_open_execution(self, session: Session) -> None:
        strategy = Strategy(
            name="demo",
            description="demo",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        session.add(strategy)
        session.flush()
        decision = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json={"symbol": "AAPL"},
            status="submitted",
            decision_hash="decision-hash-reconcile",
        )
        session.add(decision)
        session.flush()
        session.add(
            Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="paper",
                alpaca_order_id="order-reconcile",
                client_order_id="decision-hash-reconcile",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="accepted",
                raw_order={"id": "order-reconcile"},
            )
        )
        session.commit()

    def test_reconciler_reuses_and_closes_tigerbeetle_journal(self) -> None:
        journal = MagicMock(spec=TigerBeetleLedgerJournal)
        reconciler = Reconciler()

        with self.session_local() as session:
            self._seed_open_execution(session)
            with (
                patch(
                    "app.trading.reconcile.TigerBeetleLedgerJournal",
                    return_value=journal,
                ) as journal_factory,
                patch(
                    "app.trading.reconcile.upsert_execution_tca_metric"
                ) as upsert_tca,
            ):
                reconciler.reconcile(session, FakeAlpacaClient())
                reconciler.reconcile(session, FakeAlpacaClient())

        self.assertEqual(journal_factory.call_count, 1)
        self.assertEqual(upsert_tca.call_count, 2)
        self.assertTrue(
            all(
                call.kwargs["tigerbeetle_journal"] is journal
                for call in upsert_tca.call_args_list
            )
        )
        reconciler.close()
        journal.close.assert_called_once_with()
        self.assertIsNone(reconciler._tigerbeetle_journal)

    def test_reconciler_replaces_journal_after_tigerbeetle_timeout(self) -> None:
        timed_out_journal = MagicMock(spec=TigerBeetleLedgerJournal)
        replacement_journal = MagicMock(spec=TigerBeetleLedgerJournal)
        reconciler = Reconciler()
        upsert_calls = 0

        def upsert_with_first_timeout(*args, **kwargs) -> None:
            nonlocal upsert_calls
            del args
            upsert_calls += 1
            if upsert_calls == 1:
                kwargs["on_tigerbeetle_journal_error"](
                    TigerBeetleClientTimeoutError(
                        "tigerbeetle_create_accounts_timeout:10.000s"
                    )
                )

        with self.session_local() as session:
            self._seed_open_execution(session)
            with (
                patch(
                    "app.trading.reconcile.TigerBeetleLedgerJournal",
                    side_effect=[timed_out_journal, replacement_journal],
                ) as journal_factory,
                patch(
                    "app.trading.reconcile.upsert_execution_tca_metric",
                    side_effect=upsert_with_first_timeout,
                ),
            ):
                reconciler.reconcile(session, FakeAlpacaClient())
                reconciler.reconcile(session, FakeAlpacaClient())

        self.assertEqual(journal_factory.call_count, 2)
        timed_out_journal.close.assert_called_once_with()
        self.assertIs(reconciler._tigerbeetle_journal, replacement_journal)
        reconciler.close()
        replacement_journal.close.assert_called_once_with()
