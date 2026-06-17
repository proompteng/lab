from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.evidence_bundles.support import (
    CandidateEvidenceBundle,
    EVIDENCE_BUNDLE_SCHEMA_VERSION,
    _promotion_quality_scorecard,
    _unmaterialized_runtime_handoff,
    evidence_bundle_blockers,
)


def test_promotion_ready_bundle_blocks_unmaterialized_runtime_ledger_handoff() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-runtime-gap",
        candidate_id="candidate-runtime-gap",
        candidate_spec_id="spec-runtime-gap",
        dataset_snapshot_id="snapshot-runtime-gap",
        feature_spec_hash="feature-runtime-gap",
        code_commit="commit-runtime-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "runtime_ledger_lineage_materialization_handoff": (
                _unmaterialized_runtime_handoff()
            ),
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "authoritative_daily_pnl_missing" in blockers
    assert "runtime_ledger_lineage_materialization_missing" in blockers
    assert "runtime_ledger_handoff_not_proof_authority" in blockers
    assert "runtime_ledger_handoff_not_promotion_authority" in blockers
    assert "runtime_ledger_handoff_final_authority_blocked" in blockers
    assert "runtime_ledger_required_artifacts_unmaterialized" in blockers


def test_promotion_ready_bundle_blocks_missing_market_impact_stress() -> None:
    scorecard = _promotion_quality_scorecard()
    for key in (
        "market_impact_stress_passed",
        "market_impact_stress_artifact_ref",
        "market_impact_stress_model",
        "market_impact_stress_cost_bps",
        "market_impact_stress_net_pnl_per_day",
        "market_impact_liquidity_evidence_present",
    ):
        scorecard.pop(key)

    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-market-impact-gap",
        candidate_id="candidate-market-impact-gap",
        candidate_spec_id="spec-market-impact-gap",
        dataset_snapshot_id="snapshot-market-impact-gap",
        feature_spec_hash="feature-market-impact-gap",
        code_commit="commit-market-impact-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard=scorecard,
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "market_impact_stress_failed" in blockers
    assert "market_impact_stress_artifact_missing" in blockers
    assert "market_impact_stress_model_missing" in blockers
    assert "market_impact_stress_cost_bps_below_min" in blockers
    assert "market_impact_stress_net_pnl_non_positive" in blockers
    assert "market_impact_liquidity_evidence_missing" in blockers


def test_promotion_ready_bundle_blocks_missing_order_type_tca_evidence() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-order-type-gap",
        candidate_id="candidate-order-type-gap",
        candidate_spec_id="spec-order-type-gap",
        dataset_snapshot_id="snapshot-order-type-gap",
        feature_spec_hash="feature-order-type-gap",
        code_commit="commit-order-type-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_market_limit_order_type_validation": True,
            "market_limit_order_mix_evidence_present": True,
            "market_limit_order_mix_sample_count": 12,
            "market_limit_order_mix_passed": False,
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "market_limit_order_mix_missing_or_failed" in blockers
    assert "route_tca_evidence_missing" in blockers
    assert "order_type_ablation_artifact_missing" in blockers
    assert "order_type_ablation_sample_count_zero" in blockers
    assert "order_type_ablation_missing_or_failed" in blockers
    assert "limit_fill_probability_evidence_missing" in blockers
    assert "limit_fill_probability_sample_count_zero" in blockers
    assert "price_improvement_evidence_missing" in blockers
    assert "execution_shortfall_evidence_missing" in blockers
    assert "opportunity_cost_evidence_missing" in blockers


def test_promotion_ready_bundle_infers_order_type_validation_from_mix_sample() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-order-type-sample-gap",
        candidate_id="candidate-order-type-sample-gap",
        candidate_spec_id="spec-order-type-sample-gap",
        dataset_snapshot_id="snapshot-order-type-sample-gap",
        feature_spec_hash="feature-order-type-sample-gap",
        code_commit="commit-order-type-sample-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "market_limit_order_mix_sample_count": 7,
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "market_limit_order_mix_evidence_missing" in blockers
    assert "market_limit_order_mix_sample_count_zero" not in blockers
    assert "route_tca_evidence_missing" in blockers


def test_promotion_ready_bundle_infers_order_type_validation_from_2026_source_marker() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-order-type-source-marker",
        candidate_id="candidate-order-type-source-marker",
        candidate_spec_id="spec-order-type-source-marker",
        dataset_snapshot_id="snapshot-order-type-source-marker",
        feature_spec_hash="feature-order-type-source-marker",
        code_commit="commit-order-type-source-marker",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "order_type_execution_source_markers": [
                "paper-arxiv-2507.06345",
            ],
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "market_limit_order_mix_evidence_missing" in blockers
    assert "route_tca_evidence_missing" in blockers
    assert "order_type_ablation_artifact_missing" in blockers
    assert "price_improvement_evidence_missing" in blockers
    assert blockers.count("price_improvement_evidence_missing") == 1


