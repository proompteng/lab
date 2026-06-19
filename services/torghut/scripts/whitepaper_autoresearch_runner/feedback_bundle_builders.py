#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

from dataclasses import replace


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
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

from scripts.whitepaper_autoresearch_runner.candidate_prior_scoring import (
    _candidate_payload_with_feedback_metadata,
    _candidate_spec_feedback_metadata,
    _pre_replay_candidate_score,
)


def _pre_replay_prior_bundle(spec: CandidateSpec) -> CandidateEvidenceBundle:
    prior_score = _pre_replay_candidate_score(spec)
    return evidence_bundle_from_frontier_candidate(
        candidate_spec_id=spec.candidate_spec_id,
        candidate=_candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": f"pre-replay-prior-{spec.candidate_spec_id}",
                "objective_scorecard": {
                    "net_pnl_per_day": str(prior_score),
                    "active_day_ratio": "0.50",
                    "positive_day_ratio": "0.50",
                    "regime_slice_pass_rate": "0.45",
                    "posterior_edge_lower": "0.001",
                    "shadow_parity_status": "pending",
                },
                "promotion_readiness": {
                    "stage": "research_candidate",
                    "status": "pre_replay_prior",
                    "promotable": False,
                    "blockers": ["runtime_replay_required"],
                },
            },
        ),
        dataset_snapshot_id="pre-replay-proposal-priors",
        result_path=f"pre-replay-proposal-priors://{spec.candidate_spec_id}",
    )


def _execution_signature_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "execution_signature",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"signature-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _shape_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "feedback_shape_key",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"shape-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _risk_profile_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "feedback_risk_profile_key",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"risk-profile-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


def _family_feedback_bundle_for_spec(
    *,
    spec: CandidateSpec,
    bundle: CandidateEvidenceBundle,
) -> CandidateEvidenceBundle:
    scorecard = {
        **dict(bundle.objective_scorecard),
        **_candidate_spec_feedback_metadata(spec),
        "feedback_match_scope": "family_template_id",
        "feedback_source_candidate_spec_id": bundle.candidate_spec_id,
    }
    return replace(
        bundle,
        candidate_spec_id=spec.candidate_spec_id,
        candidate_id=f"family-feedback-{bundle.candidate_id}",
        objective_scorecard=scorecard,
    )


__all__ = [
    "_pre_replay_prior_bundle",
    "_execution_signature_feedback_bundle_for_spec",
    "_shape_feedback_bundle_for_spec",
    "_risk_profile_feedback_bundle_for_spec",
    "_family_feedback_bundle_for_spec",
]
