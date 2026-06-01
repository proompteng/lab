"""Optional GPU research backend probes and artifact contracts.

These helpers keep GPU research acceleration explicit. They are intentionally
advisory: backend reports can document how candidates were triaged, but they do
not prove promotion readiness.
"""

from __future__ import annotations

import importlib
import logging
import os
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Mapping, cast

GPU_RESEARCH_BACKEND_REPORT_SCHEMA_VERSION = "torghut.gpu-research-backend-report.v1"
GPU_RESEARCH_ARTIFACT_SCHEMA_VERSION = "torghut.gpu-research-artifact-context.v1"

GPU_RESEARCH_BACKENDS = (
    "rapids-cudf",
    "cupy",
    "numba-cuda",
    "torch-cuda",
)


@dataclass(frozen=True)
class GpuResearchBackendReport:
    backend: str
    available: bool
    module: str
    version: str | None = None
    cuda_runtime: str | None = None
    device_name: str | None = None
    compute_capability: str | None = None
    reason: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": GPU_RESEARCH_BACKEND_REPORT_SCHEMA_VERSION,
            "backend": self.backend,
            "available": self.available,
            "module": self.module,
            "version": self.version,
            "cuda_runtime": self.cuda_runtime,
            "device_name": self.device_name,
            "compute_capability": self.compute_capability,
            "reason": self.reason,
        }


def probe_gpu_research_backend(backend: str) -> GpuResearchBackendReport:
    normalized = _normalize_backend(backend)
    if normalized == "rapids-cudf":
        return _probe_rapids_cudf()
    if normalized == "cupy":
        return _probe_cupy()
    if normalized == "numba-cuda":
        return _probe_numba_cuda()
    if normalized == "torch-cuda":
        return _probe_torch_cuda()
    raise ValueError(f"unsupported_gpu_research_backend:{backend}")


def gpu_research_artifact_context(
    *,
    requested_backend: str,
    selected_backend: str,
    workload: str,
    backend_report: Mapping[str, Any],
    source_query_digest: str = "",
    replay_tape_digest: str = "",
    config_hash: str = "",
) -> dict[str, Any]:
    return {
        "schema_version": GPU_RESEARCH_ARTIFACT_SCHEMA_VERSION,
        "workload": workload,
        "requested_backend": requested_backend,
        "selected_backend": selected_backend,
        "promotion_proof": False,
        "blockers": [
            "gpu_research_preview_only",
            "exact_replay_required",
            "runtime_ledger_proof_required",
            "live_paper_parity_required",
        ],
        "source_query_digest": source_query_digest,
        "replay_tape_digest": replay_tape_digest,
        "config_hash": config_hash,
        "backend": dict(backend_report),
    }


def _normalize_backend(backend: str) -> str:
    normalized = backend.strip().lower()
    if normalized in GPU_RESEARCH_BACKENDS:
        return normalized
    raise ValueError(f"unsupported_gpu_research_backend:{backend}")


def _probe_rapids_cudf() -> GpuResearchBackendReport:
    try:
        cudf = importlib.import_module("cudf")
    except ModuleNotFoundError:
        return GpuResearchBackendReport(
            backend="rapids-cudf",
            available=False,
            module="cudf",
            reason="module_not_installed",
        )
    except Exception as exc:
        return GpuResearchBackendReport(
            backend="rapids-cudf",
            available=False,
            module="cudf",
            reason=f"import_failed:{type(exc).__name__}",
        )
    try:
        _cudf_runtime_smoke_test(cudf)
        metadata = _cupy_device_metadata()
    except Exception as exc:
        return GpuResearchBackendReport(
            backend="rapids-cudf",
            available=False,
            module="cudf",
            version=_module_version(cudf),
            reason=f"cuda_runtime_operation_failed:{type(exc).__name__}",
        )
    return GpuResearchBackendReport(
        backend="rapids-cudf",
        available=True,
        module="cudf",
        version=_module_version(cudf),
        cuda_runtime=metadata.get("cuda_runtime"),
        device_name=metadata.get("device_name"),
        compute_capability=metadata.get("compute_capability"),
    )


