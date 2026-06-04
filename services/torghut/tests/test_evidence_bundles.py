from __future__ import annotations

from app.trading.discovery.evidence_bundles import (
    EVIDENCE_BUNDLE_SCHEMA_VERSION,
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
)


def _promotion_quality_scorecard() -> dict[str, object]:
    return {
        "market_impact_stress_passed": True,
        "market_impact_stress_artifact_ref": "artifact://market-impact",
        "market_impact_stress_model": "nonlinear_square_root_impact",
        "market_impact_stress_cost_bps": "1",
        "market_impact_stress_net_pnl_per_day": "600",
        "market_impact_liquidity_evidence_present": True,
        "delay_adjusted_depth_stress_passed": True,
        "delay_adjusted_depth_stress_model": "delay_adjusted_depth_fixture",
        "delay_adjusted_depth_stress_ms": "50",
        "delay_adjusted_depth_stress_artifact_ref": "artifact://delay-depth",
        "delay_adjusted_depth_tail_coverage_passed": True,
        "delay_adjusted_depth_p10_active_day_fillable_notional": "1000",
        "delay_adjusted_depth_worst_active_day_fillable_notional": "1000",
        "delay_adjusted_depth_stress_net_pnl_per_day": "600",
        "fill_survival_evidence_present": True,
        "fill_survival_sample_count": 12,
        "queue_ahead_depletion_evidence_present": True,
        "queue_ahead_depletion_sample_count": 12,
        "queue_position_survival_fill_curve_evidence_present": True,
        "queue_position_survival_sample_count": 12,
        "queue_position_survival_fill_rate": "0.85",
        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
        "queue_position_survival_queue_ahead_depletion_sample_count": 12,
        "queue_position_survival_adjusted_fillable_ratio": "0.80",
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "600",
    }


def _unmaterialized_runtime_handoff() -> dict[str, object]:
    return {
        "schema_version": "torghut.fast-replay-runtime-ledger-lineage-handoff.v1",
        "status": "requires_runtime_ledger_materialization_before_authoritative_pnl",
        "candidate_spec_id": "spec-runtime-gap",
        "required_materialized_artifacts": [
            "closed_round_trip_ledger",
            "route_tca_observations",
            "trade_level_cost_log",
            "lineage_hash",
        ],
        "required_daily_pnl_basis": "post_cost_closed_round_trip_daily_pnl",
        "zero_authoritative_daily_pnl_until_materialized": True,
        "runtime_ledger_required": True,
        "source_backed_runtime_ledger_required": True,
        "proof_authority": False,
        "promotion_allowed": False,
        "final_authority_ok": False,
    }


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


