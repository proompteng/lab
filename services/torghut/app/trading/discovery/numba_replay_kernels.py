"""Preview-only sleeve path simulation kernels for research narrowing.

The CPU and Numba-CUDA paths intentionally produce advisory research artifacts.
They can accelerate sleeve discovery, but exact replay, live-paper parity, and
runtime-ledger proof remain the promotion authority.
"""

from __future__ import annotations

import importlib
import logging
import warnings
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Mapping, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.discovery.gpu_backends import (
    GpuResearchBackendReport,
    gpu_research_artifact_context,
    probe_gpu_research_backend,
)

NUMBA_REPLAY_SIMULATION_SCHEMA_VERSION = "torghut.numba-replay-simulation.v1"


@dataclass(frozen=True)
class SleevePathSimulationResult:
    final_pnl_bps: tuple[float, ...]
    max_drawdown_bps: tuple[float, ...]
    hit_stop: tuple[bool, ...]
    hit_take_profit: tuple[bool, ...]
    exit_step: tuple[int, ...]
    backend_context: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": NUMBA_REPLAY_SIMULATION_SCHEMA_VERSION,
            "promotion_proof": False,
            "final_pnl_bps": list(self.final_pnl_bps),
            "max_drawdown_bps": list(self.max_drawdown_bps),
            "hit_stop": list(self.hit_stop),
            "hit_take_profit": list(self.hit_take_profit),
            "exit_step": list(self.exit_step),
            "backend_context": dict(self.backend_context),
        }


@dataclass(frozen=True)
class _SimulationArrays:
    final_pnl_bps: NDArray[np.float64]
    max_drawdown_bps: NDArray[np.float64]
    hit_stop: NDArray[np.bool_]
    hit_take_profit: NDArray[np.bool_]
    exit_step: NDArray[np.int64]


def simulate_sleeve_paths(
    returns_bps: Sequence[Sequence[float]],
    *,
    stop_loss_bps: float,
    take_profit_bps: float,
    trailing_drawdown_bps: float,
    backend_preference: str = "cpu",
    source_query_digest: str = "",
    replay_tape_digest: str = "",
    config_hash: str = "",
) -> SleevePathSimulationResult:
    """Simulate simple sleeve exits over a batched returns matrix.

    Supported backend preferences:

    - `cpu` / `numpy`: deterministic CPU reference path.
    - `numba-cuda`: explicit GPU path; fails closed when unavailable.
    - `auto`: try Numba-CUDA, then fall back to CPU with the fallback reason
      captured in artifact metadata.
    """

    matrix = _coerce_returns_matrix(returns_bps)
    stop_loss = _coerce_non_negative_bps(stop_loss_bps, name="stop_loss_bps")
    take_profit = _coerce_non_negative_bps(take_profit_bps, name="take_profit_bps")
    trailing_drawdown = _coerce_non_negative_bps(
        trailing_drawdown_bps,
        name="trailing_drawdown_bps",
    )
    preference = backend_preference.strip().lower()
    if preference in {"", "cpu", "numpy"}:
        arrays = _simulate_cpu(matrix, stop_loss, take_profit, trailing_drawdown)
        report = _cpu_backend_report(reason="explicit_cpu_reference_backend")
        return _build_result(
            arrays,
            requested_backend=preference or "cpu",
            selected_backend="numpy",
            backend_report=report,
            source_query_digest=source_query_digest,
            replay_tape_digest=replay_tape_digest,
            config_hash=config_hash,
        )
    if preference == "auto":
        report = probe_gpu_research_backend("numba-cuda")
        if report.available:
            try:
                arrays = _simulate_numba_cuda(
                    matrix,
                    stop_loss,
                    take_profit,
                    trailing_drawdown,
                )
                return _build_result(
                    arrays,
                    requested_backend="auto",
                    selected_backend="numba-cuda",
                    backend_report=report,
                    source_query_digest=source_query_digest,
                    replay_tape_digest=replay_tape_digest,
                    config_hash=config_hash,
                )
            except Exception as exc:
                fallback_reason = f"auto_fallback:numba_cuda_execution_failed:{type(exc).__name__}"
        else:
            fallback_reason = f"auto_fallback:{report.reason or 'numba_cuda_unavailable'}"
        arrays = _simulate_cpu(matrix, stop_loss, take_profit, trailing_drawdown)
        return _build_result(
            arrays,
            requested_backend="auto",
            selected_backend="numpy-fallback",
            backend_report=_cpu_backend_report(reason=fallback_reason),
            source_query_digest=source_query_digest,
            replay_tape_digest=replay_tape_digest,
            config_hash=config_hash,
        )
    if preference == "numba-cuda":
        report = probe_gpu_research_backend("numba-cuda")
        if not report.available:
            raise ValueError(f"numba_cuda_unavailable:{report.reason or 'unknown'}")
        try:
            arrays = _simulate_numba_cuda(matrix, stop_loss, take_profit, trailing_drawdown)
        except Exception as exc:
            raise ValueError(f"numba_cuda_execution_failed:{type(exc).__name__}") from exc
        return _build_result(
            arrays,
            requested_backend="numba-cuda",
            selected_backend="numba-cuda",
            backend_report=report,
            source_query_digest=source_query_digest,
            replay_tape_digest=replay_tape_digest,
            config_hash=config_hash,
        )
    raise ValueError(f"unsupported_numba_replay_backend:{backend_preference}")


