from __future__ import annotations

# ruff: noqa: F401

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

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
    _stable_ref_archives_event_transfer,
    _stable_ref_matches,
    _runtime_ledger_amount_micros,
    _usd_to_micros,
    _uuid_or_none,
    latest_tigerbeetle_reconciliation_payload,
    latest_tigerbeetle_reconciliation_status_payload,
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
    *, net_pnl: Decimal = Decimal("2.50"), account_label: str = "paper"
) -> StrategyRuntimeLedgerBucket:
    observed_at = datetime.now(timezone.utc)
    return StrategyRuntimeLedgerBucket(
        run_id=f"runtime-run-{net_pnl}",
        candidate_id="candidate",
        hypothesis_id="hypothesis",
        observed_stage="paper",
        bucket_started_at=observed_at,
        bucket_ended_at=observed_at,
        account_label=account_label,
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


class _TestTigerBeetleReconcileBase(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)


__all__ = [name for name in globals() if not name.startswith("__")]
