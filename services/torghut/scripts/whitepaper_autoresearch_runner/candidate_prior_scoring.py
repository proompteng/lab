#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.mlx_training_data import (
    capital_budget_penalty,
    candidate_spec_capital_features,
)
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
)


from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_score_rows as _candidate_board_score_rows,
    _candidate_board_decimal_field as _candidate_board_decimal_field,
    _candidate_board_int_field as _candidate_board_int_field,
    _candidate_board_first_int_field as _candidate_board_first_int_field,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_paper_probation import (
    _paper_probation_candidate_payload as _paper_probation_candidate_payload,
    _candidate_board_paper_probation_candidates as _candidate_board_paper_probation_candidates,
    _candidate_board_paper_probation_candidate as _candidate_board_paper_probation_candidate,
    _candidate_board_status_digest as _candidate_board_status_digest,
    _candidate_board_double_oos_summary as _candidate_board_double_oos_summary,
    _candidate_board_portfolio_promotion_subject as _candidate_board_portfolio_promotion_subject,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_payloads import (
    _candidate_board_factor_acceptance_summary as _candidate_board_factor_acceptance_summary,
    _candidate_board_payload as _candidate_board_payload,
    _paper_probation_handoff_payload as _paper_probation_handoff_payload,
    _portfolio_with_runtime_closure_proof as _portfolio_with_runtime_closure_proof,
    _runtime_closure_program_for_candidate as _runtime_closure_program_for_candidate,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_runtime_windows import (
    _candidate_board_hypothesis_manifest_ref as _candidate_board_hypothesis_manifest_ref,
    _candidate_board_runtime_window_bounds as _candidate_board_runtime_window_bounds,
    _candidate_board_date_only as _candidate_board_date_only,
    _candidate_board_regular_session_bound as _candidate_board_regular_session_bound,
    _candidate_board_runtime_window_import_bounds as _candidate_board_runtime_window_import_bounds,
    _candidate_board_exact_replay_ledger_refs as _candidate_board_exact_replay_ledger_refs,
    _candidate_board_runtime_import_args as _candidate_board_runtime_import_args,
    _candidate_board_runtime_window_import_plan as _candidate_board_runtime_window_import_plan,
    _candidate_factor_acceptance_replay_metadata as _candidate_factor_acceptance_replay_metadata,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_summaries import (
    _candidate_board_rejected_signal_outcome_summary as _candidate_board_rejected_signal_outcome_summary,
    _candidate_spec_requires_order_type_execution_quality as _candidate_spec_requires_order_type_execution_quality,
    _candidate_spec_requires_predictability_decay_stress as _candidate_spec_requires_predictability_decay_stress,
    _candidate_board_predictability_decay_summary as _candidate_board_predictability_decay_summary,
    _candidate_board_scorecard_with_predictability_decay_blockers as _candidate_board_scorecard_with_predictability_decay_blockers,
    _candidate_board_order_type_execution_quality_summary as _candidate_board_order_type_execution_quality_summary,
    _candidate_board_scorecard_with_order_type_blockers as _candidate_board_scorecard_with_order_type_blockers,
    _candidate_spec_requires_queue_position_survival as _candidate_spec_requires_queue_position_survival,
    _candidate_board_queue_position_survival_summary as _candidate_board_queue_position_survival_summary,
    _candidate_board_scorecard_with_queue_position_survival_blockers as _candidate_board_scorecard_with_queue_position_survival_blockers,
    _candidate_board_scorecard_with_rejected_signal_blockers as _candidate_board_scorecard_with_rejected_signal_blockers,
    _candidate_board_evidence_lineage_summary as _candidate_board_evidence_lineage_summary,
    _candidate_board_scorecard_with_lineage_blockers as _candidate_board_scorecard_with_lineage_blockers,
    _candidate_board_replay_window_coverage_summary as _candidate_board_replay_window_coverage_summary,
    _candidate_board_market_impact_proof_summary as _candidate_board_market_impact_proof_summary,
    _candidate_board_regime_specialist_summary as _candidate_board_regime_specialist_summary,
    _candidate_board_scorecard_with_replay_window_blockers as _candidate_board_scorecard_with_replay_window_blockers,
    _candidate_board_scorecard_with_evidence_blockers as _candidate_board_scorecard_with_evidence_blockers,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_status import (
    _candidate_board_blockers as _candidate_board_blockers,
    _candidate_board_status as _candidate_board_status,
    _candidate_board_activity_count as _candidate_board_activity_count,
    _candidate_board_oracle_blocker_count as _candidate_board_oracle_blocker_count,
    _candidate_board_net_pnl as _candidate_board_net_pnl,
    _candidate_board_lower_bound_net_pnl as _candidate_board_lower_bound_net_pnl,
    _candidate_board_target_progress_ratio as _candidate_board_target_progress_ratio,
    _candidate_board_required_notional_repair_scale as _candidate_board_required_notional_repair_scale,
    _candidate_board_best_executed_candidate as _candidate_board_best_executed_candidate,
    _candidate_board_closest_promotion_candidate as _candidate_board_closest_promotion_candidate,
    _candidate_board_paper_probation_admission_blockers as _candidate_board_paper_probation_admission_blockers,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _CANDIDATE_BOARD_RUNTIME_SESSION_TZ as _CANDIDATE_BOARD_RUNTIME_SESSION_TZ,
    _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN as _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN,
    _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE as _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE,
    _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS as _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH as _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH,
    _SECOND_OOS_WINDOW_ID as _SECOND_OOS_WINDOW_ID,
    _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS as _RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS,
    _resolve_existing_path as _resolve_existing_path,
    _stable_hash as _stable_hash,
    _decimal as _decimal,
    _decimal_payload as _decimal_payload,
    _mapping as _mapping,
    _string as _string,
    _list_of_mappings as _list_of_mappings,
    _sequence_of_mappings as _sequence_of_mappings,
    _rank_sort_value as _rank_sort_value,
    _proposal_sort_value as _proposal_sort_value,
    _string_list_from_value as _string_list_from_value,
    _candidate_board_runtime_ledger_lineage_handoff as _candidate_board_runtime_ledger_lineage_handoff,
    _candidate_board_runtime_ledger_required_materialized_artifacts as _candidate_board_runtime_ledger_required_materialized_artifacts,
    _candidate_spec_requires_rejected_signal_outcome_learning as _candidate_spec_requires_rejected_signal_outcome_learning,
    _boolish as _boolish,
    _oracle_blockers as _oracle_blockers,
)
from scripts.whitepaper_autoresearch_runner.runtime_closure import (
    _runtime_closure_payload as _runtime_closure_payload,
    _portfolio_needs_runtime_closure_proof as _portfolio_needs_runtime_closure_proof,
    _load_json_mapping_artifact as _load_json_mapping_artifact,
    _runtime_closure_artifact_refs as _runtime_closure_artifact_refs,
    _runtime_report_summary_int as _runtime_report_summary_int,
    _runtime_report_int as _runtime_report_int,
    _runtime_closure_ledger_datetime as _runtime_closure_ledger_datetime,
    _runtime_closure_exact_replay_bucket_range as _runtime_closure_exact_replay_bucket_range,
    _runtime_closure_replay_bucket_has_authority as _runtime_closure_replay_bucket_has_authority,
    _runtime_closure_exact_replay_bucket as _runtime_closure_exact_replay_bucket,
    _runtime_report_source_markers as _runtime_report_source_markers,
    _market_impact_default_source_markers as _market_impact_default_source_markers,
    _runtime_closure_start_equity as _runtime_closure_start_equity,
    _portfolio_executable_max_notional as _portfolio_executable_max_notional,
    _runtime_closure_exact_replay_ledger_update as _runtime_closure_exact_replay_ledger_update,
    _runtime_closure_market_impact_stress_update as _runtime_closure_market_impact_stress_update,
    _runtime_closure_delay_adjusted_depth_stress_update as _runtime_closure_delay_adjusted_depth_stress_update,
    _runtime_closure_double_oos_update as _runtime_closure_double_oos_update,
    _runtime_closure_scorecard_update as _runtime_closure_scorecard_update,
    _runtime_closure_pending_promotion_steps as _runtime_closure_pending_promotion_steps,
    _runtime_closure_promotion_prerequisite_blockers as _runtime_closure_promotion_prerequisite_blockers,
    _promotion_readiness_payload as _promotion_readiness_payload,
)

from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)
from scripts.whitepaper_autoresearch_runner.feedback_blocking_rules import (
    _feedback_daily_net_has_loss,
    _feedback_has_no_replay_activity,
    _feedback_has_nonpositive_expected_value,
)
from scripts.whitepaper_autoresearch_runner.feedback_risk_profiles import (
    _feedback_risk_profile_key_payload,
)

_PAPER_MECHANISM_PRIOR_SCORE_CAP = Decimal("42")

_PAPER_MECHANISM_PRIOR_WEIGHTS: Mapping[str, Decimal] = {
    "mixed_market_limit_execution_policy": Decimal("9"),
    "queue_position_survival_fill_curve": Decimal("9"),
    "mpc_dynamic_execution_schedule": Decimal("8"),
    "delay_adjusted_depth_stress": Decimal("8"),
    "simulation_reality_gap_implementation_risk": Decimal("8"),
    "implementation_risk_backtest_stability": Decimal("8"),
    "replay_paper_live_semantic_parity": Decimal("7"),
    "rejected_signal_outcome_calibration": Decimal("7"),
    "nonlinear_market_impact_tca": Decimal("6"),
    "ofi_lob_continuation_response": Decimal("6"),
    "order_flow_filtration_parent_trade_obi": Decimal("6"),
    "alpha_decay_predictability_stress": Decimal("5"),
    "cluster_lob_event_clustering": Decimal("5"),
    "intraday_volume_periodicity_execution": Decimal("5"),
    "macro_announcement_dvar_momentum": Decimal("4"),
    "ohlcv_only_falsification": Decimal("3"),
}

_PAPER_EVIDENCE_REQUIREMENT_PRIOR_WEIGHTS: Mapping[str, Decimal] = {
    "route_tca": Decimal("2"),
    "execution_shortfall": Decimal("2"),
    "market_impact_stress": Decimal("2"),
    "live_paper_parity": Decimal("2"),
    "runtime_ledger": Decimal("2"),
    "fill_outcomes": Decimal("2"),
    "order_lifecycle_fill_evidence": Decimal("2"),
    "queue_position_survival_fill_curve": Decimal("2"),
    "delay_adjusted_depth_stress": Decimal("2"),
    "implementation_uncertainty_interval": Decimal("2"),
    "implementation_uncertainty_stability": Decimal("2"),
    "rejected_signal_log": Decimal("2"),
    "counterfactual_return": Decimal("2"),
    "executable_quote": Decimal("1"),
}

_LOSS_ADAPTIVE_FEEDBACK_REMEDIATION_PROFILES = frozenset(
    {"adverse_selection_feedback_escape"}
)

_REPLAY_ACTIVITY_COUNT_KEYS = (
    "decision_count",
    "trade_decision_count",
    "paper_decision_count",
    "runtime_decision_count",
    "orders_submitted_count",
    "submitted_order_count",
    "filled_count",
    "fill_count",
    "filled_order_count",
)


def _pre_replay_candidate_score(spec: CandidateSpec) -> Decimal:
    family_score = {
        "microbar_cross_sectional_pairs_v1": Decimal("70"),
        "intraday_tsmom_v2": Decimal("68"),
        "late_day_continuation_v1": Decimal("62"),
        "momentum_pullback_v1": Decimal("60"),
        "washout_rebound_v2": Decimal("55"),
        "microstructure_continuation_matched_filter_v1": Decimal("53"),
        "opening_drive_leader_reclaim_v1": Decimal("52"),
        "breakout_reclaim_v2": Decimal("50"),
        "end_of_day_reversal_v1": Decimal("48"),
        "mean_reversion_rebound_v1": Decimal("45"),
    }.get(spec.family_template_id, Decimal("40"))
    required_features = spec.feature_contract.get("required_features")
    feature_count = (
        len(cast(Sequence[Any], required_features))
        if isinstance(required_features, Sequence)
        and not isinstance(required_features, str)
        else 0
    )
    failure_penalty = Decimal(len(spec.expected_failure_modes)) * Decimal("0.25")
    capital_penalty = Decimal(
        str(capital_budget_penalty(candidate_spec_capital_features(spec)))
    )
    return (
        family_score
        + Decimal(feature_count)
        + _paper_mechanism_prior_score(spec)
        - failure_penalty
        - capital_penalty
    )


def _candidate_spec_mechanism_overlay_ids(spec: CandidateSpec) -> set[str]:
    overlay_ids = set(
        _string_list_from_value(spec.parameter_space.get("mechanism_overlay_ids"))
    )
    for overlay in _sequence_of_mappings(
        spec.feature_contract.get("mechanism_overlays")
    ):
        overlay_id = _string(overlay.get("overlay_id"))
        if overlay_id:
            overlay_ids.add(overlay_id)
    return overlay_ids


def _candidate_spec_required_evidence_tokens(spec: CandidateSpec) -> set[str]:
    tokens: set[str] = set()
    contract_rows = (
        *_sequence_of_mappings(spec.feature_contract.get("source_claims")),
        *_sequence_of_mappings(spec.feature_contract.get("validation_requirements")),
        *_sequence_of_mappings(spec.feature_contract.get("mechanism_overlays")),
    )
    for row in contract_rows:
        for key in ("data_requirements", "required_evidence"):
            tokens.update(
                _string(item) for item in _string_list_from_value(row.get(key))
            )
    for key, value in spec.promotion_contract.items():
        if key.startswith("requires_") and _boolish(value):
            tokens.add(key.removeprefix("requires_"))
    return {token for token in tokens if token}


def _paper_mechanism_prior_score(spec: CandidateSpec) -> Decimal:
    source_claims = _sequence_of_mappings(spec.feature_contract.get("source_claims"))
    validation_requirements = _sequence_of_mappings(
        spec.feature_contract.get("validation_requirements")
    )
    overlay_ids = _candidate_spec_mechanism_overlay_ids(spec)
    evidence_tokens = _candidate_spec_required_evidence_tokens(spec)
    promotion_requires_count = sum(
        1
        for key, value in spec.promotion_contract.items()
        if key.startswith("requires_") and _boolish(value)
    )
    promotion_rejects_count = sum(
        1
        for key, value in spec.promotion_contract.items()
        if key.startswith("rejects_") and _boolish(value)
    )
    score = (
        Decimal(min(len(source_claims), 8)) * Decimal("1.25")
        + Decimal(min(len(validation_requirements), 5)) * Decimal("2")
        + Decimal(min(promotion_requires_count, 8)) * Decimal("1.5")
        + Decimal(min(promotion_rejects_count, 6)) * Decimal("0.75")
    )
    for overlay_id in sorted(overlay_ids):
        score += _PAPER_MECHANISM_PRIOR_WEIGHTS.get(overlay_id, Decimal("1"))
    for token in sorted(evidence_tokens):
        score += _PAPER_EVIDENCE_REQUIREMENT_PRIOR_WEIGHTS.get(token, Decimal("0"))
    return min(_PAPER_MECHANISM_PRIOR_SCORE_CAP, score)


def _candidate_spec_universe_key(spec: CandidateSpec) -> str:
    universe = spec.strategy_overrides.get("universe_symbols")
    if not isinstance(universe, Sequence) or isinstance(universe, str):
        return ""
    return ",".join(sorted(_string(item).upper() for item in universe if _string(item)))


def _candidate_spec_signal_key(spec: CandidateSpec) -> str:
    params = _mapping(spec.strategy_overrides.get("params"))
    return "|".join(
        part
        for part in (
            _string(params.get("signal_motif")),
            _string(params.get("selection_mode")),
            _string(params.get("rank_feature")),
        )
        if part
    )


def _candidate_spec_is_false_negative_rescue(spec: CandidateSpec) -> bool:
    params = _mapping(spec.strategy_overrides.get("params"))
    overlays = spec.parameter_space.get("mechanism_overlay_ids", ())
    overlay_ids = set(_string_list_from_value(overlays))
    return (
        "rejected_signal_outcome_calibration" in overlay_ids
        and _string(params.get("veto_relaxation_scope"))
        == "labeled_false_negative_only"
        and _string(params.get("outcome_label_filter")) == "profitable_after_costs"
    )


def _candidate_spec_is_loss_adaptive_feedback_escape(spec: CandidateSpec) -> bool:
    params = _mapping(spec.strategy_overrides.get("params"))
    return (
        _string(params.get("feedback_remediation_profile"))
        in _LOSS_ADAPTIVE_FEEDBACK_REMEDIATION_PROFILES
    )


def _candidate_spec_active_loss_counter_tags(spec: CandidateSpec) -> set[str]:
    params = _mapping(spec.strategy_overrides.get("params"))
    profile = _string(params.get("feedback_remediation_profile"))
    if profile == "daily_coverage_feedback_escape":
        return {"daily_coverage_shortfall"}
    if profile in {
        "turnover_coverage_feedback_escape",
        "notional_throughput_feedback_escape",
    }:
        return {"notional_throughput_shortfall"}
    if profile == "consistency_guard_feedback_escape":
        return {"loss_control_shortfall"}
    if profile == "symbol_diversification_feedback_escape":
        return {"symbol_concentration_shortfall"}
    if profile == "adverse_selection_feedback_escape":
        return {
            "daily_coverage_shortfall",
            "notional_throughput_shortfall",
            "loss_control_shortfall",
            "adverse_selection_shortfall",
        }
    return set()


def _feedback_active_loss_counter_candidate_reasons(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> set[str]:
    if not scorecard or _feedback_has_no_replay_activity(scorecard):
        return set()
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return set()
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return set()
    if _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    ):
        return set()
    if not (
        _feedback_has_nonpositive_expected_value(scorecard)
        or _feedback_daily_net_has_loss(scorecard)
    ):
        return set()
    reasons = {"adverse_selection_shortfall"}
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        reasons.add("daily_coverage_shortfall")
    if (
        _decimal(scorecard.get("avg_filled_notional_per_day"))
        < policy.min_avg_filled_notional_per_day
    ):
        reasons.add("notional_throughput_shortfall")
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
        or _decimal(scorecard.get("negative_day_count")) > Decimal("0")
        or _decimal(scorecard.get("worst_day_loss")) > Decimal("0")
        or _decimal(scorecard.get("max_drawdown")) > Decimal("0")
    ):
        reasons.add("loss_control_shortfall")
    if (
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="0")
        > policy.max_single_symbol_contribution_share
        or _decimal(scorecard.get("symbol_concentration_share"), default="0")
        > policy.max_single_symbol_contribution_share
        or _decimal(scorecard.get("max_cluster_contribution_share"), default="0")
        > policy.max_cluster_contribution_share
    ):
        reasons.add("symbol_concentration_shortfall")
    return reasons


def _candidate_spec_matches_active_loss_counter_feedback(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    candidate_tags = _candidate_spec_active_loss_counter_tags(spec)
    if not candidate_tags:
        return False
    feedback_reasons = _feedback_active_loss_counter_candidate_reasons(
        scorecard, oracle_policy=oracle_policy
    )
    return bool(candidate_tags & feedback_reasons)


def _feedback_consistency_repair_candidate_reasons(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> set[str]:
    if (
        not scorecard
        or _feedback_has_no_replay_activity(scorecard)
        or _feedback_has_nonpositive_expected_value(scorecard)
    ):
        return set()
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return set()
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return set()
    if _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    ):
        return set()
    reasons: set[str] = set()
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        reasons.add("daily_coverage_shortfall")
    if (
        _decimal(scorecard.get("avg_filled_notional_per_day"))
        < policy.min_avg_filled_notional_per_day
    ):
        reasons.add("notional_throughput_shortfall")
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
        or _decimal(scorecard.get("negative_day_count")) > Decimal("0")
        or _decimal(scorecard.get("worst_day_loss")) > Decimal("0")
        or _decimal(scorecard.get("max_drawdown")) > Decimal("0")
        or _decimal(scorecard.get("min_daily_net_pnl")) < policy.min_daily_net_pnl
    ):
        reasons.add("loss_control_shortfall")
    if (
        _decimal(scorecard.get("best_day_share"), default="0")
        > policy.max_best_day_share
    ):
        reasons.update({"daily_coverage_shortfall", "loss_control_shortfall"})
    if (
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="0")
        > policy.max_single_symbol_contribution_share
        or _decimal(scorecard.get("symbol_concentration_share"), default="0")
        > policy.max_single_symbol_contribution_share
        or _decimal(scorecard.get("max_cluster_contribution_share"), default="0")
        > policy.max_cluster_contribution_share
    ):
        reasons.add("symbol_concentration_shortfall")
    return reasons


