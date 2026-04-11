"""Ranking-only proposal helpers for MLX-backed local autoresearch."""

from __future__ import annotations

import math
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


def _import_mlx_backend() -> tuple[str, Any]:
    import mlx.core as mx  # type: ignore[import-not-found]

    return 'mlx', mx


def _import_numpy_backend() -> tuple[str, Any]:
    import numpy as np

    return 'numpy-fallback', np


def _import_array_backend(preference: str) -> tuple[str, Any]:
    normalized = preference.strip().lower()
    if normalized in {'numpy', 'numpy-fallback'}:
        return _import_numpy_backend()
    if normalized == 'mlx':
        try:
            return _import_mlx_backend()
        except ModuleNotFoundError:
            return _import_numpy_backend()
    try:
        return _import_mlx_backend()
    except ModuleNotFoundError:
        return _import_numpy_backend()


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


@dataclass(frozen=True)
class ProposalSelectionEntry:
    candidate_id: str
    descriptor_id: str
    selection_reason: str
    score: float
    rank: int
    family_template_id: str
    side_policy: str

    def to_payload(self) -> dict[str, Any]:
        return {
            'candidate_id': self.candidate_id,
            'descriptor_id': self.descriptor_id,
            'selection_reason': self.selection_reason,
            'score': self.score,
            'rank': self.rank,
            'family_template_id': self.family_template_id,
            'side_policy': self.side_policy,
        }


@dataclass(frozen=True)
class ProposalDiagnostics:
    candidate_count: int
    scored_candidate_count: int
    score_histogram: tuple[Mapping[str, Any], ...]
    family_volume: tuple[Mapping[str, Any], ...]
    side_volume: tuple[Mapping[str, Any], ...]
    selected_candidates: tuple[ProposalSelectionEntry, ...]
    diversity_summary: Mapping[str, Any]
    rank_bucket_lift: tuple[Mapping[str, Any], ...]
    parity_matrix: Mapping[str, int]
    worst_false_positives: tuple[Mapping[str, Any], ...]
    best_false_negatives: tuple[Mapping[str, Any], ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            'candidate_count': self.candidate_count,
            'scored_candidate_count': self.scored_candidate_count,
            'score_histogram': [dict(item) for item in self.score_histogram],
            'family_volume': [dict(item) for item in self.family_volume],
            'side_volume': [dict(item) for item in self.side_volume],
            'selected_candidates': [item.to_payload() for item in self.selected_candidates],
            'diversity_summary': dict(self.diversity_summary),
            'rank_bucket_lift': [dict(item) for item in self.rank_bucket_lift],
            'parity_matrix': dict(self.parity_matrix),
            'worst_false_positives': [dict(item) for item in self.worst_false_positives],
            'best_false_negatives': [dict(item) for item in self.best_false_negatives],
        }


def _score_by_candidate(proposal_scores: Sequence[ProposalScore]) -> dict[str, ProposalScore]:
    return {item.candidate_id: item for item in proposal_scores}


def _descriptor_by_candidate(descriptors: Sequence[MlxCandidateDescriptor]) -> dict[str, MlxCandidateDescriptor]:
    return {item.candidate_id: item for item in descriptors}


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _pairwise_mean_distance(descriptors: Sequence[MlxCandidateDescriptor]) -> float:
    if len(descriptors) < 2:
        return 0.0
    vectors = [descriptor_numeric_vector(item) for item in descriptors]
    distances: list[float] = []
    for index, left in enumerate(vectors):
        for right in vectors[index + 1 :]:
            squared = [(a - b) ** 2 for a, b in zip(left, right, strict=False)]
            distances.append(math.sqrt(sum(squared)))
    return _mean(distances)


def _histogram(scores: Sequence[float], bucket_count: int = 5) -> tuple[Mapping[str, Any], ...]:
    if not scores:
        return ()
    minimum = min(scores)
    maximum = max(scores)
    if math.isclose(minimum, maximum):
        return (
            {
                'bucket_label': f'{minimum:.4f}..{maximum:.4f}',
                'min_score': minimum,
                'max_score': maximum,
                'count': len(scores),
            },
        )
    width = (maximum - minimum) / max(1, bucket_count)
    rows: list[dict[str, Any]] = []
    for bucket_index in range(bucket_count):
        lower = minimum + (width * bucket_index)
        upper = maximum if bucket_index == bucket_count - 1 else lower + width
        if bucket_index == bucket_count - 1:
            count = sum(1 for value in scores if lower <= value <= upper)
        else:
            count = sum(1 for value in scores if lower <= value < upper)
        rows.append(
            {
                'bucket_label': f'{lower:.2f}..{upper:.2f}',
                'min_score': lower,
                'max_score': upper,
                'count': count,
            }
        )
    return tuple(rows)


