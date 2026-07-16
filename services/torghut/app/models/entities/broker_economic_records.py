"""Immutable broker economic facts and their mutable ingest cursor."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, Index, Numeric, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from ..base import Base, GUID, JSONType
from .model_mixins import CreatedAtMixin, TimestampMixin


class BrokerAccountActivity(Base, CreatedAtMixin):
    """One append-only economic activity reported by the broker."""

    __tablename__ = "broker_account_activities"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    provider: Mapped[str] = mapped_column(String(length=32), nullable=False)
    source: Mapped[str] = mapped_column(String(length=64), nullable=False)
    environment: Mapped[str] = mapped_column(String(length=16), nullable=False)
    account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    endpoint_fingerprint: Mapped[str] = mapped_column(String(length=64), nullable=False)
    external_activity_id: Mapped[str] = mapped_column(
        String(length=256), nullable=False
    )
    activity_type: Mapped[str] = mapped_column(String(length=32), nullable=False)
    activity_subtype: Mapped[str | None] = mapped_column(
        String(length=32), nullable=True
    )
    correction_of_external_id: Mapped[str | None] = mapped_column(
        String(length=256), nullable=True
    )
    event_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    settle_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    order_id: Mapped[str | None] = mapped_column(String(length=128), nullable=True)
    client_order_id: Mapped[str | None] = mapped_column(
        String(length=128), nullable=True
    )
    symbol: Mapped[str | None] = mapped_column(String(length=64), nullable=True)
    side: Mapped[str | None] = mapped_column(String(length=16), nullable=True)
    quantity: Mapped[Decimal | None] = mapped_column(Numeric(38, 18), nullable=True)
    price: Mapped[Decimal | None] = mapped_column(Numeric(38, 18), nullable=True)
    cumulative_quantity: Mapped[Decimal | None] = mapped_column(
        Numeric(38, 18), nullable=True
    )
    leaves_quantity: Mapped[Decimal | None] = mapped_column(
        Numeric(38, 18), nullable=True
    )
    net_amount: Mapped[Decimal | None] = mapped_column(Numeric(38, 18), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(length=16), nullable=True)
    raw_payload: Mapped[dict[str, object]] = mapped_column(JSONType, nullable=False)
    raw_payload_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    raw_payload_sha256: Mapped[str] = mapped_column(String(length=64), nullable=False)
    normalized_economic_sha256: Mapped[str] = mapped_column(
        String(length=64), nullable=False
    )
    source_page_token: Mapped[str | None] = mapped_column(
        String(length=256), nullable=True
    )
    source_topic: Mapped[str | None] = mapped_column(String(length=128), nullable=True)
    source_partition: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    source_offset: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    first_observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    __table_args__ = (
        Index(
            "uq_broker_account_activities_external_identity",
            "provider",
            "source",
            "environment",
            "account_label",
            "external_activity_id",
            unique=True,
        ),
        Index(
            "ix_broker_account_activities_account_event",
            "account_label",
            "event_at",
            "external_activity_id",
        ),
        Index(
            "ix_broker_account_activities_type_event",
            "activity_type",
            "event_at",
        ),
        Index("ix_broker_account_activities_order", "order_id"),
        Index("ix_broker_account_activities_correction", "correction_of_external_id"),
        Index("ix_broker_account_activities_raw_sha256", "raw_payload_sha256"),
        Index(
            "ix_broker_account_activities_normalized_economic_sha256",
            "normalized_economic_sha256",
        ),
        Index(
            "uq_broker_account_activities_source_offset",
            "source_topic",
            "source_partition",
            "source_offset",
            unique=True,
            postgresql_where=text("source_offset IS NOT NULL"),
        ),
    )


class BrokerAccountActivityCursor(Base, TimestampMixin):
    """Durable progress for one broker activity pagination scope."""

    __tablename__ = "broker_account_activity_cursors"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    provider: Mapped[str] = mapped_column(String(length=32), nullable=False)
    source: Mapped[str] = mapped_column(String(length=64), nullable=False)
    environment: Mapped[str] = mapped_column(String(length=16), nullable=False)
    account_label: Mapped[str] = mapped_column(String(length=64), nullable=False)
    endpoint_fingerprint: Mapped[str] = mapped_column(String(length=64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(length=32), nullable=False, server_default=text("'idle'")
    )
    scan_after: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    scan_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    next_page_token: Mapped[str | None] = mapped_column(
        String(length=256), nullable=True
    )
    last_activity_id: Mapped[str | None] = mapped_column(
        String(length=256), nullable=True
    )
    last_activity_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    scan_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    pages_processed: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0")
    )
    activities_seen: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0")
    )
    activities_inserted: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0")
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index(
            "uq_broker_account_activity_cursors_scope",
            "provider",
            "source",
            "environment",
            "account_label",
            "endpoint_fingerprint",
            unique=True,
        ),
        Index("ix_broker_account_activity_cursors_status", "status"),
        Index("ix_broker_account_activity_cursors_updated_at", "updated_at"),
    )


__all__ = ("BrokerAccountActivity", "BrokerAccountActivityCursor")
