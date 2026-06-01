"""RAPIDS/cuDF and pandas tape feature panels for research narrowing."""

from __future__ import annotations

# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false

import importlib
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timezone
from decimal import Decimal
from typing import Any, Mapping

import numpy as np
import pandas as pd

from app.trading.discovery.gpu_backends import (
    GpuResearchBackendReport,
    gpu_research_artifact_context,
    probe_gpu_research_backend,
)
from app.trading.discovery.replay_tape import (
    ReplayTapeManifest,
    build_source_query_digest,
)
from app.trading.discovery.tape_feature_extractors import (
    extract_microprice_bias_bps,
    extract_ofi_pressure,
    extract_price,
    extract_spread_bps,
    extract_volume,
)
from app.trading.models import SignalEnvelope

RAPIDS_TAPE_FEATURE_PANEL_SCHEMA_VERSION = "torghut.rapids-tape-feature-panel.v1"
RAPIDS_TAPE_FEATURE_ROW_SCHEMA_VERSION = "torghut.rapids-tape-feature-row.v1"

RAPIDS_TAPE_FEATURE_NAMES = (
    "return_bps_mean",
    "return_bps_std",
    "spread_bps_p50",
    "spread_bps_p95",
    "ofi_mean",
    "microprice_bias_bps_mean",
    "volume_p50",
)


@dataclass(frozen=True)
class RapidsTapeFeatureRow:
    symbol: str
    trading_day: date
    row_count: int
    return_bps_mean: float
    return_bps_std: float
    spread_bps_p50: float
    spread_bps_p95: float
    ofi_mean: float
    microprice_bias_bps_mean: float
    volume_p50: float

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": RAPIDS_TAPE_FEATURE_ROW_SCHEMA_VERSION,
            "symbol": self.symbol,
            "trading_day": self.trading_day.isoformat(),
            "row_count": self.row_count,
            "return_bps_mean": _decimal_string(self.return_bps_mean),
            "return_bps_std": _decimal_string(self.return_bps_std),
            "spread_bps_p50": _decimal_string(self.spread_bps_p50),
            "spread_bps_p95": _decimal_string(self.spread_bps_p95),
            "ofi_mean": _decimal_string(self.ofi_mean),
            "microprice_bias_bps_mean": _decimal_string(
                self.microprice_bias_bps_mean
            ),
            "volume_p50": _decimal_string(self.volume_p50),
        }


@dataclass(frozen=True)
class RapidsTapeFeaturePanel:
    dataset_snapshot_ref: str
    source_query_digest: str
    replay_tape_digest: str
    row_count: int
    trading_day_count: int
    rows: tuple[RapidsTapeFeatureRow, ...]
    research_backend: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": RAPIDS_TAPE_FEATURE_PANEL_SCHEMA_VERSION,
            "status": "preview_only",
            "promotion_proof": False,
            "dataset_snapshot_ref": self.dataset_snapshot_ref,
            "source_query_digest": self.source_query_digest,
            "replay_tape_digest": self.replay_tape_digest,
            "row_count": self.row_count,
            "trading_day_count": self.trading_day_count,
            "feature_names": list(RAPIDS_TAPE_FEATURE_NAMES),
            "research_backend": dict(self.research_backend),
            "rows": [row.to_payload() for row in self.rows],
        }


