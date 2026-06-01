from __future__ import annotations

from collections.abc import Sequence
import sys
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    Strategy,
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    TradeDecision,
)
from app.trading.tigerbeetle_client import FakeTigerBeetleClient
from app.trading.tigerbeetle_journal import (
    TIGERBEETLE_AUTHORITY_BLOCKER_ACCOUNTING_ONLY,
    TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING,
    TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    TigerBeetleLedgerJournal,
    _account_specs,
    _event_amount_usd,
    _lookup_payload_decimal,
    _order_event_precedes,
    _persist_account_refs,
    _positive_payload_count,
    _result_status,
    _transfer_attr,
    _transfer_flag,
    _transfer_ref_mismatches,
    _transfer_spec,
    build_order_event_transfer_plan,
    submitted_pending_transfer_id,
    event_transfer_id,
    execution_cost_transfer_id,
    execution_transfer_id,
    runtime_ledger_transfer_id,
    tigerbeetle_runtime_ledger_journal_payload,
)
from app.trading.tigerbeetle_ids import u128_decimal
from app.trading.tigerbeetle_ledger_model import (
    LEDGER_USD_MICRO,
    TigerBeetleAccountSpec,
    TRANSFER_KIND_CANCEL_VOID,
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TRANSFER_KIND_SUBMITTED_PENDING,
    TigerBeetleTransferSpec,
    decimal_usd_to_micros,
)


class ClosableFakeTigerBeetleClient(FakeTigerBeetleClient):
    def __init__(self) -> None:
        super().__init__()
        self.close_count = 0

    def close(self) -> None:
        self.close_count += 1


class NumericExistsFakeTigerBeetleClient(FakeTigerBeetleClient):
    def create_transfers(self, transfers: Sequence[object]) -> list[SimpleNamespace]:
        del transfers
        return [SimpleNamespace(status=46)]


class _ScalarResult:
    def __init__(self, value: TigerBeetleAccountRef | None) -> None:
        self._value = value

    def scalar_one_or_none(self) -> TigerBeetleAccountRef | None:
        return self._value


class _NestedTransaction:
    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> bool:
        return False


class _RacingAccountRefSession:
    def __init__(
        self, existing_after_integrity_error: TigerBeetleAccountRef | None
    ) -> None:
        self._existing_after_integrity_error = existing_after_integrity_error
        self.execute_count = 0
        self.added_refs: list[TigerBeetleAccountRef] = []

    def execute(self, statement: object) -> _ScalarResult:
        del statement
        self.execute_count += 1
        if self.execute_count == 1:
            return _ScalarResult(None)
        return _ScalarResult(self._existing_after_integrity_error)

    def begin_nested(self) -> _NestedTransaction:
        return _NestedTransaction()

    def add(self, value: TigerBeetleAccountRef) -> None:
        self.added_refs.append(value)

    def flush(self) -> None:
        raise IntegrityError(
            "insert tigerbeetle account ref", {}, RuntimeError("duplicate")
        )


def _settings(*, enabled: bool = True, journal_enabled: bool = True) -> Settings:
    return Settings(
        TORGHUT_TIGERBEETLE_ENABLED=enabled,
        TORGHUT_TIGERBEETLE_JOURNAL_ENABLED=journal_enabled,
    )


def _create_fill_event(
    session: Session, *, fingerprint: str = "fingerprint-1"
) -> ExecutionOrderEvent:
    strategy = Strategy(
        name=f"demo-{fingerprint}",
        description="demo strat",
        enabled=True,
        base_timeframe="1Min",
        universe_type="symbols_list",
        universe_symbols=["AAPL"],
    )
    session.add(strategy)
    session.flush()

    decision = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label="paper",
        symbol="AAPL",
        timeframe="1Min",
        decision_json={"side": "buy"},
        decision_hash=f"decision-{fingerprint}",
    )
    session.add(decision)
    session.flush()

    execution = Execution(
        trade_decision_id=decision.id,
        alpaca_account_label="paper",
        alpaca_order_id=f"order-{fingerprint}",
        client_order_id=f"client-{fingerprint}",
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("1"),
        avg_fill_price=Decimal("190.25"),
        status="filled",
        raw_order={"id": f"order-{fingerprint}"},
    )
    session.add(execution)
    session.flush()

    event = ExecutionOrderEvent(
        event_fingerprint=fingerprint,
        source_topic="torghut.trade-updates.v1",
        source_partition=0,
        source_offset=sum(ord(ch) for ch in fingerprint),
        alpaca_account_label="paper",
        event_ts=datetime.now(timezone.utc),
        symbol="AAPL",
        alpaca_order_id=execution.alpaca_order_id,
        client_order_id=execution.client_order_id,
        event_type="fill",
        status="filled",
        qty=Decimal("1"),
        filled_qty=Decimal("1"),
        avg_fill_price=Decimal("190.25"),
        raw_event={"event": "fill"},
        execution_id=execution.id,
        trade_decision_id=decision.id,
    )
    session.add(event)
    session.flush()
    return event


def _runtime_bucket() -> StrategyRuntimeLedgerBucket:
    observed_at = datetime.now(timezone.utc)
    return StrategyRuntimeLedgerBucket(
        run_id="runtime-run-1",
        candidate_id="candidate-1",
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
        filled_notional=Decimal("190.25"),
        gross_strategy_pnl=Decimal("3.00"),
        cost_amount=Decimal("0.50"),
        net_strategy_pnl_after_costs=Decimal("2.50"),
        post_cost_expectancy_bps=Decimal("12.50"),
        ledger_schema_version="torghut.runtime-ledger.v1",
        pnl_basis="post_cost",
        payload_json={"source": "representative-runtime-ledger"},
    )


