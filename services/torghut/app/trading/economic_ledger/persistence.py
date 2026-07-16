"""Closed-source replay and atomic publication for broker-economic ledgers."""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Iterable, TypeAlias, cast

from sqlalchemy import (
    Integer,
    Text,
    and_,
    column,
    func,
    insert,
    or_,
    select,
    table,
    text,
)
from sqlalchemy.engine import Row
from sqlalchemy.orm import Session

from ...models import (
    BrokerAccountActivity,
    BrokerAccountActivityCursor,
    BrokerEconomicLedgerEntry,
    BrokerEconomicLedgerInput,
    BrokerEconomicLedgerRun,
)
from ..broker_account_activities import (
    ACCOUNT_ACTIVITIES_REST_SOURCE,
    as_utc,
)
from .comparison import DualReduction, reduce_and_compare
from .journal_reducer import JOURNAL_REDUCER_NAME, JOURNAL_REDUCER_VERSION
from .state_reducer import STATE_REDUCER_NAME, STATE_REDUCER_VERSION
from .types import (
    EconomicActivity,
    EconomicLedgerError,
    EconomicProjection,
    LedgerScope,
    PreparedActivities,
    canonical_sha256,
    is_occ_option_symbol,
    prepare_activities,
)


_RESULT_SCHEMA_VERSION = "torghut.broker-economic-ledger-result.v1"
_REPLAY_SCHEMA_VERSION = "torghut.broker-economic-ledger-replay.v1"
_PUBLICATION_TOKEN_SCHEMA_VERSION = "torghut.broker-economic-ledger-publication.v1"
_ENTRY_INSERT_BATCH_SIZE = 2_000
_OPTION_CONTRACT_CATALOG = table(
    "torghut_options_contract_catalog",
    column("contract_symbol", Text),
    column("contract_size", Integer),
)


BrokerEconomicLedgerSourceRecord: TypeAlias = tuple[
    str,
    str,
    dict[str, object],
    str,
    str,
    str,
    str | None,
    str | None,
    datetime | None,
    date | None,
    datetime,
    str | None,
    str | None,
    Decimal | None,
    Decimal | None,
    Decimal | None,
    str | None,
]


@dataclass(frozen=True, slots=True)
class BrokerEconomicLedgerSourceRows:
    """Database values copied while the closed-source cursor is share-locked."""

    cursor_id: uuid.UUID
    source_watermark: datetime
    scope: LedgerScope
    activities_inserted: int
    rows: tuple[Row[BrokerEconomicLedgerSourceRecord], ...]
    option_contract_sizes: tuple[tuple[str, int], ...]


@dataclass(frozen=True, slots=True)
class BrokerEconomicLedgerSnapshot:
    """One complete immutable REST source set prepared after lock release."""

    cursor_id: uuid.UUID
    source_watermark: datetime
    prepared: PreparedActivities
    activities: tuple[EconomicActivity, ...]
    input_manifest_canonical_json: str
    option_contract_sizes: tuple[tuple[str, int], ...]


@dataclass(frozen=True, slots=True)
class PublishedBrokerEconomicLedgerRuns:
    input_id: uuid.UUID
    journal_run_id: uuid.UUID
    state_run_id: uuid.UUID
    source_watermark: datetime
    reused_existing: bool


