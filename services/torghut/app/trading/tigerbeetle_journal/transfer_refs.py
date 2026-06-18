"""Idempotent Torghut order-event journal for TigerBeetle."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
import hashlib
from typing import Any, cast

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
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
    TRANSFER_KIND_FILL_POST,
    TRANSFER_KIND_REJECT_VOID,
    TRANSFER_KIND_SUBMITTED_PENDING,
    TigerBeetleAccountSpec,
    TigerBeetleTransferSpec,
    decimal_usd_to_nearest_micros,
    transfer_code_for_kind,
    transfer_kind_for_event,
)

from .journal_payloads import (
    PreparedTigerBeetleTransferWrite,
    TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT,
    TigerBeetleOrderEventTransferPlan,
    account_id_for_key,
    economic_decimal_text,
    event_amount_usd,
    nested_mapping,
    submitted_pending_key,
    transfer_attr,
)


@dataclass(frozen=True)
class TransferRefLookupKey:
    cluster_id: int
    transfer_id_text: str
    source_type: str
    source_id: str
    transfer_kind: str


def _economic_text(value: object) -> str:
    if isinstance(value, Decimal):
        return economic_decimal_text(value)
    if value is None:
        return "null"
    return str(value).strip()


def _source_revision_id(source_id: object, economic_event_key: str) -> str:
    normalized_source_id = str(source_id).strip()
    digest = hashlib.sha256(economic_event_key.encode("utf-8")).hexdigest()[:32]
    return f"{normalized_source_id}:{digest}"


def execution_economic_event_key(execution: Execution) -> str:
    """Return the immutable economics key represented by an execution ref."""

    return "|".join(
        (
            "execution_fill",
            str(execution.id),
            _economic_text(execution.alpaca_account_label),
            _economic_text(execution.symbol),
            _economic_text(execution.side),
            _economic_text(execution.trade_decision_id),
            _economic_text(execution.alpaca_order_id),
            _economic_text(execution.client_order_id),
            economic_decimal_text(execution.filled_qty),
            economic_decimal_text(execution.avg_fill_price),
        )
    )


def execution_source_id(execution: Execution) -> str:
    return _source_revision_id(execution.id, execution_economic_event_key(execution))


def execution_tca_metric_economic_event_key(metric: ExecutionTCAMetric) -> str:
    """Return the immutable economics key represented by an execution TCA ref."""

    return "|".join(
        (
            "execution_tca_metric",
            str(metric.id),
            _economic_text(metric.execution_id),
            _economic_text(metric.trade_decision_id),
            _economic_text(metric.strategy_id),
            _economic_text(metric.alpaca_account_label),
            _economic_text(metric.symbol),
            _economic_text(metric.side),
            economic_decimal_text(metric.arrival_price),
            economic_decimal_text(metric.avg_fill_price),
            economic_decimal_text(metric.filled_qty),
            economic_decimal_text(metric.signed_qty),
            economic_decimal_text(metric.shortfall_notional),
            economic_decimal_text(metric.slippage_bps),
            economic_decimal_text(metric.realized_shortfall_bps),
            economic_decimal_text(metric.expected_shortfall_bps_p50),
            economic_decimal_text(metric.expected_shortfall_bps_p95),
            economic_decimal_text(metric.divergence_bps),
            economic_decimal_text(metric.churn_qty),
            economic_decimal_text(metric.churn_ratio),
            _economic_text(metric.simulator_version),
        )
    )


def execution_tca_metric_source_id(metric: ExecutionTCAMetric) -> str:
    return _source_revision_id(
        metric.id,
        execution_tca_metric_economic_event_key(metric),
    )


def submitted_pending_transfer_id(event: ExecutionOrderEvent) -> int:
    return stable_u128(
        "torghut.tigerbeetle.submitted_pending",
        submitted_pending_key(event),
    )


def event_transfer_id(event: ExecutionOrderEvent, transfer_kind: str) -> int:
    if transfer_kind == TRANSFER_KIND_SUBMITTED_PENDING:
        return submitted_pending_transfer_id(event)
    return stable_u128(
        "torghut.tigerbeetle.transfer",
        f"{event.event_fingerprint}:{transfer_kind}",
    )


def execution_transfer_id(execution: Execution) -> int:
    return stable_u128(
        "torghut.tigerbeetle.execution_fill",
        execution_economic_event_key(execution),
    )


def execution_cost_transfer_id(metric: ExecutionTCAMetric) -> int:
    return stable_u128(
        "torghut.tigerbeetle.execution_cost",
        execution_tca_metric_economic_event_key(metric),
    )


def runtime_ledger_transfer_id(bucket: StrategyRuntimeLedgerBucket) -> int:
    return stable_u128("torghut.tigerbeetle.runtime_ledger", str(bucket.id))


def runtime_ledger_amount_source(bucket: StrategyRuntimeLedgerBucket) -> Decimal:
    if bucket.net_strategy_pnl_after_costs != Decimal("0"):
        return Decimal(str(bucket.net_strategy_pnl_after_costs))
    if bucket.cost_amount != Decimal("0"):
        return -abs(Decimal(str(bucket.cost_amount)))
    return Decimal("0")


def order_event_account_specs(
    event: ExecutionOrderEvent,
) -> list[TigerBeetleAccountSpec]:
    account_label = event.alpaca_account_label
    symbol = event.symbol
    strategy_id = str(event.trade_decision_id) if event.trade_decision_id else None
    order_identity = (
        event.client_order_id or event.alpaca_order_id or event.event_fingerprint
    )
    specs = [
        TigerBeetleAccountSpec(
            account_id=account_id_for_key(f"cash:{account_label}:usd"),
            account_key=f"cash:{account_label}:usd",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_CASH_CONTROL,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=account_id_for_key(
                f"order_hold:{account_label}:{order_identity}"
            ),
            account_key=f"order_hold:{account_label}:{order_identity}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_ORDER_HOLD,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=account_id_for_key(
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
            account_id=account_id_for_key(
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
            account_id=account_id_for_key(
                f"realized_pnl:{account_label}:{strategy_id}"
            ),
            account_key=f"realized_pnl:{account_label}:{strategy_id}",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_REALIZED_PNL,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
    ]
    return specs


def evidence_account_specs(
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
            account_id=account_id_for_key(
                f"evidence_control:{normalized_account_label}:usd"
            ),
            account_key=f"evidence_control:{normalized_account_label}:usd",
            ledger=LEDGER_USD_MICRO,
            code=ACCOUNT_CODE_EVIDENCE_CONTROL,
            account_label=account_label,
            symbol=symbol,
            strategy_id=strategy_id,
        ),
        TigerBeetleAccountSpec(
            account_id=account_id_for_key(
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
            account_id=account_id_for_key(
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
            account_id=account_id_for_key(
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


def transfer_flag(flag_name: str) -> int:
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


def order_event_transfer_spec(
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
            flags=transfer_flag("PENDING"),
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
            flags=transfer_flag("VOID_PENDING_TRANSFER"),
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
        flags=transfer_flag("POST_PENDING_TRANSFER")
        if transfer_kind == TRANSFER_KIND_FILL_POST
        else 0,
    )


def pending_transfer_ref_for_event(
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
    prefer_pending_ref: bool = True,
) -> TigerBeetleOrderEventTransferPlan | None:
    transfer_kind = transfer_kind_for_event(event.event_type, event.status)
    if transfer_kind is None:
        return None

    pending_ref = (
        pending_transfer_ref_for_event(
            session,
            event,
            cluster_id=settings_obj.tigerbeetle_cluster_id,
        )
        if prefer_pending_ref
        and transfer_kind
        in {
            TRANSFER_KIND_FILL_POST,
            TRANSFER_KIND_CANCEL_VOID,
            TRANSFER_KIND_REJECT_VOID,
        }
        else None
    )
    amount_usd = event_amount_usd(event, transfer_kind, session=session)
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

    account_specs = tuple(order_event_account_specs(event))
    account_by_key = {spec.account_key: spec for spec in account_specs}
    use_pending_transfer = pending_ref is not None or transfer_kind in {
        TRANSFER_KIND_SUBMITTED_PENDING,
        TRANSFER_KIND_CANCEL_VOID,
        TRANSFER_KIND_REJECT_VOID,
    }
    transfer_spec = order_event_transfer_spec(
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


def persist_account_refs(
    session: Session,
    *,
    cluster_id: int,
    account_specs: Sequence[TigerBeetleAccountSpec],
) -> None:
    for spec in account_specs:
        account_id = u128_decimal(spec.account_id)
        existing = session.execute(
            select(TigerBeetleAccountRef).where(
                TigerBeetleAccountRef.cluster_id == cluster_id,
                or_(
                    TigerBeetleAccountRef.account_key == spec.account_key,
                    TigerBeetleAccountRef.account_id == account_id,
                ),
            )
        ).scalar_one_or_none()
        if existing is not None:
            if (
                existing.account_id != account_id
                or existing.account_key != spec.account_key
                or existing.ledger != spec.ledger
                or existing.code != spec.code
            ):
                raise RuntimeError("tigerbeetle_account_ref_conflict")
            continue

        try:
            with session.begin_nested():
                session.add(
                    TigerBeetleAccountRef(
                        cluster_id=cluster_id,
                        account_id=account_id,
                        account_key=spec.account_key,
                        ledger=spec.ledger,
                        code=spec.code,
                        account_label=spec.account_label,
                        symbol=spec.symbol,
                        strategy_id=spec.strategy_id,
                    )
                )
                session.flush()
        except IntegrityError:
            existing = session.execute(
                select(TigerBeetleAccountRef).where(
                    TigerBeetleAccountRef.cluster_id == cluster_id,
                    or_(
                        TigerBeetleAccountRef.account_key == spec.account_key,
                        TigerBeetleAccountRef.account_id == account_id,
                    ),
                )
            ).scalar_one_or_none()
            if existing is None:
                raise
            if (
                existing.account_id != account_id
                or existing.account_key != spec.account_key
                or existing.ledger != spec.ledger
                or existing.code != spec.code
            ):
                raise RuntimeError("tigerbeetle_account_ref_conflict") from None


def dedupe_account_specs(
    account_specs: Sequence[TigerBeetleAccountSpec],
) -> list[TigerBeetleAccountSpec]:
    by_key: dict[str, TigerBeetleAccountSpec] = {}
    by_id: dict[str, TigerBeetleAccountSpec] = {}
    ordered: list[TigerBeetleAccountSpec] = []
    for spec in account_specs:
        account_id = u128_decimal(spec.account_id)
        existing = by_key.get(spec.account_key) or by_id.get(account_id)
        if existing is not None:
            if (
                existing.account_id != spec.account_id
                or existing.account_key != spec.account_key
                or existing.ledger != spec.ledger
                or existing.code != spec.code
            ):
                raise RuntimeError("tigerbeetle_account_spec_conflict")
            continue
        by_key[spec.account_key] = spec
        by_id[account_id] = spec
        ordered.append(spec)
    return ordered


def transfer_matches(
    actual: object,
    expected: TigerBeetleTransferSpec,
) -> bool:
    return (
        int(transfer_attr(actual, "id")) == expected.transfer_id
        and int(transfer_attr(actual, "amount")) == expected.amount
        and int(transfer_attr(actual, "ledger")) == expected.ledger
        and int(transfer_attr(actual, "code")) == expected.code
        and int(transfer_attr(actual, "debit_account_id")) == expected.debit_account_id
        and int(transfer_attr(actual, "credit_account_id"))
        == expected.credit_account_id
    )


def transfer_ref_mismatches(
    ref: TigerBeetleTransferRef,
    expected: TigerBeetleTransferSpec,
) -> list[str]:
    mismatches: list[str] = []
    if ref.transfer_id != u128_decimal(expected.transfer_id):
        mismatches.append("transfer_id")
    if ref.transfer_kind != expected.transfer_kind:
        mismatches.append("transfer_kind")
    if ref.amount != Decimal(expected.amount):
        mismatches.append("amount")
    if ref.ledger != expected.ledger:
        mismatches.append("ledger")
    if ref.code != expected.code:
        mismatches.append("code")
    payload = nested_mapping(ref.payload_json)
    expected_debit = u128_decimal(expected.debit_account_id)
    expected_credit = u128_decimal(expected.credit_account_id)
    if payload.get("debit_account_id") not in {None, expected_debit}:
        mismatches.append("debit_account_id")
    if payload.get("credit_account_id") not in {None, expected_credit}:
        mismatches.append("credit_account_id")
    if expected.pending_id:
        expected_pending = u128_decimal(expected.pending_id)
        if payload.get("pending_id") not in {None, expected_pending}:
            mismatches.append("pending_id")
    return mismatches


def assert_transfer_ref_matches(
    ref: TigerBeetleTransferRef,
    expected: TigerBeetleTransferSpec,
) -> None:
    mismatches = transfer_ref_mismatches(ref, expected)
    if mismatches:
        raise RuntimeError(
            f"{TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT}:{','.join(mismatches)}"
        )


def find_transfer_ref(
    session: Session, key: TransferRefLookupKey
) -> TigerBeetleTransferRef | None:
    source_existing = session.execute(
        select(TigerBeetleTransferRef).where(
            TigerBeetleTransferRef.cluster_id == key.cluster_id,
            TigerBeetleTransferRef.source_type == key.source_type,
            TigerBeetleTransferRef.source_id == key.source_id,
            TigerBeetleTransferRef.transfer_kind == key.transfer_kind,
        )
    ).scalar_one_or_none()
    if source_existing is not None:
        return source_existing
    return session.execute(
        select(TigerBeetleTransferRef).where(
            TigerBeetleTransferRef.cluster_id == key.cluster_id,
            TigerBeetleTransferRef.transfer_id == key.transfer_id_text,
        )
    ).scalar_one_or_none()


def merge_existing_transfer_ref(
    session: Session,
    existing: TigerBeetleTransferRef,
    prepared: PreparedTigerBeetleTransferWrite,
    payload_json: Mapping[str, object],
) -> TigerBeetleTransferRef:
    transfer_spec = prepared.transfer_spec
    assert_transfer_ref_matches(existing, transfer_spec)
    if existing.trade_decision_id is None:
        existing.trade_decision_id = cast(Any, prepared.trade_decision_id)
    if existing.execution_id is None:
        existing.execution_id = cast(Any, prepared.execution_id)
    if existing.execution_order_event_id is None:
        existing.execution_order_event_id = cast(Any, prepared.execution_order_event_id)
    if existing.execution_tca_metric_id is None:
        existing.execution_tca_metric_id = cast(Any, prepared.execution_tca_metric_id)
    if existing.runtime_ledger_bucket_id is None:
        existing.runtime_ledger_bucket_id = cast(Any, prepared.runtime_ledger_bucket_id)
    if existing.source_type is None:
        existing.source_type = prepared.source_type
    if existing.source_id is None:
        existing.source_id = prepared.source_id
    if existing.event_fingerprint is None:
        existing.event_fingerprint = prepared.event_fingerprint
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


def source_transfer_spec(
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


def execution_notional_usd(execution: Execution) -> Decimal | None:
    if execution.avg_fill_price is None:
        return None
    amount = Decimal(str(execution.filled_qty)) * Decimal(str(execution.avg_fill_price))
    return abs(amount)