def test_promotion_ready_bundle_infers_order_type_validation_from_ablation_ref() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-order-type-ablation-ref-gap",
        candidate_id="candidate-order-type-ablation-ref-gap",
        candidate_spec_id="spec-order-type-ablation-ref-gap",
        dataset_snapshot_id="snapshot-order-type-ablation-ref-gap",
        feature_spec_hash="feature-order-type-ablation-ref-gap",
        code_commit="commit-order-type-ablation-ref-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "order_type_ablation_artifact_ref": "artifact://order-type-ablation",
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "market_limit_order_mix_evidence_missing" in blockers
    assert "market_limit_order_mix_sample_count_zero" in blockers
    assert "order_type_ablation_artifact_missing" not in blockers


def test_promotion_ready_bundle_accepts_materialized_order_type_tca_evidence() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-order-type-ok",
        candidate_id="candidate-order-type-ok",
        candidate_spec_id="spec-order-type-ok",
        dataset_snapshot_id="snapshot-order-type-ok",
        feature_spec_hash="feature-order-type-ok",
        code_commit="commit-order-type-ok",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_market_limit_order_type_validation": True,
            "market_limit_order_mix_evidence_present": True,
            "market_limit_order_mix_sample_count": 24,
            "market_limit_order_mix_passed": True,
            "route_tca_artifact_ref": "artifact://route-tca",
            "order_type_ablation_artifact_ref": "artifact://order-type-ablation",
            "order_type_ablation_sample_count": 24,
            "order_type_ablation_passed": True,
            "limit_fill_probability_evidence_present": True,
            "limit_fill_probability_sample_count": 12,
            "price_improvement_evidence_present": True,
            "execution_shortfall_evidence_present": True,
            "opportunity_cost_evidence_present": True,
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "market_limit_order_mix_missing_or_failed" not in blockers
    assert "route_tca_evidence_missing" not in blockers
    assert "order_type_ablation_artifact_missing" not in blockers
    assert "order_type_ablation_sample_count_zero" not in blockers
    assert "order_type_ablation_missing_or_failed" not in blockers
    assert "limit_fill_probability_evidence_missing" not in blockers
    assert "limit_fill_probability_sample_count_zero" not in blockers
    assert "price_improvement_evidence_missing" not in blockers
    assert "execution_shortfall_evidence_missing" not in blockers
    assert "opportunity_cost_evidence_missing" not in blockers


def test_promotion_ready_bundle_blocks_generic_fill_survival_without_queue_position_curve() -> (
    None
):
    scorecard = _promotion_quality_scorecard()
    for key in (
        "queue_position_survival_fill_curve_evidence_present",
        "queue_position_survival_sample_count",
        "queue_position_survival_fill_rate",
        "queue_position_survival_queue_ahead_depletion_evidence_present",
        "queue_position_survival_queue_ahead_depletion_sample_count",
        "queue_position_survival_adjusted_fillable_ratio",
        "post_cost_net_pnl_after_queue_position_survival_fill_stress",
    ):
        scorecard.pop(key)

    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-generic-fill-only",
        candidate_id="candidate-generic-fill-only",
        candidate_spec_id="spec-generic-fill-only",
        dataset_snapshot_id="snapshot-generic-fill-only",
        feature_spec_hash="feature-generic-fill-only",
        code_commit="commit-generic-fill-only",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard=scorecard,
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "fill_survival_evidence_missing" not in blockers
    assert "queue_ahead_depletion_evidence_missing" not in blockers
    assert "queue_position_survival_fill_curve_evidence_missing" in blockers
    assert "queue_position_survival_sample_count_zero" in blockers
    assert "queue_position_survival_fill_rate_non_positive" in blockers
    assert "queue_position_survival_queue_ahead_depletion_evidence_missing" in blockers
    assert "queue_position_survival_adjusted_fillable_ratio_non_positive" in blockers
    assert "queue_position_survival_stress_net_pnl_non_positive" in blockers


