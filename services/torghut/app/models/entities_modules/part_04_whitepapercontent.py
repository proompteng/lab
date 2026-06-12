# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""SQLAlchemy ORM models for torghut."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, List, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy import func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..base import Base, GUID, JSONType

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_28 import *
from .part_02_researchrun import *
from .part_03_vnextempiricaljobrun import *


class WhitepaperContent(Base, CreatedAtMixin):
    """Normalized full-text representation used by synthesis/viability agents."""

    __tablename__ = "whitepaper_contents"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    document_version_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_document_versions.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    text_source: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="pdf_extract",
        server_default=text("'pdf_extract'"),
    )
    full_text: Mapped[str] = mapped_column(Text, nullable=False)
    full_text_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    section_index_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    references_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    tables_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    figures_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    chunk_manifest_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    extraction_warnings_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    quality_score: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(6, 4), nullable=True
    )

    document_version: Mapped[WhitepaperDocumentVersion] = relationship(
        back_populates="content"
    )

    __table_args__ = (
        Index("ix_whitepaper_contents_full_text_sha256", "full_text_sha256"),
    )


class WhitepaperAnalysisRun(Base, TimestampMixin):
    """Workflow-level execution record for Inngest-driven whitepaper processing."""

    __tablename__ = "whitepaper_analysis_runs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False, unique=True)
    document_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    document_version_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_document_versions.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="queued",
        server_default=text("'queued'"),
    )
    trigger_source: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="upload",
        server_default=text("'upload'"),
    )
    trigger_actor: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    retry_of_run_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    inngest_event_id: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    inngest_function_id: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    inngest_run_id: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True, unique=True
    )
    orchestration_context_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    analysis_profile_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    request_payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    result_payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    failure_code: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    failure_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    document: Mapped[WhitepaperDocument] = relationship(back_populates="analysis_runs")
    document_version: Mapped[WhitepaperDocumentVersion] = relationship(
        back_populates="analysis_runs"
    )
    steps: Mapped[List["WhitepaperAnalysisStep"]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )
    codex_agentruns: Mapped[List["WhitepaperCodexAgentRun"]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )
    synthesis: Mapped[Optional["WhitepaperSynthesis"]] = relationship(
        back_populates="analysis_run",
        uselist=False,
        cascade="all, delete-orphan",
    )
    viability_verdict: Mapped[Optional["WhitepaperViabilityVerdict"]] = relationship(
        back_populates="analysis_run",
        uselist=False,
        cascade="all, delete-orphan",
    )
    design_pull_requests: Mapped[List["WhitepaperDesignPullRequest"]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )
    engineering_trigger: Mapped[Optional["WhitepaperEngineeringTrigger"]] = (
        relationship(
            back_populates="analysis_run",
            uselist=False,
            cascade="all, delete-orphan",
        )
    )
    claims: Mapped[List["WhitepaperClaim"]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )
    claim_relations: Mapped[List["WhitepaperClaimRelation"]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )
    strategy_templates: Mapped[List["WhitepaperStrategyTemplate"]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )
    experiment_specs: Mapped[List["WhitepaperExperimentSpec"]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )
    contradiction_events: Mapped[List["WhitepaperContradictionEvent"]] = relationship(
        back_populates="analysis_run", cascade="all, delete-orphan"
    )
    artifacts: Mapped[List["WhitepaperArtifact"]] = relationship(
        back_populates="analysis_run"
    )

    __table_args__ = (
        Index("ix_whitepaper_analysis_runs_status", "status"),
        Index("ix_whitepaper_analysis_runs_document_id", "document_id"),
        Index("ix_whitepaper_analysis_runs_document_version_id", "document_version_id"),
        Index("ix_whitepaper_analysis_runs_inngest_event_id", "inngest_event_id"),
        Index("ix_whitepaper_analysis_runs_created_at", "created_at"),
    )


