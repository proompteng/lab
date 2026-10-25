from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    TigerBeetleReconciliationRun,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    StrategyRuntimeLedgerBucket,
)
from app.trading.tigerbeetle_journal import (
    TigerBeetleLedgerJournal,
    build_runtime_ledger_bucket_transfer_plan,
)
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_RUNTIME_NET_PNL,
)
from app.trading.tigerbeetle_client import (
    FakeTigerBeetleClient,
    TigerBeetleClientTimeoutError,
)
from scripts import journal_tigerbeetle_order_events as script
from scripts.tigerbeetle_order_journal import cli as script_cli
from scripts.tigerbeetle_order_journal import journal_core as script_core
from scripts.tigerbeetle_order_journal import (
    journal_payloads as script_payloads,
)
from scripts import run_tigerbeetle_journal_cron as cron_runner

__all__ = (
    "Base",
    "Decimal",
    "Execution",
    "ExecutionOrderEvent",
    "ExecutionTCAMetric",
    "FakeJournal",
    "FakeTigerBeetleClient",
    "LEDGER_USD_MICRO",
    "Path",
    "Session",
    "Settings",
    "SimpleNamespace",
    "StrategyRuntimeLedgerBucket",
    "TRANSFER_CODE_FILL_POST",
    "TRANSFER_KIND_EXECUTION_COST",
    "TRANSFER_KIND_EXECUTION_FILL",
    "TRANSFER_KIND_FILL_POST",
    "TRANSFER_KIND_RUNTIME_NET_PNL",
    "TigerBeetleAccountRef",
    "TigerBeetleClientTimeoutError",
    "TigerBeetleLedgerJournal",
    "TigerBeetleReconciliationRun",
    "TigerBeetleTransferRef",
    "_TestJournalTigerBeetleOrderEventsScriptBase",
    "_add_order_event",
    "_add_real_source_rows",
    "argparse",
    "build_runtime_ledger_bucket_transfer_plan",
    "cast",
    "create_engine",
    "cron_runner",
    "datetime",
    "io",
    "json",
    "nullcontext",
    "os",
    "patch",
    "redirect_stderr",
    "redirect_stdout",
    "script",
    "script_cli",
    "script_core",
    "script_payloads",
    "select",
    "subprocess",
    "sys",
    "tempfile",
    "timedelta",
    "timezone",
)


def _add_order_event(
    session: Session,
    *,
    fingerprint: str,
    account_label: str = "paper",
    event_type: str = "fill",
    status: str = "filled",
    source_offset: int = 1,
    has_amount: bool = True,
    avg_fill_price: Decimal = Decimal("190.25"),
) -> ExecutionOrderEvent:
    event = ExecutionOrderEvent(
        event_fingerprint=fingerprint,
        source_topic="torghut.trade-updates.v1",
        source_partition=0,
        source_offset=source_offset,
        alpaca_account_label=account_label,
        event_ts=datetime.now(timezone.utc),
        symbol="AAPL",
        alpaca_order_id=f"order-{fingerprint}",
        client_order_id=f"client-{fingerprint}",
        event_type=event_type,
        status=status,
        qty=Decimal("1") if has_amount else None,
        filled_qty=Decimal("1") if has_amount else None,
        avg_fill_price=avg_fill_price if has_amount else None,
        raw_event={"event": event_type},
    )
    session.add(event)
    session.flush()
    return event


def _add_real_source_rows(session: Session) -> None:
    execution = Execution(
        alpaca_account_label="paper",
        alpaca_order_id="order-source",
        client_order_id="client-source",
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("1"),
        avg_fill_price=Decimal("190.25"),
        status="filled",
        raw_order={"id": "order-source"},
    )
    session.add(execution)
    session.flush()
    session.add(
        ExecutionTCAMetric(
            execution_id=execution.id,
            alpaca_account_label="paper",
            symbol="AAPL",
            side="buy",
            filled_qty=Decimal("1"),
            signed_qty=Decimal("1"),
            shortfall_notional=Decimal("0.25"),
            computed_at=datetime.now(timezone.utc),
        )
    )
    session.add(
        StrategyRuntimeLedgerBucket(
            run_id="runtime-run-source",
            candidate_id="candidate",
            hypothesis_id="hypothesis",
            observed_stage="paper",
            bucket_started_at=datetime.now(timezone.utc),
            bucket_ended_at=datetime.now(timezone.utc),
            account_label="paper",
            runtime_strategy_name="demo-runtime",
            strategy_family="demo",
            fill_count=1,
            decision_count=1,
            submitted_order_count=1,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=1,
            open_position_count=0,
            filled_notional=Decimal("190.25"),
            gross_strategy_pnl=Decimal("3.00"),
            cost_amount=Decimal("0.50"),
            net_strategy_pnl_after_costs=Decimal("2.50"),
            post_cost_expectancy_bps=Decimal("12.50"),
            ledger_schema_version="torghut.runtime-ledger.v1",
            pnl_basis="post_cost",
            payload_json={"source": "test"},
        )
    )
    session.flush()


