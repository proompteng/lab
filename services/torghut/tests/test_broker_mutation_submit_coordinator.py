from __future__ import annotations

import uuid
from collections.abc import Callable, Iterator, Mapping
from decimal import Decimal
from typing import cast
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import (
    Base,
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    Execution,
    Strategy,
    TradeDecision,
    TradeDecisionSubmissionClaim,
)
from app.config import settings
from app.alpaca_client import TorghutAlpacaClient
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationIntent,
    BrokerMutationIoPermit,
    BrokerMutationIoPermitExpectation,
    BrokerMutationReceiptValidationError,
    BrokerMutationReceiptError,
    BrokerMutationSettlementRequest,
    BrokerMutationSettlement,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
    validate_broker_mutation_io_permit,
)
from app.trading.broker_mutation_submit_coordinator import (
    BrokerMutationSubmissionAlreadyProcessed,
    BrokerMutationSubmissionDeferred,
    BrokerMutationSubmissionPreflightFailed,
    BrokerMutationSubmissionUnresolved,
    BrokerMutationSubmitCoordinator,
    LinkedOrderSubmission,
    LinkedOrderSubmissionCallbacks,
    UnlinkedOrderSubmissionCallbacks,
)
from app.trading.execution_adapters import AlpacaExecutionAdapter, OrderSubmission
from app.trading.firewall import OrderFirewall
from app.trading.broker_mutation_receipts.runtime_status import (
    load_broker_mutation_runtime_status,
)


class _ProcessDeath(BaseException):
    pass


class _CloseoutBroker:
    endpoint_url = "https://paper-api.alpaca.markets"

    def __init__(self) -> None:
        self.submit_calls = 0
        self.position_calls = 0
        self.position_error: Exception | None = None
        self.position_snapshots: list[list[dict[str, object]]] = []

    def list_positions(self) -> list[dict[str, object]]:
        self.position_calls += 1
        if self.position_error is not None:
            raise self.position_error
        if self.position_snapshots:
            return self.position_snapshots.pop(0)
        return [{"symbol": "AAPL", "qty": "1"}]

    def submit_order(self, **_kwargs: object) -> dict[str, object]:
        self.submit_calls += 1
        return {"id": "closeout-order-1", "status": "accepted"}


@pytest.fixture
def sessions() -> Iterator[sessionmaker[Session]]:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(
        bind=engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        yield factory
    finally:
        engine.dispose()


def _decision(factory: sessionmaker[Session]) -> TradeDecision:
    with factory() as session:
        strategy = Strategy(
            name=f"slice4-{uuid.uuid4()}",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        session.add(strategy)
        session.flush()
        decision = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json={"action": "buy"},
            decision_hash=uuid.uuid4().hex + uuid.uuid4().hex,
            status="planned",
        )
        session.add(decision)
        session.commit()
        session.refresh(decision)
        return decision


def _request(
    decision: TradeDecision, *, endpoint_url: str = "https://paper-api.alpaca.markets"
) -> LinkedOrderSubmission:
    assert decision.decision_hash is not None
    return LinkedOrderSubmission(
        decision_id=decision.id,
        account_label="paper",
        client_order_id=decision.decision_hash,
        endpoint_url=endpoint_url,
        workflow_id=str(decision.id),
        risk_class="risk_increasing",
        request_payload={
            "symbol": "AAPL",
            "side": "buy",
            "qty": Decimal("1"),
            "order_type": "market",
            "time_in_force": "day",
        },
    )


def _unlinked_intent() -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="hyperliquid",
            account_label="hyperliquid-testnet",
            endpoint_fingerprint="b" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="hyperliquid-submit/0x" + "1" * 32,
            client_request_id="0x" + "1" * 32,
            target=BrokerMutationTarget(kind="order", key="0x" + "1" * 32),
            request_payload={
                "coin": "BTC",
                "side": "buy",
                "size": Decimal("0.01"),
                "limit_price": Decimal("50000"),
                "tif": "Ioc",
                "reduce_only": False,
            },
        )
    )


