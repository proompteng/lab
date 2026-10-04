#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
from dataclasses import replace
from decimal import Decimal
from typing import Any, Mapping, Sequence


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.candidate_specs import candidate_spec_id_for_payload
from app.trading.discovery.profit_target_oracle import (
    ProfitTargetOraclePolicy,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _decimal,
)

from scripts.whitepaper_autoresearch_runner.next_epoch_planning import (
    _int_arg,
)

_DEFAULT_DAILY_PROFIT_TARGET = "500"


def _scorecard_start_equity(
    scorecard: Mapping[str, Any], *, oracle_policy: ProfitTargetOraclePolicy
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
    return oracle_policy.default_start_equity


def _scorecard_total_net_pnl(scorecard: Mapping[str, Any]) -> Decimal:
    daily_net_payload = scorecard.get("daily_net")
    if isinstance(daily_net_payload, Mapping) and daily_net_payload:
        return sum(
            (_decimal(value) for value in daily_net_payload.values()), Decimal("0")
        )
    net_pnl_per_day = _decimal(scorecard.get("net_pnl_per_day"))
    trading_day_count = max(1, int(_decimal(scorecard.get("trading_day_count"))))
    return net_pnl_per_day * Decimal(trading_day_count)


def _scorecard_profit_factor(scorecard: Mapping[str, Any]) -> Decimal:
    explicit = scorecard.get("profit_factor")
    if explicit is not None:
        return _decimal(explicit)
    daily_net_payload = scorecard.get("daily_net")
    if isinstance(daily_net_payload, Mapping) and daily_net_payload:
        positive_total = sum(
            (
                _decimal(value)
                for value in daily_net_payload.values()
                if _decimal(value) > 0
            ),
            Decimal("0"),
        )
        negative_total = sum(
            (
                -_decimal(value)
                for value in daily_net_payload.values()
                if _decimal(value) < 0
            ),
            Decimal("0"),
        )
        if negative_total > 0:
            return positive_total / negative_total
        return Decimal("999999999") if positive_total > 0 else Decimal("0")
    if (
        _scorecard_total_net_pnl(scorecard) > 0
        and _decimal(scorecard.get("worst_day_loss")) <= 0
    ):
        return Decimal("999999999")
    return Decimal("0")


def _risk_adjusted_drawdown_passes(
    *,
    observed: Decimal,
    start_equity: Decimal,
    normal_pct: Decimal,
    extended_pct: Decimal,
    absolute_cap: Decimal,
    total_net_pnl: Decimal,
    min_total_net_pnl_to_drawdown_ratio: Decimal,
) -> bool:
    normal_limit = max(Decimal("0"), start_equity * normal_pct)
    percent_limit = max(normal_limit, start_equity * extended_pct)
    extended_limit = (
        percent_limit if absolute_cap <= 0 else min(absolute_cap, percent_limit)
    )
    if observed <= normal_limit:
        return True
    if observed <= extended_limit and observed > 0:
        return (total_net_pnl / observed) >= min_total_net_pnl_to_drawdown_ratio
    return observed <= extended_limit


def _oracle_policy_from_args(args: argparse.Namespace) -> ProfitTargetOraclePolicy:
    target_net_pnl_per_day = _decimal(
        getattr(args, "target_net_pnl_per_day", _DEFAULT_DAILY_PROFIT_TARGET),
        default=_DEFAULT_DAILY_PROFIT_TARGET,
    )
    min_active_day_ratio = _decimal(
        getattr(args, "min_active_day_ratio", "0.90"), default="0.90"
    )
    min_positive_day_ratio = _decimal(
        getattr(args, "min_positive_day_ratio", "0.60"), default="0.60"
    )
    min_daily_net_pnl = _decimal(
        getattr(args, "min_daily_net_pnl", "-999999999"),
        default="-999999999",
    )
    max_worst_day_loss = _decimal(
        getattr(args, "max_worst_day_loss", "999999999"), default="999999999"
    )
    max_drawdown = _decimal(
        getattr(args, "max_drawdown", "999999999"), default="999999999"
    )
    if bool(getattr(args, "require_no_flat_days", False)):
        min_active_day_ratio = max(min_active_day_ratio, Decimal("1"))
        min_positive_day_ratio = max(min_positive_day_ratio, Decimal("1"))
        min_daily_net_pnl = max(min_daily_net_pnl, target_net_pnl_per_day)
        max_worst_day_loss = min(max_worst_day_loss, Decimal("0"))
        max_drawdown = min(max_drawdown, Decimal("0"))
    return ProfitTargetOraclePolicy(
        min_active_day_ratio=min_active_day_ratio,
        min_positive_day_ratio=min_positive_day_ratio,
        min_profit_factor=_decimal(
            getattr(args, "min_profit_factor", "1.50"), default="1.50"
        ),
        min_daily_net_pnl=min_daily_net_pnl,
        max_worst_day_loss=max_worst_day_loss,
        max_drawdown=max_drawdown,
        max_best_day_share=_decimal(
            getattr(args, "max_best_day_share", "0.25"), default="0.25"
        ),
        max_cluster_contribution_share=_decimal(
            getattr(args, "max_cluster_contribution_share", "0.40"), default="0.40"
        ),
        max_single_symbol_contribution_share=_decimal(
            getattr(args, "max_single_symbol_contribution_share", "0.35"),
            default="0.35",
        ),
        min_avg_filled_notional_per_day=_decimal(
            getattr(args, "min_avg_filled_notional_per_day", "300000"),
            default="300000",
        ),
        min_observed_trading_days=max(
            0, _int_arg(args, "min_observed_trading_days", 20)
        ),
        min_regime_slice_pass_rate=_decimal(
            getattr(args, "min_regime_slice_pass_rate", "0.45"), default="0.45"
        ),
        default_start_equity=_decimal(
            getattr(args, "start_equity", "31590.02"), default="31590.02"
        ),
        max_worst_day_loss_pct_equity=_decimal(
            getattr(args, "max_worst_day_loss_pct_equity", "0.05"), default="0.05"
        ),
        max_drawdown_pct_equity=_decimal(
            getattr(args, "max_drawdown_pct_equity", "0.08"), default="0.08"
        ),
        extended_max_worst_day_loss_pct_equity=_decimal(
            getattr(args, "extended_max_worst_day_loss_pct_equity", "0.08"),
            default="0.08",
        ),
        extended_max_drawdown_pct_equity=_decimal(
            getattr(args, "extended_max_drawdown_pct_equity", "0.12"),
            default="0.12",
        ),
        min_total_net_pnl_to_drawdown_ratio=_decimal(
            getattr(args, "min_total_net_pnl_to_drawdown_ratio", "3.00"),
            default="3.00",
        ),
        max_gross_exposure_pct_equity=_decimal(
            getattr(args, "max_gross_exposure_pct_equity", "1.0"), default="1.0"
        ),
        min_cash=_decimal(getattr(args, "min_cash", "0"), default="0"),
        max_negative_cash_observation_count=max(
            0, _int_arg(args, "max_negative_cash_observation_count", 0)
        ),
        require_double_oos=not bool(getattr(args, "no_require_double_oos", False)),
        min_double_oos_independent_window_count=max(
            0, _int_arg(args, "min_double_oos_independent_window_count", 2)
        ),
        min_double_oos_pass_rate=_decimal(
            getattr(args, "min_double_oos_pass_rate", "1.00"), default="1.00"
        ),
    )


def _candidate_spec_with_oracle_policy(
    spec: CandidateSpec, *, oracle_policy: ProfitTargetOraclePolicy
) -> CandidateSpec:
    objective = {
        **dict(spec.objective),
        "require_positive_day_ratio": str(oracle_policy.min_positive_day_ratio),
        "require_profit_factor": str(oracle_policy.min_profit_factor),
    }
    hard_vetoes = {
        **dict(spec.hard_vetoes),
        "required_min_active_day_ratio": str(oracle_policy.min_active_day_ratio),
        "required_min_daily_notional": str(
            oracle_policy.min_avg_filled_notional_per_day
        ),
        "required_min_observed_trading_days": str(
            oracle_policy.min_observed_trading_days
        ),
        "required_max_best_day_share": str(oracle_policy.max_best_day_share),
        "required_min_profit_factor": str(oracle_policy.min_profit_factor),
        "required_max_worst_day_loss": str(oracle_policy.max_worst_day_loss),
        "required_max_drawdown": str(oracle_policy.max_drawdown),
        "required_max_gross_exposure_pct_equity": str(
            oracle_policy.max_gross_exposure_pct_equity
        ),
        "required_min_cash": str(oracle_policy.min_cash),
        "required_max_negative_cash_observation_count": str(
            oracle_policy.max_negative_cash_observation_count
        ),
        "required_max_worst_day_loss_pct_equity": str(
            oracle_policy.max_worst_day_loss_pct_equity
        ),
        "required_max_drawdown_pct_equity": str(oracle_policy.max_drawdown_pct_equity),
        "required_extended_max_worst_day_loss_pct_equity": str(
            oracle_policy.extended_max_worst_day_loss_pct_equity
        ),
        "required_extended_max_drawdown_pct_equity": str(
            oracle_policy.extended_max_drawdown_pct_equity
        ),
        "required_min_total_net_pnl_to_drawdown_ratio": str(
            oracle_policy.min_total_net_pnl_to_drawdown_ratio
        ),
        "required_min_regime_slice_pass_rate": str(
            oracle_policy.min_regime_slice_pass_rate
        ),
    }
    base_payload = {
        "hypothesis_id": spec.hypothesis_id,
        "family_template_id": spec.family_template_id,
        "feature_contract": dict(spec.feature_contract),
        "objective": objective,
    }
    return replace(
        spec,
        candidate_spec_id=candidate_spec_id_for_payload(base_payload),
        objective=objective,
        hard_vetoes=hard_vetoes,
        promotion_contract={
            **dict(spec.promotion_contract),
            "profit_target_oracle_policy": oracle_policy.to_payload(),
        },
    )


def _candidate_specs_with_oracle_policy(
    specs: Sequence[CandidateSpec], *, oracle_policy: ProfitTargetOraclePolicy
) -> list[CandidateSpec]:
    return [
        _candidate_spec_with_oracle_policy(spec, oracle_policy=oracle_policy)
        for spec in specs
    ]


__all__ = [
    "_scorecard_start_equity",
    "_scorecard_total_net_pnl",
    "_scorecard_profit_factor",
    "_risk_adjusted_drawdown_passes",
    "_oracle_policy_from_args",
    "_candidate_spec_with_oracle_policy",
    "_candidate_specs_with_oracle_policy",
]
