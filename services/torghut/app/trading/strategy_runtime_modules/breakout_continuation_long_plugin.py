# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Strategy runtime scaffolding for deterministic plugin execution."""

from __future__ import annotations

import hashlib
import json
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal, Protocol, cast

from ...models import Strategy
from ...strategies.catalog import extract_catalog_metadata
from ..evaluation_trace import GateTrace, StrategyTrace, ThresholdTrace
from ..features import FeatureVectorV3, validate_declared_features
from ..intraday_tsmom_contract import evaluate_intraday_tsmom_signal
from ..research_sleeves import (
    SleeveSignalEvaluation,
    SleeveSignalResult,
    evaluate_breakout_continuation_long,
    evaluate_end_of_day_reversal_long,
    evaluate_late_day_continuation_long,
    evaluate_mean_reversion_exhaustion_short,
    evaluate_mean_reversion_rebound_long,
    evaluate_momentum_pullback_long,
    evaluate_washout_rebound_long,
)
from ..session_context import regular_session_minutes_elapsed
from ..strategy_specs import (
    build_compiled_strategy_artifacts,
    strategy_type_supports_spec_v2,
)

# ruff: noqa: F401,F811,F821

from .empty_meta import (
    decimal as _decimal,
    empty_meta as _empty_meta,
    generic_plugin_trace as _generic_plugin_trace,
    microbar_entry_window_minutes as _microbar_entry_window_minutes,
    microbar_exit_minute_after_open as _microbar_exit_minute_after_open,
    microbar_minutes_elapsed as _microbar_minutes_elapsed,
    microbar_observed_rank_universe_size as _microbar_observed_rank_universe_size,
    microbar_pair_max_legs as _microbar_pair_max_legs,
    microbar_pair_rank_thresholds as _microbar_pair_rank_thresholds,
    microbar_pair_side_count as _microbar_pair_side_count,
    microbar_rank_thresholds as _microbar_rank_thresholds,
    microbar_rank_universe_size as _microbar_rank_universe_size,
    microbar_required_features as _microbar_required_features,
    microbar_runtime_position_qty as _microbar_runtime_position_qty,
    microbar_universe_size as _microbar_universe_size,
    plugin_result_from_sleeve_result as _plugin_result_from_sleeve_result,
)
from .evaluate_microbar_cross_sectional import (
    AggregatedIntent,
    PluginEvaluationResult,
    RuntimeDecision,
    RuntimeErrorRecord,
    RuntimeEvaluation,
    RuntimeObservation,
    StrategyContext,
    StrategyDefinition,
    StrategyIntent,
    StrategyPlugin,
    evaluate_microbar_cross_sectional as _evaluate_microbar_cross_sectional,
)
from .coerce_plugin_result import (
    IntentAggregator,
    IntradayTsmomPlugin,
    LegacyMacdRsiPlugin,
    MomentumPullbackLongPlugin,
    StrategyRegistry,
    CircuitState as _CircuitState,
    coerce_plugin_result as _coerce_plugin_result,
    trace_suppression_reason as _trace_suppression_reason,
)


