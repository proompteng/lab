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

from ..models import Strategy
from ..strategies.catalog import extract_catalog_metadata
from .features import FeatureVectorV3, validate_declared_features
from .intraday_tsmom_contract import evaluate_intraday_tsmom_signal
from .strategy_specs import build_compiled_strategy_artifacts, strategy_type_supports_spec_v2


def _empty_meta() -> dict[str, Any]:
    return {}


@dataclass(frozen=True)
class StrategyDefinition:
    strategy_id: str
    strategy_name: str
    declared_strategy_id: str
    strategy_type: str
    version: str
    params: dict[str, Any]
    feature_requirements: tuple[str, ...]
    risk_profile: str
    execution_profile: str
    enabled: bool
    base_timeframe: str
    compiler_source: str = "legacy_runtime"
    strategy_spec: dict[str, Any] = field(default_factory=_empty_meta)
    compiled_targets: dict[str, Any] = field(default_factory=_empty_meta)


@dataclass(frozen=True)
class StrategyContext:
    strategy_id: str
    strategy_name: str
    declared_strategy_id: str
    strategy_type: str
    strategy_version: str
    event_ts: str
    symbol: str
    timeframe: str
    params: dict[str, Any]
    strategy_spec: dict[str, Any] = field(default_factory=_empty_meta)


@dataclass(frozen=True)
class StrategyIntent:
    strategy_id: str
    symbol: str
    direction: Literal["buy", "sell"]
    confidence: Decimal
    target_notional: Decimal
    horizon: str
    explain: tuple[str, ...]
    feature_snapshot_hash: str
    required_features: tuple[str, ...]

    @property
    def action(self) -> Literal["buy", "sell"]:
        return self.direction

    @property
    def rationale(self) -> tuple[str, ...]:
        return self.explain


@dataclass(frozen=True)
class AggregatedIntent:
    symbol: str
    direction: Literal["buy", "sell"]
    confidence: Decimal
    target_notional: Decimal
    horizon: str
    explain: tuple[str, ...]
    source_strategy_ids: tuple[str, ...]
    feature_snapshot_hashes: tuple[str, ...]


@dataclass(frozen=True)
class RuntimeDecision:
    intent: StrategyIntent
    strategy_row_id: str
    declared_strategy_id: str
    strategy_name: str
    strategy_type: str
    strategy_version: str
    plugin_id: str
    plugin_version: str
    parameter_hash: str
    feature_hash: str
    compiler_source: str = "legacy_runtime"
    strategy_spec: dict[str, Any] = field(default_factory=_empty_meta)
    compiled_targets: dict[str, Any] = field(default_factory=_empty_meta)

    def metadata(self) -> dict[str, Any]:
        return {
            "strategy_row_id": self.strategy_row_id,
            "declared_strategy_id": self.declared_strategy_id,
            "strategy_name": self.strategy_name,
            "strategy_type": self.strategy_type,
            "strategy_version": self.strategy_version,
            "plugin_id": self.plugin_id,
            "plugin_version": self.plugin_version,
            "parameter_hash": self.parameter_hash,
            "feature_hash": self.feature_hash,
            "required_features": list(self.intent.required_features),
            "compiler_source": self.compiler_source,
            "strategy_spec_v2": dict(self.strategy_spec),
            "compiled_targets": dict(self.compiled_targets),
        }


@dataclass(frozen=True)
class RuntimeErrorRecord:
    strategy_id: str
    strategy_type: str
    plugin_id: str
    reason: str


@dataclass
class RuntimeObservation:
    strategy_events_total: dict[str, int] = field(default_factory=lambda: {})
    strategy_intents_total: dict[str, int] = field(default_factory=lambda: {})
    strategy_errors_total: dict[str, int] = field(default_factory=lambda: {})
    strategy_latency_ms: dict[str, int] = field(default_factory=lambda: {})
    intent_conflicts_total: int = 0
    isolated_failures_total: int = 0

    def record_event(self, strategy_id: str, latency_ms: int) -> None:
        self.strategy_events_total[strategy_id] = (
            self.strategy_events_total.get(strategy_id, 0) + 1
        )
        self.strategy_latency_ms[strategy_id] = latency_ms

    def record_intent(self, strategy_id: str) -> None:
        self.strategy_intents_total[strategy_id] = (
            self.strategy_intents_total.get(strategy_id, 0) + 1
        )

    def record_error(self, strategy_id: str) -> None:
        self.strategy_errors_total[strategy_id] = (
            self.strategy_errors_total.get(strategy_id, 0) + 1
        )
        self.isolated_failures_total += 1


