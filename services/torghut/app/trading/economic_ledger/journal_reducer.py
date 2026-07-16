"""Canonical balanced-journal reducer for immutable broker activities."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from decimal import Decimal, localcontext

from .types import (
    LEDGER_DECIMAL_PRECISION,
    ZERO,
    EconomicActivity,
    EconomicLedgerError,
    EconomicProjection,
    JournalReduction,
    LedgerLine,
    LedgerTransaction,
    PreparedActivities,
    balances_tuple,
    positions_tuple,
    prepare_activities,
    quantize_ledger_decimal,
)


JOURNAL_REDUCER_NAME = "balanced_journal"
JOURNAL_REDUCER_VERSION = "torghut.broker-economic-journal.v1"

_MAX_TRANSACTION_ID_LENGTH = 512
_REVERSAL_TRANSACTION_ID_PREFIX = "correction-reversal:sha256:"

_CASH_TYPES = frozenset({"ACATC", "CSD", "CSW", "JNLC", "TRANS"})
_DIVIDEND_TYPES = frozenset(
    {
        "CGD",
        "DIV",
        "DIVCGL",
        "DIVCGS",
        "DIVTXEX",
    }
)
_INTEREST_TYPES = frozenset({"INT"})
_WITHHOLDING_TYPES = frozenset({"DIVFT", "DIVNRA", "DIVTW", "INTNRA", "INTTW"})
_FEE_TYPES = frozenset({"DIVFEE", "FEE", "PTC"})
_CASH_EXPENSE_TYPES = _FEE_TYPES | _WITHHOLDING_TYPES
_PAIRED_SPLIT_SUBTYPES = frozenset({"add", "remove"})
_REGULATORY_FEE_SUBTYPES = frozenset({"CAT", "OCC", "ORF", "REG", "TAF"})


@dataclass(slots=True)
class _Position:
    quantity: Decimal = ZERO
    signed_cost: Decimal = ZERO


@dataclass(frozen=True, slots=True)
class _FillPosting:
    delta_quantity: Decimal
    cash_delta: Decimal
    position_cost_delta: Decimal
    realized: Decimal
    new_quantity: Decimal
    new_cost: Decimal


class _JournalWriter:
    def __init__(self, prepared: PreparedActivities) -> None:
        self.prepared = prepared
        self.positions: dict[str, _Position] = {}
        self.transactions: list[LedgerTransaction] = []
        self.unsupported: set[str] = set()

    def reduce(self) -> JournalReduction:
        for chain in self.prepared.chains:
            for index, activity in enumerate(chain.activities):
                position_snapshot = {
                    symbol: _Position(position.quantity, position.signed_cost)
                    for symbol, position in self.positions.items()
                }
                transaction = self._apply(activity)
                if transaction is not None:
                    self.transactions.append(transaction)
                if index == len(chain.activities) - 1:
                    continue
                correction = chain.activities[index + 1]
                if transaction is not None:
                    self.transactions.append(
                        _reversal_transaction(
                            transaction,
                            correction_activity_id=correction.external_activity_id,
                        )
                    )
                self.positions = position_snapshot
        projection = _projection_from_journal(
            self.prepared,
            transactions=tuple(self.transactions),
            unsupported=tuple(sorted(self.unsupported)),
        )
        return JournalReduction(
            projection=projection,
            transactions=tuple(self.transactions),
        )

    def _apply(self, activity: EconomicActivity) -> LedgerTransaction | None:
        activity_type = activity.activity_type
        if activity_type == "FILL":
            transaction = self._apply_fill(activity)
        elif activity_type == "CFEE":
            transaction = self._apply_crypto_fee(activity)
        elif activity_type == "SSP":
            transaction = self._apply_split(activity)
        elif activity_type in _CASH_TYPES or (
            activity_type == "JNL"
            and activity.symbol is None
            and activity.quantity is None
        ):
            transaction = self._cash_flow(activity)
        elif activity_type in _DIVIDEND_TYPES:
            transaction = self._income(
                activity,
                account="income:dividend",
                rule="dividend",
            )
        elif activity_type in _INTEREST_TYPES:
            transaction = self._income(
                activity,
                account="income:interest",
                rule="interest",
            )
        elif activity_type in _CASH_EXPENSE_TYPES:
            transaction = self._cash_fee(activity)
        else:
            self.unsupported.add(activity.external_activity_id)
            transaction = None
        return transaction

    def _apply_fill(self, activity: EconomicActivity) -> LedgerTransaction | None:
        if activity.net_amount not in {None, ZERO}:
            self.unsupported.add(activity.external_activity_id)
            return None
        return self._fill(activity)

    def _apply_crypto_fee(
        self,
        activity: EconomicActivity,
    ) -> LedgerTransaction | None:
        if activity.net_amount in {None, ZERO} and (
            activity.quantity is None or activity.quantity >= ZERO
        ):
            self.unsupported.add(activity.external_activity_id)
            return None
        return self._crypto_fee(activity)

    def _apply_split(self, activity: EconomicActivity) -> LedgerTransaction | None:
        if (
            activity.net_amount not in {None, ZERO}
            or activity.activity_subtype in _PAIRED_SPLIT_SUBTYPES
            or self._split_removes_or_flips_position(activity)
        ):
            self.unsupported.add(activity.external_activity_id)
            return None
        return self._split(activity)

    def _split_removes_or_flips_position(self, activity: EconomicActivity) -> bool:
        symbol = activity.canonical_symbol
        quantity = activity.quantity
        position = self.positions.get(symbol) if symbol is not None else None
        if quantity is None or quantity == ZERO or position is None:
            return False
        new_quantity = quantize_ledger_decimal(
            position.quantity + quantity,
            field_name="split_position_quantity",
        )
        return new_quantity == ZERO or position.quantity * new_quantity < ZERO

    def _fill(self, activity: EconomicActivity) -> LedgerTransaction:
        symbol = _required_symbol(activity)
        quantity = activity.quantity
        price = activity.price
        if quantity is None or quantity <= ZERO:
            raise EconomicLedgerError("economic_fill_quantity_must_be_positive")
        if price is None or price <= ZERO:
            raise EconomicLedgerError("economic_fill_price_must_be_positive")
        if activity.side == "buy":
            delta_quantity = quantity
        elif activity.side in {"sell", "sell_short"}:
            delta_quantity = -quantity
        else:
            raise EconomicLedgerError("economic_fill_side_invalid")
        _require_quote_currency(activity)

        position = self.positions.setdefault(symbol, _Position())
        posting = _build_fill_posting(position, delta_quantity, price)
        transaction = _transaction(
            activity,
            posting_rule="fill_weighted_average",
            lines=(
                _line(
                    "asset:cash",
                    self.prepared.scope.quote_currency,
                    posting.cash_delta,
                ),
                _line(
                    f"asset:position_cost:{symbol}",
                    self.prepared.scope.quote_currency,
                    posting.position_cost_delta,
                ),
                _line(
                    "income:realized_pnl",
                    self.prepared.scope.quote_currency,
                    -posting.realized,
                ),
                _line(
                    f"asset:position_units:{symbol}",
                    symbol,
                    posting.delta_quantity,
                ),
                _line("clearing:broker_fill", symbol, -posting.delta_quantity),
            ),
        )
        position.quantity = posting.new_quantity
        position.signed_cost = posting.new_cost
        return transaction

    def _cash_flow(self, activity: EconomicActivity) -> LedgerTransaction | None:
        amount = activity.net_amount
        if amount is None:
            raise EconomicLedgerError("economic_cash_flow_net_amount_required")
        if amount == ZERO:
            return None
        currency = _currency(activity, self.prepared.scope.quote_currency)
        return _transaction(
            activity,
            posting_rule="external_cash_flow",
            lines=(
                _line("asset:cash", currency, amount),
                _line("equity:external_flow", currency, -amount),
            ),
        )

    def _income(
        self,
        activity: EconomicActivity,
        *,
        account: str,
        rule: str,
    ) -> LedgerTransaction | None:
        amount = activity.net_amount
        if amount is None:
            raise EconomicLedgerError(f"economic_{rule}_net_amount_required")
        if amount == ZERO:
            return None
        currency = _currency(activity, self.prepared.scope.quote_currency)
        return _transaction(
            activity,
            posting_rule=rule,
            lines=(
                _line("asset:cash", currency, amount),
                _line(account, currency, -amount),
            ),
        )

    def _cash_fee(self, activity: EconomicActivity) -> LedgerTransaction | None:
        amount = activity.net_amount
        if amount is None:
            raise EconomicLedgerError("economic_fee_net_amount_required")
        if amount == ZERO:
            return None
        subtype = activity.activity_subtype or ""
        if activity.activity_type in _WITHHOLDING_TYPES:
            account = "expense:withholding"
        elif subtype.upper() in _REGULATORY_FEE_SUBTYPES:
            account = "expense:regulatory_fee"
        else:
            account = "expense:broker_fee"
        currency = _currency(activity, self.prepared.scope.quote_currency)
        return _transaction(
            activity,
            posting_rule="cash_fee",
            lines=(
                _line("asset:cash", currency, amount),
                _line(account, currency, -amount),
            ),
        )

    def _crypto_fee(self, activity: EconomicActivity) -> LedgerTransaction | None:
        if activity.net_amount not in {None, ZERO}:
            return self._cash_fee(activity)
        quantity = activity.quantity
        if quantity is None or quantity >= ZERO:
            raise EconomicLedgerError("economic_crypto_fee_quantity_must_be_negative")
        price = activity.price
        if price is None or price <= ZERO:
            raise EconomicLedgerError("economic_crypto_fee_price_must_be_positive")
        _require_quote_currency(activity)
        symbol = _required_symbol(activity)
        position = self.positions.setdefault(symbol, _Position())
        fair_value = quantize_ledger_decimal(
            abs(quantity) * price,
            field_name="crypto_fee_fair_value",
        )
        if position.quantity <= ZERO or abs(quantity) > position.quantity:
            raise EconomicLedgerError("economic_crypto_fee_position_insufficient")
        if abs(quantity) == position.quantity:
            position_cost_delta = -position.signed_cost
        else:
            average_cost = position.signed_cost / position.quantity
            position_cost_delta = quantize_ledger_decimal(
                quantity * average_cost,
                field_name="crypto_fee_position_cost_delta",
            )
        fee_amount = fair_value
        realized = quantize_ledger_decimal(
            position_cost_delta + fee_amount,
            field_name="crypto_fee_realized_pnl",
        )
        transaction = _transaction(
            activity,
            posting_rule="crypto_asset_fee",
            lines=(
                _line(
                    f"asset:position_cost:{symbol}",
                    self.prepared.scope.quote_currency,
                    position_cost_delta,
                ),
                _line(
                    "expense:broker_fee",
                    self.prepared.scope.quote_currency,
                    fee_amount,
                ),
                _line(
                    "income:realized_pnl",
                    self.prepared.scope.quote_currency,
                    -realized,
                ),
                _line(f"asset:position_units:{symbol}", symbol, quantity),
                _line("clearing:fee", symbol, -quantity),
            ),
        )
        position.quantity = quantize_ledger_decimal(
            position.quantity + quantity,
            field_name="crypto_fee_position_quantity",
        )
        position.signed_cost = quantize_ledger_decimal(
            position.signed_cost + position_cost_delta,
            field_name="crypto_fee_position_cost",
        )
        if position.quantity == ZERO:
            position.signed_cost = ZERO
        return transaction

    def _split(self, activity: EconomicActivity) -> LedgerTransaction:
        symbol = _required_symbol(activity)
        quantity = activity.quantity
        if quantity is None or quantity == ZERO:
            raise EconomicLedgerError("economic_split_quantity_delta_required")
        position = self.positions.setdefault(symbol, _Position())
        new_quantity = quantize_ledger_decimal(
            position.quantity + quantity,
            field_name="split_position_quantity",
        )
        if (
            position.quantity == ZERO
            or new_quantity == ZERO
            or position.quantity * new_quantity < ZERO
        ):
            raise EconomicLedgerError("economic_split_position_direction_invalid")
        transaction = _transaction(
            activity,
            posting_rule="stock_split_quantity_delta",
            lines=(
                _line(f"asset:position_units:{symbol}", symbol, quantity),
                _line("clearing:corporate_action", symbol, -quantity),
            ),
        )
        position.quantity = new_quantity
        return transaction


def _build_fill_posting(
    position: _Position,
    delta_quantity: Decimal,
    price: Decimal,
) -> _FillPosting:
    cash_delta = quantize_ledger_decimal(
        -delta_quantity * price,
        field_name="fill_cash_delta",
    )
    if position.quantity == ZERO or position.quantity * delta_quantity > ZERO:
        position_cost_delta = -cash_delta
    else:
        position_cost_delta = _opposite_fill_position_cost_delta(
            position,
            delta_quantity,
            price,
        )
    realized = quantize_ledger_decimal(
        cash_delta + position_cost_delta,
        field_name="fill_realized_pnl",
    )
    new_quantity = quantize_ledger_decimal(
        position.quantity + delta_quantity,
        field_name="fill_position_quantity",
    )
    new_cost = quantize_ledger_decimal(
        position.signed_cost + position_cost_delta,
        field_name="fill_position_cost",
    )
    if new_quantity == ZERO:
        new_cost = ZERO
    if new_quantity * new_cost < ZERO:
        raise EconomicLedgerError("economic_fill_position_cost_sign_mismatch")
    return _FillPosting(
        delta_quantity=delta_quantity,
        cash_delta=cash_delta,
        position_cost_delta=position_cost_delta,
        realized=realized,
        new_quantity=new_quantity,
        new_cost=new_cost,
    )


def _opposite_fill_position_cost_delta(
    position: _Position,
    delta_quantity: Decimal,
    price: Decimal,
) -> Decimal:
    closing_quantity = min(abs(position.quantity), abs(delta_quantity))
    current_direction = Decimal(1 if position.quantity > ZERO else -1)
    closing_delta = -current_direction * closing_quantity
    if closing_quantity == abs(position.quantity):
        released_cost_delta = -position.signed_cost
    else:
        released_cost_delta = quantize_ledger_decimal(
            -current_direction
            * closing_quantity
            * abs(position.signed_cost)
            / abs(position.quantity),
            field_name="fill_released_cost_delta",
        )
    opening_delta = delta_quantity - closing_delta
    opening_cost_delta = quantize_ledger_decimal(
        opening_delta * price,
        field_name="fill_opening_cost_delta",
    )
    return quantize_ledger_decimal(
        released_cost_delta + opening_cost_delta,
        field_name="fill_position_cost_delta",
    )


def reduce_balanced_journal(
    activities: PreparedActivities
    | tuple[EconomicActivity, ...]
    | list[EconomicActivity],
) -> JournalReduction:
    prepared = (
        activities
        if isinstance(activities, PreparedActivities)
        else prepare_activities(activities)
    )
    with localcontext() as context:
        context.prec = LEDGER_DECIMAL_PRECISION
        return _JournalWriter(prepared).reduce()


def _projection_from_journal(
    prepared: PreparedActivities,
    *,
    transactions: tuple[LedgerTransaction, ...],
    unsupported: tuple[str, ...],
) -> EconomicProjection:
    cash: dict[str, Decimal] = {}
    quantities: dict[str, Decimal] = {}
    costs: dict[str, Decimal] = {}
    realized_pnl = ZERO
    fees = ZERO
    dividends = ZERO
    interest = ZERO
    external_flows = ZERO
    for transaction in transactions:
        for line in transaction.lines:
            if line.account == "asset:cash":
                cash[line.commodity] = cash.get(line.commodity, ZERO) + line.amount
            elif line.account.startswith("asset:position_cost:"):
                symbol = line.account.removeprefix("asset:position_cost:")
                costs[symbol] = costs.get(symbol, ZERO) + line.amount
            elif line.account.startswith("asset:position_units:"):
                symbol = line.account.removeprefix("asset:position_units:")
                quantities[symbol] = quantities.get(symbol, ZERO) + line.amount
            elif line.account == "income:realized_pnl":
                realized_pnl -= line.amount
            elif line.account in {
                "expense:broker_fee",
                "expense:regulatory_fee",
                "expense:withholding",
            }:
                fees += line.amount
            elif line.account == "income:dividend":
                dividends -= line.amount
            elif line.account == "income:interest":
                interest -= line.amount
            elif line.account == "equity:external_flow":
                external_flows -= line.amount
    return EconomicProjection(
        reducer_name=JOURNAL_REDUCER_NAME,
        reducer_version=JOURNAL_REDUCER_VERSION,
        scope=prepared.scope,
        input_manifest_digest=prepared.manifest_digest,
        input_count=prepared.input_count,
        duplicate_count=prepared.duplicate_count,
        corrected_count=prepared.corrected_count,
        cash=balances_tuple(cash),
        positions=positions_tuple(quantities, costs),
        realized_pnl=realized_pnl,
        fees=fees,
        dividends=dividends,
        interest=interest,
        external_flows=external_flows,
        unsupported_activity_ids=unsupported,
    )


def _reversal_transaction(
    transaction: LedgerTransaction,
    *,
    correction_activity_id: str,
) -> LedgerTransaction:
    return LedgerTransaction(
        transaction_id=_reversal_transaction_id(
            correction_activity_id=correction_activity_id,
            reversed_transaction_id=transaction.transaction_id,
        ),
        source_activity_id=correction_activity_id,
        posting_rule="correction_reversal",
        reverses_transaction_id=transaction.transaction_id,
        lines=tuple(
            LedgerLine(
                account=line.account,
                commodity=line.commodity,
                amount=-line.amount,
            )
            for line in transaction.lines
        ),
    )


def _reversal_transaction_id(
    *,
    correction_activity_id: str,
    reversed_transaction_id: str,
) -> str:
    readable = f"{correction_activity_id}:reversal:{reversed_transaction_id}"
    if len(readable) <= _MAX_TRANSACTION_ID_LENGTH:
        return readable
    digest = hashlib.sha256(readable.encode("utf-8")).hexdigest()
    return f"{_REVERSAL_TRANSACTION_ID_PREFIX}{digest}"


def _transaction(
    activity: EconomicActivity,
    *,
    posting_rule: str,
    lines: tuple[LedgerLine | None, ...],
) -> LedgerTransaction:
    present = tuple(line for line in lines if line is not None)
    return LedgerTransaction(
        transaction_id=activity.external_activity_id,
        source_activity_id=activity.external_activity_id,
        posting_rule=posting_rule,
        lines=present,
    )


def _line(account: str, commodity: str, amount: Decimal) -> LedgerLine | None:
    if amount == ZERO:
        return None
    return LedgerLine(account=account, commodity=commodity, amount=amount)


def _required_symbol(activity: EconomicActivity) -> str:
    symbol = activity.canonical_symbol
    if symbol is None:
        raise EconomicLedgerError("economic_activity_symbol_required")
    return symbol


def _currency(activity: EconomicActivity, default: str) -> str:
    currency = activity.currency or default
    if currency != default:
        raise EconomicLedgerError("economic_activity_currency_unsupported")
    return currency


def _require_quote_currency(activity: EconomicActivity) -> None:
    if activity.currency not in {None, activity.scope.quote_currency}:
        raise EconomicLedgerError("economic_activity_currency_unsupported")
    symbol = activity.symbol or ""
    if "/" not in symbol:
        return
    quote = symbol.rsplit("/", maxsplit=1)[-1]
    if quote != activity.scope.quote_currency:
        raise EconomicLedgerError("economic_fill_quote_currency_unsupported")


__all__ = (
    "JOURNAL_REDUCER_NAME",
    "JOURNAL_REDUCER_VERSION",
    "reduce_balanced_journal",
)
