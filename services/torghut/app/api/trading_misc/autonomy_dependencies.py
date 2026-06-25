"""Autonomy route dependencies owned by explicit API modules."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.trading.scheduler import TradingScheduler

__all__ = (
    "apply_status_read_statement_timeout",
    "build_autonomy_capital_replay_projection",
    "load_route_provenance_summary",
    "rollback_status_read_session",
    "sqlalchemy_error_indicates_statement_timeout",
    "unavailable_runtime_ledger_portfolio_summary",
)


def build_autonomy_capital_replay_projection(
    scheduler: TradingScheduler,
) -> dict[str, object]:
    from .. import proof_floor_payloads

    return proof_floor_payloads.build_autonomy_capital_replay_projection(scheduler)


def load_route_provenance_summary(session: Session) -> dict[str, object]:
    from .. import proof_floor_payloads

    return proof_floor_payloads.load_route_provenance_summary(session)


def rollback_status_read_session(session: Session, *, context: str) -> None:
    from ..status_helpers import rollback_status_read_session as rollback

    rollback(session, context=context)


def apply_status_read_statement_timeout(
    session: Session,
    *,
    milliseconds: int,
) -> None:
    from ..status_helpers import (
        apply_status_read_statement_timeout as apply_statement_timeout,
    )

    apply_statement_timeout(session, milliseconds=milliseconds)


def sqlalchemy_error_indicates_statement_timeout(exc: SQLAlchemyError) -> bool:
    message = str(exc).lower()
    return (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    )


def unavailable_runtime_ledger_portfolio_summary(
    *,
    account_label: str,
    stage_scope: str,
    observed_at: datetime,
    reason: str,
) -> dict[str, object]:
    from ..status_helpers import (
        unavailable_runtime_ledger_portfolio_summary as unavailable_summary,
    )

    return unavailable_summary(
        account_label=account_label,
        stage_scope=stage_scope,
        observed_at=observed_at,
        reason=reason,
    )
