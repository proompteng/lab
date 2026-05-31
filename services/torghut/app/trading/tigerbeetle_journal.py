"""Idempotent Torghut order-event journal for TigerBeetle."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from types import TracebackType
from typing import Any, Self, cast

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.models import (
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
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
    ACCOUNT_CODE_EVIDENCE_CONTROL,
    ACCOUNT_CODE_EXECUTION_COST,
    ACCOUNT_CODE_EXECUTION_EVIDENCE,
    ACCOUNT_CODE_FILL_NOTIONAL,
    ACCOUNT_CODE_ORDER_HOLD,
    ACCOUNT_CODE_REALIZED_PNL,
    ACCOUNT_CODE_RUNTIME_LEDGER_EVIDENCE,
    LEDGER_USD_MICRO,
    TRANSFER_KIND_CANCEL_VOID,
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_REJECT_VOID,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    TRANSFER_KIND_SUBMITTED_PENDING,
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
    decimal_usd_to_nearest_micros,
    transfer_code_for_kind,
    transfer_kind_for_event,
)

SOURCE_TYPE_EXECUTION = "execution"
SOURCE_TYPE_EXECUTION_ORDER_EVENT = "execution_order_event"
SOURCE_TYPE_EXECUTION_TCA_METRIC = "execution_tca_metric"
SOURCE_TYPE_RUNTIME_LEDGER_BUCKET = "strategy_runtime_ledger_bucket"


def _official_status_name(value: object) -> str | None:
    if not isinstance(value, int):
        return None
    fallback_statuses = {46: "exists", 4294967295: "created"}
    try:
        import tigerbeetle as tb
    except Exception:
        return fallback_statuses.get(value)

    for status_type_name in ("CreateTransferStatus", "CreateAccountStatus"):
        status_type = getattr(tb, status_type_name, None)
        if status_type is None:
            continue
        for name in dir(status_type):
            if name.startswith("_"):
                continue
            status_value = getattr(status_type, name)
            if isinstance(status_value, int) and status_value == value:
                return name.lower()
    return fallback_statuses.get(value)


def _normalize_result_status(value: object) -> str:
    official_name = _official_status_name(value)
    if official_name is not None:
        return official_name
    return str(value or "").split(".")[-1].lower()


def _result_status(result: object) -> str:
    if isinstance(result, Mapping):
        result_mapping = cast(Mapping[str, object], result)
        return _normalize_result_status(result_mapping.get("status"))
    return _normalize_result_status(getattr(result, "status", ""))


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


FILL_POST_EVENT_TYPES = {"fill", "filled", "partial_fill", "partially_filled"}


def _event_amount_usd(
    event: ExecutionOrderEvent,
    transfer_kind: str,
    *,
    session: Session | None = None,
) -> Decimal | None:
    explicit_delta = _explicit_fill_delta_notional_usd(event)
    if transfer_kind == TRANSFER_KIND_FILL_POST and explicit_delta is not None:
        return explicit_delta

    amount = _event_cumulative_amount_usd(event, transfer_kind)
    if transfer_kind != TRANSFER_KIND_FILL_POST or amount is None or session is None:
        return amount

    prior_amount = _prior_cumulative_fill_notional_usd(session, event)
    if prior_amount is None:
        return amount
    delta = amount - prior_amount
    if delta <= 0:
        return None
    return abs(delta)


def _explicit_fill_delta_notional_usd(event: ExecutionOrderEvent) -> Decimal | None:
    raw_event = _nested_mapping(event.raw_event)
    nested_order = _nested_mapping(raw_event.get("order"))
    value = _lookup_payload_decimal(
        raw_event,
        (
            "fill_notional",
            "last_fill_notional",
            "filled_notional_delta",
            "execution_notional",
        ),
    )
    if value is None:
        value = _lookup_payload_decimal(
            nested_order,
            (
                "fill_notional",
                "last_fill_notional",
                "filled_notional_delta",
                "execution_notional",
            ),
        )
    return abs(value) if value is not None else None


def _event_cumulative_amount_usd(
    event: ExecutionOrderEvent, transfer_kind: str
) -> Decimal | None:
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


def _prior_cumulative_fill_notional_usd(
    session: Session, event: ExecutionOrderEvent
) -> Decimal | None:
    clauses: list[Any] = []
    if event.alpaca_order_id:
        clauses.append(ExecutionOrderEvent.alpaca_order_id == event.alpaca_order_id)
    if event.client_order_id:
        clauses.append(ExecutionOrderEvent.client_order_id == event.client_order_id)
    if not clauses:
        return None

    candidates = (
        session.execute(
            select(ExecutionOrderEvent).where(
                ExecutionOrderEvent.id != event.id,
                ExecutionOrderEvent.alpaca_account_label == event.alpaca_account_label,
                or_(*clauses),
            )
        )
        .scalars()
        .all()
    )
    prior_amounts = [
        _event_cumulative_amount_usd(candidate, TRANSFER_KIND_FILL_POST)
        for candidate in candidates
        if _is_fill_post_event(candidate) and _order_event_precedes(candidate, event)
    ]
    usable_amounts = [amount for amount in prior_amounts if amount is not None]
    if not usable_amounts:
        return None
    return max(usable_amounts)


def _is_fill_post_event(event: ExecutionOrderEvent) -> bool:
    normalized = (event.event_type or event.status or "").strip().lower()
    return normalized in FILL_POST_EVENT_TYPES


def _order_event_precedes(
    candidate: ExecutionOrderEvent, event: ExecutionOrderEvent
) -> bool:
    if (
        candidate.source_topic == event.source_topic
        and candidate.source_partition == event.source_partition
        and candidate.source_offset is not None
        and event.source_offset is not None
    ):
        return candidate.source_offset < event.source_offset
    if candidate.feed_seq is not None and event.feed_seq is not None:
        return candidate.feed_seq < event.feed_seq
    if candidate.event_ts is not None and event.event_ts is not None:
        return candidate.event_ts < event.event_ts
    return candidate.created_at < event.created_at


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


def execution_transfer_id(execution: Execution) -> int:
    return stable_u128("torghut.tigerbeetle.execution_fill", str(execution.id))


def execution_cost_transfer_id(metric: ExecutionTCAMetric) -> int:
    return stable_u128("torghut.tigerbeetle.execution_cost", str(metric.id))


def runtime_ledger_transfer_id(bucket: StrategyRuntimeLedgerBucket) -> int:
    return stable_u128("torghut.tigerbeetle.runtime_ledger", str(bucket.id))


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


def _evidence_account_specs(
    *,
    account_label: str | None,
    symbol: str | None,
    strategy_id: str | None,
    runtime_key: str | None = None,
) -> list[TigerBeetleAccountSpec]:
    normalized_account_label = account_label or "unknown"
    normalized_symbol = symbol or "UNKNOWN"
    normalized_strategy_id = strategy_id or "unknown"
    runtime_identity = runtime_key or normalized_strategy_id
    return [
        TigerBeetleAccountSpec(
            account_id=_account_id(f"evidence_control:{normalized_account_label}:usd"),
            account_key=f"evidence_control:{normalized_account_label}:usd",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_EVIDENCE_CONTROL,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=_account_id(
                "execution_evidence:"
                f"{normalized_account_label}:{normalized_symbol}:{normalized_strategy_id}"
            ),
            account_key=(
                "execution_evidence:"
                f"{normalized_account_label}:{normalized_symbol}:{normalized_strategy_id}"
            ),
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_EXECUTION_EVIDENCE,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=_account_id(
                "execution_cost:"
                f"{normalized_account_label}:{normalized_symbol}:{normalized_strategy_id}"
            ),
            account_key=(
                "execution_cost:"
                f"{normalized_account_label}:{normalized_symbol}:{normalized_strategy_id}"
            ),
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_EXECUTION_COST,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=_account_id(
                f"runtime_ledger:{normalized_account_label}:{runtime_identity}"
            ),
            account_key=f"runtime_ledger:{normalized_account_label}:{runtime_identity}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_RUNTIME_LEDGER_EVIDENCE,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
    ]


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
    amount_usd = _event_amount_usd(event, transfer_kind, session=session)
    amount = (
        decimal_usd_to_nearest_micros(amount_usd) if amount_usd is not None else None
    )
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


def _source_transfer_spec(
    *,
    transfer_id: int,
    transfer_kind: str,
    amount: int,
    debit: TigerBeetleAccountSpec,
    credit: TigerBeetleAccountSpec,
) -> TigerBeetleTransferSpec:
    return TigerBeetleTransferSpec(
        transfer_id=transfer_id,
        transfer_kind=transfer_kind,
        debit_account_id=debit.account_id,
        credit_account_id=credit.account_id,
        amount=amount,
        ledger=LEDGER_USD_MICRO,
        code=transfer_code_for_kind(transfer_kind),
    )


def _execution_notional_usd(execution: Execution) -> Decimal | None:
    if execution.avg_fill_price is None:
        return None
    amount = Decimal(str(execution.filled_qty)) * Decimal(str(execution.avg_fill_price))
    return abs(amount)


def _amount_to_micros(value: Decimal | None) -> int | None:
    if value is None:
        return None
    amount = decimal_usd_to_nearest_micros(abs(Decimal(str(value))))
    return amount if amount > 0 else None


class TigerBeetleLedgerJournal:
    def __init__(
        self,
        *,
        settings_obj: Settings = settings,
        client: TigerBeetleClientProtocol | None = None,
    ) -> None:
        self._settings = settings_obj
        self._client = client
        self._owns_client = client is None

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc, traceback
        self.close()

    def _client_for_write(self) -> TigerBeetleClientProtocol:
        if self._client is None:
            self._client = create_tigerbeetle_client(self._settings)
        return self._client

    def client_for_reconciliation(self) -> TigerBeetleClientProtocol | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        return self._client_for_write()

    def close(self) -> None:
        if not self._owns_client or self._client is None:
            return
        close = getattr(self._client, "close", None)
        if callable(close):
            close()
        self._client = None

    def _persist_transfer(
        self,
        session: Session,
        *,
        account_specs: Sequence[TigerBeetleAccountSpec],
        transfer_spec: TigerBeetleTransferSpec,
        trade_decision_id: object | None = None,
        execution_id: object | None = None,
        execution_order_event_id: object | None = None,
        execution_tca_metric_id: object | None = None,
        runtime_ledger_bucket_id: object | None = None,
        event_fingerprint: str | None = None,
        source_type: str,
        source_id: str,
        payload_json: Mapping[str, object],
    ) -> TigerBeetleTransferRef:
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
                existing.transfer_kind == transfer_spec.transfer_kind
                and existing.amount == Decimal(transfer_spec.amount)
                and existing.code == transfer_spec.code
                and existing.ledger == transfer_spec.ledger
            ):
                if existing.trade_decision_id is None:
                    existing.trade_decision_id = cast(Any, trade_decision_id)
                if existing.execution_id is None:
                    existing.execution_id = cast(Any, execution_id)
                if existing.execution_order_event_id is None:
                    existing.execution_order_event_id = cast(
                        Any,
                        execution_order_event_id,
                    )
                if existing.execution_tca_metric_id is None:
                    existing.execution_tca_metric_id = cast(
                        Any,
                        execution_tca_metric_id,
                    )
                if existing.runtime_ledger_bucket_id is None:
                    existing.runtime_ledger_bucket_id = cast(
                        Any,
                        runtime_ledger_bucket_id,
                    )
                if existing.source_type is None:
                    existing.source_type = source_type
                if existing.source_id is None:
                    existing.source_id = source_id
                if existing.event_fingerprint is None:
                    existing.event_fingerprint = event_fingerprint
                raw_existing_payload: object = existing.payload_json
                existing_payload: Mapping[str, object] = (
                    cast(Mapping[str, object], raw_existing_payload)
                    if isinstance(raw_existing_payload, Mapping)
                    else {}
                )
                existing.payload_json = coerce_json_payload(
                    {
                        **existing_payload,
                        **payload_json,
                    }
                )
                session.add(existing)
                session.flush()
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
            transfer_kind=transfer_spec.transfer_kind,
            ledger=transfer_spec.ledger,
            code=transfer_spec.code,
            amount=Decimal(transfer_spec.amount),
            status=status,
            result_code=status,
            trade_decision_id=trade_decision_id,
            execution_id=execution_id,
            execution_order_event_id=execution_order_event_id,
            execution_tca_metric_id=execution_tca_metric_id,
            runtime_ledger_bucket_id=runtime_ledger_bucket_id,
            source_type=source_type,
            source_id=source_id,
            event_fingerprint=event_fingerprint,
            payload_json=coerce_json_payload(payload_json),
        )
        session.add(ref)
        session.flush()
        return ref

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

        transfer_spec = plan.transfer_spec
        return self._persist_transfer(
            session,
            account_specs=plan.account_specs,
            transfer_spec=transfer_spec,
            trade_decision_id=event.trade_decision_id,
            execution_id=event.execution_id,
            execution_order_event_id=event.id,
            source_type=SOURCE_TYPE_EXECUTION_ORDER_EVENT,
            source_id=str(event.id),
            event_fingerprint=event.event_fingerprint,
            payload_json={
                "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
                "pending_id": u128_decimal(transfer_spec.pending_id)
                if transfer_spec.pending_id
                else None,
                "pending_mode": plan.pending_mode,
                "source": SOURCE_TYPE_EXECUTION_ORDER_EVENT,
            },
        )

    def journal_execution(
        self, session: Session, execution: Execution
    ) -> TigerBeetleTransferRef | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        amount = _amount_to_micros(_execution_notional_usd(execution))
        if amount is None:
            return None
        strategy_id = (
            str(execution.trade_decision_id) if execution.trade_decision_id else None
        )
        account_specs = _evidence_account_specs(
            account_label=execution.alpaca_account_label,
            symbol=execution.symbol,
            strategy_id=strategy_id,
        )
        accounts = {spec.account_key: spec for spec in account_specs}
        control = accounts[f"evidence_control:{execution.alpaca_account_label}:usd"]
        execution_account = accounts[
            f"execution_evidence:{execution.alpaca_account_label}:{execution.symbol}:{strategy_id or 'unknown'}"
        ]
        transfer_spec = _source_transfer_spec(
            transfer_id=execution_transfer_id(execution),
            transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
            amount=amount,
            debit=control,
            credit=execution_account,
        )
        return self._persist_transfer(
            session,
            account_specs=account_specs,
            transfer_spec=transfer_spec,
            trade_decision_id=execution.trade_decision_id,
            execution_id=execution.id,
            source_type=SOURCE_TYPE_EXECUTION,
            source_id=str(execution.id),
            payload_json={
                "source": SOURCE_TYPE_EXECUTION,
                "alpaca_order_id": execution.alpaca_order_id,
                "client_order_id": execution.client_order_id,
                "filled_qty": str(execution.filled_qty),
                "avg_fill_price": str(execution.avg_fill_price),
                "notional_micros": amount,
                "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
            },
        )

    def journal_execution_tca_metric(
        self, session: Session, metric: ExecutionTCAMetric
    ) -> TigerBeetleTransferRef | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        amount = _amount_to_micros(metric.shortfall_notional)
        if amount is None:
            return None
        strategy_id = str(metric.strategy_id) if metric.strategy_id else None
        account_specs = _evidence_account_specs(
            account_label=metric.alpaca_account_label,
            symbol=metric.symbol,
            strategy_id=strategy_id,
        )
        account_label = metric.alpaca_account_label or "unknown"
        accounts = {spec.account_key: spec for spec in account_specs}
        control = accounts[f"evidence_control:{account_label}:usd"]
        cost_account = accounts[
            f"execution_cost:{account_label}:{metric.symbol}:{strategy_id or 'unknown'}"
        ]
        transfer_spec = _source_transfer_spec(
            transfer_id=execution_cost_transfer_id(metric),
            transfer_kind=TRANSFER_KIND_EXECUTION_COST,
            amount=amount,
            debit=control,
            credit=cost_account,
        )
        return self._persist_transfer(
            session,
            account_specs=account_specs,
            transfer_spec=transfer_spec,
            trade_decision_id=metric.trade_decision_id,
            execution_id=metric.execution_id,
            execution_tca_metric_id=metric.id,
            source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
            source_id=str(metric.id),
            payload_json={
                "source": SOURCE_TYPE_EXECUTION_TCA_METRIC,
                "shortfall_notional": str(metric.shortfall_notional),
                "realized_shortfall_bps": str(metric.realized_shortfall_bps),
                "simulator_version": metric.simulator_version,
                "cost_micros": amount,
                "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
            },
        )

    def journal_runtime_ledger_bucket(
        self, session: Session, bucket: StrategyRuntimeLedgerBucket
    ) -> TigerBeetleTransferRef | None:
        if (
            not self._settings.tigerbeetle_enabled
            or not self._settings.tigerbeetle_journal_enabled
        ):
            return None
        amount_source = (
            bucket.net_strategy_pnl_after_costs
            if bucket.net_strategy_pnl_after_costs != Decimal("0")
            else bucket.cost_amount
        )
        amount = _amount_to_micros(amount_source)
        if amount is None:
            return None
        runtime_key = f"{bucket.hypothesis_id}:{bucket.run_id}:{bucket.bucket_started_at.isoformat()}"
        account_specs = _evidence_account_specs(
            account_label=bucket.account_label,
            symbol=None,
            strategy_id=bucket.hypothesis_id,
            runtime_key=runtime_key,
        )
        account_label = bucket.account_label or "unknown"
        accounts = {spec.account_key: spec for spec in account_specs}
        control = accounts[f"evidence_control:{account_label}:usd"]
        runtime_account = accounts[f"runtime_ledger:{account_label}:{runtime_key}"]
        transfer_spec = _source_transfer_spec(
            transfer_id=runtime_ledger_transfer_id(bucket),
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            amount=amount,
            debit=control,
            credit=runtime_account,
        )
        return self._persist_transfer(
            session,
            account_specs=account_specs,
            transfer_spec=transfer_spec,
            runtime_ledger_bucket_id=bucket.id,
            source_type=SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
            source_id=str(bucket.id),
            payload_json={
                "source": SOURCE_TYPE_RUNTIME_LEDGER_BUCKET,
                "run_id": bucket.run_id,
                "candidate_id": bucket.candidate_id,
                "hypothesis_id": bucket.hypothesis_id,
                "observed_stage": bucket.observed_stage,
                "pnl_basis": bucket.pnl_basis,
                "ledger_schema_version": bucket.ledger_schema_version,
                "filled_notional": str(bucket.filled_notional),
                "gross_strategy_pnl": str(bucket.gross_strategy_pnl),
                "cost_amount": str(bucket.cost_amount),
                "net_strategy_pnl_after_costs": str(
                    bucket.net_strategy_pnl_after_costs
                ),
                "amount_source": str(amount_source),
                "amount_micros": amount,
                "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
            },
        )
