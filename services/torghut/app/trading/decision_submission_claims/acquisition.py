"""Atomic acquisition of primary and read-only recovery claims."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from sqlalchemy import or_, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ...models import TradeDecision, TradeDecisionSubmissionClaim
from .persistence import (
    close_read_transaction,
    commit_or_rollback,
    insert_claim_if_absent,
    load_snapshot,
)
from .types import (
    CLAIM_DEFAULT_LEASE_SECONDS,
    CLAIM_MAX_LEASE_SECONDS,
    CLAIM_MIN_LEASE_SECONDS,
    ClaimAcquisitionOutcome,
    DecisionSubmissionClaimAcquireOptions,
    DecisionSubmissionClaimError,
    DecisionSubmissionClaimResult,
    DecisionSubmissionClaimSnapshot,
    DecisionSubmissionClaimValidationError,
    DecisionSubmissionRecoveryClaimResult,
    RecoveryClaimAcquisitionOutcome,
)
from .validation import (
    as_uuid,
    bounded_seconds,
    database_now,
    existing_execution_id,
    required_text,
    validate_decision_identity,
)


@dataclass(frozen=True, slots=True)
class _PrimaryRequest:
    decision_id: uuid.UUID
    client_order_id: str
    owner: str
    token: uuid.UUID
    lease_seconds: int


@dataclass(frozen=True, slots=True)
class _RecoveryLeaseRequest:
    decision_id: uuid.UUID
    owner: str
    token: uuid.UUID
    lease_seconds: int
    now: datetime


def acquire_decision_submission_claim(
    session: Session,
    *,
    decision_id: uuid.UUID | str,
    client_order_id: str,
    claim_owner: str,
    options: DecisionSubmissionClaimAcquireOptions | None = None,
) -> DecisionSubmissionClaimResult:
    """Acquire and commit ownership before the first broker write."""

    try:
        request = _normalize_primary_request(
            decision_id=decision_id,
            client_order_id=client_order_id,
            claim_owner=claim_owner,
            options=options,
        )
        return _acquire_primary(session, request)
    except (DecisionSubmissionClaimError, SQLAlchemyError):
        session.rollback()
        raise


def _acquire_primary(
    session: Session,
    request: _PrimaryRequest,
) -> DecisionSubmissionClaimResult:
    decision = validate_decision_identity(
        session,
        decision_id=request.decision_id,
        client_order_id=request.client_order_id,
    )
    now = database_now(session)
    current = load_snapshot(session, request.decision_id)
    existing_outcome = _existing_claim_outcome(
        session,
        current=current,
        request=request,
        decision=decision,
        now=now,
    )
    if existing_outcome is not None:
        return existing_outcome
    preclaim_result = _preclaim_result(session, decision, request, current)
    if preclaim_result is not None:
        return preclaim_result
    lease_expires_at = now + timedelta(seconds=request.lease_seconds)
    if _insert_primary(session, request, decision, now, lease_expires_at):
        return _committed_result(session, request.decision_id, "acquired")
    if current is not None and _take_over_expired_primary(
        session,
        request,
        current,
        now,
        lease_expires_at,
    ):
        return _committed_result(session, request.decision_id, "acquired")
    return _contention_result(session, request, now)


def _normalize_primary_request(
    *,
    decision_id: uuid.UUID | str,
    client_order_id: str,
    claim_owner: str,
    options: DecisionSubmissionClaimAcquireOptions | None,
) -> _PrimaryRequest:
    configured = options or DecisionSubmissionClaimAcquireOptions()
    return _PrimaryRequest(
        decision_id=as_uuid(decision_id, field="decision_id"),
        client_order_id=required_text(
            client_order_id, field="client_order_id", maximum=128
        ),
        owner=required_text(claim_owner, field="claim_owner", maximum=128),
        token=(
            as_uuid(configured.claim_token, field="claim_token")
            if configured.claim_token is not None
            else uuid.uuid4()
        ),
        lease_seconds=bounded_seconds(
            configured.lease_seconds,
            minimum=CLAIM_MIN_LEASE_SECONDS,
            maximum=CLAIM_MAX_LEASE_SECONDS,
            field="lease_seconds",
        ),
    )


def _existing_claim_outcome(
    session: Session,
    *,
    current: DecisionSubmissionClaimSnapshot | None,
    request: _PrimaryRequest,
    decision: TradeDecision,
    now: datetime,
) -> DecisionSubmissionClaimResult | None:
    if current is None:
        return None
    if (
        current.handle.account_label != decision.alpaca_account_label
        or current.handle.client_order_id != request.client_order_id
    ):
        session.rollback()
        raise DecisionSubmissionClaimValidationError(
            "submission_claim_identity_mismatch"
        )
    if current.state in {"submitted", "rejected"}:
        terminal_outcome: ClaimAcquisitionOutcome = (
            "submitted" if current.state == "submitted" else "rejected"
        )
        return _read_result(session, terminal_outcome, current)
    if current.state == "broker_io":
        outcome: ClaimAcquisitionOutcome = (
            "recovery_required"
            if current.recovery_after is not None and current.recovery_after <= now
            else "busy"
        )
        return _read_result(session, outcome, current)
    same_active_owner = (
        current.handle.claim_token == request.token
        and current.handle.claim_owner == request.owner
        and current.lease_expires_at > now
    )
    return (
        _read_result(session, "already_owned", current) if same_active_owner else None
    )


def _preclaim_result(
    session: Session,
    decision: TradeDecision,
    request: _PrimaryRequest,
    current: DecisionSubmissionClaimSnapshot | None,
) -> DecisionSubmissionClaimResult | None:
    if (
        existing_execution_id(
            session,
            decision=decision,
            client_order_id=request.client_order_id,
        )
        is not None
    ):
        return _read_result(session, "execution_exists", current)
    if str(decision.status or "").strip().lower() != "planned":
        return _read_result(session, "not_claimable", current)
    return None


def _insert_primary(
    session: Session,
    request: _PrimaryRequest,
    decision: TradeDecision,
    now: datetime,
    lease_expires_at: datetime,
) -> bool:
    return insert_claim_if_absent(
        session,
        {
            "trade_decision_id": request.decision_id,
            "account_label": decision.alpaca_account_label,
            "client_order_id": request.client_order_id,
            "claim_token": request.token,
            "fencing_epoch": 1,
            "state": "claimed",
            "claim_owner": request.owner,
            "claimed_at": now,
            "lease_expires_at": lease_expires_at,
            "created_at": now,
            "updated_at": now,
        },
    )


def _take_over_expired_primary(
    session: Session,
    request: _PrimaryRequest,
    current: DecisionSubmissionClaimSnapshot,
    now: datetime,
    lease_expires_at: datetime,
) -> bool:
    takeover_token = (
        request.token if request.token != current.handle.claim_token else uuid.uuid4()
    )
    acquired_id = session.execute(
        update(TradeDecisionSubmissionClaim)
        .where(
            TradeDecisionSubmissionClaim.trade_decision_id == request.decision_id,
            TradeDecisionSubmissionClaim.account_label == current.handle.account_label,
            TradeDecisionSubmissionClaim.client_order_id == request.client_order_id,
            TradeDecisionSubmissionClaim.state == "claimed",
            TradeDecisionSubmissionClaim.claim_token == current.handle.claim_token,
            TradeDecisionSubmissionClaim.fencing_epoch == current.handle.fencing_epoch,
            TradeDecisionSubmissionClaim.broker_io_started_at.is_(None),
            TradeDecisionSubmissionClaim.lease_expires_at <= now,
        )
        .values(
            claim_token=takeover_token,
            fencing_epoch=TradeDecisionSubmissionClaim.fencing_epoch + 1,
            claim_owner=request.owner,
            claimed_at=now,
            lease_expires_at=lease_expires_at,
            released_at=None,
            release_reason=None,
            updated_at=now,
        )
        .returning(TradeDecisionSubmissionClaim.trade_decision_id)
    ).scalar_one_or_none()
    return acquired_id is not None


def _contention_result(
    session: Session, request: _PrimaryRequest, now: datetime
) -> DecisionSubmissionClaimResult:
    snapshot = load_snapshot(session, request.decision_id)
    if snapshot is None:
        close_read_transaction(session)
        raise DecisionSubmissionClaimError("claim_identity_conflict")
    if snapshot.state in {"submitted", "rejected"}:
        outcome: ClaimAcquisitionOutcome = (
            "submitted" if snapshot.state == "submitted" else "rejected"
        )
    elif snapshot.state == "broker_io":
        outcome = (
            "recovery_required"
            if snapshot.recovery_after is not None and snapshot.recovery_after <= now
            else "busy"
        )
    elif (
        snapshot.handle.claim_token == request.token
        and snapshot.handle.claim_owner == request.owner
        and snapshot.lease_expires_at > now
    ):
        outcome = "already_owned"
    else:
        outcome = "busy"
    return _read_result(session, outcome, snapshot)


def _read_result(
    session: Session,
    outcome: ClaimAcquisitionOutcome,
    snapshot: DecisionSubmissionClaimSnapshot | None,
) -> DecisionSubmissionClaimResult:
    result = DecisionSubmissionClaimResult(outcome, snapshot)
    close_read_transaction(session)
    return result


def _committed_result(
    session: Session,
    decision_id: uuid.UUID,
    outcome: ClaimAcquisitionOutcome,
) -> DecisionSubmissionClaimResult:
    commit_or_rollback(session)
    snapshot = load_snapshot(session, decision_id)
    if snapshot is None:  # pragma: no cover - committed row must be readable
        close_read_transaction(session)
        raise DecisionSubmissionClaimError("committed_claim_not_found")
    return _read_result(session, outcome, snapshot)


def acquire_decision_submission_recovery_claim(
    session: Session,
    *,
    decision_id: uuid.UUID | str,
    recovery_owner: str,
    recovery_token: uuid.UUID | str | None = None,
    lease_seconds: int = CLAIM_DEFAULT_LEASE_SECONDS,
) -> DecisionSubmissionRecoveryClaimResult:
    """Lease one read-only reconciliation without changing primary ownership."""

    try:
        return _acquire_recovery(
            session,
            decision_id=decision_id,
            recovery_owner=recovery_owner,
            recovery_token=recovery_token,
            lease_seconds=lease_seconds,
        )
    except (DecisionSubmissionClaimError, SQLAlchemyError):
        session.rollback()
        raise


def _acquire_recovery(
    session: Session,
    *,
    decision_id: uuid.UUID | str,
    recovery_owner: str,
    recovery_token: uuid.UUID | str | None,
    lease_seconds: int,
) -> DecisionSubmissionRecoveryClaimResult:
    normalized_id = as_uuid(decision_id, field="decision_id")
    owner = required_text(recovery_owner, field="recovery_owner", maximum=128)
    token = (
        as_uuid(recovery_token, field="recovery_token")
        if recovery_token is not None
        else uuid.uuid4()
    )
    bounded_lease = bounded_seconds(
        lease_seconds,
        minimum=CLAIM_MIN_LEASE_SECONDS,
        maximum=CLAIM_MAX_LEASE_SECONDS,
        field="lease_seconds",
    )
    now = database_now(session)
    request = _RecoveryLeaseRequest(
        decision_id=normalized_id,
        owner=owner,
        token=token,
        lease_seconds=bounded_lease,
        now=now,
    )
    acquired = _lease_recovery(session, request)
    if acquired:
        commit_or_rollback(session)
        return _recovery_result(session, normalized_id, "acquired")
    return _recovery_contention_result(session, normalized_id, owner, token, now)


def _lease_recovery(
    session: Session,
    request: _RecoveryLeaseRequest,
) -> bool:
    current = load_snapshot(session, request.decision_id)
    if current is None:
        return False
    current_handle = current.recovery_handle
    current_token = (
        current_handle.recovery_token if current_handle is not None else None
    )
    current_epoch = (
        current_handle.recovery_fencing_epoch if current_handle is not None else 0
    )
    takeover_token = request.token if request.token != current_token else uuid.uuid4()
    token_fence = (
        TradeDecisionSubmissionClaim.recovery_token.is_(None)
        if current_token is None
        else TradeDecisionSubmissionClaim.recovery_token == current_token
    )
    acquired_id = session.execute(
        update(TradeDecisionSubmissionClaim)
        .where(
            TradeDecisionSubmissionClaim.trade_decision_id == request.decision_id,
            TradeDecisionSubmissionClaim.state == "broker_io",
            token_fence,
            TradeDecisionSubmissionClaim.recovery_fencing_epoch == current_epoch,
            TradeDecisionSubmissionClaim.recovery_after.is_not(None),
            TradeDecisionSubmissionClaim.recovery_after <= request.now,
            or_(
                TradeDecisionSubmissionClaim.recovery_lease_expires_at.is_(None),
                TradeDecisionSubmissionClaim.recovery_lease_expires_at <= request.now,
            ),
        )
        .values(
            recovery_token=takeover_token,
            recovery_fencing_epoch=(
                TradeDecisionSubmissionClaim.recovery_fencing_epoch + 1
            ),
            recovery_owner=request.owner,
            recovery_lease_started_at=request.now,
            recovery_lease_expires_at=request.now
            + timedelta(seconds=request.lease_seconds),
            updated_at=request.now,
        )
        .returning(TradeDecisionSubmissionClaim.trade_decision_id)
    ).scalar_one_or_none()
    return acquired_id is not None


def _recovery_contention_result(
    session: Session,
    decision_id: uuid.UUID,
    owner: str,
    token: uuid.UUID,
    now: datetime,
) -> DecisionSubmissionRecoveryClaimResult:
    snapshot = load_snapshot(session, decision_id)
    if snapshot is None or snapshot.state != "broker_io":
        outcome: RecoveryClaimAcquisitionOutcome = "not_required"
    elif snapshot.recovery_after is None or snapshot.recovery_after > now:
        outcome = "not_ready"
    elif (
        snapshot.recovery_handle is not None
        and snapshot.recovery_handle.recovery_token == token
        and snapshot.recovery_handle.recovery_owner == owner
        and snapshot.recovery_handle.lease_expires_at > now
    ):
        outcome = "already_owned"
    else:
        outcome = "busy"
    return _recovery_result(session, decision_id, outcome, snapshot=snapshot)


def _recovery_result(
    session: Session,
    decision_id: uuid.UUID,
    outcome: RecoveryClaimAcquisitionOutcome,
    *,
    snapshot: DecisionSubmissionClaimSnapshot | None = None,
) -> DecisionSubmissionRecoveryClaimResult:
    observed = snapshot if snapshot is not None else load_snapshot(session, decision_id)
    if outcome == "acquired" and observed is None:  # pragma: no cover
        close_read_transaction(session)
        raise DecisionSubmissionClaimError("recovery_claim_not_found")
    result = DecisionSubmissionRecoveryClaimResult(outcome, observed)
    close_read_transaction(session)
    return result
