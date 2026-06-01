"""Advisory sleeve simulation previews over manifest-verified replay tapes."""

from __future__ import annotations

import statistics
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import timezone
from typing import Any, cast

import numpy as np

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.gpu_backends import (
    GpuResearchBackendReport,
    gpu_research_artifact_context,
)
from app.trading.discovery.numba_replay_kernels import simulate_sleeve_paths
from app.trading.discovery.replay_tape import (
    ReplayTapeManifest,
    build_source_query_digest,
)
from app.trading.discovery.tape_feature_extractors import extract_price
from app.trading.models import SignalEnvelope

SLEEVE_SIMULATION_PREVIEW_PANEL_SCHEMA_VERSION = "torghut.sleeve-simulation-preview-panel.v1"
SLEEVE_SIMULATION_PREVIEW_ROW_SCHEMA_VERSION = "torghut.sleeve-simulation-preview-row.v1"

_PREVIEW_BLOCKERS = (
    "sleeve_simulation_preview_only",
    "exact_replay_required",
    "runtime_ledger_proof_required",
    "live_paper_parity_required",
)


@dataclass(frozen=True)
class SleeveSimulationPreviewRow:
    candidate_spec_id: str
    family_template_id: str
    runtime_strategy_name: str
    rank: int
    selected: bool
    selection_reason: str
    symbols: tuple[str, ...]
    path_count: int
    step_count: int
    stop_loss_bps: float
    take_profit_bps: float
    trailing_drawdown_bps: float
    mean_final_pnl_bps: float
    median_final_pnl_bps: float
    p10_final_pnl_bps: float
    worst_final_pnl_bps: float
    mean_max_drawdown_bps: float
    stop_hit_ratio: float
    take_profit_hit_ratio: float
    advisory_score: float
    preview_score: float | None
    simulation: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": SLEEVE_SIMULATION_PREVIEW_ROW_SCHEMA_VERSION,
            "candidate_spec_id": self.candidate_spec_id,
            "family_template_id": self.family_template_id,
            "runtime_strategy_name": self.runtime_strategy_name,
            "rank": self.rank,
            "selected": self.selected,
            "selection_reason": self.selection_reason,
            "symbols": list(self.symbols),
            "path_count": self.path_count,
            "step_count": self.step_count,
            "stop_loss_bps": _format_bps(self.stop_loss_bps),
            "take_profit_bps": _format_bps(self.take_profit_bps),
            "trailing_drawdown_bps": _format_bps(self.trailing_drawdown_bps),
            "mean_final_pnl_bps": _format_bps(self.mean_final_pnl_bps),
            "median_final_pnl_bps": _format_bps(self.median_final_pnl_bps),
            "p10_final_pnl_bps": _format_bps(self.p10_final_pnl_bps),
            "worst_final_pnl_bps": _format_bps(self.worst_final_pnl_bps),
            "mean_max_drawdown_bps": _format_bps(self.mean_max_drawdown_bps),
            "stop_hit_ratio": _format_ratio(self.stop_hit_ratio),
            "take_profit_hit_ratio": _format_ratio(self.take_profit_hit_ratio),
            "advisory_score": _format_bps(self.advisory_score),
            "preview_score": (
                _format_bps(self.preview_score) if self.preview_score is not None else None
            ),
            "simulation": dict(self.simulation),
        }


@dataclass(frozen=True)
class SleeveSimulationPreviewPanel:
    rows: tuple[SleeveSimulationPreviewRow, ...]
    replay_tape_manifest: ReplayTapeManifest
    requested_backend: str
    selected_candidate_spec_ids: tuple[str, ...]
    input_candidate_count: int
    requested_top_k: int
    min_returns_per_path: int
    config_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": SLEEVE_SIMULATION_PREVIEW_PANEL_SCHEMA_VERSION,
            "status": "preview_only",
            "promotion_proof": False,
            "blockers": list(_PREVIEW_BLOCKERS),
            "requested_backend": self.requested_backend,
            "requested_top_k": self.requested_top_k,
            "input_candidate_count": self.input_candidate_count,
            "selected_candidate_spec_ids": list(self.selected_candidate_spec_ids),
            "selected_candidate_spec_count": len(self.selected_candidate_spec_ids),
            "min_returns_per_path": self.min_returns_per_path,
            "config_hash": self.config_hash,
            "replay_tape": {
                "dataset_snapshot_ref": self.replay_tape_manifest.dataset_snapshot_ref,
                "content_sha256": self.replay_tape_manifest.content_sha256,
                "source_query_digest": self.replay_tape_manifest.source_query_digest,
                "row_count": self.replay_tape_manifest.row_count,
                "trading_day_count": self.replay_tape_manifest.trading_day_count,
                "start_date": self.replay_tape_manifest.start_date.isoformat(),
                "end_date": self.replay_tape_manifest.end_date.isoformat(),
                "row_symbols": list(self.replay_tape_manifest.row_symbols),
            },
            "rows": [row.to_payload() for row in self.rows],
        }


