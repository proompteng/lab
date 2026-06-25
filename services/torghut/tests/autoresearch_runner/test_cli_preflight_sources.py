from __future__ import annotations

import app.trading.discovery.portfolio_optimizer as portfolio_optimizer
import scripts.whitepaper_autoresearch_runner.artifact_io as artifact_io
import scripts.whitepaper_autoresearch_runner.persisted_feedback_sources as persisted_feedback_sources
import socket

import json
import sys
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


import scripts.run_whitepaper_autoresearch_profit_target as runner
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
    _CHIP_UNIVERSE,
    _compact_recent_whitepaper_sources,
)


class TestAutoresearchRunnerCliPreflightSources(AutoresearchRunnerTestCase):
    def test_parse_args_defaults_to_500_daily_profit_program(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with patch.object(
                sys,
                "argv",
                [
                    "run_whitepaper_autoresearch_profit_target.py",
                    "--output-dir",
                    tmpdir,
                ],
            ):
                args = runner._parse_args()

        self.assertEqual(args.target_net_pnl_per_day, "500")
        self.assertEqual(args.epoch_id, "")
        self.assertEqual(
            args.program,
            Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            ),
        )
        self.assertIsNone(args.min_daily_net_pnl)
        self.assertEqual(args.symbols.split(","), _CHIP_UNIVERSE)
        self.assertEqual(args.feedback_evidence_jsonl, [])

    def test_parse_args_uses_reachable_clickhouse_env_defaults(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with (
                patch.dict(
                    "os.environ",
                    {
                        "TA_CLICKHOUSE_URL": "http://127.0.0.1:8123",
                        "TA_CLICKHOUSE_USERNAME": "reader",
                    },
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ),
            ):
                args = runner._parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://127.0.0.1:8123")
        self.assertEqual(args.clickhouse_username, "reader")
        self.assertEqual(args.clickhouse_password_env, "TA_CLICKHOUSE_PASSWORD")

    def test_parse_args_prefers_explicit_clickhouse_http_url_over_ta_jdbc(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            with (
                patch.dict(
                    "os.environ",
                    {
                        "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut",
                        "CLICKHOUSE_HTTP_URL": "http://127.0.0.1:8123",
                    },
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ),
            ):
                args = runner._parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://127.0.0.1:8123")

    def test_clickhouse_preflight_fails_fast_for_unresolved_in_cluster_dns(
        self,
    ) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            clickhouse_http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )

        with patch(
            "scripts.whitepaper_autoresearch_runner.artifact_io.socket.getaddrinfo",
            side_effect=socket.gaierror("not known"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertIn("clickhouse_endpoint_unreachable", failure)
        self.assertIn("TA_CLICKHOUSE_URL", failure)
        self.assertIn("--clickhouse-http-url", failure)

    def test_clickhouse_preflight_skips_explicit_non_cluster_endpoint(self) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            clickhouse_http_url="http://127.0.0.1:8123",
        )

        with patch(
            "scripts.whitepaper_autoresearch_runner.artifact_io.socket.getaddrinfo",
            side_effect=AssertionError("non-cluster endpoints are replay-checked"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertEqual(failure, "")

    def test_clickhouse_preflight_skips_when_replay_tape_is_supplied(self) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            replay_tape_path=Path("/tmp/replay-tape.jsonl"),
            clickhouse_http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )

        with patch(
            "scripts.whitepaper_autoresearch_runner.artifact_io.socket.getaddrinfo",
            side_effect=AssertionError("replay tape should bypass DNS preflight"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertEqual(failure, "")

    def test_workflow_template_surfaces_feedback_and_fails_closed_on_stale_tape(
        self,
    ) -> None:
        template_path = (
            Path(__file__).parents[4]
            / "argocd"
            / "applications"
            / "torghut"
            / "whitepaper-autoresearch-workflowtemplate.yaml"
        )
        template = template_path.read_text()

        self.assertIn("name: feedbackEvidenceJsonlB64", template)
        self.assertIn("name: candidateSpecsJsonlB64", template)
        self.assertIn("name: candidateSpecsConfigMapName", template)
        self.assertIn("name: candidateSpecsConfigMapKey", template)
        self.assertIn("--candidate-specs", template)
        self.assertIn("TORGHUT_WHITEPAPER_CANDIDATE_SPECS_JSONL_B64", template)
        self.assertIn("TORGHUT_WHITEPAPER_CANDIDATE_SPECS_CONFIGMAP_PATH", template)
        self.assertIn("name: feedbackEvidenceConfigMapName", template)
        self.assertIn("name: feedbackEvidenceConfigMapKey", template)
        self.assertIn("--feedback-evidence-jsonl", template)
        self.assertIn("TORGHUT_WHITEPAPER_FEEDBACK_EVIDENCE_JSONL_B64", template)
        self.assertIn("TORGHUT_WHITEPAPER_FEEDBACK_EVIDENCE_CONFIGMAP_PATH", template)
        self.assertIn("TORGHUT_WHITEPAPER_SOURCE_JSONL_B64", template)
        self.assertIn('--epoch-id "${RUN_ID}"', template)
        self.assertIn("name: feedback-evidence", template)
        self.assertIn("name: candidate-specs", template)
        self.assertNotIn(
            "printf '%s' \"{{inputs.parameters.feedbackEvidenceJsonlB64}}\"",
            template,
        )
        self.assertNotIn(
            "printf '%s' \"{{inputs.parameters.candidateSpecsJsonlB64}}\"",
            template,
        )
        self.assertNotIn(
            "printf '%s' \"{{inputs.parameters.sourceJsonlB64}}\"",
            template,
        )
        self.assertIn(
            'if [ -n "{{inputs.parameters.fullWindowStartDate}}" ]; then',
            template,
        )
        self.assertIn(
            'if [ -n "{{inputs.parameters.expectedLastTradingDay}}" ]; then',
            template,
        )
        self.assertIn("parallelism: 1", template)
        self.assertIn("name: torghut-whitepaper-autoresearch-profit-target", template)
        self.assertIn("podGC:\n    strategy: OnPodCompletion", template)
        self.assertIn("secondsAfterCompletion: 172800", template)
        self.assertIn("name: maxCandidates\n        value: '128'", template)
        self.assertIn("name: topK\n        value: '64'", template)
        self.assertIn("name: explorationSlots\n        value: '48'", template)
        self.assertIn("name: feedbackBlockReauditSlots\n        value: '32'", template)
        self.assertIn(
            "name: maxFrontierCandidatesPerSpec\n        value: '2'", template
        )
        self.assertIn(
            "name: maxTotalFrontierCandidates\n        value: '128'", template
        )
        self.assertIn("name: realReplayTimeoutSeconds\n        value: '7200'", template)
        self.assertIn(
            "name: realReplayShardTimeoutSeconds\n        value: '900'", template
        )
        self.assertIn("name: realReplayShardWorkers\n        value: '4'", template)
        self.assertIn("name: trainDays\n        value: '12'", template)
        self.assertIn("name: holdoutDays\n        value: '8'", template)
        self.assertIn("name: secondOosDays\n        value: '5'", template)
        self.assertIn('--train-days "{{inputs.parameters.trainDays}}"', template)
        self.assertIn('--holdout-days "{{inputs.parameters.holdoutDays}}"', template)
        self.assertIn(
            '--second-oos-days "{{inputs.parameters.secondOosDays}}"', template
        )
        self.assertIn(
            '--latest-complete-window-min-days "{{inputs.parameters.latestCompleteWindowMinDays}}"',
            template,
        )
        self.assertIn(
            '--min-executable-rows-per-symbol-day "{{inputs.parameters.minExecutableRowsPerSymbolDay}}"',
            template,
        )
        self.assertIn("replay-source-coverage-diagnostics.json", template)
        self.assertIn("cpu: 4", template)
        self.assertIn("memory: 12Gi", template)
        self.assertIn("cpu: 8", template)
        self.assertIn("memory: 32Gi", template)
        self.assertIn("--feedback-block-reaudit-slots", template)
        self.assertIn(
            "--program config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml",
            template,
        )
        self.assertNotIn("--require-no-flat-days", template)
        self.assertNotIn(
            '--min-daily-net-pnl "{{inputs.parameters.targetNetPnlPerDay}}"', template
        )
        self.assertIn("activeDeadlineSeconds: 9000", template)
        self.assertIn("name: allowStaleTape\n        value: 'false'", template)
        self.assertIn("name: selectionOnly\n        value: 'false'", template)
        self.assertIn("name: selectionOnly", template)
        self.assertIn(
            'if [ "{{inputs.parameters.selectionOnly}}" = "true" ]; then',
            template,
        )
        self.assertIn("SCRIPT_ARGS+=(--selection-only)", template)
        self.assertNotIn("value: '2026-04-24'", template)
        self.assertNotIn("value: '2026-05-01'", template)

    def test_parse_args_defaults_strategy_configmap_to_runtime_env_path(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with patch.dict(
                "os.environ",
                {"TRADING_STRATEGY_CONFIG_PATH": "/etc/torghut/strategies.yaml"},
            ):
                with patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ):
                    args = runner._parse_args()

        self.assertEqual(args.strategy_configmap, Path("/etc/torghut/strategies.yaml"))

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

    def test_main_treats_selection_only_as_success(self) -> None:
        with (
            patch.object(runner, "_parse_args", return_value=Namespace()),
            patch.object(
                runner,
                "run_whitepaper_autoresearch_profit_target",
                return_value={"status": "selection_only"},
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 0)

    def test_candidate_universe_symbols_filter_to_live_chip_coverage(self) -> None:
        symbols = artifact_io._candidate_universe_symbols_from_args(
            Namespace(symbols="NVDA,AAPL,MSFT,AMAT,TSM,nvda")
        )

        self.assertEqual(symbols, ("NVDA", "AAPL"))

    def test_program_research_sources_feed_whitepaper_claim_compiler(self) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.program = Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            )
            program = runner._load_epoch_program(args)
            sources = runner._program_whitepaper_sources(program)

        source_ids = {source.run_id for source in sources}
        self.assertIn("weighted_microprice_momentum_2026", source_ids)
        self.assertIn("macro_announcement_intraday_momentum_2025", source_ids)
        self.assertIn("intraday_ofi_news_dynamics_2025", source_ids)
        self.assertIn("order_flow_filtration_2025", source_ids)
        self.assertIn("realistic_market_impact_rl_envs_2026", source_ids)
        self.assertIn("vwap_regime_classification_intraday_2026", source_ids)
        self.assertIn("structural_limits_ohlcv_intraday_2026", source_ids)
        self.assertIn("latent_microstructure_regime_detection_2026", source_ids)
        self.assertIn("unified_order_flow_impact_volatility_2026", source_ids)
        self.assertIn("closing_auction_market_making_2026", source_ids)
        self.assertIn("mixed_market_limit_execution_2026", source_ids)
        self.assertIn("regime_weighted_conformal_var_2026", source_ids)
        self.assertIn("retail_limit_orders_2025", source_ids)
        self.assertIn("retail_order_flow_segmentation_2026", source_ids)
        self.assertIn("lobdiff_event_stream_prediction_2026", source_ids)
        self.assertIn("neural_hawkes_lob_simulation_2025", source_ids)
        self.assertIn("algorithmic_retail_options_intraday_2026", source_ids)
        self.assertIn("learning_from_book_short_run_efficiency_2026", source_ids)
        self.assertIn("idiosyncratic_trade_imbalance_2026", source_ids)
        self.assertIn("intraday_price_asymmetry_sp500_2026", source_ids)
        self.assertIn("market_depth_execution_delays_2026", source_ids)
        self.assertIn("alphacrafter_factor_execution_loop_2026", source_ids)
        self.assertIn("financial_multi_agent_cost_awareness_2026", source_ids)
        self.assertIn("live_market_agent_arena_2025", source_ids)
        self.assertIn("tradetrap_system_stress_2025", source_ids)
        self.assertIn("agentic_trading_evidence_ledger_2026", source_ids)

        weighted_microprice = next(
            source
            for source in sources
            if source.run_id == "weighted_microprice_momentum_2026"
        )
        claim_types = {str(claim["claim_type"]) for claim in weighted_microprice.claims}
        self.assertIn("feature_recipe", claim_types)
        self.assertIn("validation_requirement", claim_types)
        self.assertTrue(
            runner.compile_sources_to_hypothesis_cards([weighted_microprice])
        )

        impact_source = next(
            source
            for source in sources
            if source.run_id == "realistic_market_impact_rl_envs_2026"
        )
        impact_claim_types = {
            str(claim["claim_type"]) for claim in impact_source.claims
        }
        self.assertIn("feature_recipe", impact_claim_types)
        self.assertIn("risk_constraint", impact_claim_types)
        self.assertIn("route_tca", impact_source.claims[0]["data_requirements"])
        self.assertEqual(impact_source.claims[0]["horizon_scope"], "intraday_execution")
        self.assertTrue(runner.compile_sources_to_hypothesis_cards([impact_source]))

        latent_regime_source = next(
            source
            for source in sources
            if source.run_id == "latent_microstructure_regime_detection_2026"
        )
        latent_claim_types = {
            str(claim["claim_type"]) for claim in latent_regime_source.claims
        }
        self.assertIn("feature_recipe", latent_claim_types)
        self.assertIn("validation_requirement", latent_claim_types)

        book_source = next(
            source
            for source in sources
            if source.run_id == "learning_from_book_short_run_efficiency_2026"
        )
        book_claim_types = {str(claim["claim_type"]) for claim in book_source.claims}
        self.assertIn("feature_recipe", book_claim_types)
        self.assertIn("validation_requirement", book_claim_types)

        agentic_ledger_source = next(
            source
            for source in sources
            if source.run_id == "agentic_trading_evidence_ledger_2026"
        )
        self.assertEqual(
            {claim["claim_id"] for claim in agentic_ledger_source.claims},
            {
                "evidence_ledger_required_for_reproducibility",
                "closed_loop_action_output_boundary",
            },
        )

        depth_delay_source = next(
            source
            for source in sources
            if source.run_id == "market_depth_execution_delays_2026"
        )
        depth_delay_claim_types = {
            str(claim["claim_type"]) for claim in depth_delay_source.claims
        }
        self.assertIn("feature_recipe", depth_delay_claim_types)
        self.assertIn("validation_requirement", depth_delay_claim_types)
        self.assertIn("market_depth", depth_delay_source.claims[0]["data_requirements"])
        self.assertIn(
            "execution_delay", depth_delay_source.claims[0]["data_requirements"]
        )

        retail_limit_source = next(
            source for source in sources if source.run_id == "retail_limit_orders_2025"
        )
        self.assertTrue(
            runner.compile_sources_to_hypothesis_cards([retail_limit_source])
        )
        self.assertIn(
            "order_type_ablation", retail_limit_source.claims[0]["data_requirements"]
        )
        self.assertIn(
            "opportunity_cost", retail_limit_source.claims[1]["data_requirements"]
        )

        ofi_news_source = next(
            source
            for source in sources
            if source.run_id == "intraday_ofi_news_dynamics_2025"
        )
        self.assertTrue(runner.compile_sources_to_hypothesis_cards([ofi_news_source]))
        self.assertIn(
            "price_flow_impact", ofi_news_source.claims[0]["data_requirements"]
        )
        self.assertEqual(ofi_news_source.claims[0]["claim_type"], "signal_mechanism")
        self.assertEqual(ofi_news_source.claims[1]["claim_type"], "market_regime")

        filtration_source = next(
            source
            for source in sources
            if source.run_id == "order_flow_filtration_2025"
        )
        self.assertTrue(runner.compile_sources_to_hypothesis_cards([filtration_source]))
        self.assertIn(
            "filtered_orderbook_imbalance",
            filtration_source.claims[0]["data_requirements"],
        )
        self.assertEqual(filtration_source.claims[0]["claim_type"], "feature_recipe")
        self.assertEqual(
            filtration_source.claims[1]["claim_type"], "validation_requirement"
        )
