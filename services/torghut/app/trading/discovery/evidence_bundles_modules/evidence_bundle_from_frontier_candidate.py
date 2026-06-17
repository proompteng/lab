# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Mapping, Sequence, cast

# ruff: noqa: F401,F403,F405,F811,F821

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
    _artifact_refs_from_scorecard,
    _bool,
    _decimal,
    _decimal_mapping_total,
    _frontier_replay_config,
    _frontier_replay_params,
    _frontier_strategy_overrides,
    _int,
    _int_mapping,
    _mapping,
    _order_lifecycle_metrics,
    _order_type_ablation_metrics,
    _order_type_execution_metrics,
    _runtime_ledger_lineage_handoff,
    _stable_hash,
    _string,
    _string_list,
)
from .runtime_ledger_lineage_handoff_blockers import (
    CandidateEvidenceBundle,
    _decomposition_activity_counts,
    _decomposition_symbol_contribution_shares,
    _delay_depth_fillability,
    _enrich_scorecard_with_replay_stress_metrics,
    _freshness_status_from_validation_status,
    _is_synthetic_dataset_snapshot,
    _p10,
    _runtime_ledger_lineage_handoff_blockers,
    _scorecard_with_freshness_lineage,
    _sum_mapping_int_values,
    evidence_bundle_id_for_payload,
)


