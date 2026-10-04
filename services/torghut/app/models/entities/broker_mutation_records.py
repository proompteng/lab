"""Immutable broker-mutation receipt headers and append-only event snapshots."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.schema import conv

from ..base import Base, GUID
from .broker_mutation_validation_contract import (
    BROKER_MUTATION_VALIDATION_AUTHORITY_SQL,
    BROKER_MUTATION_VALIDATION_LINEAGE_SQL,
    BROKER_MUTATION_VALIDATION_PERMIT_ID_SQL,
)

if TYPE_CHECKING:
    from .trading_records import TradeDecisionSubmissionClaim


class BrokerMutationReceipt(Base):
    """Immutable semantic identity and provenance for one broker mutation."""

    __tablename__ = "broker_mutation_receipts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    broker_route: Mapped[str] = mapped_column(String(length=32), nullable=False)
    account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    endpoint_fingerprint: Mapped[str] = mapped_column(String(length=64), nullable=False)
    operation: Mapped[str] = mapped_column(String(length=32), nullable=False)
    risk_class: Mapped[str] = mapped_column(String(length=32), nullable=False)
    purpose: Mapped[str] = mapped_column(String(length=64), nullable=False)
    submission_claim_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey(
            "trade_decision_submission_claims.trade_decision_id",
            name="fk_bm_receipt_submission_claim",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        nullable=True,
    )
    workflow_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    client_request_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    target_kind: Mapped[str] = mapped_column(String(length=32), nullable=False)
    target_key: Mapped[str] = mapped_column(String(length=256), nullable=False)
    intent_schema_version: Mapped[str] = mapped_column(
        String(length=64), nullable=False
    )
    canonical_intent_json: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_intent_sha256: Mapped[str] = mapped_column(
        String(length=64), nullable=False
    )
    creator_owner: Mapped[str] = mapped_column(String(length=128), nullable=False)
    origin_writer_generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    submission_claim: Mapped[Optional["TradeDecisionSubmissionClaim"]] = relationship(
        passive_deletes=True,
    )
    events: Mapped[list["BrokerMutationReceiptEvent"]] = relationship(
        back_populates="receipt",
        order_by="BrokerMutationReceiptEvent.sequence_no",
        passive_deletes=True,
    )

    __table_args__ = (
        CheckConstraint(
            "broker_route IN ('alpaca', 'hyperliquid')",
            name="broker_route",
        ),
        CheckConstraint(
            "operation IN ('submit_order', 'replace_order', 'cancel_order', "
            "'cancel_all_orders', 'close_position', 'close_all_positions')",
            name="operation",
        ),
        CheckConstraint(
            "risk_class IN ('risk_increasing', 'risk_reducing', 'risk_neutral')",
            name="risk_class",
        ),
        CheckConstraint(
            "purpose IN ('initial_submission', 'repricing', "
            "'inventory_conflict', 'opposite_side_cleanup', 'kill_switch', "
            "'governance', 'closeout', 'flatten', "
            "'operator', 'control_plane_validation')",
            name="purpose",
        ),
        CheckConstraint(
            "target_kind IN ('order', 'position', 'account')",
            name="target_kind",
        ),
        CheckConstraint(
            "length(account_label) BETWEEN 1 AND 64 "
            "AND length(workflow_id) BETWEEN 1 AND 128 "
            "AND length(client_request_id) BETWEEN 1 AND 128 "
            "AND length(target_key) BETWEEN 1 AND 256 "
            "AND length(creator_owner) BETWEEN 1 AND 128",
            name="required_text",
        ),
        CheckConstraint(
            "((operation = 'submit_order' AND target_kind = 'order' AND "
            "((broker_route = 'alpaca' AND (submission_claim_id IS NOT NULL OR "
            "(submission_claim_id IS NULL AND risk_class = 'risk_reducing' "
            "AND purpose IN ('closeout', 'flatten')))) OR "
            "(broker_route = 'alpaca' AND submission_claim_id IS NULL "
            "AND risk_class = 'risk_neutral' "
            "AND purpose = 'control_plane_validation') OR "
            "(broker_route = 'hyperliquid' AND submission_claim_id IS NULL "
            "AND risk_class = 'risk_increasing' "
            "AND purpose = 'initial_submission'))) OR "
            "(operation = 'replace_order' AND target_kind = 'order' "
            "AND broker_route = 'alpaca' AND submission_claim_id IS NULL "
            "AND risk_class = 'risk_neutral' "
            "AND purpose = 'repricing' "
            ") OR "
            "(operation = 'cancel_order' AND target_kind = 'order' "
            "AND submission_claim_id IS NULL) OR "
            "(operation = 'cancel_all_orders' AND target_kind = 'account' "
            "AND target_key = account_label AND submission_claim_id IS NULL "
            ") OR "
            "(operation = 'close_position' AND target_kind = 'position' "
            "AND submission_claim_id IS NULL "
            "AND risk_class = 'risk_reducing') OR "
            "(operation = 'close_all_positions' AND target_kind = 'account' "
            "AND target_key = account_label AND submission_claim_id IS NULL "
            "AND risk_class = 'risk_reducing'))",
            name="operation_contract",
        ),
        CheckConstraint(
            BROKER_MUTATION_VALIDATION_AUTHORITY_SQL,
            name=conv("ck_bm_receipt_validation_authority"),
        ).ddl_if(dialect="postgresql"),
        CheckConstraint(
            BROKER_MUTATION_VALIDATION_LINEAGE_SQL,
            name=conv("ck_bm_receipt_validation_lineage"),
        ).ddl_if(dialect="postgresql"),
        CheckConstraint("length(endpoint_fingerprint) = 64", name="endpoint_hash"),
        CheckConstraint(
            "intent_schema_version = 'torghut.broker-mutation-intent.v1'",
            name="intent_schema_version",
        ),
        CheckConstraint("length(canonical_intent_sha256) = 64", name="intent_hash"),
        CheckConstraint(
            "length(canonical_intent_json) BETWEEN 2 AND 65536",
            name="intent_size",
        ),
        CheckConstraint(
            "origin_writer_generation > 0",
            name="origin_gen_positive",
        ),
        UniqueConstraint(
            "broker_route",
            "account_label",
            "endpoint_fingerprint",
            "canonical_intent_sha256",
            name="uq_broker_mutation_receipt_intent",
        ),
        UniqueConstraint(
            "broker_route",
            "account_label",
            "endpoint_fingerprint",
            "operation",
            "client_request_id",
            name="uq_broker_mutation_receipt_client",
        ),
        Index(
            "ix_broker_mutation_receipts_claim",
            "submission_claim_id",
        ),
        Index(
            "uq_bm_receipt_submit_claim",
            "submission_claim_id",
            unique=True,
            postgresql_where=text(
                "operation = 'submit_order' AND submission_claim_id IS NOT NULL"
            ),
            sqlite_where=text(
                "operation = 'submit_order' AND submission_claim_id IS NOT NULL"
            ),
        ),
        Index(
            "uq_bm_receipt_validation_permit",
            text(BROKER_MUTATION_VALIDATION_PERMIT_ID_SQL),
            unique=True,
            postgresql_where=text("purpose = 'control_plane_validation'"),
        ).ddl_if(dialect="postgresql"),
        Index("ix_broker_mutation_receipts_workflow", "workflow_id"),
        Index(
            "ix_broker_mutation_receipts_target",
            "broker_route",
            "account_label",
            "target_kind",
            "target_key",
        ),
    )


class BrokerMutationReceiptEvent(Base):
    """Append-only full-state snapshot for one valid receipt transition."""

    __tablename__ = "broker_mutation_receipt_events"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    receipt_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey(
            "broker_mutation_receipts.id",
            name="fk_bm_receipt_event_receipt",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        nullable=False,
    )
    sequence_no: Mapped[int] = mapped_column(BigInteger, nullable=False)
    event_type: Mapped[str] = mapped_column(String(length=32), nullable=False)
    state: Mapped[str] = mapped_column(String(length=32), nullable=False)
    event_writer_generation: Mapped[int] = mapped_column(BigInteger, nullable=False)

    primary_token: Mapped[uuid.UUID] = mapped_column(GUID(), nullable=False)
    primary_epoch: Mapped[int] = mapped_column(BigInteger, nullable=False)
    primary_owner: Mapped[str] = mapped_column(String(length=128), nullable=False)
    primary_writer_generation: Mapped[int] = mapped_column(BigInteger, nullable=False)
    submission_claim_token: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), nullable=True
    )
    submission_claim_fencing_epoch: Mapped[Optional[int]] = mapped_column(
        BigInteger, nullable=True
    )
    submission_claim_owner: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    primary_claimed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    primary_lease_expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    released_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    release_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    broker_io_started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    recovery_after: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    recovery_token: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)
    recovery_epoch: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    recovery_owner: Mapped[Optional[str]] = mapped_column(
        String(length=128), nullable=True
    )
    recovery_writer_generation: Mapped[Optional[int]] = mapped_column(
        BigInteger, nullable=True
    )
    recovery_lease_started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    recovery_lease_expires_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    recovery_checked_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    recovery_observation_epoch: Mapped[Optional[int]] = mapped_column(
        BigInteger, nullable=True
    )
    recovery_outcome: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )

    settlement_source: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    settlement_outcome: Mapped[Optional[str]] = mapped_column(
        String(length=32), nullable=True
    )
    broker_reference: Mapped[Optional[str]] = mapped_column(
        String(length=256), nullable=True
    )
    execution_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(),
        ForeignKey(
            "executions.id",
            name="fk_bm_receipt_event_execution",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        nullable=True,
    )
    recovery_evidence_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    recovery_evidence_sha256: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    settlement_evidence_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    settlement_evidence_sha256: Mapped[Optional[str]] = mapped_column(
        String(length=64), nullable=True
    )
    settled_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    receipt: Mapped[BrokerMutationReceipt] = relationship(back_populates="events")

    __table_args__ = (
        UniqueConstraint(
            "receipt_id",
            "sequence_no",
            name="uq_broker_mutation_receipt_event_seq",
        ),
        CheckConstraint("sequence_no > 0", name="sequence_no_positive"),
        CheckConstraint("primary_epoch > 0", name="primary_epoch_positive"),
        CheckConstraint(
            "primary_lease_expires_at >= primary_claimed_at",
            name="primary_lease",
        ),
        CheckConstraint(
            "(submission_claim_token IS NULL "
            "AND submission_claim_fencing_epoch IS NULL "
            "AND submission_claim_owner IS NULL) OR "
            "(submission_claim_token IS NOT NULL "
            "AND submission_claim_fencing_epoch > 0 "
            "AND submission_claim_owner IS NOT NULL)",
            name="submission_claim_identity_all_or_none",
        ),
        CheckConstraint(
            "event_writer_generation > 0",
            name="event_gen_positive",
        ),
        CheckConstraint(
            "primary_writer_generation > 0",
            name="primary_gen_positive",
        ),
        CheckConstraint(
            "recovery_epoch >= 0",
            name="recovery_epoch_nonnegative",
        ),
        CheckConstraint(
            "recovery_writer_generation IS NULL OR recovery_writer_generation > 0",
            name="recovery_gen_positive",
        ),
        CheckConstraint(
            "event_type IN ('primary_claimed', 'primary_renewed', "
            "'primary_released', 'broker_io_started', 'recovery_claimed', "
            "'recovery_renewed', 'recovery_released', "
            "'recovery_observed', 'settled')",
            name="event_type",
        ),
        CheckConstraint(
            "state IN ('claimed', 'released', 'broker_io', 'settled')",
            name="state",
        ),
        CheckConstraint(
            "(event_type IN ('primary_claimed', 'primary_renewed') "
            "AND state = 'claimed') OR "
            "(event_type = 'primary_released' AND state = 'released') OR "
            "(event_type IN ('broker_io_started', 'recovery_claimed', "
            "'recovery_renewed', 'recovery_released', 'recovery_observed') "
            "AND state = 'broker_io') OR "
            "(event_type = 'settled' AND state = 'settled')",
            name="event_state",
        ),
        CheckConstraint(
            "recovery_outcome IS NULL OR "
            "recovery_outcome IN ('not_found', 'indeterminate')",
            name="recovery_outcome",
        ),
        CheckConstraint(
            "(recovery_epoch = 0 AND recovery_token IS NULL "
            "AND recovery_owner IS NULL "
            "AND recovery_writer_generation IS NULL "
            "AND recovery_lease_started_at IS NULL "
            "AND recovery_lease_expires_at IS NULL) OR "
            "(recovery_epoch > 0 AND recovery_token IS NOT NULL "
            "AND recovery_owner IS NOT NULL "
            "AND recovery_writer_generation IS NOT NULL "
            "AND recovery_lease_started_at IS NOT NULL "
            "AND recovery_lease_expires_at IS NOT NULL "
            "AND recovery_lease_expires_at >= recovery_lease_started_at)",
            name="recovery_lease_all_or_none",
        ),
        CheckConstraint(
            "state <> 'broker_io' OR "
            "(broker_io_started_at IS NOT NULL AND recovery_after IS NOT NULL)",
            name="broker_io_metadata",
        ),
        CheckConstraint(
            "state <> 'settled' OR settlement_outcome = 'already_satisfied' OR "
            "(broker_io_started_at IS NOT NULL AND recovery_after IS NOT NULL)",
            name="settled_broker_io_metadata",
        ),
        CheckConstraint(
            "(released_at IS NULL AND release_reason IS NULL) OR "
            "(released_at IS NOT NULL AND release_reason IS NOT NULL "
            "AND state = 'released' "
            "AND primary_lease_expires_at <= released_at)",
            name="release_metadata",
        ),
        CheckConstraint(
            "state <> 'released' OR "
            "(released_at IS NOT NULL AND release_reason IS NOT NULL)",
            name="released_state_metadata",
        ),
        CheckConstraint(
            "(recovery_checked_at IS NULL "
            "AND recovery_observation_epoch IS NULL "
            "AND recovery_outcome IS NULL "
            "AND recovery_evidence_json IS NULL "
            "AND recovery_evidence_sha256 IS NULL) OR "
            "(recovery_checked_at IS NOT NULL "
            "AND recovery_observation_epoch IS NOT NULL "
            "AND recovery_observation_epoch > 0 "
            "AND recovery_observation_epoch <= recovery_epoch "
            "AND recovery_outcome IS NOT NULL "
            "AND recovery_evidence_json IS NOT NULL "
            "AND recovery_evidence_sha256 IS NOT NULL)",
            name="recovery_observation_metadata",
        ),
        CheckConstraint(
            "event_type <> 'recovery_observed' OR "
            "(recovery_checked_at IS NOT NULL AND recovery_outcome IS NOT NULL "
            "AND recovery_evidence_json IS NOT NULL "
            "AND recovery_evidence_sha256 IS NOT NULL)",
            name="recovery_observed_evidence",
        ),
        CheckConstraint(
            "settlement_outcome IS NULL OR settlement_outcome IN "
            "('acknowledged', 'reconciled', 'rejected', 'already_satisfied', "
            "'validation_quarantine_closed')",
            name="settlement_outcome",
        ),
        CheckConstraint(
            "settlement_source IS NULL OR "
            "settlement_source IN "
            "('primary', 'recovery', 'preflight', 'operator_confirmation')",
            name="settlement_source",
        ),
        CheckConstraint(
            "settlement_outcome IS NULL OR "
            "(settlement_outcome = 'already_satisfied' "
            "AND settlement_source = 'preflight') OR "
            "(settlement_outcome = 'acknowledged' "
            "AND settlement_source = 'primary') OR "
            "(settlement_outcome IN ('reconciled', 'rejected') "
            "AND settlement_source IN ('primary', 'recovery')) OR "
            "(settlement_outcome = 'validation_quarantine_closed' "
            "AND settlement_source = 'operator_confirmation')",
            name="settlement_source_outcome",
        ),
        CheckConstraint(
            "settlement_source <> 'recovery' OR recovery_epoch > 0",
            name="recovery_settlement",
        ),
        CheckConstraint(
            "(state = 'settled' AND settlement_source IS NOT NULL "
            "AND settlement_outcome IS NOT NULL AND settled_at IS NOT NULL "
            "AND (settlement_outcome NOT IN ('acknowledged', 'reconciled') "
            "OR broker_reference IS NOT NULL)) OR "
            "(state <> 'settled' AND settlement_source IS NULL "
            "AND settlement_outcome IS NULL AND broker_reference IS NULL "
            "AND execution_id IS NULL "
            "AND settlement_evidence_json IS NULL "
            "AND settlement_evidence_sha256 IS NULL "
            "AND settled_at IS NULL)",
            name="settlement_metadata",
        ),
        CheckConstraint(
            "state <> 'settled' OR "
            "(settlement_evidence_json IS NOT NULL "
            "AND settlement_evidence_sha256 IS NOT NULL)",
            name="settlement_evidence",
        ),
        CheckConstraint(
            "(recovery_evidence_json IS NULL "
            "AND recovery_evidence_sha256 IS NULL) OR "
            "(recovery_evidence_json IS NOT NULL "
            "AND recovery_evidence_sha256 IS NOT NULL)",
            name="recovery_evidence_all_or_none",
        ),
        CheckConstraint(
            "recovery_evidence_sha256 IS NULL OR length(recovery_evidence_sha256) = 64",
            name="recovery_evidence_hash",
        ),
        CheckConstraint(
            "recovery_evidence_json IS NULL OR "
            "length(recovery_evidence_json) BETWEEN 2 AND 4096",
            name="recovery_evidence_size",
        ),
        CheckConstraint(
            "(settlement_evidence_json IS NULL "
            "AND settlement_evidence_sha256 IS NULL) OR "
            "(settlement_evidence_json IS NOT NULL "
            "AND settlement_evidence_sha256 IS NOT NULL)",
            name="settlement_evidence_pair",
        ),
        CheckConstraint(
            "settlement_evidence_sha256 IS NULL OR "
            "length(settlement_evidence_sha256) = 64",
            name="settlement_evidence_hash",
        ),
        CheckConstraint(
            "settlement_evidence_json IS NULL OR "
            "length(settlement_evidence_json) BETWEEN 2 AND 4096",
            name="settlement_evidence_size",
        ),
        Index(
            "ix_broker_mutation_receipt_latest",
            "receipt_id",
            "sequence_no",
        ),
        Index(
            "ix_broker_mutation_receipt_recovery_due",
            "state",
            "recovery_after",
            "recovery_lease_expires_at",
            "receipt_id",
            "sequence_no",
        ),
        Index(
            "ix_bm_receipt_event_broker_reference",
            "broker_reference",
            "receipt_id",
            postgresql_where=text("state = 'settled' AND broker_reference IS NOT NULL"),
            sqlite_where=text("state = 'settled' AND broker_reference IS NOT NULL"),
        ),
    )


__all__ = ["BrokerMutationReceipt", "BrokerMutationReceiptEvent"]
