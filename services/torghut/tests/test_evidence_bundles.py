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


def test_promotion_ready_bundle_blocks_weak_adaptive_signal_comparator_values() -> None:
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-adaptive-falsification-weak-comparator",
        candidate_id="candidate-adaptive-falsification-weak-comparator",
        candidate_spec_id="spec-adaptive-falsification-weak-comparator",
        dataset_snapshot_id="snapshot-adaptive-falsification-weak-comparator",
        feature_spec_hash="feature-adaptive-falsification-weak-comparator",
        code_commit="commit-adaptive-falsification-weak-comparator",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_adaptive_signal_falsification": True,
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
            "effective_multiplicity_adjusted_p_value": "0.10",
            "candidate_vs_null_return_delta": "0",
            "candidate_vs_incumbent_return_delta": "-0.001",
        },
        fold_metrics=(),
        stress_metrics=(),
        cost_calibration={"status": "calibrated", "source": "route_tca"},
        null_comparator={},
        promotion_readiness={
            "stage": "paper_probation",
            "status": "promotion_ready",
            "promotable": True,
        },
    )

    blockers = evidence_bundle_blockers(bundle)

    assert "adaptive_signal_null_comparator_missing" in blockers
    assert "candidate_vs_null_return_delta_non_positive" in blockers
    assert "candidate_vs_incumbent_return_delta_negative" in blockers
    assert "effective_multiplicity_adjusted_p_value_above_max" in blockers


def test_promotion_ready_bundle_infers_adaptive_signal_falsification_from_hard_veto() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-adaptive-falsification-hard-veto",
        candidate_id="candidate-adaptive-falsification-hard-veto",
        candidate_spec_id="spec-adaptive-falsification-hard-veto",
        dataset_snapshot_id="snapshot-adaptive-falsification-hard-veto",
        feature_spec_hash="feature-adaptive-falsification-hard-veto",
        code_commit="commit-adaptive-falsification-hard-veto",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "hard_vetoes": ["required_adaptive_signal_falsification"],
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

    assert "adaptive_signal_falsification_missing_or_failed" in blockers


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


def test_frontier_candidate_preserves_adaptive_signal_falsification_fields() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-adaptive-falsification-preserved",
        candidate={
            "candidate_id": "candidate-adaptive-falsification-preserved",
            "objective_scorecard": {
                **_promotion_quality_scorecard(),
                "requires_adaptive_signal_falsification": True,
            },
            "hard_vetoes": {
                "required_adaptive_signal_falsification": True,
                "required_min_null_model_sample_count": "100",
                "required_max_effective_multiplicity_adjusted_p_value": "0.05",
            },
            "promotion_contract": {
                "requires_negative_control_falsification": True,
                "requires_effective_multiplicity_adjustment": True,
            },
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
            "adaptive_signal_falsification_source_markers": [
                "spurious_predictability_arxiv_2604_15531_2026",
            ],
            "null_comparator": {
                "baseline_outperformed": True,
                "candidate_vs_null_return_delta": "0.025",
                "candidate_vs_incumbent_return_delta": "0.004",
            },
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-adaptive-falsification-preserved",
        result_path="artifact://replay",
        code_commit="commit-adaptive-falsification-preserved",
    )

    assert bundle.objective_scorecard["required_adaptive_signal_falsification"] is True
    assert bundle.objective_scorecard["requires_negative_control_falsification"] is True
    assert (
        bundle.objective_scorecard["requires_effective_multiplicity_adjustment"] is True
    )
    assert (
        bundle.objective_scorecard["adaptive_signal_falsification_artifact_ref"]
        == "artifact://adaptive-falsification"
    )
    assert bundle.null_comparator["baseline_outperformed"] is True
    blockers = evidence_bundle_blockers(bundle)
    assert "adaptive_signal_falsification_artifact_missing" not in blockers
    assert "adaptive_signal_baseline_not_outperformed" not in blockers