@dataclass(frozen=True, slots=True)
class BrokerEconomicLedgerReplay:
    snapshot: BrokerEconomicLedgerSnapshot
    reduction: DualReduction
    publication_token: str

    def to_payload(
        self,
        *,
        published: PublishedBrokerEconomicLedgerRuns | None = None,
    ) -> dict[str, object]:
        journal = self.reduction.journal.projection
        independent = self.reduction.independent
        return {
            "schema_version": _REPLAY_SCHEMA_VERSION,
            "admissible": self.reduction.admissible,
            "comparison": {
                "delta_count": len(self.reduction.comparison.deltas),
                "equivalent": self.reduction.comparison.equivalent,
                "sha256": self.reduction.comparison.comparison_digest,
            },
            "input": {
                "corrected_count": self.snapshot.prepared.corrected_count,
                "count": self.snapshot.prepared.input_count,
                "cursor_id": str(self.snapshot.cursor_id),
                "duplicate_count": self.snapshot.prepared.duplicate_count,
                "manifest_sha256": self.snapshot.prepared.manifest_digest,
                "scope": {
                    "account_label": self.snapshot.prepared.scope.account_label,
                    "endpoint_fingerprint": self.snapshot.prepared.scope.endpoint_fingerprint,
                    "environment": self.snapshot.prepared.scope.environment,
                    "provider": self.snapshot.prepared.scope.provider,
                    "quote_currency": self.snapshot.prepared.scope.quote_currency,
                },
                "source": ACCOUNT_ACTIVITIES_REST_SOURCE,
                "watermark": self.snapshot.source_watermark.isoformat(),
            },
            "journal": {
                "entry_count": sum(
                    len(transaction.lines)
                    for transaction in self.reduction.journal.transactions
                ),
                "journal_sha256": self.reduction.journal.journal_digest,
                "projection": journal.economic_payload(),
                "projection_sha256": journal.result_digest,
                "reducer_version": journal.reducer_version,
                "transaction_count": len(self.reduction.journal.transactions),
                "unsupported_count": len(journal.unsupported_activity_ids),
            },
            "publication": {
                "input_id": str(published.input_id) if published is not None else None,
                "input_source_watermark": (
                    published.source_watermark.isoformat()
                    if published is not None
                    else None
                ),
                "journal_run_id": (
                    str(published.journal_run_id) if published is not None else None
                ),
                "reused_existing": (
                    published.reused_existing if published is not None else None
                ),
                "state_run_id": (
                    str(published.state_run_id) if published is not None else None
                ),
                "token": self.publication_token,
            },
            "state": {
                "projection_sha256": independent.result_digest,
                "reducer_version": independent.reducer_version,
                "unsupported_count": len(independent.unsupported_activity_ids),
            },
        }


def replay_broker_economic_ledger_snapshot(
    snapshot: BrokerEconomicLedgerSnapshot,
) -> BrokerEconomicLedgerReplay:
    """Run both pure reducers from an already closed immutable source snapshot."""

    reduction = reduce_and_compare(snapshot.prepared)
    token = _publication_token(snapshot, reduction)
    return BrokerEconomicLedgerReplay(
        snapshot=snapshot,
        reduction=reduction,
        publication_token=token,
    )


def load_broker_economic_ledger_source_rows(
    session: Session,
    *,
    scope: LedgerScope,
) -> BrokerEconomicLedgerSourceRows:
    """Read only database values while share-locking the mutable source cursor."""

    cursor = _load_locked_source_cursor(session, scope)
    _require_complete_cursor(cursor)
    assert cursor is not None
    assert cursor.last_completed_scan_until is not None
    rows = tuple(
        session.execute(
            select(
                BrokerAccountActivity.source,
                BrokerAccountActivity.external_activity_id,
                BrokerAccountActivity.raw_payload,
                BrokerAccountActivity.raw_payload_canonical_json,
                BrokerAccountActivity.raw_payload_sha256,
                BrokerAccountActivity.activity_type,
                BrokerAccountActivity.activity_subtype,
                BrokerAccountActivity.correction_of_external_id,
                BrokerAccountActivity.event_at,
                BrokerAccountActivity.settle_date,
                BrokerAccountActivity.first_observed_at,
                BrokerAccountActivity.symbol,
                BrokerAccountActivity.side,
                BrokerAccountActivity.quantity,
                BrokerAccountActivity.price,
                BrokerAccountActivity.net_amount,
                BrokerAccountActivity.currency,
            )
            .where(
                BrokerAccountActivity.provider == scope.provider,
                BrokerAccountActivity.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
                BrokerAccountActivity.environment == scope.environment,
                BrokerAccountActivity.account_label == scope.account_label,
                BrokerAccountActivity.endpoint_fingerprint
                == scope.endpoint_fingerprint,
            )
            .order_by(BrokerAccountActivity.external_activity_id)
        ).tuples()
    )
    option_contract_sizes = _load_locked_option_contract_sizes(
        session,
        symbols=_option_symbols(rows),
    )
    return BrokerEconomicLedgerSourceRows(
        cursor_id=cursor.id,
        source_watermark=as_utc(cursor.last_completed_scan_until),
        scope=scope,
        activities_inserted=cursor.activities_inserted,
        rows=rows,
        option_contract_sizes=option_contract_sizes,
    )