class BreakoutContinuationLongPlugin:
    plugin_id = "breakout_continuation_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "ema26",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "spread_bps",
        "price_vs_vwap_w5m_bps",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "price_vs_opening_range_high_bps",
        "price_vs_opening_window_close_bps",
        "opening_range_width_bps",
        "session_high_price",
        "opening_range_high",
        "session_range_bps",
        "price_position_in_session_range",
        "recent_spread_bps_avg",
        "recent_spread_bps_max",
        "recent_imbalance_pressure_avg",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "recent_above_opening_window_close_ratio",
        "cross_section_positive_session_open_ratio",
        "cross_section_positive_opening_window_return_ratio",
        "cross_section_positive_prev_session_close_ratio",
        "cross_section_positive_opening_window_return_from_prev_close_ratio",
        "cross_section_above_vwap_w5m_ratio",
        "cross_section_continuation_breadth",
        "cross_section_session_open_rank",
        "cross_section_opening_window_return_rank",
        "cross_section_prev_session_close_rank",
        "cross_section_opening_window_return_from_prev_close_rank",
        "cross_section_range_position_rank",
        "cross_section_vwap_w5m_rank",
        "cross_section_recent_imbalance_rank",
        "cross_section_continuation_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_breakout_continuation_long(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            ema26=_decimal(features.values.get("ema26")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(
                features.values.get("price_vs_session_open_bps")
            ),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(
                features.values.get("opening_window_return_bps")
            ),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_vs_opening_range_high_bps=_decimal(
                features.values.get("price_vs_opening_range_high_bps")
            ),
            price_vs_opening_window_close_bps=_decimal(
                features.values.get("price_vs_opening_window_close_bps")
            ),
            opening_range_width_bps=_decimal(
                features.values.get("opening_range_width_bps")
            ),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            price_position_in_session_range=_decimal(
                features.values.get("price_position_in_session_range")
            ),
            price_vs_vwap_w5m_bps=_decimal(
                features.values.get("price_vs_vwap_w5m_bps")
            ),
            session_high_price=_decimal(features.values.get("session_high_price")),
            opening_range_high=_decimal(features.values.get("opening_range_high")),
            recent_spread_bps_avg=_decimal(
                features.values.get("recent_spread_bps_avg")
            ),
            recent_spread_bps_max=_decimal(
                features.values.get("recent_spread_bps_max")
            ),
            recent_imbalance_pressure_avg=_decimal(
                features.values.get("recent_imbalance_pressure_avg")
            ),
            recent_quote_invalid_ratio=_decimal(
                features.values.get("recent_quote_invalid_ratio")
            ),
            recent_quote_jump_bps_max=_decimal(
                features.values.get("recent_quote_jump_bps_max")
            ),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            recent_above_opening_range_high_ratio=_decimal(
                features.values.get("recent_above_opening_range_high_ratio")
            ),
            recent_above_opening_window_close_ratio=_decimal(
                features.values.get("recent_above_opening_window_close_ratio")
            ),
            recent_above_vwap_w5m_ratio=_decimal(
                features.values.get("recent_above_vwap_w5m_ratio")
            ),
            cross_section_positive_session_open_ratio=_decimal(
                features.values.get("cross_section_positive_session_open_ratio")
            ),
            cross_section_positive_opening_window_return_ratio=_decimal(
                features.values.get(
                    "cross_section_positive_opening_window_return_ratio"
                )
            ),
            cross_section_positive_prev_session_close_ratio=_decimal(
                features.values.get("cross_section_positive_prev_session_close_ratio")
            ),
            cross_section_positive_opening_window_return_from_prev_close_ratio=_decimal(
                features.values.get(
                    "cross_section_positive_opening_window_return_from_prev_close_ratio"
                )
            ),
            cross_section_above_vwap_w5m_ratio=_decimal(
                features.values.get("cross_section_above_vwap_w5m_ratio")
            ),
            cross_section_continuation_breadth=_decimal(
                features.values.get("cross_section_continuation_breadth")
            ),
            cross_section_session_open_rank=_decimal(
                features.values.get("cross_section_session_open_rank")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_prev_session_close_rank=_decimal(
                features.values.get("cross_section_prev_session_close_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get(
                    "cross_section_opening_window_return_from_prev_close_rank"
                )
            ),
            cross_section_range_position_rank=_decimal(
                features.values.get("cross_section_range_position_rank")
            ),
            cross_section_vwap_w5m_rank=_decimal(
                features.values.get("cross_section_vwap_w5m_rank")
            ),
            cross_section_recent_imbalance_rank=_decimal(
                features.values.get("cross_section_recent_imbalance_rank")
            ),
            cross_section_continuation_rank=_decimal(
                features.values.get("cross_section_continuation_rank")
            ),
        )
        return _plugin_result_from_sleeve_result(
            context=context,
            features=features,
            required_features=self.required_features,
            evaluation=evaluation,
        )