def test_promotion_ready_bundle_blocks_missing_implementation_risk_parity() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-implementation-risk-gap",
        candidate_id="candidate-implementation-risk-gap",
        candidate_spec_id="spec-implementation-risk-gap",
        dataset_snapshot_id="snapshot-implementation-risk-gap",
        feature_spec_hash="feature-implementation-risk-gap",
        code_commit="commit-implementation-risk-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "implementation_uncertainty_required": True,
            "implementation_uncertainty_stability_passed": True,
            "implementation_uncertainty_model_count": 5,
            "implementation_uncertainty_lower_net_pnl_per_day": "600",
            "implementation_uncertainty_source_markers": [
                "implementation_risk_backtesting_arxiv_2603_20319_2026"
            ],
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "multi_engine_replay_missing_or_failed" in blockers
    assert "multi_engine_replay_engine_count_below_min" in blockers
    assert "engine_sensitivity_report_missing" in blockers
    assert "conclusion_stability_missing_or_failed" in blockers
    assert "conclusion_stability_index_below_min" in blockers


def test_promotion_ready_bundle_accepts_materialized_implementation_risk_parity() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-implementation-risk-ok",
        candidate_id="candidate-implementation-risk-ok",
        candidate_spec_id="spec-implementation-risk-ok",
        dataset_snapshot_id="snapshot-implementation-risk-ok",
        feature_spec_hash="feature-implementation-risk-ok",
        code_commit="commit-implementation-risk-ok",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "implementation_uncertainty_required": True,
            "implementation_uncertainty_stability_passed": True,
            "implementation_uncertainty_model_count": 5,
            "implementation_uncertainty_lower_net_pnl_per_day": "600",
            "requires_multi_engine_replay": True,
            "multi_engine_replay_passed": True,
            "multi_engine_replay_engine_count": 2,
            "engine_sensitivity_report_ref": "artifact://engine-sensitivity",
            "conclusion_stability_passed": True,
            "conclusion_stability_index": "1.00",
            "required_conclusion_stability_index": "1.00",
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "multi_engine_replay_missing_or_failed" not in blockers
    assert "multi_engine_replay_engine_count_below_min" not in blockers
    assert "engine_sensitivity_report_missing" not in blockers
    assert "conclusion_stability_missing_or_failed" not in blockers
    assert "conclusion_stability_index_below_min" not in blockers


def test_promotion_ready_bundle_blocks_required_uncertainty_and_tail_risk_gaps() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-uncertainty-tail-gap",
        candidate_id="candidate-uncertainty-tail-gap",
        candidate_spec_id="spec-uncertainty-tail-gap",
        dataset_snapshot_id="snapshot-uncertainty-tail-gap",
        feature_spec_hash="feature-uncertainty-tail-gap",
        code_commit="commit-uncertainty-tail-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "implementation_uncertainty_required": True,
            "implementation_uncertainty_stability_passed": False,
            "implementation_uncertainty_model_count": 1,
            "implementation_uncertainty_lower_net_pnl_per_day": "0",
            "conformal_tail_risk_required": True,
            "conformal_tail_risk_passed": False,
            "conformal_tail_risk_sample_count": 0,
            "conformal_tail_risk_adjusted_net_pnl_per_day": "0",
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "implementation_uncertainty_stability_failed" in blockers
    assert "implementation_uncertainty_model_count_below_min" in blockers
    assert "implementation_uncertainty_lower_net_pnl_non_positive" in blockers
    assert "conformal_tail_risk_failed" in blockers
    assert "conformal_tail_risk_sample_count_zero" in blockers
    assert "conformal_tail_risk_adjusted_net_pnl_non_positive" in blockers


def test_promotion_ready_bundle_blocks_required_conformal_cost_buffer_gaps() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-conformal-cost-buffer-gap",
        candidate_id="candidate-conformal-cost-buffer-gap",
        candidate_spec_id="spec-conformal-cost-buffer-gap",
        dataset_snapshot_id="snapshot-conformal-cost-buffer-gap",
        feature_spec_hash="feature-conformal-cost-buffer-gap",
        code_commit="commit-conformal-cost-buffer-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_conformal_var_cost_buffer": True,
            "required_seed_model_family_robustness": True,
            "required_min_conformal_tail_risk_sample_count": "20",
            "conformal_tail_risk_passed": True,
            "conformal_tail_risk_sample_count": 12,
            "conformal_tail_risk_adjusted_net_pnl_per_day": "525",
            "conformal_tail_risk_target_net_pnl_per_day": "500",
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "conformal_tail_risk_sample_count_below_min" in blockers
    assert "breakeven_transaction_cost_buffer_missing_or_failed" in blockers
    assert "breakeven_transaction_cost_buffer_bps_missing" in blockers
    assert "breakeven_transaction_cost_buffer_net_pnl_non_positive" in blockers
    assert "seed_robustness_missing_or_failed" in blockers
    assert "seed_robustness_sample_count_zero" in blockers
    assert "model_family_robustness_missing_or_failed" in blockers
    assert "model_family_robustness_family_count_below_min" in blockers
    assert "conformal_tail_risk_adjusted_net_pnl_below_target" not in blockers


