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


__all__: tuple[str, ...] = (
    "CandidateEvidenceBundle",
    "EVIDENCE_BUNDLE_SCHEMA_VERSION",
    "_promotion_quality_scorecard",
    "_unmaterialized_runtime_handoff",
    "evidence_bundle_blockers",
    "evidence_bundle_from_frontier_candidate",
)
