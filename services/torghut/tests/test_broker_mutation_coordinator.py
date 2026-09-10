from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Iterator, Mapping
from decimal import Decimal
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
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationIntent,
    BrokerMutationExplicitRejection,
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
from app.trading.broker_mutation_coordinator import (
    BrokerMutationAlreadyProcessed,
    BrokerMutationDeferred,
    BrokerMutationPreflightFailed,
    BrokerMutationRejected,
    BrokerMutationUnresolved,
    BrokerMutationCoordinator,
    LinkedOrderSubmission,
    LinkedOrderSubmissionCallbacks,
    UnlinkedMutationCallbacks,
)
from app.trading.broker_mutation_receipts.runtime_status import (
    load_broker_mutation_runtime_status,
)


class _ProcessDeath(BaseException):
    pass


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
            workflow_id="hyperliquid-mutation/0x" + "1" * 32,
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


def _unlinked_cancel_intent() -> BrokerMutationIntent:
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="hyperliquid",
            account_label="hyperliquid-testnet",
            endpoint_fingerprint="b" * 64,
            operation="cancel_order",
            risk_class="risk_neutral",
            purpose="operator",
            workflow_id="cancel/1234",
            client_request_id="cancel-1234",
            target=BrokerMutationTarget(kind="order", key="1234"),
            request_payload={"order_id": "1234"},
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


def _coordinator(component: str = "slice4-test") -> BrokerMutationCoordinator:
    return BrokerMutationCoordinator(component)


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


def _latest_settlement(
    factory: sessionmaker[Session],
) -> tuple[str | None, dict[str, object]]:
    with factory() as session:
        latest = session.execute(
            select(BrokerMutationReceiptEvent)
            .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
            .limit(1)
        ).scalar_one()
    evidence = json.loads(str(latest.settlement_evidence_json))
    assert isinstance(evidence, dict)
    return latest.settlement_outcome, evidence


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
            "app.trading.broker_mutation_coordinator.acquire_decision_submission_claim",
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
            "app.trading.broker_mutation_coordinator.acquire_broker_mutation_receipt",
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
            "app.trading.broker_mutation_coordinator.acquire_broker_mutation_receipt",
            side_effect=BrokerMutationReceiptError("receipt-unavailable"),
        ),
        pytest.raises(
            BrokerMutationDeferred,
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
            "app.trading.broker_mutation_coordinator.mark_broker_mutation_io_started",
            side_effect=BrokerMutationReceiptError("io-boundary-unavailable"),
        ),
        pytest.raises(
            BrokerMutationDeferred,
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
        BrokerMutationUnresolved if isinstance(failure, Exception) else _ProcessDeath
    )
    with sessions() as session, pytest.raises(expected_error):
        coordinator.submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )

    assert _states(sessions) == ("broker_io", "broker_io", 0)
    with sessions() as session, pytest.raises(BrokerMutationDeferred):
        coordinator.submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(session, decision, broker_call),
        )
    assert broker_calls == 1