def test_frontier_candidate_applies_fast_replay_adaptive_falsification_patch() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-fast-replay-adaptive-falsification",
        candidate={
            "candidate_id": "candidate-fast-replay-adaptive-falsification",
            "objective_scorecard": _promotion_quality_scorecard(),
            "fast_replay_adaptive_signal_falsification_stress": {
                "status": (
                    "research_only_adaptive_signal_falsification_evidence_collection"
                ),
                "artifact_ref": "artifact://adaptive-falsification/fast-replay",
                "adaptive_signal_falsification_passed": False,
                "objective_scorecard_patch": {
                    "required_adaptive_signal_falsification": True,
                    "requires_negative_control_falsification": True,
                    "requires_label_permutation_test": True,
                    "requires_leakage_probe": True,
                    "requires_effective_multiplicity_adjustment": True,
                    "adaptive_signal_falsification_passed": False,
                    "adaptive_signal_falsification_artifact_ref": (
                        "artifact://adaptive-falsification/fast-replay"
                    ),
                    "negative_control_passed": False,
                    "placebo_label_test_passed": False,
                    "label_permutation_test_passed": False,
                    "feature_permutation_stability_passed": False,
                    "leakage_probe_passed": False,
                    "walk_forward_falsification_passed": False,
                    "null_model_sample_count": 0,
                    "required_min_null_model_sample_count": 30,
                    "effective_multiplicity_adjusted_p_value": 1.0,
                    "required_max_effective_multiplicity_adjusted_p_value": 0.05,
                    "candidate_vs_null_return_delta": 0.0,
                    "candidate_vs_incumbent_return_delta": 0.0,
                    "adaptive_signal_falsification_source_markers": [
                        "spurious_predictability_arxiv_2604_15531_2026",
                    ],
                },
                "null_comparator_patch": {
                    "baseline_outperformed": False,
                    "candidate_vs_null_return_delta": 0.0,
                    "candidate_vs_incumbent_return_delta": 0.0,
                    "null_model_sample_count": 0,
                },
            },
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-fast-replay-adaptive-falsification",
        result_path="artifact://replay",
        code_commit="commit-fast-replay-adaptive-falsification",
    )

    assert bundle.objective_scorecard["required_adaptive_signal_falsification"] is True
    assert bundle.objective_scorecard["adaptive_signal_falsification_passed"] is False
    assert (
        bundle.objective_scorecard["adaptive_signal_falsification_artifact_ref"]
        == "artifact://adaptive-falsification/fast-replay"
    )
    assert bundle.objective_scorecard[
        "adaptive_signal_falsification_source_markers"
    ] == ["spurious_predictability_arxiv_2604_15531_2026"]
    assert bundle.null_comparator["baseline_outperformed"] is False
    assert (
        "artifact://adaptive-falsification/fast-replay" in bundle.replay_artifact_refs
    )
    blockers = evidence_bundle_blockers(bundle)
    assert "adaptive_signal_falsification_missing_or_failed" in blockers
    assert "adaptive_signal_falsification_artifact_missing" not in blockers
    assert "adaptive_signal_baseline_not_outperformed" in blockers
    assert "null_model_sample_count_below_min" in blockers
    assert "leakage_probe_missing_or_failed" in blockers


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


