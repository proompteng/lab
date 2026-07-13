from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Iterator

import pytest
from sqlalchemy import Engine, create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Execution, Strategy, TradeDecision, TradeDecisionSubmissionClaim
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
)
from app.trading.execution.alpaca_recovery_observation import (
    AlpacaRecoveryObservationOutcome,
    validate_alpaca_recovery_observation,
)
from app.trading.execution.materialization import (
    RecoveryMaterializationIdentityConflict,
    RecoveryMaterializationLifecycleConflict,
    materialize_validated_alpaca_recovery,
)


_DECISION_ID = uuid.UUID("00000000-0000-0000-0000-000000000101")
_CLIENT_ORDER_ID = "client-order-101"


@pytest.fixture
def engine() -> Iterator[Engine]:
    database = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(database)
    try:
        yield database
    finally:
        database.dispose()


def _intent(**request_overrides: object):
    request: dict[str, object] = {
        "symbol": "AAPL",
        "side": "buy",
        "qty": Decimal("2"),
        "notional": None,
        "order_type": "limit",
        "time_in_force": "day",
        "limit_price": Decimal("190.25"),
        "stop_price": None,
        "trail_price": None,
        "trail_percent": None,
        "order_class": "simple",
        "position_intent": "buy_to_open",
        "extended_hours": False,
    }
    request.update(request_overrides)
    return build_broker_mutation_intent(
        BrokerMutationIntentRequest(
            broker_route="alpaca",
            account_label="paper-primary",
            endpoint_fingerprint="a" * 64,
            operation="submit_order",
            risk_class="risk_increasing",
            purpose="initial_submission",
            workflow_id="decision/101",
            client_request_id=_CLIENT_ORDER_ID,
            target=BrokerMutationTarget(kind="order", key=_CLIENT_ORDER_ID),
            request_payload=request,
            submission_claim_id=_DECISION_ID,
        )
    )


def _broker_order(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "broker-order-101",
        "client_order_id": _CLIENT_ORDER_ID,
        "alpaca_account_label": "paper-primary",
        "status": "accepted",
        "symbol": "AAPL",
        "side": "buy",
        "qty": "2",
        "notional": None,
        "type": "limit",
        "time_in_force": "day",
        "limit_price": "190.25",
        "stop_price": None,
        "trail_price": None,
        "trail_percent": None,
        "order_class": "simple",
        "position_intent": "buy_to_open",
        "extended_hours": False,
        "filled_qty": "0",
        "filled_avg_price": None,
    }
    payload.update(overrides)
    return payload


def _observation(*, intent=None, **overrides: object):
    return validate_alpaca_recovery_observation(
        intent=intent or _intent(),
        account_label="paper-primary",
        expected_broker_order_id="broker-order-101",
        broker_order=_broker_order(**overrides),
    )


def _seed_submission(session: Session, *, state: str = "broker_io") -> None:
    strategy = Strategy(
        name="recovery-materialization",
        description="strict recovery materialization fixture",
        enabled=True,
        base_timeframe="1Min",
        universe_type="symbols_list",
        universe_symbols=["AAPL"],
    )
    session.add(strategy)
    session.flush()
    session.add(
        TradeDecision(
            id=_DECISION_ID,
            strategy_id=strategy.id,
            alpaca_account_label="paper-primary",
            symbol="AAPL",
            timeframe="1Min",
            decision_json={"side": "buy"},
            decision_hash="decision-hash-101",
            status="submitted",
        )
    )
    session.flush()
    now = datetime.now(timezone.utc)
    session.add(
        TradeDecisionSubmissionClaim(
            trade_decision_id=_DECISION_ID,
            account_label="paper-primary",
            client_order_id=_CLIENT_ORDER_ID,
            claim_token=uuid.uuid4(),
            fencing_epoch=1,
            state=state,
            claim_owner="recovery-worker",
            claimed_at=now,
            lease_expires_at=now + timedelta(minutes=5),
            broker_io_started_at=now if state in {"broker_io", "submitted"} else None,
            recovery_after=now - timedelta(minutes=1) if state in {"broker_io", "submitted"} else None,
        )
    )
    session.flush()


def test_materializer_flushes_without_commit_and_rollback_removes_execution(engine: Engine) -> None:
    with Session(engine) as session:
        _seed_submission(session)
        execution = materialize_validated_alpaca_recovery(
            session,
            intent=_intent(),
            observation=_observation(),
        )
        execution_id = execution.id
        assert execution in session
        assert session.execute(select(Execution).where(Execution.id == execution_id)).scalar_one() is execution
        session.rollback()

    with Session(engine) as session:
        assert session.get(Execution, execution_id) is None


