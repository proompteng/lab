from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import cast
from unittest.mock import Mock

import pytest
from alpaca.trading.enums import OrderStatus
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.alpaca_client import AlpacaRecoveryOrderHistoryPage, TorghutAlpacaClient
from app.models import Base, Execution, ExecutionOrderEvent, Strategy, TradeDecision
from app.trading.alpaca_submit_recovery import AlpacaSubmitRecoveryRoute
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptSnapshot,
    BrokerMutationTarget,
    acquire_broker_mutation_receipt,
    build_broker_mutation_intent,
    fingerprint_broker_endpoint,
    mark_broker_mutation_io_started,
)
from app.trading.decision_submission_claims import DecisionSubmissionClaimHandle
from app.trading.execution import OrderExecutor
from app.trading.models import StrategyDecision


_ENDPOINT = "https://paper-api.alpaca.markets"
_CLIENT_ORDER_ID = "a" * 64


class _RecoveryClient:
    def __init__(
        self,
        *,
        exact: dict[str, object] | None,
        history: Iterable[dict[str, object]] = (),
        history_complete: bool = True,
    ) -> None:
        self.exact = exact
        self.history = tuple(history)
        self.history_complete = history_complete
        self.exact_calls: list[str] = []
        self.history_calls: list[tuple[datetime, datetime, int]] = []

    def get_order_by_client_order_id_strict(
        self,
        client_order_id: str,
    ) -> dict[str, object] | None:
        self.exact_calls.append(client_order_id)
        return self.exact

    def list_orders_recovery_window(
        self,
        *,
        after: datetime,
        until: datetime,
        limit: int,
    ) -> AlpacaRecoveryOrderHistoryPage:
        self.history_calls.append((after, until, limit))
        return AlpacaRecoveryOrderHistoryPage(
            orders=self.history,
            complete=self.history_complete,
            limit=limit,
            after=after,
            until=until,
        )


class _ObservationOnlyExecutionContext:
    name = "alpaca"
    last_route = "alpaca"
    last_fallback_reason = None
    last_fallback_count = 0

    def __init__(self) -> None:
        self.submit_calls = 0

    def submit_order(self, *_args: object, **_kwargs: object) -> None:
        self.submit_calls += 1
        raise AssertionError("strict recovery must never submit")


def _sessions(database_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite+pysqlite:///{database_path}", future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(
        bind=engine,
        class_=Session,
        expire_on_commit=False,
        future=True,
    )


def _receipt(sessions: sessionmaker[Session]) -> BrokerMutationReceiptSnapshot:
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=fingerprint_broker_endpoint(_ENDPOINT),
            operation="submit_order",
            risk_class="risk_neutral",
            purpose="control_plane_validation",
            workflow_id=_CLIENT_ORDER_ID,
            client_request_id=_CLIENT_ORDER_ID,
            target=BrokerMutationTarget(kind="order", key=_CLIENT_ORDER_ID),
            request_payload={
                "broker_request": {
                    "symbol": "AAPL",
                    "side": "buy",
                    "qty": Decimal("1"),
                    "order_type": "limit",
                    "time_in_force": "day",
                    "limit_price": Decimal("190.25"),
                    "stop_price": None,
                },
                "infrastructure_validation": {"non_promotable": True},
            },
        )
    )
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="alpaca-route-test",
            writer_generation=1,
            options=BrokerMutationReceiptAcquireOptions(
                primary_token=uuid.uuid4(),
                lease_seconds=30,
            ),
        )
    with sessions() as session:
        started = mark_broker_mutation_io_started(
            session,
            handle=acquired.receipt.primary_handle,
            recovery_seconds=30,
        )
    assert started.authorized
    return started.receipt


def _order(
    *,
    broker_order_id: str = "broker-order-1",
    client_order_id: str = _CLIENT_ORDER_ID,
    qty: str = "1",
    status: str = "accepted",
) -> dict[str, object]:
    return {
        "id": broker_order_id,
        "client_order_id": client_order_id,
        "symbol": "AAPL",
        "side": "buy",
        "qty": qty,
        "type": "limit",
        "time_in_force": "day",
        "limit_price": "190.25",
        "stop_price": None,
        "status": status,
    }


def _route(client: _RecoveryClient) -> AlpacaSubmitRecoveryRoute:
    return AlpacaSubmitRecoveryRoute(
        client=cast(TorghutAlpacaClient, client),
        firewall=Mock(),
        executor=Mock(),
        account_label="paper",
        endpoint_url=_ENDPOINT,
    )


def _recovery_decision(
    session: Session,
    executor: OrderExecutor,
    *,
    event_ts: datetime,
) -> TradeDecision:
    strategy = Strategy(
        name=f"strict-submit-recovery-{uuid.uuid4().hex}",
        description="strict recovery path test",
        enabled=True,
        base_timeframe="1Min",
        universe_type="symbols_list",
        universe_symbols=["AAPL"],
    )
    session.add(strategy)
    session.commit()
    decision = StrategyDecision(
        strategy_id=str(strategy.id),
        symbol="AAPL",
        event_ts=event_ts,
        timeframe="1Min",
        action="buy",
        qty=Decimal("1"),
        order_type="limit",
        time_in_force="day",
        limit_price=Decimal("190.25"),
        params={"price": "190.25"},
    )
    return executor.ensure_decision(session, decision, strategy, "paper")


