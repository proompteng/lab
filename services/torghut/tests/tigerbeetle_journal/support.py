from __future__ import annotations

from collections.abc import Sequence
import sys
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, cast
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
    build_order_event_transfer_plan,
    execution_economic_event_key,
    submitted_pending_transfer_id,
    event_transfer_id,
    execution_cost_transfer_id,
    execution_transfer_id,
    execution_tca_metric_economic_event_key,
    execution_tca_metric_source_id,
    runtime_ledger_transfer_id,
    tigerbeetle_runtime_ledger_journal_payload,
)
from app.trading.tigerbeetle_journal_modules.part_01_statements_58 import (
    _event_amount_usd,
    _lookup_payload_decimal,
    _order_event_precedes,
    _positive_payload_count,
    _result_index,
    _result_status,
    _result_statuses_by_index,
    _transfer_attr,
)
from app.trading.tigerbeetle_journal_modules.part_02_economic_text import (
    _account_specs,
    _dedupe_account_specs,
    _persist_account_refs,
    _transfer_flag,
    _transfer_ref_mismatches,
    _transfer_spec,
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


class AccountFailureFakeTigerBeetleClient(FakeTigerBeetleClient):
    def create_accounts(self, accounts: Sequence[object]) -> Sequence[object]:
        return [{"index": 0, "status": "linked_event_failed"} for _ in accounts[:1]]


class BatchCountingFakeTigerBeetleClient(FakeTigerBeetleClient):
    def __init__(self) -> None:
        super().__init__()
        self.account_call_sizes: list[int] = []
        self.transfer_call_sizes: list[int] = []

    def create_accounts(self, accounts: Sequence[object]) -> Sequence[object]:
        self.account_call_sizes.append(len(accounts))
        return super().create_accounts(accounts)

    def create_transfers(self, transfers: Sequence[object]) -> Sequence[object]:
        self.transfer_call_sizes.append(len(transfers))
        return super().create_transfers(transfers)


class ExistingTransferLookupCountingFakeTigerBeetleClient(FakeTigerBeetleClient):
    def __init__(self) -> None:
        super().__init__()
        self.lookup_call_sizes: list[int] = []

    def create_transfers(self, transfers: Sequence[object]) -> Sequence[object]:
        results: list[dict[str, object]] = []
        for index, transfer in enumerate(transfers):
            transfer_id = int(
                getattr(transfer, "id", getattr(transfer, "transfer_id", 0))
            )
            self.transfers[transfer_id] = transfer
            results.append({"index": index, "status": "exists"})
        return results

    def lookup_transfers(self, ids: Sequence[int]) -> Sequence[object]:
        self.lookup_call_sizes.append(len(ids))
        return super().lookup_transfers(ids)


class _ScalarResult:
    def __init__(self, value: object | None) -> None:
        self._value = value

    def scalar_one_or_none(self) -> Any:
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


class _RacingTransferRefSession:
    def __init__(
        self, existing_after_integrity_error: TigerBeetleTransferRef | None
    ) -> None:
        self._existing_after_integrity_error = existing_after_integrity_error
        self.execute_count = 0
        self.flush_count = 0
        self.added_refs: list[TigerBeetleTransferRef] = []

    def execute(self, statement: object) -> _ScalarResult:
        del statement
        self.execute_count += 1
        if self.execute_count < 3:
            return _ScalarResult(None)
        return _ScalarResult(self._existing_after_integrity_error)

    def begin_nested(self) -> _NestedTransaction:
        return _NestedTransaction()

    def add(self, value: TigerBeetleTransferRef) -> None:
        self.added_refs.append(value)

    def flush(self) -> None:
        self.flush_count += 1
        if self.flush_count == 1:
            raise IntegrityError(
                "insert tigerbeetle transfer ref", {}, RuntimeError("duplicate")
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


class _TestTigerBeetleLedgerJournalBase(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)


__all__ = [
    "AccountFailureFakeTigerBeetleClient",
    "BatchCountingFakeTigerBeetleClient",
    "ClosableFakeTigerBeetleClient",
    "Decimal",
    "ExecutionOrderEvent",
    "ExecutionTCAMetric",
    "ExistingTransferLookupCountingFakeTigerBeetleClient",
    "FakeTigerBeetleClient",
    "IntegrityError",
    "LEDGER_USD_MICRO",
    "NumericExistsFakeTigerBeetleClient",
    "Session",
    "SimpleNamespace",
    "TIGERBEETLE_AUTHORITY_BLOCKER_ACCOUNTING_ONLY",
    "TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING",
    "TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING",
    "TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS",
    "TRANSFER_KIND_CANCEL_VOID",
    "TRANSFER_KIND_EXECUTION_COST",
    "TRANSFER_KIND_EXECUTION_FILL",
    "TRANSFER_KIND_FILL_POST",
    "TRANSFER_KIND_RUNTIME_NET_PNL",
    "TRANSFER_KIND_SUBMITTED_PENDING",
    "TigerBeetleAccountRef",
    "TigerBeetleAccountSpec",
    "TigerBeetleLedgerJournal",
    "TigerBeetleTransferRef",
    "TigerBeetleTransferSpec",
    "_RacingAccountRefSession",
    "_RacingTransferRefSession",
    "_TestTigerBeetleLedgerJournalBase",
    "_account_specs",
    "_create_fill_event",
    "_dedupe_account_specs",
    "_event_amount_usd",
    "_lookup_payload_decimal",
    "_order_event_precedes",
    "_persist_account_refs",
    "_positive_payload_count",
    "_result_index",
    "_result_status",
    "_result_statuses_by_index",
    "_runtime_bucket",
    "_settings",
    "_transfer_attr",
    "_transfer_flag",
    "_transfer_ref_mismatches",
    "_transfer_spec",
    "build_order_event_transfer_plan",
    "cast",
    "datetime",
    "decimal_usd_to_micros",
    "event_transfer_id",
    "execution_cost_transfer_id",
    "execution_economic_event_key",
    "execution_tca_metric_economic_event_key",
    "execution_tca_metric_source_id",
    "execution_transfer_id",
    "patch",
    "runtime_ledger_transfer_id",
    "select",
    "submitted_pending_transfer_id",
    "sys",
    "tigerbeetle_runtime_ledger_journal_payload",
    "timezone",
    "u128_decimal",
]
