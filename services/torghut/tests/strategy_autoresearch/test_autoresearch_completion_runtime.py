from __future__ import annotations

from tests.strategy_autoresearch.support import (
    Namespace,
    Path,
    StrategyAutoresearchTestCase,
    TemporaryDirectory,
    json,
    patch,
    runner,
    yaml,
)


class TestStrategyAutoresearchCompletionRuntime(StrategyAutoresearchTestCase):
    def _fixtures(self, root: Path) -> tuple[Path, Path, Path]:
        program_path, family_dir = self._write_program_fixture(root)
        program_payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
        program_payload["objective"]["stop_when_objective_met"] = True
        program_path.write_text(
            yaml.safe_dump(program_payload, sort_keys=False),
            encoding="utf-8",
        )
        configmap_path = root / "strategy-configmap.yaml"
        configmap_path.write_text(
            yaml.safe_dump(
                {
                    "apiVersion": "v1",
                    "kind": "ConfigMap",
                    "data": {"strategies.yaml": "strategies: []\n"},
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return program_path, family_dir, configmap_path

    def _args(
        self,
        *,
        program_path: Path,
        family_dir: Path,
        configmap_path: Path,
        output_dir: Path,
    ) -> Namespace:
        return Namespace(
            program=program_path,
            output_dir=output_dir,
            resume_run_root=None,
            strategy_configmap=configmap_path,
            family_template_dir=family_dir,
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            start_equity="31590.02",
            chunk_minutes=10,
            symbols="",
            progress_log_seconds=30,
            shadow_validation_artifact=None,
            train_days=6,
            holdout_days=3,
            full_window_start_date="",
            full_window_end_date="",
            expected_last_trading_day="",
            allow_stale_tape=False,
            prefetch_full_window_rows=False,
            max_frontier_runs=0,
            json_output=None,
        )

    def _candidate(self, candidate_id: str, *, objective_met: bool) -> dict:
        return {
            "candidate_id": candidate_id,
            "hard_vetoes": [],
            "ranking": {
                "pareto_tier": 1,
                "tie_breaker_score": "10",
                "vetoed": False,
            },
            "objective_scorecard": {
                "net_pnl_per_day": "620" if objective_met else "420",
                "active_day_ratio": "0.85" if objective_met else "0.70",
                "positive_day_ratio": "0.65" if objective_met else "0.55",
                "avg_filled_notional_per_day": (
                    "340000" if objective_met else "290000"
                ),
                "avg_filled_notional_per_active_day": (
                    "400000" if objective_met else "360000"
                ),
                "best_day_share": "0.30" if objective_met else "0.40",
                "worst_day_loss": "300" if objective_met else "350",
                "max_drawdown": "850" if objective_met else "900",
                "regime_slice_pass_rate": "0.50" if objective_met else "0.45",
            },
            "full_window": {
                "net_per_day": "620" if objective_met else "420",
                "trading_day_count": 9,
                "active_days": 8 if objective_met else 6,
                "daily_net": {"2026-04-01": "620" if objective_met else "420"},
                "daily_filled_notional": {
                    "2026-04-01": "340000" if objective_met else "290000"
                },
            },
            "replay_config": {
                "params": {
                    "max_entries_per_session": "2",
                    "entry_cooldown_seconds": "600",
                },
                "strategy_overrides": {
                    "universe_symbols": ["AMAT", "NVDA"],
                    "max_position_pct_equity": "0.10",
                },
            },
        }

    @staticmethod
    def _frontier(candidate: dict) -> dict:
        return {
            "dataset_snapshot_receipt": {"snapshot_id": "snap-1"},
            "top": [candidate],
        }

    @staticmethod
    def _history_semantics(payload: dict) -> list[dict]:
        history = [
            json.loads(line)
            for line in (Path(payload["run_root"]) / "history.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        fields = (
            "candidate_id",
            "status",
            "raw_objective_met",
            "objective_met",
            "terminal_validation_status",
            "terminal_validation_reason",
            "search_action",
            "search_reason",
        )
        return [{field: item[field] for field in fields} for item in history]

    def test_duplicate_candidate_identity_cannot_stop_or_mutate_search(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir, configmap_path = self._fixtures(root)
            args = self._args(
                program_path=program_path,
                family_dir=family_dir,
                configmap_path=configmap_path,
                output_dir=root / "out",
            )

            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=[
                    self._frontier(self._candidate("duplicate-1", objective_met=False)),
                    self._frontier(self._candidate("duplicate-1", objective_met=True)),
                ],
            ) as frontier:
                payload = runner.run_strategy_autoresearch_loop(args)

            self.assertEqual(frontier.call_count, 2)
            self.assertEqual(payload["status"], "ok")
            self.assertFalse(payload["objective_met"])
            duplicate = self._history_semantics(payload)[-1]
            self.assertTrue(duplicate["raw_objective_met"])
            self.assertFalse(duplicate["objective_met"])
            self.assertEqual(duplicate["terminal_validation_status"], "duplicate")
            self.assertEqual(
                duplicate["terminal_validation_reason"],
                "duplicate_candidate_identity",
            )

    def test_max_frontier_limit_persists_explicit_stop_reason(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir, configmap_path = self._fixtures(root)
            args = self._args(
                program_path=program_path,
                family_dir=family_dir,
                configmap_path=configmap_path,
                output_dir=root / "out",
            )
            args.max_frontier_runs = 1

            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                return_value=self._frontier(
                    self._candidate("valid-below", objective_met=False)
                ),
            ) as frontier:
                payload = runner.run_strategy_autoresearch_loop(args)

            frontier.assert_called_once()
            self.assertEqual(payload["frontier_run_count"], 1)
            self.assertFalse(payload["objective_met"])
            self.assertEqual(
                payload["termination"]["reason"],
                "max_frontier_runs_reached",
            )

    def test_setup_interruption_resumes_from_preparation_checkpoint(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir, configmap_path = self._fixtures(root)
            args = self._args(
                program_path=program_path,
                family_dir=family_dir,
                configmap_path=configmap_path,
                output_dir=root / "out",
            )

            with (
                patch(
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop._maybe_materialize_run_replay_tape",
                    side_effect=KeyboardInterrupt("operator stop during setup"),
                ),
                patch(
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier"
                ) as interrupted_frontier,
            ):
                interrupted = runner.run_strategy_autoresearch_loop(args)

            interrupted_frontier.assert_not_called()
            self.assertEqual(interrupted["status"], "interrupted")
            self.assertEqual(interrupted["termination"]["reason"], "run_interrupted")
            run_root = Path(interrupted["run_root"])
            checkpoint = json.loads(
                (run_root / "checkpoint.json").read_text(encoding="utf-8")
            )
            self.assertFalse(checkpoint["setup_complete"])
            self.assertEqual(checkpoint["frontier_runs"], 0)

            args.resume_run_root = run_root
            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop._maybe_materialize_run_replay_tape",
                side_effect=KeyboardInterrupt("second setup interruption"),
            ):
                interrupted_again = runner.run_strategy_autoresearch_loop(args)
            self.assertEqual(interrupted_again["status"], "interrupted")

            with (
                patch(
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop._maybe_materialize_run_replay_tape",
                    return_value=(None, None),
                ) as resumed_setup,
                patch(
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                    return_value=self._frontier(
                        self._candidate("valid-objective", objective_met=True)
                    ),
                ),
            ):
                resumed = runner.run_strategy_autoresearch_loop(args)

            resumed_setup.assert_called_once()
            self.assertEqual(resumed["status"], "ok")
            self.assertTrue(resumed["objective_met"])
            completed_checkpoint = json.loads(
                (run_root / "checkpoint.json").read_text(encoding="utf-8")
            )
            self.assertTrue(completed_checkpoint["setup_complete"])
            decisions = [
                json.loads(line)
                for line in (run_root / "search-decisions.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            reasons = [item["reason"] for item in decisions]
            self.assertEqual(reasons.count("run_interrupted"), 2)
            self.assertEqual(reasons.count("run_resumed_from_checkpoint"), 2)

    def test_interrupted_run_resumes_from_committed_state_deterministically(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir, configmap_path = self._fixtures(root)
            interrupted_args = self._args(
                program_path=program_path,
                family_dir=family_dir,
                configmap_path=configmap_path,
                output_dir=root / "interrupted-out",
            )

            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=KeyboardInterrupt("operator stop"),
            ):
                interrupted = runner.run_strategy_autoresearch_loop(interrupted_args)

            self.assertEqual(interrupted["status"], "interrupted")
            self.assertEqual(interrupted["termination"]["reason"], "run_interrupted")
            run_root = Path(interrupted["run_root"])
            checkpoint = json.loads(
                (run_root / "checkpoint.json").read_text(encoding="utf-8")
            )
            self.assertNotIn(
                "secret",
                (run_root / "checkpoint.json").read_text(encoding="utf-8"),
            )
            self.assertEqual(checkpoint["status"], "running")
            self.assertEqual(checkpoint["frontier_runs"], 0)
            self.assertEqual(len(checkpoint["worklist"]), 1)

            resumed_args = self._args(
                program_path=program_path,
                family_dir=family_dir,
                configmap_path=configmap_path,
                output_dir=root / "unused",
            )
            resumed_args.resume_run_root = run_root
            valid_frontier = self._frontier(
                self._candidate("valid-objective", objective_met=True)
            )
            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                return_value=valid_frontier,
            ) as resumed_frontier:
                resumed = runner.run_strategy_autoresearch_loop(resumed_args)

            clean_args = self._args(
                program_path=program_path,
                family_dir=family_dir,
                configmap_path=configmap_path,
                output_dir=root / "clean-out",
            )
            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                return_value=valid_frontier,
            ):
                clean = runner.run_strategy_autoresearch_loop(clean_args)

            self.assertEqual(resumed_frontier.call_count, 1)
            self.assertEqual(resumed["status"], "ok")
            self.assertTrue(resumed["objective_met"])
            self.assertEqual(resumed["frontier_run_count"], 1)
            self.assertEqual(
                self._history_semantics(resumed),
                self._history_semantics(clean),
            )
            decisions = [
                json.loads(line)
                for line in (run_root / "search-decisions.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertIn("run_interrupted", [item["reason"] for item in decisions])
            self.assertIn(
                "run_resumed_from_checkpoint",
                [item["reason"] for item in decisions],
            )
            completed_checkpoint = json.loads(
                (run_root / "checkpoint.json").read_text(encoding="utf-8")
            )
            self.assertEqual(completed_checkpoint["status"], "completed")

            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier"
            ) as completed_frontier:
                completed_again = runner.run_strategy_autoresearch_loop(resumed_args)
            completed_frontier.assert_not_called()
            self.assertEqual(completed_again, resumed)

    def test_resume_rejects_tampered_checkpoint_before_frontier_execution(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir, configmap_path = self._fixtures(root)
            args = self._args(
                program_path=program_path,
                family_dir=family_dir,
                configmap_path=configmap_path,
                output_dir=root / "out",
            )
            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=KeyboardInterrupt("operator stop"),
            ):
                interrupted = runner.run_strategy_autoresearch_loop(args)

            run_root = Path(interrupted["run_root"])
            checkpoint_path = run_root / "checkpoint.json"
            checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
            checkpoint["frontier_runs"] = 99
            checkpoint_path.write_text(
                json.dumps(checkpoint, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            args.resume_run_root = run_root
            with (
                patch(
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier"
                ) as frontier,
                self.assertRaisesRegex(ValueError, "checkpoint_digest_mismatch"),
            ):
                runner.run_strategy_autoresearch_loop(args)
            frontier.assert_not_called()

    def test_resume_rejects_changed_execution_input_before_frontier_execution(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir, configmap_path = self._fixtures(root)
            args = self._args(
                program_path=program_path,
                family_dir=family_dir,
                configmap_path=configmap_path,
                output_dir=root / "out",
            )
            with patch(
                "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier",
                side_effect=KeyboardInterrupt("operator stop"),
            ):
                interrupted = runner.run_strategy_autoresearch_loop(args)

            configmap_path.write_text(
                yaml.safe_dump(
                    {
                        "apiVersion": "v1",
                        "kind": "ConfigMap",
                        "data": {"strategies.yaml": "strategies:\n- name: changed\n"},
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            args.resume_run_root = Path(interrupted["run_root"])
            with (
                patch(
                    "scripts.strategy_autoresearch_loop.run_strategy_autoresearch_loop.run_consistent_profitability_frontier"
                ) as frontier,
                self.assertRaisesRegex(
                    ValueError,
                    "checkpoint_execution_contract_mismatch",
                ),
            ):
                runner.run_strategy_autoresearch_loop(args)
            frontier.assert_not_called()
