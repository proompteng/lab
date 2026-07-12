"""Persistence primitives and compare-and-set fences for submission claims."""

from __future__ import annotations

from datetime import datetime
from typing import cast

from sqlalchemy import update
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ...models import TradeDecisionSubmissionClaim
from .types import (
    ClaimState,
    DecisionSubmissionClaimError,
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimLifecycle,
    DecisionSubmissionClaimSnapshot,
    DecisionSubmissionFenceError,
    DecisionSubmissionRecoveryAudit,
    DecisionSubmissionRecoveryHandle,
    DecisionSubmissionTerminalAudit,
)
from .validation import as_utc_datetime, database_now


def snapshot_from_model(
    row: TradeDecisionSubmissionClaim,
) -> DecisionSubmissionClaimSnapshot:
    recovery_handle = _recovery_handle_from_model(row)
    return DecisionSubmissionClaimSnapshot(
        handle=DecisionSubmissionClaimHandle(
            decision_id=row.trade_decision_id,
            claim_token=row.claim_token,
            fencing_epoch=int(row.fencing_epoch),
            account_label=row.account_label,
            client_order_id=row.client_order_id,
            claim_owner=row.claim_owner,
        ),
        recovery_handle=recovery_handle,
        lifecycle=DecisionSubmissionClaimLifecycle(
            state=cast(ClaimState, row.state),
            claimed_at=as_utc_datetime(row.claimed_at),
            lease_expires_at=as_utc_datetime(row.lease_expires_at),
            broker_io_started_at=_optional_datetime(row.broker_io_started_at),
            recovery_after=_optional_datetime(row.recovery_after),
            released_at=_optional_datetime(row.released_at),
            release_reason=row.release_reason,
        ),
        recovery_audit=DecisionSubmissionRecoveryAudit(
            checked_at=_optional_datetime(row.recovery_checked_at),
            observation_epoch=row.recovery_observation_epoch,
            outcome=row.recovery_outcome,
            evidence=row.recovery_evidence,
        ),
        terminal=DecisionSubmissionTerminalAudit(
            broker_order_id=row.broker_order_id,
            broker_client_order_id=row.broker_client_order_id,
            execution_id=row.execution_id,
            completed_at=_optional_datetime(row.completed_at),
            receipt_event_id=row.terminal_receipt_event_id,
        ),
    )


def _optional_datetime(value: object | None) -> datetime | None:
    return as_utc_datetime(value) if value is not None else None


def _recovery_handle_from_model(
    row: TradeDecisionSubmissionClaim,
) -> DecisionSubmissionRecoveryHandle | None:
    if row.recovery_token is None:
        return None
    if (
        row.recovery_owner is None
        or row.recovery_lease_expires_at is None
        or int(row.recovery_fencing_epoch) <= 0
    ):
        raise DecisionSubmissionClaimError("recovery_lease_metadata_invalid")
    return DecisionSubmissionRecoveryHandle(
        decision_id=row.trade_decision_id,
        recovery_token=row.recovery_token,
        recovery_fencing_epoch=int(row.recovery_fencing_epoch),
        account_label=row.account_label,
        client_order_id=row.client_order_id,
        recovery_owner=row.recovery_owner,
        lease_expires_at=as_utc_datetime(row.recovery_lease_expires_at),
    )


def load_snapshot(
    session: Session, decision_id: object
) -> DecisionSubmissionClaimSnapshot | None:
    row = session.get(
        TradeDecisionSubmissionClaim,
        decision_id,
        populate_existing=True,
    )
    return snapshot_from_model(row) if row is not None else None


def primary_handle_matches(
    snapshot: DecisionSubmissionClaimSnapshot | None,
    handle: DecisionSubmissionClaimHandle,
) -> bool:
    if snapshot is None:
        return False
    observed = snapshot.handle
    return (
        observed.decision_id == handle.decision_id
        and observed.claim_token == handle.claim_token
        and observed.fencing_epoch == handle.fencing_epoch
        and observed.account_label == handle.account_label
        and observed.client_order_id == handle.client_order_id
        and observed.claim_owner == handle.claim_owner
    )


def recovery_handle_matches(
    snapshot: DecisionSubmissionClaimSnapshot | None,
    handle: DecisionSubmissionRecoveryHandle,
) -> bool:
    if snapshot is None or snapshot.recovery_handle is None:
        return False
    observed = snapshot.recovery_handle
    return (
        observed.decision_id == handle.decision_id
        and observed.recovery_token == handle.recovery_token
        and observed.recovery_fencing_epoch == handle.recovery_fencing_epoch
        and observed.account_label == handle.account_label
        and observed.client_order_id == handle.client_order_id
        and observed.recovery_owner == handle.recovery_owner
    )


def close_read_transaction(session: Session) -> None:
    session.rollback()


def commit_or_rollback(session: Session) -> None:
    try:
        session.commit()
    except SQLAlchemyError:
        session.rollback()
        raise


def insert_claim_if_absent(session: Session, values: dict[str, object]) -> bool:
    dialect_name = session.get_bind().dialect.name
    if dialect_name == "postgresql":
        statement = (
            postgresql_insert(TradeDecisionSubmissionClaim)
            .values(**values)
            .on_conflict_do_nothing()
            .returning(TradeDecisionSubmissionClaim.trade_decision_id)
        )
    elif dialect_name == "sqlite":
        statement = (
            sqlite_insert(TradeDecisionSubmissionClaim)
            .values(**values)
            .on_conflict_do_nothing()
            .returning(TradeDecisionSubmissionClaim.trade_decision_id)
        )
    else:
        raise DecisionSubmissionClaimError(
            f"decision_submission_claim_dialect_unsupported:{dialect_name}"
        )
    inserted_id = session.execute(statement).scalar_one_or_none()
    return inserted_id is not None


