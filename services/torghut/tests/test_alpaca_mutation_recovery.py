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

from app.alpaca_client import (
    AlpacaRecoveryOrderHistoryPage,
    AlpacaStrictOrderLookupMalformedError,
    TorghutAlpacaClient,
)
from app.models import Base, Execution, ExecutionOrderEvent, Strategy, TradeDecision
from app.trading.alpaca_mutation_recovery import AlpacaMutationRecoveryRoute
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationReceiptAcquireOptions,
    BrokerMutationReceiptSnapshot,
    BrokerMutationTarget,
    BrokerMutationTargetKind,
    acquire_broker_mutation_receipt,
    build_broker_mutation_intent,
    fingerprint_broker_endpoint,
    mark_broker_mutation_io_started,
)
from app.trading.decision_submission_claims import DecisionSubmissionClaimHandle
from app.trading.execution import OrderExecutor
from app.trading.models import StrategyDecision
from app.trading.risk_reduction import (
    BrokerOrderObservation,
    BrokerPositionObservation,
    BrokerReductionSnapshot,
    CancelAllOrdersPlan,
    CancelOrderPlan,
    ClosePositionPlan,
    PositionCloseLeg,
    ReplaceOrderPlan,
    authorize_risk_reduction,
    flatten_observed_positions,
)


_ENDPOINT = "https://paper-api.alpaca.markets"
_CLIENT_ORDER_ID = "a" * 64


class _RecoveryClient:
    def __init__(
        self,
        *,
        exact: dict[str, object] | None,
        history: Iterable[dict[str, object]] = (),
        history_complete: bool = True,
        orders_by_id: dict[str, dict[str, object] | None] | None = None,
        open_orders: Iterable[dict[str, object]] = (),
        positions: Iterable[dict[str, object]] = (),
    ) -> None:
        self.exact = exact
        self.history = tuple(history)
        self.history_complete = history_complete
        self.exact_calls: list[str] = []
        self.history_calls: list[tuple[datetime, datetime, int]] = []
        self.orders_by_id = dict(orders_by_id or {})
        self.open_orders = tuple(open_orders)
        self.positions = tuple(positions)

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

    def get_order_by_id_strict(self, order_id: str) -> dict[str, object] | None:
        return self.orders_by_id.get(order_id)

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        assert status == "open"
        assert limit == 500
        return list(self.open_orders)

    def list_positions(self) -> list[dict[str, object]]:
        return list(self.positions)


