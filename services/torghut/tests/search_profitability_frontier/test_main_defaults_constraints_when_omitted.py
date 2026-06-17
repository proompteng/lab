from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.search_profitability_frontier.support import (
    Path,
    TemporaryDirectory,
    _TestSearchProfitabilityFrontierBase,
    date,
    frontier,
    io,
    json,
    patch,
    redirect_stderr,
    redirect_stdout,
    timedelta,
    yaml,
)


class TestMainDefaultsConstraintsWhenOmitted(_TestSearchProfitabilityFrontierBase):
    def test_main_defaults_constraints_when_omitted(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "breakout_continuation",
                        "strategy_name": "breakout-continuation-long-v1",
                        "parameters": {
                            "min_cross_section_continuation_rank": ["0.45"],
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            json_output = root / "frontier.json"
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=json_output,
            )
            recent_days = tuple(
                date(2026, 3, 16) + timedelta(days=index) for index in range(10)
            )

            def fake_run_replay(config: object) -> dict[str, object]:
                replay_config = config
                start_date = str(getattr(replay_config, "start_date"))
                if start_date == "2026-03-16":
                    return self._payload(
                        start_date="2026-03-16",
                        end_date="2026-03-20",
                        daily_net={
                            "2026-03-16": "0",
                            "2026-03-17": "0",
                            "2026-03-18": "0",
                            "2026-03-19": "0",
                            "2026-03-20": "0",
                        },
                        decision_count=1,
                        filled_count=0,
                        wins=0,
                        losses=0,
                    )
                return self._payload(
                    start_date="2026-03-21",
                    end_date="2026-03-25",
                    daily_net={
                        "2026-03-21": "300",
                        "2026-03-22": "300",
                        "2026-03-23": "300",
                        "2026-03-24": "0",
                        "2026-03-25": "0",
                    },
                    decision_count=3,
                    filled_count=3,
                    wins=3,
                    losses=0,
                )

            with (
                patch(
                    "scripts.search_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                patch(
                    "scripts.search_profitability_frontier.run_replay",
                    side_effect=fake_run_replay,
                ),
                redirect_stdout(io.StringIO()),
            ):
                exit_code = frontier.main()

            self.assertEqual(exit_code, 0)
            payload = json.loads(json_output.read_text(encoding="utf-8"))
            self.assertEqual(payload["candidate_count"], 1)
            self.assertEqual(
                payload["constraints"]["max_holdout_drawdown_pct_equity"],
                "0.05",
            )
            self.assertIsNone(payload["constraints"]["min_holdout_p10_daily_net"])
            self.assertEqual(
                payload["top"][0]["replay_config"]["params"][
                    "min_cross_section_continuation_rank"
                ],
                "0.45",
            )

    def test_cli_main_reports_insufficient_recent_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = self._write_sweep_config(root, ranks=["0.45"])
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / "frontier.json",
            )
            stderr = io.StringIO()
            with (
                patch(
                    "scripts.search_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_profitability_frontier._resolve_recent_trading_days",
                    return_value=tuple(
                        date(2026, 3, 16) + timedelta(days=index) for index in range(9)
                    ),
                ),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn("insufficient_recent_trading_days:9<10", stderr.getvalue())

    def test_cli_main_reports_invalid_base_configmap_shape(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = root / "strategy-configmap.yaml"
            strategy_configmap.write_text("- invalid\n", encoding="utf-8")
            sweep_config = self._write_sweep_config(root, ranks=["0.45"])
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / "frontier.json",
            )
            stderr = io.StringIO()
            recent_days = tuple(
                date(2026, 3, 16) + timedelta(days=index) for index in range(10)
            )
            with (
                patch(
                    "scripts.search_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn("base_strategy_configmap_not_mapping", stderr.getvalue())

    def test_cli_main_reports_missing_family_or_strategy_name(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "",
                        "strategy_name": "",
                        "parameters": {},
                    }
                ),
                encoding="utf-8",
            )
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / "frontier.json",
            )
            stderr = io.StringIO()
            recent_days = tuple(
                date(2026, 3, 16) + timedelta(days=index) for index in range(10)
            )
            with (
                patch(
                    "scripts.search_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn("sweep_config_missing_family_or_strategy_name", stderr.getvalue())

    def test_cli_main_reports_non_mapping_parameter_grid(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "breakout_continuation",
                        "strategy_name": "breakout-continuation-long-v1",
                        "parameters": ["not-a-mapping"],
                    }
                ),
                encoding="utf-8",
            )
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / "frontier.json",
            )
            stderr = io.StringIO()
            recent_days = tuple(
                date(2026, 3, 16) + timedelta(days=index) for index in range(10)
            )
            with (
                patch(
                    "scripts.search_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn("sweep_config_parameters_not_mapping", stderr.getvalue())

    def test_cli_main_reports_non_mapping_constraints(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            sweep_config = root / "sweep.yaml"
            sweep_config.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.replay-frontier-sweep.v1",
                        "family": "breakout_continuation",
                        "strategy_name": "breakout-continuation-long-v1",
                        "constraints": "invalid",
                        "parameters": {},
                    }
                ),
                encoding="utf-8",
            )
            args = self._make_args(
                strategy_configmap=strategy_configmap,
                sweep_config=sweep_config,
                json_output=root / "frontier.json",
            )
            stderr = io.StringIO()
            recent_days = tuple(
                date(2026, 3, 16) + timedelta(days=index) for index in range(10)
            )
            with (
                patch(
                    "scripts.search_profitability_frontier._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.search_profitability_frontier._resolve_recent_trading_days",
                    return_value=recent_days,
                ),
                redirect_stderr(stderr),
            ):
                exit_code = frontier.cli_main()

        self.assertEqual(exit_code, 1)
        self.assertIn("sweep_config_constraints_not_mapping", stderr.getvalue())
