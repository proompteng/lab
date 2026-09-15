from __future__ import annotations

import argparse
import io
import os
import sys
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import TracebackType
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Base,
    Execution,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
    coerce_json_payload,
)
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    TigerBeetleLedgerJournal,
)
from app.trading.tigerbeetle_ledger_model import (
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
)
from app.trading.tigerbeetle_runtime_ledger_parity import (
    BLOCKER_ACCOUNT_MISMATCH,
    BLOCKER_AMOUNT_MISMATCH,
    BLOCKER_CANDIDATE_MISMATCH,
    BLOCKER_ENTRY_MISSING,
    BLOCKER_RECONCILIATION_MISSING,
    BLOCKER_TRANSFER_MISSING,
    BLOCKER_TRANSFER_SHAPE_MISMATCH,
    PARITY_STATUS_BLOCKED,
    PARITY_STATUS_NO_SOURCE_DATA,
    PARITY_STATUS_OPTIONAL_DEGRADED,
    PARITY_STATUS_PASS,
    BLOCKER_RECONCILIATION_NOT_OK,
    BLOCKER_RECONCILIATION_STALE,
    audit_tigerbeetle_runtime_ledger_parity,
    tigerbeetle_runtime_ledger_parity_blockers,
)
from app.trading.tigerbeetle_reconcile import reconcile_tigerbeetle_transfers
from scripts import audit_tigerbeetle_runtime_ledger_parity as audit_script
from scripts.audit_tigerbeetle_runtime_ledger_parity import main as audit_main


def _settings(*, required: bool = False) -> Settings:
    return Settings(
        TORGHUT_TIGERBEETLE_ENABLED=True,
        TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
        TORGHUT_TIGERBEETLE_REQUIRED=required,
        TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED=required,
    )


def _execution() -> Execution:
    return Execution(
        alpaca_account_label="paper",
        alpaca_order_id="order-parity-1",
        client_order_id="client-parity-1",
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("2"),
        filled_qty=Decimal("2"),
        avg_fill_price=Decimal("100.25"),
        status="filled",
        raw_order={"id": "order-parity-1"},
    )


def _metric(execution: Execution) -> ExecutionTCAMetric:
    return ExecutionTCAMetric(
        execution_id=execution.id,
        alpaca_account_label="paper",
        symbol="AAPL",
        side="buy",
        filled_qty=Decimal("2"),
        signed_qty=Decimal("2"),
        shortfall_notional=Decimal("0.75"),
        realized_shortfall_bps=Decimal("3.50"),
        simulator_version="fixture",
        computed_at=datetime.now(timezone.utc),
    )


def _runtime_bucket(
    *, candidate_id: str = "candidate-1"
) -> StrategyRuntimeLedgerBucket:
    observed_at = datetime.now(timezone.utc)
    return StrategyRuntimeLedgerBucket(
        run_id="runtime-run-1",
        candidate_id=candidate_id,
        hypothesis_id="hypothesis-1",
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
        filled_notional=Decimal("200.50"),
        gross_strategy_pnl=Decimal("5.00"),
        cost_amount=Decimal("0.75"),
        net_strategy_pnl_after_costs=Decimal("4.25"),
        post_cost_expectancy_bps=Decimal("21.19"),
        ledger_schema_version="torghut.runtime-ledger.v1",
        pnl_basis="post_cost",
        payload_json={"source": "fixture"},
    )


def _seed_sources(
    session: Session,
) -> tuple[Execution, ExecutionTCAMetric, StrategyRuntimeLedgerBucket]:
    execution = _execution()
    session.add(execution)
    session.flush()
    metric = _metric(execution)
    bucket = _runtime_bucket()
    session.add_all([metric, bucket])
    session.flush()
    return execution, metric, bucket


def _journal_all(
    session: Session,
    client: FakeTigerBeetleClient,
    *,
    settings_obj: Settings | None = None,
) -> None:
    execution = session.execute(select(Execution)).scalar_one()
    metric = session.execute(select(ExecutionTCAMetric)).scalar_one()
    bucket = session.execute(select(StrategyRuntimeLedgerBucket)).scalar_one()
    journal = TigerBeetleLedgerJournal(
        settings_obj=settings_obj or _settings(),
        client=client,
    )
    journal.journal_execution(session, execution)
    journal.journal_execution_tca_metric(session, metric)
    journal.journal_runtime_ledger_bucket(session, bucket)
    session.flush()


