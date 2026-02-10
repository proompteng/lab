"""Order execution and idempotency helpers."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from collections.abc import Mapping
from typing import Any, Optional, cast

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import Execution, Strategy, TradeDecision, coerce_json_payload
from ..snapshots import sync_order_to_db
from .execution_policy import should_retry_order_error
from .firewall import OrderFirewall
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

        decision_payload = coerce_json_payload(decision.model_dump(mode="json"))
        decision_row = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label=account_label,
            symbol=decision.symbol,
            timeframe=decision.timeframe,
            decision_json=decision_payload,
            rationale=decision.rationale,
            status="planned",
            decision_hash=digest,
        )
        session.add(decision_row)
        try:
            session.commit()
            session.refresh(decision_row)
            return decision_row
        except IntegrityError:
            session.rollback()
            existing = session.execute(stmt).scalar_one_or_none()
            if existing is None:
                raise
            return existing

    def execution_exists(self, session: Session, decision_row: TradeDecision) -> bool:
        return self._fetch_execution(session, decision_row) is not None

    def _fetch_execution(self, session: Session, decision_row: TradeDecision) -> Optional[Execution]:
        conditions = [Execution.trade_decision_id == decision_row.id]
        if decision_row.decision_hash:
            conditions.append(Execution.client_order_id == decision_row.decision_hash)
        stmt = select(Execution).where(or_(*conditions))
        return session.execute(stmt).scalar_one_or_none()

    def submit_order(
        self,
        session: Session,
        firewall: OrderFirewall,
        decision: StrategyDecision,
        decision_row: TradeDecision,
        account_label: str,
        *,
        retry_delays: Optional[list[float]] = None,
    ) -> Optional[Execution]:
        existing_execution = self._fetch_execution(session, decision_row)
        if existing_execution is not None:
            logger.info("Execution already exists for decision %s", decision_row.id)
            return None

        existing_order = self._fetch_existing_order(firewall, decision_row.decision_hash)
        if existing_order is not None:
            execution = sync_order_to_db(session, existing_order, trade_decision_id=str(decision_row.id))
            _apply_execution_status(decision_row, execution, account_label)
            session.add(decision_row)
            session.commit()
            logger.info("Backfilled execution for decision %s from broker state", decision_row.id)
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

        if retry_delays is None:
            retry_delays = []

        attempt = 0
        while True:
            try:
                order_response = firewall.submit_order(
                    symbol=request.symbol,
                    side=request.side,
                    qty=float(request.qty),
                    order_type=request.order_type,
                    time_in_force=request.time_in_force,
                    limit_price=float(request.limit_price) if request.limit_price is not None else None,
                    stop_price=float(request.stop_price) if request.stop_price is not None else None,
                    extra_params={"client_order_id": request.client_order_id},
                )
                break
            except Exception as exc:
                if attempt >= len(retry_delays) or not should_retry_order_error(exc):
                    raise
                delay = retry_delays[attempt]
                attempt += 1
                logger.warning(
                    "Retrying order submission attempt=%s decision_id=%s error=%s",
                    attempt,
                    decision_row.id,
                    exc,
                )
                time.sleep(delay)

        execution = sync_order_to_db(session, order_response, trade_decision_id=str(decision_row.id))
        _apply_execution_status(
            decision_row,
            execution,
            account_label,
            submitted_at=datetime.now(timezone.utc),
            status_override="submitted",
        )
        session.add(decision_row)
        session.commit()
        return execution

    def mark_rejected(self, session: Session, decision_row: TradeDecision, reason: str) -> None:
        decision_row.status = "rejected"
        decision_json = _coerce_json(decision_row.decision_json)
        existing = decision_json.get("risk_reasons")
        if isinstance(existing, list):
            risk_reasons = [str(item) for item in cast(list[Any], existing)]
        else:
            risk_reasons = []
        risk_reasons.append(reason)
        decision_json["risk_reasons"] = risk_reasons
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()

    def update_decision_params(
        self,
        session: Session,
        decision_row: TradeDecision,
        params_update: Mapping[str, Any],
    ) -> None:
        decision_json = _coerce_json(decision_row.decision_json)
        params_value = decision_json.get("params")
        if isinstance(params_value, Mapping):
            params = dict(cast(Mapping[str, Any], params_value))
        else:
            params = {}
        params.update(params_update)
        decision_json["params"] = params
        decision_row.decision_json = decision_json
        session.add(decision_row)
        session.commit()

    @staticmethod
    def _fetch_existing_order(
        firewall: OrderFirewall, decision_hash_value: Optional[str]
    ) -> Optional[dict[str, Any]]:
        if not decision_hash_value:
            return None
        try:
            order = firewall.get_order_by_client_order_id(decision_hash_value)
        except Exception as exc:  # pragma: no cover - external failure
            logger.warning("Failed to fetch broker order for client_order_id: %s", exc)
            return None
        if not order:
            return None
        return order


def _coerce_json(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        raw = cast(Mapping[str, Any], value)
        return {str(key): val for key, val in raw.items()}
    return {}


def _apply_execution_status(
    decision_row: TradeDecision,
    execution: Execution,
    account_label: str,
    submitted_at: Optional[datetime] = None,
    status_override: Optional[str] = None,
) -> None:
    decision_row.status = status_override or execution.status or "submitted"
    decision_row.alpaca_account_label = account_label
    if submitted_at is not None and decision_row.executed_at is None:
        decision_row.executed_at = submitted_at
    if execution.status == "filled" and decision_row.executed_at is None:
        decision_row.executed_at = datetime.now(timezone.utc)


__all__ = ["OrderExecutor"]
