from __future__ import annotations

from datetime import datetime, timezone

from app.trading.features import (
    FeatureVectorV3,
)
from app.trading.strategy_runtime import (
    PluginEvaluationResult,
    StrategyContext,
)


class _FailingPlugin:
    plugin_id = "failing"
    version = "1.0.0"
    required_features = ("macd",)

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        _ = context
        _ = features
        raise RuntimeError("boom")


def _test_feature_vector(
    values: dict[str, object],
    *,
    event_ts: datetime | None = None,
    symbol: str = "META",
) -> FeatureVectorV3:
    return FeatureVectorV3(
        event_ts=event_ts or datetime(2026, 3, 24, 14, 30, 0, tzinfo=timezone.utc),
        symbol=symbol,
        timeframe="1Sec",
        seq=1,
        source="unit-test",
        feature_schema_version="v3",
        values=values,
        normalization_hash="unit-hash",
    )