def _option_symbols(
    rows: Iterable[Row[BrokerEconomicLedgerSourceRecord]],
) -> tuple[str, ...]:
    symbols = {
        symbol.replace("/", "").upper()
        for row in rows
        if (symbol := cast(str | None, row.symbol)) is not None
        and is_occ_option_symbol(symbol.replace("/", "").upper())
    }
    return tuple(sorted(symbols))


def _load_locked_option_contract_sizes(
    session: Session,
    *,
    symbols: tuple[str, ...],
) -> tuple[tuple[str, int], ...]:
    if not symbols:
        return ()
    rows = session.execute(
        select(
            _OPTION_CONTRACT_CATALOG.c.contract_symbol,
            _OPTION_CONTRACT_CATALOG.c.contract_size,
        )
        .where(_OPTION_CONTRACT_CATALOG.c.contract_symbol.in_(symbols))
        .order_by(_OPTION_CONTRACT_CATALOG.c.contract_symbol)
        .with_for_update(read=True)
    ).tuples()
    return tuple((str(symbol), int(contract_size)) for symbol, contract_size in rows)


def prepare_broker_economic_ledger_snapshot(
    source_rows: BrokerEconomicLedgerSourceRows,
) -> BrokerEconomicLedgerSnapshot:
    """Validate and canonicalize detached source values without a transaction."""

    if len(source_rows.rows) != source_rows.activities_inserted:
        raise EconomicLedgerError("economic_ledger_source_count_mismatch")
    option_contract_sizes = dict(source_rows.option_contract_sizes)
    activities = tuple(
        _adapt_source_activity(
            row,
            scope=source_rows.scope,
            option_contract_sizes=option_contract_sizes,
        )
        for row in source_rows.rows
    )
    prepared = prepare_activities(activities)
    manifest = tuple(
        activity.manifest_payload()
        for activity in sorted(activities, key=lambda item: item.sort_key)
    )
    manifest_canonical_json = _canonical_json(manifest)
    if _sha256(manifest_canonical_json) != prepared.manifest_digest:
        raise EconomicLedgerError("economic_ledger_manifest_digest_mismatch")
    return BrokerEconomicLedgerSnapshot(
        cursor_id=source_rows.cursor_id,
        source_watermark=source_rows.source_watermark,
        prepared=prepared,
        activities=activities,
        input_manifest_canonical_json=manifest_canonical_json,
        option_contract_sizes=source_rows.option_contract_sizes,
    )


