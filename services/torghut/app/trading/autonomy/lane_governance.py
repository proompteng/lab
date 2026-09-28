"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from .gates import (
    GateEvaluationReport,
)
from .runtime import (
    StrategyRuntimeConfig,
)
from .lane_phase_payloads import (
    coerce_str as _coerce_str,
)

from .lane_config_loading import (
    strategy_parameter_set as _strategy_parameter_set,
)


def _runtime_observation_contract_payload(
    candidate_spec_payload: Mapping[str, Any],
) -> dict[str, Any]:
    payload = candidate_spec_payload.get("runtime_observation")
    if isinstance(payload, dict):
        return cast(dict[str, Any], payload)
    return {}


def _runtime_observation_has_ledger_profit_proof(
    runtime_observation_payload: Mapping[str, Any],
) -> bool:
    return bool(runtime_observation_payload.get("runtime_ledger_profit_proof_present"))


def _resolve_hypothesis_window_evidence(
    *,
    promotion_target: str,
    runtime_observation_payload: Mapping[str, Any],
    effective_promotion_allowed: bool,
    order_count: int,
    min_sample_count_for_scale_up: int,
) -> tuple[str, str, str, dict[str, Any]]:
    observed_stage = "paper" if promotion_target == "paper" else "live"
    expected_provenance = (
        "paper_runtime_observed"
        if observed_stage == "paper"
        else "live_runtime_observed"
    )
    runtime_observation_stage = _coerce_str(
        runtime_observation_payload.get("observed_stage")
    )
    runtime_observation_provenance = _coerce_str(
        runtime_observation_payload.get("evidence_provenance")
    )
    runtime_observation_authoritative = bool(
        runtime_observation_payload.get("authoritative")
    )
    runtime_observation_source_kind = _coerce_str(
        runtime_observation_payload.get("source_kind")
    )
    runtime_observation_has_runtime_ledger_profit_proof = (
        _runtime_observation_has_ledger_profit_proof(runtime_observation_payload)
    )
    simulation_observation = runtime_observation_source_kind.startswith("simulation_")
    qualified_runtime_observation = (
        runtime_observation_authoritative
        and runtime_observation_stage == observed_stage
        and runtime_observation_provenance == expected_provenance
        and not simulation_observation
    )
    if qualified_runtime_observation:
        evidence_provenance = expected_provenance
        evidence_maturity = (
            "empirically_validated"
            if order_count > 0 and effective_promotion_allowed
            else "uncalibrated"
        )
        if observed_stage == "paper":
            capital_stage = "shadow"
        elif (
            effective_promotion_allowed and order_count >= min_sample_count_for_scale_up
        ):
            capital_stage = "0.50x live"
        elif effective_promotion_allowed:
            capital_stage = "0.10x canary"
        else:
            capital_stage = "shadow"
        qualification_reason = "runtime_observation_contract_qualified"
    else:
        evidence_provenance = "historical_market_replay"
        evidence_maturity = (
            "calibrated"
            if order_count > 0 and effective_promotion_allowed
            else "uncalibrated"
        )
        capital_stage = "shadow"
        qualification_reason = (
            "simulation_source_replay_only"
            if simulation_observation
            else "runtime_observation_contract_missing_or_ineligible"
        )
    return (
        evidence_provenance,
        evidence_maturity,
        capital_stage,
        {
            "requested_promotion_target": promotion_target,
            "runtime_observation_present": bool(runtime_observation_payload),
            "runtime_observation_authoritative": runtime_observation_authoritative,
            "runtime_observation_stage": runtime_observation_stage,
            "runtime_observation_provenance": runtime_observation_provenance,
            "runtime_observation_source_kind": runtime_observation_source_kind,
            "runtime_observation_has_runtime_ledger_profit_proof": (
                runtime_observation_has_runtime_ledger_profit_proof
            ),
            "qualified_runtime_observation": qualified_runtime_observation,
            "qualification_reason": qualification_reason,
        },
    )


def _compute_candidate_hash(
    *,
    run_id: str,
    runtime_strategies: list[StrategyRuntimeConfig],
    gate_report: GateEvaluationReport,
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    stage_lineage_payload: dict[str, Any],
    replay_artifact_hashes: dict[str, str],
) -> str:
    hasher = hashlib.sha256()
    hasher.update(signals_path.read_bytes())
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(run_id.encode("utf-8"))
    hasher.update(str(_strategy_parameter_set(runtime_strategies)).encode("utf-8"))
    hasher.update(gate_report.recommended_mode.encode("utf-8"))
    hasher.update(str(sorted(gate_report.reasons)).encode("utf-8"))
    hasher.update(
        json.dumps(
            stage_lineage_payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    hasher.update(
        json.dumps(
            replay_artifact_hashes,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    return hasher.hexdigest()[:32]


def _build_promotion_rationale(
    *,
    gate_report: GateEvaluationReport,
    promotion_check_reasons: list[str],
    rollback_check_reasons: list[str],
    promotion_target: str,
    additional_reasons: Sequence[str] = (),
) -> str:
    if (
        gate_report.promotion_allowed
        and not promotion_check_reasons
        and not rollback_check_reasons
        and not additional_reasons
    ):
        return (
            f"all_required_gates_passed_for_{promotion_target}_promotion_"
            f"recommended_mode_{gate_report.recommended_mode}"
        )
    reasons = sorted(
        set(
            [
                *gate_report.reasons,
                *promotion_check_reasons,
                *rollback_check_reasons,
                *additional_reasons,
            ]
        )
    )
    if not reasons:
        return f"promotion_target_{promotion_target}_held_without_additional_reasons"
    return f"promotion_blocked_or_held:{','.join(reasons)}"


runtime_observation_contract_payload = _runtime_observation_contract_payload
runtime_observation_has_ledger_profit_proof = (
    _runtime_observation_has_ledger_profit_proof
)
resolve_hypothesis_window_evidence = _resolve_hypothesis_window_evidence
compute_candidate_hash = _compute_candidate_hash
build_promotion_rationale = _build_promotion_rationale

__all__ = [
    "_runtime_observation_contract_payload",
    "_runtime_observation_has_ledger_profit_proof",
    "_resolve_hypothesis_window_evidence",
    "_compute_candidate_hash",
    "_build_promotion_rationale",
]
