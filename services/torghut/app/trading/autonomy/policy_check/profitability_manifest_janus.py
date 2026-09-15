"""Janus evidence validation for profitability promotion manifests."""

from __future__ import annotations

from pathlib import Path

from .common import Any
from .requirements import (
    as_dict as _as_dict,
    int_or_default as _int_or_default,
    list_count as _list_count,
    load_json_if_exists as _load_json_if_exists,
)


def append_janus_evidence_reasons(
    *,
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    _validate_janus_event_car(reasons, reason_details, policy_payload, artifact_root)
    _validate_janus_hgrm_reward(reasons, reason_details, policy_payload, artifact_root)


def _validate_janus_event_car(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    event_path = artifact_root / str(
        policy_payload.get(
            "promotion_janus_event_car_artifact", "gates/janus-event-car-v1.json"
        )
    )
    event_payload = _load_json_if_exists(event_path)

    if event_payload is None:
        reasons.append("janus_event_car_artifact_missing")
        reason_details.append(
            {
                "reason": "janus_event_car_artifact_missing",
                "artifact_ref": str(event_path),
            }
        )
        return

    _validate_janus_schema(
        reasons, reason_details, event_payload, event_path, "janus-event-car-v1"
    )
    event_count = _int_or_default(
        _as_dict(event_payload.get("summary")).get("event_count"),
        _list_count(event_payload.get("records")),
    )
    min_event_count = max(
        1, _int_or_default(policy_payload.get("promotion_min_janus_event_count"), 1)
    )
    if event_count < min_event_count:
        reasons.append("janus_event_car_count_below_minimum")
        reason_details.append(
            {
                "reason": "janus_event_car_count_below_minimum",
                "artifact_ref": str(event_path),
                "actual_event_count": event_count,
                "minimum_event_count": min_event_count,
            }
        )


def _validate_janus_hgrm_reward(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    policy_payload: dict[str, Any],
    artifact_root: Path,
) -> None:
    reward_path = artifact_root / str(
        policy_payload.get(
            "promotion_janus_hgrm_reward_artifact", "gates/janus-hgrm-reward-v1.json"
        )
    )
    reward_payload = _load_json_if_exists(reward_path)

    if reward_payload is None:
        reasons.append("janus_hgrm_reward_artifact_missing")
        reason_details.append(
            {
                "reason": "janus_hgrm_reward_artifact_missing",
                "artifact_ref": str(reward_path),
            }
        )
        return

    _validate_janus_schema(
        reasons, reason_details, reward_payload, reward_path, "janus-hgrm-reward-v1"
    )
    reward_count = _int_or_default(
        _as_dict(reward_payload.get("summary")).get("reward_count"),
        _list_count(reward_payload.get("rewards")),
    )
    min_reward_count = max(
        1, _int_or_default(policy_payload.get("promotion_min_janus_reward_count"), 1)
    )
    if reward_count < min_reward_count:
        reasons.append("janus_hgrm_reward_count_below_minimum")
        reason_details.append(
            {
                "reason": "janus_hgrm_reward_count_below_minimum",
                "artifact_ref": str(reward_path),
                "actual_reward_count": reward_count,
                "minimum_reward_count": min_reward_count,
            }
        )


def _validate_janus_schema(
    reasons: list[str],
    reason_details: list[dict[str, object]],
    payload: dict[str, Any],
    path: Path,
    expected_schema: str,
) -> None:
    if str(payload.get("schema_version", "")).strip() == expected_schema:
        return

    reason = {
        "janus-event-car-v1": "janus_event_car_schema_invalid",
        "janus-hgrm-reward-v1": "janus_hgrm_reward_schema_invalid",
    }[expected_schema]
    reasons.append(reason)
    reason_details.append(
        {
            "reason": reason,
            "artifact_ref": str(path),
            "expected": expected_schema,
        }
    )


__all__ = ("append_janus_evidence_reasons",)
