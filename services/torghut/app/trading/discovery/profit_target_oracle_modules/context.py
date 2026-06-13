"""Evaluation context construction for the profit-target oracle."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping, cast

from .parsing import (
    RiskAdjustedDrawdownInputs,
    TargetImpliedNotionalInputs,
    decimal_value,
    first_normalized_scorecard_text,
    numeric_check,
    nonnegative_int,
    profit_factor,
    risk_adjusted_drawdown_check,
    start_equity,
    target_implied_notional_gate_payload,
    total_net_pnl,
)
from .policy import (
    ACCEPTED_LEDGER_PNL_BASES,
    ACCEPTED_LEDGER_PNL_SOURCES,
    ProfitTargetOraclePolicy,
)


@dataclass
class OracleEvaluationContext:
    scorecard: Mapping[str, Any]
    target_net_pnl_per_day: Decimal
    policy: ProfitTargetOraclePolicy
    net_pnl: Decimal
    trading_day_count: int
    start_equity: Decimal
    total_net_pnl: Decimal
    worst_day_loss: Decimal
    profit_factor: Decimal
    portfolio_post_cost_net_pnl_basis: str
    portfolio_post_cost_net_pnl_source: str
    target_implied_notional_gate: dict[str, Any]
    effective_min_avg_filled_notional_per_day: Decimal
    observed_post_cost_expectancy_bps: Decimal
    checks: list[dict[str, Any]]


@dataclass(frozen=True)
class _DailyNetSummary:
    values: Mapping[str, Any] | None
    min_net_pnl: Decimal
    observed_day_count: int
    trading_day_count: int


@dataclass(frozen=True)
class _RiskReturnMetrics:
    start_equity: Decimal
    total_net_pnl: Decimal
    worst_day_loss: Decimal
    profit_factor: Decimal


@dataclass(frozen=True)
class _PostCostPnlAuthority:
    basis: str
    source: str


@dataclass(frozen=True)
class _CoreOracleCheckInputs:
    scorecard: Mapping[str, Any]
    target_net_pnl_per_day: Decimal
    policy: ProfitTargetOraclePolicy
    net_pnl: Decimal
    daily_net: _DailyNetSummary
    risk: _RiskReturnMetrics
    target_implied_notional_gate: dict[str, Any]
    effective_min_avg_filled_notional_per_day: Decimal
    observed_post_cost_expectancy_bps: Decimal


def _daily_net_summary(
    *,
    scorecard: Mapping[str, Any],
    policy: ProfitTargetOraclePolicy,
) -> _DailyNetSummary:
    daily_net_payload = scorecard.get("daily_net")
    if isinstance(daily_net_payload, Mapping) and daily_net_payload:
        daily_net = cast(Mapping[str, Any], daily_net_payload)
        min_daily_net_pnl = min(decimal_value(value) for value in daily_net.values())
        observed_day_count = len(daily_net)
    else:
        daily_net = None
        min_daily_net_pnl = Decimal("0")
        observed_day_count = 0

    trading_day_count = max(
        observed_day_count,
        nonnegative_int(
            scorecard.get("trading_day_count"),
            default=observed_day_count,
        ),
    )
    if policy.min_daily_net_pnl > 0 and observed_day_count < trading_day_count:
        min_daily_net_pnl = min(min_daily_net_pnl, Decimal("0"))
    return _DailyNetSummary(
        values=daily_net,
        min_net_pnl=min_daily_net_pnl,
        observed_day_count=observed_day_count,
        trading_day_count=trading_day_count,
    )


def _risk_return_metrics(
    *,
    scorecard: Mapping[str, Any],
    policy: ProfitTargetOraclePolicy,
    daily_net: _DailyNetSummary,
    net_pnl: Decimal,
) -> _RiskReturnMetrics:
    start_equity_value = start_equity(scorecard, policy)
    total_net_pnl_value = total_net_pnl(
        daily_net=daily_net.values,
        net_pnl_per_day=net_pnl,
        trading_day_count=daily_net.trading_day_count,
    )
    worst_day_loss = decimal_value(scorecard.get("worst_day_loss"))
    return _RiskReturnMetrics(
        start_equity=start_equity_value,
        total_net_pnl=total_net_pnl_value,
        worst_day_loss=worst_day_loss,
        profit_factor=profit_factor(
            scorecard,
            daily_net=daily_net.values,
            total_net_pnl=total_net_pnl_value,
            worst_day_loss=worst_day_loss,
        ),
    )


def _post_cost_pnl_authority(scorecard: Mapping[str, Any]) -> _PostCostPnlAuthority:
    return _PostCostPnlAuthority(
        basis=first_normalized_scorecard_text(
            scorecard,
            "portfolio_post_cost_net_pnl_basis",
            "portfolio_post_cost_net_pnl_per_day_basis",
            "post_cost_net_pnl_basis",
            "net_pnl_basis",
            "runtime_ledger_pnl_basis",
            "exact_replay_ledger_pnl_basis",
            "post_cost_expectancy_basis",
            "pnl_basis",
        ),
        source=first_normalized_scorecard_text(
            scorecard,
            "portfolio_post_cost_net_pnl_source",
            "portfolio_post_cost_net_pnl_per_day_source",
            "post_cost_net_pnl_source",
            "net_pnl_source",
            "runtime_ledger_pnl_source",
            "exact_replay_ledger_pnl_source",
            "post_cost_expectancy_source",
            "pnl_source",
        ),
    )


def _core_oracle_checks(inputs: _CoreOracleCheckInputs) -> list[dict[str, Any]]:
    scorecard = inputs.scorecard
    target_net_pnl_per_day = inputs.target_net_pnl_per_day
    policy = inputs.policy
    net_pnl = inputs.net_pnl
    daily_net = inputs.daily_net
    risk = inputs.risk
    target_implied_notional_gate = inputs.target_implied_notional_gate
    effective_min_avg_filled_notional_per_day = (
        inputs.effective_min_avg_filled_notional_per_day
    )
    observed_post_cost_expectancy_bps = inputs.observed_post_cost_expectancy_bps
    return [
        numeric_check(
            metric="portfolio_post_cost_net_pnl_per_day",
            observed=net_pnl,
            operator="gte",
            threshold=target_net_pnl_per_day,
        ),
        numeric_check(
            metric="active_day_ratio",
            observed=decimal_value(scorecard.get("active_day_ratio")),
            operator="gte",
            threshold=policy.min_active_day_ratio,
        ),
        numeric_check(
            metric="positive_day_ratio",
            observed=decimal_value(scorecard.get("positive_day_ratio")),
            operator="gte",
            threshold=policy.min_positive_day_ratio,
        ),
        numeric_check(
            metric="profit_factor",
            observed=risk.profit_factor,
            operator="gte",
            threshold=policy.min_profit_factor,
        ),
        numeric_check(
            metric="min_daily_net_pnl",
            observed=daily_net.min_net_pnl,
            operator="gte",
            threshold=policy.min_daily_net_pnl,
        ),
        numeric_check(
            metric="daily_net_observed_day_count",
            observed=Decimal(daily_net.observed_day_count),
            operator="gte",
            threshold=Decimal(daily_net.trading_day_count),
        ),
        numeric_check(
            metric="min_observed_trading_days",
            observed=Decimal(daily_net.observed_day_count),
            operator="gte",
            threshold=Decimal(max(0, policy.min_observed_trading_days)),
        ),
        numeric_check(
            metric="missing_sleeve_daily_net_count",
            observed=Decimal(
                nonnegative_int(scorecard.get("missing_sleeve_daily_net_count"))
            ),
            operator="lte",
            threshold=Decimal(max(0, policy.max_missing_sleeve_daily_net_count)),
        ),
        numeric_check(
            metric="validation_contract_pending_count",
            observed=Decimal(
                nonnegative_int(scorecard.get("validation_contract_pending_count"))
            ),
            operator="lte",
            threshold=Decimal(max(0, policy.max_validation_contract_pending_count)),
        ),
        numeric_check(
            metric="validation_live_paper_parity_pending_count",
            observed=Decimal(
                nonnegative_int(
                    scorecard.get("validation_live_paper_parity_pending_count")
                )
            ),
            operator="lte",
            threshold=Decimal(
                max(0, policy.max_validation_live_paper_parity_pending_count)
            ),
        ),
        numeric_check(
            metric="synthetic_evidence_not_promotion_proof_count",
            observed=Decimal(
                nonnegative_int(
                    scorecard.get("synthetic_evidence_not_promotion_proof_count")
                )
            ),
            operator="lte",
            threshold=Decimal(
                max(0, policy.max_synthetic_evidence_not_promotion_proof_count)
            ),
        ),
        numeric_check(
            metric="best_day_share",
            observed=decimal_value(scorecard.get("best_day_share")),
            operator="lte",
            threshold=policy.max_best_day_share,
        ),
        numeric_check(
            metric="max_single_day_contribution_share",
            observed=decimal_value(
                scorecard.get("max_single_day_contribution_share")
                or scorecard.get("best_day_share")
            ),
            operator="lte",
            threshold=policy.max_best_day_share,
        ),
        numeric_check(
            metric="max_cluster_contribution_share",
            observed=decimal_value(
                scorecard.get("max_cluster_contribution_share"), default="1"
            ),
            operator="lte",
            threshold=policy.max_cluster_contribution_share,
        ),
        numeric_check(
            metric="max_single_symbol_contribution_share",
            observed=decimal_value(
                scorecard.get("max_single_symbol_contribution_share"), default="1"
            ),
            operator="lte",
            threshold=policy.max_single_symbol_contribution_share,
        ),
        risk_adjusted_drawdown_check(
            RiskAdjustedDrawdownInputs(
                metric="worst_day_loss",
                observed=risk.worst_day_loss,
                start_equity=risk.start_equity,
                normal_pct=policy.max_worst_day_loss_pct_equity,
                extended_pct=policy.extended_max_worst_day_loss_pct_equity,
                total_net_pnl=risk.total_net_pnl,
                min_total_net_pnl_to_drawdown_ratio=policy.min_total_net_pnl_to_drawdown_ratio,
                absolute_cap=policy.max_worst_day_loss,
            )
        ),
        risk_adjusted_drawdown_check(
            RiskAdjustedDrawdownInputs(
                metric="max_drawdown",
                observed=decimal_value(scorecard.get("max_drawdown")),
                start_equity=risk.start_equity,
                normal_pct=policy.max_drawdown_pct_equity,
                extended_pct=policy.extended_max_drawdown_pct_equity,
                total_net_pnl=risk.total_net_pnl,
                min_total_net_pnl_to_drawdown_ratio=policy.min_total_net_pnl_to_drawdown_ratio,
                absolute_cap=policy.max_drawdown,
            )
        ),
        numeric_check(
            metric="max_gross_exposure_pct_equity",
            observed=decimal_value(scorecard.get("max_gross_exposure_pct_equity")),
            operator="lte",
            threshold=policy.max_gross_exposure_pct_equity,
        ),
        numeric_check(
            metric="min_cash",
            observed=decimal_value(
                scorecard.get("min_cash"), default=str(policy.min_cash)
            ),
            operator="gte",
            threshold=policy.min_cash,
        ),
        numeric_check(
            metric="negative_cash_observation_count",
            observed=Decimal(
                nonnegative_int(scorecard.get("negative_cash_observation_count"))
            ),
            operator="lte",
            threshold=Decimal(max(0, policy.max_negative_cash_observation_count)),
        ),
        numeric_check(
            metric="avg_filled_notional_per_day",
            observed=decimal_value(scorecard.get("avg_filled_notional_per_day")),
            operator="gte",
            threshold=effective_min_avg_filled_notional_per_day,
        ),
        {
            "metric": "target_implied_post_cost_pnl_basis",
            "observed": target_implied_notional_gate["post_cost_pnl_basis"],
            "operator": "in",
            "threshold": sorted(ACCEPTED_LEDGER_PNL_BASES),
            "source_marker": "target_implied_discovery_notional_gate",
            "passed": bool(target_implied_notional_gate["post_cost_basis_accepted"]),
        },
        {
            "metric": "target_implied_post_cost_pnl_source",
            "observed": target_implied_notional_gate["post_cost_pnl_source"],
            "operator": "in",
            "threshold": sorted(ACCEPTED_LEDGER_PNL_SOURCES),
            "source_marker": "target_implied_discovery_notional_gate",
            "passed": bool(target_implied_notional_gate["post_cost_source_accepted"]),
        },
        numeric_check(
            metric="target_implied_avg_filled_notional_per_day",
            observed=decimal_value(
                target_implied_notional_gate.get("avg_filled_notional_per_day")
            ),
            operator="gt",
            threshold=Decimal("0"),
        ),
        numeric_check(
            metric="target_implied_post_cost_expectancy_bps",
            observed=observed_post_cost_expectancy_bps,
            operator="gt",
            threshold=Decimal("0"),
        ),
        numeric_check(
            metric="regime_slice_pass_rate",
            observed=decimal_value(scorecard.get("regime_slice_pass_rate")),
            operator="gte",
            threshold=policy.min_regime_slice_pass_rate,
        ),
        numeric_check(
            metric="posterior_edge_lower",
            observed=decimal_value(scorecard.get("posterior_edge_lower")),
            operator="gt",
            threshold=policy.min_posterior_edge_lower,
        ),
    ]


def build_oracle_context(
    *,
    scorecard: Mapping[str, Any],
    target_net_pnl_per_day: Decimal,
    policy: ProfitTargetOraclePolicy | None,
) -> OracleEvaluationContext:
    policy = policy or ProfitTargetOraclePolicy()
    net_pnl = decimal_value(
        scorecard.get("portfolio_post_cost_net_pnl_per_day")
        or scorecard.get("net_pnl_per_day")
    )
    daily_net = _daily_net_summary(scorecard=scorecard, policy=policy)
    risk = _risk_return_metrics(
        scorecard=scorecard,
        policy=policy,
        daily_net=daily_net,
        net_pnl=net_pnl,
    )
    post_cost_pnl_authority = _post_cost_pnl_authority(scorecard)
    target_implied_notional_gate = target_implied_notional_gate_payload(
        TargetImpliedNotionalInputs(
            scorecard=scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            baseline_min_avg_filled_notional_per_day=policy.min_avg_filled_notional_per_day,
            post_cost_net_pnl_per_day=net_pnl,
            post_cost_pnl_basis=post_cost_pnl_authority.basis,
            post_cost_pnl_source=post_cost_pnl_authority.source,
        )
    )
    effective_min_avg_filled_notional_per_day = decimal_value(
        target_implied_notional_gate.get("effective_min_avg_filled_notional_per_day"),
        default=str(policy.min_avg_filled_notional_per_day),
    )
    observed_post_cost_expectancy_bps = decimal_value(
        target_implied_notional_gate.get("observed_post_cost_expectancy_bps")
    )
    checks = _core_oracle_checks(
        _CoreOracleCheckInputs(
            scorecard=scorecard,
            target_net_pnl_per_day=target_net_pnl_per_day,
            policy=policy,
            net_pnl=net_pnl,
            daily_net=daily_net,
            risk=risk,
            target_implied_notional_gate=target_implied_notional_gate,
            effective_min_avg_filled_notional_per_day=effective_min_avg_filled_notional_per_day,
            observed_post_cost_expectancy_bps=observed_post_cost_expectancy_bps,
        )
    )

    return OracleEvaluationContext(
        scorecard=scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        policy=policy,
        net_pnl=net_pnl,
        trading_day_count=daily_net.trading_day_count,
        start_equity=risk.start_equity,
        total_net_pnl=risk.total_net_pnl,
        worst_day_loss=risk.worst_day_loss,
        profit_factor=risk.profit_factor,
        portfolio_post_cost_net_pnl_basis=post_cost_pnl_authority.basis,
        portfolio_post_cost_net_pnl_source=post_cost_pnl_authority.source,
        target_implied_notional_gate=target_implied_notional_gate,
        effective_min_avg_filled_notional_per_day=effective_min_avg_filled_notional_per_day,
        observed_post_cost_expectancy_bps=observed_post_cost_expectancy_bps,
        checks=checks,
    )