def build_sleeve_simulation_preview(
    *,
    specs: Sequence[CandidateSpec],
    rows: Sequence[SignalEnvelope],
    replay_tape_manifest: ReplayTapeManifest,
    preview_scores: Mapping[str, float] | None = None,
    top_k: int = 24,
    backend_preference: str = "auto",
    min_returns_per_path: int = 2,
) -> SleeveSimulationPreviewPanel:
    bounded_min_returns = max(1, int(min_returns_per_path))
    bounded_top_k = max(1, min(len(specs) or 1, int(top_k)))
    normalized_backend = backend_preference.strip().lower() or "auto"
    score_by_spec = {key: float(value) for key, value in (preview_scores or {}).items()}
    config_hash = build_source_query_digest(
        {
            "workload": "sleeve_simulation_preview",
            "candidate_spec_ids": [spec.candidate_spec_id for spec in specs],
            "replay_tape_digest": replay_tape_manifest.content_sha256,
            "backend_preference": normalized_backend,
            "top_k": bounded_top_k,
            "min_returns_per_path": bounded_min_returns,
        }
    )
    grouped_returns = _returns_by_symbol_day(rows)
    initial_rows = tuple(
        _build_row(
            spec=spec,
            grouped_returns=grouped_returns,
            manifest=replay_tape_manifest,
            preview_score=score_by_spec.get(spec.candidate_spec_id),
            backend_preference=normalized_backend,
            min_returns_per_path=bounded_min_returns,
            config_hash=config_hash,
        )
        for spec in specs
    )
    ranked_rows = _rank_rows(initial_rows, top_k=bounded_top_k)
    return SleeveSimulationPreviewPanel(
        rows=ranked_rows,
        replay_tape_manifest=replay_tape_manifest,
        requested_backend=normalized_backend,
        selected_candidate_spec_ids=tuple(
            row.candidate_spec_id for row in ranked_rows if row.selected
        ),
        input_candidate_count=len(specs),
        requested_top_k=bounded_top_k,
        min_returns_per_path=bounded_min_returns,
        config_hash=config_hash,
    )


