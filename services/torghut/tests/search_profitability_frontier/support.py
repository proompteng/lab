from __future__ import annotations

# ruff: noqa: F401

import io
import json
import sys
from argparse import Namespace
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import yaml

import scripts.search_consistent_profitability_frontier as consistent_frontier
import scripts.search_profitability_frontier as frontier
from scripts.search_profitability_frontier import (
    apply_candidate_to_configmap,
    iter_parameter_candidates,
    resolve_sweep_window,
)


class _TestSearchProfitabilityFrontierBase(TestCase):
    def _write_strategy_configmap(self, root: Path) -> Path:
        path = root / "strategy-configmap.yaml"
        path.write_text(
            yaml.safe_dump(
                {
                    "apiVersion": "v1",
                    "kind": "ConfigMap",
                    "data": {
                        "strategies.yaml": yaml.safe_dump(
                            {
                                "strategies": [
                                    {
                                        "name": "breakout-continuation-long-v1",
                                        "enabled": True,
                                        "params": {
                                            "min_cross_section_continuation_rank": "0.45",
                                            "min_cross_section_continuation_breadth": "0.20",
                                            "min_recent_above_opening_window_close_ratio": "0.55",
                                            "min_recent_microprice_bias_bps": "0.05",
                                        },
                                    },
                                    {
                                        "name": "late-day-continuation-long-v1",
                                        "enabled": True,
                                        "params": {
                                            "min_recent_microprice_bias_bps": "0.20"
                                        },
                                    },
                                ]
                            },
                            sort_keys=False,
                        ),
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return path

    def _write_sweep_config(
        self,
        root: Path,
        *,
        ranks: list[str],
        hold_ratios: list[str] | None = None,
    ) -> Path:
        path = root / "sweep.yaml"
        path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.replay-frontier-sweep.v1",
                    "family": "breakout_continuation",
                    "strategy_name": "breakout-continuation-long-v1",
                    "disable_other_strategies": True,
                    "constraints": {
                        "holdout_target_net_per_day": "250",
                        "min_active_holdout_days": 3,
                        "max_worst_holdout_day_loss": "150",
                        "max_holdout_drawdown_pct_equity": "0.05",
                        "min_profit_factor": "1.5",
                        "require_training_decisions": True,
                        "require_holdout_decisions": True,
                    },
                    "parameters": {
                        "min_cross_section_continuation_rank": ranks,
                        "min_recent_above_opening_window_close_ratio": hold_ratios
                        or ["0.55"],
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return path

    @staticmethod
    def _payload(
        *,
        start_date: str,
        end_date: str,
        daily_net: dict[str, str],
        decision_count: int,
        filled_count: int,
        wins: int,
        losses: int,
    ) -> dict[str, object]:
        return {
            "start_date": start_date,
            "end_date": end_date,
            "net_pnl": str(sum(float(value) for value in daily_net.values())),
            "decision_count": decision_count,
            "filled_count": filled_count,
            "wins": wins,
            "losses": losses,
            "daily": {
                day: {
                    "net_pnl": value,
                    "filled_count": 1 if float(value) != 0 else 0,
                }
                for day, value in daily_net.items()
            },
        }

    def _make_args(
        self,
        *,
        strategy_configmap: Path,
        sweep_config: Path,
        json_output: Path,
    ) -> Namespace:
        return Namespace(
            strategy_configmap=strategy_configmap,
            sweep_config=sweep_config,
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            start_equity="31590.02",
            chunk_minutes=10,
            symbols="",
            progress_log_seconds=30,
            train_days=5,
            holdout_days=5,
            top_n=10,
            json_output=json_output,
        )


__all__: tuple[str, ...] = ()
