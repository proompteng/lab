"""Profit-target oracle policy and accepted evidence constants."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from app.trading.runtime_ledger import POST_COST_PNL_BASIS


PROFIT_TARGET_ORACLE_SCHEMA_VERSION = "torghut.profit-target-oracle.v1"
ACCEPTED_LEDGER_PNL_BASES = frozenset({POST_COST_PNL_BASIS})
ACCEPTED_LEDGER_PNL_SOURCES = frozenset(
    {
        "exact_replay_ledger",
        "exact_replay_runtime_ledger",
        "runtime_execution_ledger",
        "runtime_ledger",
        "strategy_runtime_ledger",
        "strategy_runtime_ledger_bucket",
        "strategy_runtime_ledger_buckets",
    }
)
ACCEPTED_MARKET_IMPACT_STRESS_MODELS = frozenset(
    {
        "almgren_chriss",
        "almgren-chriss",
        "square_root",
        "square-root",
        "power_law",
        "power-law",
        "portfolio_square_root_impact",
        "portfolio_power_law_impact",
        "portfolio_nonlinear_impact",
    }
)
ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS = frozenset(
    {
        "latency_depth_haircut",
        "delay_depth_haircut",
        "portfolio_latency_depth_haircut",
    }
)
POST_COST_EXPECTANCY_BPS_KEYS = (
    "observed_post_cost_expectancy_bps",
    "post_cost_expectancy_bps",
    "portfolio_post_cost_expectancy_bps",
    "realized_post_cost_expectancy_bps",
)
AVG_FILLED_NOTIONAL_PER_DAY_KEYS = (
    "avg_filled_notional_per_day",
    "average_filled_notional_per_day",
    "avg_daily_filled_notional",
    "filled_notional_per_day",
    "avg_filled_notional_per_window_weekday",
)


@dataclass(frozen=True)
class ProfitTargetOraclePolicy:
    min_active_day_ratio: Decimal = Decimal("0.90")
    min_positive_day_ratio: Decimal = Decimal("0.60")
    min_profit_factor: Decimal = Decimal("1.50")
    min_daily_net_pnl: Decimal = Decimal("-999999999")
    max_best_day_share: Decimal = Decimal("0.25")
    max_cluster_contribution_share: Decimal = Decimal("0.40")
    max_single_symbol_contribution_share: Decimal = Decimal("0.35")
    max_worst_day_loss: Decimal = Decimal("999999999")
    max_drawdown: Decimal = Decimal("999999999")
    default_start_equity: Decimal = Decimal("31590.02")
    max_worst_day_loss_pct_equity: Decimal = Decimal("0.05")
    max_drawdown_pct_equity: Decimal = Decimal("0.08")
    extended_max_worst_day_loss_pct_equity: Decimal = Decimal("0.08")
    extended_max_drawdown_pct_equity: Decimal = Decimal("0.12")
    min_total_net_pnl_to_drawdown_ratio: Decimal = Decimal("3.00")
    max_gross_exposure_pct_equity: Decimal = Decimal("1.0")
    min_cash: Decimal = Decimal("0")
    max_negative_cash_observation_count: int = 0
    min_avg_filled_notional_per_day: Decimal = Decimal("300000")
    min_observed_trading_days: int = 20
    min_regime_slice_pass_rate: Decimal = Decimal("0.45")
    min_posterior_edge_lower: Decimal = Decimal("0")
    require_shadow_parity_within_budget: bool = True
    require_executable_replay: bool = True
    min_executable_order_count: int = 1
    require_executable_replay_notional_within_buying_power: bool = True
    require_exact_replay_ledger: bool = True
    min_exact_replay_ledger_row_count: int = 1
    min_exact_replay_ledger_fill_count: int = 1
    require_market_impact_stress: bool = True
    min_market_impact_stress_cost_bps: Decimal = Decimal("1")
    require_market_impact_liquidity_evidence: bool = True
    require_delay_adjusted_depth_stress: bool = True
    require_delay_adjusted_depth_liquidity_evidence: bool = True
    require_delay_adjusted_depth_latency_grid: bool = True
    require_delay_adjusted_depth_tail_coverage: bool = True
    min_delay_adjusted_depth_stress_ms: Decimal = Decimal("50")
    min_delay_adjusted_depth_grid_max_stress_ms: Decimal = Decimal("250")
    min_delay_adjusted_depth_fillable_notional_per_day: Decimal = Decimal("300000")
    min_delay_adjusted_depth_tail_fillable_notional: Decimal = Decimal("300000")
    require_fill_survival_evidence: bool = True
    require_queue_position_survival_evidence: bool = True
    require_queue_ahead_depletion_evidence: bool = True
    min_queue_ahead_depletion_sample_count: int = 1
    min_fill_survival_sample_count: int = 1
    min_fill_survival_rate: Decimal = Decimal("0")
    require_implementation_uncertainty_stability: bool = False
    min_implementation_uncertainty_model_count: int = 2
    require_conformal_tail_risk: bool = False
    min_conformal_tail_risk_sample_count: int = 0
    require_predictability_decay_stress: bool = False
    min_predictability_decay_stress_horizon_count: int = 3
    min_tight_spread_regime_count: int = 20
    min_predictability_decay_stress_split_pass_rate: Decimal = Decimal("0.60")
    max_predictability_decay_stress_best_split_share: Decimal = Decimal("0.35")
    require_double_oos: bool = True
    min_double_oos_independent_window_count: int = 2
    min_double_oos_pass_rate: Decimal = Decimal("1.00")
    max_missing_sleeve_daily_net_count: int = 0
    max_validation_contract_pending_count: int = 0
    max_validation_live_paper_parity_pending_count: int = 0
    max_synthetic_evidence_not_promotion_proof_count: int = 0
    require_rejected_signal_outcome_learning: bool = False
    min_rejected_signal_outcome_label_count: int = 120
    min_rejected_signal_reason_coverage: Decimal = Decimal("0.80")
    max_rejected_signal_outcome_pending_ratio: Decimal = Decimal("0.05")
    required_rejected_signal_counterfactual_fields: tuple[str, ...] = (
        "counterfactual_return",
        "route_tca",
        "post_cost_net_pnl",
        "executable_quote",
    )
    required_rejected_signal_outcome_persistence_state: str = "ok"
    require_order_type_execution_quality: bool = False
    min_order_type_ablation_sample_count: int = 60
    max_order_type_opportunity_cost_bps: Decimal = Decimal("8")
    max_market_order_spread_bps: Decimal = Decimal("8")
    require_mpc_dynamic_execution_schedule: bool = False
    min_mpc_schedule_trace_sample_count: int = 60
    max_mpc_schedule_shortfall_bps: Decimal = Decimal("8")

    def to_payload(self) -> dict[str, Any]:
        return {
            "min_active_day_ratio": str(self.min_active_day_ratio),
            "min_positive_day_ratio": str(self.min_positive_day_ratio),
            "min_profit_factor": str(self.min_profit_factor),
            "min_daily_net_pnl": str(self.min_daily_net_pnl),
            "max_best_day_share": str(self.max_best_day_share),
            "max_cluster_contribution_share": str(self.max_cluster_contribution_share),
            "max_single_symbol_contribution_share": str(
                self.max_single_symbol_contribution_share
            ),
            "max_worst_day_loss": str(self.max_worst_day_loss),
            "max_drawdown": str(self.max_drawdown),
            "default_start_equity": str(self.default_start_equity),
            "max_worst_day_loss_pct_equity": str(self.max_worst_day_loss_pct_equity),
            "max_drawdown_pct_equity": str(self.max_drawdown_pct_equity),
            "extended_max_worst_day_loss_pct_equity": str(
                self.extended_max_worst_day_loss_pct_equity
            ),
            "extended_max_drawdown_pct_equity": str(
                self.extended_max_drawdown_pct_equity
            ),
            "min_total_net_pnl_to_drawdown_ratio": str(
                self.min_total_net_pnl_to_drawdown_ratio
            ),
            "max_gross_exposure_pct_equity": str(self.max_gross_exposure_pct_equity),
            "min_cash": str(self.min_cash),
            "max_negative_cash_observation_count": self.max_negative_cash_observation_count,
            "min_avg_filled_notional_per_day": str(
                self.min_avg_filled_notional_per_day
            ),
            "min_observed_trading_days": self.min_observed_trading_days,
            "min_regime_slice_pass_rate": str(self.min_regime_slice_pass_rate),
            "min_posterior_edge_lower": str(self.min_posterior_edge_lower),
            "require_shadow_parity_within_budget": self.require_shadow_parity_within_budget,
            "require_executable_replay": self.require_executable_replay,
            "min_executable_order_count": self.min_executable_order_count,
            "require_executable_replay_notional_within_buying_power": self.require_executable_replay_notional_within_buying_power,
            "require_exact_replay_ledger": self.require_exact_replay_ledger,
            "min_exact_replay_ledger_row_count": self.min_exact_replay_ledger_row_count,
            "min_exact_replay_ledger_fill_count": self.min_exact_replay_ledger_fill_count,
            "require_market_impact_stress": self.require_market_impact_stress,
            "min_market_impact_stress_cost_bps": str(
                self.min_market_impact_stress_cost_bps
            ),
            "require_market_impact_liquidity_evidence": self.require_market_impact_liquidity_evidence,
            "accepted_market_impact_stress_models": sorted(
                ACCEPTED_MARKET_IMPACT_STRESS_MODELS
            ),
            "require_delay_adjusted_depth_stress": self.require_delay_adjusted_depth_stress,
            "require_delay_adjusted_depth_liquidity_evidence": self.require_delay_adjusted_depth_liquidity_evidence,
            "require_delay_adjusted_depth_latency_grid": self.require_delay_adjusted_depth_latency_grid,
            "require_delay_adjusted_depth_tail_coverage": self.require_delay_adjusted_depth_tail_coverage,
            "min_delay_adjusted_depth_stress_ms": str(
                self.min_delay_adjusted_depth_stress_ms
            ),
            "min_delay_adjusted_depth_grid_max_stress_ms": str(
                self.min_delay_adjusted_depth_grid_max_stress_ms
            ),
            "min_delay_adjusted_depth_fillable_notional_per_day": str(
                self.min_delay_adjusted_depth_fillable_notional_per_day
            ),
            "min_delay_adjusted_depth_tail_fillable_notional": str(
                self.min_delay_adjusted_depth_tail_fillable_notional
            ),
            "require_fill_survival_evidence": self.require_fill_survival_evidence,
            "require_queue_position_survival_evidence": self.require_queue_position_survival_evidence,
            "require_queue_ahead_depletion_evidence": self.require_queue_ahead_depletion_evidence,
            "min_queue_ahead_depletion_sample_count": self.min_queue_ahead_depletion_sample_count,
            "min_fill_survival_sample_count": self.min_fill_survival_sample_count,
            "min_fill_survival_rate": str(self.min_fill_survival_rate),
            "accepted_delay_adjusted_depth_stress_models": sorted(
                ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS
            ),
            "require_implementation_uncertainty_stability": self.require_implementation_uncertainty_stability,
            "min_implementation_uncertainty_model_count": self.min_implementation_uncertainty_model_count,
            "require_conformal_tail_risk": self.require_conformal_tail_risk,
            "min_conformal_tail_risk_sample_count": self.min_conformal_tail_risk_sample_count,
            "require_predictability_decay_stress": self.require_predictability_decay_stress,
            "min_predictability_decay_stress_horizon_count": self.min_predictability_decay_stress_horizon_count,
            "min_tight_spread_regime_count": self.min_tight_spread_regime_count,
            "min_predictability_decay_stress_split_pass_rate": str(
                self.min_predictability_decay_stress_split_pass_rate
            ),
            "max_predictability_decay_stress_best_split_share": str(
                self.max_predictability_decay_stress_best_split_share
            ),
            "require_double_oos": self.require_double_oos,
            "min_double_oos_independent_window_count": self.min_double_oos_independent_window_count,
            "min_double_oos_pass_rate": str(self.min_double_oos_pass_rate),
            "max_missing_sleeve_daily_net_count": self.max_missing_sleeve_daily_net_count,
            "max_validation_contract_pending_count": self.max_validation_contract_pending_count,
            "max_validation_live_paper_parity_pending_count": self.max_validation_live_paper_parity_pending_count,
            "max_synthetic_evidence_not_promotion_proof_count": self.max_synthetic_evidence_not_promotion_proof_count,
            "require_rejected_signal_outcome_learning": self.require_rejected_signal_outcome_learning,
            "min_rejected_signal_outcome_label_count": self.min_rejected_signal_outcome_label_count,
            "min_rejected_signal_reason_coverage": str(
                self.min_rejected_signal_reason_coverage
            ),
            "max_rejected_signal_outcome_pending_ratio": str(
                self.max_rejected_signal_outcome_pending_ratio
            ),
            "required_rejected_signal_counterfactual_fields": list(
                self.required_rejected_signal_counterfactual_fields
            ),
            "required_rejected_signal_outcome_persistence_state": self.required_rejected_signal_outcome_persistence_state,
            "require_order_type_execution_quality": self.require_order_type_execution_quality,
            "min_order_type_ablation_sample_count": self.min_order_type_ablation_sample_count,
            "max_order_type_opportunity_cost_bps": str(
                self.max_order_type_opportunity_cost_bps
            ),
            "max_market_order_spread_bps": str(self.max_market_order_spread_bps),
            "require_mpc_dynamic_execution_schedule": self.require_mpc_dynamic_execution_schedule,
            "min_mpc_schedule_trace_sample_count": self.min_mpc_schedule_trace_sample_count,
            "max_mpc_schedule_shortfall_bps": str(self.max_mpc_schedule_shortfall_bps),
        }