class TestTigerBeetleLedgerJournal(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def test_disabled_journal_is_noop(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session)
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNone(ref)
            self.assertEqual(client.transfers, {})

    def test_source_journals_skip_disabled_and_unamounted_rows(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-source-noop")
            execution = event.execution
            self.assertIsNotNone(execution)
            assert execution is not None
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0"),
                computed_at=datetime.now(timezone.utc),
            )
            bucket = _runtime_bucket()
            bucket.net_strategy_pnl_after_costs = Decimal("0")
            bucket.cost_amount = Decimal("0")
            session.add_all([metric, bucket])
            session.flush()
            client = FakeTigerBeetleClient()
            disabled = TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False),
                client=client,
            )

            self.assertIsNone(disabled.journal_execution(session, execution))
            self.assertIsNone(disabled.journal_execution_tca_metric(session, metric))
            self.assertIsNone(disabled.journal_runtime_ledger_bucket(session, bucket))

            enabled = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)
            execution.avg_fill_price = None
            self.assertIsNone(enabled.journal_execution(session, execution))
            self.assertIsNone(enabled.journal_execution_tca_metric(session, metric))
            self.assertIsNone(enabled.journal_runtime_ledger_bucket(session, bucket))
            self.assertEqual(client.transfers, {})

    def test_repeated_same_event_creates_one_transfer_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session)
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            first = journal.journal_order_event(session, event)
            second = journal.journal_order_event(session, event)

            self.assertIsNotNone(first)
            self.assertEqual(first, second)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 1)
            self.assertEqual(refs[0].amount, Decimal("190250000"))
            self.assertEqual(refs[0].ledger, LEDGER_USD_MICRO)
            self.assertEqual(len(client.transfers), 1)

    def test_owned_client_is_reused_and_closed(self) -> None:
        with Session(self.engine) as session:
            first = _create_fill_event(session, fingerprint="client-reuse-1")
            second = _create_fill_event(session, fingerprint="client-reuse-2")
            client = ClosableFakeTigerBeetleClient()

            with patch(
                "app.trading.tigerbeetle_journal.create_tigerbeetle_client",
                return_value=client,
            ) as factory:
                with TigerBeetleLedgerJournal(settings_obj=_settings()) as journal:
                    self.assertIsNotNone(journal.journal_order_event(session, first))
                    self.assertIsNotNone(journal.journal_order_event(session, second))

            self.assertEqual(factory.call_count, 1)
            self.assertEqual(client.close_count, 1)
            self.assertEqual(len(client.transfers), 2)

    def test_reconciliation_client_is_disabled_when_journal_is_disabled(
        self,
    ) -> None:
        client = FakeTigerBeetleClient()

        self.assertIsNone(
            TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False),
                client=client,
            ).client_for_reconciliation()
        )
        self.assertIsNone(
            TigerBeetleLedgerJournal(
                settings_obj=_settings(journal_enabled=False),
                client=client,
            ).client_for_reconciliation()
        )

    def test_reconciliation_client_reuses_owned_journal_client(self) -> None:
        client = ClosableFakeTigerBeetleClient()

        with patch(
            "app.trading.tigerbeetle_journal.create_tigerbeetle_client",
            return_value=client,
        ) as factory:
            with TigerBeetleLedgerJournal(settings_obj=_settings()) as journal:
                self.assertIs(journal.client_for_reconciliation(), client)
                self.assertIs(journal.client_for_reconciliation(), client)

        self.assertEqual(factory.call_count, 1)
        self.assertEqual(client.close_count, 1)

    def test_real_fractional_notional_rounds_to_nearest_micro(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fractional-notional")
            event.filled_qty = Decimal("1")
            event.qty = Decimal("1")
            event.avg_fill_price = Decimal("1.0000005")
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(session, event)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.amount, Decimal("1000001"))
            transfer = client.transfers[int(ref.transfer_id)]
            self.assertEqual(getattr(transfer, "amount"), 1000001)

    def test_fill_without_pending_ref_uses_standalone_transfer(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-standalone")
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertIsNone(ref.payload_json["pending_id"])
            self.assertEqual(ref.payload_json["pending_mode"], "standalone_fill")
            transfer = client.transfers[int(ref.transfer_id)]
            self.assertEqual(getattr(transfer, "pending_id"), 0)
            self.assertEqual(getattr(transfer, "flags"), 0)

    def test_fill_with_pending_ref_uses_post_pending_transfer(self) -> None:
        with Session(self.engine) as session:
            fill = _create_fill_event(session, fingerprint="fingerprint-post-pending")
            submitted = ExecutionOrderEvent(
                event_fingerprint="fingerprint-post-pending-submitted",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=10,
                alpaca_account_label=fill.alpaca_account_label,
                event_ts=datetime.now(timezone.utc),
                symbol=fill.symbol,
                alpaca_order_id=fill.alpaca_order_id,
                client_order_id=fill.client_order_id,
                event_type="new",
                status="new",
                qty=Decimal("1"),
                avg_fill_price=Decimal("190.25"),
                raw_event={"event": "new", "price": "190.25"},
                execution_id=fill.execution_id,
                trade_decision_id=fill.trade_decision_id,
            )
            session.add(submitted)
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            pending_ref = journal.journal_order_event(session, submitted)
            fill_ref = journal.journal_order_event(session, fill)

            self.assertIsNotNone(pending_ref)
            self.assertIsNotNone(fill_ref)
            assert fill_ref is not None
            self.assertEqual(
                fill_ref.payload_json["pending_id"],
                str(submitted_pending_transfer_id(fill)),
            )
            self.assertEqual(
                fill_ref.payload_json["pending_mode"], "pending_transfer_ref"
            )

    def test_execution_source_writes_real_execution_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-execution")
            execution = event.execution
            self.assertIsNotNone(execution)
            assert execution is not None
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_execution(session, execution)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.source_type, "execution")
            self.assertEqual(ref.source_id, str(execution.id))
            self.assertEqual(ref.execution_id, execution.id)
            self.assertEqual(ref.transfer_kind, TRANSFER_KIND_EXECUTION_FILL)
            self.assertEqual(ref.transfer_id, str(execution_transfer_id(execution)))
            self.assertEqual(ref.amount, Decimal("190250000"))
            self.assertIn(int(ref.transfer_id), client.transfers)

    def test_cost_source_writes_real_tca_metric_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-cost")
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_execution_tca_metric(session, metric)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.source_type, "execution_tca_metric")
            self.assertEqual(ref.source_id, str(metric.id))
            self.assertEqual(ref.execution_tca_metric_id, metric.id)
            self.assertEqual(ref.transfer_kind, TRANSFER_KIND_EXECUTION_COST)
            self.assertEqual(ref.transfer_id, str(execution_cost_transfer_id(metric)))
            self.assertEqual(ref.amount, Decimal("250000"))
            self.assertEqual(
                ref.payload_json["source_refs"],
                [
                    f"postgres:execution_tca_metrics:{metric.id}",
                    f"postgres:executions:{metric.execution_id}",
                ],
            )
            self.assertEqual(
                ref.payload_json["economic_event_key"],
                f"execution:{metric.execution_id}:tca_metric:{metric.id}:execution_cost",
            )
            self.assertEqual(ref.payload_json["amount_source"], "0.25")
            self.assertEqual(ref.payload_json["ledger"], LEDGER_USD_MICRO)
            self.assertEqual(ref.payload_json["code"], 2011)
            self.assertEqual(ref.payload_json["transfer_id"], ref.transfer_id)

    def test_cost_source_retry_for_same_metric_is_idempotent(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-cost-retry")
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            first = journal.journal_execution_tca_metric(session, metric)
            second = journal.journal_execution_tca_metric(session, metric)

            self.assertIsNotNone(first)
            self.assertEqual(first, second)
            refs = session.execute(select(TigerBeetleTransferRef)).scalars().all()
            self.assertEqual(len(refs), 1)
            self.assertEqual(len(client.transfers), 1)

    def test_cost_source_same_ref_different_payload_is_blocked(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(
                session, fingerprint="fingerprint-cost-payload-conflict"
            )
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            expected_transfer_id = str(execution_cost_transfer_id(metric))
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=expected_transfer_id,
                    transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                    ledger=LEDGER_USD_MICRO,
                    code=2011,
                    amount=Decimal("999"),
                    status="created",
                    execution_id=metric.execution_id,
                    execution_tca_metric_id=metric.id,
                    source_type="execution_tca_metric",
                    source_id=str(metric.id),
                    payload_json={
                        "debit_account_id": "1",
                        "credit_account_id": "2",
                    },
                )
            )
            session.flush()

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_transfer_ref_conflict:.*amount.*debit_account_id.*credit_account_id",
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_execution_tca_metric(session, metric)

    def test_cost_source_same_ref_different_currency_is_blocked(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(
                session, fingerprint="fingerprint-cost-ledger-conflict"
            )
            metric = ExecutionTCAMetric(
                execution_id=event.execution_id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0.25"),
                realized_shortfall_bps=Decimal("1.3"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(metric)
            session.flush()
            expected_transfer_id = str(execution_cost_transfer_id(metric))
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=2001,
                    transfer_id=expected_transfer_id,
                    transfer_kind=TRANSFER_KIND_EXECUTION_COST,
                    ledger=LEDGER_USD_MICRO + 1,
                    code=2011,
                    amount=Decimal("250000"),
                    status="created",
                    execution_id=metric.execution_id,
                    execution_tca_metric_id=metric.id,
                    source_type="execution_tca_metric",
                    source_id=str(metric.id),
                    payload_json={},
                )
            )
            session.flush()

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_transfer_ref_conflict:ledger",
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_execution_tca_metric(session, metric)

    def test_transfer_ref_mismatch_details_cover_identity_kind_code_and_pending(
        self,
    ) -> None:
        expected = TigerBeetleTransferSpec(
            transfer_id=123,
            transfer_kind=TRANSFER_KIND_FILL_POST,
            debit_account_id=11,
            credit_account_id=22,
            amount=1000,
            ledger=LEDGER_USD_MICRO,
            code=2001,
            pending_id=456,
        )
        ref = TigerBeetleTransferRef(
            cluster_id=2001,
            transfer_id="999",
            transfer_kind=TRANSFER_KIND_EXECUTION_COST,
            ledger=LEDGER_USD_MICRO,
            code=2999,
            amount=Decimal("1000"),
            status="created",
            payload_json={"pending_id": "999"},
        )

        self.assertEqual(
            _transfer_ref_mismatches(ref, expected),
            ["transfer_id", "transfer_kind", "code", "pending_id"],
        )

    def test_runtime_bucket_source_writes_real_runtime_ledger_ref(self) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket()
            bucket.payload_json = {
                "source_refs": ["postgres:execution_order_events:event-1"],
                "source_window_refs": ["postgres:source_windows:window-1"],
            }
            session.add(bucket)
            session.flush()
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_runtime_ledger_bucket(session, bucket)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.source_type, "strategy_runtime_ledger_bucket")
            self.assertEqual(ref.source_id, str(bucket.id))
            self.assertEqual(ref.runtime_ledger_bucket_id, bucket.id)
            self.assertEqual(ref.transfer_kind, TRANSFER_KIND_RUNTIME_NET_PNL)
            self.assertEqual(ref.transfer_id, str(runtime_ledger_transfer_id(bucket)))
            self.assertEqual(ref.amount, Decimal("2500000"))
            self.assertEqual(ref.payload_json["pnl_direction"], "profit")
            self.assertEqual(ref.payload_json["signed_amount_micros"], 2500000)
            parity = tigerbeetle_runtime_ledger_journal_payload(
                bucket=bucket,
                ref=ref,
                status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
            )
            self.assertEqual(parity["status"], "pass")
            self.assertFalse(parity["promotion_authority"])
            self.assertIn(
                TIGERBEETLE_AUTHORITY_BLOCKER_ACCOUNTING_ONLY,
                parity["authority_blockers"],
            )
            self.assertNotIn(
                TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING,
                parity["authority_blockers"],
            )
            self.assertNotIn(
                TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING,
                parity["authority_blockers"],
            )
            transfer = client.transfers[int(ref.transfer_id)]
            self.assertEqual(
                ref.payload_json["debit_account_id"],
                str(getattr(transfer, "debit_account_id")),
            )
            self.assertEqual(
                ref.payload_json["credit_account_id"],
                str(getattr(transfer, "credit_account_id")),
            )

    def test_runtime_bucket_journal_payload_marks_aggregate_only_non_authority(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket()
            bucket.payload_json = {"source": "aggregate-only-fixture"}
            session.add(bucket)
            session.flush()
            client = FakeTigerBeetleClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_runtime_ledger_bucket(session, bucket)

        self.assertIsNotNone(ref)
        assert ref is not None
        parity = tigerbeetle_runtime_ledger_journal_payload(
            bucket=bucket,
            ref=ref,
            status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
        )
        self.assertFalse(parity["promotion_authority"])
        self.assertFalse(parity["overrides_runtime_ledger_authority"])
        self.assertIn(
            TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING,
            parity["authority_blockers"],
        )
        self.assertIn(
            TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING,
            parity["authority_blockers"],
        )

    def test_source_authority_count_parser_rejects_invalid_values(self) -> None:
        self.assertFalse(_positive_payload_count("not-a-number"))

    def test_runtime_bucket_journal_payload_merges_transfer_account_refs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            bucket = _runtime_bucket()
            session.add(bucket)
            session.flush()
            ref = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id="340282366920938463463374607431768210",
                transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
                ledger=LEDGER_USD_MICRO,
                code=2001,
                amount=Decimal("2500000"),
                status="created",
                runtime_ledger_bucket_id=bucket.id,
                payload_json={
                    "debit_account_id": "100100100100100100100100100100100101",
                    "credit_account_id": "100100100100100100100100100100100102",
                },
            )
            duplicate_cash_ref = TigerBeetleAccountRef(
                cluster_id=2001,
                account_id="100100100100100100100100100100100101",
                account_key="TORGHUT_SIM:cash",
                ledger=840001,
                code=1001,
                account_label="paper",
            )
            missing_fee_ref = TigerBeetleAccountRef(
                cluster_id=2002,
                account_id="100100100100100100100100100100100103",
                account_key="TORGHUT_SIM:fees",
                ledger=840001,
                code=1003,
                account_label="paper",
            )
            session.add_all([ref, duplicate_cash_ref, missing_fee_ref])
            session.flush()

            parity = tigerbeetle_runtime_ledger_journal_payload(
                bucket=bucket,
                ref=ref,
                status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
                account_refs=[duplicate_cash_ref, missing_fee_ref],
            )

        self.assertEqual(parity["cluster_ids"], [2001, 2002])
        self.assertEqual(
            parity["account_ids"],
            [
                "100100100100100100100100100100100101",
                "100100100100100100100100100100100102",
                "100100100100100100100100100100100103",
            ],
        )
        self.assertEqual(
            parity["account_keys"],
            ["TORGHUT_SIM:cash", "TORGHUT_SIM:fees"],
        )

    def test_negative_runtime_bucket_reverses_transfer_direction(self) -> None:
        with Session(self.engine) as session:
            winning_bucket = _runtime_bucket()
            losing_bucket = _runtime_bucket()
            losing_bucket.run_id = "runtime-run-loss"
            losing_bucket.gross_strategy_pnl = Decimal("-3.00")
            losing_bucket.cost_amount = Decimal("0.50")
            losing_bucket.net_strategy_pnl_after_costs = Decimal("-3.50")
            session.add_all([winning_bucket, losing_bucket])
            session.flush()
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            )

            winning_ref = journal.journal_runtime_ledger_bucket(session, winning_bucket)
            losing_ref = journal.journal_runtime_ledger_bucket(session, losing_bucket)

            self.assertIsNotNone(winning_ref)
            self.assertIsNotNone(losing_ref)
            assert winning_ref is not None
            assert losing_ref is not None
            self.assertEqual(winning_ref.payload_json["pnl_direction"], "profit")
            self.assertEqual(losing_ref.payload_json["pnl_direction"], "loss")
            self.assertEqual(losing_ref.payload_json["signed_amount_micros"], -3500000)
            winning_transfer = client.transfers[int(winning_ref.transfer_id)]
            losing_transfer = client.transfers[int(losing_ref.transfer_id)]
            self.assertEqual(
                getattr(winning_transfer, "debit_account_id"),
                getattr(losing_transfer, "credit_account_id"),
            )
            self.assertNotEqual(
                getattr(losing_transfer, "debit_account_id"),
                getattr(losing_transfer, "credit_account_id"),
            )
            self.assertNotEqual(
                getattr(winning_transfer, "debit_account_id"),
                getattr(losing_transfer, "debit_account_id"),
            )

    def test_source_journals_noop_when_disabled_or_amount_missing(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-noop-sources")
            execution = event.execution
            self.assertIsNotNone(execution)
            assert execution is not None
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=event.trade_decision_id,
                strategy_id=event.trade_decision.strategy_id
                if event.trade_decision
                else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                shortfall_notional=Decimal("0"),
                computed_at=datetime.now(timezone.utc),
            )
            bucket = _runtime_bucket()
            bucket.net_strategy_pnl_after_costs = Decimal("0")
            bucket.cost_amount = Decimal("0")
            session.add_all([metric, bucket])
            session.flush()

            disabled = TigerBeetleLedgerJournal(
                settings_obj=_settings(enabled=False),
                client=FakeTigerBeetleClient(),
            )
            self.assertIsNone(disabled.journal_execution(session, execution))
            self.assertIsNone(disabled.journal_execution_tca_metric(session, metric))
            self.assertIsNone(disabled.journal_runtime_ledger_bucket(session, bucket))

            execution.avg_fill_price = None
            enabled = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            )
            self.assertIsNone(enabled.journal_execution(session, execution))
            self.assertIsNone(enabled.journal_execution_tca_metric(session, metric))
            self.assertIsNone(enabled.journal_runtime_ledger_bucket(session, bucket))

    def test_existing_transfer_ref_backfills_source_metadata(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-backfill-ref")
            amount = decimal_usd_to_micros(
                _event_amount_usd(event, TRANSFER_KIND_FILL_POST) or Decimal("0")
            )
            accounts = {spec.account_key: spec for spec in _account_specs(event)}
            expected = _transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                amount=amount,
                accounts=accounts,
                use_pending_transfer=False,
            )
            existing = TigerBeetleTransferRef(
                cluster_id=2001,
                transfer_id=str(expected.transfer_id),
                transfer_kind=expected.transfer_kind,
                ledger=expected.ledger,
                code=expected.code,
                amount=Decimal(expected.amount),
                status="created",
                payload_json={"legacy": "ref"},
            )
            session.add(existing)
            session.flush()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=FakeTigerBeetleClient(),
            ).journal_order_event(session, event)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.id, existing.id)
            self.assertEqual(ref.trade_decision_id, event.trade_decision_id)
            self.assertEqual(ref.execution_id, event.execution_id)
            self.assertEqual(ref.execution_order_event_id, event.id)
            self.assertEqual(ref.source_type, "execution_order_event")
            self.assertEqual(ref.source_id, str(event.id))
            self.assertEqual(ref.event_fingerprint, event.event_fingerprint)
            self.assertEqual(ref.payload_json["legacy"], "ref")
            self.assertEqual(ref.payload_json["source"], "execution_order_event")

    def test_duplicate_transfer_exists_is_verified_before_ref_persist(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-exists")
            client = FakeTigerBeetleClient()
            amount = decimal_usd_to_micros(
                _event_amount_usd(event, TRANSFER_KIND_FILL_POST) or Decimal("0")
            )
            accounts = {spec.account_key: spec for spec in _account_specs(event)}
            expected = _transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                amount=amount,
                accounts=accounts,
                use_pending_transfer=False,
            )
            client.transfers[expected.transfer_id] = expected

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNotNone(ref)
            self.assertEqual(ref.status, "exists")
            self.assertEqual(ref.transfer_id, str(expected.transfer_id))

    def test_numeric_duplicate_transfer_exists_is_verified_before_ref_persist(
        self,
    ) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(
                session,
                fingerprint="fingerprint-numeric-exists",
            )
            client = NumericExistsFakeTigerBeetleClient()
            amount = decimal_usd_to_micros(
                _event_amount_usd(event, TRANSFER_KIND_FILL_POST) or Decimal("0")
            )
            accounts = {spec.account_key: spec for spec in _account_specs(event)}
            expected = _transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                amount=amount,
                accounts=accounts,
                use_pending_transfer=False,
            )
            client.transfers[expected.transfer_id] = expected

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(), client=client
            ).journal_order_event(
                session,
                event,
            )

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.status, "exists")
            self.assertEqual(ref.transfer_id, str(expected.transfer_id))

    def test_duplicate_transfer_conflict_fails_hard(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-conflict")
            client = FakeTigerBeetleClient()
            transfer_id = event_transfer_id(event, TRANSFER_KIND_FILL_POST)
            client.transfers[transfer_id] = TigerBeetleTransferSpec(
                transfer_id=transfer_id,
                transfer_kind=TRANSFER_KIND_FILL_POST,
                debit_account_id=1,
                credit_account_id=2,
                amount=99,
                ledger=LEDGER_USD_MICRO,
                code=2001,
            )

            with self.assertRaisesRegex(
                RuntimeError, "tigerbeetle_duplicate_transfer_conflict"
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=client
                ).journal_order_event(
                    session,
                    event,
                )

    def test_helper_edge_paths_are_deterministic(self) -> None:
        self.assertEqual(
            _result_status(SimpleNamespace(status="Result.CREATED")), "created"
        )
        self.assertEqual(_result_status(SimpleNamespace(status=46)), "exists")
        self.assertEqual(_result_status(SimpleNamespace(status=4294967295)), "created")
        with patch.dict(sys.modules, {"tigerbeetle": None}):
            self.assertEqual(_result_status(SimpleNamespace(status=46)), "exists")
        with patch.dict(sys.modules, {"tigerbeetle": SimpleNamespace()}):
            self.assertEqual(_result_status(SimpleNamespace(status=1234)), "1234")

        class FakeTransferStatuses:
            _IGNORED = 1
            EXISTS = 46

        with patch.dict(
            sys.modules,
            {
                "tigerbeetle": SimpleNamespace(
                    CreateTransferStatus=FakeTransferStatuses,
                    CreateAccountStatus=None,
                )
            },
        ):
            self.assertEqual(_result_status(SimpleNamespace(status=46)), "exists")
            self.assertEqual(_result_status(SimpleNamespace(status=1)), "1")
        self.assertEqual(_transfer_attr({"transfer_id": 123}, "id"), 123)
        self.assertEqual(_transfer_attr(SimpleNamespace(transfer_id=456), "id"), 456)
        with self.assertRaises(AttributeError):
            _transfer_attr(object(), "id")
        self.assertIsNone(_lookup_payload_decimal({"amount": "bad"}, ("amount",)))

    def test_event_amount_uses_notional_and_payload_fallbacks(self) -> None:
        notional_event = ExecutionOrderEvent(
            event_fingerprint="amount-notional",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"notional": "-12.34"},
        )
        self.assertEqual(
            _event_amount_usd(notional_event, TRANSFER_KIND_FILL_POST),
            Decimal("12.34"),
        )

        raw_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-raw",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"notional": "bad", "qty": "2", "price": "10"},
        )
        self.assertEqual(
            _event_amount_usd(raw_payload_event, TRANSFER_KIND_FILL_POST),
            Decimal("20"),
        )

        explicit_delta_event = ExecutionOrderEvent(
            event_fingerprint="amount-explicit-delta",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"fill_notional": "7.25", "notional": "100"},
        )
        self.assertEqual(
            _event_amount_usd(explicit_delta_event, TRANSFER_KIND_FILL_POST),
            Decimal("7.25"),
        )

        nested_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-nested",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="submitted",
            status="submitted",
            qty=Decimal("3"),
            raw_event={"order": {"price": "11"}},
        )
        self.assertEqual(
            _event_amount_usd(nested_payload_event, TRANSFER_KIND_SUBMITTED_PENDING),
            Decimal("33"),
        )

        missing_payload_event = ExecutionOrderEvent(
            event_fingerprint="amount-missing",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=datetime.now(timezone.utc),
            symbol="AAPL",
            event_type="fill",
            status="filled",
            raw_event={"event": "fill"},
        )
        self.assertIsNone(
            _event_amount_usd(missing_payload_event, TRANSFER_KIND_FILL_POST)
        )

    def test_fill_event_amount_uses_incremental_notional_delta(self) -> None:
        with Session(self.engine) as session:
            first = _create_fill_event(session, fingerprint="partial-fill-delta-1")
            first.alpaca_order_id = "shared-order"
            first.client_order_id = "shared-client"
            first.event_type = "partial_fill"
            first.status = "partially_filled"
            first.qty = Decimal("2")
            first.filled_qty = Decimal("1")
            first.avg_fill_price = Decimal("190.20")
            first.source_offset = 10

            second = _create_fill_event(session, fingerprint="partial-fill-delta-2")
            second.alpaca_order_id = "shared-order"
            second.client_order_id = "shared-client"
            second.event_type = "fill"
            second.status = "filled"
            second.qty = Decimal("2")
            second.filled_qty = Decimal("2")
            second.avg_fill_price = Decimal("190.40")
            second.source_offset = 11
            duplicate_cumulative = _create_fill_event(
                session, fingerprint="partial-fill-delta-3"
            )
            duplicate_cumulative.alpaca_order_id = "shared-order"
            duplicate_cumulative.client_order_id = "shared-client"
            duplicate_cumulative.event_type = "fill"
            duplicate_cumulative.status = "filled"
            duplicate_cumulative.qty = Decimal("2")
            duplicate_cumulative.filled_qty = Decimal("2")
            duplicate_cumulative.avg_fill_price = Decimal("190.40")
            duplicate_cumulative.source_offset = 12
            session.add_all([first, second])
            session.flush()

            first_plan = build_order_event_transfer_plan(
                session,
                first,
                settings_obj=_settings(),
            )
            second_plan = build_order_event_transfer_plan(
                session,
                second,
                settings_obj=_settings(),
            )
            duplicate_cumulative_plan = build_order_event_transfer_plan(
                session,
                duplicate_cumulative,
                settings_obj=_settings(),
            )

        self.assertIsNotNone(first_plan)
        self.assertIsNotNone(second_plan)
        assert first_plan is not None
        assert second_plan is not None
        self.assertEqual(first_plan.transfer_spec.amount, 190200000)
        self.assertEqual(second_plan.transfer_spec.amount, 190600000)
        self.assertIsNone(duplicate_cumulative_plan)

    def test_order_event_precedence_falls_back_deterministically(self) -> None:
        older = ExecutionOrderEvent(
            event_fingerprint="older",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=None,
            alpaca_account_label="paper",
            symbol="AAPL",
            event_type="fill",
            status="filled",
            feed_seq=10,
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            created_at=datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
        )
        newer = ExecutionOrderEvent(
            event_fingerprint="newer",
            source_topic="torghut.trade-updates.v1",
            source_partition=0,
            source_offset=None,
            alpaca_account_label="paper",
            symbol="AAPL",
            event_type="fill",
            status="filled",
            feed_seq=11,
            event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
            created_at=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
        )

        self.assertTrue(_order_event_precedes(older, newer))

        older.feed_seq = None
        newer.feed_seq = None
        self.assertTrue(_order_event_precedes(older, newer))

        older.event_ts = None
        newer.event_ts = None
        self.assertTrue(_order_event_precedes(older, newer))

    def test_transfer_specs_cover_pending_and_void_paths(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-submitted")
            accounts = {spec.account_key: spec for spec in _account_specs(event)}

            submitted = _transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                amount=100,
                accounts=accounts,
            )
            canceled = _transfer_spec(
                event,
                transfer_kind=TRANSFER_KIND_CANCEL_VOID,
                amount=100,
                accounts=accounts,
            )

        self.assertEqual(submitted.transfer_kind, TRANSFER_KIND_SUBMITTED_PENDING)
        self.assertEqual(canceled.transfer_kind, TRANSFER_KIND_CANCEL_VOID)
        self.assertNotEqual(canceled.pending_id, 0)

    def test_void_transfer_requires_pending_mode(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-void-required")
            accounts = {spec.account_key: spec for spec in _account_specs(event)}

            with self.assertRaisesRegex(
                ValueError,
                "tigerbeetle_pending_transfer_required_for_void",
            ):
                _transfer_spec(
                    event,
                    transfer_kind=TRANSFER_KIND_CANCEL_VOID,
                    amount=100,
                    accounts=accounts,
                    use_pending_transfer=False,
                )

    def test_transfer_plan_derives_void_amount_from_pending_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-void-amount")
            event.event_type = "canceled"
            event.status = "canceled"
            event.qty = None
            event.filled_qty = None
            event.avg_fill_price = None
            event.raw_event = {"event": "canceled"}
            session.add(
                TigerBeetleTransferRef(
                    cluster_id=_settings().tigerbeetle_cluster_id,
                    transfer_id=str(submitted_pending_transfer_id(event)),
                    transfer_kind=TRANSFER_KIND_SUBMITTED_PENDING,
                    ledger=LEDGER_USD_MICRO,
                    code=2000,
                    amount=Decimal("123000000"),
                    status="created",
                    event_fingerprint="fingerprint-void-amount-submitted",
                )
            )
            session.flush()

            plan = build_order_event_transfer_plan(
                session,
                event,
                settings_obj=_settings(),
            )

            self.assertIsNotNone(plan)
            assert plan is not None
            self.assertEqual(plan.transfer_spec.amount, 123000000)

    def test_transfer_plan_skips_void_without_pending_ref(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-void-skip")
            event.event_type = "canceled"
            event.status = "canceled"

            self.assertIsNone(
                build_order_event_transfer_plan(
                    session,
                    event,
                    settings_obj=_settings(),
                )
            )

    def test_transfer_flag_handles_missing_module_and_missing_flags(self) -> None:
        with patch.dict(sys.modules, {"tigerbeetle": None}):
            self.assertEqual(_transfer_flag("PENDING"), 0)
        with patch.dict(sys.modules, {"tigerbeetle": SimpleNamespace()}):
            self.assertEqual(_transfer_flag("PENDING"), 0)
        self.assertEqual(_transfer_flag("DOES_NOT_EXIST"), 0)

    def test_journal_reuses_existing_account_refs_for_distinct_events(self) -> None:
        with Session(self.engine) as session:
            first = _create_fill_event(session, fingerprint="fingerprint-ref-1")
            second = _create_fill_event(session, fingerprint="fingerprint-ref-2")
            client = FakeTigerBeetleClient()
            journal = TigerBeetleLedgerJournal(settings_obj=_settings(), client=client)

            journal.journal_order_event(session, first)
            journal.journal_order_event(session, second)

            cash_refs = [
                ref
                for ref in client.accounts.values()
                if getattr(ref, "account_key", "") == "cash:paper:usd"
            ]
            self.assertEqual(len(cash_refs), 1)
            account_refs = (
                session.execute(select(TigerBeetleAccountRef)).scalars().all()
            )
            self.assertGreaterEqual(len(account_refs), 5)

    def test_journal_detects_account_ref_id_key_conflict(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-ref-conflict")
            spec = next(
                item
                for item in _account_specs(event)
                if item.account_key.startswith("order_hold:")
            )
            session.add(
                TigerBeetleAccountRef(
                    cluster_id=_settings().tigerbeetle_cluster_id,
                    account_id=str(spec.account_id),
                    account_key=f"{spec.account_key}:conflict",
                    ledger=spec.ledger,
                    code=spec.code,
                    account_label=spec.account_label,
                    symbol=spec.symbol,
                    strategy_id=spec.strategy_id,
                )
            )
            session.flush()

            with self.assertRaisesRegex(
                RuntimeError,
                "tigerbeetle_account_ref_conflict",
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(),
                    client=FakeTigerBeetleClient(),
                ).journal_order_event(session, event)

    def test_persist_account_refs_accepts_matching_concurrent_insert(self) -> None:
        spec = TigerBeetleAccountSpec(
            account_id=101,
            account_key="order_hold:paper:test-order",
            ledger=LEDGER_USD_MICRO,
            code=1101,
            account_label="paper",
            symbol="AAPL",
            strategy_id="strategy-1",
        )
        existing = TigerBeetleAccountRef(
            cluster_id=2001,
            account_id=u128_decimal(spec.account_id),
            account_key=spec.account_key,
            ledger=spec.ledger,
            code=spec.code,
            account_label=spec.account_label,
            symbol=spec.symbol,
            strategy_id=spec.strategy_id,
        )
        session = _RacingAccountRefSession(existing)

        _persist_account_refs(
            cast(Session, session),
            cluster_id=2001,
            account_specs=(spec,),
        )

        self.assertEqual(session.execute_count, 2)
        self.assertEqual(len(session.added_refs), 1)

    def test_persist_account_refs_reraises_unresolved_integrity_error(self) -> None:
        spec = TigerBeetleAccountSpec(
            account_id=102,
            account_key="order_hold:paper:missing-race-row",
            ledger=LEDGER_USD_MICRO,
            code=1101,
        )
        session = _RacingAccountRefSession(None)

        with self.assertRaises(IntegrityError):
            _persist_account_refs(
                cast(Session, session),
                cluster_id=2001,
                account_specs=(spec,),
            )

    def test_persist_account_refs_rejects_conflicting_concurrent_insert(self) -> None:
        spec = TigerBeetleAccountSpec(
            account_id=103,
            account_key="order_hold:paper:conflicting-race-row",
            ledger=LEDGER_USD_MICRO,
            code=1101,
        )
        existing = TigerBeetleAccountRef(
            cluster_id=2001,
            account_id=u128_decimal(spec.account_id),
            account_key=spec.account_key,
            ledger=spec.ledger,
            code=9999,
        )
        session = _RacingAccountRefSession(existing)

        with self.assertRaisesRegex(
            RuntimeError,
            "tigerbeetle_account_ref_conflict",
        ):
            _persist_account_refs(
                cast(Session, session),
                cluster_id=2001,
                account_specs=(spec,),
            )

    def test_journal_ignores_non_transfer_and_missing_amount_events(self) -> None:
        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-non-transfer")
            event.event_type = "trade_update"
            event.status = "pending_replace"
            event.raw_event = {"event": "pending_replace"}

            self.assertIsNone(
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_order_event(session, event)
            )

            missing = _create_fill_event(session, fingerprint="fingerprint-missing")
            missing.raw_event = {"event": "fill"}
            missing.qty = None
            missing.filled_qty = None
            missing.avg_fill_price = None

            self.assertIsNone(
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(), client=FakeTigerBeetleClient()
                ).journal_order_event(session, missing)
            )

    def test_journal_fails_on_create_transfer_error_status(self) -> None:
        class ErrorTransferClient(FakeTigerBeetleClient):
            def create_transfers(self, transfers: list[object]) -> list[object]:
                return [{"status": "limit_exceeded"}]

        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-error-status")

            with self.assertRaisesRegex(
                RuntimeError, "tigerbeetle_create_transfer_failed:limit_exceeded"
            ):
                TigerBeetleLedgerJournal(
                    settings_obj=_settings(),
                    client=ErrorTransferClient(),
                ).journal_order_event(session, event)

    def test_journal_accepts_official_numeric_exists_status(self) -> None:
        class NumericExistsTransferClient(FakeTigerBeetleClient):
            def create_transfers(self, transfers: list[object]) -> list[object]:
                for transfer in transfers:
                    transfer_id = int(getattr(transfer, "transfer_id"))
                    self.transfers[transfer_id] = transfer
                return [SimpleNamespace(status=46)]

        with Session(self.engine) as session:
            event = _create_fill_event(session, fingerprint="fingerprint-exists-status")
            client = NumericExistsTransferClient()

            ref = TigerBeetleLedgerJournal(
                settings_obj=_settings(),
                client=client,
            ).journal_order_event(session, event)

            self.assertIsNotNone(ref)
            assert ref is not None
            self.assertEqual(ref.status, "exists")
            self.assertEqual(_result_status(SimpleNamespace(status=46)), "exists")
            self.assertEqual(
                _result_status(SimpleNamespace(status=4294967295)),
                "created",
            )
