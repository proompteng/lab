"""Research overlay checks for the profit-target oracle."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .context import OracleEvaluationContext
from .parsing import (
    artifact_refs,
    boolish,
    decimal_value,
    nonnegative_int,
    numeric_check,
    requires_conformal_tail_risk,
    requires_implementation_uncertainty_stability,
    requires_mpc_dynamic_execution_schedule,
    requires_order_type_execution_quality,
    requires_predictability_decay_stress,
)


@dataclass(frozen=True)
class _PredictabilityDecayEvidence:
    required: bool
    artifact_present: bool
    passed: bool
    horizon_curve_present: bool
    spread_adjusted_label_replay_present: bool
    horizon_count: int
    tight_spread_regime_count: int
    split_pass_rate: Decimal
    best_split_share: Decimal
    net_pnl_per_day: Decimal


@dataclass(frozen=True)
class _MpcScheduleEvidence:
    required: bool
    execution_schedule_trace_present: bool
    liquidity_forecast_present: bool
    inventory_path_present: bool
    execution_shortfall_evidence_present: bool
    route_tca_evidence_present: bool
    schedule_shortfall_ablation_passed: bool
    schedule_shortfall_ablation_artifact_present: bool
    schedule_trace_sample_count: int
    schedule_shortfall_bps: Decimal
    schedule_shortfall_net_pnl_per_day: Decimal


def append_uncertainty_and_tail_risk_checks(ctx: OracleEvaluationContext) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    target_net_pnl_per_day = ctx.target_net_pnl_per_day
    require_implementation_uncertainty_stability = (
        requires_implementation_uncertainty_stability(scorecard, policy)
    )
    implementation_uncertainty_passed = boolish(
        scorecard.get("implementation_uncertainty_stability_passed")
        or scorecard.get("implementation_risk_stability_passed")
    )
    implementation_uncertainty_model_count = nonnegative_int(
        scorecard.get("implementation_uncertainty_model_count")
        or scorecard.get("implementation_risk_model_count")
    )
    implementation_uncertainty_lower_bound = decimal_value(
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
            numeric_check(
                metric="implementation_uncertainty_model_count",
                observed=Decimal(implementation_uncertainty_model_count),
                operator="gte",
                threshold=Decimal(policy.min_implementation_uncertainty_model_count)
                if require_implementation_uncertainty_stability
                else Decimal("0"),
            ),
            {
                **numeric_check(
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
    require_conformal_tail_risk = requires_conformal_tail_risk(scorecard, policy)
    conformal_tail_risk_passed = boolish(
        scorecard.get("conformal_tail_risk_passed")
        or scorecard.get("conformal_risk_passed")
        or scorecard.get("conformal_var_passed")
    )
    conformal_tail_risk_sample_count = nonnegative_int(
        scorecard.get("conformal_tail_risk_sample_count")
        or scorecard.get("conformal_risk_sample_count")
        or scorecard.get("conformal_var_sample_count")
    )
    min_conformal_tail_risk_sample_count = max(
        policy.min_conformal_tail_risk_sample_count,
        policy.min_observed_trading_days,
    )
    conformal_tail_risk_adjusted_net = decimal_value(
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
            numeric_check(
                metric="conformal_tail_risk_sample_count",
                observed=Decimal(conformal_tail_risk_sample_count),
                operator="gte",
                threshold=Decimal(min_conformal_tail_risk_sample_count)
                if require_conformal_tail_risk
                else Decimal("0"),
            ),
            {
                **numeric_check(
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


def _predictability_decay_evidence(
    ctx: OracleEvaluationContext,
) -> _PredictabilityDecayEvidence:
    scorecard = ctx.scorecard
    policy = ctx.policy
    predictability_decay_stress_artifact_refs = artifact_refs(
        scorecard,
        "predictability_decay_stress_artifact_ref",
        "predictability_decay_stress_artifact_refs",
        "alpha_decay_stress_artifact_ref",
    )
    return _PredictabilityDecayEvidence(
        required=requires_predictability_decay_stress(scorecard, policy),
        artifact_present=bool(predictability_decay_stress_artifact_refs),
        passed=boolish(
            scorecard.get("predictability_decay_stress_passed")
            or scorecard.get("alpha_decay_stress_passed")
        ),
        horizon_curve_present=boolish(
            scorecard.get("horizon_decay_curve_present")
            or scorecard.get("predictability_horizon_decay_curve_present")
        ),
        spread_adjusted_label_replay_present=boolish(
            scorecard.get("spread_adjusted_label_replay_present")
            or scorecard.get("spread_adjusted_labels_present")
        ),
        horizon_count=nonnegative_int(
            scorecard.get("predictability_decay_stress_horizon_count")
            or scorecard.get("horizon_decay_curve_horizon_count")
        ),
        tight_spread_regime_count=nonnegative_int(
            scorecard.get("tight_spread_regime_slice_count")
            or scorecard.get("tight_spread_regime_count")
        ),
        split_pass_rate=decimal_value(
            scorecard.get("predictability_decay_stress_split_pass_rate")
            or scorecard.get("decay_stress_split_pass_rate")
        ),
        best_split_share=decimal_value(
            scorecard.get("predictability_decay_stress_best_split_share")
            or scorecard.get("decay_stress_best_split_share"),
            default="1",
        ),
        net_pnl_per_day=decimal_value(
            scorecard.get("post_cost_net_pnl_after_predictability_decay_stress")
            or scorecard.get("predictability_decay_stress_net_pnl_per_day")
        ),
    )


def append_predictability_decay_checks(ctx: OracleEvaluationContext) -> None:
    policy = ctx.policy
    checks = ctx.checks
    target_net_pnl_per_day = ctx.target_net_pnl_per_day
    evidence = _predictability_decay_evidence(ctx)
    checks.extend(
        (
            {
                "metric": "predictability_decay_stress_passed",
                "observed": str(evidence.passed).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": evidence.passed if evidence.required else True,
            },
            {
                "metric": "predictability_decay_stress_artifact_present",
                "observed": str(evidence.artifact_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": evidence.artifact_present if evidence.required else True,
            },
            {
                "metric": "horizon_decay_curve_present",
                "observed": str(evidence.horizon_curve_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": evidence.horizon_curve_present if evidence.required else True,
            },
            {
                "metric": "spread_adjusted_label_replay_present",
                "observed": str(evidence.spread_adjusted_label_replay_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": evidence.spread_adjusted_label_replay_present
                if evidence.required
                else True,
            },
            numeric_check(
                metric="predictability_decay_stress_horizon_count",
                observed=Decimal(evidence.horizon_count),
                operator="gte",
                threshold=Decimal(
                    max(0, policy.min_predictability_decay_stress_horizon_count)
                )
                if evidence.required
                else Decimal("0"),
            ),
            numeric_check(
                metric="tight_spread_regime_slice_count",
                observed=Decimal(evidence.tight_spread_regime_count),
                operator="gte",
                threshold=Decimal(max(0, policy.min_tight_spread_regime_count))
                if evidence.required
                else Decimal("0"),
            ),
            {
                **numeric_check(
                    metric="predictability_decay_stress_split_pass_rate",
                    observed=evidence.split_pass_rate,
                    operator="gte",
                    threshold=policy.min_predictability_decay_stress_split_pass_rate,
                ),
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": evidence.split_pass_rate
                >= policy.min_predictability_decay_stress_split_pass_rate
                if evidence.required
                else True,
            },
            {
                **numeric_check(
                    metric="predictability_decay_stress_best_split_share",
                    observed=evidence.best_split_share,
                    operator="lte",
                    threshold=policy.max_predictability_decay_stress_best_split_share,
                ),
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": evidence.best_split_share
                <= policy.max_predictability_decay_stress_best_split_share
                if evidence.required
                else True,
            },
            {
                **numeric_check(
                    metric="post_cost_net_pnl_after_predictability_decay_stress",
                    observed=evidence.net_pnl_per_day,
                    operator="gte",
                    threshold=target_net_pnl_per_day,
                ),
                "source_marker": "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
                "passed": evidence.net_pnl_per_day >= target_net_pnl_per_day
                if evidence.required
                else True,
            },
        )
    )


def append_order_type_execution_checks(ctx: OracleEvaluationContext) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    require_order_type_execution_quality = requires_order_type_execution_quality(
        scorecard, policy
    )
    order_type_artifact_refs = artifact_refs(
        scorecard,
        "order_type_ablation_artifact_ref",
        "order_type_ablation_artifact_refs",
    )
    order_type_ablation_artifact_present = bool(order_type_artifact_refs)
    order_type_ablation_passed = boolish(
        scorecard.get("order_type_ablation_passed")
        or scorecard.get("market_limit_execution_policy_passed")
    )
    order_type_ablation_sample_count = nonnegative_int(
        scorecard.get("order_type_ablation_sample_count")
        or scorecard.get("market_limit_order_mix_sample_count")
        or scorecard.get("limit_fill_probability_sample_count")
    )
    market_limit_order_mix_evidence_present = boolish(
        scorecard.get("market_limit_order_mix_evidence_present")
        or scorecard.get("market_limit_order_mix_present")
    )
    limit_fill_probability_evidence_present = boolish(
        scorecard.get("limit_fill_probability_evidence_present")
        or scorecard.get("limit_fill_probability_present")
    )
    price_improvement_evidence_present = boolish(
        scorecard.get("price_improvement_evidence_present")
        or scorecard.get("route_price_improvement_evidence_present")
    )
    opportunity_cost_evidence_present = boolish(
        scorecard.get("opportunity_cost_evidence_present")
        or scorecard.get("order_type_opportunity_cost_evidence_present")
    )
    execution_shortfall_evidence_present = boolish(
        scorecard.get("execution_shortfall_evidence_present")
        or scorecard.get("order_type_execution_shortfall_evidence_present")
    )
    route_tca_evidence_present = bool(
        artifact_refs(scorecard, "route_tca_artifact_ref", "route_tca_artifact_refs")
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
            numeric_check(
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
            numeric_check(
                metric="order_type_opportunity_cost_bps",
                observed=decimal_value(
                    scorecard.get("order_type_opportunity_cost_bps")
                    or scorecard.get("market_limit_order_mix_opportunity_cost_bps"),
                    default="999999",
                ),
                operator="lte",
                threshold=policy.max_order_type_opportunity_cost_bps
                if require_order_type_execution_quality
                else Decimal("999999"),
            ),
            numeric_check(
                metric="market_order_spread_bps",
                observed=decimal_value(
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


def _mpc_schedule_evidence(ctx: OracleEvaluationContext) -> _MpcScheduleEvidence:
    scorecard = ctx.scorecard
    policy = ctx.policy
    execution_schedule_trace_artifact_refs = artifact_refs(
        scorecard,
        "execution_schedule_trace_artifact_ref",
        "execution_schedule_trace_artifact_refs",
        "mpc_schedule_trace_artifact_ref",
    )
    liquidity_forecast_artifact_refs = artifact_refs(
        scorecard,
        "liquidity_forecast_artifact_ref",
        "liquidity_forecast_artifact_refs",
        "mpc_liquidity_forecast_artifact_ref",
    )
    inventory_path_artifact_refs = artifact_refs(
        scorecard,
        "inventory_path_artifact_ref",
        "inventory_path_artifact_refs",
        "inventory_path_trace_artifact_ref",
        "mpc_inventory_path_artifact_ref",
    )
    execution_shortfall_artifact_refs = artifact_refs(
        scorecard,
        "execution_shortfall_artifact_ref",
        "execution_shortfall_artifact_refs",
        "mpc_execution_shortfall_artifact_ref",
    )
    mpc_ablation_artifact_refs = artifact_refs(
        scorecard,
        "mpc_schedule_shortfall_ablation_artifact_ref",
        "mpc_schedule_shortfall_ablation_artifact_refs",
        "dynamic_execution_schedule_ablation_artifact_ref",
    )
    execution_shortfall_evidence_present = boolish(
        scorecard.get("execution_shortfall_evidence_present")
        or scorecard.get("order_type_execution_shortfall_evidence_present")
    )
    return _MpcScheduleEvidence(
        required=requires_mpc_dynamic_execution_schedule(scorecard, policy),
        execution_schedule_trace_present=bool(execution_schedule_trace_artifact_refs)
        or boolish(
            scorecard.get("execution_schedule_trace_present")
            or scorecard.get("mpc_schedule_trace_present")
        ),
        liquidity_forecast_present=bool(liquidity_forecast_artifact_refs)
        or boolish(
            scorecard.get("liquidity_forecast_present")
            or scorecard.get("mpc_liquidity_forecast_present")
        ),
        inventory_path_present=bool(inventory_path_artifact_refs)
        or boolish(
            scorecard.get("inventory_path_trace_present")
            or scorecard.get("inventory_path_present")
            or scorecard.get("mpc_inventory_path_present")
        ),
        execution_shortfall_evidence_present=(
            bool(execution_shortfall_artifact_refs)
            or execution_shortfall_evidence_present
        ),
        route_tca_evidence_present=bool(
            artifact_refs(
                scorecard,
                "route_tca_artifact_ref",
                "route_tca_artifact_refs",
            )
        ),
        schedule_shortfall_ablation_passed=boolish(
            scorecard.get("mpc_schedule_shortfall_ablation_passed")
            or scorecard.get("dynamic_execution_schedule_ablation_passed")
        ),
        schedule_shortfall_ablation_artifact_present=bool(mpc_ablation_artifact_refs),
        schedule_trace_sample_count=nonnegative_int(
            scorecard.get("mpc_schedule_trace_sample_count")
            or scorecard.get("execution_schedule_trace_sample_count")
        ),
        schedule_shortfall_bps=decimal_value(
            scorecard.get("mpc_schedule_shortfall_bps")
            or scorecard.get("dynamic_execution_schedule_shortfall_bps"),
            default="999999",
        ),
        schedule_shortfall_net_pnl_per_day=decimal_value(
            scorecard.get("mpc_schedule_shortfall_net_pnl_per_day")
            or scorecard.get("post_cost_net_pnl_after_mpc_schedule_shortfall_stress")
        ),
    )


def append_mpc_schedule_checks(ctx: OracleEvaluationContext) -> None:
    policy = ctx.policy
    checks = ctx.checks
    target_net_pnl_per_day = ctx.target_net_pnl_per_day
    evidence = _mpc_schedule_evidence(ctx)
    checks.extend(
        (
            {
                "metric": "execution_schedule_trace_present",
                "observed": str(evidence.execution_schedule_trace_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": evidence.execution_schedule_trace_present
                if evidence.required
                else True,
            },
            {
                "metric": "liquidity_forecast_present",
                "observed": str(evidence.liquidity_forecast_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": evidence.liquidity_forecast_present
                if evidence.required
                else True,
            },
            {
                "metric": "inventory_path_trace_present",
                "observed": str(evidence.inventory_path_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": evidence.inventory_path_present
                if evidence.required
                else True,
            },
            {
                "metric": "mpc_execution_shortfall_evidence_present",
                "observed": str(evidence.execution_shortfall_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": evidence.execution_shortfall_evidence_present
                if evidence.required
                else True,
            },
            {
                "metric": "mpc_route_tca_evidence_present",
                "observed": str(evidence.route_tca_evidence_present).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": evidence.route_tca_evidence_present
                if evidence.required
                else True,
            },
            {
                "metric": "mpc_schedule_shortfall_ablation_passed",
                "observed": str(evidence.schedule_shortfall_ablation_passed).lower(),
                "operator": "eq",
                "threshold": "true",
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": (
                    evidence.schedule_shortfall_ablation_passed
                    and evidence.schedule_shortfall_ablation_artifact_present
                )
                if evidence.required
                else True,
            },
            numeric_check(
                metric="mpc_schedule_trace_sample_count",
                observed=Decimal(evidence.schedule_trace_sample_count),
                operator="gte",
                threshold=Decimal(policy.min_mpc_schedule_trace_sample_count)
                if evidence.required
                else Decimal("0"),
            ),
            numeric_check(
                metric="mpc_schedule_shortfall_bps",
                observed=evidence.schedule_shortfall_bps,
                operator="lte",
                threshold=policy.max_mpc_schedule_shortfall_bps
                if evidence.required
                else Decimal("999999"),
            ),
            {
                **numeric_check(
                    metric="mpc_schedule_shortfall_net_pnl_per_day",
                    observed=evidence.schedule_shortfall_net_pnl_per_day,
                    operator="gte",
                    threshold=target_net_pnl_per_day,
                ),
                "source_marker": "mpc_trade_execution_arxiv_2603_28898_2026",
                "passed": evidence.schedule_shortfall_net_pnl_per_day
                >= target_net_pnl_per_day
                if evidence.required
                else True,
            },
        )
    )
