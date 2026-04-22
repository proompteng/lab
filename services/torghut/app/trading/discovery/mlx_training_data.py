"""Training-row and ranker helpers for the MLX autoresearch proposal model."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle

MLX_RANKER_SCHEMA_VERSION = "torghut.mlx-ranker.v1"


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _import_array_backend(preference: str) -> tuple[str, Any]:
    normalized = preference.strip().lower()
    if normalized in {"numpy", "numpy-fallback"}:
        import numpy as np

        return "numpy-fallback", np
    if normalized == "mlx":
        try:
            import mlx.core as mx  # type: ignore[import-not-found]

            return "mlx", mx
        except ModuleNotFoundError:
            import numpy as np

            return "numpy-fallback", np
    try:
        import mlx.core as mx  # type: ignore[import-not-found]

        return "mlx", mx
    except ModuleNotFoundError:
        import numpy as np

        return "numpy-fallback", np


@dataclass(frozen=True)
class MlxTrainingRow:
    candidate_spec_id: str
    feature_names: tuple[str, ...]
    feature_values: tuple[float, ...]
    target: float

    def to_payload(self) -> dict[str, Any]:
        return {
            "candidate_spec_id": self.candidate_spec_id,
            "features": dict(zip(self.feature_names, self.feature_values, strict=True)),
            "target": self.target,
        }


@dataclass(frozen=True)
class MlxRankerModel:
    schema_version: str
    model_id: str
    backend: str
    feature_names: tuple[str, ...]
    feature_means: tuple[float, ...]
    feature_scales: tuple[float, ...]
    target_mean: float
    target_scale: float
    weights: tuple[float, ...]
    bias: float
    row_count: int
    training_loss: float
    trained_at: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "model_id": self.model_id,
            "backend": self.backend,
            "feature_names": list(self.feature_names),
            "feature_means": list(self.feature_means),
            "feature_scales": list(self.feature_scales),
            "target_mean": self.target_mean,
            "target_scale": self.target_scale,
            "weights": list(self.weights),
            "bias": self.bias,
            "row_count": self.row_count,
            "training_loss": self.training_loss,
            "trained_at": self.trained_at,
        }


@dataclass(frozen=True)
class MlxRankedCandidate:
    candidate_spec_id: str
    score: float
    rank: int
    model_id: str
    backend: str
    feature_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "candidate_spec_id": self.candidate_spec_id,
            "score": self.score,
            "rank": self.rank,
            "model_id": self.model_id,
            "backend": self.backend,
            "feature_hash": self.feature_hash,
        }


@dataclass(frozen=True)
class MlxRankBucketLift:
    metric_name: str
    top_bucket_mean: float
    bottom_bucket_mean: float
    lift: float
    status: str = "computed"

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            f"top_bucket_mean_{self.metric_name}": _format_float(self.top_bucket_mean),
            f"bottom_bucket_mean_{self.metric_name}": _format_float(
                self.bottom_bucket_mean
            ),
            f"lift_{self.metric_name}": _format_float(self.lift),
        }


@dataclass(frozen=True)
class MlxRankedRowsPolicyResult:
    ranked_rows: tuple[MlxRankedCandidate, ...]
    rank_bucket_lift: MlxRankBucketLift
    model_status: str
    selection_reason: str


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _format_float(value: float) -> str:
    return format(value, ".12g")


def _family_code(family_template_id: str) -> float:
    families = {
        "breakout_reclaim_v2": 1.0,
        "washout_rebound_v2": 2.0,
        "momentum_pullback_v1": 3.0,
        "mean_reversion_rebound_v1": 4.0,
        "microbar_cross_sectional_pairs_v1": 5.0,
        "microstructure_continuation_matched_filter_v1": 6.0,
        "intraday_tsmom_v2": 7.0,
    }
    return families.get(family_template_id, 0.0)


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _std(values: Sequence[float], *, mean: float) -> float:
    if len(values) < 2:
        return 1.0
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    scale = variance**0.5
    return scale if scale > 1e-9 else 1.0


def _scalar_float(value: Any) -> float:
    item_method = getattr(value, "item", None)
    if callable(item_method):
        item_value = cast(Any, item_method())
        return float(item_value)
    return float(value)


def build_mlx_training_rows(
    *,
    candidate_specs: Sequence[CandidateSpec],
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[MlxTrainingRow]:
    evidence_by_spec = {item.candidate_spec_id: item for item in evidence_bundles}
    rows: list[MlxTrainingRow] = []
    for spec in candidate_specs:
        evidence = evidence_by_spec.get(spec.candidate_spec_id)
        scorecard: Mapping[str, Any] = (
            evidence.objective_scorecard if evidence is not None else {}
        )
        feature_names = (
            "family_code",
            "required_feature_count",
            "failure_mode_count",
            "target_net_pnl_per_day",
            "history_net_pnl_per_day",
            "history_active_day_ratio",
            "history_positive_day_ratio",
        )
        feature_values = (
            _family_code(spec.family_template_id),
            float(len(spec.feature_contract.get("required_features") or [])),
            float(len(spec.expected_failure_modes)),
            _float(spec.objective.get("target_net_pnl_per_day")),
            _float(scorecard.get("net_pnl_per_day")),
            _float(scorecard.get("active_day_ratio")),
            _float(scorecard.get("positive_day_ratio")),
        )
        target = (
            _float(scorecard.get("net_pnl_per_day"))
            + (_float(scorecard.get("active_day_ratio")) * 100.0)
            + (_float(scorecard.get("positive_day_ratio")) * 50.0)
        )
        rows.append(
            MlxTrainingRow(
                candidate_spec_id=spec.candidate_spec_id,
                feature_names=feature_names,
                feature_values=feature_values,
                target=target,
            )
        )
    return rows


def _normalize_matrix(
    rows: Sequence[MlxTrainingRow],
) -> tuple[list[list[float]], tuple[str, ...], tuple[float, ...], tuple[float, ...]]:
    if not rows:
        return [], (), (), ()
    feature_names = rows[0].feature_names
    columns = list(zip(*(row.feature_values for row in rows), strict=True))
    means = tuple(_mean(column) for column in columns)
    scales = tuple(
        _std(column, mean=mean) for column, mean in zip(columns, means, strict=True)
    )
    matrix = [
        [
            (value - mean) / scale
            for value, mean, scale in zip(
                row.feature_values, means, scales, strict=True
            )
        ]
        for row in rows
    ]
    return matrix, feature_names, means, scales


def train_mlx_ranker(
    rows: Sequence[MlxTrainingRow],
    *,
    backend_preference: str = "mlx",
    learning_rate: float = 0.05,
    steps: int = 256,
    l2_penalty: float = 0.001,
) -> MlxRankerModel:
    if not rows:
        raise ValueError("mlx_ranker_training_rows_required")
    matrix, feature_names, feature_means, feature_scales = _normalize_matrix(rows)
    targets = [row.target for row in rows]
    target_mean = _mean(targets)
    target_scale = _std(targets, mean=target_mean)
    normalized_targets = [(target - target_mean) / target_scale for target in targets]
    backend, xp = _import_array_backend(backend_preference)
    dtype = getattr(xp, "float32", None)
    x = (
        xp.array(matrix, dtype=dtype)
        if dtype is not None
        else xp.array(matrix, dtype=float)
    )
    y = (
        xp.array(normalized_targets, dtype=dtype)
        if dtype is not None
        else xp.array(normalized_targets, dtype=float)
    )
    feature_count = len(feature_names)
    weights = (
        xp.zeros((feature_count,), dtype=dtype)
        if dtype is not None
        else xp.zeros((feature_count,))
    )
    bias = xp.array(0.0, dtype=dtype) if dtype is not None else 0.0
    row_count = max(1, len(rows))
    for _ in range(max(1, steps)):
        predictions = x @ weights + bias
        errors = predictions - y
        gradient_w = ((x.T @ errors) * (2.0 / row_count)) + (weights * l2_penalty)
        gradient_b = errors.mean() * 2.0
        weights = weights - (gradient_w * learning_rate)
        bias = bias - (gradient_b * learning_rate)
    predictions = x @ weights + bias
    errors = predictions - y
    loss = _scalar_float((errors * errors).mean())
    weights_list = tuple(float(item) for item in cast(Sequence[Any], weights.tolist()))
    bias_value = _scalar_float(bias)
    model_seed = {
        "feature_names": list(feature_names),
        "weights": list(weights_list),
        "bias": bias_value,
        "row_count": len(rows),
        "backend": backend,
    }
    return MlxRankerModel(
        schema_version=MLX_RANKER_SCHEMA_VERSION,
        model_id=f"mlx-ranker-v1-{_stable_hash(model_seed)[:16]}",
        backend=backend,
        feature_names=feature_names,
        feature_means=feature_means,
        feature_scales=feature_scales,
        target_mean=target_mean,
        target_scale=target_scale,
        weights=weights_list,
        bias=bias_value,
        row_count=len(rows),
        training_loss=loss,
        trained_at=datetime.now(UTC).isoformat(),
    )


def rank_training_rows(
    *,
    model: MlxRankerModel,
    rows: Sequence[MlxTrainingRow],
) -> list[MlxRankedCandidate]:
    scored: list[tuple[MlxTrainingRow, float, str]] = []
    for row in rows:
        normalized = [
            (value - mean) / scale
            for value, mean, scale in zip(
                row.feature_values,
                model.feature_means,
                model.feature_scales,
                strict=True,
            )
        ]
        normalized_score = (
            sum(
                (
                    value * weight
                    for value, weight in zip(normalized, model.weights, strict=True)
                ),
                0.0,
            )
            + model.bias
        )
        score = (normalized_score * model.target_scale) + model.target_mean
        feature_hash = _stable_hash({"features": row.to_payload()["features"]})
        scored.append((row, score, feature_hash))
    ordered = sorted(
        scored, key=lambda item: (item[1], item[0].candidate_spec_id), reverse=True
    )
    return [
        MlxRankedCandidate(
            candidate_spec_id=row.candidate_spec_id,
            score=score,
            rank=index,
            model_id=model.model_id,
            backend=model.backend,
            feature_hash=feature_hash,
        )
        for index, (row, score, feature_hash) in enumerate(ordered, start=1)
    ]


def compute_rank_bucket_lift(
    *,
    ranked_rows: Sequence[MlxRankedCandidate],
    rows: Sequence[MlxTrainingRow],
    metric_name: str = "replay_target",
    outcome_by_spec: Mapping[str, Any] | None = None,
) -> MlxRankBucketLift:
    if not ranked_rows:
        return MlxRankBucketLift(
            metric_name=metric_name,
            top_bucket_mean=0.0,
            bottom_bucket_mean=0.0,
            lift=0.0,
            status="no_ranked_rows",
        )
    row_target_by_spec = {row.candidate_spec_id: row.target for row in rows}
    outcomes = [
        _float(
            outcome_by_spec.get(item.candidate_spec_id)
            if outcome_by_spec is not None
            else row_target_by_spec.get(item.candidate_spec_id, 0.0)
        )
        for item in ranked_rows
    ]
    split_index = max(1, len(outcomes) // 2)
    top_bucket = outcomes[:split_index]
    bottom_bucket = outcomes[split_index:] or [0.0]
    top_mean = _mean(top_bucket)
    bottom_mean = _mean(bottom_bucket)
    return MlxRankBucketLift(
        metric_name=metric_name,
        top_bucket_mean=top_mean,
        bottom_bucket_mean=bottom_mean,
        lift=top_mean - bottom_mean,
    )


def rank_training_rows_with_lift_policy(
    *,
    model: MlxRankerModel,
    rows: Sequence[MlxTrainingRow],
    metric_name: str = "replay_target",
    outcome_by_spec: Mapping[str, Any] | None = None,
) -> MlxRankedRowsPolicyResult:
    ranked_rows = rank_training_rows(model=model, rows=rows)
    rank_lift = compute_rank_bucket_lift(
        ranked_rows=ranked_rows,
        rows=rows,
        metric_name=metric_name,
        outcome_by_spec=outcome_by_spec,
    )
    if rank_lift.lift >= 0:
        return MlxRankedRowsPolicyResult(
            ranked_rows=tuple(ranked_rows),
            rank_bucket_lift=rank_lift,
            model_status="active",
            selection_reason="exploitation",
        )

    feature_hash_by_spec = {
        item.candidate_spec_id: item.feature_hash for item in ranked_rows
    }
    ranked_by_fallback = sorted(
        rows,
        key=lambda row: (
            _float(
                outcome_by_spec.get(row.candidate_spec_id)
                if outcome_by_spec is not None
                else row.target
            ),
            row.candidate_spec_id,
        ),
        reverse=True,
    )
    fallback_rows = tuple(
        MlxRankedCandidate(
            candidate_spec_id=row.candidate_spec_id,
            score=_float(
                outcome_by_spec.get(row.candidate_spec_id)
                if outcome_by_spec is not None
                else row.target
            ),
            rank=index,
            model_id=model.model_id,
            backend=model.backend,
            feature_hash=feature_hash_by_spec.get(
                row.candidate_spec_id,
                _stable_hash({"features": row.to_payload()["features"]}),
            ),
        )
        for index, row in enumerate(ranked_by_fallback, start=1)
    )
    return MlxRankedRowsPolicyResult(
        ranked_rows=fallback_rows,
        rank_bucket_lift=rank_lift,
        model_status="demoted_to_heuristic",
        selection_reason="heuristic_negative_lift_fallback",
    )


def mlx_ranker_model_from_payload(payload: Mapping[str, Any]) -> MlxRankerModel:
    schema_version = str(payload.get("schema_version") or "").strip()
    if schema_version != MLX_RANKER_SCHEMA_VERSION:
        raise ValueError(f"mlx_ranker_schema_invalid:{schema_version}")
    return MlxRankerModel(
        schema_version=MLX_RANKER_SCHEMA_VERSION,
        model_id=str(payload.get("model_id") or "").strip(),
        backend=str(payload.get("backend") or "").strip(),
        feature_names=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("feature_names") or [])
        ),
        feature_means=tuple(
            float(item)
            for item in cast(Sequence[Any], payload.get("feature_means") or [])
        ),
        feature_scales=tuple(
            float(item)
            for item in cast(Sequence[Any], payload.get("feature_scales") or [])
        ),
        target_mean=float(payload.get("target_mean") or 0.0),
        target_scale=float(payload.get("target_scale") or 1.0),
        weights=tuple(
            float(item) for item in cast(Sequence[Any], payload.get("weights") or [])
        ),
        bias=float(payload.get("bias") or 0.0),
        row_count=int(payload.get("row_count") or 0),
        training_loss=float(payload.get("training_loss") or 0.0),
        trained_at=str(payload.get("trained_at") or "").strip(),
    )
