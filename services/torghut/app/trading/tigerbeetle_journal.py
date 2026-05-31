"""Idempotent Torghut order-event journal for TigerBeetle."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.models import (
    ExecutionOrderEvent,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
    coerce_json_payload,
)
from app.trading.tigerbeetle_client import (
    TigerBeetleClientProtocol,
    create_tigerbeetle_client,
)
from app.trading.tigerbeetle_ids import stable_u128, u128_decimal
from app.trading.tigerbeetle_ledger_model import (
    ACCOUNT_CODE_CASH_CONTROL,
    ACCOUNT_CODE_EXECUTION_COST,
    ACCOUNT_CODE_FILL_NOTIONAL,
    ACCOUNT_CODE_ORDER_HOLD,
    ACCOUNT_CODE_REALIZED_PNL,
    LEDGER_USD_MICRO,
    TRANSFER_KIND_CANCEL_VOID,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_REJECT_VOID,
    TRANSFER_KIND_SUBMITTED_PENDING,
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
    decimal_usd_to_micros,
    transfer_code_for_kind,
    transfer_kind_for_event,
)


def _result_status(result: object) -> str:
    if isinstance(result, Mapping):
        result_mapping = cast(Mapping[str, object], result)
        return str(result_mapping.get("status") or "").split(".")[-1].lower()
    return str(getattr(result, "status", "")).split(".")[-1].lower()


def _transfer_attr(transfer: object, name: str) -> Any:
    if isinstance(transfer, Mapping):
        transfer_mapping = cast(Mapping[str, Any], transfer)
        value = transfer_mapping.get(name)
        if value is None and name == "id":
            value = transfer_mapping.get("transfer_id")
        return value
    if hasattr(transfer, name):
        return getattr(transfer, name)
    if name == "id" and hasattr(transfer, "transfer_id"):
        return getattr(transfer, "transfer_id")
    raise AttributeError(name)


def _lookup_payload_decimal(
    payload: Mapping[str, Any], keys: Sequence[str]
) -> Decimal | None:
    for key in keys:
        value = payload.get(key)
        if value is None:
            continue
        try:
            return Decimal(str(value))
        except Exception:
            continue
    return None


def _nested_mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _event_amount_usd(event: ExecutionOrderEvent, transfer_kind: str) -> Decimal | None:
    raw_event = _nested_mapping(event.raw_event)
    nested_order = _nested_mapping(raw_event.get("order"))
    notional = _lookup_payload_decimal(raw_event, ("notional", "filled_notional"))
    if notional is None:
        notional = _lookup_payload_decimal(
            nested_order, ("notional", "filled_notional")
        )
    if notional is not None:
        return abs(notional)

    qty = event.filled_qty if transfer_kind == TRANSFER_KIND_FILL_POST else event.qty
    if qty is None:
        qty = _lookup_payload_decimal(raw_event, ("qty", "quantity", "filled_qty"))
    price = event.avg_fill_price
    if price is None:
        price = _lookup_payload_decimal(
            raw_event,
            ("avg_fill_price", "filled_avg_price", "limit_price", "price"),
        )
    if price is None:
        price = _lookup_payload_decimal(
            nested_order,
            ("avg_fill_price", "filled_avg_price", "limit_price", "price"),
        )
    if qty is None or price is None:
        return None
    amount = Decimal(str(qty)) * Decimal(str(price))
    return abs(amount)


def _account_id(account_key: str) -> int:
    return stable_u128("torghut.tigerbeetle.account", account_key)


@dataclass(frozen=True)
class TigerBeetleOrderEventTransferPlan:
    account_specs: tuple[TigerBeetleAccountSpec, ...]
    transfer_spec: TigerBeetleTransferSpec
    transfer_kind: str
    pending_mode: str


def _submitted_pending_key(event: ExecutionOrderEvent) -> str:
    source_id = (
        str(event.execution_id)
        if event.execution_id is not None
        else event.client_order_id or event.alpaca_order_id or event.event_fingerprint
    )
    return f"{event.alpaca_account_label}:{source_id}"


def submitted_pending_transfer_id(event: ExecutionOrderEvent) -> int:
    return stable_u128(
        "torghut.tigerbeetle.submitted_pending",
        _submitted_pending_key(event),
    )


def event_transfer_id(event: ExecutionOrderEvent, transfer_kind: str) -> int:
    if transfer_kind == TRANSFER_KIND_SUBMITTED_PENDING:
        return submitted_pending_transfer_id(event)
    return stable_u128(
        "torghut.tigerbeetle.transfer",
        f"{event.event_fingerprint}:{transfer_kind}",
    )


def _account_specs(event: ExecutionOrderEvent) -> list[TigerBeetleAccountSpec]:
    account_label = event.alpaca_account_label
    symbol = event.symbol
    strategy_id = str(event.trade_decision_id) if event.trade_decision_id else None
    order_identity = (
        event.client_order_id or event.alpaca_order_id or event.event_fingerprint
    )
    specs = [
        TigerBeetleAccountSpec(
            account_id=_account_id(f"cash:{account_label}:usd"),
            account_key=f"cash:{account_label}:usd",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_CASH_CONTROL,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=_account_id(f"order_hold:{account_label}:{order_identity}"),
            account_key=f"order_hold:{account_label}:{order_identity}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_ORDER_HOLD,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=_account_id(
                f"fill_notional:{account_label}:{symbol}:{strategy_id}"
            ),
            account_key=f"fill_notional:{account_label}:{symbol}:{strategy_id}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_FILL_NOTIONAL,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=_account_id(
                f"execution_cost:{account_label}:{symbol}:{strategy_id}"
            ),
            account_key=f"execution_cost:{account_label}:{symbol}:{strategy_id}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_EXECUTION_COST,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=_account_id(f"realized_pnl:{account_label}:{strategy_id}"),
            account_key=f"realized_pnl:{account_label}:{strategy_id}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_REALIZED_PNL,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
    ]
    return specs


def _transfer_flag(flag_name: str) -> int:
    try:
        import tigerbeetle as tb
    except Exception:
        return 0
    flags = getattr(tb, "TransferFlags", None)
    if flags is None:
        return 0
    value = getattr(flags, flag_name, None)
    if value is None:
        value = getattr(flags, flag_name.lower(), None)
    if value is None:
        return 0
    return int(value)


def _transfer_spec(
    event: ExecutionOrderEvent,
    *,
    transfer_kind: str,
    amount: int,
    accounts: Mapping[str, TigerBeetleAccountSpec],
    use_pending_transfer: bool = True,
) -> TigerBeetleTransferSpec:
    cash = accounts[f"cash:{event.alpaca_account_label}:usd"]
    order_identity = (
        event.client_order_id or event.alpaca_order_id or event.event_fingerprint
    )
    order_hold = accounts[f"order_hold:{event.alpaca_account_label}:{order_identity}"]
    fill_notional = accounts[
        f"fill_notional:{event.alpaca_account_label}:{event.symbol}:{str(event.trade_decision_id) if event.trade_decision_id else None}"
    ]
    transfer_id = event_transfer_id(event, transfer_kind)
    code = transfer_code_for_kind(transfer_kind)

    if transfer_kind == TRANSFER_KIND_SUBMITTED_PENDING:
        return TigerBeetleTransferSpec(
            transfer_id=transfer_id,
            transfer_kind=transfer_kind,
            debit_account_id=cash.account_id,
            credit_account_id=order_hold.account_id,
            amount=amount,
            ledger=LEDGER_USD_MICRO,
            code=code,
            flags=_transfer_flag("PENDING"),
            timeout=0,
        )
    if transfer_kind in {TRANSFER_KIND_CANCEL_VOID, TRANSFER_KIND_REJECT_VOID}:
        if not use_pending_transfer:
            raise ValueError("tigerbeetle_pending_transfer_required_for_void")
        return TigerBeetleTransferSpec(
            transfer_id=transfer_id,
            transfer_kind=transfer_kind,
            debit_account_id=cash.account_id,
            credit_account_id=order_hold.account_id,
            amount=amount,
            pending_id=submitted_pending_transfer_id(event),
            ledger=LEDGER_USD_MICRO,
            code=code,
            flags=_transfer_flag("VOID_PENDING_TRANSFER"),
        )
    if transfer_kind == TRANSFER_KIND_FILL_POST and not use_pending_transfer:
        return TigerBeetleTransferSpec(
            transfer_id=transfer_id,
            transfer_kind=transfer_kind,
            debit_account_id=cash.account_id,
            credit_account_id=fill_notional.account_id,
            amount=amount,
            ledger=LEDGER_USD_MICRO,
            code=code,
        )
    return TigerBeetleTransferSpec(
        transfer_id=transfer_id,
        transfer_kind=transfer_kind,
        debit_account_id=order_hold.account_id,
        credit_account_id=fill_notional.account_id,
        amount=amount,
        pending_id=submitted_pending_transfer_id(event)
        if transfer_kind == TRANSFER_KIND_FILL_POST
        else 0,
        ledger=LEDGER_USD_MICRO,
        code=code,
        flags=_transfer_flag("POST_PENDING_TRANSFER")
        if transfer_kind == TRANSFER_KIND_FILL_POST
        else 0,
    )


def _pending_transfer_ref_for_event(
    session: Session,
    event: ExecutionOrderEvent,
    *,
    cluster_id: int,
) -> TigerBeetleTransferRef | None:
    return session.execute(
        select(TigerBeetleTransferRef).where(
            TigerBeetleTransferRef.cluster_id == cluster_id,
            TigerBeetleTransferRef.transfer_id
            == u128_decimal(submitted_pending_transfer_id(event)),
            TigerBeetleTransferRef.transfer_kind == TRANSFER_KIND_SUBMITTED_PENDING,
        )
    ).scalar_one_or_none()


def build_order_event_transfer_plan(
    session: Session,
    event: ExecutionOrderEvent,
    *,
    settings_obj: Settings = settings,
) -> TigerBeetleOrderEventTransferPlan | None:
    transfer_kind = transfer_kind_for_event(event.event_type, event.status)
    if transfer_kind is None:
        return None

    pending_ref = (
        _pending_transfer_ref_for_event(
            session,
            event,
            cluster_id=settings_obj.tigerbeetle_cluster_id,
        )
        if transfer_kind
        in {
            TRANSFER_KIND_FILL_POST,
            TRANSFER_KIND_CANCEL_VOID,
            TRANSFER_KIND_REJECT_VOID,
        }
        else None
    )
    amount_usd = _event_amount_usd(event, transfer_kind)
    amount = decimal_usd_to_micros(amount_usd) if amount_usd is not None else None
    if amount is None and pending_ref is not None:
        amount = int(pending_ref.amount)
    if amount is None or amount <= 0:
        return None
    if (
        transfer_kind in {TRANSFER_KIND_CANCEL_VOID, TRANSFER_KIND_REJECT_VOID}
        and pending_ref is None
    ):
        return None

    account_specs = tuple(_account_specs(event))
    account_by_key = {spec.account_key: spec for spec in account_specs}
    use_pending_transfer = pending_ref is not None or transfer_kind in {
        TRANSFER_KIND_SUBMITTED_PENDING,
        TRANSFER_KIND_CANCEL_VOID,
        TRANSFER_KIND_REJECT_VOID,
    }
    transfer_spec = _transfer_spec(
        event,
        transfer_kind=transfer_kind,
        amount=amount,
        accounts=account_by_key,
        use_pending_transfer=use_pending_transfer,
    )
    return TigerBeetleOrderEventTransferPlan(
        account_specs=account_specs,
        transfer_spec=transfer_spec,
        transfer_kind=transfer_kind,
        pending_mode=(
            "pending_transfer_ref"
            if pending_ref is not None
            else "standalone_fill"
            if transfer_kind == TRANSFER_KIND_FILL_POST
            else "pending_transfer"
        ),
    )


def _persist_account_refs(
    session: Session,
    *,
    cluster_id: int,
    account_specs: Sequence[TigerBeetleAccountSpec],
) -> None:
    for spec in account_specs:
        existing = session.execute(
            select(TigerBeetleAccountRef).where(
                TigerBeetleAccountRef.cluster_id == cluster_id,
                TigerBeetleAccountRef.account_key == spec.account_key,
            )
        ).scalar_one_or_none()
        if existing is not None:
            continue
        session.add(
            TigerBeetleAccountRef(
                cluster_id=cluster_id,
                account_id=u128_decimal(spec.account_id),
                account_key=spec.account_key,
                ledger=spec.ledger,
                code=spec.code,
                account_label=spec.account_label,
                symbol=spec.symbol,
                strategy_id=spec.strategy_id,
            )
        )
    session.flush()


def _transfer_matches(
    actual: object,
    expected: TigerBeetleTransferSpec,
) -> bool:
    return (
        int(_transfer_attr(actual, "id")) == expected.transfer_id
        and int(_transfer_attr(actual, "amount")) == expected.amount
        and int(_transfer_attr(actual, "ledger")) == expected.ledger
        and int(_transfer_attr(actual, "code")) == expected.code
        and int(_transfer_attr(actual, "debit_account_id")) == expected.debit_account_id
        and int(_transfer_attr(actual, "credit_account_id"))
        == expected.credit_account_id
    )


class TigerBeetleLedgerJournal:
    def __init__(
        self,
        *,
        settings_obj: Settings = settings,
        client: TigerBeetleClientProtocol | None = None,
    ) -> None:
        self._settings = settings_obj
        self._client = client

    def _client_for_write(self) -> TigerBeetleClientProtocol:
        return self._client or create_tigerbeetle_client(self._settings)

    def journal_order_event(
        self, session: Session, event: ExecutionOrderEvent
    ) -> TigerBeetleTransferRef | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        plan = build_order_event_transfer_plan(
            session,
            event,
            settings_obj=self._settings,
        )
        if plan is None:
            return None

        account_specs = plan.account_specs
        transfer_spec = plan.transfer_spec
        transfer_id_text = u128_decimal(transfer_spec.transfer_id)
        existing = session.execute(
            select(TigerBeetleTransferRef).where(
                TigerBeetleTransferRef.cluster_id
                == self._settings.tigerbeetle_cluster_id,
                TigerBeetleTransferRef.transfer_id == transfer_id_text,
            )
        ).scalar_one_or_none()
        if existing is not None:
            if (
                existing.amount == Decimal(transfer_spec.amount)
                and existing.code == transfer_spec.code
                and existing.ledger == transfer_spec.ledger
            ):
                return existing
            raise RuntimeError("tigerbeetle_transfer_ref_conflict")

        _persist_account_refs(
            session,
            cluster_id=self._settings.tigerbeetle_cluster_id,
            account_specs=account_specs,
        )
        client = self._client_for_write()
        client.create_accounts(account_specs)
        transfer_results = client.create_transfers([transfer_spec])
        status = _result_status(transfer_results[0]) if transfer_results else "created"
        if status not in {"created", "exists"}:
            raise RuntimeError(f"tigerbeetle_create_transfer_failed:{status}")
        if status == "exists":
            matches = [
                item
                for item in client.lookup_transfers([transfer_spec.transfer_id])
                if _transfer_matches(item, transfer_spec)
            ]
            if not matches:
                raise RuntimeError("tigerbeetle_duplicate_transfer_conflict")

        ref = TigerBeetleTransferRef(
            cluster_id=self._settings.tigerbeetle_cluster_id,
            transfer_id=transfer_id_text,
            transfer_kind=plan.transfer_kind,
            ledger=transfer_spec.ledger,
            code=transfer_spec.code,
            amount=Decimal(transfer_spec.amount),
            status=status,
            result_code=status,
            trade_decision_id=event.trade_decision_id,
            execution_id=event.execution_id,
            execution_order_event_id=event.id,
            event_fingerprint=event.event_fingerprint,
            payload_json=coerce_json_payload(
                {
                    "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                    "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
                    "pending_id": u128_decimal(transfer_spec.pending_id)
                    if transfer_spec.pending_id
                    else None,
                    "pending_mode": plan.pending_mode,
                    "source": "execution_order_event",
                }
            ),
        )
        session.add(ref)
        session.flush()
        return ref