def _build_row(
    *,
    spec: CandidateSpec,
    grouped_returns: Mapping[tuple[str, str], tuple[float, ...]],
    manifest: ReplayTapeManifest,
    preview_score: float | None,
    backend_preference: str,
    min_returns_per_path: int,
    config_hash: str,
) -> SleeveSimulationPreviewRow:
    symbols = _candidate_symbols(spec)
    params = _params(spec)
    stop_loss_bps = _param_float(
        params,
        ("long_stop_loss_bps", "short_stop_loss_bps", "stop_loss_bps", "max_session_negative_exit_bps"),
    )
    take_profit_bps = _param_float(
        params,
        ("take_profit_bps", "long_take_profit_bps", "short_take_profit_bps"),
    )
    trailing_drawdown_bps = _param_float(
        params,
        ("long_trailing_stop_drawdown_bps", "short_trailing_stop_drawdown_bps", "trailing_drawdown_bps"),
    )
    matrix = _candidate_return_matrix(
        spec=spec,
        symbols=symbols,
        grouped_returns=grouped_returns,
        min_returns_per_path=min_returns_per_path,
    )
    if not matrix:
        simulation = _missing_simulation_payload(
            requested_backend=backend_preference,
            manifest=manifest,
            config_hash=config_hash,
        )
        return SleeveSimulationPreviewRow(
            candidate_spec_id=spec.candidate_spec_id,
            family_template_id=spec.family_template_id,
            runtime_strategy_name=spec.runtime_strategy_name,
            rank=0,
            selected=False,
            selection_reason="insufficient_replay_tape_returns",
            symbols=symbols,
            path_count=0,
            step_count=0,
            stop_loss_bps=stop_loss_bps,
            take_profit_bps=take_profit_bps,
            trailing_drawdown_bps=trailing_drawdown_bps,
            mean_final_pnl_bps=0.0,
            median_final_pnl_bps=0.0,
            p10_final_pnl_bps=0.0,
            worst_final_pnl_bps=0.0,
            mean_max_drawdown_bps=0.0,
            stop_hit_ratio=0.0,
            take_profit_hit_ratio=0.0,
            advisory_score=float("-inf"),
            preview_score=preview_score,
            simulation=simulation,
        )
    result = simulate_sleeve_paths(
        matrix,
        stop_loss_bps=stop_loss_bps,
        take_profit_bps=take_profit_bps,
        trailing_drawdown_bps=trailing_drawdown_bps,
        backend_preference=backend_preference,
        source_query_digest=manifest.source_query_digest,
        replay_tape_digest=manifest.content_sha256,
        config_hash=config_hash,
    )
    final_pnl = tuple(float(item) for item in result.final_pnl_bps)
    max_drawdown = tuple(float(item) for item in result.max_drawdown_bps)
    stop_ratio = _true_ratio(result.hit_stop)
    take_ratio = _true_ratio(result.hit_take_profit)
    mean_final = statistics.fmean(final_pnl)
    mean_drawdown = statistics.fmean(max_drawdown)
    p10_final = _percentile(final_pnl, 10.0)
    advisory_score = mean_final + 0.25 * _safe_float(preview_score) + p10_final - mean_drawdown
    return SleeveSimulationPreviewRow(
        candidate_spec_id=spec.candidate_spec_id,
        family_template_id=spec.family_template_id,
        runtime_strategy_name=spec.runtime_strategy_name,
        rank=0,
        selected=False,
        selection_reason="sleeve_simulation_preview_not_selected",
        symbols=symbols,
        path_count=len(matrix),
        step_count=len(matrix[0]),
        stop_loss_bps=stop_loss_bps,
        take_profit_bps=take_profit_bps,
        trailing_drawdown_bps=trailing_drawdown_bps,
        mean_final_pnl_bps=mean_final,
        median_final_pnl_bps=float(statistics.median(final_pnl)),
        p10_final_pnl_bps=p10_final,
        worst_final_pnl_bps=min(final_pnl),
        mean_max_drawdown_bps=mean_drawdown,
        stop_hit_ratio=stop_ratio,
        take_profit_hit_ratio=take_ratio,
        advisory_score=advisory_score,
        preview_score=preview_score,
        simulation=result.to_payload(),
    )


def _rank_rows(
    rows: Sequence[SleeveSimulationPreviewRow], *, top_k: int
) -> tuple[SleeveSimulationPreviewRow, ...]:
    ranked = sorted(
        rows,
        key=lambda row: (
            row.selection_reason == "insufficient_replay_tape_returns",
            -row.advisory_score,
            -_safe_float(row.preview_score),
            row.candidate_spec_id,
        ),
    )
    selected_ids = {
        row.candidate_spec_id
        for row in ranked[:top_k]
        if row.selection_reason != "insufficient_replay_tape_returns"
    }
    return tuple(
        replace(
            row,
            rank=index,
            selected=row.candidate_spec_id in selected_ids,
            selection_reason=(
                "sleeve_simulation_preview_selected"
                if row.candidate_spec_id in selected_ids
                else row.selection_reason
            ),
        )
        for index, row in enumerate(ranked, start=1)
    )