class MeanReversionReboundLongPlugin:
    plugin_id = "mean_reversion_rebound_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "spread_bps",
        "vwap_session",
        "imbalance_bid_sz",
        "imbalance_ask_sz",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "price_position_in_session_range",
        "price_vs_opening_range_low_bps",
        "session_range_bps",
        "recent_spread_bps_avg",
        "recent_spread_bps_max",
        "recent_imbalance_pressure_avg",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "cross_section_opening_window_return_rank",
        "cross_section_opening_window_return_from_prev_close_rank",
        "cross_section_continuation_rank",
        "cross_section_reversal_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_mean_reversion_rebound_long(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            vwap_session=_decimal(features.values.get("vwap_session")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(
                features.values.get("price_vs_session_open_bps")
            ),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(
                features.values.get("opening_window_return_bps")
            ),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(
                features.values.get("price_position_in_session_range")
            ),
            price_vs_opening_range_low_bps=_decimal(
                features.values.get("price_vs_opening_range_low_bps")
            ),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_spread_bps_avg=_decimal(
                features.values.get("recent_spread_bps_avg")
            ),
            recent_spread_bps_max=_decimal(
                features.values.get("recent_spread_bps_max")
            ),
            recent_imbalance_pressure_avg=_decimal(
                features.values.get("recent_imbalance_pressure_avg")
            ),
            recent_quote_invalid_ratio=_decimal(
                features.values.get("recent_quote_invalid_ratio")
            ),
            recent_quote_jump_bps_max=_decimal(
                features.values.get("recent_quote_jump_bps_max")
            ),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get(
                    "cross_section_opening_window_return_from_prev_close_rank"
                )
            ),
            cross_section_continuation_rank=_decimal(
                features.values.get("cross_section_continuation_rank")
            ),
            cross_section_reversal_rank=_decimal(
                features.values.get("cross_section_reversal_rank")
            ),
        )
        return _plugin_result_from_sleeve_result(
            context=context,
            features=features,
            required_features=self.required_features,
            evaluation=evaluation,
        )


class MeanReversionExhaustionShortPlugin:
    plugin_id = "mean_reversion_exhaustion_short"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "spread_bps",
        "vwap_session",
        "imbalance_bid_sz",
        "imbalance_ask_sz",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "price_position_in_session_range",
        "price_vs_opening_range_high_bps",
        "session_range_bps",
        "recent_spread_bps_avg",
        "recent_spread_bps_max",
        "recent_imbalance_pressure_avg",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "cross_section_opening_window_return_rank",
        "cross_section_opening_window_return_from_prev_close_rank",
        "cross_section_continuation_rank",
        "cross_section_reversal_rank",
        "cross_section_session_open_rank",
        "cross_section_prev_session_close_rank",
        "cross_section_range_position_rank",
        "cross_section_vwap_w5m_rank",
        "cross_section_recent_imbalance_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_mean_reversion_exhaustion_short(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            vwap_session=_decimal(features.values.get("vwap_session")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(
                features.values.get("price_vs_session_open_bps")
            ),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(
                features.values.get("opening_window_return_bps")
            ),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(
                features.values.get("price_position_in_session_range")
            ),
            price_vs_opening_range_high_bps=_decimal(
                features.values.get("price_vs_opening_range_high_bps")
            ),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_spread_bps_avg=_decimal(
                features.values.get("recent_spread_bps_avg")
            ),
            recent_spread_bps_max=_decimal(
                features.values.get("recent_spread_bps_max")
            ),
            recent_imbalance_pressure_avg=_decimal(
                features.values.get("recent_imbalance_pressure_avg")
            ),
            recent_quote_invalid_ratio=_decimal(
                features.values.get("recent_quote_invalid_ratio")
            ),
            recent_quote_jump_bps_max=_decimal(
                features.values.get("recent_quote_jump_bps_max")
            ),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get(
                    "cross_section_opening_window_return_from_prev_close_rank"
                )
            ),
            cross_section_continuation_rank=_decimal(
                features.values.get("cross_section_continuation_rank")
            ),
            cross_section_reversal_rank=_decimal(
                features.values.get("cross_section_reversal_rank")
            ),
            cross_section_session_open_rank=_decimal(
                features.values.get("cross_section_session_open_rank")
            ),
            cross_section_prev_session_close_rank=_decimal(
                features.values.get("cross_section_prev_session_close_rank")
            ),
            cross_section_range_position_rank=_decimal(
                features.values.get("cross_section_range_position_rank")
            ),
            cross_section_vwap_w5m_rank=_decimal(
                features.values.get("cross_section_vwap_w5m_rank")
            ),
            cross_section_recent_imbalance_rank=_decimal(
                features.values.get("cross_section_recent_imbalance_rank")
            ),
        )
        return _plugin_result_from_sleeve_result(
            context=context,
            features=features,
            required_features=self.required_features,
            evaluation=evaluation,
        )


