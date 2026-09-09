from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.models import (
    Base,
    Execution,
    Strategy,
    TradeDecision,
    TradeDecisionSubmissionClaim,
)
from app.trading.decision_submission_claims import (
    DecisionSubmissionClaimAcquireOptions,
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimValidationError,
    DecisionSubmissionFenceError,
    RecoveryObservationOutcome,
    DecisionSubmissionRecoveryObservation,
    DecisionSubmissionTerminalIdentity,
    acquire_decision_submission_claim,
    acquire_decision_submission_recovery_claim,
    mark_decision_submission_broker_io_started,
    mark_decision_submission_recovered,
    mark_decision_submission_succeeded,
    record_decision_submission_recovery_observation,
    release_decision_submission_claim,
)


def _session_factory(
    database_path: Path,
) -> tuple[sessionmaker[Session], uuid.UUID, str]:
    engine = create_engine(
        f"sqlite+pysqlite:///{database_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
        future=True,
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(
        bind=engine,
        class_=Session,
        expire_on_commit=False,
        future=True,
    )
    decision_hash = "a" * 64
    with sessions() as session:
        strategy = Strategy(
            name="claim-test",
            description="submission claim fixture",
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
            decision_json={"action": "buy"},
            rationale="claim test",
            decision_hash=decision_hash,
            status="planned",
        )
        session.add(decision)
        session.commit()
        decision_id = decision.id
    return sessions, decision_id, decision_hash


def _acquire(
    session: Session,
    decision_id: uuid.UUID,
    client_order_id: str,
    *,
    owner: str = "worker-a",
) -> DecisionSubmissionClaimHandle:
    result = acquire_decision_submission_claim(
        session,
        decision_id=decision_id,
        client_order_id=client_order_id,
        claim_owner=owner,
    )
    assert result.claim is not None
    return result.claim.handle


def _enter_broker_io(
    sessions: sessionmaker[Session], decision_id: uuid.UUID, client_order_id: str
) -> DecisionSubmissionClaimHandle:
    with sessions() as session:
        handle = _acquire(session, decision_id, client_order_id)
    with sessions() as session:
        io_start = mark_decision_submission_broker_io_started(
            session,
            handle=handle,
        )
    assert io_start.transitioned
    assert io_start.claim.state == "broker_io"
    return handle


def test_only_first_submission_boundary_transition_grants_io_permit(
    tmp_path: Path,
) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "one-shot-io-permit.db"
    )
    with sessions() as session:
        handle = _acquire(session, decision_id, client_order_id)
    with sessions() as session:
        first = mark_decision_submission_broker_io_started(
            session,
            handle=handle,
        )
    assert first.transitioned
    with sessions() as session:
        repeated = mark_decision_submission_broker_io_started(
            session,
            handle=handle,
        )
    assert repeated.outcome == "already_started"
    assert not repeated.transitioned
    assert repeated.claim.state == "broker_io"


def test_submitted_boundary_retry_returns_terminal_snapshot(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "submitted-boundary-retry.db"
    )
    handle = _enter_broker_io(sessions, decision_id, client_order_id)
    with sessions() as session:
        execution = _pending_execution(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            broker_order_id="submitted-retry-order",
        )
        submitted = mark_decision_submission_succeeded(
            session,
            handle=handle,
            terminal=_terminal_identity(
                execution,
                client_order_id=client_order_id,
                broker_order_id="submitted-retry-order",
            ),
        )
        execution_id = execution.id
    assert submitted.state == "submitted"

    with sessions() as session:
        replay = mark_decision_submission_broker_io_started(
            session,
            handle=handle,
        )

    assert replay.outcome == "submitted"
    assert not replay.transitioned
    assert replay.claim.execution_id == execution_id


def _force_recovery_due(
    sessions: sessionmaker[Session], decision_id: uuid.UUID
) -> None:
    with sessions() as session:
        row = session.get(TradeDecisionSubmissionClaim, decision_id)
        assert row is not None
        row.recovery_after = datetime(2000, 1, 1, tzinfo=timezone.utc)
        session.commit()


