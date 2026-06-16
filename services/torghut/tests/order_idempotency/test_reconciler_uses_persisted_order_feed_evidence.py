from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.order_idempotency.support import (
    Decimal,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    FakeAlpacaClient,
    Reconciler,
    Strategy,
    TradeDecision,
    _TestOrderIdempotencyBase,
    datetime,
    select,
    timezone,
)


class TestReconcilerUsesPersistedOrderFeedEvidence(_TestOrderIdempotencyBase):
    def test_reconciler_uses_persisted_order_feed_evidence(self) -> None:
        class FailingOrderFetchClient(FakeAlpacaClient):
            def get_order(self, alpaca_order_id: str) -> dict[str, str]:
                raise AssertionError(f"should_not_fetch_order:{alpaca_order_id}")

        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL"},
                rationale=None,
                status="submitted",
                decision_hash="decision-hash-4",
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            execution = Execution(
                trade_decision_id=decision_row.id,
                alpaca_order_id="order-4",
                client_order_id="decision-hash-4",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="accepted",
                raw_order={"id": "order-4"},
            )
            session.add(execution)
            session.commit()
            session.refresh(execution)

            event = ExecutionOrderEvent(
                event_fingerprint="feed-event-4",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=4,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                feed_seq=100,
                symbol="AAPL",
                alpaca_order_id="order-4",
                client_order_id="decision-hash-4",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("189.55"),
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=decision_row.id,
            )
            session.add(event)
            session.commit()

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, FailingOrderFetchClient())

            self.assertEqual(updates, 1)
            refreshed_execution = session.get(Execution, execution.id)
            assert refreshed_execution is not None
            self.assertEqual(refreshed_execution.status, "filled")
            self.assertEqual(refreshed_execution.filled_qty, Decimal("1"))

    def test_reconciler_backfill_records_tca_metrics(self) -> None:
        class FilledOrderAlpacaClient(FakeAlpacaClient):
            last_route = "alpaca"

            def get_order_by_client_order_id(
                self, client_order_id: str
            ) -> dict[str, str] | None:
                return {
                    "id": "order-4",
                    "client_order_id": client_order_id,
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "2",
                    "filled_qty": "2",
                    "filled_avg_price": "101",
                    "status": "filled",
                }

        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL", "params": {"price": "100"}},
                rationale=None,
                status="planned",
                decision_hash="decision-hash-4",
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, FilledOrderAlpacaClient())
            self.assertEqual(updates, 1)

            tca_rows = session.execute(select(ExecutionTCAMetric)).scalars().all()
            self.assertEqual(len(tca_rows), 1)
            tca = tca_rows[0]
            self.assertEqual(tca.symbol, "AAPL")
            self.assertEqual(tca.arrival_price, Decimal("100"))
            self.assertEqual(tca.avg_fill_price, Decimal("101"))
            self.assertEqual(tca.filled_qty, Decimal("2"))
            self.assertEqual(tca.slippage_bps, Decimal("100"))
            self.assertEqual(tca.shortfall_notional, Decimal("2"))
