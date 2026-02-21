"""Deterministic forecast routing and uncertainty contract for Torghut v5."""

from __future__ import annotations

import fnmatch
import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol, cast

from .features import FeatureVectorV3, optional_decimal


def _empty_dict() -> dict[str, Any]:
    return {}


def _decimal_or_default(value: Any, default: Decimal) -> Decimal:
    parsed = optional_decimal(value)
    return parsed if parsed is not None else default


def _clamp_decimal(value: Decimal, low: Decimal, high: Decimal) -> Decimal:
    return min(high, max(low, value))


def _deterministic_latency_ms(seed: str, *, floor: int, span: int) -> int:
    digest = hashlib.sha256(seed.encode('utf-8')).hexdigest()
    bucket = int(digest[:8], 16)
    return floor + (bucket % max(1, span))


def _coerce_horizon(value: str) -> str:
    cleaned = value.strip()
    if cleaned.endswith('Min'):
        return f'{cleaned[:-3]}m'
    if cleaned.endswith('Sec'):
        return f'{cleaned[:-3]}s'
    if cleaned.endswith('Hour'):
        return f'{cleaned[:-4]}h'
    return cleaned


@dataclass(frozen=True)
class ForecastInterval:
    p05: Decimal
    p50: Decimal
    p95: Decimal

    def is_valid(self) -> bool:
        return self.p05 <= self.p50 <= self.p95

    def to_payload(self) -> dict[str, str]:
        return {'p05': str(self.p05), 'p50': str(self.p50), 'p95': str(self.p95)}


@dataclass(frozen=True)
class ForecastUncertainty:
    epistemic: Decimal
    aleatoric: Decimal

    def to_payload(self) -> dict[str, str]:
        return {'epistemic': str(self.epistemic), 'aleatoric': str(self.aleatoric)}


@dataclass(frozen=True)
class ForecastFallback:
    applied: bool
    reason: str | None

    def to_payload(self) -> dict[str, object]:
        return {'applied': self.applied, 'reason': self.reason}


@dataclass(frozen=True)
class ForecastContractV1:
    schema_version: str
    symbol: str
    horizon: str
    event_ts: datetime
    model_family: str
    model_version: str
    route_key: str
    point_forecast: Decimal
    interval: ForecastInterval
    uncertainty: ForecastUncertainty
    calibration_score: Decimal
    fallback: ForecastFallback
    inference_latency_ms: int

    def to_payload(self) -> dict[str, object]:
        return {
            'schema_version': self.schema_version,
            'symbol': self.symbol,
            'horizon': self.horizon,
            'event_ts': self.event_ts.astimezone(timezone.utc).isoformat(),
            'model_family': self.model_family,
            'model_version': self.model_version,
            'route_key': self.route_key,
            'point_forecast': str(self.point_forecast),
            'interval': self.interval.to_payload(),
            'uncertainty': self.uncertainty.to_payload(),
            'calibration_score': str(self.calibration_score),
            'fallback': self.fallback.to_payload(),
            'inference_latency_ms': self.inference_latency_ms,
        }


@dataclass(frozen=True)
class ForecastDecisionAudit:
    schema_version: str
    event_ts: datetime
    route_key: str
    selected_model_family: str
    selected_model_version: str
    final_model_family: str
    final_model_version: str
    calibration_score: Decimal
    inference_latency_ms: int
    fallback_applied: bool
    fallback_reason: str | None
    policy_version: str

    def to_payload(self) -> dict[str, object]:
        return {
            'schema_version': self.schema_version,
            'event_ts': self.event_ts.astimezone(timezone.utc).isoformat(),
            'route_key': self.route_key,
            'selected_model_family': self.selected_model_family,
            'selected_model_version': self.selected_model_version,
            'final_model_family': self.final_model_family,
            'final_model_version': self.final_model_version,
            'calibration_score': str(self.calibration_score),
            'inference_latency_ms': self.inference_latency_ms,
            'fallback_applied': self.fallback_applied,
            'fallback_reason': self.fallback_reason,
            'policy_version': self.policy_version,
        }


@dataclass(frozen=True)
class ForecastRoutingTelemetry:
    model_family: str
    route_key: str
    symbol: str
    horizon: str
    inference_latency_ms: int
    calibration_error: Decimal
    fallback_reason: str | None

    def to_payload(self) -> dict[str, object]:
        return {
            'model_family': self.model_family,
            'route_key': self.route_key,
            'symbol': self.symbol,
            'horizon': self.horizon,
            'inference_latency_ms': self.inference_latency_ms,
            'calibration_error': str(self.calibration_error),
            'fallback_reason': self.fallback_reason,
        }