def test_promotion_ready_bundle_blocks_required_ofi_response_gaps() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-ofi-response-gap",
        candidate_id="candidate-ofi-response-gap",
        candidate_spec_id="spec-ofi-response-gap",
        dataset_snapshot_id="snapshot-ofi-response-gap",
        feature_spec_hash="feature-ofi-response-gap",
        code_commit="commit-ofi-response-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_ofi_response_horizon_selection": True,
            "required_min_ofi_response_sample_count": "120",
            "required_min_ofi_response_stable_split_pass_rate": "0.60",
            "required_max_ofi_response_best_split_share": "0.35",
            "ofi_response_horizon_source_markers": [
                "ofi_response_horizon_arxiv_2505_17388_2025",
                "intraday_ofi_macro_news_arxiv_2508_06788_2025",
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

    assert "ofi_response_horizon_missing_or_failed" in blockers
    assert "ofi_response_horizon_artifact_missing" in blockers
    assert "ofi_response_sample_count_below_min" in blockers
    assert "ofi_response_stable_split_pass_rate_below_min" in blockers
    assert "ofi_response_best_split_share_missing" in blockers
    assert "executable_quote_evidence_missing" in blockers
    assert "ofi_route_tca_evidence_missing" in blockers
    assert "ofi_response_horizon_net_pnl_non_positive" in blockers


def test_promotion_ready_bundle_accepts_materialized_ofi_response_evidence() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-ofi-response-ready",
        candidate_id="candidate-ofi-response-ready",
        candidate_spec_id="spec-ofi-response-ready",
        dataset_snapshot_id="snapshot-ofi-response-ready",
        feature_spec_hash="feature-ofi-response-ready",
        code_commit="commit-ofi-response-ready",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_ofi_response_horizon_selection": True,
            "required_min_ofi_response_sample_count": "120",
            "required_min_ofi_response_stable_split_pass_rate": "0.60",
            "required_max_ofi_response_best_split_share": "0.35",
            "ofi_response_horizon_passed": True,
            "ofi_response_horizon_artifact_ref": "artifact://ofi-response",
            "ofi_response_sample_count": 120,
            "ofi_response_stable_split_pass_rate": "0.65",
            "ofi_response_best_split_share": "0.30",
            "executable_quote_evidence_present": True,
            "quote_evidence_sample_count": 120,
            "route_tca_artifact_ref": "artifact://route-tca",
            "post_cost_net_pnl_after_ofi_response_horizon": "540",
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

    assert "ofi_response_horizon_missing_or_failed" not in blockers
    assert "ofi_response_horizon_artifact_missing" not in blockers
    assert "ofi_response_sample_count_below_min" not in blockers
    assert "ofi_response_stable_split_pass_rate_below_min" not in blockers
    assert "ofi_response_best_split_share_missing" not in blockers
    assert "executable_quote_evidence_missing" not in blockers
    assert "ofi_route_tca_evidence_missing" not in blockers
    assert "ofi_response_horizon_net_pnl_non_positive" not in blockers


def test_frontier_candidate_preserves_order_type_tca_fields() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-order-type-preserved",
        candidate={
            "candidate_id": "candidate-order-type-preserved",
            "objective_scorecard": _promotion_quality_scorecard(),
            "requires_market_limit_order_type_validation": True,
            "market_limit_order_mix_sample_count": 24,
            "market_limit_order_mix_evidence_present": True,
            "market_limit_order_mix_passed": True,
            "route_tca_artifact_ref": "artifact://route-tca",
            "order_type_ablation_artifact_ref": "artifact://order-type-ablation",
            "order_type_ablation_sample_count": 24,
            "order_type_ablation_passed": True,
            "limit_fill_probability_sample_count": 12,
            "limit_fill_probability_evidence_present": True,
            "price_improvement_evidence_present": True,
            "execution_shortfall_evidence_present": True,
            "opportunity_cost_evidence_present": True,
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-order-type-preserved",
        result_path="artifact://replay",
        code_commit="commit-order-type-preserved",
    )

    assert (
        bundle.objective_scorecard["requires_market_limit_order_type_validation"]
        is True
    )
    assert bundle.objective_scorecard["order_type_ablation_sample_count"] == 24
    assert bundle.objective_scorecard["order_type_ablation_passed"] is True
    assert (
        bundle.objective_scorecard["route_tca_artifact_ref"] == "artifact://route-tca"
    )
    blockers = evidence_bundle_blockers(bundle)
    assert "order_type_ablation_artifact_missing" not in blockers
    assert "price_improvement_evidence_missing" not in blockers
    assert "execution_shortfall_evidence_missing" not in blockers


def test_frontier_candidate_preserves_bootstrap_robust_fields() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-bootstrap-preserved",
        candidate={
            "candidate_id": "candidate-bootstrap-preserved",
            "objective_scorecard": _promotion_quality_scorecard(),
            "hard_vetoes": {
                "required_bootstrap_robust_optimization": True,
                "required_min_bootstrap_replicates": "500",
            },
            "promotion_contract": {
                "requires_utility_percentile_optimization": True,
            },
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
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-bootstrap-preserved",
        result_path="artifact://replay",
        code_commit="commit-bootstrap-preserved",
    )

    assert bundle.objective_scorecard["required_bootstrap_robust_optimization"] is True
    assert bundle.objective_scorecard["required_min_bootstrap_replicates"] == "500"
    assert (
        bundle.objective_scorecard["requires_utility_percentile_optimization"] is True
    )
    assert (
        bundle.objective_scorecard["bootstrap_robust_optimization_artifact_ref"]
        == "artifact://bootstrap"
    )
    blockers = evidence_bundle_blockers(bundle)
    assert "bootstrap_robust_optimization_artifact_missing" not in blockers


def test_frontier_candidate_preserves_ofi_response_fields() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-ofi-response-preserved",
        candidate={
            "candidate_id": "candidate-ofi-response-preserved",
            "objective_scorecard": _promotion_quality_scorecard(),
            "hard_vetoes": {
                "required_min_ofi_response_sample_count": "120",
                "required_min_ofi_response_stable_split_pass_rate": "0.60",
                "required_max_ofi_response_best_split_share": "0.35",
                "required_executable_quote_evidence": True,
            },
            "promotion_contract": {
                "requires_ofi_response_horizon_selection": True,
            },
            "ofi_response_horizon_passed": True,
            "ofi_response_horizon_artifact_ref": "artifact://ofi-response",
            "ofi_response_sample_count": 120,
            "ofi_response_stable_split_pass_rate": "0.65",
            "ofi_response_best_split_share": "0.30",
            "executable_quote_evidence_present": True,
            "quote_evidence_sample_count": 120,
            "route_tca_artifact_ref": "artifact://route-tca",
            "post_cost_net_pnl_after_ofi_response_horizon": "540",
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-ofi-response-preserved",
        result_path="artifact://replay",
        code_commit="commit-ofi-response-preserved",
    )

    assert bundle.objective_scorecard["requires_ofi_response_horizon_selection"] is True
    assert bundle.objective_scorecard["required_executable_quote_evidence"] is True
    assert (
        bundle.objective_scorecard["ofi_response_horizon_artifact_ref"]
        == "artifact://ofi-response"
    )
    blockers = evidence_bundle_blockers(bundle)
    assert "ofi_response_horizon_artifact_missing" not in blockers
    assert "ofi_route_tca_evidence_missing" not in blockers


def test_frontier_candidate_preserves_implementation_risk_parity_fields() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-implementation-risk-preserved",
        candidate={
            "candidate_id": "candidate-implementation-risk-preserved",
            "objective_scorecard": _promotion_quality_scorecard(),
            "requires_multi_engine_replay": True,
            "multi_engine_replay_passed": True,
            "multi_engine_replay_engine_count": 2,
            "engine_sensitivity_report_ref": "artifact://engine-sensitivity",
            "conclusion_stability_passed": True,
            "conclusion_stability_index": "1.00",
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-implementation-risk-preserved",
        result_path="artifact://replay",
        code_commit="commit-implementation-risk-preserved",
    )

    assert bundle.objective_scorecard["requires_multi_engine_replay"] is True
    assert bundle.objective_scorecard["multi_engine_replay_passed"] is True
    assert bundle.objective_scorecard["multi_engine_replay_engine_count"] == 2
    assert (
        bundle.objective_scorecard["engine_sensitivity_report_ref"]
        == "artifact://engine-sensitivity"
    )
    assert bundle.objective_scorecard["conclusion_stability_passed"] is True
    assert bundle.objective_scorecard["conclusion_stability_index"] == "1.00"
    blockers = evidence_bundle_blockers(bundle)
    assert "multi_engine_replay_missing_or_failed" not in blockers
    assert "engine_sensitivity_report_missing" not in blockers
    assert "conclusion_stability_missing_or_failed" not in blockers


def test_frontier_candidate_preserves_runtime_handoff_as_promotion_blocker() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-runtime-gap",
        candidate={
            "candidate_id": "candidate-runtime-gap",
            "objective_scorecard": _promotion_quality_scorecard(),
            "runtime_ledger_lineage_materialization_handoff": (
                _unmaterialized_runtime_handoff()
            ),
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-runtime-gap",
        result_path="artifact://replay",
        code_commit="commit-runtime-gap",
    )

    assert (
        "runtime_ledger_lineage_materialization_handoff" in bundle.objective_scorecard
    )
    blockers = evidence_bundle_blockers(bundle)
    assert "authoritative_daily_pnl_missing" in blockers
    assert "runtime_ledger_lineage_materialization_missing" in blockers
