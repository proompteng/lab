# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Idempotent Torghut order-event journal for TigerBeetle."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
import hashlib
import json
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
from app.trading.tigerbeetle_ids import stable_ref_u128, stable_u128, u128_decimal
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

# ruff: noqa: F401,F403,F405,F811,F821


SOURCE_TYPE_EXECUTION = "execution"

SOURCE_TYPE_EXECUTION_ORDER_EVENT = "execution_order_event"

SOURCE_TYPE_EXECUTION_TCA_METRIC = "execution_tca_metric"

SOURCE_TYPE_RUNTIME_LEDGER_BUCKET = "strategy_runtime_ledger_bucket"

TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_PARITY_SCHEMA_VERSION = (
    "torghut.tigerbeetle-runtime-ledger-journal-parity.v1"
)

TIGERBEETLE_STABLE_REF_SCHEMA_VERSION = "torghut.tigerbeetle-stable-ref.v1"

TIGERBEETLE_STABLE_REF_NAMESPACE = "torghut.tigerbeetle.journal_ref"

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


def _official_status_name(
    value: object,
    *,
    status_type_names: Sequence[str],
) -> str | None:
    if not isinstance(value, int):
        return None
    fallback_statuses = {46: "exists", 4294967295: "created"}
    try:
        import tigerbeetle as tb
    except Exception:
        return fallback_statuses.get(value)

    for status_type_name in status_type_names:
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


def _normalize_result_status(
    value: object,
    *,
    status_type_names: Sequence[str],
) -> str:
    official_name = _official_status_name(
        value,
        status_type_names=status_type_names,
    )
    if official_name is not None:
        return official_name
    return str(value or "").split(".")[-1].lower()


def _result_status(result: object, *, status_type_names: Sequence[str]) -> str:
    if isinstance(result, Mapping):
        result_mapping = cast(Mapping[str, object], result)
        return _normalize_result_status(
            result_mapping.get("status"),
            status_type_names=status_type_names,
        )
    return _normalize_result_status(
        getattr(result, "status", ""),
        status_type_names=status_type_names,
    )


def _result_index(result: object, fallback: int) -> int:
    if isinstance(result, Mapping):
        result_mapping = cast(Mapping[str, object], result)
        raw_index = result_mapping.get("index")
    else:
        raw_index = getattr(result, "index", None)
    if raw_index is None:
        return fallback
    try:
        return raw_index if isinstance(raw_index, int) else int(str(raw_index))
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"tigerbeetle_result_index_invalid:{raw_index}") from exc


def _result_statuses_by_index(
    results: Sequence[object],
    *,
    count: int,
    default_status: str,
    status_type_names: Sequence[str],
) -> dict[int, str]:
    statuses = {index: default_status for index in range(count)}
    for fallback_index, result in enumerate(results):
        index = _result_index(result, fallback_index)
        if index < 0 or index >= count:
            raise RuntimeError(f"tigerbeetle_result_index_out_of_range:{index}")
        statuses[index] = _result_status(
            result,
            status_type_names=status_type_names,
        )
    return statuses


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


def _stable_ref_source_signature(
    payload_json: Mapping[str, object],
    *,
    event_fingerprint: str | None = None,
) -> str | None:
    for key in (
        "source_economic_fingerprint",
        "runtime_key",
        "economic_event_key",
        "event_fingerprint",
    ):
        value = payload_json.get(key)
        text = str(value).strip() if value is not None else ""
        if text:
            if key == "economic_event_key":
                return hashlib.sha256(text.encode("utf-8")).hexdigest()
            return text
    return event_fingerprint


def _stable_ref_account_label(
    account_specs: Sequence[TigerBeetleAccountSpec],
    payload_json: Mapping[str, object],
) -> str | None:
    payload_account_label = str(payload_json.get("account_label") or "").strip()
    if payload_account_label:
        return payload_account_label
    for spec in account_specs:
        account_label = (spec.account_label or "").strip()
        if account_label:
            return account_label
    return None