def _execution(
    session: Session,
    decision: TradeDecision,
    response: Mapping[str, object],
) -> Execution:
    assert decision.decision_hash is not None
    execution = Execution(
        id=uuid.uuid4(),
        trade_decision_id=decision.id,
        alpaca_account_label="paper",
        alpaca_order_id=str(response["id"]),
        client_order_id=decision.decision_hash,
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("0"),
        status="accepted",
    )
    session.add(execution)
    return execution


def _coordinator(component: str = "slice4-test") -> BrokerMutationSubmitCoordinator:
    return BrokerMutationSubmitCoordinator(component)


def _linked_callbacks(
    session: Session,
    decision: TradeDecision,
    broker_call: Callable[[BrokerMutationIoPermit], Mapping[str, object]],
    persist_execution: Callable[[Mapping[str, object]], Execution] | None = None,
) -> LinkedOrderSubmissionCallbacks:
    return LinkedOrderSubmissionCallbacks(
        broker_call=broker_call,
        persist_execution=persist_execution
        or (lambda response: _execution(session, decision, response)),
    )


def _states(factory: sessionmaker[Session]) -> tuple[str | None, str | None, int]:
    with factory() as session:
        claim = session.execute(
            select(TradeDecisionSubmissionClaim)
        ).scalar_one_or_none()
        receipt = session.execute(select(BrokerMutationReceipt)).scalar_one_or_none()
        latest = (
            session.execute(
                select(BrokerMutationReceiptEvent)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one_or_none()
            if receipt is not None
            else None
        )
        execution_count = len(session.execute(select(Execution.id)).all())
        return (
            claim.state if claim is not None else None,
            latest.state if latest is not None else None,
            execution_count,
        )


def test_alpaca_closeout_submit_is_receipted_and_deduplicated(
    sessions: sessionmaker[Session],
) -> None:
    broker = _CloseoutBroker()
    firewall = OrderFirewall(broker, account_label="paper")
    adapter = AlpacaExecutionAdapter(
        firewall=firewall,
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )
    submission = OrderSubmission(
        symbol="AAPL",
        side="sell",
        qty=1.0,
        order_type="limit",
        time_in_force="day",
        limit_price=100.0,
        stop_price=None,
        extra_params={"client_order_id": "torghut-closeout-test-1"},
    )

    with patch.object(settings, "trading_kill_switch_enabled", False):
        with pytest.raises(
            RuntimeError,
            match="alpaca_entry_submit_requires_durable_order_firewall",
        ):
            adapter.submit_order(submission)
        result = adapter.submit_risk_reducing_order(submission)
        with pytest.raises(BrokerMutationSubmissionAlreadyProcessed):
            adapter.submit_risk_reducing_order(submission)

    assert result["id"] == "closeout-order-1"
    assert broker.submit_calls == 1
    assert broker.position_calls == 2
    with sessions() as session:
        receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
        assert receipt.broker_route == "alpaca"
        assert receipt.risk_class == "risk_reducing"
        assert receipt.purpose == "closeout"
        assert receipt.submission_claim_id is None
        assert latest.state == "settled"
        assert latest.settlement_outcome == "acknowledged"


def test_alpaca_closeout_position_failure_releases_before_broker_io(
    sessions: sessionmaker[Session],
) -> None:
    broker = _CloseoutBroker()
    broker.position_error = RuntimeError("position-read-failed")
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )
    submission = OrderSubmission(
        symbol="AAPL",
        side="sell",
        qty=1.0,
        order_type="limit",
        time_in_force="day",
        limit_price=100.0,
        stop_price=None,
        extra_params={"client_order_id": "torghut-closeout-position-failure"},
    )

    with (
        patch.object(settings, "trading_kill_switch_enabled", False),
        pytest.raises(
            BrokerMutationSubmissionPreflightFailed,
            match="risk_reduction_preflight_failed",
        ),
    ):
        adapter.submit_risk_reducing_order(submission)

    assert broker.submit_calls == 0
    assert broker.position_calls == 1
    assert _states(sessions) == (None, "released", 0)