def _pending_execution(
    session: Session,
    *,
    decision_id: uuid.UUID,
    client_order_id: str,
    broker_order_id: str,
) -> Execution:
    execution = Execution(
        id=uuid.uuid4(),
        trade_decision_id=decision_id,
        alpaca_account_label="paper",
        alpaca_order_id=broker_order_id,
        client_order_id=client_order_id,
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=1,
        filled_qty=0,
        status="accepted",
        raw_order={"id": broker_order_id},
    )
    session.add(execution)
    return execution


def _terminal_identity(
    execution: Execution,
    *,
    client_order_id: str,
    broker_order_id: str,
) -> DecisionSubmissionTerminalIdentity:
    return DecisionSubmissionTerminalIdentity(
        broker_order_id=broker_order_id,
        broker_client_order_id=client_order_id,
        execution_id=execution.id,
    )


def test_acquire_is_durable_idempotent_and_requires_decision_hash(
    tmp_path: Path,
) -> None:
    sessions, decision_id, client_order_id = _session_factory(tmp_path / "claim.db")
    token = uuid.uuid4()
    with sessions() as session:
        first = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="worker-a",
            options=DecisionSubmissionClaimAcquireOptions(claim_token=token),
        )
    with sessions() as session:
        repeated = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="worker-a",
            options=DecisionSubmissionClaimAcquireOptions(claim_token=token),
        )
    assert first.outcome == "acquired"
    assert repeated.outcome == "already_owned"
    assert repeated.claim == first.claim
    with sessions() as session:
        with pytest.raises(
            DecisionSubmissionClaimValidationError,
            match="client_order_id_must_equal_decision_hash",
        ):
            acquire_decision_submission_claim(
                session,
                decision_id=decision_id,
                client_order_id="random-id",
                claim_owner="worker-b",
            )


def test_concurrent_primary_acquire_allows_exactly_one_owner(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "primary-cas.db"
    )
    barrier = Barrier(2)

    def acquire(owner: str) -> str:
        with sessions() as session:
            barrier.wait(timeout=10)
            return acquire_decision_submission_claim(
                session,
                decision_id=decision_id,
                client_order_id=client_order_id,
                claim_owner=owner,
            ).outcome

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(acquire, ("worker-a", "worker-b")))
    assert sorted(outcomes) == ["acquired", "busy"]


def test_pre_broker_release_expires_claim_and_fences_old_owner(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(tmp_path / "release.db")
    with sessions() as session:
        first_handle = _acquire(session, decision_id, client_order_id)
    with sessions() as session:
        released = release_decision_submission_claim(
            session,
            handle=first_handle,
            reason="risk precheck changed",
        )
    assert released.state == "claimed"
    assert released.release_reason == "risk precheck changed"
    with sessions() as session:
        reacquired = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="worker-b",
        )
    assert reacquired.outcome == "acquired"
    assert reacquired.claim is not None
    assert reacquired.claim.handle.fencing_epoch == 2
    with sessions() as session:
        with pytest.raises(DecisionSubmissionFenceError):
            mark_decision_submission_broker_io_started(
                session,
                handle=first_handle,
            )


def test_takeover_rotates_reused_expired_claim_token(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "reused-expired-token.db"
    )
    reused_token = uuid.uuid4()
    with sessions() as session:
        first = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="worker-a",
            options=DecisionSubmissionClaimAcquireOptions(claim_token=reused_token),
        )
    assert first.claim is not None
    with sessions() as session:
        release_decision_submission_claim(
            session,
            handle=first.claim.handle,
            reason="retry with deterministic token",
        )
    with sessions() as session:
        takeover = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="worker-b",
            options=DecisionSubmissionClaimAcquireOptions(claim_token=reused_token),
        )

    assert takeover.outcome == "acquired"
    assert takeover.claim is not None
    assert takeover.claim.handle.fencing_epoch == 2
    assert takeover.claim.handle.claim_token != reused_token