def test_promotion_ready_bundle_blocks_required_alpha_decay_predictability_gaps() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-alpha-decay-gap",
        candidate_id="candidate-alpha-decay-gap",
        candidate_spec_id="spec-alpha-decay-gap",
        dataset_snapshot_id="snapshot-alpha-decay-gap",
        feature_spec_hash="feature-alpha-decay-gap",
        code_commit="commit-alpha-decay-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_predictability_decay_stress": True,
            "required_min_decay_stress_horizon_count": "3",
            "required_min_tight_spread_regime_count": "20",
            "required_min_high_volume_regime_count": "20",
            "required_min_decay_stress_split_pass_rate": "0.60",
            "required_max_decay_stress_best_split_share": "0.35",
            "required_max_model_inference_latency_ms": "200",
            "alpha_decay_predictability_source_markers": [
                "alpha_decay_predictability_arxiv_2601_02310_2026",
                "short_run_market_efficiency_ssrn_6608199_2026",
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

    assert "predictability_decay_stress_missing_or_failed" in blockers
    assert "predictability_decay_stress_artifact_missing" in blockers
    assert "horizon_decay_curve_missing" in blockers
    assert "spread_adjusted_label_replay_missing_or_failed" in blockers
    assert "predictability_decay_horizon_count_below_min" in blockers
    assert "tight_spread_regime_count_below_min" in blockers
    assert "high_volume_regime_count_below_min" in blockers
    assert "predictability_decay_split_pass_rate_below_min" in blockers
    assert "predictability_decay_best_split_share_missing" in blockers
    assert "model_inference_latency_missing" in blockers
    assert "predictability_decay_route_tca_evidence_missing" in blockers
    assert "predictability_decay_net_pnl_non_positive" in blockers


def test_promotion_ready_bundle_accepts_materialized_alpha_decay_predictability_evidence() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-alpha-decay-ready",
        candidate_id="candidate-alpha-decay-ready",
        candidate_spec_id="spec-alpha-decay-ready",
        dataset_snapshot_id="snapshot-alpha-decay-ready",
        feature_spec_hash="feature-alpha-decay-ready",
        code_commit="commit-alpha-decay-ready",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_predictability_decay_stress": True,
            "required_min_decay_stress_horizon_count": "3",
            "required_min_tight_spread_regime_count": "20",
            "required_min_high_volume_regime_count": "20",
            "required_min_decay_stress_split_pass_rate": "0.60",
            "required_max_decay_stress_best_split_share": "0.35",
            "required_max_model_inference_latency_ms": "200",
            "predictability_decay_stress_passed": True,
            "predictability_decay_stress_artifact_ref": "artifact://alpha-decay",
            "horizon_decay_curve_present": True,
            "spread_adjusted_label_replay_passed": True,
            "predictability_decay_stress_horizon_count": 4,
            "tight_spread_regime_count": 24,
            "high_volume_regime_count": 25,
            "predictability_decay_stress_split_pass_rate": "0.65",
            "predictability_decay_stress_best_split_share": "0.30",
            "model_inference_latency_ms": "80",
            "route_tca_artifact_ref": "artifact://route-tca",
            "post_cost_net_pnl_after_predictability_decay_stress": "535",
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

    assert "predictability_decay_stress_missing_or_failed" not in blockers
    assert "predictability_decay_stress_artifact_missing" not in blockers
    assert "horizon_decay_curve_missing" not in blockers
    assert "spread_adjusted_label_replay_missing_or_failed" not in blockers
    assert "predictability_decay_horizon_count_below_min" not in blockers
    assert "tight_spread_regime_count_below_min" not in blockers
    assert "high_volume_regime_count_below_min" not in blockers
    assert "predictability_decay_split_pass_rate_below_min" not in blockers
    assert "predictability_decay_best_split_share_missing" not in blockers
    assert "model_inference_latency_missing" not in blockers
    assert "predictability_decay_route_tca_evidence_missing" not in blockers
    assert "predictability_decay_net_pnl_non_positive" not in blockers


def test_frontier_candidate_preserves_alpha_decay_predictability_fields() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-alpha-decay-preserved",
        candidate={
            "candidate_id": "candidate-alpha-decay-preserved",
            "objective_scorecard": _promotion_quality_scorecard(),
            "hard_vetoes": {
                "required_predictability_decay_stress": True,
                "required_horizon_decay_curve": True,
                "required_spread_adjusted_label_replay": True,
                "required_min_decay_stress_horizon_count": "3",
                "required_min_tight_spread_regime_count": "20",
                "required_min_high_volume_regime_count": "20",
                "required_min_decay_stress_split_pass_rate": "0.60",
                "required_max_decay_stress_best_split_share": "0.35",
                "required_max_model_inference_latency_ms": "200",
            },
            "promotion_contract": {
                "requires_predictability_decay_stress": True,
                "requires_route_tca": True,
            },
            "predictability_decay_stress_passed": True,
            "predictability_decay_stress_artifact_ref": "artifact://alpha-decay",
            "horizon_decay_curve_present": True,
            "spread_adjusted_label_replay_passed": True,
            "predictability_decay_stress_horizon_count": 4,
            "tight_spread_regime_count": 24,
            "high_volume_regime_count": 25,
            "predictability_decay_stress_split_pass_rate": "0.65",
            "predictability_decay_stress_best_split_share": "0.30",
            "model_inference_latency_ms": "80",
            "route_tca_artifact_ref": "artifact://route-tca",
            "post_cost_net_pnl_after_predictability_decay_stress": "535",
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-alpha-decay-preserved",
        result_path="artifact://replay",
        code_commit="commit-alpha-decay-preserved",
    )

    assert bundle.objective_scorecard["requires_predictability_decay_stress"] is True
    assert bundle.objective_scorecard["required_horizon_decay_curve"] is True
    assert (
        bundle.objective_scorecard["predictability_decay_stress_artifact_ref"]
        == "artifact://alpha-decay"
    )
    blockers = evidence_bundle_blockers(bundle)
    assert "predictability_decay_stress_artifact_missing" not in blockers
    assert "predictability_decay_route_tca_evidence_missing" not in blockers


def test_promotion_ready_bundle_blocks_required_stochastic_liquidity_resilience_gaps() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-liquidity-resilience-gap",
        candidate_id="candidate-liquidity-resilience-gap",
        candidate_spec_id="spec-liquidity-resilience-gap",
        dataset_snapshot_id="snapshot-liquidity-resilience-gap",
        feature_spec_hash="feature-liquidity-resilience-gap",
        code_commit="commit-liquidity-resilience-gap",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_stochastic_liquidity_resilience_execution_grid": True,
            "required_max_liquidity_regime_shortfall_bps": "10",
            "stochastic_liquidity_resilience_source_markers": [
                "optimal_execution_liquidity_uncertainty_arxiv_2506_11813_2025",
                "stochastic_market_depth_ssrn_3798235_2025",
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

    assert "stochastic_liquidity_resilience_missing_or_failed" in blockers
    assert "stochastic_liquidity_resilience_artifact_missing" in blockers
    assert "liquidity_regime_transition_trace_missing" in blockers
    assert "stochastic_market_depth_state_missing" in blockers
    assert "lob_shape_parameter_history_missing" in blockers
    assert "resilience_decay_half_life_missing" in blockers
    assert "depth_recovery_after_child_order_missing" in blockers
    assert "execution_shortfall_by_liquidity_regime_missing" in blockers
    assert "liquidity_resilience_route_tca_evidence_missing" in blockers
    assert "liquidity_resilience_net_pnl_non_positive" in blockers


def test_promotion_ready_bundle_accepts_materialized_stochastic_liquidity_resilience_evidence() -> (
    None
):
    bundle = CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id="ev-liquidity-resilience-ready",
        candidate_id="candidate-liquidity-resilience-ready",
        candidate_spec_id="spec-liquidity-resilience-ready",
        dataset_snapshot_id="snapshot-liquidity-resilience-ready",
        feature_spec_hash="feature-liquidity-resilience-ready",
        code_commit="commit-liquidity-resilience-ready",
        replay_artifact_refs=("artifact://replay",),
        objective_scorecard={
            **_promotion_quality_scorecard(),
            "requires_stochastic_liquidity_resilience_execution_grid": True,
            "required_max_liquidity_regime_shortfall_bps": "10",
            "stochastic_liquidity_resilience_stress_passed": True,
            "stochastic_liquidity_resilience_stress_artifact_ref": (
                "artifact://liquidity-resilience"
            ),
            "liquidity_regime_transition_trace_present": True,
            "liquidity_regime_transition_count": 4,
            "stochastic_market_depth_state_present": True,
            "stochastic_market_depth_state_count": 48,
            "lob_shape_parameter_history_present": True,
            "lob_shape_parameter_sample_count": 48,
            "resilience_decay_half_life_present": True,
            "median_resilience_half_life_seconds": "120",
            "depth_recovery_after_child_order_present": True,
            "depth_recovery_sample_count": 24,
            "execution_shortfall_by_liquidity_regime_present": True,
            "execution_shortfall_by_liquidity_regime_sample_count": 24,
            "shortfall_by_liquidity_regime_bps": "6.5",
            "route_tca_artifact_ref": "artifact://route-tca",
            "post_cost_net_pnl_after_liquidity_regime_resilience_shortfall_stress": (
                "530"
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

    assert "stochastic_liquidity_resilience_missing_or_failed" not in blockers
    assert "stochastic_liquidity_resilience_artifact_missing" not in blockers
    assert "liquidity_regime_transition_trace_missing" not in blockers
    assert "stochastic_market_depth_state_missing" not in blockers
    assert "lob_shape_parameter_history_missing" not in blockers
    assert "resilience_decay_half_life_missing" not in blockers
    assert "depth_recovery_after_child_order_missing" not in blockers
    assert "execution_shortfall_by_liquidity_regime_missing" not in blockers
    assert "liquidity_regime_shortfall_above_max" not in blockers
    assert "liquidity_resilience_route_tca_evidence_missing" not in blockers
    assert "liquidity_resilience_net_pnl_non_positive" not in blockers


def test_frontier_candidate_preserves_stochastic_liquidity_resilience_fields() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-liquidity-resilience-preserved",
        candidate={
            "candidate_id": "candidate-liquidity-resilience-preserved",
            "objective_scorecard": _promotion_quality_scorecard(),
            "hard_vetoes": {
                "required_stochastic_liquidity_resilience_execution_grid": True,
                "required_liquidity_regime_transition_trace": True,
                "required_stochastic_market_depth_state": True,
                "required_lob_shape_parameter_history": True,
                "required_resilience_decay_half_life": True,
                "required_depth_recovery_after_child_order": True,
                "required_execution_shortfall_by_liquidity_regime": True,
                "required_max_liquidity_regime_shortfall_bps": "10",
            },
            "promotion_contract": {
                "requires_stochastic_liquidity_resilience_execution_grid": True,
                "requires_route_tca": True,
            },
            "stochastic_liquidity_resilience_stress_passed": True,
            "stochastic_liquidity_resilience_stress_artifact_ref": (
                "artifact://liquidity-resilience"
            ),
            "liquidity_regime_transition_trace_present": True,
            "liquidity_regime_transition_count": 4,
            "stochastic_market_depth_state_present": True,
            "stochastic_market_depth_state_count": 48,
            "lob_shape_parameter_history_present": True,
            "lob_shape_parameter_sample_count": 48,
            "resilience_decay_half_life_present": True,
            "median_resilience_half_life_seconds": "120",
            "depth_recovery_after_child_order_present": True,
            "depth_recovery_sample_count": 24,
            "execution_shortfall_by_liquidity_regime_present": True,
            "execution_shortfall_by_liquidity_regime_sample_count": 24,
            "shortfall_by_liquidity_regime_bps": "6.5",
            "route_tca_artifact_ref": "artifact://route-tca",
            "post_cost_net_pnl_after_liquidity_regime_resilience_shortfall_stress": (
                "530"
            ),
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-liquidity-resilience-preserved",
        result_path="artifact://replay",
        code_commit="commit-liquidity-resilience-preserved",
    )

    assert (
        bundle.objective_scorecard[
            "requires_stochastic_liquidity_resilience_execution_grid"
        ]
        is True
    )
    assert (
        bundle.objective_scorecard[
            "stochastic_liquidity_resilience_stress_artifact_ref"
        ]
        == "artifact://liquidity-resilience"
    )
    blockers = evidence_bundle_blockers(bundle)
    assert "stochastic_liquidity_resilience_artifact_missing" not in blockers
    assert "liquidity_resilience_route_tca_evidence_missing" not in blockers


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


def test_frontier_candidate_preserves_conformal_cost_buffer_contract_fields() -> None:
    bundle = evidence_bundle_from_frontier_candidate(
        candidate_spec_id="spec-conformal-cost-buffer-preserved",
        candidate={
            "candidate_id": "candidate-conformal-cost-buffer-preserved",
            "objective_scorecard": _promotion_quality_scorecard(),
            "promotion_contract": {
                "requires_conformal_var_cost_buffer": True,
                "required_seed_model_family_robustness": True,
            },
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
            "promotion_readiness": {
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
            "cost_calibration": {"status": "calibrated", "source": "route_tca"},
        },
        dataset_snapshot_id="snapshot-conformal-cost-buffer-preserved",
        result_path="artifact://replay",
        code_commit="commit-conformal-cost-buffer-preserved",
    )

    assert bundle.objective_scorecard["requires_conformal_var_cost_buffer"] is True
    assert bundle.objective_scorecard["required_seed_model_family_robustness"] is True
    assert bundle.objective_scorecard["conformal_tail_risk_sample_count"] == 24
    assert (
        bundle.objective_scorecard[
            "post_cost_net_pnl_after_breakeven_transaction_cost_buffer"
        ]
        == "525"
    )
    blockers = evidence_bundle_blockers(bundle)
    assert "breakeven_transaction_cost_buffer_missing_or_failed" not in blockers
    assert "seed_robustness_missing_or_failed" not in blockers
    assert "model_family_robustness_missing_or_failed" not in blockers


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
