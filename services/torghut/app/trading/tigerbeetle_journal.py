"""Idempotent Torghut order-event journal for TigerBeetle."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
import hashlib
from types import TracebackType
from typing import Any, Self, cast

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
    PNL_DIRECTION_LOSS,
    PNL_DIRECTION_PROFIT,
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
TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_PARITY_SCHEMA_VERSION = (
    "torghut.tigerbeetle-runtime-ledger-journal-parity.v1"
)
TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS = "pass"
TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_NON_AUTHORITY_BLOCKED = (
    "non_authority_blocked"
)
TIGERBEETLE_BLOCKER_JOURNAL_DISABLED = "tigerbeetle_journal_disabled"
TIGERBEETLE_BLOCKER_JOURNAL_ENTRY_UNAVAILABLE = "tigerbeetle_journal_entry_unavailable"
TIGERBEETLE_BLOCKER_JOURNAL_ERROR = "tigerbeetle_journal_error"
TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT = "tigerbeetle_transfer_ref_conflict"
TIGERBEETLE_AUTHORITY_BLOCKER_ACCOUNTING_ONLY = (
    "tigerbeetle_accounting_parity_not_promotion_authority"
)
TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING = (
    "runtime_ledger_source_refs_missing"
)
TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING = (
    "runtime_ledger_source_window_refs_missing"
)


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


def _payload_text_list(value: object) -> list[str]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        items = cast(Sequence[object], value)
        return [text for item in items if (text := str(item).strip())]
    text = str(value).strip() if value is not None else ""
    return [text] if text else []


def runtime_ledger_bucket_source_authority_blockers(
    bucket: StrategyRuntimeLedgerBucket,
) -> list[str]:
    """Return source-window blockers that keep TigerBeetle parity non-authoritative.

    TigerBeetle is a deterministic double-entry accounting mirror. Runtime-ledger
    source rows and source-window refs remain the promotion authority for honest
    PnL proof, so the journal records explicitly carry blockers when that source
    context is not present on the persisted bucket payload.
    """

    payload = _nested_mapping(bucket.payload_json)
    source_refs = [
        source_ref
        for source_ref in [
            *(_payload_text_list(payload.get("source_refs"))),
            *(_payload_text_list(payload.get("runtime_ledger_source_refs"))),
        ]
        if "tigerbeetle" not in source_ref
        and "strategy_runtime_ledger_buckets" not in source_ref
    ]
    source_row_counts = _nested_mapping(payload.get("source_row_counts"))
    source_window_refs = [
        *(_payload_text_list(payload.get("source_window_refs"))),
        *(_payload_text_list(payload.get("runtime_ledger_source_window_refs"))),
        *(_payload_text_list(payload.get("source_window_id"))),
    ]
    has_source_rows = bool(source_refs) or any(
        _positive_payload_count(value)
        for key, value in source_row_counts.items()
        if str(key).startswith(
            (
                "execution",
                "runtime_ledger",
                "strategy_runtime",
                "trade_decision",
            )
        )
    )
    blockers = [TIGERBEETLE_AUTHORITY_BLOCKER_ACCOUNTING_ONLY]
    if not has_source_rows:
        blockers.append(
            TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_REFS_MISSING
        )
    if not source_window_refs:
        blockers.append(
            TIGERBEETLE_AUTHORITY_BLOCKER_RUNTIME_LEDGER_SOURCE_WINDOW_REFS_MISSING
        )
    return blockers


def _positive_payload_count(value: object) -> bool:
    try:
        return Decimal(str(value or "0")) > 0
    except Exception:
        return False


def tigerbeetle_runtime_ledger_journal_payload(
    *,
    bucket: StrategyRuntimeLedgerBucket,
    ref: TigerBeetleTransferRef | None,
    status: str,
    blockers: Sequence[str] = (),
    account_refs: Sequence[TigerBeetleAccountRef] = (),
    error: str | None = None,
) -> dict[str, object]:
    """Build stable bucket metadata for TigerBeetle journal parity.

    The payload is intentionally explicit that TigerBeetle is not the final
    promotion authority. It gives proof assemblers durable refs when present and
    gives readiness checks deterministic non-authority blockers when journaling is
    disabled, skipped, or degraded.
    """

    account_ids: list[str] = []
    transfer_ids: list[str] = []
    source_refs = [f"postgres:strategy_runtime_ledger_buckets:{bucket.id}"]
    cluster_ids: list[int] = []
    transfer_payload: Mapping[str, object] = {}
    if ref is not None:
        transfer_ids.append(ref.transfer_id)
        source_refs.append(f"postgres:tigerbeetle_transfer_refs:{ref.id}")
        cluster_ids.append(ref.cluster_id)
        transfer_payload = _nested_mapping(ref.payload_json)
        for key in ("debit_account_id", "credit_account_id"):
            raw_account_id = transfer_payload.get(key)
            if raw_account_id is not None:
                account_id = str(raw_account_id)
                if account_id not in account_ids:
                    account_ids.append(account_id)
    for account_ref in account_refs:
        if account_ref.account_id not in account_ids:
            account_ids.append(account_ref.account_id)
        if account_ref.cluster_id not in cluster_ids:
            cluster_ids.append(account_ref.cluster_id)

    return coerce_json_payload(
        {
            "schema_version": (
                TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_PARITY_SCHEMA_VERSION
            ),
            "status": status,
            "journal_record_available": ref is not None,
            "authority": "accounting_parity_only",
            "promotion_authority": False,
            "overrides_runtime_ledger_authority": False,
            "blockers": sorted({str(item) for item in blockers if str(item)}),
            "authority_blockers": runtime_ledger_bucket_source_authority_blockers(
                bucket
            ),
            "error": error,
            "runtime_ledger_bucket_id": str(bucket.id),
            "cluster_ids": sorted(cluster_ids),
            "account_count": len(account_refs),
            "account_ids": sorted(account_ids),
            "account_keys": sorted({row.account_key for row in account_refs}),
            "transfer_count": len(transfer_ids),
            "transfer_ids": sorted(transfer_ids),
            "source_refs": source_refs,
            "transfer": {
                "cluster_id": ref.cluster_id,
                "transfer_id": ref.transfer_id,
                "transfer_kind": ref.transfer_kind,
                "ledger": ref.ledger,
                "code": ref.code,
                "amount": str(ref.amount),
                "status": ref.status,
                "debit_account_id": transfer_payload.get("debit_account_id"),
                "credit_account_id": transfer_payload.get("credit_account_id"),
            }
            if ref is not None
            else None,
        }
    )


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


@dataclass(frozen=True)
class TigerBeetleRuntimeLedgerTransferPlan:
    account_specs: tuple[TigerBeetleAccountSpec, ...]
    transfer_spec: TigerBeetleTransferSpec
    amount_source: Decimal
    signed_amount_micros: int
    pnl_direction: str
    runtime_key: str


@dataclass(frozen=True)
class TigerBeetleSourceTransferPlan:
    account_specs: tuple[TigerBeetleAccountSpec, ...]
    transfer_spec: TigerBeetleTransferSpec
    amount_source: Decimal


def _submitted_pending_key(event: ExecutionOrderEvent) -> str:
    source_id = (
        str(event.execution_id)
        if event.execution_id is not None
        else event.client_order_id or event.alpaca_order_id or event.event_fingerprint
    )
    return f"{event.alpaca_account_label}:{source_id}"


def _economic_decimal_text(value: object) -> str:
    if value is None:
        return "null"
    return format(Decimal(str(value)).normalize(), "f")


def _economic_text(value: object) -> str:
    if isinstance(value, Decimal):
        return _economic_decimal_text(value)
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
            _economic_decimal_text(execution.filled_qty),
            _economic_decimal_text(execution.avg_fill_price),
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
            _economic_decimal_text(metric.arrival_price),
            _economic_decimal_text(metric.avg_fill_price),
            _economic_decimal_text(metric.filled_qty),
            _economic_decimal_text(metric.signed_qty),
            _economic_decimal_text(metric.shortfall_notional),
            _economic_decimal_text(metric.slippage_bps),
            _economic_decimal_text(metric.realized_shortfall_bps),
            _economic_decimal_text(metric.expected_shortfall_bps_p50),
            _economic_decimal_text(metric.expected_shortfall_bps_p95),
            _economic_decimal_text(metric.divergence_bps),
            _economic_decimal_text(metric.churn_qty),
            _economic_decimal_text(metric.churn_ratio),
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
    prefer_pending_ref: bool = True,
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
        if prefer_pending_ref
        and transfer_kind
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


def _transfer_ref_mismatches(
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
    payload = _nested_mapping(ref.payload_json)
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


def _assert_transfer_ref_matches(
    ref: TigerBeetleTransferRef,
    expected: TigerBeetleTransferSpec,
) -> None:
    mismatches = _transfer_ref_mismatches(ref, expected)
    if mismatches:
        raise RuntimeError(
            f"{TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT}:{','.join(mismatches)}"
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


def build_runtime_ledger_bucket_transfer_plan(
    bucket: StrategyRuntimeLedgerBucket,
) -> TigerBeetleRuntimeLedgerTransferPlan | None:
    amount_source = runtime_ledger_amount_source(bucket)
    amount = _amount_to_micros(amount_source)
    if amount is None:
        return None
    runtime_key = (
        f"{bucket.hypothesis_id}:{bucket.run_id}:{bucket.bucket_started_at.isoformat()}"
    )
    account_specs = tuple(
        _evidence_account_specs(
            account_label=bucket.account_label,
            symbol=None,
            strategy_id=bucket.hypothesis_id,
            runtime_key=runtime_key,
        )
    )
    account_label = bucket.account_label or "unknown"
    accounts = {spec.account_key: spec for spec in account_specs}
    control = accounts[f"evidence_control:{account_label}:usd"]
    runtime_account = accounts[f"runtime_ledger:{account_label}:{runtime_key}"]
    pnl_direction = PNL_DIRECTION_PROFIT if amount_source > 0 else PNL_DIRECTION_LOSS
    debit = control if pnl_direction == PNL_DIRECTION_PROFIT else runtime_account
    credit = runtime_account if pnl_direction == PNL_DIRECTION_PROFIT else control
    return TigerBeetleRuntimeLedgerTransferPlan(
        account_specs=account_specs,
        transfer_spec=_source_transfer_spec(
            transfer_id=runtime_ledger_transfer_id(bucket),
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            amount=amount,
            debit=debit,
            credit=credit,
        ),
        amount_source=amount_source,
        signed_amount_micros=amount if amount_source > 0 else -amount,
        pnl_direction=pnl_direction,
        runtime_key=runtime_key,
    )


def build_execution_transfer_plan(
    execution: Execution,
) -> TigerBeetleSourceTransferPlan | None:
    amount_source = _execution_notional_usd(execution)
    amount = _amount_to_micros(amount_source)
    if amount is None or amount_source is None:
        return None
    strategy_id = (
        str(execution.trade_decision_id) if execution.trade_decision_id else None
    )
    account_specs = tuple(
        _evidence_account_specs(
            account_label=execution.alpaca_account_label,
            symbol=execution.symbol,
            strategy_id=strategy_id,
        )
    )
    accounts = {spec.account_key: spec for spec in account_specs}
    control = accounts[f"evidence_control:{execution.alpaca_account_label}:usd"]
    execution_account = accounts[
        f"execution_evidence:{execution.alpaca_account_label}:{execution.symbol}:{strategy_id or 'unknown'}"
    ]
    return TigerBeetleSourceTransferPlan(
        account_specs=account_specs,
        transfer_spec=_source_transfer_spec(
            transfer_id=execution_transfer_id(execution),
            transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
            amount=amount,
            debit=control,
            credit=execution_account,
        ),
        amount_source=amount_source,
    )


def build_execution_tca_metric_transfer_plan(
    metric: ExecutionTCAMetric,
) -> TigerBeetleSourceTransferPlan | None:
    amount_source = metric.shortfall_notional
    amount = _amount_to_micros(amount_source)
    if amount is None or amount_source is None:
        return None
    strategy_id = str(metric.strategy_id) if metric.strategy_id else None
    account_specs = tuple(
        _evidence_account_specs(
            account_label=metric.alpaca_account_label,
            symbol=metric.symbol,
            strategy_id=strategy_id,
        )
    )
    account_label = metric.alpaca_account_label or "unknown"
    accounts = {spec.account_key: spec for spec in account_specs}
    control = accounts[f"evidence_control:{account_label}:usd"]
    cost_account = accounts[
        f"execution_cost:{account_label}:{metric.symbol}:{strategy_id or 'unknown'}"
    ]
    return TigerBeetleSourceTransferPlan(
        account_specs=account_specs,
        transfer_spec=_source_transfer_spec(
            transfer_id=execution_cost_transfer_id(metric),
            transfer_kind=TRANSFER_KIND_EXECUTION_COST,
            amount=amount,
            debit=control,
            credit=cost_account,
        ),
        amount_source=amount_source,
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
        source_existing = session.execute(
            select(TigerBeetleTransferRef).where(
                TigerBeetleTransferRef.cluster_id
                == self._settings.tigerbeetle_cluster_id,
                TigerBeetleTransferRef.source_type == source_type,
                TigerBeetleTransferRef.source_id == source_id,
                TigerBeetleTransferRef.transfer_kind == transfer_spec.transfer_kind,
            )
        ).scalar_one_or_none()
        if source_existing is not None:
            _assert_transfer_ref_matches(source_existing, transfer_spec)
            existing = source_existing
        else:
            existing = session.execute(
                select(TigerBeetleTransferRef).where(
                    TigerBeetleTransferRef.cluster_id
                    == self._settings.tigerbeetle_cluster_id,
                    TigerBeetleTransferRef.transfer_id == transfer_id_text,
                )
            ).scalar_one_or_none()
        if existing is not None:
            _assert_transfer_ref_matches(existing, transfer_spec)
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
        plan = build_execution_transfer_plan(execution)
        if plan is None:
            return None
        transfer_spec = plan.transfer_spec
        return self._persist_transfer(
            session,
            account_specs=plan.account_specs,
            transfer_spec=transfer_spec,
            trade_decision_id=execution.trade_decision_id,
            execution_id=execution.id,
            source_type=SOURCE_TYPE_EXECUTION,
            source_id=str(execution.id),
            payload_json={
                "source": SOURCE_TYPE_EXECUTION,
                "source_refs": [
                    f"postgres:executions:{execution.id}",
                ],
                "source_row_id": str(execution.id),
                "source_economic_fingerprint": execution_source_id(execution).split(
                    ":", 1
                )[1],
                "economic_event_key": execution_economic_event_key(execution),
                "alpaca_order_id": execution.alpaca_order_id,
                "client_order_id": execution.client_order_id,
                "filled_qty": str(execution.filled_qty),
                "avg_fill_price": str(execution.avg_fill_price),
                "amount_source": str(plan.amount_source),
                "notional_micros": transfer_spec.amount,
                "transfer_id": u128_decimal(transfer_spec.transfer_id),
                "ledger": transfer_spec.ledger,
                "code": transfer_spec.code,
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
        plan = build_execution_tca_metric_transfer_plan(metric)
        if plan is None:
            return None
        transfer_spec = plan.transfer_spec
        return self._persist_transfer(
            session,
            account_specs=plan.account_specs,
            transfer_spec=transfer_spec,
            trade_decision_id=metric.trade_decision_id,
            execution_id=metric.execution_id,
            execution_tca_metric_id=metric.id,
            source_type=SOURCE_TYPE_EXECUTION_TCA_METRIC,
            source_id=execution_tca_metric_source_id(metric),
            payload_json={
                "source": SOURCE_TYPE_EXECUTION_TCA_METRIC,
                "source_refs": [
                    f"postgres:execution_tca_metrics:{metric.id}",
                    f"postgres:executions:{metric.execution_id}",
                ],
                "source_row_id": str(metric.id),
                "source_economic_fingerprint": execution_tca_metric_source_id(
                    metric
                ).split(":", 1)[1],
                "economic_event_key": execution_tca_metric_economic_event_key(metric),
                "shortfall_notional": str(metric.shortfall_notional),
                "realized_shortfall_bps": str(metric.realized_shortfall_bps),
                "simulator_version": metric.simulator_version,
                "amount_source": str(plan.amount_source),
                "cost_micros": transfer_spec.amount,
                "transfer_id": u128_decimal(transfer_spec.transfer_id),
                "ledger": transfer_spec.ledger,
                "code": transfer_spec.code,
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
        plan = build_runtime_ledger_bucket_transfer_plan(bucket)
        if plan is None:
            return None
        transfer_spec = plan.transfer_spec
        return self._persist_transfer(
            session,
            account_specs=plan.account_specs,
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
                "amount_source": str(plan.amount_source),
                "amount_micros": transfer_spec.amount,
                "signed_amount_micros": plan.signed_amount_micros,
                "pnl_direction": plan.pnl_direction,
                "runtime_key": plan.runtime_key,
                "debit_account_id": u128_decimal(transfer_spec.debit_account_id),
                "credit_account_id": u128_decimal(transfer_spec.credit_account_id),
            },
        )
