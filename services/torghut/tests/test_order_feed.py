from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from unittest import TestCase

from app.config import settings
from app.models import Base, Execution, ExecutionOrderEvent, Strategy, TradeDecision
from app.trading.order_feed import (
    OrderFeedIngestor,
    apply_order_event_to_execution,
    normalize_order_feed_record,
    persist_order_event,
)


@dataclass
class FakeRecord:
    value: bytes
    topic: str = 'torghut.trade-updates.v1'
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
        return {('topic', 0): batch}

    def commit(self):
        self.commit_calls += 1

    def close(self):
        return None


class TestOrderFeed(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine('sqlite+pysqlite:///:memory:', future=True)
        Base.metadata.create_all(self.engine)

        self._orig_feed_enabled = settings.trading_order_feed_enabled
        self._orig_bootstrap = settings.trading_order_feed_bootstrap_servers
        self._orig_topic = settings.trading_order_feed_topic
        settings.trading_order_feed_enabled = True
        settings.trading_order_feed_bootstrap_servers = 'localhost:9092'
        settings.trading_order_feed_topic = 'torghut.trade-updates.v1'

    def tearDown(self) -> None:
        settings.trading_order_feed_enabled = self._orig_feed_enabled
        settings.trading_order_feed_bootstrap_servers = self._orig_bootstrap
        settings.trading_order_feed_topic = self._orig_topic

    def _seed_execution(self, session: Session) -> Execution:
        strategy = Strategy(
            name='demo',
            description='demo',
            enabled=True,
            base_timeframe='1Min',
            universe_type='symbols_list',
            universe_symbols=['AAPL'],
        )
        session.add(strategy)
        session.flush()

        decision = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label='paper',
            symbol='AAPL',
            timeframe='1Min',
            decision_json={'side': 'buy'},
            decision_hash='client-1',
            status='submitted',
        )
        session.add(decision)
        session.flush()

        execution = Execution(
            trade_decision_id=decision.id,
            alpaca_account_label='paper',
            alpaca_order_id='order-1',
            client_order_id='client-1',
            symbol='AAPL',
            side='buy',
            order_type='limit',
            time_in_force='day',
            submitted_qty=Decimal('1'),
            filled_qty=Decimal('0'),
            status='new',
            raw_order={'id': 'order-1'},
            last_update_at=datetime.now(timezone.utc),
        )
        session.add(execution)
        session.commit()
        session.refresh(execution)
        return execution

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
                default_topic='torghut.trade-updates.v1',
                default_account_label='paper',
            )
            assert normalized.event is not None
            self.assertEqual(normalized.event.alpaca_account_label, 'paper')

            first, first_dup = persist_order_event(session, normalized.event)
            second, second_dup = persist_order_event(session, normalized.event)
            session.commit()

            self.assertFalse(first_dup)
            self.assertTrue(second_dup)
            self.assertEqual(first.id, second.id)
            rows = session.execute(select(ExecutionOrderEvent)).scalars().all()
            self.assertEqual(len(rows), 1)

    def test_out_of_order_event_does_not_regress_execution(self) -> None:
        with Session(self.engine) as session:
            execution = self._seed_execution(session)
            execution.order_feed_last_seq = 30
            execution.order_feed_last_event_ts = datetime.now(timezone.utc)
            execution.status = 'filled'
            execution.filled_qty = Decimal('1')
            session.add(execution)
            session.commit()

            stale = ExecutionOrderEvent(
                event_fingerprint='stale-event',
                source_topic='torghut.trade-updates.v1',
                source_partition=0,
                source_offset=99,
                feed_seq=12,
                event_ts=execution.order_feed_last_event_ts - timedelta(seconds=10),
                symbol='AAPL',
                alpaca_order_id='order-1',
                client_order_id='client-1',
                event_type='partial_fill',
                status='partially_filled',
                qty=Decimal('1'),
                filled_qty=Decimal('0.5'),
                avg_fill_price=Decimal('190.0'),
                raw_event={'event': 'partial_fill'},
                execution_id=execution.id,
            )
            session.add(stale)
            session.flush()

            updated, out_of_order = apply_order_event_to_execution(execution, stale)
            self.assertFalse(updated)
            self.assertTrue(out_of_order)
            self.assertEqual(execution.status, 'filled')
            self.assertEqual(execution.filled_qty, Decimal('1'))

    def test_missing_identity_fields_are_dropped(self) -> None:
        payload = (
            b'{"channel":"trade_updates","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"order":{"symbol":"AAPL","status":"filled"}},"seq":11}'
        )
        record = FakeRecord(value=payload, offset=44)

        normalized = normalize_order_feed_record(
            record,
            default_topic='torghut.trade-updates.v1',
            default_account_label='paper',
        )
        self.assertIsNone(normalized.event)
        self.assertEqual(normalized.drop_reason, 'missing_order_identity')

    def test_v2_payload_uses_account_label_from_envelope(self) -> None:
        payload = (
            b'{"channel":"trade_updates","accountLabel":"paper-b","payload":{"event":"fill","timestamp":"2026-02-01T10:00:00Z",'
            b'"account_label":"paper-b","order":{"id":"order-9","client_order_id":"client-9","symbol":"AAPL","status":"filled",'
            b'"qty":"1","filled_qty":"1","filled_avg_price":"190.2"}},"seq":10,"version":2}'
        )
        record = FakeRecord(value=payload, topic='torghut.trade-updates.v2', offset=12)

        normalized = normalize_order_feed_record(
            record,
            default_topic='torghut.trade-updates.v1',
            default_account_label='paper-a',
        )
        assert normalized.event is not None
        self.assertEqual(normalized.event.alpaca_account_label, 'paper-b')

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
            execution = session.execute(select(Execution).where(Execution.alpaca_order_id == 'order-1')).scalar_one()
            rows = session.execute(select(ExecutionOrderEvent)).scalars().all()

        self.assertEqual(counters['messages_total'], 2)
        self.assertEqual(counters['events_persisted_total'], 1)
        self.assertEqual(counters['missing_fields_total'], 1)
        self.assertEqual(counters['apply_updates_total'], 1)
        self.assertEqual(consumer.commit_calls, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(execution.status, 'filled')
        self.assertEqual(execution.filled_qty, Decimal('1'))