def transition_primary(
    session: Session,
    *,
    handle: DecisionSubmissionClaimHandle,
    expected_state: str,
    values: dict[str, object],
    require_unexpired_lease: bool,
) -> DecisionSubmissionClaimSnapshot:
    now = database_now(session)
    predicates = _primary_predicates(handle, expected_state)
    if require_unexpired_lease:
        predicates.append(TradeDecisionSubmissionClaim.lease_expires_at > now)
    return _commit_transition(
        session,
        decision_id=handle.decision_id,
        fencing_error=(
            "decision_submission_claim_fenced:"
            f"{handle.decision_id}:{handle.fencing_epoch}:{expected_state}"
        ),
        predicates=predicates,
        values={**values, "updated_at": now},
    )


def transition_primary_uncommitted(
    session: Session,
    *,
    handle: DecisionSubmissionClaimHandle,
    expected_state: str,
    values: dict[str, object],
    require_unexpired_lease: bool,
) -> DecisionSubmissionClaimSnapshot:
    """Apply a fenced primary CAS without committing the caller's transaction."""

    now = database_now(session)
    predicates = _primary_predicates(handle, expected_state)
    if require_unexpired_lease:
        predicates.append(TradeDecisionSubmissionClaim.lease_expires_at > now)
    return _transition_uncommitted(
        session,
        decision_id=handle.decision_id,
        fencing_error=(
            "decision_submission_claim_fenced:"
            f"{handle.decision_id}:{handle.fencing_epoch}:{expected_state}"
        ),
        predicates=predicates,
        values={**values, "updated_at": now},
    )


def _primary_predicates(
    handle: DecisionSubmissionClaimHandle, expected_state: str
) -> list[ColumnElement[bool]]:
    return [
        TradeDecisionSubmissionClaim.trade_decision_id == handle.decision_id,
        TradeDecisionSubmissionClaim.claim_token == handle.claim_token,
        TradeDecisionSubmissionClaim.fencing_epoch == handle.fencing_epoch,
        TradeDecisionSubmissionClaim.account_label == handle.account_label,
        TradeDecisionSubmissionClaim.client_order_id == handle.client_order_id,
        TradeDecisionSubmissionClaim.claim_owner == handle.claim_owner,
        TradeDecisionSubmissionClaim.state == expected_state,
    ]


def transition_recovery(
    session: Session,
    *,
    handle: DecisionSubmissionRecoveryHandle,
    values: dict[str, object],
) -> DecisionSubmissionClaimSnapshot:
    now = database_now(session)
    predicates = [
        TradeDecisionSubmissionClaim.trade_decision_id == handle.decision_id,
        TradeDecisionSubmissionClaim.account_label == handle.account_label,
        TradeDecisionSubmissionClaim.client_order_id == handle.client_order_id,
        TradeDecisionSubmissionClaim.state == "broker_io",
        TradeDecisionSubmissionClaim.recovery_token == handle.recovery_token,
        TradeDecisionSubmissionClaim.recovery_fencing_epoch
        == handle.recovery_fencing_epoch,
        TradeDecisionSubmissionClaim.recovery_owner == handle.recovery_owner,
        TradeDecisionSubmissionClaim.recovery_lease_expires_at.is_not(None),
        TradeDecisionSubmissionClaim.recovery_lease_expires_at > now,
    ]
    return _commit_transition(
        session,
        decision_id=handle.decision_id,
        fencing_error=(
            "decision_submission_recovery_fenced:"
            f"{handle.decision_id}:{handle.recovery_fencing_epoch}"
        ),
        predicates=predicates,
        values={**values, "updated_at": now},
    )


def _commit_transition(
    session: Session,
    *,
    decision_id: object,
    fencing_error: str,
    predicates: list[ColumnElement[bool]],
    values: dict[str, object],
) -> DecisionSubmissionClaimSnapshot:
    try:
        _transition_uncommitted(
            session,
            decision_id=decision_id,
            fencing_error=fencing_error,
            predicates=predicates,
            values=values,
        )
        commit_or_rollback(session)
    except (DecisionSubmissionClaimError, SQLAlchemyError):
        session.rollback()
        raise
    snapshot = load_snapshot(session, decision_id)
    if snapshot is None:  # pragma: no cover - committed row must be readable
        close_read_transaction(session)
        raise DecisionSubmissionClaimError("transitioned_claim_not_found")
    close_read_transaction(session)
    return snapshot


def _transition_uncommitted(
    session: Session,
    *,
    decision_id: object,
    fencing_error: str,
    predicates: list[ColumnElement[bool]],
    values: dict[str, object],
) -> DecisionSubmissionClaimSnapshot:
    transitioned_id = session.execute(
        update(TradeDecisionSubmissionClaim)
        .where(*predicates)
        .values(**values)
        .returning(TradeDecisionSubmissionClaim.trade_decision_id)
    ).scalar_one_or_none()
    if transitioned_id is None:
        raise DecisionSubmissionFenceError(fencing_error)
    snapshot = load_snapshot(session, decision_id)
    if snapshot is None:  # pragma: no cover - transitioned row must be readable
        raise DecisionSubmissionClaimError("transitioned_claim_not_found")
    return snapshot
