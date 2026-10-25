"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

from typing import Any, Mapping, Sequence, cast

from . import shared_context as _shared
from .frontier_candidate_scorecard import (
    frontier_candidate_adaptive_signal_falsification_stress,
    frontier_candidate_null_comparator,
    frontier_candidate_scorecard,
    frontier_candidate_stress_metrics,
)
from .runtime_ledger_lineage_handoff_blockers import (
    CandidateEvidenceBundle,
    evidence_bundle_id_for_payload,
)

EVIDENCE_BUNDLE_SCHEMA_VERSION = _shared.EVIDENCE_BUNDLE_SCHEMA_VERSION
MARKET_IMPACT_STRESS_COST_BPS = _shared.MARKET_IMPACT_STRESS_COST_BPS
_artifact_refs_from_scorecard = _shared.artifact_refs_from_scorecard
_bool = _shared.bool_value
_decimal = _shared.decimal
_int = _shared.int_value
_mapping = _shared.mapping
_stable_hash = _shared.stable_hash
_string = _shared.string
_string_list = _shared.string_list


def evidence_bundle_from_frontier_candidate(
    *,
    candidate_spec_id: str,
    candidate: Mapping[str, Any],
    dataset_snapshot_id: str,
    result_path: str,
    code_commit: str = "unknown",
) -> CandidateEvidenceBundle:
    candidate_id = _string(candidate.get("candidate_id")) or candidate_spec_id
    scorecard = frontier_candidate_scorecard(
        candidate=candidate,
        result_path=result_path,
    )
    adaptive_signal_falsification_stress = (
        frontier_candidate_adaptive_signal_falsification_stress(candidate)
    )
    payload_seed = {
        "candidate_id": candidate_id,
        "candidate_spec_id": candidate_spec_id,
        "dataset_snapshot_id": dataset_snapshot_id,
        "objective_scorecard": scorecard,
    }
    promotion_readiness = _mapping(candidate.get("promotion_readiness")) or {
        "stage": "research_candidate",
        "status": "blocked_pending_runtime_parity",
        "promotable": False,
        "blockers": ["scheduler_v3_parity_missing", "shadow_validation_missing"],
    }
    replay_artifact_refs = tuple(
        dict.fromkeys(
            [
                result_path,
                *_artifact_refs_from_scorecard(scorecard),
            ]
        )
    )
    stress_metrics = frontier_candidate_stress_metrics(
        candidate=candidate,
        scorecard=scorecard,
    )
    return CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id=evidence_bundle_id_for_payload(payload_seed),
        candidate_id=candidate_id,
        candidate_spec_id=candidate_spec_id,
        dataset_snapshot_id=dataset_snapshot_id,
        feature_spec_hash=_stable_hash(
            {"candidate_spec_id": candidate_spec_id, "scorecard": scorecard}
        ),
        code_commit=code_commit,
        replay_artifact_refs=replay_artifact_refs,
        objective_scorecard=scorecard,
        fold_metrics=tuple(
            cast(Sequence[Mapping[str, Any]], candidate.get("fold_metrics") or ())
        ),
        stress_metrics=stress_metrics,
        cost_calibration=_mapping(candidate.get("cost_calibration"))
        or {"status": "provisional", "source": "frontier_replay"},
        null_comparator=frontier_candidate_null_comparator(
            candidate=candidate,
            scorecard=scorecard,
            adaptive_signal_falsification_stress=adaptive_signal_falsification_stress,
        ),
        promotion_readiness=promotion_readiness,
    )


def evidence_bundle_from_payload(payload: Mapping[str, Any]) -> CandidateEvidenceBundle:
    schema_version = _string(payload.get("schema_version"))
    if schema_version != EVIDENCE_BUNDLE_SCHEMA_VERSION:
        raise ValueError(f"evidence_bundle_schema_invalid:{schema_version}")
    return CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id=_string(payload.get("evidence_bundle_id")),
        candidate_id=_string(payload.get("candidate_id")),
        candidate_spec_id=_string(payload.get("candidate_spec_id")),
        dataset_snapshot_id=_string(payload.get("dataset_snapshot_id")),
        feature_spec_hash=_string(payload.get("feature_spec_hash")),
        code_commit=_string(payload.get("code_commit")),
        replay_artifact_refs=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("replay_artifact_refs") or [])
        ),
        objective_scorecard=_mapping(payload.get("objective_scorecard")),
        fold_metrics=tuple(
            cast(Mapping[str, Any], item)
            for item in cast(Sequence[Any], payload.get("fold_metrics") or [])
            if isinstance(item, Mapping)
        ),
        stress_metrics=tuple(
            cast(Mapping[str, Any], item)
            for item in cast(Sequence[Any], payload.get("stress_metrics") or [])
            if isinstance(item, Mapping)
        ),
        cost_calibration=_mapping(payload.get("cost_calibration")),
        null_comparator=_mapping(payload.get("null_comparator")),
        promotion_readiness=_mapping(payload.get("promotion_readiness")),
    )


