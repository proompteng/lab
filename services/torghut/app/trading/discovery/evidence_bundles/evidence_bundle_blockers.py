"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Mapping, Sequence, cast


from .shared_context import (
    ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS,
    ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS,
    BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS,
    CONFORMAL_COST_BUFFER_SCORECARD_KEYS,
    DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS,
    DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS,
    DELAY_ADJUSTED_DEPTH_STRESS_MS,
    DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS,
    EVIDENCE_BUNDLE_SCHEMA_VERSION,
    FILL_SURVIVAL_SCORECARD_KEYS,
    MARKET_IMPACT_SCORECARD_KEYS,
    MARKET_IMPACT_STRESS_COST_BPS,
    MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT,
    OFI_RESPONSE_HORIZON_SCORECARD_KEYS,
    REPLAY_ACTIVITY_SCORECARD_KEYS,
    RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS,
    STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS,
    VALID_COST_CALIBRATION_STATUSES,
    artifact_refs_from_scorecard as _artifact_refs_from_scorecard,
    bool_value as _bool,
    decimal as _decimal,
    decimal_mapping_total as _decimal_mapping_total,
    frontier_replay_params as _frontier_replay_params,
    frontier_strategy_overrides as _frontier_strategy_overrides,
    int_value as _int,
    int_mapping as _int_mapping,
    mapping as _mapping,
    order_lifecycle_metrics as _order_lifecycle_metrics,
    order_type_ablation_metrics as _order_type_ablation_metrics,
    order_type_execution_metrics as _order_type_execution_metrics,
    runtime_ledger_lineage_handoff as _runtime_ledger_lineage_handoff,
    stable_hash as _stable_hash,
    string as _string,
    string_list as _string_list,
)
from .runtime_ledger_lineage_handoff_blockers import (
    CandidateEvidenceBundle,
    decomposition_activity_counts as _decomposition_activity_counts,
    decomposition_symbol_contribution_shares as _decomposition_symbol_contribution_shares,
    delay_depth_fillability as _delay_depth_fillability,
    enrich_scorecard_with_replay_stress_metrics as _enrich_scorecard_with_replay_stress_metrics,
    is_synthetic_dataset_snapshot as _is_synthetic_dataset_snapshot,
    p10 as _p10,
    runtime_ledger_lineage_handoff_blockers as _runtime_ledger_lineage_handoff_blockers,
    scorecard_with_freshness_lineage as _scorecard_with_freshness_lineage,
    evidence_bundle_id_for_payload,
)
from .evidence_bundle_from_frontier_candidate import (
    delay_depth_survival_blockers as _delay_depth_survival_blockers,
    has_artifact_ref as _has_artifact_ref,
    implementation_risk_backtest_stability_required as _implementation_risk_backtest_stability_required,
    implementation_uncertainty_blockers as _implementation_uncertainty_blockers,
    market_impact_stress_blockers as _market_impact_stress_blockers,
    order_type_execution_blockers as _order_type_execution_blockers,
    requires_promotion_proof as _requires_promotion_proof,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from .implementation_risk_backtest_stability_blo import (
    adaptive_signal_falsification_blockers as _adaptive_signal_falsification_blockers,
    alpha_decay_predictability_blockers as _alpha_decay_predictability_blockers,
    bootstrap_robust_optimization_blockers as _bootstrap_robust_optimization_blockers,
    conformal_tail_risk_blockers as _conformal_tail_risk_blockers,
    implementation_risk_backtest_stability_blockers as _implementation_risk_backtest_stability_blockers,
    ofi_response_horizon_blockers as _ofi_response_horizon_blockers,
    stochastic_liquidity_resilience_blockers as _stochastic_liquidity_resilience_blockers,
)


def evidence_bundle_blockers(bundle: CandidateEvidenceBundle) -> tuple[str, ...]:
    blockers: list[str] = []
    if not _string(bundle.dataset_snapshot_id):
        blockers.append("dataset_snapshot_missing")
    if not bundle.replay_artifact_refs or not any(
        _string(item) for item in bundle.replay_artifact_refs
    ):
        blockers.append("replay_artifact_missing")

    cost_status = _string(bundle.cost_calibration.get("status")).lower()
    cost_source = _string(bundle.cost_calibration.get("source"))
    if not bundle.cost_calibration:
        blockers.append("cost_calibration_missing")
    elif cost_status not in VALID_COST_CALIBRATION_STATUSES:
        blockers.append("cost_calibration_status_invalid")
    elif not cost_source:
        blockers.append("cost_calibration_source_missing")

    scorecard = bundle.objective_scorecard
    if bool(scorecard.get("stale_tape")) or bool(scorecard.get("stale_override_used")):
        blockers.append("stale_tape")
    freshness = _string(
        scorecard.get("dataset_freshness_status")
        or scorecard.get("tape_freshness_status")
        or scorecard.get("freshness_status")
    ).lower()
    if freshness in {"stale", "expired", "not_fresh"}:
        blockers.append("stale_tape")
    replay_tape = _mapping(scorecard.get("replay_tape"))
    replay_status = _string(
        replay_tape.get("status") or replay_tape.get("validation_status")
    ).lower()
    if _bool(replay_tape.get("stale_override_used")) or replay_status in {
        "stale_override",
        "stale",
    }:
        blockers.append("stale_tape")
    dataset_receipt = _mapping(scorecard.get("dataset_snapshot_receipt"))
    if _bool(dataset_receipt.get("stale_override_used")):
        blockers.append("stale_tape")
    receipt_is_fresh = dataset_receipt.get("is_fresh")
    if receipt_is_fresh is not None and not _bool(receipt_is_fresh):
        blockers.append("stale_tape")
    validation_contract = _mapping(
        scorecard.get("validation_contract")
        or bundle.promotion_readiness.get("validation_contract")
    )
    if _string(
        validation_contract.get("synthetic_evidence_policy")
    ) == "validation_only_not_promotion_proof" and _is_synthetic_dataset_snapshot(
        bundle.dataset_snapshot_id
    ):
        blockers.append("synthetic_evidence_not_promotion_proof")
    if _requires_promotion_proof(bundle):
        blockers.extend(
            _runtime_ledger_lineage_handoff_blockers(
                scorecard=scorecard,
                promotion_readiness=bundle.promotion_readiness,
            )
        )
        blockers.extend(_market_impact_stress_blockers(scorecard))
        blockers.extend(_order_type_execution_blockers(scorecard))
        blockers.extend(_implementation_uncertainty_blockers(scorecard))
        blockers.extend(_implementation_risk_backtest_stability_blockers(scorecard))
        blockers.extend(_bootstrap_robust_optimization_blockers(scorecard))
        blockers.extend(
            _adaptive_signal_falsification_blockers(
                scorecard=scorecard,
                null_comparator=bundle.null_comparator,
            )
        )
        blockers.extend(_ofi_response_horizon_blockers(scorecard))
        blockers.extend(_alpha_decay_predictability_blockers(scorecard))
        blockers.extend(_stochastic_liquidity_resilience_blockers(scorecard))
        blockers.extend(_conformal_tail_risk_blockers(scorecard))
        blockers.extend(_delay_depth_survival_blockers(scorecard))
    return tuple(dict.fromkeys(blockers))


def evidence_bundle_is_valid(bundle: CandidateEvidenceBundle) -> bool:
    return not evidence_bundle_blockers(bundle)


# Explicit module exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS",
    "ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS",
    "Any",
    "BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS",
    "CONFORMAL_COST_BUFFER_SCORECARD_KEYS",
    "CandidateEvidenceBundle",
    "DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS",
    "DELAY_ADJUSTED_DEPTH_STRESS_GRID_MS",
    "DELAY_ADJUSTED_DEPTH_STRESS_MS",
    "DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS",
    "Decimal",
    "EVIDENCE_BUNDLE_SCHEMA_VERSION",
    "FILL_SURVIVAL_SCORECARD_KEYS",
    "InvalidOperation",
    "Literal",
    "MARKET_IMPACT_SCORECARD_KEYS",
    "MARKET_IMPACT_STRESS_COST_BPS",
    "MIN_CONFORMAL_TAIL_RISK_SAMPLE_COUNT",
    "Mapping",
    "OFI_RESPONSE_HORIZON_SCORECARD_KEYS",
    "REPLAY_ACTIVITY_SCORECARD_KEYS",
    "RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS",
    "STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS",
    "Sequence",
    "VALID_COST_CALIBRATION_STATUSES",
    "_adaptive_signal_falsification_blockers",
    "_alpha_decay_predictability_blockers",
    "_artifact_refs_from_scorecard",
    "_bool",
    "_bootstrap_robust_optimization_blockers",
    "_conformal_tail_risk_blockers",
    "_decimal",
    "_decimal_mapping_total",
    "_decomposition_activity_counts",
    "_decomposition_symbol_contribution_shares",
    "_delay_depth_fillability",
    "_delay_depth_survival_blockers",
    "_enrich_scorecard_with_replay_stress_metrics",
    "_frontier_replay_params",
    "_frontier_strategy_overrides",
    "_has_artifact_ref",
    "_implementation_risk_backtest_stability_blockers",
    "_implementation_risk_backtest_stability_required",
    "_implementation_uncertainty_blockers",
    "_int",
    "_int_mapping",
    "_is_synthetic_dataset_snapshot",
    "_mapping",
    "_market_impact_stress_blockers",
    "_ofi_response_horizon_blockers",
    "_order_lifecycle_metrics",
    "_order_type_ablation_metrics",
    "_order_type_execution_blockers",
    "_order_type_execution_metrics",
    "_p10",
    "_requires_promotion_proof",
    "_runtime_ledger_lineage_handoff",
    "_runtime_ledger_lineage_handoff_blockers",
    "_scorecard_with_freshness_lineage",
    "_stable_hash",
    "_stochastic_liquidity_resilience_blockers",
    "_string",
    "_string_list",
    "annotations",
    "cast",
    "dataclass",
    "evidence_bundle_blockers",
    "evidence_bundle_from_frontier_candidate",
    "evidence_bundle_from_payload",
    "evidence_bundle_id_for_payload",
    "evidence_bundle_is_valid",
    "hashlib",
    "json",
)
