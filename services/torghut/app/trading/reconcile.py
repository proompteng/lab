"""Reconcile Alpaca order status updates."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from ..models import Execution, TradeDecision
from .risk import FINAL_STATUSES

logger = logging.getLogger(__name__)


class Reconciler:
    """Pull order updates from Alpaca and update executions."""

    def reconcile(self, session: Session, client: TorghutAlpacaClient) -> int:
        stmt = select(Execution).where(~Execution.status.in_(FINAL_STATUSES))
        executions = session.execute(stmt).scalars().all()
        updates = 0
        for execution in executions:
            alpaca_order_id = execution.alpaca_order_id
            try:
                order = client.get_order(alpaca_order_id)
            except Exception as exc:  # pragma: no cover - external failure
                logger.warning("Failed to reconcile order %s: %s", alpaca_order_id, exc)
                continue

            updated = _apply_order_update(execution, order)
            if updated:
                updates += 1
                _update_trade_decision(session, execution)

        if updates:
            session.commit()
        return updates


def _apply_order_update(execution: Execution, order: dict[str, str]) -> bool:
    status = order.get("status")
    if status is None:
        return False

    execution.status = status
    execution.filled_qty = Decimal(str(order.get("filled_qty", execution.filled_qty)))
    avg_price = order.get("filled_avg_price") or order.get("avg_fill_price")
    if avg_price is not None:
        execution.avg_fill_price = Decimal(str(avg_price))
    execution.raw_order = order
    execution.last_update_at = datetime.now(timezone.utc)
    return True


def _update_trade_decision(session: Session, execution: Execution) -> None:
    if execution.trade_decision_id is None:
        return
    decision = session.get(TradeDecision, execution.trade_decision_id)
    if decision is None:
        return
    decision.status = execution.status
    if execution.status == "filled" and decision.executed_at is None:
        decision.executed_at = datetime.now(timezone.utc)
    session.add(decision)


__all__ = ["Reconciler"]
