from __future__ import annotations


import io
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    OrderFeedSourceWindow,
    Strategy,
    TradeDecision,
)
from scripts import reconcile_cross_dsn_order_feed_links as cross_dsn_script
from scripts import repair_order_feed_source_windows as script


class _FakeSession:
    def __init__(self) -> None:
        self.commits = 0
        self.rollbacks = 0

    def __enter__(self) -> _FakeSession:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class _FakeSessionFactory:
    def __init__(self, session: _FakeSession) -> None:
        self.session = session

    def __call__(self) -> _FakeSession:
        return self.session


class _TestRepairOrderFeedSourceWindowsScriptBase(TestCase):
    pass


def _sqlite_model_engine() -> Engine:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return engine


def _seed_canonical_execution(
    session: Session,
    *,
    order_id: str,
    client_order_id: str,
    execution_idempotency_key: str | None = None,
    account_label: str = "TORGHUT_SIM",
) -> tuple[TradeDecision, Execution, ExecutionTCAMetric]:
    strategy = Strategy(
        name=f"strategy-{client_order_id}",
        description="canonical sim strategy",
        enabled=True,
        base_timeframe="1Min",
        universe_type="symbols_list",
        universe_symbols=["AMZN"],
    )
    session.add(strategy)
    session.flush()
    decision = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label=account_label,
        symbol="AMZN",
        timeframe="1Min",
        decision_json={"side": "buy", "qty": "1"},
        rationale="test",
        decision_hash=client_order_id,
        status="executed",
        executed_at=datetime(2026, 6, 11, 14, 30, tzinfo=timezone.utc),
    )
    session.add(decision)
    session.flush()
    execution = Execution(
        trade_decision_id=decision.id,
        alpaca_account_label=account_label,
        alpaca_order_id=order_id,
        client_order_id=client_order_id,
        symbol="AMZN",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("1"),
        avg_fill_price=Decimal("100"),
        status="filled",
        execution_idempotency_key=execution_idempotency_key,
        raw_order={"id": order_id, "client_order_id": client_order_id},
        last_update_at=datetime(2026, 6, 11, 14, 30, tzinfo=timezone.utc),
    )
    session.add(execution)
    session.flush()
    metric = ExecutionTCAMetric(
        execution_id=execution.id,
        trade_decision_id=decision.id,
        strategy_id=strategy.id,
        alpaca_account_label=account_label,
        symbol="AMZN",
        side="buy",
        avg_fill_price=Decimal("100"),
        filled_qty=Decimal("1"),
        signed_qty=Decimal("1"),
        computed_at=datetime(2026, 6, 11, 14, 31, tzinfo=timezone.utc),
    )
    session.add(metric)
    session.flush()
    return decision, execution, metric


def _seed_live_source_window(
    session: Session, *, event_count: int
) -> OrderFeedSourceWindow:
    source_window = OrderFeedSourceWindow(
        consumer_group="torghut-order-feed-v1",
        source_topic="torghut.trade-updates.v1",
        source_partition=0,
        alpaca_account_label="PA3SX7FYNUTF",
        assignment_mode="group",
        source_revision="alpaca-trade-updates-v1",
        window_started_at=datetime(2026, 6, 11, 13, 30, tzinfo=timezone.utc),
        window_ended_at=datetime(2026, 6, 11, 20, 10, tzinfo=timezone.utc),
        start_offset=10_000,
        end_offset=10_000 + event_count - 1,
        consumed_count=event_count,
        inserted_count=event_count,
        unlinked_execution_count=event_count,
        unlinked_decision_count=event_count,
        status="inserted",
        status_reason="missing_execution_and_decision_links",
        classification_counts={
            "inserted": event_count,
            "unlinked_execution": event_count,
            "unlinked_decision": event_count,
        },
        payload_json={
            "classification_counts": {
                "inserted": event_count,
                "unlinked_execution": event_count,
                "unlinked_decision": event_count,
            }
        },
    )
    session.add(source_window)
    session.flush()
    return source_window


FakeSession = _FakeSession
FakeSessionFactory = _FakeSessionFactory
seed_canonical_execution = _seed_canonical_execution
sqlite_model_engine = _sqlite_model_engine


__all__: tuple[str, ...] = (
    "Base",
    "Decimal",
    "Execution",
    "ExecutionOrderEvent",
    "ExecutionTCAMetric",
    "FakeSession",
    "FakeSessionFactory",
    "OrderFeedSourceWindow",
    "Session",
    "Strategy",
    "TestCase",
    "TradeDecision",
    "_FakeSession",
    "_FakeSessionFactory",
    "_TestRepairOrderFeedSourceWindowsScriptBase",
    "_seed_canonical_execution",
    "_seed_live_source_window",
    "_sqlite_model_engine",
    "create_engine",
    "cross_dsn_script",
    "datetime",
    "io",
    "json",
    "os",
    "patch",
    "script",
    "select",
    "sys",
    "timedelta",
    "timezone",
    "uuid",
    "seed_canonical_execution",
    "sqlite_model_engine",
)
