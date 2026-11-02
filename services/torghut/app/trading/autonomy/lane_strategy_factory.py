"""Strategy-factory bridge helpers for the autonomous lane."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, cast

import pandas as pd

from ..alpha.lane import AlphaLaneResult, run_alpha_discovery_lane
from .lane_stage_artifacts import load_json_if_exists as _load_json_if_exists


@dataclass(frozen=True)
class _StrategyFactoryBridge:
    result: AlphaLaneResult
    candidate_spec_payload: dict[str, Any]
    evaluation_payload: dict[str, Any]
    recommendation_payload: dict[str, Any]
    attempt_payload: dict[str, Any]
    validation_payloads: dict[str, dict[str, Any]]
    sequential_trial_payload: dict[str, Any]
    cost_calibration_payload: dict[str, Any]


def _load_price_frame(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, index_col=0, parse_dates=True)


def _build_strategy_factory_bridge(
    *,
    output_dir: Path,
    notes_artifact_root: str | None,
    train_prices_path: Path | None,
    test_prices_path: Path | None,
    alpha_gate_policy_path: Path | None,
    repository: str | None,
    base: str | None,
    head: str | None,
    priority_id: str | None,
    promotion_target: str,
    now: datetime,
) -> _StrategyFactoryBridge | None:
    if train_prices_path is None or test_prices_path is None:
        return None

    bridge_result = run_alpha_discovery_lane(
        artifact_path=output_dir / "strategy-factory",
        train_prices=_load_price_frame(train_prices_path),
        test_prices=_load_price_frame(test_prices_path),
        repository=repository,
        base=base,
        head=head,
        priority_id=priority_id,
        notes_artifact_path=notes_artifact_root,
        gate_policy_path=alpha_gate_policy_path,
        promotion_target=promotion_target,
        evaluated_at=now,
        persist_results=False,
    )
    validation_payloads: dict[str, dict[str, Any]] = {}
    for test_name, artifact_path in bridge_result.validation_artifact_paths.items():
        validation_payload = _load_json_if_exists(artifact_path)
        if validation_payload is None:
            continue
        validation_payloads[test_name] = validation_payload
    return _StrategyFactoryBridge(
        result=bridge_result,
        candidate_spec_payload=_load_json_if_exists(bridge_result.candidate_spec_path)
        or {},
        evaluation_payload=_load_json_if_exists(bridge_result.evaluation_report_path)
        or {},
        recommendation_payload=_load_json_if_exists(
            bridge_result.recommendation_artifact_path
        )
        or {},
        attempt_payload=_load_json_if_exists(bridge_result.attempt_ledger_path) or {},
        validation_payloads=validation_payloads,
        sequential_trial_payload=_load_json_if_exists(
            bridge_result.sequential_trial_path
        )
        or {},
        cost_calibration_payload=_load_json_if_exists(
            bridge_result.cost_calibration_path
        )
        or {},
    )


def _strategy_factory_gate_summary(
    bridge: _StrategyFactoryBridge,
    *,
    promotion_target: str,
) -> tuple[bool, list[str], dict[str, Any]]:
    reasons: list[str] = []
    recommendation = (
        cast(dict[str, Any], bridge.recommendation_payload.get("recommendation"))
        if isinstance(bridge.recommendation_payload.get("recommendation"), dict)
        else {}
    )
    strategy_payload = (
        cast(dict[str, Any], bridge.candidate_spec_payload.get("strategy_factory"))
        if isinstance(bridge.candidate_spec_payload.get("strategy_factory"), dict)
        else {}
    )
    economic_card = (
        cast(dict[str, Any], strategy_payload.get("economic_validity_card"))
        if isinstance(strategy_payload.get("economic_validity_card"), dict)
        else {}
    )
    comparator = (
        cast(dict[str, Any], strategy_payload.get("null_comparator_summary"))
        if isinstance(strategy_payload.get("null_comparator_summary"), dict)
        else {}
    )
    sequential = bridge.sequential_trial_payload
    calibration = bridge.cost_calibration_payload

    if not bool(recommendation.get("eligible")):
        reasons.append("strategy_factory_recommendation_not_eligible")
    if str(economic_card.get("status") or "").strip().lower() != "pass":
        reasons.append("strategy_factory_economic_validity_failed")
    if not bool(comparator.get("baseline_outperformed")):
        reasons.append("strategy_factory_baseline_not_outperformed")

    sequential_status = str(sequential.get("status") or "").strip().lower()
    calibration_status = str(calibration.get("status") or "").strip().lower()
    if promotion_target in {"paper", "live"} and sequential_status not in {
        "paper_ready",
        "paper_only",
    }:
        reasons.append("strategy_factory_sequential_not_ready")
    if promotion_target == "live":
        if sequential_status != "paper_ready":
            reasons.append("strategy_factory_live_requires_paper_ready")
        if calibration_status != "calibrated":
            reasons.append("strategy_factory_live_requires_calibrated_costs")

    summary = {
        "allowed": len(reasons) == 0,
        "reasons": reasons,
        "candidate_spec_artifact": str(bridge.result.candidate_spec_path),
        "evaluation_artifact": str(bridge.result.evaluation_report_path),
        "recommendation_artifact": str(bridge.result.recommendation_artifact_path),
        "attempt_ledger_artifact": str(bridge.result.attempt_ledger_path),
        "sequential_trial_artifact": str(bridge.result.sequential_trial_path),
        "cost_calibration_artifact": str(bridge.result.cost_calibration_path),
        "sequential_status": sequential_status or None,
        "cost_calibration_status": calibration_status or None,
        "baseline_outperformed": comparator.get("baseline_outperformed"),
        "posterior_edge_summary": strategy_payload.get("posterior_edge_summary"),
    }
    return len(reasons) == 0, reasons, summary


def _strategy_factory_artifact_refs(
    bridge: _StrategyFactoryBridge | None,
) -> list[str]:
    if bridge is None:
        return []
    refs = [
        bridge.result.candidate_spec_path,
        bridge.result.evaluation_report_path,
        bridge.result.recommendation_artifact_path,
        bridge.result.attempt_ledger_path,
        bridge.result.sequential_trial_path,
        bridge.result.cost_calibration_path,
        bridge.result.candidate_generation_manifest_path,
        bridge.result.evaluation_manifest_path,
        bridge.result.recommendation_manifest_path,
        *bridge.result.validation_artifact_paths.values(),
    ]
    return [str(path) for path in refs]


StrategyFactoryBridge = _StrategyFactoryBridge
load_price_frame = _load_price_frame
build_strategy_factory_bridge = _build_strategy_factory_bridge
strategy_factory_gate_summary = _strategy_factory_gate_summary
strategy_factory_artifact_refs = _strategy_factory_artifact_refs

__all__ = [
    "StrategyFactoryBridge",
    "load_price_frame",
    "build_strategy_factory_bridge",
    "strategy_factory_gate_summary",
    "strategy_factory_artifact_refs",
]
