from __future__ import annotations

# ruff: noqa: F401

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
    evaluate_profit_target_oracle,
)


def _executable_scorecard_fields() -> dict[str, object]:
    return {
        "executable_replay_passed": True,
        "executable_replay_artifact_ref": "/tmp/executable-replay.json",
        "executable_replay_order_count": 4,
        "executable_replay_account_buying_power": "20000",
        "executable_replay_max_notional_per_trade": "10000",
        "exact_replay_ledger_artifact_ref": "/tmp/exact-replay-ledger.json",
        "exact_replay_ledger_artifact_row_count": 20,
        "exact_replay_ledger_artifact_fill_count": 20,
        "portfolio_post_cost_net_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "portfolio_post_cost_net_pnl_source": "exact_replay_runtime_ledger",
        "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
        "runtime_ledger_pnl_source": "runtime_ledger",
        "market_impact_stress_passed": True,
        "market_impact_stress_artifact_ref": "/tmp/market-impact-stress.json",
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
        "delay_adjusted_depth_stress_passed": True,
        "delay_adjusted_depth_stress_artifact_ref": "/tmp/delay-adjusted-depth-stress.json",
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
        "queue_position_survival_fill_curve_evidence_present": True,
        "queue_position_survival_sample_count": 20,
        "queue_position_survival_fill_rate": "0.85",
        "queue_position_survival_queue_ratio_p95": "0.25",
        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
        "queue_position_survival_queue_ahead_depletion_sample_count": 20,
        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 20,
        "delay_adjusted_depth_fill_survival_evidence_present": True,
        "delay_adjusted_depth_fill_survival_sample_count": 20,
        "delay_adjusted_depth_fill_survival_rate": "0.85",
        "fill_survival_evidence_present": True,
        "fill_survival_sample_count": 20,
        "fill_survival_fill_rate": "0.85",
        "delay_adjusted_depth_stress_net_pnl_per_day": "520",
        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "515",
        "double_oos_passed": True,
        "double_oos_artifact_ref": "/tmp/double-oos-report.json",
        "double_oos_independent_window_count": 2,
        "double_oos_pass_rate": "1",
        "double_oos_net_pnl_per_day": "530",
        "double_oos_cost_shock_net_pnl_per_day": "515",
    }


def _passing_scorecard() -> dict[str, object]:
    return {
        "net_pnl_per_day": "535",
        "active_day_ratio": "1",
        "positive_day_ratio": "1",
        "best_day_share": "0.23",
        "max_single_day_contribution_share": "0.23",
        "max_cluster_contribution_share": "0.34",
        "max_single_symbol_contribution_share": "0.25",
        "worst_day_loss": "0",
        "max_drawdown": "0",
        "avg_filled_notional_per_day": "700000",
        "regime_slice_pass_rate": "0.55",
        "posterior_edge_lower": "0.01",
        "shadow_parity_status": "within_budget",
        "trading_day_count": 20,
        "daily_net": {f"2026-04-{day:02d}": "535" for day in range(1, 21)},
        **_executable_scorecard_fields(),
    }


def _check_by_metric(result: dict[str, object], metric: str) -> dict[str, object]:
    checks = result["checks"]
    assert isinstance(checks, list)
    for check in checks:
        assert isinstance(check, dict)
        if check.get("metric") == metric:
            return check
    raise AssertionError(f"missing check: {metric}")


class _TestProfitTargetOracleBase(TestCase):
    pass


__all__ = [name for name in globals() if not name.startswith("__")]
