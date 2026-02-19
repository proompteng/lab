"""Reconcile broker order status updates."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Execution, TradeDecision, coerce_json_payload
from ..snapshots import sync_order_to_db
from .order_feed import apply_order_event_to_execution, latest_order_event_for_execution
from .route_metadata import coerce_route_text, resolve_order_route_metadata
from .risk import FINAL_STATUSES
from .tca import upsert_execution_tca_metric

logger = logging.getLogger(__name__)

BACKFILL_DECISION_LOOKBACK_DAYS = 7
BACKFILL_DECISION_LIMIT = 200


class Reconciler:
    """Pull order updates from execution adapter and update executions."""

    def reconcile(self, session: Session, client: Any) -> int:
        updates = 0
        updates += self._reconcile_existing_executions(session, client)
        updates += self._backfill_missing_executions(session, client)
        if updates:
            session.commit()
        return updates

    def _reconcile_existing_executions(self, session: Session, client: Any) -> int:
        stmt = select(Execution).where(~Execution.status.in_(FINAL_STATUSES))
        executions = session.execute(stmt).scalars().all()
        updates = 0
        for execution in executions:
            event = latest_order_event_for_execution(session, execution)
            if event is not None:
                updated_from_feed, _ = apply_order_event_to_execution(execution, event)
                if updated_from_feed:
                    updates += 1
                    _update_trade_decision(session, execution)
                if execution.status in FINAL_STATUSES:
                    continue

            alpaca_order_id = execution.alpaca_order_id
            try:
                order = client.get_order(alpaca_order_id)
            except Exception as exc:  # pragma: no cover - external failure
                logger.warning("Failed to reconcile order %s: %s", alpaca_order_id, exc)
                continue

            expected_adapter = coerce_route_text(execution.execution_expected_adapter)
            route_expected, route_actual, fallback_reason, fallback_count = resolve_order_route_metadata(
                expected_adapter=expected_adapter,
                execution_client=client,
                order_response=order,
            )
            updated = _apply_order_update(
                execution,
                order,
                execution_expected_adapter=route_expected,
                execution_actual_adapter=route_actual,
                execution_fallback_reason=fallback_reason,
                execution_fallback_count=fallback_count,
            )
            if updated:
                upsert_execution_tca_metric(session, execution)
                updates += 1
                _update_trade_decision(session, execution)
        return updates

    def _backfill_missing_executions(self, session: Session, client: Any) -> int:
        # Avoid scanning broker history unboundedly; reconcile only local decisions that are
        # missing an Execution and ask the broker for those specific client_order_ids.
        cutoff = datetime.now(timezone.utc) - timedelta(days=BACKFILL_DECISION_LOOKBACK_DAYS)
        decision_stmt = (
            select(TradeDecision)
            .where(
                TradeDecision.decision_hash.is_not(None),
                TradeDecision.created_at >= cutoff,
                ~TradeDecision.status.in_(FINAL_STATUSES),
            )
            .order_by(TradeDecision.created_at.desc())
            .limit(BACKFILL_DECISION_LIMIT)
        )
        decisions = session.execute(decision_stmt).scalars().all()

        updates = 0
        for decision in decisions:
            if decision.decision_hash is None:
                continue

            existing_stmt = select(Execution).where(
                (Execution.trade_decision_id == decision.id) | (Execution.client_order_id == decision.decision_hash)
            )
            existing = session.execute(existing_stmt).scalar_one_or_none()
            if existing is not None:
                continue

            try:
                order = client.get_order_by_client_order_id(decision.decision_hash)
            except Exception as exc:  # pragma: no cover - external failure
                logger.warning(
                    "Failed to fetch broker order for decision %s client_order_id=%s: %s",
                    decision.id,
                    decision.decision_hash,
                    exc,
                )
                continue
            if not order:
                continue

            expected_route = coerce_route_text(order.get("_execution_route_expected"))
            if expected_route is None:
                expected_route = coerce_route_text(order.get("_execution_route_actual"))
            route_expected, route_actual, fallback_reason, fallback_count = resolve_order_route_metadata(
                expected_adapter=expected_route,
                execution_client=client,
                order_response=order,
            )
            execution = sync_order_to_db(
                session,
                order,
                trade_decision_id=str(decision.id),
                execution_expected_adapter=route_expected,
                execution_actual_adapter=route_actual,
            )
            execution.execution_fallback_reason = fallback_reason
            execution.execution_fallback_count = fallback_count
            execution.execution_actual_adapter = route_actual
            execution.execution_expected_adapter = route_expected or execution.execution_expected_adapter
            upsert_execution_tca_metric(session, execution)
            _update_trade_decision(session, execution)
            updates += 1
        return updates


def _apply_order_update(
    execution: Execution,
    order: dict[str, str],
    *,
    execution_expected_adapter: str | None = None,
    execution_actual_adapter: str | None = None,
    execution_fallback_reason: str | None = None,
    execution_fallback_count: int | None = None,
) -> bool:
    status = order.get("status")
    if status is None:
        return False

    execution.status = status
    execution.filled_qty = Decimal(str(order.get("filled_qty", execution.filled_qty)))
    avg_price = order.get("filled_avg_price") or order.get("avg_fill_price")
    if avg_price is not None:
        execution.avg_fill_price = Decimal(str(avg_price))
    if execution_expected_adapter:
        execution.execution_expected_adapter = execution_expected_adapter
    if execution_actual_adapter:
        execution.execution_actual_adapter = execution_actual_adapter
    if execution_fallback_count is not None:
        execution.execution_fallback_count = execution_fallback_count
    execution.execution_fallback_reason = execution_fallback_reason
    execution.raw_order = coerce_json_payload(order)
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
