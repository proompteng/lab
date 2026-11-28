from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from kafka import TopicPartition
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    Strategy,
    TradeDecision,
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


def filled_order_event(**overrides: object) -> ExecutionOrderEvent:
    defaults = {
        "source_topic": "torghut.trade-updates.v1",
        "source_partition": 0,
        "alpaca_account_label": "paper",
        "event_ts": datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
        "symbol": "AAPL",
        "event_type": "fill",
        "status": "filled",
        "raw_event": {"event": "fill"},
    }
    return ExecutionOrderEvent(**(defaults | overrides))


class OrderFeedTestCase(TestCase):
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
        execution_idempotency_key: str | None = None,
        execution_correlation_id: str | None = None,
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
            execution_correlation_id=execution_correlation_id,
            execution_idempotency_key=execution_idempotency_key,
            raw_order={"id": "order-1"},
            last_update_at=datetime.now(timezone.utc),
        )
        session.add(execution)
        session.commit()
        session.refresh(execution)
        return execution
