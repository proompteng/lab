from __future__ import annotations

import app.trading.discovery.portfolio_optimizer as portfolio_optimizer
import scripts.whitepaper_autoresearch_runner.artifact_io as artifact_io
import scripts.whitepaper_autoresearch_runner.persisted_feedback_sources as persisted_feedback_sources
import scripts.whitepaper_autoresearch_runner.queue_metadata as queue_metadata

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Decimal,
    Path,
    SignalEnvelope,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    _CHIP_UNIVERSE,
    _compact_recent_whitepaper_sources,
    date,
    datetime,
    fast_replay,
    json,
    materialize_signal_tape,
    patch,
    replace,
    runner,
    timezone,
)


class TestAutoresearchRunnerSeedSelection(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_seed_recent_whitepapers_runs_end_to_end_and_writes_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir, _compact_recent_whitepaper_sources(4):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.epoch_id = "whitepaper-autoresearch-test-epoch"
            args.max_candidates = 4
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 8
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            self.assertEqual(payload["epoch_id"], "whitepaper-autoresearch-test-epoch")
            self.assertEqual(payload["status"], "no_profit_target_candidate")
            self.assertEqual(
                payload["status_reason"],
                "portfolio_candidate_failed_profit_target_oracle",
            )
            self.assertGreaterEqual(payload["source_count"], 4)
            self.assertGreaterEqual(payload["candidate_spec_count"], 4)
            self.assertIsNotNone(payload["best_portfolio_candidate"])
            self.assertFalse(payload["promotion_readiness"]["promotable"])

            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )
            self.assertEqual(summary["epoch_id"], payload["epoch_id"])
            candidate_board = json.loads(
                (output_dir / "candidate-board.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                candidate_board["schema_version"],
                "torghut.profit-candidate-board.v1",
            )
            self.assertEqual(
                candidate_board["current_answer"], "no_promotion_ready_candidate"
            )
            self.assertEqual(candidate_board["best_research_candidate"]["rank"], 1)
            self.assertTrue(candidate_board["best_research_candidate"]["blockers"])
            self.assertEqual(summary["candidate_board"], candidate_board)
            self.assertEqual(
                summary["artifacts"]["candidate_board"],
                str((output_dir / "candidate-board.json").resolve()),
            )
            paper_probation_handoff = json.loads(
                (output_dir / "paper-probation-handoff.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                paper_probation_handoff["schema_version"],
                "torghut.paper-probation-handoff.v1",
            )
            self.assertFalse(paper_probation_handoff["promotion_allowed"])
            self.assertFalse(paper_probation_handoff["final_promotion_allowed"])
            self.assertEqual(
                paper_probation_handoff["runtime_window_import_plan"],
                candidate_board["runtime_window_import_plan"],
            )
            self.assertEqual(
                summary["paper_probation_handoff"],
                paper_probation_handoff,
            )
            self.assertEqual(
                summary["artifacts"]["paper_probation_handoff"],
                str((output_dir / "paper-probation-handoff.json").resolve()),
            )
            self.assertEqual(
                summary["false_positive_table"], payload["false_positive_table"]
            )
            self.assertEqual(
                summary["best_false_negative_table"],
                payload["best_false_negative_table"],
            )
            profitability_goal = json.loads(
                (output_dir / "profitability-search-goal.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                profitability_goal["schema_version"],
                "torghut.whitepaper-autoresearch-profitability-goal.v1",
            )
            self.assertEqual(
                profitability_goal["objective"]["target_net_pnl_per_trading_day"],
                "500",
            )
            self.assertFalse(profitability_goal["objective"]["oracle_candidate_found"])
            self.assertTrue(profitability_goal["candidate_framework"]["families"])
            self.assertTrue(profitability_goal["sleeve_plan"]["rows"])
            self.assertTrue(profitability_goal["system_change_backlog"])
            self.assertEqual(
                profitability_goal["recommended_next_epoch"]["flags"][
                    "--target-net-pnl-per-day"
                ],
                "500",
            )
            self.assertIn(
                "lowering target_net_pnl_per_day to make a candidate pass",
                profitability_goal["no_cheating_contract"]["forbidden"],
            )
            self.assertEqual(
                summary["artifacts"]["profitability_search_goal"],
                str((output_dir / "profitability-search-goal.json").resolve()),
            )
            self.assertTrue((output_dir / "hypothesis-cards.jsonl").exists())
            self.assertTrue((output_dir / "whitepaper-sources.jsonl").exists())
            self.assertTrue((output_dir / "candidate-specs.jsonl").exists())
            self.assertTrue((output_dir / "candidate-compiler-report.json").exists())
            self.assertTrue((output_dir / "candidate-selection-manifest.json").exists())
            self.assertTrue((output_dir / "selected-candidate-specs.jsonl").exists())
            self.assertTrue((output_dir / "pre-replay-mlx-ranker-model.json").exists())
            self.assertTrue(
                (output_dir / "pre-replay-mlx-proposal-scores.jsonl").exists()
            )
            self.assertTrue((output_dir / "mlx-snapshot-manifest.json").exists())
            self.assertTrue((output_dir / "mlx-ranker-model.json").exists())
            self.assertTrue((output_dir / "mlx-proposal-scores.jsonl").exists())
            self.assertTrue((output_dir / "candidate-evidence-bundles.jsonl").exists())
            self.assertTrue((output_dir / "portfolio-candidates.jsonl").exists())
            self.assertTrue((output_dir / "runtime-closure" / "summary.json").exists())
            self.assertTrue(
                (
                    output_dir
                    / "runtime-closure"
                    / "replay"
                    / "candidate-configmap.yaml"
                ).exists()
            )
            runtime_summary = json.loads(
                (output_dir / "runtime-closure" / "summary.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(runtime_summary["status"], "pending_runtime_parity")
            self.assertTrue(runtime_summary["candidate_configmap_path"])
            replay_plan = json.loads(
                (
                    output_dir
                    / "runtime-closure"
                    / "replay"
                    / "runtime-replay-plan.json"
                ).read_text(encoding="utf-8")
            )
            self.assertIsNotNone(replay_plan["execution_context"])
            self.assertFalse(
                replay_plan["runtime_closure_policy"]["execute_parity_replay"]
            )
            self.assertFalse(
                replay_plan["runtime_closure_policy"]["execute_approval_replay"]
            )
            snapshot_manifest = json.loads(
                (output_dir / "mlx-snapshot-manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                replay_plan["dataset_snapshot_ref"], snapshot_manifest["snapshot_id"]
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["candidate_specs"],
                payload["candidate_spec_count"],
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["candidate_evidence_bundles"],
                payload["evidence_bundle_count"],
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["pre_replay_proposal_scores"],
                payload["pre_replay_proposal_score_count"],
            )
            self.assertEqual(
                snapshot_manifest["tensor_bundle_paths"][
                    "candidate_selection_manifest_json"
                ],
                str((output_dir / "candidate-selection-manifest.json").resolve()),
            )
            self.assertEqual(
                payload["artifacts"]["mlx_snapshot_manifest"],
                str((output_dir / "mlx-snapshot-manifest.json").resolve()),
            )
            self.assertEqual(
                payload["artifacts"]["selected_candidate_specs"],
                str((output_dir / "selected-candidate-specs.jsonl").resolve()),
            )
            self.assertTrue(
                (output_dir / "whitepaper-autoresearch-diagnostics.ipynb").exists()
            )
            model_payload = json.loads(
                (output_dir / "mlx-ranker-model.json").read_text(encoding="utf-8")
            )
            pre_replay_model_payload = json.loads(
                (output_dir / "pre-replay-mlx-ranker-model.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(pre_replay_model_payload["proposal_stage"], "pre_replay")
            self.assertEqual(
                pre_replay_model_payload["row_count"], payload["candidate_spec_count"]
            )
            self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v7")
            self.assertEqual(
                model_payload["row_count"], payload["candidate_spec_count"]
            )
            self.assertIn("rank_bucket_lift", model_payload)
            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                selection["budget"]["selected_count"],
                payload["replay_candidate_spec_count"],
            )
            self.assertEqual(
                payload["evidence_bundle_count"], payload["replay_candidate_spec_count"]
            )
            self.assertEqual(
                selection["proposal_model"]["proposal_stage"], "pre_replay"
            )
            selected_candidate_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            self.assertEqual(
                [spec["candidate_spec_id"] for spec in selected_candidate_specs],
                selection["selected_candidate_spec_ids"],
            )
            candidate_specs = [
                json.loads(line)
                for line in (output_dir / "candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            self.assertTrue(candidate_specs)
            candidate_universes = [
                spec["strategy_overrides"]["universe_symbols"]
                for spec in candidate_specs
            ]
            self.assertTrue(
                all(
                    set(symbols) <= set(_CHIP_UNIVERSE)
                    for symbols in candidate_universes
                )
            )
            self.assertTrue(
                any(symbols != _CHIP_UNIVERSE for symbols in candidate_universes)
            )

            portfolio = payload["best_portfolio_candidate"]
            self.assertFalse(portfolio["objective_scorecard"]["target_met"])
            self.assertFalse(portfolio["objective_scorecard"]["oracle_passed"])
            self.assertFalse(payload["oracle_candidate_found"])
            self.assertIn(
                "portfolio_post_cost_net_pnl_per_day_failed",
                payload["profit_target_oracle"]["blockers"],
            )
            self.assertNotIn(
                "min_daily_net_pnl_failed",
                payload["profit_target_oracle"]["blockers"],
            )
            self.assertEqual(
                payload["profit_target_oracle_policy"]["min_daily_net_pnl"],
                "-999999999",
            )
            self.assertIn(
                "executable_replay_passed_failed",
                payload["profit_target_oracle"]["blockers"],
            )
            self.assertLess(
                float(portfolio["objective_scorecard"]["net_pnl_per_day"]), 500.0
            )
            self.assertTrue(payload["false_positive_table"])
            false_positive_reasons = {
                reason
                for row in payload["false_positive_table"]
                for reason in row["failure_reasons"]
            }
            self.assertIn("active_day_ratio_below_oracle", false_positive_reasons)
            self.assertLess(
                selection["budget"]["unique_execution_signature_count"],
                payload["candidate_spec_count"],
            )
            self.assertTrue(
                any(
                    row["selection_reason"] == "duplicate_execution_signature"
                    for row in selection["rows"]
                )
            )

    def test_selection_only_writes_pre_replay_artifacts_without_replay_or_persistence(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._source_jsonl_args(output_dir)
            args.epoch_id = "whitepaper-autoresearch-selection-only"
            args.replay_mode = "real"
            args.persist_results = True
            args.selection_only = True
            args.max_candidates = 4
            args.top_k = 2

            with (
                patch.object(
                    runner,
                    "_run_replay_with_optional_timeout",
                    side_effect=AssertionError("selection-only must not run replay"),
                ) as replay_mock,
                patch.object(
                    runner,
                    "_persist_vnext_specs",
                    side_effect=AssertionError("selection-only must not persist specs"),
                ) as persist_mock,
                patch.object(
                    persisted_feedback_sources,
                    "_persist_epoch_ledgers",
                    side_effect=AssertionError(
                        "selection-only must not persist epoch ledgers"
                    ),
                ) as ledger_mock,
                patch.object(
                    portfolio_optimizer,
                    "optimize_portfolio_candidate",
                    side_effect=AssertionError(
                        "selection-only must not optimize a portfolio"
                    ),
                ) as optimizer_mock,
                patch.object(
                    runner,
                    "_runtime_closure_payload",
                    side_effect=AssertionError(
                        "selection-only must not build runtime closure"
                    ),
                ) as runtime_mock,
            ):
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )

            self.assertTrue((output_dir / "epoch-manifest.json").exists())
            self.assertTrue((output_dir / "whitepaper-sources.jsonl").exists())
            self.assertTrue((output_dir / "hypothesis-cards.jsonl").exists())
            self.assertTrue((output_dir / "candidate-specs.jsonl").exists())
            self.assertTrue((output_dir / "candidate-compiler-report.json").exists())
            self.assertTrue(
                (output_dir / "feedback-evidence-source-manifest.json").exists()
            )
            self.assertTrue((output_dir / "pre-replay-mlx-ranker-model.json").exists())
            self.assertTrue(
                (output_dir / "pre-replay-mlx-proposal-scores.jsonl").exists()
            )
            self.assertTrue((output_dir / "candidate-selection-manifest.json").exists())
            self.assertTrue((output_dir / "selected-candidate-specs.jsonl").exists())
            self.assertTrue(
                (output_dir / "whitepaper-autoresearch-diagnostics.ipynb").exists()
            )
            self.assertFalse((output_dir / "strategy-factory").exists())
            self.assertFalse((output_dir / "synthetic-replays").exists())
            self.assertFalse((output_dir / "candidate-evidence-bundles.jsonl").exists())
            self.assertFalse((output_dir / "mlx-ranker-model.json").exists())
            self.assertFalse((output_dir / "mlx-proposal-scores.jsonl").exists())
            self.assertFalse((output_dir / "portfolio-candidates.jsonl").exists())
            self.assertFalse((output_dir / "portfolio-optimizer-report.json").exists())
            self.assertFalse((output_dir / "candidate-board.json").exists())
            self.assertFalse((output_dir / "profitability-search-goal.json").exists())
            self.assertFalse((output_dir / "runtime-closure" / "summary.json").exists())
            selected_candidate_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]

        self.assertEqual(payload["status"], "selection_only")
        self.assertEqual(payload["status_reason"], "pre_replay_selection_only")
        self.assertEqual(payload["epoch_id"], "whitepaper-autoresearch-selection-only")
        self.assertEqual(summary["status"], "selection_only")
        self.assertFalse(payload["oracle_candidate_found"])
        self.assertFalse(payload["promotion_readiness"]["promotable"])
        self.assertIn(
            "real_replay_not_run",
            payload["promotion_readiness"]["blockers"],
        )
        self.assertGreater(payload["candidate_spec_count"], 0)
        self.assertGreater(payload["pre_replay_proposal_score_count"], 0)
        self.assertGreater(payload["replay_candidate_spec_count"], 0)
        self.assertEqual(
            payload["artifacts"]["selected_candidate_specs"],
            str((output_dir / "selected-candidate-specs.jsonl").resolve()),
        )
        self.assertEqual(
            [spec["candidate_spec_id"] for spec in selected_candidate_specs],
            payload["selected_candidate_spec_ids"],
        )
        replay_mock.assert_not_called()
        persist_mock.assert_not_called()
        ledger_mock.assert_not_called()
        optimizer_mock.assert_not_called()
        runtime_mock.assert_not_called()

    def test_replay_tape_preview_narrows_direct_specs_without_promotion_proof(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            specs_path = root / "candidate-specs.jsonl"
            tape_path = root / "preview-tape.jsonl"
            base_nvda = self._candidate_spec("spec-nvda-continuation")
            nvda_spec = replace(
                base_nvda,
                strategy_overrides={
                    **base_nvda.strategy_overrides,
                    "universe_symbols": ["NVDA"],
                },
            )
            base_aapl = self._candidate_spec("spec-aapl-continuation")
            aapl_spec = replace(
                base_aapl,
                strategy_overrides={
                    **base_aapl.strategy_overrides,
                    "universe_symbols": ["AAPL"],
                },
            )
            specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True)
                    for spec in (nvda_spec, aapl_spec)
                )
                + "\n",
                encoding="utf-8",
            )
            args = self._args(output_dir)
            args.candidate_specs = [specs_path]
            args.seed_recent_whitepapers = False
            args.replay_mode = "real"
            args.selection_only = True
            args.replay_tape_path = tape_path
            args.replay_tape_preview_top_k = 1
            args.symbols = "NVDA"
            args.replay_tape_dataset_snapshot_ref = "preview-snapshot"
            requested_symbols = artifact_io._candidate_universe_symbols_from_args(args)
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                        symbol=symbol,
                        timeframe="1Sec",
                        seq=seq,
                        source="ta",
                        payload={
                            "price": Decimal(price),
                            "spread_bps": Decimal("2"),
                            "ofi": Decimal("0.25"),
                            "microbar_volume": Decimal("100000"),
                            "event_type": "trade",
                        },
                    )
                    for seq, (day, symbol, price) in enumerate(
                        (
                            (23, "NVDA", "100"),
                            (24, "NVDA", "101"),
                            (25, "NVDA", "102"),
                            (26, "NVDA", "103"),
                            (27, "NVDA", "104"),
                        ),
                        start=1,
                    )
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="preview-snapshot",
                symbols=requested_symbols,
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 27),
                source_query_digest=queue_metadata._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 27),
                ),
                feature_schema_hash=queue_metadata._materialized_replay_tape_feature_schema_hash(
                    args
                ),
                cost_model_hash=queue_metadata._materialized_replay_tape_cost_model_hash(
                    args
                ),
                strategy_family=queue_metadata._materialized_replay_tape_strategy_family(
                    args
                ),
            )

            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            selected_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            preview_scores_exists = (
                output_dir / "replay-tape-preview-scores.jsonl"
            ).exists()

        self.assertEqual(payload["status"], "selection_only")
        self.assertEqual(payload["replay_candidate_spec_count"], 1)
        self.assertEqual(
            selection["selected_candidate_spec_ids"], ["spec-nvda-continuation"]
        )
        self.assertEqual(
            [spec["candidate_spec_id"] for spec in selected_specs],
            ["spec-nvda-continuation"],
        )
        self.assertFalse(selected_specs[0]["promotion_allowed"])
        self.assertFalse(selected_specs[0]["final_promotion_allowed"])
        self.assertFalse(selected_specs[0]["final_authority_ok"])
        self.assertFalse(selection["replay_tape_preview"]["promotion_proof"])
        self.assertIn(
            "exact_replay_required", selection["replay_tape_preview"]["blockers"]
        )
        self.assertIn(
            "adaptive_signal_falsification_if_adaptive_factor_or_signal_source",
            selection["replay_tape_preview"]["proof_semantics"][
                "final_promotion_requires"
            ],
        )
        self.assertTrue(preview_scores_exists)
        nvda_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == "spec-nvda-continuation"
        )
        self.assertIn("fast_replay_preview_ofi_pressure_score", nvda_row)
        self.assertIn("fast_replay_preview_microprice_bias_bps", nvda_row)
        self.assertIn("fast_replay_preview_impact_liquidity_penalty_bps", nvda_row)
        self.assertIn("fast_replay_preview_required_daily_notional", nvda_row)
        self.assertIn("fast_replay_target_implied_notional_context", nvda_row)
        self.assertIn("fast_replay_cost_impact_lineage", nvda_row)
        self.assertIn("fast_replay_adv_capacity_context", nvda_row)
        self.assertIn("fast_replay_lineage_blockers", nvda_row)
        self.assertIn("fast_replay_risk_flags", nvda_row)
        self.assertIn("fast_replay_adaptive_signal_falsification_stress", nvda_row)
        adaptive_falsification_stress = nvda_row[
            "fast_replay_adaptive_signal_falsification_stress"
        ]
        self.assertEqual(
            adaptive_falsification_stress["status"],
            "research_only_adaptive_signal_falsification_evidence_collection",
        )
        self.assertTrue(nvda_row["fast_replay_adaptive_signal_falsification_required"])
        self.assertFalse(nvda_row["fast_replay_adaptive_signal_falsification_passed"])
        self.assertIn(
            "spurious_predictability_arxiv_2604_15531_2026",
            nvda_row["fast_replay_adaptive_signal_falsification_source_markers"],
        )
        self.assertIn(
            "null_model_sample_count_below_min",
            nvda_row["fast_replay_adaptive_signal_falsification_warnings"],
        )
        self.assertIn(
            "leakage_probe_missing_or_failed",
            nvda_row["fast_replay_adaptive_signal_falsification_warnings"],
        )
        scorecard_patch = nvda_row[
            "fast_replay_adaptive_signal_falsification_objective_scorecard_patch"
        ]
        self.assertTrue(scorecard_patch["required_adaptive_signal_falsification"])
        self.assertFalse(scorecard_patch["adaptive_signal_falsification_passed"])
        self.assertEqual(
            scorecard_patch["adaptive_signal_falsification_artifact_ref"],
            nvda_row["fast_replay_adaptive_signal_falsification_artifact_ref"],
        )
        self.assertFalse(adaptive_falsification_stress["proof_authority"])
        self.assertFalse(adaptive_falsification_stress["promotion_authority"])
        self.assertFalse(adaptive_falsification_stress["promotion_allowed"])
        self.assertFalse(adaptive_falsification_stress["final_authority_ok"])
        self.assertTrue(nvda_row["fast_replay_prefilter_only"])
        self.assertFalse(nvda_row["fast_replay_proof_authority"])
        self.assertFalse(nvda_row["fast_replay_promotion_allowed"])
        self.assertFalse(nvda_row["fast_replay_final_promotion_allowed"])
        self.assertFalse(nvda_row["fast_replay_final_authority_ok"])
        aapl_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == "spec-aapl-continuation"
        )
        self.assertTrue(aapl_row["pre_fast_replay_preview_selected_for_replay"])
        self.assertFalse(aapl_row["selected_for_replay"])
        self.assertEqual(aapl_row["selection_reason"], "fast_replay_preview_filtered")

    def test_fast_replay_preview_builds_bounded_sim_target_queue_and_caps_exact_replay(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            output_dir.mkdir()
            tape_path = Path(tmpdir) / "tape.jsonl"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 14, 30 + index, tzinfo=timezone.utc),
                    symbol=symbol,
                    timeframe="1Min",
                    seq=index,
                    source="ta",
                    payload={
                        "price": Decimal(str(100 + index)),
                        "spread_bps": Decimal("2"),
                        "ofi": Decimal("0.35"),
                        "microbar_volume": Decimal("100000"),
                        "event_type": "trade",
                    },
                )
                for index, symbol in enumerate(["NVDA", "AAPL", "INTC"] * 3)
            ]
            args = self._args(output_dir)
            args.replay_mode = "real"
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-23"
            args.symbols = "NVDA,AAPL,INTC"
            args.replay_tape_path = tape_path
            args.replay_tape_preview_top_k = 8
            args.replay_tape_exact_candidate_cap = 99
            args.replay_tape_dataset_snapshot_ref = "frontier-preview"
            args.allow_unsafe_replay_tape_exact_cap_override = True
            requested_symbols = artifact_io._candidate_universe_symbols_from_args(args)
            source_query_digest = (
                queue_metadata._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 23),
                )
            )
            feature_schema_hash = (
                queue_metadata._materialized_replay_tape_feature_schema_hash(args)
            )
            cost_model_hash = queue_metadata._materialized_replay_tape_cost_model_hash(
                args
            )
            strategy_family = queue_metadata._materialized_replay_tape_strategy_family(
                args
            )
            materialize_signal_tape(
                rows=rows,
                tape_path=tape_path,
                dataset_snapshot_ref="frontier-preview",
                symbols=("NVDA", "AAPL", "INTC"),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=source_query_digest,
                feature_schema_hash=feature_schema_hash,
                cost_model_hash=cost_model_hash,
                strategy_family=strategy_family,
                source_table_versions={"signals": "v1"},
            )
            specs = [
                self._candidate_spec(
                    f"spec-frontier-{index}",
                    entry_minute_after_open=str(45 + index),
                )
                for index in range(8)
            ]
            candidate_selection = {
                "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
                "budget": {"selected_count": len(specs)},
                "selected_candidate_spec_ids": [
                    spec.candidate_spec_id for spec in specs
                ],
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "test",
                    }
                    for spec in specs
                ],
            }

            narrowed_specs, updated_selection = (
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                    candidate_selection=candidate_selection,
                )
            )

        self.assertEqual(len(narrowed_specs), 6)
        self.assertEqual(
            updated_selection["budget"]["fast_replay_exact_replay_candidate_cap"], 6
        )
        preview_validation = updated_selection["replay_tape_preview"]["validation"]
        self.assertEqual(preview_validation["source_query_digest"], source_query_digest)
        self.assertEqual(preview_validation["feature_schema_hash"], feature_schema_hash)
        self.assertEqual(preview_validation["cost_model_hash"], cost_model_hash)
        self.assertEqual(preview_validation["strategy_family"], strategy_family)
        self.assertEqual(preview_validation["cache_identity"]["status"], "complete")
        queue_payload = updated_selection["bounded_sim_target_queue"]
        self.assertEqual(queue_payload["exact_replay_candidate_count"], 6)
        self.assertFalse(queue_payload["promotion_proof"])
        self.assertEqual(
            queue_payload["proof_semantics"]["label"],
            fast_replay.FAST_REPLAY_PROOF_SEMANTICS_LABEL,
        )
        self.assertEqual(
            queue_payload["discovery_stage_semantics"]["preview_only_status"],
            "preview_only_ranked",
        )
        self.assertEqual(
            queue_payload["discovery_stage_semantics"]["exact_replay_qualified_status"],
            "exact_replay_qualified_frontier",
        )
        self.assertFalse(
            queue_payload["discovery_stage_semantics"][
                "preview_output_can_authorize_promotion"
            ]
        )
        self.assertTrue(queue_payload["prefilter_only"])
        self.assertFalse(queue_payload["proof_authority"])
        self.assertFalse(queue_payload["promotion_allowed"])
        self.assertFalse(queue_payload["final_promotion_allowed"])
        self.assertFalse(queue_payload["final_authority_ok"])
        self.assertFalse(queue_payload["proof_semantics"]["promotion_allowed"])
        self.assertFalse(queue_payload["proof_semantics"]["final_promotion_allowed"])
        self.assertFalse(queue_payload["proof_semantics"]["final_authority_ok"])
        self.assertEqual(
            queue_payload["runner_policy"]["default_shard_timeout_seconds"], 900
        )
        self.assertEqual(queue_payload["runner_policy"]["default_worker_cap"], 2)
        self.assertFalse(queue_payload["runner_policy"]["kubernetes_fanout_enabled"])
        self.assertEqual(
            queue_payload["runner_policy"]["default_parallel_frontier_candidate_cap"],
            6,
        )
        ranking_boundary = queue_payload["ranking_authority_boundary"]
        self.assertTrue(ranking_boundary["exact_replay_required"])
        self.assertTrue(ranking_boundary["runtime_ledger_required"])
        self.assertFalse(ranking_boundary["ranking_output_can_authorize_promotion"])
        first_entry = queue_payload["entries"][0]
        self.assertIn("preview_rank_score", first_entry)
        self.assertIn("ranking_only_reasons", first_entry)
        self.assertIn("risk_veto_reasons", first_entry)
        self.assertTrue(first_entry["exact_replay_required"])
        self.assertTrue(first_entry["runtime_ledger_required"])
        command_policy = queue_payload["exact_replay_command_policy"]
        self.assertEqual(command_policy["generation_scope"], "bounded_frontier_only")
        self.assertEqual(command_policy["max_exact_replay_candidates"], 6)
        self.assertEqual(command_policy["effective_exact_replay_candidate_cap"], 6)
        self.assertEqual(command_policy["max_local_workers"], 2)
        self.assertEqual(command_policy["shard_timeout_seconds"], 900)
        self.assertFalse(command_policy["proof_packet_upload_allowed"])
        self.assertFalse(command_policy["db_writes_allowed"])
        self.assertFalse(command_policy["kubernetes_fanout_allowed"])
        self.assertFalse(command_policy["promotion_writes_allowed"])
        self.assertFalse(command_policy["final_authority_ok"])
        self.assertEqual(
            queue_payload["target_queue"]["status"],
            "sim_target_queue_ready_live_paper_blocked",
        )
        self.assertEqual(
            queue_payload["target_queue"]["candidate_stage"],
            "bounded_sim_evidence_collection_candidate",
        )
        self.assertEqual(
            queue_payload["replay_tape"]["feature_schema_hash"],
            feature_schema_hash,
        )
        self.assertEqual(
            queue_payload["replay_tape"]["cost_model_hash"], cost_model_hash
        )
        self.assertEqual(
            queue_payload["replay_tape"]["strategy_family"], strategy_family
        )
        self.assertEqual(
            queue_payload["replay_tape"]["source_query_digest"], source_query_digest
        )
        self.assertEqual(
            queue_payload["replay_tape"]["source_table_versions"], {"signals": "v1"}
        )
        self.assertEqual(
            queue_payload["replay_tape"]["cache_identity"]["status"], "complete"
        )
        self.assertFalse(
            queue_payload["replay_tape"]["cache_identity"]["missing_components"]
        )
        self.assertEqual(
            [entry["frontier_bucket"] for entry in queue_payload["entries"]],
            [
                "exploitation",
                "exploitation",
                "exploitation",
                "exploitation",
                "exploration",
                "exploration",
            ],
        )
        first_entry = queue_payload["entries"][0]
        self.assertEqual(
            first_entry["discovery_stage_metadata"]["preview_status"],
            "preview_only_ranked",
        )
        self.assertTrue(
            first_entry["discovery_stage_metadata"]["exact_replay_qualified"]
        )
        self.assertEqual(
            first_entry["discovery_stage_metadata"]["evidence_collection_status"],
            "bounded_sim_evidence_collection_candidate",
        )
        self.assertFalse(first_entry["discovery_stage_metadata"]["promotion_allowed"])
        self.assertIn("observed_post_cost_expectancy_bps", first_entry)
        self.assertIn("required_daily_notional", first_entry)
        self.assertFalse(first_entry["proof_authority"])
        self.assertIn("risk_flags", first_entry)
        self.assertEqual(
            first_entry["reproducibility_metadata"]["dataset_snapshot_ref"],
            "frontier-preview",
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["feature_schema_hash"],
            feature_schema_hash,
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["source_query_digest"],
            source_query_digest,
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["source_table_versions"],
            {"signals": "v1"},
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["cache_identity"]["status"],
            "complete",
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["preview_score"],
            first_entry["preview_score"],
        )
        self.assertIn("target_implied_notional_context", first_entry)
        self.assertIn("cost_impact_lineage", first_entry)
        self.assertIn("impact_capacity_lineage", first_entry)
        self.assertIn("hpairs_macro_window_stress", first_entry)
        self.assertIn("hpairs_impact_capacity_lineage", first_entry)
        self.assertIn("exact_replay_handoff_lineage", first_entry)
        self.assertIn(
            first_entry["handoff_lineage_hash"],
            queue_payload["handoff_lineage_hashes"],
        )
        self.assertEqual(
            first_entry["exact_replay_handoff_lineage"]["lineage_hash"],
            first_entry["handoff_lineage_hash"],
        )
        self.assertEqual(
            first_entry["exact_replay_handoff_lineage"]["discovery_stage_metadata"][
                "evidence_collection_status"
            ],
            "bounded_sim_evidence_collection_candidate",
        )
        self.assertFalse(
            first_entry["exact_replay_handoff_lineage"]["discovery_stage_metadata"][
                "final_promotion_allowed"
            ]
        )
        self.assertEqual(
            first_entry["exact_replay_handoff_lineage"]["replay_tape"][
                "source_query_digest"
            ],
            source_query_digest,
        )
        self.assertEqual(
            first_entry["exact_replay_handoff_lineage"]["replay_tape"][
                "cost_model_hash"
            ],
            cost_model_hash,
        )
        self.assertFalse(
            first_entry["exact_replay_handoff_lineage"]["promotion_allowed"]
        )
        self.assertFalse(
            first_entry["exact_replay_handoff_lineage"]["final_promotion_allowed"]
        )
        self.assertFalse(
            first_entry["exact_replay_handoff_lineage"]["final_authority_ok"]
        )
        self.assertEqual(
            first_entry["adv_capacity_context"]["status"], "missing_source_backed_adv"
        )
        self.assertIn("source_backed_adv_missing", first_entry["lineage_blockers"])
        self.assertFalse(first_entry["promotion_allowed"])
        self.assertFalse(first_entry["final_promotion_allowed"])
        self.assertFalse(first_entry["final_authority_ok"])
        self.assertIn("hpairs_microstructure_prefilter", first_entry)
        self.assertEqual(
            first_entry["hpairs_microstructure_prefilter"]["proof_source"],
            "prefilter_only",
        )
        self.assertFalse(
            first_entry["hpairs_microstructure_prefilter"]["final_promotion_allowed"]
        )
        self.assertIn(
            "horizon_ofi_features",
            first_entry["hpairs_microstructure_prefilter"],
        )
        self.assertIn(
            "macro_window_stress",
            first_entry["hpairs_microstructure_prefilter"],
        )
        self.assertIn(
            "impact_capacity_lineage",
            first_entry["hpairs_microstructure_prefilter"],
        )
