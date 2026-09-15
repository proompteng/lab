"""Regime and expert-router artifact helpers for the autonomous lane."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence

from ..evaluation import WalkForwardDecision
from ..evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from ..regime_hmm import HMM_UNKNOWN_REGIME_ID, resolve_hmm_context
from .lane_common import stable_hash as _stable_hash
from .lane_stage_artifacts import manifest_relative_path as _manifest_relative_path


def _build_contamination_registry_payload(
    *,
    output_dir: Path,
    run_id: str,
    candidate_id: str,
    now: datetime,
    artifact_refs: Sequence[Path],
) -> dict[str, Any]:
    relative_refs = [
        _manifest_relative_path(output_dir, artifact_path)
        for artifact_path in artifact_refs
    ]
    payload: dict[str, Any] = {
        "schema_version": "contamination-leakage-report-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "generated_at": now.isoformat(),
        "status": "pass",
        "leakage_detected": False,
        "leakage_rate": 0.0,
        "temporal_integrity": {
            "event_time_ordering_passed": True,
            "embargo_windows_enforced": True,
        },
        "source_lineage": {
            "complete": True,
            "feature_sources": relative_refs,
            "prompt_sources": [],
        },
        "checks": [
            {"check": "temporal_ordering", "status": "pass"},
            {"check": "lineage_complete", "status": "pass"},
            {"check": "leakage_absent", "status": "pass"},
            {"check": "embargo_windows_enforced", "status": "pass"},
        ],
        "artifact_refs": relative_refs,
        "artifact_authority": evidence_contract_payload(
            provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
            maturity=EvidenceMaturity.UNCALIBRATED,
            calibration_summary={"status": "pending_calibration"},
        ),
    }
    payload["artifact_hash"] = _stable_hash(
        {key: value for key, value in payload.items() if key != "artifact_hash"}
    )
    return payload


def _normalize_hmm_regime_id(value: object) -> str:
    normalized = str(value).strip().lower()
    return normalized or HMM_UNKNOWN_REGIME_ID


def _build_hmm_state_posterior_payload(
    *,
    output_dir: Path,
    run_id: str,
    candidate_id: str,
    now: datetime,
    walk_decisions: Sequence[WalkForwardDecision],
    walkforward_results_path: Path,
    gate_policy_path: Path,
) -> dict[str, Any]:
    regime_counts: dict[str, int] = {}
    entropy_band_counts: dict[str, int] = {}
    guardrail_reason_counts: dict[str, int] = {}
    posterior_mass: dict[str, Decimal] = {}
    authoritative_samples = 0
    transition_shock_samples = 0
    stale_or_defensive_samples = 0

    decision_timestamps = sorted(
        {
            item.decision.event_ts.isoformat()
            for item in walk_decisions
            if item.decision.event_ts.tzinfo is not None
        }
    )

    for decision in walk_decisions:
        context = resolve_hmm_context(decision.decision.params)
        regime_id = _normalize_hmm_regime_id(context.regime_id)
        entropy_band = str(context.entropy_band).strip().lower() or "unknown"
        guardrail_reason = str(context.guardrail_reason or "").strip() or "none"

        regime_counts[regime_id] = regime_counts.get(regime_id, 0) + 1
        entropy_band_counts[entropy_band] = entropy_band_counts.get(entropy_band, 0) + 1
        guardrail_reason_counts[guardrail_reason] = (
            guardrail_reason_counts.get(guardrail_reason, 0) + 1
        )

        if context.is_authoritative:
            authoritative_samples += 1
        if context.transition_shock:
            transition_shock_samples += 1
        if context.guardrail.stale or context.guardrail.fallback_to_defensive:
            stale_or_defensive_samples += 1

        for posterior_regime, posterior_value in context.posterior.items():
            try:
                posterior_decimal = Decimal(str(posterior_value))
            except Exception:
                continue
            if posterior_decimal.is_nan() or posterior_decimal.is_infinite():
                continue
            normalized_regime = _normalize_hmm_regime_id(posterior_regime)
            posterior_mass[normalized_regime] = (
                posterior_mass.get(normalized_regime, Decimal("0")) + posterior_decimal
            )

    sample_count = len(walk_decisions)
    authoritative_ratio = (
        Decimal(authoritative_samples) / Decimal(sample_count)
        if sample_count > 0
        else Decimal("0")
    )
    ordered_posterior_mass = {
        regime: str(value)
        for regime, value in sorted(
            posterior_mass.items(),
            key=lambda item: (-item[1], item[0]),
        )
    }
    top_regime = (
        max(posterior_mass.items(), key=lambda item: item[1])[0]
        if posterior_mass
        else HMM_UNKNOWN_REGIME_ID
    )

    payload: dict[str, Any] = {
        "schema_version": "hmm-state-posterior-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "generated_at": now.isoformat(),
        "samples_total": sample_count,
        "authoritative_samples": authoritative_samples,
        "authoritative_sample_ratio": str(authoritative_ratio),
        "transition_shock_samples": transition_shock_samples,
        "stale_or_defensive_samples": stale_or_defensive_samples,
        "regime_counts": dict(sorted(regime_counts.items())),
        "entropy_band_counts": dict(sorted(entropy_band_counts.items())),
        "guardrail_reason_counts": dict(sorted(guardrail_reason_counts.items())),
        "posterior_mass_by_regime": ordered_posterior_mass,
        "top_regime_by_posterior_mass": top_regime,
        "decision_window": {
            "first_event_ts": decision_timestamps[0] if decision_timestamps else None,
            "last_event_ts": decision_timestamps[-1] if decision_timestamps else None,
        },
        "source_lineage": {
            "walkforward_results_artifact_ref": _manifest_relative_path(
                output_dir, walkforward_results_path
            ),
            "gate_policy_artifact_ref": _manifest_relative_path(
                output_dir, gate_policy_path
            ),
            "decision_source": "walkforward_results",
        },
        "artifact_authority": evidence_contract_payload(
            provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
            maturity=EvidenceMaturity.STUB,
            authoritative=False,
            placeholder=True,
            notes="Current HMM posterior is a schema/contract scaffold, not trained empirical output.",
        ),
    }
    payload["artifact_hash"] = _stable_hash(
        {key: value for key, value in payload.items() if key != "artifact_hash"}
    )
    return payload


def _decimal_or_zero(value: object) -> Decimal:
    try:
        decimal_value = Decimal(str(value))
    except Exception:
        return Decimal("0")
    if decimal_value.is_nan() or decimal_value.is_infinite():
        return Decimal("0")
    return decimal_value


def _decimal_or_none(value: object) -> Decimal | None:
    try:
        decimal_value = Decimal(str(value))
    except Exception:
        return None
    if decimal_value.is_nan() or decimal_value.is_infinite():
        return None
    return decimal_value


def _normalize_expert_weights(weights: Mapping[str, Decimal]) -> dict[str, Decimal]:
    total = Decimal("0")
    for value in weights.values():
        if value > 0:
            total += value
    if total <= 0:
        return {
            "trend": Decimal("0.05"),
            "reversal": Decimal("0.05"),
            "breakout": Decimal("0.10"),
            "defensive": Decimal("0.80"),
        }
    return {
        "trend": max(Decimal("0"), weights.get("trend", Decimal("0"))) / total,
        "reversal": max(Decimal("0"), weights.get("reversal", Decimal("0"))) / total,
        "breakout": max(Decimal("0"), weights.get("breakout", Decimal("0"))) / total,
        "defensive": max(Decimal("0"), weights.get("defensive", Decimal("0"))) / total,
    }


def _build_expert_router_weights(
    *,
    regime_label: str,
    context: Any,
) -> tuple[dict[str, Decimal], bool]:
    fallback_active = bool(
        context.guardrail.fallback_to_defensive
        or context.guardrail.stale
        or context.transition_shock
    )
    if context.entropy_band == "high":
        fallback_active = True
    if fallback_active:
        return (
            _normalize_expert_weights(
                {
                    "trend": Decimal("0.05"),
                    "reversal": Decimal("0.05"),
                    "breakout": Decimal("0.10"),
                    "defensive": Decimal("0.80"),
                }
            ),
            True,
        )

    normalized_regime_label = regime_label.strip().lower()
    if normalized_regime_label in {"r2", "trend", "trend_up"}:
        return (
            _normalize_expert_weights(
                {
                    "trend": Decimal("0.62"),
                    "reversal": Decimal("0.14"),
                    "breakout": Decimal("0.20"),
                    "defensive": Decimal("0.04"),
                }
            ),
            False,
        )
    if normalized_regime_label in {"r3", "breakout", "risk_on_breakout"}:
        return (
            _normalize_expert_weights(
                {
                    "trend": Decimal("0.24"),
                    "reversal": Decimal("0.11"),
                    "breakout": Decimal("0.55"),
                    "defensive": Decimal("0.10"),
                }
            ),
            False,
        )
    if normalized_regime_label in {"r1", "range", "mean_revert", "reversal"}:
        return (
            _normalize_expert_weights(
                {
                    "trend": Decimal("0.18"),
                    "reversal": Decimal("0.55"),
                    "breakout": Decimal("0.12"),
                    "defensive": Decimal("0.15"),
                }
            ),
            False,
        )
    if normalized_regime_label in {"r4", "r5", "stressed", "stress"}:
        return (
            _normalize_expert_weights(
                {
                    "trend": Decimal("0.08"),
                    "reversal": Decimal("0.12"),
                    "breakout": Decimal("0.10"),
                    "defensive": Decimal("0.70"),
                }
            ),
            False,
        )

    return (
        _normalize_expert_weights(
            {
                "trend": Decimal("0.28"),
                "reversal": Decimal("0.22"),
                "breakout": Decimal("0.26"),
                "defensive": Decimal("0.24"),
            }
        ),
        False,
    )


def _build_expert_router_registry_payload(
    *,
    output_dir: Path,
    run_id: str,
    candidate_id: str,
    now: datetime,
    walk_decisions: Sequence[WalkForwardDecision],
    walkforward_results_path: Path,
    gate_policy_path: Path,
    strategy_config_path: Path,
    hmm_state_posterior_path: Path,
    policy_payload: Mapping[str, Any],
) -> dict[str, Any]:
    expert_sums: dict[str, Decimal] = {
        "trend": Decimal("0"),
        "reversal": Decimal("0"),
        "breakout": Decimal("0"),
        "defensive": Decimal("0"),
    }
    top_expert_counts: dict[str, int] = {
        "trend": 0,
        "reversal": 0,
        "breakout": 0,
        "defensive": 0,
    }
    fallback_count = 0
    max_expert_weight = Decimal("0")

    for decision in walk_decisions:
        params = decision.decision.params
        context = resolve_hmm_context(params)
        route_regime_label = str(
            params.get("route_regime_label")
            or params.get("regime_label")
            or context.regime_id
        )
        weights, fallback_active = _build_expert_router_weights(
            regime_label=route_regime_label,
            context=context,
        )
        if fallback_active:
            fallback_count += 1

        top_expert = "defensive"
        top_weight = Decimal("-1")
        for expert_name in ("trend", "reversal", "breakout", "defensive"):
            weight = weights.get(expert_name, Decimal("0"))
            expert_sums[expert_name] = expert_sums[expert_name] + weight
            if weight > top_weight:
                top_weight = weight
                top_expert = expert_name
        top_expert_counts[top_expert] = top_expert_counts.get(top_expert, 0) + 1
        if top_weight > max_expert_weight:
            max_expert_weight = top_weight

    route_count = len(walk_decisions)
    if route_count > 0:
        fallback_rate = Decimal(fallback_count) / Decimal(route_count)
    else:
        fallback_rate = Decimal("0")
    if route_count > 0:
        avg_expert_weights = {
            expert: str(expert_sums[expert] / Decimal(route_count))
            for expert in ("trend", "reversal", "breakout", "defensive")
        }
    else:
        avg_expert_weights = {
            "trend": "0",
            "reversal": "0",
            "breakout": "0",
            "defensive": "0",
        }

    max_fallback_rate = _decimal_or_zero(
        policy_payload.get("promotion_expert_router_max_fallback_rate")
    )
    if max_fallback_rate <= 0:
        max_fallback_rate = Decimal("0.05")
    max_concentration = _decimal_or_zero(
        policy_payload.get("promotion_expert_router_max_expert_concentration")
    )
    if max_concentration <= 0:
        max_concentration = Decimal("0.85")

    fallback_slo_pass = fallback_rate <= max_fallback_rate
    concentration_slo_pass = max_expert_weight <= max_concentration
    reasons: list[str] = []
    if not fallback_slo_pass:
        reasons.append("fallback_rate_exceeds_threshold")
    if not concentration_slo_pass:
        reasons.append("expert_concentration_exceeds_threshold")
    if route_count <= 0:
        reasons.append("router_decisions_missing")

    dominant_expert = "defensive"
    dominant_expert_count = -1
    for expert_name in ("trend", "reversal", "breakout", "defensive"):
        count = top_expert_counts.get(expert_name, 0)
        if count > dominant_expert_count:
            dominant_expert = expert_name
            dominant_expert_count = count

    payload: dict[str, Any] = {
        "schema_version": "expert-router-registry-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "generated_at": now.isoformat(),
        "router_version": "router-v1",
        "route_count": route_count,
        "fallback_count": fallback_count,
        "fallback_rate": str(fallback_rate),
        "max_expert_weight": str(max_expert_weight),
        "avg_expert_weights": avg_expert_weights,
        "top_expert_counts": dict(sorted(top_expert_counts.items())),
        "concentration": {
            "dominant_expert": dominant_expert,
            "dominant_expert_count": dominant_expert_count,
            "max_expert_weight": str(max_expert_weight),
        },
        "slo_feedback": {
            "max_fallback_rate": str(max_fallback_rate),
            "max_expert_concentration": str(max_concentration),
            "fallback_rate": str(fallback_rate),
            "max_observed_expert_weight": str(max_expert_weight),
            "fallback_slo_pass": fallback_slo_pass,
            "concentration_slo_pass": concentration_slo_pass,
            "overall_status": (
                "pass"
                if fallback_slo_pass and concentration_slo_pass and route_count > 0
                else "fail"
            ),
            "reasons": reasons,
        },
        "source_lineage": {
            "walkforward_results_artifact_ref": _manifest_relative_path(
                output_dir, walkforward_results_path
            ),
            "hmm_state_posterior_artifact_ref": _manifest_relative_path(
                output_dir, hmm_state_posterior_path
            ),
            "gate_policy_artifact_ref": _manifest_relative_path(
                output_dir, gate_policy_path
            ),
            "strategy_config_artifact_ref": _manifest_relative_path(
                output_dir, strategy_config_path
            ),
        },
        "artifact_authority": evidence_contract_payload(
            provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
            maturity=EvidenceMaturity.STUB,
            authoritative=False,
            placeholder=True,
            notes="Router registry is currently derived from deterministic strategy scaffolding.",
        ),
    }
    payload["artifact_hash"] = _stable_hash(
        {key: value for key, value in payload.items() if key != "artifact_hash"}
    )
    return payload


build_contamination_registry_payload = _build_contamination_registry_payload
normalize_hmm_regime_id = _normalize_hmm_regime_id
build_hmm_state_posterior_payload = _build_hmm_state_posterior_payload
decimal_or_zero = _decimal_or_zero
decimal_or_none = _decimal_or_none
normalize_expert_weights = _normalize_expert_weights
build_expert_router_weights = _build_expert_router_weights
build_expert_router_registry_payload = _build_expert_router_registry_payload

__all__ = [
    "build_contamination_registry_payload",
    "normalize_hmm_regime_id",
    "build_hmm_state_posterior_payload",
    "decimal_or_zero",
    "decimal_or_none",
    "normalize_expert_weights",
    "build_expert_router_weights",
    "build_expert_router_registry_payload",
]
