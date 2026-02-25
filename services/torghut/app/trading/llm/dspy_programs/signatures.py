"""Typed DSPy-style signatures for Torghut advisory review programs."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


DSPyCommitteeRole = Literal["researcher", "risk_critic", "execution_critic", "policy_judge"]
DSPyVerdict = Literal["approve", "veto", "adjust", "abstain", "escalate"]


def _committee_default() -> list["DSPyCommitteeMemberOutput"]:
    return []


class DSPyCommitteeMemberOutput(BaseModel):
    """Structured per-role advisory output."""

    model_config = ConfigDict(extra="forbid")

    role: DSPyCommitteeRole
    verdict: DSPyVerdict
    confidence: float = Field(ge=0.0, le=1.0)
    uncertainty_band: Literal["low", "medium", "high"] = Field(alias="uncertaintyBand")
    rationale_short: str = Field(alias="rationaleShort")
    required_checks: list[str] = Field(default_factory=list, alias="requiredChecks")
    risk_flags: list[str] = Field(default_factory=list, alias="riskFlags")
    adjusted_qty: str | None = Field(default=None, alias="adjustedQty")
    adjusted_order_type: Literal["market", "limit", "stop", "stop_limit"] | None = Field(
        default=None,
        alias="adjustedOrderType",
    )
    limit_price: str | None = Field(default=None, alias="limitPrice")

    @field_validator("rationale_short")
    @classmethod
    def validate_rationale_short(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("rationale_short_required")
        if len(trimmed) > 280:
            raise ValueError("rationale_short_too_long")
        return trimmed


class DSPyTradeReviewInput(BaseModel):
    """Canonical DSPy program input contract for trade-review advisory calls."""

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(alias="schemaVersion")
    request_json: dict[str, Any] = Field(alias="requestJson")
    advisory_only: bool = Field(default=True, alias="advisoryOnly")
    program_name: str = Field(alias="programName")
    signature_version: str = Field(alias="signatureVersion")
    artifact_hash: str = Field(alias="artifactHash")
    market_session: str | None = Field(default=None, alias="marketSession")


class DSPyTradeReviewOutput(BaseModel):
    """Canonical DSPy program output before adaptation to LLMReviewResponse."""

    model_config = ConfigDict(extra="forbid")

    verdict: DSPyVerdict
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str
    rationale_short: str | None = Field(default=None, alias="rationaleShort")
    required_checks: list[str] = Field(default_factory=list, alias="requiredChecks")
    risk_flags: list[str] = Field(default_factory=list, alias="riskFlags")
    adjusted_qty: str | None = Field(default=None, alias="adjustedQty")
    adjusted_order_type: Literal["market", "limit", "stop", "stop_limit"] | None = Field(
        default=None,
        alias="adjustedOrderType",
    )
    limit_price: str | None = Field(default=None, alias="limitPrice")
    escalate_reason: str | None = Field(default=None, alias="escalateReason")
    uncertainty_band: Literal["low", "medium", "high"] = Field(default="medium", alias="uncertaintyBand")
    committee: list[DSPyCommitteeMemberOutput] = Field(default_factory=_committee_default)
    calibration_metadata: dict[str, Any] = Field(default_factory=dict, alias="calibrationMetadata")

    @field_validator("rationale")
    @classmethod
    def validate_rationale(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("rationale_required")
        if len(trimmed) > 280:
            raise ValueError("rationale_too_long")
        return trimmed

    @field_validator("rationale_short")
    @classmethod
    def validate_rationale_short(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            return None
        if len(trimmed) > 280:
            raise ValueError("rationale_short_too_long")
        return trimmed

    @model_validator(mode="after")
    def validate_adjustment_requirements(self) -> "DSPyTradeReviewOutput":
        if self.verdict == "adjust" and self.adjusted_qty is None:
            raise ValueError("adjusted_qty_required_for_adjust_verdict")
        if self.verdict == "escalate" and self.escalate_reason is None:
            raise ValueError("escalate_reason_required_for_escalate_verdict")
        if self.adjusted_order_type in {"limit", "stop_limit"} and self.limit_price is None:
            raise ValueError("limit_price_required_for_limit_orders")
        return self


__all__ = [
    "DSPyCommitteeRole",
    "DSPyVerdict",
    "DSPyCommitteeMemberOutput",
    "DSPyTradeReviewInput",
    "DSPyTradeReviewOutput",
]
