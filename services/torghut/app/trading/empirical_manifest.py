"""Empirical promotion manifest contract helpers."""

from __future__ import annotations

from typing import Any, Mapping, cast

EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION = (
    "torghut-empirical-promotion-manifest-v1"
)


def _as_dict(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in cast(list[Any], value) if (text := _as_text(item))]


def normalize_empirical_promotion_manifest(payload: Mapping[str, Any]) -> dict[str, Any]:
    normalized = {str(key): value for key, value in payload.items()}
    normalized.setdefault(
        "schema_version",
        EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION,
    )
    janus_q = _as_dict(normalized.get("janus_q"))
    if not janus_q:
        event_car = _as_dict(normalized.get("janus_event_car"))
        hgrm_reward = _as_dict(normalized.get("janus_hgrm_reward"))
        if event_car and hgrm_reward:
            normalized["janus_q"] = {
                "schema_version": "janus-q-evidence-v1",
                "event_car": event_car,
                "hgrm_reward": hgrm_reward,
            }
    return normalized


def validate_empirical_promotion_manifest(payload: Mapping[str, Any]) -> list[str]:
    normalized = normalize_empirical_promotion_manifest(payload)
    reasons: list[str] = []
    if (
        _as_text(normalized.get("schema_version"))
        != EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION
    ):
        reasons.append("schema_version_invalid")

    for key in (
        "run_id",
        "candidate_id",
        "dataset_snapshot_ref",
        "artifact_prefix",
        "strategy_spec_ref",
    ):
        if not _as_text(normalized.get(key)):
            reasons.append(f"{key}_missing")

    if not _as_dict(normalized.get("benchmark_parity")):
        reasons.append("benchmark_parity_missing")
    if not _as_dict(normalized.get("foundation_router_parity")):
        reasons.append("foundation_router_parity_missing")
    if not _as_dict(normalized.get("janus_event_car")):
        reasons.append("janus_event_car_missing")
    if not _as_dict(normalized.get("janus_hgrm_reward")):
        reasons.append("janus_hgrm_reward_missing")
    if not _as_dict(normalized.get("janus_q")):
        reasons.append("janus_q_missing")

    if not _as_string_list(normalized.get("model_refs")):
        reasons.append("model_refs_missing")
    if not _as_string_list(normalized.get("runtime_version_refs")):
        reasons.append("runtime_version_refs_missing")

    authority = _as_dict(normalized.get("authority"))
    if not authority:
        reasons.append("authority_missing")
    elif not bool(authority.get("generated_from_simulation_outputs", False)):
        reasons.append("authority_not_generated_from_simulation_outputs")

    if not isinstance(normalized.get("promotion_authority_eligible"), bool):
        reasons.append("promotion_authority_eligible_invalid")
    return reasons


__all__ = [
    "EMPIRICAL_PROMOTION_MANIFEST_SCHEMA_VERSION",
    "normalize_empirical_promotion_manifest",
    "validate_empirical_promotion_manifest",
]