def publish_broker_economic_ledger(
    session: Session,
    replay: BrokerEconomicLedgerReplay,
    *,
    confirmation_token: str,
) -> PublishedBrokerEconomicLedgerRuns:
    """Atomically append both projections after exact token and source checks."""

    expected_token = _publication_token(replay.snapshot, replay.reduction)
    if not hmac.compare_digest(replay.publication_token, expected_token):
        raise EconomicLedgerError("economic_ledger_replay_token_invalid")
    if not hmac.compare_digest(confirmation_token, expected_token):
        raise EconomicLedgerError("economic_ledger_publication_token_mismatch")
    if not replay.reduction.admissible:
        raise EconomicLedgerError("economic_ledger_projection_not_admissible")
    _require_replay_identity(replay)
    _acquire_publication_lock(session, replay.snapshot.prepared.scope)
    _require_current_source_snapshot(session, replay.snapshot)
    input_row = _load_or_create_input(session, replay.snapshot)
    input_id = input_row.id
    existing = _load_existing_runs(session, replay, input_row=input_row)
    if existing is not None:
        return existing

    journal_run_id = uuid.uuid4()
    state_run_id = uuid.uuid4()
    entry_batches = _journal_entry_batches(
        replay.reduction,
        run_id=journal_run_id,
        batch_size=_ENTRY_INSERT_BATCH_SIZE,
    )
    for batch in entry_batches:
        session.execute(insert(BrokerEconomicLedgerEntry), batch)
    session.execute(
        insert(BrokerEconomicLedgerRun),
        [
            _run_values(
                replay,
                run_id=journal_run_id,
                input_id=input_id,
                projection=replay.reduction.journal.projection,
            ),
            _run_values(
                replay,
                run_id=state_run_id,
                input_id=input_id,
                projection=replay.reduction.independent,
            ),
        ],
    )
    return PublishedBrokerEconomicLedgerRuns(
        input_id=input_id,
        journal_run_id=journal_run_id,
        state_run_id=state_run_id,
        source_watermark=as_utc(input_row.source_watermark),
        reused_existing=False,
    )


def _require_complete_cursor(cursor: BrokerAccountActivityCursor | None) -> None:
    if cursor is None:
        raise EconomicLedgerError("economic_ledger_source_cursor_missing")
    if (
        cursor.status != "complete"
        or cursor.last_error is not None
        or cursor.next_page_token is not None
        or cursor.scan_until is not None
        or cursor.last_completed_at is None
        or cursor.last_completed_scan_until is None
        or cursor.last_completed_scan_until > cursor.last_completed_at
    ):
        raise EconomicLedgerError("economic_ledger_source_cursor_incomplete")
    if cursor.activities_inserted <= 0:
        raise EconomicLedgerError("economic_ledger_source_empty")


def _load_locked_source_cursor(
    session: Session,
    scope: LedgerScope,
) -> BrokerAccountActivityCursor | None:
    return session.scalar(
        select(BrokerAccountActivityCursor)
        .where(
            BrokerAccountActivityCursor.provider == scope.provider,
            BrokerAccountActivityCursor.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
            BrokerAccountActivityCursor.environment == scope.environment,
            BrokerAccountActivityCursor.account_label == scope.account_label,
            BrokerAccountActivityCursor.endpoint_fingerprint
            == scope.endpoint_fingerprint,
        )
        .with_for_update(read=True)
    )


def _require_current_source_snapshot(
    session: Session,
    snapshot: BrokerEconomicLedgerSnapshot,
) -> None:
    cursor = _load_locked_source_cursor(session, snapshot.prepared.scope)
    _require_complete_cursor(cursor)
    assert cursor is not None
    assert cursor.last_completed_scan_until is not None
    if (
        cursor.id != snapshot.cursor_id
        or as_utc(cursor.last_completed_scan_until) < snapshot.source_watermark
        or cursor.activities_inserted != len(snapshot.activities)
    ):
        raise EconomicLedgerError("economic_ledger_source_watermark_changed")
    scope = snapshot.prepared.scope
    current_count = session.scalar(
        select(func.count())
        .select_from(BrokerAccountActivity)
        .where(
            BrokerAccountActivity.provider == scope.provider,
            BrokerAccountActivity.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
            BrokerAccountActivity.environment == scope.environment,
            BrokerAccountActivity.account_label == scope.account_label,
            BrokerAccountActivity.endpoint_fingerprint == scope.endpoint_fingerprint,
        )
    )
    if current_count != len(snapshot.activities):
        raise EconomicLedgerError("economic_ledger_source_rows_changed")
    current_contract_sizes = _load_locked_option_contract_sizes(
        session,
        symbols=tuple(symbol for symbol, _ in snapshot.option_contract_sizes),
    )
    if current_contract_sizes != snapshot.option_contract_sizes:
        raise EconomicLedgerError("economic_ledger_option_contract_sizes_changed")


