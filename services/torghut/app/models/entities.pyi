from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
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
from .base import Base, GUID, JSONType

MARKET_SYMBOL_MAX_LENGTH: Any

class TimestampMixin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    created_at: Mapped[datetime]
    updated_at: Mapped[datetime]

class CreatedAtMixin:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    created_at: Mapped[datetime]

class Strategy(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    name: Mapped[str]
    description: Mapped[Optional[str]]
    enabled: Mapped[bool]
    base_timeframe: Mapped[str]
    universe_type: Mapped[str]
    universe_symbols: Mapped[Optional[Any]]
    max_position_pct_equity: Mapped[Optional[Decimal]]
    max_notional_per_trade: Mapped[Optional[Decimal]]
    trade_decisions: Mapped[List["TradeDecision"]]
    __table_args__: Any

class TradeDecision(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    strategy_id: Mapped[uuid.UUID]
    alpaca_account_label: Mapped[str]
    symbol: Mapped[str]
    timeframe: Mapped[str]
    decision_json: Mapped[Any]
    rationale: Mapped[Optional[str]]
    decision_hash: Mapped[Optional[str]]
    status: Mapped[str]
    executed_at: Mapped[Optional[datetime]]
    strategy: Mapped[Strategy]
    executions: Mapped[List["Execution"]]
    llm_reviews: Mapped[List["LLMDecisionReview"]]
    __table_args__: Any

class Execution(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    trade_decision_id: Mapped[Optional[uuid.UUID]]
    alpaca_account_label: Mapped[str]
    alpaca_order_id: Mapped[str]
    client_order_id: Mapped[Optional[str]]
    symbol: Mapped[str]
    side: Mapped[str]
    order_type: Mapped[str]
    time_in_force: Mapped[str]
    submitted_qty: Mapped[Decimal]
    filled_qty: Mapped[Decimal]
    avg_fill_price: Mapped[Optional[Decimal]]
    status: Mapped[str]
    execution_expected_adapter: Mapped[str]
    execution_actual_adapter: Mapped[str]
    execution_fallback_reason: Mapped[Optional[str]]
    execution_fallback_count: Mapped[int]
    execution_correlation_id: Mapped[Optional[str]]
    execution_idempotency_key: Mapped[Optional[str]]
    execution_audit_json: Mapped[Optional[Any]]
    raw_order: Mapped[Any]
    last_update_at: Mapped[Optional[datetime]]
    order_feed_last_event_ts: Mapped[Optional[datetime]]
    order_feed_last_seq: Mapped[Optional[int]]
    trade_decision: Mapped[Optional[TradeDecision]]
    order_events: Mapped[List["ExecutionOrderEvent"]]
    __table_args__: Any

class OrderFeedSourceWindow(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    consumer_group: Mapped[str]
    source_topic: Mapped[str]
    source_partition: Mapped[int]
    alpaca_account_label: Mapped[str]
    assignment_mode: Mapped[str]
    collector_identity: Mapped[Optional[str]]
    source_revision: Mapped[Optional[str]]
    window_started_at: Mapped[datetime]
    window_ended_at: Mapped[datetime]
    start_offset: Mapped[int]
    end_offset: Mapped[int]
    broker_high_watermark: Mapped[Optional[int]]
    consumed_count: Mapped[int]
    inserted_count: Mapped[int]
    duplicate_count: Mapped[int]
    malformed_count: Mapped[int]
    missing_payload_count: Mapped[int]
    missing_identity_count: Mapped[int]
    out_of_scope_account_count: Mapped[int]
    unlinked_execution_count: Mapped[int]
    unlinked_decision_count: Mapped[int]
    failed_unhandled_count: Mapped[int]
    dropped_count: Mapped[int]
    gap_count: Mapped[int]
    gap_ranges: Mapped[Any]
    first_event_ts: Mapped[Optional[datetime]]
    last_event_ts: Mapped[Optional[datetime]]
    status: Mapped[str]
    status_reason: Mapped[Optional[str]]
    classification_counts: Mapped[Any]
    payload_json: Mapped[Any]
    events: Mapped[list["ExecutionOrderEvent"]]
    __table_args__: Any

class ExecutionOrderEvent(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    event_fingerprint: Mapped[str]
    source_topic: Mapped[str]
    source_partition: Mapped[Optional[int]]
    source_offset: Mapped[Optional[int]]
    alpaca_account_label: Mapped[str]
    feed_seq: Mapped[Optional[int]]
    event_ts: Mapped[Optional[datetime]]
    symbol: Mapped[Optional[str]]
    alpaca_order_id: Mapped[Optional[str]]
    client_order_id: Mapped[Optional[str]]
    event_type: Mapped[Optional[str]]
    status: Mapped[Optional[str]]
    qty: Mapped[Optional[Decimal]]
    filled_qty: Mapped[Optional[Decimal]]
    filled_qty_delta: Mapped[Optional[Decimal]]
    avg_fill_price: Mapped[Optional[Decimal]]
    filled_notional_delta: Mapped[Optional[Decimal]]
    fill_quantity_basis: Mapped[Optional[str]]
    raw_event: Mapped[Any]
    execution_id: Mapped[Optional[uuid.UUID]]
    trade_decision_id: Mapped[Optional[uuid.UUID]]
    source_window_id: Mapped[Optional[uuid.UUID]]
    execution: Mapped[Optional[Execution]]
    trade_decision: Mapped[Optional[TradeDecision]]
    source_window: Mapped[Optional[OrderFeedSourceWindow]]
    __table_args__: Any

class OrderFeedConsumerCursor(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    consumer_group: Mapped[str]
    source_topic: Mapped[str]
    source_partition: Mapped[int]
    high_watermark_offset: Mapped[int]
    last_event_fingerprint: Mapped[Optional[str]]
    last_event_ts: Mapped[Optional[datetime]]
    processed_event_count: Mapped[int]
    duplicate_event_count: Mapped[int]
    offset_gap_count: Mapped[int]
    __table_args__: Any

class TigerBeetleAccountRef(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    cluster_id: Mapped[int]
    account_id: Mapped[str]
    account_key: Mapped[str]
    ledger: Mapped[int]
    code: Mapped[int]
    account_label: Mapped[Optional[str]]
    symbol: Mapped[Optional[str]]
    strategy_id: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class TigerBeetleTransferRef(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    cluster_id: Mapped[int]
    transfer_id: Mapped[str]
    transfer_kind: Mapped[str]
    ledger: Mapped[int]
    code: Mapped[int]
    amount: Mapped[Decimal]
    status: Mapped[str]
    result_code: Mapped[Optional[str]]
    trade_decision_id: Mapped[Optional[uuid.UUID]]
    execution_id: Mapped[Optional[uuid.UUID]]
    execution_order_event_id: Mapped[Optional[uuid.UUID]]
    execution_tca_metric_id: Mapped[Optional[uuid.UUID]]
    runtime_ledger_bucket_id: Mapped[Optional[uuid.UUID]]
    source_type: Mapped[Optional[str]]
    source_id: Mapped[Optional[str]]
    event_fingerprint: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    trade_decision: Mapped[Optional[TradeDecision]]
    execution: Mapped[Optional[Execution]]
    execution_order_event: Mapped[Optional[ExecutionOrderEvent]]
    execution_tca_metric: Mapped[Optional["ExecutionTCAMetric"]]
    runtime_ledger_bucket: Mapped[Optional["StrategyRuntimeLedgerBucket"]]
    __table_args__: Any

class TigerBeetleReconciliationRun(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    cluster_id: Mapped[int]
    started_at: Mapped[datetime]
    finished_at: Mapped[Optional[datetime]]
    status: Mapped[str]
    checked_transfer_count: Mapped[int]
    missing_transfer_count: Mapped[int]
    mismatched_transfer_count: Mapped[int]
    source_missing_count: Mapped[int]
    account_ref_count: Mapped[int]
    transfer_ref_count: Mapped[int]
    runtime_ledger_ref_count: Mapped[int]
    runtime_ledger_signed_ref_count: Mapped[int]
    runtime_ledger_missing_signed_ref_count: Mapped[int]
    runtime_ledger_missing_account_ref_count: Mapped[int]
    stable_ref_count: Mapped[int]
    stable_ref_missing_count: Mapped[int]
    stable_ref_mismatch_count: Mapped[int]
    blockers_json: Mapped[Optional[Any]]
    ref_counts_json: Mapped[Optional[Any]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class ResearchRun(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    status: Mapped[str]
    strategy_id: Mapped[Optional[str]]
    strategy_name: Mapped[Optional[str]]
    strategy_type: Mapped[Optional[str]]
    strategy_version: Mapped[Optional[str]]
    code_commit: Mapped[Optional[str]]
    feature_version: Mapped[Optional[str]]
    feature_schema_version: Mapped[Optional[str]]
    feature_spec_hash: Mapped[Optional[str]]
    signal_source: Mapped[Optional[str]]
    dataset_version: Mapped[Optional[str]]
    dataset_from: Mapped[Optional[datetime]]
    dataset_to: Mapped[Optional[datetime]]
    dataset_snapshot_ref: Mapped[Optional[str]]
    runner_version: Mapped[Optional[str]]
    runner_binary_hash: Mapped[Optional[str]]
    gate_report_trace_id: Mapped[Optional[str]]
    recommendation_trace_id: Mapped[Optional[str]]
    discovery_mode: Mapped[Optional[str]]
    generator_family: Mapped[Optional[str]]
    grammar_version: Mapped[Optional[str]]
    search_budget: Mapped[Optional[int]]
    selection_protocol_version: Mapped[Optional[str]]
    pilot_program_id: Mapped[Optional[str]]
    kill_criteria_version: Mapped[Optional[str]]
    __table_args__: Any

class ResearchCandidate(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[str]
    candidate_hash: Mapped[Optional[str]]
    parameter_set: Mapped[Optional[Any]]
    decision_count: Mapped[int]
    trade_count: Mapped[int]
    symbols_covered: Mapped[Optional[Any]]
    universe_definition: Mapped[Optional[Any]]
    promotion_target: Mapped[Optional[str]]
    lifecycle_role: Mapped[str]
    lifecycle_status: Mapped[str]
    metadata_bundle: Mapped[Optional[Any]]
    recommendation_bundle: Mapped[Optional[Any]]
    candidate_family: Mapped[Optional[str]]
    canonical_spec: Mapped[Optional[Any]]
    semantic_hash: Mapped[Optional[str]]
    economic_rationale: Mapped[Optional[str]]
    complexity_score: Mapped[Optional[Decimal]]
    discovery_rank: Mapped[Optional[int]]
    posterior_edge_summary: Mapped[Optional[Any]]
    economic_validity_card: Mapped[Optional[Any]]
    valid_regime_envelope: Mapped[Optional[Any]]
    invalidation_clauses: Mapped[Optional[Any]]
    null_comparator_summary: Mapped[Optional[Any]]
    __table_args__: Any

class ResearchFoldMetrics(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    candidate_id: Mapped[str]
    fold_name: Mapped[str]
    fold_order: Mapped[int]
    train_start: Mapped[datetime]
    train_end: Mapped[datetime]
    test_start: Mapped[datetime]
    test_end: Mapped[datetime]
    decision_count: Mapped[int]
    trade_count: Mapped[int]
    gross_pnl: Mapped[Optional[Decimal]]
    net_pnl: Mapped[Optional[Decimal]]
    max_drawdown: Mapped[Optional[Decimal]]
    turnover_ratio: Mapped[Optional[Decimal]]
    cost_bps: Mapped[Optional[Decimal]]
    cost_assumptions: Mapped[Optional[Any]]
    regime_label: Mapped[Optional[str]]
    stat_bundle: Mapped[Optional[Any]]
    purge_window: Mapped[Optional[int]]
    embargo_window: Mapped[Optional[int]]
    feature_availability_hash: Mapped[Optional[str]]
    __table_args__: Any

class ResearchAttempt(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    attempt_id: Mapped[str]
    run_id: Mapped[str]
    candidate_hash: Mapped[Optional[str]]
    generator_family: Mapped[Optional[str]]
    attempt_stage: Mapped[str]
    status: Mapped[str]
    reason_codes: Mapped[Optional[Any]]
    artifact_ref: Mapped[Optional[str]]
    metadata_bundle: Mapped[Optional[Any]]
    __table_args__: Any

class ResearchValidationTest(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    candidate_id: Mapped[str]
    test_name: Mapped[str]
    status: Mapped[str]
    metric_bundle: Mapped[Optional[Any]]
    artifact_ref: Mapped[Optional[str]]
    computed_at: Mapped[datetime]
    __table_args__: Any

class ResearchSequentialTrial(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    candidate_id: Mapped[str]
    trial_stage: Mapped[str]
    account: Mapped[str]
    start_at: Mapped[datetime]
    last_update_at: Mapped[datetime]
    sample_count: Mapped[int]
    confidence_sequence_lower: Mapped[Optional[Decimal]]
    confidence_sequence_upper: Mapped[Optional[Decimal]]
    posterior_edge_mean: Mapped[Optional[Decimal]]
    posterior_edge_lower: Mapped[Optional[Decimal]]
    status: Mapped[str]
    reason_codes: Mapped[Optional[Any]]
    __table_args__: Any

class ResearchCostCalibration(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    calibration_id: Mapped[str]
    scope_type: Mapped[str]
    scope_id: Mapped[str]
    window_start: Mapped[Optional[datetime]]
    window_end: Mapped[Optional[datetime]]
    modeled_slippage_bps: Mapped[Optional[Decimal]]
    realized_slippage_bps: Mapped[Optional[Decimal]]
    modeled_shortfall_bps: Mapped[Optional[Decimal]]
    realized_shortfall_bps: Mapped[Optional[Decimal]]
    calibration_error_bundle: Mapped[Optional[Any]]
    status: Mapped[str]
    computed_at: Mapped[datetime]
    __table_args__: Any

class ResearchStressMetrics(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    candidate_id: Mapped[str]
    stress_case: Mapped[str]
    metric_bundle: Mapped[Optional[Any]]
    pessimistic_pnl_delta: Mapped[Optional[Decimal]]
    __table_args__: Any

class ResearchPromotion(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    candidate_id: Mapped[str]
    requested_mode: Mapped[Optional[str]]
    approved_mode: Mapped[Optional[str]]
    approver: Mapped[Optional[str]]
    approver_role: Mapped[Optional[str]]
    approve_reason: Mapped[Optional[str]]
    deny_reason: Mapped[Optional[str]]
    paper_candidate_patch_ref: Mapped[Optional[str]]
    effective_time: Mapped[Optional[datetime]]
    decision_action: Mapped[str]
    decision_rationale: Mapped[Optional[str]]
    evidence_bundle: Mapped[Optional[Any]]
    recommendation_trace_id: Mapped[Optional[str]]
    successor_candidate_id: Mapped[Optional[str]]
    rollback_candidate_id: Mapped[Optional[str]]
    __table_args__: Any

class VNextDatasetSnapshot(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    dataset_id: Mapped[str]
    source: Mapped[str]
    dataset_version: Mapped[Optional[str]]
    dataset_from: Mapped[Optional[datetime]]
    dataset_to: Mapped[Optional[datetime]]
    artifact_ref: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextFeatureViewSpec(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    strategy_id: Mapped[str]
    feature_view_spec_ref: Mapped[str]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextModelArtifact(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    strategy_id: Mapped[str]
    artifact_ref: Mapped[str]
    artifact_kind: Mapped[str]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextExperimentSpec(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    experiment_id: Mapped[str]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextExperimentRun(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    experiment_id: Mapped[Optional[str]]
    stage_lineage_root: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextSimulationCalibration(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    artifact_ref: Mapped[str]
    status: Mapped[Optional[str]]
    order_count: Mapped[Optional[int]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextShadowLiveDeviation(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    artifact_ref: Mapped[str]
    status: Mapped[Optional[str]]
    order_count: Mapped[Optional[int]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextPromotionDecision(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[str]
    promotion_target: Mapped[str]
    recommended_mode: Mapped[Optional[str]]
    decision_action: Mapped[Optional[str]]
    allowed: Mapped[bool]
    gate_report_trace_id: Mapped[Optional[str]]
    recommendation_trace_id: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextEmpiricalJobRun(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    job_name: Mapped[str]
    job_type: Mapped[str]
    job_run_id: Mapped[str]
    status: Mapped[str]
    authority: Mapped[str]
    promotion_authority_eligible: Mapped[bool]
    dataset_snapshot_ref: Mapped[Optional[str]]
    artifact_refs: Mapped[Optional[Any]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class VNextCompletionGateResult(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    gate_id: Mapped[str]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    dataset_snapshot_ref: Mapped[Optional[str]]
    git_revision: Mapped[Optional[str]]
    image_digest: Mapped[Optional[str]]
    workflow_name: Mapped[Optional[str]]
    status: Mapped[str]
    artifact_ref: Mapped[Optional[str]]
    blocked_reason: Mapped[Optional[str]]
    details_json: Mapped[Optional[Any]]
    measured_at: Mapped[datetime]
    __table_args__: Any

class EvidenceReceiptRecord(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    receipt_id: Mapped[str]
    evidence_epoch_id: Mapped[Optional[str]]
    receipt_type: Mapped[str]
    producer: Mapped[str]
    subject_ref: Mapped[str]
    state: Mapped[str]
    decision: Mapped[Optional[str]]
    observed_at: Mapped[datetime]
    fresh_until: Mapped[datetime]
    reason_codes_json: Mapped[Optional[Any]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class EvidenceEpochRecord(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    evidence_epoch_id: Mapped[str]
    account_label: Mapped[str]
    stage_scope: Mapped[str]
    decision: Mapped[str]
    fresh_until: Mapped[datetime]
    reason_codes_json: Mapped[Optional[Any]]
    receipt_ids_json: Mapped[Optional[Any]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class RejectedSignalOutcomeEvent(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    event_id: Mapped[str]
    source: Mapped[str]
    paper_source: Mapped[str]
    paper_claim_id: Mapped[str]
    account_label: Mapped[str]
    symbol: Mapped[str]
    event_ts: Mapped[datetime]
    timeframe: Mapped[str]
    seq: Mapped[Optional[str]]
    reject_reason: Mapped[str]
    spread_bps: Mapped[Optional[Decimal]]
    jump_bps: Mapped[Optional[Decimal]]
    outcome_label_status: Mapped[str]
    counterfactual_required: Mapped[bool]
    required_outcome_fields_json: Mapped[Any]
    event_payload_json: Mapped[Any]
    outcome_payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class StrategyHypothesis(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    hypothesis_id: Mapped[str]
    lane_id: Mapped[str]
    strategy_family: Mapped[str]
    source_manifest_ref: Mapped[Optional[str]]
    active: Mapped[bool]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class StrategyHypothesisVersion(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    hypothesis_id: Mapped[str]
    version_key: Mapped[str]
    source_manifest_ref: Mapped[Optional[str]]
    active: Mapped[bool]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class StrategyHypothesisMetricWindow(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    hypothesis_id: Mapped[str]
    observed_stage: Mapped[str]
    window_started_at: Mapped[Optional[datetime]]
    window_ended_at: Mapped[Optional[datetime]]
    market_session_count: Mapped[int]
    decision_count: Mapped[int]
    trade_count: Mapped[int]
    order_count: Mapped[int]
    evidence_provenance: Mapped[Optional[str]]
    evidence_maturity: Mapped[Optional[str]]
    decision_alignment_ratio: Mapped[Optional[str]]
    avg_abs_slippage_bps: Mapped[Optional[str]]
    slippage_budget_bps: Mapped[Optional[str]]
    post_cost_expectancy_bps: Mapped[Optional[str]]
    continuity_ok: Mapped[bool]
    drift_ok: Mapped[bool]
    dependency_quorum_decision: Mapped[Optional[str]]
    capital_stage: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class StrategyRuntimeLedgerBucket(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    hypothesis_id: Mapped[str]
    observed_stage: Mapped[str]
    bucket_started_at: Mapped[datetime]
    bucket_ended_at: Mapped[datetime]
    account_label: Mapped[Optional[str]]
    runtime_strategy_name: Mapped[Optional[str]]
    strategy_family: Mapped[Optional[str]]
    fill_count: Mapped[int]
    decision_count: Mapped[int]
    submitted_order_count: Mapped[int]
    cancelled_order_count: Mapped[int]
    rejected_order_count: Mapped[int]
    unfilled_order_count: Mapped[int]
    closed_trade_count: Mapped[int]
    open_position_count: Mapped[int]
    filled_notional: Mapped[Decimal]
    gross_strategy_pnl: Mapped[Decimal]
    cost_amount: Mapped[Decimal]
    net_strategy_pnl_after_costs: Mapped[Decimal]
    post_cost_expectancy_bps: Mapped[Optional[Decimal]]
    ledger_schema_version: Mapped[str]
    pnl_basis: Mapped[str]
    execution_policy_hash_counts: Mapped[Optional[Any]]
    cost_model_hash_counts: Mapped[Optional[Any]]
    lineage_hash_counts: Mapped[Optional[Any]]
    blockers_json: Mapped[Optional[Any]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class StrategyCapitalAllocation(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    hypothesis_id: Mapped[str]
    prior_stage: Mapped[Optional[str]]
    stage: Mapped[str]
    capital_multiplier: Mapped[Optional[str]]
    rollback_target_stage: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class StrategyPromotionDecision(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    candidate_id: Mapped[Optional[str]]
    hypothesis_id: Mapped[str]
    promotion_target: Mapped[str]
    state: Mapped[Optional[str]]
    allowed: Mapped[bool]
    reason_summary: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class WhitepaperDocument(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    document_key: Mapped[str]
    source: Mapped[str]
    source_identifier: Mapped[Optional[str]]
    title: Mapped[Optional[str]]
    abstract: Mapped[Optional[str]]
    authors_json: Mapped[Optional[Any]]
    published_at: Mapped[Optional[datetime]]
    language: Mapped[str]
    status: Mapped[str]
    tags_json: Mapped[Optional[Any]]
    metadata_json: Mapped[Optional[Any]]
    ingested_by: Mapped[Optional[str]]
    last_processed_at: Mapped[Optional[datetime]]
    versions: Mapped[List["WhitepaperDocumentVersion"]]
    analysis_runs: Mapped[List["WhitepaperAnalysisRun"]]
    artifacts: Mapped[List["WhitepaperArtifact"]]
    __table_args__: Any

class WhitepaperDocumentVersion(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    document_id: Mapped[uuid.UUID]
    version_number: Mapped[int]
    trigger_reason: Mapped[str]
    file_name: Mapped[Optional[str]]
    mime_type: Mapped[str]
    file_size_bytes: Mapped[Optional[int]]
    checksum_sha256: Mapped[str]
    ceph_bucket: Mapped[str]
    ceph_object_key: Mapped[str]
    ceph_etag: Mapped[Optional[str]]
    parse_status: Mapped[str]
    parse_error: Mapped[Optional[str]]
    page_count: Mapped[Optional[int]]
    char_count: Mapped[Optional[int]]
    token_count: Mapped[Optional[int]]
    language: Mapped[Optional[str]]
    upload_metadata_json: Mapped[Optional[Any]]
    extraction_metadata_json: Mapped[Optional[Any]]
    uploaded_by: Mapped[Optional[str]]
    processed_at: Mapped[Optional[datetime]]
    document: Mapped[WhitepaperDocument]
    content: Mapped[Optional["WhitepaperContent"]]
    analysis_runs: Mapped[List["WhitepaperAnalysisRun"]]
    artifacts: Mapped[List["WhitepaperArtifact"]]
    __table_args__: Any

class WhitepaperContent(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    document_version_id: Mapped[uuid.UUID]
    text_source: Mapped[str]
    full_text: Mapped[str]
    full_text_sha256: Mapped[str]
    section_index_json: Mapped[Optional[Any]]
    references_json: Mapped[Optional[Any]]
    tables_json: Mapped[Optional[Any]]
    figures_json: Mapped[Optional[Any]]
    chunk_manifest_json: Mapped[Optional[Any]]
    extraction_warnings_json: Mapped[Optional[Any]]
    quality_score: Mapped[Optional[Decimal]]
    document_version: Mapped[WhitepaperDocumentVersion]
    __table_args__: Any

class WhitepaperAnalysisRun(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    document_id: Mapped[uuid.UUID]
    document_version_id: Mapped[uuid.UUID]
    status: Mapped[str]
    trigger_source: Mapped[str]
    trigger_actor: Mapped[Optional[str]]
    retry_of_run_id: Mapped[Optional[str]]
    inngest_event_id: Mapped[Optional[str]]
    inngest_function_id: Mapped[Optional[str]]
    inngest_run_id: Mapped[Optional[str]]
    orchestration_context_json: Mapped[Optional[Any]]
    analysis_profile_json: Mapped[Optional[Any]]
    request_payload_json: Mapped[Optional[Any]]
    result_payload_json: Mapped[Optional[Any]]
    failure_code: Mapped[Optional[str]]
    failure_reason: Mapped[Optional[str]]
    started_at: Mapped[Optional[datetime]]
    completed_at: Mapped[Optional[datetime]]
    document: Mapped[WhitepaperDocument]
    document_version: Mapped[WhitepaperDocumentVersion]
    steps: Mapped[List["WhitepaperAnalysisStep"]]
    codex_agentruns: Mapped[List["WhitepaperCodexAgentRun"]]
    synthesis: Mapped[Optional["WhitepaperSynthesis"]]
    viability_verdict: Mapped[Optional["WhitepaperViabilityVerdict"]]
    design_pull_requests: Mapped[List["WhitepaperDesignPullRequest"]]
    engineering_trigger: Mapped[Optional["WhitepaperEngineeringTrigger"]]
    claims: Mapped[List["WhitepaperClaim"]]
    claim_relations: Mapped[List["WhitepaperClaimRelation"]]
    strategy_templates: Mapped[List["WhitepaperStrategyTemplate"]]
    experiment_specs: Mapped[List["WhitepaperExperimentSpec"]]
    contradiction_events: Mapped[List["WhitepaperContradictionEvent"]]
    artifacts: Mapped[List["WhitepaperArtifact"]]
    __table_args__: Any

class WhitepaperAnalysisStep(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    step_name: Mapped[str]
    step_order: Mapped[int]
    attempt: Mapped[int]
    status: Mapped[str]
    executor: Mapped[Optional[str]]
    idempotency_key: Mapped[Optional[str]]
    trace_id: Mapped[Optional[str]]
    started_at: Mapped[Optional[datetime]]
    completed_at: Mapped[Optional[datetime]]
    duration_ms: Mapped[Optional[int]]
    input_json: Mapped[Optional[Any]]
    output_json: Mapped[Optional[Any]]
    error_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    codex_agentruns: Mapped[List["WhitepaperCodexAgentRun"]]
    __table_args__: Any

class WhitepaperCodexAgentRun(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    analysis_step_id: Mapped[Optional[uuid.UUID]]
    agentrun_name: Mapped[str]
    agentrun_namespace: Mapped[Optional[str]]
    agentrun_uid: Mapped[Optional[str]]
    status: Mapped[str]
    execution_mode: Mapped[str]
    requested_by: Mapped[Optional[str]]
    codex_session_id: Mapped[Optional[str]]
    vcs_provider: Mapped[Optional[str]]
    vcs_repository: Mapped[Optional[str]]
    vcs_base_branch: Mapped[Optional[str]]
    vcs_head_branch: Mapped[Optional[str]]
    vcs_base_commit_sha: Mapped[Optional[str]]
    vcs_head_commit_sha: Mapped[Optional[str]]
    workspace_context_json: Mapped[Optional[Any]]
    prompt_text: Mapped[Optional[str]]
    prompt_hash: Mapped[Optional[str]]
    input_context_json: Mapped[Optional[Any]]
    output_context_json: Mapped[Optional[Any]]
    patch_artifact_ref: Mapped[Optional[str]]
    log_artifact_ref: Mapped[Optional[str]]
    started_at: Mapped[Optional[datetime]]
    completed_at: Mapped[Optional[datetime]]
    failure_reason: Mapped[Optional[str]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    analysis_step: Mapped[Optional[WhitepaperAnalysisStep]]
    design_pull_requests: Mapped[List["WhitepaperDesignPullRequest"]]
    __table_args__: Any

class WhitepaperSynthesis(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    synthesis_version: Mapped[str]
    generated_by: Mapped[str]
    model_name: Mapped[Optional[str]]
    prompt_version: Mapped[Optional[str]]
    executive_summary: Mapped[str]
    problem_statement: Mapped[Optional[str]]
    methodology_summary: Mapped[Optional[str]]
    key_findings_json: Mapped[Optional[Any]]
    novelty_claims_json: Mapped[Optional[Any]]
    risk_assessment_json: Mapped[Optional[Any]]
    citations_json: Mapped[Optional[Any]]
    implementation_plan_md: Mapped[Optional[str]]
    confidence: Mapped[Optional[Decimal]]
    synthesis_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    artifacts: Mapped[List["WhitepaperArtifact"]]
    __table_args__: Any

class WhitepaperViabilityVerdict(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    verdict: Mapped[str]
    score: Mapped[Optional[Decimal]]
    confidence: Mapped[Optional[Decimal]]
    decision_policy: Mapped[Optional[str]]
    gating_json: Mapped[Optional[Any]]
    rationale: Mapped[Optional[str]]
    rejection_reasons_json: Mapped[Optional[Any]]
    recommendations_json: Mapped[Optional[Any]]
    requires_followup: Mapped[bool]
    approved_by: Mapped[Optional[str]]
    approved_at: Mapped[Optional[datetime]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    artifacts: Mapped[List["WhitepaperArtifact"]]
    engineering_triggers: Mapped[List["WhitepaperEngineeringTrigger"]]
    __table_args__: Any

class WhitepaperDesignPullRequest(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    codex_agentrun_id: Mapped[Optional[uuid.UUID]]
    attempt: Mapped[int]
    status: Mapped[str]
    repository: Mapped[str]
    base_branch: Mapped[str]
    head_branch: Mapped[str]
    pr_number: Mapped[Optional[int]]
    pr_url: Mapped[Optional[str]]
    title: Mapped[Optional[str]]
    body: Mapped[Optional[str]]
    commit_sha: Mapped[Optional[str]]
    merge_commit_sha: Mapped[Optional[str]]
    checks_url: Mapped[Optional[str]]
    ci_status: Mapped[Optional[str]]
    is_merged: Mapped[bool]
    merged_at: Mapped[Optional[datetime]]
    metadata_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    codex_agentrun: Mapped[Optional[WhitepaperCodexAgentRun]]
    artifacts: Mapped[List["WhitepaperArtifact"]]
    __table_args__: Any

class WhitepaperArtifact(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    document_id: Mapped[Optional[uuid.UUID]]
    document_version_id: Mapped[Optional[uuid.UUID]]
    analysis_run_id: Mapped[Optional[uuid.UUID]]
    synthesis_id: Mapped[Optional[uuid.UUID]]
    viability_verdict_id: Mapped[Optional[uuid.UUID]]
    design_pull_request_id: Mapped[Optional[uuid.UUID]]
    artifact_scope: Mapped[str]
    artifact_type: Mapped[str]
    artifact_role: Mapped[Optional[str]]
    ceph_bucket: Mapped[Optional[str]]
    ceph_object_key: Mapped[Optional[str]]
    artifact_uri: Mapped[Optional[str]]
    checksum_sha256: Mapped[Optional[str]]
    size_bytes: Mapped[Optional[int]]
    content_type: Mapped[Optional[str]]
    metadata_json: Mapped[Optional[Any]]
    document: Mapped[Optional[WhitepaperDocument]]
    document_version: Mapped[Optional[WhitepaperDocumentVersion]]
    analysis_run: Mapped[Optional[WhitepaperAnalysisRun]]
    synthesis: Mapped[Optional[WhitepaperSynthesis]]
    viability_verdict: Mapped[Optional[WhitepaperViabilityVerdict]]
    design_pull_request: Mapped[Optional[WhitepaperDesignPullRequest]]
    __table_args__: Any

class WhitepaperClaim(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    claim_id: Mapped[str]
    claim_type: Mapped[str]
    claim_text: Mapped[str]
    asset_scope: Mapped[Optional[str]]
    horizon_scope: Mapped[Optional[str]]
    data_requirements_json: Mapped[Optional[Any]]
    expected_direction: Mapped[Optional[str]]
    required_activity_conditions_json: Mapped[Optional[Any]]
    liquidity_constraints_json: Mapped[Optional[Any]]
    validation_notes: Mapped[Optional[str]]
    confidence: Mapped[Optional[Decimal]]
    metadata_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    __table_args__: Any

class WhitepaperClaimRelation(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    relation_id: Mapped[str]
    relation_type: Mapped[str]
    source_claim_id: Mapped[str]
    target_claim_id: Mapped[str]
    target_run_id: Mapped[Optional[str]]
    rationale: Mapped[Optional[str]]
    confidence: Mapped[Optional[Decimal]]
    metadata_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    __table_args__: Any

class WhitepaperStrategyTemplate(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    template_id: Mapped[str]
    family_template_id: Mapped[str]
    economic_mechanism: Mapped[str]
    hypothesis: Mapped[Optional[str]]
    supported_markets_json: Mapped[Optional[Any]]
    required_features_json: Mapped[Optional[Any]]
    allowed_normalizations_json: Mapped[Optional[Any]]
    entry_motifs_json: Mapped[Optional[Any]]
    exit_motifs_json: Mapped[Optional[Any]]
    risk_controls_json: Mapped[Optional[Any]]
    activity_model_json: Mapped[Optional[Any]]
    liquidity_assumptions_json: Mapped[Optional[Any]]
    regime_activation_rules_json: Mapped[Optional[Any]]
    day_veto_rules_json: Mapped[Optional[Any]]
    metadata_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    __table_args__: Any

class WhitepaperExperimentSpec(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    experiment_id: Mapped[str]
    family_template_id: Mapped[str]
    template_id: Mapped[Optional[str]]
    hypothesis: Mapped[Optional[str]]
    paper_claim_links_json: Mapped[Optional[Any]]
    dataset_snapshot_policy_json: Mapped[Optional[Any]]
    template_overrides_json: Mapped[Optional[Any]]
    feature_variants_json: Mapped[Optional[Any]]
    veto_controller_variants_json: Mapped[Optional[Any]]
    selection_objectives_json: Mapped[Optional[Any]]
    hard_vetoes_json: Mapped[Optional[Any]]
    expected_failure_modes_json: Mapped[Optional[Any]]
    promotion_contract_json: Mapped[Optional[Any]]
    payload_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    __table_args__: Any

class WhitepaperContradictionEvent(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    analysis_run_id: Mapped[uuid.UUID]
    event_id: Mapped[str]
    source_claim_id: Mapped[str]
    target_claim_id: Mapped[Optional[str]]
    target_run_id: Mapped[Optional[str]]
    status: Mapped[str]
    required_action: Mapped[Optional[str]]
    rationale: Mapped[Optional[str]]
    metadata_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    __table_args__: Any

class WhitepaperEngineeringTrigger(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    trigger_id: Mapped[str]
    whitepaper_run_id: Mapped[str]
    analysis_run_id: Mapped[uuid.UUID]
    verdict_id: Mapped[Optional[uuid.UUID]]
    hypothesis_id: Mapped[Optional[str]]
    implementation_grade: Mapped[str]
    decision: Mapped[str]
    reason_codes_json: Mapped[Optional[Any]]
    approval_token: Mapped[Optional[str]]
    dispatched_agentrun_name: Mapped[Optional[str]]
    rollout_profile: Mapped[str]
    approval_source: Mapped[Optional[str]]
    approved_by: Mapped[Optional[str]]
    approved_at: Mapped[Optional[datetime]]
    approval_reason: Mapped[Optional[str]]
    policy_ref: Mapped[Optional[str]]
    gate_snapshot_hash: Mapped[Optional[str]]
    gate_snapshot_json: Mapped[Optional[Any]]
    analysis_run: Mapped[WhitepaperAnalysisRun]
    viability_verdict: Mapped[Optional[WhitepaperViabilityVerdict]]
    rollout_transitions: Mapped[List["WhitepaperRolloutTransition"]]
    __table_args__: Any

class WhitepaperRolloutTransition(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    transition_id: Mapped[str]
    trigger_id: Mapped[uuid.UUID]
    whitepaper_run_id: Mapped[str]
    from_stage: Mapped[Optional[str]]
    to_stage: Mapped[Optional[str]]
    transition_type: Mapped[str]
    status: Mapped[str]
    gate_results_json: Mapped[Optional[Any]]
    reason_codes_json: Mapped[Optional[Any]]
    blocking_gate: Mapped[Optional[str]]
    evidence_hash: Mapped[Optional[str]]
    engineering_trigger: Mapped[WhitepaperEngineeringTrigger]
    __table_args__: Any

class AutoresearchEpoch(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    epoch_id: Mapped[str]
    status: Mapped[str]
    target_net_pnl_per_day: Mapped[Decimal]
    paper_run_ids_json: Mapped[Optional[Any]]
    snapshot_manifest_json: Mapped[Optional[Any]]
    runner_config_json: Mapped[Optional[Any]]
    summary_json: Mapped[Optional[Any]]
    started_at: Mapped[Optional[datetime]]
    completed_at: Mapped[Optional[datetime]]
    failure_reason: Mapped[Optional[str]]
    __table_args__: Any

class AutoresearchCandidateSpec(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    candidate_spec_id: Mapped[str]
    epoch_id: Mapped[str]
    hypothesis_id: Mapped[str]
    candidate_kind: Mapped[str]
    family_template_id: Mapped[str]
    payload_json: Mapped[Any]
    payload_hash: Mapped[str]
    status: Mapped[str]
    blockers_json: Mapped[Optional[Any]]
    __table_args__: Any

class AutoresearchProposalScore(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    epoch_id: Mapped[str]
    candidate_spec_id: Mapped[str]
    model_id: Mapped[str]
    backend: Mapped[str]
    proposal_score: Mapped[Decimal]
    rank: Mapped[int]
    selection_reason: Mapped[str]
    feature_hash: Mapped[Optional[str]]
    payload_json: Mapped[Optional[Any]]
    __table_args__: Any

class AutoresearchPortfolioCandidate(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    portfolio_candidate_id: Mapped[str]
    epoch_id: Mapped[str]
    source_candidate_ids_json: Mapped[Any]
    target_net_pnl_per_day: Mapped[Decimal]
    objective_scorecard_json: Mapped[Any]
    optimizer_report_json: Mapped[Any]
    payload_json: Mapped[Any]
    status: Mapped[str]
    __table_args__: Any

class PositionSnapshot(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    alpaca_account_label: Mapped[str]
    as_of: Mapped[datetime]
    equity: Mapped[Decimal]
    cash: Mapped[Decimal]
    buying_power: Mapped[Decimal]
    positions: Mapped[Any]
    __table_args__: Any

class ExecutionTCAMetric(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    execution_id: Mapped[uuid.UUID]
    trade_decision_id: Mapped[Optional[uuid.UUID]]
    strategy_id: Mapped[Optional[uuid.UUID]]
    alpaca_account_label: Mapped[Optional[str]]
    symbol: Mapped[str]
    side: Mapped[str]
    arrival_price: Mapped[Optional[Decimal]]
    avg_fill_price: Mapped[Optional[Decimal]]
    filled_qty: Mapped[Decimal]
    signed_qty: Mapped[Decimal]
    slippage_bps: Mapped[Optional[Decimal]]
    shortfall_notional: Mapped[Optional[Decimal]]
    expected_shortfall_bps_p50: Mapped[Optional[Decimal]]
    expected_shortfall_bps_p95: Mapped[Optional[Decimal]]
    realized_shortfall_bps: Mapped[Optional[Decimal]]
    divergence_bps: Mapped[Optional[Decimal]]
    simulator_version: Mapped[Optional[str]]
    churn_qty: Mapped[Decimal]
    churn_ratio: Mapped[Optional[Decimal]]
    computed_at: Mapped[datetime]
    __table_args__: Any

class LeanBacktestRun(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    backtest_id: Mapped[str]
    status: Mapped[str]
    requested_by: Mapped[Optional[str]]
    lane: Mapped[str]
    config_json: Mapped[Any]
    result_json: Mapped[Optional[Any]]
    artifacts_json: Mapped[Optional[Any]]
    reproducibility_hash: Mapped[Optional[str]]
    replay_hash: Mapped[Optional[str]]
    deterministic_replay_passed: Mapped[Optional[bool]]
    failure_taxonomy: Mapped[Optional[str]]
    completed_at: Mapped[Optional[datetime]]
    __table_args__: Any

class LeanExecutionShadowEvent(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    correlation_id: Mapped[Optional[str]]
    trade_decision_id: Mapped[Optional[uuid.UUID]]
    execution_id: Mapped[Optional[uuid.UUID]]
    symbol: Mapped[str]
    side: Mapped[str]
    qty: Mapped[Decimal]
    intent_notional: Mapped[Optional[Decimal]]
    simulated_fill_price: Mapped[Optional[Decimal]]
    simulated_slippage_bps: Mapped[Optional[Decimal]]
    parity_delta_bps: Mapped[Optional[Decimal]]
    parity_status: Mapped[str]
    failure_taxonomy: Mapped[Optional[str]]
    simulation_json: Mapped[Optional[Any]]
    __table_args__: Any

class LeanCanaryIncident(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    incident_key: Mapped[str]
    breach_type: Mapped[str]
    severity: Mapped[str]
    rollback_triggered: Mapped[bool]
    symbols: Mapped[Optional[Any]]
    evidence_json: Mapped[Optional[Any]]
    resolved_at: Mapped[Optional[datetime]]
    __table_args__: Any

class LeanStrategyShadowEvaluation(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_id: Mapped[str]
    strategy_id: Mapped[str]
    symbol: Mapped[str]
    intent_json: Mapped[Any]
    shadow_json: Mapped[Optional[Any]]
    parity_status: Mapped[str]
    governance_json: Mapped[Optional[Any]]
    disable_switch_active: Mapped[bool]
    __table_args__: Any

class ToolRunLog(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    codex_session_id: Mapped[str]
    tool_name: Mapped[str]
    request_payload: Mapped[Any]
    response_payload: Mapped[Any]
    success: Mapped[bool]
    __table_args__: Any

class TradeCursor(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    source: Mapped[str]
    account_label: Mapped[str]
    cursor_at: Mapped[datetime]
    cursor_seq: Mapped[Optional[int]]
    cursor_symbol: Mapped[Optional[str]]
    __table_args__: Any

class SimulationRuntimeContext(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    lane: Mapped[str]
    account_label: Mapped[str]
    run_id: Mapped[str]
    dataset_id: Mapped[Optional[str]]
    window_start: Mapped[Optional[datetime]]
    window_end: Mapped[Optional[datetime]]
    cache_key: Mapped[Optional[str]]
    cache_artifact_path: Mapped[Optional[str]]
    cache_manifest_path: Mapped[Optional[str]]
    warm_lane_enabled: Mapped[bool]
    metadata_json: Mapped[Any]
    __table_args__: Any

class SimulationRunProgress(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    run_id: Mapped[str]
    component: Mapped[str]
    dataset_id: Mapped[Optional[str]]
    lane: Mapped[str]
    workflow_name: Mapped[Optional[str]]
    status: Mapped[str]
    last_source_ts: Mapped[Optional[datetime]]
    last_signal_ts: Mapped[Optional[datetime]]
    last_price_ts: Mapped[Optional[datetime]]
    cursor_at: Mapped[Optional[datetime]]
    records_dumped: Mapped[int]
    records_replayed: Mapped[int]
    trade_decisions: Mapped[int]
    executions: Mapped[int]
    execution_tca_metrics: Mapped[int]
    execution_order_events: Mapped[int]
    strategy_type: Mapped[Optional[str]]
    legacy_path_count: Mapped[int]
    fallback_count: Mapped[int]
    terminal_state: Mapped[Optional[str]]
    last_error_code: Mapped[Optional[str]]
    last_error_message: Mapped[Optional[str]]
    payload_json: Mapped[Any]
    __table_args__: Any

class LLMDSPyWorkflowArtifact(Base, TimestampMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    run_key: Mapped[str]
    lane: Mapped[str]
    status: Mapped[str]
    implementation_spec_ref: Mapped[str]
    program_name: Mapped[Optional[str]]
    signature_version: Mapped[Optional[str]]
    optimizer: Mapped[Optional[str]]
    artifact_uri: Mapped[Optional[str]]
    artifact_hash: Mapped[Optional[str]]
    dataset_hash: Mapped[Optional[str]]
    compiled_prompt_hash: Mapped[Optional[str]]
    reproducibility_hash: Mapped[Optional[str]]
    metric_bundle: Mapped[Optional[Any]]
    gate_compatibility: Mapped[Optional[str]]
    promotion_recommendation: Mapped[Optional[str]]
    promotion_target: Mapped[Optional[str]]
    idempotency_key: Mapped[Optional[str]]
    agentrun_name: Mapped[Optional[str]]
    agentrun_namespace: Mapped[Optional[str]]
    agentrun_uid: Mapped[Optional[str]]
    request_payload_json: Mapped[Optional[Any]]
    response_payload_json: Mapped[Optional[Any]]
    metadata_json: Mapped[Optional[Any]]
    __table_args__: Any

class LLMDecisionReview(Base, CreatedAtMixin):
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    __tablename__: Any
    id: Mapped[uuid.UUID]
    trade_decision_id: Mapped[uuid.UUID]
    model: Mapped[str]
    prompt_version: Mapped[str]
    input_json: Mapped[Any]
    response_json: Mapped[Any]
    verdict: Mapped[str]
    confidence: Mapped[Optional[Decimal]]
    adjusted_qty: Mapped[Optional[Decimal]]
    adjusted_order_type: Mapped[Optional[str]]
    rationale: Mapped[Optional[str]]
    risk_flags: Mapped[Optional[Any]]
    tokens_prompt: Mapped[Optional[int]]
    tokens_completion: Mapped[Optional[int]]
    trade_decision: Mapped[TradeDecision]
    __table_args__: Any

__all__: Any
