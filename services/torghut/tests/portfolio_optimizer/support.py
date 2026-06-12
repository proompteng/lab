from __future__ import annotations

# ruff: noqa: F401

from decimal import Decimal
from unittest import TestCase

import app.trading.discovery.portfolio_optimizer as portfolio_optimizer_module
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)
from app.trading.discovery.portfolio_candidates import (
    portfolio_candidate_from_payload,
)
from app.trading.discovery.portfolio_optimizer import optimize_portfolio_candidate
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy


def _executable_scorecard_fields(index: int | str = 0) -> dict[str, object]:
    return {
        "executable_replay_passed": True,
        "executable_replay_artifact_ref": f"/tmp/executable-replay-{index}.json",
        "executable_replay_order_count": 5,
        "executable_replay_account_buying_power": "20000",
        "executable_replay_max_notional_per_trade": "10000",
        "exact_replay_ledger_artifact_ref": f"/tmp/exact-replay-ledger-{index}.json",
        "exact_replay_ledger_artifact_row_count": 5,
        "exact_replay_ledger_artifact_fill_count": 5,
        "portfolio_post_cost_net_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "portfolio_post_cost_net_pnl_source": "runtime_ledger",
        "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "runtime_ledger_pnl_source": "runtime_ledger",
        "market_impact_stress_passed": True,
        "market_impact_stress_artifact_ref": f"/tmp/market-impact-stress-{index}.json",
        "market_impact_stress_model": "square_root",
        "market_impact_stress_cost_bps": "6",
        "market_impact_liquidity_evidence_present": True,
        "market_impact_stress_net_pnl_per_day": "535",
        "implementation_uncertainty_required": True,
        "implementation_uncertainty_model": "impact_latency_cost_model_interval",
        "implementation_uncertainty_model_count": 5,
        "implementation_uncertainty_stability_passed": True,
        "implementation_uncertainty_lower_net_pnl_per_day": "515",
        "implementation_uncertainty_upper_net_pnl_per_day": "540",
        "implementation_uncertainty_interval_width_per_day": "25",
        "market_impact_stress_components": {
            "square_root_cost_bps": "6",
            "almgren_chriss_temporary_impact_bps": "4",
            "almgren_chriss_permanent_impact_bps": "1",
            "almgren_chriss_cost_bps": "5",
            "selected_cost_bps": "6",
            "selected_model": "square_root",
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
        },
        "nonlinear_market_impact_stress_passed": True,
        "nonlinear_market_impact_stress_model": "square_root",
        "nonlinear_market_impact_stress_cost_bps": "6",
        "nonlinear_market_impact_stress_net_pnl_per_day": "535",
        "permanent_impact_decay_model": "exponential_decay_proxy",
        "delay_adjusted_depth_stress_passed": True,
        "delay_adjusted_depth_stress_artifact_ref": f"/tmp/delay-adjusted-depth-stress-{index}.json",
        "delay_adjusted_depth_stress_model": "latency_depth_haircut",
        "delay_adjusted_depth_stress_ms": "250",
        "delay_adjusted_depth_latency_grid_ms": ["50", "150", "250"],
        "delay_adjusted_depth_grid_max_stress_ms": "250",
        "delay_adjusted_depth_liquidity_evidence_present": True,
        "delay_adjusted_depth_liquidity_missing_day_count": 0,
        "delay_adjusted_depth_fillable_notional_per_day": "525000",
        "delay_adjusted_depth_worst_active_day_fillable_notional": "525000",
        "delay_adjusted_depth_p10_active_day_fillable_notional": "525000",
        "delay_adjusted_depth_tail_coverage_passed": True,
        "delay_adjusted_depth_fill_survival_evidence_present": True,
        "delay_adjusted_depth_fill_survival_sample_count": 5,
        "delay_adjusted_depth_fill_survival_rate": "0.85",
        "queue_position_survival_fill_curve_evidence_present": True,
        "queue_position_survival_sample_count": 5,
        "queue_position_survival_fill_rate": "0.85",
        "queue_position_survival_queue_ratio_p95": "0.25",
        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
        "queue_position_survival_queue_ahead_depletion_sample_count": 5,
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 5,
        "queue_ahead_depletion_evidence_present": True,
        "queue_ahead_depletion_sample_count": 5,
        "fill_survival_evidence_present": True,
        "fill_survival_sample_count": 5,
        "fill_survival_fill_rate": "0.85",
        "delay_adjusted_depth_stress_net_pnl_per_day": "520",
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "520",
        "double_oos_passed": True,
        "double_oos_artifact_ref": f"/tmp/double-oos-{index}.json",
        "double_oos_independent_window_count": 2,
        "double_oos_pass_rate": "1",
        "double_oos_net_pnl_per_day": "535",
        "double_oos_cost_shock_net_pnl_per_day": "515",
    }


class _TestPortfolioOptimizerBase(TestCase):
    pass


__all__ = [name for name in globals() if not name.startswith("__")]