def _load_or_create_input(
    session: Session,
    snapshot: BrokerEconomicLedgerSnapshot,
) -> BrokerEconomicLedgerInput:
    existing = _load_input(session, snapshot)
    if existing is not None:
        _require_existing_input(existing, snapshot)
        return existing
    input_id = uuid.uuid4()
    session.execute(
        insert(BrokerEconomicLedgerInput),
        [_input_values(snapshot, input_id=input_id)],
    )
    created = _load_input(session, snapshot)
    if created is None:
        raise EconomicLedgerError("economic_ledger_input_insert_missing")
    return created


def _load_input(
    session: Session,
    snapshot: BrokerEconomicLedgerSnapshot,
) -> BrokerEconomicLedgerInput | None:
    scope = snapshot.prepared.scope
    return session.scalar(
        select(BrokerEconomicLedgerInput).where(
            BrokerEconomicLedgerInput.provider == scope.provider,
            BrokerEconomicLedgerInput.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
            BrokerEconomicLedgerInput.environment == scope.environment,
            BrokerEconomicLedgerInput.account_label == scope.account_label,
            BrokerEconomicLedgerInput.endpoint_fingerprint
            == scope.endpoint_fingerprint,
            BrokerEconomicLedgerInput.source_cursor_id == snapshot.cursor_id,
            BrokerEconomicLedgerInput.manifest_sha256
            == snapshot.prepared.manifest_digest,
        )
    )


def _require_existing_input(
    row: BrokerEconomicLedgerInput,
    snapshot: BrokerEconomicLedgerSnapshot,
) -> None:
    prepared = snapshot.prepared
    if (
        row.quote_currency != prepared.scope.quote_currency
        or as_utc(row.source_watermark) > snapshot.source_watermark
        or row.input_count != prepared.input_count
        or row.duplicate_count != prepared.duplicate_count
        or row.corrected_count != prepared.corrected_count
        or row.manifest_canonical_json != snapshot.input_manifest_canonical_json
        or row.manifest_sha256 != _sha256(row.manifest_canonical_json)
    ):
        raise EconomicLedgerError("economic_ledger_existing_input_contradiction")


def _input_values(
    snapshot: BrokerEconomicLedgerSnapshot,
    *,
    input_id: uuid.UUID,
) -> dict[str, object]:
    prepared = snapshot.prepared
    scope = prepared.scope
    return {
        "id": input_id,
        "provider": scope.provider,
        "source": ACCOUNT_ACTIVITIES_REST_SOURCE,
        "environment": scope.environment,
        "account_label": scope.account_label,
        "endpoint_fingerprint": scope.endpoint_fingerprint,
        "quote_currency": scope.quote_currency,
        "source_cursor_id": snapshot.cursor_id,
        "source_watermark": snapshot.source_watermark,
        "input_count": prepared.input_count,
        "duplicate_count": prepared.duplicate_count,
        "corrected_count": prepared.corrected_count,
        "manifest_canonical_json": snapshot.input_manifest_canonical_json,
        "manifest_sha256": prepared.manifest_digest,
    }


