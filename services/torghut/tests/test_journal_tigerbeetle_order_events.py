from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleTransferRef,
)
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_KIND_FILL_POST,
)
from scripts import journal_tigerbeetle_order_events as script


def _add_order_event(
    session: Session,
    *,
    fingerprint: str,
    account_label: str = "paper",
    event_type: str = "fill",
    status: str = "filled",
    source_offset: int = 1,
    has_amount: bool = True,
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
        avg_fill_price=Decimal("190.25") if has_amount else None,
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
        FakeJournal.instances.append(self)

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
        return SimpleNamespace(transfer_id="1")

    def journal_execution(
        self, session: Session, execution: Execution
    ) -> object | None:
        del session
        self.executions.append(execution.alpaca_order_id)
        return SimpleNamespace(transfer_id="2")

    def journal_execution_tca_metric(
        self,
        session: Session,
        metric: ExecutionTCAMetric,
    ) -> object | None:
        del session
        self.tca_metrics.append(metric.symbol)
        return SimpleNamespace(transfer_id="3")

    def journal_runtime_ledger_bucket(
        self,
        session: Session,
        bucket: StrategyRuntimeLedgerBucket,
    ) -> object | None:
        del session
        self.runtime_buckets.append(bucket.run_id)
        return SimpleNamespace(transfer_id="4")


class TestJournalTigerBeetleOrderEventsScript(TestCase):
    def setUp(self) -> None:
        FakeJournal.instances = []
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def test_sqlalchemy_dsn_normalizes_postgres_urls(self) -> None:
        self.assertEqual(
            script._sqlalchemy_dsn("postgres://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("postgresql://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("postgresql+psycopg://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(
            script._sqlalchemy_dsn("sqlite+pysqlite:///:memory:"),
            "sqlite+pysqlite:///:memory:",
        )

    def test_payload_summarizes_batches(self) -> None:
        args = argparse.Namespace(
            dry_run=True,
            dsn_env="SIM_DB_DSN",
            account_label="paper",
            batch_size=10000,
            max_batches=0,
            fail_on_degraded=False,
        )

        payload = script._payload(
            args=args,
            started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            batches=[
                {"selected": 2, "journaled": 1, "skipped": 0, "failed": 1},
                {"selected": 1, "journaled": 0, "skipped": 1, "failed": 0},
            ],
            reconciliation={"ok": True},
        )

        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["selected"], 3)
        self.assertEqual(payload["journaled"], 1)
        self.assertEqual(payload["skipped"], 1)
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(payload["batch_size"], 5000)
        self.assertEqual(payload["max_batches"], 1)

    def test_select_unlinked_events_filters_to_journalable_account_rows(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            selected = _add_order_event(
                session,
                fingerprint="selected",
                account_label="paper",
                source_offset=1,
            )
            _add_order_event(
                session,
                fingerprint="accepted-no-amount",
                account_label="paper",
                event_type="accepted",
                status="accepted",
                source_offset=2,
                has_amount=False,
            )
            _add_order_event(
                session,
                fingerprint="wrong-account",
                account_label="live",
                source_offset=3,
            )
            linked = _add_order_event(
                session,
                fingerprint="linked",
                account_label="paper",
                source_offset=4,
            )
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=settings_obj.tigerbeetle_cluster_id,
                    transfer_id="99",
                    transfer_kind=TRANSFER_KIND_FILL_POST,
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_FILL_POST,
                    amount=Decimal("190250000"),
                    status="created",
                    execution_order_event_id=linked.id,
                    event_fingerprint=linked.event_fingerprint,
                )
            )
            session.flush()

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
            )

        self.assertEqual([event.id for event in events], [selected.id])

    def test_main_journals_selected_events_and_reconciles(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="selected", source_offset=1)
                _add_real_source_rows(session)
                session.commit()

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--batch-size",
                        "10",
                        "--max-batches",
                        "2",
                        "--reconcile-limit",
                        "12",
                        "--json",
                    ],
                ),
                patch.object(script, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": True},
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["journaled"], 4)
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(FakeJournal.instances[0].events, ["selected"])
        self.assertEqual(FakeJournal.instances[0].executions, ["order-source"])
        self.assertEqual(FakeJournal.instances[0].tca_metrics, ["AAPL"])
        self.assertEqual(
            FakeJournal.instances[0].runtime_buckets,
            ["runtime-run-source"],
        )
        reconcile.assert_called_once()

    def test_main_dry_run_rolls_back_without_reconcile(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="selected", source_offset=1)
                session.commit()

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--dry-run",
                        "--json",
                    ],
                ),
                patch.object(script, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(script, "reconcile_tigerbeetle_transfers") as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["dry_run"])
        self.assertEqual(payload["journaled"], 1)
        reconcile.assert_not_called()

    def test_main_reports_degraded_for_failed_batch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="skip", source_offset=1)
                _add_order_event(session, fingerprint="fail", source_offset=2)
                session.commit()

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--batch-size",
                        "10",
                        "--json",
                    ],
                ),
                patch.object(script, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": False},
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["skipped"], 1)
        self.assertEqual(payload["failed"], 1)

    def test_main_can_fail_closed_for_degraded_batch(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="fail", source_offset=1)
                session.commit()

            stdout = io.StringIO()
            with (
                patch.dict(os.environ, {"TEST_DB_DSN": dsn}),
                patch.object(
                    sys,
                    "argv",
                    [
                        "journal_tigerbeetle_order_events.py",
                        "--dsn-env",
                        "TEST_DB_DSN",
                        "--batch-size",
                        "10",
                        "--fail-on-degraded",
                        "--json",
                    ],
                ),
                patch.object(script, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": False},
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertTrue(payload["fail_on_degraded"])

    def test_main_requires_dsn_env_var(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(
                sys,
                "argv",
                ["journal_tigerbeetle_order_events.py", "--dsn-env", "MISSING_DSN"],
            ),
            self.assertRaisesRegex(SystemExit, "missing DSN env var: MISSING_DSN"),
        ):
            script.main()