def _coerce_returns_matrix(
    returns_bps: Sequence[Sequence[float]],
) -> NDArray[np.float64]:
    row_values: list[list[float]] = []
    expected_width: int | None = None
    for row in returns_bps:
        values = [float(item) for item in row]
        if not values:
            raise ValueError("returns_bps_steps_required")
        if expected_width is None:
            expected_width = len(values)
        elif len(values) != expected_width:
            raise ValueError("returns_bps_rectangular_matrix_required")
        row_values.append(values)
    if not row_values:
        raise ValueError("returns_bps_paths_required")

    matrix = np.asarray(row_values, dtype=np.float64)
    is_finite = cast(Any, np.isfinite(matrix).all())
    if not bool(is_finite):
        raise ValueError("returns_bps_finite_values_required")
    return matrix


def _coerce_non_negative_bps(value: float, *, name: str) -> float:
    coerced = float(value)
    if not np.isfinite(coerced):
        raise ValueError(f"{name}_finite_required")
    if coerced < 0.0:
        raise ValueError(f"{name}_non_negative_required")
    return coerced


def _simulate_cpu(
    matrix: NDArray[np.float64],
    stop_loss_bps: float,
    take_profit_bps: float,
    trailing_drawdown_bps: float,
) -> _SimulationArrays:
    path_count = int(matrix.shape[0])
    step_count = int(matrix.shape[1])
    final_pnl = np.zeros(path_count, dtype=np.float64)
    max_drawdown = np.zeros(path_count, dtype=np.float64)
    hit_stop = np.zeros(path_count, dtype=np.bool_)
    hit_take_profit = np.zeros(path_count, dtype=np.bool_)
    exit_step = np.full(path_count, step_count, dtype=np.int64)

    for path_index in range(path_count):
        pnl = 0.0
        peak = 0.0
        path_max_drawdown = 0.0
        for step_index in range(step_count):
            pnl += float(matrix[path_index, step_index])
            if pnl > peak:
                peak = pnl
            drawdown = peak - pnl
            if drawdown > path_max_drawdown:
                path_max_drawdown = drawdown
            if stop_loss_bps > 0.0 and pnl <= -stop_loss_bps:
                hit_stop[path_index] = True
                exit_step[path_index] = step_index + 1
                break
            if take_profit_bps > 0.0 and pnl >= take_profit_bps:
                hit_take_profit[path_index] = True
                exit_step[path_index] = step_index + 1
                break
            if (
                trailing_drawdown_bps > 0.0
                and peak > 0.0
                and drawdown >= trailing_drawdown_bps
            ):
                hit_stop[path_index] = True
                exit_step[path_index] = step_index + 1
                break
        final_pnl[path_index] = pnl
        max_drawdown[path_index] = path_max_drawdown

    return _SimulationArrays(
        final_pnl_bps=final_pnl,
        max_drawdown_bps=max_drawdown,
        hit_stop=hit_stop,
        hit_take_profit=hit_take_profit,
        exit_step=exit_step,
    )


