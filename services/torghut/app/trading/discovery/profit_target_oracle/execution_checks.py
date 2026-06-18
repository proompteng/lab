"""Execution and replay evidence checks for the profit-target oracle."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast

from .context import OracleEvaluationContext
from .parsing import (
    artifact_refs,
    boolish,
    decimal_value,
    nonnegative_int,
    numeric_check,
    string_value,
    string_sequence,
)
from .policy import (
    ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS,
    ACCEPTED_LEDGER_PNL_BASES,
    ACCEPTED_LEDGER_PNL_SOURCES,
    ACCEPTED_MARKET_IMPACT_STRESS_MODELS,
)


@dataclass(frozen=True)
class _FillSurvivalRequirements:
    fill_survival_evidence: bool
    queue_position_survival_evidence: bool
    queue_ahead_depletion_evidence: bool


def append_shadow_and_executable_checks(ctx: OracleEvaluationContext) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
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
    executable_passed = boolish(scorecard.get("executable_replay_passed"))
    executable_order_count = nonnegative_int(
        scorecard.get("executable_replay_order_count")
        or scorecard.get("executable_replay_submitted_order_count")
        or scorecard.get("executable_replay_orders_submitted_total")
    )
    executable_buying_power = decimal_value(
        scorecard.get("executable_replay_account_buying_power")
        or scorecard.get("executable_replay_buying_power")
    )
    executable_max_notional = decimal_value(
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
        numeric_check(
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
            numeric_check(
                metric="executable_replay_account_buying_power",
                observed=executable_buying_power,
                operator="gt",
                threshold=Decimal("0"),
            )
        )
        checks.append(
            numeric_check(
                metric="executable_replay_max_notional_per_trade",
                observed=executable_max_notional,
                operator="gt",
                threshold=Decimal("0"),
            )
        )
        checks.append(
            numeric_check(
                metric="executable_replay_notional_within_buying_power",
                observed=executable_max_notional,
                operator="lte",
                threshold=executable_buying_power,
            )
        )


def append_exact_replay_ledger_checks(ctx: OracleEvaluationContext) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    portfolio_post_cost_net_pnl_basis = ctx.portfolio_post_cost_net_pnl_basis
    portfolio_post_cost_net_pnl_source = ctx.portfolio_post_cost_net_pnl_source
    exact_replay_ledger_artifact_refs = artifact_refs(
        scorecard,
        "exact_replay_ledger_artifact_ref",
        "exact_replay_ledger_artifact_refs",
    )
    exact_replay_ledger_artifact_present = bool(exact_replay_ledger_artifact_refs)
    exact_replay_ledger_row_count = nonnegative_int(
        scorecard.get("exact_replay_ledger_artifact_row_count")
    )
    exact_replay_ledger_fill_count = nonnegative_int(
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
            numeric_check(
                metric="exact_replay_ledger_artifact_row_count",
                observed=Decimal(exact_replay_ledger_row_count),
                operator="gte",
                threshold=Decimal(max(0, policy.min_exact_replay_ledger_row_count))
                if policy.require_exact_replay_ledger
                else Decimal("0"),
            ),
            numeric_check(
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
                "threshold": sorted(ACCEPTED_LEDGER_PNL_BASES),
                "source_marker": "exact_replay_ledger_probation_gate",
                "passed": (
                    portfolio_post_cost_net_pnl_basis in ACCEPTED_LEDGER_PNL_BASES
                )
                if policy.require_exact_replay_ledger
                else True,
            },
            {
                "metric": "portfolio_post_cost_net_pnl_source",
                "observed": portfolio_post_cost_net_pnl_source,
                "operator": "in",
                "threshold": sorted(ACCEPTED_LEDGER_PNL_SOURCES),
                "source_marker": "exact_replay_ledger_probation_gate",
                "passed": (
                    portfolio_post_cost_net_pnl_source in ACCEPTED_LEDGER_PNL_SOURCES
                )
                if policy.require_exact_replay_ledger
                else True,
            },
        )
    )


def append_market_impact_checks(ctx: OracleEvaluationContext) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    target_net_pnl_per_day = ctx.target_net_pnl_per_day
    market_impact_artifact_refs = artifact_refs(
        scorecard,
        "market_impact_stress_artifact_ref",
        "market_impact_stress_artifact_refs",
        "impact_stress_artifact_ref",
        "cost_shock_artifact_ref",
    )
    market_impact_artifact_present = bool(market_impact_artifact_refs)
    market_impact_passed = boolish(
        scorecard.get("market_impact_stress_passed")
        or scorecard.get("cost_shock_stress_passed")
        or scorecard.get("nonlinear_market_impact_stress_passed")
    )
    market_impact_model = string_value(
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
    market_impact_liquidity_evidence_present = boolish(
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
            "threshold": sorted(ACCEPTED_MARKET_IMPACT_STRESS_MODELS),
            "source_marker": "order_flow_market_impact_arxiv_2601_23172_2026",
            "passed": (market_impact_model in ACCEPTED_MARKET_IMPACT_STRESS_MODELS)
            if policy.require_market_impact_stress
            else True,
        }
    )
    checks.append(
        numeric_check(
            metric="market_impact_stress_cost_bps",
            observed=decimal_value(
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
    market_impact_net_pnl = decimal_value(
        scorecard.get("market_impact_stress_net_pnl_per_day")
        or scorecard.get("post_impact_net_pnl_per_day")
        or scorecard.get("cost_shock_net_pnl_per_day")
    )
    market_impact_net_check = numeric_check(
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


def append_delay_depth_checks(ctx: OracleEvaluationContext) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    delay_depth_artifact_refs = artifact_refs(
        scorecard,
        "delay_adjusted_depth_stress_artifact_ref",
        "delay_adjusted_depth_stress_artifact_refs",
        "delay_depth_stress_artifact_ref",
        "latency_depth_stress_artifact_ref",
    )
    delay_depth_artifact_present = bool(delay_depth_artifact_refs)
    delay_depth_passed = boolish(
        scorecard.get("delay_adjusted_depth_stress_passed")
        or scorecard.get("delay_depth_stress_passed")
        or scorecard.get("latency_depth_stress_passed")
    )
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
    delay_depth_liquidity_evidence_present = boolish(
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
        numeric_check(
            metric="delay_adjusted_depth_liquidity_missing_day_count",
            observed=decimal_value(
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
    delay_depth_latency_grid_ms = string_sequence(
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
        numeric_check(
            metric="delay_adjusted_depth_grid_max_stress_ms",
            observed=decimal_value(
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
    delay_depth_tail_coverage_passed = boolish(
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


def _fill_survival_requirements(
    ctx: OracleEvaluationContext,
) -> _FillSurvivalRequirements:
    policy = ctx.policy
    require_fill_survival_evidence = (
        policy.require_delay_adjusted_depth_stress
        and policy.require_fill_survival_evidence
    )
    return _FillSurvivalRequirements(
        fill_survival_evidence=require_fill_survival_evidence,
        queue_position_survival_evidence=(
            require_fill_survival_evidence
            and policy.require_queue_position_survival_evidence
        ),
        queue_ahead_depletion_evidence=(
            require_fill_survival_evidence
            and policy.require_queue_ahead_depletion_evidence
        ),
    )


def _delay_depth_model(ctx: OracleEvaluationContext) -> str:
    scorecard = ctx.scorecard
    return string_value(
        scorecard.get("delay_adjusted_depth_stress_model")
        or scorecard.get("delay_depth_stress_model")
        or scorecard.get("latency_depth_stress_model")
    ).lower()


def _append_queue_survival_checks(
    ctx: OracleEvaluationContext,
    requirements: _FillSurvivalRequirements,
) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    queue_position_survival_evidence_present = boolish(
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
            if requirements.queue_position_survival_evidence
            else True,
        }
    )
    queue_ahead_depletion_evidence_present = boolish(
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
            if requirements.queue_ahead_depletion_evidence
            else True,
        }
    )
    queue_ahead_depletion_sample_count = max(
        nonnegative_int(
            scorecard.get("queue_position_survival_queue_ahead_depletion_sample_count")
        ),
        nonnegative_int(
            scorecard.get("delay_adjusted_depth_queue_ahead_depletion_sample_count")
        ),
        nonnegative_int(scorecard.get("queue_ahead_depletion_sample_count")),
    )
    queue_ahead_depletion_sample_check = numeric_check(
        metric="queue_ahead_depletion_sample_count",
        observed=Decimal(queue_ahead_depletion_sample_count),
        operator="gte",
        threshold=Decimal(policy.min_queue_ahead_depletion_sample_count),
    )
    if not requirements.queue_ahead_depletion_evidence:
        queue_ahead_depletion_sample_check["passed"] = True
    checks.append(
        {
            **queue_ahead_depletion_sample_check,
            "source_marker": "deep_queue_reactive_arxiv_2501_08822_2025",
        }
    )


def _append_fill_survival_evidence_checks(
    ctx: OracleEvaluationContext,
    requirements: _FillSurvivalRequirements,
) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    fill_survival_evidence_present = boolish(
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
            if requirements.fill_survival_evidence
            else True,
        }
    )
    fill_survival_sample_count = max(
        nonnegative_int(scorecard.get("queue_position_survival_sample_count")),
        nonnegative_int(
            scorecard.get("delay_adjusted_depth_fill_survival_sample_count")
        ),
        nonnegative_int(scorecard.get("fill_survival_sample_count")),
    )
    fill_survival_sample_check = numeric_check(
        metric="fill_survival_sample_count",
        observed=Decimal(fill_survival_sample_count),
        operator="gte",
        threshold=Decimal(policy.min_fill_survival_sample_count),
    )
    if not requirements.fill_survival_evidence:
        fill_survival_sample_check["passed"] = True
    checks.append(
        {
            **fill_survival_sample_check,
            "source_marker": "kanformer_fill_survival_arxiv_2512_05734_2025",
        }
    )
    fill_survival_rate = max(
        decimal_value(scorecard.get("queue_position_survival_fill_rate")),
        decimal_value(scorecard.get("delay_adjusted_depth_fill_survival_rate")),
        decimal_value(scorecard.get("fill_survival_fill_rate")),
        decimal_value(scorecard.get("fill_survival_rate")),
    )
    fill_survival_rate_check = numeric_check(
        metric="fill_survival_rate",
        observed=fill_survival_rate,
        operator="gt",
        threshold=policy.min_fill_survival_rate,
    )
    if not requirements.fill_survival_evidence:
        fill_survival_rate_check["passed"] = True
    checks.append(
        {
            **fill_survival_rate_check,
            "source_marker": "kanformer_fill_survival_arxiv_2512_05734_2025",
        }
    )


def _append_delay_depth_tail_checks(
    ctx: OracleEvaluationContext,
    *,
    delay_depth_model: str,
) -> None:
    scorecard = ctx.scorecard
    policy = ctx.policy
    checks = ctx.checks
    target_net_pnl_per_day = ctx.target_net_pnl_per_day
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
            numeric_check(
                metric=metric_name,
                observed=max((decimal_value(scorecard.get(key)) for key in keys)),
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
            "threshold": sorted(ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS),
            "source_marker": "latency_execution_policy_arxiv_2504_00846_2025",
            "passed": (delay_depth_model in ACCEPTED_DELAY_ADJUSTED_DEPTH_STRESS_MODELS)
            if policy.require_delay_adjusted_depth_stress
            else True,
        }
    )
    checks.append(
        numeric_check(
            metric="delay_adjusted_depth_stress_ms",
            observed=decimal_value(
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
        numeric_check(
            metric="delay_adjusted_depth_fillable_notional_per_day",
            observed=decimal_value(
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
    delay_depth_net_pnl = decimal_value(
        scorecard.get("delay_adjusted_depth_stress_net_pnl_per_day")
        or scorecard.get("delay_depth_stress_net_pnl_per_day")
        or scorecard.get("latency_depth_stress_net_pnl_per_day")
    )
    delay_depth_net_check = numeric_check(
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


def append_fill_survival_checks(ctx: OracleEvaluationContext) -> None:
    requirements = _fill_survival_requirements(ctx)
    _append_queue_survival_checks(ctx, requirements)
    _append_fill_survival_evidence_checks(ctx, requirements)
    _append_delay_depth_tail_checks(ctx, delay_depth_model=_delay_depth_model(ctx))
