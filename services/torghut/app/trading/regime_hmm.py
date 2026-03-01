"""Shared HMM regime-context parsing and normalization helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, cast


HMM_CONTEXT_SCHEMA_VERSION = "hmm_regime_context_v1"
HMM_UNKNOWN_SCHEMA_VERSION = "unknown"
HMM_UNKNOWN_REGIME_ID = "unknown"
HMM_DEFAULT_ENTROPY = "0"
HMM_ENTROPY_BANDS = {"low", "medium", "high"}
HMM_ENTROPY_MEDIUM_THRESHOLD = Decimal("0.90")
HMM_ENTROPY_HIGH_THRESHOLD = Decimal("1.35")
_REGIME_ID_RE = re.compile(r"^[Rr]\d+$")


@dataclass(frozen=True)
class HMMGuardrail:
    stale: bool
    fallback_to_defensive: bool
    reason: str | None

    def to_payload(self) -> dict[str, object]:
        return {
            "stale": self.stale,
            "fallback_to_defensive": self.fallback_to_defensive,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class HMMArtifact:
    model_id: str
    feature_schema: str
    training_run_id: str

    def to_payload(self) -> dict[str, str]:
        return {
            "model_id": self.model_id,
            "feature_schema": self.feature_schema,
            "training_run_id": self.training_run_id,
        }


@dataclass(frozen=True)
class HMMRegimeContext:
    schema_version: str
    regime_id: str
    posterior: dict[str, str]
    entropy: str
    entropy_band: str
    predicted_next: str
    transition_shock: bool
    duration_ms: int
    artifact: HMMArtifact
    guardrail: HMMGuardrail

    @property
    def artifact_model_id(self) -> str:
        return self.artifact.model_id

    @property
    def guardrail_reason(self) -> str | None:
        return self.guardrail.reason

    @property
    def has_regime(self) -> bool:
        return self.regime_id != HMM_UNKNOWN_REGIME_ID

    @property
    def is_authoritative(self) -> bool:
        return (
            self.has_regime
            and not self.guardrail.stale
            and not self.guardrail.fallback_to_defensive
            and _REGIME_ID_RE.match(self.regime_id) is not None
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "regime_id": self.regime_id,
            "posterior": dict(self.posterior),
            "entropy": self.entropy,
            "entropy_band": self.entropy_band,
            "predicted_next": self.predicted_next,
            "transition_shock": self.transition_shock,
            "duration_ms": self.duration_ms,
            "artifact": self.artifact.to_payload(),
            "guardrail": self.guardrail.to_payload(),
        }

    @classmethod
    def unknown(cls) -> "HMMRegimeContext":
        return cls(
            schema_version=HMM_UNKNOWN_SCHEMA_VERSION,
            regime_id=HMM_UNKNOWN_REGIME_ID,
            posterior={},
            entropy=HMM_DEFAULT_ENTROPY,
            entropy_band="low",
            predicted_next=HMM_UNKNOWN_REGIME_ID,
            transition_shock=False,
            duration_ms=0,
            artifact=HMMArtifact(
                model_id=HMM_UNKNOWN_REGIME_ID,
                feature_schema=HMM_UNKNOWN_REGIME_ID,
                training_run_id=HMM_UNKNOWN_REGIME_ID,
            ),
            guardrail=HMMGuardrail(
                stale=False,
                fallback_to_defensive=False,
                reason=None,
            ),
        )


def resolve_hmm_context(raw_payload: Mapping[str, Any] | None) -> HMMRegimeContext:
    if raw_payload is None:
        return HMMRegimeContext.unknown()

    payload = dict(cast(dict[str, Any], raw_payload))
    direct_payload = _extract_context_payload(payload)
    if direct_payload is None:
        if not _has_hmm_split_fields(payload):
            return HMMRegimeContext.unknown()
        return _parse_context_map(payload)

    return _parse_context_map(direct_payload)


def resolve_regime_route_label(
    payload: Mapping[str, Any],
    *,
    macd: Decimal | None,
    macd_signal: Decimal | None,
) -> str:
    context = resolve_hmm_context(payload)
    if context.is_authoritative:
        return context.regime_id

    explicit = payload.get("regime_label")
    if isinstance(explicit, str):
        explicit_value = explicit.strip()
        if explicit_value:
            return explicit_value.lower()

    if macd is None or macd_signal is None:
        return "unknown"
    spread = macd - macd_signal
    if spread >= Decimal("0.02"):
        return "trend"
    if spread <= Decimal("-0.02"):
        return "mean_revert"
    return "range"


def resolve_legacy_regime_label(payload: Mapping[str, Any]) -> str | None:
    direct = payload.get("regime_label")
    if isinstance(direct, str):
        direct_value = direct.strip()
        if direct_value:
            return direct_value.lower()
    regime = payload.get("regime")
    if isinstance(regime, Mapping):
        regime_map = cast(Mapping[str, Any], regime)
        label = regime_map.get("label")
        if isinstance(label, str):
            label_value = label.strip()
            if label_value:
                return label_value.lower()
    return None


def _extract_context_payload(payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    candidate_keys = (
        "regime_hmm",
        "hmm_regime_context",
        "hmm_context",
        "regime_context",
    )
    for key in candidate_keys:
        value = payload.get(key)
        if isinstance(value, Mapping):
            context_payload = cast(Mapping[str, Any], value)
            return {str(k): v for k, v in context_payload.items()}

    regime_payload = payload
    if "posterior" in regime_payload and isinstance(regime_payload.get("posterior"), Mapping):
        if _has_any_context_field(regime_payload):
            return {str(k): v for k, v in regime_payload.items()}
    if _has_hmm_split_fields(regime_payload):
        return {
            "regime_id": regime_payload.get("hmm_regime_id"),
            "posterior": regime_payload.get("hmm_state_posterior"),
            "entropy": regime_payload.get("hmm_entropy"),
            "entropy_band": regime_payload.get("hmm_entropy_band"),
            "predicted_next": regime_payload.get("hmm_predicted_next"),
            "transition_shock": regime_payload.get("hmm_transition_shock"),
            "duration_ms": regime_payload.get("hmm_duration_ms"),
            "artifact": regime_payload.get("hmm_artifact"),
            "guardrail": regime_payload.get("hmm_guardrail"),
        }
    return None


def _has_any_context_field(payload: Mapping[str, Any]) -> bool:
    return any(
        isinstance(payload.get(field), Mapping)
        or field in payload
        for field in (
            "schema_version",
            "regime_id",
            "posterior",
            "entropy",
            "entropy_band",
            "predicted_next",
            "transition_shock",
            "duration_ms",
            "artifact",
            "guardrail",
        )
    )


def _has_hmm_split_fields(payload: Mapping[str, Any]) -> bool:
    split_keys = {
        "hmm_state_posterior",
        "hmm_entropy",
        "hmm_entropy_band",
        "hmm_regime_id",
        "hmm_predicted_next",
        "hmm_transition_shock",
        "hmm_duration_ms",
        "hmm_artifact",
        "hmm_guardrail",
    }
    return any(key in payload for key in split_keys)


def _parse_context_map(payload: Mapping[str, Any]) -> HMMRegimeContext:
    schema_version = _coerce_string(payload.get("schema_version") or payload.get("schemaVersion"))
    if not schema_version:
        schema_version = HMM_UNKNOWN_SCHEMA_VERSION

    regime_id = _normalize_regime_id(payload.get("regime_id") or payload.get("regimeId"))
    posterior_raw = payload.get("posterior")
    posterior = _coerce_posterior(posterior_raw)
    entropy = _coerce_decimal_str(payload.get("entropy"))
    entropy_band_raw = payload.get("entropy_band") or payload.get("entropyBand")
    entropy_band = _coerce_entropy_band(entropy_band_raw, entropy)
    predicted_next = _normalize_predicted_next(
        payload.get("predicted_next") or payload.get("predictedNext")
    )
    transition_shock = _coerce_bool(
        _coerce_first_present(payload, "transition_shock", "transitionShock")
    )
    duration_ms = _coerce_int(payload.get("duration_ms") or payload.get("durationMs"))
    artifact = _coerce_artifact(payload.get("artifact"))
    guardrail = _coerce_guardrail(
        payload.get("guardrail"),
        fallback_to_defensive=_coerce_bool(
            _coerce_first_present(payload, "fallback_to_defensive", "fallbackToDefensive")
        ),
    )

    return HMMRegimeContext(
        schema_version=schema_version,
        regime_id=regime_id,
        posterior=posterior,
        entropy=entropy,
        entropy_band=entropy_band,
        predicted_next=predicted_next,
        transition_shock=transition_shock,
        duration_ms=duration_ms,
        artifact=artifact,
        guardrail=guardrail,
    )


def _coerce_string(raw: Any) -> str:
    if raw is None:
        return ""
    text = str(raw).strip()
    return text


def _normalize_regime_id(raw: Any) -> str:
    text = _coerce_string(raw)
    if not text:
        return HMM_UNKNOWN_REGIME_ID
    return text


def _coerce_posterior(raw: Any) -> dict[str, str]:
    if not isinstance(raw, Mapping):
        return {}

    payload = cast(Mapping[str, Any], raw)
    posterior: dict[str, str] = {}
    for key, value in payload.items():
        key_value = _coerce_string(key)
        if not _REGIME_ID_RE.match(key_value):
            continue
        if not key_value:
            continue
        posterior[key_value] = _coerce_decimal_str(value)
    return posterior


def _coerce_decimal_str(raw: Any) -> str:
    if raw is None:
        return HMM_DEFAULT_ENTROPY
    if isinstance(raw, Decimal):
        return str(raw)
    try:
        decimal_value = Decimal(str(raw))
    except (ArithmeticError, ValueError, TypeError):
        return HMM_DEFAULT_ENTROPY
    return str(decimal_value)


def _coerce_entropy_band(raw: Any, entropy: str) -> str:
    band = _coerce_string(raw).lower()
    if band in HMM_ENTROPY_BANDS:
        return band

    entropy_value = _coerce_entropy_value(entropy)
    if entropy_value <= HMM_ENTROPY_MEDIUM_THRESHOLD:
        return "low"
    if entropy_value <= HMM_ENTROPY_HIGH_THRESHOLD:
        return "medium"
    return "high"


def _coerce_entropy_value(raw: str) -> Decimal:
    try:
        return Decimal(raw)
    except (ValueError, ArithmeticError):
        return Decimal("0")


def _coerce_first_present(payload: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload.get(key) is not None:
            return payload.get(key)
    return None


def _normalize_predicted_next(raw: Any) -> str:
    text = _coerce_string(raw)
    if not text:
        return HMM_UNKNOWN_REGIME_ID
    return text


def _coerce_int(raw: Any) -> int:
    if raw is None:
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def _coerce_bool(raw: Any) -> bool:
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return False
    if isinstance(raw, (int, float)):
        return raw != 0
    text = str(raw).strip().lower()
    return text in {"1", "true", "yes", "on"}


def _coerce_artifact(raw: Any) -> HMMArtifact:
    if isinstance(raw, Mapping):
        artifact_map = cast(Mapping[str, Any], raw)
        model_id = _coerce_string(
            artifact_map.get("model_id")
            or artifact_map.get("modelId")
            or artifact_map.get("artifact_model_id")
            or artifact_map.get("artifactModelId")
            or HMM_UNKNOWN_REGIME_ID
        )
        feature_schema = _coerce_string(
            artifact_map.get("feature_schema")
            or artifact_map.get("featureSchema")
            or artifact_map.get("artifact_feature_schema")
            or artifact_map.get("featureSchemaVersion")
            or HMM_UNKNOWN_REGIME_ID
        )
        training_run_id = _coerce_string(
            artifact_map.get("training_run_id")
            or artifact_map.get("trainingRunId")
            or HMM_UNKNOWN_REGIME_ID
        )
    else:
        model_id = HMM_UNKNOWN_REGIME_ID
        feature_schema = HMM_UNKNOWN_REGIME_ID
        training_run_id = HMM_UNKNOWN_REGIME_ID
    return HMMArtifact(
        model_id=model_id,
        feature_schema=feature_schema,
        training_run_id=training_run_id,
    )


def _coerce_guardrail(raw: Any, *, fallback_to_defensive: bool = False) -> HMMGuardrail:
    if isinstance(raw, Mapping):
        guardrail_map = cast(Mapping[str, Any], raw)
        stale = _coerce_bool(
            _coerce_first_present(
                guardrail_map,
                "stale",
                "isStale",
                "is_stale",
            )
        )
        if not fallback_to_defensive:
            fallback_to_defensive = _coerce_bool(
                _coerce_first_present(
                    guardrail_map,
                    "fallback_to_defensive",
                    "fallbackToDefensive",
                )
            )
        reason = _coerce_string(
            guardrail_map.get("reason")
        )
    else:
        stale = False
        reason = ""
    if fallback_to_defensive and not reason:
        reason = "fallback_to_defensive"
    return HMMGuardrail(
        stale=stale,
        fallback_to_defensive=fallback_to_defensive,
        reason=reason or None,
    )


__all__ = [
    "HMMArtifact",
    "HMMGuardrail",
    "HMMRegimeContext",
    "HMMRegimeContext",
    "HMM_CONTEXT_SCHEMA_VERSION",
    "HMM_UNKNOWN_REGIME_ID",
    "HMM_UNKNOWN_SCHEMA_VERSION",
    "resolve_hmm_context",
    "resolve_legacy_regime_label",
    "resolve_regime_route_label",
]