def _cudf_runtime_smoke_test(cudf: Any) -> None:
    series_type = cast(Any, getattr(cudf, "Series", None))
    if not callable(series_type):
        raise RuntimeError("cudf_series_unavailable")
    series = cast(Any, series_type([1, 2, 3]))
    sum_method = getattr(series, "sum", None)
    if not callable(sum_method):
        raise RuntimeError("cudf_series_sum_unavailable")
    total = cast(Any, sum_method())
    if int(total) != 6:
        raise RuntimeError("unexpected_cudf_runtime_probe_result")


def _cupy_device_metadata() -> dict[str, str | None]:
    _preload_windows_cupy_cuda_libraries()
    cupy = importlib.import_module("cupy")
    runtime = cupy.cuda.runtime
    device_count = int(runtime.getDeviceCount())
    if device_count < 1:
        raise RuntimeError("cuda_device_unavailable")
    props = runtime.getDeviceProperties(0)
    device_name = _decode_device_name(props.get("name"))
    return {
        "cuda_runtime": str(runtime.runtimeGetVersion()),
        "device_name": device_name,
        "compute_capability": _format_compute_capability(
            props.get("major"),
            props.get("minor"),
        ),
    }


def _format_compute_capability(major: Any, minor: Any) -> str | None:
    if major is None or minor is None:
        return None
    return f"{major}.{minor}"


def _probe_cupy() -> GpuResearchBackendReport:
    _preload_windows_cupy_cuda_libraries()
    try:
        cupy = importlib.import_module("cupy")
    except ModuleNotFoundError:
        return GpuResearchBackendReport(
            backend="cupy",
            available=False,
            module="cupy",
            reason="module_not_installed",
        )
    try:
        runtime = cupy.cuda.runtime
        device_count = int(runtime.getDeviceCount())
        if device_count < 1:
            return GpuResearchBackendReport(
                backend="cupy",
                available=False,
                module="cupy",
                version=_module_version(cupy),
                reason="cuda_device_unavailable",
            )
        props = runtime.getDeviceProperties(0)
        device_name = _decode_device_name(props.get("name"))
        major = props.get("major")
        minor = props.get("minor")
        cuda_runtime = str(runtime.runtimeGetVersion())
    except Exception as exc:
        return GpuResearchBackendReport(
            backend="cupy",
            available=False,
            module="cupy",
            version=_module_version(cupy),
            reason=f"probe_failed:{type(exc).__name__}",
        )
    try:
        _cupy_runtime_smoke_test(cupy)
    except Exception as exc:
        return GpuResearchBackendReport(
            backend="cupy",
            available=False,
            module="cupy",
            version=_module_version(cupy),
            cuda_runtime=cuda_runtime,
            device_name=device_name,
            compute_capability=_format_compute_capability(major, minor),
            reason=f"cuda_runtime_operation_failed:{type(exc).__name__}",
        )
    return GpuResearchBackendReport(
        backend="cupy",
        available=True,
        module="cupy",
        version=_module_version(cupy),
        cuda_runtime=cuda_runtime,
        device_name=device_name,
        compute_capability=_format_compute_capability(major, minor),
    )


def _preload_windows_cupy_cuda_libraries() -> None:
    if os.name != "nt":
        return
    try:
        pathfinder = importlib.import_module("cuda.pathfinder")
    except ModuleNotFoundError:
        return
    load_dynamic_lib = getattr(pathfinder, "load_nvidia_dynamic_lib", None)
    if not callable(load_dynamic_lib):
        return
    try:
        load_dynamic_lib("nvrtc")
    except Exception:
        return


def _cupy_runtime_smoke_test(cupy: Any) -> None:
    values = cupy.asarray([1.0, 2.0, 4.0], dtype=getattr(cupy, "float64", None))
    deltas = cupy.diff(values)
    asnumpy = getattr(cupy, "asnumpy", None)
    host_deltas = asnumpy(deltas) if callable(asnumpy) else deltas
    if _host_sequence_length(host_deltas) != 2:
        raise RuntimeError("unexpected_cupy_runtime_probe_result")
    stream = getattr(getattr(getattr(cupy, "cuda", None), "Stream", None), "null", None)
    synchronize = getattr(stream, "synchronize", None)
    if callable(synchronize):
        synchronize()


