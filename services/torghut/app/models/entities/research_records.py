"""SQLAlchemy ORM models for torghut."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Index,
    Numeric,
    String,
    Text,
    text,
)
from sqlalchemy import func
from sqlalchemy.orm import Mapped, mapped_column

from ..base import Base, GUID, JSONType


from .trading_records import CreatedAtMixin, TimestampMixin


class ResearchRun(Base, TimestampMixin):
    """Durable research execution metadata for autonomous lane runs."""

    __tablename__ = "research_runs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="running",
        server_default=text("'running'"),
    )
    strategy_id: Mapped[Optional[str]] = mapped_column(String(length=64), nullable=True)
    strategy_name: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    strategy_type: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    strategy_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    code_commit: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    feature_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    feature_schema_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    feature_spec_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    signal_source: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    dataset_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    dataset_from: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    dataset_to: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    dataset_snapshot_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    runner_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    runner_binary_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    gate_report_trace_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    recommendation_trace_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    discovery_mode: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    generator_family: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    grammar_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    search_budget: Mapped[Optional[int]] = mapped_column(BigInteger(), nullable=True)
    selection_protocol_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    pilot_program_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    kill_criteria_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )

    __table_args__ = (
        Index("ix_research_runs_status", "status"),
        Index("ix_research_runs_created_at", "created_at"),
        Index("ix_research_runs_gate_trace", "gate_report_trace_id"),
        Index("ix_research_runs_recommendation_trace", "recommendation_trace_id"),
        Index("ix_research_runs_discovery_mode", "discovery_mode"),
        Index("ix_research_runs_generator_family", "generator_family"),
    )


class ResearchCandidate(Base, CreatedAtMixin):
    """Candidate metadata selected by an autonomous research lane."""

    __tablename__ = "research_candidates"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[str] = mapped_column(
        String(length=64), nullable=False, unique=True
    )
    candidate_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    parameter_set: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    decision_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    trade_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    symbols_covered: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    universe_definition: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    promotion_target: Mapped[Optional[str]] = mapped_column(
        String(length=16), nullable=True
    )
    lifecycle_role: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="challenger",
        server_default=text("'challenger'"),
    )
    lifecycle_status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="evaluated",
        server_default=text("'evaluated'"),
    )
    metadata_bundle: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    recommendation_bundle: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    candidate_family: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    canonical_spec: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    semantic_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    economic_rationale: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    complexity_score: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    discovery_rank: Mapped[Optional[int]] = mapped_column(BigInteger(), nullable=True)
    posterior_edge_summary: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    economic_validity_card: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    valid_regime_envelope: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    invalidation_clauses: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    null_comparator_summary: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )

    __table_args__ = (
        Index("ix_research_candidates_run_id", "run_id"),
        Index("ix_research_candidates_candidate_id", "candidate_id"),
        Index("ix_research_candidates_lifecycle_role", "lifecycle_role"),
        Index("ix_research_candidates_lifecycle_status", "lifecycle_status"),
        Index("ix_research_candidates_family", "candidate_family"),
        Index("ix_research_candidates_semantic_hash", "semantic_hash"),
    )


class ResearchFoldMetrics(Base, CreatedAtMixin):
    """Fold-level metric records for offline robustness checks."""

    __tablename__ = "research_fold_metrics"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    candidate_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    fold_name: Mapped[str] = mapped_column(String(length=128), nullable=False)
    fold_order: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    train_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    train_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    test_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    test_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    decision_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    trade_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    gross_pnl: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    net_pnl: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    max_drawdown: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    turnover_ratio: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    cost_bps: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    cost_assumptions: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    regime_label: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    stat_bundle: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    purge_window: Mapped[Optional[int]] = mapped_column(BigInteger(), nullable=True)
    embargo_window: Mapped[Optional[int]] = mapped_column(BigInteger(), nullable=True)
    feature_availability_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )

    __table_args__ = (
        Index("ix_research_fold_metrics_candidate", "candidate_id"),
        Index("ix_research_fold_metrics_fold_order", "fold_order"),
    )


class ResearchAttempt(Base, CreatedAtMixin):
    """Attempt ledger rows for search-space provenance."""

    __tablename__ = "research_attempts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[str] = mapped_column(
        String(length=64), nullable=False, unique=True
    )
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    generator_family: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    attempt_stage: Mapped[str] = mapped_column(String(length=64), nullable=False)
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    reason_codes: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    artifact_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    metadata_bundle: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_research_attempts_run_id", "run_id"),
        Index("ix_research_attempts_stage", "attempt_stage"),
        Index("ix_research_attempts_status", "status"),
        Index("ix_research_attempts_generator_family", "generator_family"),
    )


class ResearchValidationTest(Base, CreatedAtMixin):
    """Validation battery results for research candidates."""

    __tablename__ = "research_validation_tests"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    candidate_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    test_name: Mapped[str] = mapped_column(String(length=64), nullable=False)
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    metric_bundle: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    artifact_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_research_validation_tests_candidate", "candidate_id"),
        Index("ix_research_validation_tests_name", "test_name"),
        Index("ix_research_validation_tests_status", "status"),
        Index(
            "uq_research_validation_tests_candidate_name",
            "candidate_id",
            "test_name",
            unique=True,
        ),
    )


class ResearchSequentialTrial(Base, CreatedAtMixin):
    """Sequential promotion state bridging offline and paper/live evaluation."""

    __tablename__ = "research_sequential_trials"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    candidate_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    trial_stage: Mapped[str] = mapped_column(String(length=32), nullable=False)
    account: Mapped[str] = mapped_column(String(length=64), nullable=False)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_update_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    sample_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    confidence_sequence_lower: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    confidence_sequence_upper: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    posterior_edge_mean: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    posterior_edge_lower: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    reason_codes: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_research_sequential_trials_candidate", "candidate_id"),
        Index("ix_research_sequential_trials_stage", "trial_stage"),
        Index("ix_research_sequential_trials_status", "status"),
        Index(
            "uq_research_sequential_trials_candidate_stage_account",
            "candidate_id",
            "trial_stage",
            "account",
            unique=True,
        ),
    )


class ResearchCostCalibration(Base, CreatedAtMixin):
    """Scope-specific execution cost calibration records."""

    __tablename__ = "research_cost_calibrations"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    calibration_id: Mapped[str] = mapped_column(
        String(length=64), nullable=False, unique=True
    )
    scope_type: Mapped[str] = mapped_column(String(length=64), nullable=False)
    scope_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    window_start: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    window_end: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    modeled_slippage_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    realized_slippage_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    modeled_shortfall_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    realized_shortfall_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    calibration_error_bundle: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_research_cost_calibrations_scope", "scope_type", "scope_id"),
        Index("ix_research_cost_calibrations_status", "status"),
        Index("ix_research_cost_calibrations_computed_at", "computed_at"),
    )


class ResearchStressMetrics(Base, CreatedAtMixin):
    """Stress-case and resilience metrics for robustness checks."""

    __tablename__ = "research_stress_metrics"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    candidate_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    stress_case: Mapped[str] = mapped_column(String(length=64), nullable=False)
    metric_bundle: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    pessimistic_pnl_delta: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )

    __table_args__ = (
        Index("ix_research_stress_metrics_candidate", "candidate_id"),
        Index("ix_research_stress_metrics_case", "stress_case"),
    )


class ResearchPromotion(Base, CreatedAtMixin):
    """Promotion request/decision audit rows for research candidates."""

    __tablename__ = "research_promotions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    candidate_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    requested_mode: Mapped[Optional[str]] = mapped_column(
        String(length=16), nullable=True
    )
    approved_mode: Mapped[Optional[str]] = mapped_column(
        String(length=16), nullable=True
    )
    approver: Mapped[Optional[str]] = mapped_column(String(length=128), nullable=True)
    approver_role: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    approve_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    deny_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    paper_candidate_patch_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    effective_time: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decision_action: Mapped[str] = mapped_column(
        String(length=32), nullable=False, default="hold", server_default=text("'hold'")
    )
    decision_rationale: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    evidence_bundle: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    recommendation_trace_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    successor_candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    rollback_candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )

    __table_args__ = (
        Index("ix_research_promotions_candidate", "candidate_id"),
        Index("ix_research_promotions_requested_mode", "requested_mode"),
        Index("ix_research_promotions_approved_mode", "approved_mode"),
        Index("ix_research_promotions_action", "decision_action"),
        Index("ix_research_promotions_recommendation_trace", "recommendation_trace_id"),
    )


class VNextDatasetSnapshot(Base, TimestampMixin):
    """Normalized dataset snapshot records for vNext research/promotion evidence."""

    __tablename__ = "vnext_dataset_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    dataset_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    source: Mapped[str] = mapped_column(String(length=64), nullable=False)
    dataset_version: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    dataset_from: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    dataset_to: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    artifact_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_dataset_snapshots_run_id", "run_id"),
        Index("ix_vnext_dataset_snapshots_candidate_id", "candidate_id"),
        Index("ix_vnext_dataset_snapshots_dataset_id", "dataset_id"),
        Index(
            "uq_vnext_dataset_snapshots_run_dataset_id",
            "run_id",
            "dataset_id",
            unique=True,
        ),
    )


class VNextFeatureViewSpec(Base, TimestampMixin):
    """Normalized feature view specs referenced by a vNext candidate."""

    __tablename__ = "vnext_feature_view_specs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    strategy_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    feature_view_spec_ref: Mapped[str] = mapped_column(
        String(length=255), nullable=False
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_feature_view_specs_run_id", "run_id"),
        Index("ix_vnext_feature_view_specs_candidate_id", "candidate_id"),
        Index("ix_vnext_feature_view_specs_strategy_id", "strategy_id"),
        Index(
            "uq_vnext_feature_view_specs_candidate_strategy",
            "candidate_id",
            "strategy_id",
            unique=True,
        ),
    )


class VNextModelArtifact(Base, TimestampMixin):
    """Normalized model/rule artifacts behind a compiled vNext strategy."""

    __tablename__ = "vnext_model_artifacts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    strategy_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    artifact_ref: Mapped[str] = mapped_column(String(length=255), nullable=False)
    artifact_kind: Mapped[str] = mapped_column(String(length=64), nullable=False)
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_model_artifacts_run_id", "run_id"),
        Index("ix_vnext_model_artifacts_candidate_id", "candidate_id"),
        Index("ix_vnext_model_artifacts_strategy_id", "strategy_id"),
        Index(
            "uq_vnext_model_artifacts_candidate_strategy_ref",
            "candidate_id",
            "strategy_id",
            "artifact_ref",
            unique=True,
        ),
    )


class VNextExperimentSpec(Base, TimestampMixin):
    """Normalized typed experiment spec records for vNext research automation."""

    __tablename__ = "vnext_experiment_specs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    experiment_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_experiment_specs_run_id", "run_id"),
        Index("ix_vnext_experiment_specs_candidate_id", "candidate_id"),
        Index("ix_vnext_experiment_specs_experiment_id", "experiment_id"),
        Index(
            "uq_vnext_experiment_specs_candidate_experiment",
            "candidate_id",
            "experiment_id",
            unique=True,
        ),
    )


class VNextExperimentRun(Base, TimestampMixin):
    """Normalized experiment-run lineage records for vNext research execution."""

    __tablename__ = "vnext_experiment_runs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    experiment_id: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    stage_lineage_root: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_experiment_runs_run_id", "run_id"),
        Index("ix_vnext_experiment_runs_candidate_id", "candidate_id"),
        Index("ix_vnext_experiment_runs_experiment_id", "experiment_id"),
        Index(
            "uq_vnext_experiment_runs_candidate_run",
            "candidate_id",
            "run_id",
            unique=True,
        ),
    )


class VNextSimulationCalibration(Base, TimestampMixin):
    """Normalized simulator calibration evidence for vNext promotion."""

    __tablename__ = "vnext_simulation_calibrations"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    artifact_ref: Mapped[str] = mapped_column(String(length=255), nullable=False)
    status: Mapped[Optional[str]] = mapped_column(String(length=64), nullable=True)
    order_count: Mapped[Optional[int]] = mapped_column(BigInteger(), nullable=True)
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_simulation_calibrations_run_id", "run_id"),
        Index("ix_vnext_simulation_calibrations_candidate_id", "candidate_id"),
        Index(
            "uq_vnext_simulation_calibrations_candidate_artifact",
            "candidate_id",
            "artifact_ref",
            unique=True,
        ),
    )


class VNextShadowLiveDeviation(Base, TimestampMixin):
    """Normalized shadow/live deviation evidence for vNext promotion."""

    __tablename__ = "vnext_shadow_live_deviations"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    artifact_ref: Mapped[str] = mapped_column(String(length=255), nullable=False)
    status: Mapped[Optional[str]] = mapped_column(String(length=64), nullable=True)
    order_count: Mapped[Optional[int]] = mapped_column(BigInteger(), nullable=True)
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_shadow_live_deviations_run_id", "run_id"),
        Index("ix_vnext_shadow_live_deviations_candidate_id", "candidate_id"),
        Index(
            "uq_vnext_shadow_live_deviations_candidate_artifact",
            "candidate_id",
            "artifact_ref",
            unique=True,
        ),
    )


class VNextPromotionDecision(Base, TimestampMixin):
    """Normalized promotion decision rows for vNext portfolio-aware governance."""

    __tablename__ = "vnext_promotion_decisions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    promotion_target: Mapped[str] = mapped_column(String(length=16), nullable=False)
    recommended_mode: Mapped[Optional[str]] = mapped_column(
        String(length=16), nullable=True
    )
    decision_action: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    allowed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    gate_report_trace_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    recommendation_trace_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_promotion_decisions_run_id", "run_id"),
        Index("ix_vnext_promotion_decisions_candidate_id", "candidate_id"),
        Index("ix_vnext_promotion_decisions_target", "promotion_target"),
        Index(
            "uq_vnext_promotion_decisions_candidate_target",
            "candidate_id",
            "promotion_target",
            unique=True,
        ),
    )