class MicrobarCrossSectionalLongPlugin:
    plugin_id = "microbar_cross_sectional_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "macd",
        "macd_signal",
        "rsi14",
        "session_minutes_elapsed",
        "cross_section_continuation_breadth",
        "cross_section_session_open_rank",
        "cross_section_vwap_w5m_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        return _evaluate_microbar_cross_sectional(
            context=context,
            features=features,
            entry_action="buy",
            exit_action="sell",
        )


class MicrobarCrossSectionalShortPlugin:
    plugin_id = "microbar_cross_sectional_short"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "macd",
        "macd_signal",
        "rsi14",
        "session_minutes_elapsed",
        "cross_section_continuation_breadth",
        "cross_section_session_open_rank",
        "cross_section_vwap_w5m_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        return _evaluate_microbar_cross_sectional(
            context=context,
            features=features,
            entry_action="sell",
            exit_action="buy",
        )


class MicrobarCrossSectionalPairsPlugin:
    plugin_id = "microbar_cross_sectional_pairs"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "macd",
        "macd_signal",
        "rsi14",
        "session_minutes_elapsed",
        "cross_section_continuation_breadth",
        "cross_section_session_open_rank",
        "cross_section_vwap_w5m_rank",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        return _evaluate_microbar_cross_sectional(
            context=context,
            features=features,
            entry_action="buy",
            exit_action="sell",
            pair_mode=True,
        )


