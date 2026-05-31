from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
    TigerBeetleReconciliationRun,
    TigerBeetleTransferRef,
)
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TRANSFER_CODE_EXECUTION_FILL,
    TRANSFER_CODE_FILL_POST,
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
    BLOCKER_SOURCE_ROW_MISSING,
    BLOCKER_UNLINKED_COST,
    BLOCKER_UNLINKED_EXECUTION,
    BLOCKER_SOURCE_AMOUNT_MISMATCH,
    BLOCKER_UNLINKED_RUNTIME_LEDGER,
    BLOCKER_TRANSFER_MISSING,
    BLOCKER_UNLINKED_EVENT,
    _attr,
    _cost_amount_micros,
    _expected_source_amount_micros,
    _execution_amount_micros,
    _payload_int,
    _runtime_ledger_amount_micros,
    _usd_to_micros,
    _uuid_or_none,
    latest_tigerbeetle_reconciliation_payload,
    reconcile_tigerbeetle_transfers,
)


class FailingLookupClient(FakeTigerBeetleClient):
    def lookup_transfers(self, ids: list[int]) -> list[object]:
        raise RuntimeError("lookup failed")


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
                    source_id=str(execution.id),
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

    def test_reconciliation_blocks_source_row_missing(self) -> None:
        with Session(self.engine) as session:
            missing_id = "6f767a53-6b44-428a-bd85-2f662642f637"
            session.add(
                TigerBeetleTransferRef(
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
            )
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
            session.add(
                TigerBeetleTransferRef(
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
            )
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
                        "ref_counts": {"transfer_ref_count": 2},
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
        self.assertEqual(payload["ref_counts"], {"transfer_ref_count": 2})

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
        self.assertIsNone(_usd_to_micros(None))
        self.assertIsNone(_usd_to_micros(Decimal("0")))
        self.assertIsNone(_usd_to_micros(Decimal("0.0000001")))
        self.assertEqual(_usd_to_micros(Decimal("-1.25")), Decimal("1250000"))
        self.assertIsNone(_execution_amount_micros(None))
        self.assertIsNone(_cost_amount_micros(None))
        self.assertIsNone(_runtime_ledger_amount_micros(None))

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
                source_id=str(metric.id),
            )
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

            self.assertEqual(_expected_source_amount_micros(session, cost_ref), Decimal("250000"))
            self.assertEqual(_expected_source_amount_micros(session, runtime_ref), Decimal("500000"))
            self.assertIsNone(_expected_source_amount_micros(session, unknown_ref))
            self.assertIsNone(_expected_source_amount_micros(session, invalid_ref))
