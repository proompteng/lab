"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Mapping, cast

from sqlalchemy.orm import Session


from ...config import settings
from ..evaluation import (
    WalkForwardDecision,
)
from ..evidence_contracts import (
    contract_from_artifact_payload,
)
from ..features import (
    FeatureNormalizationError,
    normalize_feature_vector_v3,
)
from ..forecasting import build_default_forecast_router
from ..llm.evaluation import build_llm_evaluation_metrics
from ..models import SignalEnvelope
from ..tca import build_tca_gate_inputs


def _coerce_fragility_state(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"normal", "elevated", "stress", "crisis"}:
        return normalized
    return None


def _fragility_state_rank(state: str) -> int:
    normalized = state.strip().lower()
    if normalized == "normal":
        return 0
    if normalized == "elevated":
        return 1
    if normalized == "stress":
        return 2
    return 3


def _coerce_fragility_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off", ""}:
            return False
    return None


def _coerce_fragility_score(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None
    if not parsed.is_finite():
        return None
    return parsed


def _coerce_fragility_measurement(
    payload: dict[str, object],
) -> tuple[str, Decimal, bool] | None:
    state = _coerce_fragility_state(payload.get("fragility_state"))
    score = _coerce_fragility_score(payload.get("fragility_score"))
    stability = _coerce_fragility_bool(payload.get("stability_mode_active"))
    if state is None or score is None or stability is None:
        return None
    return (state, score, stability)


def _is_more_worse_fragility(
    candidate: tuple[str, Decimal, bool], current: tuple[str, Decimal, bool]
) -> bool:
    candidate_rank = _fragility_state_rank(candidate[0])
    current_rank = _fragility_state_rank(current[0])
    if candidate_rank != current_rank:
        return candidate_rank > current_rank
    if candidate[1] != current[1]:
        return candidate[1] > current[1]
    return not candidate[2] and current[2]


def _resolve_gate_fragility_inputs(
    *,
    metrics_payload: dict[str, object],
    decisions: list[WalkForwardDecision],
) -> tuple[str, Decimal, bool, bool]:
    fallback_measurement = _coerce_fragility_measurement(
        {
            "fragility_state": metrics_payload.get("fragility_state"),
            "fragility_score": metrics_payload.get("fragility_score"),
            "stability_mode_active": metrics_payload.get("stability_mode_active"),
        }
    )
    selected_measurement: tuple[str, Decimal, bool] | None = None

    for item in decisions:
        params = item.decision.params
        allocator_payload = params.get("allocator")
        allocator: dict[str, Any] = (
            dict(cast(Mapping[str, Any], allocator_payload))
            if isinstance(allocator_payload, Mapping)
            else {}
        )
        snapshot_payload = params.get("fragility_snapshot")
        snapshot: dict[str, Any] = (
            dict(cast(Mapping[str, Any], snapshot_payload))
            if isinstance(snapshot_payload, Mapping)
            else {}
        )

        raw_state = allocator.get("fragility_state")
        if raw_state is None:
            raw_state = snapshot.get("fragility_state")
        if raw_state is None:
            raw_state = params.get("fragility_state")

        raw_score = allocator.get("fragility_score")
        if raw_score is None:
            raw_score = snapshot.get("fragility_score")
        if raw_score is None:
            raw_score = params.get("fragility_score")

        raw_stability = allocator.get("stability_mode_active")
        if raw_stability is None:
            raw_stability = params.get("stability_mode_active")

        candidate = _coerce_fragility_measurement(
            {
                "fragility_state": raw_state,
                "fragility_score": raw_score,
                "stability_mode_active": raw_stability,
            }
        )
        if candidate is None:
            continue

        if selected_measurement is None or _is_more_worse_fragility(
            candidate, selected_measurement
        ):
            selected_measurement = candidate

    if selected_measurement is None:
        if fallback_measurement is None:
            return ("crisis", Decimal("1"), False, False)
        selected_measurement = fallback_measurement

    selected_state, selected_score, selected_stability = selected_measurement
    return selected_state, selected_score, selected_stability, True


def _resolve_gate_forecast_metrics(
    *,
    signals: list[SignalEnvelope],
) -> dict[str, str]:
    if not signals or not settings.trading_forecast_router_enabled:
        return {}

    try:
        router = build_default_forecast_router(
            policy_path=settings.trading_forecast_router_policy_path,
            refinement_enabled=settings.trading_forecast_router_refinement_enabled,
        )
    except Exception:
        return {}

    fallback_total = 0
    latency_samples_ms: list[int] = []
    calibration_scores: list[Decimal] = []

    for signal in signals:
        try:
            feature_vector = normalize_feature_vector_v3(signal)
        except FeatureNormalizationError:
            return {}

        try:
            route_result = router.route_and_forecast(
                feature_vector=feature_vector,
                horizon=signal.timeframe or "1Min",
                event_ts=signal.event_ts,
            )
        except Exception:
            return {}

        contract_payload = route_result.contract.to_payload()
        authority = contract_from_artifact_payload(contract_payload)
        if (
            not authority
            or not bool(authority.get("authoritative", False))
            or bool(authority.get("placeholder", False))
            or not bool(route_result.contract.promotion_authority_eligible)
        ):
            return {}

        if route_result.contract.fallback.applied:
            fallback_total += 1
        latency_samples_ms.append(route_result.contract.inference_latency_ms)
        calibration_scores.append(route_result.contract.calibration_score)

    expected_samples = len(signals)
    if (
        len(latency_samples_ms) != expected_samples
        or len(calibration_scores) != expected_samples
    ):
        return {}

    fallback_rate = (Decimal(fallback_total) / Decimal(expected_samples)).quantize(
        Decimal("0.0001")
    )
    calibration_score_min = min(calibration_scores).quantize(Decimal("0.0001"))
    latency_ms_p95 = _nearest_rank_percentile(latency_samples_ms, 95)

    return {
        "fallback_rate": str(fallback_rate),
        "inference_latency_ms_p95": str(latency_ms_p95),
        "calibration_score_min": str(calibration_score_min),
    }


def _resolve_gate_staleness_ms_p95(
    *,
    signals: list[SignalEnvelope],
) -> int | None:
    if not signals:
        return None
    staleness_values_ms: list[int] = []
    for signal in signals:
        if signal.ingest_ts is None:
            return None
        event_ts = signal.event_ts.astimezone(timezone.utc)
        ingest_ts = signal.ingest_ts.astimezone(timezone.utc)
        age_ms = int((ingest_ts - event_ts).total_seconds() * 1000)
        if age_ms < 0:
            age_ms = 0
        staleness_values_ms.append(age_ms)
    return _nearest_rank_percentile(staleness_values_ms, 95)


def _to_finite_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
    elif isinstance(value, str):
        value = value.strip()
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return None
    else:
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def _resolve_gate_llm_metrics(
    *,
    session_factory: Callable[[], Session],
    now: datetime,
) -> dict[str, str]:
    try:
        with session_factory() as session:
            payload = build_llm_evaluation_metrics(session=session, now=now)
            metrics_payload = payload.get("metrics")
            if not isinstance(metrics_payload, dict):
                return {}
            metrics = cast(Mapping[str, Any], metrics_payload)
            error_rate = _to_finite_float(metrics.get("error_rate"))
            if error_rate is None or error_rate < 0 or error_rate > 1:
                return {}
            return {"error_ratio": str(Decimal(str(error_rate)))}
    except Exception:
        return {}


def _nearest_rank_percentile(values: list[int], percentile: int) -> int:
    if not values:
        return 0
    bounded = max(1, min(100, percentile))
    ordered = sorted(values)
    index = ((len(ordered) * bounded) + 99) // 100 - 1
    if index < 0:
        index = 0
    return ordered[index]


def _load_tca_gate_inputs(
    session_factory: Callable[[], Session],
) -> dict[str, object]:
    try:
        with session_factory() as session:
            return build_tca_gate_inputs(session)
    except Exception:
        return {
            "order_count": 0,
            "avg_slippage_bps": Decimal("0"),
            "avg_abs_slippage_bps": Decimal("0"),
            "avg_shortfall_notional": Decimal("0"),
            "avg_shortfall_notional_abs": Decimal("0"),
            "avg_churn_ratio": Decimal("0"),
            "avg_divergence_bps": Decimal("0"),
            "avg_divergence_bps_abs": Decimal("0"),
            "avg_realized_shortfall_bps": Decimal("0"),
            "avg_realized_shortfall_bps_abs": Decimal("0"),
            "avg_calibration_error_bps": Decimal("0"),
            "expected_shortfall_coverage": Decimal("0"),
            "expected_shortfall_sample_count": 0,
            "avg_expected_shortfall_bps_p50": Decimal("0"),
            "avg_expected_shortfall_bps_p95": Decimal("0"),
        }


coerce_fragility_state = _coerce_fragility_state
fragility_state_rank = _fragility_state_rank
coerce_fragility_bool = _coerce_fragility_bool
coerce_fragility_score = _coerce_fragility_score
coerce_fragility_measurement = _coerce_fragility_measurement
is_more_worse_fragility = _is_more_worse_fragility
resolve_gate_fragility_inputs = _resolve_gate_fragility_inputs
resolve_gate_forecast_metrics = _resolve_gate_forecast_metrics
resolve_gate_staleness_ms_p95 = _resolve_gate_staleness_ms_p95
to_finite_float = _to_finite_float
resolve_gate_llm_metrics = _resolve_gate_llm_metrics
nearest_rank_percentile = _nearest_rank_percentile
load_tca_gate_inputs = _load_tca_gate_inputs

__all__ = [
    "_coerce_fragility_state",
    "_fragility_state_rank",
    "_coerce_fragility_bool",
    "_coerce_fragility_score",
    "_coerce_fragility_measurement",
    "_is_more_worse_fragility",
    "_resolve_gate_fragility_inputs",
    "_resolve_gate_forecast_metrics",
    "_resolve_gate_staleness_ms_p95",
    "_to_finite_float",
    "_resolve_gate_llm_metrics",
    "_nearest_rank_percentile",
    "_load_tca_gate_inputs",
]