def test_explicit_linked_broker_rejection_settles_claim_and_receipt(
    sessions: sessionmaker[Session],
) -> None:
    decision = _decision(sessions)
    coordinator = _coordinator()
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        raise BrokerMutationExplicitRejection(
            broker_status="http_403",
            rejection_code="40310000",
            detail="cost basis below broker minimum",
        )

    def forbidden_execution(_response: Mapping[str, object]) -> Execution:
        raise AssertionError("rejection must not persist an execution")

    with (
        sessions() as session,
        pytest.raises(
            BrokerMutationRejected,
            match="linked_submission_broker_rejected.*http_403:40310000",
        ),
    ):
        coordinator.submit_linked_order(
            session,
            request=_request(decision),
            callbacks=_linked_callbacks(
                session,
                decision,
                broker_call,
                persist_execution=forbidden_execution,
            ),
        )

    assert broker_calls == 1
    assert _states(sessions) == ("rejected", "settled", 0)
    outcome, evidence = _latest_settlement(sessions)
    assert outcome == "rejected"
    broker_evidence = evidence["evidence"]
    assert isinstance(broker_evidence, dict)
    assert broker_evidence["broker_status"] == "http_403"
    assert broker_evidence["rejection_code"] == "40310000"

    with sessions() as session, pytest.raises(BrokerMutationRejected):
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
            BrokerMutationUnresolved,
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
    with sessions() as session, pytest.raises(BrokerMutationAlreadyProcessed):
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
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=UnlinkedMutationCallbacks(
                broker_call=broker_call,
                persist_terminal=persist_terminal,
                build_settlement=settlement,
            ),
        )
    with sessions() as session, pytest.raises(BrokerMutationAlreadyProcessed):
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=UnlinkedMutationCallbacks(
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
            raise BrokerMutationPreflightFailed("position-read-failed")

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

    callbacks = UnlinkedMutationCallbacks(
        broker_call=broker_call,
        persist_terminal=lambda _result: None,
        build_settlement=settlement,
        preflight=preflight,
    )
    with (
        sessions() as session,
        pytest.raises(
            BrokerMutationPreflightFailed,
            match="position-read-failed",
        ),
    ):
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=callbacks,
        )

    assert (preflight_calls, broker_calls) == (1, 0)
    assert _states(sessions) == (None, "released", 0)

    fail_preflight = False
    with sessions() as session:
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=callbacks,
        )

    assert (preflight_calls, broker_calls) == (2, 1)
    assert _states(sessions) == (None, "settled", 0)

    fail_preflight = True
    with sessions() as session, pytest.raises(BrokerMutationAlreadyProcessed):
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=callbacks,
        )
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

    with (
        sessions() as session,
        pytest.raises(
            BrokerMutationUnresolved,
            match="unlinked_submission_broker_io_unresolved",
        ),
    ):
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=UnlinkedMutationCallbacks(
                broker_call=broker_call,
                persist_terminal=lambda _result: None,
                build_settlement=unused_settlement,
            ),
        )

    with sessions() as session, pytest.raises(BrokerMutationDeferred):
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=UnlinkedMutationCallbacks(
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
    assert status["unresolved_submit_receipt_count"] == 1
    assert status["unresolved_reduction_receipt_count"] == 0
    assert status["settled_receipt_count"] == 0


def test_explicit_unlinked_broker_rejection_settles_without_terminal_callback(
    sessions: sessionmaker[Session],
) -> None:
    coordinator = _coordinator()
    intent = _unlinked_intent()
    broker_calls = 0

    def broker_call(_permit: object) -> Mapping[str, object]:
        nonlocal broker_calls
        broker_calls += 1
        raise BrokerMutationExplicitRejection(
            broker_status="http_422",
            rejection_code="42210000",
            detail="order rejected",
        )

    def forbidden_terminal(_result: Mapping[str, object]) -> None:
        raise AssertionError("rejection must not run the success callback")

    def forbidden_settlement(
        _result: Mapping[str, object],
    ) -> BrokerMutationSettlement:
        raise AssertionError("rejection must use the coordinator settlement")

    callbacks = UnlinkedMutationCallbacks(
        broker_call=broker_call,
        persist_terminal=forbidden_terminal,
        build_settlement=forbidden_settlement,
    )
    with (
        sessions() as session,
        pytest.raises(
            BrokerMutationRejected,
            match="unlinked_submission_broker_rejected.*http_422:42210000",
        ),
    ):
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=callbacks,
        )

    assert broker_calls == 1
    assert _states(sessions) == (None, "settled", 0)
    outcome, evidence = _latest_settlement(sessions)
    assert outcome == "rejected"
    assert evidence["evidence"] == {
        "broker_status": "http_422",
        "detail": "order rejected",
        "rejection_code": "42210000",
        "schema_version": "torghut.broker-mutation-explicit-rejection.v1",
    }

    with sessions() as session, pytest.raises(BrokerMutationAlreadyProcessed):
        coordinator.execute_unlinked_mutation(
            session,
            intent=intent,
            callbacks=callbacks,
        )
    assert broker_calls == 1


def test_reduction_timeout_uses_operation_specific_error_scope(
    sessions: sessionmaker[Session],
) -> None:
    def broker_call(_permit: object) -> Mapping[str, object]:
        raise TimeoutError("timeout")

    def unused_settlement(_result: Mapping[str, object]) -> BrokerMutationSettlement:
        raise AssertionError("terminal settlement must not run after timeout")

    with (
        sessions() as session,
        pytest.raises(
            BrokerMutationUnresolved,
            match="unlinked_cancel_order_broker_io_unresolved",
        ),
    ):
        _coordinator().execute_unlinked_mutation(
            session,
            intent=_unlinked_cancel_intent(),
            callbacks=UnlinkedMutationCallbacks(
                broker_call=broker_call,
                persist_terminal=lambda _result: None,
                build_settlement=unused_settlement,
            ),
        )

    with sessions() as session:
        status = load_broker_mutation_runtime_status(session)
    assert status["unresolved_receipt_count"] == 1
    assert status["unresolved_submit_receipt_count"] == 0
    assert status["unresolved_reduction_receipt_count"] == 1
    assert "broker_mutation_reduction_unresolved" in status["reason_codes"]


@pytest.mark.parametrize(
    ("intent_factory", "expected_scope"),
    [
        (_unlinked_intent, "unlinked_submission_terminal_unresolved"),
        (_unlinked_cancel_intent, "unlinked_cancel_order_terminal_unresolved"),
    ],
)
def test_unlinked_terminal_error_scope_preserves_submit_contract(
    sessions: sessionmaker[Session],
    intent_factory: Callable[[], BrokerMutationIntent],
    expected_scope: str,
) -> None:
    def terminal_failure(_result: Mapping[str, object]) -> None:
        raise RuntimeError("database unavailable")

    with (
        sessions() as session,
        pytest.raises(BrokerMutationUnresolved, match=expected_scope),
    ):
        _coordinator().execute_unlinked_mutation(
            session,
            intent=intent_factory(),
            callbacks=UnlinkedMutationCallbacks(
                broker_call=lambda _permit: {"id": "broker-order"},
                persist_terminal=terminal_failure,
                build_settlement=lambda _result: build_broker_mutation_settlement(
                    BrokerMutationSettlementRequest(
                        source="primary",
                        outcome="acknowledged",
                        broker_reference="broker-order",
                        execution_id=None,
                        evidence_payload={"status": "accepted"},
                    )
                ),
            ),
        )
