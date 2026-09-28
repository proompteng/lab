"""Persistence record for TigerBeetle reconciliation summaries."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column

from ..base import Base, GUID, JSONType
from .model_mixins import TimestampMixin


class TigerBeetleReconciliationRun(Base, TimestampMixin):
    """Summary row for TigerBeetle reconciliation checks."""

    __tablename__ = "tigerbeetle_reconciliation_runs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    cluster_id: Mapped[int] = mapped_column(BigInteger(), nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    finished_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    status: Mapped[str] = mapped_column(String(length=32), nullable=False)
    checked_transfer_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    missing_transfer_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    mismatched_transfer_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    source_missing_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    account_ref_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    transfer_ref_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    runtime_ledger_ref_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    runtime_ledger_signed_ref_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    runtime_ledger_missing_signed_ref_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    runtime_ledger_missing_account_ref_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    stable_ref_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    stable_ref_missing_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    stable_ref_mismatch_count: Mapped[int] = mapped_column(
        BigInteger(), nullable=False, server_default=text("0")
    )
    blockers_json: Mapped[Optional[object]] = mapped_column(JSONType, nullable=True)
    ref_counts_json: Mapped[Optional[object]] = mapped_column(JSONType, nullable=True)
    payload_json: Mapped[Optional[object]] = mapped_column(JSONType, nullable=True)

    __table_args__ = (
        Index("ix_tigerbeetle_reconciliation_runs_cluster_id", "cluster_id"),
        Index("ix_tigerbeetle_reconciliation_runs_status", "status"),
        Index("ix_tigerbeetle_reconciliation_runs_started_at", "started_at"),
    )


__all__ = ("TigerBeetleReconciliationRun",)
