"""Preview-only vectorized scoring over manifest-verified replay tapes."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import timezone
from decimal import Decimal
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.replay_tape import ReplayTapeManifest
from app.trading.models import SignalEnvelope

FAST_REPLAY_PREVIEW_SCHEMA_VERSION = "torghut.fast-replay-preview.v1"
FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION = "torghut.fast-replay-preview-row.v1"


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
        }


@dataclass(frozen=True)
class FastReplayPreviewResult:
    rows: tuple[FastReplayPreviewRow, ...]
    selected_candidate_spec_ids: tuple[str, ...]
    requested_top_k: int
    input_candidate_count: int
    replay_tape_manifest: ReplayTapeManifest
    selected_row_count: int

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
    returns_bps: NDArray[np.float64]
    median_spread_bps: float


def build_fast_replay_preview(
    *,
    specs: Sequence[CandidateSpec],
    rows: Sequence[SignalEnvelope],
    replay_tape_manifest: ReplayTapeManifest,
    top_k: int,
    min_rows_per_candidate: int = 2,
) -> FastReplayPreviewResult:
    """Rank candidate specs with cheap tape-derived features only.

    This intentionally produces a preview artifact, not replay evidence. Exact
    scheduler replay and runtime ledger proof remain required downstream.
    """

    bounded_top_k = max(1, min(len(specs) or 1, int(top_k)))
    symbol_stats = _build_symbol_stats(rows)
    scored_rows: list[FastReplayPreviewRow] = []
    for spec in specs:
        scored_rows.append(
            _score_candidate_spec(
                spec=spec,
                symbol_stats=symbol_stats,
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
    )


def _build_symbol_stats(
    rows: Sequence[SignalEnvelope],
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
        price_array = np.asarray(
            [price for price in prices if price is not None and price > 0.0],
            dtype=np.float64,
        )
        returns = (
            np.diff(price_array) / price_array[:-1] * 10_000.0
            if price_array.size >= 2
            else np.asarray([], dtype=np.float64)
        )
        spread_values = [
            spread
            for row in ordered
            if (spread := _extract_spread_bps(row)) is not None
        ]
        stats[symbol] = _SymbolTapeStats(
            symbol=symbol,
            row_count=len(ordered),
            trading_day_count=len(
                {row.event_ts.astimezone(timezone.utc).date() for row in ordered}
            ),
            returns_bps=returns,
            median_spread_bps=float(np.median(spread_values)) if spread_values else 0.0,
        )
    return stats


def _score_candidate_spec(
    *,
    spec: CandidateSpec,
    symbol_stats: Mapping[str, _SymbolTapeStats],
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
        )

    return_vectors = [stat.returns_bps for stat in matched if stat.returns_bps.size]
    returns = (
        np.concatenate(return_vectors)
        if return_vectors
        else np.asarray([], dtype=np.float64)
    )
    direction = _candidate_direction(spec)
    signed_return_bps = float(np.mean(returns)) * direction if returns.size else 0.0
    avg_abs_return_bps = float(np.mean(np.abs(returns))) if returns.size else 0.0
    median_spread_bps = float(np.median([stat.median_spread_bps for stat in matched]))
    activity_score = float(np.log1p(matched_row_count))
    coverage_score = matched_symbol_count / max(1, requested_symbol_count)
    preview_score = (
        signed_return_bps
        + avg_abs_return_bps * 0.15
        + activity_score
        + coverage_score * 25.0
        - median_spread_bps * 0.05
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
    payload = signal.payload
    for key in ("price", "mid_price", "mid", "mark", "last_price", "close"):
        value = _float_or_none(payload.get(key))
        if value is not None and value > 0.0:
            return value
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask > 0.0:
        return (bid + ask) / 2.0
    return None


def _extract_spread_bps(signal: SignalEnvelope) -> float | None:
    payload = signal.payload
    explicit = _float_or_none(payload.get("spread_bps"))
    if explicit is not None:
        return max(0.0, explicit)
    bid = _float_or_none(payload.get("bid"))
    ask = _float_or_none(payload.get("ask"))
    if bid is not None and ask is not None and bid > 0.0 and ask >= bid:
        return (ask - bid) / ((ask + bid) / 2.0) * 10_000.0
    spread = _float_or_none(payload.get("spread"))
    price = _extract_price(signal)
    if spread is not None and price is not None and price > 0.0:
        return max(0.0, spread / price * 10_000.0)
    return None


def _float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(parsed):
        return None
    return parsed


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
