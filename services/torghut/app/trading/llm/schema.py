"""Schemas for LLM trade decision reviews."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _positions_default() -> list[dict[str, Any]]:
    return []


def _account_default() -> dict[str, str]:
    return {}


def _recent_decisions_default() -> list["RecentDecisionSummary"]:
    return []


class LLMDecisionContext(BaseModel):
    """Minimal decision context passed to the LLM reviewer."""

    model_config = ConfigDict(extra="forbid")

    strategy_id: str
    symbol: str
    action: Literal["buy", "sell"]
    qty: Decimal
    order_type: Literal["market", "limit", "stop", "stop_limit"]
    time_in_force: Literal["day", "gtc", "ioc", "fok"]
    event_ts: datetime
    timeframe: str
    rationale: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)


class PortfolioSnapshot(BaseModel):
    """Portfolio snapshot supplied to the LLM reviewer."""

    model_config = ConfigDict(extra="forbid")

    equity: Optional[Decimal] = None
    cash: Optional[Decimal] = None
    buying_power: Optional[Decimal] = None
    total_exposure: Optional[Decimal] = None
    exposure_by_symbol: dict[str, Decimal] = Field(default_factory=dict)
    positions: list[dict[str, Any]] = Field(default_factory=_positions_default)


class MarketSnapshot(BaseModel):
    """Latest market data for the symbol."""

    model_config = ConfigDict(extra="forbid")

    symbol: str
    as_of: datetime
    price: Optional[Decimal] = None
    spread: Optional[Decimal] = None
    source: Optional[str] = None


class RecentDecisionSummary(BaseModel):
    """Recent decisions for the same symbol/strategy."""

    model_config = ConfigDict(extra="forbid")

    decision_id: str
    strategy_id: str
    symbol: str
    action: Literal["buy", "sell"]
    qty: Decimal
    status: str
    created_at: datetime
    rationale: Optional[str] = None
    price: Optional[Decimal] = None


class LLMPolicyContext(BaseModel):
    """Policy bounds used to validate any LLM adjustments."""

    model_config = ConfigDict(extra="forbid")

    adjustment_allowed: bool
    min_qty_multiplier: Decimal
    max_qty_multiplier: Decimal
    allowed_order_types: list[str]


class LLMReviewRequest(BaseModel):
    """Structured request payload sent to the LLM."""

    model_config = ConfigDict(extra="forbid")

    decision: LLMDecisionContext
    portfolio: PortfolioSnapshot
    market: Optional[MarketSnapshot] = None
    recent_decisions: list[RecentDecisionSummary] = Field(default_factory=_recent_decisions_default)
    account: dict[str, str] = Field(default_factory=_account_default)
    positions: list[dict[str, Any]] = Field(default_factory=_positions_default)
    policy: LLMPolicyContext
    trading_mode: Literal["paper", "live"]
    prompt_version: str


class LLMReviewResponse(BaseModel):
    """Structured response payload returned by the LLM."""

    # Some gateways prepend metadata or include extra keys even when prompted not to.
    # Ignore unknown fields but keep strict validation on required schema fields.
    model_config = ConfigDict(extra="ignore")

    verdict: Literal["approve", "veto", "adjust"]
    confidence: float = Field(ge=0.0, le=1.0)
    adjusted_qty: Optional[Decimal] = None
    adjusted_order_type: Optional[Literal["market", "limit", "stop", "stop_limit"]] = None
    limit_price: Optional[Decimal] = None
    rationale: str
    risk_flags: list[str] = Field(default_factory=list)

    @field_validator("rationale")
    @classmethod
    def validate_rationale(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("rationale_required")
        if len(trimmed) > 280:
            raise ValueError("rationale_too_long")
        return trimmed


__all__ = [
    "LLMDecisionContext",
    "PortfolioSnapshot",
    "MarketSnapshot",
    "RecentDecisionSummary",
    "LLMPolicyContext",
    "LLMReviewRequest",
    "LLMReviewResponse",
]