def _adapt_source_activity(
    row: Row[BrokerEconomicLedgerSourceRecord],
    *,
    scope: LedgerScope,
    option_contract_sizes: dict[str, int],
) -> EconomicActivity:
    (
        source,
        external_activity_id,
        raw_payload,
        raw_payload_canonical_json,
        raw_payload_sha256,
        activity_type,
        activity_subtype,
        correction_of_external_id,
        event_at,
        settle_date,
        first_observed_at,
        symbol,
        side,
        quantity,
        price,
        net_amount,
        currency,
    ) = row
    if source != ACCOUNT_ACTIVITIES_REST_SOURCE:
        raise EconomicLedgerError("economic_ledger_source_not_rest")
    try:
        canonical_payload = json.loads(raw_payload_canonical_json)
    except json.JSONDecodeError as exc:
        raise EconomicLedgerError("economic_ledger_source_json_invalid") from exc
    if (
        not isinstance(canonical_payload, dict)
        or canonical_payload != raw_payload
        or _sha256(raw_payload_canonical_json) != raw_payload_sha256
    ):
        raise EconomicLedgerError("economic_ledger_source_hash_mismatch")
    canonical_symbol = symbol.replace("/", "").upper() if symbol is not None else None
    contract_size = option_contract_sizes.get(canonical_symbol or "")
    return EconomicActivity(
        scope=scope,
        external_activity_id=external_activity_id,
        raw_payload_sha256=raw_payload_sha256,
        activity_type=activity_type,
        activity_subtype=activity_subtype,
        correction_of_external_id=correction_of_external_id,
        event_at=as_utc(event_at) if event_at is not None else None,
        settle_date=settle_date,
        first_observed_at=as_utc(first_observed_at),
        symbol=symbol,
        side=side,
        quantity=quantity,
        price=price,
        contract_size=(Decimal(contract_size) if contract_size is not None else None),
        net_amount=net_amount,
        currency=currency,
    )


def _publication_token(
    snapshot: BrokerEconomicLedgerSnapshot,
    reduction: DualReduction,
) -> str:
    digest = canonical_sha256(
        {
            "admissible": reduction.admissible,
            "comparison_sha256": reduction.comparison.comparison_digest,
            "cursor_id": str(snapshot.cursor_id),
            "input_manifest_sha256": snapshot.prepared.manifest_digest,
            "journal_projection_sha256": reduction.journal.projection.result_digest,
            "journal_sha256": reduction.journal.journal_digest,
            "schema_version": _PUBLICATION_TOKEN_SCHEMA_VERSION,
            "state_projection_sha256": reduction.independent.result_digest,
        }
    )
    return f"publish:{digest}"


def _require_replay_identity(replay: BrokerEconomicLedgerReplay) -> None:
    prepared = replay.snapshot.prepared
    journal = replay.reduction.journal.projection
    independent = replay.reduction.independent
    projections = (
        (journal, JOURNAL_REDUCER_NAME, JOURNAL_REDUCER_VERSION),
        (independent, STATE_REDUCER_NAME, STATE_REDUCER_VERSION),
    )
    if any(
        not _projection_matches_prepared(
            projection,
            prepared=prepared,
            reducer_name=reducer_name,
            reducer_version=reducer_version,
        )
        for projection, reducer_name, reducer_version in projections
    ):
        raise EconomicLedgerError("economic_ledger_replay_identity_mismatch")
    comparison = replay.reduction.comparison
    if (
        comparison.input_manifest_digest != prepared.manifest_digest
        or comparison.canonical_reducer
        != f"{JOURNAL_REDUCER_NAME}:{JOURNAL_REDUCER_VERSION}"
        or comparison.independent_reducer
        != f"{STATE_REDUCER_NAME}:{STATE_REDUCER_VERSION}"
    ):
        raise EconomicLedgerError("economic_ledger_replay_identity_mismatch")


def _projection_matches_prepared(
    projection: EconomicProjection,
    *,
    prepared: PreparedActivities,
    reducer_name: str,
    reducer_version: str,
) -> bool:
    return (
        projection.reducer_name == reducer_name
        and projection.reducer_version == reducer_version
        and projection.scope == prepared.scope
        and projection.input_manifest_digest == prepared.manifest_digest
        and projection.input_count == prepared.input_count
        and projection.duplicate_count == prepared.duplicate_count
        and projection.corrected_count == prepared.corrected_count
    )


