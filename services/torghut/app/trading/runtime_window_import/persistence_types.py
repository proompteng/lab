"""Typed state for runtime-window persistence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Mapping, Sequence

from sqlalchemy.orm import Session

from ...models import (
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
)
from ..hypotheses import HypothesisManifest, HypothesisRegistryLoadResult

from .common import ObservedRuntimeBucket


@dataclass(frozen=True)
class PersistObservedRuntimeWindowsRequest:
    session: Session
    run_id: str
    candidate_id: str | None
    hypothesis_id: str
    observed_stage: str
    strategy_family: str | None
    source_manifest_ref: str | None
    buckets: Sequence[ObservedRuntimeBucket]
    slippage_budget_bps: Decimal | None = None
    runtime_observation_payload: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class ManifestContext:
    registry: HypothesisRegistryLoadResult
    manifest: HypothesisManifest
    budget: Decimal
    runtime_payload: dict[str, Any]
    delay_depth_stress_summary: dict[str, object]
    evidence_provenance: str
    dataset_snapshot_ref: str | None
    dataset_source: str


@dataclass(frozen=True)
class BucketSet:
    raw_buckets: list[ObservedRuntimeBucket]
    sorted_buckets: list[ObservedRuntimeBucket]
    raw_window_count: int
    skipped_zero_activity_window_count: int


@dataclass(frozen=True)
class ReplacementCounts:
    current_runtime_ledger_bucket_replacement_count: int
    replaced_runtime_ledger_bucket_count: int


@dataclass(frozen=True)
class AggregateMetrics:
    inserted: int
    total_session_samples: int
    total_decision_count: int
    total_trade_count: int
    total_order_count: int
    total_post_cost_promotion_sample_count: int
    total_post_cost_basis_counts: dict[str, int]
    latest_three_budget_ok: bool
    all_continuity_ok: bool
    all_drift_ok: bool
    dependency_quorum_allowed: bool
    average_slippage: Decimal
    average_post_cost: Decimal
    post_cost_expectancy_aggregation: str
    runtime_ledger_sample_count: int
    runtime_ledger_filled_notional: Decimal
    runtime_ledger_net_strategy_pnl_after_costs: Decimal
    runtime_ledger_daily_summary: dict[str, Any]
    latest_observation_at: datetime
    import_window_start: datetime
    import_window_end: datetime


@dataclass(frozen=True)
class PromotionState:
    promotion_blocking_reasons: list[str]
    promotion_allowed: bool
    evidence_blocking_reasons: list[str]
    proof_blockers: list[dict[str, Any]]
    proof_status: str
    runtime_materialization_target: dict[str, Any]


@dataclass(frozen=True)
class PersistencePlan:
    request: PersistObservedRuntimeWindowsRequest
    context: ManifestContext
    buckets: BucketSet
    replacements: ReplacementCounts
    metrics: AggregateMetrics
    promotion: PromotionState


@dataclass(frozen=True)
class PersistedRows:
    metric_window_rows: list[StrategyHypothesisMetricWindow]
    runtime_ledger_rows: list[StrategyRuntimeLedgerBucket]
    promotion_decision_row: StrategyPromotionDecision


@dataclass(frozen=True)
class MaterializationUpdate:
    proof_status: str
    proof_blockers: Sequence[dict[str, Any]]
    materialization_blockers: Sequence[str]
    runtime_import_readback: Mapping[str, Any]
    profit_distance_readback: Mapping[str, Any]
