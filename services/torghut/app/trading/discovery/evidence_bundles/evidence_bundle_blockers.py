"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Mapping, Sequence, cast

from .evidence_bundle_from_frontier_candidate import (
    delay_depth_survival_blockers as _delay_depth_survival_blockers,
)
from .evidence_bundle_from_frontier_candidate import (
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from .evidence_bundle_from_frontier_candidate import (
    has_artifact_ref as _has_artifact_ref,
)
from .evidence_bundle_from_frontier_candidate import (
    implementation_uncertainty_blockers as _implementation_uncertainty_blockers,
)
from .evidence_bundle_from_frontier_candidate import (
    market_impact_stress_blockers as _market_impact_stress_blockers,
)
from .evidence_bundle_from_frontier_candidate import (
    order_type_execution_blockers as _order_type_execution_blockers,
)
from .evidence_bundle_from_frontier_candidate import (
    requires_promotion_proof as _requires_promotion_proof,
)
from .implementation_risk_backtest_stability_blo import (
    adaptive_signal_falsification_blockers as _adaptive_signal_falsification_blockers,
)
from .implementation_risk_backtest_stability_blo import (
    alpha_decay_predictability_blockers as _alpha_decay_predictability_blockers,
)
from .implementation_risk_backtest_stability_blo import (
    bootstrap_robust_optimization_blockers as _bootstrap_robust_optimization_blockers,
)
from .implementation_risk_backtest_stability_blo import (
    conformal_tail_risk_blockers as _conformal_tail_risk_blockers,
)
from .implementation_risk_backtest_stability_blo import (
    implementation_risk_backtest_stability_blockers as _implementation_risk_blockers,
)
from .implementation_risk_backtest_stability_blo import (
    ofi_response_horizon_blockers as _ofi_response_horizon_blockers,
)
from .implementation_risk_backtest_stability_blo import (
    stochastic_liquidity_resilience_blockers as _stochastic_liquidity_blockers,
)
from .runtime_ledger_lineage_handoff_blockers import (
    CandidateEvidenceBundle,
    evidence_bundle_id_for_payload,
)
from .runtime_ledger_lineage_handoff_blockers import (
    decomposition_activity_counts as _decomposition_activity_counts,
)
from .runtime_ledger_lineage_handoff_blockers import (
    delay_depth_fillability as _delay_depth_fillability,
)
from .runtime_ledger_lineage_handoff_blockers import (
    is_synthetic_dataset_snapshot as _is_synthetic_dataset_snapshot,
)
from .runtime_ledger_lineage_handoff_blockers import (
    p10 as _p10,
)
from .runtime_ledger_lineage_handoff_blockers import (
    runtime_ledger_lineage_handoff_blockers as _runtime_ledger_lineage_handoff_blockers,
)
from .runtime_ledger_lineage_handoff_blockers import (
    scorecard_with_freshness_lineage as _scorecard_with_freshness_lineage,
)
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
)
from .shared_context import (
    artifact_refs_from_scorecard as _artifact_refs_from_scorecard,
)
from .shared_context import (
    bool_value as _bool,
)
from .shared_context import (
    decimal as _decimal,
)
from .shared_context import (
    decimal_mapping_total as _decimal_mapping_total,
)
from .shared_context import (
    frontier_replay_params as _frontier_replay_params,
)
from .shared_context import (
    frontier_strategy_overrides as _frontier_strategy_overrides,
)
from .shared_context import (
    int_mapping as _int_mapping,
)
from .shared_context import (
    int_value as _int,
)
from .shared_context import (
    mapping as _mapping,
)
from .shared_context import (
    order_lifecycle_metrics as _order_lifecycle_metrics,
)
from .shared_context import (
    order_type_ablation_metrics as _order_type_ablation_metrics,
)
from .shared_context import (
    order_type_execution_metrics as _order_type_execution_metrics,
)
from .shared_context import (
    runtime_ledger_lineage_handoff as _runtime_ledger_lineage_handoff,
)
from .shared_context import (
    stable_hash as _stable_hash,
)
from .shared_context import (
    string as _string,
)
from .shared_context import (
    string_list as _string_list,
)


