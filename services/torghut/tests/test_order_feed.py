from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from unittest import TestCase
from unittest.mock import patch

from kafka import TopicPartition

from app.config import settings
from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    OrderFeedConsumerCursor,
    OrderFeedSourceWindow,
    RejectedSignalOutcomeEvent,
    Strategy,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
    TradeDecision,
)
from app.trading import order_feed as order_feed_module
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
)
from app.trading.tigerbeetle_ledger_model import (
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_FILL_POST,
)
from app.trading.order_feed import (
    EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION,
    HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
    ORDER_FEED_SOURCE_REVISION,
    NormalizedOrderEvent,
    OrderFeedIngestor,
    apply_order_event_to_execution,
    backfill_order_feed_events_from_executions,
    backfill_order_feed_source_windows,
    latest_order_event_for_execution,
    link_order_events_to_execution,
    merge_execution_raw_order_update,
    normalize_order_feed_record,
    persist_order_event,
    repair_order_feed_execution_links,
    repair_order_feed_fill_deltas,
)


@dataclass
class FakeRecord:
    value: bytes
    topic: str = "torghut.trade-updates.v1"
    partition: int = 0
    offset: int = 0
    broker_high_watermark: int | None = None


class FakeConsumer:
    def __init__(self, records: list[FakeRecord]) -> None:
        self._records = records
        self.commit_calls = 0

    def poll(self, *, timeout_ms: int, max_records: int):
        del timeout_ms
        batch = self._records[:max_records]
        self._records = self._records[max_records:]
        if not batch:
            return {}
        return {("topic", 0): batch}

    def commit(self):
        self.commit_calls += 1

    def close(self):
        return None


class FakeManualConsumer(FakeConsumer):
    def __init__(
        self, records: list[FakeRecord], *, partitions: dict[str, set[int]]
    ) -> None:
        super().__init__(records)
        self._partitions = partitions
        self.assigned: list[TopicPartition] = []
        self.seek_calls: list[tuple[TopicPartition, int]] = []
        self.seek_to_beginning_calls: list[tuple[TopicPartition, ...]] = []
        self.seek_to_end_calls: list[tuple[TopicPartition, ...]] = []

    def partitions_for_topic(self, topic: str) -> set[int] | None:
        return self._partitions.get(topic)

    def assign(self, partitions: list[TopicPartition]) -> None:
        self.assigned = partitions

    def seek(self, partition: TopicPartition, offset: int) -> None:
        self.seek_calls.append((partition, offset))

    def seek_to_beginning(self, *partitions: TopicPartition) -> None:
        self.seek_to_beginning_calls.append(partitions)

    def seek_to_end(self, *partitions: TopicPartition) -> None:
        self.seek_to_end_calls.append(partitions)


class FakeManualConsumerWithoutEndSeek(FakeConsumer):
    def __init__(
        self, records: list[FakeRecord], *, partitions: dict[str, set[int]]
    ) -> None:
        super().__init__(records)
        self._partitions = partitions
        self.assigned: list[TopicPartition] = []
        self.seek_calls: list[tuple[TopicPartition, int]] = []

    def partitions_for_topic(self, topic: str) -> set[int] | None:
        return self._partitions.get(topic)

    def assign(self, partitions: list[TopicPartition]) -> None:
        self.assigned = partitions

    def seek(self, partition: TopicPartition, offset: int) -> None:
        self.seek_calls.append((partition, offset))


