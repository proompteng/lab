"""Append-only broker-economic ledger inputs, projections, and journal lines."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..base import Base, GUID, JSONType
from .model_mixins import CreatedAtMixin


class BrokerEconomicLedgerInput(Base, CreatedAtMixin):
    """One immutable closed REST source manifest shared by both reducers."""

    __tablename__ = "broker_economic_ledger_inputs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    provider: Mapped[str] = mapped_column(String(length=32), nullable=False)
    source: Mapped[str] = mapped_column(String(length=64), nullable=False)
    environment: Mapped[str] = mapped_column(String(length=16), nullable=False)
    account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    endpoint_fingerprint: Mapped[str] = mapped_column(String(length=64), nullable=False)
    quote_currency: Mapped[str] = mapped_column(String(length=16), nullable=False)
    source_cursor_id: Mapped[uuid.UUID] = mapped_column(GUID(), nullable=False)
    source_watermark: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    input_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    duplicate_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    corrected_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    manifest_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    manifest_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)

    __table_args__ = (
        Index(
            "uq_broker_economic_ledger_inputs_identity",
            "provider",
            "source",
            "environment",
            "account_label",
            "endpoint_fingerprint",
            "source_cursor_id",
            "manifest_sha256",
            unique=True,
        ),
        Index(
            "ix_broker_economic_ledger_inputs_scope_watermark",
            "provider",
            "environment",
            "account_label",
            "source_watermark",
        ),
    )


class BrokerEconomicLedgerRun(Base, CreatedAtMixin):
    """One immutable reducer result over one shared input envelope."""

    __tablename__ = "broker_economic_ledger_runs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    input_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey(
            "broker_economic_ledger_inputs.id",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        nullable=False,
    )
    reducer_name: Mapped[str] = mapped_column(String(length=64), nullable=False)
    reducer_version: Mapped[str] = mapped_column(String(length=128), nullable=False)
    unsupported_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    transaction_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    entry_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    admissible: Mapped[bool] = mapped_column(Boolean, nullable=False)
    result: Mapped[dict[str, object]] = mapped_column(JSONType, nullable=False)
    result_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    result_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    projection_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    comparison_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    journal_sha256: Mapped[str | None] = mapped_column(String(length=64), nullable=True)

    __table_args__ = (
        Index(
            "uq_broker_economic_ledger_runs_identity",
            "input_id",
            "reducer_name",
            "reducer_version",
            unique=True,
        ),
    )


class BrokerEconomicLedgerEntry(Base, CreatedAtMixin):
    """One immutable balanced journal line, inserted before its sealed run."""

    __tablename__ = "broker_economic_ledger_entries"

    run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey(
            "broker_economic_ledger_runs.id",
            deferrable=True,
            initially="DEFERRED",
        ),
        primary_key=True,
    )
    transaction_index: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    line_number: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source_activity_id: Mapped[str] = mapped_column(String(length=256), nullable=False)
    transaction_id: Mapped[str] = mapped_column(String(length=512), nullable=False)
    reverses_transaction_id: Mapped[str | None] = mapped_column(
        String(length=512), nullable=True
    )
    posting_rule: Mapped[str] = mapped_column(String(length=128), nullable=False)
    transaction_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    account: Mapped[str] = mapped_column(String(length=128), nullable=False)
    commodity: Mapped[str] = mapped_column(String(length=64), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(38, 18), nullable=False)

    __table_args__ = (
        Index(
            "uq_broker_economic_ledger_entries_transaction_line",
            "run_id",
            "transaction_id",
            "line_number",
            unique=True,
        ),
    )


class BrokerEconomicLedgerReconciliation(Base, CreatedAtMixin):
    """One immutable fresh-broker observation of a published reducer pair."""

    __tablename__ = "broker_economic_ledger_reconciliations"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    input_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("broker_economic_ledger_inputs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    journal_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("broker_economic_ledger_runs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    state_run_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("broker_economic_ledger_runs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    input_source_watermark: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    source_watermark: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    source_age_seconds: Mapped[int] = mapped_column(BigInteger, nullable=False)
    max_source_age_seconds: Mapped[int] = mapped_column(BigInteger, nullable=False)
    broker_snapshot: Mapped[dict[str, object]] = mapped_column(JSONType, nullable=False)
    broker_snapshot_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    broker_snapshot_sha256: Mapped[str] = mapped_column(
        String(length=64), nullable=False
    )
    result: Mapped[dict[str, object]] = mapped_column(JSONType, nullable=False)
    result_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    result_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    comparison_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    journal_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    reconciled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    residual_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    open_order_count: Mapped[int] = mapped_column(BigInteger, nullable=False)
    source_commit: Mapped[str] = mapped_column(String(length=64), nullable=False)
    image_digest: Mapped[str] = mapped_column(String(length=128), nullable=False)

    __table_args__ = (
        Index(
            "uq_broker_econ_recon_observation",
            "journal_run_id",
            "state_run_id",
            "observed_at",
            "broker_snapshot_sha256",
            unique=True,
        ),
        Index(
            "ix_broker_econ_recon_latest",
            "input_id",
            "observed_at",
        ),
    )


__all__ = (
    "BrokerEconomicLedgerEntry",
    "BrokerEconomicLedgerInput",
    "BrokerEconomicLedgerReconciliation",
    "BrokerEconomicLedgerRun",
)
