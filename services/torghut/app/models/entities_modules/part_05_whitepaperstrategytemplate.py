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
from .part_04_whitepapercontent import *


class WhitepaperStrategyTemplate(Base, TimestampMixin):
    """Family-template candidates compiled from whitepaper claims."""

    __tablename__ = "whitepaper_strategy_templates"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    template_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    family_template_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    economic_mechanism: Mapped[str] = mapped_column(Text, nullable=False)
    hypothesis: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    supported_markets_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    required_features_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    allowed_normalizations_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    entry_motifs_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    exit_motifs_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    risk_controls_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    activity_model_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    liquidity_assumptions_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    regime_activation_rules_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    day_veto_rules_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="strategy_templates"
    )

    __table_args__ = (
        Index("ix_whitepaper_strategy_templates_run_id", "analysis_run_id"),
        Index("ix_whitepaper_strategy_templates_family_id", "family_template_id"),
        Index(
            "uq_whitepaper_strategy_templates_run_template_id",
            "analysis_run_id",
            "template_id",
            unique=True,
        ),
    )


class WhitepaperExperimentSpec(Base, TimestampMixin):
    """Claim-linked experiment specs compiled from whitepaper research."""

    __tablename__ = "whitepaper_experiment_specs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    experiment_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    family_template_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    template_id: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    hypothesis: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    paper_claim_links_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    dataset_snapshot_policy_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    template_overrides_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    feature_variants_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    veto_controller_variants_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    selection_objectives_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    hard_vetoes_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    expected_failure_modes_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    promotion_contract_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="experiment_specs"
    )

    __table_args__ = (
        Index("ix_whitepaper_experiment_specs_run_id", "analysis_run_id"),
        Index("ix_whitepaper_experiment_specs_family_id", "family_template_id"),
        Index(
            "uq_whitepaper_experiment_specs_run_experiment_id",
            "analysis_run_id",
            "experiment_id",
            unique=True,
        ),
    )


class WhitepaperContradictionEvent(Base, TimestampMixin):
    """Contradiction signals requiring revalidation of prior claim-linked families."""

    __tablename__ = "whitepaper_contradiction_events"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    event_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    source_claim_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    target_claim_id: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    target_run_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="open",
        server_default=text("'open'"),
    )
    required_action: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    rationale: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="contradiction_events"
    )

    __table_args__ = (
        Index("ix_whitepaper_contradiction_events_run_id", "analysis_run_id"),
        Index("ix_whitepaper_contradiction_events_status", "status"),
        Index("ix_whitepaper_contradiction_events_source_claim_id", "source_claim_id"),
        Index(
            "uq_whitepaper_contradiction_events_run_event_id",
            "analysis_run_id",
            "event_id",
            unique=True,
        ),
    )


class WhitepaperEngineeringTrigger(Base, TimestampMixin):
    """Deterministic implementation trigger decision for a completed whitepaper run."""

    __tablename__ = "whitepaper_engineering_triggers"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    trigger_id: Mapped[str] = mapped_column(
        String(length=64), nullable=False, unique=True
    )
    whitepaper_run_id: Mapped[str] = mapped_column(
        String(length=64), nullable=False, unique=True
    )
    analysis_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    verdict_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_viability_verdicts.id", ondelete="SET NULL"),
        nullable=True,
    )
    hypothesis_id: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    implementation_grade: Mapped[str] = mapped_column(String(length=32), nullable=False)
    decision: Mapped[str] = mapped_column(String(length=32), nullable=False)
    reason_codes_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    approval_token: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    dispatched_agentrun_name: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    rollout_profile: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="manual",
        server_default=text("'manual'"),
    )
    approval_source: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    approved_by: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    approved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    approval_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    policy_ref: Mapped[Optional[str]] = mapped_column(String(length=255), nullable=True)
    gate_snapshot_hash: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    gate_snapshot_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    analysis_run: Mapped[WhitepaperAnalysisRun] = relationship(
        back_populates="engineering_trigger"
    )
    viability_verdict: Mapped[Optional[WhitepaperViabilityVerdict]] = relationship(
        back_populates="engineering_triggers"
    )
    rollout_transitions: Mapped[List["WhitepaperRolloutTransition"]] = relationship(
        back_populates="engineering_trigger",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("ix_whitepaper_engineering_triggers_run_id", "whitepaper_run_id"),
        Index("ix_whitepaper_engineering_triggers_grade", "implementation_grade"),
        Index("ix_whitepaper_engineering_triggers_decision", "decision"),
        Index("ix_whitepaper_engineering_triggers_rollout_profile", "rollout_profile"),
        Index("ix_whitepaper_engineering_triggers_approval_source", "approval_source"),
    )


