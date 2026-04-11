"""Ranking-only proposal helpers for MLX-backed local autoresearch."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from app.trading.discovery.autoresearch import ProposalModelPolicy
from app.trading.discovery.mlx_features import MlxCandidateDescriptor, descriptor_numeric_vector


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _candidate_target(row: Mapping[str, Any]) -> float:
    net = _float(row.get('net_pnl_per_day'))
    activity = _float(row.get('active_day_ratio'))
    concentration_penalty = _float(row.get('best_day_share'))
    veto_penalty = 1.0 if row.get('hard_vetoes') else 0.0
    return net + (activity * 100.0) - (concentration_penalty * 100.0) - (veto_penalty * 250.0)


def _import_array_backend() -> tuple[str, Any]:
    try:
        import mlx.core as mx  # type: ignore[import-not-found]

        return 'mlx', mx
    except ModuleNotFoundError:
        import numpy as np

        return 'numpy-fallback', np


def _array(xp: Any, values: Sequence[Sequence[float]] | Sequence[float]) -> Any:
    dtype = getattr(xp, 'float32', None)
    if dtype is not None:
        return xp.array(values, dtype=dtype)
    return xp.array(values, dtype=float)


@dataclass(frozen=True)
class ProposalScore:
    candidate_id: str
    descriptor_id: str
    score: float
    rank: int
    backend: str
    mode: str

    def to_payload(self) -> dict[str, Any]:
        return {
            'candidate_id': self.candidate_id,
            'descriptor_id': self.descriptor_id,
            'score': self.score,
            'rank': self.rank,
            'backend': self.backend,
            'mode': self.mode,
        }


def rank_candidate_descriptors(
    *,
    descriptors: Sequence[MlxCandidateDescriptor],
    history_rows: Sequence[Mapping[str, Any]],
    policy: ProposalModelPolicy,
) -> list[ProposalScore]:
    if not descriptors:
        return []
    backend_name, xp = _import_array_backend()
    if not policy.enabled or policy.mode != 'ranking_only':
        return [
            ProposalScore(
                candidate_id=descriptor.candidate_id,
                descriptor_id=descriptor.descriptor_id,
                score=0.0,
                rank=index + 1,
                backend=backend_name,
                mode=policy.mode,
            )
            for index, descriptor in enumerate(descriptors)
        ]

    proposal_vectors = _array(xp, [descriptor_numeric_vector(item) for item in descriptors])
    if len(history_rows) < policy.minimum_history_rows:
        return [
            ProposalScore(
                candidate_id=descriptor.candidate_id,
                descriptor_id=descriptor.descriptor_id,
                score=0.0,
                rank=index + 1,
                backend=backend_name,
                mode=policy.mode,
            )
            for index, descriptor in enumerate(descriptors)
        ]

    history_vectors: list[list[float]] = []
    history_targets: list[float] = []
    for row in history_rows:
        history_descriptor = [
            float(row.get('entry_window_start_minute') or 0),
            float(row.get('entry_window_end_minute') or 0),
            float(row.get('max_hold_minutes') or 0),
            float(row.get('rank_count') or 0),
            float(bool(row.get('requires_prev_day_features'))),
            float(bool(row.get('requires_cross_sectional_features'))),
            float(bool(row.get('requires_quote_quality_gate'))),
        ]
        history_vectors.append(history_descriptor)
        history_targets.append(_candidate_target(row))

    history_matrix = _array(xp, history_vectors)
    positive_rows = [row for row, target in zip(history_vectors, history_targets, strict=False) if target > 0]
    negative_rows = [row for row, target in zip(history_vectors, history_targets, strict=False) if target <= 0]
    if positive_rows:
        positive_centroid = _array(xp, positive_rows).mean(axis=0)
    else:
        positive_centroid = history_matrix.mean(axis=0)
    if negative_rows:
        negative_centroid = _array(xp, negative_rows).mean(axis=0)
    else:
        negative_centroid = xp.zeros_like(positive_centroid)

    direction = positive_centroid - negative_centroid
    raw_scores = proposal_vectors @ direction
    resolved_scores = [float(item) for item in raw_scores.tolist()]
    ordered = sorted(
        zip(descriptors, resolved_scores, strict=False),
        key=lambda item: (-item[1], item[0].candidate_id),
    )
    results: list[ProposalScore] = []
    for index, (descriptor, score) in enumerate(ordered, start=1):
        results.append(
            ProposalScore(
                candidate_id=descriptor.candidate_id,
                descriptor_id=descriptor.descriptor_id,
                score=score,
                rank=index,
                backend=backend_name,
                mode=policy.mode,
            )
        )
    return results