class TestOrderFeed(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

        self._orig_feed_enabled = settings.trading_order_feed_enabled
        self._orig_bootstrap = settings.trading_order_feed_bootstrap_servers
        self._orig_topic = settings.trading_order_feed_topic
        self._orig_topic_v2 = settings.trading_order_feed_topic_v2
        self._orig_group_id = settings.trading_order_feed_group_id
        self._orig_client_id = settings.trading_order_feed_client_id
        self._orig_assignment_mode = settings.trading_order_feed_assignment_mode
        self._orig_auto_offset_reset = settings.trading_order_feed_auto_offset_reset
        self._orig_tigerbeetle_enabled = settings.tigerbeetle_enabled
        self._orig_tigerbeetle_journal_enabled = settings.tigerbeetle_journal_enabled
        self._orig_tigerbeetle_required = settings.tigerbeetle_required
        self._orig_tigerbeetle_reconcile_required = (
            settings.tigerbeetle_reconcile_required
        )
        settings.trading_order_feed_enabled = True
        settings.trading_order_feed_bootstrap_servers = "localhost:9092"
        settings.trading_order_feed_topic = "torghut.trade-updates.v1"
        settings.trading_order_feed_topic_v2 = None
        settings.trading_order_feed_assignment_mode = "group"
        settings.trading_order_feed_auto_offset_reset = "latest"
        settings.tigerbeetle_enabled = False
        settings.tigerbeetle_journal_enabled = False
        settings.tigerbeetle_required = False
        settings.tigerbeetle_reconcile_required = False

    def tearDown(self) -> None:
        settings.trading_order_feed_enabled = self._orig_feed_enabled
        settings.trading_order_feed_bootstrap_servers = self._orig_bootstrap
        settings.trading_order_feed_topic = self._orig_topic
        settings.trading_order_feed_topic_v2 = self._orig_topic_v2
        settings.trading_order_feed_group_id = self._orig_group_id
        settings.trading_order_feed_client_id = self._orig_client_id
        settings.trading_order_feed_assignment_mode = self._orig_assignment_mode
        settings.trading_order_feed_auto_offset_reset = self._orig_auto_offset_reset
        settings.tigerbeetle_enabled = self._orig_tigerbeetle_enabled
        settings.tigerbeetle_journal_enabled = self._orig_tigerbeetle_journal_enabled
        settings.tigerbeetle_required = self._orig_tigerbeetle_required
        settings.tigerbeetle_reconcile_required = (
            self._orig_tigerbeetle_reconcile_required
        )

    def _seed_execution(
        self,
        session: Session,
        *,
        account_label: str = "paper",
        order_id: str = "order-1",
        client_order_id: str = "client-1",
    ) -> Execution:
        strategy = Strategy(
            name="demo",
            description="demo",
            enabled=True,
            base_timeframe="1Min",
            universe_type="symbols_list",
            universe_symbols=["AAPL"],
        )
        session.add(strategy)
        session.flush()

        decision = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label=account_label,
            symbol="AAPL",
            timeframe="1Min",
            decision_json={"side": "buy"},
            decision_hash=client_order_id,
            status="submitted",
        )
        session.add(decision)
        session.flush()

        execution = Execution(
            trade_decision_id=decision.id,
            alpaca_account_label=account_label,
            alpaca_order_id=order_id,
            client_order_id=client_order_id,
            symbol="AAPL",
            side="buy",
            order_type="limit",
            time_in_force="day",
            submitted_qty=Decimal("1"),
            filled_qty=Decimal("0"),
            status="new",
            raw_order={"id": "order-1"},
            last_update_at=datetime.now(timezone.utc),
        )
        session.add(execution)
        session.commit()
        session.refresh(execution)
        return execution

    def test_runtime_symbol_columns_allow_occ_option_contracts(self) -> None:
        for model in (
            TradeDecision,
            Execution,
            ExecutionOrderEvent,
            RejectedSignalOutcomeEvent,
            ExecutionTCAMetric,
        ):
            symbol_column = model.__table__.c.symbol
            self.assertEqual(
                symbol_column.type.length,
                64,
                f"{model.__tablename__}.symbol must support OCC option symbols",
            )

    def test_option_order_feed_symbol_persists_full_occ_symbol(self) -> None:
        option_symbol = "AMZN260529P00270000"
        self.assertGreater(len(option_symbol), 16)
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"option-order-1","client_order_id":"option-client-1",'
            b'"symbol":"AMZN260529P00270000","status":"filled","qty":"1","filled_qty":"1",'
            b'"filled_avg_price":"2.15"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=55)

        with Session(self.engine) as session:
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            self.assertEqual(normalized.event.symbol, option_symbol)

            persisted, is_duplicate = persist_order_event(session, normalized.event)
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertEqual(persisted.symbol, option_symbol)

    def test_cross_account_order_feed_normalization_defaults_do_not_crosstalk(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-shared","client_order_id":"client-shared","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)

        with Session(self.engine) as session:
            paper_a = self._seed_execution(
                session,
                account_label="paper-a",
                order_id="order-shared",
                client_order_id="client-shared",
            )
            paper_b = self._seed_execution(
                session,
                account_label="paper-b",
                order_id="order-2",
                client_order_id="client-b",
            )

            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper-b",
            )
            assert normalized.event is not None

            persisted, is_duplicate = persist_order_event(session, normalized.event)
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertEqual(persisted.alpaca_account_label, "paper-b")
            self.assertIsNone(persisted.execution_id)
            self.assertEqual(paper_a.status, "new")
            self.assertEqual(paper_b.status, "new")

    def test_unrelated_account_order_feed_event_stays_unlinked_from_hpairs_decision(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","account_label":"UNRELATED_ACCOUNT",'
            b'"payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"hpairs-order-1","client_order_id":"hpairs-client-1",'
            b'"symbol":"AAPL","status":"filled","qty":"1","filled_qty":"1",'
            b'"filled_avg_price":"190.2","alpaca_account_label":"UNRELATED_ACCOUNT"}},'
            b'"seq":11}'
        )
        record = FakeRecord(value=payload, offset=23)

        with Session(self.engine) as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="H-PAIRS paper collection",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add(strategy)
            session.flush()
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json={
                        "params": {
                            "hypothesis_id": "H-PAIRS-01",
                            "source_decision_mode": "route_acquisition",
                        }
                    },
                    decision_hash="hpairs-client-1",
                    status="submitted",
                )
            )
            session.commit()

            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="TORGHUT_SIM",
            )
            assert normalized.event is not None
            persisted, is_duplicate = persist_order_event(session, normalized.event)
            session.commit()
            persisted_account_label = persisted.alpaca_account_label
            persisted_execution_id = persisted.execution_id
            persisted_trade_decision_id = persisted.trade_decision_id

        self.assertFalse(is_duplicate)
        self.assertEqual(persisted_account_label, "UNRELATED_ACCOUNT")
        self.assertIsNone(persisted_execution_id)
        self.assertIsNone(persisted_trade_decision_id)

    def test_cross_account_ingest_default_account_does_not_update_wrong_execution(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-shared","client_order_id":"client-shared","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        fake_payload_record = FakeRecord(value=payload, offset=22)

        with Session(self.engine) as session:
            self._seed_execution(
                session,
                account_label="paper-a",
                order_id="order-shared",
                client_order_id="client-shared",
            )
            self._seed_execution(
                session,
                account_label="paper-b",
                order_id="order-shared-b",
                client_order_id="client-shared-b",
            )

            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([fake_payload_record]),
                default_account_label="paper-b",
            )
            counters = ingestor.ingest_once(session)
            self.assertEqual(counters["messages_total"], 1)
            self.assertEqual(counters["events_persisted_total"], 1)
            self.assertEqual(counters["apply_updates_total"], 0)
            self.assertEqual(counters["duplicates_total"], 0)

            paper_a = session.execute(
                select(Execution).where(
                    Execution.alpaca_account_label == "paper-a",
                    Execution.alpaca_order_id == "order-shared",
                )
            ).scalar_one()
            paper_b = session.execute(
                select(Execution).where(
                    Execution.alpaca_account_label == "paper-b",
                    Execution.alpaca_order_id == "order-shared-b",
                )
            ).scalar_one()
            self.assertEqual(paper_a.status, "new")
            self.assertEqual(paper_b.status, "new")

            events = session.execute(select(ExecutionOrderEvent)).scalars().all()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].alpaca_account_label, "paper-b")

    def test_persist_order_event_journals_tigerbeetle_ref_when_enabled(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        client = FakeTigerBeetleClient()
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None

            with patch(
                "app.trading.tigerbeetle_journal.create_tigerbeetle_client",
                return_value=client,
            ):
                persisted, is_duplicate = persist_order_event(
                    session,
                    normalized.event,
                )
                duplicate_row, duplicate = persist_order_event(
                    session,
                    normalized.event,
                )
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertTrue(duplicate)
            self.assertEqual(duplicate_row.id, persisted.id)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 1)
            self.assertEqual(refs[0].execution_order_event_id, persisted.id)
            self.assertEqual(refs[0].amount, Decimal("190250000"))

    def test_order_feed_ingest_persists_tigerbeetle_reconciliation(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        client = FakeTigerBeetleClient()
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            self._seed_execution(session)
            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([record]),
                default_account_label="paper",
            )

            with (
                patch(
                    "app.trading.tigerbeetle_journal.create_tigerbeetle_client",
                    return_value=client,
                ),
                patch(
                    "app.trading.tigerbeetle_reconcile.create_tigerbeetle_client",
                    return_value=client,
                ),
            ):
                counters = ingestor.ingest_once(session)

            self.assertEqual(counters["events_persisted_total"], 1)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 2)
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            refs_by_kind = {ref.transfer_kind: ref for ref in refs}
            self.assertEqual(
                set(refs_by_kind),
                {TRANSFER_KIND_FILL_POST, TRANSFER_KIND_EXECUTION_FILL},
            )
            order_ref = refs_by_kind[TRANSFER_KIND_FILL_POST]
            self.assertEqual(order_ref.execution_order_event_id, event.id)
            self.assertEqual(order_ref.source_type, SOURCE_TYPE_EXECUTION_ORDER_EVENT)
            self.assertEqual(order_ref.source_id, str(event.id))
            execution_ref = refs_by_kind[TRANSFER_KIND_EXECUTION_FILL]
            self.assertEqual(execution_ref.execution_id, event.execution_id)
            self.assertEqual(execution_ref.source_type, SOURCE_TYPE_EXECUTION)
            self.assertEqual(execution_ref.source_id, str(event.execution_id))
            runs = session.execute(select(TigerBeetleReconciliationRun)).scalars().all()
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0].status, "ok")

    def test_order_feed_reconciliation_failure_respects_required_flag(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            ingestor = OrderFeedIngestor(
                consumer_factory=lambda: FakeConsumer([]),
                default_account_label="paper",
            )
            with patch(
                "app.trading.order_feed.reconcile_tigerbeetle_transfers",
                side_effect=RuntimeError("reconcile failed"),
            ):
                with self.assertLogs(order_feed_module.logger, level="WARNING"):
                    ingestor._reconcile_tigerbeetle_if_enabled(session)

                settings.tigerbeetle_reconcile_required = True
                with self.assertRaisesRegex(RuntimeError, "reconcile failed"):
                    ingestor._reconcile_tigerbeetle_if_enabled(session)

    def test_optional_tigerbeetle_journal_failure_does_not_drop_order_event(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True
        settings.tigerbeetle_required = False

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None

            with patch(
                "app.trading.tigerbeetle_journal.create_tigerbeetle_client",
                side_effect=RuntimeError("tb unavailable"),
            ):
                persisted, is_duplicate = persist_order_event(
                    session,
                    normalized.event,
                )
            session.commit()

            self.assertFalse(is_duplicate)
            self.assertIsNotNone(persisted.id)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(refs, [])

    def test_required_tigerbeetle_journal_failure_blocks_order_event(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.25"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=22)
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True
        settings.tigerbeetle_required = True

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None

            with patch(
                "app.trading.tigerbeetle_journal.create_tigerbeetle_client",
                side_effect=RuntimeError("tb unavailable"),
            ):
                with self.assertRaisesRegex(RuntimeError, "tb unavailable"):
                    persist_order_event(session, normalized.event)
            session.rollback()
            self.assertEqual(
                session.execute(select(ExecutionOrderEvent)).scalars().all(),
                [],
            )
            self.assertEqual(
                session.execute(select(TigerBeetleTransferRef)).scalars().all(),
                [],
            )

    def test_duplicate_event_is_idempotent(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=12)

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            self.assertEqual(normalized.event.alpaca_account_label, "paper")

            first, first_dup = persist_order_event(session, normalized.event)
            second, second_dup = persist_order_event(session, normalized.event)
            session.commit()

            self.assertFalse(first_dup)
            self.assertTrue(second_dup)
            self.assertEqual(first.id, second.id)
            rows = session.execute(select(ExecutionOrderEvent)).scalars().all()
            self.assertEqual(len(rows), 1)

    def test_ingestor_counts_duplicate_events(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=12)
        consumer = FakeConsumer([record, record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            rows = session.execute(select(ExecutionOrderEvent)).scalars().all()

        self.assertEqual(counters["messages_total"], 2)
        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["duplicates_total"], 1)
        self.assertEqual(len(rows), 1)

    def test_latest_order_event_for_execution_ignores_unrelated_same_account_event(
        self,
    ) -> None:
        own_payload = (
            b'{"channel":"trade_updates","payload":{"event":"accepted","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"accepted",'
            b'"qty":"1","filled_qty":"0"}},"seq":10}'
        )
        unrelated_payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:05:00Z",'
            b'"order":{"id":"order-2","client_order_id":"client-2","symbol":"MSFT","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"405.0"}},"seq":11}'
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            for payload, offset in ((own_payload, 1), (unrelated_payload, 2)):
                normalized = normalize_order_feed_record(
                    FakeRecord(value=payload, offset=offset),
                    default_topic="torghut.trade-updates.v1",
                    default_account_label="paper",
                )
                assert normalized.event is not None
                persist_order_event(session, normalized.event)
            session.commit()

            latest = latest_order_event_for_execution(session, execution)

        self.assertIsNotNone(latest)
        assert latest is not None
        self.assertEqual(latest.alpaca_order_id, "order-1")
        self.assertEqual(latest.client_order_id, "client-1")

    def test_out_of_order_event_does_not_regress_execution(self) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.order_feed_last_seq = 30
            execution.order_feed_last_event_ts = datetime.now(timezone.utc)
            execution.status = "filled"
            execution.filled_qty = Decimal("1")
            session.add(execution)
            session.commit()

            stale = ExecutionOrderEvent(
                event_fingerprint="stale-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=99,
                alpaca_account_label="paper",
                feed_seq=12,
                event_ts=execution.order_feed_last_event_ts - timedelta(seconds=10),
                symbol="AAPL",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                event_type="partial_fill",
                status="partially_filled",
                qty=Decimal("1"),
                filled_qty=Decimal("0.5"),
                avg_fill_price=Decimal("190.0"),
                raw_event={"event": "partial_fill"},
                execution_id=execution.id,
            )
            session.add(stale)
            session.flush()

            updated, out_of_order = apply_order_event_to_execution(execution, stale)
            self.assertFalse(updated)
            self.assertTrue(out_of_order)
            self.assertEqual(execution.status, "filled")
            self.assertEqual(execution.filled_qty, Decimal("1"))

    def test_order_feed_update_preserves_submit_audit_and_cost_metadata(self) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.raw_order = {
                "id": "order-1",
                "status": "accepted",
                "_execution_audit": {
                    "execution_policy_hash": "policy-sha",
                    "lineage_hash": "lineage-sha",
                },
                "runtime_ledger_cost": {
                    "cost_amount": "0.20",
                    "cost_basis": "modeled_paper_cost_budget",
                },
                "cost_amount": "0.20",
                "cost_basis": "modeled_paper_cost_budget",
                "execution_policy": {"max_order_notional": "1000"},
            }
            event = ExecutionOrderEvent(
                event_fingerprint="fill-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=101,
                alpaca_account_label="paper",
                feed_seq=31,
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.2"),
                raw_event={
                    "event": "fill",
                    "order": {
                        "id": "order-1",
                        "status": "filled",
                        "filled_qty": "1",
                        "filled_avg_price": "190.2",
                    },
                },
                execution_id=execution.id,
            )
            session.add(event)
            session.flush()

            updated, out_of_order = apply_order_event_to_execution(execution, event)

            self.assertTrue(updated)
            self.assertFalse(out_of_order)
            assert isinstance(execution.raw_order, dict)
            self.assertEqual(
                execution.raw_order["_execution_audit"]["execution_policy_hash"],
                "policy-sha",
            )
            self.assertEqual(
                execution.raw_order["runtime_ledger_cost"]["cost_basis"],
                "modeled_paper_cost_budget",
            )
            self.assertEqual(execution.raw_order["cost_amount"], "0.20")
            self.assertEqual(execution.raw_order["status"], "accepted")
            self.assertEqual(
                execution.raw_order["_order_feed_last_event"]["order"]["status"],
                "filled",
            )

    def test_merge_execution_raw_order_update_preserves_existing_keys(self) -> None:
        merged = merge_execution_raw_order_update(
            {
                "id": "order-1",
                "status": "accepted",
                "cost_amount": "0.20",
            },
            {"status": "filled", "filled_qty": "1"},
            update_key="_broker_reconcile_last_order",
        )

        self.assertIsInstance(merged, dict)
        assert isinstance(merged, dict)
        self.assertEqual(merged["status"], "accepted")
        self.assertEqual(merged["cost_amount"], "0.20")
        self.assertEqual(merged["filled_qty"], "1")
        self.assertEqual(merged["_broker_reconcile_last_order"]["status"], "filled")

    def test_ingestor_refreshes_tca_after_order_feed_fill_update(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":31}'
        )
        consumer = FakeConsumer([FakeRecord(value=payload, offset=101)])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            execution = self._seed_execution(session)

            with patch("app.trading.order_feed.upsert_execution_tca_metric") as upsert:
                counters = ingestor.ingest_once(session)
                session.refresh(execution)

            self.assertEqual(counters["events_persisted_total"], 1)
            self.assertEqual(counters["apply_updates_total"], 1)
            self.assertEqual(execution.status, "filled")
            upsert.assert_called_once()

    def test_ingestor_counts_out_of_order_updates(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"partial_fill","timestamp":"2026-02-01T09:59:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"partially_filled",'
            b'"qty":"1","filled_qty":"0.5","filled_avg_price":"190.0"}},"seq":12}'
        )
        consumer = FakeConsumer([FakeRecord(value=payload, offset=99)])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.order_feed_last_seq = 30
            execution.order_feed_last_event_ts = datetime(
                2026, 2, 1, 10, 0, tzinfo=timezone.utc
            )
            execution.status = "filled"
            execution.filled_qty = Decimal("1")
            session.add(execution)
            session.commit()

            counters = ingestor.ingest_once(session)
            session.refresh(execution)

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["out_of_order_total"], 1)
        self.assertEqual(counters["apply_updates_total"], 0)
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1"))

    def test_missing_identity_fields_are_dropped(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"symbol":"AAPL","status":"filled"}},"seq":11}'
        )
        record = FakeRecord(value=payload, offset=44)

        normalized = normalize_order_feed_record(
            record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper",
        )
        self.assertIsNone(normalized.event)
        self.assertEqual(normalized.drop_reason, "missing_order_identity")

    def test_v2_payload_uses_account_label_from_envelope(self) -> None:
        payload = (
            b'{"channel":"trade_updates","accountLabel":"paper-b","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"account_label":"paper-b","order":{"id":"order-9","client_order_id":"client-9","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10,"version":2}'
        )
        record = FakeRecord(value=payload, topic="torghut.trade-updates.v2", offset=12)

        normalized = normalize_order_feed_record(
            record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper-a",
        )
        assert normalized.event is not None
        self.assertEqual(normalized.event.alpaca_account_label, "paper-b")

    def test_payload_uses_order_level_alpaca_account_label(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-7","client_order_id":"client-7","symbol":"AAPL","status":"filled",'
            b'"alpaca_account_label":"paper-c","qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, topic="torghut.trade-updates.v1", offset=12)

        normalized = normalize_order_feed_record(
            record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper-a",
        )
        assert normalized.event is not None
        self.assertEqual(normalized.event.alpaca_account_label, "paper-c")

    def test_sim_broker_account_label_alias_links_to_torghut_sim_scope(
        self,
    ) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","account_label":"PA3SX7FYNUTF",'
                b'"payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"account_label":"PA3SX7FYNUTF",'
                b'"order":{"id":"sim-order-1","client_order_id":"sim-client-1",'
                b'"symbol":"AAPL","status":"filled","qty":"1","filled_qty":"1",'
                b'"filled_avg_price":"190.2","alpaca_account_label":"PA3SX7FYNUTF"}},'
                b'"seq":10}'
            ),
            offset=26,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(
            consumer_factory=lambda: consumer,
            default_account_label="TORGHUT_SIM",
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                account_label="TORGHUT_SIM",
                order_id="sim-order-1",
                client_order_id="sim-client-1",
            )
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id

            counters = ingestor.ingest_once(session)
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["out_of_scope_account_total"], 0)
        self.assertEqual(counters["apply_updates_total"], 1)
        self.assertEqual(event.alpaca_account_label, "TORGHUT_SIM")
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, trade_decision_id)
        self.assertEqual(
            event.raw_event["_torghut_account_label_alias"]["source_account_label"],
            "PA3SX7FYNUTF",
        )
        self.assertEqual(source_window.alpaca_account_label, "TORGHUT_SIM")
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(
            source_window.payload_json["account_label_alias"],
            {
                "source_account_label": "PA3SX7FYNUTF",
                "canonical_account_label": "TORGHUT_SIM",
                "basis": "matched_order_identity",
            },
        )

    def test_build_consumer_applies_kafka_security_kwargs(self) -> None:
        captured_kwargs: dict[str, object] = {}
        original_security_protocol = settings.trading_order_feed_security_protocol
        original_sasl_mechanism = settings.trading_order_feed_sasl_mechanism
        original_sasl_username = settings.trading_order_feed_sasl_username
        original_sasl_password = settings.trading_order_feed_sasl_password
        try:
            settings.trading_order_feed_security_protocol = "SASL_PLAINTEXT"
            settings.trading_order_feed_sasl_mechanism = "SCRAM-SHA-512"
            settings.trading_order_feed_sasl_username = "user"
            settings.trading_order_feed_sasl_password = "secret"

            class _FakeKafkaConsumer:
                def __init__(self, *topics: str, **kwargs: object) -> None:
                    captured_kwargs["topics"] = list(topics)
                    captured_kwargs.update(kwargs)

            with patch.dict(
                "sys.modules",
                {"kafka": SimpleNamespace(KafkaConsumer=_FakeKafkaConsumer)},
            ):
                OrderFeedIngestor._build_consumer()
        finally:
            settings.trading_order_feed_security_protocol = original_security_protocol
            settings.trading_order_feed_sasl_mechanism = original_sasl_mechanism
            settings.trading_order_feed_sasl_username = original_sasl_username
            settings.trading_order_feed_sasl_password = original_sasl_password

        self.assertEqual(captured_kwargs.get("security_protocol"), "SASL_PLAINTEXT")
        self.assertEqual(captured_kwargs.get("sasl_mechanism"), "SCRAM-SHA-512")
        self.assertEqual(captured_kwargs.get("sasl_plain_username"), "user")
        self.assertEqual(captured_kwargs.get("sasl_plain_password"), "secret")

    def test_build_consumer_group_mode_falls_back_to_client_id_group(self) -> None:
        captured_kwargs: dict[str, object] = {}
        original_group_id = settings.trading_order_feed_group_id
        original_client_id = settings.trading_order_feed_client_id
        original_assignment_mode = settings.trading_order_feed_assignment_mode
        try:
            settings.trading_order_feed_assignment_mode = "group"
            settings.trading_order_feed_group_id = " "
            settings.trading_order_feed_client_id = "paper-route-client"

            class _FakeKafkaConsumer:
                def __init__(self, *topics: str, **kwargs: object) -> None:
                    captured_kwargs["topics"] = list(topics)
                    captured_kwargs.update(kwargs)

            with patch.dict(
                "sys.modules",
                {"kafka": SimpleNamespace(KafkaConsumer=_FakeKafkaConsumer)},
            ):
                OrderFeedIngestor._build_consumer()
        finally:
            settings.trading_order_feed_group_id = original_group_id
            settings.trading_order_feed_client_id = original_client_id
            settings.trading_order_feed_assignment_mode = original_assignment_mode

        self.assertEqual(captured_kwargs.get("topics"), ["torghut.trade-updates.v1"])
        self.assertEqual(captured_kwargs.get("group_id"), "paper-route-client")

    def test_build_consumer_disables_group_subscription_for_manual_assignment(
        self,
    ) -> None:
        captured_kwargs: dict[str, object] = {}
        original_assignment_mode = settings.trading_order_feed_assignment_mode
        original_group_id = settings.trading_order_feed_group_id
        try:
            settings.trading_order_feed_assignment_mode = "manual"
            settings.trading_order_feed_group_id = "torghut-order-feed-sim-default"

            class _FakeKafkaConsumer:
                def __init__(self, *topics: str, **kwargs: object) -> None:
                    captured_kwargs["topics"] = list(topics)
                    captured_kwargs.update(kwargs)

            with patch.dict(
                "sys.modules",
                {"kafka": SimpleNamespace(KafkaConsumer=_FakeKafkaConsumer)},
            ):
                OrderFeedIngestor._build_consumer()
        finally:
            settings.trading_order_feed_assignment_mode = original_assignment_mode
            settings.trading_order_feed_group_id = original_group_id

        self.assertEqual(captured_kwargs.get("topics"), [])
        self.assertIsNone(captured_kwargs.get("group_id"))

    def test_ingest_counts_consumer_factory_failure(self) -> None:
        def fail_consumer() -> FakeConsumer:
            raise RuntimeError("boom")

        ingestor = OrderFeedIngestor(consumer_factory=fail_consumer)
        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["consumer_errors_total"], 1)

    def test_ingest_skips_when_bootstrap_servers_missing(self) -> None:
        settings.trading_order_feed_bootstrap_servers = ""
        ingestor = OrderFeedIngestor(consumer_factory=lambda: FakeConsumer([]))

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(counters["consumer_errors_total"], 0)

    def test_close_resets_cached_manual_consumer(self) -> None:
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)
        ingestor._consumer = consumer
        ingestor._manual_assignment_ready = True

        ingestor.close()

        self.assertIsNone(ingestor._consumer)
        self.assertFalse(ingestor._manual_assignment_ready)

    def test_existing_manual_consumer_gets_assigned_before_poll(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: FakeConsumer([]))
        ingestor._consumer = consumer
        ingestor._manual_assignment_ready = False

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(
            consumer.assigned, [TopicPartition("torghut.trade-updates.v1", 0)]
        )
        self.assertTrue(ingestor._manual_assignment_ready)

    def test_manual_assignment_resumes_after_persisted_offsets(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0, 1}},
        )

        with Session(self.engine) as session:
            existing = OrderFeedSourceWindow(
                consumer_group=settings.trading_order_feed_group_id,
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                start_offset=41,
                end_offset=41,
                consumed_count=1,
                status="inserted",
            )
            session.add(existing)
            session.commit()

            ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(
            consumer.assigned,
            [
                TopicPartition("torghut.trade-updates.v1", 0),
                TopicPartition("torghut.trade-updates.v1", 1),
            ],
        )
        self.assertEqual(
            consumer.seek_calls,
            [(TopicPartition("torghut.trade-updates.v1", 0), 42)],
        )
        self.assertEqual(
            consumer.seek_to_beginning_calls,
            [(TopicPartition("torghut.trade-updates.v1", 1),)],
        )
        self.assertEqual(consumer.seek_to_end_calls, [])

    def test_manual_assignment_prefers_consumer_cursor_over_event_rows(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        settings.trading_order_feed_group_id = "torghut-order-feed-v1"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )

        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="legacy-event",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=41,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    raw_event={"event": "fill"},
                )
            )
            session.add(
                OrderFeedSourceWindow(
                    consumer_group="torghut-order-feed-v1",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    alpaca_account_label="paper",
                    assignment_mode="manual",
                    source_revision=ORDER_FEED_SOURCE_REVISION,
                    window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    start_offset=49,
                    end_offset=49,
                    consumed_count=1,
                    status="inserted",
                )
            )
            session.add(
                OrderFeedConsumerCursor(
                    consumer_group="torghut-order-feed-v1",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    high_watermark_offset=57,
                    processed_event_count=9,
                )
            )
            session.commit()

            ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(
            consumer.seek_calls,
            [(TopicPartition("torghut.trade-updates.v1", 0), 58)],
        )
        self.assertEqual(consumer.seek_to_beginning_calls, [])

    def test_backfill_source_windows_links_legacy_events_without_cursor_authority(
        self,
    ) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        settings.trading_order_feed_group_id = "torghut-order-feed-v1"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-with-source-offset",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=88,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
            )
            session.add(event)
            session.commit()

            result = backfill_order_feed_source_windows(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.get(OrderFeedSourceWindow, event.source_window_id)
            self.assertIsNotNone(source_window)
            assert source_window is not None
            ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)
            counters = ingestor.ingest_once(session)

        self.assertEqual(
            result,
            {
                "selected": 1,
                "source_windows_created": 1,
                "source_windows_reused": 0,
                "events_linked": 1,
            },
        )
        self.assertEqual(
            source_window.source_revision,
            HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
        )
        self.assertEqual(source_window.status, "inserted")
        self.assertGreater(
            source_window.window_ended_at,
            source_window.window_started_at,
        )
        self.assertEqual(
            source_window.status_reason, "historical_execution_order_event_backfill"
        )
        self.assertEqual(source_window.inserted_count, 1)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)
        self.assertEqual(source_window.payload_json["cursor_authority"], False)
        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(consumer.seek_calls, [])
        self.assertEqual(
            consumer.seek_to_beginning_calls,
            [(TopicPartition("torghut.trade-updates.v1", 0),)],
        )

    def test_backfill_source_windows_reuses_existing_source_window(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                source_revision=HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                start_offset=88,
                end_offset=90,
                consumed_count=3,
                inserted_count=3,
                status="inserted",
            )
            session.add(source_window)
            session.flush()
            source_window_id = source_window.id
            event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-existing-source-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=89,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                raw_event={"event": "fill"},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
            )
            session.add(event)
            session.commit()

            result = backfill_order_feed_source_windows(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(event)

        self.assertEqual(
            result,
            {
                "selected": 1,
                "source_windows_created": 0,
                "source_windows_reused": 1,
                "events_linked": 1,
            },
        )
        self.assertEqual(event.source_window_id, source_window_id)

    def test_linking_one_event_keeps_source_window_unlinked_counts_aggregate(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=88,
                end_offset=89,
                consumed_count=2,
                inserted_count=2,
                unlinked_execution_count=2,
                unlinked_decision_count=2,
                status="inserted",
            )
            session.add(source_window)
            session.flush()

            linkable_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-linkable-source-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=88,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
                source_window_id=source_window.id,
            )
            still_unlinked_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-still-unlinked-source-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=89,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="MSFT",
                alpaca_order_id="other-order",
                client_order_id="other-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("320.00"),
                raw_event={"event": "fill"},
                source_window_id=source_window.id,
            )
            session.add_all([linkable_event, still_unlinked_event])
            session.commit()

            linked = link_order_events_to_execution(session, execution)
            session.commit()
            session.refresh(source_window)
            session.refresh(linkable_event)
            session.refresh(still_unlinked_event)

        self.assertEqual(linked, 1)
        self.assertEqual(linkable_event.execution_id, execution_id)
        self.assertEqual(linkable_event.trade_decision_id, trade_decision_id)
        self.assertIsNone(still_unlinked_event.execution_id)
        self.assertIsNone(still_unlinked_event.trade_decision_id)
        self.assertEqual(source_window.inserted_count, 2)
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 1)

    def test_linking_legacy_offset_event_creates_source_window_lineage(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            linkable_event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-linkable-missing-source-window",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=188,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add(linkable_event)
            session.commit()

            linked = link_order_events_to_execution(session, execution)
            session.commit()
            session.refresh(linkable_event)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(linked, 1)
        self.assertEqual(linkable_event.execution_id, execution_id)
        self.assertEqual(linkable_event.trade_decision_id, trade_decision_id)
        self.assertEqual(linkable_event.source_window_id, source_window.id)
        self.assertEqual(
            source_window.source_revision,
            HISTORICAL_ORDER_EVENT_SOURCE_WINDOW_REVISION,
        )
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(source_window.start_offset, 188)
        self.assertEqual(source_window.end_offset, 188)
        self.assertGreater(
            source_window.window_ended_at,
            source_window.window_started_at,
        )
        self.assertEqual(source_window.inserted_count, 1)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)

    def test_linking_event_uses_client_order_decision_when_execution_is_unlinked(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            decision_id = execution.trade_decision_id
            execution.trade_decision_id = None
            session.add(execution)
            session.flush()
            event = ExecutionOrderEvent(
                event_fingerprint="legacy-fill-execution-missing-decision",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=238,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.commit()

            linked = link_order_events_to_execution(session, execution)
            session.commit()
            session.refresh(event)

        self.assertEqual(linked, 1)
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, decision_id)

    def test_repair_order_feed_execution_links_links_matching_lifecycle_rows(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            linkable_event = ExecutionOrderEvent(
                event_fingerprint="repair-linkable-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=288,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id=execution.alpaca_order_id,
                client_order_id=execution.client_order_id,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            unmatched_event = ExecutionOrderEvent(
                event_fingerprint="repair-unmatched-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=289,
                alpaca_account_label="paper",
                event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                symbol="MSFT",
                alpaca_order_id="missing-order",
                client_order_id="missing-client",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("320.00"),
                raw_event={"event": "fill"},
            )
            session.add_all([linkable_event, unmatched_event])
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            session.refresh(linkable_event)
            session.refresh(unmatched_event)
            session.refresh(execution)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            tca_metric = session.execute(select(ExecutionTCAMetric)).scalar_one()

        self.assertEqual(
            result,
            {
                "selected": 2,
                "executions_matched": 1,
                "executions_linked": 1,
                "decisions_matched": 0,
                "events_linked": 1,
                "decision_events_linked": 0,
                "events_without_execution": 1,
                "events_without_decision": 1,
            },
        )
        self.assertEqual(linkable_event.execution_id, execution_id)
        self.assertEqual(linkable_event.trade_decision_id, trade_decision_id)
        self.assertEqual(linkable_event.source_window_id, source_window.id)
        self.assertIsNone(unmatched_event.execution_id)
        self.assertIsNone(unmatched_event.trade_decision_id)
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1.00000000"))
        self.assertEqual(tca_metric.execution_id, execution_id)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)

    def test_repair_order_feed_execution_links_links_matching_decision_without_execution(
        self,
    ) -> None:
        with Session(self.engine) as session:
            strategy = Strategy(
                name="decision-only-demo",
                description="decision-only-demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                decision_hash="decision-only-client-1",
                status="submitted",
            )
            session.add(decision)
            session.flush()
            decision_id = decision.id
            event = ExecutionOrderEvent(
                event_fingerprint="repair-decision-only-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=388,
                alpaca_account_label="TORGHUT_SIM",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="missing-execution-order",
                client_order_id="decision-only-client-1",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="TORGHUT_SIM",
                limit=10,
            )
            session.commit()
            session.refresh(event)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(
            result,
            {
                "selected": 1,
                "executions_matched": 0,
                "executions_linked": 0,
                "decisions_matched": 1,
                "events_linked": 0,
                "decision_events_linked": 1,
                "events_without_execution": 1,
                "events_without_decision": 0,
            },
        )
        self.assertIsNone(event.execution_id)
        self.assertEqual(event.trade_decision_id, decision_id)
        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 0)

    def test_repair_order_feed_execution_links_counts_missing_decision_identity(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="repair-missing-decision-identity",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=389,
                alpaca_account_label="TORGHUT_SIM",
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="missing-execution-order-no-client",
                client_order_id=None,
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("191.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.commit()

            result = repair_order_feed_execution_links(
                session,
                account_label="TORGHUT_SIM",
                limit=10,
            )

        self.assertEqual(result["selected"], 1)
        self.assertEqual(result["decision_events_linked"], 0)
        self.assertEqual(result["events_without_execution"], 1)
        self.assertEqual(result["events_without_decision"], 1)

    def test_repair_order_feed_execution_links_limits_matching_execution_fanout(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            events = [
                ExecutionOrderEvent(
                    event_fingerprint=f"repair-fanout-fill-{index}",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=400 + index,
                    alpaca_account_label="paper",
                    event_ts=datetime(2026, 2, 1, 10, index, tzinfo=timezone.utc),
                    symbol="AAPL",
                    alpaca_order_id=execution.alpaca_order_id,
                    client_order_id=execution.client_order_id,
                    event_type="fill",
                    status="filled",
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("191.25"),
                    raw_event={"event": "fill"},
                )
                for index in range(5)
            ]
            session.add_all(events)
            session.commit()

            first_result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=2,
            )
            session.commit()
            second_result = repair_order_feed_execution_links(
                session,
                account_label="paper",
                limit=2,
            )
            session.commit()
            linked_count = session.scalar(
                select(func.count(ExecutionOrderEvent.id)).where(
                    ExecutionOrderEvent.execution_id == execution.id
                )
            )

        self.assertEqual(first_result["events_linked"], 2)
        self.assertEqual(second_result["events_linked"], 2)
        self.assertEqual(linked_count, 4)

    def test_backfill_order_feed_events_from_executions_links_live_account_source(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="live-order-1",
                client_order_id="live-client-1",
            )
            execution.status = "filled"
            execution.filled_qty = Decimal("1")
            execution.avg_fill_price = Decimal("191.25")
            execution.raw_order = {
                "id": "live-order-1",
                "client_order_id": "live-client-1",
                "status": "filled",
            }
            execution_id = execution.id
            trade_decision_id = execution.trade_decision_id
            session.add(execution)
            session.commit()

            result = backfill_order_feed_events_from_executions(
                session,
                account_label="PA3SX7FYNUTF",
                limit=10,
            )
            session.commit()
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(
            result,
            {
                "selected": 1,
                "events_created": 1,
                "source_windows_created": 1,
                "skipped_existing_event": 0,
                "skipped_missing_trade_decision": 0,
                "skipped_missing_order_identity": 0,
                "skipped_source_offset_collision": 0,
            },
        )
        self.assertEqual(event.execution_id, execution_id)
        self.assertEqual(event.trade_decision_id, trade_decision_id)
        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(event.alpaca_account_label, "PA3SX7FYNUTF")
        self.assertEqual(event.event_type, "fill")
        self.assertEqual(event.status, "filled")
        self.assertEqual(event.filled_qty, Decimal("1.00000000"))
        self.assertEqual(event.avg_fill_price, Decimal("191.25000000"))
        self.assertIsNotNone(event.source_offset)
        self.assertEqual(
            source_window.source_revision,
            EXECUTION_RAW_ORDER_SOURCE_WINDOW_REVISION,
        )
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(source_window.payload_json["cursor_authority"], False)
        self.assertEqual(source_window.payload_json["execution_id"], str(execution_id))
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)

    def test_execution_event_backfill_filters_existing_order_feed_lifecycle(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session, account_label="PA3SX7FYNUTF")
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="existing-live-fill",
                    source_topic="torghut.trade-updates.v2",
                    source_partition=0,
                    source_offset=101,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    symbol="AAPL",
                    alpaca_order_id=execution.alpaca_order_id,
                    client_order_id=execution.client_order_id,
                    event_type="fill",
                    status="filled",
                    raw_event={"event": "fill"},
                    execution_id=execution.id,
                    trade_decision_id=execution.trade_decision_id,
                )
            )
            session.commit()

            result = backfill_order_feed_events_from_executions(
                session,
                account_label="PA3SX7FYNUTF",
                limit=10,
            )
            event_count = session.scalar(select(func.count(ExecutionOrderEvent.id)))

        self.assertEqual(result["selected"], 0)
        self.assertEqual(result["events_created"], 0)
        self.assertEqual(result["skipped_existing_event"], 0)
        self.assertEqual(event_count, 1)

    def test_execution_event_backfill_handles_race_and_offset_collision(
        self,
    ) -> None:
        with Session(self.engine) as session:
            self._seed_execution(
                session,
                account_label="PA3SX7FYNUTF",
                order_id="race-order",
                client_order_id="race-client",
            )
            with patch.object(
                order_feed_module,
                "latest_order_event_for_execution",
                return_value=ExecutionOrderEvent(
                    event_fingerprint="race-existing",
                    source_topic="torghut.trade-updates.v2",
                    alpaca_account_label="PA3SX7FYNUTF",
                    raw_event={"event": "fill"},
                ),
            ):
                race_result = backfill_order_feed_events_from_executions(
                    session,
                    account_label="PA3SX7FYNUTF",
                    limit=10,
                )

            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="offset-collision",
                    source_topic=order_feed_module.EXECUTION_RAW_ORDER_SOURCE_TOPIC,
                    source_partition=order_feed_module.EXECUTION_RAW_ORDER_SOURCE_PARTITION,
                    source_offset=77,
                    alpaca_account_label="PA3SX7FYNUTF",
                    event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    symbol="MSFT",
                    alpaca_order_id="other-order",
                    client_order_id="other-client",
                    event_type="fill",
                    status="filled",
                    raw_event={"event": "fill"},
                )
            )
            session.commit()
            with patch.object(
                order_feed_module,
                "_stable_execution_source_offset",
                return_value=77,
            ):
                collision_result = backfill_order_feed_events_from_executions(
                    session,
                    account_label="PA3SX7FYNUTF",
                    limit=10,
                )

        self.assertEqual(race_result["selected"], 1)
        self.assertEqual(race_result["events_created"], 0)
        self.assertEqual(race_result["skipped_existing_event"], 1)
        self.assertEqual(collision_result["selected"], 1)
        self.assertEqual(collision_result["events_created"], 0)
        self.assertEqual(collision_result["skipped_source_offset_collision"], 1)

    def test_execution_backfill_helper_edges_are_deterministic(self) -> None:
        partial_execution = Execution(
            trade_decision_id=None,
            alpaca_account_label="PA3SX7FYNUTF",
            alpaca_order_id="partial-order",
            client_order_id=None,
            symbol="AAPL",
            side="buy",
            order_type="limit",
            time_in_force="day",
            submitted_qty=Decimal("1"),
            filled_qty=Decimal("0.5"),
            status="partially_filled",
        )
        unknown_execution = Execution(
            trade_decision_id=None,
            alpaca_account_label="PA3SX7FYNUTF",
            alpaca_order_id="unknown-order",
            client_order_id=None,
            symbol="AAPL",
            side="buy",
            order_type="limit",
            time_in_force="day",
            submitted_qty=Decimal("1"),
            filled_qty=Decimal("0"),
            status="",
        )

        self.assertEqual(
            order_feed_module._execution_backfill_event_type(partial_execution),
            "partial_fill",
        )
        self.assertEqual(
            order_feed_module._execution_backfill_event_type(unknown_execution),
            "execution_snapshot",
        )
        self.assertEqual(
            order_feed_module._ensure_aware_utc(
                datetime(2026, 2, 1, 2, 0, tzinfo=timezone(timedelta(hours=-8)))
            ),
            datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
        )
        self.assertIsNone(order_feed_module._isoformat_datetime(None))
        self.assertEqual(
            order_feed_module._stable_execution_source_offset("not-a-uuid"),
            order_feed_module._stable_execution_source_offset("not-a-uuid"),
        )

    def test_historical_source_window_helpers_handle_missing_and_aware_offsets(
        self,
    ) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="legacy-fill-missing-offset",
            source_topic="torghut.trade-updates.v1",
            source_partition=None,
            source_offset=None,
            alpaca_account_label="paper",
            event_ts=datetime(
                2026,
                2,
                1,
                2,
                0,
                tzinfo=timezone(timedelta(hours=-8)),
            ),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"event": "fill"},
        )

        with Session(self.engine) as session:
            self.assertIsNone(
                order_feed_module._find_existing_source_window_for_event(
                    session,
                    event,
                )
            )
            with self.assertRaisesRegex(
                ValueError,
                "historical_source_window_requires_source_offset",
            ):
                order_feed_module._create_historical_source_window_for_event(
                    session,
                    event,
                )

        self.assertEqual(
            order_feed_module._event_timestamp_for_source_window(event),
            datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
        )

    def test_ingest_persists_durable_consumer_cursor_for_valid_event(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=7,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(cursor.consumer_group, settings.trading_order_feed_group_id)
        self.assertEqual(cursor.source_topic, "torghut.trade-updates.v1")
        self.assertEqual(cursor.source_partition, 0)
        self.assertEqual(cursor.high_watermark_offset, 7)
        self.assertEqual(cursor.processed_event_count, 1)
        self.assertEqual(cursor.duplicate_event_count, 0)

        with Session(self.engine) as session:
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(source_window.start_offset, 7)
        self.assertEqual(source_window.end_offset, 7)
        self.assertEqual(source_window.consumed_count, 1)
        self.assertEqual(source_window.inserted_count, 1)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)

    def test_source_window_records_scope_revision_and_available_high_watermark(
        self,
    ) -> None:
        settings.trading_order_feed_group_id = "torghut-paper-order-feed-v2"
        settings.trading_order_feed_client_id = "paper-collector-7"
        settings.trading_order_feed_assignment_mode = "manual"
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=31,
            broker_high_watermark=37,
        )
        consumer = FakeManualConsumer(
            [record], partitions={"torghut.trade-updates.v1": {0}}
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(source_window.consumer_group, "torghut-paper-order-feed-v2")
        self.assertEqual(source_window.source_topic, "torghut.trade-updates.v1")
        self.assertEqual(source_window.source_partition, 0)
        self.assertEqual(source_window.alpaca_account_label, "paper")
        self.assertEqual(source_window.assignment_mode, "manual")
        self.assertEqual(source_window.collector_identity, "paper-collector-7")
        self.assertEqual(source_window.source_revision, ORDER_FEED_SOURCE_REVISION)
        self.assertEqual(source_window.start_offset, 31)
        self.assertEqual(source_window.end_offset, 31)
        self.assertEqual(source_window.broker_high_watermark, 37)
        self.assertEqual(source_window.status, "inserted")

    def test_manual_assignment_skips_kafka_commit_after_durable_cursor_update(
        self,
    ) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "earliest"
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=32,
        )
        consumer = FakeManualConsumer(
            [record],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(counters["consumer_commits_total"], 0)
        self.assertEqual(counters["consumer_commit_skipped_total"], 1)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(cursor.high_watermark_offset, 32)
        self.assertEqual(source_window.assignment_mode, "manual")
        self.assertEqual(source_window.status, "inserted")

    def test_invalid_json_is_durably_classified_before_cursor_advance(self) -> None:
        record = FakeRecord(value=b"{not-json", offset=17)
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["classified_drops_total"], 1)
        self.assertEqual(counters["malformed_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(event_count, 0)
        self.assertEqual(cursor.high_watermark_offset, 17)
        self.assertEqual(source_window.status, "dropped")
        self.assertEqual(source_window.status_reason, "malformed_json")
        self.assertEqual(source_window.malformed_count, 1)
        self.assertEqual(source_window.dropped_count, 1)

    def test_missing_trade_update_payload_is_durably_classified(self) -> None:
        record = FakeRecord(
            value=b'{"channel":"orders","payload":{"event":"fill"}}', offset=18
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["classified_drops_total"], 1)
        self.assertEqual(counters["missing_payload_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(event_count, 0)
        self.assertEqual(cursor.high_watermark_offset, 18)
        self.assertEqual(source_window.status, "dropped")
        self.assertEqual(source_window.status_reason, "missing_trade_update_payload")
        self.assertEqual(source_window.missing_payload_count, 1)
        self.assertEqual(source_window.dropped_count, 1)

    def test_out_of_scope_account_is_durably_classified(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","account_label":"paper-b",'
                b'"payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-b","client_order_id":"client-b","symbol":"AAPL",'
                b'"status":"filled","qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=19,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(
            consumer_factory=lambda: consumer,
            default_account_label="paper-a",
        )

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["classified_drops_total"], 1)
        self.assertEqual(counters["out_of_scope_account_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(event_count, 0)
        self.assertEqual(cursor.high_watermark_offset, 19)
        self.assertEqual(source_window.alpaca_account_label, "paper-a")
        self.assertEqual(source_window.status, "dropped")
        self.assertEqual(source_window.status_reason, "out_of_scope_account")
        self.assertEqual(source_window.out_of_scope_account_count, 1)

    def test_out_of_scope_account_without_source_position_is_not_committed(
        self,
    ) -> None:
        record = SimpleNamespace(
            value=(
                b'{"channel":"trade_updates","account_label":"paper-b",'
                b'"payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-b","client_order_id":"client-b","symbol":"AAPL",'
                b'"status":"filled","qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            topic="torghut.trade-updates.v1",
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(
            consumer_factory=lambda: consumer,
            default_account_label="paper-a",
        )

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            source_window_count = len(
                session.execute(select(OrderFeedSourceWindow)).all()
            )
            cursor_count = len(session.execute(select(OrderFeedConsumerCursor)).all())

        self.assertEqual(counters["messages_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 0)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(source_window_count, 0)
        self.assertEqual(cursor_count, 0)

    def test_missing_order_identity_is_durably_classified(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"symbol":"AAPL","status":"filled","qty":"1","filled_qty":"1",'
                b'"filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=18,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()

        self.assertEqual(counters["classified_drops_total"], 1)
        self.assertEqual(counters["missing_identity_total"], 1)
        self.assertEqual(source_window.status, "dropped")
        self.assertEqual(source_window.status_reason, "missing_order_identity")
        self.assertEqual(source_window.missing_identity_count, 1)
        self.assertEqual(cursor.high_watermark_offset, 18)

    def test_unhandled_persist_failure_is_classified_without_cursor_or_kafka_commit(
        self,
    ) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=20,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            with patch(
                "app.trading.order_feed.persist_order_event",
                side_effect=RuntimeError("store failed"),
            ):
                counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            cursor_count = len(session.execute(select(OrderFeedConsumerCursor)).all())
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["messages_total"], 1)
        self.assertEqual(counters["failed_unhandled_total"], 1)
        self.assertEqual(counters["consumer_errors_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 0)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(cursor_count, 0)
        self.assertEqual(event_count, 0)
        self.assertEqual(source_window.status, "failed_unhandled")
        self.assertEqual(source_window.failed_unhandled_count, 1)
        self.assertIn("RuntimeError", source_window.status_reason or "")

    def test_unhandled_apply_failure_does_not_advance_source_cursor(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=21,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            with patch(
                "app.trading.order_feed.apply_order_event_to_execution",
                side_effect=RuntimeError("apply failed"),
            ):
                counters = ingestor.ingest_once(session)
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()
            cursor_count = len(session.execute(select(OrderFeedConsumerCursor)).all())
            event_count = len(session.execute(select(ExecutionOrderEvent)).all())

        self.assertEqual(counters["messages_total"], 1)
        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["failed_unhandled_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 0)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(cursor_count, 0)
        self.assertEqual(event_count, 1)
        self.assertEqual(source_window.status, "failed_unhandled")
        self.assertEqual(source_window.failed_unhandled_count, 1)

    def test_redelivered_failed_apply_duplicate_retries_before_cursor_advance(
        self,
    ) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=21,
        )

        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            first_consumer = FakeConsumer([record])
            first_ingestor = OrderFeedIngestor(consumer_factory=lambda: first_consumer)
            with patch(
                "app.trading.order_feed.apply_order_event_to_execution",
                side_effect=RuntimeError("apply failed"),
            ):
                first_counters = first_ingestor.ingest_once(session)
            failed_source_window = session.execute(
                select(OrderFeedSourceWindow)
            ).scalar_one()
            session.refresh(execution)

            second_consumer = FakeConsumer([record])
            second_ingestor = OrderFeedIngestor(
                consumer_factory=lambda: second_consumer
            )
            second_counters = second_ingestor.ingest_once(session)
            session.refresh(execution)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            source_windows = (
                session.execute(select(OrderFeedSourceWindow)).scalars().all()
            )
            duplicate_window = session.execute(
                select(OrderFeedSourceWindow).where(
                    OrderFeedSourceWindow.status == "duplicate"
                )
            ).scalar_one()

        self.assertEqual(first_counters["failed_unhandled_total"], 1)
        self.assertEqual(first_counters["cursor_updates_total"], 0)
        self.assertEqual(first_consumer.commit_calls, 0)
        self.assertEqual(failed_source_window.status, "failed_unhandled")
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1.00000000"))
        self.assertEqual(execution.avg_fill_price, Decimal("190.20000000"))
        self.assertEqual(second_counters["duplicates_total"], 1)
        self.assertEqual(second_counters["apply_updates_total"], 1)
        self.assertEqual(second_counters["cursor_updates_total"], 1)
        self.assertEqual(second_consumer.commit_calls, 1)
        self.assertEqual(cursor.high_watermark_offset, 21)
        self.assertEqual(
            {window.status for window in source_windows},
            {"failed_unhandled", "duplicate"},
        )
        self.assertEqual(
            duplicate_window.status_reason,
            "duplicate_after_failed_unhandled_reprocessed",
        )
        self.assertEqual(
            duplicate_window.payload_json[
                "reprocessed_failed_unhandled_source_window_id"
            ],
            str(failed_source_window.id),
        )

    def test_failed_duplicate_source_window_helper_handles_unlinked_event(
        self,
    ) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="no-window",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            raw_event={},
        )

        with Session(self.engine) as session:
            has_failed_source_window = (
                order_feed_module._order_event_has_failed_unhandled_source_window(
                    session,
                    event,
                )
            )

        self.assertFalse(has_failed_source_window)

    def test_retry_failed_duplicate_requires_execution_link(self) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="failed-without-execution-link",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            raw_event={},
        )

        with Session(self.engine) as session:
            with self.assertRaisesRegex(
                RuntimeError,
                "failed_unhandled_order_event_missing_execution_link",
            ):
                order_feed_module._retry_failed_duplicate_order_event_application(
                    session=session,
                    event=event,
                    counters={"out_of_order_total": 0, "apply_updates_total": 0},
                    source_window=None,
                )

    def test_retry_failed_duplicate_requires_existing_execution(self) -> None:
        event = ExecutionOrderEvent(
            event_fingerprint="failed-missing-execution",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            raw_event={},
            execution_id=uuid.uuid4(),
        )

        with Session(self.engine) as session:
            with self.assertRaisesRegex(
                RuntimeError,
                "failed_unhandled_order_event_execution_not_found",
            ):
                order_feed_module._retry_failed_duplicate_order_event_application(
                    session=session,
                    event=event,
                    counters={"out_of_order_total": 0, "apply_updates_total": 0},
                    source_window=None,
                )

    def test_retry_failed_duplicate_records_out_of_order_retry_lineage(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.order_feed_last_seq = 99
            failed_source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="group",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                start_offset=30,
                end_offset=30,
                consumed_count=1,
                status="failed_unhandled",
            )
            retry_source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="group",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=30,
                end_offset=30,
                consumed_count=1,
                status="duplicate",
            )
            session.add_all([execution, failed_source_window, retry_source_window])
            session.flush()
            event = ExecutionOrderEvent(
                event_fingerprint="failed-out-of-order-retry",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=30,
                alpaca_account_label="paper",
                feed_seq=10,
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="order-1",
                client_order_id="client-1",
                event_type="fill",
                status="filled",
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.2"),
                raw_event={},
                execution_id=execution.id,
                trade_decision_id=execution.trade_decision_id,
                source_window_id=failed_source_window.id,
            )
            counters = {"out_of_order_total": 0, "apply_updates_total": 0}

            order_feed_module._retry_failed_duplicate_order_event_application(
                session=session,
                event=event,
                counters=counters,
                source_window=retry_source_window,
            )

        self.assertEqual(counters["out_of_order_total"], 1)
        self.assertEqual(counters["apply_updates_total"], 0)
        self.assertEqual(
            retry_source_window.status_reason,
            "duplicate_after_failed_unhandled_reprocessed",
        )
        self.assertEqual(
            retry_source_window.payload_json[
                "reprocessed_failed_unhandled_source_window_id"
            ],
            str(failed_source_window.id),
        )

    def test_unhandled_failure_stops_batch_before_later_offsets(self) -> None:
        failed = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=22,
        )
        later = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:05Z",'
                b'"order":{"id":"order-2","client_order_id":"client-2","symbol":"MSFT","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"405.0"}},"seq":11}'
            ),
            offset=23,
        )
        consumer = FakeConsumer([failed, later])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            with patch(
                "app.trading.order_feed.persist_order_event",
                side_effect=RuntimeError("store failed"),
            ):
                counters = ingestor.ingest_once(session)
            source_windows = (
                session.execute(
                    select(OrderFeedSourceWindow).order_by(
                        OrderFeedSourceWindow.start_offset
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(counters["messages_total"], 1)
        self.assertEqual(counters["failed_unhandled_total"], 1)
        self.assertEqual(consumer.commit_calls, 0)
        self.assertEqual(len(source_windows), 1)
        self.assertEqual(source_windows[0].start_offset, 22)
        self.assertEqual(source_windows[0].status, "failed_unhandled")

    def test_unlinked_event_source_window_records_missing_lineage(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"unlinked-order","client_order_id":"unlinked-client","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=19,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()
            source_window = session.execute(select(OrderFeedSourceWindow)).scalar_one()

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["unlinked_execution_total"], 1)
        self.assertEqual(counters["unlinked_decision_total"], 1)
        self.assertEqual(event.source_window_id, source_window.id)
        self.assertEqual(source_window.status, "inserted")
        self.assertEqual(source_window.inserted_count, 1)
        self.assertEqual(source_window.unlinked_execution_count, 1)
        self.assertEqual(source_window.unlinked_decision_count, 1)

    def test_cursor_consumer_group_falls_back_to_client_id(self) -> None:
        settings.trading_order_feed_group_id = " "
        settings.trading_order_feed_client_id = "paper-route-client"
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=7,
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()

        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(cursor.consumer_group, "paper-route-client")

    def test_valid_event_without_source_position_skips_cursor_update(self) -> None:
        record = SimpleNamespace(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            topic="torghut.trade-updates.v1",
        )
        consumer = FakeConsumer([record])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor_count = len(session.execute(select(OrderFeedConsumerCursor)).all())

        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 0)
        self.assertEqual(cursor_count, 0)
        self.assertEqual(consumer.commit_calls, 1)

    def test_later_offset_with_gap_advances_cursor_gap_accounting(self) -> None:
        first = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"partial_fill",'
                b'"timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"partially_filled",'
                b'"qty":"2","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=7,
        )
        later = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:05Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"2","filled_qty":"2","filled_avg_price":"190.4"}},"seq":11}'
            ),
            offset=10,
        )
        consumer = FakeConsumer([first, later])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            events = (
                session.execute(
                    select(ExecutionOrderEvent).order_by(
                        ExecutionOrderEvent.source_offset.asc()
                    )
                )
                .scalars()
                .all()
            )
            source_windows = (
                session.execute(
                    select(OrderFeedSourceWindow).order_by(
                        OrderFeedSourceWindow.start_offset.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(counters["events_persisted_total"], 2)
        self.assertEqual(counters["cursor_updates_total"], 2)
        self.assertEqual(cursor.high_watermark_offset, 10)
        self.assertEqual(cursor.processed_event_count, 2)
        self.assertEqual(cursor.offset_gap_count, 1)
        self.assertEqual(
            cursor.last_event_ts,
            datetime(2026, 2, 1, 10, 0, 5),
        )
        self.assertEqual(
            [event.filled_qty for event in events], [Decimal("1"), Decimal("2")]
        )
        self.assertEqual(
            [event.filled_qty_delta for event in events],
            [Decimal("1"), Decimal("1")],
        )
        self.assertEqual(
            [event.fill_quantity_basis for event in events],
            ["cumulative_to_delta", "cumulative_to_delta"],
        )
        self.assertEqual(
            [event.filled_notional_delta for event in events],
            [Decimal("190.20000000"), Decimal("190.40000000")],
        )
        self.assertEqual([window.start_offset for window in source_windows], [7, 10])
        self.assertEqual(source_windows[1].gap_count, 1)
        self.assertEqual(
            source_windows[1].gap_ranges,
            [{"start_offset": 8, "end_offset": 9}],
        )

    def test_fill_delta_fields_rejects_fill_without_order_identity(self) -> None:
        event = NormalizedOrderEvent(
            event_fingerprint="fill-no-order-id",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=12,
            alpaca_account_label="paper",
            feed_seq=12,
            event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            alpaca_order_id=None,
            client_order_id=None,
            event_type="fill",
            status="filled",
            qty=Decimal("1"),
            filled_qty=Decimal("1"),
            filled_qty_delta=None,
            avg_fill_price=Decimal("190.2"),
            filled_notional_delta=None,
            fill_quantity_basis=None,
            raw_event={},
        )

        with Session(self.engine) as session:
            qty_delta, notional_delta, basis = order_feed_module._fill_delta_fields(
                session,
                event,
            )

        self.assertIsNone(qty_delta)
        self.assertIsNone(notional_delta)
        self.assertEqual(basis, "cumulative_non_increasing")

    def test_fill_delta_fields_rejects_non_increasing_cumulative_fill(self) -> None:
        first = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"partial_fill",'
                b'"timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"partially_filled",'
                b'"qty":"2","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=7,
        )
        stale_repeat = NormalizedOrderEvent(
            event_fingerprint="fill-non-increasing",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=13,
            alpaca_account_label="paper",
            feed_seq=13,
            event_ts=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            alpaca_order_id="order-1",
            client_order_id="client-1",
            event_type="fill",
            status="filled",
            qty=Decimal("2"),
            filled_qty=Decimal("1"),
            filled_qty_delta=None,
            avg_fill_price=Decimal("190.3"),
            filled_notional_delta=None,
            fill_quantity_basis=None,
            raw_event={},
        )

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                first,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            persist_order_event(session, normalized.event)

            qty_delta, notional_delta, basis = order_feed_module._fill_delta_fields(
                session,
                stale_repeat,
            )

        self.assertIsNone(qty_delta)
        self.assertIsNone(notional_delta)
        self.assertEqual(basis, "cumulative_non_increasing")

    def test_repair_order_feed_fill_deltas_converts_legacy_cumulative_fills(
        self,
    ) -> None:
        base_ts = datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            self._seed_execution(session)
            session.add_all(
                [
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-1",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=101,
                        alpaca_account_label="paper",
                        feed_seq=10,
                        event_ts=base_ts,
                        symbol="AAPL",
                        alpaca_order_id="order-1",
                        client_order_id="client-1",
                        event_type="partial_fill",
                        status="partially_filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("190.20"),
                        raw_event={},
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-2",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=102,
                        alpaca_account_label="paper",
                        feed_seq=11,
                        event_ts=base_ts + timedelta(seconds=1),
                        symbol="AAPL",
                        alpaca_order_id="order-1",
                        client_order_id="client-1",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("2"),
                        avg_fill_price=Decimal("190.40"),
                        raw_event={},
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-repeat",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=103,
                        alpaca_account_label="paper",
                        feed_seq=12,
                        event_ts=base_ts + timedelta(seconds=2),
                        symbol="AAPL",
                        alpaca_order_id="order-1",
                        client_order_id="client-1",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("2"),
                        avg_fill_price=Decimal("190.50"),
                        raw_event={},
                    ),
                ]
            )
            session.commit()

            counters = repair_order_feed_fill_deltas(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            events = (
                session.execute(
                    select(ExecutionOrderEvent).order_by(
                        ExecutionOrderEvent.feed_seq.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(counters["selected"], 3)
        self.assertEqual(counters["delta_events_repaired"], 2)
        self.assertEqual(counters["non_increasing_events_marked"], 1)
        self.assertEqual(counters["missing_identity_events_marked"], 0)
        self.assertEqual(
            [event.filled_qty_delta for event in events],
            [Decimal("1.00000000"), Decimal("1.00000000"), None],
        )
        self.assertEqual(
            [event.filled_notional_delta for event in events],
            [Decimal("190.20000000"), Decimal("190.40000000"), None],
        )
        self.assertEqual(
            [event.fill_quantity_basis for event in events],
            [
                "cumulative_to_delta",
                "cumulative_to_delta",
                "cumulative_non_increasing",
            ],
        )

    def test_repair_order_feed_fill_deltas_rejects_missing_order_identity(
        self,
    ) -> None:
        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="legacy-fill-no-identity",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=201,
                    alpaca_account_label="paper",
                    feed_seq=20,
                    event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                    symbol="AAPL",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("190.20"),
                    raw_event={},
                )
            )
            session.commit()

            counters = repair_order_feed_fill_deltas(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            event = session.execute(select(ExecutionOrderEvent)).scalar_one()

        self.assertEqual(counters["selected"], 1)
        self.assertEqual(counters["delta_events_repaired"], 0)
        self.assertEqual(counters["missing_identity_events_marked"], 1)
        self.assertIsNone(event.filled_qty_delta)
        self.assertIsNone(event.filled_notional_delta)
        self.assertEqual(event.fill_quantity_basis, "cumulative_non_increasing")

    def test_repair_order_feed_fill_deltas_orders_by_source_offset_without_event_ts(
        self,
    ) -> None:
        with Session(self.engine) as session:
            session.add_all(
                [
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-offset-1",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=301,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        alpaca_order_id="order-offset",
                        event_type="partial_fill",
                        status="partially_filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("190"),
                        raw_event={},
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="legacy-fill-offset-2",
                        source_topic="torghut.trade-updates.v1",
                        source_partition=0,
                        source_offset=302,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        alpaca_order_id="order-offset",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("2"),
                        filled_qty=Decimal("2"),
                        avg_fill_price=Decimal("191"),
                        raw_event={},
                    ),
                ]
            )
            session.commit()

            counters = repair_order_feed_fill_deltas(
                session,
                account_label="paper",
                limit=10,
            )
            session.commit()
            events = (
                session.execute(
                    select(ExecutionOrderEvent).order_by(
                        ExecutionOrderEvent.source_offset.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(counters["selected"], 2)
        self.assertEqual(counters["delta_events_repaired"], 2)
        self.assertEqual(
            [event.filled_qty_delta for event in events],
            [Decimal("1.00000000"), Decimal("1.00000000")],
        )
        self.assertEqual(
            [event.filled_notional_delta for event in events],
            [Decimal("190.00000000"), Decimal("191.00000000")],
        )

    def test_duplicate_event_source_window_attach_refreshes_linkage_counts(
        self,
    ) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
        )
        record = FakeRecord(value=payload, offset=11)

        with Session(self.engine) as session:
            self._seed_execution(session)
            normalized = normalize_order_feed_record(
                record,
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            persisted, duplicate = persist_order_event(session, normalized.event)
            self.assertFalse(duplicate)
            persisted_id = persisted.id
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed-v1",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                source_revision=ORDER_FEED_SOURCE_REVISION,
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 1, tzinfo=timezone.utc),
                start_offset=11,
                end_offset=11,
                consumed_count=1,
                inserted_count=1,
                unlinked_execution_count=1,
                unlinked_decision_count=1,
                status="inserted",
            )
            session.add(source_window)
            session.flush()
            persisted.source_window_id = None
            session.flush()

            persisted_again, duplicate_again = persist_order_event(
                session,
                normalized.event,
                source_window_id=source_window.id,
            )
            persisted_again_id = persisted_again.id
            session.commit()
            session.refresh(source_window)

        self.assertTrue(duplicate_again)
        self.assertEqual(persisted_again_id, persisted_id)
        self.assertEqual(source_window.unlinked_execution_count, 0)
        self.assertEqual(source_window.unlinked_decision_count, 0)

    def test_duplicate_event_advances_cursor_accounting_and_commits(self) -> None:
        record = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=11,
        )

        with Session(self.engine) as session:
            self._seed_execution(session)
            first_consumer = FakeConsumer([record])
            first_ingestor = OrderFeedIngestor(consumer_factory=lambda: first_consumer)
            first_ingestor.ingest_once(session)

            duplicate_consumer = FakeConsumer([record])
            duplicate_ingestor = OrderFeedIngestor(
                consumer_factory=lambda: duplicate_consumer
            )
            counters = duplicate_ingestor.ingest_once(session)
            cursor = session.execute(select(OrderFeedConsumerCursor)).scalar_one()
            duplicate_source_window = session.execute(
                select(OrderFeedSourceWindow).where(
                    OrderFeedSourceWindow.status == "duplicate"
                )
            ).scalar_one()

        self.assertEqual(counters["duplicates_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(duplicate_consumer.commit_calls, 1)
        self.assertEqual(cursor.high_watermark_offset, 11)
        self.assertEqual(cursor.processed_event_count, 2)
        self.assertEqual(cursor.duplicate_event_count, 1)
        self.assertEqual(duplicate_source_window.duplicate_count, 1)
        self.assertEqual(duplicate_source_window.consumed_count, 1)
        self.assertEqual(
            duplicate_source_window.payload_json["classification_counts"],
            {"duplicate": 1},
        )

    def test_manual_assignment_skips_missing_topic_metadata_then_fails_closed(
        self,
    ) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        consumer = FakeManualConsumer([], partitions={})
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["consumer_errors_total"], 1)
        self.assertEqual(consumer.assigned, [])

    def test_manual_assignment_latest_requires_seek_to_end_support(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "latest"
        consumer = FakeManualConsumerWithoutEndSeek(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["consumer_errors_total"], 1)
        self.assertEqual(
            consumer.assigned, [TopicPartition("torghut.trade-updates.v1", 0)]
        )

    def test_manual_assignment_latest_seeks_unpositioned_to_end(self) -> None:
        settings.trading_order_feed_assignment_mode = "manual"
        settings.trading_order_feed_auto_offset_reset = "latest"
        consumer = FakeManualConsumer(
            [],
            partitions={"torghut.trade-updates.v1": {0}},
        )
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            counters = ingestor.ingest_once(session)

        self.assertEqual(counters["messages_total"], 0)
        self.assertEqual(consumer.seek_to_beginning_calls, [])
        self.assertEqual(
            consumer.seek_to_end_calls,
            [(TopicPartition("torghut.trade-updates.v1", 0),)],
        )

    def test_stream_and_root_order_payloads_are_normalized(self) -> None:
        stream_record = FakeRecord(
            value=(
                b'{"stream":"trade_updates","data":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-stream","client_order_id":"client-stream","symbol":"AAPL","status":"filled"}}}'
            )
        )
        root_record = FakeRecord(
            value=(
                b'{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-root","client_order_id":"client-root","symbol":"AAPL","status":"filled"}}'
            )
        )

        stream = normalize_order_feed_record(
            stream_record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper",
        )
        root = normalize_order_feed_record(
            root_record,
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper",
        )

        assert stream.event is not None
        assert root.event is not None
        self.assertEqual(stream.event.alpaca_order_id, "order-stream")
        self.assertEqual(root.event.alpaca_order_id, "order-root")

    def test_ingestor_applies_valid_events_and_tracks_missing_fields(self) -> None:
        good = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
                b'"order":{"id":"order-1","client_order_id":"client-1","symbol":"AAPL","status":"filled",'
                b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10}'
            ),
            offset=1,
        )
        bad = FakeRecord(
            value=(
                b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:01:00Z",'
                b'"order":{"symbol":"AAPL"}},"seq":11}'
            ),
            offset=2,
        )
        consumer = FakeConsumer([good, bad])
        ingestor = OrderFeedIngestor(consumer_factory=lambda: consumer)

        with Session(self.engine) as session:
            self._seed_execution(session)
            counters = ingestor.ingest_once(session)
            execution = session.execute(
                select(Execution).where(Execution.alpaca_order_id == "order-1")
            ).scalar_one()
            rows = session.execute(select(ExecutionOrderEvent)).scalars().all()

        self.assertEqual(counters["messages_total"], 2)
        self.assertEqual(counters["events_persisted_total"], 1)
        self.assertEqual(counters["missing_fields_total"], 1)
        self.assertEqual(counters["apply_updates_total"], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(execution.status, "filled")
        self.assertEqual(execution.filled_qty, Decimal("1"))