class WhitepaperRolloutTransition(Base, CreatedAtMixin):
    """Audit log of deterministic automatic rollout transitions for whitepaper candidates."""

    __tablename__ = "whitepaper_rollout_transitions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    transition_id: Mapped[str] = mapped_column(
        String(length=64), nullable=False, unique=True
    )
    trigger_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("whitepaper_engineering_triggers.id", ondelete="CASCADE"),
        nullable=False,
    )
    whitepaper_run_id: Mapped[str] = mapped_column(String(length=64), nullable=False)
    from_stage: Mapped[Optional[str]] = mapped_column(String(length=32), nullable=True)
    to_stage: Mapped[Optional[str]] = mapped_column(String(length=32), nullable=True)
    transition_type: Mapped[str] = mapped_column(String(length=32), nullable=False)
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    gate_results_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    reason_codes_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    blocking_gate: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    evidence_hash: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )

    engineering_trigger: Mapped[WhitepaperEngineeringTrigger] = relationship(
        back_populates="rollout_transitions"
    )

    __table_args__ = (
        Index("ix_whitepaper_rollout_transitions_trigger_id", "trigger_id"),
        Index("ix_whitepaper_rollout_transitions_run_id", "whitepaper_run_id"),
        Index("ix_whitepaper_rollout_transitions_status", "status"),
        Index("ix_whitepaper_rollout_transitions_created_at", "created_at"),
    )


class AutoresearchEpoch(Base, TimestampMixin):
    """Durable execution record for whitepaper autoresearch epochs."""

    __tablename__ = "autoresearch_epochs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    epoch_id: Mapped[str] = mapped_column(
        String(length=128), nullable=False, unique=True
    )
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    target_net_pnl_per_day: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False
    )
    paper_run_ids_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    snapshot_manifest_json: Mapped[Optional[Any]] = mapped_column(
        JSONType, nullable=True
    )
    runner_config_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    summary_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failure_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("ix_autoresearch_epochs_status", "status"),
        Index("ix_autoresearch_epochs_completed_at", "completed_at"),
    )


class AutoresearchCandidateSpec(Base, TimestampMixin):
    """Normalized candidate spec ledger for autoresearch epochs."""

    __tablename__ = "autoresearch_candidate_specs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    candidate_spec_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    epoch_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    hypothesis_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    candidate_kind: Mapped[str] = mapped_column(String(length=32), nullable=False)
    family_template_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    payload_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(length=64), nullable=False)
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    blockers_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index(
            "uq_autoresearch_candidate_specs_epoch_candidate_spec",
            "epoch_id",
            "candidate_spec_id",
            unique=True,
        ),
        Index("ix_autoresearch_candidate_specs_epoch_id", "epoch_id"),
        Index("ix_autoresearch_candidate_specs_hypothesis_id", "hypothesis_id"),
        Index("ix_autoresearch_candidate_specs_family", "family_template_id"),
        Index("ix_autoresearch_candidate_specs_status", "status"),
    )


class AutoresearchProposalScore(Base, TimestampMixin):
    """MLX or fallback proposal score ledger for autoresearch candidate specs."""

    __tablename__ = "autoresearch_proposal_scores"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    epoch_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    candidate_spec_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    model_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    backend: Mapped[str] = mapped_column(String(length=64), nullable=False)
    proposal_score: Mapped[Decimal] = mapped_column(Numeric(20, 8), nullable=False)
    rank: Mapped[int] = mapped_column(BigInteger(), nullable=False)
    selection_reason: Mapped[str] = mapped_column(String(length=64), nullable=False)
    feature_hash: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    payload_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_autoresearch_proposal_scores_epoch_id", "epoch_id"),
        Index("ix_autoresearch_proposal_scores_candidate_spec", "candidate_spec_id"),
        Index("ix_autoresearch_proposal_scores_rank", "epoch_id", "rank"),
        Index(
            "uq_autoresearch_proposal_scores_epoch_candidate_model",
            "epoch_id",
            "candidate_spec_id",
            "model_id",
            unique=True,
        ),
    )


