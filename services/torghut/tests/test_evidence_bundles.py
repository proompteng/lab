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