def _acquire_publication_lock(session: Session, scope: LedgerScope) -> None:
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return
    lock_identity = canonical_sha256(
        {
            "account_label": scope.account_label,
            "endpoint_fingerprint": scope.endpoint_fingerprint,
            "environment": scope.environment,
            "provider": scope.provider,
        }
    )
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:identity, 0))"),
        {"identity": f"torghut:broker-economic-ledger:{lock_identity}"},
    )


def _load_existing_runs(
    session: Session,
    replay: BrokerEconomicLedgerReplay,
    *,
    input_row: BrokerEconomicLedgerInput,
) -> PublishedBrokerEconomicLedgerRuns | None:
    input_id = input_row.id
    rows = tuple(
        session.scalars(
            select(BrokerEconomicLedgerRun).where(
                BrokerEconomicLedgerRun.input_id == input_id,
                or_(
                    and_(
                        BrokerEconomicLedgerRun.reducer_name == JOURNAL_REDUCER_NAME,
                        BrokerEconomicLedgerRun.reducer_version
                        == JOURNAL_REDUCER_VERSION,
                    ),
                    and_(
                        BrokerEconomicLedgerRun.reducer_name == STATE_REDUCER_NAME,
                        BrokerEconomicLedgerRun.reducer_version
                        == STATE_REDUCER_VERSION,
                    ),
                ),
            )
        )
    )
    if not rows:
        return None
    by_reducer = {row.reducer_name: row for row in rows}
    if set(by_reducer) != {JOURNAL_REDUCER_NAME, STATE_REDUCER_NAME}:
        raise EconomicLedgerError("economic_ledger_existing_run_pair_incomplete")
    journal = by_reducer[JOURNAL_REDUCER_NAME]
    state = by_reducer[STATE_REDUCER_NAME]
    _require_existing_run(
        journal,
        projection=replay.reduction.journal.projection,
        comparison_sha256=replay.reduction.comparison.comparison_digest,
        journal_sha256=replay.reduction.journal.journal_digest,
    )
    _require_existing_run(
        state,
        projection=replay.reduction.independent,
        comparison_sha256=replay.reduction.comparison.comparison_digest,
        journal_sha256=None,
    )
    return PublishedBrokerEconomicLedgerRuns(
        input_id=input_id,
        journal_run_id=journal.id,
        state_run_id=state.id,
        source_watermark=as_utc(input_row.source_watermark),
        reused_existing=True,
    )


def require_published_broker_economic_ledger_runs(
    session: Session,
    replay: BrokerEconomicLedgerReplay,
) -> PublishedBrokerEconomicLedgerRuns:
    """Resolve the exact immutable run pair without creating evidence."""

    _require_replay_identity(replay)
    _acquire_publication_lock(session, replay.snapshot.prepared.scope)
    _require_current_source_snapshot(session, replay.snapshot)
    input_row = _load_input(session, replay.snapshot)
    if input_row is None:
        raise EconomicLedgerError("economic_ledger_published_input_missing")
    _require_existing_input(input_row, replay.snapshot)
    runs = _load_existing_runs(session, replay, input_row=input_row)
    if runs is None:
        raise EconomicLedgerError("economic_ledger_published_run_pair_missing")
    return runs


def _require_existing_run(
    row: BrokerEconomicLedgerRun,
    *,
    projection: EconomicProjection,
    comparison_sha256: str,
    journal_sha256: str | None,
) -> None:
    if (
        row.reducer_version != projection.reducer_version
        or row.projection_sha256 != projection.result_digest
        or row.comparison_sha256 != comparison_sha256
        or row.journal_sha256 != journal_sha256
        or row.admissible is not True
        or row.result_sha256 != _sha256(row.result_canonical_json)
    ):
        raise EconomicLedgerError("economic_ledger_existing_run_contradiction")