def evidence_bundle_blockers(bundle: CandidateEvidenceBundle) -> tuple[str, ...]:
    blockers: list[str] = []
    scorecard = bundle.objective_scorecard
    blockers.extend(_dataset_replay_blockers(bundle))
    blockers.extend(_cost_calibration_blockers(bundle))
    blockers.extend(_freshness_blockers(scorecard))
    blockers.extend(_synthetic_policy_blockers(bundle=bundle, scorecard=scorecard))
    if _requires_promotion_proof(bundle):
        blockers.extend(_promotion_proof_blockers(bundle=bundle, scorecard=scorecard))
    return tuple(dict.fromkeys(blockers))


def _dataset_replay_blockers(bundle: CandidateEvidenceBundle) -> list[str]:
    blockers: list[str] = []
    if not _string(bundle.dataset_snapshot_id):
        blockers.append("dataset_snapshot_missing")
    if not bundle.replay_artifact_refs or not any(
        _string(item) for item in bundle.replay_artifact_refs
    ):
        blockers.append("replay_artifact_missing")
    return blockers


def _cost_calibration_blockers(bundle: CandidateEvidenceBundle) -> list[str]:
    blockers: list[str] = []
    cost_status = _string(bundle.cost_calibration.get("status")).lower()
    cost_source = _string(bundle.cost_calibration.get("source"))
    if not bundle.cost_calibration:
        blockers.append("cost_calibration_missing")
    elif cost_status not in VALID_COST_CALIBRATION_STATUSES:
        blockers.append("cost_calibration_status_invalid")
    elif not cost_source:
        blockers.append("cost_calibration_source_missing")
    return blockers


def _freshness_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
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
    return blockers


def _synthetic_policy_blockers(
    *,
    bundle: CandidateEvidenceBundle,
    scorecard: Mapping[str, Any],
) -> list[str]:
    validation_contract = _mapping(
        scorecard.get("validation_contract")
        or bundle.promotion_readiness.get("validation_contract")
    )
    if _string(
        validation_contract.get("synthetic_evidence_policy")
    ) == "validation_only_not_promotion_proof" and _is_synthetic_dataset_snapshot(
        bundle.dataset_snapshot_id
    ):
        return ["synthetic_evidence_not_promotion_proof"]
    return []


def _promotion_proof_blockers(
    *,
    bundle: CandidateEvidenceBundle,
    scorecard: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    blockers.extend(
        _runtime_ledger_lineage_handoff_blockers(
            scorecard=scorecard,
            promotion_readiness=bundle.promotion_readiness,
        )
    )
    blockers.extend(_market_impact_stress_blockers(scorecard))
    blockers.extend(_order_type_execution_blockers(scorecard))
    blockers.extend(_implementation_uncertainty_blockers(scorecard))
    blockers.extend(_implementation_risk_blockers(scorecard))
    blockers.extend(_bootstrap_robust_optimization_blockers(scorecard))
    blockers.extend(
        _adaptive_signal_falsification_blockers(
            scorecard=scorecard,
            null_comparator=bundle.null_comparator,
        )
    )
    blockers.extend(_ofi_response_horizon_blockers(scorecard))
    blockers.extend(_alpha_decay_predictability_blockers(scorecard))
    blockers.extend(_stochastic_liquidity_blockers(scorecard))
    blockers.extend(_conformal_tail_risk_blockers(scorecard))
    blockers.extend(_delay_depth_survival_blockers(scorecard))
    return blockers


def evidence_bundle_is_valid(bundle: CandidateEvidenceBundle) -> bool:
    return not evidence_bundle_blockers(bundle)


# Explicit exports keep re-export imports intentional without file-level Ruff ignores.
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
    "_delay_depth_fillability",
    "_delay_depth_survival_blockers",
    "_frontier_replay_params",
    "_frontier_strategy_overrides",
    "_has_artifact_ref",
    "_implementation_risk_blockers",
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
    "_stochastic_liquidity_blockers",
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
