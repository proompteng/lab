"""Persistence functions for runtime window imports."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from app.models import (
    StrategyHypothesis,
    StrategyHypothesisVersion,
    VNextDatasetSnapshot,
)

__all__ = [
    "_dataset_snapshot_row",
    "_ensure_hypothesis_records",
    "_ensure_hypothesis_version",
    "_bucket_set",
    "_maybe_add_dataset_snapshot",
]

RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD = timedelta(seconds=3600)


def _dataset_snapshot_row(
    request: Any,
    context: Any,
    buckets: Any,
) -> Any:
    """Create a dataset snapshot row."""
    from .parser_helpers import _metadata_text_list, text_value

    runtime_payload = dict(request.runtime_observation_payload or {})
    artifact_refs = _metadata_text_list(runtime_payload.get("artifact_refs"))
    dataset_snapshot_ref = text_value(
        runtime_payload.get("dataset_snapshot_ref")
    ) or next((ref for ref in artifact_refs if ref), None)
    observed_source = (
        "paper_runtime_observed"
        if request.observed_stage == "paper"
        else "live_runtime_observed"
    )
    return request.session.model(
        run_id=request.run_id,
        dataset_id=f"runtime-window-{request.run_id}",
        dataset_ref=dataset_snapshot_ref,
        source=observed_source,
        bucket_count=len(buckets.raw_buckets),
        strategy_family=context.manifest.strategy_family,
        strategy_id=context.manifest.strategy_id,
        hypothesis_id=request.hypothesis_id,
        candidate_id=request.candidate_id,
        window_start=request.window_start.isoformat(),
        window_end=request.window_end.isoformat(),
    )


def _ensure_hypothesis_records(
    request: Any,
    context: Any,
) -> None:
    """Ensure hypothesis records exist in the database."""
    existing_hypothesis = request.session.execute(
        request.session.select(StrategyHypothesis).where(
            StrategyHypothesis.hypothesis_id == request.hypothesis_id
        )
    ).scalar_one_or_none()
    if existing_hypothesis is None:
        request.session.add(
            StrategyHypothesis(
                hypothesis_id=request.hypothesis_id,
                lane_id=context.manifest.lane_id,
                strategy_family=context.manifest.strategy_family,
                source_manifest_ref=request.source_manifest_ref
                or context.registry.path,
                active=True,
                payload_json=context.manifest.model_dump(mode="json"),
            )
        )
    _ensure_hypothesis_version(request, context)


def _ensure_hypothesis_version(
    request: Any,
    context: Any,
) -> None:
    """Ensure hypothesis version record exists."""
    version_key = f"{context.manifest.schema_version}:{context.manifest.lane_id}"
    existing_version = request.session.execute(
        request.session.select(StrategyHypothesisVersion).where(
            StrategyHypothesisVersion.hypothesis_id == request.hypothesis_id,
            StrategyHypothesisVersion.version_key == version_key,
        )
    ).scalar_one_or_none()
    if existing_version is None:
        request.session.add(
            StrategyHypothesisVersion(
                hypothesis_id=request.hypothesis_id,
                version_key=version_key,
                source_manifest_ref=request.source_manifest_ref
                or context.registry.path,
                active=True,
                payload_json=context.manifest.model_dump(mode="json"),
            )
        )


def _bucket_set(
    request: Any,
) -> Any:
    """Build a bucket set from the request buckets."""
    raw_buckets = sorted(request.buckets, key=lambda item: item.window_ended_at)
    sorted_buckets = [
        bucket
        for bucket in raw_buckets
        if bucket.decision_count > 0 or bucket.trade_count > 0 or bucket.order_count > 0
    ]
    return {
        "raw_buckets": raw_buckets,
        "sorted_buckets": sorted_buckets,
        "raw_window_count": len(raw_buckets),
        "skipped_zero_activity_window_count": len(raw_buckets) - len(sorted_buckets),
    }


def _maybe_add_dataset_snapshot(
    request: Any,
    context: Any,
    buckets: Any,
) -> None:
    """Add a dataset snapshot if candidate_id and dataset_snapshot_ref are present."""
    if request.candidate_id is None or context.get("dataset_snapshot_ref") is None:
        return

    existing_dataset = request.session.execute(
        request.session.select(VNextDatasetSnapshot).where(
            VNextDatasetSnapshot.run_id == request.run_id,
            VNextDatasetSnapshot.dataset_id == f"runtime-window-{request.run_id}",
        )
    ).scalar_one_or_none()
    if existing_dataset is not None:
        return
    request.session.add(_dataset_snapshot_row(request, context, buckets))