def test_broker_io_boundary_rechecks_decision_and_execution(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(tmp_path / "boundary.db")
    with sessions() as session:
        handle = _acquire(session, decision_id, client_order_id)
    with sessions() as session:
        decision = session.get(TradeDecision, decision_id)
        assert decision is not None
        decision.status = "rejected"
        session.commit()
    with sessions() as session:
        with pytest.raises(
            DecisionSubmissionClaimValidationError,
            match="trade_decision_not_planned",
        ):
            mark_decision_submission_broker_io_started(session, handle=handle)
    with sessions() as session:
        decision = session.get(TradeDecision, decision_id)
        assert decision is not None
        decision.status = "planned"
        _pending_execution(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            broker_order_id="already-created",
        )
        session.commit()
    with sessions() as session:
        with pytest.raises(
            DecisionSubmissionClaimValidationError,
            match="execution_exists_at_broker_io_boundary",
        ):
            mark_decision_submission_broker_io_started(session, handle=handle)
    with sessions() as session:
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
        assert claim is not None
        assert claim.state == "claimed"


def test_recovery_lease_is_separate_and_only_one_reader_acquires(
    tmp_path: Path,
) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "recovery-cas.db"
    )
    primary_handle = _enter_broker_io(sessions, decision_id, client_order_id)
    _force_recovery_due(sessions, decision_id)
    barrier = Barrier(2)

    def acquire(owner: str) -> str:
        with sessions() as session:
            barrier.wait(timeout=10)
            return acquire_decision_submission_recovery_claim(
                session,
                decision_id=decision_id,
                recovery_owner=owner,
            ).outcome

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(acquire, ("reader-a", "reader-b")))
    assert sorted(outcomes) == ["acquired", "busy"]
    with sessions() as session:
        row = session.get(TradeDecisionSubmissionClaim, decision_id)
        assert row is not None
        assert row.state == "broker_io"
        assert row.claim_token == primary_handle.claim_token
        assert row.fencing_epoch == primary_handle.fencing_epoch
        assert row.claim_owner == primary_handle.claim_owner
        assert row.recovery_fencing_epoch == 1


def test_recovery_takeover_rotates_reused_expired_token(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "reused-recovery-token.db"
    )
    _enter_broker_io(sessions, decision_id, client_order_id)
    _force_recovery_due(sessions, decision_id)
    reused_token = uuid.uuid4()

    with sessions() as session:
        first = acquire_decision_submission_recovery_claim(
            session,
            decision_id=decision_id,
            recovery_owner="reader-a",
            recovery_token=reused_token,
        )
    assert first.outcome == "acquired"
    assert first.claim is not None
    assert first.claim.recovery_handle is not None
    assert first.claim.recovery_handle.recovery_token == reused_token
    assert first.claim.recovery_handle.recovery_fencing_epoch == 1

    with sessions() as session:
        row = session.get(TradeDecisionSubmissionClaim, decision_id)
        assert row is not None
        row.recovery_lease_expires_at = datetime(2000, 1, 1, tzinfo=timezone.utc)
        session.commit()

    with sessions() as session:
        takeover = acquire_decision_submission_recovery_claim(
            session,
            decision_id=decision_id,
            recovery_owner="reader-b",
            recovery_token=reused_token,
        )
    assert takeover.outcome == "acquired"
    assert takeover.claim is not None
    assert takeover.claim.recovery_handle is not None
    assert takeover.claim.recovery_handle.recovery_fencing_epoch == 2
    assert takeover.claim.recovery_handle.recovery_token != reused_token
    assert takeover.claim.recovery_handle.recovery_owner == "reader-b"


