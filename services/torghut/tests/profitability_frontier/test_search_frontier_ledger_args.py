from __future__ import annotations

from tests.profitability_frontier.search_frontier_base import (
    Decimal,
    Namespace,
    Path,
    SearchConsistentProfitabilityFrontierTestCaseBase,
    SignalEnvelope,
    TemporaryDirectory,
    _authoritative_exact_replay_ledger_payload,
    _authoritative_exact_replay_rows,
    build_source_query_digest,
    cast,
    date,
    datetime,
    frontier,
    io,
    json,
    materialize_signal_tape,
    patch,
    redirect_stderr,
    redirect_stdout,
    sys,
    timezone,
)


class TestSearchFrontierLedgerArgs(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_exact_replay_ledger_artifact_update_stamps_authoritative_bucket(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = Namespace(json_output=root / "frontier.json")

            update = frontier._exact_replay_ledger_artifact_update(
                args=args,
                root=root,
                candidate_index=3,
                candidate_id="candidate-ledger-authority",
                full_window_payload={
                    "exact_replay_ledger": _authoritative_exact_replay_ledger_payload()
                },
                dataset_snapshot_id="snapshot-ledger",
                replay_lineage={"lineage_hash": "lineage-sha"},
                candidate_evaluation_key={"candidate_evaluation_key": "eval-key"},
                candidate_symbols=("NVDA",),
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 23),
            )

            exact_ledger_ref = Path(update["exact_replay_ledger_artifact_ref"])

            self.assertTrue(exact_ledger_ref.exists())
            self.assertEqual(update["exact_replay_ledger_artifact_row_count"], 6)
            self.assertEqual(update["exact_replay_ledger_artifact_fill_count"], 2)
            self.assertNotIn("runtime_ledger_artifact_ref", update)
            self.assertNotIn("runtime_ledger_artifact_row_count", update)
            self.assertNotIn("runtime_ledger_artifact_fill_count", update)
            self.assertNotIn("runtime_ledger_artifact_proof_authority", update)
            self.assertEqual(update["runtime_ledger_closed_trade_count"], 1)
            self.assertEqual(update["runtime_ledger_open_position_count"], 0)
            self.assertEqual(update["runtime_ledger_filled_notional"], "201")
            self.assertEqual(
                update["runtime_ledger_net_strategy_pnl_after_costs"], "0.80"
            )
            self.assertGreater(
                Decimal(str(update["runtime_ledger_post_cost_expectancy_bps"])),
                Decimal("0"),
            )
            self.assertEqual(
                update["runtime_ledger_pnl_basis"],
                "realized_strategy_pnl_after_explicit_costs",
            )
            self.assertEqual(
                update["runtime_ledger_pnl_source"],
                "exact_replay_runtime_ledger",
            )

    def test_exact_replay_ledger_artifact_update_rejects_weak_bucket(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = Namespace(json_output=root / "frontier.json")

            update = frontier._exact_replay_ledger_artifact_update(
                args=args,
                root=root,
                candidate_index=4,
                candidate_id="candidate-placeholder-ledger",
                full_window_payload={
                    "exact_replay_ledger": _authoritative_exact_replay_ledger_payload(
                        rows=[
                            {
                                "event_type": "fill",
                                "executed_at": "2026-03-18T14:35:02+00:00",
                                "decision_id": "decision-buy",
                                "order_id": "order-buy",
                                "symbol": "NVDA",
                                "side": "buy",
                                "filled_qty": "1",
                                "avg_fill_price": "100",
                                "cost_amount": "0.10",
                                "cost_basis": "local_replay_transaction_cost_model",
                            },
                        ],
                        fill_row_count=1,
                    )
                },
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 23),
            )

        self.assertEqual(update, {})

    def test_exact_replay_ledger_artifact_update_rejects_fill_count_mismatch(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = Namespace(json_output=root / "frontier.json")

            update = frontier._exact_replay_ledger_artifact_update(
                args=args,
                root=root,
                candidate_index=5,
                candidate_id="candidate-mismatched-ledger",
                full_window_payload={
                    "exact_replay_ledger": _authoritative_exact_replay_ledger_payload(
                        fill_row_count=1
                    )
                },
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 23),
            )

        self.assertEqual(update, {})

    def test_exact_replay_ledger_artifact_update_rejects_malformed_fill_count(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = Namespace(json_output=root / "frontier.json")
            ledger_payload = _authoritative_exact_replay_ledger_payload()
            ledger_payload["fill_row_count"] = "not-an-int"

            update = frontier._exact_replay_ledger_artifact_update(
                args=args,
                root=root,
                candidate_index=6,
                candidate_id="candidate-malformed-ledger",
                full_window_payload={"exact_replay_ledger": ledger_payload},
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 23),
            )

        self.assertEqual(update, {})

    def test_exact_replay_ledger_artifact_update_rejects_missing_bucket_range(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = Namespace(json_output=root / "frontier.json")

            update = frontier._exact_replay_ledger_artifact_update(
                args=args,
                root=root,
                candidate_index=7,
                candidate_id="candidate-missing-window-ledger",
                full_window_payload={
                    "exact_replay_ledger": _authoritative_exact_replay_ledger_payload()
                },
            )

        self.assertEqual(update, {})

    def test_exact_replay_ledger_artifact_update_rejects_non_mapping_rows(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = Namespace(json_output=root / "frontier.json")

            update = frontier._exact_replay_ledger_artifact_update(
                args=args,
                root=root,
                candidate_index=8,
                candidate_id="candidate-bad-row-ledger",
                full_window_payload={
                    "exact_replay_ledger": _authoritative_exact_replay_ledger_payload(
                        rows=cast(list[dict[str, object]], ["bad-row"])
                    )
                },
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 23),
            )

        self.assertEqual(update, {})

    def test_frontier_ledger_datetime_handles_empty_invalid_and_timezone_forms(
        self,
    ) -> None:
        self.assertIsNone(frontier._frontier_ledger_datetime(""))
        self.assertIsNone(frontier._frontier_ledger_datetime("not-a-date"))
        self.assertEqual(
            frontier._frontier_ledger_datetime("2026-03-18T14:35:00"),
            datetime(2026, 3, 18, 14, 35, tzinfo=timezone.utc),
        )
        self.assertEqual(
            frontier._frontier_ledger_datetime("2026-03-18T14:35:00Z"),
            datetime(2026, 3, 18, 14, 35, tzinfo=timezone.utc),
        )

    def test_frontier_exact_replay_bucket_rejects_empty_bucket_build(self) -> None:
        with patch(
            "scripts.consistent_profitability_frontier.ledger_order.build_runtime_ledger_buckets",
            return_value=[],
        ):
            bucket = frontier._frontier_exact_replay_bucket(
                ledger_payload=_authoritative_exact_replay_ledger_payload(),
                raw_rows=_authoritative_exact_replay_rows(),
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 23),
            )

        self.assertIsNone(bucket)

    def test_candidate_replay_lineage_payload_hashes_window_coverage(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            candidate_configmap = root / "candidate.yaml"
            candidate_configmap.write_text("data:\n  strategies.yaml: '{}'\n")
            replay_payload = self._payload(
                start_date="2026-03-18",
                end_date="2026-03-19",
                daily_net={"2026-03-18": "100", "2026-03-19": "150"},
                decision_count=2,
                filled_count=2,
                wins=2,
                losses=0,
            )
            window = frontier.FrontierReplayWindows(
                train_days=(date(2026, 3, 18),),
                holdout_days=(date(2026, 3, 19),),
                second_oos_days=(),
            )

            lineage = frontier._candidate_replay_lineage_payload(
                candidate_configmap_path=candidate_configmap,
                candidate_search_key="candidate-key",
                dataset_snapshot_id="snapshot-lineage",
                train_payload=replay_payload,
                holdout_payload=replay_payload,
                full_window_payload=replay_payload,
                second_oos_payload=None,
                window=window,
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 19),
                holdout_replay_skipped=False,
                full_window_replay_skipped=False,
            )

        coverage = frontier._replay_window_coverage_payload(lineage)
        self.assertEqual(
            lineage["schema_version"], "torghut.frontier-replay-lineage.v1"
        )
        self.assertEqual(lineage["missing_windows"], [])
        self.assertEqual(
            lineage["present_windows"], ["train", "holdout", "full_window"]
        )
        self.assertTrue(lineage["lineage_hash"])
        self.assertEqual(
            len(lineage["windows"]["full_window"]["daily_filled_notional_sha256"]),
            64,
        )
        self.assertEqual(
            len(lineage["windows"]["full_window"]["daily_liquidity_notional_sha256"]),
            64,
        )
        self.assertEqual(coverage["lineage_hash"], lineage["lineage_hash"])
        self.assertEqual(coverage["window_count"], 3)

    def test_parse_args_supports_harness_v2_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = root / "strategies.yaml"
            sweep_config = root / "sweep.yaml"
            family_dir = root / "families"
            strategy_configmap.write_text(
                "apiVersion: v1\nkind: ConfigMap\n", encoding="utf-8"
            )
            sweep_config.write_text(
                "family: breakout_reclaim\nstrategy_name: intraday-tsmom-profit-v3\n",
                encoding="utf-8",
            )
            family_dir.mkdir()
            with patch.object(
                sys,
                "argv",
                [
                    "prog",
                    "--strategy-configmap",
                    str(strategy_configmap),
                    "--sweep-config",
                    str(sweep_config),
                    "--expected-last-trading-day",
                    "2026-04-07",
                    "--clickhouse-password-env",
                    "TORGHUT_CLICKHOUSE_PASSWORD",
                    "--allow-stale-tape",
                    "--replay-tape-path",
                    str(root / "tape.jsonl"),
                    "--replay-tape-manifest",
                    str(root / "tape.jsonl.manifest.json"),
                    "--family-template-dir",
                    str(family_dir),
                    "--max-candidates-to-evaluate",
                    "12",
                    "--staged-train-screen-multiplier",
                    "3",
                    "--candidate-record",
                    str(root / "candidate.json"),
                    "--capture-rejected-seed-full-window-ledger",
                    "--capture-positive-rejected-full-window-ledgers",
                    "2",
                    "--no-train-screening",
                    "--min-train-screen-net-per-day",
                    "-50",
                    "--min-train-screen-active-ratio",
                    "0.25",
                    "--max-train-screen-worst-day-loss",
                    "125",
                    "--second-oos-days",
                    "2",
                    "--collect-train-gate-diagnostics",
                ],
            ):
                args = frontier._parse_args()

        self.assertEqual(args.expected_last_trading_day, "2026-04-07")
        self.assertEqual(args.clickhouse_password_env, "TORGHUT_CLICKHOUSE_PASSWORD")
        self.assertTrue(args.allow_stale_tape)
        self.assertEqual(args.replay_tape_path, root / "tape.jsonl")
        self.assertEqual(args.replay_tape_manifest, root / "tape.jsonl.manifest.json")
        self.assertEqual(args.family_template_dir, family_dir)
        self.assertEqual(args.max_candidates_to_evaluate, 12)
        self.assertEqual(args.staged_train_screen_multiplier, 3)
        self.assertEqual(args.candidate_record, [root / "candidate.json"])
        self.assertTrue(args.capture_rejected_seed_full_window_ledger)
        self.assertEqual(args.capture_positive_rejected_full_window_ledgers, 2)
        self.assertFalse(args.train_screening)
        self.assertEqual(args.min_train_screen_net_per_day, "-50")
        self.assertEqual(args.min_train_screen_active_ratio, "0.25")
        self.assertEqual(args.max_train_screen_worst_day_loss, "125")
        self.assertEqual(args.second_oos_days, 2)
        self.assertTrue(args.collect_train_gate_diagnostics)

    def test_parse_args_uses_repo_root_strategy_configmap_by_default(self) -> None:
        with patch.object(sys, "argv", ["prog"]):
            args = frontier._parse_args()

        expected = (
            Path(__file__).resolve().parents[4]
            / "argocd/applications/torghut/strategy-configmap.yaml"
        )
        self.assertEqual(args.strategy_configmap, expected)
        self.assertTrue(args.strategy_configmap.exists())

    def test_clickhouse_preflight_fails_fast_for_unresolved_in_cluster_dns(
        self,
    ) -> None:
        args = Namespace(
            replay_tape_path=None,
            clickhouse_http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )

        with patch(
            "scripts.search_consistent_profitability_frontier.socket.getaddrinfo",
            side_effect=frontier.socket.gaierror("not known"),
        ):
            failure = frontier._clickhouse_endpoint_preflight_failure(args)

        self.assertIn("clickhouse_endpoint_unreachable", failure)
        self.assertIn("TA_CLICKHOUSE_URL", failure)
        self.assertIn("--clickhouse-http-url", failure)

    def test_clickhouse_preflight_skips_when_replay_tape_is_supplied(self) -> None:
        args = Namespace(
            replay_tape_path=Path("/tmp/replay-tape.jsonl"),
            clickhouse_http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )

        with patch(
            "scripts.search_consistent_profitability_frontier.socket.getaddrinfo",
            side_effect=AssertionError("replay tape should bypass DNS preflight"),
        ):
            failure = frontier._clickhouse_endpoint_preflight_failure(args)

        self.assertEqual(failure, "")

    def test_main_writes_error_json_for_clickhouse_preflight_failure(self) -> None:
        with TemporaryDirectory() as tmpdir:
            json_output = Path(tmpdir) / "frontier.json"
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "search_consistent_profitability_frontier.py",
                        "--clickhouse-http-url",
                        "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
                        "--json-output",
                        str(json_output),
                    ],
                ),
                patch(
                    "scripts.search_consistent_profitability_frontier.socket.getaddrinfo",
                    side_effect=frontier.socket.gaierror("not known"),
                ),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                code = frontier.main()

            payload = json.loads(json_output.read_text(encoding="utf-8"))

        self.assertEqual(code, 1)
        self.assertEqual(payload["status"], "error")
        self.assertEqual(
            payload["schema_version"],
            "torghut.consistent-profitability-frontier-error.v1",
        )
        self.assertIn("clickhouse_endpoint_unreachable", payload["error"])
        self.assertIn("--replay-tape-path", payload["remediation"][-1])

    def test_load_replay_tape_rows_validates_and_slices_rows(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tape_path = root / "frontier-tape.jsonl"
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 18, 17, 30, tzinfo=timezone.utc),
                        symbol="NVDA",
                        timeframe="1Sec",
                        seq=1,
                        source="ta",
                        payload={"price": Decimal("900.00")},
                    ),
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 19, 17, 30, tzinfo=timezone.utc),
                        symbol="META",
                        timeframe="1Sec",
                        seq=2,
                        source="ta",
                        payload={"price": Decimal("500.00")},
                    ),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-frontier",
                symbols=("NVDA", "META"),
                start_date=date(2026, 3, 18),
                end_date=date(2026, 3, 19),
                source_query_digest=build_source_query_digest({"query": "frontier"}),
            )

            rows, validation = frontier._load_replay_tape_rows(
                tape_path=tape_path,
                manifest_path=None,
                start_date=date(2026, 3, 18),
                end_date=date(2026, 3, 18),
                symbols=("NVDA",),
                allow_stale_tape=False,
            )

        self.assertEqual([row.symbol for row in rows], ["NVDA"])
        self.assertEqual(validation["status"], "valid")
        self.assertEqual(validation["requested_symbols"], ["NVDA"])
        self.assertEqual(validation["selected_row_count"], 1)
        self.assertEqual(validation["selected_symbols"], ["NVDA"])
        self.assertEqual(
            validation["source_query_digest"],
            build_source_query_digest({"query": "frontier"}),
        )
        self.assertEqual(validation["manifest_path"], "")

    def test_load_replay_tape_rows_rejects_absent_requested_symbol_from_unscoped_manifest(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tape_path = root / "frontier-tape.jsonl"
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 3, 18, 17, 30, tzinfo=timezone.utc),
                        symbol="META",
                        timeframe="1Sec",
                        seq=1,
                        source="ta",
                        payload={"price": Decimal("500.00")},
                    ),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-frontier",
                symbols=(),
                start_date=date(2026, 3, 18),
                end_date=date(2026, 3, 18),
                source_query_digest=build_source_query_digest({"query": "frontier"}),
            )

            with self.assertRaisesRegex(ValueError, "symbols_not_covered:NVDA"):
                frontier._load_replay_tape_rows(
                    tape_path=tape_path,
                    manifest_path=None,
                    start_date=date(2026, 3, 18),
                    end_date=date(2026, 3, 18),
                    symbols=("NVDA",),
                    allow_stale_tape=False,
                )

    def test_clickhouse_password_env_resolution_keeps_secret_out_of_argv(self) -> None:
        with patch.dict("os.environ", {"TORGHUT_CLICKHOUSE_PASSWORD": "from-env"}):
            resolved = frontier._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="",
                    clickhouse_password_env="TORGHUT_CLICKHOUSE_PASSWORD",
                )
            )
            direct = frontier._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="direct",
                    clickhouse_password_env="TORGHUT_CLICKHOUSE_PASSWORD",
                )
            )

        self.assertEqual(resolved, "from-env")
        self.assertEqual(direct, "direct")

    def test_rolling_lower_bound_handles_empty_and_short_windows(self) -> None:
        self.assertEqual(frontier._rolling_lower_bound({}, window=3), Decimal("0"))
        self.assertEqual(
            frontier._rolling_lower_bound(
                {"2026-04-03": Decimal("30"), "2026-04-04": Decimal("60")},
                window=5,
            ),
            Decimal("45"),
        )

    def test_selected_normalization_regime_prefers_override(self) -> None:
        self.assertEqual(
            frontier._selected_normalization_regime(
                strategy_overrides={"normalization_regime": "matched_filter"},
                template_allowed_normalizations=("trading_value_scaled",),
            ),
            "matched_filter",
        )

    def test_candidate_search_key_ignores_local_only_overrides(self) -> None:
        left = frontier._candidate_search_key(
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "universe_symbols": ["NVDA", "AMAT"],
                "normalization_regime": "price_scaled",
            },
        )
        right = frontier._candidate_search_key(
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "universe_symbols": ["NVDA", "AMAT"],
                "normalization_regime": "matched_filter",
            },
        )

        self.assertEqual(left, right)

    def test_candidate_evaluation_key_binds_replay_and_cost_proof_context(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            candidate_configmap = root / "candidate.yaml"
            candidate_configmap.write_text("data:\n  strategies.yaml: '{}'\n")
            replay_payload = self._payload(
                start_date="2026-03-18",
                end_date="2026-03-19",
                daily_net={"2026-03-18": "100", "2026-03-19": "150"},
                decision_count=2,
                filled_count=2,
                wins=2,
                losses=0,
            )
            window = frontier.FrontierReplayWindows(
                train_days=(date(2026, 3, 18),),
                holdout_days=(date(2026, 3, 19),),
                second_oos_days=(),
            )
            lineage = frontier._candidate_replay_lineage_payload(
                candidate_configmap_path=candidate_configmap,
                candidate_search_key="candidate-key",
                dataset_snapshot_id="snapshot-lineage",
                train_payload=replay_payload,
                holdout_payload=replay_payload,
                full_window_payload=replay_payload,
                second_oos_payload=None,
                window=window,
                full_window_start=date(2026, 3, 18),
                full_window_end=date(2026, 3, 19),
                holdout_replay_skipped=False,
                full_window_replay_skipped=False,
            )

        base = frontier._candidate_evaluation_key_payload(
            candidate_search_key="candidate-key",
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "price_scaled",
                "universe_symbols": ["NVDA"],
            },
            replay_lineage=lineage,
            replay_tape_validation={
                "content_sha256": "tape-sha",
                "dataset_snapshot_ref": "snapshot-lineage",
                "source_query_digest": "query-sha",
                "source_table_versions": {"signals": "v1"},
                "feature_schema_hash": "feature-sha",
                "cost_model_hash": "cost-sha",
                "strategy_family": "hpairs",
                "feature_versions": {"hpairs": "v1"},
                "replay_cache_key": "cache-key",
                "selected_symbols": ["NVDA"],
                "selected_row_count": 10,
                "status": "valid",
            },
            window=window,
            full_window_start=date(2026, 3, 18),
            full_window_end=date(2026, 3, 19),
            full_window_summary={
                "market_impact_stress_model": "impact-v1",
                "market_impact_stress_cost_bps": "8",
                "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                "delay_adjusted_depth_stress_ms": "50",
                "implementation_uncertainty_model": "interval-v1",
            },
        )
        changed_tape = frontier._candidate_evaluation_key_payload(
            candidate_search_key="candidate-key",
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "price_scaled",
                "universe_symbols": ["NVDA"],
            },
            replay_lineage=lineage,
            replay_tape_validation={
                "content_sha256": "different-tape-sha",
                "dataset_snapshot_ref": "snapshot-lineage",
                "source_query_digest": "query-sha",
                "source_table_versions": {"signals": "v1"},
                "feature_schema_hash": "feature-sha",
                "cost_model_hash": "cost-sha",
                "strategy_family": "hpairs",
                "feature_versions": {"hpairs": "v1"},
                "replay_cache_key": "cache-key",
                "selected_symbols": ["NVDA"],
                "selected_row_count": 10,
                "status": "valid",
            },
            window=window,
            full_window_start=date(2026, 3, 18),
            full_window_end=date(2026, 3, 19),
            full_window_summary={
                "market_impact_stress_model": "impact-v1",
                "market_impact_stress_cost_bps": "8",
                "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                "delay_adjusted_depth_stress_ms": "50",
                "implementation_uncertainty_model": "interval-v1",
            },
        )
        changed_cost = frontier._candidate_evaluation_key_payload(
            candidate_search_key="candidate-key",
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "price_scaled",
                "universe_symbols": ["NVDA"],
            },
            replay_lineage=lineage,
            replay_tape_validation={
                "content_sha256": "tape-sha",
                "dataset_snapshot_ref": "snapshot-lineage",
                "source_query_digest": "query-sha",
                "source_table_versions": {"signals": "v1"},
                "feature_schema_hash": "feature-sha",
                "cost_model_hash": "cost-sha",
                "strategy_family": "hpairs",
                "feature_versions": {"hpairs": "v1"},
                "replay_cache_key": "cache-key",
                "selected_symbols": ["NVDA"],
                "selected_row_count": 10,
                "status": "valid",
            },
            window=window,
            full_window_start=date(2026, 3, 18),
            full_window_end=date(2026, 3, 19),
            full_window_summary={
                "market_impact_stress_model": "impact-v2",
                "market_impact_stress_cost_bps": "12",
                "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                "delay_adjusted_depth_stress_ms": "50",
                "implementation_uncertainty_model": "interval-v1",
            },
        )
        changed_feature_schema = frontier._candidate_evaluation_key_payload(
            candidate_search_key="candidate-key",
            params_candidate={"long_stop_loss_bps": "12"},
            strategy_overrides={
                "normalization_regime": "price_scaled",
                "universe_symbols": ["NVDA"],
            },
            replay_lineage=lineage,
            replay_tape_validation={
                "content_sha256": "tape-sha",
                "dataset_snapshot_ref": "snapshot-lineage",
                "source_query_digest": "query-sha",
                "source_table_versions": {"signals": "v1"},
                "feature_schema_hash": "feature-sha-v2",
                "cost_model_hash": "cost-sha",
                "strategy_family": "hpairs",
                "feature_versions": {"hpairs": "v2"},
                "replay_cache_key": "cache-key-v2",
                "selected_symbols": ["NVDA"],
                "selected_row_count": 10,
                "status": "valid",
            },
            window=window,
            full_window_start=date(2026, 3, 18),
            full_window_end=date(2026, 3, 19),
            full_window_summary={
                "market_impact_stress_model": "impact-v1",
                "market_impact_stress_cost_bps": "8",
                "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                "delay_adjusted_depth_stress_ms": "50",
                "implementation_uncertainty_model": "interval-v1",
            },
        )

        self.assertEqual(base["schema_version"], "torghut.candidate-evaluation-key.v1")
        self.assertEqual(base["replay_tape"]["source_query_digest"], "query-sha")
        self.assertEqual(base["replay_tape"]["feature_schema_hash"], "feature-sha")
        self.assertEqual(base["replay_tape"]["cost_model_hash"], "cost-sha")
        self.assertEqual(base["replay_tape"]["strategy_family"], "hpairs")
        self.assertEqual(
            base["effective_strategy_config_sha256"],
            lineage["candidate_configmap_sha256"],
        )
        self.assertNotEqual(
            base["candidate_evaluation_key"],
            changed_tape["candidate_evaluation_key"],
        )
        self.assertNotEqual(
            base["candidate_evaluation_key"],
            changed_cost["candidate_evaluation_key"],
        )
        self.assertNotEqual(
            base["candidate_evaluation_key"],
            changed_feature_schema["candidate_evaluation_key"],
        )

    def test_rank_scored_candidates_uses_deployable_lower_bound_for_ordering(
        self,
    ) -> None:
        def scored_candidate(
            *,
            candidate_id: str,
            net_pnl_per_day: str,
            deployable_lower_bound: str | None,
            include_fill_survival: bool = True,
        ) -> dict[str, object]:
            scorecard: dict[str, object] = {
                "net_pnl_per_day": net_pnl_per_day,
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "avg_filled_notional_per_day": "300000",
                "avg_filled_notional_per_active_day": "300000",
                "worst_day_loss": "0",
                "max_drawdown": "30",
                "best_day_share": "0.10",
                "negative_day_count": 0,
                "rolling_3d_lower_bound": "300",
                "rolling_5d_lower_bound": "300",
                "regime_slice_pass_rate": "1",
                "symbol_concentration_share": "0.10",
                "entry_family_contribution_share": "0.10",
            }
            if deployable_lower_bound is not None:
                scorecard.update(
                    {
                        "market_impact_stress_passed": True,
                        "market_impact_stress_net_pnl_per_day": deployable_lower_bound,
                        "delay_adjusted_depth_stress_passed": True,
                        "delay_adjusted_depth_stress_net_pnl_per_day": deployable_lower_bound,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": deployable_lower_bound,
                        "queue_position_survival_fill_curve_evidence_present": True,
                        "queue_position_survival_sample_count": 6,
                        "queue_position_survival_fill_rate": "0.85",
                        "queue_position_survival_queue_ratio_p95": "0.25",
                        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                        "queue_position_survival_queue_ahead_depletion_sample_count": 6,
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 6,
                        "delay_adjusted_depth_fill_survival_evidence_present": True,
                        "delay_adjusted_depth_fill_survival_sample_count": 6,
                        "delay_adjusted_depth_fill_survival_rate": "0.85",
                        "double_oos_passed": True,
                        "double_oos_cost_shock_net_pnl_per_day": deployable_lower_bound,
                        "implementation_uncertainty_stability_passed": True,
                        "implementation_uncertainty_lower_net_pnl_per_day": deployable_lower_bound,
                        "conformal_tail_risk_passed": True,
                        "conformal_tail_risk_adjusted_net_pnl_per_day": deployable_lower_bound,
                    }
                )
                if not include_fill_survival:
                    scorecard.pop("queue_position_survival_fill_curve_evidence_present")
                    scorecard.pop("queue_position_survival_sample_count")
                    scorecard.pop("queue_position_survival_fill_rate")
                    scorecard.pop("queue_position_survival_queue_ratio_p95")
                    scorecard.pop(
                        "queue_position_survival_queue_ahead_depletion_evidence_present"
                    )
                    scorecard.pop(
                        "queue_position_survival_queue_ahead_depletion_sample_count"
                    )
                    scorecard.pop(
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
                    )
                    scorecard.pop(
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count"
                    )
                    scorecard.pop("delay_adjusted_depth_fill_survival_evidence_present")
                    scorecard.pop("delay_adjusted_depth_fill_survival_sample_count")
                    scorecard.pop("delay_adjusted_depth_fill_survival_rate")
            return {
                "candidate_id": candidate_id,
                "full_window": {
                    "trading_day_count": 6,
                    "net_per_day": net_pnl_per_day,
                },
                "hard_vetoes": [],
                "objective_scorecard": scorecard,
            }

        ranked = frontier._rank_scored_candidates(
            [
                scored_candidate(
                    candidate_id="raw-only",
                    net_pnl_per_day="2500",
                    deployable_lower_bound=None,
                ),
                scored_candidate(
                    candidate_id="optimistic",
                    net_pnl_per_day="1500",
                    deployable_lower_bound="220",
                    include_fill_survival=False,
                ),
                scored_candidate(
                    candidate_id="robust",
                    net_pnl_per_day="620",
                    deployable_lower_bound="580",
                ),
            ]
        )

        self.assertEqual(ranked[0]["candidate_id"], "robust")
        raw_only = next(item for item in ranked if item["candidate_id"] == "raw-only")
        self.assertGreater(
            raw_only["objective_scorecard"]["deployable_lower_bound_missing_count"],
            0,
        )
        optimistic = next(
            item for item in ranked if item["candidate_id"] == "optimistic"
        )
        self.assertGreater(
            optimistic["objective_scorecard"][
                "deployable_lower_bound_failed_gate_count"
            ],
            0,
        )
        self.assertEqual(
            ranked[0]["objective_scorecard"]["deployable_lower_bound_net_pnl_per_day"],
            "580",
        )

    def test_deployable_proof_requires_queue_ahead_depletion_survival(self) -> None:
        scorecard: dict[str, object] = {
            "market_impact_stress_passed": True,
            "delay_adjusted_depth_stress_passed": True,
            "double_oos_passed": True,
            "implementation_uncertainty_stability_passed": True,
            "conformal_tail_risk_passed": True,
            "delay_adjusted_depth_fill_survival_evidence_present": True,
            "delay_adjusted_depth_fill_survival_sample_count": 20,
            "delay_adjusted_depth_fill_survival_rate": "0.85",
            "fill_survival_evidence_present": True,
            "fill_survival_sample_count": 20,
            "fill_survival_fill_rate": "0.85",
        }

        self.assertGreater(frontier.deployable_proof_failed_gate_count(scorecard), 0)

        scorecard.update(
            {
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 20,
                "queue_position_survival_fill_rate": "0.85",
            }
        )
        self.assertGreater(frontier.deployable_proof_failed_gate_count(scorecard), 0)

        scorecard.update(
            {
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 20,
            }
        )
        self.assertEqual(frontier.deployable_proof_failed_gate_count(scorecard), 0)

    def test_parameter_grid_items_rejects_non_iterable_shapes(self) -> None:
        with self.assertRaisesRegex(ValueError, "parameter_values_not_sequence:alpha"):
            frontier._parameter_grid_items({"alpha": "1"})
        with self.assertRaisesRegex(ValueError, "parameter_values_not_sequence:alpha"):
            frontier._parameter_grid_items({"alpha": {"nested": "1"}})
        with self.assertRaisesRegex(ValueError, "parameter_values_not_iterable:alpha"):
            frontier._parameter_grid_items({"alpha": 1})

    def test_candidate_record_seed_extracts_exact_strategy_candidate(self) -> None:
        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "candidate.json"
            path.write_text(
                json.dumps(
                    {
                        "candidate_id": "H-TSMOM-LIQ-01",
                        "candidate_strategy": {
                            "strategy_name": "intraday-tsmom-profit-v3",
                            "universe_symbols": ["NVDA", "AAPL"],
                            "max_notional_per_trade": "50000",
                            "max_position_pct_equity": "3.0",
                            "params": {
                                "entry_start_minute_utc": "810",
                                "entry_end_minute_utc": "930",
                                "max_spread_bps": "20",
                                "min_recent_imbalance_pressure": "0.02",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )

            params, overrides = frontier._candidate_record_seed(
                path=path,
                strategy_name="intraday-tsmom-profit-v3",
            )

        self.assertEqual(
            params,
            {
                "entry_start_minute_utc": "810",
                "entry_end_minute_utc": "930",
                "max_spread_bps": "20",
                "min_recent_imbalance_pressure": "0.02",
            },
        )
        self.assertEqual(
            overrides,
            {
                "universe_symbols": ["NVDA", "AAPL"],
                "max_notional_per_trade": "50000",
                "max_position_pct_equity": "3.0",
            },
        )
