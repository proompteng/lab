from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.run_strategy_factory_v2.support import (
    Decimal,
    Namespace,
    OperationalError,
    Path,
    Session,
    TemporaryDirectory,
    VNextExperimentRun,
    VNextExperimentSpec,
    _TestRunStrategyFactoryV2Base,
    json,
    patch,
    runner,
    select,
    sys,
    yaml,
)


class TestParseArgsAndHelpersCoverEdgeCases(_TestRunStrategyFactoryV2Base):
    def test_parse_args_and_helpers_cover_edge_cases(self) -> None:
        with TemporaryDirectory() as tmpdir:
            seed_dir = Path(tmpdir)
            (seed_dir / "profitability-frontier-consistent-invalid.yaml").write_text(
                "[]", encoding="utf-8"
            )
            (seed_dir / "profitability-frontier-consistent-other.yaml").write_text(
                yaml.safe_dump({"family_template_id": "other-family"}, sort_keys=False),
                encoding="utf-8",
            )
            (seed_dir / "profitability-frontier-strict-daily-fallback.yaml").write_text(
                yaml.safe_dump(
                    {"family_template_id": "strict-family"}, sort_keys=False
                ),
                encoding="utf-8",
            )
            with patch.object(
                sys,
                "argv",
                [
                    "run_strategy_factory_v2.py",
                    "--output-dir",
                    tmpdir,
                    "--experiment-id",
                    "exp-1",
                    "--paper-run-id",
                    "paper-1",
                    "--limit",
                    "2",
                    "--clickhouse-password-env",
                    "TORGHUT_CLICKHOUSE_PASSWORD",
                    "--allow-stale-tape",
                    "--prefetch-full-window-rows",
                    "--replay-tape-path",
                    str(seed_dir / "tape.jsonl"),
                    "--replay-tape-manifest",
                    str(seed_dir / "tape.manifest.json"),
                    "--staged-train-screen-multiplier",
                    "4",
                    "--capture-positive-rejected-full-window-ledgers",
                    "2",
                    "--symbol-prune-iterations",
                    "1",
                    "--symbol-prune-candidates",
                    "3",
                    "--symbol-prune-min-universe-size",
                    "5",
                    "--loss-repair-iterations",
                    "1",
                    "--loss-repair-candidates",
                    "2",
                    "--consistency-repair-iterations",
                    "1",
                    "--consistency-repair-candidates",
                    "4",
                    "--no-persist-results",
                ],
            ):
                parsed = runner._parse_args()
            missing_seed = runner._load_seed_sweep_config(
                "missing-family", seed_dir=seed_dir
            )
            fallback = runner._load_seed_sweep_config(
                "strict-family", seed_dir=seed_dir
            )

        self.assertEqual(parsed.output_dir, Path(tmpdir))
        self.assertEqual(parsed.experiment_id, ["exp-1"])
        self.assertEqual(parsed.paper_run_id, ["paper-1"])
        self.assertEqual(parsed.limit, 2)
        self.assertEqual(parsed.clickhouse_password_env, "TORGHUT_CLICKHOUSE_PASSWORD")
        self.assertTrue(parsed.allow_stale_tape)
        self.assertTrue(parsed.prefetch_full_window_rows)
        self.assertEqual(parsed.replay_tape_path, seed_dir / "tape.jsonl")
        self.assertEqual(parsed.replay_tape_manifest, seed_dir / "tape.manifest.json")
        self.assertEqual(parsed.staged_train_screen_multiplier, 4)
        self.assertEqual(parsed.capture_positive_rejected_full_window_ledgers, 2)
        self.assertEqual(parsed.symbol_prune_iterations, 1)
        self.assertEqual(parsed.symbol_prune_candidates, 3)
        self.assertEqual(parsed.symbol_prune_min_universe_size, 5)
        self.assertEqual(parsed.loss_repair_iterations, 1)
        self.assertEqual(parsed.loss_repair_candidates, 2)
        self.assertEqual(parsed.consistency_repair_iterations, 1)
        self.assertEqual(parsed.consistency_repair_candidates, 4)
        self.assertFalse(parsed.persist_results)
        self.assertEqual(runner._list_of_strings("not-a-list"), [])
        self.assertEqual(
            runner._coerce_decimal(Decimal("1.25"), default="0"), Decimal("1.25")
        )
        self.assertEqual(runner._coerce_decimal(7, default="0"), Decimal("7"))
        self.assertEqual(runner._coerce_ratio_days(ratio=Decimal("0"), total_days=5), 0)
        with patch.dict("os.environ", {"TORGHUT_CLICKHOUSE_PASSWORD": "from-env"}):
            self.assertEqual(
                runner._resolved_clickhouse_password(
                    Namespace(
                        clickhouse_password="",
                        clickhouse_password_env="TORGHUT_CLICKHOUSE_PASSWORD",
                    )
                ),
                "from-env",
            )
        self.assertIsNone(missing_seed)
        assert fallback is not None
        self.assertEqual(fallback["family_template_id"], "strict-family")

    def test_parse_args_prefers_clickhouse_http_url_env(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with (
                patch.dict(
                    "os.environ",
                    {
                        "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut",
                        "CLICKHOUSE_HTTP_URL": "http://127.0.0.1:8123",
                        "TA_CLICKHOUSE_USERNAME": "reader",
                    },
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_strategy_factory_v2.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ),
            ):
                parsed = runner._parse_args()

        self.assertEqual(parsed.clickhouse_http_url, "http://127.0.0.1:8123")
        self.assertEqual(parsed.clickhouse_username, "reader")

    def test_frontier_args_forwards_repair_and_proof_capture_controls(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = self._args(
                output_dir=root / "out",
                strategy_configmap=root / "strategy-configmap.yaml",
                family_template_dir=root / "families",
                seed_sweep_dir=root / "seed",
            )
            args.staged_train_screen_multiplier = 5
            args.capture_rejected_seed_full_window_ledger = True
            args.capture_positive_rejected_full_window_ledgers = 3
            args.symbol_prune_iterations = 1
            args.symbol_prune_candidates = 2
            args.symbol_prune_min_universe_size = 4
            args.loss_repair_iterations = 1
            args.loss_repair_candidates = 2
            args.consistency_repair_iterations = 1
            args.consistency_repair_candidates = 3

            frontier_args = runner._frontier_args(
                args=args,
                strategy_configmap=args.strategy_configmap,
                sweep_config=root / "compiled-sweep.yaml",
                json_output=root / "result.json",
            )

        self.assertEqual(frontier_args.staged_train_screen_multiplier, 5)
        self.assertTrue(frontier_args.capture_rejected_seed_full_window_ledger)
        self.assertEqual(frontier_args.capture_positive_rejected_full_window_ledgers, 3)
        self.assertEqual(frontier_args.symbol_prune_iterations, 1)
        self.assertEqual(frontier_args.symbol_prune_candidates, 2)
        self.assertEqual(frontier_args.symbol_prune_min_universe_size, 4)
        self.assertEqual(frontier_args.loss_repair_iterations, 1)
        self.assertEqual(frontier_args.loss_repair_candidates, 2)
        self.assertEqual(frontier_args.consistency_repair_iterations, 1)
        self.assertEqual(frontier_args.consistency_repair_candidates, 3)

    def test_frontier_args_forwards_replay_tape_paths(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            args = self._args(
                output_dir=root / "out",
                strategy_configmap=root / "strategy-configmap.yaml",
                family_template_dir=root / "families",
                seed_sweep_dir=root / "seed",
            )
            args.replay_tape_path = root / "tape.jsonl"
            args.replay_tape_manifest = root / "tape.manifest.json"

            frontier_args = runner._frontier_args(
                args=args,
                strategy_configmap=args.strategy_configmap,
                sweep_config=root / "compiled-sweep.yaml",
                json_output=root / "result.json",
            )

        self.assertEqual(
            frontier_args.replay_tape_path, (root / "tape.jsonl").resolve()
        )
        self.assertEqual(
            frontier_args.replay_tape_manifest,
            (root / "tape.manifest.json").resolve(),
        )

    def test_load_source_experiment_specs_applies_filters(self) -> None:
        with Session(self.engine) as session:
            session.add_all(
                [
                    VNextExperimentSpec(
                        run_id="paper-keep",
                        candidate_id=None,
                        experiment_id="exp-keep",
                        payload_json={"family_template_id": "breakout_reclaim_v2"},
                    ),
                    VNextExperimentSpec(
                        run_id="paper-other",
                        candidate_id=None,
                        experiment_id="exp-other",
                        payload_json={"family_template_id": "breakout_reclaim_v2"},
                    ),
                ]
            )
            session.commit()

        args = Namespace(
            experiment_id=["exp-keep"], paper_run_id=["paper-keep"], limit=10
        )
        with patch(
            "scripts.run_strategy_factory_v2.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            rows = runner._load_source_experiment_specs(args)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].experiment_id, "exp-keep")
        self.assertEqual(rows[0].run_id, "paper-keep")

    def test_compile_sweep_config_raises_for_missing_template_or_runtime_harness(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_dir = root / "families"
            family_dir.mkdir()
            seed_dir = root / "seed"
            seed_dir.mkdir()
            (family_dir / "incomplete_family.yaml").write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.family-template.v1",
                        "family_id": "incomplete_family",
                        "economic_mechanism": "Incomplete.",
                        "supported_markets": ["us_equities_intraday"],
                        "required_features": [],
                        "allowed_normalizations": ["price_scaled"],
                        "entry_motifs": ["breakout"],
                        "exit_motifs": ["stop"],
                        "risk_controls": ["stop_loss"],
                        "activity_model": {},
                        "liquidity_assumptions": {},
                        "regime_activation_rules": [],
                        "day_veto_rules": [],
                        "default_hard_vetoes": {},
                        "default_selection_objectives": {},
                        "runtime_harness": {},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )

            missing_template_row = VNextExperimentSpec(
                run_id="paper-run-1",
                candidate_id=None,
                experiment_id="exp-missing-template",
                payload_json={},
            )
            with self.assertRaisesRegex(
                ValueError, "experiment_family_template_missing:exp-missing-template"
            ):
                runner._compile_sweep_config(
                    experiment_row=missing_template_row,
                    family_dir=family_dir,
                    seed_dir=seed_dir,
                    train_days=6,
                    holdout_days=3,
                )

            incomplete_runtime_row = VNextExperimentSpec(
                run_id="paper-run-2",
                candidate_id=None,
                experiment_id="exp-incomplete-runtime",
                payload_json={"family_template_id": "incomplete_family"},
            )
            with self.assertRaisesRegex(
                ValueError,
                "family_template_runtime_harness_incomplete:incomplete_family",
            ):
                runner._compile_sweep_config(
                    experiment_row=incomplete_runtime_row,
                    family_dir=family_dir,
                    seed_dir=seed_dir,
                    train_days=6,
                    holdout_days=3,
                )

    def test_whitepaper_profit_target_experiments_force_standalone_replay(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            seed_path = (
                seed_sweep_dir / "profitability-frontier-consistent-breakout.yaml"
            )
            seed_payload = yaml.safe_load(seed_path.read_text(encoding="utf-8"))
            seed_payload["disable_other_strategies"] = False
            seed_path.write_text(
                yaml.safe_dump(seed_payload, sort_keys=False),
                encoding="utf-8",
            )
            experiment_row = VNextExperimentSpec(
                run_id="paper-run-standalone",
                candidate_id=None,
                experiment_id="exp-standalone",
                payload_json={
                    "family_template_id": "breakout_reclaim_v2",
                    "selection_objectives": {"target_net_pnl_per_day": "500"},
                    "promotion_contract": {
                        "source": "whitepaper_autoresearch_profit_target",
                    },
                },
            )

            compiled = runner._compile_sweep_config(
                experiment_row=experiment_row,
                family_dir=family_template_dir,
                seed_dir=seed_sweep_dir,
                train_days=6,
                holdout_days=3,
            )

            self.assertTrue(compiled.sweep_config["disable_other_strategies"])

    def test_run_strategy_factory_v2_compiles_executes_and_persists(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            with Session(self.engine) as session:
                session.add(
                    VNextExperimentSpec(
                        run_id="paper-run-1",
                        candidate_id=None,
                        experiment_id="exp-breakout-1",
                        payload_json={
                            "family_template_id": "breakout_reclaim_v2",
                            "paper_claim_links": ["claim-1"],
                            "selection_objectives": {
                                "target_net_pnl_per_day": "320",
                                "require_positive_day_ratio": "0.75",
                            },
                            "hard_vetoes": {
                                "required_min_active_day_ratio": "0.50",
                                "required_min_daily_notional": "210000",
                                "required_max_best_day_share": "0.45",
                                "required_max_worst_day_loss": "350",
                                "required_max_drawdown": "800",
                                "required_min_regime_slice_pass_rate": "0.55",
                            },
                            "template_overrides": {
                                "max_notional_per_trade": "50000",
                                "params": {
                                    "long_stop_loss_bps": "12",
                                },
                            },
                            "feature_variants": ["trading_value_scaled"],
                            "veto_controller_variants": [{"rule": "quote_quality"}],
                        },
                    )
                )
                session.commit()

            fake_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [
                    {
                        "candidate_id": "cand-1",
                        "full_window": {"net_per_day": "321.5"},
                    }
                ],
            }
            with (
                patch(
                    "scripts.run_strategy_factory_v2.SessionLocal",
                    side_effect=lambda: Session(self.engine),
                ),
                patch(
                    "scripts.run_strategy_factory_v2.run_consistent_profitability_frontier",
                    return_value=fake_payload,
                ) as mock_frontier,
            ):
                result = runner.run_strategy_factory_v2(
                    self._args(
                        output_dir=output_dir,
                        strategy_configmap=strategy_configmap,
                        family_template_dir=family_template_dir,
                        seed_sweep_dir=seed_sweep_dir,
                    )
                )

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["count"], 1)
            self.assertEqual(
                result["experiments"][0]["experiment_id"], "exp-breakout-1"
            )
            self.assertEqual(result["experiments"][0]["top_candidate_id"], "cand-1")
            self.assertEqual(result["experiments"][0]["dataset_snapshot_id"], "snap-1")
            self.assertFalse(
                result["experiments"][0]["promotion_readiness"]["promotable"]
            )
            self.assertEqual(
                result["experiments"][0]["promotion_readiness"][
                    "runtime_strategy_name"
                ],
                "breakout-continuation-long-v1",
            )
            mock_frontier.assert_called_once()

            compiled_sweep_path = output_dir / "exp-breakout-1" / "compiled-sweep.yaml"
            compiled = yaml.safe_load(compiled_sweep_path.read_text(encoding="utf-8"))
            self.assertEqual(compiled["family_template_id"], "breakout_reclaim_v2")
            self.assertEqual(compiled["family"], "breakout_continuation_consistent")
            self.assertEqual(compiled["strategy_name"], "breakout-continuation-long-v1")
            self.assertEqual(
                compiled["constraints"]["holdout_target_net_per_day"], "320"
            )
            self.assertEqual(compiled["consistency_constraints"]["min_active_days"], 5)
            self.assertEqual(
                compiled["consistency_constraints"]["min_positive_days"], 7
            )
            self.assertEqual(
                compiled["consistency_constraints"]["min_avg_filled_notional_per_day"],
                "210000",
            )
            self.assertEqual(
                compiled["strategy_overrides"]["normalization_regime"],
                ["trading_value_scaled"],
            )
            self.assertEqual(
                compiled["strategy_overrides"]["max_notional_per_trade"], ["50000"]
            )
            self.assertEqual(compiled["parameters"]["long_stop_loss_bps"], ["12"])
            self.assertEqual(
                compiled["parameters"]["position_isolation_mode"], ["per_strategy"]
            )
            self.assertEqual(
                compiled["experiment_spec"]["paper_claim_links"], ["claim-1"]
            )

            result_path = output_dir / "exp-breakout-1" / "result.json"
            self.assertEqual(
                json.loads(result_path.read_text(encoding="utf-8")), fake_payload
            )

            with Session(self.engine) as session:
                run_row = session.execute(
                    select(VNextExperimentRun).where(
                        VNextExperimentRun.experiment_id == "exp-breakout-1"
                    )
                ).scalar_one()
                self.assertEqual(run_row.candidate_id, "cand-1")
                persisted_spec = session.execute(
                    select(VNextExperimentSpec)
                    .where(VNextExperimentSpec.experiment_id == "exp-breakout-1")
                    .where(VNextExperimentSpec.run_id != "paper-run-1")
                ).scalar_one()
                self.assertEqual(persisted_spec.candidate_id, "cand-1")
                self.assertFalse(
                    persisted_spec.payload_json["promotion_readiness"]["promotable"]
                )
                self.assertEqual(
                    persisted_spec.payload_json["promotion_readiness"]["status"],
                    "blocked_pending_runtime_parity",
                )

    def test_persist_result_updates_existing_candidate_experiment_pair(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            experiment_row = VNextExperimentSpec(
                run_id="paper-run-1",
                candidate_id=None,
                experiment_id="exp-breakout-1",
                payload_json={"family_template_id": "breakout_reclaim_v2"},
            )
            compiled = runner._compile_sweep_config(
                experiment_row=experiment_row,
                family_dir=family_template_dir,
                seed_dir=seed_sweep_dir,
                train_days=6,
                holdout_days=3,
            )
            duplicate_run_experiment = runner._compile_sweep_config(
                experiment_row=VNextExperimentSpec(
                    run_id="paper-run-1",
                    candidate_id=None,
                    experiment_id="exp-breakout-2",
                    payload_json={"family_template_id": "breakout_reclaim_v2"},
                ),
                family_dir=family_template_dir,
                seed_dir=seed_sweep_dir,
                train_days=6,
                holdout_days=3,
            )
            experiment_root = output_dir / compiled.experiment_id
            experiment_root.mkdir()
            compiled_sweep_path = experiment_root / "compiled-sweep.yaml"
            result_path = experiment_root / "result.json"
            result_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [
                    {
                        "candidate_id": "cand-duplicate",
                        "full_window": {"net_per_day": "501"},
                    }
                ],
            }

            with patch(
                "scripts.run_strategy_factory_v2.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ):
                runner._persist_result(
                    runner_run_id="strategy-factory-v2-old",
                    experiment=compiled,
                    result_payload=result_payload,
                    compiled_sweep_path=compiled_sweep_path,
                    result_path=result_path,
                )
                runner._persist_result(
                    runner_run_id="strategy-factory-v2-new",
                    experiment=compiled,
                    result_payload=result_payload,
                    compiled_sweep_path=compiled_sweep_path,
                    result_path=result_path,
                )
                runner._persist_result(
                    runner_run_id="strategy-factory-v2-new",
                    experiment=duplicate_run_experiment,
                    result_payload=result_payload,
                    compiled_sweep_path=compiled_sweep_path,
                    result_path=result_path,
                )

            with Session(self.engine) as session:
                persisted_specs = (
                    session.execute(
                        select(VNextExperimentSpec).where(
                            VNextExperimentSpec.candidate_id == "cand-duplicate",
                            VNextExperimentSpec.experiment_id == "exp-breakout-1",
                        )
                    )
                    .scalars()
                    .all()
                )
                self.assertEqual(len(persisted_specs), 1)
                self.assertEqual(persisted_specs[0].run_id, "strategy-factory-v2-new")
                self.assertEqual(
                    persisted_specs[0].payload_json["runner_run_id"],
                    "strategy-factory-v2-new",
                )
                run_row = session.execute(
                    select(VNextExperimentRun).where(
                        VNextExperimentRun.candidate_id == "cand-duplicate",
                        VNextExperimentRun.run_id == "strategy-factory-v2-new",
                    )
                ).scalar_one()
                self.assertEqual(run_row.experiment_id, "exp-breakout-2")

    def test_persist_result_retries_transient_sqlalchemy_failure(self) -> None:
        transient_error = OperationalError(
            "insert into vnext_experiment_specs",
            {},
            Exception("server closed the connection unexpectedly"),
        )

        with (
            patch.object(
                runner,
                "_persist_result_once",
                side_effect=[transient_error, None],
            ) as mock_persist_once,
            patch("scripts.run_strategy_factory_v2.time.sleep") as mock_sleep,
        ):
            result = runner._persist_result(
                runner_run_id="strategy-factory-v2-retry",
                experiment=runner.CompiledExperimentSweep(
                    source_run_id="paper-run-1",
                    experiment_id="exp-breakout-1",
                    family_template=self._family_template_fixture(),
                    experiment_payload={"family_template_id": "breakout_reclaim_v2"},
                    sweep_config={},
                ),
                result_payload={"top": []},
                compiled_sweep_path=Path("compiled-sweep.yaml"),
                result_path=Path("result.json"),
            )

        self.assertEqual(result, {"status": "persisted", "attempt": 2})
        self.assertEqual(mock_persist_once.call_count, 2)
        mock_sleep.assert_called_once()

    def test_run_strategy_factory_v2_reports_persistence_warning_without_dropping_replay(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            experiment_row = VNextExperimentSpec(
                run_id="paper-run-1",
                candidate_id=None,
                experiment_id="exp-breakout-1",
                payload_json={"family_template_id": "breakout_reclaim_v2"},
            )
            fake_payload = {
                "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
                "top": [
                    {
                        "candidate_id": "cand-1",
                        "full_window": {"net_per_day": "321.5"},
                    }
                ],
            }
            persistence_failure = {
                "status": "failed",
                "attempts": 3,
                "error_type": "OperationalError",
                "error": "server closed the connection unexpectedly",
            }

            with (
                patch(
                    "scripts.run_strategy_factory_v2.SessionLocal",
                    side_effect=lambda: Session(self.engine),
                ),
                patch(
                    "scripts.run_strategy_factory_v2._load_source_experiment_specs",
                    return_value=[experiment_row],
                ),
                patch(
                    "scripts.run_strategy_factory_v2.run_consistent_profitability_frontier",
                    return_value=fake_payload,
                ),
                patch(
                    "scripts.run_strategy_factory_v2._persist_result",
                    return_value=persistence_failure,
                ),
            ):
                result = runner.run_strategy_factory_v2(
                    self._args(
                        output_dir=output_dir,
                        strategy_configmap=strategy_configmap,
                        family_template_dir=family_template_dir,
                        seed_sweep_dir=seed_sweep_dir,
                    )
                )

        self.assertEqual(result["status"], "ok_with_persistence_warnings")
        self.assertFalse(result["persisted"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["experiments"][0]["top_candidate_id"], "cand-1")
        self.assertEqual(
            result["experiments"][0]["persistence_status"], persistence_failure
        )
        self.assertEqual(
            result["persistence_failures"][0]["candidate_spec_id"], "exp-breakout-1"
        )

    def test_run_strategy_factory_v2_applies_replay_ledger_guidance_before_frontier(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_configmap = self._write_strategy_configmap(root)
            family_template_dir = self._write_family_template(root)
            seed_sweep_dir = self._write_seed_sweep(root)
            output_dir = root / "artifacts"
            output_dir.mkdir()

            experiment_row = runner.InMemoryExperimentSpec(
                run_id="paper-run-1",
                experiment_id="exp-breakout-guided",
                payload_json={
                    "family_template_id": "breakout_reclaim_v2",
                    "selection_objectives": {"target_net_pnl_per_day": "500"},
                    "template_overrides": {"params": {"max_entries_per_session": "1"}},
                    "exact_replay_ledger_remediation": {
                        "status": "blocked_pending_search_remediation",
                        "candidate_id": "cand-replay-blocked",
                        "promotion_blockers": ["avg_filled_notional_per_day_below_min"],
                        "runtime_ledger_blockers": [],
                        "recommended_search_actions": [{"required_multiplier": "2.0"}],
                    },
                },
            )

            observed_sweep_configs: list[dict[str, object]] = []

            def fake_frontier(args: Namespace) -> dict[str, object]:
                observed_sweep_configs.append(
                    yaml.safe_load(Path(args.sweep_config).read_text(encoding="utf-8"))
                )
                return {
                    "candidate_count": 2,
                    "dataset_snapshot_receipt": {"snapshot_id": "snap-guided"},
                    "top": [
                        {
                            "candidate_id": "cand-guided",
                            "full_window": {"net_per_day": "501"},
                        }
                    ],
                }

            with patch(
                "scripts.run_strategy_factory_v2.run_consistent_profitability_frontier",
                side_effect=fake_frontier,
            ):
                result = runner.run_strategy_factory_v2_from_specs(
                    Namespace(
                        **{
                            **vars(
                                self._args(
                                    output_dir=output_dir,
                                    strategy_configmap=strategy_configmap,
                                    family_template_dir=family_template_dir,
                                    seed_sweep_dir=seed_sweep_dir,
                                )
                            ),
                            "persist_results": False,
                        }
                    ),
                    source_specs=[experiment_row],
                )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(
            result["experiments"][0]["replay_ledger_guided_actions"], ["breadth"]
        )
        compiled = observed_sweep_configs[0]
        self.assertEqual(compiled["parameters"]["max_entries_per_session"], ["1", "2"])
        self.assertEqual(
            compiled["metadata"]["replay_ledger_guided_search"]["source_candidate_id"],
            "cand-replay-blocked",
        )
