from __future__ import annotations

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


class TestAutoresearchRunnerRealReplayShardsPart2(AutoresearchRunnerTestCase):
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