def requires_promotion_proof(bundle: CandidateEvidenceBundle) -> bool:
    readiness = bundle.promotion_readiness
    if _bool(readiness.get("promotable")):
        return True
    stage = _string(readiness.get("stage")).lower()
    status = _string(readiness.get("status")).lower()
    if stage and stage not in {"research_candidate", "research"}:
        return True
    return status in {
        "promotion_ready",
        "ready_for_promotion",
        "paper_probation",
        "paper_canary",
        "live_canary",
    }


def delay_depth_survival_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    blockers.extend(_delay_depth_stress_blockers(scorecard))
    blockers.extend(_fill_survival_blockers(scorecard))
    blockers.extend(_queue_ahead_depletion_blockers(scorecard))
    blockers.extend(_queue_position_survival_blockers(scorecard))
    return blockers


def _delay_depth_stress_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not _bool(scorecard.get("delay_adjusted_depth_stress_passed")):
        blockers.append("delay_adjusted_depth_stress_failed")
    if not _string(scorecard.get("delay_adjusted_depth_stress_model")):
        blockers.append("delay_adjusted_depth_stress_model_missing")
    if _decimal(scorecard.get("delay_adjusted_depth_stress_ms")) <= 0:
        blockers.append("delay_adjusted_depth_stress_ms_missing")
    if not _string(scorecard.get("delay_adjusted_depth_stress_artifact_ref")):
        blockers.append("delay_adjusted_depth_stress_artifact_missing")
    if not _bool(scorecard.get("delay_adjusted_depth_tail_coverage_passed")):
        blockers.append("delay_adjusted_depth_tail_coverage_missing")
    if (
        _decimal(scorecard.get("delay_adjusted_depth_p10_active_day_fillable_notional"))
        <= 0
    ):
        blockers.append("delay_adjusted_depth_p10_fillable_non_positive")
    if (
        _decimal(
            scorecard.get("delay_adjusted_depth_worst_active_day_fillable_notional")
        )
        <= 0
    ):
        blockers.append("delay_adjusted_depth_worst_fillable_non_positive")
    if _decimal(scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")) <= 0:
        blockers.append("delay_adjusted_depth_stress_net_pnl_non_positive")
    return blockers


def _fill_survival_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not (
        _bool(scorecard.get("fill_survival_evidence_present"))
        or _bool(scorecard.get("delay_adjusted_depth_fill_survival_evidence_present"))
    ):
        blockers.append("fill_survival_evidence_missing")
    if (
        max(
            _int(scorecard.get("fill_survival_sample_count")),
            _int(scorecard.get("delay_adjusted_depth_fill_survival_sample_count")),
        )
        <= 0
    ):
        blockers.append("fill_survival_sample_count_zero")
    return blockers


def _queue_ahead_depletion_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not (
        _bool(scorecard.get("queue_ahead_depletion_evidence_present"))
        or _bool(
            scorecard.get("delay_adjusted_depth_queue_ahead_depletion_evidence_present")
        )
        or _bool(
            scorecard.get(
                "queue_position_survival_queue_ahead_depletion_evidence_present"
            )
        )
    ):
        blockers.append("queue_ahead_depletion_evidence_missing")
    if (
        max(
            _int(scorecard.get("queue_ahead_depletion_sample_count")),
            _int(
                scorecard.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
            ),
            _int(
                scorecard.get(
                    "queue_position_survival_queue_ahead_depletion_sample_count"
                )
            ),
        )
        <= 0
    ):
        blockers.append("queue_ahead_depletion_sample_count_zero")
    return blockers


def _queue_position_survival_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not _bool(scorecard.get("queue_position_survival_fill_curve_evidence_present")):
        blockers.append("queue_position_survival_fill_curve_evidence_missing")
    if _int(scorecard.get("queue_position_survival_sample_count")) <= 0:
        blockers.append("queue_position_survival_sample_count_zero")
    if _decimal(scorecard.get("queue_position_survival_fill_rate")) <= 0:
        blockers.append("queue_position_survival_fill_rate_non_positive")
    if not _bool(
        scorecard.get("queue_position_survival_queue_ahead_depletion_evidence_present")
    ):
        blockers.append(
            "queue_position_survival_queue_ahead_depletion_evidence_missing"
        )
    if (
        _int(
            scorecard.get("queue_position_survival_queue_ahead_depletion_sample_count")
        )
        <= 0
    ):
        blockers.append(
            "queue_position_survival_queue_ahead_depletion_sample_count_zero"
        )
    if _decimal(scorecard.get("queue_position_survival_adjusted_fillable_ratio")) <= 0:
        blockers.append("queue_position_survival_adjusted_fillable_ratio_non_positive")
    if (
        _decimal(
            scorecard.get("post_cost_net_pnl_after_queue_position_survival_fill_stress")
            or scorecard.get("queue_position_survival_stress_net_pnl_per_day")
        )
        <= 0
    ):
        blockers.append("queue_position_survival_stress_net_pnl_non_positive")
    return blockers


def has_artifact_ref(scorecard: Mapping[str, Any], *keys: str) -> bool:
    for key in keys:
        raw_value = scorecard.get(key)
        if isinstance(raw_value, Sequence) and not isinstance(
            raw_value, (str, bytes, bytearray)
        ):
            if any(_string(item) for item in cast(Sequence[Any], raw_value)):
                return True
            continue
        if _string(raw_value):
            return True
    return False


def order_type_execution_validation_required(scorecard: Mapping[str, Any]) -> bool:
    if any(
        _bool(scorecard.get(key))
        for key in (
            "requires_market_limit_order_type_validation",
            "market_limit_order_type_validation_required",
            "order_type_ablation_required",
        )
    ):
        return True
    if _int(scorecard.get("market_limit_order_mix_sample_count")) > 0:
        return True
    if has_artifact_ref(
        scorecard,
        "order_type_ablation_artifact_ref",
        "order_type_ablation_artifact_refs",
        "market_limit_order_mix_artifact_ref",
        "market_limit_order_mix_artifact_refs",
    ):
        return True
    source_markers = {
        marker.lower()
        for marker in _string_list(scorecard.get("order_type_execution_source_markers"))
    }
    return bool(
        source_markers
        & {
            "retail_limit_orders_rof_rfaf049_2025",
            "retail_order_flow_segmentation_ssrn_6414558_2026",
            "payment_for_order_flow_ssrn_6704839_2026",
            "mpc_execution_schedule_arxiv_2603_28898_2026",
            "reinforcement_learning_trade_execution_market_limit_orders_2026",
            "arxiv_2507_06345_2026",
            "arxiv-2507.06345",
            "paper-arxiv-2507.06345",
        }
    )


def order_type_execution_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    if not order_type_execution_validation_required(scorecard):
        return []

    blockers: list[str] = []
    blockers.extend(_market_limit_order_mix_blockers(scorecard))
    blockers.extend(_route_tca_blockers(scorecard))
    blockers.extend(_order_type_ablation_blockers(scorecard))
    blockers.extend(_execution_quality_blockers(scorecard))
    return blockers


def _market_limit_order_mix_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not _bool(scorecard.get("market_limit_order_mix_evidence_present")):
        blockers.append("market_limit_order_mix_evidence_missing")
    if _int(scorecard.get("market_limit_order_mix_sample_count")) <= 0:
        blockers.append("market_limit_order_mix_sample_count_zero")
    if not (
        _bool(scorecard.get("market_limit_order_mix_passed"))
        or _bool(scorecard.get("market_limit_execution_policy_passed"))
    ):
        blockers.append("market_limit_order_mix_missing_or_failed")
    return blockers


def _route_tca_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not has_artifact_ref(
        scorecard,
        "route_tca_artifact_ref",
        "route_tca_artifact_refs",
    ) and not _bool(scorecard.get("route_tca_evidence_present")):
        blockers.append("route_tca_evidence_missing")
    return blockers


def _order_type_ablation_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not has_artifact_ref(
        scorecard,
        "order_type_ablation_artifact_ref",
        "order_type_ablation_artifact_refs",
    ):
        blockers.append("order_type_ablation_artifact_missing")
    if _int(scorecard.get("order_type_ablation_sample_count")) <= 0:
        blockers.append("order_type_ablation_sample_count_zero")
    if not _bool(scorecard.get("order_type_ablation_passed")):
        blockers.append("order_type_ablation_missing_or_failed")
    return blockers


def _execution_quality_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    if not _bool(scorecard.get("limit_fill_probability_evidence_present")):
        blockers.append("limit_fill_probability_evidence_missing")
    if _int(scorecard.get("limit_fill_probability_sample_count")) <= 0:
        blockers.append("limit_fill_probability_sample_count_zero")
    if not _bool(scorecard.get("price_improvement_evidence_present")):
        blockers.append("price_improvement_evidence_missing")
    if not _bool(scorecard.get("execution_shortfall_evidence_present")):
        blockers.append("execution_shortfall_evidence_missing")
    if not (
        _bool(scorecard.get("opportunity_cost_evidence_present"))
        or _bool(scorecard.get("order_type_opportunity_cost_evidence_present"))
    ):
        blockers.append("opportunity_cost_evidence_missing")
    return blockers


def market_impact_stress_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    market_impact_passed = _bool(
        scorecard.get("nonlinear_market_impact_stress_passed")
    ) or _bool(scorecard.get("market_impact_stress_passed"))
    if not market_impact_passed:
        blockers.append("market_impact_stress_failed")
    if not has_artifact_ref(
        scorecard,
        "market_impact_stress_artifact_ref",
        "market_impact_stress_artifact_refs",
        "nonlinear_market_impact_stress_artifact_ref",
        "nonlinear_market_impact_stress_artifact_refs",
    ):
        blockers.append("market_impact_stress_artifact_missing")
    if not _string(
        scorecard.get("nonlinear_market_impact_stress_model")
        or scorecard.get("market_impact_stress_model")
        or scorecard.get("market_impact_cost_model")
    ):
        blockers.append("market_impact_stress_model_missing")
    if (
        _decimal(
            scorecard.get("nonlinear_market_impact_stress_cost_bps")
            or scorecard.get("market_impact_stress_cost_bps")
            or scorecard.get("market_impact_cost_bps")
        )
        < MARKET_IMPACT_STRESS_COST_BPS
    ):
        blockers.append("market_impact_stress_cost_bps_below_min")
    if (
        _decimal(
            scorecard.get("nonlinear_market_impact_stress_net_pnl_per_day")
            or scorecard.get("market_impact_stress_net_pnl_per_day")
        )
        <= 0
    ):
        blockers.append("market_impact_stress_net_pnl_non_positive")
    if not _bool(scorecard.get("market_impact_liquidity_evidence_present")):
        blockers.append("market_impact_liquidity_evidence_missing")
    return blockers


def implementation_uncertainty_blockers(
    scorecard: Mapping[str, Any],
) -> list[str]:
    requires_implementation_uncertainty = _bool(
        scorecard.get("implementation_uncertainty_required")
    ) or _bool(scorecard.get("requires_implementation_uncertainty_stability"))
    if not requires_implementation_uncertainty:
        return []

    blockers: list[str] = []
    if not _bool(scorecard.get("implementation_uncertainty_stability_passed")):
        blockers.append("implementation_uncertainty_stability_failed")
    if _int(scorecard.get("implementation_uncertainty_model_count")) < 2:
        blockers.append("implementation_uncertainty_model_count_below_min")
    if _decimal(scorecard.get("implementation_uncertainty_lower_net_pnl_per_day")) <= 0:
        blockers.append("implementation_uncertainty_lower_net_pnl_non_positive")
    return blockers


def implementation_risk_backtest_stability_required(
    scorecard: Mapping[str, Any],
) -> bool:
    if any(
        _bool(scorecard.get(key))
        for key in (
            "requires_implementation_risk_backtest_stability",
            "implementation_risk_backtest_stability_required",
            "requires_multi_engine_replay",
            "required_multi_engine_replay",
            "requires_engine_sensitivity_report",
            "requires_conclusion_stability",
        )
    ):
        return True
    return "implementation_risk_backtesting_arxiv_2603_20319_2026" in {
        marker.lower()
        for marker in _string_list(
            scorecard.get("implementation_uncertainty_source_markers")
        )
    }


__all__ = (
    "evidence_bundle_from_frontier_candidate",
    "evidence_bundle_from_payload",
)
