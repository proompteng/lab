from __future__ import annotations

# pyright: reportMissingImports=false, reportMissingTypeStubs=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportUnnecessaryCast=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast
from app.trading.runtime_ledger import POST_COST_PNL_BASIS

PROFIT_TARGET_ORACLE_SCHEMA_VERSION: Any
_ACCEPTED_LEDGER_PNL_BASES: Any
_ACCEPTED_LEDGER_PNL_SOURCES: Any
_ACCEPTED_MARKET_IMPACT_STRESS_MODELS: Any
_ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS: Any
_POST_COST_EXPECTANCY_BPS_KEYS: Any
_AVG_FILLED_NOTIONAL_PER_DAY_KEYS: Any

class ProfitTargetOraclePolicy:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    min_active_day_ratio: Decimal
    min_positive_day_ratio: Decimal
    min_profit_factor: Decimal
    min_daily_net_pnl: Decimal
    max_best_day_share: Decimal
    max_cluster_contribution_share: Decimal
    max_single_symbol_contribution_share: Decimal
    max_worst_day_loss: Decimal
    max_drawdown: Decimal
    default_start_equity: Decimal
    max_worst_day_loss_pct_equity: Decimal
    max_drawdown_pct_equity: Decimal
    extended_max_worst_day_loss_pct_equity: Decimal
    extended_max_drawdown_pct_equity: Decimal
    min_total_net_pnl_to_drawdown_ratio: Decimal
    max_gross_exposure_pct_equity: Decimal
    min_cash: Decimal
    max_negative_cash_observation_count: int
    min_avg_filled_notional_per_day: Decimal
    min_observed_trading_days: int
    min_regime_slice_pass_rate: Decimal
    min_posterior_edge_lower: Decimal
    require_shadow_parity_within_budget: bool
    require_executable_replay: bool
    min_executable_order_count: int
    require_executable_replay_notional_within_buying_power: bool
    require_exact_replay_ledger: bool
    min_exact_replay_ledger_row_count: int
    min_exact_replay_ledger_fill_count: int
    require_market_impact_stress: bool
    min_market_impact_stress_cost_bps: Decimal
    require_market_impact_liquidity_evidence: bool
    require_delay_adjusted_depth_stress: bool
    require_delay_adjusted_depth_liquidity_evidence: bool
    require_delay_adjusted_depth_latency_grid: bool
    require_delay_adjusted_depth_tail_coverage: bool
    min_delay_adjusted_depth_stress_ms: Decimal
    min_delay_adjusted_depth_grid_max_stress_ms: Decimal
    min_delay_adjusted_depth_fillable_notional_per_day: Decimal
    min_delay_adjusted_depth_tail_fillable_notional: Decimal
    require_fill_survival_evidence: bool
    require_queue_position_survival_evidence: bool
    require_queue_ahead_depletion_evidence: bool
    min_queue_ahead_depletion_sample_count: int
    min_fill_survival_sample_count: int
    min_fill_survival_rate: Decimal
    require_implementation_uncertainty_stability: bool
    min_implementation_uncertainty_model_count: int
    require_conformal_tail_risk: bool
    min_conformal_tail_risk_sample_count: int
    require_predictability_decay_stress: bool
    min_predictability_decay_stress_horizon_count: int
    min_tight_spread_regime_count: int
    min_predictability_decay_stress_split_pass_rate: Decimal
    max_predictability_decay_stress_best_split_share: Decimal
    require_double_oos: bool
    min_double_oos_independent_window_count: int
    min_double_oos_pass_rate: Decimal
    max_missing_sleeve_daily_net_count: int
    max_validation_contract_pending_count: int
    max_validation_live_paper_parity_pending_count: int
    max_synthetic_evidence_not_promotion_proof_count: int
    require_rejected_signal_outcome_learning: bool
    min_rejected_signal_outcome_label_count: int
    min_rejected_signal_reason_coverage: Decimal
    max_rejected_signal_outcome_pending_ratio: Decimal
    required_rejected_signal_counterfactual_fields: tuple[str, ...]
    required_rejected_signal_outcome_persistence_state: str
    require_order_type_execution_quality: bool
    min_order_type_ablation_sample_count: int
    max_order_type_opportunity_cost_bps: Decimal
    max_market_order_spread_bps: Decimal
    require_mpc_dynamic_execution_schedule: bool
    min_mpc_schedule_trace_sample_count: int
    max_mpc_schedule_shortfall_bps: Decimal
    def to_payload(*args: Any, **kwargs: Any) -> Any: ...

def _decimal(*args: Any, **kwargs: Any) -> Any: ...
def _nonnegative_int(*args: Any, **kwargs: Any) -> Any: ...
def _boolish(*args: Any, **kwargs: Any) -> Any: ...
def _string(*args: Any, **kwargs: Any) -> Any: ...
def _first_normalized_scorecard_text(*args: Any, **kwargs: Any) -> Any: ...
def _numeric_check(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_payload(*args: Any, **kwargs: Any) -> Any: ...
def _first_positive_decimal(*args: Any, **kwargs: Any) -> Any: ...
def _first_decimal_or_none(*args: Any, **kwargs: Any) -> Any: ...
def _target_implied_notional_gate_payload(*args: Any, **kwargs: Any) -> Any: ...
def _artifact_refs(*args: Any, **kwargs: Any) -> Any: ...
def _string_sequence(*args: Any, **kwargs: Any) -> Any: ...
def _requires_rejected_signal_outcome_learning(*args: Any, **kwargs: Any) -> Any: ...
def _requires_order_type_execution_quality(*args: Any, **kwargs: Any) -> Any: ...
def _requires_mpc_dynamic_execution_schedule(*args: Any, **kwargs: Any) -> Any: ...
def _requires_implementation_uncertainty_stability(
    *args: Any, **kwargs: Any
) -> Any: ...
def _requires_conformal_tail_risk(*args: Any, **kwargs: Any) -> Any: ...
def _requires_predictability_decay_stress(*args: Any, **kwargs: Any) -> Any: ...
def _start_equity(*args: Any, **kwargs: Any) -> Any: ...
def _total_net_pnl(*args: Any, **kwargs: Any) -> Any: ...
def _profit_factor(*args: Any, **kwargs: Any) -> Any: ...
def _risk_adjusted_drawdown_check(*args: Any, **kwargs: Any) -> Any: ...
def evaluate_profit_target_oracle(*args: Any, **kwargs: Any) -> Any: ...