def _candidate_spec_matches_consistency_repair_feedback(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    candidate_tags = _candidate_spec_active_loss_counter_tags(spec)
    if not candidate_tags:
        return False
    feedback_reasons = _feedback_consistency_repair_candidate_reasons(
        scorecard, oracle_policy=oracle_policy
    )
    return bool(candidate_tags & feedback_reasons)


def _active_loss_counter_proposal_score(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    raw_score: float,
    target_score: float,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> float:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    candidate_tags = _candidate_spec_active_loss_counter_tags(spec)
    feedback_reasons = _feedback_active_loss_counter_candidate_reasons(
        scorecard,
        oracle_policy=policy,
    )
    matched_tags = candidate_tags & feedback_reasons
    params = _mapping(spec.strategy_overrides.get("params"))
    remediation_profile = _string(params.get("feedback_remediation_profile"))
    profile_bonus = {
        "adverse_selection_feedback_escape": Decimal("160"),
        "notional_throughput_feedback_escape": Decimal("110"),
        "turnover_coverage_feedback_escape": Decimal("90"),
        "daily_coverage_feedback_escape": Decimal("70"),
        "consistency_guard_feedback_escape": Decimal("60"),
        "symbol_diversification_feedback_escape": Decimal("40"),
    }.get(remediation_profile, Decimal("0"))
    capital_features = candidate_spec_capital_features(spec)
    configured_daily_notional_capacity = _decimal(
        capital_features.get("configured_daily_notional_capacity")
    )
    required_daily_notional = max(policy.min_avg_filled_notional_per_day, Decimal("1"))
    capacity_ratio = min(
        Decimal("2"),
        configured_daily_notional_capacity / required_daily_notional,
    )
    loss_control_bonus = Decimal("0")
    if _string(params.get("max_stop_loss_exits_per_session")) == "1":
        loss_control_bonus += Decimal("20")
    if _decimal(params.get("stop_loss_lockout_seconds")) >= Decimal("1800"):
        loss_control_bonus += Decimal("20")
    activity_count = max(
        (_decimal(scorecard.get(key)) for key in _REPLAY_ACTIVITY_COUNT_KEYS),
        default=Decimal("0"),
    )
    activity_bonus = min(activity_count, Decimal("100")) * Decimal("2")
    avg_filled_notional_per_day = _decimal(scorecard.get("avg_filled_notional_per_day"))
    activity_bonus += min(
        Decimal("1"),
        avg_filled_notional_per_day / required_daily_notional,
    ) * Decimal("50")
    activity_bonus += min(
        Decimal("1"),
        max(Decimal("0"), _decimal(scorecard.get("active_day_ratio"))),
    ) * Decimal("50")
    mlx_relative_signal = max(
        Decimal("-250"),
        min(Decimal("250"), Decimal(str(raw_score)) - Decimal(str(target_score))),
    )
    return float(
        Decimal("-100000")
        + _pre_replay_candidate_score(spec)
        + (Decimal(len(matched_tags)) * Decimal("180"))
        + profile_bonus
        + (capacity_ratio * Decimal("40"))
        + loss_control_bonus
        + activity_bonus
        + mlx_relative_signal
    )


def _consistency_repair_proposal_score(
    spec: CandidateSpec,
    scorecard: Mapping[str, Any],
    *,
    raw_score: float,
    target_score: float,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> float:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    candidate_tags = _candidate_spec_active_loss_counter_tags(spec)
    feedback_reasons = _feedback_consistency_repair_candidate_reasons(
        scorecard,
        oracle_policy=policy,
    )
    matched_tags = candidate_tags & feedback_reasons
    params = _mapping(spec.strategy_overrides.get("params"))
    remediation_profile = _string(params.get("feedback_remediation_profile"))
    profile_bonus = {
        "consistency_guard_feedback_escape": Decimal("180"),
        "daily_coverage_feedback_escape": Decimal("150"),
        "adverse_selection_feedback_escape": Decimal("130"),
        "symbol_diversification_feedback_escape": Decimal("120"),
        "notional_throughput_feedback_escape": Decimal("80"),
        "turnover_coverage_feedback_escape": Decimal("70"),
    }.get(remediation_profile, Decimal("40"))
    positive_shortfall = max(
        Decimal("0"),
        policy.min_positive_day_ratio
        - _decimal(scorecard.get("positive_day_ratio"), default="1"),
    )
    concentration_excess = max(
        Decimal("0"),
        _decimal(scorecard.get("best_day_share"), default="0")
        - policy.max_best_day_share,
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="0")
        - policy.max_single_symbol_contribution_share,
        _decimal(scorecard.get("symbol_concentration_share"), default="0")
        - policy.max_single_symbol_contribution_share,
        _decimal(scorecard.get("max_cluster_contribution_share"), default="0")
        - policy.max_cluster_contribution_share,
    )
    mlx_relative_signal = max(
        Decimal("-250"),
        min(Decimal("250"), Decimal(str(raw_score)) - Decimal(str(target_score))),
    )
    return float(
        Decimal("-50000")
        + _pre_replay_candidate_score(spec)
        + (Decimal(len(matched_tags)) * Decimal("120"))
        + profile_bonus
        + mlx_relative_signal
        - (positive_shortfall * Decimal("80"))
        - (concentration_excess * Decimal("80"))
    )


def _scorecard_is_false_negative_rescue_feedback(
    scorecard: Mapping[str, Any],
) -> bool:
    signal_key = _string(scorecard.get("signal_key"))
    if signal_key.startswith("rejected_signal_false_negative"):
        return True
    runtime_params = _mapping(scorecard.get("runtime_params"))
    return _string(runtime_params.get("signal_motif")).startswith(
        "rejected_signal_false_negative"
    )


def _candidate_spec_execution_profile(spec: CandidateSpec) -> Mapping[str, Any]:
    return _mapping(spec.feature_contract.get("execution_profile"))


def _candidate_spec_feedback_risk_profile_key(spec: CandidateSpec) -> str:
    execution_profile = _candidate_spec_execution_profile(spec)
    return _stable_hash(
        _feedback_risk_profile_key_payload(
            family_template_id=spec.family_template_id,
            runtime_strategy_name=spec.runtime_strategy_name,
            execution_profile_id=_string(execution_profile.get("profile_id")),
            universe_key=_candidate_spec_universe_key(spec),
            signal_key=_candidate_spec_signal_key(spec),
        )
    )


def _candidate_spec_feedback_shape_key(spec: CandidateSpec) -> str:
    params = _mapping(spec.strategy_overrides.get("params"))
    execution_profile = _candidate_spec_execution_profile(spec)
    return _stable_hash(
        {
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "execution_profile_id": _string(execution_profile.get("profile_id")),
            "universe_key": _candidate_spec_universe_key(spec),
            "signal_key": _candidate_spec_signal_key(spec),
            "capital_profile": _string(params.get("capital_profile")),
            "entry_minute_after_open": _string(params.get("entry_minute_after_open")),
            "exit_minute_after_open": _string(params.get("exit_minute_after_open")),
            "entry_start_minute_utc": _string(params.get("entry_start_minute_utc")),
            "entry_end_minute_utc": _string(params.get("entry_end_minute_utc")),
            "max_entries_per_session": _string(params.get("max_entries_per_session")),
            "max_concurrent_positions": _string(params.get("max_concurrent_positions")),
            "top_n": _string(params.get("top_n")),
            "max_pair_legs": _string(params.get("max_pair_legs")),
            "long_stop_loss_bps": _string(params.get("long_stop_loss_bps")),
            "short_stop_loss_bps": _string(params.get("short_stop_loss_bps")),
            "max_session_negative_exit_bps": _string(
                params.get("max_session_negative_exit_bps")
            ),
        }
    )


def _candidate_spec_feedback_metadata(spec: CandidateSpec) -> dict[str, Any]:
    execution_profile = _candidate_spec_execution_profile(spec)
    params = _mapping(spec.strategy_overrides.get("params"))
    universe_symbols = [
        _string(symbol).upper()
        for symbol in cast(
            Sequence[Any], spec.strategy_overrides.get("universe_symbols") or []
        )
        if _string(symbol)
    ]
    return {
        "family_template_id": spec.family_template_id,
        "runtime_family": spec.runtime_family,
        "runtime_strategy_name": spec.runtime_strategy_name,
        "execution_signature": _candidate_spec_execution_signature(spec),
        "execution_profile_id": _string(execution_profile.get("profile_id")),
        "execution_profile_index": execution_profile.get("profile_index"),
        "feedback_risk_profile_key": _candidate_spec_feedback_risk_profile_key(spec),
        "feedback_shape_key": _candidate_spec_feedback_shape_key(spec),
        "universe_key": _candidate_spec_universe_key(spec),
        "signal_key": _candidate_spec_signal_key(spec),
        "runtime_params": dict(params),
        "universe_symbols": universe_symbols,
    }


def _candidate_payload_with_feedback_metadata(
    *, candidate: Mapping[str, Any], spec: CandidateSpec
) -> dict[str, Any]:
    metadata = _candidate_spec_feedback_metadata(spec)
    next_candidate = {**dict(candidate), **metadata}
    scorecard = _mapping(next_candidate.get("objective_scorecard"))
    next_candidate["objective_scorecard"] = {
        **metadata,
        **scorecard,
    }
    validation_requirements = _list_of_mappings(
        spec.feature_contract.get("validation_requirements")
    )
    validation_requirement_claim_ids = [
        _string(item.get("claim_id"))
        for item in validation_requirements
        if _string(item.get("claim_id"))
    ]
    if validation_requirements or spec.promotion_contract.get(
        "synthetic_evidence_policy"
    ):
        validation_contract = {
            "schema_version": "torghut.candidate-validation-contract.v1",
            "source": "candidate_spec",
            "validation_requirements": validation_requirements,
            "validation_requirement_claim_ids": validation_requirement_claim_ids,
            "requires_historical_replay": bool(
                spec.promotion_contract.get("requires_historical_replay")
            ),
            "requires_live_paper_parity": bool(
                spec.promotion_contract.get("requires_live_paper_parity")
            ),
            "synthetic_evidence_policy": _string(
                spec.promotion_contract.get("synthetic_evidence_policy")
            ),
        }
        next_candidate["objective_scorecard"] = {
            **_mapping(next_candidate.get("objective_scorecard")),
            "validation_contract": validation_contract,
        }
        readiness = _mapping(next_candidate.get("promotion_readiness"))
        blockers = _string_list_from_value(readiness.get("blockers"))
        blockers.append("validation_contract_pending")
        if validation_contract["requires_live_paper_parity"]:
            blockers.append("validation_live_paper_parity_pending")
        if validation_contract["synthetic_evidence_policy"]:
            blockers.append("synthetic_evidence_not_promotion_proof")
        next_candidate["promotion_readiness"] = {
            **readiness,
            "stage": _string(readiness.get("stage")) or "research_candidate",
            "status": _string(readiness.get("status"))
            or "blocked_pending_validation_contract",
            "promotable": False,
            "blockers": list(dict.fromkeys(blockers)),
            "validation_contract": validation_contract,
        }
    return next_candidate


__all__ = [
    "_pre_replay_candidate_score",
    "_candidate_spec_mechanism_overlay_ids",
    "_candidate_spec_required_evidence_tokens",
    "_paper_mechanism_prior_score",
    "_candidate_spec_universe_key",
    "_candidate_spec_signal_key",
    "_candidate_spec_is_false_negative_rescue",
    "_candidate_spec_is_loss_adaptive_feedback_escape",
    "_candidate_spec_active_loss_counter_tags",
    "_feedback_active_loss_counter_candidate_reasons",
    "_candidate_spec_matches_active_loss_counter_feedback",
    "_feedback_consistency_repair_candidate_reasons",
    "_candidate_spec_matches_consistency_repair_feedback",
    "_active_loss_counter_proposal_score",
    "_consistency_repair_proposal_score",
    "_scorecard_is_false_negative_rescue_feedback",
    "_candidate_spec_execution_profile",
    "_candidate_spec_feedback_risk_profile_key",
    "_candidate_spec_feedback_shape_key",
    "_candidate_spec_feedback_metadata",
    "_candidate_payload_with_feedback_metadata",
]