class WhitepaperAnalysisStep(Base, TimestampMixin):
    """Stage-level audit rows for each Inngest workflow step attempt."""

    __tablename__ = "whitepaper_analysis_steps"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    step_name: Mapped[str] = mapped_column(String(length=64), nullable=False)
    step_order: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default=text("0")
    )
    attempt: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=1, server_default=text("1")
    )
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="queued",
        server_default=text("'queued'"),
    )
    executor: Mapped[Optional[str]] = mapped_column(String(length=64), nullable=True)
    idempotency_key: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    trace_id: Mapped[Optional[str]] = mapped_column(String(length=128), nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    duration_ms: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    input_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    output_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    error_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(back_populates="steps")
    codex_agentruns: Mapped[List["WhitepaperCodexAgentRun"]] = relationship(
        back_populates="analysis_step"
    )

    __table_args__ = (
        Index("ix_whitepaper_analysis_steps_run_id", "analysis_run_id"),
        Index("ix_whitepaper_analysis_steps_step_name", "step_name"),
        Index("ix_whitepaper_analysis_steps_status", "status"),
        Index(
            "uq_whitepaper_analysis_steps_run_step_attempt",
            "analysis_run_id",
            "step_name",
            "attempt",
            unique=True,
        ),
    )


class WhitepaperCodexAgentRun(Base, TimestampMixin):
    """AgentRun execution context for Codex whitepaper analysis against repo state."""

    __tablename__ = "whitepaper_codex_agentruns"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    analysis_step_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_steps.id", ondelete="SET NULL"),
        nullable=True,
    )
    agentrun_name: Mapped[str] = mapped_column(
        String(length=128), nullable=False, unique=True
    )
    agentrun_namespace: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    agentrun_uid: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="queued",
        server_default=text("'queued'"),
    )
    execution_mode: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="default",
        server_default=text("'default'"),
    )
    requested_by: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    codex_session_id: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    vcs_provider: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    vcs_repository: Mapped[Optional[str]] = mapped_column(
        String(length=255), nullable=True
    )
    vcs_base_branch: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    vcs_head_branch: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    vcs_base_commit_sha: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    vcs_head_commit_sha: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    workspace_context_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    prompt_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    prompt_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    input_context_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    output_context_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    patch_artifact_ref: Mapped[Optional[str]] = mapped_column(
        String(length=512), nullable=True
    )
    log_artifact_ref: Mapped[Optional[str]] = mapped_column(
        String(length=512), nullable=True
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failure_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="codex_agentruns"
    )
    analysis_step: Mapped[Optional[WhitepaperAnalysisStep]] = relationship(
        back_populates="codex_agentruns"
    )
    design_pull_requests: Mapped[List["WhitepaperDesignPullRequest"]] = relationship(
        back_populates="codex_agentrun"
    )

    __table_args__ = (
        Index("ix_whitepaper_codex_agentruns_run_id", "analysis_run_id"),
        Index("ix_whitepaper_codex_agentruns_status", "status"),
        Index("ix_whitepaper_codex_agentruns_codex_session_id", "codex_session_id"),
        Index("ix_whitepaper_codex_agentruns_head_branch", "vcs_head_branch"),
    )


class WhitepaperSynthesis(Base, TimestampMixin):
    """Structured synthesis payload generated by Codex from full paper context."""

    __tablename__ = "whitepaper_syntheses"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    synthesis_version: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="v1",
        server_default=text("'v1'"),
    )
    generated_by: Mapped[str] = mapped_column(
        String(length=64),
        nullable=False,
        default="codex",
        server_default=text("'codex'"),
    )
    model_name: Mapped[Optional[str]] = mapped_column(String(length=128), nullable=True)
    prompt_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    executive_summary: Mapped[str] = mapped_column(Text, nullable=False)
    problem_statement: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    methodology_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    key_findings_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    novelty_claims_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    risk_assessment_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    citations_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    implementation_plan_md: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    confidence: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 4), nullable=True)
    synthesis_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="synthesis"
    )
    artifacts: Mapped[List["WhitepaperArtifact"]] = relationship(
        back_populates="synthesis"
    )

    __table_args__ = (Index("ix_whitepaper_syntheses_generated_by", "generated_by"),)


class WhitepaperViabilityVerdict(Base, TimestampMixin):
    """Final viability decision and policy evidence for a whitepaper analysis run."""

    __tablename__ = "whitepaper_viability_verdicts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    verdict: Mapped[str] = mapped_column(String(length=32), nullable=False)
    score: Mapped[Optional[Decimal]] = mapped_column(Numeric(8, 4), nullable=True)
    confidence: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 4), nullable=True)
    decision_policy: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    gating_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    rationale: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    rejection_reasons_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    recommendations_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    requires_followup: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=func.false(),
    )
    approved_by: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    approved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="viability_verdict"
    )
    artifacts: Mapped[List["WhitepaperArtifact"]] = relationship(
        back_populates="viability_verdict"
    )
    engineering_triggers: Mapped[List["WhitepaperEngineeringTrigger"]] = relationship(
        back_populates="viability_verdict"
    )

    __table_args__ = (
        Index("ix_whitepaper_viability_verdicts_verdict", "verdict"),
        Index(
            "ix_whitepaper_viability_verdicts_requires_followup", "requires_followup"
        ),
    )


class WhitepaperDesignPullRequest(Base, TimestampMixin):
    """Design-document pull request metadata generated from whitepaper analysis."""

    __tablename__ = "whitepaper_design_pull_requests"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    codex_agentrun_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_codex_agentruns.id", ondelete="SET NULL"),
        nullable=True,
    )
    attempt: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=1, server_default=text("1")
    )
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="draft",
        server_default=text("'draft'"),
    )
    repository: Mapped[str] = mapped_column(String(length=255), nullable=False)
    base_branch: Mapped[str] = mapped_column(String(length=128), nullable=False)
    head_branch: Mapped[str] = mapped_column(String(length=128), nullable=False)
    pr_number: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    pr_url: Mapped[Optional[str]] = mapped_column(String(length=512), nullable=True)
    title: Mapped[Optional[str]] = mapped_column(String(length=512), nullable=True)
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    commit_sha: Mapped[Optional[str]] = mapped_column(String(length=128), nullable=True)
    merge_commit_sha: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    checks_url: Mapped[Optional[str]] = mapped_column(String(length=512), nullable=True)
    ci_status: Mapped[Optional[str]] = mapped_column(String(length=32), nullable=True)
    is_merged: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=func.false(),
    )
    merged_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="design_pull_requests"
    )
    codex_agentrun: Mapped[Optional[WhitepaperCodexAgentRun]] = relationship(
        back_populates="design_pull_requests"
    )
    artifacts: Mapped[List["WhitepaperArtifact"]] = relationship(
        back_populates="design_pull_request"
    )

    __table_args__ = (
        Index("ix_whitepaper_design_pull_requests_status", "status"),
        Index("ix_whitepaper_design_pull_requests_pr_number", "pr_number"),
        Index("ix_whitepaper_design_pull_requests_merged", "is_merged"),
        Index(
            "uq_whitepaper_design_pull_requests_run_attempt",
            "analysis_run_id",
            "attempt",
            unique=True,
        ),
    )


