from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import create_engine, select
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
    RejectedSignalOutcomeEvent,
    Strategy,
    TradeDecision,
)
from app.trading.order_feed import (
    OrderFeedIngestor,
    apply_order_event_to_execution,
    merge_execution_raw_order_update,
    normalize_order_feed_record,
    persist_order_event,
)


@dataclass
class FakeRecord:
    value: bytes
    topic: str = "torghut.trade-updates.v1"
    partition: int = 0
    offset: int = 0


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
        settings.trading_order_feed_enabled = True
        settings.trading_order_feed_bootstrap_servers = "localhost:9092"
        settings.trading_order_feed_topic = "torghut.trade-updates.v1"
        settings.trading_order_feed_topic_v2 = None
        settings.trading_order_feed_assignment_mode = "group"
        settings.trading_order_feed_auto_offset_reset = "latest"

    def tearDown(self) -> None:
        settings.trading_order_feed_enabled = self._orig_feed_enabled
        settings.trading_order_feed_bootstrap_servers = self._orig_bootstrap
        settings.trading_order_feed_topic = self._orig_topic
        settings.trading_order_feed_topic_v2 = self._orig_topic_v2
        settings.trading_order_feed_group_id = self._orig_group_id
        settings.trading_order_feed_client_id = self._orig_client_id
        settings.trading_order_feed_assignment_mode = self._orig_assignment_mode
        settings.trading_order_feed_auto_offset_reset = self._orig_auto_offset_reset

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

            session.commit()

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
            existing = ExecutionOrderEvent(
                event_fingerprint="existing-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=41,
                alpaca_account_label="paper",
                symbol="AAPL",
                raw_event={"event": "fill"},
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

        self.assertEqual(counters["events_persisted_total"], 2)
        self.assertEqual(counters["cursor_updates_total"], 2)
        self.assertEqual(cursor.high_watermark_offset, 10)
        self.assertEqual(cursor.processed_event_count, 2)
        self.assertEqual(cursor.offset_gap_count, 1)
        self.assertEqual(
            cursor.last_event_ts,
            datetime(2026, 2, 1, 10, 0, 5),
        )

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

        self.assertEqual(counters["duplicates_total"], 1)
        self.assertEqual(counters["cursor_updates_total"], 1)
        self.assertEqual(duplicate_consumer.commit_calls, 1)
        self.assertEqual(cursor.high_watermark_offset, 11)
        self.assertEqual(cursor.processed_event_count, 2)
        self.assertEqual(cursor.duplicate_event_count, 1)

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
