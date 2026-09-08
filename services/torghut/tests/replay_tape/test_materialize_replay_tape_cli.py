from __future__ import annotations

from tests.replay_tape.support import (
    io,
    json,
    sys,
    Namespace,
    redirect_stdout,
    date,
    datetime,
    timezone,
    Decimal,
    Path,
    TemporaryDirectory,
    TestCase,
    patch,
    SignalEnvelope,
    materialize_cli,
    ReplayConfig,
)


class TestMaterializeReplayTapeCli(TestCase):
    def _coverage_row(
        self,
        *,
        raw: int,
        executable: int,
        microbar: int,
        symbols: int = 1,
        quote_valid_ratio: str = "1",
        max_gap_seconds: int = 1,
    ) -> dict[str, object]:
        return {
            "raw_signal_rows": raw,
            "executable_signal_rows": executable,
            "quote_sane_signal_rows": executable,
            "spread_sane_signal_rows": executable,
            "microbar_rows": microbar,
            "raw_signal_symbol_count": symbols,
            "executable_signal_symbol_count": symbols if executable > 0 else 0,
            "microbar_symbol_count": symbols,
            "min_executable_rows_per_symbol_day": executable,
            "min_spread_sane_rows_per_symbol_day": executable,
            "quote_valid_ratio": quote_valid_ratio,
            "min_quote_valid_ratio_by_symbol_day": quote_valid_ratio,
            "max_executable_gap_seconds": max_gap_seconds,
        }

    def _signal(self, *, day: int, seq: int, month: int = 3) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, month, day, 17, 30, seq, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=seq,
            source="ta",
            payload={
                "_source_ingest_ts": {
                    "ta_signals": datetime(
                        2026, month, day, 17, 31, tzinfo=timezone.utc
                    ),
                    "ta_microbars": datetime(
                        2026, month, day, 17, 31, tzinfo=timezone.utc
                    ),
                },
                "_source_versions": {
                    "ta_signals": 7,
                    "ta_microbars": 9,
                },
                "price": Decimal("100.25"),
                "spread": Decimal("0.02"),
                "window_size": "PT1S",
            },
            ingest_ts=datetime(2026, month, day, 17, 31, tzinfo=timezone.utc),
        )

    def test_parse_args_and_helpers_normalize_cli_inputs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "tape.jsonl"
            with patch.object(
                sys,
                "argv",
                [
                    "prog",
                    "--start-date",
                    "2026-03-26",
                    "--end-date",
                    "2026-03-27",
                    "--dataset-snapshot-ref",
                    "snapshot-cli",
                    "--output",
                    str(output),
                    "--symbols",
                    " nvda, META ",
                    "--coverage-diagnostic-output",
                    str(output.with_suffix(".coverage.json")),
                    "--latest-complete-window-min-days",
                    "2",
                    "--latest-complete-window-receipt-output",
                    str(output.with_suffix(".window.json")),
                    "--source-table-version",
                    "ta_signals=v1",
                    "--clickhouse-query-timeout-seconds",
                    "9",
                ],
            ):
                args = materialize_cli._parse_args()

        symbols = materialize_cli._parse_symbols(str(args.symbols))
        self.assertEqual(symbols, ("NVDA", "META"))
        self.assertEqual(args.clickhouse_query_timeout_seconds, 9)
        self.assertEqual(args.min_executable_rows_per_symbol_day, 18000)
        self.assertEqual(args.min_quote_valid_ratio, "0.90")
        self.assertEqual(args.max_coverage_spread_bps, "50")
        self.assertEqual(args.max_executable_gap_seconds, 120)
        self.assertEqual(
            args.coverage_diagnostic_output,
            output.with_suffix(".coverage.json"),
        )
        self.assertEqual(args.latest_complete_window_min_days, 2)
        self.assertEqual(
            args.latest_complete_window_receipt_output,
            output.with_suffix(".window.json"),
        )
        self.assertFalse(args.allow_incomplete_coverage)
        self.assertEqual(
            materialize_cli._parse_source_table_versions(args.source_table_version),
            {"ta_signals": "v1"},
        )
        self.assertEqual(
            materialize_cli._source_query_payload(args=args, symbols=symbols)[
                "symbols"
            ],
            ["NVDA", "META"],
        )
        with patch.object(
            sys,
            "argv",
            [
                "prog",
                "--start-date",
                "2026-03-26",
                "--end-date",
                "2026-03-27",
                "--dataset-snapshot-ref",
                "snapshot-cli",
                "--output",
                str(args.output),
                "--allow-incomplete-coverage",
            ],
        ):
            self.assertTrue(materialize_cli._parse_args().allow_incomplete_coverage)
        with self.assertRaisesRegex(ValueError, "source_table_version_invalid"):
            materialize_cli._parse_source_table_versions(["broken"])

    def test_coverage_diagnostics_parse_day_level_counts(self) -> None:
        diagnostics = materialize_cli._parse_coverage_diagnostics(
            "bad\trow\n2026-03-26\t10\t5\t7\t2\t1\t2\n"
        )

        self.assertEqual(
            diagnostics,
            {
                "2026-03-26": {
                    "raw_signal_rows": 10,
                    "executable_signal_rows": 5,
                    "quote_sane_signal_rows": 5,
                    "spread_sane_signal_rows": 5,
                    "microbar_rows": 7,
                    "raw_signal_symbol_count": 2,
                    "executable_signal_symbol_count": 1,
                    "microbar_symbol_count": 2,
                    "min_executable_rows_per_symbol_day": 5,
                    "min_spread_sane_rows_per_symbol_day": 5,
                    "quote_valid_ratio": "1",
                    "min_quote_valid_ratio_by_symbol_day": "1",
                    "max_executable_gap_seconds": 0,
                },
            },
        )

        diagnostics = materialize_cli._parse_coverage_diagnostics(
            "2026-03-27\t100\t90\t89\t88\t95\t2\t2\t2\t44\t43\t0.9777777778\t0.95\t7\n"
        )
        self.assertEqual(diagnostics["2026-03-27"]["spread_sane_signal_rows"], 88)
        self.assertEqual(
            diagnostics["2026-03-27"]["min_quote_valid_ratio_by_symbol_day"],
            "0.95",
        )
        self.assertEqual(diagnostics["2026-03-27"]["max_executable_gap_seconds"], 7)

    def test_fetch_coverage_diagnostics_marks_missing_source_layers(self) -> None:
        args = Namespace(
            clickhouse_http_url="http://clickhouse.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            clickhouse_query_timeout_seconds=7,
            observation_cutoff=datetime(2026, 3, 28, 12, 0, tzinfo=timezone.utc),
        )
        with patch(
            "scripts.materialize_replay_tape.replay_mod._http_query",
            return_value="2026-03-26\t10\t5\t7\t2\t1\t2\n",
        ) as query:
            diagnostics = materialize_cli._fetch_coverage_diagnostics(
                args=args,
                symbols=("META",),
                start_date=date(2026, 3, 26),
                end_date=date(2026, 3, 27),
            )

        self.assertEqual(
            materialize_cli._business_days(date(2026, 3, 27), date(2026, 3, 26)),
            (),
        )
        query_payload = str(query.call_args.kwargs["query"])
        self.assertIn("symbol IN ('META')", query_payload)
        self.assertIn(
            "ingest_ts <= toDateTime64('2026-03-28 12:00:00.000'", query_payload
        )
        self.assertEqual(query_payload.count("LIMIT 1 BY symbol, event_ts, seq"), 2)
        self.assertIn("toUInt64OrZero(toString(raw_signal_rows))", query_payload)
        self.assertEqual(query.call_args.kwargs["timeout_seconds"], 7)
        self.assertEqual(diagnostics["missing_raw_signal_days"], ["2026-03-27"])
        self.assertEqual(diagnostics["missing_executable_signal_days"], ["2026-03-27"])
        self.assertEqual(diagnostics["missing_microbar_days"], ["2026-03-27"])

    def test_latest_complete_window_selects_latest_consecutive_complete_days(
        self,
    ) -> None:
        diagnostics = {
            "requested_trading_days": [
                "2026-03-26",
                "2026-03-27",
                "2026-03-30",
                "2026-03-31",
            ],
            "rows_by_trading_day": {
                "2026-03-26": self._coverage_row(
                    raw=10, executable=10, microbar=10, symbols=2
                ),
                "2026-03-27": self._coverage_row(
                    raw=10, executable=0, microbar=10, symbols=2
                ),
                "2026-03-30": self._coverage_row(
                    raw=10, executable=10, microbar=10, symbols=2
                ),
                "2026-03-31": self._coverage_row(
                    raw=11, executable=11, microbar=11, symbols=2
                ),
            },
        }

        selected_start, selected_end, selected_days = (
            materialize_cli._latest_complete_window(
                diagnostics,
                min_days=2,
                expected_symbol_count=2,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio=Decimal("0.90"),
                max_executable_gap_seconds=120,
            )
        )

        self.assertEqual(selected_start, date(2026, 3, 30))
        self.assertEqual(selected_end, date(2026, 3, 31))
        self.assertEqual(selected_days, ("2026-03-30", "2026-03-31"))
        with self.assertRaisesRegex(
            ValueError,
            "latest_complete_replay_window_missing:min_days=3",
        ):
            materialize_cli._latest_complete_window(
                diagnostics,
                min_days=3,
                expected_symbol_count=2,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio=Decimal("0.90"),
                max_executable_gap_seconds=120,
            )

        stale_gap_diagnostics = {
            "requested_trading_days": ["2026-03-30", "2026-03-31"],
            "rows_by_trading_day": {
                "2026-03-30": self._coverage_row(
                    raw=10, executable=10, microbar=10, max_gap_seconds=121
                ),
                "2026-03-31": self._coverage_row(
                    raw=10, executable=10, microbar=10, quote_valid_ratio="0.89"
                ),
            },
        }
        with self.assertRaisesRegex(
            ValueError,
            "latest_complete_replay_window_missing:min_days=1",
        ):
            materialize_cli._latest_complete_window(
                stale_gap_diagnostics,
                min_days=1,
                expected_symbol_count=1,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio=Decimal("0.90"),
                max_executable_gap_seconds=120,
            )

    def test_main_materializes_manifest_from_replay_rows(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            diagnostic_output = root / "coverage.json"
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=diagnostic_output,
                source_table_version=["ta_signals=v1"],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(
                        self._signal(day=26, seq=1),
                        self._signal(day=27, seq=2),
                    ),
                ),
                patch(
                    "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                    return_value={
                        "schema_version": "torghut.replay-coverage-diagnostic.v1",
                        "requested_trading_days": ["2026-03-26", "2026-03-27"],
                        "missing_executable_signal_days": [],
                    },
                ),
                redirect_stdout(stdout),
            ):
                exit_code = materialize_cli.main()

            payload = json.loads(stdout.getvalue())
            output_exists = output.exists()
            manifest_exists = manifest_output.exists()
            diagnostic_payload = json.loads(
                diagnostic_output.read_text(encoding="utf-8")
            )

        self.assertEqual(exit_code, 0)
        self.assertTrue(output_exists)
        self.assertTrue(manifest_exists)
        self.assertEqual(payload["dataset_snapshot_ref"], "snapshot-cli")
        self.assertEqual(payload["row_count"], 2)
        self.assertEqual(payload["source_table_versions"], {"ta_signals": "v1"})
        self.assertEqual(payload["observed_trading_days"], ["2026-03-26", "2026-03-27"])
        self.assertEqual(payload["missing_trading_days"], [])
        self.assertEqual(
            payload["row_count_by_trading_day"],
            {"2026-03-26": 1, "2026-03-27": 1},
        )
        self.assertEqual(payload["missing_symbol_trading_days"], [])
        self.assertEqual(
            payload["row_count_by_symbol_trading_day"],
            {"META": {"2026-03-26": 1, "2026-03-27": 1}},
        )
        self.assertEqual(diagnostic_payload["missing_executable_signal_days"], [])

    def test_main_builds_complete_point_in_time_receipt_from_explicit_spec(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            spec_path = root / "point-in-time-spec.json"
            cutoff = datetime(2026, 3, 26, 18, 0, tzinfo=timezone.utc)
            spec_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.point-in-time-receipt-spec.v1",
                        "observation_cutoff": cutoff.isoformat(),
                        "feed_identity": "alpaca-iex",
                        "timezone": "America/New_York",
                        "session_calendar_version": "nyse-v1",
                        "session_calendar_sha256": "sha256:" + "1" * 64,
                        "universe_version": "universe-v1",
                        "universe_sha256": "sha256:" + "2" * 64,
                        "universe_symbols": ["META"],
                        "corporate_actions_version": "announcements-v1",
                        "corporate_actions_sha256": "sha256:" + "3" * 64,
                        "adjustment_policy": "split-dividend-v1",
                        "adjustment_policy_sha256": "sha256:" + "4" * 64,
                        "code_digest": "5" * 40,
                        "economic_policy_digest": "sha256:" + "6" * 64,
                        "feature_pipeline_sha256": "sha256:" + "7" * 64,
                    }
                ),
                encoding="utf-8",
            )
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-26",
                chunk_minutes=10,
                clickhouse_query_timeout_seconds=7,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=None,
                source_table_version=[
                    "torghut.ta_signals=schema-v1",
                    "torghut.ta_microbars=schema-v1",
                ],
                point_in_time_spec=spec_path,
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(self._signal(day=26, seq=1),),
                ) as fetch,
                redirect_stdout(stdout),
            ):
                exit_code = materialize_cli.main()

            payload = json.loads(stdout.getvalue())
            replay_config = fetch.call_args.args[0]

        self.assertEqual(exit_code, 0)
        self.assertEqual(replay_config.observation_cutoff, cutoff)
        self.assertEqual(
            payload["point_in_time_receipt"]["observation_cutoff"],
            cutoff.isoformat(),
        )
        self.assertEqual(
            payload["point_in_time_receipt"]["source_watermarks"].keys(),
            {"ta_microbars", "ta_signals"},
        )

    def test_main_can_materialize_latest_complete_source_window(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            diagnostic_output = root / "coverage.json"
            receipt_output = root / "window.json"
            captured_windows: list[tuple[date, date]] = []

            def iter_rows(config: ReplayConfig) -> tuple[SignalEnvelope, ...]:
                captured_windows.append((config.start_date, config.end_date))
                return (
                    self._signal(day=30, seq=1),
                    self._signal(day=31, seq=2),
                )

            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-31",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=diagnostic_output,
                latest_complete_window_min_days=2,
                latest_complete_window_receipt_output=receipt_output,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio="0.90",
                max_coverage_spread_bps="50",
                max_executable_gap_seconds=120,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            coverage = {
                "schema_version": "torghut.replay-coverage-diagnostic.v1",
                "requested_trading_days": [
                    "2026-03-26",
                    "2026-03-27",
                    "2026-03-30",
                    "2026-03-31",
                ],
                "rows_by_trading_day": {
                    "2026-03-26": self._coverage_row(
                        raw=10, executable=10, microbar=10
                    ),
                    "2026-03-27": self._coverage_row(raw=10, executable=0, microbar=10),
                    "2026-03-30": self._coverage_row(
                        raw=10, executable=10, microbar=10
                    ),
                    "2026-03-31": self._coverage_row(
                        raw=11, executable=11, microbar=11
                    ),
                },
                "missing_executable_signal_days": ["2026-03-27"],
            }
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                    return_value=coverage,
                ) as fetch,
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    side_effect=iter_rows,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = materialize_cli.main()

            payload = json.loads(stdout.getvalue())
            diagnostic_payload = json.loads(
                diagnostic_output.read_text(encoding="utf-8")
            )
            receipt_payload = json.loads(receipt_output.read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured_windows, [(date(2026, 3, 30), date(2026, 3, 31))])
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(payload["start_date"], "2026-03-30")
        self.assertEqual(payload["end_date"], "2026-03-31")
        self.assertEqual(
            payload["requested_trading_days"], ["2026-03-30", "2026-03-31"]
        )
        self.assertEqual(
            diagnostic_payload["latest_complete_window"]["selected_trading_days"],
            ["2026-03-30", "2026-03-31"],
        )
        self.assertEqual(receipt_payload["requested_start_date"], "2026-03-26")
        self.assertEqual(receipt_payload["effective_start_date"], "2026-03-30")
        self.assertEqual(
            receipt_payload["materialized_manifest"]["row_count"],
            2,
        )

    def test_latest_complete_source_window_skips_market_holiday(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            captured_windows: list[tuple[date, date]] = []

            def iter_rows(config: ReplayConfig) -> tuple[SignalEnvelope, ...]:
                captured_windows.append((config.start_date, config.end_date))
                return (
                    self._signal(day=22, seq=1, month=5),
                    self._signal(day=26, seq=2, month=5),
                )

            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-05-22",
                end_date="2026-05-26",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=None,
                latest_complete_window_min_days=2,
                latest_complete_window_receipt_output=None,
                min_executable_rows_per_symbol_day=1,
                min_quote_valid_ratio="0",
                max_coverage_spread_bps="1000000000",
                max_executable_gap_seconds=999999,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            coverage = {
                "schema_version": "torghut.replay-coverage-diagnostic.v1",
                "requested_trading_days": ["2026-05-22", "2026-05-26"],
                "rows_by_trading_day": {
                    "2026-05-22": self._coverage_row(
                        raw=2,
                        executable=2,
                        microbar=2,
                    ),
                    "2026-05-26": self._coverage_row(
                        raw=2,
                        executable=2,
                        microbar=2,
                    ),
                },
                "missing_executable_signal_days": [],
            }
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                    return_value=coverage,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    side_effect=iter_rows,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = materialize_cli.main()

            payload = json.loads(stdout.getvalue())

        self.assertEqual(exit_code, 0)
        self.assertEqual(captured_windows, [(date(2026, 5, 22), date(2026, 5, 26))])
        self.assertEqual(
            payload["requested_trading_days"], ["2026-05-22", "2026-05-26"]
        )
        self.assertEqual(payload["missing_trading_days"], [])

    def test_latest_complete_window_failure_writes_diagnostics(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            diagnostic_output = root / "coverage.json"
            receipt_output = root / "window.json"
            args = Namespace(
                coverage_diagnostic_output=diagnostic_output,
                latest_complete_window_receipt_output=receipt_output,
                latest_complete_window_min_days=2,
                min_executable_rows_per_symbol_day=10,
                min_quote_valid_ratio="0.90",
                max_executable_gap_seconds=120,
            )
            coverage = {
                "schema_version": "torghut.replay-coverage-diagnostic.v1",
                "requested_trading_days": ["2026-03-26", "2026-03-27"],
                "rows_by_trading_day": {
                    "2026-03-26": self._coverage_row(
                        raw=10,
                        executable=0,
                        microbar=10,
                    ),
                    "2026-03-27": self._coverage_row(
                        raw=10,
                        executable=10,
                        microbar=10,
                    ),
                },
            }
            with patch(
                "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                return_value=coverage,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "latest_complete_replay_window_missing:min_days=2",
                ):
                    materialize_cli._select_effective_window(
                        args=args,
                        symbols=("META",),
                        requested_start_date=date(2026, 3, 26),
                        requested_end_date=date(2026, 3, 27),
                    )

            diagnostic_payload = json.loads(
                diagnostic_output.read_text(encoding="utf-8")
            )
            receipt_payload = json.loads(receipt_output.read_text(encoding="utf-8"))

        self.assertEqual(receipt_payload["status"], "missing")
        self.assertEqual(receipt_payload["selected_trading_days"], [])
        self.assertEqual(
            diagnostic_payload["latest_complete_window"]["failure_reason"],
            "latest_complete_replay_window_missing:min_days=2",
        )

    def test_main_fails_closed_on_incomplete_coverage_by_default(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=None,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(self._signal(day=26, seq=1),),
                ),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-03-27",
                ):
                    materialize_cli.main()

            self.assertFalse(output.exists())
            self.assertFalse(manifest_output.exists())

    def test_main_writes_coverage_diagnostics_when_strict_coverage_fails(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            diagnostic_output = root / "coverage.json"
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=diagnostic_output,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(self._signal(day=26, seq=1),),
                ),
                patch(
                    "scripts.materialize_replay_tape._fetch_coverage_diagnostics",
                    return_value={
                        "schema_version": "torghut.replay-coverage-diagnostic.v1",
                        "requested_trading_days": ["2026-03-26", "2026-03-27"],
                        "rows_by_trading_day": {
                            "2026-03-26": {
                                "raw_signal_rows": 10,
                                "executable_signal_rows": 1,
                                "microbar_rows": 10,
                            },
                            "2026-03-27": {
                                "raw_signal_rows": 11,
                                "executable_signal_rows": 0,
                                "microbar_rows": 11,
                            },
                        },
                        "missing_executable_signal_days": ["2026-03-27"],
                    },
                ),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-03-27",
                ):
                    materialize_cli.main()

            payload = json.loads(diagnostic_output.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["materialization_failure_reason"],
                "replay_tape_incomplete_coverage:missing_days=2026-03-27",
            )
            self.assertEqual(payload["missing_executable_signal_days"], ["2026-03-27"])
            self.assertEqual(
                payload["materialization_diagnostics"][
                    "materialized_executable_rows_by_trading_day"
                ],
                {"2026-03-26": 1},
            )
            self.assertFalse(output.exists())
            self.assertFalse(manifest_output.exists())

    def test_main_fails_closed_on_missing_symbol_days_by_default(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output = root / "tape.jsonl"
            manifest_output = root / "tape.manifest.json"
            args = Namespace(
                strategy_configmap=root / "strategy.yaml",
                clickhouse_http_url="http://clickhouse.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_date="2026-03-26",
                end_date="2026-03-27",
                chunk_minutes=0,
                start_equity="10000",
                symbols="meta,aapl",
                dataset_snapshot_ref="snapshot-cli",
                output=output,
                manifest_output=manifest_output,
                coverage_diagnostic_output=None,
                source_table_version=[],
                allow_incomplete_coverage=False,
                log_level="WARNING",
            )
            with (
                patch(
                    "scripts.materialize_replay_tape._parse_args",
                    return_value=args,
                ),
                patch(
                    "scripts.materialize_replay_tape.replay_mod._iter_signal_rows",
                    return_value=(
                        self._signal(day=26, seq=1),
                        self._signal(day=27, seq=2),
                    ),
                ),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_symbol_days=AAPL:2026-03-26,AAPL:2026-03-27",
                ):
                    materialize_cli.main()

            self.assertFalse(output.exists())
            self.assertFalse(manifest_output.exists())