def _host_sequence_length(value: Any) -> int:
    size = getattr(value, "size", None)
    if size is not None:
        return int(size)
    return len(cast(Sequence[Any], value))


def _probe_numba_cuda() -> GpuResearchBackendReport:
    _quiet_numba_cuda_driver_logs()
    try:
        numba = importlib.import_module("numba")
        cuda = importlib.import_module("numba.cuda")
    except ModuleNotFoundError:
        return GpuResearchBackendReport(
            backend="numba-cuda",
            available=False,
            module="numba.cuda",
            reason="module_not_installed",
        )
    try:
        if not bool(cuda.is_available()):
            return GpuResearchBackendReport(
                backend="numba-cuda",
                available=False,
                module="numba.cuda",
                version=_module_version(numba),
                reason="cuda_device_unavailable",
            )
        device = cuda.get_current_device()
        compute_capability = getattr(device, "compute_capability", None)
        return GpuResearchBackendReport(
            backend="numba-cuda",
            available=True,
            module="numba.cuda",
            version=_module_version(numba),
            device_name=str(getattr(device, "name", "") or ""),
            compute_capability=(
                ".".join(str(item) for item in compute_capability)
                if compute_capability is not None
                else None
            ),
        )
    except Exception as exc:
        return GpuResearchBackendReport(
            backend="numba-cuda",
            available=False,
            module="numba.cuda",
            version=_module_version(numba),
            reason=f"probe_failed:{type(exc).__name__}",
        )


def _probe_torch_cuda() -> GpuResearchBackendReport:
    try:
        torch = importlib.import_module("torch")
    except ModuleNotFoundError:
        return GpuResearchBackendReport(
            backend="torch-cuda",
            available=False,
            module="torch",
            reason="module_not_installed",
        )
    cuda = getattr(torch, "cuda", None)
    is_available = getattr(cuda, "is_available", None)
    if not callable(is_available) or not bool(is_available()):
        return GpuResearchBackendReport(
            backend="torch-cuda",
            available=False,
            module="torch",
            version=_module_version(torch),
            cuda_runtime=str(getattr(getattr(torch, "version", None), "cuda", "") or ""),
            reason="cuda_device_unavailable",
        )
    get_device_name = getattr(cuda, "get_device_name", None)
    get_device_capability = getattr(cuda, "get_device_capability", None)
    capability = get_device_capability(0) if callable(get_device_capability) else None
    if isinstance(capability, tuple):
        capability_items = cast(tuple[object, ...], capability)
        compute_capability = ".".join(str(item) for item in capability_items)
    else:
        compute_capability = str(capability) if capability is not None else None
    return GpuResearchBackendReport(
        backend="torch-cuda",
        available=True,
        module="torch",
        version=_module_version(torch),
        cuda_runtime=str(getattr(getattr(torch, "version", None), "cuda", "") or ""),
        device_name=str(get_device_name(0) if callable(get_device_name) else ""),
        compute_capability=compute_capability,
    )


def _module_version(module: Any) -> str:
    return str(getattr(module, "__version__", "") or "")


def _decode_device_name(value: Any) -> str | None:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if value is None:
        return None
    return str(value)


def _quiet_numba_cuda_driver_logs() -> None:
    for logger_name in ("numba.cuda.cudadrv", "numba.cuda.cudadrv.driver"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)


__all__ = [
    "GPU_RESEARCH_BACKENDS",
    "GPU_RESEARCH_ARTIFACT_SCHEMA_VERSION",
    "GPU_RESEARCH_BACKEND_REPORT_SCHEMA_VERSION",
    "GpuResearchBackendReport",
    "gpu_research_artifact_context",
    "probe_gpu_research_backend",
]