class AutoresearchPortfolioCandidate(Base, TimestampMixin):
    """Portfolio assembly ledger for autoresearch epochs."""

    __tablename__ = "autoresearch_portfolio_candidates"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    portfolio_candidate_id: Mapped[str] = mapped_column(
        String(length=128), nullable=False, unique=True
    )
    epoch_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    source_candidate_ids_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    target_net_pnl_per_day: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False
    )
    objective_scorecard_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    optimizer_report_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    payload_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)

    __table_args__ = (
        Index("ix_autoresearch_portfolio_candidates_epoch_id", "epoch_id"),
        Index("ix_autoresearch_portfolio_candidates_status", "status"),
        Index("ix_autoresearch_portfolio_candidates_created", "created_at"),
        Index(
            "ix_autoresearch_portfolio_candidates_status_created",
            "status",
            "created_at",
        ),
    )


class PositionSnapshot(Base, CreatedAtMixin):
    """Snapshots of account equity, cash, buying power, and positions."""

    __tablename__ = "position_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    alpaca_account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    equity: Mapped[Decimal] = mapped_column(Numeric(20, 8), nullable=False)
    cash: Mapped[Decimal] = mapped_column(Numeric(20, 8), nullable=False)
    buying_power: Mapped[Decimal] = mapped_column(Numeric(20, 8), nullable=False)
    positions: Mapped[Any] = mapped_column(JSONType, nullable=False)

    __table_args__ = (
        Index("ix_position_snapshots_as_of", "as_of"),
        Index("ix_position_snapshots_account_label", "alpaca_account_label"),
        Index("ix_position_snapshots_account_as_of", "alpaca_account_label", "as_of"),
    )


class ExecutionTCAMetric(Base, TimestampMixin):
    """Per-order transaction cost analytics metrics derived from execution outcomes."""

    __tablename__ = "execution_tca_metrics"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    execution_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("executions.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    trade_decision_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("trade_decisions.id", ondelete="SET NULL"), nullable=True
    )
    strategy_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("strategies.id", ondelete="SET NULL"), nullable=True
    )
    alpaca_account_label: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    symbol: Mapped[str] = mapped_column(
        String(length=MARKET_SYMBOL_MAX_LENGTH), nullable=False
    )
    side: Mapped[str] = mapped_column(String(length=8), nullable=False)
    arrival_price: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    avg_fill_price: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    filled_qty: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False, default=Decimal("0"), server_default=text("0")
    )
    signed_qty: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False, default=Decimal("0"), server_default=text("0")
    )
    slippage_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    shortfall_notional: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    expected_shortfall_bps_p50: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    expected_shortfall_bps_p95: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    realized_shortfall_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    divergence_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    simulator_version: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    churn_qty: Mapped[Decimal] = mapped_column(
        Numeric(20, 8), nullable=False, default=Decimal("0"), server_default=text("0")
    )
    churn_ratio: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_execution_tca_metrics_trade_decision_id", "trade_decision_id"),
        Index(
            "ix_execution_tca_metrics_account_computed_symbol",
            "alpaca_account_label",
            "computed_at",
            "symbol",
        ),
        Index("ix_execution_tca_metrics_strategy_symbol", "strategy_id", "symbol"),
        Index("ix_execution_tca_metrics_symbol", "symbol"),
        Index("ix_execution_tca_metrics_computed_at", "computed_at"),
    )


class LeanBacktestRun(Base, TimestampMixin):
    """Asynchronous LEAN backtest request lifecycle and reproducibility ledger."""

    __tablename__ = "lean_backtest_runs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    backtest_id: Mapped[str] = mapped_column(
        String(length=64), nullable=False, unique=True
    )
    status: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="queued",
        server_default=text("'queued'"),
    )
    requested_by: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    lane: Mapped[str] = mapped_column(
        String(length=32),
        nullable=False,
        default="research",
        server_default=text("'research'"),
    )
    config_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    result_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    artifacts_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    reproducibility_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    replay_hash: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    deterministic_replay_passed: Mapped[Optional[bool]] = mapped_column(
        Boolean, nullable=True
    )
    failure_taxonomy: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index("ix_lean_backtest_runs_status", "status"),
        Index("ix_lean_backtest_runs_lane", "lane"),
        Index("ix_lean_backtest_runs_created_at", "created_at"),
    )


