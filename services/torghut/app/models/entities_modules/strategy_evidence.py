"""SQLAlchemy ORM models for torghut."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, List, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..base import Base, GUID, JSONType

from .trading_records import (
    MARKET_SYMBOL_MAX_LENGTH,
    CreatedAtMixin,
    TimestampMixin,
)

if TYPE_CHECKING:
    from .whitepaper_content import (
        WhitepaperAnalysisRun,
        WhitepaperArtifact,
        WhitepaperContent,
    )


class VNextEmpiricalJobRun(Base, TimestampMixin):
    """Normalized empirical job records for parity and Janus evidence freshness."""

    __tablename__ = "vnext_empirical_job_runs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    job_name: Mapped[str] = mapped_column(String(length=128), nullable=False)
    job_type: Mapped[str] = mapped_column(String(length=64), nullable=False)
    job_run_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    authority: Mapped[str] = mapped_column(String(length=32), nullable=False)
    promotion_authority_eligible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    dataset_snapshot_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    artifact_refs: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_vnext_empirical_job_runs_run_id", "run_id"),
        Index("ix_vnext_empirical_job_runs_candidate_id", "candidate_id"),
        Index("ix_vnext_empirical_job_runs_job_type", "job_type"),
        Index(
            "uq_vnext_empirical_job_runs_job_run_id",
            "job_run_id",
            unique=True,
        ),
    )


class VNextCompletionGateResult(Base, TimestampMixin):
    """Traceable completion results for doc-scoped vNext gates."""

    __tablename__ = "vnext_completion_gate_results"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    gate_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    dataset_snapshot_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    git_revision: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    image_digest: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    workflow_name: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    artifact_ref: Mapped[Optional[str]] = mapped_column(
        String(length=1024), nullable=True
    )
    blocked_reason: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    details_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    measured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    __table_args__ = (
        Index("ix_vnext_completion_gate_results_gate_id", "gate_id"),
        Index("ix_vnext_completion_gate_results_run_id", "run_id"),
        Index("ix_vnext_completion_gate_results_candidate_id", "candidate_id"),
        Index("ix_vnext_completion_gate_results_status", "status"),
        Index(
            "uq_vnext_completion_gate_results_gate_run",
            "gate_id",
            "run_id",
            unique=True,
        ),
    )


class EvidenceReceiptRecord(Base, CreatedAtMixin):
    """Append-only receipt row for Torghut evidence epochs."""

    __tablename__ = "evidence_receipts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    receipt_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    evidence_epoch_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    receipt_type: Mapped[str] = mapped_column(String(length=64), nullable=False)
    producer: Mapped[str] = mapped_column(String(length=128), nullable=False)
    subject_ref: Mapped[str] = mapped_column(String(length=255), nullable=False)
    state: Mapped[str] = mapped_column(String(length=32), nullable=False)
    decision: Mapped[Optional[str]] = mapped_column(String(length=64), nullable=True)
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    fresh_until: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    reason_codes_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("uq_evidence_receipts_receipt_id", "receipt_id", unique=True),
        Index("ix_evidence_receipts_epoch_id", "evidence_epoch_id"),
        Index("ix_evidence_receipts_type_state", "receipt_type", "state"),
        Index("ix_evidence_receipts_fresh_until", "fresh_until"),
    )


class EvidenceEpochRecord(Base, CreatedAtMixin):
    """Append-only cross-plane evidence epoch row."""

    __tablename__ = "evidence_epochs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    evidence_epoch_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    stage_scope: Mapped[str] = mapped_column(String(length=32), nullable=False)
    decision: Mapped[str] = mapped_column(String(length=32), nullable=False)
    fresh_until: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    reason_codes_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    receipt_ids_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("uq_evidence_epochs_epoch_id", "evidence_epoch_id", unique=True),
        Index("ix_evidence_epochs_account_stage", "account_label", "stage_scope"),
        Index("ix_evidence_epochs_decision", "decision"),
        Index("ix_evidence_epochs_fresh_until", "fresh_until"),
    )


class RejectedSignalOutcomeEvent(Base, TimestampMixin):
    """Durable counterfactual-learning event for rejected trading signals."""

    __tablename__ = "rejected_signal_outcome_events"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    source: Mapped[str] = mapped_column(String(length=64), nullable=False)
    paper_source: Mapped[str] = mapped_column(String(length=128), nullable=False)
    paper_claim_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    symbol: Mapped[str] = mapped_column(
        String(length=MARKET_SYMBOL_MAX_LENGTH), nullable=False
    )
    event_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    timeframe: Mapped[str] = mapped_column(String(length=16), nullable=False)
    seq: Mapped[Optional[str]] = mapped_column(String(length=64), nullable=True)
    reject_reason: Mapped[str] = mapped_column(String(length=128), nullable=False)
    spread_bps: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    jump_bps: Mapped[Optional[Decimal]] = mapped_column(Numeric(20, 8), nullable=True)
    outcome_label_status: Mapped[str] = mapped_column(
        String(length=32), nullable=False, server_default=text("'pending'")
    )
    counterfactual_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    required_outcome_fields_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    event_payload_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    outcome_payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("uq_rejected_signal_outcome_events_event_id", "event_id", unique=True),
        Index(
            "ix_rejected_signal_outcome_events_status_ts",
            "outcome_label_status",
            "event_ts",
        ),
        Index(
            "ix_rejected_signal_outcome_events_account_symbol_ts",
            "account_label",
            "symbol",
            "event_ts",
        ),
        Index(
            "ix_rejected_signal_events_account_event_created",
            "account_label",
            "event_ts",
            "created_at",
        ),
        Index(
            "ix_rejected_signal_outcome_events_reason",
            "reject_reason",
        ),
    )


class StrategyHypothesis(Base, TimestampMixin):
    """Persistent hypothesis registry rows used for live capital governance."""

    __tablename__ = "strategy_hypotheses"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    hypothesis_id: Mapped[str] = mapped_column(
        String(length=128), nullable=False, unique=True
    )
    lane_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    strategy_family: Mapped[str] = mapped_column(String(length=128), nullable=False)
    source_manifest_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_strategy_hypotheses_hypothesis_id", "hypothesis_id"),
        Index("ix_strategy_hypotheses_strategy_family", "strategy_family"),
    )


class StrategyHypothesisVersion(Base, TimestampMixin):
    """Versioned hypothesis manifests loaded from source control."""

    __tablename__ = "strategy_hypothesis_versions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    hypothesis_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    version_key: Mapped[str] = mapped_column(String(length=128), nullable=False)
    source_manifest_ref: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_strategy_hypothesis_versions_hypothesis_id", "hypothesis_id"),
        Index(
            "uq_strategy_hypothesis_versions_hypothesis_version",
            "hypothesis_id",
            "version_key",
            unique=True,
        ),
    )


class StrategyHypothesisMetricWindow(Base, TimestampMixin):
    """Observed paper/live metric windows used to derive doc29 live gates."""

    __tablename__ = "strategy_hypothesis_metric_windows"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    hypothesis_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    observed_stage: Mapped[str] = mapped_column(String(length=32), nullable=False)
    window_started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    window_ended_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    market_session_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("1")
    )
    decision_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    trade_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    order_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    evidence_provenance: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    evidence_maturity: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    decision_alignment_ratio: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    avg_abs_slippage_bps: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    slippage_budget_bps: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    post_cost_expectancy_bps: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    continuity_ok: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    drift_ok: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    dependency_quorum_decision: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    capital_stage: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_strategy_hypothesis_metric_windows_run_id", "run_id"),
        Index("ix_strategy_hypothesis_metric_windows_candidate_id", "candidate_id"),
        Index("ix_strategy_hypothesis_metric_windows_hypothesis_id", "hypothesis_id"),
        Index("ix_strategy_hypothesis_metric_windows_observed_stage", "observed_stage"),
        Index(
            "ix_strategy_hypothesis_metric_windows_hypothesis_ended_created",
            "hypothesis_id",
            "window_ended_at",
            "created_at",
        ),
        Index(
            "ix_strategy_hyp_metric_windows_hyp_cand_window",
            "hypothesis_id",
            "candidate_id",
            "window_started_at",
            "window_ended_at",
            "created_at",
        ),
    )


class StrategyRuntimeLedgerBucket(Base, TimestampMixin):
    """Durable runtime-ledger PnL bucket used as promotion-grade profit proof."""

    __tablename__ = "strategy_runtime_ledger_buckets"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    hypothesis_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    observed_stage: Mapped[str] = mapped_column(String(length=32), nullable=False)
    bucket_started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    bucket_ended_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    account_label: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    runtime_strategy_name: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    strategy_family: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    fill_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    decision_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    submitted_order_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    cancelled_order_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    rejected_order_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    unfilled_order_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    closed_trade_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    open_position_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    filled_notional: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False, server_default=text("0")
    )
    gross_strategy_pnl: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False, server_default=text("0")
    )
    cost_amount: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False, server_default=text("0")
    )
    net_strategy_pnl_after_costs: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False, server_default=text("0")
    )
    post_cost_expectancy_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    ledger_schema_version: Mapped[str] = mapped_column(
        String(length=64), nullable=False
    )
    pnl_basis: Mapped[str] = mapped_column(String(length=64), nullable=False)
    execution_policy_hash_counts: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    cost_model_hash_counts: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    lineage_hash_counts: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    blockers_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_strategy_runtime_ledger_buckets_run_id", "run_id"),
        Index("ix_strategy_runtime_ledger_buckets_hypothesis_id", "hypothesis_id"),
        Index("ix_strategy_runtime_ledger_buckets_candidate_id", "candidate_id"),
        Index(
            "ix_strategy_runtime_ledger_buckets_hypothesis_ended_created",
            "hypothesis_id",
            "bucket_ended_at",
            "created_at",
        ),
        Index(
            "ix_strategy_runtime_ledger_buckets_hyp_run_cand_stage_ended",
            "hypothesis_id",
            "run_id",
            "candidate_id",
            "observed_stage",
            "bucket_ended_at",
            "created_at",
        ),
        Index(
            "ix_strategy_runtime_ledger_buckets_account_stage_ended",
            "account_label",
            "observed_stage",
            "bucket_ended_at",
            "created_at",
        ),
        Index(
            "ix_runtime_ledger_bucket_audit_lookup",
            "hypothesis_id",
            "candidate_id",
            "observed_stage",
            "account_label",
            "strategy_family",
            "bucket_ended_at",
            "created_at",
        ),
        Index(
            "ix_strategy_runtime_ledger_buckets_stage_started",
            "observed_stage",
            "bucket_started_at",
        ),
    )


class StrategyCapitalAllocation(Base, TimestampMixin):
    """Capital-band transitions for each hypothesis lane."""

    __tablename__ = "strategy_capital_allocations"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    hypothesis_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    prior_stage: Mapped[Optional[str]] = mapped_column(String(length=32), nullable=True)
    stage: Mapped[str] = mapped_column(String(length=32), nullable=False)
    capital_multiplier: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    rollback_target_stage: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_strategy_capital_allocations_run_id", "run_id"),
        Index("ix_strategy_capital_allocations_candidate_id", "candidate_id"),
        Index("ix_strategy_capital_allocations_hypothesis_id", "hypothesis_id"),
    )


class StrategyPromotionDecision(Base, TimestampMixin):
    """Persisted promotion decisions scoped to hypothesis and target stage."""

    __tablename__ = "strategy_promotion_decisions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    candidate_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    hypothesis_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    promotion_target: Mapped[str] = mapped_column(String(length=16), nullable=False)
    state: Mapped[Optional[str]] = mapped_column(String(length=32), nullable=True)
    allowed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    reason_summary: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_strategy_promotion_decisions_run_id", "run_id"),
        Index("ix_strategy_promotion_decisions_candidate_id", "candidate_id"),
        Index("ix_strategy_promotion_decisions_hypothesis_id", "hypothesis_id"),
        Index(
            "ix_strategy_promotion_decisions_hypothesis_created",
            "hypothesis_id",
            "created_at",
        ),
        Index(
            "uq_strategy_promotion_decisions_run_hypothesis_target",
            "run_id",
            "hypothesis_id",
            "promotion_target",
            unique=True,
        ),
    )


class WhitepaperDocument(Base, TimestampMixin):
    """Logical whitepaper record with source metadata and lifecycle status."""

    __tablename__ = "whitepaper_documents"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    document_key: Mapped[str] = mapped_column(
        String(length=64),
        nullable=False,
        unique=True,
        default=lambda: f"wp-{uuid.uuid4().hex[:24]}",
    )
    source: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="upload",
        server_default=text("'upload'"),
    )
    source_identifier: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    title: Mapped[Optional[str]] = mapped_column(String(length=512), nullable=True)
    abstract: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    authors_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    published_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    language: Mapped[str] = mapped_column(
        String(length=16),
        nullable=False,
        default="en",
        server_default=text("'en'"),
    )
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="uploaded",
        server_default=text("'uploaded'"),
    )
    tags_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    ingested_by: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    last_processed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    versions: Mapped[List["WhitepaperDocumentVersion"]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )
    analysis_runs: Mapped[List["WhitepaperAnalysisRun"]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )
    artifacts: Mapped[List["WhitepaperArtifact"]] = relationship(
        back_populates="document"
    )

    __table_args__ = (
        Index("ix_whitepaper_documents_status", "status"),
        Index("ix_whitepaper_documents_source", "source"),
        Index(
            "uq_whitepaper_documents_source_identifier",
            "source",
            "source_identifier",
            unique=True,
        ),
    )


class WhitepaperDocumentVersion(Base, TimestampMixin):
    """Concrete uploaded file revision and extraction bookkeeping."""

    __tablename__ = "whitepaper_document_versions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    version_number: Mapped[int] = mapped_column(BigInteger, nullable=False)
    trigger_reason: Mapped[str] = mapped_column(
        String(length=64),
        nullable=False,
        default="upload",
        server_default=text("'upload'"),
    )
    file_name: Mapped[Optional[str]] = mapped_column(String(length=512), nullable=True)
    mime_type: Mapped[str] = mapped_column(
        String(length=128),
        nullable=False,
        default="application/pdf",
        server_default=text("'application/pdf'"),
    )
    file_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    checksum_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    ceph_bucket: Mapped[str] = mapped_column(String(length=128), nullable=False)
    ceph_object_key: Mapped[str] = mapped_column(String(length=1024), nullable=False)
    ceph_etag: Mapped[Optional[str]] = mapped_column(String(length=128), nullable=True)
    parse_status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="pending",
        server_default=text("'pending'"),
    )
    parse_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    page_count: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    char_count: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    token_count: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    language: Mapped[Optional[str]] = mapped_column(String(length=16), nullable=True)
    upload_metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    extraction_metadata_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    uploaded_by: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    processed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    document: Mapped[WhitepaperDocument] = relationship(back_populates="versions")
    content: Mapped[Optional["WhitepaperContent"]] = relationship(
        back_populates="document_version",
        uselist=False,
        cascade="all, delete-orphan",
    )
    analysis_runs: Mapped[List["WhitepaperAnalysisRun"]] = relationship(
        back_populates="document_version", cascade="all, delete-orphan"
    )
    artifacts: Mapped[List["WhitepaperArtifact"]] = relationship(
        back_populates="document_version"
    )

    __table_args__ = (
        Index("ix_whitepaper_document_versions_document_id", "document_id"),
        Index("ix_whitepaper_document_versions_parse_status", "parse_status"),
        Index("ix_whitepaper_document_versions_checksum", "checksum_sha256"),
        Index(
            "uq_whitepaper_document_versions_document_version",
            "document_id",
            "version_number",
            unique=True,
        ),
        Index(
            "uq_whitepaper_document_versions_ceph_object",
            "ceph_bucket",
            "ceph_object_key",
            unique=True,
        ),
    )
