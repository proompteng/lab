"""Identity and input validation for submission claims."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import cast

from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.orm import Session

from ...models import Execution, TradeDecision
from .types import (
    DecisionSubmissionClaimError,
    DecisionSubmissionClaimHandle,
    DecisionSubmissionClaimValidationError,
    DecisionSubmissionRecoveryHandle,
    DecisionSubmissionTerminalIdentity,
)

SubmissionHandle = DecisionSubmissionClaimHandle | DecisionSubmissionRecoveryHandle
NormalizedTerminalIdentity = tuple[str, str, uuid.UUID]
DECISION_IDENTITY_LOCK_RETRIES = 3


def bounded_seconds(value: object, *, minimum: int, maximum: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise DecisionSubmissionClaimValidationError(f"{field}_must_be_integer")
    if value < minimum or value > maximum:
        raise DecisionSubmissionClaimValidationError(
            f"{field}_outside_bounds:{minimum}:{maximum}"
        )
    return value


def required_text(value: object, *, field: str, maximum: int) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        raise DecisionSubmissionClaimValidationError(f"{field}_required")
    if len(normalized) > maximum:
        raise DecisionSubmissionClaimValidationError(f"{field}_too_long:{maximum}")
    return normalized


def as_uuid(value: uuid.UUID | str, *, field: str) -> uuid.UUID:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (TypeError, ValueError) as exc:
        raise DecisionSubmissionClaimValidationError(f"{field}_invalid") from exc


def as_utc_datetime(value: object) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value or "").strip().replace("Z", "+00:00")
        if not raw:
            raise DecisionSubmissionClaimError("database_clock_unavailable")
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError as exc:
            raise DecisionSubmissionClaimError("database_clock_invalid") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def database_now(session: Session) -> datetime:
    clock = (
        func.clock_timestamp()
        if session.get_bind().dialect.name == "postgresql"
        else func.current_timestamp()
    )
    return as_utc_datetime(session.execute(select(clock)).scalar_one())


def validate_decision_identity(
    session: Session,
    *,
    decision_id: uuid.UUID,
    client_order_id: str,
    expected_account_label: str | None = None,
) -> TradeDecision:
    if session.get_bind().dialect.name != "postgresql":
        return _load_and_validate_decision(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
            expected_account_label=expected_account_label,
        )
    for attempt in range(DECISION_IDENTITY_LOCK_RETRIES):
        account_label = expected_account_label or _read_candidate_account(
            session,
            decision_id=decision_id,
            client_order_id=client_order_id,
        )
        _lock_postgres_submission_identity(
            session,
            decision_id=decision_id,
            account_label=account_label,
            client_order_id=client_order_id,
        )
        try:
            return _load_and_validate_decision(
                session,
                decision_id=decision_id,
                client_order_id=client_order_id,
                expected_account_label=account_label,
            )
        except DecisionSubmissionClaimValidationError as exc:
            session.rollback()
            if (
                expected_account_label is not None
                or attempt == DECISION_IDENTITY_LOCK_RETRIES - 1
            ):
                raise
            if str(exc) != "trade_decision_account_identity_changed":
                raise
    raise DecisionSubmissionClaimError("decision_identity_lock_retry_exhausted")


def _read_candidate_account(
    session: Session,
    *,
    decision_id: uuid.UUID,
    client_order_id: str,
) -> str:
    with session.no_autoflush:
        identity = session.execute(
            select(
                TradeDecision.alpaca_account_label,
                TradeDecision.decision_hash,
            ).where(TradeDecision.id == decision_id)
        ).one_or_none()
    if identity is None:
        raise DecisionSubmissionClaimValidationError("trade_decision_not_found")
    account_label, decision_hash = identity
    _validate_client_order_identity(decision_hash, client_order_id)
    return required_text(account_label, field="account_label", maximum=64)


def _lock_postgres_submission_identity(
    session: Session,
    *,
    decision_id: uuid.UUID,
    account_label: str,
    client_order_id: str,
) -> None:
    session.execute(
        text(
            "SELECT torghut_lock_submission_identities("
            "CAST(ARRAY[:decision_key, :client_key] AS text[]))"
        ),
        {
            "decision_key": f"torghut:submission:decision:{decision_id}",
            "client_key": (
                f"torghut:submission:client:{account_label}\x1f{client_order_id}"
            ),
        },
    )


def _load_and_validate_decision(
    session: Session,
    *,
    decision_id: uuid.UUID,
    client_order_id: str,
    expected_account_label: str | None,
) -> TradeDecision:
    decision = session.execute(
        select(TradeDecision)
        .where(TradeDecision.id == decision_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if decision is None:
        raise DecisionSubmissionClaimValidationError("trade_decision_not_found")
    _validate_client_order_identity(decision.decision_hash, client_order_id)
    if (
        expected_account_label is not None
        and decision.alpaca_account_label != expected_account_label
    ):
        raise DecisionSubmissionClaimValidationError(
            "trade_decision_account_identity_changed"
        )
    return decision


def _validate_client_order_identity(
    decision_hash: object,
    client_order_id: str,
) -> None:
    expected_client_order_id = str(decision_hash or "").strip()
    if not expected_client_order_id:
        raise DecisionSubmissionClaimValidationError(
            "trade_decision_decision_hash_required"
        )
    if client_order_id != expected_client_order_id:
        raise DecisionSubmissionClaimValidationError(
            "client_order_id_must_equal_decision_hash"
        )


def existing_execution_id(
    session: Session,
    *,
    decision: TradeDecision,
    client_order_id: str,
) -> uuid.UUID | None:
    identity = session.execute(
        select(
            Execution.id,
            Execution.trade_decision_id,
            Execution.alpaca_account_label,
            Execution.client_order_id,
        )
        .where(
            or_(
                Execution.trade_decision_id == decision.id,
                and_(
                    Execution.alpaca_account_label == decision.alpaca_account_label,
                    Execution.client_order_id == client_order_id,
                ),
            )
        )
        .order_by(Execution.created_at.desc())
        .limit(1)
    ).one_or_none()
    if identity is None:
        return None
    execution_id, observed_decision_id, account_label, observed_client_order_id = (
        identity
    )
    if (
        observed_decision_id != decision.id
        or str(account_label or "").strip() != decision.alpaca_account_label
        or str(observed_client_order_id or "").strip() != client_order_id
    ):
        raise DecisionSubmissionClaimValidationError(
            "existing_execution_submission_identity_mismatch"
        )
    return cast(uuid.UUID, execution_id)


def validate_broker_io_boundary(
    session: Session,
    *,
    handle: SubmissionHandle,
) -> None:
    decision = validate_decision_identity(
        session,
        decision_id=handle.decision_id,
        client_order_id=handle.client_order_id,
        expected_account_label=handle.account_label,
    )
    if str(decision.status or "").strip().lower() != "planned":
        session.rollback()
        raise DecisionSubmissionClaimValidationError("trade_decision_not_planned")
    if (
        existing_execution_id(
            session,
            decision=decision,
            client_order_id=handle.client_order_id,
        )
        is not None
    ):
        session.rollback()
        raise DecisionSubmissionClaimValidationError(
            "execution_exists_at_broker_io_boundary"
        )


def validate_execution_identity(
    session: Session,
    *,
    handle: SubmissionHandle,
    terminal: NormalizedTerminalIdentity,
) -> None:
    broker_order_id, _, execution_id = terminal
    identity = session.execute(
        select(
            Execution.trade_decision_id,
            Execution.alpaca_account_label,
            Execution.client_order_id,
            Execution.alpaca_order_id,
        ).where(Execution.id == execution_id)
    ).one_or_none()
    if identity is None:
        raise DecisionSubmissionClaimValidationError("execution_not_found")
    observed_decision_id, observed_account, observed_client_id, observed_order_id = (
        identity
    )
    if (
        observed_decision_id != handle.decision_id
        or str(observed_account or "").strip() != handle.account_label
        or str(observed_client_id or "").strip() != handle.client_order_id
        or str(observed_order_id or "").strip() != broker_order_id
    ):
        raise DecisionSubmissionClaimValidationError(
            "execution_submission_claim_identity_mismatch"
        )


def normalized_terminal_identity(
    session: Session,
    *,
    handle: SubmissionHandle,
    terminal: DecisionSubmissionTerminalIdentity,
) -> NormalizedTerminalIdentity:
    normalized_order_id = required_text(
        terminal.broker_order_id, field="broker_order_id", maximum=128
    )
    normalized_client_id = required_text(
        terminal.broker_client_order_id,
        field="broker_client_order_id",
        maximum=128,
    )
    if normalized_client_id != handle.client_order_id:
        raise DecisionSubmissionClaimValidationError("broker_client_order_id_mismatch")
    normalized_execution_id = as_uuid(terminal.execution_id, field="execution_id")
    normalized = (
        normalized_order_id,
        normalized_client_id,
        normalized_execution_id,
    )
    validate_execution_identity(
        session,
        handle=handle,
        terminal=normalized,
    )
    return normalized
