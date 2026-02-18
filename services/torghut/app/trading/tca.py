"""Transaction cost analytics (TCA) derivation for execution rows."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Optional, cast

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Execution, ExecutionTCAMetric, TradeDecision


def upsert_execution_tca_metric(session: Session, execution: Execution) -> ExecutionTCAMetric:
    """Derive deterministic TCA metrics for an execution and upsert a single row."""

    decision = _load_trade_decision(session, execution)
    strategy_id = decision.strategy_id if decision is not None else None
    account_label = decision.alpaca_account_label if decision is not None else None

    arrival_price = _resolve_arrival_price(decision=decision, execution=execution)
    avg_fill_price = _positive_decimal(execution.avg_fill_price)
    filled_qty = _positive_decimal(execution.filled_qty) or Decimal("0")
    signed_qty = _signed_qty(side=execution.side, qty=filled_qty)

    slippage_bps: Decimal | None = None
    shortfall_notional: Decimal | None = None
    if arrival_price is not None and avg_fill_price is not None and filled_qty > 0 and signed_qty != 0:
        price_delta = avg_fill_price - arrival_price
        direction = Decimal("1") if signed_qty > 0 else Decimal("-1")
        slippage_bps = (direction * price_delta / arrival_price) * Decimal("10000")
        shortfall_notional = direction * price_delta * filled_qty

    churn_qty, churn_ratio = _derive_churn(
        session=session,
        execution=execution,
        strategy_id=strategy_id,
        account_label=account_label,
        signed_qty=signed_qty,
        filled_qty=filled_qty,
    )

    existing = session.execute(
        select(ExecutionTCAMetric).where(ExecutionTCAMetric.execution_id == execution.id)
    ).scalar_one_or_none()
    if existing is None:
        row = ExecutionTCAMetric(
            execution_id=execution.id,
            trade_decision_id=execution.trade_decision_id,
            strategy_id=strategy_id,
            alpaca_account_label=account_label,
            symbol=execution.symbol,
            side=execution.side,
            arrival_price=arrival_price,
            avg_fill_price=avg_fill_price,
            filled_qty=filled_qty,
            signed_qty=signed_qty,
            slippage_bps=slippage_bps,
            shortfall_notional=shortfall_notional,
            churn_qty=churn_qty,
            churn_ratio=churn_ratio,
        )
        session.add(row)
        return row

    existing.trade_decision_id = execution.trade_decision_id
    existing.strategy_id = strategy_id
    existing.alpaca_account_label = account_label
    existing.symbol = execution.symbol
    existing.side = execution.side
    existing.arrival_price = arrival_price
    existing.avg_fill_price = avg_fill_price
    existing.filled_qty = filled_qty
    existing.signed_qty = signed_qty
    existing.slippage_bps = slippage_bps
    existing.shortfall_notional = shortfall_notional
    existing.churn_qty = churn_qty
    existing.churn_ratio = churn_ratio
    session.add(existing)
    return existing


def build_tca_gate_inputs(session: Session, *, strategy_id: str | None = None) -> dict[str, Decimal | int]:
    """Build aggregate TCA inputs used by autonomy gate thresholds."""

    stmt = select(
        func.count(ExecutionTCAMetric.id),
        func.avg(ExecutionTCAMetric.slippage_bps),
        func.avg(ExecutionTCAMetric.shortfall_notional),
        func.avg(ExecutionTCAMetric.churn_ratio),
    )
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)

    row = session.execute(stmt).one()
    order_count = int(row[0] or 0)
    avg_slippage = _decimal_or_none(row[1])
    avg_shortfall = _decimal_or_none(row[2])
    avg_churn = _decimal_or_none(row[3])
    return {
        "order_count": order_count,
        "avg_slippage_bps": avg_slippage if avg_slippage is not None else Decimal("0"),
        "avg_shortfall_notional": avg_shortfall if avg_shortfall is not None else Decimal("0"),
        "avg_churn_ratio": avg_churn if avg_churn is not None else Decimal("0"),
    }


def _derive_churn(
    *,
    session: Session,
    execution: Execution,
    strategy_id: Any,
    account_label: str | None,
    signed_qty: Decimal,
    filled_qty: Decimal,
) -> tuple[Decimal, Optional[Decimal]]:
    if strategy_id is None or filled_qty <= 0 or signed_qty == 0:
        return Decimal("0"), None

    prior_where = [
        ExecutionTCAMetric.strategy_id == strategy_id,
        ExecutionTCAMetric.symbol == execution.symbol,
        Execution.created_at < execution.created_at,
    ]
    if account_label is None:
        prior_where.append(ExecutionTCAMetric.alpaca_account_label.is_(None))
    else:
        prior_where.append(ExecutionTCAMetric.alpaca_account_label == account_label)

    prior_signed_sum_stmt = (
        select(func.coalesce(func.sum(ExecutionTCAMetric.signed_qty), 0))
        .select_from(ExecutionTCAMetric)
        .join(Execution, Execution.id == ExecutionTCAMetric.execution_id)
        .where(*prior_where)
    )
    prior_signed = _decimal_or_none(session.execute(prior_signed_sum_stmt).scalar_one()) or Decimal("0")

    if prior_signed == 0:
        return Decimal("0"), Decimal("0")
    if (prior_signed > 0 and signed_qty > 0) or (prior_signed < 0 and signed_qty < 0):
        return Decimal("0"), Decimal("0")

    churn_qty = min(abs(prior_signed), abs(signed_qty))
    churn_ratio = churn_qty / filled_qty if filled_qty > 0 else None
    return churn_qty, churn_ratio


def _resolve_arrival_price(*, decision: TradeDecision | None, execution: Execution) -> Decimal | None:
    decision_payload: dict[str, Any] = {}
    if decision is not None and isinstance(decision.decision_json, Mapping):
        decision_payload = {str(key): value for key, value in cast(Mapping[str, Any], decision.decision_json).items()}
    params = decision_payload.get("params")
    params_payload: dict[str, Any] = {}
    if isinstance(params, Mapping):
        params_payload = {str(key): value for key, value in cast(Mapping[str, Any], params).items()}

    raw_order_payload: dict[str, Any] = {}
    if isinstance(execution.raw_order, Mapping):
        raw_order_payload = {str(key): value for key, value in cast(Mapping[str, Any], execution.raw_order).items()}

    for candidate in (
        params_payload.get("arrival_price"),
        params_payload.get("reference_price"),
        params_payload.get("price"),
        decision_payload.get("arrival_price"),
        decision_payload.get("reference_price"),
        raw_order_payload.get("arrival_price"),
        raw_order_payload.get("reference_price"),
        raw_order_payload.get("limit_price"),
    ):
        resolved = _positive_decimal(candidate)
        if resolved is not None:
            return resolved
    return None


def _load_trade_decision(session: Session, execution: Execution) -> TradeDecision | None:
    if execution.trade_decision_id is not None:
        decision = session.get(TradeDecision, execution.trade_decision_id)
        if decision is not None:
            return decision
    if execution.client_order_id is None:
        return None
    return session.execute(
        select(TradeDecision).where(TradeDecision.decision_hash == execution.client_order_id)
    ).scalar_one_or_none()


def _signed_qty(*, side: str, qty: Decimal) -> Decimal:
    normalized = (side or "").strip().lower()
    if normalized == "buy":
        return qty
    if normalized == "sell":
        return -qty
    return Decimal("0")


def _positive_decimal(value: Any) -> Decimal | None:
    parsed = _decimal_or_none(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


__all__ = ["build_tca_gate_inputs", "upsert_execution_tca_metric"]