def test_promotion_ready_bundle_accepts_materialized_conformal_cost_buffer() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-conformal-cost-buffer-ok",
        candidate_id="candidate-conformal-cost-buffer-ok",
        candidate_spec_id="spec-conformal-cost-buffer-ok",
        dataset_snapshot_id="snapshot-conformal-cost-buffer-ok",
        feature_spec_hash="feature-conformal-cost-buffer-ok",
        code_commit="commit-conformal-cost-buffer-ok",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_conformal_var_cost_buffer": True,
            "required_seed_model_family_robustness": True,
            "required_min_conformal_tail_risk_sample_count": "20",
            "conformal_tail_risk_passed": True,
            "conformal_tail_risk_sample_count": 24,
            "conformal_tail_risk_adjusted_net_pnl_per_day": "525",
            "conformal_tail_risk_target_net_pnl_per_day": "500",
            "breakeven_transaction_cost_buffer_passed": True,
            "breakeven_transaction_cost_buffer_bps": "3.5",
            "post_cost_net_pnl_after_breakeven_transaction_cost_buffer": "525",
            "seed_robustness_passed": True,
            "seed_robustness_sample_count": 8,
            "model_family_robustness_passed": True,
            "model_family_robustness_family_count": 2,
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "conformal_tail_risk_sample_count_below_min" not in blockers
    assert "breakeven_transaction_cost_buffer_missing_or_failed" not in blockers
    assert "breakeven_transaction_cost_buffer_bps_missing" not in blockers
    assert "breakeven_transaction_cost_buffer_net_pnl_non_positive" not in blockers
    assert "seed_robustness_missing_or_failed" not in blockers
    assert "seed_robustness_sample_count_zero" not in blockers
    assert "model_family_robustness_missing_or_failed" not in blockers
    assert "model_family_robustness_family_count_below_min" not in blockers


def test_promotion_ready_bundle_blocks_required_bootstrap_robust_gaps() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-bootstrap-gap",
        candidate_id="candidate-bootstrap-gap",
        candidate_spec_id="spec-bootstrap-gap",
        dataset_snapshot_id="snapshot-bootstrap-gap",
        feature_spec_hash="feature-bootstrap-gap",
        code_commit="commit-bootstrap-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_bootstrap_robust_optimization": True,
            "required_min_bootstrap_replicates": "500",
            "bootstrap_robust_optimization_source_markers": [
                "bootstrap_robust_optimization_arxiv_2510_12725_2025",
                "spurious_predictability_arxiv_2604_15531_2026",
            ],
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "bootstrap_robust_optimization_missing_or_failed" in blockers
    assert "bootstrap_robust_optimization_artifact_missing" in blockers
    assert "bootstrap_replicate_count_below_min" in blockers
    assert "bootstrap_confidence_interval_missing_or_failed" in blockers
    assert "utility_percentile_optimization_missing_or_failed" in blockers
    assert "bootstrap_percentile_robust_net_pnl_non_positive" in blockers
    assert "selection_bias_stress_missing_or_failed" in blockers
    assert "parameter_instability_stress_missing_or_failed" in blockers
    assert "model_misspecification_stress_missing_or_failed" in blockers
    assert "out_of_sample_generalization_missing_or_failed" in blockers


def test_promotion_ready_bundle_accepts_materialized_bootstrap_robust_evidence() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-bootstrap-ready",
        candidate_id="candidate-bootstrap-ready",
        candidate_spec_id="spec-bootstrap-ready",
        dataset_snapshot_id="snapshot-bootstrap-ready",
        feature_spec_hash="feature-bootstrap-ready",
        code_commit="commit-bootstrap-ready",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_bootstrap_robust_optimization": True,
            "required_min_bootstrap_replicates": "500",
            "bootstrap_robust_optimization_passed": True,
            "bootstrap_robust_optimization_artifact_ref": "artifact://bootstrap",
            "bootstrap_replicate_count": 500,
            "bootstrap_confidence_interval_passed": True,
            "utility_percentile_optimization_passed": True,
            "bootstrap_percentile_robust_net_pnl_per_day": "550",
            "selection_bias_stress_passed": True,
            "parameter_instability_stress_passed": True,
            "model_misspecification_stress_passed": True,
            "out_of_sample_generalization_passed": True,
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": True},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "bootstrap_robust_optimization_missing_or_failed" not in blockers
    assert "bootstrap_robust_optimization_artifact_missing" not in blockers
    assert "bootstrap_replicate_count_below_min" not in blockers
    assert "bootstrap_confidence_interval_missing_or_failed" not in blockers
    assert "utility_percentile_optimization_missing_or_failed" not in blockers
    assert "bootstrap_percentile_robust_net_pnl_non_positive" not in blockers
    assert "selection_bias_stress_missing_or_failed" not in blockers
    assert "parameter_instability_stress_missing_or_failed" not in blockers
    assert "model_misspecification_stress_missing_or_failed" not in blockers
    assert "out_of_sample_generalization_missing_or_failed" not in blockers