class WhitepaperArtifact(Base, CreatedAtMixin):
    """Normalized artifact ledger for Ceph/S3 objects and derived outputs."""

    __tablename__ = "whitepaper_artifacts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    document_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_documents.id", ondelete="SET NULL"),
        nullable=True,
    )
    document_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_document_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    analysis_run_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="SET NULL"),
        nullable=True,
    )
    synthesis_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_syntheses.id", ondelete="SET NULL"),
        nullable=True,
    )
    viability_verdict_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_viability_verdicts.id", ondelete="SET NULL"),
        nullable=True,
    )
    design_pull_request_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_design_pull_requests.id", ondelete="SET NULL"),
        nullable=True,
    )
    artifact_scope: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="run",
        server_default=text("'run'"),
    )
    artifact_type: Mapped[str] = mapped_column(String(length=64), nullable=False)
    artifact_role: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    ceph_bucket: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    ceph_object_key: Mapped[Optional[str]] = mapped_column(
        String(length=1024), nullable=True
    )
    artifact_uri: Mapped[Optional[str]] = mapped_column(
        String(length=1024), nullable=True
    )
    checksum_sha256: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    content_type: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    document: Mapped[Optional[WhitepaperDocument]] = relationship(
        back_populates="artifacts"
    )
    document_version: Mapped[Optional[WhitepaperDocumentVersion]] = relationship(
        back_populates="artifacts"
    )
    analysis_run: Mapped[Optional[WhitepaperAnalysisRun]] = relationship(
        back_populates="artifacts"
    )
    synthesis: Mapped[Optional[WhitepaperSynthesis]] = relationship(
        back_populates="artifacts"
    )
    viability_verdict: Mapped[Optional[WhitepaperViabilityVerdict]] = relationship(
        back_populates="artifacts"
    )
    design_pull_request: Mapped[Optional[WhitepaperDesignPullRequest]] = relationship(
        back_populates="artifacts"
    )

    __table_args__ = (
        Index("ix_whitepaper_artifacts_artifact_type", "artifact_type"),
        Index("ix_whitepaper_artifacts_analysis_run_id", "analysis_run_id"),
        Index("ix_whitepaper_artifacts_document_version_id", "document_version_id"),
        Index(
            "uq_whitepaper_artifacts_ceph_object",
            "ceph_bucket",
            "ceph_object_key",
            unique=True,
        ),
    )


class WhitepaperClaim(Base, TimestampMixin):
    """Structured whitepaper claim cards extracted from a completed analysis run."""

    __tablename__ = "whitepaper_claims"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    claim_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    claim_type: Mapped[str] = mapped_column(String(length=64), nullable=False)
    claim_text: Mapped[str] = mapped_column(Text, nullable=False)
    asset_scope: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    horizon_scope: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    data_requirements_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    expected_direction: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    required_activity_conditions_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    liquidity_constraints_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    validation_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    confidence: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 4), nullable=True)
    metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(back_populates="claims")

    __table_args__ = (
        Index("ix_whitepaper_claims_run_id", "analysis_run_id"),
        Index("ix_whitepaper_claims_type", "claim_type"),
        Index("ix_whitepaper_claims_asset_scope", "asset_scope"),
        Index(
            "uq_whitepaper_claims_run_claim_id",
            "analysis_run_id",
            "claim_id",
            unique=True,
        ),
    )


class WhitepaperClaimRelation(Base, TimestampMixin):
    """Relations between extracted whitepaper claims."""

    __tablename__ = "whitepaper_claim_relations"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    relation_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    relation_type: Mapped[str] = mapped_column(String(length=64), nullable=False)
    source_claim_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    target_claim_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    target_run_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    rationale: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    confidence: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 4), nullable=True)
    metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="claim_relations"
    )

    __table_args__ = (
        Index("ix_whitepaper_claim_relations_run_id", "analysis_run_id"),
        Index("ix_whitepaper_claim_relations_type", "relation_type"),
        Index("ix_whitepaper_claim_relations_source", "source_claim_id"),
        Index("ix_whitepaper_claim_relations_target", "target_claim_id"),
        Index(
            "uq_whitepaper_claim_relations_run_relation_id",
            "analysis_run_id",
            "relation_id",
            unique=True,
        ),
    )


__all__ = [name for name in globals() if not name.startswith("__")]