def _run_values(
    replay: BrokerEconomicLedgerReplay,
    *,
    run_id: uuid.UUID,
    input_id: uuid.UUID,
    projection: EconomicProjection,
) -> dict[str, object]:
    journal_sha256, transaction_count, entry_count = _run_metrics(
        replay,
        projection=projection,
    )
    result = _result_payload(
        projection,
        comparison_sha256=replay.reduction.comparison.comparison_digest,
        journal_sha256=journal_sha256,
    )
    result_canonical_json = _canonical_json(result)
    return {
        "id": run_id,
        "input_id": input_id,
        "reducer_name": projection.reducer_name,
        "reducer_version": projection.reducer_version,
        "unsupported_count": len(projection.unsupported_activity_ids),
        "transaction_count": transaction_count,
        "entry_count": entry_count,
        "admissible": projection.admissible,
        "result": result,
        "result_canonical_json": result_canonical_json,
        "result_sha256": _sha256(result_canonical_json),
        "projection_sha256": projection.result_digest,
        "comparison_sha256": replay.reduction.comparison.comparison_digest,
        "journal_sha256": journal_sha256,
    }


def _run_metrics(
    replay: BrokerEconomicLedgerReplay,
    *,
    projection: EconomicProjection,
) -> tuple[str | None, int, int]:
    if (
        projection.reducer_name == JOURNAL_REDUCER_NAME
        and projection.reducer_version == JOURNAL_REDUCER_VERSION
    ):
        transactions = replay.reduction.journal.transactions
        return (
            replay.reduction.journal.journal_digest,
            len(transactions),
            sum(len(transaction.lines) for transaction in transactions),
        )
    if (
        projection.reducer_name == STATE_REDUCER_NAME
        and projection.reducer_version == STATE_REDUCER_VERSION
    ):
        return None, 0, 0
    raise EconomicLedgerError("economic_ledger_reducer_unsupported")


def _result_payload(
    projection: EconomicProjection,
    *,
    comparison_sha256: str,
    journal_sha256: str | None,
) -> dict[str, object]:
    return {
        "schema_version": _RESULT_SCHEMA_VERSION,
        "admissible": projection.admissible,
        "comparison_sha256": comparison_sha256,
        "input_count": projection.input_count,
        "input_manifest_sha256": projection.input_manifest_digest,
        "journal_sha256": journal_sha256,
        "projection": projection.economic_payload(),
        "projection_sha256": projection.result_digest,
        "reducer_name": projection.reducer_name,
        "reducer_version": projection.reducer_version,
    }


def _journal_entry_batches(
    reduction: DualReduction,
    *,
    run_id: uuid.UUID,
    batch_size: int,
) -> Iterable[list[dict[str, object]]]:
    batch: list[dict[str, object]] = []
    for transaction_index, transaction in enumerate(reduction.journal.transactions):
        for line_number, line in enumerate(transaction.lines):
            batch.append(
                {
                    "run_id": run_id,
                    "transaction_index": transaction_index,
                    "line_number": line_number,
                    "source_activity_id": transaction.source_activity_id,
                    "transaction_id": transaction.transaction_id,
                    "reverses_transaction_id": transaction.reverses_transaction_id,
                    "posting_rule": transaction.posting_rule,
                    "transaction_sha256": transaction.digest,
                    "account": line.account,
                    "commodity": line.commodity,
                    "amount": line.amount,
                }
            )
            if len(batch) == batch_size:
                yield batch
                batch = []
    if batch:
        yield batch


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise EconomicLedgerError("economic_ledger_json_invalid") from exc


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


__all__ = (
    "BrokerEconomicLedgerReplay",
    "BrokerEconomicLedgerSnapshot",
    "BrokerEconomicLedgerSourceRows",
    "PublishedBrokerEconomicLedgerRuns",
    "load_broker_economic_ledger_source_rows",
    "prepare_broker_economic_ledger_snapshot",
    "publish_broker_economic_ledger",
    "require_published_broker_economic_ledger_runs",
    "replay_broker_economic_ledger_snapshot",
)