@dataclass(frozen=True)
class RuntimeEvaluation:
    intents: list[AggregatedIntent]
    raw_intents: list[RuntimeDecision]
    errors: list[RuntimeErrorRecord]
    observation: RuntimeObservation


class StrategyPlugin(Protocol):
    plugin_id: str
    version: str
    required_features: tuple[str, ...]

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> StrategyIntent | None: ...


@dataclass
class _CircuitState:
    consecutive_errors: int = 0
    degraded_until: datetime | None = None


class StrategyRegistry:
    def __init__(
        self,
        plugins: dict[str, StrategyPlugin] | None = None,
        *,
        circuit_error_threshold: int = 3,
        cooldown_seconds: int = 300,
    ) -> None:
        plugin_map = plugins or {
            "legacy_macd_rsi": LegacyMacdRsiPlugin(),
            "intraday_tsmom_v1": IntradayTsmomPlugin(),
        }
        self._by_key: dict[tuple[str, str], StrategyPlugin] = {}
        self._type_alias: dict[str, tuple[str, str]] = {}
        for alias, plugin in plugin_map.items():
            normalized_alias = alias.strip()
            self._type_alias[normalized_alias] = (plugin.plugin_id, plugin.version)
            self._by_key[(plugin.plugin_id, plugin.version)] = plugin
        self.circuit_error_threshold = max(1, circuit_error_threshold)
        self.cooldown_seconds = max(1, cooldown_seconds)
        self._circuit_state: dict[str, _CircuitState] = {}

    def resolve(self, definition: StrategyDefinition) -> StrategyPlugin | None:
        explicit = self._by_key.get((definition.strategy_type, definition.version))
        if explicit is not None:
            return explicit
        alias = self._type_alias.get(definition.strategy_type)
        if alias is not None:
            return self._by_key.get(alias)
        # Deterministic fallback: pin the lowest lexical version for a matching strategy type.
        candidates = sorted(
            [
                (plugin_id, plugin_version)
                for plugin_id, plugin_version in self._by_key
                if plugin_id == definition.strategy_type
            ]
        )
        if not candidates:
            return None
        return self._by_key[candidates[0]]

    def is_degraded(self, strategy_id: str, *, event_ts: datetime) -> bool:
        state = self._circuit_state.get(strategy_id)
        if state is None or state.degraded_until is None:
            return False
        return event_ts.astimezone(timezone.utc) <= state.degraded_until

    def record_success(self, strategy_id: str) -> None:
        state = self._circuit_state.get(strategy_id)
        if state is None:
            return
        state.consecutive_errors = 0

    def record_error(self, strategy_id: str, *, event_ts: datetime) -> None:
        state = self._circuit_state.setdefault(strategy_id, _CircuitState())
        state.consecutive_errors += 1
        if state.consecutive_errors >= self.circuit_error_threshold:
            state.degraded_until = event_ts.astimezone(timezone.utc) + timedelta(
                seconds=self.cooldown_seconds
            )
            state.consecutive_errors = 0