def _simulate_numba_cuda(
    matrix: NDArray[np.float64],
    stop_loss_bps: float,
    take_profit_bps: float,
    trailing_drawdown_bps: float,
) -> _SimulationArrays:
    _quiet_numba_cuda_driver_logs()
    cuda = cast(Any, importlib.import_module("numba.cuda"))
    contiguous_matrix = np.ascontiguousarray(matrix, dtype=np.float64)
    path_count = int(contiguous_matrix.shape[0])
    threads_per_block = 128
    blocks_per_grid = (path_count + threads_per_block - 1) // threads_per_block

    device_returns = cuda.to_device(contiguous_matrix)
    device_final_pnl = cuda.device_array(path_count, dtype=np.float64)
    device_max_drawdown = cuda.device_array(path_count, dtype=np.float64)
    device_hit_stop = cuda.device_array(path_count, dtype=np.int8)
    device_hit_take_profit = cuda.device_array(path_count, dtype=np.int8)
    device_exit_step = cuda.device_array(path_count, dtype=np.int64)

    @cuda.jit
    def _kernel(
        returns_matrix: Any,
        stop_loss: float,
        take_profit: float,
        trailing_drawdown: float,
        final_pnl: Any,
        max_drawdown: Any,
        stop_flags: Any,
        take_flags: Any,
        exit_steps: Any,
    ) -> None:
        path_index = cuda.grid(1)
        if path_index >= returns_matrix.shape[0]:
            return
        step_count = returns_matrix.shape[1]
        pnl = 0.0
        peak = 0.0
        path_max_drawdown = 0.0
        stop_hit = 0
        take_hit = 0
        exit_step = step_count
        for step_index in range(step_count):
            pnl += returns_matrix[path_index, step_index]
            if pnl > peak:
                peak = pnl
            drawdown = peak - pnl
            if drawdown > path_max_drawdown:
                path_max_drawdown = drawdown
            if stop_loss > 0.0 and pnl <= -stop_loss:
                stop_hit = 1
                exit_step = step_index + 1
                break
            if take_profit > 0.0 and pnl >= take_profit:
                take_hit = 1
                exit_step = step_index + 1
                break
            if trailing_drawdown > 0.0 and peak > 0.0 and drawdown >= trailing_drawdown:
                stop_hit = 1
                exit_step = step_index + 1
                break
        final_pnl[path_index] = pnl
        max_drawdown[path_index] = path_max_drawdown
        stop_flags[path_index] = stop_hit
        take_flags[path_index] = take_hit
        exit_steps[path_index] = exit_step

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=".*Grid size .* GPU under-utilization.*",
            category=Warning,
        )
        _kernel[blocks_per_grid, threads_per_block](
            device_returns,
            float(stop_loss_bps),
            float(take_profit_bps),
            float(trailing_drawdown_bps),
            device_final_pnl,
            device_max_drawdown,
            device_hit_stop,
            device_hit_take_profit,
            device_exit_step,
        )
    cuda.synchronize()

    return _SimulationArrays(
        final_pnl_bps=np.asarray(device_final_pnl.copy_to_host(), dtype=np.float64),
        max_drawdown_bps=np.asarray(device_max_drawdown.copy_to_host(), dtype=np.float64),
        hit_stop=np.asarray(device_hit_stop.copy_to_host(), dtype=np.int8).astype(np.bool_),
        hit_take_profit=np.asarray(device_hit_take_profit.copy_to_host(), dtype=np.int8).astype(
            np.bool_
        ),
        exit_step=np.asarray(device_exit_step.copy_to_host(), dtype=np.int64),
    )


def _build_result(
    arrays: _SimulationArrays,
    *,
    requested_backend: str,
    selected_backend: str,
    backend_report: GpuResearchBackendReport,
    source_query_digest: str,
    replay_tape_digest: str,
    config_hash: str,
) -> SleevePathSimulationResult:
    backend_context = gpu_research_artifact_context(
        requested_backend=requested_backend,
        selected_backend=selected_backend,
        workload="sleeve_path_simulation",
        backend_report=backend_report.to_payload(),
        source_query_digest=source_query_digest,
        replay_tape_digest=replay_tape_digest,
        config_hash=config_hash,
    )
    return SleevePathSimulationResult(
        final_pnl_bps=tuple(float(item) for item in arrays.final_pnl_bps.tolist()),
        max_drawdown_bps=tuple(float(item) for item in arrays.max_drawdown_bps.tolist()),
        hit_stop=tuple(bool(item) for item in arrays.hit_stop.tolist()),
        hit_take_profit=tuple(bool(item) for item in arrays.hit_take_profit.tolist()),
        exit_step=tuple(int(item) for item in arrays.exit_step.tolist()),
        backend_context=backend_context,
    )


def _cpu_backend_report(*, reason: str) -> GpuResearchBackendReport:
    return GpuResearchBackendReport(
        backend="numpy",
        available=True,
        module="numpy",
        version=np.__version__,
        reason=reason,
    )


def _quiet_numba_cuda_driver_logs() -> None:
    for logger_name in ("numba.cuda.cudadrv", "numba.cuda.cudadrv.driver"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)


__all__ = [
    "NUMBA_REPLAY_SIMULATION_SCHEMA_VERSION",
    "SleevePathSimulationResult",
    "simulate_sleeve_paths",
]
