"""Order execution and idempotency helpers."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..alpaca_client import TorghutAlpacaClient
from ..models import Execution, Strategy, TradeDecision
from ..snapshots import sync_order_to_db
from .models import ExecutionRequest, StrategyDecision, decision_hash

logger = logging.getLogger(__name__)


class OrderExecutor:
    """Submit orders to Alpaca with idempotency guards."""

    def ensure_decision(
        self, session: Session, decision: StrategyDecision, strategy: Strategy, account_label: str
    ) -> TradeDecision:
        digest = decision_hash(decision)
        stmt = select(TradeDecision).where(TradeDecision.decision_hash == digest)
        existing = session.execute(stmt).scalar_one_or_none()
        if existing:
            return existing

        decision_row = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label=account_label,
            symbol=decision.symbol,
            timeframe=decision.timeframe,
            decision_json=decision.model_dump(mode="json"),
            rationale=decision.rationale,
            status="planned",
            decision_hash=digest,
        )
        session.add(decision_row)
        session.commit()
        session.refresh(decision_row)
        return decision_row

    def execution_exists(self, session: Session, decision_row: TradeDecision) -> bool:
        stmt = select(Execution).where(Execution.trade_decision_id == decision_row.id)
        existing = session.execute(stmt).scalar_one_or_none()
        return existing is not None

    def submit_order(
        self,
        session: Session,
        client: TorghutAlpacaClient,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account_label: str,
    ) -> Optional[Execution]:
        if self.execution_exists(session, decision_row):
            logger.info("Execution already exists for decision %s", decision_row.id)
            return None

        request = ExecutionRequest(
            decision_id=str(decision_row.id),
            symbol=decision.symbol,
            side=decision.action,
            qty=decision.qty,
            order_type=decision.order_type,
            time_in_force=decision.time_in_force,
            limit_price=decision.limit_price,
            stop_price=decision.stop_price,
            client_order_id=decision_row.decision_hash,
        )

        order_response = client.submit_order(
            symbol=request.symbol,
            side=request.side,
            qty=float(request.qty),
            order_type=request.order_type,
            time_in_force=request.time_in_force,
            limit_price=float(request.limit_price) if request.limit_price is not None else None,
            stop_price=float(request.stop_price) if request.stop_price is not None else None,
            extra_params={"client_order_id": request.client_order_id},
        )

        execution = sync_order_to_db(session, order_response, trade_decision_id=str(decision_row.id))
        decision_row.status = "submitted"
        decision_row.executed_at = datetime.now(timezone.utc)
        decision_row.alpaca_account_label = account_label
        session.add(decision_row)
        session.commit()
        return execution

    def mark_rejected(self, session: Session, decision_row: TradeDecision, reason: str) -> None:
        decision_row.status = "rejected"
        decision_json = decision_row.decision_json or {}
        if isinstance(decision_json, dict):
            decision_json.setdefault("risk_reasons", []).append(reason)
            decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()


__all__ = ["OrderExecutor"]
