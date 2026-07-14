from __future__ import annotations

import uuid
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from threading import Barrier, Event, Lock

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import (
    BrokerMutationReceipt,
    BrokerMutationReceiptEvent,
    Execution,
    TradeDecisionSubmissionClaim,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationIoPermit,
    BrokerMutationIoPermitExpectation,
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
    consume_broker_mutation_io_permit,
    validate_broker_mutation_io_permit,
)
from app.trading.broker_mutation_submit_coordinator import (
    BrokerMutationSubmissionAlreadyProcessed,
    BrokerMutationSubmissionDeferred,
    BrokerMutationSubmitCoordinator,
    LinkedOrderSubmission,
    LinkedOrderSubmissionCallbacks,
    UnlinkedOrderSubmissionCallbacks,
)
from tests.execution.decision_submission_claims_postgres_support import (
    POSTGRES_DSN,
    SERVICE_ROOT,
    create_schema_engines,
    drop_schema,
    insert_decision,
)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the coordinator race test",
)
def test_postgres_two_leaders_make_exactly_one_broker_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "submit_coordinator"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0061_linked_submission_terminal")
        command.stamp(alembic, "0065_strategy_capital_compat")
        command.upgrade(alembic, "0066_broker_submit_coordinator")

        with schema_engine.connect() as connection:
            check_constraints = connection.execute(
                text(
                    """
                    SELECT conname, pg_get_constraintdef(oid)
                      FROM pg_constraint
                     WHERE conrelid = 'broker_mutation_receipts'::regclass
                       AND contype = 'c'
                    """
                )
            ).all()
        operation_contract = next(
            definition
            for _name, definition in check_constraints
            if "submit_order" in definition and "hyperliquid" in definition
        )
        assert "alpaca" in operation_contract
        assert "hyperliquid" in operation_contract

        decision_id = uuid.uuid4()
        client_order_id = uuid.uuid4().hex + uuid.uuid4().hex
        with schema_engine.begin() as connection:
            insert_decision(
                connection,
                decision_id=decision_id,
                client_order_id=client_order_id,
            )

        request = LinkedOrderSubmission(
            decision_id=decision_id,
            account_label="paper",
            client_order_id=client_order_id,
            endpoint_url="https://paper-api.alpaca.markets",
            workflow_id=str(decision_id),
            risk_class="risk_increasing",
            request_payload={
                "symbol": "AAPL",
                "side": "buy",
                "qty": Decimal("1"),
                "order_type": "market",
                "time_in_force": "day",
            },
        )
        entrants = Barrier(2)
        broker_started = Event()
        release_broker = Event()
        broker_call_lock = Lock()
        broker_calls = 0

        def broker_call(permit: BrokerMutationIoPermit) -> Mapping[str, object]:
            nonlocal broker_calls
            validate_broker_mutation_io_permit(permit)
            with broker_call_lock:
                broker_calls += 1
            broker_started.set()
            assert release_broker.wait(timeout=10)
            return {"id": "order-concurrent", "status": "accepted"}

        def run(component: str) -> str:
            entrants.wait(timeout=10)
            with sessions() as session:
                try:
                    BrokerMutationSubmitCoordinator(component).submit_linked_order(
                        session,
                        request=request,
                        callbacks=LinkedOrderSubmissionCallbacks(
                            broker_call=broker_call,
                            persist_execution=lambda response: _persist_execution(
                                session,
                                decision_id=decision_id,
                                client_order_id=client_order_id,
                                response=response,
                            ),
                        ),
                    )
                except BrokerMutationSubmissionAlreadyProcessed:
                    return "already_processed"
                except BrokerMutationSubmissionDeferred:
                    return "deferred"
            return "submitted"

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(run, component)
                for component in ("leader-a", "leader-b")
            ]
            assert broker_started.wait(timeout=10)
            release_broker.set()
            outcomes = [future.result(timeout=15) for future in futures]

        assert broker_calls == 1
        assert outcomes.count("submitted") == 1
        assert set(outcomes).issubset({"submitted", "already_processed", "deferred"})
        with sessions() as session:
            claim_state = session.execute(
                select(TradeDecisionSubmissionClaim.state)
            ).scalar_one()
            receipt_state = session.execute(
                select(BrokerMutationReceiptEvent.state)
                .join(
                    BrokerMutationReceipt,
                    BrokerMutationReceipt.id == BrokerMutationReceiptEvent.receipt_id,
                )
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
            execution_count = len(session.execute(select(Execution.id)).all())
        assert (claim_state, receipt_state, execution_count) == (
            "submitted",
            "settled",
            1,
        )
    finally:
        drop_schema(schema, admin_engine, schema_engine)


@pytest.mark.skipif(
    not POSTGRES_DSN,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the coordinator closeout test",
)
def test_postgres_unlinked_alpaca_closeout_settles_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    schema, admin_engine, schema_engine, schema_dsn = create_schema_engines(
        "submit_closeout"
    )
    sessions = sessionmaker(
        bind=schema_engine,
        class_=Session,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    request_payload = {
        "symbol": "AAPL",
        "side": "sell",
        "qty": Decimal("1"),
        "order_type": "limit",
        "time_in_force": "day",
        "limit_price": Decimal("100"),
        "stop_price": None,
        "extra_params": {"client_order_id": "closeout-postgres-1"},
    }
    try:
        monkeypatch.setattr(settings, "db_dsn", schema_dsn)
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        command.stamp(alembic, "0057_generic_multifactor_machine")
        command.upgrade(alembic, "0061_linked_submission_terminal")
        command.stamp(alembic, "0065_strategy_capital_compat")
        command.upgrade(alembic, "0066_broker_submit_coordinator")
        intent = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label="paper",
                endpoint_fingerprint="a" * 64,
                operation="submit_order",
                risk_class="risk_reducing",
                purpose="closeout",
                workflow_id="closeout-postgres-1",
                client_request_id="closeout-postgres-1",
                target=BrokerMutationTarget(
                    kind="order",
                    key="closeout-postgres-1",
                ),
                request_payload=request_payload,
            )
        )
        coordinator = BrokerMutationSubmitCoordinator("alpaca-closeout-pg")
        broker_calls = 0

        def broker_call(permit: BrokerMutationIoPermit) -> Mapping[str, object]:
            nonlocal broker_calls
            consume_broker_mutation_io_permit(
                permit,
                expectation=BrokerMutationIoPermitExpectation(
                    broker_route="alpaca",
                    operation="submit_order",
                    risk_class="risk_reducing",
                    account_label="paper",
                    endpoint_fingerprint="a" * 64,
                    request_payload=request_payload,
                ),
            )
            broker_calls += 1
            return {"id": "closeout-order-postgres-1", "status": "accepted"}

        def settlement(result: Mapping[str, object]) -> BrokerMutationSettlement:
            return build_broker_mutation_settlement(
                BrokerMutationSettlementRequest(
                    source="primary",
                    outcome="acknowledged",
                    broker_reference=str(result["id"]),
                    execution_id=None,
                    evidence_payload={"status": result["status"]},
                )
            )

        with sessions() as session:
            coordinator.submit_unlinked_order(
                session,
                intent=intent,
                callbacks=UnlinkedOrderSubmissionCallbacks(
                    broker_call=broker_call,
                    persist_terminal=lambda _result: None,
                    build_settlement=settlement,
                ),
            )
        with (
            sessions() as session,
            pytest.raises(BrokerMutationSubmissionAlreadyProcessed),
        ):
            coordinator.submit_unlinked_order(
                session,
                intent=intent,
                callbacks=UnlinkedOrderSubmissionCallbacks(
                    broker_call=broker_call,
                    persist_terminal=lambda _result: None,
                    build_settlement=settlement,
                ),
            )

        with sessions() as session:
            receipt = session.execute(select(BrokerMutationReceipt)).scalar_one()
            latest = session.execute(
                select(BrokerMutationReceiptEvent)
                .where(BrokerMutationReceiptEvent.receipt_id == receipt.id)
                .order_by(BrokerMutationReceiptEvent.sequence_no.desc())
                .limit(1)
            ).scalar_one()
        assert broker_calls == 1
        assert receipt.submission_claim_id is None
        assert (receipt.broker_route, receipt.risk_class, receipt.purpose) == (
            "alpaca",
            "risk_reducing",
            "closeout",
        )
        assert (latest.state, latest.settlement_outcome) == (
            "settled",
            "acknowledged",
        )
    finally:
        drop_schema(schema, admin_engine, schema_engine)


def _persist_execution(
    session: Session,
    *,
    decision_id: uuid.UUID,
    client_order_id: str,
    response: Mapping[str, object],
) -> Execution:
    execution_id = uuid.uuid4()
    broker_order_id = str(response["id"])
    session.execute(
        text(
            """
            INSERT INTO executions (
                id, trade_decision_id, alpaca_account_label,
                client_order_id, alpaca_order_id, status
            ) VALUES (
                :id, :decision_id, 'paper',
                :client_order_id, :broker_order_id, 'accepted'
            )
            """
        ),
        {
            "id": execution_id,
            "decision_id": decision_id,
            "client_order_id": client_order_id,
            "broker_order_id": broker_order_id,
        },
    )
    return Execution(
        id=execution_id,
        trade_decision_id=decision_id,
        alpaca_account_label="paper",
        alpaca_order_id=broker_order_id,
        client_order_id=client_order_id,
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("0"),
        status="accepted",
    )
