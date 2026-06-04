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
    StrategyRuntimeLedgerBucket,
    TigerBeetleReconciliationRun,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
)
from app.trading import tigerbeetle_journal as journal_model
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
from scripts import run_tigerbeetle_journal_cron as cron_runner


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


class TestJournalTigerBeetleOrderEventsScript(TestCase):
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

    def test_parse_sources_accepts_aliases_and_deduplicates(self) -> None:
        self.assertEqual(
            script._parse_sources("execution,tca,cost,runtime_ledger"),
            (
                script.SOURCE_TYPE_EXECUTION,
                script.SOURCE_TYPE_EXECUTION_TCA_METRIC,
                script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            ),
        )
        self.assertEqual(script._parse_sources("all"), script.DEFAULT_SOURCES)
        with self.assertRaises(ValueError):
            script._parse_sources("unknown-source")

    def test_tigerbeetle_status_decoder_uses_operation_specific_enum(self) -> None:
        fake_tigerbeetle = SimpleNamespace(
            CreateAccountStatus=SimpleNamespace(exists=21),
            CreateTransferStatus=SimpleNamespace(debit_account_not_found=21),
        )

        with patch.dict(sys.modules, {"tigerbeetle": fake_tigerbeetle}):
            self.assertEqual(
                journal_model._result_statuses_by_index(
                    [{"index": 0, "status": 21}],
                    count=1,
                    default_status="created",
                    status_type_names=("CreateAccountStatus",),
                ),
                {0: "exists"},
            )
            self.assertEqual(
                journal_model._result_statuses_by_index(
                    [{"index": 0, "status": 21}],
                    count=1,
                    default_status="created",
                    status_type_names=("CreateTransferStatus",),
                ),
                {0: "debit_account_not_found"},
            )

    def test_payload_summarizes_batches(self) -> None:
        args = argparse.Namespace(
            dry_run=True,
            dsn_env="SIM_DB_DSN",
            account_label="paper",
            batch_size=10000,
            max_batches=0,
            event_scan_limit=1000,
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
        self.assertEqual(payload["event_scan_limit"], 1000)

    def test_payload_degrades_when_reconciliation_fails(self) -> None:
        args = argparse.Namespace(
            dry_run=False,
            dsn_env="SIM_DB_DSN",
            account_label="paper",
            batch_size=500,
            max_batches=1,
            event_scan_limit=None,
            fail_on_degraded=True,
            skip_reconcile=False,
            sources="all",
            supervised_worker=False,
            supervise_timeout_seconds=0.0,
            allow_data_quality_degraded=False,
        )

        payload = script._payload(
            args=args,
            started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            batches=[
                {"selected": 1, "journaled": 1, "skipped": 0, "failed": 0},
            ],
            reconciliation={"ok": False, "blockers": ["tigerbeetle_transfer_missing"]},
        )

        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["failed"], 0)
        self.assertTrue(payload["fail_on_degraded"])
        self.assertTrue(payload["exit_nonzero"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])

    def test_payload_keeps_data_quality_blockers_visible_without_promotion_authority(
        self,
    ) -> None:
        args = argparse.Namespace(
            dry_run=False,
            dsn_env="SIM_DB_DSN",
            account_label="TORGHUT_SIM",
            batch_size=500,
            max_batches=1,
            event_scan_limit=None,
            fail_on_degraded=True,
            skip_reconcile=False,
            sources="all",
            supervised_worker=False,
            supervise_timeout_seconds=0.0,
            allow_data_quality_degraded=True,
        )

        payload = script._payload(
            args=args,
            started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            batches=[
                {"selected": 0, "journaled": 0, "skipped": 0, "failed": 0},
            ],
            reconciliation={
                "ok": False,
                "blockers": [
                    "tigerbeetle_source_amount_mismatch",
                    "tigerbeetle_unlinked_execution_cost",
                ],
                "promotion_authority": False,
                "overrides_runtime_ledger_authority": False,
            },
        )

        self.assertEqual(payload["status"], "degraded")
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["exit_nonzero"])
        self.assertEqual(payload["exit_policy"], "fail_on_hard_failures_only")
        self.assertEqual(payload["hard_failure_reasons"], [])
        self.assertEqual(
            payload["accounting_blockers"],
            [
                "tigerbeetle_source_amount_mismatch",
                "tigerbeetle_unlinked_execution_cost",
            ],
        )
        self.assertEqual(
            payload["reconciliation_blockers"],
            [
                "tigerbeetle_source_amount_mismatch",
                "tigerbeetle_unlinked_execution_cost",
            ],
        )
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])

    def test_supervised_worker_timeout_emits_degraded_payload(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    "execution",
                    "--batch-size",
                    "50",
                    "--max-batches",
                    "1",
                    "--fail-on-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                side_effect=subprocess.TimeoutExpired(
                    cmd=["python", "journal_tigerbeetle_order_events.py"],
                    timeout=0.01,
                ),
            ) as run_mock,
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 1)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["stopped_early"])
        self.assertEqual(
            payload["stop_reasons"],
            ["tigerbeetle_journal_worker_timeout"],
        )
        self.assertEqual(payload["failed"], 1)
        self.assertTrue(payload["exit_nonzero"])
        self.assertEqual(
            payload["hard_failure_reasons"],
            ["journal_batch_failures", "tigerbeetle_journal_worker_timeout"],
        )
        self.assertEqual(
            payload["reconciliation"]["reason"],
            "tigerbeetle_journal_worker_timeout",
        )
        self.assertIn("supervised_worker_timeout", stderr.getvalue())
        self.assertIn("--supervised-worker", run_mock.call_args.args[0])
        self.assertEqual(run_mock.call_args.kwargs["timeout"], 0.01)
        self.assertTrue(run_mock.call_args.kwargs["capture_output"])
        self.assertTrue(run_mock.call_args.kwargs["text"])

    def test_supervised_worker_splits_multi_source_timeout_budget(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    "execution,execution_tca_metric",
                    "--batch-size",
                    "50",
                    "--max-batches",
                    "1",
                    "--fail-on-degraded",
                    "--allow-data-quality-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                side_effect=[
                    subprocess.CompletedProcess(
                        args=["python", "journal_tigerbeetle_order_events.py"],
                        returncode=0,
                    ),
                    subprocess.TimeoutExpired(
                        cmd=["python", "journal_tigerbeetle_order_events.py"],
                        timeout=0.01,
                    ),
                ],
            ) as run_mock,
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 1)
        self.assertEqual(run_mock.call_count, 2)
        first_argv = run_mock.call_args_list[0].args[0]
        second_argv = run_mock.call_args_list[1].args[0]
        self.assertEqual(
            first_argv[first_argv.index("--sources") + 1],
            script.SOURCE_TYPE_EXECUTION,
        )
        self.assertEqual(
            second_argv[second_argv.index("--sources") + 1],
            script.SOURCE_TYPE_EXECUTION_TCA_METRIC,
        )
        self.assertIn("--supervised-worker", first_argv)
        self.assertIn("--supervised-worker", second_argv)
        self.assertEqual(run_mock.call_args_list[0].kwargs["timeout"], 0.01)
        self.assertEqual(run_mock.call_args_list[1].kwargs["timeout"], 0.01)
        self.assertTrue(run_mock.call_args_list[0].kwargs["capture_output"])
        self.assertTrue(run_mock.call_args_list[1].kwargs["capture_output"])

        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["sources"], [script.SOURCE_TYPE_EXECUTION_TCA_METRIC])
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["exit_nonzero"])
        self.assertEqual(
            payload["hard_failure_reasons"],
            ["journal_batch_failures", "tigerbeetle_journal_worker_timeout"],
        )
        self.assertIn("supervised_worker_timeout", stderr.getvalue())
        self.assertIn(script.SOURCE_TYPE_EXECUTION_TCA_METRIC, stderr.getvalue())
        self.assertNotIn(
            f'"{script.SOURCE_TYPE_EXECUTION}","{script.SOURCE_TYPE_EXECUTION_TCA_METRIC}"',
            stderr.getvalue(),
        )

    def test_supervised_worker_normalizes_safe_payload_exit_mismatch(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        safe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "ok": False,
            "status": "degraded",
            "authority": "non_authoritative_tigerbeetle_journal_telemetry",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": False,
            "failed": 0,
            "hard_failure_reasons": [],
            "stop_reasons": [],
            "accounting_blockers": ["tigerbeetle_unlinked_execution"],
            "reconciliation_blockers": ["tigerbeetle_unlinked_execution"],
            "sources": [script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET],
        }

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    "--batch-size",
                    "5",
                    "--max-batches",
                    "1",
                    "--fail-on-degraded",
                    "--allow-data-quality-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["python", "journal_tigerbeetle_order_events.py"],
                    returncode=1,
                    stdout=json.dumps(safe_payload, separators=(",", ":")) + "\n",
                    stderr="",
                ),
            ),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue()), safe_payload)
        progress = json.loads(stderr.getvalue())
        self.assertEqual(
            progress["event"],
            "supervised_worker_exit_mismatch_normalized",
        )
        self.assertEqual(progress["returncode"], 1)
        self.assertEqual(
            progress["sources"],
            [script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET],
        )
        self.assertEqual(
            progress["accounting_blockers"],
            ["tigerbeetle_unlinked_execution"],
        )

    def test_supervised_worker_keeps_unsafe_payload_exit_nonzero(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        unsafe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "ok": False,
            "status": "degraded",
            "authority": "non_authoritative_tigerbeetle_journal_telemetry",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": True,
            "failed": 1,
            "hard_failure_reasons": ["journal_batch_failures"],
            "stop_reasons": [],
            "accounting_blockers": [],
            "reconciliation_blockers": [],
            "sources": [script.SOURCE_TYPE_EXECUTION],
        }

        with (
            patch.dict(os.environ, {"DB_DSN": "sqlite+pysqlite:///:memory:"}),
            patch.object(
                sys,
                "argv",
                [
                    "journal_tigerbeetle_order_events.py",
                    "--dsn-env",
                    "DB_DSN",
                    "--sources",
                    script.SOURCE_TYPE_EXECUTION,
                    "--batch-size",
                    "5",
                    "--max-batches",
                    "1",
                    "--fail-on-degraded",
                    "--json",
                    "--supervise-timeout-seconds",
                    "0.01",
                ],
            ),
            patch(
                "scripts.journal_tigerbeetle_order_events.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=["python", "journal_tigerbeetle_order_events.py"],
                    returncode=1,
                    stdout=json.dumps(unsafe_payload, separators=(",", ":")) + "\n",
                    stderr="",
                ),
            ),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            exit_code = script.main()

        self.assertEqual(exit_code, 1)
        self.assertEqual(json.loads(stdout.getvalue()), unsafe_payload)
        self.assertEqual(stderr.getvalue(), "")

    def test_last_journal_payload_skips_worker_noise_and_invalid_json(self) -> None:
        first_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "status": "stale",
        }
        final_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "status": "degraded",
            "exit_nonzero": False,
        }

        payload = script._last_journal_payload(
            "\n".join(
                [
                    "worker booted before json output",
                    "{invalid-json",
                    json.dumps({"schema_version": "unrelated.worker.v1"}),
                    json.dumps(first_payload, separators=(",", ":")),
                    "worker flushed trailing progress",
                    json.dumps(final_payload, separators=(",", ":")),
                ]
            )
        )

        self.assertEqual(payload, final_payload)

    def test_safe_payload_rejects_unsafe_supervised_exit_mismatches(self) -> None:
        safe_payload = {
            "schema_version": "torghut.tigerbeetle-journal-order-events.v1",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "exit_nonzero": False,
            "failed": 0,
            "hard_failure_reasons": [],
            "stop_reasons": [],
        }
        unsafe_cases = [
            ("missing_payload", None),
            ("wrong_schema", {**safe_payload, "schema_version": "unrelated.worker.v1"}),
            ("promotion_authority", {**safe_payload, "promotion_authority": True}),
            (
                "runtime_ledger_authority_override",
                {**safe_payload, "overrides_runtime_ledger_authority": True},
            ),
            ("failed_rows", {**safe_payload, "failed": 2}),
            (
                "hard_failure_reasons",
                {**safe_payload, "hard_failure_reasons": ["journal_batch_failures"]},
            ),
            (
                "scalar_stop_reason",
                {**safe_payload, "stop_reasons": "tigerbeetle_rpc_timeout"},
            ),
        ]

        self.assertTrue(script._safe_payload_allows_success(safe_payload))
        for label, payload in unsafe_cases:
            with self.subTest(label=label):
                self.assertFalse(script._safe_payload_allows_success(payload))

    def test_torghut_cronjob_keeps_live_sources_split_and_honest(self) -> None:
        manifest = (
            Path(__file__).resolve().parents[3]
            / "argocd/applications/torghut/tigerbeetle-journal-order-events-cronjob.yaml"
        ).read_text()
        cases = {
            "torghut-tigerbeetle-journal-order-events-live": (
                "--preset live",
                cron_runner._live_commands(execution_batch_size=10),
            ),
            "torghut-tigerbeetle-journal-order-events-sim": (
                "--preset sim",
                cron_runner._sim_commands(),
            ),
        }
        for cronjob_name, (preset_arg, commands) in cases.items():
            section = manifest.split(f"name: {cronjob_name}", 1)[1]
            if "---" in section:
                section = section.split("---", 1)[0]
            self.assertIn("scripts/run_tigerbeetle_journal_cron.py", section)
            self.assertIn(preset_arg, section)
            self.assertEqual(
                [command.source for command in commands],
                [
                    script.SOURCE_TYPE_EXECUTION,
                    script.SOURCE_TYPE_EXECUTION_TCA_METRIC,
                    script.SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                    script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                ],
            )
            self.assertNotIn("execution,execution_tca_metric", section)
            self.assertEqual(section.count("--supervise-timeout-seconds 120"), 1)
            command_argvs = [
                cron_runner._argv_for_command(
                    command,
                    json_output=True,
                    supervise_timeout_seconds=45.0,
                )
                for command in commands
            ]
            source_args = [argv[argv.index("--sources") + 1] for argv in command_argvs]
            self.assertEqual(source_args, [command.source for command in commands])
            self.assertTrue(all("," not in source for source in source_args))
            if cronjob_name == "torghut-tigerbeetle-journal-order-events-live":
                order_event_argv = command_argvs[2]
                self.assertEqual(
                    order_event_argv[order_event_argv.index("--batch-size") + 1],
                    str(cron_runner.LIVE_ORDER_EVENT_BATCH_SIZE),
                )
                self.assertEqual(
                    order_event_argv[order_event_argv.index("--max-batches") + 1],
                    "1",
                )
            runtime_argv = command_argvs[-1]
            self.assertEqual(
                runtime_argv[runtime_argv.index("--sources") + 1],
                script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            )
            if cronjob_name == "torghut-tigerbeetle-journal-order-events-live":
                self.assertIn("--reconcile-empty-selection", runtime_argv)
                self.assertEqual(
                    runtime_argv[runtime_argv.index("--reconcile-limit") + 1],
                    str(cron_runner.LIVE_RECONCILE_LIMIT),
                )
            else:
                self.assertIn("--reconcile-empty-selection", runtime_argv)
            self.assertIn("--fail-on-degraded", runtime_argv)
            self.assertIn("--allow-data-quality-degraded", runtime_argv)

    def test_process_rows_attaches_runtime_bucket_journal_payload(self) -> None:
        settings_obj = Settings(
            TORGHUT_TIGERBEETLE_ENABLED=True,
            TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
        )
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-journal-attach",
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
                transfer_id="340282366920938463463374607431768211",
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

            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(dry_run=False),
                source=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                rows=[bucket],
                journal_one=lambda row: ref,
            )

        self.assertEqual(batch["journaled"], 1)
        self.assertEqual(batch["failed"], 0)
        payload = bucket.payload_json
        self.assertIsInstance(payload, dict)
        self.assertIn("postgres:execution_order_events:event-1", payload["source_refs"])
        self.assertIn(
            f"postgres:strategy_runtime_ledger_buckets:{bucket.id}",
            payload["source_refs"],
        )
        self.assertIn(
            f"postgres:tigerbeetle_transfer_refs:{ref.id}",
            payload["source_refs"],
        )
        self.assertEqual(
            payload["source_row_counts"]["tigerbeetle_transfer_refs"],
            1,
        )
        self.assertEqual(
            payload["tigerbeetle_transfer_ids"],
            ["340282366920938463463374607431768211"],
        )
        self.assertEqual(
            payload["tigerbeetle_journal_parity"]["status"],
            "pass",
        )
        self.assertFalse(
            payload["tigerbeetle_journal_parity"]["promotion_authority"],
        )

    def test_source_batch_uses_batch_refs_for_runtime_attach_and_skips(self) -> None:
        with Session(self.engine) as session:
            bucket, ref = self._add_runtime_bucket_with_ref(
                session,
                run_id="runtime-run-batch-attach",
            )
            skipped = SimpleNamespace(id="skipped-runtime-row")

            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(dry_run=False, progress_interval=0),
                source=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                rows=[bucket, skipped],
                journal_one=lambda row: (_ for _ in ()).throw(
                    AssertionError(f"unexpected row fallback: {row!r}")
                ),
                journal_many=lambda rows: [ref, None],
            )

        self.assertEqual(batch["journaled"], 1)
        self.assertEqual(batch["skipped"], 1)
        self.assertEqual(batch["failed"], 0)
        payload = bucket.payload_json
        self.assertIsInstance(payload, dict)
        self.assertIn(
            f"postgres:tigerbeetle_transfer_refs:{ref.id}",
            payload["source_refs"],
        )
        self.assertEqual(
            payload["tigerbeetle_transfer_ids"],
            [ref.transfer_id],
        )

    def test_source_batch_chunks_batch_refs_and_commits_between_chunks(self) -> None:
        rows = [
            SimpleNamespace(id="row-1"),
            SimpleNamespace(id="row-2"),
            SimpleNamespace(id="row-3"),
        ]
        calls: list[list[str]] = []

        class ChunkSession:
            commits = 0

            def begin_nested(self) -> object:
                return nullcontext()

            def commit(self) -> None:
                self.commits += 1

            def expunge_all(self) -> None:
                return None

        session = ChunkSession()

        batch = script._journal_source_batch(
            session,
            args=argparse.Namespace(
                dry_run=False,
                progress_interval=0,
                commit_each_row=True,
                journal_batch_chunk_size=2,
            ),
            source=script.SOURCE_TYPE_EXECUTION_TCA_METRIC,
            rows=rows,
            journal_one=lambda row: (_ for _ in ()).throw(
                AssertionError(f"unexpected row fallback: {row!r}")
            ),
            journal_many=lambda chunk: (
                calls.append([str(getattr(row, "id")) for row in chunk])
                or [object() for _ in chunk]
            ),
        )

        self.assertEqual(calls, [["row-1", "row-2"], ["row-3"]])
        self.assertEqual(session.commits, 2)
        self.assertEqual(batch["journaled"], 3)
        self.assertEqual(batch["failed"], 0)
        self.assertEqual(batch["journal_batch_chunk_size"], 2)
        self.assertEqual(batch["journal_batch_chunks"], 2)

    def test_source_batch_falls_back_from_count_mismatch_and_stops_on_timeout(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket, ref = self._add_runtime_bucket_with_ref(
                session,
                run_id="runtime-run-fallback-attach",
            )
            bucket_id = bucket.id
            ref_id = ref.id
            timeout_row = SimpleNamespace(id="timeout-row")
            seen: list[str] = []

            def journal_one(row: object) -> object:
                seen.append(str(getattr(row, "id", "unknown")))
                if row is timeout_row:
                    raise TigerBeetleClientTimeoutError(
                        "tigerbeetle_create_transfers_timeout:10.000s"
                    )
                return ref

            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(
                    dry_run=False,
                    progress_interval=0,
                    commit_each_row=True,
                ),
                source=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                rows=[bucket, timeout_row],
                journal_one=journal_one,
                journal_many=lambda rows: [],
            )
            persisted_bucket = session.get(StrategyRuntimeLedgerBucket, bucket_id)
            self.assertIsNotNone(persisted_bucket)
            assert persisted_bucket is not None
            payload = persisted_bucket.payload_json

        self.assertEqual(seen, [str(bucket_id), "timeout-row"])
        self.assertEqual(batch["journaled"], 1)
        self.assertEqual(batch["failed"], 1)
        self.assertTrue(batch["stopped_early"])
        self.assertEqual(batch["stop_reason"], "tigerbeetle_rpc_timeout")
        self.assertEqual(
            batch["error_counts"],
            {
                "TigerBeetleClientTimeoutError:tigerbeetle_create_transfers_timeout:10.000s": 1
            },
        )
        self.assertIsInstance(payload, dict)
        self.assertIn(
            f"postgres:tigerbeetle_transfer_refs:{ref_id}",
            payload["source_refs"],
        )

    def test_runtime_bucket_journal_materializes_signed_ref_and_is_idempotent(
        self,
    ) -> None:
        settings_obj = Settings(
            TORGHUT_TIGERBEETLE_ENABLED=True,
            TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
        )
        client = FakeTigerBeetleClient()
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-signed-ref",
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
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None

            with TigerBeetleLedgerJournal(
                settings_obj=settings_obj,
                client=client,
            ) as journal:
                ref = journal.journal_runtime_ledger_bucket(session, bucket)
                self.assertIsNotNone(ref)
                assert ref is not None
                script._attach_runtime_bucket_journal_payload(bucket, ref)
                ref_again = journal.journal_runtime_ledger_bucket(session, bucket)

            session.flush()
            payload = ref.payload_json
            self.assertIsInstance(payload, dict)
            transfer = plan.transfer_spec
            self.assertEqual(ref_again, ref)
            self.assertEqual(ref.runtime_ledger_bucket_id, bucket.id)
            self.assertEqual(ref.source_type, script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET)
            self.assertEqual(ref.source_id, str(bucket.id))
            self.assertEqual(ref.transfer_id, str(transfer.transfer_id))
            self.assertEqual(payload["signed_amount_micros"], plan.signed_amount_micros)
            self.assertEqual(payload["pnl_direction"], plan.pnl_direction)
            self.assertEqual(
                payload["debit_account_id"], str(transfer.debit_account_id)
            )
            self.assertEqual(
                payload["credit_account_id"],
                str(transfer.credit_account_id),
            )
            self.assertEqual(len(client.transfers), 1)
            self.assertEqual(len(client.accounts), 4)
            self.assertEqual(
                len(
                    session.execute(
                        select(TigerBeetleTransferRef).where(
                            TigerBeetleTransferRef.source_type
                            == script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                            TigerBeetleTransferRef.source_id == str(bucket.id),
                        )
                    )
                    .scalars()
                    .all()
                ),
                1,
            )
            self.assertEqual(
                len(session.execute(select(TigerBeetleAccountRef)).scalars().all()),
                4,
            )
            self.assertEqual(
                script._select_unlinked_runtime_buckets(
                    session,
                    settings_obj=settings_obj,
                    account_label="paper",
                    limit=10,
                ),
                [],
            )

    def test_source_batch_stops_on_tigerbeetle_timeout(self) -> None:
        rows = [SimpleNamespace(id="first"), SimpleNamespace(id="second")]
        seen: list[str] = []

        def journal_one(row: SimpleNamespace) -> object:
            seen.append(str(row.id))
            raise TigerBeetleClientTimeoutError(
                "tigerbeetle_create_transfers_timeout:10.000s"
            )

        with Session(self.engine) as session:
            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(dry_run=False, progress_interval=0),
                source=script.SOURCE_TYPE_EXECUTION,
                rows=rows,
                journal_one=journal_one,
            )

        self.assertEqual(seen, ["first"])
        self.assertEqual(batch["failed"], 1)
        self.assertTrue(batch["stopped_early"])
        self.assertEqual(batch["stop_reason"], "tigerbeetle_rpc_timeout")
        self.assertEqual(
            batch["error_counts"],
            {
                "TigerBeetleClientTimeoutError:tigerbeetle_create_transfers_timeout:10.000s": 1
            },
        )

    def test_source_batch_can_commit_successful_rows_individually(self) -> None:
        class FakeNested:
            def __enter__(self) -> None:
                return None

            def __exit__(self, *args: object) -> bool:
                del args
                return False

        class FakeSession:
            commits = 0
            expunges = 0

            def begin_nested(self) -> FakeNested:
                return FakeNested()

            def commit(self) -> None:
                self.commits += 1

            def expunge_all(self) -> None:
                self.expunges += 1

        session = FakeSession()
        rows = [SimpleNamespace(id="first"), SimpleNamespace(id="second")]
        stderr = io.StringIO()

        with redirect_stderr(stderr):
            batch = script._journal_source_batch(
                session,
                args=argparse.Namespace(
                    dry_run=False,
                    progress_interval=1,
                    commit_each_row=True,
                ),
                source=script.SOURCE_TYPE_EXECUTION,
                rows=rows,
                journal_one=lambda row: object(),
            )

        self.assertEqual(batch["journaled"], 2)
        self.assertEqual(batch["failed"], 0)
        self.assertEqual(session.commits, 2)
        self.assertEqual(session.expunges, 2)
        events = [
            json.loads(line) for line in stderr.getvalue().splitlines() if line.strip()
        ]
        row_start_events = [
            event for event in events if event["event"] == "source_row_start"
        ]
        self.assertEqual(
            [event["row_id"] for event in row_start_events],
            ["first", "second"],
        )

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
                event_scan_limit=10,
            )

        self.assertEqual([event.id for event in events.rows], [selected.id])
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_events_rounds_high_precision_amount_rows(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            rounded = _add_order_event(
                session,
                fingerprint="rounded-precision",
                account_label="paper",
                source_offset=1,
            )
            rounded.avg_fill_price = Decimal("190.2500001")
            selected = _add_order_event(
                session,
                fingerprint="selected",
                account_label="paper",
                source_offset=2,
            )
            session.add_all([rounded, selected])
            session.flush()

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
                event_scan_limit=10,
            )

        self.assertEqual(
            [event.event_fingerprint for event in events.rows],
            ["rounded-precision", "selected"],
        )
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_events_honors_scan_limit(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            rounded = _add_order_event(
                session,
                fingerprint="rounded-precision",
                account_label="paper",
                source_offset=1,
            )
            rounded.avg_fill_price = Decimal("190.2500001")
            _add_order_event(
                session,
                fingerprint="selected",
                account_label="paper",
                source_offset=2,
            )
            session.add(rounded)
            session.flush()

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
                event_scan_limit=1,
            )

        self.assertEqual(
            [event.event_fingerprint for event in events.rows], ["rounded-precision"]
        )
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_events_stops_after_limit(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            first = _add_order_event(
                session,
                fingerprint="selected-1",
                account_label="paper",
                source_offset=1,
            )
            _add_order_event(
                session,
                fingerprint="selected-2",
                account_label="paper",
                source_offset=2,
            )
            session.commit()

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
                event_scan_limit=10,
            )

        self.assertEqual([event.id for event in events.rows], [first.id])
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_events_accepts_sub_micro_notional_rows(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            selected = _add_order_event(
                session,
                fingerprint="sub-micro-notional",
                account_label="paper",
                avg_fill_price=Decimal("1.0000005"),
            )

            events = script._select_unlinked_events(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
            )

        self.assertEqual([event.id for event in events.rows], [selected.id])
        self.assertEqual(events.scan_failed, 0)

    def test_select_unlinked_executions_uses_direct_ref_fk(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            linked = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-linked",
                client_order_id="client-linked",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-linked"},
            )
            selected = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-selected",
                client_order_id="client-selected",
                symbol="MSFT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("410.50"),
                status="filled",
                raw_order={"id": "order-selected"},
            )
            session.add_all([linked, selected])
            session.flush()
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=settings_obj.tigerbeetle_cluster_id,
                    transfer_id="12001",
                    transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_FILL_POST,
                    amount=Decimal("190250000"),
                    status="created",
                    execution_id=linked.id,
                )
            )
            session.flush()

            executions = script._select_unlinked_executions(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
            )

        self.assertEqual([row.id for row in executions], [selected.id])

    def test_select_unlinked_executions_prioritizes_reconciliation_window(
        self,
    ) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            older = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-older-window",
                client_order_id="client-older-window",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-older-window"},
                created_at=observed_at - timedelta(minutes=5),
                updated_at=observed_at - timedelta(minutes=5),
            )
            newer = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-newer-window",
                client_order_id="client-newer-window",
                symbol="MSFT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("410.50"),
                status="filled",
                raw_order={"id": "order-newer-window"},
                created_at=observed_at,
                updated_at=observed_at,
            )
            session.add_all([older, newer])
            session.flush()

            executions = script._select_unlinked_executions(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

        self.assertEqual([row.id for row in executions], [newer.id])

    def test_select_unlinked_tca_metrics_uses_direct_ref_fk(self) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        with Session(self.engine) as session:
            linked_execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-tca-linked",
                client_order_id="client-tca-linked",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-tca-linked"},
            )
            selected_execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-tca-selected",
                client_order_id="client-tca-selected",
                symbol="MSFT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("410.50"),
                status="filled",
                raw_order={"id": "order-tca-selected"},
            )
            session.add_all([linked_execution, selected_execution])
            session.flush()
            linked = ExecutionTCAMetric(
                execution_id=linked_execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                computed_at=datetime.now(timezone.utc),
            )
            selected = ExecutionTCAMetric(
                execution_id=selected_execution.id,
                alpaca_account_label="paper",
                symbol="MSFT",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.35"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add_all([linked, selected])
            session.flush()
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=settings_obj.tigerbeetle_cluster_id,
                    transfer_id="12002",
                    transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_FILL_POST,
                    amount=Decimal("250000"),
                    status="created",
                    execution_id=linked_execution.id,
                    execution_tca_metric_id=linked.id,
                )
            )
            session.flush()

            metrics = script._select_unlinked_tca_metrics(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=10,
            )

        self.assertEqual([row.id for row in metrics], [selected.id])

    def test_select_unlinked_tca_metrics_prioritizes_reconciliation_window(
        self,
    ) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            older_execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-older-tca-window",
                client_order_id="client-older-tca-window",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-older-tca-window"},
            )
            newer_execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-newer-tca-window",
                client_order_id="client-newer-tca-window",
                symbol="MSFT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("410.50"),
                status="filled",
                raw_order={"id": "order-newer-tca-window"},
            )
            session.add_all([older_execution, newer_execution])
            session.flush()
            older = ExecutionTCAMetric(
                execution_id=older_execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                computed_at=observed_at - timedelta(minutes=5),
                created_at=observed_at - timedelta(minutes=5),
                updated_at=observed_at - timedelta(minutes=5),
            )
            newer = ExecutionTCAMetric(
                execution_id=newer_execution.id,
                alpaca_account_label="paper",
                symbol="MSFT",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.35"),
                computed_at=observed_at,
                created_at=observed_at,
                updated_at=observed_at,
            )
            session.add_all([older, newer])
            session.flush()

            metrics = script._select_unlinked_tca_metrics(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

        self.assertEqual([row.id for row in metrics], [newer.id])

    def test_select_runtime_buckets_repairs_unsigned_legacy_ref_materialization(
        self,
    ) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-legacy-ref",
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
                payload_json={"source": "test"},
            )
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            transfer = plan.transfer_spec
            legacy_ref = TigerBeetleTransferRef(
                cluster_id=settings_obj.tigerbeetle_cluster_id,
                transfer_id=str(transfer.transfer_id),
                transfer_kind=transfer.transfer_kind,
                ledger=transfer.ledger,
                code=transfer.code,
                amount=Decimal(transfer.amount),
                status="created",
                source_type=script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                source_id=str(bucket.id),
                payload_json={
                    "source": script.SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    "account_ids": [
                        str(transfer.debit_account_id),
                        str(transfer.credit_account_id),
                    ],
                },
            )
            session.add(legacy_ref)
            session.flush()

            selected = script._select_unlinked_runtime_buckets(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

            self.assertEqual([row.id for row in selected], [bucket.id])
            self.assertEqual(
                script._payload_mapping(legacy_ref), legacy_ref.payload_json
            )
            self.assertFalse(
                script._payload_int_matches(
                    {"signed_amount_micros": "not-an-int"},
                    "signed_amount_micros",
                    plan.signed_amount_micros,
                )
            )

            legacy_ref.runtime_ledger_bucket_id = bucket.id
            session.add(legacy_ref)
            session.flush()
            selected_after_fk_repair = script._select_unlinked_runtime_buckets(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

            legacy_ref.payload_json = {
                **legacy_ref.payload_json,
                "signed_amount_micros": plan.signed_amount_micros,
                "pnl_direction": plan.pnl_direction,
                "debit_account_id": str(transfer.debit_account_id),
                "credit_account_id": str(transfer.credit_account_id),
            }
            session.add(legacy_ref)
            session.flush()
            selected_after_signed_materialization = (
                script._select_unlinked_runtime_buckets(
                    session,
                    settings_obj=settings_obj,
                    account_label="paper",
                    limit=10,
                )
            )
            legacy_ref.payload_json = None
            bucket.net_strategy_pnl_after_costs = Decimal("0")
            bucket.cost_amount = Decimal("0")
            self.assertEqual(script._payload_mapping(legacy_ref), {})
            self.assertFalse(
                script._runtime_ref_matches_signed_bucket(legacy_ref, bucket)
            )

        self.assertEqual([row.id for row in selected_after_fk_repair], [bucket.id])
        self.assertEqual(selected_after_signed_materialization, [])

    def test_runtime_signed_ref_helpers_fail_closed_on_unusable_payloads(
        self,
    ) -> None:
        observed_at = datetime.now(timezone.utc)
        bucket = StrategyRuntimeLedgerBucket(
            run_id="runtime-run-unjournalable",
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
            gross_strategy_pnl=Decimal("0"),
            cost_amount=Decimal("0"),
            net_strategy_pnl_after_costs=Decimal("0"),
            post_cost_expectancy_bps=Decimal("0"),
            ledger_schema_version="torghut.runtime-ledger.v1",
            pnl_basis="post_cost",
            payload_json={"source": "test"},
        )
        ref = TigerBeetleTransferRef(
            transfer_id="0",
            transfer_kind=script.TRANSFER_KIND_RUNTIME_NET_PNL,
            amount=Decimal("0"),
            payload_json="not-a-mapping",
        )

        self.assertEqual(script._payload_mapping(ref), {})
        self.assertFalse(script._payload_int_matches({"value": object()}, "value", 1))
        self.assertFalse(script._runtime_ref_matches_signed_bucket(ref, bucket))

    def test_select_runtime_buckets_stops_at_limit(
        self,
    ) -> None:
        settings_obj = Settings(TORGHUT_TIGERBEETLE_ENABLED=True)
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-limit",
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
                payload_json={"source": "test"},
            )
            session.add(bucket)
            session.flush()

            selected = script._select_unlinked_runtime_buckets(
                session,
                settings_obj=settings_obj,
                account_label="paper",
                limit=1,
            )

        self.assertEqual([row.id for row in selected], [bucket.id])

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
        self.assertEqual(
            payload["schema_version"],
            "torghut.tigerbeetle-journal-order-events.v1",
        )
        self.assertTrue(payload["ok"])
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
        self.assertIs(
            reconcile.call_args.kwargs["client"],
            FakeJournal.instances[0].reconciliation_client,
        )

    def test_main_can_target_tca_metrics_without_reconcile(self) -> None:
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
                        "--sources",
                        "execution_tca_metric",
                        "--batch-size",
                        "10",
                        "--max-batches",
                        "2",
                        "--skip-reconcile",
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
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["sources"], [script.SOURCE_TYPE_EXECUTION_TCA_METRIC])
        self.assertTrue(payload["skip_reconcile"])
        self.assertEqual(payload["journaled"], 1)
        self.assertEqual(FakeJournal.instances[0].events, [])
        self.assertEqual(FakeJournal.instances[0].executions, [])
        self.assertEqual(FakeJournal.instances[0].tca_metrics, ["AAPL"])
        self.assertEqual(FakeJournal.instances[0].runtime_buckets, [])
        reconcile.assert_not_called()

    def test_main_skips_backfill_and_reconcile_when_source_selects_no_rows(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)

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
                        "--sources",
                        "strategy_runtime_ledger_bucket",
                        "--batch-size",
                        "5",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
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
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["selected"], 0)
        self.assertEqual(payload["journaled"], 0)
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["reconciliation"]["status"], "skipped")
        self.assertEqual(payload["reconciliation"]["reason"], "no_source_rows_selected")
        self.assertFalse(payload["reconcile_empty_selection"])
        self.assertEqual(FakeJournal.instances[0].runtime_buckets, [])
        self.assertEqual(FakeJournal.instances[0].stable_ref_backfills, 0)
        reconcile.assert_not_called()

    def test_main_can_reconcile_when_source_selects_no_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)

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
                        "--sources",
                        "strategy_runtime_ledger_bucket",
                        "--batch-size",
                        "5",
                        "--reconcile-limit",
                        "12",
                        "--reconcile-empty-selection",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": True, "status": "ok"},
                ) as reconcile,
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["selected"], 0)
        self.assertTrue(payload["reconcile_empty_selection"])
        self.assertEqual(payload["reconciliation"]["status"], "ok")
        self.assertEqual(FakeJournal.instances[0].stable_ref_backfills, 0)
        reconcile.assert_called_once()
        self.assertEqual(reconcile.call_args.kwargs["limit"], 12)
        self.assertIs(
            reconcile.call_args.kwargs["client"],
            FakeJournal.instances[0].reconciliation_client,
        )

    def test_main_reuses_fresh_reconciliation_when_empty_source_selects_no_rows(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                observed_at = datetime.now(timezone.utc)
                session.add(
                    TigerBeetleReconciliationRun(
                        cluster_id=2001,
                        started_at=observed_at,
                        finished_at=observed_at,
                        status="ok",
                        checked_transfer_count=26,
                        missing_transfer_count=0,
                        mismatched_transfer_count=0,
                        source_missing_count=0,
                        payload_json={
                            "ok": True,
                            "status": "ok",
                            "blockers": [],
                            "reconciliation_max_age_seconds": 300,
                            "runtime_ledger_checked_transfer_count": 26,
                            "runtime_ledger_signed_transfer_count": 26,
                            "runtime_ledger_missing_signed_ref_count": 0,
                        },
                    )
                )
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
                        "--sources",
                        "strategy_runtime_ledger_bucket",
                        "--batch-size",
                        "5",
                        "--reconcile-limit",
                        "12",
                        "--reconcile-empty-selection",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
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
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["selected"], 0)
        self.assertEqual(payload["journaled"], 0)
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["reconciliation"]["status"], "skipped")
        self.assertEqual(
            payload["reconciliation"]["reason"],
            "fresh_reconciliation_available",
        )
        self.assertEqual(
            payload["reconciliation"]["latest_status"],
            "ok",
        )
        self.assertFalse(payload["reconciliation"]["reconciliation_stale"])
        self.assertEqual(FakeJournal.instances[0].runtime_buckets, [])
        self.assertEqual(FakeJournal.instances[0].stable_ref_backfills, 0)
        reconcile.assert_not_called()

    def test_fresh_empty_selection_reconciliation_requires_clean_latest_payload(
        self,
    ) -> None:
        base_payload: dict[str, object] = {
            "ok": True,
            "status": "ok",
            "reconciliation_stale": False,
            "reconciliation_max_age_seconds": 300,
            "blockers": [],
            "client_lookup_ok": True,
        }
        rejection_cases = [
            {"ok": False},
            {"status": "degraded"},
            {"reconciliation_stale": True},
            {"reconciliation_max_age_seconds": 0},
            {"blockers": ["runtime_ledger_missing"]},
            {"blockers": True},
            {"client_lookup_ok": False},
        ]

        for override in rejection_cases:
            with self.subTest(override=override):
                payload = {**base_payload, **override}
                session = object()
                with patch.object(
                    script,
                    "latest_tigerbeetle_reconciliation_payload",
                    return_value=payload,
                ) as latest:
                    result = script._fresh_reconciliation_for_empty_selection(
                        session,
                        settings_obj=cast(
                            Settings,
                            SimpleNamespace(tigerbeetle_cluster_id=2001),
                        ),
                    )

                self.assertIsNone(result)
                latest.assert_called_once_with(session, cluster_id=2001)

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

    def test_main_reports_scan_failed_rows_as_degraded_event_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                bad = _add_order_event(session, fingerprint="bad", source_offset=1)
                bad.avg_fill_price = Decimal("190.2500001")
                _add_order_event(session, fingerprint="selected", source_offset=2)
                session.commit()

            real_build_plan = script.build_order_event_transfer_plan

            def build_plan_with_failure(
                session: Session,
                event: ExecutionOrderEvent,
                *,
                settings_obj: Settings,
            ) -> object:
                if event.event_fingerprint == "bad":
                    raise RuntimeError("scan failed")
                return real_build_plan(session, event, settings_obj=settings_obj)

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
                    return_value={"ok": True},
                ),
                patch.object(
                    script,
                    "build_order_event_transfer_plan",
                    side_effect=build_plan_with_failure,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["journaled"], 1)
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(payload["batches"][0]["scan_failed"], 1)

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
        self.assertEqual(
            payload["batches"][0]["error_counts"],
            {"RuntimeError:journal failed": 1},
        )
        sample_errors = payload["batches"][0]["sample_errors"]
        self.assertEqual(len(sample_errors), 1)
        self.assertTrue(sample_errors[0]["row_id"])
        self.assertEqual(sample_errors[0]["error_type"], "RuntimeError")
        self.assertEqual(sample_errors[0]["error"], "journal failed")

    def test_main_stops_journaling_after_tigerbeetle_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "torghut.db")
            dsn = f"sqlite+pysqlite:///{db_path}"
            engine = create_engine(dsn, future=True)
            Base.metadata.create_all(engine)
            with Session(engine) as session:
                _add_order_event(session, fingerprint="timeout", source_offset=1)
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
                        "--fail-on-degraded",
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
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["stopped_early"])
        self.assertEqual(payload["stop_reasons"], ["tigerbeetle_rpc_timeout"])
        self.assertEqual(payload["failed"], 1)
        self.assertEqual(payload["reconciliation"]["status"], "skipped")
        reconcile.assert_not_called()
        fake_journal = FakeJournal.instances[-1]
        self.assertEqual(fake_journal.events, ["timeout"])
        self.assertEqual(fake_journal.executions, [])
        self.assertEqual(fake_journal.tca_metrics, [])

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

    def test_main_can_fail_closed_for_degraded_reconciliation(self) -> None:
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
                    return_value={"ok": False, "blockers": ["missing"]},
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["failed"], 0)
        self.assertEqual(payload["journaled"], 1)

    def test_main_scheduled_non_authority_allows_data_quality_degraded_exit_zero(
        self,
    ) -> None:
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
                        "--batch-size",
                        "10",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script,
                    "reconcile_tigerbeetle_transfers",
                    return_value={
                        "ok": False,
                        "blockers": [
                            "tigerbeetle_source_amount_mismatch",
                            "tigerbeetle_unlinked_execution_cost",
                        ],
                        "promotion_authority": False,
                        "overrides_runtime_ledger_authority": False,
                    },
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "degraded")
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["exit_nonzero"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])
        self.assertEqual(payload["hard_failure_reasons"], [])
        self.assertEqual(
            payload["accounting_blockers"],
            [
                "tigerbeetle_source_amount_mismatch",
                "tigerbeetle_unlinked_execution_cost",
            ],
        )

    def test_main_scheduled_non_authority_fails_closed_for_batch_errors(
        self,
    ) -> None:
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
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script,
                    "reconcile_tigerbeetle_transfers",
                    return_value={"ok": True, "blockers": []},
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["exit_nonzero"])
        self.assertEqual(payload["hard_failure_reasons"], ["journal_batch_failures"])

    def test_main_scheduled_non_authority_fails_closed_for_tigerbeetle_infra_blocker(
        self,
    ) -> None:
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
                        "--batch-size",
                        "10",
                        "--fail-on-degraded",
                        "--allow-data-quality-degraded",
                        "--json",
                    ],
                ),
                patch.object(script, "TigerBeetleLedgerJournal", FakeJournal),
                patch.object(
                    script,
                    "reconcile_tigerbeetle_transfers",
                    return_value={
                        "ok": False,
                        "blockers": ["tigerbeetle_client_unavailable"],
                    },
                ),
                redirect_stdout(stdout),
            ):
                exit_code = script.main()

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["exit_nonzero"])
        self.assertEqual(
            payload["hard_failure_reasons"],
            ["tigerbeetle_client_unavailable"],
        )

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