class IntentAggregator:
    """Aggregate strategy intents to one symbol-level direction deterministically."""

    def aggregate(
        self, intents: list[StrategyIntent]
    ) -> tuple[list[AggregatedIntent], int]:
        grouped: dict[tuple[str, str], list[StrategyIntent]] = defaultdict(list)
        for intent in intents:
            grouped[(intent.symbol, intent.horizon)].append(intent)

        aggregated: list[AggregatedIntent] = []
        conflicts = 0
        for (symbol, horizon), bucket in sorted(grouped.items()):
            ranked = sorted(
                bucket,
                key=lambda item: (
                    -item.confidence,
                    -item.target_notional,
                    item.strategy_id,
                ),
            )
            directions = {item.direction for item in ranked}
            if len(directions) > 1:
                conflicts += 1

            net_score = Decimal("0")
            total_notional = Decimal("0")
            for intent in ranked:
                signed = (
                    intent.target_notional
                    if intent.direction == "buy"
                    else -intent.target_notional
                )
                net_score += intent.confidence * signed
                total_notional += abs(intent.target_notional)

            if net_score == 0:
                winner = ranked[0]
                direction = winner.direction
            else:
                direction = "buy" if net_score > 0 else "sell"

            selected = [intent for intent in ranked if intent.direction == direction]
            confidence = sum(
                (intent.confidence for intent in selected),
                Decimal("0"),
            ) / Decimal(len(selected))
            selected_notional = sum(
                (intent.target_notional for intent in selected),
                Decimal("0"),
            )
            top_reasons = selected[0].explain if selected else ranked[0].explain
            if len(directions) > 1:
                top_reasons = top_reasons + ("intent_conflict_resolved",)
            resolved_notional = (
                selected_notional if selected_notional > 0 else total_notional
            )
            source_intents = selected if selected else ranked
            source_strategy_ids = tuple(
                dict.fromkeys(intent.strategy_id for intent in source_intents)
            )

            aggregated.append(
                AggregatedIntent(
                    symbol=symbol,
                    direction=direction,
                    confidence=confidence.quantize(Decimal("0.0001")),
                    target_notional=resolved_notional.quantize(Decimal("0.0001")),
                    horizon=horizon,
                    explain=top_reasons,
                    source_strategy_ids=source_strategy_ids,
                    feature_snapshot_hashes=tuple(
                        sorted({item.feature_snapshot_hash for item in ranked})
                    ),
                )
            )
        return aggregated, conflicts


class LegacyMacdRsiPlugin:
    plugin_id = "legacy_macd_rsi"
    version = "1.0.0"
    required_features: tuple[str, ...] = ("macd", "macd_signal", "rsi14", "price")

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> StrategyIntent | None:
        macd = _decimal(features.values.get("macd"))
        macd_signal = _decimal(features.values.get("macd_signal"))
        rsi14 = _decimal(features.values.get("rsi14"))
        target_notional = _target_notional(context.params)
        if macd is None or macd_signal is None or rsi14 is None:
            return None
        if macd > macd_signal and rsi14 < Decimal("35"):
            return StrategyIntent(
                strategy_id=context.strategy_id,
                symbol=context.symbol,
                direction="buy",
                confidence=Decimal("0.65"),
                target_notional=target_notional,
                horizon=context.timeframe,
                explain=("macd_cross_up", "rsi_oversold"),
                feature_snapshot_hash=features.normalization_hash,
                required_features=self.required_features,
            )
        if macd < macd_signal and rsi14 > Decimal("65"):
            return StrategyIntent(
                strategy_id=context.strategy_id,
                symbol=context.symbol,
                direction="sell",
                confidence=Decimal("0.65"),
                target_notional=target_notional,
                horizon=context.timeframe,
                explain=("macd_cross_down", "rsi_overbought"),
                feature_snapshot_hash=features.normalization_hash,
                required_features=self.required_features,
            )
        return None