def test_promotion_ready_bundle_blocks_required_adaptive_signal_falsification_gaps() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-adaptive-falsification-gap",
        candidate_id="candidate-adaptive-falsification-gap",
        candidate_spec_id="spec-adaptive-falsification-gap",
        dataset_snapshot_id="snapshot-adaptive-falsification-gap",
        feature_spec_hash="feature-adaptive-falsification-gap",
        code_commit="commit-adaptive-falsification-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_adaptive_signal_falsification": True,
            "required_min_null_model_sample_count": "100",
            "required_max_effective_multiplicity_adjusted_p_value": "0.05",
            "bootstrap_robust_optimization_source_markers": [
                "spurious_predictability_arxiv_2604_15531_2026",
            ],
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={"baseline_outperformed": False},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "adaptive_signal_falsification_missing_or_failed" in blockers
    assert "adaptive_signal_falsification_artifact_missing" in blockers
    assert "adaptive_signal_baseline_not_outperformed" in blockers
    assert "candidate_vs_null_return_delta_missing" in blockers
    assert "candidate_vs_incumbent_return_delta_missing" in blockers
    assert "null_model_sample_count_below_min" in blockers
    assert "effective_multiplicity_adjusted_p_value_missing" in blockers
    assert "negative_control_missing_or_failed" in blockers
    assert "placebo_label_test_missing_or_failed" in blockers
    assert "label_permutation_test_missing_or_failed" in blockers
    assert "feature_permutation_stability_missing_or_failed" in blockers
    assert "leakage_probe_missing_or_failed" in blockers
    assert "walk_forward_falsification_missing_or_failed" in blockers


def test_promotion_ready_bundle_accepts_materialized_adaptive_signal_falsification() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-adaptive-falsification-ready",
        candidate_id="candidate-adaptive-falsification-ready",
        candidate_spec_id="spec-adaptive-falsification-ready",
        dataset_snapshot_id="snapshot-adaptive-falsification-ready",
        feature_spec_hash="feature-adaptive-falsification-ready",
        code_commit="commit-adaptive-falsification-ready",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_adaptive_signal_falsification": True,
            "required_min_null_model_sample_count": "100",
            "required_max_effective_multiplicity_adjusted_p_value": "0.05",
            "adaptive_signal_falsification_passed": True,
            "adaptive_signal_falsification_artifact_ref": (
                "artifact://adaptive-falsification"
            ),
            "negative_control_passed": True,
            "placebo_label_test_passed": True,
            "label_permutation_test_passed": True,
            "feature_permutation_stability_passed": True,
            "leakage_probe_passed": True,
            "walk_forward_falsification_passed": True,
            "null_model_sample_count": 128,
            "effective_multiplicity_adjusted_p_value": "0.02",
            "candidate_vs_null_return_delta": "0.025",
            "candidate_vs_incumbent_return_delta": "0.004",
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={
            "baseline_outperformed": True,
        },
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "adaptive_signal_falsification_missing_or_failed" not in blockers
    assert "adaptive_signal_falsification_artifact_missing" not in blockers
    assert "adaptive_signal_baseline_not_outperformed" not in blockers
    assert "candidate_vs_null_return_delta_missing" not in blockers
    assert "candidate_vs_incumbent_return_delta_missing" not in blockers
    assert "null_model_sample_count_below_min" not in blockers
    assert "effective_multiplicity_adjusted_p_value_missing" not in blockers
    assert "negative_control_missing_or_failed" not in blockers
    assert "placebo_label_test_missing_or_failed" not in blockers
    assert "label_permutation_test_missing_or_failed" not in blockers
    assert "feature_permutation_stability_missing_or_failed" not in blockers
    assert "leakage_probe_missing_or_failed" not in blockers
    assert "walk_forward_falsification_missing_or_failed" not in blockers
