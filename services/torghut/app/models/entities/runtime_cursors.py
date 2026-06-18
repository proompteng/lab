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
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..base import Base, GUID, JSONType


from .trading_records import CreatedAtMixin, TimestampMixin, TradeDecision


class TradeCursor(Base, TimestampMixin):
    """Cursor for signal ingestion progress tracking."""

    __tablename__ = "trade_cursor"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(length=64), nullable=False)
    account_label: Mapped[str] = mapped_column(
        String(length=64), nullable=False, server_default=text("'paper'")
    )
    cursor_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    cursor_seq: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    cursor_symbol: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )

    __table_args__ = (
        Index("uq_trade_cursor_source_account", "source", "account_label", unique=True),
    )


class SimulationRuntimeContext(Base, TimestampMixin):
    """Explicit simulation runtime context keyed by lane + account label."""

    __tablename__ = "simulation_runtime_context"

    lane: Mapped[str] = mapped_column(String(length=32), primary_key=True)
    account_label: Mapped[str] = mapped_column(String(length=64), primary_key=True)
    run_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    dataset_id: Mapped[Optional[str]] = mapped_column(String(length=128), nullable=True)
    window_start: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    window_end: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cache_key: Mapped[Optional[str]] = mapped_column(String(length=128), nullable=True)
    cache_artifact_path: Mapped[Optional[str]] = mapped_column(
        String(length=512), nullable=True
    )
    cache_manifest_path: Mapped[Optional[str]] = mapped_column(
        String(length=512), nullable=True
    )
    warm_lane_enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=text("false"),
    )
    metadata_json: Mapped[Any] = mapped_column(
        JSONType,
        nullable=False,
        default=dict,
        server_default=text("'{}'"),
    )

    __table_args__ = (
        Index("ix_simulation_runtime_context_run", "run_id"),
        Index("ix_simulation_runtime_context_updated_at", "updated_at"),
    )


class SimulationRunProgress(Base, TimestampMixin):
    """Durable runtime progress ledger for historical simulation runs."""

    __tablename__ = "simulation_run_progress"

    run_id: Mapped[str] = mapped_column(String(length=128), primary_key=True)
    component: Mapped[str] = mapped_column(String(length=32), primary_key=True)
    dataset_id: Mapped[Optional[str]] = mapped_column(String(length=128), nullable=True)
    lane: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="equity",
        server_default=text("'equity'"),
    )
    workflow_name: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="pending",
        server_default=text("'pending'"),
    )
    last_source_ts: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_signal_ts: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_price_ts: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cursor_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    records_dumped: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    records_replayed: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    trade_decisions: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    executions: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    execution_tca_metrics: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    execution_order_events: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    strategy_type: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    legacy_path_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    fallback_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, default=0, server_default=text("0")
    )
    terminal_state: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    last_error_code: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    last_error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    payload_json: Mapped[Any] = mapped_column(
        JSONType,
        nullable=False,
        default=dict,
        server_default=text("'{}'"),
    )

    __table_args__ = (
        Index("ix_simulation_run_progress_status", "status"),
        Index("ix_simulation_run_progress_updated_at", "updated_at"),
        Index("ix_simulation_run_progress_dataset", "dataset_id"),
    )


class LLMDSPyWorkflowArtifact(Base, TimestampMixin):
    """DSPy compile/eval/promotion artifact + AgentRun audit record."""

    __tablename__ = "llm_dspy_workflow_artifacts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_key: Mapped[str] = mapped_column(
        String(length=128), nullable=False, unique=True
    )
    lane: Mapped[str] = mapped_column(String(length=32), nullable=False)
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="queued",
        server_default=text("'queued'"),
    )
    implementation_spec_ref: Mapped[str] = mapped_column(
        String(length=128), nullable=False
    )
    program_name: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    signature_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    optimizer: Mapped[Optional[str]] = mapped_column(String(length=64), nullable=True)
    artifact_uri: Mapped[Optional[str]] = mapped_column(
        String(length=1024), nullable=True
    )
    artifact_hash: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    dataset_hash: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    compiled_prompt_hash: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    reproducibility_hash: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    metric_bundle: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    gate_compatibility: Mapped[Optional[str]] = mapped_column(
        String(length=16), nullable=True
    )
    promotion_recommendation: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    promotion_target: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    idempotency_key: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    agentrun_name: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    agentrun_namespace: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    agentrun_uid: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    request_payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    response_payload_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_llm_dspy_workflow_artifacts_lane", "lane"),
        Index("ix_llm_dspy_workflow_artifacts_status", "status"),
        Index(
            "ix_llm_dspy_workflow_artifacts_program_name",
            "program_name",
        ),
        Index(
            "ix_llm_dspy_workflow_artifacts_artifact_hash",
            "artifact_hash",
        ),
        Index(
            "ix_llm_dspy_workflow_artifacts_created_at",
            "created_at",
        ),
    )


class LLMDecisionReview(Base, CreatedAtMixin):
    """Audit record for LLM review of a trade decision."""

    __tablename__ = "llm_decision_reviews"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    trade_decision_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("trade_decisions.id", ondelete="CASCADE"), nullable=False
    )
    model: Mapped[str] = mapped_column(String(length=128), nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(length=32), nullable=False)
    input_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    response_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    verdict: Mapped[str] = mapped_column(String(length=16), nullable=False)
    confidence: Mapped[Optional[Decimal]] = mapped_column(Numeric(6, 4), nullable=True)
    adjusted_qty: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    adjusted_order_type: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    rationale: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    risk_flags: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    tokens_prompt: Mapped[Optional[int]] = mapped_column(nullable=True)
    tokens_completion: Mapped[Optional[int]] = mapped_column(nullable=True)

    trade_decision: Mapped[TradeDecision] = relationship(back_populates="llm_reviews")

    __table_args__ = (
        Index("ix_llm_decision_reviews_trade_decision_id", "trade_decision_id"),
        Index("ix_llm_decision_reviews_verdict", "verdict"),
        Index("ix_llm_decision_reviews_created_at", "created_at"),
    )


__all__ = [
    "TradeCursor",
    "SimulationRuntimeContext",
    "SimulationRunProgress",
    "LLMDSPyWorkflowArtifact",
    "LLMDecisionReview",
]