@pytest.mark.parametrize("outcome", ["not_found", "indeterminate"])
def test_negative_recovery_observation_stays_quarantined_and_fences_stale_reader(
    tmp_path: Path,
    outcome: RecoveryObservationOutcome,
) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / f"{outcome}.db"
    )
    _enter_broker_io(sessions, decision_id, client_order_id)
    _force_recovery_due(sessions, decision_id)
    with sessions() as session:
        acquired = acquire_decision_submission_recovery_claim(
            session,
            decision_id=decision_id,
            recovery_owner="reader-a",
        )
    assert acquired.claim is not None
    assert acquired.claim.recovery_handle is not None
    first_recovery = acquired.claim.recovery_handle
    with sessions() as session:
        observed = record_decision_submission_recovery_observation(
            session,
            handle=first_recovery,
            observation=DecisionSubmissionRecoveryObservation(
                checked_client_order_id=client_order_id,
                outcome=outcome,
                evidence="broker lookup returned no definitive order",
            ),
        )
    assert observed.state == "broker_io"
    assert observed.recovery_outcome == outcome
    assert observed.recovery_observation_epoch == 1
    with sessions() as session:
        retry = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="writer-b",
        )
    assert retry.outcome == "busy"
    _force_recovery_due(sessions, decision_id)
    with sessions() as session:
        second = acquire_decision_submission_recovery_claim(
            session,
            decision_id=decision_id,
            recovery_owner="reader-b",
        )
    assert second.claim is not None
    assert second.claim.recovery_handle is not None
    assert second.claim.recovery_handle.recovery_fencing_epoch == 2
    assert second.claim.recovery_observation_epoch == 1
    with sessions() as session:
        with pytest.raises(DecisionSubmissionFenceError):
            record_decision_submission_recovery_observation(
                session,
                handle=first_recovery,
                observation=DecisionSubmissionRecoveryObservation(
                    checked_client_order_id=client_order_id,
                    outcome="not_found",
                    evidence="stale reader must not write",
                ),
            )


def test_recovered_order_terminalizes_execution_and_claim_atomically(
    tmp_path: Path,
) -> None:
    sessions, decision_id, client_order_id = _session_factory(tmp_path / "recovered.db")
    _enter_broker_io(sessions, decision_id, client_order_id)
    _force_recovery_due(sessions, decision_id)
    with sessions() as session:
        acquired = acquire_decision_submission_recovery_claim(
            session,
            decision_id=decision_id,
            recovery_owner="reader-a",
        )
    assert acquired.claim is not None
    assert acquired.claim.recovery_handle is not None
    recovery_handle = acquired.claim.recovery_handle
    with sessions() as session:
        execution = _pending_execution(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            broker_order_id="broker-order-1",
        )
        execution_id = execution.id
        submitted = mark_decision_submission_recovered(
            session,
            handle=recovery_handle,
            terminal=_terminal_identity(
                execution,
                client_order_id=client_order_id,
                broker_order_id="broker-order-1",
            ),
            evidence="lookup returned the exact broker order",
        )
    assert submitted.state == "submitted"
    assert submitted.execution_id == execution_id
    assert submitted.recovery_outcome == "found"
    assert submitted.recovery_observation_epoch == 1
    assert submitted.recovery_handle is not None
    assert submitted.completed_at is not None
    assert submitted.recovery_handle.lease_expires_at <= submitted.completed_at
    with sessions() as session:
        assert session.get(Execution, execution_id) is not None


def test_primary_success_keeps_recovery_observation_empty(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "primary-success.db"
    )
    primary_handle = _enter_broker_io(sessions, decision_id, client_order_id)
    with sessions() as session:
        with pytest.raises(DecisionSubmissionFenceError):
            release_decision_submission_claim(
                session,
                handle=primary_handle,
                reason="broker I/O cannot be released",
            )
    with sessions() as session:
        execution = _pending_execution(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            broker_order_id="primary-order",
        )
        execution_id = execution.id
        submitted = mark_decision_submission_succeeded(
            session,
            handle=primary_handle,
            terminal=_terminal_identity(
                execution,
                client_order_id=client_order_id,
                broker_order_id="primary-order",
            ),
        )
    assert submitted.state == "submitted"
    assert submitted.execution_id == execution_id
    assert submitted.recovery_checked_at is None
    assert submitted.recovery_outcome is None
    assert submitted.recovery_evidence is None
    with sessions() as session:
        assert session.get(Execution, execution_id) is not None


