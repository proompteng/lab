from __future__ import annotations

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Any,
    Namespace,
    Path,
    Sequence,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    claim_compiler_script,
    patch,
    runner,
)
from scripts.whitepaper_autoresearch_runner import replay_execution
from scripts.whitepaper_autoresearch_runner import replay_shards


class TestAutoresearchRunnerRealReplayA(WhitepaperAutoresearchRunnerTestCaseBase):
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

            def fake_replay_once(
                args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
                timeout_seconds: int,
            ) -> runner.EpochReplayResult:
                _ = timeout_seconds
                return fake_replay(args, output_dir=output_dir, specs=specs)

            with patch.object(
                replay_shards,
                "_run_real_replay_once_with_optional_timeout",
                side_effect=fake_replay_once,
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
                patch.object(replay_execution, "signal", object()),
                patch.object(
                    replay_execution,
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
        with patch.object(replay_execution, "_run_real_replay", return_value=expected):
            runner._real_replay_worker(success_queue, args, "worker-output", (spec,))
        self.assertEqual(success_queue.items, [("ok", expected)])

        error_queue = CaptureQueue()
        with patch.object(
            replay_execution,
            "_run_real_replay",
            side_effect=ValueError("worker-failed"),
        ):
            runner._real_replay_worker(error_queue, args, "worker-output", (spec,))
        self.assertEqual(error_queue.items[0][0], "error")
        self.assertIsInstance(error_queue.items[0][1], ValueError)

        payload_queue = CaptureQueue(fail_error_put=True)
        with patch.object(
            replay_execution,
            "_run_real_replay",
            side_effect=ValueError("worker-failed"),
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

            def fake_replay_once(
                args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
                timeout_seconds: int,
            ) -> runner.EpochReplayResult:
                _ = timeout_seconds
                return fake_replay(args, output_dir=output_dir, specs=specs)

            with patch.object(
                replay_shards,
                "_run_real_replay_once_with_optional_timeout",
                side_effect=fake_replay_once,
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