@dataclass(frozen=True)
class ForecastRouterPolicyEntry:
    symbol_glob: str
    horizon: str
    regime: str
    preferred_model_family: str
    candidate_fallbacks: tuple[str, ...]
    min_calibration_score: Decimal
    max_inference_latency_ms: int
    disable_refinement: bool

    def matches(self, *, symbol: str, horizon: str, regime: str) -> bool:
        return (
            fnmatch.fnmatch(symbol, self.symbol_glob)
            and (self.horizon == '*' or self.horizon == horizon)
            and (self.regime == '*' or self.regime == regime)
        )


@dataclass(frozen=True)
class ForecastRouterPolicyV1:
    policy_version: str
    entries: tuple[ForecastRouterPolicyEntry, ...]

    @classmethod
    def from_path(cls, path: Path) -> 'ForecastRouterPolicyV1':
        payload = json.loads(path.read_text(encoding='utf-8'))
        return cls.from_payload(cast(dict[str, Any], payload))

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> 'ForecastRouterPolicyV1':
        entries: list[ForecastRouterPolicyEntry] = []
        routes_raw = payload.get('routes')
        if isinstance(routes_raw, list):
            for raw_item in cast(list[Any], routes_raw):
                if not isinstance(raw_item, dict):
                    continue
                item = cast(dict[str, Any], raw_item)
                fallback_items = item.get('candidate_fallbacks', [])
                fallbacks = tuple(
                    str(fallback).strip()
                    for fallback in fallback_items
                    if isinstance(fallback, str) and fallback.strip()
                )
                entries.append(
                    ForecastRouterPolicyEntry(
                        symbol_glob=str(item.get('symbol_glob', '*')).strip() or '*',
                        horizon=_coerce_horizon(str(item.get('horizon', '*')).strip() or '*'),
                        regime=str(item.get('regime', '*')).strip() or '*',
                        preferred_model_family=(
                            str(item.get('preferred_model_family', 'chronos')).strip()
                            or 'chronos'
                        ),
                        candidate_fallbacks=fallbacks,
                        min_calibration_score=_decimal_or_default(
                            item.get('min_calibration_score'), Decimal('0.85')
                        ),
                        max_inference_latency_ms=max(
                            1, int(item.get('max_inference_latency_ms', 200))
                        ),
                        disable_refinement=bool(item.get('disable_refinement', False)),
                    )
                )

        if not entries:
            entries.append(
                ForecastRouterPolicyEntry(
                    symbol_glob='*',
                    horizon='*',
                    regime='*',
                    preferred_model_family='chronos',
                    candidate_fallbacks=('moment', 'financial_tsfm'),
                    min_calibration_score=Decimal('0.85'),
                    max_inference_latency_ms=200,
                    disable_refinement=False,
                )
            )

        return cls(
            policy_version=str(payload.get('policy_version', 'forecast_router_policy_v1')),
            entries=tuple(entries),
        )

    def resolve(self, *, symbol: str, horizon: str, regime: str) -> ForecastRouterPolicyEntry:
        for route in self.entries:
            if route.matches(symbol=symbol, horizon=horizon, regime=regime):
                return route
        return self.entries[0]


@dataclass(frozen=True)
class ForecastAdapterOutput:
    model_family: str
    model_version: str
    point_forecast: Decimal
    interval: ForecastInterval
    uncertainty: ForecastUncertainty
    inference_latency_ms: int


class ForecastAdapter(Protocol):
    model_family: str
    model_version: str

    def forecast(
        self,
        *,
        feature_vector: FeatureVectorV3,
        horizon: str,
    ) -> ForecastAdapterOutput:
        ...