class LeanExecutionShadowEvent(Base, CreatedAtMixin):
    """Parity telemetry comparing Torghut intents against LEAN shadow simulation."""

    __tablename__ = "lean_execution_shadow_events"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    correlation_id: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    trade_decision_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("trade_decisions.id", ondelete="SET NULL"), nullable=True
    )
    execution_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("executions.id", ondelete="SET NULL"), nullable=True
    )
    symbol: Mapped[str] = mapped_column(String(length=32), nullable=False)
    side: Mapped[str] = mapped_column(String(length=8), nullable=False)
    qty: Mapped[Decimal] = mapped_column(Numeric(20, 8), nullable=False)
    intent_notional: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    simulated_fill_price: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    simulated_slippage_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    parity_delta_bps: Mapped[Optional[Decimal]] = mapped_column(
        Numeric(20, 8), nullable=True
    )
    parity_status: Mapped[str] = mapped_column(
        String(length=64),
        nullable=False,
        default="unknown",
        server_default=text("'unknown'"),
    )
    failure_taxonomy: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    simulation_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_lean_execution_shadow_events_created_at", "created_at"),
        Index("ix_lean_execution_shadow_events_symbol", "symbol"),
        Index("ix_lean_execution_shadow_events_status", "parity_status"),
        Index("ix_lean_execution_shadow_events_trade_decision", "trade_decision_id"),
    )


class LeanCanaryIncident(Base, CreatedAtMixin):
    """Gate-breach incidents and rollback evidence for controlled LEAN live canaries."""

    __tablename__ = "lean_canary_incidents"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    incident_key: Mapped[str] = mapped_column(
        String(length=96), nullable=False, unique=True
    )
    breach_type: Mapped[str] = mapped_column(String(length=64), nullable=False)
    severity: Mapped[str] = mapped_column(
        String(length=16),
        nullable=False,
        default="warning",
        server_default=text("'warning'"),
    )
    rollback_triggered: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=func.false(),
    )
    symbols: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    evidence_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index("ix_lean_canary_incidents_breach_type", "breach_type"),
        Index("ix_lean_canary_incidents_created_at", "created_at"),
    )


class LeanStrategyShadowEvaluation(Base, CreatedAtMixin):
    """Shadow-only LEAN strategy-runtime parity evidence before promotion."""

    __tablename__ = "lean_strategy_shadow_evaluations"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[str] = mapped_column(String(length=64), nullable=False, unique=True)
    strategy_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    symbol: Mapped[str] = mapped_column(String(length=32), nullable=False)
    intent_json: Mapped[Any] = mapped_column(JSONType, nullable=False)
    shadow_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    parity_status: Mapped[str] = mapped_column(
        String(length=64),
        nullable=False,
        default="unknown",
        server_default=text("'unknown'"),
    )
    governance_json: Mapped[Optional[Any]] = mapped_column(JSONType, nullable=True)
    disable_switch_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=func.false(),
    )

    __table_args__ = (
        Index("ix_lean_strategy_shadow_evaluations_strategy", "strategy_id"),
        Index("ix_lean_strategy_shadow_evaluations_symbol", "symbol"),
        Index("ix_lean_strategy_shadow_evaluations_status", "parity_status"),
    )


class ToolRunLog(Base, CreatedAtMixin):
    """Trace of tool invocations made by the Codex agent."""

    __tablename__ = "tool_run_logs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    codex_session_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    tool_name: Mapped[str] = mapped_column(String(length=128), nullable=False)
    request_payload: Mapped[Any] = mapped_column(JSONType, nullable=False)
    response_payload: Mapped[Any] = mapped_column(JSONType, nullable=False)
    success: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=func.true()
    )

    __table_args__ = (Index("ix_tool_run_logs_codex_session", "codex_session_id"),)


__all__ = [name for name in globals() if not name.startswith("__")]