class _MappingTransferClient:
    def __init__(self, transfers: list[dict[str, object]]) -> None:
        self.transfers = transfers

    def nop(self) -> None:
        return None

    def create_accounts(self, accounts: object) -> list[object]:
        return []

    def lookup_accounts(self, ids: object) -> list[object]:
        return []

    def create_transfers(self, transfers: object) -> list[object]:
        return []

    def lookup_transfers(self, ids: object) -> list[object]:
        return list(self.transfers)


class _FailingLookupClient(_MappingTransferClient):
    def __init__(self) -> None:
        super().__init__([])

    def lookup_transfers(self, ids: object) -> list[object]:
        raise RuntimeError("lookup unavailable")


class _SessionContext:
    session = object()

    def __enter__(self) -> object:
        return self.session

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        return False


class _ClosingClient:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class TestAuditTigerBeetleRuntimeLedgerParity(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def test_full_parity_passes_for_execution_cost_and_runtime_ledger_refs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)
            client = FakeTigerBeetleClient()
            _journal_all(session, client)
            reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(required=True),
                client=client,
            )

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=True),
                client=client,
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["parity_status"], PARITY_STATUS_PASS)
        self.assertEqual(payload["blockers"], [])
        totals = payload["totals"]
        assert isinstance(totals, dict)
        self.assertEqual(totals["checked_source_count"], 3)
        self.assertEqual(totals["checked_actual_transfer_count"], 3)
        self.assertEqual(
            totals["expected_amount_micros_by_family"],
            {
                "execution_cost": "750000",
                "execution_fill": "200500000",
                "runtime_net_pnl": "4250000",
            },
        )
        read_only = payload["read_only_contract"]
        assert isinstance(read_only, dict)
        self.assertFalse(read_only["generates_proof"])
        self.assertFalse(read_only["synthesizes_fills"])
        self.assertFalse(read_only["overrides_runtime_ledger_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertTrue(payload["reconciliation_ok"])
        self.assertFalse(payload["reconciliation_stale"])
        samples = payload["samples"]
        assert isinstance(samples, list)
        runtime_sample = next(
            sample for sample in samples if sample["family"] == "runtime_net_pnl"
        )
        self.assertFalse(runtime_sample["promotion_authority"])
        self.assertIn(
            "postgres:strategy_runtime_ledger_buckets:",
            str(runtime_sample["source_refs"]),
        )
        self.assertTrue(str(runtime_sample["runtime_ledger_net_pnl_transfer_ref"]))
        self.assertEqual(runtime_sample["signed_amount_micros"], "4250000")
        self.assertEqual(runtime_sample["pnl_direction"], "profit")

    def test_missing_tigerbeetle_entries_are_optional_degraded_when_not_required(
        self,
    ) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=False),
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["parity_status"], PARITY_STATUS_OPTIONAL_DEGRADED)
        self.assertIn(BLOCKER_ENTRY_MISSING, payload["blockers"])
        totals = payload["totals"]
        assert isinstance(totals, dict)
        self.assertEqual(totals["missing_ref_count"], 3)

    def test_required_mode_fails_closed_when_parity_entries_are_missing(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=True),
            )

        self.assertFalse(payload["ok"])
        self.assertTrue(payload["required"])
        self.assertEqual(payload["parity_status"], PARITY_STATUS_BLOCKED)
        self.assertIn(BLOCKER_ENTRY_MISSING, payload["blockers"])
        self.assertIn(BLOCKER_RECONCILIATION_MISSING, payload["blockers"])

    def test_stale_reconciliation_blocks_required_parity(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)
            client = FakeTigerBeetleClient()
            _journal_all(session, client)
            stale_at = datetime.now(timezone.utc) - timedelta(hours=2)
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=_settings(required=True).tigerbeetle_cluster_id,
                    started_at=stale_at,
                    finished_at=stale_at,
                    status="ok",
                    checked_transfer_count=3,
                    missing_transfer_count=0,
                    mismatched_transfer_count=0,
                    source_missing_count=0,
                    payload_json={
                        "blockers": [],
                        "reconciliation_max_age_seconds": 60,
                    },
                )
            )
            session.flush()

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=Settings(
                    TORGHUT_TIGERBEETLE_ENABLED=True,
                    TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=True,
                    TORGHUT_TIGERBEETLE_REQUIRED=True,
                    TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED=True,
                    TORGHUT_TIGERBEETLE_RECONCILE_MAX_AGE_SECONDS=60,
                ),
                client=client,
            )

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["reconciliation_ok"])
        self.assertTrue(payload["reconciliation_stale"])
        self.assertIn(BLOCKER_RECONCILIATION_STALE, payload["blockers"])

    def test_missing_runtime_ledger_ref_blocks_required_parity(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)
            client = FakeTigerBeetleClient()
            execution = session.execute(select(Execution)).scalar_one()
            metric = session.execute(select(ExecutionTCAMetric)).scalar_one()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(required=True),
                client=client,
            )
            journal.journal_execution(session, execution)
            journal.journal_execution_tca_metric(session, metric)
            reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(required=True),
                client=client,
            )

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=True),
                client=client,
            )

        self.assertFalse(payload["ok"])
        self.assertIn(BLOCKER_ENTRY_MISSING, payload["blockers"])
        samples = payload["samples"]
        assert isinstance(samples, list)
        runtime_sample = next(
            sample for sample in samples if sample["family"] == "runtime_net_pnl"
        )
        self.assertEqual(runtime_sample["status"], "missing_ref")
        self.assertFalse(runtime_sample["promotion_authority"])

    def test_amount_mismatch_blocks_required_parity(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)
            client = FakeTigerBeetleClient()
            _journal_all(session, client)
            ref = session.execute(
                select(TigerBeetleTransferRef).where(
                    TigerBeetleTransferRef.source_type == SOURCE_TYPE_EXECUTION,
                    TigerBeetleTransferRef.transfer_kind
                    == TRANSFER_KIND_EXECUTION_FILL,
                )
            ).scalar_one()
            ref.amount = Decimal("1")
            session.add(ref)
            session.flush()

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=True),
                client=client,
            )

        self.assertFalse(payload["ok"])
        self.assertIn(BLOCKER_AMOUNT_MISMATCH, payload["blockers"])
        totals = payload["totals"]
        assert isinstance(totals, dict)
        self.assertGreaterEqual(totals["amount_mismatch_count"], 1)

    def test_account_and_candidate_mismatch_blocks_required_parity(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)
            client = FakeTigerBeetleClient()
            _journal_all(session, client)
            ref = session.execute(
                select(TigerBeetleTransferRef).where(
                    TigerBeetleTransferRef.source_type
                    == SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    TigerBeetleTransferRef.transfer_kind
                    == TRANSFER_KIND_RUNTIME_NET_PNL,
                )
            ).scalar_one()
            payload_json = dict(ref.payload_json or {})
            payload_json["candidate_id"] = "wrong-candidate"
            payload_json["debit_account_id"] = "999"
            ref.payload_json = coerce_json_payload(payload_json)
            session.add(ref)
            session.flush()

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=True),
                client=client,
            )

        self.assertFalse(payload["ok"])
        self.assertIn(BLOCKER_ACCOUNT_MISMATCH, payload["blockers"])
        self.assertIn(BLOCKER_CANDIDATE_MISMATCH, payload["blockers"])
        totals = payload["totals"]
        assert isinstance(totals, dict)
        self.assertEqual(totals["account_mismatch_count"], 1)
        self.assertEqual(totals["candidate_mismatch_count"], 1)

    def test_no_source_data_is_explicit_and_requirement_can_be_overridden(
        self,
    ) -> None:
        with Session(self.engine) as session:
            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=False),
                limit=-10,
                require_tigerbeetle=True,
            )

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["required"])
        self.assertEqual(payload["limit"], 1)
        self.assertEqual(payload["parity_status"], PARITY_STATUS_NO_SOURCE_DATA)
        self.assertEqual(payload["blockers"], [])

    def test_account_label_filter_limits_source_selection(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=False),
                account_label="live",
            )

        totals = payload["totals"]
        assert isinstance(totals, dict)
        self.assertEqual(payload["account_label"], "live")
        self.assertEqual(totals["checked_source_count"], 0)
        self.assertEqual(payload["parity_status"], PARITY_STATUS_NO_SOURCE_DATA)

    def test_actual_transfer_missing_is_reported_from_live_lookup(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)
            fake = FakeTigerBeetleClient()
            _journal_all(session, fake)

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=True),
                client=_MappingTransferClient([]),
            )

        self.assertFalse(payload["ok"])
        self.assertIn(BLOCKER_TRANSFER_MISSING, payload["blockers"])
        totals = payload["totals"]
        assert isinstance(totals, dict)
        self.assertEqual(totals["actual_missing_count"], 3)
        samples = payload["samples"]
        assert isinstance(samples, list)
        self.assertTrue(
            any(sample.get("status") == "missing_actual_transfer" for sample in samples)
        )

    def test_actual_mapping_lookup_mismatches_are_reported(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)
            fake = FakeTigerBeetleClient()
            _journal_all(session, fake)
            ref = session.execute(select(TigerBeetleTransferRef)).scalars().first()
            assert ref is not None

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=True),
                client=_MappingTransferClient(
                    [
                        {
                            "transfer_id": int(ref.transfer_id),
                            "amount": "1",
                            "debit_account_id": "999",
                            "credit_account_id": "888",
                            "ledger": ref.ledger + 1,
                            "code": ref.code + 1,
                        }
                    ]
                ),
            )

        self.assertFalse(payload["ok"])
        self.assertIn(BLOCKER_AMOUNT_MISMATCH, payload["blockers"])
        self.assertIn(BLOCKER_ACCOUNT_MISMATCH, payload["blockers"])
        self.assertIn(BLOCKER_TRANSFER_SHAPE_MISMATCH, payload["blockers"])
        self.assertIn(BLOCKER_TRANSFER_MISSING, payload["blockers"])
        totals = payload["totals"]
        assert isinstance(totals, dict)
        self.assertGreaterEqual(totals["amount_mismatch_count"], 1)
        self.assertGreaterEqual(totals["account_mismatch_count"], 1)
        self.assertGreaterEqual(totals["transfer_shape_mismatch_count"], 1)
        self.assertGreaterEqual(totals["actual_missing_count"], 1)

    def test_lookup_client_error_is_optional_degraded_until_required(self) -> None:
        with Session(self.engine) as session:
            _seed_sources(session)
            fake = FakeTigerBeetleClient()
            _journal_all(session, fake)

            payload = audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=_settings(required=False),
                client=_FailingLookupClient(),
            )

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["parity_status"], PARITY_STATUS_OPTIONAL_DEGRADED)
        self.assertIn("RuntimeError: lookup unavailable", str(payload["client_error"]))

    def test_required_parity_blocker_extractor_fails_closed_only_when_required(
        self,
    ) -> None:
        self.assertEqual(
            tigerbeetle_runtime_ledger_parity_blockers(
                {"required": False, "blockers": [BLOCKER_ENTRY_MISSING]}
            ),
            [],
        )
        self.assertEqual(
            tigerbeetle_runtime_ledger_parity_blockers(
                {"required": True, "blockers": [BLOCKER_ENTRY_MISSING]}
            ),
            [BLOCKER_ENTRY_MISSING],
        )
        self.assertEqual(
            tigerbeetle_runtime_ledger_parity_blockers(
                {"required": True, "blockers": "not-a-list"}
            ),
            [],
        )
        self.assertEqual(
            tigerbeetle_runtime_ledger_parity_blockers(
                {
                    "required": True,
                    "reconciliation_ok": False,
                    "latest_reconciliation": {
                        "blockers": ["tigerbeetle_postgres_ref_mismatch"],
                    },
                    "blockers": [BLOCKER_ENTRY_MISSING],
                }
            ),
            [
                BLOCKER_ENTRY_MISSING,
                "tigerbeetle_postgres_ref_mismatch",
                BLOCKER_RECONCILIATION_NOT_OK,
            ],
        )
        self.assertEqual(
            tigerbeetle_runtime_ledger_parity_blockers(
                {
                    "required": True,
                    "reconciliation_ok": False,
                    "reconciliation_stale": True,
                    "latest_reconciliation": None,
                    "blockers": [],
                }
            ),
            [
                BLOCKER_RECONCILIATION_MISSING,
                BLOCKER_RECONCILIATION_NOT_OK,
                BLOCKER_RECONCILIATION_STALE,
            ],
        )

    def test_script_parsers_normalize_dsn_and_requirement_values(self) -> None:
        self.assertEqual(
            audit_script._sqlalchemy_dsn("postgres://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(
            audit_script._sqlalchemy_dsn("postgresql://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(
            audit_script._sqlalchemy_dsn("postgresql+psycopg://user:pass@host/db"),
            "postgresql+psycopg://user:pass@host/db",
        )
        self.assertEqual(audit_script._parse_require("auto"), None)
        self.assertTrue(audit_script._parse_require("required"))
        self.assertFalse(audit_script._parse_require("optional"))
        with self.assertRaises(argparse.ArgumentTypeError):
            audit_script._parse_require("sometimes")

    def test_run_audit_uses_configured_dsn_and_closes_owned_client(self) -> None:
        args = argparse.Namespace(
            dsn_env="TEST_TORGHUT_DSN",
            lookup_tigerbeetle=True,
            account_label="paper",
            limit=7,
            require_tigerbeetle=True,
        )
        payload = {"ok": True, "required": True, "blockers": []}
        closing_client = _ClosingClient()

        with patch.dict(
            os.environ,
            {"TEST_TORGHUT_DSN": "postgres://user:pass@host/db"},
        ):
            with patch.object(audit_script, "create_engine") as create_engine:
                with patch.object(audit_script, "sessionmaker") as sessionmaker:
                    with patch.object(
                        audit_script,
                        "create_tigerbeetle_client",
                        return_value=closing_client,
                    ) as create_client:
                        with patch.object(
                            audit_script,
                            "audit_tigerbeetle_runtime_ledger_parity",
                            return_value=payload,
                        ) as audit:
                            sessionmaker.return_value = _SessionContext

                            result = audit_script.run_audit(args)

        self.assertEqual(result, payload)
        create_engine.assert_called_once_with(
            "postgresql+psycopg://user:pass@host/db",
            pool_pre_ping=True,
            future=True,
        )
        create_client.assert_called_once()
        audit.assert_called_once_with(
            _SessionContext.session,
            settings_obj=create_client.call_args.args[0],
            client=closing_client,
            account_label="paper",
            limit=7,
            require_tigerbeetle=True,
        )
        self.assertTrue(closing_client.closed)

    def test_run_audit_requires_dsn_env_var(self) -> None:
        args = argparse.Namespace(
            dsn_env="MISSING_TORGHUT_DSN",
            lookup_tigerbeetle=False,
            account_label=None,
            limit=1,
            require_tigerbeetle=None,
        )

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(SystemExit, "missing DSN env var"):
                audit_script.run_audit(args)

    def test_script_main_emits_stable_json_and_does_not_fail_optional_blockers(
        self,
    ) -> None:
        out = io.StringIO()
        payload = {
            "schema_version": "torghut.tigerbeetle-runtime-ledger-parity.v1",
            "required": False,
            "ok": True,
            "parity_status": PARITY_STATUS_OPTIONAL_DEGRADED,
            "blockers": [BLOCKER_ENTRY_MISSING],
        }

        with patch.object(
            sys,
            "argv",
            ["audit_tigerbeetle_runtime_ledger_parity.py"],
        ):
            with patch(
                "scripts.audit_tigerbeetle_runtime_ledger_parity.run_audit",
                return_value=payload,
            ):
                with redirect_stdout(out):
                    result = audit_main()

        self.assertEqual(result, 0)
        self.assertIn(
            '"schema_version":"torghut.tigerbeetle-runtime-ledger-parity.v1"',
            out.getvalue(),
        )

    def test_script_main_fails_only_for_required_blockers_when_requested(
        self,
    ) -> None:
        out = io.StringIO()
        payload = {
            "schema_version": "torghut.tigerbeetle-runtime-ledger-parity.v1",
            "required": True,
            "ok": False,
            "parity_status": PARITY_STATUS_BLOCKED,
            "blockers": [BLOCKER_ENTRY_MISSING],
        }

        with patch.object(
            sys,
            "argv",
            [
                "audit_tigerbeetle_runtime_ledger_parity.py",
                "--fail-on-required-blockers",
            ],
        ):
            with patch(
                "scripts.audit_tigerbeetle_runtime_ledger_parity.run_audit",
                return_value=payload,
            ):
                with redirect_stdout(out):
                    result = audit_main()

        self.assertEqual(result, 1)
        self.assertIn('"required":true', out.getvalue())
