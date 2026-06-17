from __future__ import annotations

from tests.profitability_frontier.search_frontier_base import (
    Decimal,
    Path,
    SearchConsistentProfitabilityFrontierTestCaseBase,
    SignalEnvelope,
    SimpleNamespace,
    TemporaryDirectory,
    _GuardedSignalRow,
    date,
    datetime,
    frontier,
    patch,
    timedelta,
    timezone,
    yaml,
)


class TestSearchFrontierReplayInputs(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_resolve_frontier_replay_windows_keeps_second_oos_independent(
        self,
    ) -> None:
        days = tuple(date(2026, 3, 16) + timedelta(days=index) for index in range(8))

        resolved = frontier._resolve_frontier_replay_windows(
            days,
            train_days=3,
            holdout_days=3,
            second_oos_days=2,
        )

        self.assertEqual(resolved.train_days, days[:3])
        self.assertEqual(resolved.holdout_days, days[3:6])
        self.assertEqual(resolved.second_oos_days, days[6:])
        self.assertEqual(resolved.expected_days, days)

    def test_recent_day_query_honors_explicit_expected_last_trading_day(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = self._make_args(
                strategy_configmap=self._write_strategy_configmap(root),
                sweep_config=self._write_sweep_config(root),
                json_output=root / "frontier.json",
            )
            args.expected_last_trading_day = "2026-05-21"
            args.second_oos_days = 2

            with patch(
                "scripts.search_consistent_profitability_frontier._resolve_recent_trading_days",
                side_effect=RuntimeError("stop-after-recent-days"),
            ) as resolve_recent:
                with self.assertRaisesRegex(RuntimeError, "stop-after-recent-days"):
                    frontier.run_consistent_profitability_frontier(args)

        self.assertEqual(
            resolve_recent.call_args.kwargs["latest_trading_day"],
            date(2026, 5, 21),
        )
        self.assertEqual(resolve_recent.call_args.kwargs["limit"], 8)

    def test_explicit_full_window_replay_tape_receipt_keeps_missing_business_days(
        self,
    ) -> None:
        window = frontier.FrontierReplayWindows(
            train_days=(date(2026, 5, 18),),
            holdout_days=(date(2026, 5, 21),),
        )
        expected_days = frontier._snapshot_expected_days(
            window=window,
            full_window_start=date(2026, 5, 18),
            full_window_end=date(2026, 5, 21),
            require_full_window_coverage=True,
        )
        rows = [
            SignalEnvelope(
                event_ts=datetime(2026, 5, 18, 14, 30, tzinfo=timezone.utc),
                symbol="AMZN",
                timeframe="1Sec",
                seq=1,
                source="ta",
                payload={"price": Decimal("200")},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 5, 21, 14, 30, tzinfo=timezone.utc),
                symbol="AMZN",
                timeframe="1Sec",
                seq=2,
                source="ta",
                payload={"price": Decimal("210")},
            ),
        ]

        receipt = frontier._build_replay_tape_snapshot_receipt(
            validation={
                "status": "valid",
                "dataset_snapshot_ref": "snapshot-gap",
                "content_sha256": "content-sha",
                "source_query_digest": "query-sha",
                "row_count": 2,
                "trading_day_count": 2,
                "source_table_versions": {},
                "artifact_refs": {},
            },
            rows=rows,
            start_day=date(2026, 5, 18),
            end_day=date(2026, 5, 21),
            expected_last_trading_day=date(2026, 5, 21),
            expected_trading_days=expected_days,
            allow_stale_tape=False,
        )

        self.assertEqual(
            expected_days,
            (
                date(2026, 5, 18),
                date(2026, 5, 19),
                date(2026, 5, 20),
                date(2026, 5, 21),
            ),
        )
        self.assertFalse(receipt.is_fresh)
        self.assertEqual(
            receipt.missing_days,
            (date(2026, 5, 19), date(2026, 5, 20)),
        )

    def test_strategy_universe_symbols_reads_target_strategy_universe(self) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "universe_symbols": ["nvda", " AMAT "],
                            },
                            {
                                "name": "other",
                                "universe_symbols": ["META"],
                            },
                        ]
                    },
                    sort_keys=False,
                )
            }
        }
        self.assertEqual(
            frontier._strategy_universe_symbols(
                configmap_payload=configmap_payload,
                strategy_name="intraday-tsmom-profit-v3",
            ),
            ("NVDA", "AMAT"),
        )

    def test_resolve_prefetch_symbols_uses_override_union_before_base_universe(
        self,
    ) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "universe_symbols": ["META"],
                            },
                        ]
                    },
                    sort_keys=False,
                )
            }
        }
        self.assertEqual(
            frontier._resolve_prefetch_symbols(
                cli_symbols=(),
                override_candidates=[
                    {"universe_symbols": ["nvda", "amat"]},
                    {"universe_symbols": ["AMAT", "amd"]},
                ],
                configmap_payload=configmap_payload,
                strategy_name="intraday-tsmom-profit-v3",
            ),
            ("NVDA", "AMAT", "AMD"),
        )

    def test_cached_iter_signal_rows_factory_filters_by_date_and_symbol_preserving_order(
        self,
    ) -> None:
        rows = [
            SimpleNamespace(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 23, 14, 0, tzinfo=timezone.utc),
                seq=2,
            ),
            SimpleNamespace(
                symbol="AMAT",
                event_ts=datetime(2026, 3, 23, 14, 0, 1, tzinfo=timezone.utc),
                seq=1,
            ),
            SimpleNamespace(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 24, 14, 0, tzinfo=timezone.utc),
                seq=3,
            ),
        ]
        iterator = frontier._cached_iter_signal_rows_factory(rows)
        config = SimpleNamespace(
            symbols=("NVDA",),
            start_date=date(2026, 3, 23),
            end_date=date(2026, 3, 23),
        )
        filtered = list(iterator(config))
        self.assertEqual([item.symbol for item in filtered], ["NVDA"])
        self.assertEqual(filtered[0].seq, 2)

    def test_cached_iter_signal_rows_factory_preserves_cross_symbol_order(
        self,
    ) -> None:
        rows = [
            SimpleNamespace(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 23, 14, 0, tzinfo=timezone.utc),
                seq=1,
            ),
            SimpleNamespace(
                symbol="AMAT",
                event_ts=datetime(2026, 3, 23, 14, 0, 1, tzinfo=timezone.utc),
                seq=2,
            ),
            SimpleNamespace(
                symbol="META",
                event_ts=datetime(2026, 3, 23, 14, 0, 2, tzinfo=timezone.utc),
                seq=3,
            ),
            SimpleNamespace(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 24, 14, 0, tzinfo=timezone.utc),
                seq=4,
            ),
        ]
        iterator = frontier._cached_iter_signal_rows_factory(rows)
        config = SimpleNamespace(
            symbols=("amat", "nvda"),
            start_date=date(2026, 3, 23),
            end_date=date(2026, 3, 24),
        )

        filtered = list(iterator(config))

        self.assertEqual([item.symbol for item in filtered], ["NVDA", "AMAT", "NVDA"])
        self.assertEqual([item.seq for item in filtered], [1, 2, 4])

    def test_cached_iter_signal_rows_factory_returns_all_symbols_without_filter(
        self,
    ) -> None:
        rows = [
            SimpleNamespace(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 23, 14, 0, tzinfo=timezone.utc),
                seq=1,
            ),
            SimpleNamespace(
                symbol="AMAT",
                event_ts=datetime(2026, 3, 23, 14, 0, 1, tzinfo=timezone.utc),
                seq=2,
            ),
            SimpleNamespace(
                symbol="META",
                event_ts=datetime(2026, 3, 24, 14, 0, tzinfo=timezone.utc),
                seq=3,
            ),
        ]
        iterator = frontier._cached_iter_signal_rows_factory(rows)
        config = SimpleNamespace(
            symbols=(),
            start_date=date(2026, 3, 23),
            end_date=date(2026, 3, 24),
        )

        filtered = list(iterator(config))

        self.assertEqual([item.seq for item in filtered], [1, 2, 3])

    def test_cached_iter_signal_rows_factory_returns_empty_for_inverted_dates(
        self,
    ) -> None:
        rows = [
            SimpleNamespace(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 23, 14, 0, tzinfo=timezone.utc),
                seq=1,
            )
        ]
        iterator = frontier._cached_iter_signal_rows_factory(rows)
        config = SimpleNamespace(
            symbols=(),
            start_date=date(2026, 3, 24),
            end_date=date(2026, 3, 23),
        )

        self.assertEqual(list(iterator(config)), [])

    def test_cached_iter_signal_rows_factory_uses_index_after_factory(
        self,
    ) -> None:
        rows = [
            _GuardedSignalRow(
                symbol="NVDA",
                event_ts=datetime(2026, 3, 22, 14, 0, tzinfo=timezone.utc),
                seq=1,
            ),
            _GuardedSignalRow(
                symbol="AMAT",
                event_ts=datetime(2026, 3, 23, 14, 0, tzinfo=timezone.utc),
                seq=2,
            ),
            _GuardedSignalRow(
                symbol="META",
                event_ts=datetime(2026, 3, 24, 14, 0, tzinfo=timezone.utc),
                seq=3,
            ),
        ]
        iterator = frontier._cached_iter_signal_rows_factory(rows)
        for row in rows:
            row.raise_on_event_ts = True

        config = SimpleNamespace(
            symbols=("AMAT",),
            start_date=date(2026, 3, 23),
            end_date=date(2026, 3, 23),
        )

        filtered = list(iterator(config))

        self.assertEqual([item.symbol for item in filtered], ["AMAT"])
        self.assertEqual(filtered[0].seq, 2)

    def test_apply_candidate_to_configmap_with_overrides_updates_top_level_fields(
        self,
    ) -> None:
        configmap_payload = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "enabled": False,
                                "max_notional_per_trade": "25000",
                                "params": {"long_stop_loss_bps": "18"},
                            },
                            {"name": "late-day", "enabled": True, "params": {}},
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = frontier.apply_candidate_to_configmap_with_overrides(
            configmap_payload=configmap_payload,
            strategy_name="intraday-tsmom-profit-v3",
            candidate_params={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "universe_symbols": ["NVDA", "AMAT"],
                "max_notional_per_trade": "15000",
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated["data"]["strategies.yaml"])
        strategies = {item["name"]: item for item in catalog["strategies"]}
        self.assertEqual(
            strategies["intraday-tsmom-profit-v3"]["params"]["long_stop_loss_bps"],
            "12",
        )
        self.assertEqual(
            strategies["intraday-tsmom-profit-v3"]["params"]["position_isolation_mode"],
            "per_strategy",
        )
        self.assertEqual(
            strategies["intraday-tsmom-profit-v3"]["universe_symbols"],
            ["NVDA", "AMAT"],
        )
        self.assertEqual(
            strategies["intraday-tsmom-profit-v3"]["max_notional_per_trade"],
            "15000",
        )
        self.assertFalse(strategies["late-day"]["enabled"])

    def test_apply_candidate_to_configmap_with_overrides_skips_search_only_normalization_override(
        self,
    ) -> None:
        configmap_payload = {
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
                                "params": {"long_stop_loss_bps": "18"},
                            },
                        ]
                    },
                    sort_keys=False,
                )
            },
        }

        updated = frontier.apply_candidate_to_configmap_with_overrides(
            configmap_payload=configmap_payload,
            strategy_name="intraday-tsmom-profit-v3",
            candidate_params={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "opening_window_scaled",
                "universe_symbols": ["NVDA", "AMAT"],
            },
            disable_other_strategies=True,
        )

        catalog = yaml.safe_load(updated["data"]["strategies.yaml"])
        strategy = catalog["strategies"][0]
        self.assertEqual(strategy["params"]["long_stop_loss_bps"], "12")
        self.assertEqual(strategy["universe_symbols"], ["NVDA", "AMAT"])
        self.assertNotIn("normalization_regime", strategy)

    def test_apply_candidate_to_configmap_with_overrides_validates_returned_catalog(
        self,
    ) -> None:
        base_payload = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {"strategies": [{"name": "target", "enabled": True, "params": {}}]},
                    sort_keys=False,
                )
            },
        }

        invalid_returns = [
            ({"data": []}, "strategy_configmap_missing_data"),
            ({"data": {}}, "strategy_configmap_missing_strategies_yaml"),
            ({"data": {"strategies.yaml": "- bad\n"}}, "strategy_catalog_not_mapping"),
            (
                {"data": {"strategies.yaml": "strategies: {}\n"}},
                "strategy_catalog_missing_strategies",
            ),
        ]
        for returned, reason in invalid_returns:
            with self.subTest(reason=reason):
                with patch.object(
                    frontier, "apply_candidate_to_configmap", return_value=returned
                ):
                    with self.assertRaisesRegex(ValueError, reason):
                        frontier.apply_candidate_to_configmap_with_overrides(
                            configmap_payload=base_payload,
                            strategy_name="target",
                            candidate_params={},
                            strategy_overrides={"universe_symbols": ["NVDA"]},
                            disable_other_strategies=True,
                        )

        with self.assertRaisesRegex(
            ValueError, "strategy_override_key_reserved:params"
        ):
            frontier.apply_candidate_to_configmap_with_overrides(
                configmap_payload=base_payload,
                strategy_name="target",
                candidate_params={},
                strategy_overrides={"params": {"long_stop_loss_bps": "10"}},
                disable_other_strategies=True,
            )
        returned_other_strategy = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {"strategies": [{"name": "other", "params": {}}]},
                    sort_keys=False,
                )
            }
        }
        with patch.object(
            frontier,
            "apply_candidate_to_configmap",
            return_value=returned_other_strategy,
        ):
            with self.assertRaisesRegex(ValueError, "strategy_not_found:missing"):
                frontier.apply_candidate_to_configmap_with_overrides(
                    configmap_payload=base_payload,
                    strategy_name="missing",
                    candidate_params={},
                    strategy_overrides={"universe_symbols": ["NVDA"]},
                    disable_other_strategies=False,
                )

    def test_symbol_contributions_from_replay_payload_aggregates_downside_and_activity(
        self,
    ) -> None:
        payload = {
            "funnel": {
                "buckets": [
                    {
                        "trading_day": "2026-03-31",
                        "symbol": "AVGO",
                        "filled_count": 1,
                        "net_pnl": "-120",
                        "cost_total": "10",
                    },
                    {
                        "trading_day": "2026-04-01",
                        "symbol": "AVGO",
                        "filled_count": 1,
                        "net_pnl": "30",
                        "cost_total": "5",
                    },
                    {
                        "trading_day": "2026-04-01",
                        "symbol": "MSFT",
                        "filled_count": 1,
                        "net_pnl": "220",
                        "cost_total": "7",
                    },
                ]
            }
        }
        contributions = frontier._symbol_contributions_from_replay_payload(payload)
        self.assertEqual(list(contributions), ["AVGO", "MSFT"])
        self.assertEqual(contributions["AVGO"]["active_days"], 2)
        self.assertEqual(contributions["AVGO"]["negative_days"], 1)
        self.assertEqual(contributions["AVGO"]["net_pnl"], "-90")
        self.assertEqual(contributions["AVGO"]["downside_pnl"], "120")
        self.assertEqual(contributions["MSFT"]["contribution_score"], "220")

    def test_train_gate_diagnostics_from_replay_payload_summarizes_funnel(self) -> None:
        payload = {
            "decision_count": 0,
            "filled_count": 0,
            "funnel": {
                "buckets": [
                    {
                        "retained_rows": 10,
                        "runtime_evaluable_rows": 8,
                        "quote_valid_rows": 9,
                        "strategy_evaluations": 8,
                        "passed_trace_count": 1,
                        "gate_pass_counts": {"short:eligibility": 8},
                        "first_failed_gate_counts": {"short:confirmation": 5},
                        "failing_threshold_counts": {
                            "short:confirmation:imbalance_pressure": 5,
                        },
                        "post_gate_block_reason_counts": {
                            "raw_decision_not_emitted": 2,
                        },
                    },
                    {
                        "retained_rows": 4,
                        "runtime_evaluable_rows": 3,
                        "quote_valid_rows": 3,
                        "strategy_evaluations": 3,
                        "passed_trace_count": 0,
                        "first_failed_gate_counts": {"short:structure": 3},
                        "failing_threshold_counts": {"short:structure:rsi14": 3},
                    },
                ]
            },
            "near_misses": [
                {
                    "trading_day": "2026-05-01",
                    "symbol": "AAPL",
                    "strategy_type": "short",
                    "event_ts": "2026-05-01T15:00:00+00:00",
                    "first_failed_gate": "confirmation",
                    "distance_score": "0.02",
                    "thresholds": [
                        {
                            "metric": "imbalance_pressure",
                            "value": "0.01",
                            "threshold": "0.00",
                            "distance_to_pass": "0.01",
                        }
                    ],
                }
            ],
        }

        diagnostics = frontier._train_gate_diagnostics_from_replay_payload(payload)

        self.assertEqual(diagnostics["status"], "available")
        self.assertEqual(diagnostics["aggregate"]["strategy_evaluations"], 11)
        self.assertEqual(
            diagnostics["top_first_failed_gates"][0],
            {"key": "short:confirmation", "count": 5},
        )
        self.assertEqual(
            diagnostics["top_failing_thresholds"][0],
            {"key": "short:confirmation:imbalance_pressure", "count": 5},
        )
        self.assertEqual(
            diagnostics["top_post_gate_block_reasons"][0],
            {"key": "raw_decision_not_emitted", "count": 2},
        )
        self.assertEqual(
            diagnostics["near_misses"][0]["thresholds"][0]["metric"],
            "imbalance_pressure",
        )

    def test_train_gate_diagnostics_from_replay_payload_ignores_malformed_items(
        self,
    ) -> None:
        payload = {
            "decision_count": 1,
            "filled_count": 0,
            "funnel": {
                "buckets": [
                    "not-a-bucket",
                    {
                        "retained_rows": "bad-count",
                        "runtime_evaluable_rows": "2",
                        "quote_valid_rows": "2",
                        "strategy_evaluations": "2",
                        "passed_trace_count": "0",
                        "gate_pass_counts": {"short:structure": "2"},
                        "first_failed_gate_counts": {
                            "short:confirmation": "bad-count",
                            "short:structure": "1",
                        },
                    },
                ]
            },
            "near_misses": [
                {
                    "trading_day": "2026-05-01",
                    "symbol": "AAPL",
                    "strategy_type": "short",
                    "event_ts": "2026-05-01T15:00:00+00:00",
                    "first_failed_gate": "confirmation",
                    "distance_score": "0.02",
                    "thresholds": [
                        "not-a-threshold",
                        {
                            "metric": "rsi14",
                            "value": "72",
                            "threshold": "70",
                            "distance_to_pass": "2",
                        },
                    ],
                }
            ],
        }

        diagnostics = frontier._train_gate_diagnostics_from_replay_payload(payload)

        self.assertEqual(diagnostics["aggregate"]["retained_rows"], 0)
        self.assertEqual(diagnostics["aggregate"]["runtime_evaluable_rows"], 2)
        self.assertEqual(
            diagnostics["top_first_failed_gates"],
            [{"key": "short:structure", "count": 1}],
        )
        self.assertEqual(
            diagnostics["near_misses"][0]["thresholds"],
            [
                {
                    "metric": "rsi14",
                    "value": "72",
                    "threshold": "70",
                    "distance_to_pass": "2",
                }
            ],
        )
