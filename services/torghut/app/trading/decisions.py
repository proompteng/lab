"""Trading decision engine based on TA signals."""

from __future__ import annotations
import logging
import re
from decimal import ROUND_DOWN, Decimal
from typing import Any, Iterable, Literal, Optional, cast

from ..config import settings
from ..models import Strategy
from .features import (
    FeatureNormalizationError,
    SignalFeatures,
    extract_signal_features,
    normalize_feature_vector_v3,
    optional_decimal,
)
from .models import SignalEnvelope, StrategyDecision
from .prices import MarketSnapshot, PriceFetcher
from .strategy_runtime import StrategyRuntime

logger = logging.getLogger(__name__)


class DecisionEngine:
    """Evaluate TA signals against configured strategies."""

    def __init__(self, price_fetcher: Optional[PriceFetcher] = None) -> None:
        self.price_fetcher = price_fetcher
        self.strategy_runtime = StrategyRuntime()

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
            signal_timeframe = _resolve_signal_timeframe(signal)
            if signal_timeframe is None:
                logger.debug(
                    "Skipping strategy %s because signal timeframe could not be resolved for symbol %s",
                    strategy.id,
                    signal.symbol,
                )
                continue
            if signal_timeframe != strategy.base_timeframe:
                logger.debug(
                    "Skipping strategy %s due to timeframe mismatch signal=%s strategy=%s",
                    strategy.id,
                    signal_timeframe,
                    strategy.base_timeframe,
                )
                continue
            if signal.timeframe != signal_timeframe:
                signal = signal.model_copy(update={"timeframe": signal_timeframe})
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
        features = extract_signal_features(signal)

        price = features.price
        snapshot: Optional[MarketSnapshot] = None
        if price is None and self.price_fetcher is not None:
            snapshot = self.price_fetcher.fetch_market_snapshot(signal)
            if snapshot is not None:
                price = snapshot.price

        action: Literal["buy", "sell"]
        rationale_parts: list[str]
        runtime_metadata: dict[str, Any]
        if settings.trading_strategy_runtime_mode == "plugin_v3":
            normalized_payload = dict(signal.payload)
            if price is not None and "price" not in normalized_payload:
                normalized_payload["price"] = price
            normalized_signal = signal.model_copy(update={"payload": normalized_payload})
            try:
                feature_vector = normalize_feature_vector_v3(normalized_signal)
            except FeatureNormalizationError:
                logger.debug("Feature normalization failed strategy=%s symbol=%s", strategy.id, signal.symbol)
                return None
            runtime_decision = self.strategy_runtime.evaluate(strategy, feature_vector, timeframe=timeframe)
            if runtime_decision is None:
                return None
            action = runtime_decision.intent.action
            rationale_parts = list(runtime_decision.intent.rationale)
            runtime_metadata = runtime_decision.metadata()
        else:
            if features.macd is None or features.macd_signal is None or features.rsi is None:
                logger.debug("Signal missing indicators for strategy %s", strategy.id)
                return None
            action = "buy"
            rationale_parts = []
            if features.macd > features.macd_signal and features.rsi < 35:
                action = "buy"
                rationale_parts.extend(["macd_cross_up", "rsi_oversold"])
            elif features.macd < features.macd_signal and features.rsi > 65:
                action = "sell"
                rationale_parts.extend(["macd_cross_down", "rsi_overbought"])
            else:
                return None
            runtime_metadata = {
                "plugin_id": "legacy_builtin",
                "plugin_version": "1.0.0",
                "parameter_hash": "legacy",
                "required_features": ["macd", "macd_signal", "rsi14", "price"],
            }
        if features.macd is None or features.macd_signal is None or features.rsi is None:
            return None

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
                macd=features.macd,
                macd_signal=features.macd_signal,
                rsi=features.rsi,
                price=price,
                volatility=features.volatility,
                snapshot=snapshot,
                runtime_metadata=runtime_metadata,
            )
            | {"sizing": sizing_meta},
        )


def _build_params(
    macd: Decimal,
    macd_signal: Decimal,
    rsi: Decimal,
    price: Optional[Decimal],
    volatility: Optional[Decimal],
    snapshot: Optional[MarketSnapshot],
    runtime_metadata: dict[str, Any],
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "macd": macd,
        "macd_signal": macd_signal,
        "rsi": rsi,
        "price": price,
        "strategy_runtime": runtime_metadata,
    }
    if volatility is not None:
        params["volatility"] = volatility
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
    max_notional = optional_decimal(strategy.max_notional_per_trade)
    max_pct = optional_decimal(strategy.max_position_pct_equity)

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
        global_notional = optional_decimal(settings.trading_max_notional_per_trade)
        if global_notional is not None and global_notional > 0:
            notional_budget = global_notional
            method = "global_max_notional_per_trade"

    if notional_budget is None or notional_budget <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_budget"}

    qty = (notional_budget / price).quantize(Decimal("1"), rounding=ROUND_DOWN)
    if qty < 1:
        qty = Decimal("1")

    return qty, {"method": method, "notional_budget": str(notional_budget), "price": str(price)}


def _resolve_signal_timeframe(signal: SignalEnvelope) -> Optional[str]:
    if signal.timeframe is not None:
        return signal.timeframe
    payload_map: dict[str, Any] = signal.payload

    timeframe = payload_map.get("timeframe")
    if isinstance(timeframe, str):
        return _coerce_timeframe(timeframe)

    window = payload_map.get("window")
    if isinstance(window, dict):
        window_payload = cast(dict[str, Any], window)
        window_size = window_payload.get("size")
        if isinstance(window_size, str):
            return _coerce_timeframe(window_size)

    window_size_payload = payload_map.get("window_size")
    if isinstance(window_size_payload, str):
        return _coerce_timeframe(window_size_payload)

    window_step = payload_map.get("window_step")
    if isinstance(window_step, str):
        return _coerce_timeframe(window_step)

    return None


def _coerce_timeframe(value: str) -> Optional[str]:
    legacy_match = re.fullmatch(
        r"(?i)\s*(\d+)\s*(sec|secs|s|min|minute|minutes|m|hour|hours|h)\s*",
        value,
    )
    if legacy_match is not None:
        amount = int(legacy_match.group(1))
        unit = legacy_match.group(2).lower()
        if unit in {"sec", "secs", "s"}:
            return f"{amount}Sec"
        if unit in {"min", "minute", "minutes", "m"}:
            return f"{amount}Min"
        if unit in {"hour", "hours", "h"}:
            return f"{amount}Hour"

    iso_match = re.fullmatch(r"PT(\d+)([SMH])", value)
    if iso_match is not None:
        amount = int(iso_match.group(1))
        unit = iso_match.group(2)
        if unit == "S":
            return f"{amount}Sec"
        if unit == "M":
            return f"{amount}Min"
        if unit == "H":
            return f"{amount}Hour"
    return None


__all__ = ["DecisionEngine", "SignalFeatures", "extract_signal_features"]
