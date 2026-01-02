"""Trading decision engine based on TA signals."""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Iterable, Optional, cast

from ..config import settings
from ..models import Strategy
from .models import SignalEnvelope, StrategyDecision
from .prices import PriceFetcher

logger = logging.getLogger(__name__)


class DecisionEngine:
    """Evaluate TA signals against configured strategies."""

    def __init__(self, price_fetcher: Optional[PriceFetcher] = None) -> None:
        self.price_fetcher = price_fetcher

    def evaluate(self, signal: SignalEnvelope, strategies: Iterable[Strategy]) -> list[StrategyDecision]:
        decisions: list[StrategyDecision] = []
        for strategy in strategies:
            if not strategy.enabled:
                continue
            if signal.timeframe and signal.timeframe != strategy.base_timeframe:
                continue
            decision = self._evaluate_strategy(signal, strategy)
            if decision:
                decisions.append(decision)
        return decisions

    def _evaluate_strategy(self, signal: SignalEnvelope, strategy: Strategy) -> Optional[StrategyDecision]:
        payload = signal.payload or {}
        macd, macd_signal = _extract_macd(payload)
        rsi = _extract_rsi(payload)

        if macd is None or macd_signal is None or rsi is None:
            logger.debug("Signal missing indicators for strategy %s", strategy.id)
            return None

        action: Optional[str] = None
        rationale_parts: list[str] = []
        if macd > macd_signal and rsi < 35:
            action = "buy"
            rationale_parts.append("macd_cross_up")
            rationale_parts.append("rsi_oversold")
        elif macd < macd_signal and rsi > 65:
            action = "sell"
            rationale_parts.append("macd_cross_down")
            rationale_parts.append("rsi_overbought")

        if action is None:
            return None

        qty = Decimal(str(settings.trading_default_qty))
        price = _extract_price(payload)
        if price is None and self.price_fetcher is not None:
            price = self.price_fetcher.fetch_price(signal)

        return StrategyDecision(
            strategy_id=str(strategy.id),
            symbol=signal.symbol,
            event_ts=signal.event_ts,
            timeframe=signal.timeframe or strategy.base_timeframe,
            action=action,
            qty=qty,
            order_type="market",
            time_in_force="day",
            rationale=",".join(rationale_parts) if rationale_parts else None,
            params={
                "macd": macd,
                "macd_signal": macd_signal,
                "rsi": rsi,
                "price": price,
            },
        )


def _extract_macd(payload: dict[str, Any]) -> tuple[Optional[Decimal], Optional[Decimal]]:
    macd_block = payload.get("macd")
    if isinstance(macd_block, dict):
        macd_dict = cast(dict[str, Any], macd_block)
        macd_val = macd_dict.get("macd")
        signal_val = macd_dict.get("signal")
    else:
        macd_val = payload.get("macd")
        signal_val = payload.get("macd_signal")
    return _optional_decimal(macd_val), _optional_decimal(signal_val)


def _extract_rsi(payload: dict[str, Any]) -> Optional[Decimal]:
    return _optional_decimal(payload.get("rsi14") or payload.get("rsi"))


def _extract_price(payload: dict[str, Any]) -> Optional[Decimal]:
    for key in ("price", "close", "c", "last"):
        if key in payload:
            return _optional_decimal(payload.get(key))
    return None


def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


__all__ = ["DecisionEngine"]
