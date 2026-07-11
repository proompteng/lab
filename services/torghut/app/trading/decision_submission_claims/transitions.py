"""Fenced state transitions for durable submission claims."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .persistence import (
    close_read_transaction,
    load_snapshot,
    primary_handle_matches,
    recovery_handle_matches,
    transition_primary,
    transition_recovery,
)
from .types import (
    CLAIM_DEFAULT_LEASE_SECONDS,
    CLAIM_DEFAULT_RECOVERY_SECONDS,
    CLAIM_MAX_LEASE_SECONDS,
    CLAIM_MAX_RECOVERY_SECONDS,
    CLAIM_MIN_LEASE_SECONDS,
    CLAIM_MIN_RECOVERY_SECONDS,
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimError,
    DecisionSubmissionClaimSnapshot,
    DecisionSubmissionClaimValidationError,
    DecisionSubmissionFenceError,
    DecisionSubmissionBoundaryResult,
    DecisionSubmissionRecoveryHandle,
    DecisionSubmissionRecoveryObservation,
    DecisionSubmissionTerminalIdentity,
)
from .validation import (
    NormalizedTerminalIdentity,
    as_uuid,
    bounded_seconds,
    database_now,
    normalized_terminal_identity,
    required_text,
    validate_broker_io_boundary,
)


def renew_decision_submission_claim(
    session: Session,
    *,
    handle: DecisionSubmissionClaimHandle,
    lease_seconds: int = CLAIM_DEFAULT_LEASE_SECONDS,
) -> DecisionSubmissionClaimSnapshot:
    """Extend a live pre-broker lease without changing its fencing epoch."""

    bounded_lease = bounded_seconds(
        lease_seconds,
        minimum=CLAIM_MIN_LEASE_SECONDS,
        maximum=CLAIM_MAX_LEASE_SECONDS,
        field="lease_seconds",
    )
    now = database_now(session)
    return transition_primary(
        session,
        handle=handle,
        expected_state="claimed",
        values={"lease_expires_at": now + timedelta(seconds=bounded_lease)},
        require_unexpired_lease=True,
    )


def mark_decision_submission_broker_io_started(
    session: Session,
    *,
    handle: DecisionSubmissionClaimHandle,
    recovery_seconds: int = CLAIM_DEFAULT_RECOVERY_SECONDS,
) -> DecisionSubmissionBoundaryResult:
    """Commit claim ambiguity truth without granting broker authorization."""

    try:
        bounded_recovery = bounded_seconds(
            recovery_seconds,
            minimum=CLAIM_MIN_RECOVERY_SECONDS,
            maximum=CLAIM_MAX_RECOVERY_SECONDS,
            field="recovery_seconds",
        )
        validate_broker_io_boundary(session, handle=handle)
        now = database_now(session)
        claim = transition_primary(
            session,
            handle=handle,
            expected_state="claimed",
            values={
                "state": "broker_io",
                "broker_io_started_at": now,
                "recovery_after": now + timedelta(seconds=bounded_recovery),
            },
            require_unexpired_lease=True,
        )
        return DecisionSubmissionBoundaryResult(
            outcome="transitioned",
            claim=claim,
        )
    except DecisionSubmissionFenceError:
        snapshot = get_decision_submission_claim(session, handle.decision_id)
        if (
            primary_handle_matches(snapshot, handle)
            and snapshot is not None
            and snapshot.state in {"broker_io", "submitted"}
        ):
            outcome = (
                "already_started" if snapshot.state == "broker_io" else "submitted"
            )
            return DecisionSubmissionBoundaryResult(
                outcome=outcome,
                claim=snapshot,
            )
        raise
    except (DecisionSubmissionClaimError, SQLAlchemyError):
        session.rollback()
        raise


def mark_decision_submission_succeeded(
    session: Session,
    *,
    handle: DecisionSubmissionClaimHandle,
    terminal: DecisionSubmissionTerminalIdentity,
) -> DecisionSubmissionClaimSnapshot:
    """Atomically persist a matching Execution and terminal claim truth."""

    normalized_terminal: NormalizedTerminalIdentity | None = None
    try:
        normalized_terminal = normalized_terminal_identity(
            session,
            handle=handle,
            terminal=terminal,
        )
        now = database_now(session)
        return transition_primary(
            session,
            handle=handle,
            expected_state="broker_io",
            values=_primary_terminal_values(
                normalized_terminal,
                completed_at=now,
            ),
            require_unexpired_lease=False,
        )
    except DecisionSubmissionFenceError:
        if normalized_terminal is None:
            session.rollback()
            raise
        snapshot = get_decision_submission_claim(session, handle.decision_id)
        if primary_handle_matches(snapshot, handle) and _terminal_matches(
            snapshot, normalized_terminal
        ):
            assert snapshot is not None
            return snapshot
        raise
    except (DecisionSubmissionClaimError, SQLAlchemyError):
        session.rollback()
        raise


def mark_decision_submission_recovered(
    session: Session,
    *,
    handle: DecisionSubmissionRecoveryHandle,
    terminal: DecisionSubmissionTerminalIdentity,
    evidence: str,
) -> DecisionSubmissionClaimSnapshot:
    """Atomically persist recovered Execution and terminal claim truth."""

    normalized_terminal: NormalizedTerminalIdentity | None = None
    try:
        normalized_evidence = required_text(
            evidence, field="recovery_evidence", maximum=4096
        )
        normalized_terminal = normalized_terminal_identity(
            session,
            handle=handle,
            terminal=terminal,
        )
        now = database_now(session)
        return transition_recovery(
            session,
            handle=handle,
            values=_recovered_terminal_values(
                normalized_terminal,
                completed_at=now,
                evidence=normalized_evidence,
                observation_epoch=handle.recovery_fencing_epoch,
            ),
        )
    except DecisionSubmissionFenceError:
        if normalized_terminal is None:
            session.rollback()
            raise
        snapshot = get_decision_submission_claim(session, handle.decision_id)
        if (
            recovery_handle_matches(snapshot, handle)
            and snapshot is not None
            and _terminal_matches(snapshot, normalized_terminal)
        ):
            return snapshot
        raise
    except (DecisionSubmissionClaimError, SQLAlchemyError):
        session.rollback()
        raise


def _primary_terminal_values(
    terminal: NormalizedTerminalIdentity,
    *,
    completed_at: datetime,
) -> dict[str, object]:
    broker_order_id, broker_client_order_id, execution_id = terminal
    return {
        "state": "submitted",
        "broker_order_id": broker_order_id,
        "broker_client_order_id": broker_client_order_id,
        "execution_id": execution_id,
        "completed_at": completed_at,
    }


def _recovered_terminal_values(
    terminal: NormalizedTerminalIdentity,
    *,
    completed_at: datetime,
    evidence: str,
    observation_epoch: int,
) -> dict[str, object]:
    values = _primary_terminal_values(terminal, completed_at=completed_at)
    values.update(
        {
            "recovery_checked_at": completed_at,
            "recovery_observation_epoch": observation_epoch,
            "recovery_outcome": "found",
            "recovery_evidence": evidence,
            "recovery_lease_expires_at": completed_at,
        }
    )
    return values


def _terminal_matches(
    snapshot: DecisionSubmissionClaimSnapshot | None,
    terminal: NormalizedTerminalIdentity,
) -> bool:
    broker_order_id, broker_client_order_id, execution_id = terminal
    return (
        snapshot is not None
        and snapshot.state == "submitted"
        and snapshot.broker_order_id == broker_order_id
        and snapshot.broker_client_order_id == broker_client_order_id
        and snapshot.execution_id == execution_id
    )


def record_decision_submission_recovery_observation(
    session: Session,
    *,
    handle: DecisionSubmissionRecoveryHandle,
    observation: DecisionSubmissionRecoveryObservation,
    retry_seconds: int = CLAIM_DEFAULT_RECOVERY_SECONDS,
) -> DecisionSubmissionClaimSnapshot:
    """Record an absent/unknown read while preserving broker-I/O quarantine."""

    normalized_client_order_id = required_text(
        observation.checked_client_order_id,
        field="checked_client_order_id",
        maximum=128,
    )
    if normalized_client_order_id != handle.client_order_id:
        raise DecisionSubmissionClaimValidationError(
            "recovery_client_order_id_mismatch"
        )
    if observation.outcome not in {"not_found", "indeterminate"}:
        raise DecisionSubmissionClaimValidationError(
            "recovery_observation_outcome_invalid"
        )
    normalized_evidence = required_text(
        observation.evidence, field="recovery_evidence", maximum=4096
    )
    bounded_retry = bounded_seconds(
        retry_seconds,
        minimum=CLAIM_MIN_RECOVERY_SECONDS,
        maximum=CLAIM_MAX_RECOVERY_SECONDS,
        field="retry_seconds",
    )
    now = database_now(session)
    return transition_recovery(
        session,
        handle=handle,
        values={
            "recovery_checked_at": now,
            "recovery_observation_epoch": handle.recovery_fencing_epoch,
            "recovery_outcome": observation.outcome,
            "recovery_evidence": normalized_evidence,
            "recovery_after": now + timedelta(seconds=bounded_retry),
            "recovery_lease_expires_at": now,
        },
    )


def release_decision_submission_claim(
    session: Session,
    *,
    handle: DecisionSubmissionClaimHandle,
    reason: str,
) -> DecisionSubmissionClaimSnapshot:
    """Expire only a live pre-broker claim while retaining its audit row."""

    normalized_reason = required_text(reason, field="release_reason", maximum=1024)
    now = database_now(session)
    try:
        return transition_primary(
            session,
            handle=handle,
            expected_state="claimed",
            values={
                "lease_expires_at": now,
                "released_at": now,
                "release_reason": normalized_reason,
            },
            require_unexpired_lease=True,
        )
    except DecisionSubmissionFenceError:
        snapshot = get_decision_submission_claim(session, handle.decision_id)
        if (
            primary_handle_matches(snapshot, handle)
            and snapshot is not None
            and snapshot.state == "claimed"
            and snapshot.release_reason == normalized_reason
        ):
            return snapshot
        raise


def get_decision_submission_claim(
    session: Session, decision_id: uuid.UUID | str
) -> DecisionSubmissionClaimSnapshot | None:
    """Read latest durable claim state without changing ownership."""

    normalized_id = as_uuid(decision_id, field="decision_id")
    snapshot = load_snapshot(session, normalized_id)
    close_read_transaction(session)
    return snapshot
