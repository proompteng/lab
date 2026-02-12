"""Strategy runtime scaffolding for deterministic plugin execution."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal, Protocol

from ..models import Strategy
from .features import FeatureVectorV3


@dataclass(frozen=True)
class StrategyContext:
    strategy_id: str
    strategy_name: str
    strategy_type: str
    strategy_version: str
    event_ts: str
    symbol: str
    timeframe: str
    params: dict[str, Any]


@dataclass(frozen=True)
class StrategyIntent:
    action: Literal['buy', 'sell']
    confidence: Decimal
    rationale: tuple[str, ...]
    required_features: tuple[str, ...] = ('macd', 'macd_signal', 'rsi14', 'price')


@dataclass(frozen=True)
class RuntimeDecision:
    intent: StrategyIntent
    plugin_id: str
    plugin_version: str
    parameter_hash: str
    feature_hash: str

    def metadata(self) -> dict[str, Any]:
        return {
            'plugin_id': self.plugin_id,
            'plugin_version': self.plugin_version,
            'parameter_hash': self.parameter_hash,
            'feature_hash': self.feature_hash,
            'required_features': list(self.intent.required_features),
        }


class StrategyPlugin(Protocol):
    plugin_id: str
    version: str
    required_features: tuple[str, ...]

    def evaluate(self, context: StrategyContext, features: FeatureVectorV3) -> StrategyIntent | None:
        ...


class LegacyMacdRsiPlugin:
    plugin_id = 'legacy_macd_rsi'
    version = '1.0.0'
    required_features = ('macd', 'macd_signal', 'rsi14', 'price')

    def evaluate(self, context: StrategyContext, features: FeatureVectorV3) -> StrategyIntent | None:
        macd = _decimal(features.values.get('macd'))
        macd_signal = _decimal(features.values.get('macd_signal'))
        rsi14 = _decimal(features.values.get('rsi14'))
        if macd is None or macd_signal is None or rsi14 is None:
            return None
        if macd > macd_signal and rsi14 < Decimal('35'):
            return StrategyIntent(
                action='buy',
                confidence=Decimal('0.65'),
                rationale=('macd_cross_up', 'rsi_oversold'),
                required_features=self.required_features,
            )
        if macd < macd_signal and rsi14 > Decimal('65'):
            return StrategyIntent(
                action='sell',
                confidence=Decimal('0.65'),
                rationale=('macd_cross_down', 'rsi_overbought'),
                required_features=self.required_features,
            )
        return None


class IntradayTsmomPlugin:
    """Intraday trend-following plugin with stricter momentum/volatility filters."""

    plugin_id = 'intraday_tsmom'
    version = '1.1.0'
    required_features = ('price', 'ema12', 'ema26', 'macd', 'macd_signal', 'rsi14', 'vol_realized_w60s')

    def evaluate(self, context: StrategyContext, features: FeatureVectorV3) -> StrategyIntent | None:
        _ = context
        ema12 = _decimal(features.values.get('ema12'))
        ema26 = _decimal(features.values.get('ema26'))
        macd = _decimal(features.values.get('macd'))
        macd_signal = _decimal(features.values.get('macd_signal'))
        rsi14 = _decimal(features.values.get('rsi14'))
        vol = _decimal(features.values.get('vol_realized_w60s'))

        if ema12 is None or ema26 is None or macd is None or macd_signal is None or rsi14 is None:
            return None

        macd_hist = macd - macd_signal
        trend_up = ema12 > ema26 and macd > macd_signal
        trend_down = ema12 < ema26 and macd < macd_signal
        # Profit-focused filter: avoid noisy low-conviction and high-volatility windows.
        vol_ok = vol is None or (Decimal('0.001') <= vol <= Decimal('0.012'))

        if trend_up and vol_ok and macd_hist >= Decimal('0.04') and Decimal('52') <= rsi14 <= Decimal('62'):
            confidence = Decimal('0.64')
            if macd_hist >= Decimal('0.10'):
                confidence += Decimal('0.05')
            if vol is not None and vol <= Decimal('0.008'):
                confidence += Decimal('0.03')
            return StrategyIntent(
                action='buy',
                confidence=min(confidence, Decimal('0.82')),
                rationale=('tsmom_trend_up', 'momentum_confirmed', 'volatility_within_budget'),
                required_features=self.required_features,
            )

        if trend_down and rsi14 >= Decimal('66') and (macd_signal - macd) >= Decimal('0.06'):
            confidence = Decimal('0.62')
            if rsi14 >= Decimal('72'):
                confidence += Decimal('0.03')
            return StrategyIntent(
                action='sell',
                confidence=min(confidence, Decimal('0.78')),
                rationale=('tsmom_trend_down', 'momentum_reversal_exit'),
                required_features=self.required_features,
            )

        return None


class StrategyRuntime:
    """Deterministic strategy plugin runtime for phase-1/phase-2 scaffolding."""

    def __init__(self, plugins: dict[str, StrategyPlugin] | None = None) -> None:
        self.plugins = plugins or {
            'legacy_macd_rsi': LegacyMacdRsiPlugin(),
            'intraday_tsmom_v1': IntradayTsmomPlugin(),
        }

    def evaluate(self, strategy: Strategy, features: FeatureVectorV3, *, timeframe: str) -> RuntimeDecision | None:
        plugin_type = self._strategy_plugin_type(strategy)
        plugin = self.plugins.get(plugin_type)
        if plugin is None:
            return None
        context = StrategyContext(
            strategy_id=str(strategy.id),
            strategy_name=str(strategy.name),
            strategy_type=plugin_type,
            strategy_version=self._strategy_version(strategy),
            event_ts=features.event_ts.isoformat(),
            symbol=features.symbol,
            timeframe=timeframe,
            params=self._strategy_params(strategy),
        )
        intent = plugin.evaluate(context, features)
        if intent is None:
            return None
        return RuntimeDecision(
            intent=intent,
            plugin_id=plugin.plugin_id,
            plugin_version=plugin.version,
            parameter_hash=self._parameter_hash(context.params),
            feature_hash=features.normalization_hash,
        )

    @staticmethod
    def _strategy_plugin_type(strategy: Strategy) -> str:
        raw = getattr(strategy, 'universe_type', None)
        if not raw:
            return 'legacy_macd_rsi'
        if str(raw) in {'static', 'legacy_macd_rsi'}:
            return 'legacy_macd_rsi'
        if str(raw) in {'intraday_tsmom', 'intraday_tsmom_v1', 'tsmom_intraday'}:
            return 'intraday_tsmom_v1'
        return str(raw)

    @staticmethod
    def _strategy_version(strategy: Strategy) -> str:
        if strategy.description and 'version=' in strategy.description:
            segments = [segment.strip() for segment in strategy.description.split(',')]
            for segment in segments:
                if segment.startswith('version='):
                    return segment.split('=', 1)[1] or '1.0.0'
        return '1.0.0'

    @staticmethod
    def _strategy_params(strategy: Strategy) -> dict[str, Any]:
        return {
            'max_position_pct_equity': str(strategy.max_position_pct_equity)
            if strategy.max_position_pct_equity is not None
            else None,
            'max_notional_per_trade': str(strategy.max_notional_per_trade)
            if strategy.max_notional_per_trade is not None
            else None,
            'base_timeframe': strategy.base_timeframe,
            'universe_symbols': strategy.universe_symbols,
        }

    @staticmethod
    def _parameter_hash(params: dict[str, Any]) -> str:
        payload = json.dumps(params, sort_keys=True, separators=(',', ':'), default=str)
        return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None