def test_alpaca_closeout_revalidates_position_at_submit_boundary(
    sessions: sessionmaker[Session],
) -> None:
    broker = _CloseoutBroker()
    broker.position_snapshots = [
        [{"symbol": "AAPL", "qty": "1"}],
        [],
    ]
    adapter = AlpacaExecutionAdapter(
        firewall=OrderFirewall(broker, account_label="paper"),
        read_client=cast(TorghutAlpacaClient, broker),
        session_factory=sessions,
        account_label="paper",
        endpoint_url=broker.endpoint_url,
    )
    submission = OrderSubmission(
        symbol="AAPL",
        side="sell",
        qty=1.0,
        order_type="limit",
        time_in_force="day",
        limit_price=100.0,
        stop_price=None,
        extra_params={"client_order_id": "torghut-closeout-position-race"},
    )

    with (
        patch.object(settings, "trading_kill_switch_enabled", False),
        pytest.raises(
            BrokerMutationSubmissionUnresolved,
            match="OrderFirewallRiskReductionBlocked",
        ),
    ):
        adapter.submit_risk_reducing_order(submission)

    assert broker.position_calls == 2
    assert broker.submit_calls == 0
    assert _states(sessions) == (None, "broker_io", 0)


def test_invalid_intent_fails_before_claim_or_broker_call(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "order-1", "status": "accepted"}

    with (
        sessions() as session,
        pytest.raises(
            BrokerMutationReceiptValidationError,
            match="endpoint_url_scheme_invalid",
        ),
    ):
        _coordinator().submit_linked_order(
            session,
            request=_request(decision, endpoint_url="not-a-url"),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )

    assert broker_calls == 0
    assert _states(sessions) == (None, None, 0)


def test_process_death_before_claim_leaves_no_durable_or_broker_state(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "order-1", "status": "accepted"}

    with (
        sessions() as session,
        patch(
            "app.trading.broker_mutation_submit_coordinator.acquire_decision_submission_claim",
            side_effect=_ProcessDeath("before-claim"),
        ),
        pytest.raises(_ProcessDeath, match="before-claim"),
    ):
        _coordinator().submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )

    assert broker_calls == 0
    assert _states(sessions) == (None, None, 0)


def test_process_death_after_claim_leaves_claimed_without_broker_io(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "order-1", "status": "accepted"}

    with (
        sessions() as session,
        patch(
            "app.trading.broker_mutation_submit_coordinator.acquire_broker_mutation_receipt",
            side_effect=_ProcessDeath("after-claim"),
        ),
        pytest.raises(_ProcessDeath, match="after-claim"),
    ):
        _coordinator().submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )

    assert broker_calls == 0
    assert _states(sessions) == ("claimed", None, 0)


def test_receipt_failure_after_claim_defers_without_rejecting_or_broker_io(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "order-1", "status": "accepted"}

    with (
        sessions() as session,
        patch(
            "app.trading.broker_mutation_submit_coordinator.acquire_broker_mutation_receipt",
            side_effect=BrokerMutationReceiptError("receipt-unavailable"),
        ),
        pytest.raises(
            BrokerMutationSubmissionDeferred,
            match="linked_submission_receipt_unavailable",
        ),
    ):
        _coordinator().submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )

    assert broker_calls == 0
    assert _states(sessions) == ("claimed", None, 0)


