"""Schemas for LLM trade decision reviews."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def _positions_default() -> list[dict[str, Any]]:
    return []


def _account_default() -> dict[str, str]:
    return {}


def _recent_decisions_default() -> list["RecentDecisionSummary"]:
    return []


def _market_context_citations_default() -> list["MarketContextCitation"]:
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


class MarketContextCitation(BaseModel):
    """Citation metadata for market-context sources."""

    model_config = ConfigDict(extra="forbid")

    source: str
    published_at: datetime = Field(alias="publishedAt")
    url: Optional[str] = None


class MarketContextDomain(BaseModel):
    """Normalized market-context domain block."""

    model_config = ConfigDict(extra="forbid")

    domain: Literal["technicals", "fundamentals", "news", "regime"]
    state: Literal["ok", "stale", "missing", "error"]
    as_of: Optional[datetime] = Field(default=None, alias="asOf")
    freshness_seconds: Optional[int] = Field(default=None, alias="freshnessSeconds")
    max_freshness_seconds: int = Field(alias="maxFreshnessSeconds")
    source_count: int = Field(alias="sourceCount")
    quality_score: float = Field(ge=0.0, le=1.0, alias="qualityScore")
    payload: dict[str, Any] = Field(default_factory=dict)
    citations: list[MarketContextCitation] = Field(default_factory=_market_context_citations_default)
    risk_flags: list[str] = Field(default_factory=list, alias="riskFlags")


class MarketContextDomains(BaseModel):
    """Grouped domain blocks in the market-context bundle."""

    model_config = ConfigDict(extra="forbid")

    technicals: MarketContextDomain
    fundamentals: MarketContextDomain
    news: MarketContextDomain
    regime: MarketContextDomain


class MarketContextBundle(BaseModel):
    """Versioned decision-time market context bundle."""

    model_config = ConfigDict(extra="forbid")

    context_version: str = Field(alias="contextVersion")
    symbol: str
    as_of_utc: datetime = Field(alias="asOfUtc")
    freshness_seconds: int = Field(alias="freshnessSeconds")
    quality_score: float = Field(ge=0.0, le=1.0, alias="qualityScore")
    source_count: int = Field(alias="sourceCount")
    risk_flags: list[str] = Field(default_factory=list, alias="riskFlags")
    domains: MarketContextDomains


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
    market_context: Optional[MarketContextBundle] = None
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

    verdict: Literal["approve", "veto", "adjust", "abstain", "escalate"]
    confidence: float = Field(ge=0.0, le=1.0)
    confidence_band: Literal["low", "medium", "high"]
    calibrated_probabilities: "LLMCalibratedProbabilities"
    uncertainty: "LLMUncertainty"
    calibration_metadata: dict[str, Any] = Field(default_factory=dict)
    adjusted_qty: Optional[Decimal] = None
    adjusted_order_type: Optional[Literal["market", "limit", "stop", "stop_limit"]] = None
    limit_price: Optional[Decimal] = None
    escalate_reason: Optional[str] = None
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

    @model_validator(mode="after")
    def validate_adjustment_requirements(self) -> "LLMReviewResponse":
        if self.verdict == "adjust" and self.adjusted_qty is None:
            raise ValueError("adjusted_qty_required_for_adjust_verdict")
        if self.adjusted_order_type in {"limit", "stop_limit"} and self.limit_price is None:
            raise ValueError("limit_price_required_for_limit_orders")
        return self


class LLMCalibratedProbabilities(BaseModel):
    """Calibrated per-verdict probabilities emitted by the reviewer."""

    model_config = ConfigDict(extra="forbid")

    approve: float = Field(ge=0.0, le=1.0)
    veto: float = Field(ge=0.0, le=1.0)
    adjust: float = Field(ge=0.0, le=1.0)
    abstain: float = Field(ge=0.0, le=1.0)
    escalate: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_sum(self) -> "LLMCalibratedProbabilities":
        total = self.approve + self.veto + self.adjust + self.abstain + self.escalate
        if abs(total - 1.0) > 0.02:
            raise ValueError("calibrated_probabilities_must_sum_to_one")
        return self


class LLMUncertainty(BaseModel):
    """Uncertainty envelope associated with the calibrated probabilities."""

    model_config = ConfigDict(extra="forbid")

    score: float = Field(ge=0.0, le=1.0)
    band: Literal["low", "medium", "high"]
    confidence_interval_low: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    confidence_interval_high: Optional[float] = Field(default=None, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_interval(self) -> "LLMUncertainty":
        if self.confidence_interval_low is None and self.confidence_interval_high is None:
            return self
        if self.confidence_interval_low is None or self.confidence_interval_high is None:
            raise ValueError("uncertainty_confidence_interval_incomplete")
        if self.confidence_interval_low > self.confidence_interval_high:
            raise ValueError("uncertainty_confidence_interval_invalid")
        return self


__all__ = [
    "LLMDecisionContext",
    "PortfolioSnapshot",
    "MarketSnapshot",
    "MarketContextCitation",
    "MarketContextDomain",
    "MarketContextDomains",
    "MarketContextBundle",
    "RecentDecisionSummary",
    "LLMPolicyContext",
    "LLMReviewRequest",
    "LLMReviewResponse",
    "LLMCalibratedProbabilities",
    "LLMUncertainty",
]
