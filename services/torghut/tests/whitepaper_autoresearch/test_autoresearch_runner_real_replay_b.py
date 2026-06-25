from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
from app.trading.discovery.candidate_specs import CandidateSpec
import scripts.whitepaper_autoresearch_runner.replay_models as replay_models

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Any,
    Namespace,
    Path,
    Sequence,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    cast,
    claim_compiler_script,
    patch,
    runner,
)
from scripts.whitepaper_autoresearch_runner import replay_shards
import app.trading.discovery.whitepaper_candidate_compiler as whitepaper_candidate_compiler
import app.whitepapers.claim_compiler as claim_compiler


class TestAutoresearchRunnerRealReplayB(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_failed_shard_retry_defaults_timeout_and_reports_retry_failures(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-retry-fails")
        calls: list[tuple[int, int, int]] = []

        def fake_execute(
            plan: replay_models._ReplayShardPlan,
        ) -> replay_models._ReplayShardOutcome:
            calls.append(
                (
                    plan.shard_index,
                    plan.timeout_seconds,
                    int(plan.args.max_total_frontier_candidates),
                )
            )
            return replay_models._ReplayShardOutcome(
                shard_index=plan.shard_index,
                candidate_spec_ids=(spec.candidate_spec_id,),
                result=replay_models.EpochReplayResult(
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
                replay_shards, "_execute_real_replay_shard", side_effect=fake_execute
            ):
                evidence, replay_results, failures, summary = (
                    replay_shards._retry_real_replay_failed_shard_specs(
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
            plan: replay_models._ReplayShardPlan,
        ) -> replay_models._ReplayShardOutcome:
            calls.append(plan.shard_index)
            bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
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
            return replay_models._ReplayShardOutcome(
                shard_index=plan.shard_index,
                candidate_spec_ids=(spec.candidate_spec_id,),
                result=replay_models.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok"},),
                ),
            )

        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.real_replay_failed_spec_retries = 2
            with patch.object(
                replay_shards, "_execute_real_replay_shard", side_effect=fake_execute
            ):
                evidence, replay_results, failures, summary = (
                    replay_shards._retry_real_replay_failed_shard_specs(
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
            args = self._args(output_dir)
            args.max_candidates = 24
            args.top_k = 12
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 5

            plans = replay_shards._build_real_replay_shards(
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
                [claim_compiler.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = (
                whitepaper_candidate_compiler.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
            )
            specs = compilation.executable_specs[:8]
            args = self._args(output_dir)
            args.max_candidates = 24
            args.top_k = 16
            args.max_frontier_candidates_per_spec = 64
            args.max_total_frontier_candidates = 8

            plans = replay_shards._build_real_replay_shards(
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
            args = self._args(output_dir)
            args.real_replay_shard_workers = 8
            workers_seen: list[int] = []
            submitted: list[tuple[Any, replay_models._ReplayShardPlan]] = []

            class _FakeFuture:
                def __init__(self, outcome: replay_models._ReplayShardOutcome) -> None:
                    self._outcome = outcome

                def result(self) -> replay_models._ReplayShardOutcome:
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
                    plan: replay_models._ReplayShardPlan,
                ) -> _FakeFuture:
                    submitted.append((fn, plan))
                    return _FakeFuture(
                        replay_models._ReplayShardOutcome(
                            shard_index=plan.shard_index,
                            candidate_spec_ids=tuple(
                                spec.candidate_spec_id for spec in plan.specs
                            ),
                            result=replay_models.EpochReplayResult(
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
                patch.object(replay_shards, "ProcessPoolExecutor", _FakeExecutor),
                patch.object(
                    replay_shards, "as_completed", side_effect=fake_as_completed
                ),
            ):
                result = replay_shards._run_real_replay_shards(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                    shard_size=1,
                    shard_timeout_seconds=7,
                )

        self.assertEqual(workers_seen, [2])
        self.assertEqual(len(submitted), 3)
        self.assertTrue(
            all(
                fn is replay_shards._execute_real_replay_shard
                for fn, _plan in submitted
            )
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
                [claim_compiler.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = (
                whitepaper_candidate_compiler.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
            )
            specs = compilation.executable_specs[:6]
            args = self._args(output_dir)
            args.max_frontier_candidates_per_spec = 4
            args.max_total_frontier_candidates = 24
            args.real_replay_shard_workers = 8
            args.real_replay_max_parallel_frontier_candidates = 10

            plans = replay_shards._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=2,
                shard_timeout_seconds=1200,
            )

        self.assertEqual(
            [
                replay_shards._replay_shard_frontier_candidate_budget(plan)
                for plan in plans
            ],
            [8, 8, 8],
        )
        self.assertEqual([plan.timeout_seconds for plan in plans], [900, 900, 900])
        self.assertEqual(
            replay_shards._bounded_real_replay_shard_workers(args=args, plans=plans),
            1,
        )

    def test_real_replay_shards_cap_workers_to_local_limit_even_under_budget(
        self,
    ) -> None:
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
            specs = compilation.executable_specs[:4]
            args = self._args(output_dir)
            args.max_frontier_candidates_per_spec = 1
            args.max_total_frontier_candidates = 4
            args.real_replay_shard_workers = 8
            args.real_replay_max_parallel_frontier_candidates = 99

            plans = replay_shards._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=1,
                shard_timeout_seconds=7,
            )

        self.assertEqual(
            replay_shards._bounded_real_replay_shard_workers(args=args, plans=plans),
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
                specs: Sequence[CandidateSpec],
            ) -> replay_models.EpochReplayResult:
                spec = specs[0]
                bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
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
                return replay_models.EpochReplayResult(
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