def test_io_boundary_failure_defers_claimed_receipt_without_broker_call(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "order-1", "status": "accepted"}

    with (
        sessions() as session,
        patch(
            "app.trading.broker_mutation_submit_coordinator.mark_broker_mutation_io_started",
            side_effect=BrokerMutationReceiptError("io-boundary-unavailable"),
        ),
        pytest.raises(
            BrokerMutationSubmissionDeferred,
            match="linked_submission_io_boundary_unavailable",
        ),
    ):
        _coordinator().submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )

    assert broker_calls == 0
    assert _states(sessions) == ("claimed", "claimed", 0)


@pytest.mark.parametrize("failure", [TimeoutError("timeout"), _ProcessDeath("death")])
def test_failure_after_io_boundary_is_unresolved_and_never_retried(
    sessions: sessionmaker[Session],
    failure: BaseException,
) -> None:
    decision = _decision(sessions)
    broker_calls = 0
    coordinator = _coordinator()

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        raise failure

    expected_error: type[BaseException] = (
        BrokerMutationSubmissionUnresolved
        if isinstance(failure, Exception)
        else _ProcessDeath
    )
    with sessions() as session, pytest.raises(expected_error):
        coordinator.submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )

    assert _states(sessions) == ("broker_io", "broker_io", 0)
    with sessions() as session, pytest.raises(BrokerMutationSubmissionDeferred):
        coordinator.submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )
    assert broker_calls == 1


def test_acceptance_followed_by_persistence_failure_keeps_unresolved_truth(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "order-accepted", "status": "accepted"}

    with (
        sessions() as session,
        pytest.raises(
            BrokerMutationSubmissionUnresolved,
            match="terminal_unresolved",
        ),
    ):
        _coordinator().submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(
                session,
                decision,
                broker_call,
                persist_execution=lambda _response: (_ for _ in ()).throw(
                    RuntimeError("database unavailable")
                ),
            ),
        )

    assert broker_calls == 1
    assert _states(sessions) == ("broker_io", "broker_io", 0)


def test_process_death_after_acceptance_before_persistence_keeps_unresolved_truth(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "order-accepted", "status": "accepted"}

    with sessions() as session, pytest.raises(_ProcessDeath, match="after-acceptance"):
        _coordinator().submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(
                session,
                decision,
                broker_call,
                persist_execution=lambda _response: (_ for _ in ()).throw(
                    _ProcessDeath("after-acceptance")
                ),
            ),
        )

    assert broker_calls == 1
    assert _states(sessions) == ("broker_io", "broker_io", 0)


def test_success_commits_claim_receipt_and_execution_once(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    broker_calls = 0
    coordinator = _coordinator()

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "order-accepted", "status": "accepted"}

    with sessions() as session:
        execution = coordinator.submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )
        assert execution.alpaca_order_id == "order-accepted"

    assert _states(sessions) == ("submitted", "settled", 1)
    with sessions() as session, pytest.raises(BrokerMutationSubmissionAlreadyProcessed):
        coordinator.submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )
    assert broker_calls == 1


def test_unlinked_submit_settles_once_and_rejects_duplicate_replay(
    sessions: sessionmaker[Session],
) -> None:
    coordinator = _coordinator()
    broker_calls = 0
    persisted = 0
    intent = _unlinked_intent()

    def broker_call(permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        validate_broker_mutation_io_permit(
            permit,
            expectation=BrokerMutationIoPermitExpectation(
                broker_route="hyperliquid",
                operation="submit_order",
            ),
        )
        broker_calls += 1
        return {"id": "hl-order-1", "status": "accepted"}

    def persist_terminal(_result: Mapping[str, object]) -> None:
        nonlocal persisted
        persisted += 1

    def settlement(_result: Mapping[str, object]) -> BrokerMutationSettlement:
        return build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="primary",
                outcome="acknowledged",
                broker_reference="hl-order-1",
                execution_id=None,
                evidence_payload={"status": "accepted"},
            )
        )

    with sessions() as session:
        coordinator.submit_unlinked_order(
            session,
            intent=intent,
            callbacks=UnlinkedOrderSubmissionCallbacks(
                broker_call=broker_call,
                persist_terminal=persist_terminal,
                build_settlement=settlement,
            ),
        )
    with sessions() as session, pytest.raises(BrokerMutationSubmissionAlreadyProcessed):
        coordinator.submit_unlinked_order(
            session,
            intent=intent,
            callbacks=UnlinkedOrderSubmissionCallbacks(
                broker_call=broker_call,
                persist_terminal=persist_terminal,
                build_settlement=settlement,
            ),
        )

    assert (broker_calls, persisted) == (1, 1)
    assert _states(sessions) == (None, "settled", 0)
    with sessions() as session:
        status = load_broker_mutation_runtime_status(session)
    assert status["settled_receipt_count"] == 1
    assert status["unresolved_receipt_count"] == 0


