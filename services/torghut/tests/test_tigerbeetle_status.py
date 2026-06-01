from __future__ import annotations

import time
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import settings
from app.main import (
    _build_tigerbeetle_ledger_status,
    _check_tigerbeetle_protocol_health,
    _tigerbeetle_status_int,
)
from app.models import (
    Base,
    StrategyRuntimeLedgerBucket,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
)
from app.trading.tigerbeetle_client import TigerBeetleHealth
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TRANSFER_CODE_RUNTIME_NET_PNL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
)


class TestTigerBeetleStatus(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)
        self._orig_enabled = settings.tigerbeetle_enabled
        self._orig_required = settings.tigerbeetle_required
        self._orig_journal_enabled = settings.tigerbeetle_journal_enabled
        self._orig_reconcile_required = settings.tigerbeetle_reconcile_required
        self._orig_timeout = settings.tigerbeetle_health_timeout_seconds
        settings.tigerbeetle_enabled = False
        settings.tigerbeetle_required = False
        settings.tigerbeetle_journal_enabled = False
        settings.tigerbeetle_reconcile_required = False
        settings.tigerbeetle_health_timeout_seconds = 1.0

    def tearDown(self) -> None:
        settings.tigerbeetle_enabled = self._orig_enabled
        settings.tigerbeetle_required = self._orig_required
        settings.tigerbeetle_journal_enabled = self._orig_journal_enabled
        settings.tigerbeetle_reconcile_required = self._orig_reconcile_required
        settings.tigerbeetle_health_timeout_seconds = self._orig_timeout

    def test_disabled_tigerbeetle_status_is_non_blocking(self) -> None:
        with Session(self.engine) as session:
            payload = _build_tigerbeetle_ledger_status(session)

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["enabled"])
        self.assertTrue(payload["protocol_ok"])
        self.assertEqual(payload["blockers"], [])
        self.assertEqual(payload["ref_counts"]["transfer_ref_count"], 0)

    def test_tigerbeetle_status_int_normalizes_bool_strings_and_bad_values(self) -> None:
        self.assertEqual(_tigerbeetle_status_int(True), 1)
        self.assertEqual(_tigerbeetle_status_int(False), 0)
        self.assertEqual(_tigerbeetle_status_int("7"), 7)
        self.assertEqual(_tigerbeetle_status_int("not-an-int"), 0)
        self.assertEqual(_tigerbeetle_status_int(None), 0)

    def test_required_protocol_failure_blocks_readiness_dependency(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = True
        health = TigerBeetleHealth(
            enabled=True,
            required=True,
            ok=False,
            cluster_id=2001,
            replica_addresses=["tb:3000"],
            last_error="RuntimeError: boom",
        )

        with Session(self.engine) as session:
            with patch("app.main.check_tigerbeetle_health", return_value=health):
                payload = _build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["protocol_ok"])
        self.assertIn("tigerbeetle_protocol_unhealthy", payload["blockers"])

    def test_missing_reconciliation_blocks_only_when_required(self) -> None:
        settings.tigerbeetle_reconcile_required = True

        with Session(self.engine) as session:
            payload = _build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertIn("tigerbeetle_reconciliation_missing", payload["blockers"])

    def test_enabled_missing_reconciliation_fails_closed(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = False
        health = TigerBeetleHealth(
            enabled=True,
            required=False,
            ok=True,
            cluster_id=2001,
            replica_addresses=["tb:3000"],
            last_error=None,
        )

        with Session(self.engine) as session:
            with patch("app.main.check_tigerbeetle_health", return_value=health):
                payload = _build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertTrue(payload["reconciliation_required"])
        self.assertIn("tigerbeetle_reconciliation_missing", payload["blockers"])

    def test_disabled_claimed_runtime_refs_fail_closed_when_unsigned(self) -> None:
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-claimed",
                candidate_id="candidate",
                hypothesis_id="hypothesis",
                observed_stage="paper",
                bucket_started_at=observed_at,
                bucket_ended_at=observed_at,
                account_label="paper",
                runtime_strategy_name="demo",
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
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id="1001",
                    transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_RUNTIME_NET_PNL,
                    amount=Decimal("2500000"),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type="strategy_runtime_ledger_bucket",
                    source_id=str(bucket.id),
                    payload_json={
                        "source": "strategy_runtime_ledger_bucket",
                        "debit_account_id": "11",
                        "credit_account_id": "12",
                    },
                )
            )
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=2001,
                    started_at=observed_at,
                    finished_at=observed_at,
                    status="ok",
                    checked_transfer_count=1,
                    missing_transfer_count=0,
                    mismatched_transfer_count=0,
                    source_missing_count=0,
                    payload_json={
                        "blockers": [],
                        "runtime_ledger_signed_transfer_count": 0,
                        "ref_counts": {"runtime_ledger_ref_count": 1},
                    },
                )
            )
            session.flush()

            payload = _build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertTrue(payload["claimed_by_runtime_evidence"])
        self.assertTrue(payload["reconciliation_required"])
        self.assertEqual(payload["runtime_ledger_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_signed_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 1)
        self.assertIn(
            "tigerbeetle_runtime_ledger_signed_refs_missing",
            payload["blockers"],
        )
        self.assertIn(
            "tigerbeetle_runtime_ledger_account_refs_missing",
            payload["blockers"],
        )

    def test_protocol_timeout_is_nonblocking_until_required(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = False
        settings.tigerbeetle_health_timeout_seconds = 0.01

        def slow_health(_settings: object) -> TigerBeetleHealth:
            time.sleep(0.2)
            return TigerBeetleHealth(
                enabled=True,
                required=False,
                ok=True,
                cluster_id=2001,
                replica_addresses=["tb:3000"],
                last_error=None,
            )

        with patch("app.main.check_tigerbeetle_health", side_effect=slow_health):
            payload = _check_tigerbeetle_protocol_health()

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["protocol_ok"])
        self.assertIn("TimeoutError", str(payload["last_error"]))

    def test_latest_reconciliation_blockers_are_reported(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_reconcile_required = True
        health = TigerBeetleHealth(
            enabled=True,
            required=False,
            ok=True,
            cluster_id=2001,
            replica_addresses=["tb:3000"],
            last_error=None,
        )

        with Session(self.engine) as session:
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=2001,
                    started_at=datetime.now(timezone.utc),
                    finished_at=datetime.now(timezone.utc),
                    status="degraded",
                    checked_transfer_count=1,
                    missing_transfer_count=0,
                    mismatched_transfer_count=1,
                    source_missing_count=0,
                    payload_json={
                        "blockers": ["tigerbeetle_transfer_code_mismatch"],
                        "ref_counts": {"transfer_ref_count": 1},
                    },
                )
            )
            session.flush()
            with patch("app.main.check_tigerbeetle_health", return_value=health):
                payload = _build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertIn("tigerbeetle_transfer_code_mismatch", payload["blockers"])
        latest_reconciliation = payload["latest_reconciliation"]
        assert isinstance(latest_reconciliation, dict)
        self.assertEqual(latest_reconciliation["ref_counts"], {"transfer_ref_count": 1})
