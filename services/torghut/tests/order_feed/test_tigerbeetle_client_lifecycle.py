from __future__ import annotations

from tests.order_feed.support import (
    FakeConsumer,
    FakeRecord,
    FakeTigerBeetleClient,
    OrderFeedIngestor,
    OrderFeedTestCase,
    Session,
    patch,
    settings,
)


class TestTigerBeetleClientLifecycle(OrderFeedTestCase):
    def test_order_feed_reuses_tigerbeetle_reconciliation_client(self) -> None:
        class CloseTrackingTigerBeetleClient(FakeTigerBeetleClient):
            def __init__(self) -> None:
                super().__init__()
                self.close_calls = 0

            def close(self) -> None:
                self.close_calls += 1

        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        reconciliation_client = CloseTrackingTigerBeetleClient()
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            self._seed_execution(session)
            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([record]),
                default_account_label="paper",
            )

            with patch(
                "app.trading.tigerbeetle_journal.ledger_journal.create_tigerbeetle_client",
                return_value=reconciliation_client,
            ) as create_client:
                ingestor.ingest_once(session)
                ingestor._reconcile_tigerbeetle_if_enabled(session)

            self.assertEqual(create_client.call_count, 1)
            self.assertEqual(reconciliation_client.close_calls, 0)
            ingestor.close()
            self.assertEqual(reconciliation_client.close_calls, 1)
            self.assertIsNone(ingestor._tigerbeetle_journal)