def _claim_handle(decision: TradeDecision) -> DecisionSubmissionClaimHandle:
    assert decision.decision_hash is not None
    return DecisionSubmissionClaimHandle(
        decision_id=decision.id,
        claim_token=uuid.uuid4(),
        fencing_epoch=1,
        account_label="paper",
        client_order_id=decision.decision_hash,
        claim_owner="strict-submit-recovery-test",
    )


def test_exact_client_id_match_recovers_without_history_scan(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "exact.sqlite")
    receipt = _receipt(sessions)
    client = _RecoveryClient(exact=_order())

    read = _route(client).observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "found"
    assert read.broker_order == _order()
    assert read.evidence["exact_client_order_lookup"] == "found"
    assert client.exact_calls == [_CLIENT_ORDER_ID]
    assert client.history_calls == []


def test_history_match_recovers_after_exact_lookup_miss(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "history.sqlite")
    receipt = _receipt(sessions)
    client = _RecoveryClient(exact=None, history=[_order()])
    observed_at = datetime.now(timezone.utc) + timedelta(seconds=1)

    read = _route(client).observe(receipt, observed_at=observed_at)

    assert read.outcome == "found"
    assert read.evidence["exact_client_order_lookup"] == "not_found"
    assert read.evidence["history_match_count"] == 1
    assert len(client.history_calls) == 1
    after, until, limit = client.history_calls[0]
    assert receipt.lifecycle.broker_io_started_at is not None
    assert after == receipt.lifecycle.broker_io_started_at - timedelta(minutes=5)
    assert until == observed_at
    assert limit == 500


def test_conflicting_history_ids_are_indeterminate(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "conflict.sqlite")
    receipt = _receipt(sessions)
    client = _RecoveryClient(
        exact=None,
        history=[
            _order(broker_order_id="broker-order-1"),
            _order(broker_order_id="broker-order-2"),
        ],
    )

    read = _route(client).observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "conflicting_client_order_history"
    assert read.evidence["absence_proof_complete"] is False
    assert read.evidence["history_match_count"] == 2


def test_full_history_page_cannot_prove_absence(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "incomplete.sqlite")
    receipt = _receipt(sessions)
    client = _RecoveryClient(exact=None, history_complete=False)

    read = _route(client).observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["history_complete"] is False
    assert read.evidence["absence_proof_complete"] is False


def test_exact_order_identity_mismatch_requires_operator_review(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "mismatch.sqlite")
    receipt = _receipt(sessions)
    client = _RecoveryClient(exact=_order(qty="2"))

    read = _route(client).observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "alpaca_recovery_order_qty_mismatch"
    assert read.evidence["absence_proof_complete"] is False
    assert read.broker_order is None


_KNOWN_ALPACA_ORDER_STATUSES = {
    "accepted",
    "accepted_for_bidding",
    "calculated",
    "canceled",
    "done_for_day",
    "expired",
    "filled",
    "held",
    "new",
    "partially_filled",
    "pending_cancel",
    "pending_new",
    "pending_replace",
    "pending_review",
    "rejected",
    "replaced",
    "stopped",
    "suspended",
}


@pytest.mark.parametrize("status", sorted(_KNOWN_ALPACA_ORDER_STATUSES))
def test_known_order_statuses_have_explicit_submission_resolution(
    tmp_path: Path,
    status: str,
) -> None:
    assert {member.value for member in OrderStatus} == _KNOWN_ALPACA_ORDER_STATUSES
    sessions = _sessions(tmp_path / f"status-{status}.sqlite")
    receipt = _receipt(sessions)
    route = _route(_RecoveryClient(exact=_order(status=status)))

    read = route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )
    settlement = route.build_found_settlement(Mock(spec=Session), receipt, read)

    assert read.outcome == "found"
    assert read.evidence["submission_resolution"] == (
        "rejected" if status == "rejected" else "acknowledged"
    )
    assert settlement.outcome == ("rejected" if status == "rejected" else "reconciled")
    assert settlement.broker_reference == "broker-order-1"


def test_unknown_order_status_requires_operator_review(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "unknown-status.sqlite")
    receipt = _receipt(sessions)

    read = _route(
        _RecoveryClient(exact=_order(status="future_unreviewed_status"))
    ).observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "alpaca_recovery_order_status_unknown"
    assert read.evidence["absence_proof_complete"] is False