class WashoutReboundLongPlugin:
    plugin_id = "washout_rebound_long"
    version = "1.0.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
        "vwap_session",
        "spread_bps",
        "imbalance_bid_sz",
        "imbalance_ask_sz",
        "price_vs_session_open_bps",
        "price_vs_prev_session_close_bps",
        "opening_window_return_bps",
        "opening_window_return_from_prev_close_bps",
        "price_position_in_session_range",
        "price_vs_session_low_bps",
        "price_vs_opening_range_low_bps",
        "session_range_bps",
        "recent_spread_bps_avg",
        "recent_spread_bps_max",
        "recent_imbalance_pressure_avg",
        "recent_quote_invalid_ratio",
        "recent_quote_jump_bps_max",
        "recent_microprice_bias_bps_avg",
        "recent_above_vwap_w5m_ratio",
        "cross_section_opening_window_return_rank",
        "cross_section_opening_window_return_from_prev_close_rank",
        "cross_section_continuation_rank",
        "cross_section_reversal_rank",
        "cross_section_recent_imbalance_rank",
        "cross_section_positive_recent_imbalance_ratio",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> PluginEvaluationResult:
        evaluation = evaluate_washout_rebound_long(
            params=context.params,
            strategy_id=context.strategy_id,
            strategy_type=context.strategy_type,
            symbol=context.symbol,
            event_ts=context.event_ts,
            timeframe=context.timeframe,
            trace_enabled=context.trace_enabled,
            price=_decimal(features.values.get("price")),
            ema12=_decimal(features.values.get("ema12")),
            macd=_decimal(features.values.get("macd")),
            macd_signal=_decimal(features.values.get("macd_signal")),
            rsi14=_decimal(features.values.get("rsi14")),
            vol_realized_w60s=_decimal(features.values.get("vol_realized_w60s")),
            vwap_session=_decimal(features.values.get("vwap_session")),
            spread_bps=_decimal(features.values.get("spread_bps")),
            imbalance_bid_sz=_decimal(features.values.get("imbalance_bid_sz")),
            imbalance_ask_sz=_decimal(features.values.get("imbalance_ask_sz")),
            price_vs_session_open_bps=_decimal(
                features.values.get("price_vs_session_open_bps")
            ),
            price_vs_prev_session_close_bps=_decimal(
                features.values.get("price_vs_prev_session_close_bps")
            ),
            opening_window_return_bps=_decimal(
                features.values.get("opening_window_return_bps")
            ),
            opening_window_return_from_prev_close_bps=_decimal(
                features.values.get("opening_window_return_from_prev_close_bps")
            ),
            price_position_in_session_range=_decimal(
                features.values.get("price_position_in_session_range")
            ),
            price_vs_session_low_bps=_decimal(
                features.values.get("price_vs_session_low_bps")
            ),
            price_vs_opening_range_low_bps=_decimal(
                features.values.get("price_vs_opening_range_low_bps")
            ),
            session_range_bps=_decimal(features.values.get("session_range_bps")),
            recent_spread_bps_avg=_decimal(
                features.values.get("recent_spread_bps_avg")
            ),
            recent_spread_bps_max=_decimal(
                features.values.get("recent_spread_bps_max")
            ),
            recent_imbalance_pressure_avg=_decimal(
                features.values.get("recent_imbalance_pressure_avg")
            ),
            recent_quote_invalid_ratio=_decimal(
                features.values.get("recent_quote_invalid_ratio")
            ),
            recent_quote_jump_bps_max=_decimal(
                features.values.get("recent_quote_jump_bps_max")
            ),
            recent_microprice_bias_bps_avg=_decimal(
                features.values.get("recent_microprice_bias_bps_avg")
            ),
            recent_above_vwap_w5m_ratio=_decimal(
                features.values.get("recent_above_vwap_w5m_ratio")
            ),
            cross_section_opening_window_return_rank=_decimal(
                features.values.get("cross_section_opening_window_return_rank")
            ),
            cross_section_opening_window_return_from_prev_close_rank=_decimal(
                features.values.get(
                    "cross_section_opening_window_return_from_prev_close_rank"
                )
            ),
            cross_section_continuation_rank=_decimal(
                features.values.get("cross_section_continuation_rank")
            ),
            cross_section_reversal_rank=_decimal(
                features.values.get("cross_section_reversal_rank")
            ),
            cross_section_recent_imbalance_rank=_decimal(
                features.values.get("cross_section_recent_imbalance_rank")
            ),
            cross_section_positive_recent_imbalance_ratio=_decimal(
                features.values.get("cross_section_positive_recent_imbalance_ratio")
            ),
        )
        return _plugin_result_from_sleeve_result(
            context=context,
            features=features,
            required_features=self.required_features,
            evaluation=evaluation,
        )


__all__ = (
    "BreakoutContinuationLongPlugin",
    "MeanReversionReboundLongPlugin",
    "MeanReversionExhaustionShortPlugin",
    "MicrobarCrossSectionalLongPlugin",
    "MicrobarCrossSectionalShortPlugin",
    "MicrobarCrossSectionalPairsPlugin",
    "WashoutReboundLongPlugin",
)
