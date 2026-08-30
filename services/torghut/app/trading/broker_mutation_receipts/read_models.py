"""Read-only receipt and immutable event-history queries."""

from __future__ import annotations

import uuid

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .persistence import (
    close_read_transaction,
    load_receipt_event_history,
    load_receipt_snapshot,
)
from .types import BrokerMutationReceiptEventSnapshot, BrokerMutationReceiptSnapshot
from .validation import BrokerMutationReceiptError, as_uuid


def get_broker_mutation_receipt(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> BrokerMutationReceiptSnapshot | None:
    try:
        snapshot = load_receipt_snapshot(
            session,
            as_uuid(receipt_id, field="receipt_id"),
        )
        close_read_transaction(session)
        return snapshot
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


def get_broker_mutation_receipt_history(
    session: Session,
    receipt_id: uuid.UUID | str,
) -> tuple[BrokerMutationReceiptEventSnapshot, ...]:
    try:
        history = tuple(
            load_receipt_event_history(
                session,
                as_uuid(receipt_id, field="receipt_id"),
            )
        )
        close_read_transaction(session)
        return history
    except (BrokerMutationReceiptError, SQLAlchemyError):
        session.rollback()
        raise


__all__ = [
    "get_broker_mutation_receipt",
    "get_broker_mutation_receipt_history",
]