def test_order_executor_recovery_persists_observation_without_submit_or_commit(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "executor-recovery.sqlite")
    execution_context = _ObservationOnlyExecutionContext()
    executor = OrderExecutor()
    event_ts = datetime(2026, 7, 15, 1, 0, tzinfo=timezone.utc)
    with sessions() as session:
        decision_row = _recovery_decision(
            session,
            executor,
            event_ts=event_ts,
        )
        assert decision_row.decision_hash is not None
        observed_order = _order(
            broker_order_id="observed-without-response",
            client_order_id=decision_row.decision_hash,
        )
        pending_event = ExecutionOrderEvent(
            event_fingerprint="f" * 64,
            source_topic="torghut.order-feed.test",
            source_partition=0,
            source_offset=1,
            alpaca_account_label="paper",
            event_ts=event_ts,
            symbol="AAPL",
            alpaca_order_id="observed-without-response",
            client_order_id=decision_row.decision_hash,
            event_type="new",
            status="accepted",
            qty=Decimal("1"),
            filled_qty=Decimal("0"),
            raw_event={"event": "new"},
        )
        session.add(pending_event)
        session.commit()

        execution = executor.recover_linked_order_submission(
            session=session,
            execution_client=execution_context,
            claim_handle=_claim_handle(decision_row),
            order_response=observed_order,
        )

        execution_id = execution.id
        decision_id = decision_row.id
        pending_event_id = pending_event.id
        assert execution.alpaca_order_id == "observed-without-response"
        assert str(execution.trade_decision_id) == str(decision_id)
        assert decision_row.status == "submitted"
        assert pending_event.execution_id == execution_id
        assert str(pending_event.trade_decision_id) == str(decision_id)
        assert session.in_transaction()
        assert execution_context.submit_calls == 0
        session.rollback()

    with sessions() as session:
        assert session.get(Execution, execution_id) is None
        persisted_decision = session.get(TradeDecision, decision_id)
        assert persisted_decision is not None
        assert persisted_decision.status == "planned"
        persisted_event = session.get(ExecutionOrderEvent, pending_event_id)
        assert persisted_event is not None
        assert persisted_event.execution_id is None
        assert persisted_event.trade_decision_id is None


def test_order_executor_recovery_rejects_conflicting_local_execution_identity(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "executor-recovery-conflict.sqlite")
    execution_context = _ObservationOnlyExecutionContext()
    executor = OrderExecutor()
    event_ts = datetime(2026, 7, 15, 1, 0, tzinfo=timezone.utc)
    with sessions() as session:
        decision_row = _recovery_decision(
            session,
            executor,
            event_ts=event_ts,
        )
        assert decision_row.decision_hash is not None
        conflicting = Execution(
            trade_decision_id=None,
            alpaca_account_label="paper",
            alpaca_order_id="conflicting-local-order",
            client_order_id="different-client-order-id",
            symbol="AAPL",
            side="buy",
            order_type="limit",
            time_in_force="day",
            submitted_qty=Decimal("1"),
            filled_qty=Decimal("0"),
            status="accepted",
            raw_order={"source": "preexisting-conflict"},
        )
        session.add(conflicting)
        session.commit()
        conflicting_id = conflicting.id
        decision_id = decision_row.id

        with pytest.raises(
            ValueError,
            match="linked_submission_recovery_execution_identity_conflict",
        ):
            executor.recover_linked_order_submission(
                session=session,
                execution_client=execution_context,
                claim_handle=_claim_handle(decision_row),
                order_response=_order(
                    broker_order_id="conflicting-local-order",
                    client_order_id=decision_row.decision_hash,
                ),
            )

        assert execution_context.submit_calls == 0
        session.rollback()

    with sessions() as session:
        persisted = session.get(Execution, conflicting_id)
        assert persisted is not None
        assert persisted.client_order_id == "different-client-order-id"
        assert persisted.trade_decision_id is None
        persisted_decision = session.get(TradeDecision, decision_id)
        assert persisted_decision is not None
        assert persisted_decision.status == "planned"


def test_order_executor_recovery_rejects_client_order_id_mismatch(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "executor-recovery-client-id.sqlite")
    execution_context = _ObservationOnlyExecutionContext()
    executor = OrderExecutor()
    with sessions() as session:
        decision_row = _recovery_decision(
            session,
            executor,
            event_ts=datetime(2026, 7, 15, 1, 0, tzinfo=timezone.utc),
        )

        with pytest.raises(
            ValueError,
            match="linked_submission_recovery_client_order_id_mismatch",
        ):
            executor.recover_linked_order_submission(
                session=session,
                execution_client=execution_context,
                claim_handle=_claim_handle(decision_row),
                order_response=_order(client_order_id="b" * 64),
            )

        assert execution_context.submit_calls == 0


def test_complete_exact_and_history_absence_is_only_nonterminal_read(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "absent.sqlite")
    receipt = _receipt(sessions)
    client = _RecoveryClient(exact=None, history_complete=True)

    read = _route(client).observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "not_found"
    assert read.evidence["absence_proof_complete"] is True
    assert read.evidence["history_status"] == "all"
    assert read.evidence["history_limit"] == 500
