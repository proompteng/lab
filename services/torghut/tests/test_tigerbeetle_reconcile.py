from __future__ import annotations

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
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
)
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_journal import (
    SOURCE_TYPE_EXECUTION,
    SOURCE_TYPE_EXECUTION_TCA_METRIC,
    SOURCE_TYPE_EXECUTION_ORDER_EVENT,
    SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
    build_order_event_transfer_plan,
    build_runtime_ledger_bucket_transfer_plan,
    submitted_pending_transfer_id,
    tigerbeetle_stable_ref_payload,
)
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TRANSFER_CODE_EXECUTION_FILL,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_CODE_RUNTIME_NET_PNL,
    TRANSFER_CODE_SUBMITTED_PENDING,
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_SUBMITTED_PENDING,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TigerBeetleTransferSpec,
)
from app.trading.tigerbeetle_reconcile import (
    BLOCKER_AMOUNT_MISMATCH,
    BLOCKER_CODE_MISMATCH,
    BLOCKER_CLIENT_UNAVAILABLE,
    BLOCKER_CREDIT_ACCOUNT_MISMATCH,
    BLOCKER_DEBIT_ACCOUNT_MISMATCH,
    BLOCKER_LEDGER_MISMATCH,
    BLOCKER_POSTGRES_REF_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING,
    BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH,
    BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING,
    BLOCKER_SOURCE_ROW_MISSING,
    BLOCKER_STABLE_REF_PAYLOAD_MISMATCH,
    BLOCKER_UNLINKED_COST,
    BLOCKER_UNLINKED_EXECUTION,
    BLOCKER_SOURCE_AMOUNT_MISMATCH,
    BLOCKER_UNLINKED_RUNTIME_LEDGER,
    BLOCKER_TRANSFER_MISSING,
    BLOCKER_UNLINKED_EVENT,
    _attr,
    _archived_runtime_ledger_amount_micros,
    _cost_amount_micros,
    _expected_source_amount_micros,
    _execution_amount_micros,
    _payload_int,
    _payload_string_list,
    _runtime_ledger_payload_account_ids,
    _stable_ref_matches,
    _runtime_ledger_amount_micros,
    _usd_to_micros,
    _uuid_or_none,
    latest_tigerbeetle_reconciliation_payload,
    reconcile_tigerbeetle_transfers,
    tigerbeetle_ref_counts,
)


class FailingLookupClient(FakeTigerBeetleClient):
    def lookup_transfers(self, ids: list[int]) -> list[object]:
        raise RuntimeError("lookup failed")


class CloseTrackingClient(FakeTigerBeetleClient):
    def __init__(self) -> None:
        super().__init__()
        self.closed = False

    def close(self) -> None:
        self.closed = True


def _settings() -> Settings:
    return Settings(TORGHUT_TIGERBEETLE_ENABLED=True)


def _add_ref(
    session: Session,
    *,
    transfer_id: str = "1001",
    amount: Decimal = Decimal("190250000"),
    payload_json: dict[str, object] | None = None,
) -> None:
    session.add(
        TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id=transfer_id,
            transfer_kind="fill_post",
            ledger=LEDGER_USD_MICRO,
            code=TRANSFER_CODE_FILL_POST,
            amount=amount,
            status="created",
            source_type="execution_order_event",
            source_id=f"source-{transfer_id}",
            event_fingerprint=f"fingerprint-{transfer_id}",
            payload_json=payload_json,
        )
    )
    session.flush()


def _transfer(
    *, transfer_id: int = 1001, amount: int = 190250000
) -> TigerBeetleTransferSpec:
    return TigerBeetleTransferSpec(
        transfer_id=transfer_id,
        transfer_kind="fill_post",
        debit_account_id=11,
        credit_account_id=12,
        amount=amount,
        ledger=LEDGER_USD_MICRO,
        code=TRANSFER_CODE_FILL_POST,
    )


def _runtime_bucket(
    *, net_pnl: Decimal = Decimal("2.50")
) -> StrategyRuntimeLedgerBucket:
    observed_at = datetime.now(timezone.utc)
    return StrategyRuntimeLedgerBucket(
        run_id=f"runtime-run-{net_pnl}",
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
        gross_strategy_pnl=net_pnl + Decimal("0.50"),
        cost_amount=Decimal("0.50"),
        net_strategy_pnl_after_costs=net_pnl,
        post_cost_expectancy_bps=Decimal("12.50"),
        ledger_schema_version="torghut.runtime-ledger.v1",
        pnl_basis="post_cost",
        payload_json={"source": "representative-runtime-ledger"},
    )


def _add_account_refs_for_plan(
    session: Session,
    plan: object,
    *,
    cluster_id: int = 2001,
) -> None:
    for spec in getattr(plan, "account_specs"):
        existing = session.scalar(
            select(TigerBeetleAccountRef.id).where(
                TigerBeetleAccountRef.cluster_id == cluster_id,
                TigerBeetleAccountRef.account_id == str(spec.account_id),
            )
        )
        if existing is not None:
            continue
        session.add(
            TigerBeetleAccountRef(
                cluster_id=cluster_id,
                account_id=str(spec.account_id),
                account_key=spec.account_key,
                ledger=spec.ledger,
                code=spec.code,
                account_label=spec.account_label,
                symbol=spec.symbol,
                strategy_id=spec.strategy_id,
            )
        )


