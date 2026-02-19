"""Trading decision engine based on TA signals."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
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
from .strategy_runtime import (
    RuntimeErrorRecord,
    RuntimeObservation,
    StrategyRegistry,
    StrategyRuntime,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DecisionRuntimeTelemetry:
    mode: str
    runtime_enabled: bool
    fallback_to_legacy: bool
    errors: tuple[RuntimeErrorRecord, ...] = field(default_factory=tuple)
    observation: RuntimeObservation | None = None


class DecisionEngine:
    """Evaluate TA signals against configured strategies."""

    def __init__(self, price_fetcher: Optional[PriceFetcher] = None) -> None:
        self.price_fetcher = price_fetcher
        self.strategy_runtime = StrategyRuntime(
            registry=StrategyRegistry(
                circuit_error_threshold=settings.trading_strategy_runtime_circuit_errors,
                cooldown_seconds=settings.trading_strategy_runtime_circuit_cooldown_seconds,
            )
        )
        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode="legacy",
            runtime_enabled=False,
            fallback_to_legacy=False,
        )

    def evaluate(
        self,
        signal: SignalEnvelope,
        strategies: Iterable[Strategy],
        *,
        equity: Optional[Decimal] = None,
    ) -> list[StrategyDecision]:
        filtered = [strategy for strategy in strategies if strategy.enabled]
        timeframe = _resolve_signal_timeframe(signal)
        if timeframe is None:
            self._last_runtime_telemetry = DecisionRuntimeTelemetry(
                mode="legacy",
                runtime_enabled=False,
                fallback_to_legacy=False,
            )
            return []
        if signal.timeframe != timeframe:
            signal = signal.model_copy(update={"timeframe": timeframe})

        runtime_enabled = _runtime_enabled()
        if runtime_enabled:
            decisions = self._evaluate_with_runtime(signal, filtered, equity=equity)
            if decisions:
                return decisions
            if settings.trading_strategy_runtime_fallback_legacy:
                runtime_telemetry = self._last_runtime_telemetry
                legacy_decisions = self._evaluate_legacy(
                    signal, filtered, equity=equity
                )
                self._last_runtime_telemetry = DecisionRuntimeTelemetry(
                    mode=settings.trading_strategy_runtime_mode,
                    runtime_enabled=True,
                    fallback_to_legacy=True,
                    errors=runtime_telemetry.errors,
                    observation=runtime_telemetry.observation,
                )
                return legacy_decisions
            return []

        return self._evaluate_legacy(signal, filtered, equity=equity)

    def consume_runtime_telemetry(self) -> DecisionRuntimeTelemetry:
        telemetry = self._last_runtime_telemetry
        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode="legacy",
            runtime_enabled=False,
            fallback_to_legacy=False,
        )
        return telemetry

    def _evaluate_with_runtime(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Optional[Decimal],
    ) -> list[StrategyDecision]:
        timeframe = signal.timeframe
        if timeframe is None:
            return []
        features = extract_signal_features(signal)

        price = features.price
        snapshot: Optional[MarketSnapshot] = None
        if price is None and self.price_fetcher is not None:
            snapshot = self.price_fetcher.fetch_market_snapshot(signal)
            if snapshot is not None:
                price = snapshot.price

        normalized_payload = dict(signal.payload)
        if price is not None and "price" not in normalized_payload:
            normalized_payload["price"] = price
        normalized_signal = signal.model_copy(update={"payload": normalized_payload})
        try:
            feature_vector = normalize_feature_vector_v3(normalized_signal)
        except FeatureNormalizationError:
            logger.debug("Feature normalization failed symbol=%s", signal.symbol)
            self._last_runtime_telemetry = DecisionRuntimeTelemetry(
                mode=settings.trading_strategy_runtime_mode,
                runtime_enabled=True,
                fallback_to_legacy=False,
            )
            return []

        runtime_eval = self.strategy_runtime.evaluate_all(
            strategies, feature_vector, timeframe=timeframe
        )
        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode=settings.trading_strategy_runtime_mode,
            runtime_enabled=True,
            fallback_to_legacy=False,
            errors=tuple(runtime_eval.errors),
            observation=runtime_eval.observation,
        )

        decisions: list[StrategyDecision] = []
        if not runtime_eval.intents:
            return decisions

        strategies_by_id = {str(strategy.id): strategy for strategy in strategies}
        for intent in runtime_eval.intents:
            source_strategy_ids = list(intent.source_strategy_ids)
            primary_strategy_id = source_strategy_ids[0] if source_strategy_ids else None
            if primary_strategy_id is None:
                logger.warning(
                    "Skipping aggregated intent without source strategy symbol=%s horizon=%s",
                    intent.symbol,
                    intent.horizon,
                )
                continue
            source_strategies = [
                strategies_by_id[strategy_id]
                for strategy_id in source_strategy_ids
                if strategy_id in strategies_by_id
            ]
            qty, sizing_meta = _resolve_qty_for_aggregated(
                source_strategies, price=price, equity=equity
            )
            decisions.append(
                StrategyDecision(
                    strategy_id=primary_strategy_id,
                    symbol=intent.symbol,
                    event_ts=signal.event_ts,
                    timeframe=timeframe,
                    action=intent.direction,
                    qty=qty,
                    order_type="market",
                    time_in_force="day",
                    rationale=",".join(intent.explain),
                    params=_build_params(
                        macd=features.macd,
                        macd_signal=features.macd_signal,
                        rsi=features.rsi,
                        price=price,
                        volatility=features.volatility,
                        snapshot=snapshot,
                        runtime_metadata={
                            "mode": settings.trading_strategy_runtime_mode,
                            "aggregated": True,
                            "source_strategy_ids": source_strategy_ids,
                            "feature_snapshot_hashes": list(
                                intent.feature_snapshot_hashes
                            ),
                            "intent_conflicts_total": runtime_eval.observation.intent_conflicts_total,
                            "strategy_errors": [
                                {
                                    "strategy_id": error.strategy_id,
                                    "strategy_type": error.strategy_type,
                                    "plugin_id": error.plugin_id,
                                    "reason": error.reason,
                                }
                                for error in runtime_eval.errors
                            ],
                        },
                    )
                    | {"sizing": sizing_meta},
                )
            )
        return decisions

    def _evaluate_legacy(
        self,
        signal: SignalEnvelope,
        strategies: list[Strategy],
        *,
        equity: Optional[Decimal],
    ) -> list[StrategyDecision]:
        decisions: list[StrategyDecision] = []
        timeframe = signal.timeframe
        if timeframe is None:
            return decisions

        for strategy in strategies:
            if timeframe != strategy.base_timeframe:
                logger.debug(
                    "Skipping strategy %s due to timeframe mismatch signal=%s strategy=%s",
                    strategy.id,
                    timeframe,
                    strategy.base_timeframe,
                )
                continue
            decision = self._evaluate_legacy_strategy(signal, strategy, equity=equity)
            if decision is not None:
                decisions.append(decision)

        self._last_runtime_telemetry = DecisionRuntimeTelemetry(
            mode="legacy",
            runtime_enabled=False,
            fallback_to_legacy=False,
        )
        return decisions

    def _evaluate_legacy_strategy(
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

        if (
            features.macd is None
            or features.macd_signal is None
            or features.rsi is None
        ):
            logger.debug("Signal missing indicators for strategy %s", strategy.id)
            return None

        action: Literal["buy", "sell"]
        rationale_parts: list[str]
        if features.macd > features.macd_signal and features.rsi < 35:
            action = "buy"
            rationale_parts = ["macd_cross_up", "rsi_oversold"]
        elif features.macd < features.macd_signal and features.rsi > 65:
            action = "sell"
            rationale_parts = ["macd_cross_down", "rsi_overbought"]
        else:
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
            rationale=",".join(rationale_parts),
            params=_build_params(
                macd=features.macd,
                macd_signal=features.macd_signal,
                rsi=features.rsi,
                price=price,
                volatility=features.volatility,
                snapshot=snapshot,
                runtime_metadata={
                    "plugin_id": "legacy_builtin",
                    "plugin_version": "1.0.0",
                    "parameter_hash": "legacy",
                    "required_features": ["macd", "macd_signal", "rsi14", "price"],
                },
            )
            | {"sizing": sizing_meta},
        )


def _build_params(
    macd: Decimal | None,
    macd_signal: Decimal | None,
    rsi: Decimal | None,
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

    return qty, {
        "method": method,
        "notional_budget": str(notional_budget),
        "price": str(price),
    }


def _resolve_qty_for_aggregated(
    strategies: list[Strategy],
    *,
    price: Optional[Decimal],
    equity: Optional[Decimal],
) -> tuple[Decimal, dict[str, Any]]:
    default_qty = Decimal(str(settings.trading_default_qty))
    if price is None or price <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_price"}
    if not strategies:
        return default_qty, {"method": "default_qty", "reason": "no_strategies"}

    total_budget = Decimal("0")
    for strategy in strategies:
        budget = optional_decimal(strategy.max_notional_per_trade)
        if budget is not None and budget > 0:
            total_budget += budget
    if total_budget <= 0:
        global_budget = optional_decimal(settings.trading_max_notional_per_trade)
        if global_budget is not None and global_budget > 0:
            total_budget = global_budget
    if total_budget <= 0 and equity is not None:
        pct = optional_decimal(settings.trading_max_position_pct_equity)
        if pct is not None and pct > 0:
            total_budget = equity * pct
    if total_budget <= 0:
        return default_qty, {"method": "default_qty", "reason": "missing_budget"}

    qty = (total_budget / price).quantize(Decimal("1"), rounding=ROUND_DOWN)
    if qty < 1:
        qty = Decimal("1")
    return qty, {
        "method": "aggregated_notional_budget",
        "notional_budget": str(total_budget),
        "price": str(price),
    }


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


def _runtime_enabled() -> bool:
    mode = settings.trading_strategy_runtime_mode
    if mode == "plugin_v3":
        return True
    if mode == "scheduler_v3":
        return settings.trading_strategy_scheduler_enabled
    return False


__all__ = [
    "DecisionEngine",
    "DecisionRuntimeTelemetry",
    "SignalFeatures",
    "extract_signal_features",
]
