"""Risk checks for trade decisions."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Strategy, TradeDecision
from .models import RiskCheckResult, StrategyDecision

FINAL_STATUSES = {"filled", "canceled", "rejected", "expired"}


class RiskEngine:
    """Apply trading risk constraints before execution."""

    def evaluate(
        self,
        session: Session,
        decision: StrategyDecision,
        strategy: Strategy,
        account: dict[str, str],
        positions: Iterable[dict[str, str]],
        allowed_symbols: Optional[set[str]] = None,
    ) -> RiskCheckResult:
        reasons: list[str] = []

        if not settings.trading_enabled:
            reasons.append("trading_disabled")
        if settings.trading_mode == "live" and not settings.trading_live_enabled:
            reasons.append("live_trading_disabled")

        if not strategy.enabled:
            reasons.append("strategy_disabled")

        if allowed_symbols is not None and decision.symbol not in allowed_symbols:
            reasons.append("symbol_not_allowed")

        price = _extract_decision_price(decision)
        if price is None:
            reasons.append("missing_price")

        qty = Decimal(str(decision.qty))
        notional = price * qty if price is not None else None

        max_notional = _resolve_decimal(strategy.max_notional_per_trade) or _resolve_decimal(
            settings.trading_max_notional_per_trade
        )
        if notional is not None and max_notional is not None and notional > max_notional:
            reasons.append("max_notional_exceeded")

        equity = _resolve_decimal(account.get("equity"))
        buying_power = _resolve_decimal(account.get("buying_power"))
        if notional is not None and buying_power is not None and notional > buying_power:
            reasons.append("insufficient_buying_power")

        max_pct = _resolve_decimal(strategy.max_position_pct_equity) or _resolve_decimal(
            settings.trading_max_position_pct_equity
        )
        if max_pct is not None and equity is not None and notional is not None:
            current_value = _current_position_value(decision.symbol, positions)
            if current_value + notional > equity * max_pct:
                reasons.append("max_position_pct_exceeded")

        cooldown_seconds = settings.trading_cooldown_seconds
        if cooldown_seconds > 0:
            recent_cutoff = datetime.now(timezone.utc) - timedelta(seconds=cooldown_seconds)
            stmt = (
                select(TradeDecision)
                .where(TradeDecision.symbol == decision.symbol)
                .where(TradeDecision.created_at >= recent_cutoff)
            )
            recent = session.execute(stmt).scalar_one_or_none()
            if recent:
                reasons.append("cooldown_active")

        return RiskCheckResult(approved=len(reasons) == 0, reasons=reasons)


def _extract_decision_price(decision: StrategyDecision) -> Optional[Decimal]:
    for key in ("price", "limit_price", "stop_price"):
        value = decision.params.get(key)
        if value is None:
            value = getattr(decision, key, None)
        if value is not None:
            try:
                return Decimal(str(value))
            except (ArithmeticError, ValueError):
                continue
    return None


def _resolve_decimal(value: Optional[Decimal | str | float]) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _current_position_value(symbol: str, positions: Iterable[dict[str, str]]) -> Decimal:
    total = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        market_value = position.get("market_value") or position.get("market_value")
        try:
            total += Decimal(str(market_value))
        except (ArithmeticError, ValueError):
            continue
    return total


__all__ = ["RiskEngine", "FINAL_STATUSES"]