def test_late_primary_response_terminalizes_after_not_found_observation(
    tmp_path: Path,
) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "late-primary.db"
    )
    primary_handle = _enter_broker_io(sessions, decision_id, client_order_id)
    _force_recovery_due(sessions, decision_id)
    with sessions() as session:
        recovery = acquire_decision_submission_recovery_claim(
            session,
            decision_id=decision_id,
            recovery_owner="reader-a",
        )
    assert recovery.claim is not None
    assert recovery.claim.recovery_handle is not None
    with sessions() as session:
        record_decision_submission_recovery_observation(
            session,
            handle=recovery.claim.recovery_handle,
            observation=DecisionSubmissionRecoveryObservation(
                checked_client_order_id=client_order_id,
                outcome="not_found",
                evidence="404 before late broker response",
            ),
        )
    with sessions() as session:
        execution = _pending_execution(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            broker_order_id="late-order",
        )
        submitted = mark_decision_submission_succeeded(
            session,
            handle=primary_handle,
            terminal=_terminal_identity(
                execution,
                client_order_id=client_order_id,
                broker_order_id="late-order",
            ),
        )
    assert submitted.state == "submitted"
    assert submitted.recovery_outcome == "not_found"
    assert submitted.broker_order_id == "late-order"


def test_fenced_terminalization_rolls_back_pending_execution(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "terminal-fence.db"
    )
    valid_handle = _enter_broker_io(sessions, decision_id, client_order_id)
    stale_handle = DecisionSubmissionClaimHandle(
        decision_id=valid_handle.decision_id,
        claim_token=uuid.uuid4(),
        fencing_epoch=valid_handle.fencing_epoch,
        account_label=valid_handle.account_label,
        client_order_id=valid_handle.client_order_id,
        claim_owner=valid_handle.claim_owner,
    )
    with sessions() as session:
        execution = _pending_execution(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            broker_order_id="must-rollback",
        )
        execution_id = execution.id
        with pytest.raises(DecisionSubmissionFenceError):
            mark_decision_submission_succeeded(
                session,
                handle=stale_handle,
                terminal=_terminal_identity(
                    execution,
                    client_order_id=client_order_id,
                    broker_order_id="must-rollback",
                ),
            )
    with sessions() as session:
        assert session.get(Execution, execution_id) is None
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
        assert claim is not None
        assert claim.state == "broker_io"
        assert claim.execution_id is None


def test_terminal_validation_failure_rolls_back_autoflushed_execution(
    tmp_path: Path,
) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "terminal-validation-rollback.db"
    )
    handle = _enter_broker_io(sessions, decision_id, client_order_id)
    execution_id = uuid.uuid4()
    with sessions() as session:
        execution = _pending_execution(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            broker_order_id="bad-identity",
        )
        execution.id = execution_id
        execution.alpaca_account_label = "wrong-account"
        with pytest.raises(
            DecisionSubmissionClaimValidationError,
            match="execution_submission_claim_identity_mismatch",
        ):
            mark_decision_submission_succeeded(
                session,
                handle=handle,
                terminal=DecisionSubmissionTerminalIdentity(
                    broker_order_id="bad-identity",
                    broker_client_order_id=client_order_id,
                    execution_id=execution_id,
                ),
            )
        session.commit()
    with sessions() as session:
        assert session.get(Execution, execution_id) is None
        claim = session.get(TradeDecisionSubmissionClaim, decision_id)
        assert claim is not None
        assert claim.state == "broker_io"
        assert claim.execution_id is None


def test_existing_execution_is_terminal_defense_in_depth(tmp_path: Path) -> None:
    sessions, decision_id, client_order_id = _session_factory(
        tmp_path / "existing-execution.db"
    )
    with sessions() as session:
        _pending_execution(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            broker_order_id="existing-order",
        )
        session.commit()
    with sessions() as session:
        result = acquire_decision_submission_claim(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner="worker-a",
        )
    assert result.outcome == "execution_exists"
    assert result.claim is None


def test_claim_relationships_preserve_restrict_audit_semantics() -> None:
    relationship = TradeDecision.submission_claim.property
    assert "delete" not in relationship.cascade
    assert "delete-orphan" not in relationship.cascade
    assert relationship.passive_deletes is True
    decision_fk = next(
        iter(TradeDecisionSubmissionClaim.__table__.c.trade_decision_id.foreign_keys)
    )
    execution_fk = next(
        iter(TradeDecisionSubmissionClaim.__table__.c.execution_id.foreign_keys)
    )
    assert decision_fk.ondelete == "RESTRICT"
    assert execution_fk.ondelete == "RESTRICT"
