"""One immutable economic policy shared by research and broker-facing stages."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import date, time
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Literal, Self, cast

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from .costs import CostModelConfig, TransactionCostModel
from .quote_quality import QuoteQualityPolicy
from .session_context.features import (
    REGULAR_CLOSE_LOCAL,
    REGULAR_OPEN_LOCAL,
    US_EQUITIES_TIMEZONE,
)

if TYPE_CHECKING:
    from .execution_policy.policy_types import ExecutionPolicyConfig

ECONOMIC_POLICY_SCHEMA_VERSION = "torghut.economic-policy.v1"
DEFAULT_ECONOMIC_POLICY_PATH = (
    Path(__file__).resolve().parents[2] / "config" / "economic-policy-v1.json"
)

PositiveFraction = Annotated[Decimal, Field(gt=0, le=1)]
NonNegativeDecimal = Annotated[Decimal, Field(ge=0)]
PositiveDecimal = Annotated[Decimal, Field(gt=0)]


class EconomicPolicyError(RuntimeError):
    """Raised when the configured policy cannot safely govern execution."""


class StrictPolicyModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SessionPolicy(StrictPolicyModel):
    calendar: Literal["XNYS"]
    timezone_name: Literal["America/New_York"]
    weekdays: tuple[int, ...]
    regular_open: time
    new_exposure_cutoff: time
    flatten_start: time
    flat_confirmation: time
    regular_close: time
    allow_extended_hours: Literal[False]

    @field_validator("weekdays")
    @classmethod
    def _validate_weekdays(cls, value: tuple[int, ...]) -> tuple[int, ...]:
        normalized = tuple(dict.fromkeys(value))
        if normalized != (0, 1, 2, 3, 4) or normalized != value:
            raise ValueError("XNYS weekdays must be Monday through Friday")
        return normalized

    @model_validator(mode="after")
    def _validate_session_order(self) -> Self:
        ordered = (
            self.regular_open,
            self.new_exposure_cutoff,
            self.flatten_start,
            self.flat_confirmation,
            self.regular_close,
        )
        if any(value.tzinfo is not None for value in ordered):
            raise ValueError("session times must be local wall-clock values")
        if tuple(sorted(ordered)) != ordered or len(set(ordered)) != len(ordered):
            raise ValueError("session boundaries must be strictly increasing")
        if self.regular_open != REGULAR_OPEN_LOCAL:
            raise ValueError("regular open differs from the XNYS engine boundary")
        if self.regular_close != REGULAR_CLOSE_LOCAL:
            raise ValueError("regular close differs from the XNYS engine boundary")
        if self.timezone_name != US_EQUITIES_TIMEZONE:
            raise ValueError("session timezone differs from the XNYS engine timezone")
        return self


class SizingPolicy(StrictPolicyModel):
    allow_shorts: bool
    fractional_equities: bool
    max_order_pct_equity: PositiveFraction
    max_symbol_pct_equity: PositiveFraction
    max_gross_exposure_pct_equity: PositiveFraction
    max_net_exposure_pct_equity: PositiveFraction
    buying_power_reserve_bps: Annotated[Decimal, Field(ge=0, le=10_000)]
    max_participation_rate: PositiveFraction
    prefer_limit: bool

    @model_validator(mode="after")
    def _validate_exposure_hierarchy(self) -> Self:
        if self.max_order_pct_equity > self.max_gross_exposure_pct_equity:
            raise ValueError("max order exposure cannot exceed max gross exposure")
        if self.max_symbol_pct_equity > self.max_gross_exposure_pct_equity:
            raise ValueError("max symbol exposure cannot exceed max gross exposure")
        if self.max_net_exposure_pct_equity > self.max_gross_exposure_pct_equity:
            raise ValueError("max net exposure cannot exceed max gross exposure")
        return self


class FeePolicy(StrictPolicyModel):
    commission_bps: NonNegativeDecimal
    commission_per_share: NonNegativeDecimal
    min_commission: NonNegativeDecimal
    sec_fee_rate_on_sales: PositiveDecimal
    taf_fee_per_share_on_sales: PositiveDecimal
    taf_fee_cap_per_trade: PositiveDecimal
    cat_fee_per_share: PositiveDecimal
    rounding_increment: PositiveDecimal
    rounding_scope: Literal["daily_account_fee_type"]
    estimation_rounding_scope: Literal["per_order_fee_type_conservative"]
    schedule_revised_on: date
    source_urls: tuple[str, ...]

    @field_validator("source_urls")
    @classmethod
    def _validate_source_urls(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if not value or any(not item.startswith("https://") for item in value):
            raise ValueError("fee policy requires HTTPS primary-source URLs")
        return value


class BorrowPolicy(StrictPolicyModel):
    easy_to_borrow_only: Literal[True]
    easy_to_borrow_annual_rate: NonNegativeDecimal
    hard_to_borrow_behavior: Literal["reject"]
    missing_borrow_status_behavior: Literal["reject"]
    margin_debit_annual_rate: PositiveDecimal


class LatencyPolicy(StrictPolicyModel):
    assumed_execution_seconds: Annotated[int, Field(gt=0)]
    execution_advisor_timeout_ms: Annotated[int, Field(gt=0)]


class SlippagePolicy(StrictPolicyModel):
    include_half_spread_for_aggressive_orders: Literal[True]
    include_volatility_drift: Literal[True]
    impact_bps_at_full_participation: PositiveDecimal
    impact_participation_exponent: PositiveDecimal
    max_executable_spread_bps: NonNegativeDecimal
    max_quote_mid_jump_bps: NonNegativeDecimal
    max_jump_with_wide_spread_bps: NonNegativeDecimal


class StaleDataPolicy(StrictPolicyModel):
    signal_max_lag_seconds: Annotated[int, Field(gt=0)]
    executable_quote_max_age_seconds: Annotated[int, Field(gt=0)]
    executable_quote_forward_seconds: Literal[0]
    broker_quote_max_age_seconds: Annotated[int, Field(gt=0)]
    market_context_max_age_seconds: Annotated[int, Field(gt=0)]
    missing_behavior: Literal["reject"]
    stale_behavior: Literal["reject"]


class RiskPolicy(StrictPolicyModel):
    daily_loss_stop_pct_equity: PositiveFraction
    persistent_drawdown_stop_pct_equity: PositiveFraction
    pair_delta_tolerance_bps: NonNegativeDecimal
    closeout_slippage_bps: PositiveDecimal
    overnight_positions: Literal["forbidden"]
    missing_risk_input_behavior: Literal["reject"]

    @model_validator(mode="after")
    def _validate_loss_hierarchy(self) -> Self:
        if self.daily_loss_stop_pct_equity > self.persistent_drawdown_stop_pct_equity:
            raise ValueError("daily loss stop cannot exceed persistent drawdown stop")
        return self


class AccountingPolicy(StrictPolicyModel):
    base_currency: Literal["USD"]
    position_cost_basis: Literal["average_cost"]
    pnl_basis: Literal["net_of_fees_and_modeled_execution_costs"]
    fee_accrual: Literal["daily_account_fee_type"]
    numeric_representation: Literal["decimal"]


class EnginePolicy(StrictPolicyModel):
    strategy_runtime_mode: Literal["scheduler_v3"]


class EconomicPolicy(StrictPolicyModel):
    schema_version: Literal["torghut.economic-policy.v1"]
    policy_id: str = Field(
        min_length=1, max_length=128, pattern=r"^[a-z0-9][a-z0-9._-]*$"
    )
    effective_from: date
    venue: Literal["alpaca"]
    asset_class: Literal["us_equity"]
    engine: EnginePolicy
    session: SessionPolicy
    sizing: SizingPolicy
    fees: FeePolicy
    borrow: BorrowPolicy
    latency: LatencyPolicy
    slippage: SlippagePolicy
    stale_data: StaleDataPolicy
    risk: RiskPolicy
    accounting: AccountingPolicy

    @model_validator(mode="after")
    def _validate_effective_dates(self) -> Self:
        if self.fees.schedule_revised_on > self.effective_from:
            raise ValueError(
                "fee schedule revision cannot follow policy effective date"
            )
        return self

    @property
    def canonical_payload(self) -> dict[str, object]:
        return cast(dict[str, object], self.model_dump(mode="json"))

    @property
    def digest(self) -> str:
        return _canonical_digest(self.canonical_payload)

    def cost_model_config(self) -> CostModelConfig:
        return CostModelConfig(
            commission_bps=self.fees.commission_bps,
            commission_per_share=self.fees.commission_per_share,
            min_commission=self.fees.min_commission,
            sec_fee_rate_on_sales=self.fees.sec_fee_rate_on_sales,
            taf_fee_per_share_on_sales=self.fees.taf_fee_per_share_on_sales,
            taf_fee_cap_per_trade=self.fees.taf_fee_cap_per_trade,
            cat_fee_per_share=self.fees.cat_fee_per_share,
            regulatory_fee_rounding_increment=self.fees.rounding_increment,
            max_participation_rate=self.sizing.max_participation_rate,
            impact_bps_at_full_participation=self.slippage.impact_bps_at_full_participation,
            impact_participation_exponent=self.slippage.impact_participation_exponent,
        )

    def execution_policy_config(
        self, *, kill_switch_enabled: bool
    ) -> ExecutionPolicyConfig:
        from .execution_policy.policy_types import ExecutionPolicyConfig

        return ExecutionPolicyConfig(
            min_notional=None,
            max_notional=None,
            max_participation_rate=self.sizing.max_participation_rate,
            allow_shorts=self.sizing.allow_shorts,
            kill_switch_enabled=kill_switch_enabled,
            prefer_limit=self.sizing.prefer_limit,
        )

    def quote_quality_policy(self) -> QuoteQualityPolicy:
        return QuoteQualityPolicy(
            max_executable_spread_bps=self.slippage.max_executable_spread_bps,
            max_quote_mid_jump_bps=self.slippage.max_quote_mid_jump_bps,
            max_jump_with_wide_spread_bps=self.slippage.max_jump_with_wide_spread_bps,
            max_executable_quote_age_seconds=self.stale_data.executable_quote_max_age_seconds,
        )


def load_economic_policy(
    path: str | Path = DEFAULT_ECONOMIC_POLICY_PATH,
    *,
    expected_digest: str | None = None,
) -> EconomicPolicy:
    resolved = Path(path).expanduser().resolve()
    try:
        raw = resolved.read_text(encoding="utf-8")
    except OSError as exc:
        raise EconomicPolicyError(f"economic_policy_unreadable:{resolved}") from exc
    try:
        policy = EconomicPolicy.model_validate_json(raw)
    except ValidationError as exc:
        raise EconomicPolicyError(
            f"economic_policy_invalid:{resolved}:{exc.error_count()}"
        ) from exc
    if expected_digest is not None:
        normalized = expected_digest.strip().lower()
        if normalized != policy.digest:
            raise EconomicPolicyError(
                f"economic_policy_digest_mismatch:expected={normalized}:actual={policy.digest}"
            )
    return policy


@lru_cache(maxsize=1)
def load_default_economic_policy() -> EconomicPolicy:
    return load_economic_policy(DEFAULT_ECONOMIC_POLICY_PATH)


def alpaca_equity_fee_schedule_cost(
    *,
    side: object,
    filled_qty: Decimal,
    filled_notional: Decimal,
) -> tuple[Decimal, str] | None:
    if filled_qty <= 0 or filled_notional <= 0:
        return None
    normalized_side = str(side or "").strip().lower().replace("-", "_")
    if normalized_side in {"buy_to_cover", "cover"}:
        normalized_side = "buy"
    if normalized_side in {"sell_short", "short"}:
        normalized_side = "sell"
    if normalized_side not in {"buy", "sell"}:
        return None
    policy = load_default_economic_policy()
    estimate = TransactionCostModel(
        policy.cost_model_config()
    ).estimate_regulatory_fees(
        side=cast(Literal["buy", "sell"], normalized_side),
        qty=filled_qty,
        notional=filled_notional,
    )
    basis = (
        "modeled_alpaca_2026_equity_sec_taf_cat_per_order_conservative"
        if normalized_side == "sell"
        else "modeled_alpaca_2026_equity_cat_per_order_conservative"
    )
    return estimate.total, basis


def alpaca_equity_fee_schedule_hash() -> str:
    policy = load_default_economic_policy()
    return _canonical_digest(
        cast(dict[str, object], policy.fees.model_dump(mode="json"))
    ).removeprefix("sha256:")


def load_runtime_economic_policy(
    settings_obj: object,
    *,
    required: bool,
) -> EconomicPolicy | None:
    path = str(getattr(settings_obj, "trading_economic_policy_path", "") or "").strip()
    digest = str(
        getattr(settings_obj, "trading_economic_policy_expected_digest", "") or ""
    ).strip()
    if not path and not digest:
        if required:
            raise EconomicPolicyError("economic_policy_not_configured")
        return None
    if not path or not digest:
        raise EconomicPolicyError(
            "economic_policy_path_and_digest_must_be_configured_together"
        )
    policy = load_economic_policy(path, expected_digest=digest)
    mismatches = runtime_policy_mismatches(policy, settings_obj)
    if mismatches:
        raise EconomicPolicyError(
            "economic_policy_runtime_mismatch:" + ",".join(mismatches)
        )
    return policy


def runtime_policy_mismatches(
    policy: EconomicPolicy, settings_obj: object
) -> tuple[str, ...]:
    mismatches: list[str] = []
    for field_name, expected in _runtime_settings_projection(policy).items():
        actual = getattr(settings_obj, field_name, None)
        if not _policy_values_equal(actual, expected):
            mismatches.append(field_name)
    return tuple(mismatches)


@contextmanager
def bind_economic_policy_settings(
    policy: EconomicPolicy,
    settings_obj: object,
) -> Iterator[None]:
    """Bind legacy settings readers to the explicit replay policy for one run."""

    projection = _runtime_settings_projection(policy)
    original = {name: getattr(settings_obj, name) for name in projection}
    try:
        for name, value in projection.items():
            setattr(settings_obj, name, value)
        yield
    finally:
        for name, value in original.items():
            setattr(settings_obj, name, value)


def economic_policy_status(settings_obj: object) -> dict[str, object]:
    try:
        policy = load_runtime_economic_policy(settings_obj, required=True)
    except EconomicPolicyError as exc:
        return {
            "schema_version": ECONOMIC_POLICY_SCHEMA_VERSION,
            "configured": False,
            "valid": False,
            "reason": str(exc),
        }
    if policy is None:  # pragma: no cover - required=True guarantees a policy
        raise AssertionError("required policy loader returned no policy")
    from .economic_policy_parity import build_economic_policy_fixture_result

    fixture = build_economic_policy_fixture_result(policy)
    return {
        "schema_version": policy.schema_version,
        "policy_id": policy.policy_id,
        "digest": policy.digest,
        "effective_from": policy.effective_from.isoformat(),
        "configured": True,
        "valid": fixture["approved"],
        "runtime_mismatches": [],
        "pre_broker_fixture": {
            "fixture_id": "aapl-sell-10-v1",
            "approved": fixture["approved"],
            "intent_digest": fixture["intent_digest"],
        },
    }


def _runtime_settings_projection(policy: EconomicPolicy) -> Mapping[str, object]:
    return {
        "trading_strategy_runtime_mode": policy.engine.strategy_runtime_mode,
        "trading_allow_shorts": policy.sizing.allow_shorts,
        "trading_fractional_equities_enabled": policy.sizing.fractional_equities,
        "trading_simple_max_order_pct_equity": float(
            policy.sizing.max_order_pct_equity
        ),
        "trading_simple_max_symbol_pct_equity": float(
            policy.sizing.max_symbol_pct_equity
        ),
        "trading_simple_max_gross_exposure_pct_equity": float(
            policy.sizing.max_gross_exposure_pct_equity
        ),
        "trading_simple_max_net_exposure_pct_equity": float(
            policy.sizing.max_net_exposure_pct_equity
        ),
        "trading_simple_buying_power_reserve_bps": float(
            policy.sizing.buying_power_reserve_bps
        ),
        "trading_max_position_pct_equity": float(policy.sizing.max_symbol_pct_equity),
        "trading_allocator_max_symbol_pct_equity": float(
            policy.sizing.max_symbol_pct_equity
        ),
        "trading_portfolio_max_gross_exposure_pct_equity": float(
            policy.sizing.max_gross_exposure_pct_equity
        ),
        "trading_portfolio_max_net_exposure_pct_equity": float(
            policy.sizing.max_net_exposure_pct_equity
        ),
        "trading_max_participation_rate": float(policy.sizing.max_participation_rate),
        "trading_execution_prefer_limit": policy.sizing.prefer_limit,
        "trading_execution_advisor_timeout_ms": policy.latency.execution_advisor_timeout_ms,
        "trading_signal_max_executable_spread_bps": policy.slippage.max_executable_spread_bps,
        "trading_signal_max_quote_mid_jump_bps": policy.slippage.max_quote_mid_jump_bps,
        "trading_signal_max_jump_with_wide_spread_bps": policy.slippage.max_jump_with_wide_spread_bps,
        "trading_signal_stale_lag_alert_seconds": policy.stale_data.signal_max_lag_seconds,
        "trading_executable_quote_lookback_seconds": policy.stale_data.executable_quote_max_age_seconds,
        "trading_executable_quote_forward_seconds": policy.stale_data.executable_quote_forward_seconds,
        "trading_alpaca_quote_max_age_seconds": policy.stale_data.broker_quote_max_age_seconds,
        "trading_market_context_max_staleness_seconds": policy.stale_data.market_context_max_age_seconds,
        "trading_daily_loss_stop_pct_equity": float(
            policy.risk.daily_loss_stop_pct_equity
        ),
        "trading_persistent_drawdown_stop_pct_equity": float(
            policy.risk.persistent_drawdown_stop_pct_equity
        ),
        "trading_pair_delta_tolerance_bps": float(policy.risk.pair_delta_tolerance_bps),
        "trading_closeout_slippage_bps": float(policy.risk.closeout_slippage_bps),
        "trading_new_exposure_cutoff_time_et": policy.session.new_exposure_cutoff,
        "trading_flatten_start_time_et": policy.session.flatten_start,
        "trading_flat_confirmation_time_et": policy.session.flat_confirmation,
    }


def _policy_values_equal(actual: object, expected: object) -> bool:
    if isinstance(expected, Decimal):
        try:
            return Decimal(str(actual)) == expected
        except (ArithmeticError, ValueError):
            return False
    if isinstance(expected, float):
        try:
            return Decimal(str(actual)) == Decimal(str(expected))
        except (ArithmeticError, ValueError):
            return False
    return actual == expected


def _canonical_digest(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


__all__ = [
    "DEFAULT_ECONOMIC_POLICY_PATH",
    "ECONOMIC_POLICY_SCHEMA_VERSION",
    "EconomicPolicy",
    "EconomicPolicyError",
    "alpaca_equity_fee_schedule_cost",
    "alpaca_equity_fee_schedule_hash",
    "bind_economic_policy_settings",
    "economic_policy_status",
    "load_economic_policy",
    "load_default_economic_policy",
    "load_runtime_economic_policy",
    "runtime_policy_mismatches",
]
