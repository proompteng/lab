from __future__ import annotations

# ruff: noqa: F403,F405
from tests.whitepaper_autoresearch.autoresearch_runner_base import *


class TestAutoresearchRunnerSourcesReplay(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_compile_claims_script_main_writes_recent_seed_cards(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "claims" / "hypothesis-cards.jsonl"
            with (
                patch(
                    "sys.argv",
                    [
                        "compile_whitepaper_claims.py",
                        "--output",
                        str(output_path),
                        "--seed-recent-whitepapers",
                    ],
                ),
                patch("builtins.print") as mock_print,
            ):
                parsed = claim_compiler_script._parse_args()
                exit_code = claim_compiler_script.main()

            rows = output_path.read_text(encoding="utf-8").splitlines()

        self.assertEqual(parsed.output, output_path)
        self.assertTrue(parsed.seed_recent_whitepapers)
        self.assertEqual(exit_code, 0)
        self.assertGreaterEqual(len(rows), 4)
        self.assertTrue(mock_print.called)

    def test_compile_claims_script_reads_source_jsonl(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            source_path.write_text(
                json.dumps(_source_jsonl_payload(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            output_path = root / "hypothesis-cards.jsonl"
            with (
                patch(
                    "sys.argv",
                    [
                        "compile_whitepaper_claims.py",
                        "--source-jsonl",
                        str(source_path),
                        "--output",
                        str(output_path),
                    ],
                ),
                patch("builtins.print") as mock_print,
            ):
                parsed = claim_compiler_script._parse_args()
                exit_code = claim_compiler_script.main()

            rows = output_path.read_text(encoding="utf-8").splitlines()

        self.assertEqual(parsed.source_jsonl, [source_path])
        self.assertEqual(exit_code, 0)
        self.assertEqual(len(rows), 1)
        self.assertTrue(mock_print.called)

    def test_compile_claims_script_loads_completed_persisted_run_claims(
        self,
    ) -> None:
        with Session(self.engine) as session:
            document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00001",
                title="Persisted Claims Paper",
                metadata_json={"source_url": "https://example.test/paper.pdf"},
            )
            version = WhitepaperDocumentVersion(
                document=document,
                version_number=1,
                checksum_sha256="a" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="paper.pdf",
            )
            run = WhitepaperAnalysisRun(
                run_id="paper-run-db",
                document=document,
                document_version=version,
                status="completed",
            )
            session.add_all(
                [
                    document,
                    version,
                    run,
                    WhitepaperClaim(
                        analysis_run=run,
                        claim_id="claim-flow",
                        claim_type="signal_mechanism",
                        claim_text="Order-flow bursts can predict short-horizon continuation.",
                        data_requirements_json=["order_flow_imbalance"],
                        confidence="0.82",
                    ),
                    WhitepaperClaim(
                        analysis_run=run,
                        claim_id="claim-validation",
                        claim_type="validation_requirement",
                        claim_text="The signal must pass held-out liquidity stress windows.",
                        data_requirements_json=["spread_bps"],
                        confidence="0.76",
                    ),
                    WhitepaperClaimRelation(
                        analysis_run=run,
                        relation_id="rel-supports",
                        relation_type="supports",
                        source_claim_id="claim-validation",
                        target_claim_id="claim-flow",
                    ),
                ]
            )
            session.commit()

        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "scripts.compile_whitepaper_claims.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
            patch(
                "sys.argv",
                [
                    "compile_whitepaper_claims.py",
                    "--paper-run-id",
                    "paper-run-db",
                    "--output",
                    str(Path(tmpdir) / "hypothesis-cards.jsonl"),
                    "--sources-output",
                    str(Path(tmpdir) / "sources.jsonl"),
                ],
            ),
            patch("builtins.print") as mock_print,
        ):
            exit_code = claim_compiler_script.main()
            card_rows = (
                (Path(tmpdir) / "hypothesis-cards.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            )
            source_rows = (
                (Path(tmpdir) / "sources.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(len(card_rows), 1)
        self.assertEqual(len(source_rows), 1)
        source_payload = json.loads(source_rows[0])
        self.assertEqual(source_payload["run_id"], "paper-run-db")
        self.assertEqual(len(source_payload["claims"]), 2)
        self.assertEqual(len(source_payload["claim_relations"]), 1)
        self.assertTrue(mock_print.called)

    def test_runner_db_source_loader_ignores_incomplete_whitepaper_runs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            completed_document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00002",
                title="Completed Claims Paper",
                metadata_json={"source_url": "https://example.test/completed.pdf"},
            )
            completed_version = WhitepaperDocumentVersion(
                document=completed_document,
                version_number=1,
                checksum_sha256="b" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="completed.pdf",
            )
            completed_run = WhitepaperAnalysisRun(
                run_id="paper-completed",
                document=completed_document,
                document_version=completed_version,
                status="completed",
            )
            running_document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00003",
                title="Running Claims Paper",
                metadata_json={"source_url": "https://example.test/running.pdf"},
            )
            running_version = WhitepaperDocumentVersion(
                document=running_document,
                version_number=1,
                checksum_sha256="c" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="running.pdf",
            )
            running_run = WhitepaperAnalysisRun(
                run_id="paper-running",
                document=running_document,
                document_version=running_version,
                status="running",
            )
            session.add_all(
                [
                    completed_document,
                    completed_version,
                    completed_run,
                    WhitepaperClaim(
                        analysis_run=completed_run,
                        claim_id="claim-completed",
                        claim_type="signal_mechanism",
                        claim_text="Completed paper claim.",
                        data_requirements_json=["order_flow_imbalance"],
                    ),
                    running_document,
                    running_version,
                    running_run,
                    WhitepaperClaim(
                        analysis_run=running_run,
                        claim_id="claim-running",
                        claim_type="signal_mechanism",
                        claim_text="Running paper claim.",
                        data_requirements_json=["order_flow_imbalance"],
                    ),
                ]
            )
            session.commit()

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            sources = runner._load_sources_from_db(["paper-completed", "paper-running"])

        self.assertEqual([source.run_id for source in sources], ["paper-completed"])

    def test_runner_parse_args_covers_cli_defaults_and_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            source_path = Path(tmpdir) / "sources.jsonl"
            with patch(
                "sys.argv",
                [
                    "run_whitepaper_autoresearch_profit_target.py",
                    "--output-dir",
                    str(output_dir),
                    "--epoch-id",
                    "whitepaper-autoresearch-cli-epoch",
                    "--seed-recent-whitepapers",
                    "--replay-mode",
                    "synthetic",
                    "--source-jsonl",
                    str(source_path),
                    "--candidate-specs",
                    str(Path(tmpdir) / "selected-candidate-specs.jsonl"),
                    "--clickhouse-password-env",
                    "TORGHUT_CLICKHOUSE_PASSWORD",
                    "--max-total-frontier-candidates",
                    "7",
                    "--staged-train-screen-multiplier",
                    "4",
                    "--capture-rejected-seed-full-window-ledger",
                    "--capture-positive-rejected-full-window-ledgers",
                    "3",
                    "--symbol-prune-iterations",
                    "1",
                    "--symbol-prune-candidates",
                    "2",
                    "--symbol-prune-min-universe-size",
                    "4",
                    "--loss-repair-iterations",
                    "1",
                    "--loss-repair-candidates",
                    "2",
                    "--consistency-repair-iterations",
                    "1",
                    "--consistency-repair-candidates",
                    "5",
                    "--replay-tape-path",
                    str(Path(tmpdir) / "tape.jsonl"),
                    "--replay-tape-manifest",
                    str(Path(tmpdir) / "tape.manifest.json"),
                    "--materialize-replay-tape",
                    "--selection-only",
                    "--no-persist-results",
                ],
            ):
                parsed = runner._parse_args()

        self.assertEqual(parsed.output_dir, output_dir)
        self.assertEqual(parsed.epoch_id, "whitepaper-autoresearch-cli-epoch")
        self.assertTrue(parsed.seed_recent_whitepapers)
        self.assertEqual(parsed.replay_mode, "synthetic")
        self.assertEqual(parsed.source_jsonl, [source_path])
        self.assertEqual(
            parsed.candidate_specs, [Path(tmpdir) / "selected-candidate-specs.jsonl"]
        )
        self.assertEqual(parsed.clickhouse_password_env, "TORGHUT_CLICKHOUSE_PASSWORD")
        self.assertEqual(parsed.symbols, ",".join(_CHIP_UNIVERSE))
        self.assertEqual(
            parsed.max_frontier_candidates_per_spec,
            runner._DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
        )
        self.assertEqual(parsed.max_total_frontier_candidates, 7)
        self.assertEqual(parsed.staged_train_screen_multiplier, 4)
        self.assertTrue(parsed.capture_rejected_seed_full_window_ledger)
        self.assertEqual(parsed.capture_positive_rejected_full_window_ledgers, 3)
        self.assertEqual(parsed.symbol_prune_iterations, 1)
        self.assertEqual(parsed.symbol_prune_candidates, 2)
        self.assertEqual(parsed.symbol_prune_min_universe_size, 4)
        self.assertEqual(parsed.loss_repair_iterations, 1)
        self.assertEqual(parsed.loss_repair_candidates, 2)
        self.assertEqual(parsed.consistency_repair_iterations, 1)
        self.assertEqual(parsed.consistency_repair_candidates, 5)
        self.assertEqual(parsed.real_replay_shard_size, 0)
        self.assertEqual(
            parsed.real_replay_shard_timeout_seconds,
            runner._DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
        )
        self.assertEqual(
            parsed.real_replay_shard_workers,
            runner._DEFAULT_REAL_REPLAY_SHARD_WORKERS,
        )
        self.assertEqual(
            parsed.real_replay_max_parallel_frontier_candidates,
            runner._DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
        )
        self.assertEqual(parsed.replay_tape_path, Path(tmpdir) / "tape.jsonl")
        self.assertEqual(
            parsed.replay_tape_manifest, Path(tmpdir) / "tape.manifest.json"
        )
        self.assertTrue(parsed.materialize_replay_tape)
        self.assertTrue(parsed.selection_only)
        self.assertEqual(parsed.max_worst_day_loss, "999999999")
        self.assertEqual(parsed.max_drawdown, "999999999")
        self.assertEqual(parsed.min_profit_factor, "1.50")
        self.assertEqual(parsed.max_worst_day_loss_pct_equity, "0.05")
        self.assertEqual(parsed.max_drawdown_pct_equity, "0.08")
        self.assertEqual(parsed.extended_max_worst_day_loss_pct_equity, "0.08")
        self.assertEqual(parsed.extended_max_drawdown_pct_equity, "0.12")
        self.assertEqual(parsed.min_total_net_pnl_to_drawdown_ratio, "3.00")
        self.assertEqual(parsed.max_gross_exposure_pct_equity, "1.0")
        self.assertEqual(parsed.min_cash, "0")
        self.assertEqual(parsed.max_negative_cash_observation_count, 0)
        self.assertFalse(parsed.persist_results)

    def test_decimal_arg_or_default_uses_explicit_cli_override(self) -> None:
        value = runner._decimal_arg_or_default(
            Namespace(min_daily_net_pnl="-125.50"),
            "min_daily_net_pnl",
            Decimal("-350"),
        )

        self.assertEqual(value, Decimal("-125.50"))

    def test_clickhouse_password_env_resolution_keeps_secret_out_of_argv(
        self,
    ) -> None:
        with patch.dict("os.environ", {"TORGHUT_TEST_CLICKHOUSE_PASSWORD": "from-env"}):
            resolved = runner._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="",
                    clickhouse_password_env="TORGHUT_TEST_CLICKHOUSE_PASSWORD",
                )
            )
            direct = runner._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="direct",
                    clickhouse_password_env="TORGHUT_TEST_CLICKHOUSE_PASSWORD",
                )
            )

        self.assertEqual(resolved, "from-env")
        self.assertEqual(direct, "direct")

    def test_runner_reads_source_jsonl_end_to_end(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            source_path.write_text(
                json.dumps(_source_jsonl_payload(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            output_dir = root / "epoch"
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.source_jsonl = [source_path]
            args.exploration_slots = 0
            args.max_candidates = 1
            args.max_frontier_candidates_per_spec = 1
            args.max_total_frontier_candidates = 1
            args.portfolio_size_min = 1
            args.portfolio_size_max = 1
            args.top_k = 1
            args.persist_results = False
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            manifest = json.loads(
                (output_dir / "epoch-manifest.json").read_text(encoding="utf-8")
            )
            sources = [
                json.loads(line)
                for line in (output_dir / "whitepaper-sources.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(payload["source_count"], 1)
        self.assertEqual(manifest["paper_sources"][0]["run_id"], "paper-jsonl-2026")
        self.assertEqual(sources[0]["run_id"], "paper-jsonl-2026")

    def test_candidate_budget_does_not_truncate_compiled_hypothesis_universe(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            rows: list[dict[str, object]] = []
            for index in range(1):
                payload = dict(_source_jsonl_payload())
                payload["run_id"] = f"paper-jsonl-coverage-{index}"
                payload["title"] = f"Coverage Paper {index}"
                payload["source_url"] = f"https://example.test/coverage-{index}.pdf"
                claims = [
                    dict(item)
                    for item in cast(list[dict[str, object]], payload["claims"])
                ]
                claims[0]["claim_text"] = (
                    f"Order-flow momentum continuation signal {index} with late-day reversal validation."
                )
                payload["claims"] = claims
                rows.append(payload)
            source_path.write_text(
                "\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n",
                encoding="utf-8",
            )
            output_dir = root / "epoch"
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.source_jsonl = [source_path]
            args.max_candidates = 2
            args.top_k = 1
            args.exploration_slots = 1
            args.max_frontier_candidates_per_spec = 1
            args.max_total_frontier_candidates = 4
            args.persist_results = False

            payload = runner.run_whitepaper_autoresearch_profit_target(args)
            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertGreater(payload["candidate_spec_count"], args.max_candidates)
        self.assertEqual(
            selection["budget"]["compiled_candidate_count"],
            payload["candidate_spec_count"],
        )
        self.assertEqual(
            selection["budget"]["selected_count"],
            payload["replay_candidate_spec_count"],
        )
        self.assertLessEqual(
            payload["replay_candidate_spec_count"], args.max_candidates
        )

    def test_real_replay_builds_evidence_and_skips_incomplete_results(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "real"
            empty_result_path = Path(tmpdir) / "empty.json"
            valid_result_path = Path(tmpdir) / "valid.json"
            empty_result_path.write_text(json.dumps({"top": []}), encoding="utf-8")
            valid_result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "250",
                                    "active_day_ratio": "1.0",
                                    "positive_day_ratio": "0.8",
                                },
                            },
                            {
                                "candidate_id": "cand-real-diversifier",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "175",
                                    "active_day_ratio": "1.0",
                                    "positive_day_ratio": "0.8",
                                },
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {"experiment_id": "missing-path"},
                    {
                        "experiment_id": "empty-top",
                        "result_path": str(empty_result_path),
                    },
                    {
                        "experiment_id": "spec-real",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(valid_result_path),
                        "promotion_readiness": {"status": "blocked"},
                    },
                ]
            }

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2",
                return_value=factory_payload,
            ):
                result = runner._run_real_replay(
                    self._args(output_dir), output_dir=output_dir
                )

        self.assertEqual(len(result.evidence_bundles), 2)
        self.assertEqual(result.evidence_bundles[0].candidate_spec_id, "spec-real")
        self.assertEqual(result.evidence_bundles[1].candidate_spec_id, "spec-real")
        self.assertEqual(
            result.evidence_bundles[1].candidate_id, "cand-real-diversifier"
        )
        self.assertEqual(result.evidence_bundles[0].dataset_snapshot_id, "snap-real")

    def test_real_replay_injects_spec_metadata_into_evidence_bundle(self) -> None:
        spec = self._candidate_spec("spec-real-replay-signature")
        with TemporaryDirectory() as tmpdir:
            result_path = Path(tmpdir) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "25",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            result = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "candidate_spec_id": spec.candidate_spec_id,
                            "experiment_id": "exp-real",
                            "dataset_snapshot_id": "snap-real",
                            "result_path": str(result_path),
                        }
                    ]
                },
                specs_by_id={spec.candidate_spec_id: spec},
            )

        self.assertEqual(len(result.evidence_bundles), 1)
        scorecard = result.evidence_bundles[0].objective_scorecard
        self.assertEqual(scorecard["family_template_id"], spec.family_template_id)
        self.assertEqual(scorecard["runtime_family"], spec.runtime_family)
        self.assertEqual(scorecard["runtime_strategy_name"], spec.runtime_strategy_name)
        self.assertEqual(
            scorecard["execution_signature"],
            runner._candidate_spec_execution_signature(spec),
        )

    def test_real_replay_uses_spec_universe_instead_of_global_symbols(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "1",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_symbols: list[str] = []
            captured_replay_tapes: list[tuple[Path | None, Path | None]] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_symbols.append(str(factory_args.symbols))
                captured_replay_tapes.append(
                    (
                        factory_args.replay_tape_path,
                        factory_args.replay_tape_manifest,
                    )
                )
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.replay_tape_path = output_dir / "tape.jsonl"
                args.replay_tape_manifest = output_dir / "tape.manifest.json"
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_symbols, [""])
        self.assertEqual(
            captured_replay_tapes,
            [(output_dir / "tape.jsonl", output_dir / "tape.manifest.json")],
        )
        self.assertEqual(len(result.evidence_bundles), 1)

    def test_real_replay_passes_global_frontier_candidate_budget(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "1",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_budget: list[int] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_budget.append(
                    int(factory_args.max_total_candidates_to_evaluate)
                )
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_total_frontier_candidates = 11
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_budget, [11])
        self.assertEqual(len(result.evidence_bundles), 1)

    def test_real_replay_caps_source_spec_frontier_budget_from_global_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps({"top": []}),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_budget: list[int] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_budget.append(int(factory_args.max_candidates_to_evaluate))
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_frontier_candidates_per_spec = 64
                args.max_total_frontier_candidates = 8
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:8],
                )

        self.assertEqual(captured_budget, [1])
        self.assertEqual(len(result.evidence_bundles), 0)

    def test_real_replay_defaults_global_frontier_budget_to_candidate_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps({"top": []}),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_budget: list[int] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_budget.append(
                    int(factory_args.max_total_candidates_to_evaluate)
                )
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_frontier_candidates_per_spec = 8
                args.max_total_frontier_candidates = 0
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_budget, [24])
        self.assertEqual(len(result.evidence_bundles), 0)

    def test_real_replay_forwards_frontier_repair_and_proof_capture_controls(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps({"top": []}),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_multiplier: list[int] = []
            captured_controls: list[dict[str, object]] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_multiplier.append(
                    int(factory_args.staged_train_screen_multiplier)
                )
                captured_controls.append(
                    {
                        "capture_rejected_seed_full_window_ledger": bool(
                            factory_args.capture_rejected_seed_full_window_ledger
                        ),
                        "capture_positive_rejected_full_window_ledgers": int(
                            factory_args.capture_positive_rejected_full_window_ledgers
                        ),
                        "symbol_prune_iterations": int(
                            factory_args.symbol_prune_iterations
                        ),
                        "symbol_prune_candidates": int(
                            factory_args.symbol_prune_candidates
                        ),
                        "symbol_prune_min_universe_size": int(
                            factory_args.symbol_prune_min_universe_size
                        ),
                        "loss_repair_iterations": int(
                            factory_args.loss_repair_iterations
                        ),
                        "loss_repair_candidates": int(
                            factory_args.loss_repair_candidates
                        ),
                        "consistency_repair_iterations": int(
                            factory_args.consistency_repair_iterations
                        ),
                        "consistency_repair_candidates": int(
                            factory_args.consistency_repair_candidates
                        ),
                    }
                )
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.staged_train_screen_multiplier = 3
                args.capture_rejected_seed_full_window_ledger = True
                args.capture_positive_rejected_full_window_ledgers = 2
                args.symbol_prune_iterations = 1
                args.symbol_prune_candidates = 2
                args.symbol_prune_min_universe_size = 4
                args.loss_repair_iterations = 1
                args.loss_repair_candidates = 1
                args.consistency_repair_iterations = 1
                args.consistency_repair_candidates = 2
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_multiplier, [3])
        self.assertEqual(
            captured_controls,
            [
                {
                    "capture_rejected_seed_full_window_ledger": True,
                    "capture_positive_rejected_full_window_ledgers": 2,
                    "symbol_prune_iterations": 1,
                    "symbol_prune_candidates": 2,
                    "symbol_prune_min_universe_size": 4,
                    "loss_repair_iterations": 1,
                    "loss_repair_candidates": 1,
                    "consistency_repair_iterations": 1,
                    "consistency_repair_candidates": 2,
                }
            ],
        )
        self.assertEqual(len(result.evidence_bundles), 0)

    def test_program_replay_budget_supplies_staged_train_screen_multiplier(
        self,
    ) -> None:
        args = self._args(Path("/tmp/epoch"))
        program = runner._load_epoch_program(args)
        controls = runner._resolved_real_replay_frontier_controls(args, program)

        self.assertEqual(
            runner._resolved_staged_train_screen_multiplier(args, program),
            3,
        )
        self.assertEqual(controls["symbol_prune_iterations"], 1)
        self.assertEqual(controls["symbol_prune_candidates"], 2)
        self.assertEqual(controls["symbol_prune_min_universe_size"], 5)
        self.assertEqual(controls["loss_repair_iterations"], 1)
        self.assertEqual(controls["loss_repair_candidates"], 1)
        self.assertEqual(controls["consistency_repair_iterations"], 1)
        self.assertEqual(controls["consistency_repair_candidates"], 2)
        self.assertFalse(controls["capture_rejected_seed_full_window_ledger"])
        self.assertEqual(controls["capture_positive_rejected_full_window_ledgers"], 0)
        args.staged_train_screen_multiplier = 4
        args.symbol_prune_candidates = 5
        args.capture_positive_rejected_full_window_ledgers = 6
        override_controls = runner._resolved_real_replay_frontier_controls(
            args, program
        )
        self.assertEqual(
            runner._resolved_staged_train_screen_multiplier(args, program),
            4,
        )
        self.assertEqual(override_controls["symbol_prune_candidates"], 5)
        self.assertEqual(
            override_controls["capture_positive_rejected_full_window_ledgers"], 6
        )
