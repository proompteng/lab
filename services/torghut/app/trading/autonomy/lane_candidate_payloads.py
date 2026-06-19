"""Candidate-state payload helpers for the autonomous lane."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Sequence, cast

import yaml

from ..hypotheses import load_hypothesis_registry, resolve_hypothesis_dependency_quorum
from .gates import PromotionTarget
from .lane_common import (
    default_strategy_configmap_path as _default_strategy_configmap_path,
)
from .runtime import StrategyRuntimeConfig


def _normalize_strategy_artifacts(value: object) -> object | None:
    if not isinstance(value, dict):
        return value

    payload = cast(dict[str, object], value)
    kind = str(payload.get("kind", "")).strip().lower()
    if kind == "configmap":
        data = payload.get("data")
        if not isinstance(data, dict):
            return None
        data_payload = cast(dict[str, object], data)
        strategies_yaml = data_payload.get("strategies.yaml")
        if not isinstance(strategies_yaml, str):
            return None
        try:
            nested_payload = cast(object, yaml.safe_load(strategies_yaml))
        except Exception:
            return None
        return _normalize_strategy_artifacts(nested_payload)

    return payload


def _is_runbook_valid(strategy_configmap_path: Path | None) -> bool:
    resolved_path = strategy_configmap_path or _default_strategy_configmap_path()
    if not resolved_path.exists() or not resolved_path.is_file():
        return False

    try:
        raw_payload = cast(
            object, yaml.safe_load(resolved_path.read_text(encoding="utf-8"))
        )
    except Exception:
        return False

    normalized_payload = _normalize_strategy_artifacts(raw_payload)

    if normalized_payload is None:
        return False

    if isinstance(normalized_payload, dict):
        payload = cast(dict[str, object], normalized_payload)
        strategies = payload.get("strategies")
    elif isinstance(normalized_payload, list):
        strategies = cast(list[object], normalized_payload)
    else:
        return False

    if not isinstance(strategies, list):
        return False

    strategy_items = cast(list[object], strategies)
    return bool(strategy_items) and all(
        isinstance(item, dict) for item in strategy_items
    )


def _build_candidate_state_payload(
    *,
    candidate_id: str,
    run_id: str,
    promotion_target: PromotionTarget,
    approval_token: str | None,
    runtime_strategies: list[StrategyRuntimeConfig],
    now: datetime,
    code_version: str,
    runbook_validated: bool,
    dependency_quorum_payload: dict[str, Any],
    alpha_readiness_payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "candidateId": candidate_id,
        "runId": run_id,
        "activeStage": "gate-evaluation",
        "paused": False,
        "datasetSnapshotRef": "signals_window",
        "noSignalReason": None,
        "runbookValidated": runbook_validated,
        "dependencyQuorum": dependency_quorum_payload,
        "alphaReadiness": alpha_readiness_payload,
        "rollbackReadiness": {
            "killSwitchDryRunPassed": bool(runtime_strategies),
            "gitopsRevertDryRunPassed": (
                promotion_target != "live" or bool(approval_token)
            ),
            "strategyDisableDryRunPassed": bool(runtime_strategies),
            "dryRunCompletedAt": now.isoformat(),
            "humanApproved": promotion_target != "live" or bool(approval_token),
            "rollbackTarget": f"{code_version or 'unknown'}",
        },
    }


def _build_candidate_alpha_readiness_payload(
    *,
    runtime_strategies: Sequence[StrategyRuntimeConfig],
) -> tuple[dict[str, Any], dict[str, Any]]:
    registry = load_hypothesis_registry()
    dependency_quorum = resolve_hypothesis_dependency_quorum(registry)
    strategy_families = sorted(
        {
            str(strategy.strategy_type).strip()
            for strategy in runtime_strategies
            if str(strategy.strategy_type).strip()
        }
    )
    matched_hypotheses = [
        manifest
        for manifest in registry.items
        if manifest.strategy_family in strategy_families
    ]
    matched_strategy_families = {
        manifest.strategy_family for manifest in matched_hypotheses
    }
    missing_strategy_families = sorted(
        family
        for family in strategy_families
        if family not in matched_strategy_families
    )
    reasons: list[str] = []
    if not registry.loaded:
        reasons.append("hypothesis_registry_unavailable")
    if registry.errors:
        reasons.append("hypothesis_registry_errors_present")
    if missing_strategy_families:
        reasons.append("strategy_family_hypothesis_unmapped")
    if dependency_quorum.decision != "allow":
        reasons.append(f"jangar_dependency_quorum_{dependency_quorum.decision}")
    return (
        {
            "mode": "candidate_alignment_v1",
            "registry_loaded": registry.loaded,
            "registry_path": registry.path,
            "registry_errors": list(registry.errors),
            "strategy_families": strategy_families,
            "matched_hypothesis_ids": sorted(
                {manifest.hypothesis_id for manifest in matched_hypotheses}
            ),
            "missing_strategy_families": missing_strategy_families,
            "promotion_eligible": (
                registry.loaded
                and not registry.errors
                and not missing_strategy_families
                and dependency_quorum.decision == "allow"
            ),
            "reasons": reasons,
            "dependency_quorum": dependency_quorum.as_payload(),
        },
        dependency_quorum.as_payload(),
    )


normalize_strategy_artifacts = _normalize_strategy_artifacts
is_runbook_valid = _is_runbook_valid
build_candidate_state_payload = _build_candidate_state_payload
build_candidate_alpha_readiness_payload = _build_candidate_alpha_readiness_payload

__all__ = [
    "normalize_strategy_artifacts",
    "is_runbook_valid",
    "build_candidate_state_payload",
    "build_candidate_alpha_readiness_payload",
]
