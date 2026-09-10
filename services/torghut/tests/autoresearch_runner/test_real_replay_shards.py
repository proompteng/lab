from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
from app.trading.discovery.candidate_specs import CandidateSpec
import multiprocessing
import queue
import scripts.run_strategy_factory_v2 as strategy_factory_runner
import scripts.whitepaper_autoresearch_runner.candidate_identity as candidate_identity
import scripts.whitepaper_autoresearch_runner.candidate_prior_scoring as candidate_prior_scoring
import time as monotonic_time

import json
from argparse import Namespace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Sequence
from unittest.mock import patch


import scripts.compile_whitepaper_claims as claim_compiler_script
from scripts.whitepaper_autoresearch_runner import replay_execution
from scripts.whitepaper_autoresearch_runner import replay_shards
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)
import app.trading.discovery.whitepaper_candidate_compiler as whitepaper_candidate_compiler
import app.whitepapers.claim_compiler as claim_compiler
import scripts.whitepaper_autoresearch_runner.replay_models as replay_models


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

            with patch.object(
                replay_execution, "_current_code_commit", return_value="abc123"
            ):
                replay = replay_execution._real_replay_result_from_factory_payload(
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
            candidate_prior_scoring._candidate_spec_feedback_shape_key(spec),
        )
        self.assertEqual(
            scorecard["feedback_risk_profile_key"],
            candidate_prior_scoring._candidate_spec_feedback_risk_profile_key(spec),
        )
        self.assertEqual(
            scorecard["execution_signature"],
            candidate_identity._candidate_spec_execution_signature(spec),
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

            replay = replay_execution._real_replay_result_from_factory_payload(
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

            replay = replay_execution._real_replay_result_from_factory_payload(
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
                strategy_factory_runner,
                "run_strategy_factory_v2",
                return_value=factory_payload,
            ):
                result = replay_execution._run_real_replay(
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
            result = replay_execution._real_replay_result_from_factory_payload(
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
            candidate_identity._candidate_spec_execution_signature(spec),
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
                strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [claim_compiler.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = (
                    whitepaper_candidate_compiler.compile_whitepaper_candidate_specs(
                        hypothesis_cards=cards,
                        family_template_dir=Path("config/trading/families"),
                        seed_sweep_dir=Path("config/trading"),
                    )
                )
                args = self._args(output_dir)
                args.replay_tape_path = output_dir / "tape.jsonl"
                args.replay_tape_manifest = output_dir / "tape.manifest.json"
                result = replay_execution._run_real_replay(
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
                strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [claim_compiler.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = (
                    whitepaper_candidate_compiler.compile_whitepaper_candidate_specs(
                        hypothesis_cards=cards,
                        family_template_dir=Path("config/trading/families"),
                        seed_sweep_dir=Path("config/trading"),
                    )
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_total_frontier_candidates = 11
                result = replay_execution._run_real_replay(
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
                strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [claim_compiler.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = (
                    whitepaper_candidate_compiler.compile_whitepaper_candidate_specs(
                        hypothesis_cards=cards,
                        family_template_dir=Path("config/trading/families"),
                        seed_sweep_dir=Path("config/trading"),
                    )
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_frontier_candidates_per_spec = 64
                args.max_total_frontier_candidates = 8
                result = replay_execution._run_real_replay(
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
                strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [claim_compiler.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = (
                    whitepaper_candidate_compiler.compile_whitepaper_candidate_specs(
                        hypothesis_cards=cards,
                        family_template_dir=Path("config/trading/families"),
                        seed_sweep_dir=Path("config/trading"),
                    )
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_frontier_candidates_per_spec = 8
                args.max_total_frontier_candidates = 0
                result = replay_execution._run_real_replay(
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
                strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [claim_compiler.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = (
                    whitepaper_candidate_compiler.compile_whitepaper_candidate_specs(
                        hypothesis_cards=cards,
                        family_template_dir=Path("config/trading/families"),
                        seed_sweep_dir=Path("config/trading"),
                    )
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
                result = replay_execution._run_real_replay(
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
        program = replay_shards._load_epoch_program(args)
        controls = replay_shards._resolved_real_replay_frontier_controls(args, program)

        self.assertEqual(
            replay_shards._resolved_staged_train_screen_multiplier(args, program),
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
        override_controls = replay_shards._resolved_real_replay_frontier_controls(
            args, program
        )
        self.assertEqual(
            replay_shards._resolved_staged_train_screen_multiplier(args, program),
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
                [claim_compiler.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = (
                whitepaper_candidate_compiler.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
            )
            specs = compilation.executable_specs[:3]
            calls: list[list[str]] = []

            def fake_replay(
                _args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[CandidateSpec],
            ) -> replay_models.EpochReplayResult:
                spec_ids = [spec.candidate_spec_id for spec in specs]
                calls.append(spec_ids)
                if len(calls) == 2:
                    raise TimeoutError("real_replay_timeout_seconds:7")
                bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
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
                return replay_models.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok", "spec_ids": spec_ids},),
                )

            args = self._args(output_dir)
            args.replay_mode = "real"
            args.real_replay_shard_size = 1
            args.real_replay_shard_timeout_seconds = 7
            args.real_replay_shard_workers = 1
            args.real_replay_failed_spec_retries = 0

            def fake_replay_once(
                args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[CandidateSpec],
                timeout_seconds: int,
            ) -> replay_models.EpochReplayResult:
                _ = timeout_seconds
                return fake_replay(args, output_dir=output_dir, specs=specs)

            with patch.object(
                replay_shards,
                "_run_real_replay_once_with_optional_timeout",
                side_effect=fake_replay_once,
            ):
                result = replay_shards._run_replay_with_optional_timeout(
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
            bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
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
                patch.object(replay_execution, "signal", object()),
                patch.object(
                    replay_execution,
                    "_run_real_replay_once_in_child_process",
                    return_value=replay_models.EpochReplayResult(
                        evidence_bundles=(bundle,),
                        replay_results=({"status": "ok"},),
                    ),
                ) as child_replay,
            ):
                result = replay_execution._run_real_replay_once_with_optional_timeout(
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
                raise queue.Empty

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
                    multiprocessing,
                    "get_context",
                    return_value=fake_context,
                ),
                patch.object(monotonic_time, "monotonic", side_effect=[0.0, 0.0, 8.0]),
            ):
                with self.assertRaisesRegex(
                    TimeoutError, "real_replay_timeout_seconds:7"
                ):
                    replay_execution._run_real_replay_once_in_child_process(
                        args=args,
                        output_dir=output_dir,
                        specs=(spec,),
                        timeout_seconds=7,
                    )

        self.assertTrue(fake_context.process.started)
        self.assertTrue(fake_context.process.terminated)
        self.assertTrue(fake_context.queue.closed)
        self.assertTrue(fake_context.queue.joined)