def test_unlinked_preflight_failure_releases_and_remains_retryable(
    sessions: sessionmaker[Session],
) -> None:
    coordinator = _coordinator()
    intent = _unlinked_intent()
    preflight_calls = 0
    broker_calls = 0
    fail_preflight = True

    def preflight() -> None:
        nonlocal preflight_calls
        preflight_calls += 1
        if fail_preflight:
            raise BrokerMutationSubmissionPreflightFailed("position-read-failed")

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        return {"id": "hl-order-preflight", "status": "accepted"}

    def settlement(_result: Mapping[str, object]) -> BrokerMutationSettlement:
        return build_broker_mutation_settlement(
            BrokerMutationSettlementRequest(
                source="primary",
                outcome="acknowledged",
                broker_reference="hl-order-preflight",
                execution_id=None,
                evidence_payload={"status": "accepted"},
            )
        )

    callbacks = UnlinkedOrderSubmissionCallbacks(
        broker_call=broker_call,
        persist_terminal=lambda _result: None,
        build_settlement=settlement,
        preflight=preflight,
    )
    with (
        sessions() as session,
        pytest.raises(
            BrokerMutationSubmissionPreflightFailed,
            match="position-read-failed",
        ),
    ):
        coordinator.submit_unlinked_order(session, intent=intent, callbacks=callbacks)

    assert (preflight_calls, broker_calls) == (1, 0)
    assert _states(sessions) == (None, "released", 0)

    fail_preflight = False
    with sessions() as session:
        coordinator.submit_unlinked_order(session, intent=intent, callbacks=callbacks)

    assert (preflight_calls, broker_calls) == (2, 1)
    assert _states(sessions) == (None, "settled", 0)

    fail_preflight = True
    with sessions() as session, pytest.raises(BrokerMutationSubmissionAlreadyProcessed):
        coordinator.submit_unlinked_order(session, intent=intent, callbacks=callbacks)
    assert (preflight_calls, broker_calls) == (2, 1)


def test_unlinked_timeout_stays_unresolved_and_is_not_retried(
    sessions: sessionmaker[Session],
) -> None:
    coordinator = _coordinator()
    broker_calls = 0
    intent = _unlinked_intent()

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        raise TimeoutError("timeout")

    def unused_settlement(_result: Mapping[str, object]) -> BrokerMutationSettlement:
        raise AssertionError("terminal settlement must not run after timeout")

    for expected_error in (
        BrokerMutationSubmissionUnresolved,
        BrokerMutationSubmissionDeferred,
    ):
        with sessions() as session, pytest.raises(expected_error):
            coordinator.submit_unlinked_order(
                session,
                intent=intent,
                callbacks=UnlinkedOrderSubmissionCallbacks(
                    broker_call=broker_call,
                    persist_terminal=lambda _result: None,
                    build_settlement=unused_settlement,
                ),
            )

    assert broker_calls == 1
    assert _states(sessions) == (None, "broker_io", 0)
    with sessions() as session:
        status = load_broker_mutation_runtime_status(session)
    assert status["unresolved_receipt_count"] == 1
    assert status["settled_receipt_count"] == 0
