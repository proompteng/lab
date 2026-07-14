"""Fail-closed schema for non-promotable broker infrastructure exercises."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

_MAX_PERMIT_LIFETIME = timedelta(minutes=15)
_VALIDATION_HOSTS = {
    "alpaca": "paper-api.alpaca.markets",
    "hyperliquid": "api.hyperliquid-testnet.xyz",
}
_Digest = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]


class InfrastructureValidationPermit(BaseModel):
    """Short-lived authority that cannot target or generate live evidence."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["torghut.infrastructure-validation-permit.v1"]
    permit_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    purpose: Literal["control_plane_validation"]
    venue: Literal["alpaca", "hyperliquid"]
    account_mode: Literal["paper", "sandbox"]
    market_session: Literal["regular", "continuous"]
    account_label: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    broker_base_url: AnyHttpUrl
    symbols: tuple[str, ...] = Field(min_length=1, max_length=20)
    sides: tuple[Literal["buy", "sell"], ...] = Field(min_length=1, max_length=2)
    order_types: tuple[Literal["market", "limit", "stop", "stop_limit"], ...] = Field(
        min_length=1, max_length=4
    )
    max_orders: int = Field(gt=0, le=20)
    max_outstanding_intents: int = Field(gt=0, le=20)
    max_notional_usd: Decimal = Field(gt=0)
    max_loss_usd: Decimal = Field(gt=0)
    issued_by: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    approved_by: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    issued_at: datetime
    expires_at: datetime
    test_plan_digest: _Digest
    expected_terminal_state: Literal["no_open_orders_no_positions_no_unsettled_claims"]
    expected_terminal_state_digest: _Digest
    evidence_tag: Literal["non_promotable_validation"]
    promotable: Literal[False]

    @field_validator("permit_id", "account_label", "issued_by", "approved_by")
    @classmethod
    def _normalize_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("validation_permit_required_text_empty")
        return normalized

    @field_validator("symbols")
    @classmethod
    def _normalize_symbols(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(value.strip().upper() for value in values)
        if (
            not normalized
            or len(set(normalized)) != len(normalized)
            or any(
                re.fullmatch(r"[A-Z0-9][A-Z0-9.-]{0,31}", value) is None
                for value in normalized
            )
        ):
            raise ValueError("validation_symbols_must_be_unique_and_nonempty")
        return normalized

    @field_validator("sides", "order_types")
    @classmethod
    def _require_unique_bounds(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(set(values)) != len(values):
            raise ValueError("validation_permit_bounds_must_be_unique")
        return values

    @field_validator("max_notional_usd", "max_loss_usd")
    @classmethod
    def _require_finite_money_bound(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("validation_permit_money_bound_must_be_finite")
        return value

    @model_validator(mode="after")
    def _validate_safety_boundary(self) -> "InfrastructureValidationPermit":
        if self.issued_at.tzinfo is None or self.expires_at.tzinfo is None:
            raise ValueError("validation_permit_timestamps_must_be_timezone_aware")
        lifetime = self.expires_at - self.issued_at
        if lifetime <= timedelta(0) or lifetime > _MAX_PERMIT_LIFETIME:
            raise ValueError("validation_permit_lifetime_out_of_bounds")
        if self.issued_by.casefold() == self.approved_by.casefold():
            raise ValueError("validation_permit_requires_independent_approval")
        if self.max_outstanding_intents > self.max_orders:
            raise ValueError("validation_permit_outstanding_exceeds_order_limit")
        if self.max_loss_usd > self.max_notional_usd:
            raise ValueError("validation_permit_loss_exceeds_notional")
        expected_mode_and_session = {
            "alpaca": ("paper", "regular"),
            "hyperliquid": ("sandbox", "continuous"),
        }[self.venue]
        if (self.account_mode, self.market_session) != expected_mode_and_session:
            raise ValueError("validation_permit_venue_boundary_mismatch")
        _validate_endpoint(self.venue, str(self.broker_base_url))
        return self


def authorize_infrastructure_validation(
    permit: InfrastructureValidationPermit,
    *,
    account_label: str,
    account_mode: str,
    broker_base_url: str,
    now: datetime,
) -> InfrastructureValidationPermit:
    """Bind a validated permit to the exact configured non-live account."""

    if now.tzinfo is None:
        raise ValueError("infrastructure_validation_now_must_be_timezone_aware")
    if now < permit.issued_at:
        raise ValueError("infrastructure_validation_permit_not_yet_active")
    if now >= permit.expires_at:
        raise ValueError("infrastructure_validation_permit_expired")
    if account_mode not in {"paper", "sandbox"} or account_mode != permit.account_mode:
        raise ValueError("infrastructure_validation_account_mode_mismatch")
    if account_label.strip() != permit.account_label:
        raise ValueError("infrastructure_validation_account_mismatch")
    _validate_endpoint(permit.venue, broker_base_url)
    return permit


def _validate_endpoint(venue: str, endpoint: str) -> None:
    expected_host = _VALIDATION_HOSTS.get(venue)
    parsed = _parse_endpoint(endpoint)
    if expected_host is None or str(parsed.host or "").lower() != expected_host:
        raise ValueError("infrastructure_validation_endpoint_not_sandbox")


def _parse_endpoint(endpoint: str) -> AnyHttpUrl:
    try:
        parsed = AnyHttpUrl(endpoint)
    except ValueError as exc:
        raise ValueError("infrastructure_validation_endpoint_invalid") from exc
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port != 443
        or parsed.path != "/"
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("infrastructure_validation_endpoint_invalid")
    return parsed


__all__ = [
    "InfrastructureValidationPermit",
    "authorize_infrastructure_validation",
]
