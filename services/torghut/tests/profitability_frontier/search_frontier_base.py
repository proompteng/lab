from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.profitability_frontier.search_frontier_support import (
    Decimal,
    Namespace,
    Path,
    SignalEnvelope,
    SimpleNamespace,
    TemporaryDirectory,
    TestCase,
    _GuardedSignalRow,
    _authoritative_exact_replay_ledger_payload,
    _authoritative_exact_replay_rows,
    build_source_query_digest,
    cast,
    date,
    datetime,
    deque,
    frontier,
    io,
    json,
    materialize_signal_tape,
    patch,
    redirect_stderr,
    redirect_stdout,
    sys,
    timedelta,
    timezone,
    yaml,
)


class SearchConsistentProfitabilityFrontierTestCaseBase(TestCase):
    @staticmethod
    def _payload(
        *,
        start_date: str,
        end_date: str,
        daily_net: dict[str, str],
        daily_filled_notional: dict[str, str] | None = None,
        daily_liquidity_notional: dict[str, str] | None = None,
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
                    "filled_notional": (
                        daily_filled_notional[day]
                        if daily_filled_notional is not None
                        and day in daily_filled_notional
                        else ("1000" if float(value) != 0 else "0")
                    ),
                    "daily_adv_notional": daily_liquidity_notional[day]
                    if daily_liquidity_notional is not None
                    and day in daily_liquidity_notional
                    else None,
                }
                for day, value in daily_net.items()
            },
        }

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
                                        "name": "intraday-tsmom-profit-v3",
                                        "enabled": True,
                                        "max_notional_per_trade": "25000",
                                        "max_position_pct_equity": "2.0",
                                        "universe_symbols": ["NVDA", "AMAT", "AMD"],
                                        "params": {
                                            "min_cross_section_continuation_rank": "0.60",
                                            "long_stop_loss_bps": "18",
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
                        )
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return path

    def _write_sweep_config(self, root: Path) -> Path:
        path = root / "sweep.yaml"
        path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.replay-frontier-sweep.v1",
                    "family": "intraday_tsmom_consistent",
                    "strategy_name": "intraday-tsmom-profit-v3",
                    "disable_other_strategies": True,
                    "constraints": {
                        "holdout_target_net_per_day": "200",
                        "min_active_holdout_days": 2,
                        "max_worst_holdout_day_loss": "200",
                        "min_profit_factor": "1.1",
                    },
                    "consistency_constraints": {
                        "target_net_per_day": "200",
                        "min_active_days": 6,
                        "max_worst_day_loss": "250",
                        "max_negative_days": 1,
                        "max_drawdown": "300",
                        "require_every_day_active": True,
                    },
                    "strategy_overrides": {
                        "universe_symbols": [["NVDA"], ["NVDA", "AMAT"]],
                        "max_notional_per_trade": ["15000"],
                    },
                    "parameters": {
                        "long_stop_loss_bps": ["12", "18"],
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return path

    def _make_args(
        self, *, strategy_configmap: Path, sweep_config: Path, json_output: Path
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
            train_days=3,
            holdout_days=3,
            second_oos_days=0,
            full_window_start_date="",
            full_window_end_date="",
            expected_last_trading_day="",
            allow_stale_tape=False,
            family_template_dir=Path(__file__).resolve().parents[2]
            / "config"
            / "trading"
            / "families",
            prefetch_full_window_rows=False,
            top_n=10,
            max_candidates_to_evaluate=0,
            staged_train_screen_multiplier=1,
            json_output=json_output,
            symbol_prune_iterations=0,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
            loss_repair_iterations=0,
            loss_repair_candidates=1,
            consistency_repair_iterations=0,
            consistency_repair_candidates=1,
            train_screening=True,
            min_train_screen_net_per_day="0",
            min_train_screen_active_ratio="0.50",
            max_train_screen_worst_day_loss="",
            capture_rejected_seed_full_window_ledger=False,
            capture_positive_rejected_full_window_ledgers=0,
        )


__all__ = [name for name in globals() if not name.startswith("__")]
