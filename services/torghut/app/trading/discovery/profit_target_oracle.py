"""Oracle-style objective gate for doc 71 whitepaper autoresearch candidates."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.runtime_ledger import POST_COST_PNL_BASIS


PROFIT_TARGET_ORACLE_SCHEMA_VERSION = "torghut.profit-target-oracle.v1"
_ACCEPTED_LEDGER_PNL_BASES = frozenset({POST_COST_PNL_BASIS})
_ACCEPTED_LEDGER_PNL_SOURCES = frozenset(
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
_ACCEPTED_MARKET_IMPACT_STRESS_MODELS = frozenset(
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
_ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS = frozenset(
    {
        "latency_depth_haircut",
        "delay_depth_haircut",
        "portfolio_latency_depth_haircut",
    }
)
_POST_COST_EXPECTANCY_BPS_KEYS = (
    "observed_post_cost_expectancy_bps",
    "post_cost_expectancy_bps",
    "portfolio_post_cost_expectancy_bps",
    "realized_post_cost_expectancy_bps",
)
_AVG_FILLED_NOTIONAL_PER_DAY_KEYS = (
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
                _ACCEPTED_MARKET_IMPACT_STRESS_MODELS
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
                _ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS
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


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _nonnegative_int(value: Any, *, default: int = 0) -> int:
    try:
        return max(0, int(Decimal(str(value if value is not None else default))))
    except Exception:
        return default


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value if value is not None else "").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
        "passed",
    }


def _string(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _first_normalized_scorecard_text(scorecard: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        normalized = _string(scorecard.get(key)).lower()
        if normalized:
            return normalized
    return ""


def _numeric_check(
    *,
    metric: str,
    observed: Decimal,
    operator: str,
    threshold: Decimal,
) -> dict[str, Any]:
    if operator == "gte":
        passed = observed >= threshold
    elif operator == "lte":
        passed = observed <= threshold
    elif operator == "gt":
        passed = observed > threshold
    else:
        raise ValueError(f"oracle_operator_unsupported:{operator}")
    return {
        "metric": metric,
        "observed": str(observed),
        "operator": operator,
        "threshold": str(threshold),
        "passed": passed,
    }


def _decimal_payload(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value, "f")


def _first_positive_decimal(
    scorecard: Mapping[str, Any], keys: tuple[str, ...]
) -> tuple[Decimal, str]:
    for key in keys:
        value = _decimal(scorecard.get(key))
        if value > 0:
            return value, key
    return Decimal("0"), ""


def _first_decimal_or_none(
    scorecard: Mapping[str, Any], keys: tuple[str, ...]
) -> tuple[Decimal | None, str]:
    for key in keys:
        raw_value = scorecard.get(key)
        if raw_value is None or (isinstance(raw_value, str) and not raw_value.strip()):
            continue
        return _decimal(raw_value), key
    return None, ""


def _target_implied_notional_gate_payload(
    *,
    scorecard: Mapping[str, Any],
    target_net_pnl_per_day: Decimal,
    baseline_min_avg_filled_notional_per_day: Decimal,
    post_cost_net_pnl_per_day: Decimal,
    post_cost_pnl_basis: str,
    post_cost_pnl_source: str,
) -> dict[str, Any]:
    avg_filled_notional_per_day, avg_filled_notional_source = _first_positive_decimal(
        scorecard, _AVG_FILLED_NOTIONAL_PER_DAY_KEYS
    )
    explicit_expectancy_bps, explicit_expectancy_source = _first_decimal_or_none(
        scorecard, _POST_COST_EXPECTANCY_BPS_KEYS
    )
    blockers: list[str] = []
    post_cost_basis_ok = post_cost_pnl_basis in _ACCEPTED_LEDGER_PNL_BASES
    post_cost_source_ok = post_cost_pnl_source in _ACCEPTED_LEDGER_PNL_SOURCES
    if not post_cost_basis_ok:
        blockers.append("target_implied_post_cost_pnl_basis_missing_or_unsupported")
    if not post_cost_source_ok:
        blockers.append("target_implied_post_cost_pnl_source_missing_or_unsupported")
    if avg_filled_notional_per_day <= 0:
        blockers.append(
            "target_implied_avg_filled_notional_per_day_missing_or_non_positive"
        )

    observed_expectancy_bps: Decimal | None = None
    observed_expectancy_source = ""
    if post_cost_basis_ok and post_cost_source_ok and avg_filled_notional_per_day > 0:
        if explicit_expectancy_bps is not None:
            observed_expectancy_bps = explicit_expectancy_bps
            observed_expectancy_source = explicit_expectancy_source
        elif post_cost_net_pnl_per_day > 0:
            observed_expectancy_bps = (
                post_cost_net_pnl_per_day
                / avg_filled_notional_per_day
                * Decimal("10000")
            )
            observed_expectancy_source = (
                "derived_from_post_cost_net_pnl_per_day_and_avg_filled_notional_per_day"
            )

    if observed_expectancy_bps is None or observed_expectancy_bps <= 0:
        blockers.append(
            "target_implied_post_cost_expectancy_bps_missing_or_non_positive"
        )

    target_implied_min_avg_filled_notional_per_day: Decimal | None = None
    if observed_expectancy_bps is not None and observed_expectancy_bps > 0:
        target_implied_min_avg_filled_notional_per_day = (
            target_net_pnl_per_day * Decimal("10000") / observed_expectancy_bps
        )
    effective_min_avg_filled_notional_per_day = baseline_min_avg_filled_notional_per_day
    if target_implied_min_avg_filled_notional_per_day is not None:
        effective_min_avg_filled_notional_per_day = max(
            baseline_min_avg_filled_notional_per_day,
            target_implied_min_avg_filled_notional_per_day,
        )

    return {
        "target_daily_net_pnl": _decimal_payload(target_net_pnl_per_day),
        "post_cost_net_pnl_per_day": _decimal_payload(post_cost_net_pnl_per_day),
        "post_cost_pnl_basis": post_cost_pnl_basis,
        "post_cost_pnl_source": post_cost_pnl_source,
        "post_cost_basis_accepted": post_cost_basis_ok,
        "post_cost_source_accepted": post_cost_source_ok,
        "avg_filled_notional_per_day": _decimal_payload(avg_filled_notional_per_day),
        "avg_filled_notional_per_day_source": avg_filled_notional_source,
        "observed_post_cost_expectancy_bps": _decimal_payload(observed_expectancy_bps),
        "observed_post_cost_expectancy_bps_source": observed_expectancy_source,
        "baseline_min_avg_filled_notional_per_day": _decimal_payload(
            baseline_min_avg_filled_notional_per_day
        ),
        "target_implied_min_avg_filled_notional_per_day": _decimal_payload(
            target_implied_min_avg_filled_notional_per_day
        ),
        "effective_min_avg_filled_notional_per_day": _decimal_payload(
            effective_min_avg_filled_notional_per_day
        ),
        "target_implied_min_notional_formula": (
            "target_daily_net_pnl / (observed_post_cost_expectancy_bps / 10000)"
        ),
        "blockers": blockers,
    }


def _artifact_refs(scorecard: Mapping[str, Any], *keys: str) -> list[str]:
    refs: list[str] = []
    for key in keys:
        raw_value = scorecard.get(key)
        if isinstance(raw_value, list):
            for item in cast(list[Any], raw_value):
                normalized = _string(item)
                if normalized:
                    refs.append(normalized)
            continue
        normalized = _string(raw_value)
        if normalized:
            refs.append(normalized)
    return refs


def _string_sequence(value: Any) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [
            normalized
            for item in cast(Sequence[Any], value)
            if (normalized := _string(item))
        ]
    raw_value = _string(value)
    if not raw_value:
        return []
    if "," in raw_value:
        return [item.strip() for item in raw_value.split(",") if item.strip()]
    return [raw_value]


def _requires_rejected_signal_outcome_learning(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_rejected_signal_outcome_learning:
        return True
    if _boolish(
        scorecard.get("requires_rejected_signal_outcome_learning")
        or scorecard.get("rejected_signal_outcome_learning_required")
        or scorecard.get("requires_rejected_signal_outcome_calibration")
        or scorecard.get("rejected_signal_outcome_calibration_required")
    ):
        return True
    overlay_ids = set(
        _string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return "rejected_signal_outcome_calibration" in overlay_ids


def _requires_order_type_execution_quality(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_order_type_execution_quality:
        return True
    if _boolish(
        scorecard.get("requires_order_type_execution_quality")
        or scorecard.get("order_type_execution_quality_required")
        or scorecard.get("requires_order_type_ablation")
        or scorecard.get("requires_market_limit_order_mix")
        or scorecard.get("market_limit_order_mix_required")
    ):
        return True
    overlay_ids = set(
        _string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return "mixed_market_limit_execution_policy" in overlay_ids


def _requires_mpc_dynamic_execution_schedule(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_mpc_dynamic_execution_schedule:
        return True
    if _boolish(
        scorecard.get("requires_mpc_dynamic_execution_schedule")
        or scorecard.get("required_mpc_dynamic_execution_schedule")
        or scorecard.get("requires_dynamic_execution_schedule")
    ):
        return True
    overlay_ids = set(
        _string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return "mpc_dynamic_execution_schedule" in overlay_ids


def _requires_implementation_uncertainty_stability(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_implementation_uncertainty_stability:
        return True
    if _boolish(
        scorecard.get("implementation_uncertainty_required")
        or scorecard.get("requires_implementation_uncertainty_stability")
        or scorecard.get("requires_implementation_risk_backtest_stability")
    ):
        return True
    overlay_ids = set(
        _string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return bool(
        {
            "execution_reality_gap_stability",
            "implementation_risk_backtest_stability",
            "order_flow_impact_stability",
        }
        & overlay_ids
    )


def _requires_conformal_tail_risk(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_conformal_tail_risk:
        return True
    if _boolish(
        scorecard.get("conformal_tail_risk_required")
        or scorecard.get("requires_conformal_tail_risk")
        or scorecard.get("requires_conformal_var_cost_buffer")
    ):
        return True
    overlay_ids = set(
        _string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return bool(
        {
            "conformal_tail_risk",
            "conformal_var_cost_buffer",
            "regime_weighted_conformal_var",
        }
        & overlay_ids
    )


def _requires_predictability_decay_stress(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> bool:
    if policy.require_predictability_decay_stress:
        return True
    if _boolish(
        scorecard.get("predictability_decay_stress_required")
        or scorecard.get("requires_predictability_decay_stress")
        or scorecard.get("requires_horizon_decay_curve")
        or scorecard.get("requires_spread_adjusted_label_replay")
    ):
        return True
    overlay_ids = set(
        _string_sequence(
            scorecard.get("mechanism_overlay_ids")
            or scorecard.get("mechanism_overlays")
            or scorecard.get("overlay_ids")
        )
    )
    return "alpha_decay_predictability_stress" in overlay_ids


def _start_equity(
    scorecard: Mapping[str, Any], policy: ProfitTargetOraclePolicy
) -> Decimal:
    for key in (
        "start_equity",
        "account_start_equity",
        "execution_start_equity",
        "executable_replay_start_equity",
        "runtime_start_equity",
    ):
        value = _decimal(scorecard.get(key))
        if value > 0:
            return value
    return policy.default_start_equity


def _total_net_pnl(
    *,
    daily_net: Mapping[str, Any] | None,
    net_pnl_per_day: Decimal,
    trading_day_count: int,
) -> Decimal:
    if daily_net:
        return sum((_decimal(value) for value in daily_net.values()), Decimal("0"))
    return net_pnl_per_day * Decimal(max(1, trading_day_count))


def _profit_factor(
    scorecard: Mapping[str, Any],
    *,
    daily_net: Mapping[str, Any] | None,
    total_net_pnl: Decimal,
    worst_day_loss: Decimal,
) -> Decimal:
    explicit = scorecard.get("profit_factor")
    if explicit is not None:
        return _decimal(explicit)
    if daily_net:
        positive_total = sum(
            (_decimal(value) for value in daily_net.values() if _decimal(value) > 0),
            Decimal("0"),
        )
        negative_total = sum(
            (-_decimal(value) for value in daily_net.values() if _decimal(value) < 0),
            Decimal("0"),
        )
        if negative_total > 0:
            return positive_total / negative_total
        return Decimal("999999999") if positive_total > 0 else Decimal("0")
    if worst_day_loss <= 0 and total_net_pnl > 0:
        return Decimal("999999999")
    return Decimal("0")


def _risk_adjusted_drawdown_check(
    *,
    metric: str,
    observed: Decimal,
    start_equity: Decimal,
    normal_pct: Decimal,
    extended_pct: Decimal,
    total_net_pnl: Decimal,
    min_total_net_pnl_to_drawdown_ratio: Decimal,
    absolute_cap: Decimal,
) -> dict[str, Any]:
    normal_limit = max(Decimal("0"), start_equity * normal_pct)
    extended_limit = max(normal_limit, start_equity * extended_pct)
    absolute_limit = (
        extended_limit if absolute_cap <= 0 else min(absolute_cap, extended_limit)
    )
    ratio = Decimal("999999999") if observed <= 0 else total_net_pnl / observed
    if observed <= normal_limit:
        passed = True
        mode = "normal_pct"
    elif observed <= absolute_limit and observed > 0:
        passed = ratio >= min_total_net_pnl_to_drawdown_ratio
        mode = "return_adjusted"
    else:
        passed = observed <= absolute_limit
        mode = "hard_cap"
    return {
        "metric": metric,
        "observed": str(observed),
        "operator": "risk_adjusted_lte",
        "threshold": str(normal_limit),
        "extended_threshold": str(absolute_limit),
        "start_equity": str(start_equity),
        "normal_pct_equity": str(normal_pct),
        "extended_pct_equity": str(extended_pct),
        "total_net_pnl_to_drawdown_ratio": str(ratio),
        "min_total_net_pnl_to_drawdown_ratio": str(min_total_net_pnl_to_drawdown_ratio),
        "mode": mode,
        "passed": passed,
    }


def evaluate_profit_target_oracle(
    scorecard: Mapping[str, Any],
    *,
    target_net_pnl_per_day: Decimal = Decimal("300"),
    policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Any]:
    """Evaluate the doc 71 production objective criteria against a scorecard."""

    policy = policy or ProfitTargetOraclePolicy()
    net_pnl = _decimal(
        scorecard.get("portfolio_post_cost_net_pnl_per_day")
        or scorecard.get("net_pnl_per_day")
    )
    daily_net_payload = scorecard.get("daily_net")
    if isinstance(daily_net_payload, Mapping) and daily_net_payload:
        daily_net = cast(Mapping[str, Any], daily_net_payload)
        min_daily_net_pnl = min(_decimal(value) for value in daily_net.values())
        daily_net_observed_day_count = len(daily_net)
    else:
        daily_net = None
        min_daily_net_pnl = Decimal("0")
        daily_net_observed_day_count = 0
    trading_day_count = _nonnegative_int(
        scorecard.get("trading_day_count"),
        default=daily_net_observed_day_count,
    )
    if trading_day_count < daily_net_observed_day_count:
        trading_day_count = daily_net_observed_day_count
    if (
        policy.min_daily_net_pnl > 0
        and daily_net_observed_day_count < trading_day_count
    ):
        min_daily_net_pnl = min(min_daily_net_pnl, Decimal("0"))
    start_equity = _start_equity(scorecard, policy)
    total_net_pnl = _total_net_pnl(
        daily_net=daily_net,
        net_pnl_per_day=net_pnl,
        trading_day_count=trading_day_count,
    )
    worst_day_loss = _decimal(scorecard.get("worst_day_loss"))
    profit_factor = _profit_factor(
        scorecard,
        daily_net=daily_net,
        total_net_pnl=total_net_pnl,
        worst_day_loss=worst_day_loss,
    )
    portfolio_post_cost_net_pnl_basis = _first_normalized_scorecard_text(
        scorecard,
        "portfolio_post_cost_net_pnl_basis",
        "portfolio_post_cost_net_pnl_per_day_basis",
        "post_cost_net_pnl_basis",
        "net_pnl_basis",
        "runtime_ledger_pnl_basis",
        "exact_replay_ledger_pnl_basis",
        "post_cost_expectancy_basis",
        "pnl_basis",
    )
    portfolio_post_cost_net_pnl_source = _first_normalized_scorecard_text(
        scorecard,
        "portfolio_post_cost_net_pnl_source",
        "portfolio_post_cost_net_pnl_per_day_source",
        "post_cost_net_pnl_source",
        "net_pnl_source",
        "runtime_ledger_pnl_source",
        "exact_replay_ledger_pnl_source",
        "post_cost_expectancy_source",
        "pnl_source",
    )
    target_implied_notional_gate = _target_implied_notional_gate_payload(
        scorecard=scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        baseline_min_avg_filled_notional_per_day=policy.min_avg_filled_notional_per_day,
        post_cost_net_pnl_per_day=net_pnl,
        post_cost_pnl_basis=portfolio_post_cost_net_pnl_basis,
        post_cost_pnl_source=portfolio_post_cost_net_pnl_source,
    )
    effective_min_avg_filled_notional_per_day = _decimal(
        target_implied_notional_gate.get("effective_min_avg_filled_notional_per_day"),
        default=str(policy.min_avg_filled_notional_per_day),
    )
    observed_post_cost_expectancy_bps = _decimal(
        target_implied_notional_gate.get("observed_post_cost_expectancy_bps")
    )
    checks = [
        _numeric_check(
            metric="portfolio_post_cost_net_pnl_per_day",
            observed=net_pnl,
            operator="gte",
            threshold=target_net_pnl_per_day,
        ),
        _numeric_check(
            metric="active_day_ratio",
            observed=_decimal(scorecard.get("active_day_ratio")),
            operator="gte",
            threshold=policy.min_active_day_ratio,
        ),
        _numeric_check(
            metric="positive_day_ratio",
            observed=_decimal(scorecard.get("positive_day_ratio")),
            operator="gte",
            threshold=policy.min_positive_day_ratio,
        ),
        _numeric_check(
            metric="profit_factor",
            observed=profit_factor,
            operator="gte",
            threshold=policy.min_profit_factor,
        ),
        _numeric_check(
            metric="min_daily_net_pnl",
            observed=min_daily_net_pnl,
            operator="gte",
            threshold=policy.min_daily_net_pnl,
        ),
        _numeric_check(
            metric="daily_net_observed_day_count",
            observed=Decimal(daily_net_observed_day_count),
            operator="gte",
            threshold=Decimal(trading_day_count),
        ),
        _numeric_check(
            metric="min_observed_trading_days",
            observed=Decimal(daily_net_observed_day_count),
            operator="gte",
            threshold=Decimal(max(0, policy.min_observed_trading_days)),
        ),
        _numeric_check(
            metric="missing_sleeve_daily_net_count",
            observed=Decimal(
                _nonnegative_int(scorecard.get("missing_sleeve_daily_net_count"))
            ),
            operator="lte",
            threshold=Decimal(max(0, policy.max_missing_sleeve_daily_net_count)),
        ),
        _numeric_check(
            metric="validation_contract_pending_count",
            observed=Decimal(
                _nonnegative_int(scorecard.get("validation_contract_pending_count"))
            ),
            operator="lte",
            threshold=Decimal(max(0, policy.max_validation_contract_pending_count)),
        ),
        _numeric_check(
            metric="validation_live_paper_parity_pending_count",
            observed=Decimal(
                _nonnegative_int(
                    scorecard.get("validation_live_paper_parity_pending_count")
                )
            ),
            operator="lte",
            threshold=Decimal(
                max(0, policy.max_validation_live_paper_parity_pending_count)
            ),
        ),
        _numeric_check(
            metric="synthetic_evidence_not_promotion_proof_count",
            observed=Decimal(
                _nonnegative_int(
                    scorecard.get("synthetic_evidence_not_promotion_proof_count")
                )
            ),
            operator="lte",
            threshold=Decimal(
                max(0, policy.max_synthetic_evidence_not_promotion_proof_count)
            ),
        ),
        _numeric_check(
            metric="best_day_share",
            observed=_decimal(scorecard.get("best_day_share")),
            operator="lte",
            threshold=policy.max_best_day_share,
        ),
        _numeric_check(
            metric="max_single_day_contribution_share",
            observed=_decimal(
                scorecard.get("max_single_day_contribution_share")
                or scorecard.get("best_day_share")
            ),
            operator="lte",
            threshold=policy.max_best_day_share,
        ),
        _numeric_check(
            metric="max_cluster_contribution_share",
            observed=_decimal(
                scorecard.get("max_cluster_contribution_share"), default="1"
            ),
            operator="lte",
            threshold=policy.max_cluster_contribution_share,
        ),
        _numeric_check(
            metric="max_single_symbol_contribution_share",
            observed=_decimal(
                scorecard.get("max_single_symbol_contribution_share"), default="1"
            ),
            operator="lte",
            threshold=policy.max_single_symbol_contribution_share,
        ),
        _risk_adjusted_drawdown_check(
            metric="worst_day_loss",
            observed=worst_day_loss,
            start_equity=start_equity,
            normal_pct=policy.max_worst_day_loss_pct_equity,
            extended_pct=policy.extended_max_worst_day_loss_pct_equity,
            total_net_pnl=total_net_pnl,
            min_total_net_pnl_to_drawdown_ratio=policy.min_total_net_pnl_to_drawdown_ratio,
            absolute_cap=policy.max_worst_day_loss,
        ),
        _risk_adjusted_drawdown_check(
            metric="max_drawdown",
            observed=_decimal(scorecard.get("max_drawdown")),
            start_equity=start_equity,
            normal_pct=policy.max_drawdown_pct_equity,
            extended_pct=policy.extended_max_drawdown_pct_equity,
            total_net_pnl=total_net_pnl,
            min_total_net_pnl_to_drawdown_ratio=policy.min_total_net_pnl_to_drawdown_ratio,
            absolute_cap=policy.max_drawdown,
        ),
        _numeric_check(
            metric="max_gross_exposure_pct_equity",
            observed=_decimal(scorecard.get("max_gross_exposure_pct_equity")),
            operator="lte",
            threshold=policy.max_gross_exposure_pct_equity,
        ),
        _numeric_check(
            metric="min_cash",
            observed=_decimal(scorecard.get("min_cash"), default=str(policy.min_cash)),
            operator="gte",
            threshold=policy.min_cash,
        ),
        _numeric_check(
            metric="negative_cash_observation_count",
            observed=Decimal(
                _nonnegative_int(scorecard.get("negative_cash_observation_count"))
            ),
            operator="lte",
            threshold=Decimal(max(0, policy.max_negative_cash_observation_count)),
        ),
        _numeric_check(
            metric="avg_filled_notional_per_day",
            observed=_decimal(scorecard.get("avg_filled_notional_per_day")),
            operator="gte",
            threshold=effective_min_avg_filled_notional_per_day,
        ),
        {
            "metric": "target_implied_post_cost_pnl_basis",
            "observed": target_implied_notional_gate["post_cost_pnl_basis"],
            "operator": "in",
            "threshold": sorted(_ACCEPTED_LEDGER_PNL_BASES),
            "source_marker": "target_implied_discovery_notional_gate",
            "passed": bool(target_implied_notional_gate["post_cost_basis_accepted"]),
        },
        {
            "metric": "target_implied_post_cost_pnl_source",
            "observed": target_implied_notional_gate["post_cost_pnl_source"],
            "operator": "in",
            "threshold": sorted(_ACCEPTED_LEDGER_PNL_SOURCES),
            "source_marker": "target_implied_discovery_notional_gate",
            "passed": bool(target_implied_notional_gate["post_cost_source_accepted"]),
        },
        _numeric_check(
            metric="target_implied_avg_filled_notional_per_day",
            observed=_decimal(
                target_implied_notional_gate.get("avg_filled_notional_per_day")
            ),
            operator="gt",
            threshold=Decimal("0"),
        ),
        _numeric_check(
            metric="target_implied_post_cost_expectancy_bps",
            observed=observed_post_cost_expectancy_bps,
            operator="gt",
            threshold=Decimal("0"),
        ),
        _numeric_check(
            metric="regime_slice_pass_rate",
            observed=_decimal(scorecard.get("regime_slice_pass_rate")),
            operator="gte",
            threshold=policy.min_regime_slice_pass_rate,
        ),
        _numeric_check(
            metric="posterior_edge_lower",
            observed=_decimal(scorecard.get("posterior_edge_lower")),
            operator="gt",
            threshold=policy.min_posterior_edge_lower,
        ),
    ]
    shadow_parity_status = str(scorecard.get("shadow_parity_status") or "").strip()
    checks.append(
        {
            "metric": "shadow_parity_status",
            "observed": shadow_parity_status,
            "operator": "eq",
            "threshold": "within_budget",
            "passed": (shadow_parity_status == "within_budget")
            if policy.require_shadow_parity_within_budget
            else True,
        }
    )
    raw_executable_artifact_refs = scorecard.get("executable_replay_artifact_refs")
    executable_artifact_refs: list[str] = []
    if isinstance(raw_executable_artifact_refs, list):
        for item in cast(list[Any], raw_executable_artifact_refs):
            normalized_ref = str(item).strip()
            if normalized_ref:
                executable_artifact_refs.append(normalized_ref)
    executable_artifact_ref = str(
        scorecard.get("executable_replay_artifact_ref") or ""
    ).strip()
    executable_artifact_present = bool(
        executable_artifact_ref or executable_artifact_refs
    )
    executable_passed = _boolish(scorecard.get("executable_replay_passed"))
    executable_order_count = _nonnegative_int(
        scorecard.get("executable_replay_order_count")
        or scorecard.get("executable_replay_submitted_order_count")
        or scorecard.get("executable_replay_orders_submitted_total")
    )
    executable_buying_power = _decimal(
        scorecard.get("executable_replay_account_buying_power")
        or scorecard.get("executable_replay_buying_power")
    )
    executable_max_notional = _decimal(
        scorecard.get("executable_replay_max_notional_per_trade")
        or scorecard.get("executable_replay_max_notional_per_order")
    )
    checks.append(
        {
            "metric": "executable_replay_passed",
            "observed": str(executable_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "passed": executable_passed if policy.require_executable_replay else True,
        }
    )
    checks.append(
        {
            "metric": "executable_replay_artifact_present",
            "observed": str(executable_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "passed": executable_artifact_present
            if policy.require_executable_replay
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="executable_replay_order_count",
            observed=Decimal(executable_order_count),
            operator="gte",
            threshold=Decimal(max(0, policy.min_executable_order_count))
            if policy.require_executable_replay
            else Decimal("0"),
        )
    )
    if policy.require_executable_replay_notional_within_buying_power:
        checks.append(
            _numeric_check(
                metric="executable_replay_account_buying_power",
                observed=executable_buying_power,
                operator="gt",
                threshold=Decimal("0"),
            )
        )
        checks.append(
            _numeric_check(
                metric="executable_replay_max_notional_per_trade",
                observed=executable_max_notional,
                operator="gt",
                threshold=Decimal("0"),
            )
        )
        checks.append(
            _numeric_check(
                metric="executable_replay_notional_within_buying_power",
                observed=executable_max_notional,
                operator="lte",
                threshold=executable_buying_power,
            )
        )
    exact_replay_ledger_artifact_refs = _artifact_refs(
        scorecard,
        "exact_replay_ledger_artifact_ref",
        "exact_replay_ledger_artifact_refs",
    )
    exact_replay_ledger_artifact_present = bool(exact_replay_ledger_artifact_refs)
    exact_replay_ledger_row_count = _nonnegative_int(
        scorecard.get("exact_replay_ledger_artifact_row_count")
    )
    exact_replay_ledger_fill_count = _nonnegative_int(
        scorecard.get("exact_replay_ledger_artifact_fill_count")
    )
    checks.extend(
        (
            {
                "metric": "exact_replay_ledger_artifact_present",
                "observed": str(exact_replay_ledger_artifact_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "exact_replay_ledger_probation_gate",
                "passed": exact_replay_ledger_artifact_present
                if policy.require_exact_replay_ledger
                else True,
            },
            _numeric_check(
                metric="exact_replay_ledger_artifact_row_count",
                observed=Decimal(exact_replay_ledger_row_count),
                operator="gte",
                threshold=Decimal(max(0, policy.min_exact_replay_ledger_row_count))
                if policy.require_exact_replay_ledger
                else Decimal("0"),
            ),
            _numeric_check(
                metric="exact_replay_ledger_artifact_fill_count",
                observed=Decimal(exact_replay_ledger_fill_count),
                operator="gte",
                threshold=Decimal(max(0, policy.min_exact_replay_ledger_fill_count))
                if policy.require_exact_replay_ledger
                else Decimal("0"),
            ),
            {
                "metric": "portfolio_post_cost_net_pnl_basis",
                "observed": portfolio_post_cost_net_pnl_basis,
                "operator": "in",
                "threshold": sorted(_ACCEPTED_LEDGER_PNL_BASES),
                "source_marker": "exact_replay_ledger_probation_gate",
                "passed": (
                    portfolio_post_cost_net_pnl_basis in _ACCEPTED_LEDGER_PNL_BASES
                )
                if policy.require_exact_replay_ledger
                else True,
            },
            {
                "metric": "portfolio_post_cost_net_pnl_source",
                "observed": portfolio_post_cost_net_pnl_source,
                "operator": "in",
                "threshold": sorted(_ACCEPTED_LEDGER_PNL_SOURCES),
                "source_marker": "exact_replay_ledger_probation_gate",
                "passed": (
                    portfolio_post_cost_net_pnl_source in _ACCEPTED_LEDGER_PNL_SOURCES
                )
                if policy.require_exact_replay_ledger
                else True,
            },
        )
    )
    market_impact_artifact_refs = _artifact_refs(
        scorecard,
        "market_impact_stress_artifact_ref",
        "market_impact_stress_artifact_refs",
        "impact_stress_artifact_ref",
        "cost_shock_artifact_ref",
    )
    market_impact_artifact_present = bool(market_impact_artifact_refs)
    market_impact_passed = _boolish(
        scorecard.get("market_impact_stress_passed")
        or scorecard.get("cost_shock_stress_passed")
        or scorecard.get("nonlinear_market_impact_stress_passed")
    )
    market_impact_model = _string(
        scorecard.get("market_impact_stress_model")
        or scorecard.get("market_impact_cost_model")
        or scorecard.get("cost_shock_model")
    ).lower()
    checks.append(
        {
            "metric": "market_impact_stress_passed",
            "observed": str(market_impact_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
            "passed": market_impact_passed
            if policy.require_market_impact_stress
            else True,
        }
    )
    checks.append(
        {
            "metric": "market_impact_stress_artifact_present",
            "observed": str(market_impact_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
            "passed": market_impact_artifact_present
            if policy.require_market_impact_stress
            else True,
        }
    )
    market_impact_liquidity_evidence_present = _boolish(
        scorecard.get("market_impact_liquidity_evidence_present")
        or scorecard.get("liquidity_evidence_present")
    )
    checks.append(
        {
            "metric": "market_impact_liquidity_evidence_present",
            "observed": str(market_impact_liquidity_evidence_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
            "passed": market_impact_liquidity_evidence_present
            if (
                policy.require_market_impact_stress
                and policy.require_market_impact_liquidity_evidence
            )
            else True,
        }
    )
    checks.append(
        {
            "metric": "market_impact_stress_model",
            "observed": market_impact_model,
            "operator": "in",
            "threshold": sorted(_ACCEPTED_MARKET_IMPACT_STRESS_MODELS),
            "source_marker": "order_flow_market_impact_arxiv_2601_23172_2026",
            "passed": (market_impact_model in _ACCEPTED_MARKET_IMPACT_STRESS_MODELS)
            if policy.require_market_impact_stress
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="market_impact_stress_cost_bps",
            observed=_decimal(
                scorecard.get("market_impact_stress_cost_bps")
                or scorecard.get("market_impact_cost_bps")
                or scorecard.get("cost_shock_bps")
            ),
            operator="gte",
            threshold=policy.min_market_impact_stress_cost_bps
            if policy.require_market_impact_stress
            else Decimal("0"),
        )
    )
    market_impact_net_pnl = _decimal(
        scorecard.get("market_impact_stress_net_pnl_per_day")
        or scorecard.get("post_impact_net_pnl_per_day")
        or scorecard.get("cost_shock_net_pnl_per_day")
    )
    market_impact_net_check = _numeric_check(
        metric="market_impact_stress_net_pnl_per_day",
        observed=market_impact_net_pnl,
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_market_impact_stress:
        market_impact_net_check["passed"] = True
    checks.append(
        {
            **market_impact_net_check,
            "source_marker": "double_oos_cost_sensitivity_arxiv_2602_10785_2026",
        }
    )
    delay_depth_artifact_refs = _artifact_refs(
        scorecard,
        "delay_adjusted_depth_stress_artifact_ref",
        "delay_adjusted_depth_stress_artifact_refs",
        "delay_depth_stress_artifact_ref",
        "latency_depth_stress_artifact_ref",
    )
    delay_depth_artifact_present = bool(delay_depth_artifact_refs)
    delay_depth_passed = _boolish(
        scorecard.get("delay_adjusted_depth_stress_passed")
        or scorecard.get("delay_depth_stress_passed")
        or scorecard.get("latency_depth_stress_passed")
    )
    delay_depth_model = _string(
        scorecard.get("delay_adjusted_depth_stress_model")
        or scorecard.get("delay_depth_stress_model")
        or scorecard.get("latency_depth_stress_model")
    ).lower()
    checks.append(
        {
            "metric": "delay_adjusted_depth_stress_passed",
            "observed": str(delay_depth_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "market_depth_execution_delays_ssrn_6440898_2026",
            "passed": delay_depth_passed
            if policy.require_delay_adjusted_depth_stress
            else True,
        }
    )
    checks.append(
        {
            "metric": "delay_adjusted_depth_stress_artifact_present",
            "observed": str(delay_depth_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "market_depth_execution_delays_ssrn_6440898_2026",
            "passed": delay_depth_artifact_present
            if policy.require_delay_adjusted_depth_stress
            else True,
        }
    )
    delay_depth_liquidity_evidence_present = _boolish(
        scorecard.get("delay_adjusted_depth_liquidity_evidence_present")
        or scorecard.get("delay_depth_liquidity_evidence_present")
        or scorecard.get("latency_depth_liquidity_evidence_present")
    )
    checks.append(
        {
            "metric": "delay_adjusted_depth_liquidity_evidence_present",
            "observed": str(delay_depth_liquidity_evidence_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "market_depth_execution_delays_ssrn_6440898_2026",
            "passed": delay_depth_liquidity_evidence_present
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_liquidity_evidence
            )
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="delay_adjusted_depth_liquidity_missing_day_count",
            observed=_decimal(
                scorecard.get("delay_adjusted_depth_liquidity_missing_day_count")
                or scorecard.get("delay_depth_liquidity_missing_day_count")
                or scorecard.get("latency_depth_liquidity_missing_day_count")
            ),
            operator="lte",
            threshold=Decimal("0")
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_liquidity_evidence
            )
            else Decimal("999999999"),
        )
    )
    delay_depth_latency_grid_ms = _string_sequence(
        scorecard.get("delay_adjusted_depth_latency_grid_ms")
        or scorecard.get("delay_depth_latency_grid_ms")
        or scorecard.get("latency_depth_grid_ms")
    )
    required_latency_grid_ms = {"50", "150", "250"}
    delay_depth_latency_grid_present = required_latency_grid_ms.issubset(
        set(delay_depth_latency_grid_ms)
    )
    checks.append(
        {
            "metric": "delay_adjusted_depth_latency_grid_ms",
            "observed": ",".join(delay_depth_latency_grid_ms),
            "operator": "contains",
            "threshold": sorted(required_latency_grid_ms),
            "source_marker": "latency_execution_policy_arxiv_2504_00846_2025",
            "passed": delay_depth_latency_grid_present
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_latency_grid
            )
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="delay_adjusted_depth_grid_max_stress_ms",
            observed=_decimal(
                scorecard.get("delay_adjusted_depth_grid_max_stress_ms")
                or scorecard.get("delay_depth_grid_max_stress_ms")
                or scorecard.get("latency_depth_grid_max_stress_ms")
            ),
            operator="gte",
            threshold=policy.min_delay_adjusted_depth_grid_max_stress_ms
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_latency_grid
            )
            else Decimal("0"),
        )
    )
    delay_depth_tail_coverage_passed = _boolish(
        scorecard.get("delay_adjusted_depth_tail_coverage_passed")
        or scorecard.get("delay_depth_tail_coverage_passed")
        or scorecard.get("latency_depth_tail_coverage_passed")
    )
    checks.append(
        {
            "metric": "delay_adjusted_depth_tail_coverage_passed",
            "observed": str(delay_depth_tail_coverage_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "market_depth_execution_delays_ssrn_6440898_2026",
            "passed": delay_depth_tail_coverage_passed
            if (
                policy.require_delay_adjusted_depth_stress
                and policy.require_delay_adjusted_depth_tail_coverage
            )
            else True,
        }
    )
    require_fill_survival_evidence = (
        policy.require_delay_adjusted_depth_stress
        and policy.require_fill_survival_evidence
    )
    require_queue_position_survival_evidence = (
        require_fill_survival_evidence
        and policy.require_queue_position_survival_evidence
    )
    require_queue_ahead_depletion_evidence = (
        require_fill_survival_evidence and policy.require_queue_ahead_depletion_evidence
    )
    queue_position_survival_evidence_present = _boolish(
        scorecard.get("queue_position_survival_fill_curve_evidence_present")
    )
    checks.append(
        {
            "metric": "queue_position_survival_fill_curve_evidence_present",
            "observed": str(queue_position_survival_evidence_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "kanformer_fill_survival_arxiv_2512_05734_2025",
            "passed": queue_position_survival_evidence_present
            if require_queue_position_survival_evidence
            else True,
        }
    )
    queue_ahead_depletion_evidence_present = _boolish(
        scorecard.get("queue_position_survival_queue_ahead_depletion_evidence_present")
        or scorecard.get("delay_adjusted_depth_queue_ahead_depletion_evidence_present")
        or scorecard.get("queue_ahead_depletion_evidence_present")
    )
    checks.append(
        {
            "metric": "queue_ahead_depletion_evidence_present",
            "observed": str(queue_ahead_depletion_evidence_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "deep_queue_reactive_arxiv_2501_08822_2025",
            "passed": queue_ahead_depletion_evidence_present
            if require_queue_ahead_depletion_evidence
            else True,
        }
    )
    queue_ahead_depletion_sample_count = max(
        _nonnegative_int(
            scorecard.get("queue_position_survival_queue_ahead_depletion_sample_count")
        ),
        _nonnegative_int(
            scorecard.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
        ),
        _nonnegative_int(scorecard.get("queue_ahead_depletion_sample_count")),
    )
    queue_ahead_depletion_sample_check = _numeric_check(
        metric="queue_ahead_depletion_sample_count",
        observed=Decimal(queue_ahead_depletion_sample_count),
        operator="gte",
        threshold=Decimal(policy.min_queue_ahead_depletion_sample_count),
    )
    if not require_queue_ahead_depletion_evidence:
        queue_ahead_depletion_sample_check["passed"] = True
    checks.append(
        {
            **queue_ahead_depletion_sample_check,
            "source_marker": "deep_queue_reactive_arxiv_2501_08822_2025",
        }
    )
    fill_survival_evidence_present = _boolish(
        scorecard.get("queue_position_survival_fill_curve_evidence_present")
        or scorecard.get("queue_position_survival_evidence_present")
        or scorecard.get("delay_adjusted_depth_fill_survival_evidence_present")
        or scorecard.get("fill_survival_evidence_present")
    )
    checks.append(
        {
            "metric": "fill_survival_evidence_present",
            "observed": str(fill_survival_evidence_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "kanformer_fill_survival_arxiv_2512_05734_2025",
            "passed": fill_survival_evidence_present
            if require_fill_survival_evidence
            else True,
        }
    )
    fill_survival_sample_count = max(
        _nonnegative_int(scorecard.get("queue_position_survival_sample_count")),
        _nonnegative_int(
            scorecard.get("delay_adjusted_depth_fill_survival_sample_count")
        ),
        _nonnegative_int(scorecard.get("fill_survival_sample_count")),
    )
    fill_survival_sample_check = _numeric_check(
        metric="fill_survival_sample_count",
        observed=Decimal(fill_survival_sample_count),
        operator="gte",
        threshold=Decimal(policy.min_fill_survival_sample_count),
    )
    if not require_fill_survival_evidence:
        fill_survival_sample_check["passed"] = True
    checks.append(
        {
            **fill_survival_sample_check,
            "source_marker": "kanformer_fill_survival_arxiv_2512_05734_2025",
        }
    )
    fill_survival_rate = max(
        _decimal(scorecard.get("queue_position_survival_fill_rate")),
        _decimal(scorecard.get("delay_adjusted_depth_fill_survival_rate")),
        _decimal(scorecard.get("fill_survival_fill_rate")),
        _decimal(scorecard.get("fill_survival_rate")),
    )
    fill_survival_rate_check = _numeric_check(
        metric="fill_survival_rate",
        observed=fill_survival_rate,
        operator="gt",
        threshold=policy.min_fill_survival_rate,
    )
    if not require_fill_survival_evidence:
        fill_survival_rate_check["passed"] = True
    checks.append(
        {
            **fill_survival_rate_check,
            "source_marker": "kanformer_fill_survival_arxiv_2512_05734_2025",
        }
    )
    for metric_name, *keys in (
        (
            "delay_adjusted_depth_worst_active_day_fillable_notional",
            "delay_adjusted_depth_worst_active_day_fillable_notional",
            "delay_depth_worst_active_day_fillable_notional",
            "latency_depth_worst_active_day_fillable_notional",
        ),
        (
            "delay_adjusted_depth_p10_active_day_fillable_notional",
            "delay_adjusted_depth_p10_active_day_fillable_notional",
            "delay_depth_p10_active_day_fillable_notional",
            "latency_depth_p10_active_day_fillable_notional",
        ),
    ):
        checks.append(
            _numeric_check(
                metric=metric_name,
                observed=max((_decimal(scorecard.get(key)) for key in keys)),
                operator="gte",
                threshold=policy.min_delay_adjusted_depth_tail_fillable_notional
                if (
                    policy.require_delay_adjusted_depth_stress
                    and policy.require_delay_adjusted_depth_tail_coverage
                )
                else Decimal("0"),
            )
        )
    checks.append(
        {
            "metric": "delay_adjusted_depth_stress_model",
            "observed": delay_depth_model,
            "operator": "in",
            "threshold": sorted(_ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS),
            "source_marker": "latency_execution_policy_arxiv_2504_00846_2025",
            "passed": (
                delay_depth_model in _ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS
            )
            if policy.require_delay_adjusted_depth_stress
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="delay_adjusted_depth_stress_ms",
            observed=_decimal(
                scorecard.get("delay_adjusted_depth_stress_ms")
                or scorecard.get("delay_depth_stress_delay_ms")
                or scorecard.get("latency_depth_stress_ms")
            ),
            operator="gte",
            threshold=policy.min_delay_adjusted_depth_stress_ms
            if policy.require_delay_adjusted_depth_stress
            else Decimal("0"),
        )
    )
    checks.append(
        _numeric_check(
            metric="delay_adjusted_depth_fillable_notional_per_day",
            observed=_decimal(
                scorecard.get("delay_adjusted_depth_fillable_notional_per_day")
                or scorecard.get("delay_depth_stress_fillable_notional_per_day")
                or scorecard.get("latency_depth_fillable_notional_per_day")
            ),
            operator="gte",
            threshold=policy.min_delay_adjusted_depth_fillable_notional_per_day
            if policy.require_delay_adjusted_depth_stress
            else Decimal("0"),
        )
    )
    delay_depth_net_pnl = _decimal(
        scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")
        or scorecard.get("delay_depth_stress_net_pnl_per_day")
        or scorecard.get("latency_depth_stress_net_pnl_per_day")
    )
    delay_depth_net_check = _numeric_check(
        metric="delay_adjusted_depth_stress_net_pnl_per_day",
        observed=delay_depth_net_pnl,
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_delay_adjusted_depth_stress:
        delay_depth_net_check["passed"] = True
    checks.append(
        {
            **delay_depth_net_check,
            "source_marker": "rl_market_limit_execution_arxiv_2507_06345_2026",
        }
    )
    require_implementation_uncertainty_stability = (
        _requires_implementation_uncertainty_stability(scorecard, policy)
    )
    implementation_uncertainty_passed = _boolish(
        scorecard.get("implementation_uncertainty_stability_passed")
        or scorecard.get("implementation_risk_stability_passed")
    )
    implementation_uncertainty_model_count = _nonnegative_int(
        scorecard.get("implementation_uncertainty_model_count")
        or scorecard.get("implementation_risk_model_count")
    )
    implementation_uncertainty_lower_bound = _decimal(
        scorecard.get("implementation_uncertainty_lower_net_pnl_per_day")
        or scorecard.get("implementation_risk_lower_net_pnl_per_day")
    )
    checks.extend(
        (
            {
                "metric": "implementation_uncertainty_stability_passed",
                "observed": str(implementation_uncertainty_passed).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "implementation_risk_backtesting_arxiv_2603_20319_2026",
                "passed": implementation_uncertainty_passed
                if require_implementation_uncertainty_stability
                else True,
            },
            _numeric_check(
                metric="implementation_uncertainty_model_count",
                observed=Decimal(implementation_uncertainty_model_count),
                operator="gte",
                threshold=Decimal(policy.min_implementation_uncertainty_model_count)
                if require_implementation_uncertainty_stability
                else Decimal("0"),
            ),
            {
                **_numeric_check(
                    metric="implementation_uncertainty_lower_net_pnl_per_day",
                    observed=implementation_uncertainty_lower_bound,
                    operator="gte",
                    threshold=target_net_pnl_per_day,
                ),
                "source_marker": "lob_simulation_reality_gap_arxiv_2603_24137_2026",
                "passed": implementation_uncertainty_lower_bound
                >= target_net_pnl_per_day
                if require_implementation_uncertainty_stability
                else True,
            },
        )
    )
    require_conformal_tail_risk = _requires_conformal_tail_risk(scorecard, policy)
    conformal_tail_risk_passed = _boolish(
        scorecard.get("conformal_tail_risk_passed")
        or scorecard.get("conformal_risk_passed")
        or scorecard.get("conformal_var_passed")
    )
    conformal_tail_risk_sample_count = _nonnegative_int(
        scorecard.get("conformal_tail_risk_sample_count")
        or scorecard.get("conformal_risk_sample_count")
        or scorecard.get("conformal_var_sample_count")
    )
    min_conformal_tail_risk_sample_count = max(
        policy.min_conformal_tail_risk_sample_count,
        policy.min_observed_trading_days,
    )
    conformal_tail_risk_adjusted_net = _decimal(
        scorecard.get("conformal_tail_risk_adjusted_net_pnl_per_day")
        or scorecard.get("conformal_risk_adjusted_net_pnl_per_day")
        or scorecard.get("conformal_var_adjusted_net_pnl_per_day")
    )
    checks.extend(
        (
            {
                "metric": "conformal_tail_risk_passed",
                "observed": str(conformal_tail_risk_passed).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "regime_weighted_conformal_var_arxiv_2602_03903_2026",
                "passed": conformal_tail_risk_passed
                if require_conformal_tail_risk
                else True,
            },
            _numeric_check(
                metric="conformal_tail_risk_sample_count",
                observed=Decimal(conformal_tail_risk_sample_count),
                operator="gte",
                threshold=Decimal(min_conformal_tail_risk_sample_count)
                if require_conformal_tail_risk
                else Decimal("0"),
            ),
            {
                **_numeric_check(
                    metric="conformal_tail_risk_adjusted_net_pnl_per_day",
                    observed=conformal_tail_risk_adjusted_net,
                    operator="gte",
                    threshold=target_net_pnl_per_day,
                ),
                "source_marker": "regime_weighted_conformal_var_arxiv_2602_03903_2026",
                "passed": conformal_tail_risk_adjusted_net >= target_net_pnl_per_day
                if require_conformal_tail_risk
                else True,
            },
        )
    )
    require_predictability_decay_stress = _requires_predictability_decay_stress(
        scorecard, policy
    )
    predictability_decay_stress_artifact_refs = _artifact_refs(
        scorecard,
        "predictability_decay_stress_artifact_ref",
        "predictability_decay_stress_artifact_refs",
        "alpha_decay_stress_artifact_ref",
    )
    predictability_decay_stress_artifact_present = bool(
        predictability_decay_stress_artifact_refs
    )
    predictability_decay_stress_passed = _boolish(
        scorecard.get("predictability_decay_stress_passed")
        or scorecard.get("alpha_decay_stress_passed")
    )
    horizon_decay_curve_present = _boolish(
        scorecard.get("horizon_decay_curve_present")
        or scorecard.get("predictability_horizon_decay_curve_present")
    )
    spread_adjusted_label_replay_present = _boolish(
        scorecard.get("spread_adjusted_label_replay_present")
        or scorecard.get("spread_adjusted_labels_present")
    )
    predictability_decay_horizon_count = _nonnegative_int(
        scorecard.get("predictability_decay_stress_horizon_count")
        or scorecard.get("horizon_decay_curve_horizon_count")
    )
    tight_spread_regime_count = _nonnegative_int(
        scorecard.get("tight_spread_regime_slice_count")
        or scorecard.get("tight_spread_regime_count")
    )
    predictability_decay_split_pass_rate = _decimal(
        scorecard.get("predictability_decay_stress_split_pass_rate")
        or scorecard.get("decay_stress_split_pass_rate")
    )
    predictability_decay_best_split_share = _decimal(
        scorecard.get("predictability_decay_stress_best_split_share")
        or scorecard.get("decay_stress_best_split_share"),
        default="1",
    )
    predictability_decay_stress_net_pnl = _decimal(
        scorecard.get("post_cost_net_pnl_after_predictability_decay_stress")
        or scorecard.get("predictability_decay_stress_net_pnl_per_day")
    )
    checks.extend(
        (
            {
                "metric": "predictability_decay_stress_passed",
                "observed": str(predictability_decay_stress_passed).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": predictability_decay_stress_passed
                if require_predictability_decay_stress
                else True,
            },
            {
                "metric": "predictability_decay_stress_artifact_present",
                "observed": str(predictability_decay_stress_artifact_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": predictability_decay_stress_artifact_present
                if require_predictability_decay_stress
                else True,
            },
            {
                "metric": "horizon_decay_curve_present",
                "observed": str(horizon_decay_curve_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": horizon_decay_curve_present
                if require_predictability_decay_stress
                else True,
            },
            {
                "metric": "spread_adjusted_label_replay_present",
                "observed": str(spread_adjusted_label_replay_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": spread_adjusted_label_replay_present
                if require_predictability_decay_stress
                else True,
            },
            _numeric_check(
                metric="predictability_decay_stress_horizon_count",
                observed=Decimal(predictability_decay_horizon_count),
                operator="gte",
                threshold=Decimal(
                    max(0, policy.min_predictability_decay_stress_horizon_count)
                )
                if require_predictability_decay_stress
                else Decimal("0"),
            ),
            _numeric_check(
                metric="tight_spread_regime_slice_count",
                observed=Decimal(tight_spread_regime_count),
                operator="gte",
                threshold=Decimal(max(0, policy.min_tight_spread_regime_count))
                if require_predictability_decay_stress
                else Decimal("0"),
            ),
            {
                **_numeric_check(
                    metric="predictability_decay_stress_split_pass_rate",
                    observed=predictability_decay_split_pass_rate,
                    operator="gte",
                    threshold=policy.min_predictability_decay_stress_split_pass_rate,
                ),
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": predictability_decay_split_pass_rate
                >= policy.min_predictability_decay_stress_split_pass_rate
                if require_predictability_decay_stress
                else True,
            },
            {
                **_numeric_check(
                    metric="predictability_decay_stress_best_split_share",
                    observed=predictability_decay_best_split_share,
                    operator="lte",
                    threshold=policy.max_predictability_decay_stress_best_split_share,
                ),
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": predictability_decay_best_split_share
                <= policy.max_predictability_decay_stress_best_split_share
                if require_predictability_decay_stress
                else True,
            },
            {
                **_numeric_check(
                    metric="post_cost_net_pnl_after_predictability_decay_stress",
                    observed=predictability_decay_stress_net_pnl,
                    operator="gte",
                    threshold=target_net_pnl_per_day,
                ),
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": predictability_decay_stress_net_pnl >= target_net_pnl_per_day
                if require_predictability_decay_stress
                else True,
            },
        )
    )
    require_order_type_execution_quality = _requires_order_type_execution_quality(
        scorecard, policy
    )
    order_type_artifact_refs = _artifact_refs(
        scorecard,
        "order_type_ablation_artifact_ref",
        "order_type_ablation_artifact_refs",
    )
    order_type_ablation_artifact_present = bool(order_type_artifact_refs)
    order_type_ablation_passed = _boolish(
        scorecard.get("order_type_ablation_passed")
        or scorecard.get("market_limit_execution_policy_passed")
    )
    order_type_ablation_sample_count = _nonnegative_int(
        scorecard.get("order_type_ablation_sample_count")
        or scorecard.get("market_limit_order_mix_sample_count")
        or scorecard.get("limit_fill_probability_sample_count")
    )
    market_limit_order_mix_evidence_present = _boolish(
        scorecard.get("market_limit_order_mix_evidence_present")
        or scorecard.get("market_limit_order_mix_present")
    )
    limit_fill_probability_evidence_present = _boolish(
        scorecard.get("limit_fill_probability_evidence_present")
        or scorecard.get("limit_fill_probability_present")
    )
    price_improvement_evidence_present = _boolish(
        scorecard.get("price_improvement_evidence_present")
        or scorecard.get("route_price_improvement_evidence_present")
    )
    opportunity_cost_evidence_present = _boolish(
        scorecard.get("opportunity_cost_evidence_present")
        or scorecard.get("order_type_opportunity_cost_evidence_present")
    )
    execution_shortfall_evidence_present = _boolish(
        scorecard.get("execution_shortfall_evidence_present")
        or scorecard.get("order_type_execution_shortfall_evidence_present")
    )
    route_tca_evidence_present = bool(
        _artifact_refs(scorecard, "route_tca_artifact_ref", "route_tca_artifact_refs")
    )
    checks.extend(
        (
            {
                "metric": "order_type_ablation_passed",
                "observed": str(order_type_ablation_passed).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "retail_limit_orders_rof_rfaf049_2025",
                "passed": order_type_ablation_passed
                if require_order_type_execution_quality
                else True,
            },
            {
                "metric": "order_type_ablation_artifact_present",
                "observed": str(order_type_ablation_artifact_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "retail_order_flow_segmentation_ssrn_6414558_2026",
                "passed": order_type_ablation_artifact_present
                if require_order_type_execution_quality
                else True,
            },
            _numeric_check(
                metric="order_type_ablation_sample_count",
                observed=Decimal(order_type_ablation_sample_count),
                operator="gte",
                threshold=Decimal(policy.min_order_type_ablation_sample_count)
                if require_order_type_execution_quality
                else Decimal("0"),
            ),
            {
                "metric": "market_limit_order_mix_evidence_present",
                "observed": str(market_limit_order_mix_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "retail_limit_orders_rof_rfaf049_2025",
                "passed": market_limit_order_mix_evidence_present
                if require_order_type_execution_quality
                else True,
            },
            {
                "metric": "limit_fill_probability_evidence_present",
                "observed": str(limit_fill_probability_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "rl_market_limit_execution_arxiv_2507_06345_2026",
                "passed": limit_fill_probability_evidence_present
                if require_order_type_execution_quality
                else True,
            },
            {
                "metric": "price_improvement_evidence_present",
                "observed": str(price_improvement_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "retail_order_flow_segmentation_ssrn_6414558_2026",
                "passed": price_improvement_evidence_present
                if require_order_type_execution_quality
                else True,
            },
            {
                "metric": "opportunity_cost_evidence_present",
                "observed": str(opportunity_cost_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "retail_limit_orders_rof_rfaf049_2025",
                "passed": opportunity_cost_evidence_present
                if require_order_type_execution_quality
                else True,
            },
            {
                "metric": "execution_shortfall_evidence_present",
                "observed": str(execution_shortfall_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "retail_limit_orders_rof_rfaf049_2025",
                "passed": execution_shortfall_evidence_present
                if require_order_type_execution_quality
                else True,
            },
            {
                "metric": "route_tca_evidence_present",
                "observed": str(route_tca_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "retail_order_flow_segmentation_ssrn_6414558_2026",
                "passed": route_tca_evidence_present
                if require_order_type_execution_quality
                else True,
            },
            _numeric_check(
                metric="order_type_opportunity_cost_bps",
                observed=_decimal(
                    scorecard.get("order_type_opportunity_cost_bps")
                    or scorecard.get("market_limit_order_mix_opportunity_cost_bps"),
                    default="999999",
                ),
                operator="lte",
                threshold=policy.max_order_type_opportunity_cost_bps
                if require_order_type_execution_quality
                else Decimal("999999"),
            ),
            _numeric_check(
                metric="market_order_spread_bps",
                observed=_decimal(
                    scorecard.get("market_order_spread_bps")
                    or scorecard.get("market_limit_order_mix_market_spread_bps"),
                    default="999999",
                ),
                operator="lte",
                threshold=policy.max_market_order_spread_bps
                if require_order_type_execution_quality
                else Decimal("999999"),
            ),
        )
    )
    require_mpc_dynamic_execution_schedule = _requires_mpc_dynamic_execution_schedule(
        scorecard, policy
    )
    execution_schedule_trace_artifact_refs = _artifact_refs(
        scorecard,
        "execution_schedule_trace_artifact_ref",
        "execution_schedule_trace_artifact_refs",
        "mpc_schedule_trace_artifact_ref",
    )
    liquidity_forecast_artifact_refs = _artifact_refs(
        scorecard,
        "liquidity_forecast_artifact_ref",
        "liquidity_forecast_artifact_refs",
        "mpc_liquidity_forecast_artifact_ref",
    )
    inventory_path_artifact_refs = _artifact_refs(
        scorecard,
        "inventory_path_artifact_ref",
        "inventory_path_artifact_refs",
        "inventory_path_trace_artifact_ref",
        "mpc_inventory_path_artifact_ref",
    )
    execution_shortfall_artifact_refs = _artifact_refs(
        scorecard,
        "execution_shortfall_artifact_ref",
        "execution_shortfall_artifact_refs",
        "mpc_execution_shortfall_artifact_ref",
    )
    mpc_ablation_artifact_refs = _artifact_refs(
        scorecard,
        "mpc_schedule_shortfall_ablation_artifact_ref",
        "mpc_schedule_shortfall_ablation_artifact_refs",
        "dynamic_execution_schedule_ablation_artifact_ref",
    )
    execution_schedule_trace_present = bool(
        execution_schedule_trace_artifact_refs
    ) or _boolish(
        scorecard.get("execution_schedule_trace_present")
        or scorecard.get("mpc_schedule_trace_present")
    )
    liquidity_forecast_present = bool(liquidity_forecast_artifact_refs) or _boolish(
        scorecard.get("liquidity_forecast_present")
        or scorecard.get("mpc_liquidity_forecast_present")
    )
    inventory_path_present = bool(inventory_path_artifact_refs) or _boolish(
        scorecard.get("inventory_path_trace_present")
        or scorecard.get("inventory_path_present")
        or scorecard.get("mpc_inventory_path_present")
    )
    mpc_execution_shortfall_evidence_present = (
        bool(execution_shortfall_artifact_refs) or execution_shortfall_evidence_present
    )
    mpc_schedule_shortfall_ablation_passed = _boolish(
        scorecard.get("mpc_schedule_shortfall_ablation_passed")
        or scorecard.get("dynamic_execution_schedule_ablation_passed")
    )
    mpc_schedule_trace_sample_count = _nonnegative_int(
        scorecard.get("mpc_schedule_trace_sample_count")
        or scorecard.get("execution_schedule_trace_sample_count")
    )
    checks.extend(
        (
            {
                "metric": "execution_schedule_trace_present",
                "observed": str(execution_schedule_trace_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": execution_schedule_trace_present
                if require_mpc_dynamic_execution_schedule
                else True,
            },
            {
                "metric": "liquidity_forecast_present",
                "observed": str(liquidity_forecast_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": liquidity_forecast_present
                if require_mpc_dynamic_execution_schedule
                else True,
            },
            {
                "metric": "inventory_path_trace_present",
                "observed": str(inventory_path_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": inventory_path_present
                if require_mpc_dynamic_execution_schedule
                else True,
            },
            {
                "metric": "mpc_execution_shortfall_evidence_present",
                "observed": str(mpc_execution_shortfall_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": mpc_execution_shortfall_evidence_present
                if require_mpc_dynamic_execution_schedule
                else True,
            },
            {
                "metric": "mpc_route_tca_evidence_present",
                "observed": str(route_tca_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": route_tca_evidence_present
                if require_mpc_dynamic_execution_schedule
                else True,
            },
            {
                "metric": "mpc_schedule_shortfall_ablation_passed",
                "observed": str(mpc_schedule_shortfall_ablation_passed).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": (
                    mpc_schedule_shortfall_ablation_passed
                    and bool(mpc_ablation_artifact_refs)
                )
                if require_mpc_dynamic_execution_schedule
                else True,
            },
            _numeric_check(
                metric="mpc_schedule_trace_sample_count",
                observed=Decimal(mpc_schedule_trace_sample_count),
                operator="gte",
                threshold=Decimal(policy.min_mpc_schedule_trace_sample_count)
                if require_mpc_dynamic_execution_schedule
                else Decimal("0"),
            ),
            _numeric_check(
                metric="mpc_schedule_shortfall_bps",
                observed=_decimal(
                    scorecard.get("mpc_schedule_shortfall_bps")
                    or scorecard.get("dynamic_execution_schedule_shortfall_bps"),
                    default="999999",
                ),
                operator="lte",
                threshold=policy.max_mpc_schedule_shortfall_bps
                if require_mpc_dynamic_execution_schedule
                else Decimal("999999"),
            ),
            {
                **_numeric_check(
                    metric="mpc_schedule_shortfall_net_pnl_per_day",
                    observed=_decimal(
                        scorecard.get("mpc_schedule_shortfall_net_pnl_per_day")
                        or scorecard.get(
                            "post_cost_net_pnl_after_mpc_schedule_shortfall_stress"
                        )
                    ),
                    operator="gte",
                    threshold=target_net_pnl_per_day,
                ),
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": _decimal(
                    scorecard.get("mpc_schedule_shortfall_net_pnl_per_day")
                    or scorecard.get(
                        "post_cost_net_pnl_after_mpc_schedule_shortfall_stress"
                    )
                )
                >= target_net_pnl_per_day
                if require_mpc_dynamic_execution_schedule
                else True,
            },
        )
    )
    double_oos_artifact_refs = _artifact_refs(
        scorecard,
        "double_oos_artifact_ref",
        "double_oos_artifact_refs",
        "double_oos_report_ref",
        "walk_forward_oos_artifact_ref",
    )
    double_oos_artifact_present = bool(double_oos_artifact_refs)
    double_oos_passed = _boolish(
        scorecard.get("double_oos_passed")
        or scorecard.get("double_out_of_sample_passed")
        or scorecard.get("walk_forward_oos_passed")
    )
    checks.append(
        {
            "metric": "double_oos_passed",
            "observed": str(double_oos_passed).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
            "passed": double_oos_passed if policy.require_double_oos else True,
        }
    )
    checks.append(
        {
            "metric": "double_oos_artifact_present",
            "observed": str(double_oos_artifact_present).lower(),
            "operator": "eq",
            "threshold": "true",
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
            "passed": double_oos_artifact_present
            if policy.require_double_oos
            else True,
        }
    )
    checks.append(
        _numeric_check(
            metric="double_oos_independent_window_count",
            observed=Decimal(
                _nonnegative_int(
                    scorecard.get("double_oos_independent_window_count")
                    or scorecard.get("double_oos_fold_count")
                    or scorecard.get("oos_fold_count")
                )
            ),
            operator="gte",
            threshold=Decimal(max(0, policy.min_double_oos_independent_window_count))
            if policy.require_double_oos
            else Decimal("0"),
        )
    )
    checks.append(
        _numeric_check(
            metric="double_oos_pass_rate",
            observed=_decimal(
                scorecard.get("double_oos_pass_rate")
                or scorecard.get("double_out_of_sample_pass_rate")
                or scorecard.get("walk_forward_oos_pass_rate")
            ),
            operator="gte",
            threshold=policy.min_double_oos_pass_rate
            if policy.require_double_oos
            else Decimal("0"),
        )
    )
    double_oos_net_check = _numeric_check(
        metric="double_oos_net_pnl_per_day",
        observed=_decimal(
            scorecard.get("double_oos_net_pnl_per_day")
            or scorecard.get("double_out_of_sample_net_pnl_per_day")
            or scorecard.get("walk_forward_oos_net_pnl_per_day")
        ),
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_double_oos:
        double_oos_net_check["passed"] = True
    checks.append(
        {
            **double_oos_net_check,
            "source_marker": "double_oos_walkforward_arxiv_2602_10785_2026",
        }
    )
    double_oos_cost_shock_net_check = _numeric_check(
        metric="double_oos_cost_shock_net_pnl_per_day",
        observed=_decimal(
            scorecard.get("double_oos_cost_shock_net_pnl_per_day")
            or scorecard.get("double_oos_market_impact_stress_net_pnl_per_day")
            or scorecard.get("double_oos_cost_sensitivity_net_pnl_per_day")
        ),
        operator="gte",
        threshold=target_net_pnl_per_day,
    )
    if not policy.require_double_oos:
        double_oos_cost_shock_net_check["passed"] = True
    checks.append(
        {
            **double_oos_cost_shock_net_check,
            "source_marker": "double_oos_cost_sensitivity_arxiv_2602_10785_2026",
        }
    )
    require_rejected_signal_learning = _requires_rejected_signal_outcome_learning(
        scorecard, policy
    )
    rejected_signal_labeled_count = _nonnegative_int(
        scorecard.get("rejected_signal_outcome_labeled_count")
        or scorecard.get("rejected_signal_outcome_label_count")
        or scorecard.get("rejected_signal_outcome_labeled_event_count")
    )
    rejected_signal_pending_ratio = _decimal(
        scorecard.get("rejected_signal_outcome_pending_ratio"), default="1"
    )
    rejected_signal_reason_coverage = _decimal(
        scorecard.get("rejected_signal_reason_coverage")
        or scorecard.get("rejected_signal_outcome_reason_coverage")
    )
    rejected_signal_persistence_state = _string(
        scorecard.get("rejected_signal_outcome_persistence_state")
        or scorecard.get("rejected_signal_persistence_state")
    ).lower()
    observed_counterfactual_fields = set(
        _string_sequence(
            scorecard.get("rejected_signal_counterfactual_fields")
            or scorecard.get("rejected_signal_counterfactual_fields_present")
            or scorecard.get("rejected_signal_outcome_counterfactual_fields")
        )
    )
    if _boolish(scorecard.get("rejected_signal_counterfactual_fields_present")):
        observed_counterfactual_fields.update(
            policy.required_rejected_signal_counterfactual_fields
        )
    required_counterfactual_fields = set(
        policy.required_rejected_signal_counterfactual_fields
    )
    checks.extend(
        (
            _numeric_check(
                metric="rejected_signal_outcome_labeled_count",
                observed=Decimal(rejected_signal_labeled_count),
                operator="gte",
                threshold=Decimal(policy.min_rejected_signal_outcome_label_count)
                if require_rejected_signal_learning
                else Decimal("0"),
            ),
            _numeric_check(
                metric="rejected_signal_outcome_pending_ratio",
                observed=rejected_signal_pending_ratio,
                operator="lte",
                threshold=policy.max_rejected_signal_outcome_pending_ratio
                if require_rejected_signal_learning
                else Decimal("1"),
            ),
            _numeric_check(
                metric="rejected_signal_reason_coverage",
                observed=rejected_signal_reason_coverage,
                operator="gte",
                threshold=policy.min_rejected_signal_reason_coverage
                if require_rejected_signal_learning
                else Decimal("0"),
            ),
            {
                "metric": "rejected_signal_counterfactual_fields_present",
                "observed": sorted(observed_counterfactual_fields),
                "operator": "contains",
                "threshold": sorted(required_counterfactual_fields),
                "source_marker": "rejected_signal_outcome_calibration",
                "passed": required_counterfactual_fields.issubset(
                    observed_counterfactual_fields
                )
                if require_rejected_signal_learning
                else True,
            },
            {
                "metric": "rejected_signal_outcome_persistence_state",
                "observed": rejected_signal_persistence_state,
                "operator": "eq",
                "threshold": policy.required_rejected_signal_outcome_persistence_state,
                "source_marker": "rejected_signal_outcome_calibration",
                "passed": (
                    rejected_signal_persistence_state
                    == policy.required_rejected_signal_outcome_persistence_state
                )
                if require_rejected_signal_learning
                else True,
            },
        )
    )
    blockers = [
        f"{item['metric']}_failed" for item in checks if not bool(item["passed"])
    ]
    return {
        "schema_version": PROFIT_TARGET_ORACLE_SCHEMA_VERSION,
        "policy": policy.to_payload(),
        "target_implied_notional_gate": target_implied_notional_gate,
        "target_implied_min_avg_filled_notional_per_day": target_implied_notional_gate[
            "target_implied_min_avg_filled_notional_per_day"
        ],
        "effective_min_avg_filled_notional_per_day": target_implied_notional_gate[
            "effective_min_avg_filled_notional_per_day"
        ],
        "observed_post_cost_expectancy_bps": target_implied_notional_gate[
            "observed_post_cost_expectancy_bps"
        ],
        "passed": not blockers,
        "checks": checks,
        "blockers": blockers,
    }
