"""Profit-target oracle evaluation orchestration."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping

from .context import build_oracle_context
from .execution_checks import (
    append_delay_depth_checks,
    append_exact_replay_ledger_checks,
    append_fill_survival_checks,
    append_market_impact_checks,
    append_shadow_and_executable_checks,
)
from .policy import ProfitTargetOraclePolicy
from .research_checks import (
    append_mpc_schedule_checks,
    append_order_type_execution_checks,
    append_predictability_decay_checks,
    append_uncertainty_and_tail_risk_checks,
)
from .validation_checks import (
    append_double_oos_checks,
    append_rejected_signal_learning_checks,
    build_oracle_result,
)


def evaluate_profit_target_oracle(
    scorecard: Mapping[str, Any],
    *,
    target_net_pnl_per_day: Decimal,
    policy: ProfitTargetOraclePolicy | None = None,
) -> dict[str, Any]:
    """Evaluate the doc 71 production objective criteria against a scorecard."""

    ctx = build_oracle_context(
        scorecard=scorecard,
        target_net_pnl_per_day=target_net_pnl_per_day,
        policy=policy,
    )
    append_shadow_and_executable_checks(ctx)
    append_exact_replay_ledger_checks(ctx)
    append_market_impact_checks(ctx)
    append_delay_depth_checks(ctx)
    append_fill_survival_checks(ctx)
    append_uncertainty_and_tail_risk_checks(ctx)
    append_predictability_decay_checks(ctx)
    append_order_type_execution_checks(ctx)
    append_mpc_schedule_checks(ctx)
    append_double_oos_checks(ctx)
    append_rejected_signal_learning_checks(ctx)
    return build_oracle_result(ctx)
