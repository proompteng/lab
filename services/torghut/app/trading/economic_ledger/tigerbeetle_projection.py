"""Deterministic TigerBeetle projection for the broker-economic journal."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import TYPE_CHECKING, TypeVar, cast

from app.trading.tigerbeetle_ids import U128_MAX, stable_u128, u128_decimal
from app.trading.tigerbeetle_journal.journal_payloads import transfer_attr
from app.trading.tigerbeetle_ledger_model import (
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
)

from .types import (
    EconomicLedgerError,
    LedgerScope,
    LedgerTransaction,
    canonical_sha256,
)

if TYPE_CHECKING:
    from .persistence import BrokerEconomicLedgerReplay


# The v1 namespace orders date-only fees by external ID. The v2 namespace only
# preserves observation order within one settlement date. Both contain
# immutable transfers and must never be reused after the cross-date ordering
# correction.
TIGERBEETLE_ECONOMIC_PROJECTION_VERSION = (
    "torghut.broker-economic-tigerbeetle-projection.v3"
)
TIGERBEETLE_MAX_BATCH_SIZE = 8_189

_AMOUNT_SCALE = Decimal("1000000000000000000")
_LEDGER_HIGH_BIT = 1 << 31
_LEDGER_LOW_MASK = _LEDGER_HIGH_BIT - 1

_ACCOUNT_CODE_BY_TYPE = {
    "asset": 1_601,
    "clearing": 1_602,
    "expense": 1_603,
    "income": 1_604,
    "equity": 1_605,
    "liability": 1_606,
}
_TRANSFER_CODE_BY_RULE = {
    "fill_weighted_average": 2_101,
    "external_cash_flow": 2_102,
    "dividend": 2_103,
    "interest": 2_104,
    "cash_fee": 2_105,
    "crypto_asset_fee": 2_106,
    "correction_reversal": 2_107,
}
_TRANSFER_KIND = "broker_economic_journal"
_TRANSFER_FLAG_LINKED = 1

_T = TypeVar("_T")


@dataclass(slots=True)
class ExpectedAccount:
    spec: TigerBeetleAccountSpec
    debits_posted: int = 0
    credits_posted: int = 0


@dataclass(frozen=True, slots=True)
class ProjectionSummary:
    accounts: dict[int, ExpectedAccount]
    transfer_groups: tuple[tuple[TigerBeetleTransferSpec, ...], ...]
    account_manifest_sha256: str
    transfer_manifest_sha256: str

    @property
    def transaction_count(self) -> int:
        return len(self.transfer_groups)

    @property
    def transfer_count(self) -> int:
        return sum(len(group) for group in self.transfer_groups)

    def payload(self) -> dict[str, object]:
        return {
            "account_count": len(self.accounts),
            "account_manifest_sha256": self.account_manifest_sha256,
            "transaction_count": self.transaction_count,
            "transfer_count": self.transfer_count,
            "transfer_manifest_sha256": self.transfer_manifest_sha256,
        }


@dataclass(frozen=True, slots=True)
class _ProjectionContext:
    scope_sha256: str
    account_scope_key: str


def canonical_line(value: Mapping[str, object]) -> bytes:
    return (
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
        + b"\n"
    )


def _scope_context(scope: LedgerScope) -> _ProjectionContext:
    scope_payload = {
        "account_label": scope.account_label,
        "endpoint_fingerprint": scope.endpoint_fingerprint,
        "environment": scope.environment,
        "provider": scope.provider,
        "projection_version": TIGERBEETLE_ECONOMIC_PROJECTION_VERSION,
    }
    scope_sha256 = canonical_sha256(scope_payload)
    return _ProjectionContext(
        scope_sha256=scope_sha256,
        account_scope_key=scope_sha256[:32],
    )


def scope_digest(scope: LedgerScope) -> str:
    return _scope_context(scope).scope_sha256


def _commodity_ledger(commodity: str) -> int:
    digest = hashlib.sha256(
        (
            f"{TIGERBEETLE_ECONOMIC_PROJECTION_VERSION}\0{commodity.strip().upper()}"
        ).encode("utf-8")
    ).digest()
    return _LEDGER_HIGH_BIT | (int.from_bytes(digest[:4], "big") & _LEDGER_LOW_MASK)


def _scaled_amount(value: Decimal) -> int:
    scaled = abs(value) * _AMOUNT_SCALE
    if scaled != scaled.to_integral_value():
        raise EconomicLedgerError("tigerbeetle_economic_amount_precision_exceeded")
    amount = int(scaled)
    if amount <= 0 or amount > U128_MAX:
        raise EconomicLedgerError("tigerbeetle_economic_amount_out_of_range")
    return amount


def _account_code(account: str) -> int:
    account_type = account.split(":", 1)[0]
    try:
        return _ACCOUNT_CODE_BY_TYPE[account_type]
    except KeyError as exc:
        raise EconomicLedgerError(
            f"tigerbeetle_economic_account_type_unsupported:{account_type}"
        ) from exc


def _projection_id(namespace: str, identity: str) -> int:
    value = stable_u128(namespace, identity)
    if value == U128_MAX:
        raise EconomicLedgerError("tigerbeetle_economic_id_out_of_range")
    return value


def _transfer_code(posting_rule: str) -> int:
    try:
        return _TRANSFER_CODE_BY_RULE[posting_rule]
    except KeyError as exc:
        raise EconomicLedgerError(
            f"tigerbeetle_economic_posting_rule_unsupported:{posting_rule}"
        ) from exc


def _account_spec(
    *,
    context: _ProjectionContext,
    account: str,
    commodity: str,
) -> TigerBeetleAccountSpec:
    identity = "\0".join(
        (
            TIGERBEETLE_ECONOMIC_PROJECTION_VERSION,
            context.scope_sha256,
            commodity,
            account,
        )
    )
    account_digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return TigerBeetleAccountSpec(
        account_id=_projection_id(
            "torghut.tigerbeetle.broker_economic.account",
            identity,
        ),
        account_key=(
            f"broker_economic:{context.account_scope_key}:{account_digest[:32]}"
        ),
        ledger=_commodity_ledger(commodity),
        code=_account_code(account),
    )


@dataclass(frozen=True, slots=True)
class _TransferProjectionContext:
    projection: _ProjectionContext
    transaction: LedgerTransaction
    commodity: str


@dataclass(slots=True)
class _Posting:
    line_number: int
    account: TigerBeetleAccountSpec
    remaining: int


def _posting(
    context: _TransferProjectionContext,
    line_number: int,
    account: str,
    amount: Decimal,
) -> _Posting:
    return _Posting(
        line_number=line_number,
        account=_account_spec(
            context=context.projection,
            account=account,
            commodity=context.commodity,
        ),
        remaining=_scaled_amount(amount),
    )


def _transfer_spec(
    context: _TransferProjectionContext,
    debit: _Posting,
    credit: _Posting,
    segment: int,
    amount: int,
) -> TigerBeetleTransferSpec:
    identity = "\0".join(
        (
            TIGERBEETLE_ECONOMIC_PROJECTION_VERSION,
            context.projection.scope_sha256,
            context.transaction.digest,
            context.commodity,
            str(debit.line_number),
            str(credit.line_number),
            str(segment),
            str(amount),
        )
    )
    return TigerBeetleTransferSpec(
        transfer_id=_projection_id(
            "torghut.tigerbeetle.broker_economic.transfer",
            identity,
        ),
        transfer_kind=_TRANSFER_KIND,
        debit_account_id=debit.account.account_id,
        credit_account_id=credit.account.account_id,
        amount=amount,
        ledger=debit.account.ledger,
        code=_transfer_code(context.transaction.posting_rule),
    )


def _project_commodity(
    context: _TransferProjectionContext,
    lines: Sequence[tuple[int, str, Decimal]],
) -> list[TigerBeetleTransferSpec]:
    debits = [
        _posting(context, line_number, account, amount)
        for line_number, account, amount in lines
        if amount > 0
    ]
    credits = [
        _posting(context, line_number, account, amount)
        for line_number, account, amount in lines
        if amount < 0
    ]
    if not debits or not credits:
        raise EconomicLedgerError("tigerbeetle_economic_transaction_unbalanced")

    transfers: list[TigerBeetleTransferSpec] = []
    debit_index = 0
    credit_index = 0
    segment = 0
    while debit_index < len(debits) and credit_index < len(credits):
        debit = debits[debit_index]
        credit = credits[credit_index]
        amount = min(debit.remaining, credit.remaining)
        transfers.append(_transfer_spec(context, debit, credit, segment, amount))
        debit.remaining -= amount
        credit.remaining -= amount
        if debit.remaining == 0:
            debit_index += 1
        if credit.remaining == 0:
            credit_index += 1
        segment += 1
    if debit_index != len(debits) or credit_index != len(credits):
        raise EconomicLedgerError("tigerbeetle_economic_transaction_unbalanced")
    return transfers


def project_broker_economic_transaction(
    transaction: LedgerTransaction,
    *,
    scope: LedgerScope,
) -> tuple[TigerBeetleTransferSpec, ...]:
    """Decompose one balanced journal transaction into one linked TB chain."""

    projection_context = _scope_context(scope)
    by_commodity: dict[str, list[tuple[int, str, Decimal]]] = {}
    ledger_by_commodity: dict[int, str] = {}
    for line_number, line in enumerate(transaction.lines):
        commodity = line.commodity.strip().upper()
        ledger = _commodity_ledger(commodity)
        existing_commodity = ledger_by_commodity.get(ledger)
        if existing_commodity is not None and existing_commodity != commodity:
            raise EconomicLedgerError("tigerbeetle_economic_commodity_ledger_collision")
        ledger_by_commodity[ledger] = commodity
        by_commodity.setdefault(commodity, []).append(
            (line_number, line.account, line.amount)
        )

    transfers: list[TigerBeetleTransferSpec] = []
    for commodity in sorted(by_commodity):
        context = _TransferProjectionContext(
            projection=projection_context,
            transaction=transaction,
            commodity=commodity,
        )
        transfers.extend(_project_commodity(context, by_commodity[commodity]))
    return tuple(
        replace(spec, flags=_TRANSFER_FLAG_LINKED if index < len(transfers) - 1 else 0)
        for index, spec in enumerate(transfers)
    )


def _expected_accounts(
    replay: BrokerEconomicLedgerReplay,
    context: _ProjectionContext,
) -> dict[int, ExpectedAccount]:
    accounts: dict[int, ExpectedAccount] = {}
    commodity_by_ledger: dict[int, str] = {}
    for transaction in replay.reduction.journal.transactions:
        for line in transaction.lines:
            commodity = line.commodity.strip().upper()
            ledger = _commodity_ledger(commodity)
            existing_commodity = commodity_by_ledger.get(ledger)
            if existing_commodity is not None and existing_commodity != commodity:
                raise EconomicLedgerError(
                    "tigerbeetle_economic_commodity_ledger_collision"
                )
            commodity_by_ledger[ledger] = commodity
            spec = _account_spec(
                context=context,
                account=line.account,
                commodity=commodity,
            )
            expected = accounts.get(spec.account_id)
            if expected is None:
                expected = ExpectedAccount(spec=spec)
                accounts[spec.account_id] = expected
            elif expected.spec != spec:
                raise EconomicLedgerError("tigerbeetle_economic_account_id_collision")
            amount = _scaled_amount(line.amount)
            if line.amount > 0:
                expected.debits_posted += amount
                total = expected.debits_posted
            else:
                expected.credits_posted += amount
                total = expected.credits_posted
            if total > U128_MAX:
                raise EconomicLedgerError(
                    "tigerbeetle_economic_account_balance_out_of_range"
                )
    return accounts


def _project_transfer_groups(
    replay: BrokerEconomicLedgerReplay,
) -> tuple[tuple[tuple[TigerBeetleTransferSpec, ...], ...], str]:
    groups: list[tuple[TigerBeetleTransferSpec, ...]] = []
    transfer_ids: set[int] = set()
    transfer_hasher = hashlib.sha256()
    for transaction in replay.reduction.journal.transactions:
        group = project_broker_economic_transaction(
            transaction,
            scope=replay.snapshot.prepared.scope,
        )
        if not group:
            raise EconomicLedgerError("tigerbeetle_economic_transaction_empty")
        if len(group) > TIGERBEETLE_MAX_BATCH_SIZE:
            raise EconomicLedgerError("tigerbeetle_economic_transaction_batch_exceeded")
        for spec in group:
            if spec.transfer_id in transfer_ids:
                raise EconomicLedgerError("tigerbeetle_economic_transfer_id_collision")
            transfer_ids.add(spec.transfer_id)
            transfer_hasher.update(canonical_line(transfer_payload(spec)))
        groups.append(group)
    return tuple(groups), transfer_hasher.hexdigest()


def _account_manifest(accounts: Mapping[int, ExpectedAccount]) -> str:
    account_hasher = hashlib.sha256()
    for account_id in sorted(accounts):
        account_hasher.update(canonical_line(account_payload(accounts[account_id])))
    return account_hasher.hexdigest()


def build_projection_summary(replay: BrokerEconomicLedgerReplay) -> ProjectionSummary:
    context = _scope_context(replay.snapshot.prepared.scope)
    accounts = _expected_accounts(replay, context)
    transfer_groups, transfer_manifest_sha256 = _project_transfer_groups(replay)
    return ProjectionSummary(
        accounts=accounts,
        transfer_groups=transfer_groups,
        account_manifest_sha256=_account_manifest(accounts),
        transfer_manifest_sha256=transfer_manifest_sha256,
    )


def iter_transfer_batches(
    summary: ProjectionSummary,
) -> Iterable[tuple[TigerBeetleTransferSpec, ...]]:
    batch: list[TigerBeetleTransferSpec] = []
    for group in summary.transfer_groups:
        if batch and len(batch) + len(group) > TIGERBEETLE_MAX_BATCH_SIZE:
            yield tuple(batch)
            batch = []
        batch.extend(group)
    if batch:
        yield tuple(batch)


def iter_group_batches(
    summary: ProjectionSummary,
) -> Iterable[tuple[tuple[TigerBeetleTransferSpec, ...], ...]]:
    groups: list[tuple[TigerBeetleTransferSpec, ...]] = []
    size = 0
    for group in summary.transfer_groups:
        if groups and size + len(group) > TIGERBEETLE_MAX_BATCH_SIZE:
            yield tuple(groups)
            groups = []
            size = 0
        groups.append(group)
        size += len(group)
    if groups:
        yield tuple(groups)


def chunked(values: Sequence[_T], size: int) -> Iterable[Sequence[_T]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def transfer_payload(spec: TigerBeetleTransferSpec) -> dict[str, object]:
    return {
        "amount": str(spec.amount),
        "code": spec.code,
        "credit_account_id": u128_decimal(spec.credit_account_id),
        "debit_account_id": u128_decimal(spec.debit_account_id),
        "flags": spec.flags,
        "id": u128_decimal(spec.transfer_id),
        "ledger": spec.ledger,
        "pending_id": u128_decimal(spec.pending_id) if spec.pending_id else "0",
        "timeout": spec.timeout,
        "user_data_128": "0",
        "user_data_32": 0,
        "user_data_64": "0",
    }


def account_payload(expected: ExpectedAccount) -> dict[str, object]:
    return {
        "code": expected.spec.code,
        "credits_pending": "0",
        "credits_posted": str(expected.credits_posted),
        "debits_pending": "0",
        "debits_posted": str(expected.debits_posted),
        "flags": 0,
        "id": u128_decimal(expected.spec.account_id),
        "ledger": expected.spec.ledger,
        "user_data_128": "0",
        "user_data_32": 0,
        "user_data_64": "0",
    }


def account_identity_payload(expected: ExpectedAccount) -> dict[str, object]:
    payload = account_payload(expected)
    return {
        key: payload[key]
        for key in (
            "code",
            "flags",
            "id",
            "ledger",
            "user_data_128",
            "user_data_32",
            "user_data_64",
        )
    }


def _object_attr(value: object, name: str) -> object | None:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[str, object], value)
        resolved = mapping.get(name)
        if resolved is None and name == "id":
            resolved = mapping.get("account_id")
        return resolved
    if name == "id" and not hasattr(value, name) and hasattr(value, "account_id"):
        return getattr(value, "account_id")
    return getattr(value, name, None)


def _required_int(value: object | None) -> int:
    if not isinstance(value, (int, str)):
        raise TypeError("tigerbeetle_integer_field_invalid")
    return int(value)


def _optional_int(value: object | None) -> int:
    return 0 if value is None else _required_int(value)


def _optional_transfer_int(value: object, name: str) -> int:
    try:
        return _optional_int(transfer_attr(value, name))
    except AttributeError:
        return 0


def actual_transfer_payload(value: object) -> dict[str, object]:
    pending_id = _optional_transfer_int(value, "pending_id")
    return {
        "amount": str(_required_int(transfer_attr(value, "amount"))),
        "code": _required_int(transfer_attr(value, "code")),
        "credit_account_id": u128_decimal(
            _required_int(transfer_attr(value, "credit_account_id"))
        ),
        "debit_account_id": u128_decimal(
            _required_int(transfer_attr(value, "debit_account_id"))
        ),
        "flags": _optional_transfer_int(value, "flags"),
        "id": u128_decimal(_required_int(transfer_attr(value, "id"))),
        "ledger": _required_int(transfer_attr(value, "ledger")),
        "pending_id": u128_decimal(pending_id) if pending_id else "0",
        "timeout": _optional_transfer_int(value, "timeout"),
        "user_data_128": str(_optional_transfer_int(value, "user_data_128")),
        "user_data_32": _optional_transfer_int(value, "user_data_32"),
        "user_data_64": str(_optional_transfer_int(value, "user_data_64")),
    }


def actual_account_payload(value: object) -> dict[str, object]:
    return {
        "code": _required_int(_object_attr(value, "code")),
        "credits_pending": str(_optional_int(_object_attr(value, "credits_pending"))),
        "credits_posted": str(_optional_int(_object_attr(value, "credits_posted"))),
        "debits_pending": str(_optional_int(_object_attr(value, "debits_pending"))),
        "debits_posted": str(_optional_int(_object_attr(value, "debits_posted"))),
        "flags": _optional_int(_object_attr(value, "flags")),
        "id": u128_decimal(_required_int(_object_attr(value, "id"))),
        "ledger": _required_int(_object_attr(value, "ledger")),
        "user_data_128": str(_optional_int(_object_attr(value, "user_data_128"))),
        "user_data_32": _optional_int(_object_attr(value, "user_data_32")),
        "user_data_64": str(_optional_int(_object_attr(value, "user_data_64"))),
    }


def mismatch_fields(
    expected: Mapping[str, object],
    actual: Mapping[str, object],
) -> list[str]:
    return sorted(
        key
        for key, expected_value in expected.items()
        if actual.get(key) != expected_value
    )


def account_objects_by_id(
    values: Sequence[object],
    *,
    requested_ids: Sequence[int],
) -> dict[int, object]:
    requested = set(requested_ids)
    resolved: dict[int, object] = {}
    for value in values:
        try:
            account_id = _required_int(_object_attr(value, "id"))
        except (TypeError, ValueError) as exc:
            raise EconomicLedgerError(
                "tigerbeetle_economic_account_lookup_payload_invalid"
            ) from exc
        if account_id not in requested or account_id in resolved:
            raise EconomicLedgerError(
                "tigerbeetle_economic_account_lookup_payload_invalid"
            )
        resolved[account_id] = value
    return resolved


def transfer_objects_by_id(
    values: Sequence[object],
    *,
    requested_ids: Sequence[int],
) -> dict[int, object]:
    requested = set(requested_ids)
    resolved: dict[int, object] = {}
    for value in values:
        try:
            transfer_id = _required_int(transfer_attr(value, "id"))
        except (AttributeError, TypeError, ValueError) as exc:
            raise EconomicLedgerError(
                "tigerbeetle_economic_transfer_lookup_payload_invalid"
            ) from exc
        if transfer_id not in requested or transfer_id in resolved:
            raise EconomicLedgerError(
                "tigerbeetle_economic_transfer_lookup_payload_invalid"
            )
        resolved[transfer_id] = value
    return resolved
