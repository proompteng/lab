from __future__ import annotations

from app.trading.discovery.evidence_bundles import (
    EVIDENCE_BUNDLE_SCHEMA_VERSION,
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
)


def _promotion_quality_scorecard() -> dict[str, object]:
    return {
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
