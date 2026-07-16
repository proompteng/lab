"""Pure contracts for deterministic broker-economic ledger reduction."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext


ZERO = Decimal("0")
LEDGER_DECIMAL_PRECISION = 80
LEDGER_DECIMAL_SCALE = 18
LEDGER_QUANTUM = Decimal("0.000000000000000001")
_LEDGER_ABSOLUTE_LIMIT = Decimal("100000000000000000000")
_OPTION_CONTRACT_MULTIPLIER = Decimal("100")
_UNIT_NOTIONAL_MULTIPLIER = Decimal("1")
_OCC_OPTION_SYMBOL = re.compile(r"^[A-Z0-9]{1,6}[0-9]{6}[CP][0-9]{8}$")


class EconomicLedgerError(RuntimeError):
    """Base error for an inadmissible economic-ledger input or output."""


class EconomicLedgerSourceContradiction(EconomicLedgerError):
    """One broker identity was observed with contradictory immutable bytes."""


class EconomicLedgerCorrectionError(EconomicLedgerError):
    """A correction chain is missing, forked, or cyclic."""


@dataclass(frozen=True, slots=True)
class LedgerScope:
    provider: str
    environment: str
    account_label: str
    endpoint_fingerprint: str
    quote_currency: str = "USD"

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "provider", _required_text(self.provider, "provider", 32).lower()
        )
        object.__setattr__(
            self,
            "environment",
            _required_text(self.environment, "environment", 16).lower(),
        )
        object.__setattr__(
            self,
            "account_label",
            _required_text(self.account_label, "account_label", 64),
        )
        object.__setattr__(
            self,
            "endpoint_fingerprint",
            _sha256(self.endpoint_fingerprint, field_name="endpoint_fingerprint"),
        )
        object.__setattr__(
            self,
            "quote_currency",
            _required_text(self.quote_currency, "quote_currency", 16).upper(),
        )


@dataclass(frozen=True, slots=True)
class EconomicActivity:
    """One immutable REST broker activity adapted for pure reduction."""

    scope: LedgerScope
    external_activity_id: str
    raw_payload_sha256: str
    activity_type: str
    first_observed_at: datetime
    activity_subtype: str | None = None
    correction_of_external_id: str | None = None
    event_at: datetime | None = None
    settle_date: date | None = None
    symbol: str | None = None
    side: str | None = None
    quantity: Decimal | None = None
    price: Decimal | None = None
    net_amount: Decimal | None = None
    currency: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "external_activity_id",
            _required_text(self.external_activity_id, "external_activity_id", 256),
        )
        object.__setattr__(
            self,
            "raw_payload_sha256",
            _sha256(self.raw_payload_sha256, field_name="raw_payload_sha256"),
        )
        object.__setattr__(
            self,
            "activity_type",
            _required_text(self.activity_type, "activity_type", 32).upper(),
        )
        object.__setattr__(
            self,
            "activity_subtype",
            _optional_text(self.activity_subtype, "activity_subtype", 32, lower=True),
        )
        object.__setattr__(
            self,
            "correction_of_external_id",
            _optional_text(
                self.correction_of_external_id,
                "correction_of_external_id",
                256,
            ),
        )
        object.__setattr__(
            self,
            "symbol",
            _optional_text(self.symbol, "symbol", 64, upper=True),
        )
        object.__setattr__(
            self,
            "side",
            _optional_text(self.side, "side", 16, lower=True),
        )
        object.__setattr__(
            self,
            "currency",
            _optional_text(self.currency, "currency", 16, upper=True),
        )
        object.__setattr__(
            self,
            "first_observed_at",
            _aware_utc(self.first_observed_at, "first_observed_at"),
        )
        if self.event_at is not None:
            object.__setattr__(self, "event_at", _aware_utc(self.event_at, "event_at"))
        for field_name in ("quantity", "price", "net_amount"):
            value = getattr(self, field_name)
            if value is not None:
                object.__setattr__(self, field_name, _finite_decimal(value, field_name))
        if self.correction_of_external_id == self.external_activity_id:
            raise EconomicLedgerCorrectionError(
                "economic_activity_cannot_correct_itself"
            )

    @property
    def economic_at(self) -> datetime:
        if self.event_at is not None:
            return self.event_at
        if self.settle_date is not None:
            # Alpaca can emit asset CFEE rows with only a date. The fee charges
            # that day's fills, so it must not sort ahead of timestamped fills.
            fallback_time = time.max if self.activity_type == "CFEE" else time.min
            return datetime.combine(
                self.settle_date,
                fallback_time,
                tzinfo=timezone.utc,
            )
        return self.first_observed_at

    @property
    def canonical_symbol(self) -> str | None:
        if self.symbol is None:
            return None
        return self.symbol.replace("/", "")

    @property
    def notional_multiplier(self) -> Decimal:
        return notional_multiplier_for_symbol(self.canonical_symbol)

    @property
    def sort_key(self) -> tuple[datetime, date, str, str]:
        return (
            self.economic_at,
            self.settle_date or date.min,
            self.external_activity_id,
            self.raw_payload_sha256,
        )

    def manifest_payload(self) -> dict[str, object]:
        return {
            "activity_subtype": self.activity_subtype,
            "activity_type": self.activity_type,
            "correction_of_external_id": self.correction_of_external_id,
            "currency": self.currency,
            "event_at": _datetime_text(self.event_at),
            "external_activity_id": self.external_activity_id,
            "first_observed_at": _datetime_text(self.first_observed_at),
            "net_amount": decimal_text(self.net_amount),
            "notional_multiplier": decimal_text(self.notional_multiplier),
            "price": decimal_text(self.price),
            "quantity": decimal_text(self.quantity),
            "raw_payload_sha256": self.raw_payload_sha256,
            "settle_date": self.settle_date.isoformat() if self.settle_date else None,
            "side": self.side,
            "symbol": self.symbol,
        }


@dataclass(frozen=True, slots=True)
class ActivityChain:
    """One original activity followed by zero or more retroactive corrections."""

    activities: tuple[EconomicActivity, ...]

    @property
    def effective(self) -> EconomicActivity:
        return self.activities[-1]

    @property
    def root(self) -> EconomicActivity:
        return self.activities[0]


@dataclass(frozen=True, slots=True)
class PreparedActivities:
    scope: LedgerScope
    chains: tuple[ActivityChain, ...]
    manifest_digest: str
    input_count: int
    duplicate_count: int
    corrected_count: int

    @property
    def effective(self) -> tuple[EconomicActivity, ...]:
        return tuple(chain.effective for chain in self.chains)


@dataclass(frozen=True, slots=True)
class LedgerLine:
    account: str
    commodity: str
    amount: Decimal

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "account", _required_text(self.account, "account", 128)
        )
        object.__setattr__(
            self,
            "commodity",
            _required_text(self.commodity, "commodity", 64).upper(),
        )
        amount = _finite_decimal(self.amount, "amount")
        if amount == ZERO:
            raise EconomicLedgerError("ledger_line_amount_must_be_nonzero")
        object.__setattr__(self, "amount", amount)


@dataclass(frozen=True, slots=True)
class LedgerTransaction:
    transaction_id: str
    source_activity_id: str
    posting_rule: str
    lines: tuple[LedgerLine, ...]
    reverses_transaction_id: str | None = None
    digest: str = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "transaction_id",
            _required_text(self.transaction_id, "transaction_id", 512),
        )
        object.__setattr__(
            self,
            "source_activity_id",
            _required_text(self.source_activity_id, "source_activity_id", 256),
        )
        object.__setattr__(
            self,
            "posting_rule",
            _required_text(self.posting_rule, "posting_rule", 128),
        )
        if self.reverses_transaction_id is not None:
            object.__setattr__(
                self,
                "reverses_transaction_id",
                _required_text(
                    self.reverses_transaction_id,
                    "reverses_transaction_id",
                    512,
                ),
            )
        if len(self.lines) < 2:
            raise EconomicLedgerError("ledger_transaction_requires_two_lines")
        balances: dict[str, Decimal] = {}
        for line in self.lines:
            balances[line.commodity] = balances.get(line.commodity, ZERO) + line.amount
        unbalanced = {
            commodity: amount
            for commodity, amount in balances.items()
            if amount != ZERO
        }
        if unbalanced:
            raise EconomicLedgerError(f"ledger_transaction_unbalanced:{unbalanced}")
        payload = {
            "lines": [
                {
                    "account": line.account,
                    "amount": decimal_text(line.amount),
                    "commodity": line.commodity,
                }
                for line in self.lines
            ],
            "posting_rule": self.posting_rule,
            "reverses_transaction_id": self.reverses_transaction_id,
            "source_activity_id": self.source_activity_id,
            "transaction_id": self.transaction_id,
        }
        object.__setattr__(self, "digest", canonical_sha256(payload))


@dataclass(frozen=True, slots=True)
class CommodityBalance:
    commodity: str
    amount: Decimal

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "commodity",
            _required_text(self.commodity, "commodity", 64).upper(),
        )
        object.__setattr__(self, "amount", _finite_decimal(self.amount, "amount"))


@dataclass(frozen=True, slots=True)
class PositionBalance:
    symbol: str
    quantity: Decimal
    signed_cost: Decimal

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "symbol", _required_text(self.symbol, "symbol", 64).upper()
        )
        object.__setattr__(self, "quantity", _finite_decimal(self.quantity, "quantity"))
        object.__setattr__(
            self, "signed_cost", _finite_decimal(self.signed_cost, "signed_cost")
        )
        if self.quantity == ZERO and self.signed_cost != ZERO:
            raise EconomicLedgerError("economic_position_flat_cost_nonzero")
        if self.quantity != ZERO and self.signed_cost == ZERO:
            raise EconomicLedgerError("economic_position_nonzero_quantity_zero_cost")
        if self.quantity * self.signed_cost < ZERO:
            raise EconomicLedgerError("economic_position_cost_sign_mismatch")

    @property
    def average_cost(self) -> Decimal | None:
        if self.quantity == ZERO:
            return None
        with localcontext() as context:
            context.prec = LEDGER_DECIMAL_PRECISION
            return quantize_ledger_decimal(
                self.signed_cost / self.quantity,
                field_name="average_cost",
            )


@dataclass(frozen=True, slots=True)
class EconomicProjection:
    reducer_name: str
    reducer_version: str
    scope: LedgerScope
    input_manifest_digest: str
    input_count: int
    duplicate_count: int
    corrected_count: int
    cash: tuple[CommodityBalance, ...]
    positions: tuple[PositionBalance, ...]
    realized_pnl: Decimal
    fees: Decimal
    dividends: Decimal
    interest: Decimal
    external_flows: Decimal
    unsupported_activity_ids: tuple[str, ...]
    result_digest: str = field(init=False)

    def __post_init__(self) -> None:
        for field_name in (
            "realized_pnl",
            "fees",
            "dividends",
            "interest",
            "external_flows",
        ):
            object.__setattr__(
                self,
                field_name,
                _finite_decimal(getattr(self, field_name), field_name),
            )
        payload = self.economic_payload()
        payload.update(
            reducer_name=self.reducer_name,
            reducer_version=self.reducer_version,
        )
        object.__setattr__(self, "result_digest", canonical_sha256(payload))

    @property
    def admissible(self) -> bool:
        return not self.unsupported_activity_ids

    def economic_payload(self) -> dict[str, object]:
        return {
            "cash": {
                balance.commodity: decimal_text(balance.amount) for balance in self.cash
            },
            "corrected_count": self.corrected_count,
            "dividends": decimal_text(self.dividends),
            "duplicate_count": self.duplicate_count,
            "external_flows": decimal_text(self.external_flows),
            "fees": decimal_text(self.fees),
            "input_count": self.input_count,
            "input_manifest_digest": self.input_manifest_digest,
            "interest": decimal_text(self.interest),
            "positions": {
                position.symbol: {
                    "quantity": decimal_text(position.quantity),
                    "signed_cost": decimal_text(position.signed_cost),
                }
                for position in self.positions
            },
            "realized_pnl": decimal_text(self.realized_pnl),
            "scope": {
                "account_label": self.scope.account_label,
                "endpoint_fingerprint": self.scope.endpoint_fingerprint,
                "environment": self.scope.environment,
                "provider": self.scope.provider,
                "quote_currency": self.scope.quote_currency,
            },
            "unsupported_activity_ids": list(self.unsupported_activity_ids),
        }


@dataclass(frozen=True, slots=True)
class JournalReduction:
    projection: EconomicProjection
    transactions: tuple[LedgerTransaction, ...]
    journal_digest: str = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "journal_digest",
            canonical_sha256([transaction.digest for transaction in self.transactions]),
        )


def prepare_activities(activities: Iterable[EconomicActivity]) -> PreparedActivities:
    """Deduplicate immutable identities and resolve correction chains."""

    unique, duplicate_count = _deduplicate_activities(activities)
    scope = _single_scope(unique.values())
    chains = _activity_chains(unique)
    manifest = [
        activity.manifest_payload()
        for activity in sorted(unique.values(), key=lambda activity: activity.sort_key)
    ]
    return PreparedActivities(
        scope=scope,
        chains=chains,
        manifest_digest=canonical_sha256(manifest),
        input_count=len(unique),
        duplicate_count=duplicate_count,
        corrected_count=sum(len(chain.activities) - 1 for chain in chains),
    )


def _deduplicate_activities(
    activities: Iterable[EconomicActivity],
) -> tuple[dict[str, EconomicActivity], int]:
    unique: dict[str, EconomicActivity] = {}
    duplicate_count = 0
    for activity in activities:
        existing = unique.get(activity.external_activity_id)
        if existing is None:
            unique[activity.external_activity_id] = activity
            continue
        if (
            existing.raw_payload_sha256 != activity.raw_payload_sha256
            or existing != activity
        ):
            raise EconomicLedgerSourceContradiction(
                f"economic_activity_payload_changed:{activity.external_activity_id}"
            )
        duplicate_count += 1
    if not unique:
        raise EconomicLedgerError("economic_ledger_input_empty")
    return unique, duplicate_count


def _single_scope(activities: Iterable[EconomicActivity]) -> LedgerScope:
    scopes = {activity.scope for activity in activities}
    if len(scopes) != 1:
        raise EconomicLedgerError("economic_ledger_scope_mixed")
    return next(iter(scopes))


def _activity_chains(
    unique: Mapping[str, EconomicActivity],
) -> tuple[ActivityChain, ...]:
    successor = _correction_successors(unique)
    roots = sorted(
        (
            activity
            for activity in unique.values()
            if activity.correction_of_external_id is None
        ),
        key=lambda activity: activity.sort_key,
    )
    visited: set[str] = set()
    chains = tuple(_walk_correction_chain(root, successor, visited) for root in roots)
    if visited != set(unique):
        raise EconomicLedgerCorrectionError("economic_activity_correction_cycle")
    return chains


def _correction_successors(
    unique: Mapping[str, EconomicActivity],
) -> dict[str, EconomicActivity]:
    successor: dict[str, EconomicActivity] = {}
    for activity in unique.values():
        predecessor = activity.correction_of_external_id
        if predecessor is None:
            continue
        if predecessor not in unique:
            raise EconomicLedgerCorrectionError(
                f"economic_activity_correction_predecessor_missing:{predecessor}"
            )
        if predecessor in successor:
            raise EconomicLedgerCorrectionError(
                f"economic_activity_correction_fork:{predecessor}"
            )
        successor[predecessor] = activity
    return successor


def _walk_correction_chain(
    root: EconomicActivity,
    successor: Mapping[str, EconomicActivity],
    visited: set[str],
) -> ActivityChain:
    chain: list[EconomicActivity] = []
    current = root
    while current.external_activity_id not in visited:
        visited.add(current.external_activity_id)
        chain.append(current)
        next_activity = successor.get(current.external_activity_id)
        if next_activity is None:
            return ActivityChain(tuple(chain))
        current = next_activity
    raise EconomicLedgerCorrectionError("economic_activity_correction_cycle")


def canonical_sha256(value: object) -> str:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise EconomicLedgerError("economic_ledger_value_not_canonical_json") from exc
    return hashlib.sha256(encoded).hexdigest()


def decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    if value == ZERO:
        return "0"
    exact = format(value, "f")
    if "." not in exact:
        return exact
    return exact.rstrip("0").rstrip(".")


def quantize_ledger_decimal(
    value: Decimal,
    *,
    field_name: str = "derived_amount",
) -> Decimal:
    """Round one derived value to the durable NUMERIC(38, 18) contract."""

    if not value.is_finite():
        raise EconomicLedgerError(f"economic_ledger_{field_name}_invalid")
    with localcontext() as context:
        context.prec = LEDGER_DECIMAL_PRECISION
        try:
            quantized = value.quantize(LEDGER_QUANTUM, rounding=ROUND_HALF_UP)
        except InvalidOperation as exc:
            raise EconomicLedgerError(
                f"economic_ledger_{field_name}_out_of_range"
            ) from exc
    if abs(quantized) >= _LEDGER_ABSOLUTE_LIMIT:
        raise EconomicLedgerError(f"economic_ledger_{field_name}_out_of_range")
    return ZERO if quantized == ZERO else quantized


def balances_tuple(values: Mapping[str, Decimal]) -> tuple[CommodityBalance, ...]:
    return tuple(
        CommodityBalance(commodity=commodity, amount=amount)
        for commodity, amount in sorted(values.items())
        if amount != ZERO
    )


def positions_tuple(
    quantities: Mapping[str, Decimal],
    costs: Mapping[str, Decimal],
) -> tuple[PositionBalance, ...]:
    return tuple(
        PositionBalance(
            symbol=symbol,
            quantity=quantities.get(symbol, ZERO),
            signed_cost=costs.get(symbol, ZERO),
        )
        for symbol in sorted(set(quantities) | set(costs))
        if quantities.get(symbol, ZERO) != ZERO or costs.get(symbol, ZERO) != ZERO
    )


def notional_multiplier_for_symbol(symbol: str | None) -> Decimal:
    """Return the broker notional multiplier encoded by a canonical symbol."""
    if symbol is not None and _OCC_OPTION_SYMBOL.fullmatch(symbol) is not None:
        return _OPTION_CONTRACT_MULTIPLIER
    return _UNIT_NOTIONAL_MULTIPLIER


def _required_text(value: object, field_name: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise EconomicLedgerError(f"economic_ledger_{field_name}_must_be_string")
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > maximum
        or any(ord(char) < 32 for char in normalized)
    ):
        raise EconomicLedgerError(f"economic_ledger_{field_name}_invalid")
    return normalized


def _optional_text(
    value: object,
    field_name: str,
    maximum: int,
    *,
    lower: bool = False,
    upper: bool = False,
) -> str | None:
    if value is None:
        return None
    normalized = _required_text(value, field_name, maximum)
    if lower:
        return normalized.lower()
    if upper:
        return normalized.upper()
    return normalized


def _sha256(value: object, *, field_name: str) -> str:
    normalized = _required_text(value, field_name, 64).lower()
    if len(normalized) != 64 or any(
        char not in "0123456789abcdef" for char in normalized
    ):
        raise EconomicLedgerError(f"economic_ledger_{field_name}_invalid")
    return normalized


def _aware_utc(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None:
        raise EconomicLedgerError(f"economic_ledger_{field_name}_timezone_required")
    return value.astimezone(timezone.utc)


def _finite_decimal(value: object, field_name: str) -> Decimal:
    if isinstance(value, bool):
        raise EconomicLedgerError(f"economic_ledger_{field_name}_invalid")
    try:
        parsed = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise EconomicLedgerError(f"economic_ledger_{field_name}_invalid") from exc
    if not parsed.is_finite():
        raise EconomicLedgerError(f"economic_ledger_{field_name}_invalid")
    quantized = quantize_ledger_decimal(parsed, field_name=field_name)
    if parsed != quantized:
        raise EconomicLedgerError(
            f"economic_ledger_{field_name}_scale_exceeds_{LEDGER_DECIMAL_SCALE}"
        )
    return quantized


def _datetime_text(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (
        value.astimezone(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


__all__ = (
    "LEDGER_DECIMAL_PRECISION",
    "LEDGER_DECIMAL_SCALE",
    "LEDGER_QUANTUM",
    "ZERO",
    "ActivityChain",
    "CommodityBalance",
    "EconomicActivity",
    "EconomicLedgerCorrectionError",
    "EconomicLedgerError",
    "EconomicLedgerSourceContradiction",
    "EconomicProjection",
    "JournalReduction",
    "LedgerLine",
    "LedgerScope",
    "LedgerTransaction",
    "PositionBalance",
    "PreparedActivities",
    "balances_tuple",
    "canonical_sha256",
    "decimal_text",
    "notional_multiplier_for_symbol",
    "positions_tuple",
    "prepare_activities",
    "quantize_ledger_decimal",
)
