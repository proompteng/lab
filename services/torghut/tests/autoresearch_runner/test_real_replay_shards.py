from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Sequence, cast
from unittest.mock import patch


import scripts.compile_whitepaper_claims as claim_compiler_script
import scripts.run_whitepaper_autoresearch_profit_target as runner
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
    _FakeSigalrmSignal,
)


class TestAutoresearchRunnerRealReplayShards(AutoresearchRunnerTestCase):
    def test_real_replay_evidence_carries_feedback_shape_metadata(self) -> None:
        spec = self._candidate_spec("spec-real-replay-shape-metadata")
        with TemporaryDirectory() as tmpdir:
            result_path = Path(tmpdir) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real-replay-shape",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "650",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(runner, "_current_code_commit", return_value="abc123"):
                replay = runner._real_replay_result_from_factory_payload(
                    {
                        "experiments": [
                            {
                                "candidate_spec_id": spec.candidate_spec_id,
                                "result_path": str(result_path),
                                "dataset_snapshot_id": "snap-real-replay-shape",
                            }
                        ]
                    },
                    specs_by_id={spec.candidate_spec_id: spec},
                )

        self.assertEqual(len(replay.evidence_bundles), 1)
        self.assertEqual(replay.evidence_bundles[0].code_commit, "abc123")
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(
            scorecard["feedback_shape_key"],
            runner._candidate_spec_feedback_shape_key(spec),
        )
        self.assertEqual(
            scorecard["feedback_risk_profile_key"],
            runner._candidate_spec_feedback_risk_profile_key(spec),
        )
        self.assertEqual(
            scorecard["execution_signature"],
            runner._candidate_spec_execution_signature(spec),
        )

    def test_real_replay_evidence_promotes_summary_activity_counts(self) -> None:
        with TemporaryDirectory() as tmp:
            result_path = Path(tmp) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "summary": {
                            "decision_count": 0,
                            "filled_count": 0,
                            "orders_submitted_count": 0,
                            "avg_filled_notional_per_day": "0",
                        },
                        "top": [
                            {
                                "candidate_id": "cand-summary-activity",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "0",
                                    "active_day_ratio": "0",
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            replay = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "result_path": str(result_path),
                            "candidate_spec_id": "spec-summary-activity",
                            "dataset_snapshot_id": "real-summary-activity",
                        }
                    ]
                }
            )

        self.assertEqual(len(replay.evidence_bundles), 1)
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(scorecard["decision_count"], 0)
        self.assertEqual(scorecard["filled_count"], 0)
        self.assertEqual(scorecard["orders_submitted_count"], 0)
        self.assertEqual(scorecard["avg_filled_notional_per_day"], "0")

    def test_real_replay_evidence_derives_activity_counts_from_decomposition(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp:
            result_path = Path(tmp) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-decomposition-activity",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "-13.37",
                                    "active_day_ratio": "0",
                                },
                                "decomposition": {
                                    "families": {
                                        "opening_drive_leader_reclaim_v1": {
                                            "evaluations": 2,
                                            "fills": 2,
                                        }
                                    },
                                    "symbols": {
                                        "NVDA": {
                                            "filled_count": 2,
                                            "net_pnl": "-40.13",
                                        }
                                    },
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            replay = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "result_path": str(result_path),
                            "candidate_spec_id": "spec-decomposition-activity",
                            "dataset_snapshot_id": "real-decomposition-activity",
                        }
                    ]
                }
            )

        self.assertEqual(len(replay.evidence_bundles), 1)
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(scorecard["decision_count"], 2)
        self.assertEqual(scorecard["filled_count"], 2)
        self.assertEqual(scorecard["filled_order_count"], 2)

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

    def test_sharded_real_replay_continues_after_candidate_timeout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            calls: list[list[str]] = []

            def fake_replay(
                _args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                spec_ids = [spec.candidate_spec_id for spec in specs]
                calls.append(spec_ids)
                if len(calls) == 2:
                    raise TimeoutError("real_replay_timeout_seconds:7")
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=spec_ids[0],
                    candidate={
                        "candidate_id": f"cand-{spec_ids[0]}",
                        "objective_scorecard": {
                            "net_pnl_per_day": "10",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                        },
                    },
                    dataset_snapshot_id="snap-shard",
                    result_path=str(output_dir / f"{spec_ids[0]}.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok", "spec_ids": spec_ids},),
                )

            args = self._args(output_dir)
            args.replay_mode = "real"
            args.real_replay_shard_size = 1
            args.real_replay_shard_timeout_seconds = 7
            args.real_replay_shard_workers = 1
            args.real_replay_failed_spec_retries = 0
            with (
                patch.object(runner, "signal", _FakeSigalrmSignal()),
                patch.object(runner, "_run_real_replay", side_effect=fake_replay),
            ):
                result = runner._run_replay_with_optional_timeout(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                )

        self.assertEqual(len(calls), 3)
        self.assertTrue(result.incomplete)
        self.assertEqual(len(result.evidence_bundles), 2)
        self.assertTrue(
            any(
                item.get("status") == "partial_replay_shards_interrupted"
                for item in result.replay_results
            )
        )
        shard_summary = next(
            item
            for item in result.replay_results
            if item.get("status") == "partial_replay_shards_interrupted"
        )
        self.assertEqual(shard_summary["shard_workers"], 1)
        self.assertIn(
            "TimeoutError:real_replay_timeout_seconds:7", result.failure_reasons
        )

    def test_real_replay_timeout_wrapper_uses_child_process_without_sigalrm(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.replay_mode = "real"
            spec = self._candidate_spec("spec-no-sigalrm")
            bundle = runner.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": "candidate-no-sigalrm",
                    "objective_scorecard": {
                        "net_pnl_per_day": "10",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                    },
                },
                dataset_snapshot_id="snap-no-sigalrm",
                result_path=str(output_dir / "candidate-no-sigalrm.json"),
            )

            with (
                patch.object(runner, "signal", object()),
                patch.object(
                    runner,
                    "_run_real_replay_once_in_child_process",
                    return_value=runner.EpochReplayResult(
                        evidence_bundles=(bundle,),
                        replay_results=({"status": "ok"},),
                    ),
                ) as child_replay,
            ):
                result = runner._run_real_replay_once_with_optional_timeout(
                    args=args,
                    output_dir=output_dir,
                    specs=(spec,),
                    timeout_seconds=7,
                )

        self.assertEqual(
            result.evidence_bundles[0].candidate_spec_id, spec.candidate_spec_id
        )
        child_replay.assert_called_once_with(
            args=args,
            output_dir=output_dir,
            specs=(spec,),
            timeout_seconds=7,
        )

    def test_real_replay_child_process_timeout_terminates_worker(self) -> None:
        class FakeQueue:
            closed = False
            joined = False

            def get(self, *, timeout: float) -> Any:
                raise runner.queue.Empty

            def close(self) -> None:
                self.closed = True

            def join_thread(self) -> None:
                self.joined = True

        class FakeProcess:
            def __init__(self) -> None:
                self.exitcode: int | None = None
                self.started = False
                self.terminated = False

            def start(self) -> None:
                self.started = True

            def is_alive(self) -> bool:
                return self.exitcode is None

            def terminate(self) -> None:
                self.terminated = True
                self.exitcode = -15

            def join(self, *, timeout: float | None = None) -> None:
                return None

        class FakeContext:
            def __init__(self) -> None:
                self.queue = FakeQueue()
                self.process = FakeProcess()

            def Queue(self, *, maxsize: int) -> FakeQueue:
                return self.queue

            def Process(self, **_: Any) -> FakeProcess:
                return self.process

        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            spec = self._candidate_spec("spec-child-timeout")
            fake_context = FakeContext()

            with (
                patch.object(
                    runner.multiprocessing,
                    "get_context",
                    return_value=fake_context,
                ),
                patch.object(
                    runner.monotonic_time, "monotonic", side_effect=[0.0, 0.0, 8.0]
                ),
            ):
                with self.assertRaisesRegex(
                    TimeoutError, "real_replay_timeout_seconds:7"
                ):
                    runner._run_real_replay_once_in_child_process(
                        args=args,
                        output_dir=output_dir,
                        specs=(spec,),
                        timeout_seconds=7,
                    )

        self.assertTrue(fake_context.process.started)
        self.assertTrue(fake_context.process.terminated)
        self.assertTrue(fake_context.queue.closed)
        self.assertTrue(fake_context.queue.joined)

    def test_real_replay_worker_reports_success_error_and_error_payload(
        self,
    ) -> None:
        class CaptureQueue:
            def __init__(self, *, fail_error_put: bool = False) -> None:
                self.items: list[tuple[str, Any]] = []
                self.fail_error_put = fail_error_put

            def put(self, item: tuple[str, Any]) -> None:
                if self.fail_error_put and item[0] == "error":
                    raise RuntimeError("queue-put-failed")
                self.items.append(item)

        args = self._args(Path("unused"))
        spec = self._candidate_spec("spec-worker")
        expected = runner.EpochReplayResult(
            evidence_bundles=(),
            replay_results=({"status": "ok"},),
        )
        success_queue = CaptureQueue()
        with patch.object(runner, "_run_real_replay", return_value=expected):
            runner._real_replay_worker(success_queue, args, "worker-output", (spec,))
        self.assertEqual(success_queue.items, [("ok", expected)])

        error_queue = CaptureQueue()
        with patch.object(
            runner, "_run_real_replay", side_effect=ValueError("worker-failed")
        ):
            runner._real_replay_worker(error_queue, args, "worker-output", (spec,))
        self.assertEqual(error_queue.items[0][0], "error")
        self.assertIsInstance(error_queue.items[0][1], ValueError)

        payload_queue = CaptureQueue(fail_error_put=True)
        with patch.object(
            runner, "_run_real_replay", side_effect=ValueError("worker-failed")
        ):
            runner._real_replay_worker(payload_queue, args, "worker-output", (spec,))
        self.assertEqual(
            payload_queue.items,
            [("error_payload", ("ValueError", "worker-failed"))],
        )

    def test_terminate_process_covers_inactive_and_kill_fallback(self) -> None:
        class InactiveProcess:
            terminated = False

            def is_alive(self) -> bool:
                return False

            def terminate(self) -> None:
                self.terminated = True

        inactive = InactiveProcess()
        runner._terminate_process(inactive)
        self.assertFalse(inactive.terminated)

        class StubbornProcess:
            def __init__(self) -> None:
                self.terminated = False
                self.killed = False
                self.join_calls = 0

            def is_alive(self) -> bool:
                return not self.killed

            def terminate(self) -> None:
                self.terminated = True

            def kill(self) -> None:
                self.killed = True

            def join(self, *, timeout: float | None = None) -> None:
                self.join_calls += 1

        stubborn = StubbornProcess()
        runner._terminate_process(stubborn)
        self.assertTrue(stubborn.terminated)
        self.assertTrue(stubborn.killed)
        self.assertEqual(stubborn.join_calls, 2)

    def test_real_replay_child_process_returns_queue_result(self) -> None:
        class FakeQueue:
            closed = False
            joined = False

            def __init__(self, item: tuple[str, Any]) -> None:
                self.item = item

            def get(self, *, timeout: float) -> tuple[str, Any]:
                return self.item

            def close(self) -> None:
                self.closed = True

            def join_thread(self) -> None:
                self.joined = True

        class FakeProcess:
            exitcode: int | None = None

            def __init__(self) -> None:
                self.started = False
                self.terminated = False

            def start(self) -> None:
                self.started = True

            def join(self, *, timeout: float | None = None) -> None:
                return None

            def is_alive(self) -> bool:
                return False

            def terminate(self) -> None:
                self.terminated = True

        class FakeContext:
            def __init__(self, queue: FakeQueue, process: FakeProcess) -> None:
                self.queue = queue
                self.process = process

            def Queue(self, *, maxsize: int) -> FakeQueue:
                return self.queue

            def Process(self, **_: Any) -> FakeProcess:
                return self.process

        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            spec = self._candidate_spec("spec-child-ok")
            expected = runner.EpochReplayResult(
                evidence_bundles=(),
                replay_results=({"status": "ok"},),
            )
            fake_queue = FakeQueue(("ok", expected))
            fake_process = FakeProcess()
            fake_context = FakeContext(fake_queue, fake_process)

            with patch.object(
                runner.multiprocessing, "get_context", return_value=fake_context
            ):
                result = runner._run_real_replay_once_in_child_process(
                    args=args,
                    output_dir=output_dir,
                    specs=(spec,),
                    timeout_seconds=7,
                )

        self.assertIs(result, expected)
        self.assertTrue(fake_process.started)
        self.assertFalse(fake_process.terminated)
        self.assertTrue(fake_queue.closed)
        self.assertTrue(fake_queue.joined)

    def test_real_replay_child_process_raises_worker_statuses(self) -> None:
        class FakeQueue:
            closed = False
            joined = False

            def __init__(self, item: tuple[str, Any]) -> None:
                self.item = item

            def get(self, *, timeout: float) -> tuple[str, Any]:
                return self.item

            def close(self) -> None:
                self.closed = True

            def join_thread(self) -> None:
                self.joined = True

        class FakeProcess:
            exitcode: int | None = None

            def start(self) -> None:
                return None

            def join(self, *, timeout: float | None = None) -> None:
                return None

            def is_alive(self) -> bool:
                return False

        class FakeContext:
            def __init__(self, queue: FakeQueue) -> None:
                self.queue = queue

            def Queue(self, *, maxsize: int) -> FakeQueue:
                return self.queue

            def Process(self, **_: Any) -> FakeProcess:
                return FakeProcess()

        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            spec = self._candidate_spec("spec-child-error")

            for item, expected_error in (
                (("error", ValueError("worker-failed")), ValueError),
                (("error_payload", ("RuntimeError", "payload-failed")), RuntimeError),
            ):
                fake_queue = FakeQueue(item)
                fake_context = FakeContext(fake_queue)
                with (
                    self.subTest(status=item[0]),
                    patch.object(
                        runner.multiprocessing,
                        "get_context",
                        return_value=fake_context,
                    ),
                    self.assertRaises(expected_error),
                ):
                    runner._run_real_replay_once_in_child_process(
                        args=args,
                        output_dir=output_dir,
                        specs=(spec,),
                        timeout_seconds=7,
                    )
                self.assertTrue(fake_queue.closed)
                self.assertTrue(fake_queue.joined)

    def test_real_replay_child_process_detects_worker_exit_without_result(
        self,
    ) -> None:
        class FakeQueue:
            closed = False
            joined = False

            def get(self, *, timeout: float) -> Any:
                raise runner.queue.Empty

            def close(self) -> None:
                self.closed = True

            def join_thread(self) -> None:
                self.joined = True

        class FakeProcess:
            exitcode: int | None = 1

            def start(self) -> None:
                return None

            def is_alive(self) -> bool:
                return False

        class FakeContext:
            def __init__(self) -> None:
                self.queue = FakeQueue()

            def Queue(self, *, maxsize: int) -> FakeQueue:
                return self.queue

            def Process(self, **_: Any) -> FakeProcess:
                return FakeProcess()

        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            spec = self._candidate_spec("spec-child-no-result")
            fake_context = FakeContext()

            with (
                patch.object(
                    runner.multiprocessing, "get_context", return_value=fake_context
                ),
                self.assertRaisesRegex(
                    RuntimeError, "real_replay_worker_exited_without_result"
                ),
            ):
                runner._run_real_replay_once_in_child_process(
                    args=args,
                    output_dir=output_dir,
                    specs=(spec,),
                    timeout_seconds=7,
                )

        self.assertTrue(fake_context.queue.closed)
        self.assertTrue(fake_context.queue.joined)

    def test_sharded_real_replay_retries_failed_specs_individually(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            calls: list[tuple[list[str], int, int, int]] = []

            def fake_replay(
                args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                spec_ids = [spec.candidate_spec_id for spec in specs]
                calls.append(
                    (
                        spec_ids,
                        int(args.max_candidates),
                        int(args.top_k),
                        int(args.max_total_frontier_candidates),
                    )
                )
                if len(calls) == 2:
                    raise TimeoutError("real_replay_timeout_seconds:7")
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=spec_ids[0],
                    candidate={
                        "candidate_id": f"cand-{spec_ids[0]}",
                        "objective_scorecard": {
                            "net_pnl_per_day": "10",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                        },
                    },
                    dataset_snapshot_id="snap-shard",
                    result_path=str(output_dir / f"{spec_ids[0]}.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok", "spec_ids": spec_ids},),
                )

            args = self._args(output_dir)
            args.replay_mode = "real"
            args.real_replay_shard_size = 1
            args.real_replay_shard_timeout_seconds = 7
            args.real_replay_shard_workers = 1
            args.real_replay_failed_spec_retries = 1
            args.real_replay_retry_timeout_seconds = 11
            args.real_replay_retry_max_frontier_candidates_per_spec = 1
            with (
                patch.object(runner, "signal", _FakeSigalrmSignal()),
                patch.object(runner, "_run_real_replay", side_effect=fake_replay),
            ):
                result = runner._run_replay_with_optional_timeout(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                )

        self.assertEqual(len(calls), 4)
        self.assertFalse(result.incomplete)
        self.assertEqual(len(result.evidence_bundles), 3)
        self.assertEqual(calls[-1][1:], (1, 1, 1))
        retry_summary = next(
            item
            for item in result.replay_results
            if item.get("status") == "failed_shard_specs_retried"
        )
        self.assertEqual(retry_summary["retry_timeout_seconds"], 11)
        self.assertEqual(
            retry_summary["completed_candidate_spec_ids"],
            [calls[1][0][0]],
        )
        self.assertEqual(result.failure_reasons, ())

    def test_failed_shard_retry_skips_malformed_and_unknown_spec_ids(self) -> None:
        self.assertEqual(
            runner._failed_shard_spec_ids(
                (
                    {"candidate_spec_ids": "spec-not-a-list"},
                    {"candidate_spec_ids": ["spec-a", "", "spec-a", "spec-b"]},
                )
            ),
            ("spec-a", "spec-b"),
        )

        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            evidence, replay_results, failures, summary = (
                runner._retry_real_replay_failed_shard_specs(
                    args=args,
                    output_dir=Path(tmpdir) / "epoch",
                    specs=(self._candidate_spec("spec-known"),),
                    shard_failures=({"candidate_spec_ids": ["spec-missing"]},),
                    shard_timeout_seconds=7,
                    starting_shard_index=1,
                )
            )

        self.assertEqual(evidence, ())
        self.assertEqual(replay_results, ())
        self.assertEqual(failures, ({"candidate_spec_ids": ["spec-missing"]},))
        self.assertIsNone(summary)

    def test_failed_shard_retry_defaults_timeout_and_reports_retry_failures(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-retry-fails")
        calls: list[tuple[int, int, int]] = []

        def fake_execute(
            plan: runner._ReplayShardPlan,
        ) -> runner._ReplayShardOutcome:
            calls.append(
                (
                    plan.shard_index,
                    plan.timeout_seconds,
                    int(plan.args.max_total_frontier_candidates),
                )
            )
            return runner._ReplayShardOutcome(
                shard_index=plan.shard_index,
                candidate_spec_ids=(spec.candidate_spec_id,),
                result=runner.EpochReplayResult(
                    evidence_bundles=(),
                    replay_results=(),
                ),
                failure={
                    "shard_index": plan.shard_index,
                    "candidate_spec_ids": [spec.candidate_spec_id],
                    "reason": "nested_shard_incomplete",
                },
            )

        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.real_replay_failed_spec_retries = 2
            args.real_replay_retry_timeout_seconds = 0
            args.real_replay_retry_max_frontier_candidates_per_spec = 2
            with patch.object(
                runner, "_execute_real_replay_shard", side_effect=fake_execute
            ):
                evidence, replay_results, failures, summary = (
                    runner._retry_real_replay_failed_shard_specs(
                        args=args,
                        output_dir=Path(tmpdir) / "epoch",
                        specs=(spec,),
                        shard_failures=(
                            {"candidate_spec_ids": [spec.candidate_spec_id]},
                        ),
                        shard_timeout_seconds=7,
                        starting_shard_index=3,
                    )
                )

        self.assertEqual(evidence, ())
        self.assertEqual(replay_results, ())
        self.assertEqual(calls, [(4, 900, 2), (5, 900, 2)])
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["retry_attempt"], 2)
        self.assertEqual(failures[0]["retry_candidate_spec_id"], spec.candidate_spec_id)
        self.assertEqual(failures[0]["retry_timeout_seconds"], 900)
        self.assertEqual(failures[0]["retry_max_frontier_candidates_per_spec"], 2)
        assert summary is not None
        self.assertEqual(len(summary["attempts"]), 2)
        self.assertEqual(
            summary["remaining_failed_candidate_spec_ids"], [spec.candidate_spec_id]
        )

    def test_failed_shard_retry_stops_after_all_specs_complete(self) -> None:
        spec = self._candidate_spec("spec-retry-completes")
        calls: list[int] = []

        def fake_execute(
            plan: runner._ReplayShardPlan,
        ) -> runner._ReplayShardOutcome:
            calls.append(plan.shard_index)
            bundle = runner.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-retry-completes",
                    "objective_scorecard": {
                        "net_pnl_per_day": "10",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                    },
                },
                dataset_snapshot_id="snap-retry-completes",
                result_path="feedback://retry-completes",
            )
            return runner._ReplayShardOutcome(
                shard_index=plan.shard_index,
                candidate_spec_ids=(spec.candidate_spec_id,),
                result=runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok"},),
                ),
            )

        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.real_replay_failed_spec_retries = 2
            with patch.object(
                runner, "_execute_real_replay_shard", side_effect=fake_execute
            ):
                evidence, replay_results, failures, summary = (
                    runner._retry_real_replay_failed_shard_specs(
                        args=args,
                        output_dir=Path(tmpdir) / "epoch",
                        specs=(spec,),
                        shard_failures=(
                            {"candidate_spec_ids": [spec.candidate_spec_id]},
                        ),
                        shard_timeout_seconds=7,
                        starting_shard_index=3,
                    )
                )

        self.assertEqual(calls, [4])
        self.assertEqual(evidence[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(replay_results, ({"status": "ok"},))
        self.assertEqual(failures, ())
        assert summary is not None
        self.assertEqual(len(summary["attempts"]), 1)
        self.assertEqual(
            summary["completed_candidate_spec_ids"], [spec.candidate_spec_id]
        )

    def test_real_replay_shards_use_isolated_output_dirs_and_bounded_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            args = self._args(output_dir)
            args.max_candidates = 24
            args.top_k = 12
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 5

            plans = runner._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=1,
                shard_timeout_seconds=7,
            )

        self.assertEqual(len(plans), 3)
        self.assertEqual(
            [plan.output_dir.name for plan in plans],
            ["shard-001", "shard-002", "shard-003"],
        )
        self.assertTrue(
            all(
                plan.output_dir.parent == output_dir / "strategy-factory-shards"
                for plan in plans
            )
        )
        self.assertEqual(
            [plan.args.max_total_frontier_candidates for plan in plans],
            [2, 2, 2],
        )
        self.assertEqual([plan.args.top_k for plan in plans], [1, 1, 1])

    def test_real_replay_shards_distribute_global_budget_across_one_spec_shards(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:8]
            args = self._args(output_dir)
            args.max_candidates = 24
            args.top_k = 16
            args.max_frontier_candidates_per_spec = 64
            args.max_total_frontier_candidates = 8

            plans = runner._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=1,
                shard_timeout_seconds=7,
            )

        self.assertEqual(len(plans), 8)
        self.assertEqual(
            [int(plan.args.max_total_frontier_candidates) for plan in plans],
            [1] * 8,
        )

    def test_real_replay_shards_runs_bounded_worker_pool(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            args = self._args(output_dir)
            args.real_replay_shard_workers = 8
            workers_seen: list[int] = []
            submitted: list[tuple[Any, runner._ReplayShardPlan]] = []

            class _FakeFuture:
                def __init__(self, outcome: runner._ReplayShardOutcome) -> None:
                    self._outcome = outcome

                def result(self) -> runner._ReplayShardOutcome:
                    return self._outcome

            class _FakeExecutor:
                def __init__(self, max_workers: int) -> None:
                    workers_seen.append(max_workers)

                def __enter__(self) -> _FakeExecutor:
                    return self

                def __exit__(self, *_args: object) -> None:
                    return None

                def submit(
                    self,
                    fn: Any,
                    plan: runner._ReplayShardPlan,
                ) -> _FakeFuture:
                    submitted.append((fn, plan))
                    return _FakeFuture(
                        runner._ReplayShardOutcome(
                            shard_index=plan.shard_index,
                            candidate_spec_ids=tuple(
                                spec.candidate_spec_id for spec in plan.specs
                            ),
                            result=runner.EpochReplayResult(
                                evidence_bundles=(),
                                replay_results=(
                                    {
                                        "status": "ok",
                                        "shard_index": plan.shard_index,
                                    },
                                ),
                            ),
                        )
                    )

            def fake_as_completed(futures: object) -> list[_FakeFuture]:
                return list(cast(Sequence[_FakeFuture], list(futures)))[::-1]

            with (
                patch.object(runner, "ProcessPoolExecutor", _FakeExecutor),
                patch.object(runner, "as_completed", side_effect=fake_as_completed),
            ):
                result = runner._run_real_replay_shards(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                    shard_size=1,
                    shard_timeout_seconds=7,
                )

        self.assertEqual(workers_seen, [2])
        self.assertEqual(len(submitted), 3)
        self.assertTrue(
            all(fn is runner._execute_real_replay_shard for fn, _plan in submitted)
        )
        self.assertEqual(
            [item["shard_index"] for item in result.replay_results],
            [1, 2, 3],
        )

    def test_real_replay_shards_caps_workers_by_parallel_frontier_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:6]
            args = self._args(output_dir)
            args.max_frontier_candidates_per_spec = 4
            args.max_total_frontier_candidates = 24
            args.real_replay_shard_workers = 8
            args.real_replay_max_parallel_frontier_candidates = 10

            plans = runner._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=2,
                shard_timeout_seconds=1200,
            )

        self.assertEqual(
            [runner._replay_shard_frontier_candidate_budget(plan) for plan in plans],
            [8, 8, 8],
        )
        self.assertEqual([plan.timeout_seconds for plan in plans], [900, 900, 900])
        self.assertEqual(
            runner._bounded_real_replay_shard_workers(args=args, plans=plans),
            1,
        )

    def test_real_replay_shards_cap_workers_to_local_limit_even_under_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:4]
            args = self._args(output_dir)
            args.max_frontier_candidates_per_spec = 1
            args.max_total_frontier_candidates = 4
            args.real_replay_shard_workers = 8
            args.real_replay_max_parallel_frontier_candidates = 99

            plans = runner._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=1,
                shard_timeout_seconds=7,
            )

        self.assertEqual(
            runner._bounded_real_replay_shard_workers(args=args, plans=plans),
            2,
        )

    def test_incomplete_sharded_replay_cannot_report_oracle_candidate_found(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"

            def fake_replay(
                *,
                args: Namespace,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                spec = specs[0]
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=spec.candidate_spec_id,
                    candidate={
                        "candidate_id": "cand-incomplete",
                        "objective_scorecard": {
                            "net_pnl_per_day": "400",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                            "daily_net": {
                                "2026-02-23": "400",
                                "2026-02-24": "400",
                                "2026-02-25": "400",
                                "2026-02-26": "400",
                            },
                            "avg_filled_notional_per_day": "350000",
                        },
                    },
                    dataset_snapshot_id="snap-incomplete",
                    result_path=str(output_dir / "incomplete.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "partial_replay_shards_interrupted"},),
                    incomplete=True,
                    failure_reasons=("TimeoutError:real_replay_timeout_seconds:7",),
                )

            args = self._source_jsonl_args(output_dir)
            args.replay_mode = "real"
            args.portfolio_size_min = 1
            with patch.object(
                runner, "_run_replay_with_optional_timeout", side_effect=fake_replay
            ):
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(payload["status_reason"], "selected_replay_incomplete")
        self.assertTrue(payload["replay_incomplete"])
        self.assertFalse(payload["oracle_candidate_found"])
        self.assertIn(
            "selected_replay_incomplete", payload["promotion_readiness"]["blockers"]
        )

    def test_main_returns_nonzero_without_sources(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch.object(
                runner,
                "_parse_args",
                return_value=Namespace(
                    **{
                        **vars(self._args(Path(tmpdir) / "epoch")),
                        "seed_recent_whitepapers": False,
                        "paper_run_id": [],
                    }
                ),
            ),
            patch.object(runner, "_program_whitepaper_sources", return_value=()),
            patch("builtins.print") as mock_print,
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 2)
        self.assertTrue(mock_print.called)
