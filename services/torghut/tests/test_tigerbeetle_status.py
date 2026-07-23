from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.api.health_checks import (
    build_tigerbeetle_ledger_status,
    check_tigerbeetle_protocol_health,
    tigerbeetle_status_int,
)
from app.api.health_checks import tigerbeetle_health as health_checks_context
from app.api.status_helpers import budget_unavailable_tigerbeetle_ledger_payload
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
        self._orig_reconcile_max_age_seconds = (
            settings.tigerbeetle_reconcile_max_age_seconds
        )
        self._orig_timeout = settings.tigerbeetle_health_timeout_seconds
        settings.tigerbeetle_enabled = False
        settings.tigerbeetle_required = False
        settings.tigerbeetle_journal_enabled = False
        settings.tigerbeetle_reconcile_required = False
        settings.tigerbeetle_reconcile_max_age_seconds = 3600
        settings.tigerbeetle_health_timeout_seconds = 1.0
        health_checks_context.close_tigerbeetle_protocol_health_client()
        self.protocol_client = MagicMock()
        self._create_protocol_client_patch = patch.object(
            health_checks_context,
            "create_tigerbeetle_client",
            return_value=self.protocol_client,
        )
        self.create_protocol_client = self._create_protocol_client_patch.start()

    def tearDown(self) -> None:
        health_checks_context.close_tigerbeetle_protocol_health_client()
        self._create_protocol_client_patch.stop()
        settings.tigerbeetle_enabled = self._orig_enabled
        settings.tigerbeetle_required = self._orig_required
        settings.tigerbeetle_journal_enabled = self._orig_journal_enabled
        settings.tigerbeetle_reconcile_required = self._orig_reconcile_required
        settings.tigerbeetle_reconcile_max_age_seconds = (
            self._orig_reconcile_max_age_seconds
        )
        settings.tigerbeetle_health_timeout_seconds = self._orig_timeout

    def test_disabled_tigerbeetle_status_is_non_blocking(self) -> None:
        with Session(self.engine) as session:
            payload = build_tigerbeetle_ledger_status(session)

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["enabled"])
        self.assertTrue(payload["protocol_ok"])
        self.assertFalse(payload["protocol_probe_skipped"])
        self.assertEqual(payload["blockers"], [])
        self.assertEqual(payload["ref_counts"]["transfer_ref_count"], 0)

    def test_status_uses_bounded_ref_count_diagnostics(self) -> None:
        ref_counts = {
            "schema_version": "torghut.tigerbeetle-ref-counts.v1",
            "cluster_id": 2001,
            "account_ref_count": 0,
            "transfer_ref_count": 0,
            "by_source_type": {},
            "runtime_ledger_ref_count": 0,
            "runtime_ledger_signed_ref_count": 0,
            "runtime_ledger_missing_signed_ref_count": 0,
            "runtime_ledger_missing_account_ref_count": 0,
            "source_materialization": {},
        }

        with Session(self.engine) as session:
            with patch.object(
                health_checks_context, "tigerbeetle_ref_counts", return_value=ref_counts
            ) as ref_counts_mock:
                payload = build_tigerbeetle_ledger_status(session)

        self.assertTrue(payload["ok"])
        self.assertEqual(ref_counts_mock.call_args.kwargs["full_ref_scan"], False)

    def test_status_reuses_latest_reconciliation_ref_counts(self) -> None:
        settings.tigerbeetle_reconcile_required = True
        latest_reconciliation = {
            "ok": True,
            "status": "ok",
            "age_seconds": 12,
            "reconciliation_stale": False,
            "blockers": [],
            "ref_counts": {
                "schema_version": "torghut.tigerbeetle-ref-counts.v1",
                "cluster_id": 2001,
                "account_ref_count": 54_129,
                "transfer_ref_count": 28_993,
                "by_source_type": {"strategy_runtime_ledger_bucket": 26},
                "runtime_ledger_ref_count": 26,
                "runtime_ledger_signed_ref_count": 26,
                "runtime_ledger_missing_signed_ref_count": 0,
                "runtime_ledger_missing_account_ref_count": 0,
                "source_materialization": {},
            },
        }

        with Session(self.engine) as session:
            with (
                patch.object(
                    health_checks_context,
                    "latest_tigerbeetle_reconciliation_payload",
                    return_value=latest_reconciliation,
                ),
                patch.object(
                    health_checks_context, "tigerbeetle_ref_counts"
                ) as ref_counts_mock,
            ):
                payload = build_tigerbeetle_ledger_status(session)

        ref_counts_mock.assert_not_called()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["claimed_by_runtime_evidence"])
        self.assertEqual(payload["runtime_ledger_ref_count"], 26)
        ref_counts = payload["ref_counts"]
        self.assertIsInstance(ref_counts, dict)
        assert isinstance(ref_counts, dict)
        self.assertEqual(ref_counts["source"], "latest_tigerbeetle_reconciliation")
        self.assertTrue(ref_counts["bounded_status_live_query_skipped"])
        self.assertNotIn("tigerbeetle_ref_counts_unavailable", payload["blockers"])

    def test_optional_reconciliation_queries_current_runtime_ref_counts(self) -> None:
        latest_reconciliation = {
            "ok": True,
            "status": "ok",
            "age_seconds": 7_200,
            "reconciliation_stale": True,
            "blockers": [],
            "ref_counts": {
                "account_ref_count": 100,
                "transfer_ref_count": 100,
                "runtime_ledger_ref_count": 1,
                "runtime_ledger_signed_ref_count": 1,
                "runtime_ledger_missing_signed_ref_count": 0,
                "runtime_ledger_missing_account_ref_count": 0,
            },
        }
        current_ref_counts = {
            "schema_version": "torghut.tigerbeetle-ref-counts.v1",
            "cluster_id": 2001,
            "account_ref_count": 100,
            "transfer_ref_count": 100,
            "by_source_type": {"strategy_runtime_ledger_bucket": 1},
            "runtime_ledger_ref_count": 1,
            "runtime_ledger_signed_ref_count": 0,
            "runtime_ledger_missing_signed_ref_count": 1,
            "runtime_ledger_missing_account_ref_count": 0,
            "source_materialization": {},
        }

        with Session(self.engine) as session:
            with (
                patch.object(
                    health_checks_context,
                    "latest_tigerbeetle_reconciliation_payload",
                    return_value=latest_reconciliation,
                ),
                patch.object(
                    health_checks_context,
                    "tigerbeetle_ref_counts",
                    return_value=current_ref_counts,
                ) as ref_counts_mock,
            ):
                payload = build_tigerbeetle_ledger_status(session)

        ref_counts_mock.assert_called_once()
        self.assertEqual(payload["runtime_ledger_signed_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 1)
        self.assertIn(
            "tigerbeetle_runtime_ledger_signed_refs_missing",
            payload["blockers"],
        )

    def test_status_reuses_latest_reconciliation_top_level_counts(self) -> None:
        settings.tigerbeetle_reconcile_required = True
        latest_reconciliation = {
            "ok": True,
            "status": "ok",
            "age_seconds": 12,
            "reconciliation_stale": False,
            "blockers": [],
            "account_ref_count": 54_129,
            "transfer_ref_count": 28_993,
            "runtime_ledger_ref_count": 26,
            "runtime_ledger_signed_ref_count": 26,
            "runtime_ledger_missing_signed_ref_count": 0,
            "runtime_ledger_missing_account_ref_count": 0,
            "ref_counts": {
                "schema_version": "torghut.tigerbeetle-ref-counts.v1",
                "cluster_id": 2001,
                "by_source_type": {"strategy_runtime_ledger_bucket": 26},
                "source_materialization": {},
            },
        }

        with Session(self.engine) as session:
            with (
                patch.object(
                    health_checks_context,
                    "latest_tigerbeetle_reconciliation_payload",
                    return_value=latest_reconciliation,
                ),
                patch.object(
                    health_checks_context, "tigerbeetle_ref_counts"
                ) as ref_counts_mock,
            ):
                payload = build_tigerbeetle_ledger_status(session)

        ref_counts_mock.assert_not_called()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["claimed_by_runtime_evidence"])
        self.assertEqual(payload["runtime_ledger_ref_count"], 26)
        ref_counts = payload["ref_counts"]
        self.assertIsInstance(ref_counts, dict)
        assert isinstance(ref_counts, dict)
        self.assertEqual(ref_counts["source"], "latest_tigerbeetle_reconciliation")
        self.assertEqual(ref_counts["account_ref_count"], 54_129)
        self.assertEqual(ref_counts["transfer_ref_count"], 28_993)
        self.assertEqual(ref_counts["runtime_ledger_signed_ref_count"], 26)
        self.assertTrue(ref_counts["bounded_status_live_query_skipped"])
        self.assertNotIn("tigerbeetle_ref_counts_unavailable", payload["blockers"])

    def test_status_uses_compact_reconciliation_without_payload_or_ref_scan(
        self,
    ) -> None:
        settings.tigerbeetle_reconcile_required = True
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=2001,
                    started_at=observed_at,
                    finished_at=observed_at,
                    status="ok",
                    checked_transfer_count=7,
                    missing_transfer_count=0,
                    mismatched_transfer_count=0,
                    source_missing_count=0,
                    account_ref_count=54_129,
                    transfer_ref_count=28_993,
                    runtime_ledger_ref_count=26,
                    runtime_ledger_signed_ref_count=26,
                    runtime_ledger_missing_signed_ref_count=0,
                    runtime_ledger_missing_account_ref_count=0,
                    stable_ref_count=28_993,
                    stable_ref_missing_count=0,
                    stable_ref_mismatch_count=0,
                    blockers_json=[],
                    ref_counts_json={
                        "by_source_type": {"strategy_runtime_ledger_bucket": 26},
                        "source_materialization": {},
                    },
                    payload_json={
                        "blockers": ["legacy_payload_should_not_be_read"],
                        "ref_counts": {
                            "runtime_ledger_missing_signed_ref_count": 99,
                        },
                    },
                )
            )
            session.flush()
            with (
                patch.object(
                    health_checks_context,
                    "latest_tigerbeetle_reconciliation_payload",
                    side_effect=AssertionError("legacy payload query was called"),
                ),
                patch.object(
                    health_checks_context,
                    "tigerbeetle_ref_counts",
                    side_effect=AssertionError("live ref-count scan was called"),
                ),
            ):
                payload = build_tigerbeetle_ledger_status(session)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["claimed_by_runtime_evidence"])
        self.assertEqual(payload["blockers"], [])
        self.assertEqual(payload["runtime_ledger_ref_count"], 26)
        self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 0)
        latest_reconciliation = payload["latest_reconciliation"]
        self.assertIsInstance(latest_reconciliation, dict)
        assert isinstance(latest_reconciliation, dict)
        self.assertTrue(latest_reconciliation["compact_status"])
        self.assertTrue(latest_reconciliation["payload_json_skipped"])
        self.assertEqual(latest_reconciliation["transfer_ref_count"], 28_993)
        ref_counts = payload["ref_counts"]
        self.assertIsInstance(ref_counts, dict)
        assert isinstance(ref_counts, dict)
        self.assertTrue(ref_counts["bounded_status_live_query_skipped"])
        self.assertEqual(ref_counts["transfer_ref_count"], 28_993)

    def test_compact_reconciliation_status_keeps_persisted_blockers_fail_closed(
        self,
    ) -> None:
        settings.tigerbeetle_reconcile_required = True
        observed_at = datetime.now(timezone.utc)
        with Session(self.engine) as session:
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=2001,
                    started_at=observed_at,
                    finished_at=observed_at,
                    status="degraded",
                    checked_transfer_count=2,
                    missing_transfer_count=0,
                    mismatched_transfer_count=1,
                    source_missing_count=0,
                    account_ref_count=1,
                    transfer_ref_count=2,
                    runtime_ledger_ref_count=0,
                    runtime_ledger_signed_ref_count=0,
                    runtime_ledger_missing_signed_ref_count=0,
                    runtime_ledger_missing_account_ref_count=0,
                    stable_ref_count=2,
                    stable_ref_missing_count=0,
                    stable_ref_mismatch_count=1,
                    blockers_json=["tigerbeetle_transfer_code_mismatch"],
                    ref_counts_json={"by_source_type": {}},
                    payload_json={
                        "blockers": [],
                        "ref_counts": {"transfer_ref_count": 0},
                    },
                )
            )
            session.flush()
            with (
                patch.object(
                    health_checks_context,
                    "latest_tigerbeetle_reconciliation_payload",
                    side_effect=AssertionError("legacy payload query was called"),
                ),
                patch.object(
                    health_checks_context,
                    "tigerbeetle_ref_counts",
                    side_effect=AssertionError("live ref-count scan was called"),
                ),
            ):
                payload = build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertIn("tigerbeetle_transfer_code_mismatch", payload["blockers"])
        latest_reconciliation = payload["latest_reconciliation"]
        self.assertIsInstance(latest_reconciliation, dict)
        assert isinstance(latest_reconciliation, dict)
        self.assertTrue(latest_reconciliation["compact_status"])
        self.assertEqual(
            latest_reconciliation["blockers"], ["tigerbeetle_transfer_code_mismatch"]
        )

    def test_ref_count_failure_degrades_without_status_exception(self) -> None:
        with Session(self.engine) as session:
            with patch.object(
                health_checks_context,
                "tigerbeetle_ref_counts",
                side_effect=SQLAlchemyError("idle in transaction timeout"),
            ):
                payload = build_tigerbeetle_ledger_status(session)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["ref_counts"]["ref_counts_unavailable"])
        self.assertIn("tigerbeetle_ref_counts_unavailable", payload["blockers"])

    def test_tigerbeetle_status_int_normalizes_bool_strings_and_bad_values(
        self,
    ) -> None:
        self.assertEqual(tigerbeetle_status_int(True), 1)
        self.assertEqual(tigerbeetle_status_int(False), 0)
        self.assertEqual(tigerbeetle_status_int("7"), 7)
        self.assertEqual(tigerbeetle_status_int("not-an-int"), 0)
        self.assertEqual(tigerbeetle_status_int(None), 0)

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
            with patch.object(
                health_checks_context, "check_tigerbeetle_health", return_value=health
            ):
                payload = build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["protocol_ok"])
        self.assertFalse(payload["protocol_probe_skipped"])
        self.assertIn("tigerbeetle_protocol_unhealthy", payload["blockers"])

    def test_required_protocol_does_not_require_periodic_reconciliation(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = True
        settings.tigerbeetle_reconcile_required = False
        health = TigerBeetleHealth(
            enabled=True,
            required=True,
            ok=True,
            cluster_id=2001,
            replica_addresses=["tb:3000"],
            last_error=None,
        )

        with Session(self.engine) as session:
            with patch.object(
                health_checks_context, "check_tigerbeetle_health", return_value=health
            ):
                payload = build_tigerbeetle_ledger_status(session)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["protocol_ok"])
        self.assertFalse(payload["reconciliation_required"])
        self.assertNotIn("tigerbeetle_reconciliation_missing", payload["blockers"])

    def test_budget_unavailable_payload_keeps_reconciliation_optional(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = True
        settings.tigerbeetle_reconcile_required = False

        payload = budget_unavailable_tigerbeetle_ledger_payload("budget_unavailable")

        self.assertTrue(payload["required"])
        self.assertFalse(payload["reconcile_required"])
        self.assertFalse(payload["reconciliation_required"])

    def test_missing_reconciliation_blocks_only_when_required(self) -> None:
        settings.tigerbeetle_reconcile_required = True

        with Session(self.engine) as session:
            payload = build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertIn("tigerbeetle_reconciliation_missing", payload["blockers"])

    def test_enabled_missing_reconciliation_is_nonblocking_until_required(self) -> None:
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
            with patch.object(
                health_checks_context, "check_tigerbeetle_health", return_value=health
            ) as health_mock:
                payload = build_tigerbeetle_ledger_status(session)

        self.assertTrue(payload["ok"])
        health_mock.assert_not_called()
        self.assertTrue(payload["protocol_probe_skipped"])
        self.assertFalse(payload["protocol_ok"])
        self.assertFalse(payload["reconciliation_required"])
        self.assertNotIn("tigerbeetle_reconciliation_missing", payload["blockers"])

    def test_optional_claimed_runtime_refs_report_unsigned_blockers_without_failing(
        self,
    ) -> None:
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

            payload = build_tigerbeetle_ledger_status(session)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["claimed_by_runtime_evidence"])
        self.assertFalse(payload["reconciliation_required"])
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

    def test_optional_protocol_probe_is_skipped_until_required(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = False
        settings.tigerbeetle_health_timeout_seconds = 0.01

        with patch.object(
            health_checks_context, "check_tigerbeetle_health"
        ) as health_mock:
            payload = check_tigerbeetle_protocol_health()

        self.assertTrue(payload["ok"])
        self.assertFalse(payload["protocol_ok"])
        self.assertTrue(payload["protocol_probe_skipped"])
        self.assertIsNone(payload["last_error"])
        health_mock.assert_not_called()

    def test_required_protocol_probe_reuses_one_bounded_client(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = True
        settings.tigerbeetle_health_timeout_seconds = 0.25
        health = TigerBeetleHealth(
            enabled=True,
            required=True,
            ok=True,
            cluster_id=2001,
            replica_addresses=["tb:3000"],
            last_error=None,
        )

        with patch.object(
            health_checks_context,
            "check_tigerbeetle_health",
            return_value=health,
        ) as health_mock:
            first = check_tigerbeetle_protocol_health()
            second = check_tigerbeetle_protocol_health()

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.create_protocol_client.assert_called_once_with(
            settings,
            rpc_timeout_seconds=0.25,
        )
        self.assertEqual(health_mock.call_count, 2)
        for call in health_mock.call_args_list:
            self.assertIs(call.kwargs["client"], self.protocol_client)

    def test_failed_protocol_probe_discards_client_before_retry(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_required = True
        first_client = MagicMock()
        second_client = MagicMock()
        self.create_protocol_client.side_effect = [first_client, second_client]
        failed = TigerBeetleHealth(
            enabled=True,
            required=True,
            ok=False,
            cluster_id=2001,
            replica_addresses=["tb:3000"],
            last_error="TigerBeetleClientTimeoutError: timed out",
        )
        healthy = TigerBeetleHealth(
            enabled=True,
            required=True,
            ok=True,
            cluster_id=2001,
            replica_addresses=["tb:3000"],
            last_error=None,
        )

        with patch.object(
            health_checks_context,
            "check_tigerbeetle_health",
            side_effect=[failed, healthy],
        ):
            first = check_tigerbeetle_protocol_health()
            second = check_tigerbeetle_protocol_health()

        self.assertFalse(first["ok"])
        self.assertTrue(second["ok"])
        first_client.close.assert_called_once_with()
        self.assertEqual(self.create_protocol_client.call_count, 2)

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
            with patch.object(
                health_checks_context, "check_tigerbeetle_health", return_value=health
            ):
                payload = build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertIn("tigerbeetle_transfer_code_mismatch", payload["blockers"])
        latest_reconciliation = payload["latest_reconciliation"]
        assert isinstance(latest_reconciliation, dict)
        self.assertEqual(latest_reconciliation["ref_counts"], {"transfer_ref_count": 1})

    def test_stale_reconciliation_is_fail_closed_when_required(self) -> None:
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_reconcile_required = True
        settings.tigerbeetle_reconcile_max_age_seconds = 60
        health = TigerBeetleHealth(
            enabled=True,
            required=False,
            ok=True,
            cluster_id=2001,
            replica_addresses=["tb:3000"],
            last_error=None,
        )
        stale_at = datetime(2026, 1, 1, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=2001,
                    started_at=stale_at,
                    finished_at=stale_at,
                    status="ok",
                    checked_transfer_count=1,
                    missing_transfer_count=0,
                    mismatched_transfer_count=0,
                    source_missing_count=0,
                    payload_json={
                        "blockers": [],
                        "ref_counts": {"transfer_ref_count": 1},
                    },
                )
            )
            session.flush()
            with patch.object(
                health_checks_context, "check_tigerbeetle_health", return_value=health
            ):
                payload = build_tigerbeetle_ledger_status(session)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertTrue(payload["reconciliation_stale"])
        self.assertGreater(payload["reconciliation_age_seconds"], 60)
        self.assertEqual(payload["reconciliation_max_age_seconds"], 60)
        self.assertIn("tigerbeetle_reconciliation_stale", payload["blockers"])
