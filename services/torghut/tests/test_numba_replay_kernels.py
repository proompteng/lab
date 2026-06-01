from __future__ import annotations

import logging
from unittest import TestCase
from unittest.mock import patch

from app.trading.discovery.gpu_backends import GpuResearchBackendReport, probe_gpu_research_backend
from app.trading.discovery import numba_replay_kernels
from app.trading.discovery.numba_replay_kernels import simulate_sleeve_paths


class TestNumbaReplayKernels(TestCase):
    def test_cpu_reference_simulates_stops_takes_and_trailing(self) -> None:
        result = simulate_sleeve_paths(
            (
                (10.0, 20.0, -5.0),
                (-40.0, -20.0, 10.0),
                (15.0, 15.0, 15.0),
                (20.0, -5.0, -30.0),
            ),
            stop_loss_bps=50.0,
            take_profit_bps=35.0,
            trailing_drawdown_bps=25.0,
            backend_preference="cpu",
            source_query_digest="source-digest",
            replay_tape_digest="tape-digest",
            config_hash="config-hash",
        )

        self.assertEqual(result.final_pnl_bps, (25.0, -60.0, 45.0, -15.0))
        self.assertEqual(result.max_drawdown_bps, (5.0, 60.0, 0.0, 35.0))
        self.assertEqual(result.hit_stop, (False, True, False, True))
        self.assertEqual(result.hit_take_profit, (False, False, True, False))
        self.assertEqual(result.exit_step, (3, 2, 3, 3))

        payload = result.to_payload()
        self.assertEqual(payload["schema_version"], "torghut.numba-replay-simulation.v1")
        backend_context = payload["backend_context"]
        self.assertEqual(backend_context["requested_backend"], "cpu")
        self.assertEqual(backend_context["selected_backend"], "numpy")
        self.assertFalse(backend_context["promotion_proof"])
        self.assertIn("exact_replay_required", backend_context["blockers"])
        self.assertEqual(backend_context["source_query_digest"], "source-digest")
        self.assertEqual(backend_context["replay_tape_digest"], "tape-digest")
        self.assertEqual(backend_context["config_hash"], "config-hash")

    def test_explicit_numba_cuda_fails_closed_when_unavailable(self) -> None:
        unavailable = GpuResearchBackendReport(
            backend="numba-cuda",
            available=False,
            module="numba.cuda",
            reason="module_not_installed",
        )

        with (
            patch(
                "app.trading.discovery.numba_replay_kernels.probe_gpu_research_backend",
                return_value=unavailable,
            ),
            self.assertRaisesRegex(ValueError, "numba_cuda_unavailable:module_not_installed"),
        ):
            simulate_sleeve_paths(
                ((1.0, 2.0),),
                stop_loss_bps=50.0,
                take_profit_bps=50.0,
                trailing_drawdown_bps=25.0,
                backend_preference="numba-cuda",
            )

    def test_auto_falls_back_to_cpu_when_numba_cuda_unavailable(self) -> None:
        unavailable = GpuResearchBackendReport(
            backend="numba-cuda",
            available=False,
            module="numba.cuda",
            reason="module_not_installed",
        )

        with patch(
            "app.trading.discovery.numba_replay_kernels.probe_gpu_research_backend",
            return_value=unavailable,
        ):
            result = simulate_sleeve_paths(
                ((1.0, 2.0),),
                stop_loss_bps=50.0,
                take_profit_bps=50.0,
                trailing_drawdown_bps=25.0,
                backend_preference="auto",
            )

        backend_context = result.to_payload()["backend_context"]
        self.assertEqual(backend_context["requested_backend"], "auto")
        self.assertEqual(backend_context["selected_backend"], "numpy-fallback")
        self.assertEqual(backend_context["backend"]["reason"], "auto_fallback:module_not_installed")

    def test_numba_cuda_driver_logs_are_quieted_before_gpu_execution(self) -> None:
        driver_logger = logging.getLogger("numba.cuda.cudadrv.driver")
        parent_logger = logging.getLogger("numba.cuda.cudadrv")
        original_driver_level = driver_logger.level
        original_parent_level = parent_logger.level
        try:
            driver_logger.setLevel(logging.NOTSET)
            parent_logger.setLevel(logging.NOTSET)

            numba_replay_kernels._quiet_numba_cuda_driver_logs()

            self.assertEqual(driver_logger.level, logging.WARNING)
            self.assertEqual(parent_logger.level, logging.WARNING)
        finally:
            driver_logger.setLevel(original_driver_level)
            parent_logger.setLevel(original_parent_level)

    def test_numba_cuda_matches_cpu_reference_when_available(self) -> None:
        report = probe_gpu_research_backend("numba-cuda")
        if not report.available:
            self.skipTest(f"numba-cuda unavailable: {report.reason}")
        driver_logger = logging.getLogger("numba.cuda.cudadrv.driver")
        driver_logger.handlers.clear()
        driver_logger.addHandler(logging.NullHandler())
        driver_logger.propagate = False

        returns_bps = (
            (10.0, 20.0, -5.0),
            (-40.0, -20.0, 10.0),
            (15.0, 15.0, 15.0),
            (20.0, -5.0, -30.0),
        )
        cpu_result = simulate_sleeve_paths(
            returns_bps,
            stop_loss_bps=50.0,
            take_profit_bps=35.0,
            trailing_drawdown_bps=25.0,
            backend_preference="cpu",
        )
        gpu_result = simulate_sleeve_paths(
            returns_bps,
            stop_loss_bps=50.0,
            take_profit_bps=35.0,
            trailing_drawdown_bps=25.0,
            backend_preference="numba-cuda",
        )

        self.assertEqual(gpu_result.final_pnl_bps, cpu_result.final_pnl_bps)
        self.assertEqual(gpu_result.max_drawdown_bps, cpu_result.max_drawdown_bps)
        self.assertEqual(gpu_result.hit_stop, cpu_result.hit_stop)
        self.assertEqual(gpu_result.hit_take_profit, cpu_result.hit_take_profit)
        self.assertEqual(gpu_result.exit_step, cpu_result.exit_step)
        self.assertEqual(gpu_result.to_payload()["backend_context"]["selected_backend"], "numba-cuda")