def _volume(rows: Sequence[str], *, label_key: str) -> tuple[Mapping[str, Any], ...]:
    counts: dict[str, int] = {}
    for item in rows:
        counts[item] = counts.get(item, 0) + 1
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return tuple({label_key: label, 'candidate_count': count} for label, count in ordered)


def select_proposal_batch(
    *,
    descriptors: Sequence[MlxCandidateDescriptor],
    proposal_scores: Sequence[ProposalScore],
    limit: int,
    top_k: int,
    exploration_slots: int,
) -> list[ProposalSelectionEntry]:
    if limit <= 0 or not descriptors or not proposal_scores:
        return []
    descriptor_by_candidate = _descriptor_by_candidate(descriptors)
    ordered_scores = sorted(proposal_scores, key=lambda item: (item.rank, -item.score, item.candidate_id))
    selected: list[ProposalSelectionEntry] = []
    selected_ids: set[str] = set()
    selected_families: set[str] = set()
    selected_sides: set[str] = set()

    exploitation_limit = min(limit, max(1, top_k))
    for item in ordered_scores:
        descriptor = descriptor_by_candidate.get(item.candidate_id)
        if descriptor is None or item.candidate_id in selected_ids:
            continue
        selected.append(
            ProposalSelectionEntry(
                candidate_id=item.candidate_id,
                descriptor_id=item.descriptor_id,
                selection_reason='exploitation',
                score=item.score,
                rank=item.rank,
                family_template_id=descriptor.family_template_id,
                side_policy=descriptor.side_policy,
            )
        )
        selected_ids.add(item.candidate_id)
        selected_families.add(descriptor.family_template_id)
        selected_sides.add(descriptor.side_policy)
        if len(selected) >= exploitation_limit:
            break

    remaining_slots = min(
        max(0, limit - len(selected)),
        max(0, exploration_slots),
    )
    while remaining_slots > 0:
        best_item: tuple[float, ProposalScore, MlxCandidateDescriptor] | None = None
        selected_descriptors = [descriptor_by_candidate[item.candidate_id] for item in selected if item.candidate_id in descriptor_by_candidate]
        for score in ordered_scores:
            if score.candidate_id in selected_ids:
                continue
            descriptor = descriptor_by_candidate.get(score.candidate_id)
            if descriptor is None:
                continue
            family_bonus = 1000.0 if descriptor.family_template_id not in selected_families else 0.0
            side_bonus = 100.0 if descriptor.side_policy not in selected_sides else 0.0
            if selected_descriptors:
                distances = [
                    math.sqrt(
                        sum(
                            (a - b) ** 2
                            for a, b in zip(
                                descriptor_numeric_vector(descriptor),
                                descriptor_numeric_vector(existing),
                                strict=False,
                            )
                        )
                    )
                    for existing in selected_descriptors
                ]
                diversity_bonus = _mean(distances)
            else:
                diversity_bonus = 0.0
            combined = family_bonus + side_bonus + diversity_bonus + (score.score * 0.001)
            candidate = (combined, score, descriptor)
            if best_item is None or candidate[0] > best_item[0] or (
                math.isclose(candidate[0], best_item[0])
                and (score.rank, score.candidate_id) < (best_item[1].rank, best_item[1].candidate_id)
            ):
                best_item = candidate
        if best_item is None:
            break
        _, score, descriptor = best_item
        selected.append(
            ProposalSelectionEntry(
                candidate_id=score.candidate_id,
                descriptor_id=score.descriptor_id,
                selection_reason='exploration',
                score=score.score,
                rank=score.rank,
                family_template_id=descriptor.family_template_id,
                side_policy=descriptor.side_policy,
            )
        )
        selected_ids.add(score.candidate_id)
        selected_families.add(descriptor.family_template_id)
        selected_sides.add(descriptor.side_policy)
        remaining_slots -= 1
    return selected


