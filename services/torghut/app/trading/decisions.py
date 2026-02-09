"""Trading decision engine based on TA signals."""

from __future__ import annotations

import logging
from decimal import ROUND_DOWN, Decimal
from typing import Any, Iterable, Optional, cast

from ..config import settings
from ..models import Strategy
from .models import SignalEnvelope, StrategyDecision
from .prices import MarketSnapshot, PriceFetcher

logger = logging.getLogger(__name__)


class DecisionEngine:
    """Evaluate TA signals against configured strategies."""

    def __init__(self, price_fetcher: Optional[PriceFetcher] = None) -> None:
        self.price_fetcher = price_fetcher

    def evaluate(
        self,
        signal: SignalEnvelope,
        strategies: Iterable[Strategy],
        *,
        equity: Optional[Decimal] = None,
    ) -> list[StrategyDecision]:
        decisions: list[StrategyDecision] = []
        for strategy in strategies:
            if not strategy.enabled:
                continue
            if signal.timeframe is None:
                logger.debug(
                    "Skipping strategy %s due to missing signal timeframe for symbol %s",
                    strategy.id,
                    signal.symbol,
                )
                continue
            if signal.timeframe != strategy.base_timeframe:
                continue
            decision = self._evaluate_strategy(signal, strategy, equity=equity)
            if decision:
                decisions.append(decision)
        return decisions

    def _evaluate_strategy(
        self,
        signal: SignalEnvelope,
        strategy: Strategy,
        *,
        equity: Optional[Decimal],
    ) -> Optional[StrategyDecision]:
        timeframe = signal.timeframe
        if timeframe is None:
            return None
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

        price = _extract_price(payload)
        snapshot: Optional[MarketSnapshot] = None
        if price is None and self.price_fetcher is not None:
            snapshot = self.price_fetcher.fetch_market_snapshot(signal)
            if snapshot is not None:
                price = snapshot.price

        qty, sizing_meta = _resolve_qty(strategy, price=price, equity=equity)

        return StrategyDecision(
            strategy_id=str(strategy.id),
            symbol=signal.symbol,
            event_ts=signal.event_ts,
            timeframe=timeframe,
            action=action,
            qty=qty,
            order_type="market",
            time_in_force="day",
            rationale=",".join(rationale_parts) if rationale_parts else None,
            params=_build_params(
                macd=macd,
                macd_signal=macd_signal,
                rsi=rsi,
                price=price,
                snapshot=snapshot,
            )
            | {"sizing": sizing_meta},
        )


def _build_params(
    macd: Decimal,
    macd_signal: Decimal,
    rsi: Decimal,
    price: Optional[Decimal],
    snapshot: Optional[MarketSnapshot],
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "macd": macd,
        "macd_signal": macd_signal,
        "rsi": rsi,
        "price": price,
    }
    if snapshot is not None:
        params["price_snapshot"] = _snapshot_payload(snapshot)
        if snapshot.spread is not None:
            params.setdefault("spread", snapshot.spread)
    return params


def _snapshot_payload(snapshot: MarketSnapshot) -> dict[str, Any]:
    return {
        "as_of": snapshot.as_of.isoformat(),
        "price": str(snapshot.price) if snapshot.price is not None else None,
        "spread": str(snapshot.spread) if snapshot.spread is not None else None,
        "source": snapshot.source,
    }


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


def _resolve_qty(
    strategy: Strategy,
    *,
    price: Optional[Decimal],
    equity: Optional[Decimal],
) -> tuple[Decimal, dict[str, Any]]:
    """Resolve an integer share quantity from strategy settings.

    Precedence:
    - `min(max_notional_per_trade, equity * max_position_pct_equity)` when both are available
    - `max_notional_per_trade`
    - `equity * max_position_pct_equity`
    - global `TRADING_MAX_NOTIONAL_PER_TRADE` / `TRADING_MAX_POSITION_PCT_EQUITY`
    - global `TRADING_DEFAULT_QTY` fallback
    """

    default_qty = Decimal(str(settings.trading_default_qty))
    if price is None or price <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_price"}

    # Prefer strategy-level sizing. Treat global max_position_pct_equity as a risk cap, not a sizing target.
    max_notional = _optional_decimal(strategy.max_notional_per_trade)
    max_pct = _optional_decimal(strategy.max_position_pct_equity)

    pct_notional: Optional[Decimal] = None
    if equity is not None and max_pct is not None and max_pct > 0:
        pct_notional = equity * max_pct

    notional_budget: Optional[Decimal] = None
    method = "default_qty"
    if max_notional is not None and max_notional > 0 and pct_notional is not None:
        notional_budget = min(max_notional, pct_notional)
        method = "min(max_notional,pct_equity)"
    elif max_notional is not None and max_notional > 0:
        notional_budget = max_notional
        method = "max_notional_per_trade"
    elif pct_notional is not None:
        notional_budget = pct_notional
        method = "max_position_pct_equity"
    else:
        # Fall back to a global max_notional to avoid fixed-share trading when no strategy sizing is configured.
        global_notional = _optional_decimal(settings.trading_max_notional_per_trade)
        if global_notional is not None and global_notional > 0:
            notional_budget = global_notional
            method = "global_max_notional_per_trade"

    if notional_budget is None or notional_budget <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_budget"}

    qty = (notional_budget / price).quantize(Decimal("1"), rounding=ROUND_DOWN)
    if qty < 1:
        qty = Decimal("1")

    return qty, {"method": method, "notional_budget": str(notional_budget), "price": str(price)}


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