class _DeterministicAdapter:
    model_family = 'unknown'
    model_version = 'unknown'
    _latency_floor = 30
    _latency_span = 45
    _bias = Decimal('0')
    _volatility_scale = Decimal('0.75')
    _epistemic_offset = Decimal('0.08')

    def forecast(
        self,
        *,
        feature_vector: FeatureVectorV3,
        horizon: str,
    ) -> ForecastAdapterOutput:
        price = optional_decimal(feature_vector.values.get('price')) or Decimal('0')
        macd = optional_decimal(feature_vector.values.get('macd')) or Decimal('0')
        macd_signal = optional_decimal(feature_vector.values.get('macd_signal')) or Decimal('0')
        vol = optional_decimal(feature_vector.values.get('vol_realized_w60s')) or Decimal('0.004')
        spread = optional_decimal(feature_vector.values.get('spread')) or Decimal('0.01')

        drift = (macd - macd_signal) * Decimal('0.8') + self._bias
        point = price + drift
        half_width = max(Decimal('0.01'), (vol * price * self._volatility_scale) + spread)

        interval = ForecastInterval(
            p05=(point - half_width).quantize(Decimal('0.0001')),
            p50=point.quantize(Decimal('0.0001')),
            p95=(point + half_width).quantize(Decimal('0.0001')),
        )
        uncertainty = ForecastUncertainty(
            epistemic=_clamp_decimal(
                (abs(drift) / max(Decimal('1'), price)) + self._epistemic_offset,
                Decimal('0.01'),
                Decimal('0.99'),
            ).quantize(Decimal('0.0001')),
            aleatoric=_clamp_decimal(
                (vol * Decimal('18')) + Decimal('0.05'), Decimal('0.01'), Decimal('0.99')
            ).quantize(Decimal('0.0001')),
        )
        seed = f'{feature_vector.normalization_hash}:{self.model_family}:{horizon}'
        latency = _deterministic_latency_ms(seed, floor=self._latency_floor, span=self._latency_span)
        return ForecastAdapterOutput(
            model_family=self.model_family,
            model_version=self.model_version,
            point_forecast=interval.p50,
            interval=interval,
            uncertainty=uncertainty,
            inference_latency_ms=latency,
        )


class ChronosForecastAdapter(_DeterministicAdapter):
    model_family = 'chronos'
    model_version = 'chronos-ft-fin-v1'
    _latency_floor = 45
    _latency_span = 70
    _bias = Decimal('0.03')
    _volatility_scale = Decimal('0.82')
    _epistemic_offset = Decimal('0.06')


class MomentForecastAdapter(_DeterministicAdapter):
    model_family = 'moment'
    model_version = 'moment-fin-v1'
    _latency_floor = 35
    _latency_span = 55
    _bias = Decimal('0.02')
    _volatility_scale = Decimal('0.78')
    _epistemic_offset = Decimal('0.07')


class FinancialTsfmForecastAdapter(_DeterministicAdapter):
    model_family = 'financial_tsfm'
    model_version = 'financial-tsfm-v1'
    _latency_floor = 55
    _latency_span = 85
    _bias = Decimal('0.04')
    _volatility_scale = Decimal('0.88')
    _epistemic_offset = Decimal('0.05')


class DeterministicBaselineAdapter(_DeterministicAdapter):
    model_family = 'baseline'
    model_version = 'baseline-deterministic-v1'
    _latency_floor = 8
    _latency_span = 12
    _bias = Decimal('0')
    _volatility_scale = Decimal('0.60')
    _epistemic_offset = Decimal('0.10')