class TestTigerBeetleReconcile(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def test_reconciliation_passes_when_postgres_refs_match_tigerbeetle(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["blockers"], [])
            self.assertEqual(payload["checked_transfer_count"], 1)

    def test_reconciliation_closes_owned_tigerbeetle_client(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = CloseTrackingClient()
            client.transfers[1001] = _transfer()

            with patch(
                "app.trading.tigerbeetle_reconcile.create_tigerbeetle_client",
                return_value=client,
            ):
                payload = reconcile_tigerbeetle_transfers(
                    session,
                    settings_obj=_settings(),
                )

            self.assertTrue(payload["ok"])
            self.assertTrue(client.closed)

    def test_reconciliation_does_not_close_injected_tigerbeetle_client(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = CloseTrackingClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"])
            self.assertFalse(client.closed)

    def test_reconciliation_blocks_missing_tigerbeetle_transfer(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_TRANSFER_MISSING, payload["blockers"])

    def test_reconciliation_blocks_amount_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer(amount=1)

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_AMOUNT_MISMATCH, payload["blockers"])

    def test_source_amount_micros_rounds_real_broker_notional(self) -> None:
        self.assertEqual(_usd_to_micros(Decimal("1.0000004")), Decimal("1000000"))
        self.assertEqual(_usd_to_micros(Decimal("1.0000005")), Decimal("1000001"))

    def test_reconciliation_blocks_source_amount_mismatch(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-source-mismatch",
                client_order_id="client-source-mismatch",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-source-mismatch"},
            )
            session.add(execution)
            session.flush()
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id="1002",
                    transfer_kind="execution_fill",
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_EXECUTION_FILL,
                    amount=Decimal("1"),
                    status="created",
                    execution_id=execution.id,
                    source_type="execution",
                    source_id=f"{execution.id}:current",
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1002] = TigerBeetleTransferSpec(
                transfer_id=1002,
                transfer_kind="execution_fill",
                debit_account_id=11,
                credit_account_id=12,
                amount=1,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_SOURCE_AMOUNT_MISMATCH, payload["blockers"])
            self.assertEqual(payload["source_amount_mismatch_count"], 1)

    def test_reconciliation_reports_legacy_unversioned_source_amount_without_blocking(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-legacy-source",
                client_order_id="client-legacy-source",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-legacy-source"},
            )
            session.add(execution)
            session.flush()
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="1004",
                transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("1"),
                status="created",
                execution_id=execution.id,
                source_type=SOURCE_TYPE_EXECUTION,
                source_id=str(execution.id),
            )
            session.add(ref)
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1004] = TigerBeetleTransferSpec(
                transfer_id=1004,
                transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                debit_account_id=11,
                credit_account_id=12,
                amount=1,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"])
            self.assertNotIn(BLOCKER_SOURCE_AMOUNT_MISMATCH, payload["blockers"])
            self.assertEqual(payload["source_amount_mismatch_count"], 0)
            self.assertEqual(payload["legacy_source_amount_unverifiable_count"], 1)
            legacy_refs = payload["legacy_source_amount_unverifiable_refs"]
            assert isinstance(legacy_refs, list)
            self.assertEqual(legacy_refs[0]["row_id"], str(ref.id))

    def test_reconciliation_blocks_source_row_missing(self) -> None:
        with Session(self.engine) as session:
            missing_id = "6f767a53-6b44-428a-bd85-2f662642f637"
            missing_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="1003",
                transfer_kind="execution_fill",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("190250000"),
                status="created",
                source_type="execution",
                source_id=missing_id,
            )
            session.add(missing_ref)
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1003] = TigerBeetleTransferSpec(
                transfer_id=1003,
                transfer_kind="execution_fill",
                debit_account_id=11,
                credit_account_id=12,
                amount=190250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_SOURCE_ROW_MISSING, payload["blockers"])
            self.assertEqual(payload["source_row_missing_count"], 1)
            self.assertEqual(payload["missing_source_row_count"], 1)
            self.assertEqual(payload["source_missing_count"], 1)
            missing_source_rows = payload["missing_source_rows"]
            assert isinstance(missing_source_rows, list)
            self.assertEqual(missing_source_rows[0]["row_id"], str(missing_ref.id))
            self.assertEqual(missing_source_rows[0]["source_id"], missing_id)

    def test_reconciliation_accepts_historical_standalone_fill_when_pending_ref_arrives_later(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="standalone-fill-before-pending",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=2,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.flush()
            plan = build_order_event_transfer_plan(
                session, event, settings_obj=_settings()
            )
            self.assertIsNotNone(plan)
            assert plan is not None
            transfer = plan.transfer_spec
            pending_transfer_id = submitted_pending_transfer_id(event)
            session.add_all(
                [
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id=str(transfer.transfer_id),
                        transfer_kind=transfer.transfer_kind,
                        ledger=transfer.ledger,
                        code=transfer.code,
                        amount=Decimal(transfer.amount),
                        status="created",
                        execution_order_event_id=event.id,
                        source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                        source_id=str(event.id),
                        event_fingerprint=event.event_fingerprint,
                        payload_json={
                            "debit_account_id": f"{transfer.debit_account_id}.0",
                            "credit_account_id": str(transfer.credit_account_id),
                            "pending_mode": "standalone_fill",
                            "source": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
                        },
                    ),
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id=str(pending_transfer_id),
                        transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                        ledger=LEDGER_USD_MICRO,
                        code=TRANSFER_CODE_SUBMITTED_PENDING,
                        amount=Decimal(transfer.amount),
                        status="created",
                    ),
                ]
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = {
                "transfer_id": Decimal(transfer.transfer_id),
                "amount": str(transfer.amount),
                "ledger": str(transfer.ledger),
                "code": str(transfer.code),
                "debit_account_id": Decimal(transfer.debit_account_id),
                "credit_account_id": str(transfer.credit_account_id),
            }
            client.transfers[pending_transfer_id] = TigerBeetleTransferSpec(
                transfer_id=pending_transfer_id,
                transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                debit_account_id=11,
                credit_account_id=12,
                amount=transfer.amount,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_SUBMITTED_PENDING,
            )

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

        self.assertTrue(payload["ok"], payload)
        self.assertNotIn(BLOCKER_POSTGRES_REF_MISMATCH, payload["blockers"])
        self.assertEqual(payload["mismatched_ref_count"], 0)

    def test_runtime_payload_account_ids_normalize_sequence_scalar_and_missing_values(
        self,
    ) -> None:
        self.assertEqual(
            _payload_string_list({"account_ids": ["11", None, 12]}, "account_ids"),
            ["11", "12"],
        )
        self.assertEqual(
            _payload_string_list({"account_ids": "11"}, "account_ids"), ["11"]
        )

        ref = TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id="runtime-account-ref",
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            ledger=LEDGER_USD_MICRO,
            code=TRANSFER_CODE_RUNTIME_NET_PNL,
            amount=Decimal("2500000"),
            status="created",
            source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id="runtime-source",
            payload_json={
                "account_ids": ["11"],
                "debit_account_id": None,
                "credit_account_id": "12",
            },
        )

        self.assertEqual(_runtime_ledger_payload_account_ids(ref), ["11", "12"])

    def test_reconciliation_accepts_signed_runtime_ledger_profit_and_loss_refs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            profit_bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            loss_bucket = _runtime_bucket(net_pnl=Decimal("-3.50"))
            session.add_all([profit_bucket, loss_bucket])
            session.flush()
            client = FakeTigerBeetleClient()
            for bucket in (profit_bucket, loss_bucket):
                plan = build_runtime_ledger_bucket_transfer_plan(bucket)
                self.assertIsNotNone(plan)
                assert plan is not None
                _add_account_refs_for_plan(session, plan)
                transfer = plan.transfer_spec
                session.add(
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id=str(transfer.transfer_id),
                        transfer_kind=transfer.transfer_kind,
                        ledger=transfer.ledger,
                        code=transfer.code,
                        amount=Decimal(transfer.amount),
                        status="created",
                        runtime_ledger_bucket_id=bucket.id,
                        source_type="strategy_runtime_ledger_bucket",
                        source_id=str(bucket.id),
                        payload_json={
                            "source": "strategy_runtime_ledger_bucket",
                            "run_id": bucket.run_id,
                            "candidate_id": bucket.candidate_id,
                            "hypothesis_id": bucket.hypothesis_id,
                            "observed_stage": bucket.observed_stage,
                            "pnl_basis": bucket.pnl_basis,
                            "ledger_schema_version": bucket.ledger_schema_version,
                            "amount_source": str(plan.amount_source),
                            "signed_amount_micros": plan.signed_amount_micros,
                            "pnl_direction": plan.pnl_direction,
                            "runtime_key": plan.runtime_key,
                            "debit_account_id": str(transfer.debit_account_id),
                            "credit_account_id": str(transfer.credit_account_id),
                        },
                    )
                )
                client.transfers[transfer.transfer_id] = transfer
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"], payload)
            self.assertEqual(payload["runtime_ledger_checked_transfer_count"], 2)
            self.assertEqual(payload["runtime_ledger_signed_transfer_count"], 2)
            self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 0)
            self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 0)
            self.assertFalse(payload["promotion_authority"])
            self.assertFalse(payload["overrides_runtime_ledger_authority"])
            self.assertFalse(payload["reconciliation_stale"])
            freshness = payload["reconciliation_freshness"]
            assert isinstance(freshness, dict)
            self.assertEqual(freshness["age_seconds"], 0)
            self.assertFalse(freshness["stale"])
            ref_counts = payload["ref_counts"]
            assert isinstance(ref_counts, dict)
            self.assertEqual(ref_counts["runtime_ledger_signed_ref_count"], 2)
            self.assertEqual(ref_counts["runtime_ledger_missing_signed_ref_count"], 0)
            self.assertEqual(ref_counts["runtime_ledger_missing_account_ref_count"], 0)
            source_materialization = ref_counts["source_materialization"]
            assert isinstance(source_materialization, dict)
            self.assertEqual(
                source_materialization["runtime_ledger_source_type"],
                SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            )

    def test_reconciliation_reports_archived_runtime_ref_without_blocking_current_ref(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            client = FakeTigerBeetleClient()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            current_transfer = plan.transfer_spec
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(current_transfer.transfer_id),
                    transfer_kind=current_transfer.transfer_kind,
                    ledger=current_transfer.ledger,
                    code=current_transfer.code,
                    amount=Decimal(current_transfer.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "run_id": bucket.run_id,
                        "candidate_id": bucket.candidate_id,
                        "hypothesis_id": bucket.hypothesis_id,
                        "observed_stage": bucket.observed_stage,
                        "pnl_basis": bucket.pnl_basis,
                        "ledger_schema_version": bucket.ledger_schema_version,
                        "amount_source": str(plan.amount_source),
                        "signed_amount_micros": plan.signed_amount_micros,
                        "pnl_direction": plan.pnl_direction,
                        "runtime_key": plan.runtime_key,
                        "debit_account_id": str(current_transfer.debit_account_id),
                        "credit_account_id": str(current_transfer.credit_account_id),
                    },
                )
            )
            archived_transfer = TigerBeetleTransferSpec(
                transfer_id=7001,
                transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                debit_account_id=11,
                credit_account_id=12,
                amount=2500000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_RUNTIME_NET_PNL,
            )
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(archived_transfer.transfer_id),
                    transfer_kind=archived_transfer.transfer_kind,
                    ledger=archived_transfer.ledger,
                    code=archived_transfer.code,
                    amount=Decimal(archived_transfer.amount),
                    status="exists",
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id="6f767a53-6b44-428a-bd85-2f662642f637",
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "run_id": "archived-runtime-run",
                        "candidate_id": "candidate",
                        "hypothesis_id": "hypothesis",
                        "amount_source": "2.50",
                        "net_strategy_pnl_after_costs": "2.50",
                        "debit_account_id": str(archived_transfer.debit_account_id),
                        "credit_account_id": str(archived_transfer.credit_account_id),
                    },
                )
            )
            session.flush()
            client.transfers[current_transfer.transfer_id] = current_transfer
            client.transfers[archived_transfer.transfer_id] = archived_transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"], payload)
            self.assertEqual(payload["runtime_ledger_checked_transfer_count"], 2)
            self.assertEqual(payload["runtime_ledger_signed_transfer_count"], 1)
            self.assertEqual(
                payload["archived_runtime_ledger_source_missing_count"],
                1,
            )
            self.assertEqual(payload["source_row_missing_count"], 0)
            self.assertEqual(payload["source_missing_count"], 0)
            self.assertNotIn(BLOCKER_SOURCE_ROW_MISSING, payload["blockers"])

    def test_reconciliation_blocks_runtime_ledger_signed_ref_coverage_gap(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            transfer = plan.transfer_spec
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(transfer.transfer_id),
                    transfer_kind=transfer.transfer_kind,
                    ledger=transfer.ledger,
                    code=transfer.code,
                    amount=Decimal(transfer.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "debit_account_id": str(transfer.debit_account_id),
                        "credit_account_id": str(transfer.credit_account_id),
                    },
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertFalse(payload["ok"], payload)
            self.assertIn(
                BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING,
                payload["blockers"],
            )
            self.assertIn(
                BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING,
                payload["blockers"],
            )
            self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 1)
            self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 2)

    def test_reconciliation_keeps_unsigned_runtime_placeholder_blocked_with_accounts(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            transfer = plan.transfer_spec
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(transfer.transfer_id),
                    transfer_kind=transfer.transfer_kind,
                    ledger=transfer.ledger,
                    code=transfer.code,
                    amount=Decimal(transfer.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "account_ids": [
                            str(transfer.debit_account_id),
                            str(transfer.credit_account_id),
                        ],
                    },
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertFalse(payload["ok"], payload)
            self.assertIn(
                BLOCKER_RUNTIME_LEDGER_SIGNED_REFS_MISSING,
                payload["blockers"],
            )
            self.assertNotIn(
                BLOCKER_RUNTIME_LEDGER_ACCOUNT_REFS_MISSING,
                payload["blockers"],
            )
            self.assertEqual(payload["runtime_ledger_signed_ref_count"], 0)
            self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 1)
            self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 0)

    def test_reconciliation_blocks_stable_ref_payload_mismatch(self) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            transfer = plan.transfer_spec
            stable_payload = tigerbeetle_stable_ref_payload(
                cluster_id=2001,
                account_specs=plan.account_specs,
                transfer_spec=transfer,
                source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                source_id=str(bucket.id),
                payload_json={
                    "runtime_key": plan.runtime_key,
                    "debit_account_id": str(transfer.debit_account_id),
                    "credit_account_id": str(transfer.credit_account_id),
                },
            )
            stable_ref = stable_payload["stable_ref"]
            assert isinstance(stable_ref, dict)
            components = stable_ref["components"]
            assert isinstance(components, dict)
            components["source_id"] = "different-runtime-bucket"
            payload_json = {
                "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                "run_id": bucket.run_id,
                "candidate_id": bucket.candidate_id,
                "hypothesis_id": bucket.hypothesis_id,
                "observed_stage": bucket.observed_stage,
                "pnl_basis": bucket.pnl_basis,
                "ledger_schema_version": bucket.ledger_schema_version,
                "amount_source": str(plan.amount_source),
                "signed_amount_micros": plan.signed_amount_micros,
                "pnl_direction": plan.pnl_direction,
                "runtime_key": plan.runtime_key,
                "debit_account_id": str(transfer.debit_account_id),
                "credit_account_id": str(transfer.credit_account_id),
                **stable_payload,
            }
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id=str(transfer.transfer_id),
                transfer_kind=transfer.transfer_kind,
                ledger=transfer.ledger,
                code=transfer.code,
                amount=Decimal(transfer.amount),
                status="created",
                runtime_ledger_bucket_id=bucket.id,
                source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                source_id=str(bucket.id),
                payload_json=payload_json,
            )
            session.add(ref)
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[transfer.transfer_id] = transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

        self.assertFalse(_stable_ref_matches(ref))
        self.assertFalse(payload["ok"], payload)
        self.assertIn(BLOCKER_STABLE_REF_PAYLOAD_MISMATCH, payload["blockers"])
        self.assertEqual(payload["stable_ref_count"], 1)
        self.assertEqual(payload["stable_ref_mismatch_count"], 1)

    def test_ref_counts_expose_source_materialization_identifiers(self) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            transfer = plan.transfer_spec
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(transfer.transfer_id),
                    transfer_kind=transfer.transfer_kind,
                    ledger=transfer.ledger,
                    code=transfer.code,
                    amount=Decimal(transfer.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "signed_amount_micros": plan.signed_amount_micros,
                        "pnl_direction": plan.pnl_direction,
                        "debit_account_id": str(transfer.debit_account_id),
                        "credit_account_id": str(transfer.credit_account_id),
                    },
                )
            )
            session.flush()

            payload = tigerbeetle_ref_counts(session, cluster_id=2001)

        self.assertEqual(payload["account_ref_count"], 4)
        self.assertEqual(payload["runtime_ledger_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_signed_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_source_ids"], [str(bucket.id)])
        self.assertEqual(
            payload["runtime_ledger_transfer_ids"],
            [str(transfer.transfer_id)],
        )
        source_materialization = payload["source_materialization"]
        assert isinstance(source_materialization, dict)
        self.assertEqual(
            source_materialization["runtime_ledger_source_table"],
            "strategy_runtime_ledger_buckets",
        )

    def test_bounded_ref_counts_preserve_signed_runtime_refs_when_sample_exact(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("2.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            transfer = plan.transfer_spec
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(transfer.transfer_id),
                    transfer_kind=transfer.transfer_kind,
                    ledger=transfer.ledger,
                    code=transfer.code,
                    amount=Decimal(transfer.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                    source_id=str(bucket.id),
                    payload_json={
                        "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                        "signed_amount_micros": plan.signed_amount_micros,
                        "pnl_direction": plan.pnl_direction,
                        "debit_account_id": str(transfer.debit_account_id),
                        "credit_account_id": str(transfer.credit_account_id),
                    },
                )
            )
            session.flush()

            payload = tigerbeetle_ref_counts(
                session,
                cluster_id=2001,
                full_ref_scan=False,
            )

        self.assertEqual(payload["runtime_ledger_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_signed_ref_count"], 1)
        self.assertEqual(payload["runtime_ledger_missing_signed_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_missing_account_ref_count"], 0)
        self.assertEqual(payload["runtime_ledger_signed_bucket_ids"], [str(bucket.id)])
        self.assertFalse(payload["runtime_ledger_ref_coverage_bounded"])

    def test_reconciliation_blocks_runtime_ledger_signed_direction_mismatch(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket(net_pnl=Decimal("-3.50"))
            session.add(bucket)
            session.flush()
            plan = build_runtime_ledger_bucket_transfer_plan(bucket)
            self.assertIsNotNone(plan)
            assert plan is not None
            _add_account_refs_for_plan(session, plan)
            expected = plan.transfer_spec
            wrong_transfer = TigerBeetleTransferSpec(
                transfer_id=expected.transfer_id,
                transfer_kind=expected.transfer_kind,
                debit_account_id=expected.credit_account_id,
                credit_account_id=expected.debit_account_id,
                amount=expected.amount,
                ledger=expected.ledger,
                code=expected.code,
            )
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=str(expected.transfer_id),
                    transfer_kind=expected.transfer_kind,
                    ledger=expected.ledger,
                    code=expected.code,
                    amount=Decimal(expected.amount),
                    status="created",
                    runtime_ledger_bucket_id=bucket.id,
                    source_type="strategy_runtime_ledger_bucket",
                    source_id=str(bucket.id),
                    payload_json={
                        "source": "strategy_runtime_ledger_bucket",
                        "run_id": bucket.run_id,
                        "candidate_id": "wrong-candidate",
                        "hypothesis_id": bucket.hypothesis_id,
                        "observed_stage": bucket.observed_stage,
                        "pnl_basis": bucket.pnl_basis,
                        "ledger_schema_version": bucket.ledger_schema_version,
                        "amount_source": str(plan.amount_source),
                        "signed_amount_micros": abs(plan.signed_amount_micros),
                        "pnl_direction": "profit",
                        "runtime_key": plan.runtime_key,
                        "debit_account_id": str(wrong_transfer.debit_account_id),
                        "credit_account_id": str(wrong_transfer.credit_account_id),
                    },
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[expected.transfer_id] = wrong_transfer

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertFalse(payload["ok"])
            self.assertIn(
                BLOCKER_RUNTIME_LEDGER_DIRECTION_MISMATCH, payload["blockers"]
            )
            self.assertIn(BLOCKER_RUNTIME_LEDGER_METADATA_MISMATCH, payload["blockers"])
            self.assertEqual(payload["runtime_ledger_signed_transfer_count"], 0)
            self.assertEqual(payload["runtime_ledger_direction_mismatch_count"], 1)
            self.assertEqual(payload["runtime_ledger_metadata_mismatch_count"], 1)

    def test_reconciliation_blocks_code_and_ledger_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)
            client = FakeTigerBeetleClient()
            client.transfers[1001] = TigerBeetleTransferSpec(
                transfer_id=1001,
                transfer_kind="fill_post",
                debit_account_id=11,
                credit_account_id=12,
                amount=190250000,
                ledger=999,
                code=999,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_CODE_MISMATCH, payload["blockers"])
            self.assertIn(BLOCKER_LEDGER_MISMATCH, payload["blockers"])

    def test_reconciliation_blocks_account_mismatch(self) -> None:
        with Session(self.engine) as session:
            _add_ref(
                session,
                payload_json={"debit_account_id": "11", "credit_account_id": "12"},
            )
            client = FakeTigerBeetleClient()
            client.transfers[1001] = TigerBeetleTransferSpec(
                transfer_id=1001,
                transfer_kind="fill_post",
                debit_account_id=99,
                credit_account_id=98,
                amount=190250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_FILL_POST,
            )

            payload = reconcile_tigerbeetle_transfers(
                session, settings_obj=_settings(), client=client
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_DEBIT_ACCOUNT_MISMATCH, payload["blockers"])
            self.assertIn(BLOCKER_CREDIT_ACCOUNT_MISMATCH, payload["blockers"])

    def test_reconciliation_blocks_postgres_ref_that_no_longer_matches_event(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="linked-unjournalable-event",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                event_type="accepted",
                status="accepted",
                raw_event={"event": "accepted"},
            )
            session.add(event)
            session.flush()
            mismatched_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="1001",
                transfer_kind="fill_post",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_FILL_POST,
                amount=Decimal("190250000"),
                status="created",
                event_fingerprint=event.event_fingerprint,
                execution_order_event_id=event.id,
                payload_json={
                    "debit_account_id": "11",
                    "credit_account_id": "12",
                },
            )
            session.add(mismatched_ref)
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_POSTGRES_REF_MISMATCH, payload["blockers"])
            mismatched_refs = payload["mismatched_refs"]
            assert isinstance(mismatched_refs, list)
            self.assertEqual(mismatched_refs[0]["row_id"], str(mismatched_ref.id))
            self.assertEqual(
                mismatched_refs[0]["blocker"],
                BLOCKER_POSTGRES_REF_MISMATCH,
            )

    def test_reconciliation_blocks_unlinked_order_event(self) -> None:
        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="unlinked-fill",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=1,
                    alpaca_account_label="paper",
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("190.25"),
                    raw_event={"event": "fill"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_EVENT, payload["blockers"])
            self.assertEqual(payload["source_missing_count"], 1)

    def test_reconciliation_treats_source_id_order_event_ref_as_linked(self) -> None:
        with Session(self.engine) as session:
            event = ExecutionOrderEvent(
                event_fingerprint="source-id-linked-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=1,
                alpaca_account_label="paper",
                event_ts=datetime.now(timezone.utc),
                symbol="AAPL",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "fill"},
            )
            session.add(event)
            session.flush()
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id="1001",
                    transfer_kind="fill_post",
                    ledger=LEDGER_USD_MICRO,
                    code=TRANSFER_CODE_FILL_POST,
                    amount=Decimal("190250000"),
                    status="created",
                    source_type="execution_order_event",
                    source_id=str(event.id),
                    event_fingerprint=event.event_fingerprint,
                )
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1001] = _transfer()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["unlinked_event_count"], 0)
            self.assertNotIn(BLOCKER_UNLINKED_EVENT, payload["blockers"])

    def test_reconciliation_blocks_unlinked_execution_ref(self) -> None:
        with Session(self.engine) as session:
            session.add(
                Execution(
                    alpaca_account_label="paper",
                    alpaca_order_id="order-unlinked-execution",
                    client_order_id="client-unlinked-execution",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("190.25"),
                    status="filled",
                    raw_order={"id": "order-unlinked-execution"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_EXECUTION, payload["blockers"])
            self.assertEqual(payload["unlinked_execution_count"], 1)

    def test_reconciliation_blocks_unlinked_cost_ref(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-unlinked-cost",
                client_order_id="client-unlinked-cost",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-unlinked-cost"},
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
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_COST, payload["blockers"])
            self.assertEqual(payload["unlinked_cost_count"], 1)

    def test_reconciliation_treats_fk_linked_cost_ref_as_linked(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-linked-cost",
                client_order_id="client-linked-cost",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-linked-cost"},
            )
            session.add(execution)
            session.flush()
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            session.add_all(
                [
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id="1005",
                        transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                        ledger=LEDGER_USD_MICRO,
                        code=TRANSFER_CODE_EXECUTION_FILL,
                        amount=Decimal("190250000"),
                        status="created",
                        execution_id=execution.id,
                        source_type=SOURCE_TYPE_EXECUTION,
                        source_id=str(execution.id),
                        payload_json={"amount_source": "190.25"},
                    ),
                    TigerBeetleTransferRef(
                        cluster_id=2001,
                        transfer_id="1006",
                        transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                        ledger=LEDGER_USD_MICRO,
                        code=TRANSFER_CODE_EXECUTION_FILL,
                        amount=Decimal("250000"),
                        status="created",
                        execution_id=execution.id,
                        execution_tca_metric_id=metric.id,
                        source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
                        source_id=str(metric.id),
                    ),
                ]
            )
            session.flush()
            client = FakeTigerBeetleClient()
            client.transfers[1005] = TigerBeetleTransferSpec(
                transfer_id=1005,
                transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
                debit_account_id=11,
                credit_account_id=12,
                amount=190250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )
            client.transfers[1006] = TigerBeetleTransferSpec(
                transfer_id=1006,
                transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                debit_account_id=11,
                credit_account_id=13,
                amount=250000,
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
            )

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=client,
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["unlinked_cost_count"], 0)
            self.assertNotIn(BLOCKER_UNLINKED_COST, payload["blockers"])

    def test_reconciliation_blocks_unlinked_runtime_ledger_ref(self) -> None:
        with Session(self.engine) as session:
            observed_at = datetime.now(timezone.utc)
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="runtime-run-unlinked",
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
                    payload_json={"source": "representative-runtime-ledger"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_UNLINKED_RUNTIME_LEDGER, payload["blockers"])
            self.assertEqual(payload["unlinked_runtime_ledger_count"], 1)

    def test_reconciliation_ignores_unjournalable_lifecycle_event(self) -> None:
        with Session(self.engine) as session:
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="accepted-without-price",
                    source_topic="torghut.trade-updates.v1",
                    source_partition=0,
                    source_offset=1,
                    alpaca_account_label="paper",
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    event_type="accepted",
                    status="accepted",
                    qty=Decimal("1"),
                    raw_event={"event": "accepted"},
                )
            )
            session.flush()

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )

            self.assertTrue(payload["ok"])
            self.assertEqual(payload["unlinked_event_count"], 0)

    def test_reconciliation_blocks_client_unavailable(self) -> None:
        with Session(self.engine) as session:
            _add_ref(session)

            payload = reconcile_tigerbeetle_transfers(
                session,
                settings_obj=_settings(),
                client=FailingLookupClient(),
            )

            self.assertFalse(payload["ok"])
            self.assertIn(BLOCKER_CLIENT_UNAVAILABLE, payload["blockers"])
            self.assertNotIn(BLOCKER_TRANSFER_MISSING, payload["blockers"])
            self.assertFalse(payload["client_lookup_ok"])
            self.assertIn("RuntimeError: lookup failed", str(payload["client_error"]))
            self.assertEqual(payload["missing_transfer_count"], 0)
            self.assertEqual(payload["missing_transfer_refs"], [])

    def test_latest_reconciliation_payload_normalizes_blockers(self) -> None:
        with Session(self.engine) as session:
            session.add(
                TigerBeetleReconciliationRun(
                    cluster_id=2001,
                    started_at=datetime.now(timezone.utc),
                    finished_at=datetime.now(timezone.utc),
                    status="degraded",
                    checked_transfer_count=2,
                    missing_transfer_count=0,
                    mismatched_transfer_count=1,
                    source_missing_count=0,
                    payload_json={
                        "blockers": [BLOCKER_CODE_MISMATCH, 7],
                        "client_lookup_ok": False,
                        "client_error": "RuntimeError: lookup failed",
                        "mismatched_ref_count": 1,
                        "missing_source_row_count": 3,
                        "unlinked_order_event_ref_count": 4,
                        "mismatched_refs": [
                            {
                                "blocker": BLOCKER_CODE_MISMATCH,
                                "row_id": "ref-1",
                            }
                        ],
                        "blocker_details": {
                            "mismatched_refs": [
                                {
                                    "blocker": BLOCKER_CODE_MISMATCH,
                                    "row_id": "ref-1",
                                }
                            ]
                        },
                        "ref_counts": {
                            "account_ref_count": 1,
                            "transfer_ref_count": 2,
                            "runtime_ledger_ref_count": 5,
                            "runtime_ledger_signed_ref_count": 4,
                        },
                    },
                )
            )
            session.flush()

            payload = latest_tigerbeetle_reconciliation_payload(
                session,
                cluster_id=2001,
            )

        self.assertIsNotNone(payload)
        assert payload is not None
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["blockers"], [BLOCKER_CODE_MISMATCH, "7"])
        self.assertEqual(payload["account_ref_count"], 1)
        self.assertEqual(payload["transfer_ref_count"], 2)
        self.assertEqual(payload["runtime_ledger_ref_count"], 5)
        self.assertEqual(payload["runtime_ledger_signed_ref_count"], 4)
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["overrides_runtime_ledger_authority"])
        self.assertFalse(payload["client_lookup_ok"])
        self.assertEqual(payload["client_error"], "RuntimeError: lookup failed")
        self.assertIn("reconciliation_freshness", payload)
        self.assertEqual(payload["mismatched_ref_count"], 1)
        self.assertEqual(payload["missing_source_row_count"], 3)
        self.assertEqual(payload["unlinked_order_event_ref_count"], 4)
        self.assertEqual(
            payload["mismatched_refs"],
            [{"blocker": BLOCKER_CODE_MISMATCH, "row_id": "ref-1"}],
        )
        self.assertEqual(
            payload["ref_counts"],
            {
                "account_ref_count": 1,
                "transfer_ref_count": 2,
                "runtime_ledger_ref_count": 5,
                "runtime_ledger_signed_ref_count": 4,
            },
        )

    def test_attr_helper_supports_mapping_and_transfer_id_fallbacks(self) -> None:
        self.assertEqual(_attr({"transfer_id": 44}, "id"), 44)
        self.assertEqual(_attr(type("TransferId", (), {"transfer_id": 45})(), "id"), 45)
        with self.assertRaises(AttributeError):
            _attr(object(), "id")

    def test_source_amount_helpers_handle_invalid_and_zero_values(self) -> None:
        self.assertEqual(_payload_int({"value": "42"}, "value"), 42)
        self.assertEqual(_payload_int({"value": object()}, "value"), 0)
        self.assertEqual(_payload_int({}, "value"), 0)
        self.assertIsNone(_uuid_or_none(None))
        self.assertIsNone(_uuid_or_none("not-a-uuid"))
        self.assertEqual(
            str(_uuid_or_none("6f767a53-6b44-428a-bd85-2f662642f637:revision")),
            "6f767a53-6b44-428a-bd85-2f662642f637",
        )
        self.assertIsNone(_usd_to_micros(None))
        self.assertIsNone(_usd_to_micros(Decimal("0")))
        self.assertIsNone(_usd_to_micros(Decimal("0.0000001")))
        self.assertEqual(_usd_to_micros(Decimal("-1.25")), Decimal("1250000"))
        self.assertIsNone(_execution_amount_micros(None))
        self.assertIsNone(_cost_amount_micros(None))
        self.assertIsNone(_runtime_ledger_amount_micros(None))
        archived_ref = TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id="9001",
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            ledger=LEDGER_USD_MICRO,
            code=TRANSFER_CODE_RUNTIME_NET_PNL,
            amount=Decimal("1250000"),
            status="exists",
            source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id="6f767a53-6b44-428a-bd85-2f662642f637",
            payload_json={},
        )
        self.assertIsNone(_archived_runtime_ledger_amount_micros(archived_ref))
        archived_ref.payload_json = {"amount_source": object()}
        self.assertIsNone(_archived_runtime_ledger_amount_micros(archived_ref))
        archived_ref.payload_json = {"amount_source": "-1.25"}
        self.assertEqual(
            _archived_runtime_ledger_amount_micros(archived_ref),
            Decimal("1250000"),
        )

    def test_expected_source_amount_supports_cost_and_runtime_refs(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                alpaca_account_label="paper",
                alpaca_order_id="order-source-helper",
                client_order_id="client-source-helper",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                status="filled",
                raw_order={"id": "order-source-helper"},
            )
            session.add(execution)
            session.flush()
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("-0.25"),
                computed_at=datetime.now(timezone.utc),
            )
            observed_at = datetime.now(timezone.utc)
            bucket = StrategyRuntimeLedgerBucket(
                run_id="runtime-run-helper",
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
                gross_strategy_pnl=Decimal("0"),
                cost_amount=Decimal("-0.50"),
                net_strategy_pnl_after_costs=Decimal("0"),
                post_cost_expectancy_bps=Decimal("12.50"),
                ledger_schema_version="torghut.runtime-ledger.v1",
                pnl_basis="post_cost",
                payload_json={"source": "helper"},
            )
            session.add_all([metric, bucket])
            session.flush()

            cost_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2001",
                transfer_kind="execution_cost",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("250000"),
                status="created",
                source_type="execution_tca_metric",
                source_id=f"{metric.id}:revision",
            )
            archived_cost_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2005",
                transfer_kind="execution_cost",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("250000"),
                status="created",
                source_type="execution_tca_metric",
                source_id=f"{metric.id}:archived",
                payload_json={"amount_source": "0.25"},
            )
            metric.shortfall_notional = Decimal("0.75")
            runtime_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2002",
                transfer_kind="runtime_net_pnl",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("500000"),
                status="created",
                source_type="strategy_runtime_ledger_bucket",
                source_id=str(bucket.id),
            )
            unknown_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2003",
                transfer_kind="runtime_net_pnl",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("500000"),
                status="created",
                source_type="untracked",
                source_id=str(bucket.id),
            )
            invalid_ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="2004",
                transfer_kind="runtime_net_pnl",
                ledger=LEDGER_USD_MICRO,
                code=TRANSFER_CODE_EXECUTION_FILL,
                amount=Decimal("500000"),
                status="created",
                source_type="strategy_runtime_ledger_bucket",
                source_id="not-a-uuid",
            )

            self.assertEqual(
                _expected_source_amount_micros(session, cost_ref), Decimal("750000")
            )
            self.assertEqual(
                _expected_source_amount_micros(session, archived_cost_ref),
                Decimal("250000"),
            )
            self.assertEqual(
                _expected_source_amount_micros(session, runtime_ref), Decimal("500000")
            )
            self.assertIsNone(_expected_source_amount_micros(session, unknown_ref))
            self.assertIsNone(_expected_source_amount_micros(session, invalid_ref))
