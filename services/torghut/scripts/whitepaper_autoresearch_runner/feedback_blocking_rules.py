#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence, cast


from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
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

from scripts.whitepaper_autoresearch_runner.feedback_risk_profiles import (
    _feedback_risk_profile_key_payload,
)

_FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
    }
)

_RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS = frozenset(
    {
        "active_day_ratio_below_oracle",
        "positive_day_ratio_below_oracle",
        "best_day_share_above_oracle",
        "active_day_ratio_failed",
        "positive_day_ratio_failed",
        "min_daily_net_pnl_failed",
        "daily_net_observed_day_count_failed",
        "best_day_share_failed",
        "max_single_day_contribution_share_failed",
        "max_single_symbol_contribution_share_failed",
        "max_cluster_contribution_share_failed",
    }
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


def _feedback_scorecard_has_hard_veto(scorecard: Mapping[str, Any]) -> bool:
    if _oracle_blockers(scorecard):
        return True
    oracle_passed = scorecard.get("oracle_passed")
    if oracle_passed is not None and not _boolish(oracle_passed):
        return True
    hard_vetoes = scorecard.get("hard_vetoes") or scorecard.get("veto_reasons")
    if isinstance(hard_vetoes, str):
        return bool(hard_vetoes.strip())
    if isinstance(hard_vetoes, Sequence) and not isinstance(hard_vetoes, str):
        return any(_string(item) for item in hard_vetoes)
    return False


def _feedback_daily_net_has_loss(scorecard: Mapping[str, Any]) -> bool:
    daily_net = scorecard.get("daily_net")
    if not isinstance(daily_net, Mapping):
        return False
    return any(
        _decimal(value, default="0") <= Decimal("0")
        for value in cast(Mapping[Any, Any], daily_net).values()
    )


def _feedback_has_no_replay_activity(scorecard: Mapping[str, Any]) -> bool:
    explicit_activity = False
    for key in _REPLAY_ACTIVITY_COUNT_KEYS:
        if key not in scorecard:
            continue
        explicit_activity = True
        if _decimal(scorecard.get(key)) > Decimal("0"):
            return False
    if "avg_filled_notional_per_day" in scorecard:
        explicit_activity = True
        if _decimal(scorecard.get("avg_filled_notional_per_day")) > Decimal("0"):
            return False
    daily_filled_notional = scorecard.get("daily_filled_notional")
    if isinstance(daily_filled_notional, Mapping):
        explicit_activity = True
        if any(
            _decimal(value) > Decimal("0")
            for value in cast(Mapping[Any, Any], daily_filled_notional).values()
        ):
            return False
    return explicit_activity


def _feedback_family_prior_has_hard_block(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    oracle_blockers = _oracle_blockers(scorecard)
    if oracle_blockers & _FAMILY_PRIOR_HARD_BLOCK_ORACLE_BLOCKERS:
        return True
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        return True
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
    ):
        return True
    if _decimal(scorecard.get("best_day_share")) > policy.max_best_day_share:
        return True
    return _feedback_has_nonpositive_expected_value(scorecard)


def _feedback_risk_profile_has_penalty(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    oracle_blockers = _oracle_blockers(scorecard)
    if oracle_blockers & _RISK_PROFILE_FEEDBACK_ORACLE_BLOCKERS:
        return True
    if (
        _decimal(scorecard.get("active_day_ratio"), default="1")
        < policy.min_active_day_ratio
    ):
        return True
    if (
        _decimal(scorecard.get("positive_day_ratio"), default="1")
        < policy.min_positive_day_ratio
    ):
        return True
    if _decimal(scorecard.get("best_day_share")) > policy.max_best_day_share:
        return True
    if (
        _decimal(scorecard.get("max_single_day_contribution_share"))
        > policy.max_best_day_share
    ):
        return True
    if (
        _decimal(scorecard.get("max_single_symbol_contribution_share"), default="1")
        > policy.max_single_symbol_contribution_share
    ):
        return True
    if (
        _decimal(scorecard.get("max_cluster_contribution_share"), default="1")
        > policy.max_cluster_contribution_share
    ):
        return True
    return False


def _feedback_risk_profile_has_terminal_block(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    if not scorecard:
        return False
    if _feedback_has_no_replay_activity(scorecard):
        return True
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if not _feedback_risk_profile_has_penalty(scorecard, oracle_policy=policy):
        return False
    if _feedback_has_nonpositive_expected_value(scorecard):
        return True
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return True
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return True
    return _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    )


def _feedback_has_policy_penalty(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    if _feedback_has_no_replay_activity(scorecard):
        return True
    return _feedback_risk_profile_has_penalty(
        scorecard, oracle_policy=oracle_policy
    ) or _feedback_daily_net_has_loss(scorecard)


def _feedback_is_blocked(
    scorecard: Mapping[str, Any],
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> bool:
    policy = oracle_policy or ProfitTargetOraclePolicy()
    if _feedback_has_no_replay_activity(scorecard):
        return True
    if _feedback_scorecard_has_hard_veto(scorecard):
        return True
    if (
        _decimal(scorecard.get("max_gross_exposure_pct_equity"))
        > policy.max_gross_exposure_pct_equity
    ):
        return True
    if _decimal(scorecard.get("min_cash")) < policy.min_cash:
        return True
    if _decimal(scorecard.get("negative_cash_observation_count")) > Decimal(
        max(0, policy.max_negative_cash_observation_count)
    ):
        return True
    return _decimal(scorecard.get("net_pnl_per_day")) <= Decimal("0")


def _feedback_has_nonpositive_expected_value(scorecard: Mapping[str, Any]) -> bool:
    return _decimal(scorecard.get("net_pnl_per_day")) <= Decimal("0")


def _feedback_bundle_sort_value(
    bundle: CandidateEvidenceBundle,
    *,
    oracle_policy: ProfitTargetOraclePolicy | None = None,
) -> tuple[int, Decimal, str]:
    scorecard = bundle.objective_scorecard
    return (
        0 if _feedback_is_blocked(scorecard, oracle_policy=oracle_policy) else 1,
        _decimal(scorecard.get("net_pnl_per_day")),
        _string(bundle.candidate_id),
    )


def _feedback_family_template_id(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("family_template_id"))


def _feedback_execution_signature(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("execution_signature"))


def _feedback_shape_key(bundle: CandidateEvidenceBundle) -> str:
    return _string(bundle.objective_scorecard.get("feedback_shape_key"))


def _feedback_risk_profile_key_from_scorecard(scorecard: Mapping[str, Any]) -> str:
    direct_key = _string(scorecard.get("feedback_risk_profile_key"))
    if direct_key:
        return direct_key
    payload = _feedback_risk_profile_key_payload(
        family_template_id=_string(scorecard.get("family_template_id")),
        runtime_strategy_name=_string(scorecard.get("runtime_strategy_name")),
        execution_profile_id=_string(scorecard.get("execution_profile_id")),
        universe_key=_string(scorecard.get("universe_key")),
        signal_key=_string(scorecard.get("signal_key")),
    )
    if not any(_string(value) for value in payload.values()):
        return ""
    return _stable_hash(payload)


def _feedback_risk_profile_key(bundle: CandidateEvidenceBundle) -> str:
    return _feedback_risk_profile_key_from_scorecard(bundle.objective_scorecard)


__all__ = [
    "_feedback_scorecard_has_hard_veto",
    "_feedback_daily_net_has_loss",
    "_feedback_has_no_replay_activity",
    "_feedback_family_prior_has_hard_block",
    "_feedback_risk_profile_has_penalty",
    "_feedback_risk_profile_has_terminal_block",
    "_feedback_has_policy_penalty",
    "_feedback_is_blocked",
    "_feedback_has_nonpositive_expected_value",
    "_feedback_bundle_sort_value",
    "_feedback_family_template_id",
    "_feedback_execution_signature",
    "_feedback_shape_key",
    "_feedback_risk_profile_key_from_scorecard",
    "_feedback_risk_profile_key",
]
