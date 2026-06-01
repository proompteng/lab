"""Preview-only vectorized scoring over manifest-verified replay tapes."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import timezone
from decimal import Decimal
from typing import Any, cast

import numpy as np

from app.trading.discovery.candidate_specs import CandidateSpec
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

FAST_REPLAY_PREVIEW_SCHEMA_VERSION = "torghut.fast-replay-preview.v1"
FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION = "torghut.fast-replay-preview-row.v2"


@dataclass(frozen=True)
class FastReplayPreviewRow:
    candidate_spec_id: str
    rank: int
    preview_score: Decimal
    selected: bool
    selection_reason: str
    matched_row_count: int
    matched_symbol_count: int
    requested_symbol_count: int
    trading_day_count: int
    signed_return_bps: Decimal
    avg_abs_return_bps: Decimal
    median_spread_bps: Decimal
    activity_score: Decimal
    coverage_score: Decimal
    ofi_pressure_score: Decimal
    microprice_bias_bps: Decimal
    spread_tail_bps: Decimal
    return_tail_abs_bps: Decimal
    impact_liquidity_penalty_bps: Decimal

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION,
            "candidate_spec_id": self.candidate_spec_id,
            "rank": self.rank,
            "preview_score": str(self.preview_score),
            "selected": self.selected,
            "selection_reason": self.selection_reason,
            "matched_row_count": self.matched_row_count,
            "matched_symbol_count": self.matched_symbol_count,
            "requested_symbol_count": self.requested_symbol_count,
            "trading_day_count": self.trading_day_count,
            "signed_return_bps": str(self.signed_return_bps),
            "avg_abs_return_bps": str(self.avg_abs_return_bps),
            "median_spread_bps": str(self.median_spread_bps),
            "activity_score": str(self.activity_score),
            "coverage_score": str(self.coverage_score),
            "ofi_pressure_score": str(self.ofi_pressure_score),
            "microprice_bias_bps": str(self.microprice_bias_bps),
            "spread_tail_bps": str(self.spread_tail_bps),
            "return_tail_abs_bps": str(self.return_tail_abs_bps),
            "impact_liquidity_penalty_bps": str(
                self.impact_liquidity_penalty_bps
            ),
        }


@dataclass(frozen=True)
class FastReplayPreviewResult:
    rows: tuple[FastReplayPreviewRow, ...]
    selected_candidate_spec_ids: tuple[str, ...]
    requested_top_k: int
    input_candidate_count: int
    replay_tape_manifest: ReplayTapeManifest
    selected_row_count: int
    research_backend: Mapping[str, Any]

    def to_manifest_payload(self) -> dict[str, Any]:
        return {
            "schema_version": FAST_REPLAY_PREVIEW_SCHEMA_VERSION,
            "status": "preview_only",
            "promotion_proof": False,
            "blockers": [
                "preview_only_not_promotion_proof",
                "exact_replay_required",
                "runtime_ledger_proof_required",
            ],
            "requested_top_k": self.requested_top_k,
            "input_candidate_count": self.input_candidate_count,
            "selected_candidate_spec_ids": list(self.selected_candidate_spec_ids),
            "selected_candidate_spec_count": len(self.selected_candidate_spec_ids),
            "selected_row_count": self.selected_row_count,
            "research_backend": dict(self.research_backend),
            "replay_tape": {
                "dataset_snapshot_ref": self.replay_tape_manifest.dataset_snapshot_ref,
                "content_sha256": self.replay_tape_manifest.content_sha256,
                "row_count": self.replay_tape_manifest.row_count,
                "trading_day_count": self.replay_tape_manifest.trading_day_count,
                "start_date": self.replay_tape_manifest.start_date.isoformat(),
                "end_date": self.replay_tape_manifest.end_date.isoformat(),
                "row_symbols": list(self.replay_tape_manifest.row_symbols),
            },
        }


@dataclass(frozen=True)
class _SymbolTapeStats:
    symbol: str
    row_count: int
    trading_day_count: int
    returns_bps: Any
    median_spread_bps: float
    spread_tail_bps: float
    ofi_pressure_score: float
    microprice_bias_bps: float
    median_volume: float
    return_tail_abs_bps: float


@dataclass(frozen=True)
class _ArrayBackend:
    name: str
    xp: Any
    to_host: Callable[[Any], Any]
    report: Mapping[str, Any]


def _resolve_array_backend(preference: str) -> _ArrayBackend:
    normalized = preference.strip().lower()
    if normalized in {"", "numpy", "numpy-fallback"}:
        return _numpy_array_backend(requested_backend=normalized or "numpy")
    if normalized not in {"auto", "cupy"}:
        raise ValueError(f"unsupported_fast_replay_array_backend:{preference}")

    cupy_probe = probe_gpu_research_backend("cupy")
    if cupy_probe.available:
        cupy = __import__("cupy")
        return _ArrayBackend(
            name="cupy",
            xp=cupy,
            to_host=cupy.asnumpy,
            report=cupy_probe.to_payload(),
        )
    if normalized == "cupy":
        raise ValueError(f"fast_replay_preview_cupy_unavailable:{cupy_probe.reason}")

    numpy_report = GpuResearchBackendReport(
        backend="numpy",
        available=True,
        module="numpy",
        version=np.__version__,
        reason=f"auto_fallback:{cupy_probe.reason or 'cupy_unavailable'}",
    )
    return _ArrayBackend(
        name="numpy-fallback",
        xp=np,
        to_host=lambda value: value,
        report=numpy_report.to_payload(),
    )


def _numpy_array_backend(*, requested_backend: str) -> _ArrayBackend:
    report = GpuResearchBackendReport(
        backend="numpy",
        available=True,
        module="numpy",
        version=np.__version__,
        reason=(
            "explicit_cpu_reference_backend"
            if requested_backend == "numpy"
            else "explicit_numpy_fallback_backend"
        ),
    )
    return _ArrayBackend(
        name="numpy-fallback",
        xp=np,
        to_host=lambda value: value,
        report=report.to_payload(),
    )


def _backend_array(array_backend: _ArrayBackend, values: Sequence[float]) -> Any:
    dtype = getattr(array_backend.xp, "float64", np.float64)
    return array_backend.xp.asarray(list(values), dtype=dtype)


def _array_size(value: Any) -> int:
    try:
        return int(getattr(value, "size", 0) or 0)
    except Exception:
        return 0


def _backend_scalar(value: Any, array_backend: _ArrayBackend) -> float:
    host_value = array_backend.to_host(value)
    item = host_value.item() if hasattr(host_value, "item") else host_value
    return float(item)


def build_fast_replay_preview(
    *,
    specs: Sequence[CandidateSpec],
    rows: Sequence[SignalEnvelope],
    replay_tape_manifest: ReplayTapeManifest,
    top_k: int,
    min_rows_per_candidate: int = 2,
    array_backend_preference: str = "numpy",
) -> FastReplayPreviewResult:
    """Rank candidate specs with cheap tape-derived features only.

    This intentionally produces a preview artifact, not replay evidence. Exact
    scheduler replay and runtime ledger proof remain required downstream.
    """

    bounded_top_k = max(1, min(len(specs) or 1, int(top_k)))
    array_backend = _resolve_array_backend(array_backend_preference)
    research_backend = gpu_research_artifact_context(
        requested_backend=array_backend_preference,
        selected_backend=array_backend.name,
        workload="fast_replay_preview",
        backend_report=array_backend.report,
        source_query_digest=replay_tape_manifest.source_query_digest,
        replay_tape_digest=replay_tape_manifest.content_sha256,
        config_hash=build_source_query_digest(
            {
                "workload": "fast_replay_preview",
                "array_backend_preference": array_backend_preference,
                "selected_backend": array_backend.name,
                "top_k": bounded_top_k,
                "min_rows_per_candidate": max(1, int(min_rows_per_candidate)),
                "input_candidate_count": len(specs),
                "row_count": len(rows),
                "replay_tape_digest": replay_tape_manifest.content_sha256,
            }
        ),
    )
    symbol_stats = _build_symbol_stats(rows, array_backend=array_backend)
    scored_rows: list[FastReplayPreviewRow] = []
    for spec in specs:
        scored_rows.append(
            _score_candidate_spec(
                spec=spec,
                symbol_stats=symbol_stats,
                array_backend=array_backend,
                min_rows_per_candidate=max(1, int(min_rows_per_candidate)),
            )
        )

    ranked_rows = sorted(
        scored_rows,
        key=lambda row: (
            row.selection_reason == "insufficient_replay_tape_rows",
            -float(row.preview_score),
            row.candidate_spec_id,
        ),
    )
    selected_ids = {
        row.candidate_spec_id for row in ranked_rows[:bounded_top_k] if scored_rows
    }
    final_rows = tuple(
        FastReplayPreviewRow(
            candidate_spec_id=row.candidate_spec_id,
            rank=index,
            preview_score=row.preview_score,
            selected=row.candidate_spec_id in selected_ids,
            selection_reason=(
                "fast_replay_preview_selected"
                if row.candidate_spec_id in selected_ids
                else row.selection_reason
            ),
            matched_row_count=row.matched_row_count,
            matched_symbol_count=row.matched_symbol_count,
            requested_symbol_count=row.requested_symbol_count,
            trading_day_count=row.trading_day_count,
            signed_return_bps=row.signed_return_bps,
            avg_abs_return_bps=row.avg_abs_return_bps,
            median_spread_bps=row.median_spread_bps,
            activity_score=row.activity_score,
            coverage_score=row.coverage_score,
            ofi_pressure_score=row.ofi_pressure_score,
            microprice_bias_bps=row.microprice_bias_bps,
            spread_tail_bps=row.spread_tail_bps,
            return_tail_abs_bps=row.return_tail_abs_bps,
            impact_liquidity_penalty_bps=row.impact_liquidity_penalty_bps,
        )
        for index, row in enumerate(ranked_rows, start=1)
    )
    return FastReplayPreviewResult(
        rows=final_rows,
        selected_candidate_spec_ids=tuple(
            row.candidate_spec_id for row in final_rows if row.selected
        ),
        requested_top_k=bounded_top_k,
        input_candidate_count=len(specs),
        replay_tape_manifest=replay_tape_manifest,
        selected_row_count=len(rows),
        research_backend=research_backend,
    )


def _build_symbol_stats(
    rows: Sequence[SignalEnvelope],
    *,
    array_backend: _ArrayBackend,
) -> dict[str, _SymbolTapeStats]:
    rows_by_symbol: dict[str, list[SignalEnvelope]] = {}
    for row in rows:
        symbol = row.symbol.strip().upper()
        if not symbol:
            continue
        rows_by_symbol.setdefault(symbol, []).append(row)

    stats: dict[str, _SymbolTapeStats] = {}
    for symbol, symbol_rows in rows_by_symbol.items():
        ordered = sorted(symbol_rows, key=lambda item: item.event_ts)
        prices = [_extract_price(row) for row in ordered]
        xp = array_backend.xp
        price_array = _backend_array(
            array_backend,
            [price for price in prices if price is not None and price > 0.0],
        )
        returns = (
            xp.diff(price_array) / price_array[:-1] * 10_000.0
            if _array_size(price_array) >= 2
            else _backend_array(array_backend, [])
        )
        spread_values = [
            spread
            for row in ordered
            if (spread := _extract_spread_bps(row)) is not None
        ]
        ofi_values = [
            ofi for row in ordered if (ofi := _extract_ofi_pressure(row)) is not None
        ]
        microprice_bias_values = [
            bias
            for row in ordered
            if (bias := _extract_microprice_bias_bps(row)) is not None
        ]
        volume_values = [
            volume for row in ordered if (volume := _extract_volume(row)) is not None
        ]
        abs_returns = (
            xp.abs(returns)
            if _array_size(returns)
            else _backend_array(array_backend, [])
        )
        stats[symbol] = _SymbolTapeStats(
            symbol=symbol,
            row_count=len(ordered),
            trading_day_count=len(
                {row.event_ts.astimezone(timezone.utc).date() for row in ordered}
            ),
            returns_bps=returns,
            median_spread_bps=float(np.median(spread_values)) if spread_values else 0.0,
            spread_tail_bps=_backend_scalar(
                xp.percentile(_backend_array(array_backend, spread_values), 95),
                array_backend,
            )
            if spread_values
            else 0.0,
            ofi_pressure_score=_backend_scalar(
                xp.mean(_backend_array(array_backend, ofi_values)),
                array_backend,
            )
            if ofi_values
            else 0.0,
            microprice_bias_bps=(
                _backend_scalar(
                    xp.mean(_backend_array(array_backend, microprice_bias_values)),
                    array_backend,
                )
                if microprice_bias_values
                else 0.0
            ),
            median_volume=float(np.median(volume_values)) if volume_values else 0.0,
            return_tail_abs_bps=(
                _backend_scalar(xp.percentile(abs_returns, 95), array_backend)
                if _array_size(abs_returns)
                else 0.0
            ),
        )
    return stats


def _score_candidate_spec(
    *,
    spec: CandidateSpec,
    symbol_stats: Mapping[str, _SymbolTapeStats],
    array_backend: _ArrayBackend,
    min_rows_per_candidate: int,
) -> FastReplayPreviewRow:
    requested_symbols = _candidate_symbols(spec)
    matched = [
        stat for symbol in requested_symbols if (stat := symbol_stats.get(symbol))
    ]
    matched_row_count = sum(stat.row_count for stat in matched)
    requested_symbol_count = len(requested_symbols)
    matched_symbol_count = len(matched)
    if matched_row_count < min_rows_per_candidate or not matched:
        return FastReplayPreviewRow(
            candidate_spec_id=spec.candidate_spec_id,
            rank=0,
            preview_score=Decimal("-1000000"),
            selected=False,
            selection_reason="insufficient_replay_tape_rows",
            matched_row_count=matched_row_count,
            matched_symbol_count=matched_symbol_count,
            requested_symbol_count=requested_symbol_count,
            trading_day_count=max(
                (stat.trading_day_count for stat in matched), default=0
            ),
            signed_return_bps=Decimal("0"),
            avg_abs_return_bps=Decimal("0"),
            median_spread_bps=Decimal("0"),
            activity_score=Decimal("0"),
            coverage_score=Decimal("0"),
            ofi_pressure_score=Decimal("0"),
            microprice_bias_bps=Decimal("0"),
            spread_tail_bps=Decimal("0"),
            return_tail_abs_bps=Decimal("0"),
            impact_liquidity_penalty_bps=Decimal("0"),
        )

    xp = array_backend.xp
    return_vectors = [
        stat.returns_bps for stat in matched if _array_size(stat.returns_bps)
    ]
    returns = (
        xp.concatenate(return_vectors)
        if return_vectors
        else _backend_array(array_backend, [])
    )
    direction = _candidate_direction(spec)
    signed_return_bps = (
        _backend_scalar(xp.mean(returns), array_backend) * direction
        if _array_size(returns)
        else 0.0
    )
    avg_abs_return_bps = (
        _backend_scalar(xp.mean(xp.abs(returns)), array_backend)
        if _array_size(returns)
        else 0.0
    )
    median_spread_bps = float(np.median([stat.median_spread_bps for stat in matched]))
    spread_tail_bps = float(np.median([stat.spread_tail_bps for stat in matched]))
    ofi_pressure_score = _weighted_average(
        [(stat.ofi_pressure_score, stat.row_count) for stat in matched]
    )
    microprice_bias_bps = _weighted_average(
        [(stat.microprice_bias_bps, stat.row_count) for stat in matched]
    )
    return_tail_abs_bps = float(
        np.median([stat.return_tail_abs_bps for stat in matched])
    )
    median_volume = float(np.median([stat.median_volume for stat in matched]))
    activity_score = float(np.log1p(matched_row_count))
    coverage_score = matched_symbol_count / max(1, requested_symbol_count)
    impact_liquidity_penalty_bps = _impact_liquidity_penalty_bps(
        median_spread_bps=median_spread_bps,
        spread_tail_bps=spread_tail_bps,
        median_volume=median_volume,
    )
    preview_score = (
        signed_return_bps
        + avg_abs_return_bps * 0.15
        + direction * ofi_pressure_score * 8.0
        + direction * microprice_bias_bps * 0.35
        + activity_score
        + coverage_score * 25.0
        - median_spread_bps * 0.05
        - spread_tail_bps * 0.03
        - return_tail_abs_bps * 0.02
        - impact_liquidity_penalty_bps * 0.20
    )
    return FastReplayPreviewRow(
        candidate_spec_id=spec.candidate_spec_id,
        rank=0,
        preview_score=_decimal_from_float(preview_score),
        selected=False,
        selection_reason="fast_replay_preview_ranked",
        matched_row_count=matched_row_count,
        matched_symbol_count=matched_symbol_count,
        requested_symbol_count=requested_symbol_count,
        trading_day_count=max((stat.trading_day_count for stat in matched), default=0),
        signed_return_bps=_decimal_from_float(signed_return_bps),
        avg_abs_return_bps=_decimal_from_float(avg_abs_return_bps),
        median_spread_bps=_decimal_from_float(median_spread_bps),
        activity_score=_decimal_from_float(activity_score),
        coverage_score=_decimal_from_float(coverage_score),
        ofi_pressure_score=_decimal_from_float(ofi_pressure_score),
        microprice_bias_bps=_decimal_from_float(microprice_bias_bps),
        spread_tail_bps=_decimal_from_float(spread_tail_bps),
        return_tail_abs_bps=_decimal_from_float(return_tail_abs_bps),
        impact_liquidity_penalty_bps=_decimal_from_float(
            impact_liquidity_penalty_bps
        ),
    )


def _candidate_symbols(spec: CandidateSpec) -> tuple[str, ...]:
    raw = spec.strategy_overrides.get("universe_symbols")
    if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes, bytearray)):
        raw_symbols = cast(Sequence[Any], raw)
        symbols = tuple(
            sorted(
                {_string(item).upper() for item in raw_symbols if _string(item).strip()}
            )
        )
        if symbols:
            return symbols
    return (spec.runtime_strategy_name.upper(),)


def _candidate_direction(spec: CandidateSpec) -> float:
    params = _mapping(spec.strategy_overrides.get("params"))
    text = " ".join(
        item
        for item in (
            spec.runtime_strategy_name,
            spec.family_template_id,
            _string(params.get("selection_mode")),
            _string(params.get("signal_motif")),
            _string(params.get("rank_feature")),
        )
        if item
    ).lower()
    if any(
        token in text for token in ("reversal", "rebound", "washout", "mean_revert")
    ):
        return -1.0
    return 1.0


def _extract_price(signal: SignalEnvelope) -> float | None:
    return extract_price(signal)


def _extract_spread_bps(signal: SignalEnvelope) -> float | None:
    return extract_spread_bps(signal)


def _extract_ofi_pressure(signal: SignalEnvelope) -> float | None:
    return extract_ofi_pressure(signal)


def _extract_microprice_bias_bps(signal: SignalEnvelope) -> float | None:
    return extract_microprice_bias_bps(signal)


def _extract_volume(signal: SignalEnvelope) -> float | None:
    return extract_volume(signal)


def _impact_liquidity_penalty_bps(
    *, median_spread_bps: float, spread_tail_bps: float, median_volume: float
) -> float:
    volume_penalty = 25.0 / max(1.0, np.log1p(max(0.0, median_volume)))
    return max(0.0, median_spread_bps * 0.5 + spread_tail_bps * 0.5 + volume_penalty)


def _weighted_average(values: Sequence[tuple[float, int]]) -> float:
    total_weight = sum(max(0, weight) for _, weight in values)
    if total_weight <= 0:
        return 0.0
    return sum(value * max(0, weight) for value, weight in values) / total_weight


def _decimal_from_float(value: float) -> Decimal:
    return Decimal(str(round(float(value), 8)))


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _string(value: Any) -> str:
    return str(value or "").strip()


__all__ = [
    "FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION",
    "FAST_REPLAY_PREVIEW_SCHEMA_VERSION",
    "FastReplayPreviewResult",
    "FastReplayPreviewRow",
    "build_fast_replay_preview",
]
