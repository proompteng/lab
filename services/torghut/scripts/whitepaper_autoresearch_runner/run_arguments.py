#!/usr/bin/env python3
"""Argument normalization for whitepaper autoresearch runs."""

from __future__ import annotations

import argparse
from typing import Any

from app.trading.discovery.autoresearch import StrategyAutoresearchProgram

from scripts.whitepaper_autoresearch_runner.common import _decimal
from scripts.whitepaper_autoresearch_runner.next_epoch_planning import (
    _decimal_arg_or_default,
    _int_arg,
)
from scripts.whitepaper_autoresearch_runner.replay_shards import (
    _resolved_real_replay_frontier_controls,
    _resolved_staged_train_screen_multiplier,
)


def _args_with_objective_constraints(
    *,
    args: argparse.Namespace,
    objective: Any,
    program: StrategyAutoresearchProgram,
) -> argparse.Namespace:
    args = argparse.Namespace(
        **{
            **vars(args),
            "min_active_day_ratio": str(
                max(
                    _decimal(getattr(args, "min_active_day_ratio", "0.90")),
                    objective.min_active_day_ratio,
                )
            ),
            "min_positive_day_ratio": str(
                max(
                    _decimal(getattr(args, "min_positive_day_ratio", "0.60")),
                    objective.min_positive_day_ratio,
                )
            ),
            "min_daily_net_pnl": str(
                max(
                    _decimal_arg_or_default(
                        args,
                        "min_daily_net_pnl",
                        objective.min_daily_net_pnl,
                    ),
                    objective.min_daily_net_pnl,
                )
            ),
            "min_profit_factor": str(
                max(
                    _decimal(getattr(args, "min_profit_factor", "1.50")),
                    objective.min_profit_factor,
                )
            ),
            "max_worst_day_loss": str(
                min(
                    _decimal(getattr(args, "max_worst_day_loss", "999999999")),
                    objective.max_worst_day_loss,
                )
            ),
            "max_drawdown": str(
                min(
                    _decimal(getattr(args, "max_drawdown", "999999999")),
                    objective.max_drawdown,
                )
            ),
            "max_best_day_share": str(
                min(
                    _decimal(getattr(args, "max_best_day_share", "0.25")),
                    objective.max_best_day_share,
                )
            ),
            "min_avg_filled_notional_per_day": str(
                max(
                    _decimal(
                        getattr(args, "min_avg_filled_notional_per_day", "300000")
                    ),
                    objective.min_daily_notional,
                )
            ),
            "max_worst_day_loss_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_worst_day_loss_pct_equity", "0.05")),
                    objective.max_worst_day_loss_pct_equity,
                )
            ),
            "max_drawdown_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_drawdown_pct_equity", "0.08")),
                    objective.max_drawdown_pct_equity,
                )
            ),
            "extended_max_worst_day_loss_pct_equity": str(
                min(
                    _decimal(
                        getattr(args, "extended_max_worst_day_loss_pct_equity", "0.08")
                    ),
                    objective.extended_max_worst_day_loss_pct_equity,
                )
            ),
            "extended_max_drawdown_pct_equity": str(
                min(
                    _decimal(getattr(args, "extended_max_drawdown_pct_equity", "0.12")),
                    objective.extended_max_drawdown_pct_equity,
                )
            ),
            "min_total_net_pnl_to_drawdown_ratio": str(
                max(
                    _decimal(
                        getattr(args, "min_total_net_pnl_to_drawdown_ratio", "3.00")
                    ),
                    objective.min_total_net_pnl_to_drawdown_ratio,
                )
            ),
            "max_gross_exposure_pct_equity": str(
                min(
                    _decimal(getattr(args, "max_gross_exposure_pct_equity", "1.0")),
                    objective.max_gross_exposure_pct_equity,
                )
            ),
            "min_cash": str(
                max(_decimal(getattr(args, "min_cash", "0")), objective.min_cash)
            ),
            "no_require_double_oos": bool(getattr(args, "no_require_double_oos", False))
            or not bool(getattr(objective, "require_double_oos", True)),
            "min_double_oos_independent_window_count": max(
                _int_arg(args, "min_double_oos_independent_window_count", 2),
                int(getattr(objective, "min_double_oos_independent_window_count", 2)),
            ),
            "min_double_oos_pass_rate": str(
                max(
                    _decimal(getattr(args, "min_double_oos_pass_rate", "1.00")),
                    _decimal(
                        getattr(objective, "min_double_oos_pass_rate", "1.00"),
                        default="1.00",
                    ),
                )
            ),
            "staged_train_screen_multiplier": _resolved_staged_train_screen_multiplier(
                args, program
            ),
            **_resolved_real_replay_frontier_controls(args, program),
        }
    )
    return args