def evidence_bundle_from_frontier_candidate(
    *,
    candidate_spec_id: str,
    candidate: Mapping[str, Any],
    dataset_snapshot_id: str,
    result_path: str,
    code_commit: str = "unknown",
) -> CandidateEvidenceBundle:
    candidate_id = _string(candidate.get("candidate_id")) or candidate_spec_id
    scorecard = _mapping(candidate.get("objective_scorecard"))
    full_window = _mapping(candidate.get("full_window"))
    summary = _mapping(candidate.get("summary"))
    if not scorecard:
        scorecard = {
            "net_pnl_per_day": _string(full_window.get("net_per_day")),
            "active_day_ratio": _string(full_window.get("active_day_ratio")),
            "positive_day_ratio": _string(full_window.get("positive_day_ratio")),
            "best_day_share": _string(full_window.get("best_day_share")),
            "max_drawdown": _string(full_window.get("max_drawdown")),
        }
    adaptive_signal_falsification_stress = _mapping(
        candidate.get("fast_replay_adaptive_signal_falsification_stress")
        or candidate.get("adaptive_signal_falsification_stress")
    )
    adaptive_signal_falsification_scorecard_patch = _mapping(
        candidate.get(
            "fast_replay_adaptive_signal_falsification_objective_scorecard_patch"
        )
        or adaptive_signal_falsification_stress.get("objective_scorecard_patch")
    )
    if adaptive_signal_falsification_scorecard_patch:
        for key in ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS:
            if key in adaptive_signal_falsification_scorecard_patch:
                scorecard = {
                    **scorecard,
                    key: adaptive_signal_falsification_scorecard_patch[key],
                }
    for key in REPLAY_ACTIVITY_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in MARKET_IMPACT_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in CONFORMAL_COST_BUFFER_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in (*DELAY_DEPTH_SURVIVAL_SCORECARD_KEYS, *FILL_SURVIVAL_SCORECARD_KEYS):
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in RUNTIME_LEDGER_LINEAGE_HANDOFF_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in OFI_RESPONSE_HORIZON_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key in STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for source in (candidate, summary, full_window):
        for key, value in _order_type_execution_metrics(source).items():
            if key not in scorecard:
                scorecard = {**scorecard, key: value}
    for source in (candidate, summary, full_window):
        for key, value in _order_lifecycle_metrics(source).items():
            if key not in scorecard:
                scorecard = {**scorecard, key: value}
    for source in (candidate, summary, full_window):
        for key, value in _order_type_ablation_metrics(source).items():
            if key not in scorecard or key in {
                "order_type_ablation_artifact_ref",
                "order_type_ablation_sample_count",
                "order_type_ablation_passed",
                "order_type_ablation_selected_order_type",
                "order_type_opportunity_cost_bps",
                "order_type_opportunity_cost_evidence_present",
                "opportunity_cost_evidence_present",
                "limit_fill_probability_sample_count",
                "limit_fill_probability_evidence_present",
            }:
                scorecard = {**scorecard, key: value}
    if (
        scorecard.get("market_limit_order_mix_evidence_present")
        and "order_type_execution_artifact_ref" not in scorecard
    ):
        scorecard = {**scorecard, "order_type_execution_artifact_ref": result_path}
    if (
        scorecard.get("market_limit_order_mix_evidence_present")
        and "market_limit_order_mix_artifact_ref" not in scorecard
    ):
        scorecard = {**scorecard, "market_limit_order_mix_artifact_ref": result_path}
    for key, value in _decomposition_activity_counts(candidate).items():
        if key not in scorecard:
            scorecard = {**scorecard, key: value}
    daily_net = _mapping(full_window.get("daily_net"))
    if daily_net and "daily_net" not in scorecard:
        scorecard = {**scorecard, "daily_net": daily_net}
    daily_filled_notional = _mapping(full_window.get("daily_filled_notional"))
    if daily_filled_notional and "daily_filled_notional" not in scorecard:
        scorecard = {**scorecard, "daily_filled_notional": daily_filled_notional}
    if "trading_day_count" in full_window and "trading_day_count" not in scorecard:
        scorecard = {**scorecard, "trading_day_count": full_window["trading_day_count"]}
    raw_candidate_hard_vetoes = candidate.get("hard_vetoes")
    if isinstance(raw_candidate_hard_vetoes, str):
        raw_hard_vetoes: Sequence[Any] = (raw_candidate_hard_vetoes,)
    else:
        raw_hard_vetoes = cast(Sequence[Any], raw_candidate_hard_vetoes or ())
    hard_vetoes = tuple(
        item for item in (_string(value) for value in raw_hard_vetoes) if item
    )
    if hard_vetoes and "hard_vetoes" not in scorecard:
        scorecard = {**scorecard, "hard_vetoes": list(hard_vetoes)}
    for nested_contract in (
        _mapping(candidate.get("hard_vetoes")),
        _mapping(candidate.get("promotion_contract")),
    ):
        for key in (
            *BOOTSTRAP_ROBUST_OPTIMIZATION_SCORECARD_KEYS,
            *ADAPTIVE_SIGNAL_FALSIFICATION_SCORECARD_KEYS,
            *OFI_RESPONSE_HORIZON_SCORECARD_KEYS,
            *ALPHA_DECAY_PREDICTABILITY_SCORECARD_KEYS,
            *STOCHASTIC_LIQUIDITY_RESILIENCE_SCORECARD_KEYS,
            *CONFORMAL_COST_BUFFER_SCORECARD_KEYS,
        ):
            if key in nested_contract and key not in scorecard:
                scorecard = {**scorecard, key: nested_contract[key]}
    replay_params = _frontier_replay_params(candidate)
    if replay_params and "runtime_params" not in scorecard:
        scorecard = {**scorecard, "runtime_params": replay_params}
    strategy_overrides = _frontier_strategy_overrides(candidate)
    if strategy_overrides and "candidate_strategy_overrides" not in scorecard:
        scorecard = {**scorecard, "candidate_strategy_overrides": strategy_overrides}
    universe_symbols = _string_list(strategy_overrides.get("universe_symbols"))
    if universe_symbols and "universe_symbols" not in scorecard:
        scorecard = {**scorecard, "universe_symbols": universe_symbols}
    for key in ("max_notional_per_trade", "max_position_pct_equity"):
        if key in scorecard:
            continue
        value = strategy_overrides.get(key)
        if value is not None:
            scorecard = {**scorecard, key: value}
    if "symbol_contribution_shares" not in scorecard and "symbol" not in scorecard:
        symbol_shares = _decomposition_symbol_contribution_shares(candidate)
        if symbol_shares:
            scorecard = {**scorecard, "symbol_contribution_shares": symbol_shares}
    runtime_identity_fallbacks = {
        "runtime_family": _string(candidate.get("family")),
        "runtime_strategy_name": _string(candidate.get("strategy_name")),
    }
    for key in (
        "family_template_id",
        "runtime_family",
        "runtime_strategy_name",
        "execution_signature",
        "execution_profile_id",
        "execution_profile_index",
        "feedback_risk_profile_key",
        "feedback_shape_key",
        "universe_key",
        "signal_key",
    ):
        value = _string(candidate.get(key)) or runtime_identity_fallbacks.get(key, "")
        if value and key not in scorecard:
            scorecard = {**scorecard, key: value}
    replay_lineage = _mapping(candidate.get("replay_lineage"))
    if replay_lineage and "replay_lineage" not in scorecard:
        scorecard = {**scorecard, "replay_lineage": replay_lineage}
    replay_window_coverage = _mapping(
        scorecard.get("replay_window_coverage")
        or candidate.get("replay_window_coverage")
        or replay_lineage.get("replay_window_coverage")
    )
    if replay_window_coverage and "replay_window_coverage" not in scorecard:
        scorecard = {**scorecard, "replay_window_coverage": replay_window_coverage}
    scorecard = _enrich_scorecard_with_replay_stress_metrics(
        scorecard=scorecard,
        full_window=full_window,
        result_path=result_path,
    )
    scorecard = _scorecard_with_freshness_lineage(
        scorecard=scorecard,
        candidate=candidate,
    )
    stress_metrics = tuple(
        cast(Sequence[Mapping[str, Any]], candidate.get("stress_metrics") or ())
    )
    if not stress_metrics:
        stress_metrics = (
            {
                "source": "frontier_replay",
                "stress_type": "market_impact",
                "model": scorecard.get("market_impact_stress_model"),
                "cost_bps": scorecard.get("market_impact_stress_cost_bps"),
                "net_pnl_per_day": scorecard.get(
                    "market_impact_stress_net_pnl_per_day"
                ),
                "passed": scorecard.get("market_impact_stress_passed"),
                "artifact_ref": scorecard.get("market_impact_stress_artifact_ref"),
            },
            {
                "source": "frontier_replay",
                "stress_type": "delay_adjusted_depth",
                "model": scorecard.get("delay_adjusted_depth_stress_model"),
                "stress_ms": scorecard.get("delay_adjusted_depth_stress_ms"),
                "latency_grid_ms": scorecard.get(
                    "delay_adjusted_depth_latency_grid_ms"
                ),
                "grid_max_stress_ms": scorecard.get(
                    "delay_adjusted_depth_grid_max_stress_ms"
                ),
                "fillable_notional_per_day": scorecard.get(
                    "delay_adjusted_depth_fillable_notional_per_day"
                ),
                "worst_grid_fillable_notional_per_day": scorecard.get(
                    "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
                ),
                "worst_active_day_fillable_notional": scorecard.get(
                    "delay_adjusted_depth_worst_active_day_fillable_notional"
                ),
                "p10_active_day_fillable_notional": scorecard.get(
                    "delay_adjusted_depth_p10_active_day_fillable_notional"
                ),
                "tail_coverage_passed": scorecard.get(
                    "delay_adjusted_depth_tail_coverage_passed"
                ),
                "liquidity_missing_day_count": scorecard.get(
                    "delay_adjusted_depth_liquidity_missing_day_count"
                ),
                "fillable_ratio": scorecard.get("delay_adjusted_depth_fillable_ratio"),
                "survival_adjusted_fillable_ratio": scorecard.get(
                    "delay_adjusted_depth_survival_adjusted_fillable_ratio"
                ),
                "unfillable_notional_per_day": scorecard.get(
                    "delay_adjusted_depth_unfillable_notional_per_day"
                ),
                "fill_survival_evidence_present": scorecard.get(
                    "delay_adjusted_depth_fill_survival_evidence_present"
                ),
                "fill_survival_sample_count": scorecard.get(
                    "delay_adjusted_depth_fill_survival_sample_count"
                ),
                "fill_survival_rate": scorecard.get(
                    "delay_adjusted_depth_fill_survival_rate"
                ),
                "queue_ratio_p95": scorecard.get(
                    "delay_adjusted_depth_queue_ratio_p95"
                ),
                "queue_ahead_depletion_evidence_present": scorecard.get(
                    "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
                ),
                "queue_ahead_depletion_sample_count": scorecard.get(
                    "delay_adjusted_depth_queue_ahead_depletion_sample_count"
                ),
                "net_pnl_per_day": scorecard.get(
                    "delay_adjusted_depth_stress_net_pnl_per_day"
                ),
                "passed": scorecard.get("delay_adjusted_depth_stress_passed"),
                "artifact_ref": scorecard.get(
                    "delay_adjusted_depth_stress_artifact_ref"
                ),
            },
            {
                "source": "frontier_replay",
                "stress_type": "implementation_uncertainty",
                "model": scorecard.get("implementation_uncertainty_model"),
                "model_count": scorecard.get("implementation_uncertainty_model_count"),
                "lower_net_pnl_per_day": scorecard.get(
                    "implementation_uncertainty_lower_net_pnl_per_day"
                ),
                "upper_net_pnl_per_day": scorecard.get(
                    "implementation_uncertainty_upper_net_pnl_per_day"
                ),
                "interval_width_per_day": scorecard.get(
                    "implementation_uncertainty_interval_width_per_day"
                ),
                "scenarios": scorecard.get("implementation_uncertainty_scenarios"),
                "passed": scorecard.get("implementation_uncertainty_stability_passed"),
            },
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
        null_comparator=_mapping(candidate.get("null_comparator"))
        or _mapping(adaptive_signal_falsification_stress.get("null_comparator_patch"))
        or {
            "baseline_outperformed": bool(
                float(str(scorecard.get("net_pnl_per_day") or 0)) > 0
            )
        },
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


def _requires_promotion_proof(bundle: CandidateEvidenceBundle) -> bool:
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


def _delay_depth_survival_blockers(scorecard: Mapping[str, Any]) -> list[str]:
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


def _has_artifact_ref(scorecard: Mapping[str, Any], *keys: str) -> bool:
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


def _order_type_execution_validation_required(scorecard: Mapping[str, Any]) -> bool:
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
    if _has_artifact_ref(
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


def _order_type_execution_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    if not _order_type_execution_validation_required(scorecard):
        return []

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
    if not _has_artifact_ref(
        scorecard,
        "route_tca_artifact_ref",
        "route_tca_artifact_refs",
    ) and not _bool(scorecard.get("route_tca_evidence_present")):
        blockers.append("route_tca_evidence_missing")
    if not _has_artifact_ref(
        scorecard,
        "order_type_ablation_artifact_ref",
        "order_type_ablation_artifact_refs",
    ):
        blockers.append("order_type_ablation_artifact_missing")
    if _int(scorecard.get("order_type_ablation_sample_count")) <= 0:
        blockers.append("order_type_ablation_sample_count_zero")
    if not _bool(scorecard.get("order_type_ablation_passed")):
        blockers.append("order_type_ablation_missing_or_failed")
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


def _market_impact_stress_blockers(scorecard: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    market_impact_passed = _bool(
        scorecard.get("nonlinear_market_impact_stress_passed")
    ) or _bool(scorecard.get("market_impact_stress_passed"))
    if not market_impact_passed:
        blockers.append("market_impact_stress_failed")
    if not _has_artifact_ref(
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


def _implementation_uncertainty_blockers(
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


def _implementation_risk_backtest_stability_required(
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


__all__ = [name for name in globals() if not name.startswith("__")]
