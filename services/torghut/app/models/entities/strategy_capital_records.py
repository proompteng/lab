"""Persistence record for immutable strategy capital authorities."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..base import Base, GUID, JSONType
from .model_mixins import CreatedAtMixin
from .trading_records import Strategy


class StrategyCapitalAuthorityRecord(Base, CreatedAtMixin):
    """Insert-only strategy authority selected by an explicit Strategy pointer."""

    __tablename__ = "strategy_capital_authorities"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    authority_id: Mapped[str] = mapped_column(String(length=128), nullable=False)
    strategy_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("strategies.id", ondelete="RESTRICT"), nullable=False
    )
    schema_version: Mapped[str] = mapped_column(String(length=64), nullable=False)
    stage: Mapped[str] = mapped_column(String(length=32), nullable=False)
    authority_digest: Mapped[str] = mapped_column(String(length=71), nullable=False)
    payload_json: Mapped[dict[str, object]] = mapped_column(JSONType, nullable=False)
    issued_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    expires_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    strategy: Mapped[Strategy] = relationship(foreign_keys=[strategy_id])

    __table_args__ = (
        CheckConstraint(
            "schema_version = 'torghut.strategy-capital-authority.v1'",
            name="ck_strategy_capital_authorities_schema",
        ),
        CheckConstraint(
            "stage IN ('disabled', 'quarantined', 'research_only', "
            "'replay_verified', 'shadow_allowed', 'paper_probation', "
            "'paper_verified', 'micro_live_allowed', 'capital_allowed', 'scaled')",
            name="ck_strategy_capital_authorities_stage",
        ),
        CheckConstraint(
            "length(authority_digest) = 71 AND authority_digest LIKE 'sha256:%'",
            name="ck_strategy_capital_authorities_digest",
        ),
        CheckConstraint(
            "expires_at IS NULL OR issued_at IS NOT NULL",
            name="ck_strategy_capital_authorities_expiry_issuance",
        ),
        CheckConstraint(
            "expires_at IS NULL OR expires_at > issued_at",
            name="ck_strategy_capital_authorities_expiry_order",
        ),
        UniqueConstraint(
            "authority_id", name="uq_strategy_capital_authorities_authority_id"
        ),
        UniqueConstraint(
            "authority_digest", name="uq_strategy_capital_authorities_digest"
        ),
        UniqueConstraint(
            "id",
            "strategy_id",
            name="uq_strategy_capital_authorities_record_strategy",
        ),
        UniqueConstraint(
            "authority_id",
            "authority_digest",
            "strategy_id",
            name="uq_strategy_capital_authorities_identity",
        ),
        Index(
            "ix_strategy_capital_authorities_strategy_created",
            "strategy_id",
            "created_at",
        ),
    )


__all__ = ("StrategyCapitalAuthorityRecord",)
