# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Mapping, Sequence, cast

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_12 import *
from .part_02_runtime_ledger_lineage_handoff_blockers import *
from .part_03_evidence_bundle_from_frontier_candidate import *
from .part_04_implementation_risk_backtest_stability_blo import *


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


__all__ = [name for name in globals() if not name.startswith("__")]
