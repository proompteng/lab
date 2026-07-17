"""Append-only order-lineage repair receipts."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.schema import conv

from ..base import Base, GUID, JSONType
from .model_mixins import CreatedAtMixin


class OrderLineageRepairReceipt(Base, CreatedAtMixin):
    """One immutable observation of all evidence for a broker order identity."""

    __tablename__ = "order_lineage_repair_receipts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    repair_version: Mapped[str] = mapped_column(String(length=64), nullable=False)
    provider: Mapped[str] = mapped_column(String(length=32), nullable=False)
    environment: Mapped[str] = mapped_column(String(length=16), nullable=False)
    account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    order_identity_sha256: Mapped[str] = mapped_column(
        String(length=64), nullable=False
    )
    alpaca_order_id: Mapped[str | None] = mapped_column(
        String(length=128), nullable=True
    )
    client_order_id: Mapped[str | None] = mapped_column(
        String(length=128), nullable=True
    )
    classification: Mapped[str] = mapped_column(String(length=32), nullable=False)
    confidence: Mapped[str] = mapped_column(String(length=16), nullable=False)
    execution_source: Mapped[str] = mapped_column(String(length=32), nullable=False)
    source_first_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    source_last_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    evidence: Mapped[dict[str, object]] = mapped_column(JSONType, nullable=False)
    evidence_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    promotion_authority_eligible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "length(repair_version) BETWEEN 1 AND 64 "
            "AND length(provider) BETWEEN 1 AND 32 "
            "AND length(environment) BETWEEN 1 AND 16 "
            "AND length(account_label) BETWEEN 1 AND 64",
            name=conv("ck_order_lineage_receipt_scope"),
        ),
        CheckConstraint(
            "length(order_identity_sha256) = 64 AND length(evidence_sha256) = 64",
            name=conv("ck_order_lineage_receipt_hashes"),
        ),
        CheckConstraint(
            "alpaca_order_id IS NOT NULL OR client_order_id IS NOT NULL",
            name=conv("ck_order_lineage_receipt_order_identity"),
        ),
        CheckConstraint(
            "classification IN ('complete', 'linked_incomplete', "
            "'external_or_unproved', 'ambiguous', 'broker_activity_only', "
            "'order_feed_only')",
            name=conv("ck_order_lineage_receipt_classification"),
        ),
        CheckConstraint(
            "confidence IN ('exact', 'unproved', 'ambiguous')",
            name=conv("ck_order_lineage_receipt_confidence"),
        ),
        CheckConstraint(
            "execution_source IN ('local', 'canonical_cross_dsn', 'none')",
            name=conv("ck_order_lineage_receipt_execution_source"),
        ),
        CheckConstraint(
            "source_first_at <= source_last_at",
            name=conv("ck_order_lineage_receipt_source_window"),
        ),
        CheckConstraint(
            "promotion_authority_eligible IS FALSE",
            name=conv("ck_order_lineage_receipt_non_promotional"),
        ),
        CheckConstraint(
            "(classification IN ('complete', 'linked_incomplete') "
            "AND confidence = 'exact' AND execution_source <> 'none') OR "
            "(classification = 'ambiguous' AND confidence = 'ambiguous' "
            "AND execution_source = 'none') OR "
            "(classification = 'external_or_unproved' "
            "AND confidence = 'unproved' AND execution_source = 'none') OR "
            "(classification IN ('broker_activity_only', 'order_feed_only') "
            "AND ((confidence = 'exact' AND execution_source <> 'none') OR "
            "(confidence = 'unproved' AND execution_source = 'none')))",
            name=conv("ck_order_lineage_receipt_classification_confidence"),
        ),
        Index(
            "uq_order_lineage_receipt_evidence",
            "order_identity_sha256",
            "repair_version",
            "evidence_sha256",
            unique=True,
        ),
        Index(
            "ix_order_lineage_receipt_current",
            "repair_version",
            "order_identity_sha256",
            "source_last_at",
            "created_at",
        ),
        Index(
            "ix_order_lineage_receipt_classification",
            "repair_version",
            "classification",
            "confidence",
        ),
        Index(
            "ix_order_lineage_receipt_alpaca_alias",
            "repair_version",
            "provider",
            "environment",
            "account_label",
            "alpaca_order_id",
            postgresql_where=text("alpaca_order_id IS NOT NULL"),
        ),
        Index(
            "ix_order_lineage_receipt_client_alias",
            "repair_version",
            "provider",
            "environment",
            "account_label",
            "client_order_id",
            postgresql_where=text("client_order_id IS NOT NULL"),
        ),
    )


class OrderLineageRepairRun(Base, CreatedAtMixin):
    """One immutable, closed census over current order-lineage evidence."""

    __tablename__ = "order_lineage_repair_runs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    repair_version: Mapped[str] = mapped_column(String(length=64), nullable=False)
    provider: Mapped[str] = mapped_column(String(length=32), nullable=False)
    environment: Mapped[str] = mapped_column(String(length=16), nullable=False)
    account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    broker_economic_input_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey(
            "broker_economic_ledger_inputs.id",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        nullable=False,
    )
    input_manifest: Mapped[dict[str, object]] = mapped_column(JSONType, nullable=False)
    input_manifest_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    input_manifest_sha256: Mapped[str] = mapped_column(
        String(length=64), nullable=False
    )
    receipt_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    result: Mapped[dict[str, object]] = mapped_column(JSONType, nullable=False)
    result_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    result_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    promotion_authority_eligible: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "length(repair_version) BETWEEN 1 AND 64 "
            "AND length(provider) BETWEEN 1 AND 32 "
            "AND length(environment) BETWEEN 1 AND 16 "
            "AND length(account_label) BETWEEN 1 AND 64",
            name=conv("ck_order_lineage_run_scope"),
        ),
        CheckConstraint(
            "length(input_manifest_sha256) = 64 AND length(result_sha256) = 64",
            name=conv("ck_order_lineage_run_hashes"),
        ),
        CheckConstraint(
            "receipt_count >= 0",
            name=conv("ck_order_lineage_run_receipt_count"),
        ),
        CheckConstraint(
            "promotion_authority_eligible IS FALSE",
            name=conv("ck_order_lineage_run_non_promotional"),
        ),
        Index(
            "uq_order_lineage_run_input",
            "repair_version",
            "provider",
            "environment",
            "account_label",
            "input_manifest_sha256",
            unique=True,
        ),
        Index(
            "ix_order_lineage_run_current",
            "repair_version",
            "provider",
            "environment",
            "account_label",
            "created_at",
        ),
        Index(
            "ix_order_lineage_run_broker_input",
            "broker_economic_input_id",
        ),
    )


__all__ = ("OrderLineageRepairReceipt", "OrderLineageRepairRun")
