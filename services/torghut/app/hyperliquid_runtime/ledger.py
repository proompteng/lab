"""TigerBeetle accounting plan for Hyperliquid runtime events."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import text

from app.trading.tigerbeetle_client import (
    RealTigerBeetleClient,
    TigerBeetleClientProtocol,
    parse_replica_addresses,
)
from app.trading.tigerbeetle_ids import stable_u128, u128_decimal
from app.trading.tigerbeetle_journal.journal_payloads import (
    result_statuses_by_index,
    transfer_attr,
)
from app.trading.tigerbeetle_ledger_model import (
    ACCOUNT_CODE_CASH_CONTROL,
    ACCOUNT_CODE_EXECUTION_COST,
    ACCOUNT_CODE_FILL_NOTIONAL,
    ACCOUNT_CODE_ORDER_HOLD,
    ACCOUNT_CODE_REALIZED_PNL,
    LEDGER_USD_MICRO,
    TRANSFER_CODE_CANCEL_VOID,
    TRANSFER_CODE_EXPLICIT_FEE,
    TRANSFER_CODE_FILL_POST,
    TRANSFER_CODE_REJECT_VOID,
    TRANSFER_CODE_RUNTIME_NET_PNL,
    TRANSFER_CODE_SUBMITTED_PENDING,
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
    decimal_usd_to_nearest_micros,
)

from .models import Fill, OrderIntent, OrderResult, RuntimeDependencyStatus
from .runtime_session import RuntimeSession


_DEFAULT_REPLICA_ADDRESSES = "torghut-tigerbeetle.torghut.svc.cluster.local:3000"


@dataclass(frozen=True)
class HyperliquidJournalEvent:
    """Audit event converted into deterministic TigerBeetle transfer specs."""

    source_id: str
    transfer_kind: str
    amount_usd: Decimal
    debit_account_key: str
    credit_account_key: str
    transfer_code: int


class HyperliquidTigerBeetleJournal:
    """Write TigerBeetle transfers and persist deterministic Postgres refs."""

    def __init__(
        self,
        *,
        cluster_id: int,
        enabled: bool = True,
        required: bool = False,
        journal_enabled: bool = True,
        replica_addresses: str = _DEFAULT_REPLICA_ADDRESSES,
        rpc_timeout_seconds: float = 10.0,
        client: TigerBeetleClientProtocol | None = None,
    ) -> None:
        if cluster_id <= 0:
            raise ValueError("tigerbeetle_cluster_id_invalid")
        self._cluster_id = cluster_id
        self._enabled = enabled
        self._required = required
        self._journal_enabled = journal_enabled
        self._replica_addresses = replica_addresses
        self._rpc_timeout_seconds = max(float(rpc_timeout_seconds), 0.001)
        self._client = client
        self._owns_client = client is None

    def close(self) -> None:
        if not self._owns_client or self._client is None:
            return
        close = getattr(self._client, "close", None)
        if callable(close):
            close()
        self._client = None

    def dependency_status(self) -> RuntimeDependencyStatus:
        if not self._enabled:
            return RuntimeDependencyStatus(
                name="hyperliquid_tigerbeetle",
                ready=not self._required,
                reason="tigerbeetle_disabled" if self._required else None,
            )
        if not self._journal_enabled:
            return RuntimeDependencyStatus(
                name="hyperliquid_tigerbeetle",
                ready=not self._required,
                reason="tigerbeetle_journal_disabled" if self._required else None,
            )
        try:
            self._client_for_write().nop()
        except Exception as exc:
            return RuntimeDependencyStatus(
                name="hyperliquid_tigerbeetle",
                ready=False,
                reason=f"tigerbeetle_unavailable:{type(exc).__name__}",
            )
        return RuntimeDependencyStatus(name="hyperliquid_tigerbeetle", ready=True)

    def order_events(
        self,
        intent: OrderIntent,
        result: OrderResult,
    ) -> list[HyperliquidJournalEvent]:
        if result.status in {"rejected", "cancelled"}:
            return [
                HyperliquidJournalEvent(
                    source_id=intent.cloid,
                    transfer_kind="rejection_release"
                    if result.status == "rejected"
                    else "cancellation_release",
                    amount_usd=intent.notional_usd,
                    debit_account_key=_account_key(
                        ACCOUNT_CODE_ORDER_HOLD, intent.market_id
                    ),
                    credit_account_key=_account_key(
                        ACCOUNT_CODE_CASH_CONTROL, "testnet-cash"
                    ),
                    transfer_code=TRANSFER_CODE_REJECT_VOID
                    if result.status == "rejected"
                    else TRANSFER_CODE_CANCEL_VOID,
                )
            ]
        return [
            HyperliquidJournalEvent(
                source_id=intent.cloid,
                transfer_kind="submitted_hold",
                amount_usd=intent.notional_usd,
                debit_account_key=_account_key(
                    ACCOUNT_CODE_CASH_CONTROL, "testnet-cash"
                ),
                credit_account_key=_account_key(
                    ACCOUNT_CODE_ORDER_HOLD, intent.market_id
                ),
                transfer_code=TRANSFER_CODE_SUBMITTED_PENDING,
            )
        ]

    def fill_events(self, fill: Fill) -> list[HyperliquidJournalEvent]:
        events = [
            HyperliquidJournalEvent(
                source_id=fill.fill_hash,
                transfer_kind="fill_notional",
                amount_usd=fill.notional_usd,
                debit_account_key=_account_key(ACCOUNT_CODE_ORDER_HOLD, fill.market_id),
                credit_account_key=_account_key(
                    ACCOUNT_CODE_FILL_NOTIONAL, fill.market_id
                ),
                transfer_code=TRANSFER_CODE_FILL_POST,
            )
        ]
        if fill.fee_usd > Decimal("0"):
            events.append(
                HyperliquidJournalEvent(
                    source_id=f"{fill.fill_hash}:fee",
                    transfer_kind="fee",
                    amount_usd=fill.fee_usd,
                    debit_account_key=_account_key(
                        ACCOUNT_CODE_FILL_NOTIONAL, fill.market_id
                    ),
                    credit_account_key=_account_key(
                        ACCOUNT_CODE_EXECUTION_COST, fill.market_id
                    ),
                    transfer_code=TRANSFER_CODE_EXPLICIT_FEE,
                )
            )
        if fill.closed_pnl_usd != Decimal("0"):
            events.append(
                HyperliquidJournalEvent(
                    source_id=f"{fill.fill_hash}:realized_pnl",
                    transfer_kind="realized_pnl",
                    amount_usd=fill.closed_pnl_usd.copy_abs(),
                    debit_account_key=_account_key(
                        ACCOUNT_CODE_FILL_NOTIONAL, fill.market_id
                    ),
                    credit_account_key=_account_key(
                        ACCOUNT_CODE_REALIZED_PNL, fill.market_id
                    ),
                    transfer_code=TRANSFER_CODE_RUNTIME_NET_PNL,
                )
            )
        return events

    def transfer_spec(self, event: HyperliquidJournalEvent) -> TigerBeetleTransferSpec:
        amount = decimal_usd_to_nearest_micros(event.amount_usd.copy_abs())
        return TigerBeetleTransferSpec(
            transfer_id=stable_u128(
                "torghut.hyperliquid.transfer",
                f"{self._cluster_id}:{event.source_id}:{event.transfer_kind}",
            ),
            transfer_kind=event.transfer_kind,
            debit_account_id=stable_u128(
                "torghut.hyperliquid.account", event.debit_account_key
            ),
            credit_account_id=stable_u128(
                "torghut.hyperliquid.account", event.credit_account_key
            ),
            amount=amount,
            ledger=LEDGER_USD_MICRO,
            code=event.transfer_code,
        )

    def persist_refs(
        self,
        session: RuntimeSession,
        events: Sequence[HyperliquidJournalEvent],
    ) -> int:
        if not events:
            return 0
        specs = [self.transfer_spec(event) for event in events]
        statuses = self._write_transfer_specs(events, specs)
        count = 0
        for event, spec, status in zip(events, specs, statuses):
            session.execute(
                text(
                    """
                    INSERT INTO hyperliquid_runtime_tigerbeetle_refs (
                      transfer_id,
                      source_id,
                      transfer_kind,
                      debit_account_id,
                      credit_account_id,
                      amount,
                      ledger,
                      code,
                      status
                    )
                    VALUES (
                      :transfer_id,
                      :source_id,
                      :transfer_kind,
                      :debit_account_id,
                      :credit_account_id,
                      :amount,
                      :ledger,
                      :code,
                      :status
                    )
                    ON CONFLICT (transfer_id) DO UPDATE SET
                      status = EXCLUDED.status
                    """
                ),
                {
                    "transfer_id": u128_decimal(spec.transfer_id),
                    "source_id": event.source_id,
                    "transfer_kind": spec.transfer_kind,
                    "debit_account_id": u128_decimal(spec.debit_account_id),
                    "credit_account_id": u128_decimal(spec.credit_account_id),
                    "amount": str(spec.amount),
                    "ledger": spec.ledger,
                    "code": spec.code,
                    "status": status,
                },
            )
            count += 1
        return count

    def _client_for_write(self) -> TigerBeetleClientProtocol:
        if self._client is None:
            self._client = RealTigerBeetleClient(
                cluster_id=self._cluster_id,
                replica_addresses=parse_replica_addresses(self._replica_addresses),
                rpc_timeout_seconds=self._rpc_timeout_seconds,
            )
        return self._client

    def _write_transfer_specs(
        self,
        events: Sequence[HyperliquidJournalEvent],
        specs: Sequence[TigerBeetleTransferSpec],
    ) -> list[str]:
        if not self._enabled or not self._journal_enabled:
            if self._required:
                raise RuntimeError("tigerbeetle_journal_disabled")
            return ["planned" for _ in specs]
        try:
            return self._write_transfer_specs_or_raise(events, specs)
        except Exception:
            if self._required:
                raise
            return ["failed" for _ in specs]

    def _write_transfer_specs_or_raise(
        self,
        events: Sequence[HyperliquidJournalEvent],
        specs: Sequence[TigerBeetleTransferSpec],
    ) -> list[str]:
        client = self._client_for_write()
        account_specs = _dedupe_account_specs(
            [spec for event in events for spec in _account_specs(event)]
        )
        account_statuses = result_statuses_by_index(
            client.create_accounts(account_specs),
            count=len(account_specs),
            default_status="created",
            status_type_names=("CreateAccountStatus",),
        )
        for index, status in account_statuses.items():
            if status in {"created", "exists"}:
                continue
            account_id = u128_decimal(account_specs[index].account_id)
            raise RuntimeError(
                f"tigerbeetle_create_account_failed:{account_id}:{status}"
            )

        transfer_statuses = result_statuses_by_index(
            client.create_transfers(specs),
            count=len(specs),
            default_status="created",
            status_type_names=("CreateTransferStatus",),
        )
        existing_by_id = _existing_transfers_by_id(
            client,
            specs=specs,
            statuses=transfer_statuses,
        )
        ordered_statuses: list[str] = []
        for index, spec in enumerate(specs):
            status = transfer_statuses[index]
            if status not in {"created", "exists"}:
                raise RuntimeError(f"tigerbeetle_create_transfer_failed:{status}")
            if status == "exists":
                existing = existing_by_id.get(spec.transfer_id)
                if existing is None or not _transfer_matches(existing, spec):
                    raise RuntimeError("tigerbeetle_duplicate_transfer_conflict")
            ordered_statuses.append(status)
        return ordered_statuses


def _account_key(
    code: int,
    suffix: str,
) -> str:
    return f"testnet:{code}:{suffix}"


def _account_specs(event: HyperliquidJournalEvent) -> list[TigerBeetleAccountSpec]:
    return [
        _account_spec(event.debit_account_key),
        _account_spec(event.credit_account_key),
    ]


def _account_spec(account_key: str) -> TigerBeetleAccountSpec:
    return TigerBeetleAccountSpec(
        account_id=stable_u128("torghut.hyperliquid.account", account_key),
        account_key=account_key,
        ledger=LEDGER_USD_MICRO,
        code=_account_code(account_key),
        account_label="hyperliquid-testnet",
        symbol=_account_symbol(account_key),
        strategy_id="hl-equity-momentum-v1",
    )


def _account_code(account_key: str) -> int:
    parts = account_key.split(":", 2)
    if len(parts) != 3 or parts[0] != "testnet":
        raise ValueError(f"hyperliquid_account_key_invalid:{account_key}")
    return int(parts[1])


def _account_symbol(account_key: str) -> str | None:
    suffix = account_key.split(":", 2)[-1]
    return None if suffix == "testnet-cash" else suffix


def _dedupe_account_specs(
    account_specs: Sequence[TigerBeetleAccountSpec],
) -> list[TigerBeetleAccountSpec]:
    by_key: dict[str, TigerBeetleAccountSpec] = {}
    ordered: list[TigerBeetleAccountSpec] = []
    for spec in account_specs:
        existing = by_key.get(spec.account_key)
        if existing is not None:
            if existing != spec:
                raise RuntimeError("tigerbeetle_account_spec_conflict")
            continue
        by_key[spec.account_key] = spec
        ordered.append(spec)
    return ordered


def _existing_transfers_by_id(
    client: TigerBeetleClientProtocol,
    *,
    specs: Sequence[TigerBeetleTransferSpec],
    statuses: dict[int, str],
) -> dict[int, object]:
    existing_transfer_ids = list(
        dict.fromkeys(
            specs[index].transfer_id
            for index, status in statuses.items()
            if status == "exists"
        )
    )
    if not existing_transfer_ids:
        return {}
    return {
        int(transfer_attr(transfer, "id")): transfer
        for transfer in client.lookup_transfers(existing_transfer_ids)
    }


def _transfer_matches(actual: object, expected: TigerBeetleTransferSpec) -> bool:
    return (
        int(transfer_attr(actual, "id")) == expected.transfer_id
        and int(transfer_attr(actual, "amount")) == expected.amount
        and int(transfer_attr(actual, "ledger")) == expected.ledger
        and int(transfer_attr(actual, "code")) == expected.code
        and int(transfer_attr(actual, "debit_account_id")) == expected.debit_account_id
        and int(transfer_attr(actual, "credit_account_id"))
        == expected.credit_account_id
    )
