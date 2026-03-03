"""Runtime gate-policy contract checks for startup and CI parity enforcement."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

_REQUIRED_BOOL_KEYS: tuple[str, ...] = (
    "promotion_require_profitability_stage_manifest",
    "promotion_require_benchmark_parity",
    "promotion_require_janus_evidence",
    "promotion_require_stress_evidence",
)

_REQUIRED_STRING_KEYS: tuple[str, ...] = (
    "promotion_profitability_stage_manifest_artifact",
)

_REQUIRED_LIST_KEYS: tuple[str, ...] = (
    "promotion_benchmark_required_artifacts",
    "promotion_janus_required_artifacts",
    "promotion_stress_required_artifacts",
)

REQUIRED_RUNTIME_GATE_POLICY_KEYS: tuple[str, ...] = (
    *_REQUIRED_BOOL_KEYS,
    *_REQUIRED_STRING_KEYS,
    *_REQUIRED_LIST_KEYS,
)


def load_runtime_gate_policy(policy_path: Path) -> dict[str, Any]:
    raw_payload = json.loads(policy_path.read_text(encoding="utf-8"))
    if not isinstance(raw_payload, dict):
        raise ValueError("policy payload must be a JSON object")
    return cast(dict[str, Any], raw_payload)


def required_key_errors(policy_payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    for key in REQUIRED_RUNTIME_GATE_POLICY_KEYS:
        if key not in policy_payload:
            errors.append(f"missing:{key}")

    for key in _REQUIRED_BOOL_KEYS:
        if key not in policy_payload:
            continue
        if not isinstance(policy_payload.get(key), bool):
            errors.append(f"invalid_type:{key}:bool")

    for key in _REQUIRED_STRING_KEYS:
        if key not in policy_payload:
            continue
        value = policy_payload.get(key)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"invalid_type:{key}:non_empty_string")

    for key in _REQUIRED_LIST_KEYS:
        if key not in policy_payload:
            continue
        value = policy_payload.get(key)
        if not isinstance(value, list):
            errors.append(f"invalid_type:{key}:list")
            continue
        list_value = cast(list[Any], value)
        if not list_value:
            errors.append(f"invalid_value:{key}:empty")
            continue
        if any(not isinstance(item, str) or not item.strip() for item in list_value):
            errors.append(f"invalid_value:{key}:string_items_required")

    return errors


def assert_runtime_gate_policy_contract(policy_path: str | None) -> dict[str, Any]:
    resolved = (policy_path or "").strip()
    if not resolved:
        raise RuntimeError(
            "TRADING_AUTONOMY_GATE_POLICY_PATH is required when autonomy is enabled"
        )

    path = Path(resolved)
    if not path.exists():
        raise RuntimeError(f"autonomy gate policy path does not exist: {path}")

    try:
        payload = load_runtime_gate_policy(path)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"autonomy gate policy JSON parse failed at {path}: {exc}"
        ) from exc
    except ValueError as exc:
        raise RuntimeError(f"autonomy gate policy is invalid at {path}: {exc}") from exc

    errors = required_key_errors(payload)
    if errors:
        joined = ", ".join(sorted(set(errors)))
        raise RuntimeError(
            f"autonomy gate policy contract violations at {path}: {joined}"
        )

    return payload
