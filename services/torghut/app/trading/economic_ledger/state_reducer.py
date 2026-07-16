"""Independent cash-and-position reducer for broker-economic differential proof."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, localcontext

from .types import (
    LEDGER_DECIMAL_PRECISION,
    ZERO,
    EconomicActivity,
    EconomicLedgerError,
    EconomicProjection,
    PreparedActivities,
    balances_tuple,
    positions_tuple,
    prepare_activities,
    quantize_ledger_decimal,
)


STATE_REDUCER_NAME = "independent_position_state"
STATE_REDUCER_VERSION = "torghut.broker-economic-state.v1"

_EXTERNAL_FLOW_TYPES = frozenset({"ACATC", "CSD", "CSW", "JNLC", "TRANS"})
_DIVIDEND_ACTIVITY_TYPES = frozenset(
    {
        "CGD",
        "DIV",
        "DIVCGL",
        "DIVCGS",
        "DIVTXEX",
    }
)
_INTEREST_ACTIVITY_TYPES = frozenset({"INT"})
_WITHHOLDING_ACTIVITY_TYPES = frozenset({"DIVFT", "DIVNRA", "DIVTW", "INTNRA", "INTTW"})
_CASH_FEE_ACTIVITY_TYPES = frozenset({"DIVFEE", "FEE", "PTC"})
_CASH_EXPENSE_ACTIVITY_TYPES = _CASH_FEE_ACTIVITY_TYPES | _WITHHOLDING_ACTIVITY_TYPES


@dataclass(slots=True)
class _Holding:
    units: Decimal = ZERO
    carrying_value: Decimal = ZERO


class _StateReducer:
    def __init__(self, prepared: PreparedActivities) -> None:
        self.prepared = prepared
        self.cash: dict[str, Decimal] = {}
        self.holdings: dict[str, _Holding] = {}
        self.realized_pnl = ZERO
        self.fees = ZERO
        self.dividends = ZERO
        self.interest = ZERO
        self.external_flows = ZERO
        self.unsupported: set[str] = set()

    def reduce(self) -> EconomicProjection:
        for chain in self.prepared.chains:
            for activity in chain.activities:
                if not self._recognized(activity):
                    self.unsupported.add(activity.external_activity_id)
            effective = chain.effective
            if effective.external_activity_id not in self.unsupported:
                self._apply(effective)
        return EconomicProjection(
            reducer_name=STATE_REDUCER_NAME,
            reducer_version=STATE_REDUCER_VERSION,
            scope=self.prepared.scope,
            input_manifest_digest=self.prepared.manifest_digest,
            input_count=self.prepared.input_count,
            duplicate_count=self.prepared.duplicate_count,
            corrected_count=self.prepared.corrected_count,
            cash=balances_tuple(self.cash),
            positions=positions_tuple(
                {symbol: holding.units for symbol, holding in self.holdings.items()},
                {
                    symbol: holding.carrying_value
                    for symbol, holding in self.holdings.items()
                },
            ),
            realized_pnl=self.realized_pnl,
            fees=self.fees,
            dividends=self.dividends,
            interest=self.interest,
            external_flows=self.external_flows,
            unsupported_activity_ids=tuple(sorted(self.unsupported)),
        )

    def _recognized(self, activity: EconomicActivity) -> bool:
        activity_type = activity.activity_type
        return (
            activity_type in {"CFEE", "FILL"}
            or (activity_type == "SSP" and activity.net_amount in {None, ZERO})
            or activity_type in _EXTERNAL_FLOW_TYPES
            or activity_type in _DIVIDEND_ACTIVITY_TYPES
            or activity_type in _INTEREST_ACTIVITY_TYPES
            or activity_type in _CASH_EXPENSE_ACTIVITY_TYPES
            or (
                activity_type == "JNL"
                and activity.symbol is None
                and activity.quantity is None
            )
        )

    def _apply(self, activity: EconomicActivity) -> None:
        activity_type = activity.activity_type
        if activity_type == "FILL":
            self._fill(activity)
        elif activity_type == "CFEE":
            self._crypto_fee(activity)
        elif activity_type == "SSP":
            self._split(activity)
        elif activity_type in _EXTERNAL_FLOW_TYPES or activity_type == "JNL":
            amount = _required_amount(activity, "cash_flow")
            self._add_cash(activity, amount)
            self.external_flows = quantize_ledger_decimal(
                self.external_flows + amount,
                field_name="external_flows",
            )
        elif activity_type in _DIVIDEND_ACTIVITY_TYPES:
            amount = _required_amount(activity, "dividend")
            self._add_cash(activity, amount)
            self.dividends = quantize_ledger_decimal(
                self.dividends + amount,
                field_name="dividends",
            )
        elif activity_type in _INTEREST_ACTIVITY_TYPES:
            amount = _required_amount(activity, "interest")
            self._add_cash(activity, amount)
            self.interest = quantize_ledger_decimal(
                self.interest + amount,
                field_name="interest",
            )
        elif activity_type in _CASH_EXPENSE_ACTIVITY_TYPES:
            amount = _required_amount(activity, "fee")
            self._add_cash(activity, amount)
            self.fees = quantize_ledger_decimal(
                self.fees - amount,
                field_name="fees",
            )
        else:
            raise EconomicLedgerError("independent_reducer_unrecognized_activity")

    def _fill(self, activity: EconomicActivity) -> None:
        symbol = _symbol(activity)
        quantity = activity.quantity
        price = activity.price
        if quantity is None or quantity <= ZERO:
            raise EconomicLedgerError("economic_fill_quantity_must_be_positive")
        if price is None or price <= ZERO:
            raise EconomicLedgerError("economic_fill_price_must_be_positive")
        if activity.side == "buy":
            order_units = quantity
        elif activity.side == "sell":
            order_units = -quantity
        else:
            raise EconomicLedgerError("economic_fill_side_invalid")
        _validate_quote(activity)

        holding = self.holdings.setdefault(symbol, _Holding())
        previous_value = holding.carrying_value
        cash_change = quantize_ledger_decimal(
            -order_units * price,
            field_name="fill_cash_delta",
        )
        self._add_cash(activity, cash_change)
        holding.units, holding.carrying_value = _next_holding(
            holding,
            order_units,
            price,
            cash_change,
        )
        self.realized_pnl = quantize_ledger_decimal(
            self.realized_pnl + cash_change + (holding.carrying_value - previous_value),
            field_name="realized_pnl",
        )

    def _crypto_fee(self, activity: EconomicActivity) -> None:
        if activity.net_amount not in {None, ZERO}:
            amount = _required_amount(activity, "fee")
            self._add_cash(activity, amount)
            self.fees = quantize_ledger_decimal(
                self.fees - amount,
                field_name="fees",
            )
            return
        units = activity.quantity
        if units is None or units == ZERO:
            return
        price = activity.price
        if price is None or price <= ZERO:
            raise EconomicLedgerError("economic_crypto_fee_price_must_be_positive")
        _validate_quote(activity)
        symbol = _symbol(activity)
        holding = self.holdings.setdefault(symbol, _Holding())
        fair_value = quantize_ledger_decimal(
            abs(units) * price,
            field_name="crypto_fee_fair_value",
        )
        if units < ZERO:
            if holding.units <= ZERO or abs(units) > holding.units:
                raise EconomicLedgerError("economic_crypto_fee_position_insufficient")
            if abs(units) == holding.units:
                released_cost = holding.carrying_value
            else:
                released_cost = quantize_ledger_decimal(
                    abs(units) * holding.carrying_value / holding.units,
                    field_name="crypto_fee_released_cost",
                )
            holding.units = quantize_ledger_decimal(
                holding.units + units,
                field_name="crypto_fee_position_quantity",
            )
            holding.carrying_value = quantize_ledger_decimal(
                holding.carrying_value - released_cost,
                field_name="crypto_fee_position_cost",
            )
            self.realized_pnl = quantize_ledger_decimal(
                self.realized_pnl + fair_value - released_cost,
                field_name="realized_pnl",
            )
            self.fees = quantize_ledger_decimal(
                self.fees + fair_value,
                field_name="fees",
            )
        else:
            holding.units = quantize_ledger_decimal(
                holding.units + units,
                field_name="crypto_fee_position_quantity",
            )
            holding.carrying_value = quantize_ledger_decimal(
                holding.carrying_value + fair_value,
                field_name="crypto_fee_position_cost",
            )
            self.fees = quantize_ledger_decimal(
                self.fees - fair_value,
                field_name="fees",
            )
        if holding.units == ZERO:
            holding.carrying_value = ZERO

    def _split(self, activity: EconomicActivity) -> None:
        units = activity.quantity
        if units is None or units == ZERO:
            raise EconomicLedgerError("economic_split_quantity_delta_required")
        symbol = _symbol(activity)
        holding = self.holdings.setdefault(symbol, _Holding())
        new_units = quantize_ledger_decimal(
            holding.units + units,
            field_name="split_position_quantity",
        )
        if (
            holding.units == ZERO
            or new_units == ZERO
            or holding.units * new_units < ZERO
        ):
            raise EconomicLedgerError("economic_split_position_direction_invalid")
        holding.units = new_units

    def _add_cash(self, activity: EconomicActivity, amount: Decimal) -> None:
        currency = activity.currency or self.prepared.scope.quote_currency
        if currency != self.prepared.scope.quote_currency:
            raise EconomicLedgerError("economic_activity_currency_unsupported")
        self.cash[currency] = quantize_ledger_decimal(
            self.cash.get(currency, ZERO) + amount,
            field_name="cash_balance",
        )


def _next_holding(
    holding: _Holding,
    order_units: Decimal,
    price: Decimal,
    cash_change: Decimal,
) -> tuple[Decimal, Decimal]:
    if holding.units == ZERO or holding.units * order_units > ZERO:
        return (
            quantize_ledger_decimal(
                holding.units + order_units,
                field_name="fill_position_quantity",
            ),
            quantize_ledger_decimal(
                holding.carrying_value - cash_change,
                field_name="fill_position_cost",
            ),
        )
    return _opposite_holding(holding, order_units, price)


def _opposite_holding(
    holding: _Holding,
    order_units: Decimal,
    price: Decimal,
) -> tuple[Decimal, Decimal]:
    current_sign = Decimal(1 if holding.units > ZERO else -1)
    order_sign = Decimal(1 if order_units > ZERO else -1)
    units_closed = min(abs(holding.units), abs(order_units))
    if units_closed == abs(holding.units):
        released_value = abs(holding.carrying_value)
    else:
        released_value = quantize_ledger_decimal(
            units_closed * abs(holding.carrying_value) / abs(holding.units),
            field_name="fill_released_cost",
        )

    existing_remainder = abs(holding.units) - units_closed
    order_remainder = abs(order_units) - units_closed
    if existing_remainder > ZERO:
        new_units = current_sign * existing_remainder
        new_value = holding.carrying_value - current_sign * released_value
    elif order_remainder > ZERO:
        new_units = order_sign * order_remainder
        new_value = order_sign * quantize_ledger_decimal(
            order_remainder * price,
            field_name="fill_opening_cost",
        )
    else:
        new_units = ZERO
        new_value = ZERO
    return (
        quantize_ledger_decimal(
            new_units,
            field_name="fill_position_quantity",
        ),
        quantize_ledger_decimal(
            new_value,
            field_name="fill_position_cost",
        ),
    )


def reduce_independent_state(
    activities: PreparedActivities
    | tuple[EconomicActivity, ...]
    | list[EconomicActivity],
) -> EconomicProjection:
    prepared = (
        activities
        if isinstance(activities, PreparedActivities)
        else prepare_activities(activities)
    )
    with localcontext() as context:
        context.prec = LEDGER_DECIMAL_PRECISION
        return _StateReducer(prepared).reduce()


def _required_amount(activity: EconomicActivity, kind: str) -> Decimal:
    amount = activity.net_amount
    if amount is None:
        raise EconomicLedgerError(f"economic_{kind}_net_amount_required")
    return amount


def _symbol(activity: EconomicActivity) -> str:
    symbol = activity.canonical_symbol
    if symbol is None:
        raise EconomicLedgerError("economic_activity_symbol_required")
    return symbol


def _validate_quote(activity: EconomicActivity) -> None:
    if activity.currency not in {None, activity.scope.quote_currency}:
        raise EconomicLedgerError("economic_activity_currency_unsupported")
    raw_symbol = activity.symbol or ""
    if (
        "/" in raw_symbol
        and raw_symbol.rsplit("/", maxsplit=1)[-1] != activity.scope.quote_currency
    ):
        raise EconomicLedgerError("economic_fill_quote_currency_unsupported")


__all__ = (
    "STATE_REDUCER_NAME",
    "STATE_REDUCER_VERSION",
    "reduce_independent_state",
)