def build_rapids_tape_feature_panel(
    *,
    rows: Sequence[SignalEnvelope],
    replay_tape_manifest: ReplayTapeManifest,
    backend_preference: str = "pandas",
) -> RapidsTapeFeaturePanel:
    """Build symbol/day dataframe features over a manifest-verified tape.

    The returned panel is a research artifact only. It is useful for candidate
    narrowing and sleeve discovery, but it does not clear promotion gates.
    """

    preference = backend_preference.strip().lower()
    input_frame = _rows_to_pandas_frame(rows)
    if preference in {"", "pandas"}:
        feature_rows = _compute_feature_rows(input_frame)
        report = _pandas_backend_report(reason="explicit_cpu_reference_backend")
        return _build_panel(
            feature_rows,
            rows=rows,
            replay_tape_manifest=replay_tape_manifest,
            requested_backend=preference or "pandas",
            selected_backend="pandas",
            backend_report=report,
        )
    if preference == "auto":
        report = probe_gpu_research_backend("rapids-cudf")
        if report.available:
            try:
                feature_rows = _compute_rapids_feature_rows(input_frame)
                return _build_panel(
                    feature_rows,
                    rows=rows,
                    replay_tape_manifest=replay_tape_manifest,
                    requested_backend="auto",
                    selected_backend="rapids-cudf",
                    backend_report=report,
                )
            except Exception as exc:
                fallback_reason = (
                    "auto_fallback:rapids_cudf_execution_failed:"
                    f"{type(exc).__name__}"
                )
        else:
            fallback_reason = f"auto_fallback:{report.reason or 'rapids_cudf_unavailable'}"
        feature_rows = _compute_feature_rows(input_frame)
        return _build_panel(
            feature_rows,
            rows=rows,
            replay_tape_manifest=replay_tape_manifest,
            requested_backend="auto",
            selected_backend="pandas-fallback",
            backend_report=_pandas_backend_report(reason=fallback_reason),
        )
    if preference == "rapids-cudf":
        report = probe_gpu_research_backend("rapids-cudf")
        if not report.available:
            raise ValueError(f"rapids_cudf_unavailable:{report.reason or 'unknown'}")
        try:
            feature_rows = _compute_rapids_feature_rows(input_frame)
        except Exception as exc:
            raise ValueError(f"rapids_cudf_execution_failed:{type(exc).__name__}") from exc
        return _build_panel(
            feature_rows,
            rows=rows,
            replay_tape_manifest=replay_tape_manifest,
            requested_backend="rapids-cudf",
            selected_backend="rapids-cudf",
            backend_report=report,
        )
    raise ValueError(f"unsupported_rapids_tape_feature_backend:{backend_preference}")


def _rows_to_pandas_frame(rows: Sequence[SignalEnvelope]) -> pd.DataFrame:
    records: list[dict[str, Any]] = []
    for row in rows:
        event_ts = row.event_ts.astimezone(timezone.utc)
        records.append(
            {
                "symbol": row.symbol.upper(),
                "trading_day": event_ts.date().isoformat(),
                "event_ts_ns": int(event_ts.timestamp() * 1_000_000_000),
                "row_count_marker": 1,
                "price": extract_price(row),
                "spread_bps": extract_spread_bps(row),
                "ofi": extract_ofi_pressure(row),
                "microprice_bias_bps": extract_microprice_bias_bps(row),
                "volume": extract_volume(row),
            }
        )
    return pd.DataFrame.from_records(
        records,
        columns=[
            "symbol",
            "trading_day",
            "event_ts_ns",
            "row_count_marker",
            "price",
            "spread_bps",
            "ofi",
            "microprice_bias_bps",
            "volume",
        ],
    )


def _compute_rapids_feature_rows(input_frame: pd.DataFrame) -> tuple[RapidsTapeFeatureRow, ...]:
    cudf = importlib.import_module("cudf")
    from_pandas = getattr(cudf, "from_pandas", None)
    if not callable(from_pandas):
        raise ValueError("rapids_cudf_from_pandas_unavailable")
    gpu_frame = from_pandas(input_frame)
    return _compute_feature_rows(gpu_frame)


