from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from datetime import datetime, timezone
from decimal import Decimal
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
    PARITY_STATUS_BLOCKED,
    PARITY_STATUS_OPTIONAL_DEGRADED,
    PARITY_STATUS_PASS,
    audit_tigerbeetle_runtime_ledger_parity,
)
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
