"""Deterministic regime classifier for evaluation."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Literal, Optional

from .evaluation import WalkForwardDecision


VolatilityBucket = Literal["low", "mid", "high", "unknown"]
TrendBucket = Literal["up", "down", "flat", "unknown"]
LiquidityFlag = Literal["liquid", "illiquid", "unknown"]


@dataclass(frozen=True)
class RegimeLabel:
    volatility_bucket: VolatilityBucket
    trend_bucket: TrendBucket
    liquidity_flag: LiquidityFlag

    def label(self) -> str:
        return (
            f"vol={self.volatility_bucket}|trend={self.trend_bucket}"
            f"|liq={self.liquidity_flag}"
        )

    def to_payload(self) -> dict[str, str]:
        return {
            "label": self.label(),
            "volatility_bucket": self.volatility_bucket,
            "trend_bucket": self.trend_bucket,
            "liquidity_flag": self.liquidity_flag,
        }


def classify_regime(decisions: Iterable[WalkForwardDecision]) -> RegimeLabel:
    ordered = sorted(
        decisions,
        key=lambda item: (
            item.decision.event_ts,
            item.decision.symbol,
            item.decision.strategy_id,
        ),
    )
    prices: list[Decimal] = []
    volatilities: list[Decimal] = []
    macd_diffs: list[Decimal] = []
    missing_price = 0

    for item in ordered:
        features = item.features
        if features.price is None:
            missing_price += 1
        else:
            prices.append(features.price)
        if features.volatility is not None:
            volatilities.append(features.volatility)
        if features.macd is not None and features.macd_signal is not None:
            macd_diffs.append(features.macd - features.macd_signal)

    volatility_bucket = _classify_volatility(volatilities, prices)
    trend_bucket = _classify_trend(prices, macd_diffs)
    liquidity_flag = _classify_liquidity(prices, missing_price, len(ordered))
    return RegimeLabel(
        volatility_bucket=volatility_bucket,
        trend_bucket=trend_bucket,
        liquidity_flag=liquidity_flag,
    )


def _classify_volatility(
    volatilities: list[Decimal],
    prices: list[Decimal],
) -> VolatilityBucket:
    if volatilities:
        avg_vol = _decimal_mean(volatilities)
        if avg_vol < Decimal("0.01"):
            return "low"
        if avg_vol < Decimal("0.03"):
            return "mid"
        return "high"

    price_vol = _average_abs_pct_change(prices)
    if price_vol is None:
        return "unknown"
    if price_vol < Decimal("0.002"):
        return "low"
    if price_vol < Decimal("0.01"):
        return "mid"
    return "high"


def _classify_trend(
    prices: list[Decimal],
    macd_diffs: list[Decimal],
) -> TrendBucket:
    if len(prices) >= 2:
        start = prices[0]
        end = prices[-1]
        if start == 0:
            return "unknown"
        change = (end - start) / start
        if change >= Decimal("0.002"):
            return "up"
        if change <= Decimal("-0.002"):
            return "down"
        return "flat"

    if macd_diffs:
        avg_macd = _decimal_mean(macd_diffs)
        if avg_macd >= Decimal("0.05"):
            return "up"
        if avg_macd <= Decimal("-0.05"):
            return "down"
        return "flat"

    return "unknown"


def _classify_liquidity(
    prices: list[Decimal],
    missing_price: int,
    total: int,
) -> LiquidityFlag:
    if total == 0:
        return "unknown"
    missing_ratio = Decimal(str(missing_price)) / Decimal(str(total))
    if missing_ratio > Decimal("0.5"):
        return "illiquid"

    price_vol = _average_abs_pct_change(prices)
    if price_vol is None:
        return "unknown"
    if price_vol > Decimal("0.05"):
        return "illiquid"
    return "liquid"


def _average_abs_pct_change(prices: list[Decimal]) -> Optional[Decimal]:
    if len(prices) < 2:
        return None
    changes: list[Decimal] = []
    for prev, current in zip(prices, prices[1:]):
        if prev == 0:
            continue
        changes.append(abs((current - prev) / prev))
    if not changes:
        return None
    return _decimal_mean(changes)


def _decimal_mean(values: list[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    total = sum(values, Decimal("0"))
    return total / Decimal(str(len(values)))


__all__ = [
    "LiquidityFlag",
    "RegimeLabel",
    "TrendBucket",
    "VolatilityBucket",
    "classify_regime",
]
