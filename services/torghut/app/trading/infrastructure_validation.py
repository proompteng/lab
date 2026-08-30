"""Fail-closed authority for non-promotable broker infrastructure exercises."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal, Mapping, Self, TypeAlias

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
_MAX_SUBMIT_PROOF_NOTIONAL_USD = Decimal("1")
_MAX_LIFECYCLE_NOTIONAL_USD = Decimal("30")
_MIN_LIFECYCLE_LEG_PLAN_NOTIONAL_USD = Decimal("12")
INFRASTRUCTURE_VALIDATION_LIFECYCLE_PLAN_SCHEMA_VERSION = (
    "torghut.infrastructure-validation-lifecycle-plan.v2"
)
_INFRASTRUCTURE_VALIDATION_LIFECYCLE_PLAN_SCHEMA_VERSIONS = frozenset(
    {
        "torghut.infrastructure-validation-lifecycle-plan.v1",
        INFRASTRUCTURE_VALIDATION_LIFECYCLE_PLAN_SCHEMA_VERSION,
    }
)
_VALIDATION_HOSTS = {
    "alpaca": "paper-api.alpaca.markets",
    "hyperliquid": "api.hyperliquid-testnet.xyz",
}
_Digest = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
_EXPECTED_TERMINAL_STATE = "no_open_orders_no_positions_no_unsettled_claims"
_EXPECTED_TERMINAL_SCHEMA_VERSION = "torghut.infrastructure-validation-terminal.v1"


class InfrastructureValidationPermit(BaseModel):
    """Short-lived authority that cannot target or generate live evidence."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal["torghut.infrastructure-validation-permit.v2"]
    permit_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    purpose: Literal["control_plane_validation"]
    venue: Literal["alpaca", "hyperliquid"]
    asset_class: Literal["equity", "crypto", "perpetual"]
    account_mode: Literal["paper", "sandbox"]
    market_session: Literal["regular", "continuous"]
    account_label: Annotated[str, StringConstraints(min_length=1, max_length=64)]
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
        normalized = tuple(value.strip() for value in values)
        if (
            not normalized
            or len({value.casefold() for value in normalized}) != len(normalized)
            or any(not value for value in normalized)
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
            ("alpaca", "equity"): ("paper", "regular"),
            ("alpaca", "crypto"): ("paper", "continuous"),
            ("hyperliquid", "perpetual"): ("sandbox", "continuous"),
        }.get((self.venue, self.asset_class))
        if expected_mode_and_session is None:
            raise ValueError("validation_permit_asset_class_boundary_mismatch")
        if (self.account_mode, self.market_session) != expected_mode_and_session:
            raise ValueError("validation_permit_venue_boundary_mismatch")
        if any(
            not _valid_symbol_for_asset_class(symbol, self.asset_class)
            for symbol in self.symbols
        ):
            raise ValueError("validation_permit_symbol_asset_class_mismatch")
        _validate_endpoint(self.venue, str(self.broker_base_url))
        return self