def test_materializer_updates_one_exact_execution_monotonically(engine: Engine) -> None:
    with Session(engine) as session:
        _seed_submission(session)
        intent = _intent()
        first = materialize_validated_alpaca_recovery(
            session,
            intent=intent,
            observation=_observation(intent=intent),
        )
        first_id = first.id
        second = materialize_validated_alpaca_recovery(
            session,
            intent=intent,
            observation=_observation(
                intent=intent,
                status="filled",
                filled_qty="2",
                filled_avg_price="190.30",
            ),
        )
        assert second.id == first_id
        assert second.status == "filled"
        assert second.filled_qty == Decimal("2.00000000")
        session.commit()

    with Session(engine) as session:
        assert session.execute(select(Execution)).scalars().one().status == "filled"


def test_materializer_rejects_status_and_fill_regressions(engine: Engine) -> None:
    with Session(engine) as session:
        _seed_submission(session)
        intent = _intent()
        materialize_validated_alpaca_recovery(
            session,
            intent=intent,
            observation=_observation(intent=intent, status="filled", filled_qty="2", filled_avg_price="190.30"),
        )
        with pytest.raises(
            RecoveryMaterializationLifecycleConflict,
            match="(terminal_status_regression|filled_qty_regression)",
        ):
            materialize_validated_alpaca_recovery(
                session,
                intent=intent,
                observation=_observation(intent=intent),
            )
        session.rollback()


def test_materializer_rejects_indeterminate_notional_and_complex_observations(engine: Engine) -> None:
    with Session(engine) as session:
        _seed_submission(session)
        notional_intent = _intent(qty=None, notional=Decimal("500"))
        notional = _observation(intent=notional_intent)
        assert notional.outcome is AlpacaRecoveryObservationOutcome.INDETERMINATE
        with pytest.raises(ValueError, match="recovery_observation_not_validated"):
            materialize_validated_alpaca_recovery(session, intent=notional_intent, observation=notional)

        complex_intent = _intent(order_class="bracket")
        complex_observation = _observation(intent=complex_intent)
        assert complex_observation.outcome is AlpacaRecoveryObservationOutcome.INDETERMINATE
        with pytest.raises(ValueError, match="recovery_observation_not_validated"):
            materialize_validated_alpaca_recovery(
                session,
                intent=complex_intent,
                observation=complex_observation,
            )
        assert session.execute(select(Execution)).scalars().all() == []


def test_materializer_rejects_legacy_execution_without_identity_audit(engine: Engine) -> None:
    with Session(engine) as session:
        _seed_submission(session)
        session.add(
            Execution(
                id=uuid.uuid4(),
                trade_decision_id=_DECISION_ID,
                alpaca_account_label="paper-primary",
                alpaca_order_id="broker-order-101",
                client_order_id=_CLIENT_ORDER_ID,
                symbol="AAPL",
                side="buy",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("2"),
                filled_qty=Decimal("0"),
                avg_fill_price=None,
                status="accepted",
            )
        )
        session.flush()
        with pytest.raises(RecoveryMaterializationIdentityConflict, match="identity_missing"):
            materialize_validated_alpaca_recovery(
                session,
                intent=_intent(),
                observation=_observation(),
            )
        session.rollback()


def test_materializer_rejects_wrong_claim_identity_before_insert(engine: Engine) -> None:
    with Session(engine) as session:
        _seed_submission(session)
        claim = session.get(TradeDecisionSubmissionClaim, _DECISION_ID)
        assert claim is not None
        claim.client_order_id = "different-client-order"
        session.flush()
        with pytest.raises(RecoveryMaterializationIdentityConflict, match="claim_identity_mismatch"):
            materialize_validated_alpaca_recovery(
                session,
                intent=_intent(),
                observation=_observation(),
            )
        assert session.execute(select(Execution)).scalars().all() == []


def test_materializer_rejects_claim_before_broker_io(engine: Engine) -> None:
    with Session(engine) as session:
        _seed_submission(session, state="claimed")
        with pytest.raises(RecoveryMaterializationIdentityConflict, match="claim_state_invalid"):
            materialize_validated_alpaca_recovery(
                session,
                intent=_intent(),
                observation=_observation(),
            )
        assert session.execute(select(Execution)).scalars().all() == []