class IntradayTsmomPlugin:
    """Intraday trend-following plugin with stricter momentum/volatility filters."""

    plugin_id = "intraday_tsmom"
    version = "1.1.0"
    required_features: tuple[str, ...] = (
        "price",
        "ema12",
        "ema26",
        "macd",
        "macd_signal",
        "rsi14",
        "vol_realized_w60s",
    )

    def evaluate(
        self, context: StrategyContext, features: FeatureVectorV3
    ) -> StrategyIntent | None:
        ema12 = _decimal(features.values.get("ema12"))
        ema26 = _decimal(features.values.get("ema26"))
        macd = _decimal(features.values.get("macd"))
        macd_signal = _decimal(features.values.get("macd_signal"))
        rsi14 = _decimal(features.values.get("rsi14"))
        vol = _decimal(features.values.get("vol_realized_w60s"))
        evaluation = evaluate_intraday_tsmom_signal(
            timeframe=context.timeframe,
            params=context.params,
            ema12=ema12,
            ema26=ema26,
            macd=macd,
            macd_signal=macd_signal,
            rsi14=rsi14,
            vol_realized_w60s=vol,
        )
        if evaluation is None:
            return None

        target_notional = _target_notional(context.params)
        direction = "buy" if evaluation.direction == "long" else "sell"
        confidence_cap = Decimal("0.84") if evaluation.direction == "long" else Decimal("0.80")
        return StrategyIntent(
            strategy_id=context.strategy_id,
            symbol=context.symbol,
            direction=direction,
            confidence=min(evaluation.confidence, confidence_cap),
            target_notional=target_notional,
            horizon=context.timeframe,
            explain=evaluation.rationale,
            feature_snapshot_hash=features.normalization_hash,
            required_features=self.required_features,
        )


