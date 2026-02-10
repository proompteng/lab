"""Helpers for recording Alpaca state into the torghut database."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .alpaca_client import TorghutAlpacaClient
from .models import Execution, PositionSnapshot, coerce_json_payload

logger = logging.getLogger(__name__)


def snapshot_account_and_positions(
    session: Session, client: TorghutAlpacaClient, alpaca_account_label: str
) -> PositionSnapshot:
    """Fetch account + positions and persist a PositionSnapshot."""

    account = client.get_account()
    positions = client.list_positions()

    snapshot = PositionSnapshot(
        alpaca_account_label=alpaca_account_label,
        as_of=datetime.now(timezone.utc),
        equity=Decimal(str(account.get("equity"))),
        cash=Decimal(str(account.get("cash"))),
        buying_power=Decimal(str(account.get("buying_power"))),
        positions=coerce_json_payload(positions),
    )
    session.add(snapshot)
    session.commit()
    session.refresh(snapshot)
    return snapshot


def sync_order_to_db(
    session: Session, order_response: dict[str, Any], trade_decision_id: Optional[str] = None
) -> Execution:
    """Create or update an Execution row from an Alpaca order response."""

    alpaca_order_id = order_response.get("id") or order_response.get("order_id")
    if alpaca_order_id is None:
        raise ValueError("order_response must include an 'id' field")

    stmt = select(Execution).where(Execution.alpaca_order_id == alpaca_order_id)
    existing = session.execute(stmt).scalar_one_or_none()
    if existing is None:
        client_order_id = order_response.get("client_order_id")
        if client_order_id:
            stmt = select(Execution).where(Execution.client_order_id == client_order_id)
            existing = session.execute(stmt).scalar_one_or_none()
            if existing and existing.alpaca_order_id != alpaca_order_id:
                logger.warning("Execution client_order_id reused with new alpaca_order_id")

    data = {
        "trade_decision_id": trade_decision_id,
        "alpaca_order_id": alpaca_order_id,
        "client_order_id": order_response.get("client_order_id"),
        "symbol": order_response.get("symbol"),
        "side": order_response.get("side"),
        "order_type": order_response.get("type") or order_response.get("order_type"),
        "time_in_force": order_response.get("time_in_force"),
        "submitted_qty": Decimal(str(order_response.get("qty", 0))),
        "filled_qty": Decimal(str(order_response.get("filled_qty", 0))),
        "avg_fill_price": _optional_decimal(order_response.get("filled_avg_price")),
        "status": order_response.get("status"),
        "raw_order": coerce_json_payload(order_response),
        "last_update_at": datetime.now(timezone.utc),
    }

    if existing:
        for key, value in data.items():
            setattr(existing, key, value)
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return existing

    execution = Execution(**data)
    session.add(execution)
    try:
        session.commit()
        session.refresh(execution)
        return execution
    except IntegrityError:
        session.rollback()
        stmt = select(Execution).where(Execution.alpaca_order_id == alpaca_order_id)
        existing = session.execute(stmt).scalar_one_or_none()
        if existing is None:
            client_order_id = order_response.get("client_order_id")
            if client_order_id:
                stmt = select(Execution).where(Execution.client_order_id == client_order_id)
                existing = session.execute(stmt).scalar_one_or_none()
        if existing is None:
            raise
        for key, value in data.items():
            setattr(existing, key, value)
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return existing


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


__all__ = ["snapshot_account_and_positions", "sync_order_to_db"]