def build_proposal_diagnostics(
    *,
    descriptors: Sequence[MlxCandidateDescriptor],
    proposal_scores: Sequence[ProposalScore],
    history_rows: Sequence[Mapping[str, Any]],
    selected_candidates: Sequence[ProposalSelectionEntry] = (),
) -> ProposalDiagnostics:
    descriptor_by_candidate = _descriptor_by_candidate(descriptors)
    score_by_candidate = _score_by_candidate(proposal_scores)
    unique_descriptors = list(descriptor_by_candidate.values())
    unique_scores = list(score_by_candidate.values())
    score_values = [item.score for item in unique_scores]
    family_volume = _volume([item.family_template_id for item in unique_descriptors], label_key='family_template_id')
    side_volume = _volume([item.side_policy for item in unique_descriptors], label_key='side_policy')

    replay_rows: list[dict[str, Any]] = []
    for row in history_rows:
        candidate_id = str(row.get('candidate_id') or '').strip()
        score = score_by_candidate.get(candidate_id)
        if score is None:
            continue
        replay_rows.append(
            {
                'candidate_id': candidate_id,
                'proposal_rank': score.rank,
                'proposal_score': score.score,
                'net_pnl_per_day': _float(row.get('net_pnl_per_day')),
                'active_day_ratio': _float(row.get('active_day_ratio')),
                'objective_met': bool(row.get('objective_met')),
                'promotion_status': str(row.get('promotion_status') or '').strip(),
                'status': str(row.get('status') or '').strip(),
            }
        )
    replay_rows.sort(key=lambda item: (item['proposal_rank'], item['candidate_id']))

    rank_bucket_lift: list[dict[str, Any]] = []
    if replay_rows:
        bucket_size = max(1, math.ceil(len(replay_rows) / min(4, len(replay_rows))))
        for bucket_index in range(0, len(replay_rows), bucket_size):
            bucket_rows = replay_rows[bucket_index : bucket_index + bucket_size]
            label = f'rank_{bucket_index + 1}_to_{bucket_index + len(bucket_rows)}'
            rank_bucket_lift.append(
                {
                    'bucket_label': label,
                    'candidate_count': len(bucket_rows),
                    'mean_proposal_score': _mean([float(item['proposal_score']) for item in bucket_rows]),
                    'mean_net_pnl_per_day': _mean([float(item['net_pnl_per_day']) for item in bucket_rows]),
                    'positive_rate': _mean([1.0 if float(item['net_pnl_per_day']) > 0 else 0.0 for item in bucket_rows]),
                }
            )

    false_positives = sorted(
        [item for item in replay_rows if float(item['net_pnl_per_day']) <= 0],
        key=lambda item: (-float(item['proposal_score']), item['candidate_id']),
    )[:5]
    false_negatives = sorted(
        [item for item in replay_rows if float(item['net_pnl_per_day']) > 0],
        key=lambda item: (-float(item['net_pnl_per_day']), int(item['proposal_rank'])),
    )
    median_rank = math.ceil(len(replay_rows) / 2) if replay_rows else 0
    false_negatives = [item for item in false_negatives if int(item['proposal_rank']) > max(1, median_rank)][:5]

    selected_descriptors = [
        descriptor_by_candidate[item.candidate_id]
        for item in selected_candidates
        if item.candidate_id in descriptor_by_candidate
    ]
    parity_matrix = {
        'proposed_count': len(unique_descriptors),
        'replayed_count': len(replay_rows),
        'keep_count': sum(1 for row in replay_rows if row['status'] == 'keep'),
        'objective_met_count': sum(1 for row in replay_rows if row['objective_met']),
        'blocked_promotion_count': sum(1 for row in replay_rows if row['promotion_status']),
    }
    diversity_summary = {
        'selected_unique_family_count': len({item.family_template_id for item in selected_candidates}),
        'selected_unique_side_count': len({item.side_policy for item in selected_candidates}),
        'selected_mean_pairwise_distance': _pairwise_mean_distance(selected_descriptors),
    }
    return ProposalDiagnostics(
        candidate_count=len(unique_descriptors),
        scored_candidate_count=len(unique_scores),
        score_histogram=_histogram(score_values),
        family_volume=family_volume,
        side_volume=side_volume,
        selected_candidates=tuple(selected_candidates),
        diversity_summary=diversity_summary,
        rank_bucket_lift=tuple(rank_bucket_lift),
        parity_matrix=parity_matrix,
        worst_false_positives=tuple(false_positives),
        best_false_negatives=tuple(false_negatives),
    )


def rank_candidate_descriptors(
    *,
    descriptors: Sequence[MlxCandidateDescriptor],
    history_rows: Sequence[Mapping[str, Any]],
    policy: ProposalModelPolicy,
) -> list[ProposalScore]:
    if not descriptors:
        return []
    backend_name, xp = _import_array_backend(policy.backend_preference)
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