class StrategyRuntime:
    """Deterministic strategy plugin runtime with failure isolation."""

    def __init__(
        self,
        *,
        registry: StrategyRegistry | None = None,
        aggregator: IntentAggregator | None = None,
    ) -> None:
        self.registry = registry or StrategyRegistry()
        self.aggregator = aggregator or IntentAggregator()

    def evaluate(
        self, strategy: Strategy, features: FeatureVectorV3, *, timeframe: str
    ) -> RuntimeDecision | None:
        definition = self.definition_from_strategy(strategy)
        plugin = self.registry.resolve(definition)
        if plugin is None:
            return None
        declared_valid, _ = validate_declared_features(plugin.required_features)
        if not declared_valid:
            return None
        context = StrategyContext(
            strategy_id=definition.strategy_id,
            strategy_name=definition.strategy_name,
            declared_strategy_id=definition.declared_strategy_id,
            strategy_type=definition.strategy_type,
            strategy_version=definition.version,
            event_ts=features.event_ts.isoformat(),
            symbol=features.symbol,
            timeframe=timeframe,
            params=definition.params,
            strategy_spec=dict(definition.strategy_spec),
        )
        intent = plugin.evaluate(context, features)
        if intent is None:
            return None
        return RuntimeDecision(
            intent=intent,
            strategy_row_id=definition.strategy_id,
            declared_strategy_id=definition.declared_strategy_id,
            strategy_name=definition.strategy_name,
            strategy_type=definition.strategy_type,
            strategy_version=definition.version,
            plugin_id=plugin.plugin_id,
            plugin_version=plugin.version,
            parameter_hash=self._parameter_hash(context.params),
            feature_hash=features.normalization_hash,
            compiler_source=definition.compiler_source,
            strategy_spec=dict(definition.strategy_spec),
            compiled_targets=dict(definition.compiled_targets),
        )

    def evaluate_all(
        self, strategies: list[Strategy], features: FeatureVectorV3, *, timeframe: str
    ) -> RuntimeEvaluation:
        raw_intents: list[RuntimeDecision] = []
        errors: list[RuntimeErrorRecord] = []
        observation = RuntimeObservation()
        all_intents: list[StrategyIntent] = []

        sorted_definitions = sorted(
            [
                self.definition_from_strategy(strategy)
                for strategy in strategies
                if strategy.enabled
            ],
            key=lambda item: item.strategy_id,
        )
        for definition in sorted_definitions:
            if definition.base_timeframe != timeframe:
                continue
            start = time.perf_counter()
            if self.registry.is_degraded(
                definition.strategy_id, event_ts=features.event_ts
            ):
                observation.record_error(definition.strategy_id)
                errors.append(
                    RuntimeErrorRecord(
                        strategy_id=definition.strategy_id,
                        strategy_type=definition.strategy_type,
                        plugin_id="circuit_breaker",
                        reason="strategy_degraded",
                    )
                )
                continue

            plugin = self.registry.resolve(definition)
            if plugin is None:
                observation.record_error(definition.strategy_id)
                errors.append(
                    RuntimeErrorRecord(
                        strategy_id=definition.strategy_id,
                        strategy_type=definition.strategy_type,
                        plugin_id="unregistered",
                        reason="plugin_not_found",
                    )
                )
                continue

            context = StrategyContext(
                strategy_id=definition.strategy_id,
                strategy_name=definition.strategy_name,
                declared_strategy_id=definition.declared_strategy_id,
                strategy_type=definition.strategy_type,
                strategy_version=definition.version,
                event_ts=features.event_ts.isoformat(),
                symbol=features.symbol,
                timeframe=timeframe,
                params=definition.params,
                strategy_spec=dict(definition.strategy_spec),
            )

            try:
                intent = plugin.evaluate(context, features)
                latency_ms = int((time.perf_counter() - start) * 1000)
                observation.record_event(definition.strategy_id, latency_ms)
                self.registry.record_success(definition.strategy_id)
                if intent is None:
                    continue
                decision = RuntimeDecision(
                    intent=intent,
                    strategy_row_id=definition.strategy_id,
                    declared_strategy_id=definition.declared_strategy_id,
                    strategy_name=definition.strategy_name,
                    strategy_type=definition.strategy_type,
                    strategy_version=definition.version,
                    plugin_id=plugin.plugin_id,
                    plugin_version=plugin.version,
                    parameter_hash=self._parameter_hash(context.params),
                    feature_hash=features.normalization_hash,
                    compiler_source=definition.compiler_source,
                    strategy_spec=dict(definition.strategy_spec),
                    compiled_targets=dict(definition.compiled_targets),
                )
                raw_intents.append(decision)
                all_intents.append(intent)
                observation.record_intent(definition.strategy_id)
            except Exception as exc:
                latency_ms = int((time.perf_counter() - start) * 1000)
                observation.record_event(definition.strategy_id, latency_ms)
                observation.record_error(definition.strategy_id)
                self.registry.record_error(
                    definition.strategy_id, event_ts=features.event_ts
                )
                errors.append(
                    RuntimeErrorRecord(
                        strategy_id=definition.strategy_id,
                        strategy_type=definition.strategy_type,
                        plugin_id=plugin.plugin_id,
                        reason=type(exc).__name__,
                    )
                )

        aggregated_intents, conflicts = self.aggregator.aggregate(all_intents)
        observation.intent_conflicts_total = conflicts
        return RuntimeEvaluation(
            intents=aggregated_intents,
            raw_intents=raw_intents,
            errors=errors,
            observation=observation,
        )

    @staticmethod
    def definition_from_strategy(strategy: Strategy) -> StrategyDefinition:
        catalog_metadata = StrategyRuntime._catalog_metadata(strategy)
        strategy_type = StrategyRuntime._strategy_plugin_type(strategy)
        version = StrategyRuntime._strategy_version(strategy)
        params = StrategyRuntime._strategy_params(strategy)
        compiler_source = str(catalog_metadata.get("compiler_source") or "legacy_runtime")
        strategy_spec = (
            cast(dict[str, Any], catalog_metadata.get("strategy_spec_v2"))
            if isinstance(catalog_metadata.get("strategy_spec_v2"), dict)
            else {}
        )
        compiled_targets = (
            cast(dict[str, Any], catalog_metadata.get("compiled_targets"))
            if isinstance(catalog_metadata.get("compiled_targets"), dict)
            else {}
        )
        declared_strategy_id = (
            str(catalog_metadata.get("strategy_id") or "").strip()
            or str(strategy.name)
        )
        if strategy_type_supports_spec_v2(strategy_type):
            compiler_source = "spec_v2"
            if not strategy_spec or not compiled_targets:
                raw_universe_symbols: object = strategy.universe_symbols
                universe_symbols: list[str] | None = None
                if isinstance(raw_universe_symbols, list):
                    universe_symbols = []
                    for raw_item in cast(list[object], raw_universe_symbols):
                        item_text = str(raw_item).strip()
                        if item_text:
                            universe_symbols.append(item_text)
                compiled = build_compiled_strategy_artifacts(
                    strategy_id=declared_strategy_id,
                    strategy_type=strategy_type,
                    semantic_version=version,
                    params=params,
                    base_timeframe=str(strategy.base_timeframe),
                    universe_symbols=universe_symbols,
                    source="spec_v2",
                )
                strategy_spec = compiled.strategy_spec.to_payload()
                compiled_targets = {
                    "evaluator_config": compiled.evaluator_config,
                    "shadow_runtime_config": compiled.shadow_runtime_config,
                    "live_runtime_config": compiled.live_runtime_config,
                    "promotion_metadata": compiled.promotion_metadata,
                }
        return StrategyDefinition(
            strategy_id=str(strategy.id),
            strategy_name=str(strategy.name),
            declared_strategy_id=declared_strategy_id,
            strategy_type=strategy_type,
            version=version,
            params=params,
            feature_requirements=("macd", "macd_signal", "rsi14", "price"),
            risk_profile="default",
            execution_profile="market",
            enabled=bool(strategy.enabled),
            base_timeframe=str(strategy.base_timeframe),
            compiler_source=compiler_source,
            strategy_spec=strategy_spec,
            compiled_targets=compiled_targets,
        )

    @staticmethod
    def _strategy_plugin_type(strategy: Strategy) -> str:
        metadata = StrategyRuntime._catalog_metadata(strategy)
        metadata_type = str(metadata.get("strategy_type") or "").strip()
        if metadata_type:
            return str(metadata_type)
        raw = getattr(strategy, "universe_type", None)
        if not raw:
            return "legacy_macd_rsi"
        if str(raw) in {"static", "legacy_macd_rsi"}:
            return "legacy_macd_rsi"
        if str(raw) in {"intraday_tsmom", "intraday_tsmom_v1", "tsmom_intraday"}:
            return "intraday_tsmom_v1"
        return str(raw)

    @staticmethod
    def _strategy_version(strategy: Strategy) -> str:
        metadata = StrategyRuntime._catalog_metadata(strategy)
        metadata_version = str(metadata.get("version") or "").strip()
        if metadata_version:
            return metadata_version
        if strategy.description:
            description = str(strategy.description)
            if "version=" in description:
                segments = [segment.strip() for segment in description.split(",")]
                for segment in segments:
                    if segment.startswith("version="):
                        return segment.split("=", 1)[1] or "1.0.0"
            marker_start = description.rfind("@")
            marker_end = description.rfind(")")
            if marker_start >= 0:
                candidate_end = marker_end if marker_end > marker_start else len(description)
                candidate = description[marker_start + 1 : candidate_end].strip()
                if candidate:
                    return candidate
            tokens = description.split()
            if tokens:
                last = tokens[-1].lstrip("v")
                if last and any(ch.isdigit() for ch in last):
                    return last
        return "1.0.0"

    @staticmethod
    def _strategy_params(strategy: Strategy) -> dict[str, Any]:
        metadata = StrategyRuntime._catalog_metadata(strategy)
        params = (
            dict(cast(dict[str, Any], metadata.get("params")))
            if isinstance(metadata.get("params"), dict)
            else {}
        )
        params.setdefault(
            "max_position_pct_equity",
            str(strategy.max_position_pct_equity)
            if strategy.max_position_pct_equity is not None
            else None,
        )
        params.setdefault(
            "max_notional_per_trade",
            str(strategy.max_notional_per_trade)
            if strategy.max_notional_per_trade is not None
            else None,
        )
        params.setdefault("base_timeframe", strategy.base_timeframe)
        params.setdefault("universe_symbols", strategy.universe_symbols)
        return params

    @staticmethod
    def _catalog_metadata(strategy: Strategy) -> dict[str, Any]:
        return extract_catalog_metadata(
            str(strategy.description) if strategy.description is not None else None
        )

    @staticmethod
    def _parameter_hash(params: dict[str, Any]) -> str:
        payload = json.dumps(params, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _target_notional(params: dict[str, Any]) -> Decimal:
    notional = _decimal(params.get("max_notional_per_trade"))
    if notional is None or notional <= 0:
        return Decimal("100")
    return notional