class FakeJournal:
    instances: list["FakeJournal"] = []

    def __init__(self, *, settings_obj: Settings) -> None:
        self.settings_obj = settings_obj
        self.events: list[str] = []
        self.executions: list[str] = []
        self.tca_metrics: list[str] = []
        self.runtime_buckets: list[str] = []
        self.stable_ref_backfills = 0
        self.reconciliation_client = SimpleNamespace(name="shared-tigerbeetle-client")
        self.closed = False
        FakeJournal.instances.append(self)

    def __enter__(self) -> "FakeJournal":
        return self

    def __exit__(self, *args: object) -> None:
        del args
        self.closed = True

    def journal_order_event(
        self,
        session: Session,
        event: ExecutionOrderEvent,
    ) -> object | None:
        del session
        self.events.append(event.event_fingerprint)
        if event.event_fingerprint == "skip":
            return None
        if event.event_fingerprint == "fail":
            raise RuntimeError("journal failed")
        if event.event_fingerprint == "timeout":
            raise TigerBeetleClientTimeoutError(
                "tigerbeetle_create_transfers_timeout:10.000s"
            )
        return SimpleNamespace(transfer_id="1")

    def journal_order_events(
        self,
        session: Session,
        events: Sequence[ExecutionOrderEvent],
    ) -> list[object | None]:
        return [self.journal_order_event(session, event) for event in events]

    def journal_execution(
        self, session: Session, execution: Execution
    ) -> object | None:
        del session
        self.executions.append(execution.alpaca_order_id)
        return SimpleNamespace(transfer_id="2")

    def journal_executions(
        self,
        session: Session,
        executions: Sequence[Execution],
    ) -> list[object | None]:
        return [self.journal_execution(session, execution) for execution in executions]

    def journal_execution_tca_metric(
        self,
        session: Session,
        metric: ExecutionTCAMetric,
    ) -> object | None:
        del session
        self.tca_metrics.append(metric.symbol)
        return SimpleNamespace(transfer_id="3")

    def journal_execution_tca_metrics(
        self,
        session: Session,
        metrics: Sequence[ExecutionTCAMetric],
    ) -> list[object | None]:
        return [
            self.journal_execution_tca_metric(session, metric) for metric in metrics
        ]

    def journal_runtime_ledger_bucket(
        self,
        session: Session,
        bucket: StrategyRuntimeLedgerBucket,
    ) -> object | None:
        del session
        self.runtime_buckets.append(bucket.run_id)
        return SimpleNamespace(transfer_id="4")

    def journal_runtime_ledger_buckets(
        self,
        session: Session,
        buckets: Sequence[StrategyRuntimeLedgerBucket],
    ) -> list[object | None]:
        return [
            self.journal_runtime_ledger_bucket(session, bucket) for bucket in buckets
        ]

    def client_for_reconciliation(self) -> object:
        return self.reconciliation_client

    def backfill_stable_ref_payloads(
        self,
        session: Session,
        *,
        limit: int = 1000,
    ) -> dict[str, object]:
        del session, limit
        self.stable_ref_backfills += 1
        return {"selected": 0, "updated": 0, "skipped": 0}


class _TestJournalTigerBeetleOrderEventsScriptBase(TestCase):
    def setUp(self) -> None:
        FakeJournal.instances = []
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def _add_runtime_bucket_with_ref(
        self,
        session: Session,
        *,
        run_id: str,
    ) -> tuple[StrategyRuntimeLedgerBucket, TigerBeetleTransferRef]:
        settings_obj = Settings(
            TORGHUT_TIGERBEETLE_ENABLED=True,
            TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
        )
        observed_at = datetime.now(timezone.utc)
        bucket = StrategyRuntimeLedgerBucket(
            run_id=run_id,
            candidate_id="candidate",
            hypothesis_id="hypothesis",
            observed_stage="paper",
            bucket_started_at=observed_at,
            bucket_ended_at=observed_at,
            account_label="paper",
            runtime_strategy_name="demo-runtime",
            strategy_family="demo",
            fill_count=1,
            decision_count=1,
            submitted_order_count=1,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=1,
            open_position_count=0,
            filled_notional=Decimal("190.25"),
            gross_strategy_pnl=Decimal("3.00"),
            cost_amount=Decimal("0.50"),
            net_strategy_pnl_after_costs=Decimal("2.50"),
            post_cost_expectancy_bps=Decimal("12.50"),
            ledger_schema_version="torghut.runtime-ledger.v1",
            pnl_basis="post_cost",
            payload_json={
                "source_refs": ["postgres:execution_order_events:event-1"],
                "source_row_counts": {"execution_order_events": 1},
                "source_window_refs": ["kafka:torghut.trade-updates.v1:0:1-2"],
            },
        )
        session.add(bucket)
        session.flush()
        ref = TigerBeetleTransferRef(
            cluster_id=settings_obj.tigerbeetle_cluster_id,
            transfer_id=str(340282366920938463463374607431768000 + int(bucket.id)),
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            ledger=LEDGER_USD_MICRO,
            code=TRANSFER_CODE_FILL_POST,
            amount=Decimal("2500000"),
            status="created",
            runtime_ledger_bucket_id=bucket.id,
            source_type=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id=str(bucket.id),
            payload_json={
                "debit_account_id": "100100100100100100100100100100100101",
                "credit_account_id": "100100100100100100100100100100100102",
            },
        )
        session.add(ref)
        session.flush()
        return bucket, ref
