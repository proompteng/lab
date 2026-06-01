from __future__ import annotations

import logging
import os
from unittest import TestCase
from unittest.mock import patch

from app.trading.discovery import gpu_backends
from app.trading.discovery.gpu_backends import (
    gpu_research_artifact_context,
    probe_gpu_research_backend,
)
from scripts import probe_quant_gpu_backends


class TestQuantGpuBackends(TestCase):
    def test_missing_backend_modules_report_unavailable(self) -> None:
        def missing_module(name: str) -> object:
            raise ModuleNotFoundError(name)

        with patch(
            "app.trading.discovery.gpu_backends.importlib.import_module",
            side_effect=missing_module,
        ):
            cudf_report = probe_gpu_research_backend("rapids-cudf")
            cupy_report = probe_gpu_research_backend("cupy")
            numba_report = probe_gpu_research_backend("numba-cuda")

        self.assertFalse(cudf_report.available)
        self.assertEqual(cudf_report.reason, "module_not_installed")
        self.assertFalse(cupy_report.available)
        self.assertEqual(cupy_report.reason, "module_not_installed")
        self.assertFalse(numba_report.available)
        self.assertEqual(numba_report.reason, "module_not_installed")

    def test_rapids_cudf_probe_payload_keeps_non_secret_failure_contract(self) -> None:
        payload = probe_gpu_research_backend("rapids-cudf").to_payload()

        self.assertEqual(
            payload["schema_version"],
            "torghut.gpu-research-backend-report.v1",
        )
        self.assertEqual(payload["backend"], "rapids-cudf")
        self.assertEqual(payload["module"], "cudf")
        if not payload["available"]:
            reason = str(payload["reason"])
            self.assertTrue(reason)
            self.assertNotIn("password", reason.lower())
            self.assertNotIn("token", reason.lower())
            self.assertNotIn("\n", reason)

    def test_rapids_cudf_probe_reports_cuda_device_metadata_when_available(self) -> None:
        class FakeSeries:
            def __init__(self, values: list[int]) -> None:
                self.values = values

            def sum(self) -> int:
                return sum(self.values)

        class FakeCudf:
            __version__ = "26.4.0"
            Series = FakeSeries

        class Runtime:
            @staticmethod
            def getDeviceCount() -> int:
                return 1

            @staticmethod
            def getDeviceProperties(index: int) -> dict[str, object]:
                self.assertEqual(index, 0)
                return {"name": b"NVIDIA GeForce RTX 5090", "major": 12, "minor": 0}

            @staticmethod
            def runtimeGetVersion() -> int:
                return 13010

        class Cuda:
            runtime = Runtime()

        class FakeCupy:
            cuda = Cuda()

        def import_module(name: str) -> object:
            if name == "cudf":
                return FakeCudf()
            if name == "cupy":
                return FakeCupy()
            raise ModuleNotFoundError(name)

        with patch(
            "app.trading.discovery.gpu_backends.importlib.import_module",
            side_effect=import_module,
        ):
            report = probe_gpu_research_backend("rapids-cudf")

        self.assertTrue(report.available)
        self.assertEqual(report.version, "26.4.0")
        self.assertEqual(report.cuda_runtime, "13010")
        self.assertEqual(report.device_name, "NVIDIA GeForce RTX 5090")
        self.assertEqual(report.compute_capability, "12.0")

    def test_gpu_research_artifact_context_is_not_promotion_proof(self) -> None:
        payload = gpu_research_artifact_context(
            requested_backend="cupy",
            selected_backend="cupy",
            workload="fast_replay_preview",
            backend_report={
                "schema_version": "torghut.gpu-research-backend-report.v1",
                "backend": "cupy",
                "available": True,
            },
            source_query_digest="source-digest",
            replay_tape_digest="tape-digest",
            config_hash="config-hash",
        )

        self.assertEqual(
            payload["schema_version"], "torghut.gpu-research-artifact-context.v1"
        )
        self.assertFalse(payload["promotion_proof"])
        self.assertIn("exact_replay_required", payload["blockers"])
        self.assertIn("runtime_ledger_proof_required", payload["blockers"])
        self.assertIn("live_paper_parity_required", payload["blockers"])
        self.assertEqual(payload["source_query_digest"], "source-digest")
        self.assertEqual(payload["replay_tape_digest"], "tape-digest")

    def test_cupy_probe_rejects_runtime_operation_failure(self) -> None:
        class Runtime:
            @staticmethod
            def getDeviceCount() -> int:
                return 1

            @staticmethod
            def getDeviceProperties(index: int) -> dict[str, object]:
                self.assertEqual(index, 0)
                return {"name": b"NVIDIA GeForce RTX 5090", "major": 12, "minor": 0}

            @staticmethod
            def runtimeGetVersion() -> int:
                return 12090

        class Cuda:
            runtime = Runtime()

        class Cupy:
            __version__ = "13.6.0"
            cuda = Cuda()
            float64 = "float64"

            @staticmethod
            def asarray(values: list[float], *, dtype: str) -> list[float]:
                self.assertEqual(dtype, "float64")
                return values

            @staticmethod
            def diff(values: list[float]) -> list[float]:
                self.assertEqual(values, [1.0, 2.0, 4.0])
                raise RuntimeError("nvrtc64_120_0.dll missing")

        with patch(
            "app.trading.discovery.gpu_backends.importlib.import_module",
            return_value=Cupy(),
        ):
            report = probe_gpu_research_backend("cupy")

        self.assertFalse(report.available)
        self.assertEqual(report.backend, "cupy")
        self.assertEqual(report.device_name, "NVIDIA GeForce RTX 5090")
        self.assertEqual(report.compute_capability, "12.0")
        self.assertEqual(report.reason, "cuda_runtime_operation_failed:RuntimeError")

    def test_numba_probe_quiets_driver_logs_before_device_probe(self) -> None:
        driver_logger = logging.getLogger("numba.cuda.cudadrv.driver")
        parent_logger = logging.getLogger("numba.cuda.cudadrv")
        original_driver_level = driver_logger.level
        original_parent_level = parent_logger.level
        try:
            driver_logger.setLevel(logging.NOTSET)
            parent_logger.setLevel(logging.NOTSET)

            gpu_backends._quiet_numba_cuda_driver_logs()

            self.assertEqual(driver_logger.level, logging.WARNING)
            self.assertEqual(parent_logger.level, logging.WARNING)
        finally:
            driver_logger.setLevel(original_driver_level)
            parent_logger.setLevel(original_parent_level)

    def test_cupy_probe_preloads_windows_nvrtc_before_importing_cupy(self) -> None:
        if os.name != "nt":
            self.skipTest("Windows DLL preload behavior")
        calls: list[str] = []

        class Runtime:
            @staticmethod
            def getDeviceCount() -> int:
                return 1

            @staticmethod
            def getDeviceProperties(index: int) -> dict[str, object]:
                self.assertEqual(index, 0)
                return {"name": b"NVIDIA GeForce RTX 5090", "major": 12, "minor": 0}

            @staticmethod
            def runtimeGetVersion() -> int:
                return 12090

        class Stream:
            class null:
                @staticmethod
                def synchronize() -> None:
                    calls.append("cupy:synchronize")

        class Cuda:
            runtime = Runtime()

        setattr(Cuda, "Stream", Stream)

        class Cupy:
            __version__ = "13.6.0"
            cuda = Cuda()
            float64 = "float64"

            @staticmethod
            def asarray(values: list[float], *, dtype: str) -> list[float]:
                calls.append("cupy:asarray")
                return values

            @staticmethod
            def diff(values: list[float]) -> list[float]:
                calls.append("cupy:diff")
                return [1.0, 2.0]

            @staticmethod
            def asnumpy(values: list[float]) -> list[float]:
                calls.append("cupy:asnumpy")
                return values

        class Pathfinder:
            @staticmethod
            def load_nvidia_dynamic_lib(libname: str) -> object:
                calls.append(f"pathfinder:load:{libname}")
                return object()

        def import_module(name: str) -> object:
            calls.append(f"import:{name}")
            if name == "cuda.pathfinder":
                return Pathfinder()
            if name == "cupy":
                return Cupy()
            raise ModuleNotFoundError(name)

        with patch(
            "app.trading.discovery.gpu_backends.importlib.import_module",
            side_effect=import_module,
        ):
            report = probe_gpu_research_backend("cupy")

        self.assertTrue(report.available)
        self.assertLess(calls.index("pathfinder:load:nvrtc"), calls.index("import:cupy"))
        self.assertIn("cupy:diff", calls)

    def test_probe_cli_prints_requested_backend_json(self) -> None:
        class Report:
            @staticmethod
            def to_payload() -> dict[str, object]:
                return {
                    "schema_version": "torghut.gpu-research-backend-report.v1",
                    "backend": "cupy",
                    "available": True,
                }

        with (
            patch(
                "sys.argv",
                ["probe_quant_gpu_backends.py", "--backend", "cupy"],
            ),
            patch.object(
                probe_quant_gpu_backends,
                "probe_gpu_research_backend",
                return_value=Report(),
            ) as probe,
            patch("builtins.print") as print_mock,
        ):
            exit_code = probe_quant_gpu_backends.main()

        self.assertEqual(exit_code, 0)
        probe.assert_called_once_with("cupy")
        printed = str(print_mock.call_args.args[0])
        self.assertIn('"backend": "cupy"', printed)
        self.assertIn('"available": true', printed)