@dataclass(frozen=True)
class ForecastCalibrationStore:
    defaults_by_family: dict[str, Decimal] = field(default_factory=_empty_dict)
    route_overrides: dict[str, dict[str, Decimal]] = field(default_factory=_empty_dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> 'ForecastCalibrationStore':
        defaults: dict[str, Decimal] = {}
        defaults_raw = payload.get('default_calibration_score_by_model_family')
        if isinstance(defaults_raw, dict):
            for family, score in cast(dict[str, Any], defaults_raw).items():
                defaults[family] = _decimal_or_default(score, Decimal('0.90'))

        overrides: dict[str, dict[str, Decimal]] = {}
        overrides_raw = payload.get('route_calibration_scores')
        if isinstance(overrides_raw, dict):
            for route_key, family_map in cast(dict[str, Any], overrides_raw).items():
                if not isinstance(family_map, dict):
                    continue
                normalized: dict[str, Decimal] = {}
                for family, score in cast(dict[str, Any], family_map).items():
                    normalized[family] = _decimal_or_default(score, Decimal('0.90'))
                overrides[route_key] = normalized

        return cls(defaults_by_family=defaults, route_overrides=overrides)

    def score(self, *, route_key: str, model_family: str) -> Decimal:
        route_map = self.route_overrides.get(route_key, {})
        if model_family in route_map:
            return route_map[model_family]
        if model_family in self.defaults_by_family:
            return self.defaults_by_family[model_family]
        return Decimal('0.90')


class ForecastRefinerV5:
    """Deterministic bridge-style refinement that narrows spread on clean signals."""

    def refine(
        self,
        contract: ForecastAdapterOutput,
        *,
        feature_vector: FeatureVectorV3,
    ) -> ForecastAdapterOutput:
        quality = str(feature_vector.values.get('signal_quality_flag') or '').strip().lower()
        shrink = Decimal('0.92') if quality in {'high', 'ok', 'healthy'} else Decimal('0.97')
        midpoint = contract.interval.p50
        low_delta = midpoint - contract.interval.p05
        high_delta = contract.interval.p95 - midpoint

        refined_interval = ForecastInterval(
            p05=(midpoint - (low_delta * shrink)).quantize(Decimal('0.0001')),
            p50=midpoint.quantize(Decimal('0.0001')),
            p95=(midpoint + (high_delta * shrink)).quantize(Decimal('0.0001')),
        )
        refined_uncertainty = ForecastUncertainty(
            epistemic=_clamp_decimal(
                contract.uncertainty.epistemic * Decimal('0.97'), Decimal('0.01'), Decimal('0.99')
            ).quantize(Decimal('0.0001')),
            aleatoric=_clamp_decimal(
                contract.uncertainty.aleatoric * shrink, Decimal('0.01'), Decimal('0.99')
            ).quantize(Decimal('0.0001')),
        )

        return ForecastAdapterOutput(
            model_family=contract.model_family,
            model_version=contract.model_version,
            point_forecast=contract.point_forecast.quantize(Decimal('0.0001')),
            interval=refined_interval,
            uncertainty=refined_uncertainty,
            inference_latency_ms=contract.inference_latency_ms,
        )


@dataclass(frozen=True)
class ForecastRouterResult:
    contract: ForecastContractV1
    audit: ForecastDecisionAudit
    telemetry: ForecastRoutingTelemetry


class ForecastRouterV5:
    """Route each symbol/horizon/regime key to a forecast adapter deterministically."""

    def __init__(
        self,
        *,
        policy: ForecastRouterPolicyV1,
        adapters: dict[str, ForecastAdapter],
        calibration_store: ForecastCalibrationStore,
        refiner: ForecastRefinerV5 | None,
    ) -> None:
        self.policy = policy
        self.adapters = dict(adapters)
        self.calibration_store = calibration_store
        self.refiner = refiner
        self._baseline_family = 'baseline'

    def route_and_forecast(
        self,
        *,
        feature_vector: FeatureVectorV3,
        horizon: str,
        event_ts: datetime,
    ) -> ForecastRouterResult:
        symbol = feature_vector.symbol
        resolved_horizon = _coerce_horizon(horizon)
        regime = self._resolve_regime(feature_vector)
        route_key = f'{symbol}|{resolved_horizon}|{regime}'
        route = self.policy.resolve(symbol=symbol, horizon=resolved_horizon, regime=regime)

        selected_family = route.preferred_model_family
        selected_adapter = self.adapters.get(selected_family)
        calibration = self.calibration_store.score(route_key=route_key, model_family=selected_family)
        fallback_reason: str | None = None

        if selected_adapter is None:
            fallback_reason = 'preferred_adapter_missing'

        if fallback_reason is None and calibration < route.min_calibration_score:
            fallback_reason = 'calibration_below_threshold'

        output: ForecastAdapterOutput | None = None
        if fallback_reason is None and selected_adapter is not None:
            output = selected_adapter.forecast(feature_vector=feature_vector, horizon=resolved_horizon)
            if output.inference_latency_ms > route.max_inference_latency_ms:
                fallback_reason = 'latency_slo_breach'
            elif not output.interval.is_valid():
                fallback_reason = 'invalid_interval_contract'

        final_family = selected_family
        if fallback_reason is not None:
            final_family, output = self._fallback_output(
                route=route,
                feature_vector=feature_vector,
                horizon=resolved_horizon,
                route_key=route_key,
            )

        assert output is not None
        if self.refiner is not None and not route.disable_refinement:
            output = self.refiner.refine(output, feature_vector=feature_vector)

        final_calibration = self.calibration_store.score(route_key=route_key, model_family=final_family)
        fallback = ForecastFallback(applied=fallback_reason is not None, reason=fallback_reason)

        contract = ForecastContractV1(
            schema_version='forecast_contract_v1',
            symbol=symbol,
            horizon=resolved_horizon,
            event_ts=event_ts.astimezone(timezone.utc),
            model_family=output.model_family,
            model_version=output.model_version,
            route_key=route_key,
            point_forecast=output.point_forecast.quantize(Decimal('0.0001')),
            interval=output.interval,
            uncertainty=output.uncertainty,
            calibration_score=final_calibration.quantize(Decimal('0.0001')),
            fallback=fallback,
            inference_latency_ms=output.inference_latency_ms,
        )
        selected_version = selected_adapter.model_version if selected_adapter is not None else 'missing'
        audit = ForecastDecisionAudit(
            schema_version='forecast_decision_audit_v1',
            event_ts=event_ts.astimezone(timezone.utc),
            route_key=route_key,
            selected_model_family=selected_family,
            selected_model_version=selected_version,
            final_model_family=output.model_family,
            final_model_version=output.model_version,
            calibration_score=final_calibration.quantize(Decimal('0.0001')),
            inference_latency_ms=output.inference_latency_ms,
            fallback_applied=fallback.applied,
            fallback_reason=fallback.reason,
            policy_version=self.policy.policy_version,
        )
        telemetry = ForecastRoutingTelemetry(
            model_family=output.model_family,
            route_key=route_key,
            symbol=symbol,
            horizon=resolved_horizon,
            inference_latency_ms=output.inference_latency_ms,
            calibration_error=(Decimal('1') - final_calibration).quantize(Decimal('0.0001')),
            fallback_reason=fallback.reason,
        )
        return ForecastRouterResult(contract=contract, audit=audit, telemetry=telemetry)

    def _resolve_regime(self, feature_vector: FeatureVectorV3) -> str:
        explicit = feature_vector.values.get('route_regime_label')
        if isinstance(explicit, str) and explicit.strip():
            return explicit.strip()
        macd = optional_decimal(feature_vector.values.get('macd')) or Decimal('0')
        signal = optional_decimal(feature_vector.values.get('macd_signal')) or Decimal('0')
        spread = macd - signal
        if spread >= Decimal('0.02'):
            return 'trend'
        if spread <= Decimal('-0.02'):
            return 'mean_revert'
        return 'range'

    def _fallback_output(
        self,
        *,
        route: ForecastRouterPolicyEntry,
        feature_vector: FeatureVectorV3,
        horizon: str,
        route_key: str,
    ) -> tuple[str, ForecastAdapterOutput]:
        for family in route.candidate_fallbacks:
            adapter = self.adapters.get(family)
            if adapter is None:
                continue
            score = self.calibration_store.score(route_key=route_key, model_family=family)
            if score < route.min_calibration_score:
                continue
            output = adapter.forecast(feature_vector=feature_vector, horizon=horizon)
            if output.interval.is_valid() and output.inference_latency_ms <= route.max_inference_latency_ms:
                return family, output

        baseline_adapter = self.adapters[self._baseline_family]
        return self._baseline_family, baseline_adapter.forecast(
            feature_vector=feature_vector,
            horizon=horizon,
        )


def build_default_forecast_router(*, policy_path: str | None, refinement_enabled: bool) -> ForecastRouterV5:
    policy_payload: dict[str, Any] = {}
    if policy_path:
        path = Path(policy_path)
        if path.exists():
            loaded = json.loads(path.read_text(encoding='utf-8'))
            if isinstance(loaded, dict):
                policy_payload = cast(dict[str, Any], loaded)

    policy = ForecastRouterPolicyV1.from_payload(policy_payload)
    calibration_store = ForecastCalibrationStore.from_payload(policy_payload)
    adapters: dict[str, ForecastAdapter] = {
        'chronos': ChronosForecastAdapter(),
        'moment': MomentForecastAdapter(),
        'financial_tsfm': FinancialTsfmForecastAdapter(),
        'baseline': DeterministicBaselineAdapter(),
    }
    refiner = ForecastRefinerV5() if refinement_enabled else None
    return ForecastRouterV5(
        policy=policy,
        adapters=adapters,
        calibration_store=calibration_store,
        refiner=refiner,
    )


__all__ = [
    'ForecastContractV1',
    'ForecastDecisionAudit',
    'ForecastRouterResult',
    'ForecastRouterV5',
    'ForecastRoutingTelemetry',
    'build_default_forecast_router',
]