class _InfrastructureValidationPlanBase(BaseModel):
    """Shared immutable envelope for one bounded Alpaca IOC entry."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    venue: Literal["alpaca"]
    asset_class: Literal["crypto"]
    symbol: Annotated[str, StringConstraints(min_length=1, max_length=32)]
    side: Literal["buy"]
    qty: Decimal = Field(gt=0)
    order_type: Literal["limit"]
    time_in_force: Literal["ioc"]
    limit_price: Decimal = Field(gt=0)
    stop_price: None = None

    @field_validator("symbol")
    @classmethod
    def _normalize_symbol(cls, value: str) -> str:
        return value.strip().upper()

    @field_validator("qty", "limit_price")
    @classmethod
    def _require_finite_order_decimal(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("infrastructure_validation_order_decimal_not_finite")
        return value

    @model_validator(mode="after")
    def _validate_asset_symbol(self) -> Self:
        if not _valid_symbol_for_asset_class(self.symbol, self.asset_class):
            raise ValueError("infrastructure_validation_order_symbol_invalid")
        if not (self.qty * self.limit_price).is_finite():
            raise ValueError("infrastructure_validation_order_notional_not_finite")
        return self

    @property
    def notional_usd(self) -> Decimal:
        return self.qty * self.limit_price


class InfrastructureValidationOrderPlan(_InfrastructureValidationPlanBase):
    """One known-null Alpaca IOC submit plan bound into a validation permit."""

    schema_version: Literal["torghut.infrastructure-validation-order-plan.v1"]


class InfrastructureValidationLifecyclePlan(_InfrastructureValidationPlanBase):
    """One bounded fill followed only by independently authorized reductions."""

    schema_version: Literal["torghut.infrastructure-validation-lifecycle-plan.v2"]
    resting_close_limit_price: Decimal = Field(gt=0)
    replacement_close_limit_price: Decimal = Field(gt=0)
    partial_close_qty: Decimal = Field(gt=0)

    @field_validator(
        "resting_close_limit_price",
        "replacement_close_limit_price",
        "partial_close_qty",
    )
    @classmethod
    def _require_finite_lifecycle_decimal(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("infrastructure_validation_lifecycle_decimal_not_finite")
        return value

    @model_validator(mode="after")
    def _validate_reduction_schedule(self) -> "InfrastructureValidationLifecyclePlan":
        if self.partial_close_qty >= self.qty:
            raise ValueError("infrastructure_validation_partial_close_not_partial")
        if self.resting_close_limit_price <= self.limit_price:
            raise ValueError("infrastructure_validation_close_price_not_resting")
        if self.replacement_close_limit_price <= self.resting_close_limit_price:
            raise ValueError("infrastructure_validation_replacement_not_resting")
        return self


InfrastructureValidationSubmitPlan: TypeAlias = (
    InfrastructureValidationOrderPlan | InfrastructureValidationLifecyclePlan
)


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


def authorize_infrastructure_validation_order(
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationSubmitPlan,
    *,
    account_label: str,
    broker_base_url: str,
    now: datetime,
) -> InfrastructureValidationPermit:
    """Bind one deterministic known-null IOC plan to one non-live account."""

    authorize_infrastructure_validation(
        permit,
        account_label=account_label,
        account_mode="paper",
        broker_base_url=broker_base_url,
        now=now,
    )
    if permit.venue != "alpaca" or plan.venue != permit.venue:
        raise ValueError("infrastructure_validation_order_venue_mismatch")
    if plan.asset_class != permit.asset_class:
        raise ValueError("infrastructure_validation_order_asset_class_mismatch")
    if permit.max_orders != 1 or permit.max_outstanding_intents != 1:
        raise ValueError("infrastructure_validation_submit_requires_single_intent")
    if plan.symbol not in permit.symbols:
        raise ValueError("infrastructure_validation_order_symbol_out_of_bounds")
    if plan.side not in permit.sides:
        raise ValueError("infrastructure_validation_order_side_out_of_bounds")
    if plan.order_type not in permit.order_types:
        raise ValueError("infrastructure_validation_order_type_out_of_bounds")
    if (
        permit.symbols != (plan.symbol,)
        or permit.sides != (plan.side,)
        or permit.order_types != (plan.order_type,)
    ):
        raise ValueError("infrastructure_validation_submit_bounds_not_exact")
    if plan.notional_usd > permit.max_notional_usd:
        raise ValueError("infrastructure_validation_order_notional_out_of_bounds")
    if plan.notional_usd > permit.max_loss_usd:
        raise ValueError("infrastructure_validation_order_loss_out_of_bounds")
    absolute_cap = (
        _MAX_LIFECYCLE_NOTIONAL_USD
        if isinstance(plan, InfrastructureValidationLifecyclePlan)
        else _MAX_SUBMIT_PROOF_NOTIONAL_USD
    )
    if (
        permit.max_notional_usd > absolute_cap
        or permit.max_loss_usd > absolute_cap
        or plan.notional_usd > absolute_cap
    ):
        raise ValueError("infrastructure_validation_submit_exceeds_absolute_cap")
    if isinstance(plan, InfrastructureValidationLifecyclePlan):
        _validate_lifecycle_leg_plan_notional(plan)
    if infrastructure_validation_plan_sha256(plan) != permit.test_plan_digest:
        raise ValueError("infrastructure_validation_order_plan_digest_mismatch")
    if (
        infrastructure_validation_terminal_state_sha256()
        != permit.expected_terminal_state_digest
    ):
        raise ValueError("infrastructure_validation_terminal_digest_mismatch")
    return permit


def _validate_lifecycle_leg_plan_notional(
    plan: InfrastructureValidationLifecyclePlan,
) -> None:
    residual_quantity = plan.qty - plan.partial_close_qty
    for field, quantity in (
        ("partial_close", plan.partial_close_qty),
        ("residual_close", residual_quantity),
    ):
        if quantity * plan.limit_price < _MIN_LIFECYCLE_LEG_PLAN_NOTIONAL_USD:
            raise ValueError(
                "infrastructure_validation_"
                f"{field}_plan_notional_below_broker_cost_basis_floor"
            )


def infrastructure_validation_order_plan_sha256(
    plan: InfrastructureValidationOrderPlan,
) -> str:
    return infrastructure_validation_plan_sha256(plan)


def infrastructure_validation_lifecycle_plan_sha256(
    plan: InfrastructureValidationLifecyclePlan,
) -> str:
    return infrastructure_validation_plan_sha256(plan)


def is_infrastructure_validation_lifecycle_plan_schema(value: object) -> bool:
    """Recognize both immutable historical v1 and current floor-enforced v2."""

    return (
        isinstance(value, str)
        and value in _INFRASTRUCTURE_VALIDATION_LIFECYCLE_PLAN_SCHEMA_VERSIONS
    )


def infrastructure_validation_plan_sha256(
    plan: InfrastructureValidationSubmitPlan,
) -> str:
    return _canonical_model_sha256(plan)


def infrastructure_validation_terminal_state_payload() -> dict[str, str]:
    return {
        "schema_version": _EXPECTED_TERMINAL_SCHEMA_VERSION,
        "state": _EXPECTED_TERMINAL_STATE,
    }


def infrastructure_validation_terminal_state_sha256() -> str:
    payload = infrastructure_validation_terminal_state_payload()
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def infrastructure_validation_permit_sha256(
    permit: InfrastructureValidationPermit,
) -> str:
    return _canonical_model_sha256(permit)


def infrastructure_validation_client_order_id(
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationSubmitPlan,
) -> str:
    """Return the sole broker identity available to this immutable permit."""

    identity = hashlib.sha256(
        (
            f"{permit.permit_id}\x1f{infrastructure_validation_permit_sha256(permit)}"
            f"\x1f{infrastructure_validation_plan_sha256(plan)}"
        ).encode("utf-8")
    ).hexdigest()
    return f"ivp-{identity[:44]}"


def infrastructure_validation_request_payload(
    permit: InfrastructureValidationPermit,
    plan: InfrastructureValidationSubmitPlan,
) -> dict[str, object]:
    """Build the exact non-promotable envelope sealed into the durable intent."""

    client_order_id = infrastructure_validation_client_order_id(permit, plan)
    permit_payload = permit.model_dump(mode="json")
    plan_payload = plan.model_dump(mode="json")
    return {
        "broker_request": {
            "symbol": plan.symbol,
            "side": plan.side,
            "qty": str(plan.qty),
            "order_type": plan.order_type,
            "time_in_force": plan.time_in_force,
            "limit_price": str(plan.limit_price),
            "stop_price": None,
            "extra_params": {"client_order_id": client_order_id},
        },
        "infrastructure_validation": {
            "permit": permit_payload,
            "permit_sha256": infrastructure_validation_permit_sha256(permit),
            "test_plan": plan_payload,
            "test_plan_sha256": infrastructure_validation_plan_sha256(plan),
            "expected_terminal_state": infrastructure_validation_terminal_state_payload(),
            "expected_terminal_state_sha256": infrastructure_validation_terminal_state_sha256(),
        },
    }


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


def _valid_symbol_for_asset_class(symbol: str, asset_class: str) -> bool:
    patterns = {
        "equity": r"[A-Z][A-Z0-9.-]{0,31}",
        "crypto": r"[A-Z0-9][A-Z0-9.-]{0,15}/[A-Z0-9][A-Z0-9.-]{0,15}",
        "perpetual": r"(?:[A-Z0-9][A-Z0-9.-]{0,31}|[a-z][a-z0-9-]{0,15}:[A-Z0-9][A-Z0-9.-]{0,31})",
    }
    pattern = patterns.get(asset_class)
    return pattern is not None and re.fullmatch(pattern, symbol) is not None


def _canonical_model_sha256(model: BaseModel) -> str:
    return hashlib.sha256(
        _canonical_json(model.model_dump(mode="json")).encode("utf-8")
    ).hexdigest()


def _canonical_json(payload: Mapping[str, object]) -> str:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


__all__ = [
    "INFRASTRUCTURE_VALIDATION_LIFECYCLE_PLAN_SCHEMA_VERSION",
    "InfrastructureValidationLifecyclePlan",
    "InfrastructureValidationPermit",
    "InfrastructureValidationOrderPlan",
    "InfrastructureValidationSubmitPlan",
    "authorize_infrastructure_validation",
    "authorize_infrastructure_validation_order",
    "infrastructure_validation_client_order_id",
    "infrastructure_validation_lifecycle_plan_sha256",
    "infrastructure_validation_order_plan_sha256",
    "infrastructure_validation_plan_sha256",
    "infrastructure_validation_permit_sha256",
    "infrastructure_validation_request_payload",
    "infrastructure_validation_terminal_state_payload",
    "infrastructure_validation_terminal_state_sha256",
    "is_infrastructure_validation_lifecycle_plan_schema",
]