def _returns_by_symbol_day(
    rows: Sequence[SignalEnvelope],
) -> dict[tuple[str, str], tuple[float, ...]]:
    price_points: dict[tuple[str, str], list[tuple[Any, float]]] = defaultdict(list)
    for row in rows:
        price = extract_price(row)
        if price is None or price <= 0.0:
            continue
        ts = row.event_ts.astimezone(timezone.utc)
        price_points[(row.symbol.upper(), ts.date().isoformat())].append((ts, price))
    returns: dict[tuple[str, str], tuple[float, ...]] = {}
    for key, points in price_points.items():
        ordered = [price for _, price in sorted(points, key=lambda item: item[0])]
        path: list[float] = []
        for previous, current in zip(ordered, ordered[1:]):
            if previous <= 0.0:
                continue
            path.append((current - previous) / previous * 10_000.0)
        returns[key] = tuple(path)
    return returns


def _candidate_return_matrix(
    *,
    spec: CandidateSpec,
    symbols: Sequence[str],
    grouped_returns: Mapping[tuple[str, str], tuple[float, ...]],
    min_returns_per_path: int,
) -> tuple[tuple[float, ...], ...]:
    multiplier = -1.0 if _is_short_or_negative(spec) else 1.0
    paths = [
        tuple(multiplier * item for item in path)
        for (symbol, _day), path in grouped_returns.items()
        if symbol in symbols and len(path) >= min_returns_per_path
    ]
    if not paths:
        return ()
    step_count = min(len(path) for path in paths)
    if step_count < min_returns_per_path:
        return ()
    return tuple(tuple(path[:step_count]) for path in paths)


def _candidate_symbols(spec: CandidateSpec) -> tuple[str, ...]:
    raw_symbols = spec.strategy_overrides.get("universe_symbols") or ()
    symbols = tuple(
        str(item).strip().upper()
        for item in raw_symbols
        if str(item).strip()
    )
    return tuple(dict.fromkeys(symbols))


def _params(spec: CandidateSpec) -> Mapping[str, Any]:
    value = spec.strategy_overrides.get("params")
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _param_float(params: Mapping[str, Any], keys: Sequence[str]) -> float:
    for key in keys:
        value = params.get(key)
        if value is None:
            continue
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if np.isfinite(parsed) and parsed >= 0.0:
            return parsed
    return 0.0


def _is_short_or_negative(spec: CandidateSpec) -> bool:
    expected_direction = str(spec.feature_contract.get("expected_direction") or "").lower()
    if expected_direction in {"negative", "short"}:
        return True
    return "short" in spec.family_template_id.lower() or "short" in spec.runtime_strategy_name.lower()


def _missing_simulation_payload(
    *,
    requested_backend: str,
    manifest: ReplayTapeManifest,
    config_hash: str,
) -> dict[str, Any]:
    report = GpuResearchBackendReport(
        backend="none",
        available=False,
        module="",
        reason="insufficient_replay_tape_returns",
    )
    return {
        "schema_version": "torghut.numba-replay-simulation.v1",
        "promotion_proof": False,
        "final_pnl_bps": [],
        "max_drawdown_bps": [],
        "hit_stop": [],
        "hit_take_profit": [],
        "exit_step": [],
        "backend_context": gpu_research_artifact_context(
            requested_backend=requested_backend,
            selected_backend="none",
            workload="sleeve_path_simulation",
            backend_report=report.to_payload(),
            source_query_digest=manifest.source_query_digest,
            replay_tape_digest=manifest.content_sha256,
            config_hash=config_hash,
        ),
    }


def _true_ratio(values: Sequence[bool]) -> float:
    if not values:
        return 0.0
    return sum(1 for item in values if item) / len(values)


def _percentile(values: Sequence[float], percentile: float) -> float:
    return float(np.percentile(np.asarray(values, dtype=np.float64), percentile))


def _safe_float(value: float | None) -> float:
    if value is None:
        return 0.0
    if not np.isfinite(value):
        return 0.0
    return float(value)


def _format_bps(value: float) -> str:
    if value == float("-inf"):
        return "-inf"
    return f"{float(value):.8f}"


def _format_ratio(value: float) -> str:
    return f"{float(value):.6f}"


__all__ = [
    "SLEEVE_SIMULATION_PREVIEW_PANEL_SCHEMA_VERSION",
    "SLEEVE_SIMULATION_PREVIEW_ROW_SCHEMA_VERSION",
    "SleeveSimulationPreviewPanel",
    "SleeveSimulationPreviewRow",
    "build_sleeve_simulation_preview",
]
