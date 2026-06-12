from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.evidence_bundles.support import *


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
