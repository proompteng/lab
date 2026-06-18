"""TigerBeetle accounting plan for Hyperliquid runtime events."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import text

from app.trading.tigerbeetle_ids import stable_u128, u128_decimal
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
    TigerBeetleTransferSpec,
    decimal_usd_to_nearest_micros,
)

from .models import Fill, OrderIntent, OrderResult
from .runtime_session import RuntimeSession


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
    """Persist TigerBeetle transfer refs for independent reconciliation."""

    def __init__(self, *, cluster_id: int) -> None:
        if cluster_id <= 0:
            raise ValueError("tigerbeetle_cluster_id_invalid")
        self._cluster_id = cluster_id

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
        count = 0
        for event in events:
            spec = self.transfer_spec(event)
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
                    ON CONFLICT (transfer_id) DO NOTHING
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
                    "status": "planned",
                },
            )
            count += 1
        return count


def _account_key(
    code: int,
    suffix: str,
) -> str:
    return f"testnet:{code}:{suffix}"
