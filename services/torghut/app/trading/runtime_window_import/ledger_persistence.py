"""Import observed runtime windows into the hypothesis governance ledger."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from ...config import settings
from ...models import (
    StrategyRuntimeLedgerBucket,
    TigerBeetleAccountRef,
    TigerBeetleTransferRef,
)
from ..tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_DISABLED,
    TIGERBEETLE_BLOCKER_JOURNAL_ENTRY_UNAVAILABLE,
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_NON_AUTHORITY_BLOCKED,
    TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
    TigerBeetleLedgerJournal,
    tigerbeetle_runtime_ledger_journal_payload,
)

from .common import (
    ObservedRuntimeBucket,
    US_EQUITIES_REGULAR_TIMEZONE,
    mapping_payload,
    observation_int,
    optional_decimal,
    parse_observation_datetime,
    runtime_ledger_bucket_blockers,
    string_list,
    text_value,
    utc_datetime,
    logger,
)
from .observed_buckets import runtime_ledger_bucket_payloads


@dataclass(frozen=True)
class RuntimeLedgerBucketDeleteRequest:
    session: Session
    run_id: str
    candidate_id: str | None
    hypothesis_id: str
    observed_stage: str
    replacement_scopes: Sequence[tuple[datetime, datetime, str | None, str | None]]


@dataclass(frozen=True)
class TigerBeetleJournalMark:
    ref: TigerBeetleTransferRef | None
    status: str
    blockers: Sequence[str]
    error: str | None = None


def _empty_cluster_ids() -> set[int]:
    return set()


@dataclass(frozen=True)
class _TigerBeetleRowRefs:
    bucket_id: str
    account_ids: list[str]
    account_keys: list[str]
    transfer_ids: list[str]
    missing_account_ids: list[str]
    source_refs: list[str]
    cluster_ids: set[int] = field(default_factory=_empty_cluster_ids)


def runtime_ledger_bucket_replacement_scopes(
    *,
    buckets: Sequence[ObservedRuntimeBucket],
    runtime_payload: Mapping[str, Any],
) -> list[tuple[datetime, datetime, str | None, str | None]]:
    scopes: list[tuple[datetime, datetime, str | None, str | None]] = []
    seen: set[tuple[datetime, datetime, str | None, str | None]] = set()

    def add_scope(
        *,
        started_at: datetime,
        ended_at: datetime,
        account_label: str | None,
        runtime_strategy_name: str | None,
    ) -> None:
        if ended_at <= started_at:
            return
        scope = (started_at, ended_at, account_label, runtime_strategy_name)
        if scope not in seen:
            seen.add(scope)
            scopes.append(scope)

    for bucket in buckets:
        for ledger_payload in runtime_ledger_bucket_payloads(bucket.payload_json):
            bucket_started_at = (
                parse_observation_datetime(ledger_payload.get("bucket_started_at"))
                or bucket.window_started_at
            )
            bucket_ended_at = (
                parse_observation_datetime(ledger_payload.get("bucket_ended_at"))
                or bucket.window_ended_at
            )
            account_label = text_value(
                ledger_payload.get("account_label")
            ) or text_value(runtime_payload.get("account_label"))
            runtime_strategy_name = text_value(
                ledger_payload.get("strategy_id")
            ) or text_value(runtime_payload.get("strategy_name"))
            add_scope(
                started_at=bucket_started_at,
                ended_at=bucket_ended_at,
                account_label=account_label,
                runtime_strategy_name=runtime_strategy_name,
            )
            source_window_started_at = parse_observation_datetime(
                ledger_payload.get("source_window_start")
            )
            source_window_ended_at = parse_observation_datetime(
                ledger_payload.get("source_window_end")
            )
            if (
                source_window_started_at is not None
                and source_window_ended_at is not None
            ):
                add_scope(
                    started_at=source_window_started_at,
                    ended_at=source_window_ended_at,
                    account_label=account_label,
                    runtime_strategy_name=runtime_strategy_name,
                )
    return scopes


def _runtime_ledger_replacement_overlap_predicates(
    replacement_scopes: Sequence[tuple[datetime, datetime, str | None, str | None]],
) -> list[ColumnElement[bool]]:
    overlap_predicates = [
        and_(
            StrategyRuntimeLedgerBucket.bucket_started_at < bucket_ended_at,
            StrategyRuntimeLedgerBucket.bucket_ended_at > bucket_started_at,
            StrategyRuntimeLedgerBucket.account_label == account_label,
            StrategyRuntimeLedgerBucket.runtime_strategy_name == runtime_strategy_name,
        )
        for (
            bucket_started_at,
            bucket_ended_at,
            account_label,
            runtime_strategy_name,
        ) in replacement_scopes
    ]
    return overlap_predicates


def _delete_runtime_ledger_buckets(
    request: RuntimeLedgerBucketDeleteRequest,
    *,
    current_run: bool,
) -> int:
    if not request.replacement_scopes:
        return 0
    run_predicate = (
        StrategyRuntimeLedgerBucket.run_id == request.run_id
        if current_run
        else StrategyRuntimeLedgerBucket.run_id != request.run_id
    )
    overlap_predicates = _runtime_ledger_replacement_overlap_predicates(
        request.replacement_scopes
    )
    result = request.session.execute(
        delete(StrategyRuntimeLedgerBucket).where(
            run_predicate,
            StrategyRuntimeLedgerBucket.candidate_id == request.candidate_id,
            StrategyRuntimeLedgerBucket.hypothesis_id == request.hypothesis_id,
            StrategyRuntimeLedgerBucket.observed_stage == request.observed_stage,
            or_(*overlap_predicates),
        )
    )
    return int(getattr(result, "rowcount", 0) or 0)


def delete_current_runtime_ledger_buckets(
    request: RuntimeLedgerBucketDeleteRequest,
) -> int:
    return _delete_runtime_ledger_buckets(request, current_run=True)


def delete_replaced_runtime_ledger_buckets(
    request: RuntimeLedgerBucketDeleteRequest,
) -> int:
    return _delete_runtime_ledger_buckets(request, current_run=False)


def runtime_ledger_post_cost_from_observed_buckets(
    buckets: Sequence[ObservedRuntimeBucket],
) -> tuple[Decimal | None, Decimal, Decimal, int]:
    total_net = Decimal("0")
    total_notional = Decimal("0")
    sample_count = 0
    for bucket in buckets:
        for ledger_payload in runtime_ledger_bucket_payloads(bucket.payload_json):
            if runtime_ledger_bucket_blockers(ledger_payload):
                continue
            net_pnl = optional_decimal(
                ledger_payload.get("net_strategy_pnl_after_costs")
            )
            filled_notional = optional_decimal(ledger_payload.get("filled_notional"))
            if net_pnl is None or filled_notional is None or filled_notional <= 0:
                continue
            total_net += net_pnl
            total_notional += filled_notional
            sample_count += 1
    if sample_count <= 0 or total_notional <= 0:
        return None, total_net, total_notional, sample_count
    return (
        (total_net / total_notional) * Decimal("10000"),
        total_net,
        total_notional,
        sample_count,
    )


def runtime_ledger_trading_day_key(dt: datetime) -> str:
    return (
        utc_datetime(dt)
        .astimezone(ZoneInfo(US_EQUITIES_REGULAR_TIMEZONE))
        .date()
        .isoformat()
    )


def median_decimal(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    sorted_values = sorted(values)
    middle = len(sorted_values) // 2
    if len(sorted_values) % 2:
        return sorted_values[middle]
    return (sorted_values[middle - 1] + sorted_values[middle]) / Decimal("2")


def p10_decimal(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    sorted_values = sorted(values)
    index = max(0, ((len(sorted_values) + 9) // 10) - 1)
    return sorted_values[index]


_RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS = (
    "account_equity",
    "portfolio_equity",
    "start_equity",
    "starting_equity",
    "equity",
    "portfolio_value",
    "net_liquidation",
    "net_liquidation_value",
)

_RUNTIME_LEDGER_SYMBOL_KEYS = ("symbol", "ticker")

_RUNTIME_LEDGER_SYMBOL_PNL_KEYS = (
    "net_pnl_by_symbol",
    "symbol_net_pnl_after_costs",
    "net_strategy_pnl_after_costs_by_symbol",
)


def runtime_ledger_equity_denominator(
    bucket: Mapping[str, Any],
) -> tuple[Decimal, str] | None:
    for key in _RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS:
        value = optional_decimal(bucket.get(key))
        if value is not None and value > 0:
            return value, key
    return None


def _runtime_ledger_symbol(bucket: Mapping[str, Any]) -> str | None:
    for key in _RUNTIME_LEDGER_SYMBOL_KEYS:
        symbol = text_value(bucket.get(key))
        if symbol is not None:
            return symbol.upper()
    return None


def runtime_ledger_symbol_pnl_items(
    bucket: Mapping[str, Any],
    *,
    net_pnl: Decimal | None,
) -> list[tuple[str, Decimal]]:
    for key in _RUNTIME_LEDGER_SYMBOL_PNL_KEYS:
        raw_mapping = bucket.get(key)
        if not isinstance(raw_mapping, Mapping):
            continue
        items: list[tuple[str, Decimal]] = []
        for raw_symbol, raw_pnl in cast(Mapping[object, object], raw_mapping).items():
            symbol = str(raw_symbol).strip().upper()
            pnl = optional_decimal(raw_pnl)
            if symbol and pnl is not None:
                items.append((symbol, pnl))
        if items:
            return items

    symbol = _runtime_ledger_symbol(bucket)
    if symbol is None or net_pnl is None:
        return []
    return [(symbol, net_pnl)]


def _uuid_values(values: Sequence[str]) -> list[UUID]:
    uuids: list[UUID] = []
    for value in values:
        try:
            uuids.append(UUID(value))
        except ValueError:
            continue
    return uuids


def _tigerbeetle_transfer_account_ids(row: TigerBeetleTransferRef) -> list[str]:
    payload = mapping_payload(row.payload_json)
    account_ids: list[str] = []
    for key in ("debit_account_id", "credit_account_id"):
        account_id = text_value(payload.get(key))
        if account_id is not None:
            account_ids.append(account_id)
    return account_ids


def _tigerbeetle_account_refs_for_ids(
    *,
    session: Session,
    cluster_ids: Sequence[int],
    account_ids: Sequence[str],
) -> list[TigerBeetleAccountRef]:
    if not cluster_ids or not account_ids:
        return []
    return list(
        session.execute(
            select(TigerBeetleAccountRef)
            .where(
                TigerBeetleAccountRef.cluster_id.in_(cluster_ids),
                TigerBeetleAccountRef.account_id.in_(account_ids),
            )
            .order_by(
                TigerBeetleAccountRef.cluster_id.asc(),
                TigerBeetleAccountRef.account_key.asc(),
            )
        )
        .scalars()
        .all()
    )


def _tigerbeetle_account_refs_for_transfer_ref(
    session: Session,
    ref: TigerBeetleTransferRef,
) -> list[TigerBeetleAccountRef]:
    return _tigerbeetle_account_refs_for_ids(
        session=session,
        cluster_ids=[ref.cluster_id],
        account_ids=_tigerbeetle_transfer_account_ids(ref),
    )


def _tigerbeetle_refs_for_ledger_payload(
    session: Session,
    ledger_payload: Mapping[str, Any],
) -> dict[str, Any]:
    event_ids = _uuid_values(
        [
            *string_list(ledger_payload.get("execution_order_event_ids")),
            *string_list(
                ledger_payload.get("runtime_ledger_execution_order_event_ids")
            ),
        ]
    )
    event_fingerprints = [
        *string_list(ledger_payload.get("execution_order_event_fingerprints")),
        *string_list(ledger_payload.get("event_fingerprints")),
    ]
    predicates: list[ColumnElement[bool]] = []
    if event_ids:
        predicates.append(
            cast(
                ColumnElement[bool],
                TigerBeetleTransferRef.execution_order_event_id.in_(event_ids),
            )
        )
    if event_fingerprints:
        predicates.append(
            cast(
                ColumnElement[bool],
                TigerBeetleTransferRef.event_fingerprint.in_(event_fingerprints),
            )
        )
    if not predicates:
        return {}

    rows = (
        session.execute(
            select(TigerBeetleTransferRef)
            .where(or_(*predicates))
            .order_by(TigerBeetleTransferRef.created_at.asc())
        )
        .scalars()
        .all()
    )
    if not rows:
        return {}
    account_ids = sorted(
        {
            account_id
            for row in rows
            for account_id in _tigerbeetle_transfer_account_ids(row)
        }
    )
    account_rows = _tigerbeetle_account_refs_for_ids(
        session=session,
        cluster_ids=sorted({row.cluster_id for row in rows}),
        account_ids=account_ids,
    )
    account_ref_keys = {(row.cluster_id, row.account_id) for row in account_rows}
    missing_account_ids = sorted(
        {
            account_id
            for row in rows
            for account_id in _tigerbeetle_transfer_account_ids(row)
            if (row.cluster_id, account_id) not in account_ref_keys
        }
    )
    return {
        "schema_version": "torghut.tigerbeetle-ledger-refs.v1",
        "cluster_ids": sorted({row.cluster_id for row in rows}),
        "account_count": len(account_rows),
        "account_ids": sorted({row.account_id for row in account_rows}),
        "account_keys": sorted({row.account_key for row in account_rows}),
        "accounts": [
            {
                "cluster_id": row.cluster_id,
                "account_id": row.account_id,
                "account_key": row.account_key,
                "ledger": row.ledger,
                "code": row.code,
                "account_label": row.account_label,
                "symbol": row.symbol,
                "strategy_id": row.strategy_id,
            }
            for row in account_rows
        ],
        "missing_account_ids": missing_account_ids,
        "transfer_count": len(rows),
        "transfer_ids": sorted({row.transfer_id for row in rows}),
        "transfers": [
            {
                "cluster_id": row.cluster_id,
                "transfer_id": row.transfer_id,
                "transfer_kind": row.transfer_kind,
                "ledger": row.ledger,
                "code": row.code,
                "amount": str(row.amount),
                "status": row.status,
                "execution_order_event_id": str(row.execution_order_event_id)
                if row.execution_order_event_id
                else None,
                "event_fingerprint": row.event_fingerprint,
            }
            for row in rows
        ],
    }


def ledger_payload_with_tigerbeetle_refs(
    session: Session,
    ledger_payload: dict[str, Any],
) -> dict[str, Any]:
    tigerbeetle_refs = _tigerbeetle_refs_for_ledger_payload(session, ledger_payload)
    if not tigerbeetle_refs:
        return ledger_payload
    source_refs = string_list(ledger_payload.get("source_refs"))
    if "postgres:tigerbeetle_transfer_refs" not in source_refs:
        source_refs.append("postgres:tigerbeetle_transfer_refs")
    source_row_counts = mapping_payload(ledger_payload.get("source_row_counts"))
    source_row_counts["tigerbeetle_transfer_refs"] = tigerbeetle_refs["transfer_count"]
    if tigerbeetle_refs.get("account_count"):
        if "postgres:tigerbeetle_account_refs" not in source_refs:
            source_refs.append("postgres:tigerbeetle_account_refs")
        source_row_counts["tigerbeetle_account_refs"] = tigerbeetle_refs[
            "account_count"
        ]
    return {
        **ledger_payload,
        "source_refs": source_refs,
        "source_row_counts": source_row_counts,
        "tigerbeetle": tigerbeetle_refs,
        "tigerbeetle_account_ids": tigerbeetle_refs["account_ids"],
        "tigerbeetle_account_keys": tigerbeetle_refs["account_keys"],
        "tigerbeetle_transfer_ids": tigerbeetle_refs["transfer_ids"],
    }


def _extend_unique(target: list[str], values: Sequence[str]) -> None:
    for value in values:
        if value not in target:
            target.append(value)


def _sequence_items(value: Any) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _tigerbeetle_row_refs(
    row: StrategyRuntimeLedgerBucket,
) -> _TigerBeetleRowRefs | None:
    payload = mapping_payload(row.payload_json)
    refs = mapping_payload(payload.get("tigerbeetle"))
    account_ids = string_list(
        refs.get("account_ids") or payload.get("tigerbeetle_account_ids")
    )
    account_keys = string_list(
        refs.get("account_keys") or payload.get("tigerbeetle_account_keys")
    )
    transfer_ids = string_list(
        refs.get("transfer_ids") or payload.get("tigerbeetle_transfer_ids")
    )
    if not account_ids and not account_keys and not transfer_ids:
        return None
    cluster_ids = {
        value
        for value in (
            observation_int(item) for item in _sequence_items(refs.get("cluster_ids"))
        )
        if value > 0
    }
    return _TigerBeetleRowRefs(
        bucket_id=str(row.id),
        account_ids=account_ids,
        account_keys=account_keys,
        transfer_ids=transfer_ids,
        missing_account_ids=string_list(refs.get("missing_account_ids")),
        source_refs=string_list(payload.get("source_refs")),
        cluster_ids=cluster_ids,
    )


def _tigerbeetle_bucket_ref_payload(refs: _TigerBeetleRowRefs) -> dict[str, Any]:
    return {
        "runtime_ledger_bucket_id": refs.bucket_id,
        "account_ids": refs.account_ids,
        "account_keys": refs.account_keys,
        "transfer_ids": refs.transfer_ids,
        "missing_account_ids": refs.missing_account_ids,
    }


def runtime_ledger_tigerbeetle_proof_refs(
    rows: Sequence[StrategyRuntimeLedgerBucket],
) -> dict[str, Any]:
    if not rows:
        return {}
    account_ids: list[str] = []
    account_keys: list[str] = []
    transfer_ids: list[str] = []
    source_refs: list[str] = []
    missing_account_ids: list[str] = []
    buckets: list[dict[str, Any]] = []
    cluster_ids: set[int] = set()

    for row in rows:
        row_refs = _tigerbeetle_row_refs(row)
        if row_refs is None:
            continue
        cluster_ids.update(row_refs.cluster_ids)
        _extend_unique(account_ids, row_refs.account_ids)
        _extend_unique(account_keys, row_refs.account_keys)
        _extend_unique(transfer_ids, row_refs.transfer_ids)
        _extend_unique(missing_account_ids, row_refs.missing_account_ids)
        _extend_unique(source_refs, row_refs.source_refs)
        buckets.append(_tigerbeetle_bucket_ref_payload(row_refs))

    if not account_ids and not account_keys and not transfer_ids:
        return {}
    return {
        "schema_version": "torghut.tigerbeetle-runtime-ledger-proof-refs.v1",
        "cluster_ids": sorted(cluster_ids),
        "account_count": len(account_ids),
        "transfer_count": len(transfer_ids),
        "account_ids": account_ids,
        "account_keys": account_keys,
        "transfer_ids": transfer_ids,
        "missing_account_ids": missing_account_ids,
        "source_refs": source_refs,
        "runtime_ledger_buckets": buckets,
    }


def journal_tigerbeetle_runtime_ledger_bucket(
    session: Session,
    row: StrategyRuntimeLedgerBucket,
) -> None:
    session.flush()
    if not settings.tigerbeetle_enabled or not settings.tigerbeetle_journal_enabled:
        _mark_runtime_ledger_bucket_tigerbeetle_journal(
            session,
            row,
            TigerBeetleJournalMark(
                ref=None,
                status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_NON_AUTHORITY_BLOCKED,
                blockers=[TIGERBEETLE_BLOCKER_JOURNAL_DISABLED],
            ),
        )
        return
    try:
        with TigerBeetleLedgerJournal() as journal, session.begin_nested():
            ref = journal.journal_runtime_ledger_bucket(session, row)
    except Exception as exc:
        if settings.tigerbeetle_required:
            raise
        _mark_runtime_ledger_bucket_tigerbeetle_journal(
            session,
            row,
            TigerBeetleJournalMark(
                ref=None,
                status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_NON_AUTHORITY_BLOCKED,
                blockers=[TIGERBEETLE_BLOCKER_JOURNAL_ERROR],
                error=f"{type(exc).__name__}: {exc}",
            ),
        )
        logger.warning(
            "TigerBeetle runtime-ledger journal failed for bucket_id=%s run_id=%s: %s",
            row.id,
            row.run_id,
            exc,
        )
        return
    if ref is None:
        _mark_runtime_ledger_bucket_tigerbeetle_journal(
            session,
            row,
            TigerBeetleJournalMark(
                ref=None,
                status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_NON_AUTHORITY_BLOCKED,
                blockers=[TIGERBEETLE_BLOCKER_JOURNAL_ENTRY_UNAVAILABLE],
            ),
        )
        return
    _mark_runtime_ledger_bucket_tigerbeetle_journal(
        session,
        row,
        TigerBeetleJournalMark(
            ref=ref,
            status=TIGERBEETLE_RUNTIME_LEDGER_JOURNAL_STATUS_PASS,
            blockers=[],
        ),
    )


def _mark_runtime_ledger_bucket_tigerbeetle_journal(
    session: Session,
    row: StrategyRuntimeLedgerBucket,
    mark: TigerBeetleJournalMark,
) -> None:
    account_refs = (
        _tigerbeetle_account_refs_for_transfer_ref(session, mark.ref)
        if mark.ref is not None
        else []
    )
    journal_payload = tigerbeetle_runtime_ledger_journal_payload(
        bucket=row,
        ref=mark.ref,
        status=mark.status,
        blockers=mark.blockers,
        account_refs=account_refs,
        error=mark.error,
    )
    existing_payload = mapping_payload(row.payload_json)
    source_refs = string_list(existing_payload.get("source_refs"))
    for source_ref in string_list(journal_payload.get("source_refs")):
        if source_ref not in source_refs:
            source_refs.append(source_ref)
    source_row_counts = mapping_payload(existing_payload.get("source_row_counts"))
    if mark.ref is not None:
        source_row_counts["tigerbeetle_transfer_refs"] = 1
        source_row_counts["tigerbeetle_account_refs"] = len(account_refs)
    existing_tigerbeetle_refs = mapping_payload(existing_payload.get("tigerbeetle"))
    tigerbeetle_refs = (
        journal_payload
        if mark.ref is not None or not existing_tigerbeetle_refs
        else existing_tigerbeetle_refs
    )
    tigerbeetle_account_ids = (
        journal_payload["account_ids"]
        if mark.ref is not None
        else existing_payload.get("tigerbeetle_account_ids")
        or tigerbeetle_refs.get("account_ids")
        or journal_payload["account_ids"]
    )
    tigerbeetle_account_keys = (
        journal_payload["account_keys"]
        if mark.ref is not None
        else existing_payload.get("tigerbeetle_account_keys")
        or tigerbeetle_refs.get("account_keys")
        or journal_payload["account_keys"]
    )
    tigerbeetle_transfer_ids = (
        journal_payload["transfer_ids"]
        if mark.ref is not None
        else existing_payload.get("tigerbeetle_transfer_ids")
        or tigerbeetle_refs.get("transfer_ids")
        or journal_payload["transfer_ids"]
    )
    row.payload_json = {
        **existing_payload,
        "source_refs": source_refs,
        "source_row_counts": source_row_counts,
        "tigerbeetle_journal_parity": journal_payload,
        "tigerbeetle": tigerbeetle_refs,
        "tigerbeetle_account_ids": tigerbeetle_account_ids,
        "tigerbeetle_account_keys": tigerbeetle_account_keys,
        "tigerbeetle_transfer_ids": tigerbeetle_transfer_ids,
        "tigerbeetle_non_authority_blockers": journal_payload["authority_blockers"],
    }
    session.add(row)
    session.flush()
