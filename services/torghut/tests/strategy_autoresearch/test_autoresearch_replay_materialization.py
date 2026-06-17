from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.strategy_autoresearch.support import (
    FamilyAutoresearchPlan,
    Namespace,
    Path,
    SignalEnvelope,
    StrategyAutoresearchTestCase,
    TemporaryDirectory,
    UTC,
    _family_template,
    date,
    datetime,
    frontier,
    load_strategy_autoresearch_program,
    patch,
    runner,
    timedelta,
    yaml,
)


class TestStrategyAutoresearchReplayMaterialization(StrategyAutoresearchTestCase):
    def test_frontier_args_forwards_second_oos_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)
            program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
            program_payload["replay_budget"] = {"staged_train_screen_multiplier": 3}
            program_path.write_text(
                yaml.safe_dump(program_payload, sort_keys=False), encoding="utf-8"
            )
            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )
            args = Namespace(
                strategy_configmap=root / "strategy-configmap.yaml",
                family_template_dir=family_dir,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                symbols="",
                progress_log_seconds=30,
                train_days=6,
                holdout_days=3,
                second_oos_days=4,
                full_window_start_date="",
                full_window_end_date="",
                expected_last_trading_day="",
                allow_stale_tape=False,
                prefetch_full_window_rows=False,
                replay_tape_path=root / "tape.jsonl",
                replay_tape_manifest=root / "tape.manifest.json",
                max_candidates_per_frontier_run=0,
                staged_train_screen_multiplier=0,
            )

            frontier_args = runner._frontier_args(
                args=args,
                program=program,
                family_plan=program.families[0],
                sweep_config_path=root / "sweep.yaml",
                json_output_path=root / "result.json",
            )
            args.staged_train_screen_multiplier = 5
            override_frontier_args = runner._frontier_args(
                args=args,
                program=program,
                family_plan=program.families[0],
                sweep_config_path=root / "sweep.yaml",
                json_output_path=root / "override-result.json",
            )

        self.assertEqual(frontier_args.second_oos_days, 4)
        self.assertEqual(
            frontier_args.replay_tape_path, (root / "tape.jsonl").resolve()
        )
        self.assertEqual(
            frontier_args.replay_tape_manifest,
            (root / "tape.manifest.json").resolve(),
        )
        self.assertEqual(frontier_args.loss_repair_iterations, 1)
        self.assertEqual(frontier_args.loss_repair_candidates, 1)
        self.assertEqual(frontier_args.consistency_repair_iterations, 1)
        self.assertEqual(frontier_args.consistency_repair_candidates, 2)
        self.assertEqual(frontier_args.staged_train_screen_multiplier, 3)
        self.assertEqual(override_frontier_args.staged_train_screen_multiplier, 5)

    def test_frontier_staged_search_budget_expands_train_screen_only_stage(
        self,
    ) -> None:
        payload = frontier._staged_search_budget_payload(
            args=Namespace(train_screening=True, staged_train_screen_multiplier=3),
            candidate_budget=96,
            full_replay_candidates_started=12,
            train_screen_only_candidates=40,
        )

        self.assertTrue(payload["enabled"])
        self.assertEqual(payload["train_screen_candidate_budget"], 288)
        self.assertEqual(payload["full_replay_candidate_budget"], 96)
        self.assertEqual(payload["full_replay_candidates_started"], 12)
        self.assertEqual(payload["train_screen_only_candidates"], 40)

    def test_frontier_staged_search_budget_does_not_expand_without_train_screen(
        self,
    ) -> None:
        payload = frontier._staged_search_budget_payload(
            args=Namespace(train_screening=False, staged_train_screen_multiplier=3),
            candidate_budget=96,
        )

        self.assertFalse(payload["enabled"])
        self.assertEqual(payload["train_screen_candidate_budget"], 96)
        self.assertEqual(payload["full_replay_candidate_budget"], 96)

    def test_frontier_staged_search_budget_marks_unbounded_as_disabled(
        self,
    ) -> None:
        payload = frontier._staged_search_budget_payload(
            args=Namespace(train_screening=True, staged_train_screen_multiplier=3),
            candidate_budget=0,
        )

        self.assertFalse(payload["enabled"])
        self.assertEqual(payload["train_screen_candidate_budget"], 0)
        self.assertEqual(payload["full_replay_candidate_budget"], 0)

    def test_history_record_flattens_staged_search_metadata(self) -> None:
        record = runner._history_record(
            runner_run_id="run-1",
            experiment_index=1,
            family_plan=FamilyAutoresearchPlan(
                family_template=_family_template(),
                seed_sweep_config=Path("/tmp/example.yaml"),
                max_iterations=1,
                keep_top_candidates=1,
                frontier_top_n=1,
                force_keep_top_candidate_if_all_vetoed=True,
                symbol_prune_iterations=0,
                symbol_prune_candidates=1,
                symbol_prune_min_universe_size=2,
                loss_repair_iterations=0,
                loss_repair_candidates=1,
                consistency_repair_iterations=0,
                consistency_repair_candidates=2,
                parameter_mutations={},
                strategy_override_mutations={},
            ),
            iteration=1,
            mutation_label="seed",
            parent_candidate_id=None,
            sweep_config_path=Path("/tmp/sweep.yaml"),
            result_path=Path("/tmp/result.json"),
            candidate_payload={
                "candidate_id": "candidate-1",
                "hard_vetoes": [],
                "ranking": {"pareto_tier": 1, "tie_breaker_score": "10"},
                "objective_scorecard": {"net_pnl_per_day": "500"},
                "full_window": {},
                "replay_config": {},
                "staged_search": {
                    "stage": "full_replay",
                    "train_screen_multiplier": 3,
                    "full_replay_candidate_budget": 96,
                    "full_replay_candidates_started": 7,
                },
            },
            rank=1,
            status="keep",
            objective_met=False,
            dataset_snapshot_id="snap-1",
        )

        self.assertEqual(record["staged_search_stage"], "full_replay")
        self.assertEqual(record["staged_train_screen_multiplier"], 3)
        self.assertEqual(record["staged_full_replay_candidate_budget"], "96")
        self.assertEqual(record["staged_full_replay_candidates_started"], 7)

    def test_history_record_flattens_exact_replay_execution_quality(self) -> None:
        candidate_payload = runner._with_exact_replay_execution_quality(
            {
                "candidate_id": "candidate-1",
                "hard_vetoes": [],
                "ranking": {"pareto_tier": 1, "tie_breaker_score": "10"},
                "objective_scorecard": {"net_pnl_per_day": "700"},
                "full_window": {},
                "replay_config": {},
            },
            {
                "candidate_id": "candidate-1",
                "artifact_ref": "/tmp/candidate-1-exact-replay-ledger.json",
                "execution_quality": {
                    "market_order_ratio": "0.8",
                    "limit_order_ratio": "0.2",
                },
                "execution_quality_blockers": [
                    "market_order_share_high",
                    "queue_evidence_missing",
                ],
                "execution_quality_penalty_bps": "35",
                "execution_quality_penalty_amount": "17.5",
                "execution_quality_adjusted_window_net_pnl_per_day": "430",
            },
        )

        record = runner._history_record(
            runner_run_id="run-1",
            experiment_index=1,
            family_plan=FamilyAutoresearchPlan(
                family_template=_family_template(),
                seed_sweep_config=Path("/tmp/example.yaml"),
                max_iterations=1,
                keep_top_candidates=1,
                frontier_top_n=1,
                force_keep_top_candidate_if_all_vetoed=True,
                symbol_prune_iterations=0,
                symbol_prune_candidates=1,
                symbol_prune_min_universe_size=2,
                loss_repair_iterations=0,
                loss_repair_candidates=1,
                consistency_repair_iterations=0,
                consistency_repair_candidates=2,
                parameter_mutations={},
                strategy_override_mutations={},
            ),
            iteration=1,
            mutation_label="seed",
            parent_candidate_id=None,
            sweep_config_path=Path("/tmp/sweep.yaml"),
            result_path=Path("/tmp/result.json"),
            candidate_payload=candidate_payload,
            rank=1,
            status="keep",
            objective_met=False,
            dataset_snapshot_id="snap-1",
        )

        self.assertEqual(
            record["execution_quality"]["market_order_ratio"],
            "0.8",
        )
        self.assertEqual(record["execution_quality_blocker_count"], 2)
        self.assertEqual(record["execution_quality_penalty_bps"], "35")
        self.assertEqual(
            record["execution_quality_adjusted_window_net_pnl_per_day"],
            "430",
        )
        self.assertEqual(
            record["exact_replay_ledger_ranking_authority"],
            "research_ranking_only_not_promotion_proof",
        )
        self.assertNotIn("promotion_allowed", candidate_payload)

    def test_best_history_record_uses_execution_quality_adjusted_cap(self) -> None:
        weak_after_execution_quality = {
            "status": "keep",
            "hard_vetoes": [],
            "pareto_tier": 1,
            "candidate_id": "raw-winner",
            "net_pnl_per_day": "900",
            "deployable_lower_bound_net_pnl_per_day": "900",
            "execution_quality_adjusted_window_net_pnl_per_day": "80",
            "active_day_ratio": "1",
        }
        stronger_after_execution_quality = {
            "status": "keep",
            "hard_vetoes": [],
            "pareto_tier": 1,
            "candidate_id": "adjusted-winner",
            "net_pnl_per_day": "300",
            "deployable_lower_bound_net_pnl_per_day": "300",
            "execution_quality_adjusted_window_net_pnl_per_day": "260",
            "active_day_ratio": "1",
        }

        best = runner._best_history_record(
            [weak_after_execution_quality, stronger_after_execution_quality]
        )

        self.assertEqual(best["candidate_id"], "adjusted-winner")

    def test_maybe_decimal_returns_none_for_invalid_values(self) -> None:
        self.assertIsNone(runner._maybe_decimal("not-a-decimal"))

    def test_exact_replay_ranking_by_candidate_keeps_first_valid_candidate(
        self,
    ) -> None:
        first = {
            "candidate_id": "candidate-1",
            "artifact_ref": "/tmp/first.json",
        }
        second = {
            "candidate_id": "candidate-1",
            "artifact_ref": "/tmp/second.json",
        }

        by_candidate = runner._exact_replay_ranking_by_candidate(
            {
                "candidates": [
                    "not-a-mapping",
                    {"candidate_id": ""},
                    first,
                    second,
                ]
            }
        )

        self.assertEqual(by_candidate, {"candidate-1": first})

    def test_exact_replay_candidate_match_allows_payload_without_artifact_refs(
        self,
    ) -> None:
        exact_candidate = {
            "candidate_id": "candidate-1",
            "artifact_ref": "/tmp/exact.json",
        }

        self.assertEqual(
            runner._exact_replay_candidate_for_payload(
                candidate_payload={"candidate_id": "candidate-1"},
                by_candidate={"candidate-1": exact_candidate},
            ),
            exact_candidate,
        )

    def test_exact_replay_execution_quality_leaves_payload_without_candidate(
        self,
    ) -> None:
        candidate_payload = {
            "candidate_id": "candidate-1",
            "exact_replay_ledger_ranking": {"path": "/tmp/ranking.json"},
        }

        self.assertEqual(
            runner._with_exact_replay_execution_quality(candidate_payload, None),
            candidate_payload,
        )

    def test_exact_replay_candidate_match_rejects_missing_candidate_id(self) -> None:
        self.assertIsNone(
            runner._exact_replay_candidate_for_payload(
                candidate_payload={
                    "exact_replay_ledger_artifact_ref": "/tmp/current.json"
                },
                by_candidate={
                    "candidate-1": {
                        "candidate_id": "candidate-1",
                        "artifact_ref": "/tmp/current.json",
                    }
                },
            )
        )

    def test_exact_replay_candidate_match_rejects_unranked_candidate(self) -> None:
        self.assertIsNone(
            runner._exact_replay_candidate_for_payload(
                candidate_payload={"candidate_id": "candidate-1"},
                by_candidate={},
            )
        )

    def test_exact_replay_candidate_match_rejects_missing_exact_artifact(self) -> None:
        self.assertIsNone(
            runner._exact_replay_candidate_for_payload(
                candidate_payload={
                    "candidate_id": "candidate-1",
                    "exact_replay_ledger_artifact_ref": "/tmp/current.json",
                },
                by_candidate={
                    "candidate-1": {
                        "candidate_id": "candidate-1",
                    }
                },
            )
        )

    def test_exact_replay_candidate_match_returns_matching_artifact(self) -> None:
        exact_candidate = {
            "candidate_id": "candidate-1",
            "artifact_ref": "/tmp/current.json",
        }

        self.assertEqual(
            runner._exact_replay_candidate_for_payload(
                candidate_payload={
                    "candidate_id": "candidate-1",
                    "exact_replay_ledger_artifact_refs": ["/tmp/current.json"],
                },
                by_candidate={"candidate-1": exact_candidate},
            ),
            exact_candidate,
        )

    def test_exact_replay_candidate_match_requires_artifact_when_present(
        self,
    ) -> None:
        exact_candidate = runner._exact_replay_candidate_for_payload(
            candidate_payload={
                "candidate_id": "candidate-1",
                "exact_replay_ledger_artifact_ref": "/tmp/current.json",
            },
            by_candidate={
                "candidate-1": {
                    "candidate_id": "candidate-1",
                    "artifact_ref": "/tmp/stale.json",
                }
            },
        )

        self.assertIsNone(exact_candidate)

    def test_materialize_run_replay_tape_writes_bundle_and_receipt(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
            ]

            with patch(
                "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                return_value=iter(signal_rows),
            ):
                stats, receipt = runner._maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id="strategy-autoresearch-test",
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-20",
                    full_window_end_date="2026-03-20",
                    existing_signal_bundle=None,
                )
            assert receipt is not None
            tape_exists = Path(receipt["tape_path"]).exists()
            manifest_exists = Path(receipt["manifest_path"]).exists()

        assert stats is not None
        self.assertEqual(stats.row_count, 1)
        self.assertEqual(receipt["status"], "materialized")
        self.assertEqual(receipt["row_count"], 1)
        self.assertTrue(tape_exists)
        self.assertTrue(manifest_exists)

    def test_write_signal_bundle_uses_supplied_replay_tape_without_clickhouse(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            tape_path = root / "provided-tape.jsonl"
            signal_row = SignalEnvelope(
                event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                symbol="AMAT",
                seq=1,
                source="ta",
                timeframe="1Sec",
                payload={"price": "180.10"},
            )
            manifest = runner.materialize_signal_tape(
                rows=[signal_row],
                tape_path=tape_path,
                dataset_snapshot_ref="provided-snapshot",
                symbols=("AMAT",),
                start_date=date(2026, 3, 20),
                end_date=date(2026, 3, 20),
                source_query_digest="digest",
            )
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                replay_tape_path=tape_path,
                replay_tape_manifest=runner.default_manifest_path(tape_path),
                allow_stale_tape=False,
            )

            with patch(
                "scripts.run_strategy_autoresearch_loop.replay_mod._http_query",
                side_effect=AssertionError("clickhouse should not be queried"),
            ):
                stats = runner._maybe_write_signal_bundle(
                    args=args,
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-20",
                    full_window_end_date="2026-03-20",
                    existing=None,
                )

        assert stats is not None
        self.assertEqual(stats.row_count, manifest.row_count)
        self.assertEqual(stats.symbol_count, 1)

    def test_materialize_run_replay_tape_selects_latest_complete_window(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
                allow_stale_tape=False,
                latest_complete_window_min_days=1,
                latest_complete_window_receipt_output=None,
                coverage_diagnostic_output=None,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 23, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
            ]
            latest_window_receipt = {
                "schema_version": "torghut.replay-latest-complete-window.v1",
                "requested_start_date": "2026-03-20",
                "requested_end_date": "2026-03-23",
                "effective_start_date": "2026-03-23",
                "effective_end_date": "2026-03-23",
                "selected_trading_days": ["2026-03-23"],
            }

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._select_effective_replay_tape_window",
                    return_value=(
                        date(2026, 3, 23),
                        date(2026, 3, 23),
                        latest_window_receipt,
                    ),
                ) as select_window,
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
            ):
                stats, receipt = runner._maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id="strategy-autoresearch-test",
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-20",
                    full_window_end_date="2026-03-23",
                    existing_signal_bundle=None,
                )

            select_kwargs = select_window.call_args.kwargs
            self.assertEqual(select_kwargs["requested_start_date"], date(2026, 3, 20))
            self.assertEqual(select_kwargs["requested_end_date"], date(2026, 3, 23))
            self.assertEqual(select_kwargs["symbols"], ("AMAT",))
            self.assertEqual(
                select_kwargs["args"].latest_complete_window_receipt_output,
                Path(bundle_paths["replay_tape_latest_complete_window_receipt_json"]),
            )
            self.assertEqual(
                select_kwargs["args"].coverage_diagnostic_output,
                Path(bundle_paths["replay_tape_coverage_diagnostics_json"]),
            )

        assert stats is not None
        assert receipt is not None
        self.assertEqual(stats.row_count, 1)
        self.assertEqual(receipt["requested_full_window_start_date"], "2026-03-20")
        self.assertEqual(receipt["requested_full_window_end_date"], "2026-03-23")
        self.assertEqual(receipt["effective_full_window_start_date"], "2026-03-23")
        self.assertEqual(receipt["effective_full_window_end_date"], "2026-03-23")
        self.assertEqual(receipt["latest_complete_window"], latest_window_receipt)
        self.assertEqual(receipt["row_count"], 1)

    def test_materialize_run_replay_tape_defaults_latest_window_to_objective(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            selected_days: list[date] = []
            current_day = date(2026, 3, 2)
            while current_day <= date(2026, 3, 27):
                if current_day.weekday() < 5:
                    selected_days.append(current_day)
                current_day += timedelta(days=1)
            self.assertEqual(len(selected_days), 20)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
                allow_stale_tape=False,
                latest_complete_window_min_days=0,
                latest_complete_window_receipt_output=None,
                coverage_diagnostic_output=None,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(
                        trading_day.year,
                        trading_day.month,
                        trading_day.day,
                        13,
                        30,
                        tzinfo=UTC,
                    ),
                    symbol="AMAT",
                    seq=index,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
                for index, trading_day in enumerate(selected_days, start=1)
            ]
            latest_window_receipt = {
                "schema_version": "torghut.replay-latest-complete-window.v1",
                "requested_start_date": "2026-03-02",
                "requested_end_date": "2026-03-27",
                "effective_start_date": "2026-03-02",
                "effective_end_date": "2026-03-27",
                "selected_trading_days": [
                    trading_day.isoformat() for trading_day in selected_days
                ],
            }

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._select_effective_replay_tape_window",
                    return_value=(
                        date(2026, 3, 2),
                        date(2026, 3, 27),
                        latest_window_receipt,
                    ),
                ) as select_window,
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
            ):
                stats, receipt = runner._maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id="strategy-autoresearch-test",
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-02",
                    full_window_end_date="2026-03-27",
                    existing_signal_bundle=None,
                    objective_min_observed_trading_days=20,
                )

            select_kwargs = select_window.call_args.kwargs
            self.assertEqual(select_kwargs["args"].latest_complete_window_min_days, 20)

        assert stats is not None
        assert receipt is not None
        self.assertEqual(stats.row_count, 20)
        self.assertEqual(receipt["trading_day_count"], 20)
        self.assertEqual(receipt["objective_min_observed_trading_days"], 20)
        self.assertEqual(receipt["latest_complete_window_min_days"], 20)
        self.assertEqual(
            receipt["latest_complete_window_min_days_source"],
            "objective_min_observed_trading_days",
        )
        self.assertEqual(receipt["latest_complete_window_cli_min_days"], 0)
        self.assertEqual(receipt["latest_complete_window_objective_min_days"], 20)

    def test_materialize_run_replay_tape_does_not_let_cli_lower_objective_window(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            selected_days: list[date] = []
            current_day = date(2026, 3, 2)
            while current_day <= date(2026, 3, 27):
                if current_day.weekday() < 5:
                    selected_days.append(current_day)
                current_day += timedelta(days=1)
            self.assertEqual(len(selected_days), 20)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
                allow_stale_tape=False,
                latest_complete_window_min_days=2,
                latest_complete_window_receipt_output=None,
                coverage_diagnostic_output=None,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(
                        trading_day.year,
                        trading_day.month,
                        trading_day.day,
                        13,
                        30,
                        tzinfo=UTC,
                    ),
                    symbol="AMAT",
                    seq=index,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
                for index, trading_day in enumerate(selected_days, start=1)
            ]
            latest_window_receipt = {
                "schema_version": "torghut.replay-latest-complete-window.v1",
                "requested_start_date": "2026-03-02",
                "requested_end_date": "2026-03-27",
                "effective_start_date": "2026-03-02",
                "effective_end_date": "2026-03-27",
                "selected_trading_days": [
                    trading_day.isoformat() for trading_day in selected_days
                ],
            }

            with (
                patch(
                    "scripts.run_strategy_autoresearch_loop._select_effective_replay_tape_window",
                    return_value=(
                        date(2026, 3, 2),
                        date(2026, 3, 27),
                        latest_window_receipt,
                    ),
                ) as select_window,
                patch(
                    "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                    return_value=iter(signal_rows),
                ),
            ):
                stats, receipt = runner._maybe_materialize_run_replay_tape(
                    args=args,
                    runner_run_id="strategy-autoresearch-test",
                    snapshot_symbols=("AMAT",),
                    bundle_paths=bundle_paths,
                    full_window_start_date="2026-03-02",
                    full_window_end_date="2026-03-27",
                    existing_signal_bundle=None,
                    objective_min_observed_trading_days=20,
                )

            select_kwargs = select_window.call_args.kwargs
            self.assertEqual(select_kwargs["args"].latest_complete_window_min_days, 20)

        assert stats is not None
        assert receipt is not None
        self.assertEqual(stats.row_count, 20)
        self.assertEqual(receipt["latest_complete_window_min_days"], 20)
        self.assertEqual(
            receipt["latest_complete_window_min_days_source"],
            "objective_min_observed_trading_days_floor",
        )
        self.assertEqual(receipt["latest_complete_window_cli_min_days"], 2)
        self.assertEqual(receipt["latest_complete_window_objective_min_days"], 20)

    def test_materialize_run_replay_tape_fails_closed_on_missing_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "strategy-configmap.yaml"
            configmap_path.write_text("apiVersion: v1\nkind: ConfigMap\n")
            bundle_paths = runner._mlx_bundle_paths(root)
            args = Namespace(
                strategy_configmap=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity="31590.02",
                chunk_minutes=10,
                progress_log_seconds=30,
                materialize_replay_tape=True,
                replay_tape_path=None,
                allow_stale_tape=False,
            )
            signal_rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
                    symbol="AMAT",
                    seq=1,
                    source="ta",
                    timeframe="1Sec",
                    payload={"price": "180.10"},
                )
            ]

            with patch(
                "scripts.run_strategy_autoresearch_loop.replay_mod._iter_signal_rows",
                return_value=iter(signal_rows),
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-03-23",
                ):
                    runner._maybe_materialize_run_replay_tape(
                        args=args,
                        runner_run_id="strategy-autoresearch-test",
                        snapshot_symbols=("AMAT",),
                        bundle_paths=bundle_paths,
                        full_window_start_date="2026-03-20",
                        full_window_end_date="2026-03-23",
                        existing_signal_bundle=None,
                    )

            self.assertFalse(Path(bundle_paths["replay_tape_jsonl"]).exists())
            self.assertFalse(Path(bundle_paths["replay_tape_manifest_json"]).exists())

    def test_provided_replay_tape_receipt_reads_manifest_and_handles_missing(
        self,
    ) -> None:
        signal_row = SignalEnvelope(
            event_ts=datetime(2026, 3, 20, 13, 30, tzinfo=UTC),
            symbol="AMAT",
            seq=1,
            source="ta",
            timeframe="1Sec",
            payload={"price": "180.10"},
        )
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tape_path = root / "provided-tape.jsonl"
            missing_tape_path = root / "missing-tape.jsonl"
            manifest = runner.materialize_signal_tape(
                rows=[signal_row],
                tape_path=tape_path,
                dataset_snapshot_ref="provided-snapshot",
                symbols=("AMAT",),
                start_date=date(2026, 3, 20),
                end_date=date(2026, 3, 20),
                source_query_digest="digest",
            )

            missing_receipt = runner._provided_replay_tape_receipt(
                tape_path=missing_tape_path, manifest_path=None
            )
            receipt = runner._provided_replay_tape_receipt(
                tape_path=tape_path, manifest_path=None
            )

        self.assertIsNone(missing_receipt)
        assert receipt is not None
        self.assertEqual(receipt["status"], "provided")
        self.assertEqual(receipt["row_count"], manifest.row_count)
        self.assertEqual(receipt["dataset_snapshot_ref"], "provided-snapshot")