class _MalformedExactLookupClient(_RecoveryClient):
    def __init__(self) -> None:
        super().__init__(exact=None)

    def get_order_by_client_order_id_strict(
        self,
        client_order_id: str,
    ) -> dict[str, object] | None:
        self.exact_calls.append(client_order_id)
        raise AlpacaStrictOrderLookupMalformedError(
            "alpaca_strict_order_lookup_missing_payload"
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


def _reduction_receipt(
    sessions: sessionmaker[Session],
    *,
    operation: str,
    target_kind: str,
    target_key: str,
    broker_request: dict[str, object],
    risk_reduction: dict[str, object],
) -> BrokerMutationReceiptSnapshot:
    purpose_by_operation = {
        "cancel_order": "operator",
        "cancel_all_orders": "operator",
        "replace_order": "repricing",
        "close_position": "closeout",
        "close_all_positions": "flatten",
    }
    intent = build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper",
            endpoint_fingerprint=fingerprint_broker_endpoint(_ENDPOINT),
            operation=operation,
            risk_class=(
                "risk_reducing"
                if operation in {"close_position", "close_all_positions"}
                else "risk_neutral"
            ),
            purpose=purpose_by_operation[operation],
            workflow_id=f"recovery-test/{uuid.uuid4().hex}",
            client_request_id=f"rr-{uuid.uuid4().hex}",
            target=BrokerMutationTarget(
                kind=cast(BrokerMutationTargetKind, target_kind),
                key=target_key,
            ),
            request_payload={
                **broker_request,
                "risk_reduction": risk_reduction,
                "schema_version": "torghut.alpaca-reduction-request.v1",
            },
        )
    )
    with sessions() as session:
        acquired = acquire_broker_mutation_receipt(
            session,
            intent=intent,
            primary_owner="alpaca-reduction-recovery-test",
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


def _risk_snapshot(
    *,
    orders: tuple[BrokerOrderObservation, ...] = (),
    positions: tuple[BrokerPositionObservation, ...] = (),
) -> BrokerReductionSnapshot:
    return BrokerReductionSnapshot(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint=fingerprint_broker_endpoint(_ENDPOINT),
        observed_at=datetime.now(timezone.utc),
        complete=True,
        orders=orders,
        positions=positions,
    )


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


def _route(client: _RecoveryClient) -> AlpacaMutationRecoveryRoute:
    return AlpacaMutationRecoveryRoute(
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
    assert read.broker_result == _order()
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


def test_malformed_exact_lookup_is_indeterminate_and_retryable(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "malformed-exact.sqlite")
    receipt = _receipt(sessions)
    client = _MalformedExactLookupClient()

    read = _route(client).observe(
        receipt,
        observed_at=datetime.now(timezone.utc) + timedelta(seconds=1),
    )

    assert read.outcome == "indeterminate"
    assert read.evidence["reason"] == "exact_client_order_lookup_malformed"
    assert read.evidence["exact_client_order_lookup"] == "malformed"
    assert read.evidence["absence_proof_complete"] is False
    assert client.exact_calls == [_CLIENT_ORDER_ID]
    assert client.history_calls == []


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
    assert read.broker_result is None


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


def test_cancel_recovery_distinguishes_open_terminal_and_absent_order(
    tmp_path: Path,
) -> None:
    sessions = _sessions(tmp_path / "cancel-recovery.sqlite")
    order = BrokerOrderObservation(
        order_id="order-1",
        client_order_id="client-1",
        symbol="AAPL",
        side="buy",
        quantity=Decimal("1"),
        filled_quantity=Decimal("0"),
        status="new",
    )
    snapshot = _risk_snapshot(orders=(order,))
    authorization = authorize_risk_reduction(
        snapshot,
        CancelOrderPlan("order-1"),
        now=snapshot.observed_at,
    )
    receipt = _reduction_receipt(
        sessions,
        operation="cancel_order",
        target_kind="order",
        target_key="order-1",
        broker_request={"order_id": "order-1"},
        risk_reduction=dict(authorization.evidence_payload),
    )
    open_order = _order(
        broker_order_id="order-1",
        client_order_id="client-1",
        status="new",
    )
    terminal_order = {**open_order, "status": "filled", "filled_qty": "1"}

    open_read = _route(
        _RecoveryClient(exact=None, orders_by_id={"order-1": open_order})
    ).observe(receipt, observed_at=datetime.now(timezone.utc))
    terminal_route = _route(
        _RecoveryClient(exact=None, orders_by_id={"order-1": terminal_order})
    )
    terminal_read = terminal_route.observe(
        receipt,
        observed_at=datetime.now(timezone.utc),
    )
    absent_read = _route(
        _RecoveryClient(exact=None, orders_by_id={"order-1": None})
    ).observe(receipt, observed_at=datetime.now(timezone.utc))

    assert (open_read.outcome, open_read.evidence["reason"]) == (
        "not_found",
        "target_order_still_open",
    )
    assert terminal_read.outcome == "found"
    assert absent_read.outcome == "found"
    settlement = terminal_route.build_found_settlement(
        Mock(spec=Session),
        receipt,
        terminal_read,
    )
    assert settlement.outcome == "reconciled"
    assert settlement.broker_reference == "order-1"


def test_cancel_all_recovery_checks_only_the_sealed_order_set(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "cancel-all-recovery.sqlite")
    orders = (
        BrokerOrderObservation(
            "order-1", "AAPL", "buy", Decimal("1"), Decimal("0"), "new"
        ),
        BrokerOrderObservation(
            "order-2", "MSFT", "sell", Decimal("1"), Decimal("0"), "new"
        ),
    )
    snapshot = _risk_snapshot(orders=orders)
    authorization = authorize_risk_reduction(
        snapshot,
        CancelAllOrdersPlan(),
        now=snapshot.observed_at,
    )
    receipt = _reduction_receipt(
        sessions,
        operation="cancel_all_orders",
        target_kind="account",
        target_key="paper",
        broker_request={"target_order_ids": ["order-1", "order-2"]},
        risk_reduction=dict(authorization.evidence_payload),
    )

    unresolved = _route(
        _RecoveryClient(
            exact=None,
            open_orders=(
                _order(broker_order_id="order-2", status="new"),
                _order(broker_order_id="unrelated", status="new"),
            ),
        )
    ).observe(receipt, observed_at=datetime.now(timezone.utc))
    resolved = _route(
        _RecoveryClient(
            exact=None,
            open_orders=(_order(broker_order_id="unrelated", status="new"),),
        )
    ).observe(receipt, observed_at=datetime.now(timezone.utc))
    malformed = _route(
        _RecoveryClient(exact=None, open_orders=({"id": "order-2"},))
    ).observe(receipt, observed_at=datetime.now(timezone.utc))

    assert unresolved.outcome == "not_found"
    assert unresolved.evidence["remaining_target_order_ids"] == ["order-2"]
    assert resolved.outcome == "found"
    assert malformed.outcome == "indeterminate"
    assert malformed.evidence["reason"] == "alpaca_order_side_invalid"


def test_replace_recovery_requires_causal_replacement_fields(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "replace-recovery.sqlite")
    observed = BrokerOrderObservation(
        "order-1",
        "AAPL",
        "buy",
        Decimal("10"),
        Decimal("4"),
        "partially_filled",
        limit_price=Decimal("190.25"),
    )
    snapshot = _risk_snapshot(orders=(observed,))
    authorization = authorize_risk_reduction(
        snapshot,
        ReplaceOrderPlan("order-1", Decimal("191")),
        now=snapshot.observed_at,
    )
    receipt = _reduction_receipt(
        sessions,
        operation="replace_order",
        target_kind="order",
        target_key="order-1",
        broker_request={"limit_price": "191", "order_id": "order-1"},
        risk_reduction=dict(authorization.evidence_payload),
    )
    original = {
        **_order(broker_order_id="order-1", qty="10", status="replaced"),
        "filled_qty": "4",
        "replaced_by": "order-2",
    }
    replacement = {
        **_order(broker_order_id="order-2", qty="6", status="new"),
        "client_order_id": "replacement-client",
        "limit_price": "191",
        "replaces": "order-1",
    }
    client = _RecoveryClient(
        exact=None,
        orders_by_id={"order-1": original, "order-2": replacement},
    )
    route = _route(client)

    found = route.observe(receipt, observed_at=datetime.now(timezone.utc))
    wrong_price = client.orders_by_id["order-2"]
    assert isinstance(wrong_price, dict)
    wrong_price["limit_price"] = "192"
    conflict = route.observe(receipt, observed_at=datetime.now(timezone.utc))

    assert found.outcome == "found"
    assert conflict.outcome == "indeterminate"
    assert conflict.evidence["reason"] == "alpaca_replace_recovery_limit_price_mismatch"


@pytest.mark.parametrize(
    ("positions", "outcome", "reason"),
    [
        (
            ({"symbol": "AAPL", "side": "long", "qty": "3", "current_price": "200"},),
            "found",
            "target_position_reduced",
        ),
        (
            ({"symbol": "AAPL", "side": "long", "qty": "5", "current_price": "200"},),
            "not_found",
            "target_position_unchanged",
        ),
        (
            ({"symbol": "AAPL", "side": "short", "qty": "1", "current_price": "200"},),
            "indeterminate",
            "position_side_flipped",
        ),
    ],
)
def test_close_recovery_uses_fresh_broker_position_delta(
    tmp_path: Path,
    positions: tuple[dict[str, object], ...],
    outcome: str,
    reason: str,
) -> None:
    sessions = _sessions(tmp_path / f"close-{outcome}.sqlite")
    snapshot = _risk_snapshot(
        positions=(BrokerPositionObservation("AAPL", Decimal("5"), Decimal("200")),)
    )
    authorization = authorize_risk_reduction(
        snapshot,
        ClosePositionPlan(PositionCloseLeg("AAPL", "sell", Decimal("2"))),
        now=snapshot.observed_at,
    )
    receipt = _reduction_receipt(
        sessions,
        operation="close_position",
        target_kind="position",
        target_key="AAPL",
        broker_request={"quantity": "2", "symbol": "AAPL"},
        risk_reduction=dict(authorization.evidence_payload),
    )

    read = _route(_RecoveryClient(exact=None, positions=positions)).observe(
        receipt,
        observed_at=datetime.now(timezone.utc),
    )

    assert (read.outcome, read.evidence["reason"]) == (outcome, reason)


def test_close_all_recovery_requires_final_flatten(tmp_path: Path) -> None:
    sessions = _sessions(tmp_path / "close-all-recovery.sqlite")
    snapshot = _risk_snapshot(
        positions=(BrokerPositionObservation("AAPL", Decimal("1"), Decimal("200")),)
    )
    authorization = authorize_risk_reduction(
        snapshot,
        flatten_observed_positions(snapshot),
        now=snapshot.observed_at,
    )
    receipt = _reduction_receipt(
        sessions,
        operation="close_all_positions",
        target_kind="account",
        target_key="paper",
        broker_request={"symbols": ["AAPL"]},
        risk_reduction=dict(authorization.evidence_payload),
    )

    flat = _route(_RecoveryClient(exact=None, positions=())).observe(
        receipt,
        observed_at=datetime.now(timezone.utc),
    )
    partial = _route(
        _RecoveryClient(
            exact=None,
            positions=(
                {
                    "symbol": "AAPL",
                    "side": "long",
                    "qty": "0.5",
                    "current_price": "200",
                },
            ),
        )
    ).observe(receipt, observed_at=datetime.now(timezone.utc))

    assert flat.outcome == "found"
    assert partial.outcome == "not_found"
    assert partial.evidence["reason"] == "flatten_incomplete"