def _compute_feature_rows(frame: Any) -> tuple[RapidsTapeFeatureRow, ...]:
    if bool(getattr(frame, "empty", True)):
        return ()
    working = frame.sort_values(["symbol", "trading_day", "event_ts_ns"])
    group_keys = ["symbol", "trading_day"]
    grouped = working.groupby(group_keys)
    working["prior_price"] = grouped["price"].shift(1)
    working["return_bps"] = (
        (working["price"] - working["prior_price"]) / working["prior_price"] * 10_000.0
    )
    grouped = working.groupby(group_keys)
    feature_frame = pd.concat(
        [
            _series_to_pandas(grouped["row_count_marker"].sum()).rename("row_count"),
            _series_to_pandas(grouped["return_bps"].mean()).rename("return_bps_mean"),
            _series_to_pandas(grouped["return_bps"].std(ddof=0)).rename("return_bps_std"),
            _series_to_pandas(grouped["spread_bps"].quantile(0.5)).rename(
                "spread_bps_p50"
            ),
            _series_to_pandas(grouped["spread_bps"].quantile(0.95)).rename(
                "spread_bps_p95"
            ),
            _series_to_pandas(grouped["ofi"].mean()).rename("ofi_mean"),
            _series_to_pandas(grouped["microprice_bias_bps"].mean()).rename(
                "microprice_bias_bps_mean"
            ),
            _series_to_pandas(grouped["volume"].quantile(0.5)).rename("volume_p50"),
        ],
        axis=1,
    ).reset_index()
    feature_frame = feature_frame.fillna(0).sort_values(["symbol", "trading_day"])

    result: list[RapidsTapeFeatureRow] = []
    for _, row in feature_frame.iterrows():
        result.append(
            RapidsTapeFeatureRow(
                symbol=str(row["symbol"]).upper(),
                trading_day=date.fromisoformat(str(row["trading_day"])),
                row_count=int(row["row_count"]),
                return_bps_mean=_finite_float(row["return_bps_mean"]),
                return_bps_std=_finite_float(row["return_bps_std"]),
                spread_bps_p50=_finite_float(row["spread_bps_p50"]),
                spread_bps_p95=_finite_float(row["spread_bps_p95"]),
                ofi_mean=_finite_float(row["ofi_mean"]),
                microprice_bias_bps_mean=_finite_float(
                    row["microprice_bias_bps_mean"]
                ),
                volume_p50=_finite_float(row["volume_p50"]),
            )
        )
    return tuple(result)


def _series_to_pandas(value: Any) -> Any:
    to_pandas = getattr(value, "to_pandas", None)
    if callable(to_pandas):
        return to_pandas()
    return value


def _build_panel(
    feature_rows: tuple[RapidsTapeFeatureRow, ...],
    *,
    rows: Sequence[SignalEnvelope],
    replay_tape_manifest: ReplayTapeManifest,
    requested_backend: str,
    selected_backend: str,
    backend_report: GpuResearchBackendReport,
) -> RapidsTapeFeaturePanel:
    config_hash = build_source_query_digest(
        {
            "workload": "rapids_tape_feature_panel",
            "requested_backend": requested_backend,
            "selected_backend": selected_backend,
            "feature_names": list(RAPIDS_TAPE_FEATURE_NAMES),
            "input_row_count": len(rows),
            "replay_tape_digest": replay_tape_manifest.content_sha256,
        }
    )
    research_backend = gpu_research_artifact_context(
        requested_backend=requested_backend,
        selected_backend=selected_backend,
        workload="rapids_tape_feature_panel",
        backend_report=backend_report.to_payload(),
        source_query_digest=replay_tape_manifest.source_query_digest,
        replay_tape_digest=replay_tape_manifest.content_sha256,
        config_hash=config_hash,
    )
    observed_days = {
        row.event_ts.astimezone(timezone.utc).date()
        for row in rows
    }
    return RapidsTapeFeaturePanel(
        dataset_snapshot_ref=replay_tape_manifest.dataset_snapshot_ref,
        source_query_digest=replay_tape_manifest.source_query_digest,
        replay_tape_digest=replay_tape_manifest.content_sha256,
        row_count=len(rows),
        trading_day_count=len(observed_days),
        rows=feature_rows,
        research_backend=research_backend,
    )


def _pandas_backend_report(*, reason: str) -> GpuResearchBackendReport:
    return GpuResearchBackendReport(
        backend="pandas",
        available=True,
        module="pandas",
        version=pd.__version__,
        reason=reason,
    )


def _finite_float(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(result):
        return 0.0
    return result


def _decimal_string(value: float) -> str:
    if not np.isfinite(value):
        return "0"
    quantized = Decimal(str(float(value))).quantize(Decimal("0.0000000001"))
    text = format(quantized, "f").rstrip("0").rstrip(".")
    return text or "0"


__all__ = [
    "RAPIDS_TAPE_FEATURE_NAMES",
    "RAPIDS_TAPE_FEATURE_PANEL_SCHEMA_VERSION",
    "RAPIDS_TAPE_FEATURE_ROW_SCHEMA_VERSION",
    "RapidsTapeFeaturePanel",
    "RapidsTapeFeatureRow",
    "build_rapids_tape_feature_panel",
]
