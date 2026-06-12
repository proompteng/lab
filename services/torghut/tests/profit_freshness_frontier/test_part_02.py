from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.profit_freshness_frontier.support import *


def test_fresh_execution_tca_does_not_inherit_routeability_blockers() -> None:
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "execution_tca_route_universe_exclusions_applied",
                    "freshness_seconds": 71,
                    "source_ref": {
                        "last_computed_at": "2026-05-12T15:08:49+00:00",
                    },
                }
            ],
        },
        routeability_repair_acceptance_ledger={
            "schema_version": "torghut.routeability-repair-acceptance-ledger.v1",
            "ledger_id": "routeability-acceptance-ledger:route-blocked",
            "aggregate_state": "blocked",
            "accepted_routeable_candidate_count": 0,
            "aggregate_blocking_reason_codes": [
                "proof_floor_repair_only",
                "capital_state_zero_notional",
                "route_tca_passed_but_dependency_receipts_block_capital",
                "execution_tca_route_universe_exclusions_applied",
                "execution_tca_symbol_missing",
            ],
            "lots": [
                {
                    "lot_id": "routeability-repair-lot:alpha",
                    "lot_type": "alpha_readiness_repair",
                    "current_state": "blocked",
                    "blocking_reason_codes": ["alpha_readiness_fail"],
                    "hypothesis_ids": ["H-AAPL"],
                },
                {
                    "lot_id": "routeability-repair-lot:tca",
                    "lot_type": "route_universe_tca_repair",
                    "current_state": "blocked",
                    "blocking_reason_codes": [
                        "execution_tca_route_universe_exclusions_applied",
                        "execution_tca_symbol_missing",
                    ],
                    "hypothesis_ids": ["H-AAPL", "H-AMD", "H-AMZN"],
                },
            ],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 0},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "probing",
                    "current_blocker": (
                        "route_tca_passed_but_dependency_receipts_block_capital"
                    ),
                    "hypothesis_ids": ["H-AAPL"],
                },
                {
                    "symbol": "AMD",
                    "state": "blocked",
                    "current_blocker": "execution_tca_route_universe_exclusions_applied",
                    "hypothesis_ids": ["H-AMD"],
                },
                {
                    "symbol": "AMZN",
                    "state": "missing",
                    "current_blocker": "execution_tca_symbol_missing",
                    "hypothesis_ids": ["H-AMZN"],
                },
            ],
        },
        quant_evidence={
            "ok": True,
            "status": "healthy",
            "latest_metrics_count": 144,
            "stage_count": 4,
        },
        market_context_status={"status": "healthy", "last_domain_states": {}},
        empirical_jobs_status={
            "ready": True,
            "status": "healthy",
            "eligible_jobs": [
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ],
            "candidate_ids": ["candidate-aapl"],
            "dataset_snapshot_refs": ["dataset-aapl"],
        },
        hypothesis_payload={
            "summary": {"promotion_eligible_total": 0, "reason_totals": {}},
            "items": [{"hypothesis_id": "H-AAPL", "reasons": []}],
        },
        jangar_reliability_settlement_ref={
            "settlement_ref": "jangar-reliability-settlement:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    tca_dimension = _dimension(frontier, "tca_fill_quality")
    route_dimension = _dimension(frontier, "route_readiness")

    assert tca_dimension["state"] == "current"
    assert tca_dimension["reason_codes"] == []
    assert tca_dimension["blocking_hypotheses"] == []
    assert tca_dimension["details"]["routeability_blocked_symbols"] == [
        "AAPL",
        "AMD",
        "AMZN",
    ]
    assert route_dimension["state"] == "blocked"
    assert "capital_state_zero_notional" in route_dimension["reason_codes"]
    assert (
        "route_tca_passed_but_dependency_receipts_block_capital"
        in route_dimension["reason_codes"]
    )
    assert (
        frontier["next_zero_notional_action"] == "recompute_route_tca_and_fill_quality"
    )
    assert (
        frontier["selected_zero_notional_repairs"][0]["zero_notional_action"]
        == "recompute_route_tca_and_fill_quality"
    )
    assert frontier["capital_posture"]["paper_replay_candidate_count"] == 0


def test_route_readiness_uses_settlement_action_without_unsettled_tca_lot() -> None:
    frontier = _frontier(
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "execution_tca",
                    "state": "pass",
                    "reason": "route_tca_passed",
                    "freshness_seconds": 71,
                    "source_ref": {
                        "last_computed_at": "2026-05-12T15:08:49+00:00",
                    },
                }
            ],
        },
        routeability_repair_acceptance_ledger={
            "schema_version": "torghut.routeability-repair-acceptance-ledger.v1",
            "ledger_id": "routeability-acceptance-ledger:route-alpha-blocked",
            "aggregate_state": "blocked",
            "accepted_routeable_candidate_count": 0,
            "aggregate_blocking_reason_codes": ["alpha_readiness_fail"],
            "lots": [
                {
                    "lot_id": "routeability-repair-lot:tca",
                    "lot_type": "route_universe_tca_repair",
                    "current_state": "accepted",
                    "blocking_reason_codes": [],
                },
                {
                    "lot_id": "routeability-repair-lot:alpha",
                    "lot_type": "alpha_readiness_repair",
                    "current_state": "blocked",
                    "blocking_reason_codes": ["alpha_readiness_fail"],
                    "hypothesis_ids": ["H-AAPL"],
                },
            ],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 0},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "routeable",
                    "current_blocker": "",
                    "hypothesis_ids": ["H-AAPL"],
                }
            ],
        },
        quant_evidence={
            "ok": True,
            "status": "healthy",
            "latest_metrics_count": 144,
            "stage_count": 4,
        },
        market_context_status={"status": "healthy", "last_domain_states": {}},
        empirical_jobs_status={
            "ready": True,
            "status": "healthy",
            "eligible_jobs": [
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ],
            "candidate_ids": ["candidate-aapl"],
            "dataset_snapshot_refs": ["dataset-aapl"],
        },
        hypothesis_payload={
            "summary": {"promotion_eligible_total": 0, "reason_totals": {}},
            "items": [{"hypothesis_id": "H-AAPL", "reasons": []}],
        },
        jangar_reliability_settlement_ref={
            "settlement_ref": "jangar-reliability-settlement:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    route_dimension = _dimension(frontier, "route_readiness")

    assert route_dimension["state"] == "blocked"
    assert "alpha_readiness_fail" in route_dimension["reason_codes"]
    assert (
        frontier["next_zero_notional_action"] == "settle_routeability_acceptance_lots"
    )


def test_profit_freshness_lots_carry_non_authoritative_target_notional_rankings() -> (
    None
):
    frontier = _frontier(
        quality_adjusted_profit_frontier={
            "frontier_id": "quality-frontier:target-notional",
            "packets": [
                {
                    "packet_id": "qapf:empirical-target",
                    "blocked_dimension": "empirical_proof",
                    "candidate_id": "candidate-nvda",
                    "post_cost_daily_net_pnl_unlock": "250.50",
                    "target_notional_ranking": {
                        "status": "feasible",
                        "target_daily_net_pnl": "500",
                        "observed_post_cost_expectancy_bps": "8",
                        "required_daily_notional": "625000",
                        "capacity_daily_notional": "900000",
                        "drawdown_budget": "1000",
                        "blocking_reasons": [],
                    },
                }
            ],
        }
    )

    selected = cast(list[Mapping[str, Any]], frontier["selected_zero_notional_repairs"])

    assert selected[0]["target_notional_ranking_basis"] == (
        "non_authoritative_candidate_comparison"
    )
    assert selected[0]["target_notional_rankings"] == [
        {
            "packet_ref": "qapf:empirical-target",
            "status": "feasible",
            "target_daily_net_pnl": "500",
            "observed_post_cost_expectancy_bps": "8",
            "required_daily_notional": "625000",
            "capacity_daily_notional": "900000",
            "drawdown_budget": "1000",
            "blocking_reasons": [],
            "authority": "ranking_metadata_only",
        }
    ]
    assert frontier["summary"]["target_notional_ranked_repair_count"] >= 1