def _payload_account_ids(
    payload_json: Mapping[str, object],
    account_specs: Sequence[TigerBeetleAccountSpec],
) -> list[str]:
    account_ids = [u128_decimal(spec.account_id) for spec in account_specs]
    raw_account_ids = payload_json.get("account_ids")
    if isinstance(raw_account_ids, Sequence) and not isinstance(
        raw_account_ids, (str, bytes, bytearray)
    ):
        for value in cast(Sequence[object], raw_account_ids):
            account_id = str(value).strip() if value is not None else ""
            if account_id and account_id not in account_ids:
                account_ids.append(account_id)
    for key in ("debit_account_id", "credit_account_id"):
        value = payload_json.get(key)
        account_id = str(value).strip() if value is not None else ""
        if account_id and account_id not in account_ids:
            account_ids.append(account_id)
    return sorted(account_ids)


def tigerbeetle_stable_ref_payload(
    *,
    cluster_id: int,
    account_specs: Sequence[TigerBeetleAccountSpec],
    transfer_spec: TigerBeetleTransferSpec,
    source_type: str,
    source_id: str,
    payload_json: Mapping[str, object],
    event_fingerprint: str | None = None,
) -> dict[str, object]:
    """Return a signed, deterministic audit-ref payload for a transfer ref.

    TigerBeetle transfer IDs are immutable once written. This stable ref is a
    source-backed audit handle that includes cluster/account/source/kind inputs
    without rewriting old transfer IDs or letting TigerBeetle become promotion
    authority.
    """

    account_label = _stable_ref_account_label(account_specs, payload_json)
    source_signature = _stable_ref_source_signature(
        payload_json,
        event_fingerprint=event_fingerprint,
    )
    components = {
        "cluster_id": int(cluster_id),
        "account_label": account_label or "unknown",
        "source_type": source_type,
        "source_id": source_id,
        "transfer_kind": transfer_spec.transfer_kind,
        "source_signature": source_signature or "none",
    }
    stable_ref_id = u128_decimal(
        stable_ref_u128(
            cluster_id=int(cluster_id),
            account_label=account_label,
            source_type=source_type,
            source_id=source_id,
            transfer_kind=transfer_spec.transfer_kind,
            source_signature=source_signature,
        )
    )
    stable_ref: dict[str, object] = {
        "schema_version": TIGERBEETLE_STABLE_REF_SCHEMA_VERSION,
        "derivation_namespace": TIGERBEETLE_STABLE_REF_NAMESPACE,
        "stable_ref_id": stable_ref_id,
        "components": components,
        "account_ids": _payload_account_ids(payload_json, account_specs),
        "account_keys": sorted({spec.account_key for spec in account_specs}),
        "transfer_id": u128_decimal(transfer_spec.transfer_id),
        "ledger": transfer_spec.ledger,
        "code": transfer_spec.code,
        "amount": str(transfer_spec.amount),
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
    }
    canonical = json.dumps(stable_ref, sort_keys=True, separators=(",", ":"))
    stable_ref["payload_hash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return {"stable_ref": stable_ref, "stable_ref_id": stable_ref_id}


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
    stable_ref_payload = _nested_mapping(transfer_payload.get("stable_ref"))
    stable_ref_id = str(stable_ref_payload.get("stable_ref_id") or "").strip()
    stable_refs = [stable_ref_payload] if stable_ref_id else []
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
            "stable_ref_count": len(stable_refs),
            "stable_ref_ids": [stable_ref_id] if stable_ref_id else [],
            "stable_refs": stable_refs,
            "source_refs": source_refs,
            "transfer": {
                "cluster_id": ref.cluster_id,
                "transfer_id": ref.transfer_id,
                "stable_ref_id": stable_ref_id or None,
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


@dataclass(frozen=True)
class _PreparedTigerBeetleTransferWrite:
    account_specs: tuple[TigerBeetleAccountSpec, ...]
    transfer_spec: TigerBeetleTransferSpec
    trade_decision_id: object | None
    execution_id: object | None
    execution_order_event_id: object | None
    execution_tca_metric_id: object | None
    runtime_ledger_bucket_id: object | None
    event_fingerprint: str | None
    source_type: str
    source_id: str
    payload_json: Mapping[str, object]


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


__all__ = [name for name in globals() if not name.startswith("__")]
