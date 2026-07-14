"""Crash-resumable persistence for expiration-sharded options discovery."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import hashlib
import json
from typing import cast

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, CursorResult, Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from .archive_model import ARCHIVE_COMPONENT, ARCHIVE_SCOPE_TYPE, ArchiveShard


ARCHIVE_MEMBERSHIP_TABLE = "torghut_options_archive_membership"
DEFAULT_ARCHIVE_LOCK_NAME = "torghut:options-catalog-archive"
_IN_PROGRESS_STATUSES = frozenset({"running", "retry", "finalizing"})


class ArchiveStateError(RuntimeError):
    """Raised when durable archive state cannot be reconciled safely."""


class ArchiveLeaseLostError(ArchiveStateError):
    """Raised when the singleton archive lease is no longer held."""


@dataclass(frozen=True, slots=True)
class ArchiveCheckpoint:
    shard: ArchiveShard
    query_fingerprint: str
    status: str
    cursor: str | None
    page_count: int
    seen_count: int
    retry_count: int
    next_eligible_at: datetime | None
    last_success_at: datetime | None

    def due(self, now: datetime) -> bool:
        return self.next_eligible_at is None or self.next_eligible_at <= now


@dataclass(frozen=True, slots=True)
class ArchiveCompletion:
    checkpoint: ArchiveCheckpoint
    transitioned_count: int


@dataclass(frozen=True, slots=True)
class ArchiveFailure:
    error_code: str
    error_detail: str
    retry_base_seconds: int
    retry_max_seconds: int


@dataclass(frozen=True, slots=True)
class ArchiveResetRequest:
    shard: ArchiveShard
    query_fingerprint: str
    observed_at: datetime
    reason: str
    last_success_at: datetime | None


def archive_advisory_lock_id(
    name: str = DEFAULT_ARCHIVE_LOCK_NAME,
) -> int:
    """Return a stable signed 64-bit PostgreSQL advisory-lock identifier."""

    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=True)


def _metadata(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        raw = cast(dict[object, object], value)
        return {str(key): item for key, item in raw.items()}
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            raw = cast(dict[object, object], parsed)
            return {str(key): item for key, item in raw.items()}
    return {}


def _metadata_json(
    checkpoint: ArchiveCheckpoint,
    *,
    extra: Mapping[str, object] | None = None,
) -> str:
    payload: dict[str, object] = {
        "expiration_date_gte": checkpoint.shard.start.isoformat(),
        "expiration_date_lte": checkpoint.shard.end.isoformat(),
        "page_count": checkpoint.page_count,
        "query_fingerprint": checkpoint.query_fingerprint,
        "seen_count": checkpoint.seen_count,
        "status": checkpoint.status,
    }
    if extra:
        payload.update(extra)
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _as_int(value: object, default: int = 0) -> int:
    try:
        return int(cast(int | float | str, value))
    except (TypeError, ValueError, ArithmeticError):
        return default


class OptionsArchiveRepository:
    """Own archive watermarks, unlogged membership, and singleton fencing."""

    def __init__(self, sqlalchemy_dsn: str) -> None:
        self._engine: Engine = create_engine(
            sqlalchemy_dsn,
            future=True,
            pool_pre_ping=True,
            pool_size=2,
            max_overflow=1,
        )
        self._session_factory = sessionmaker(
            bind=self._engine,
            expire_on_commit=False,
            future=True,
        )
        self._lease_connection: Connection | None = None
        self._lease_lock_id: int | None = None

    @contextmanager
    def session(self) -> Iterator[Session]:
        session = self._session_factory()
        try:
            yield session
        finally:
            session.close()

    def try_acquire_lease(self, lock_name: str = DEFAULT_ARCHIVE_LOCK_NAME) -> bool:
        """Acquire and retain the session-scoped singleton advisory lock."""

        if self._lease_connection is not None:
            return self.lease_healthy()
        lock_id = archive_advisory_lock_id(lock_name)
        connection: Connection | None = None
        try:
            connection = self._engine.connect()
            acquired = bool(
                connection.execute(
                    text("SELECT pg_try_advisory_lock(:lock_id)"),
                    {"lock_id": lock_id},
                ).scalar_one()
            )
            connection.commit()
        except SQLAlchemyError:
            if connection is not None:
                connection.close()
            return False
        if not acquired:
            connection.close()
            return False
        self._lease_connection = connection
        self._lease_lock_id = lock_id
        return True

    def lease_healthy(self) -> bool:
        connection = self._lease_connection
        if connection is None:
            return False
        try:
            connection.execute(text("SELECT 1")).scalar_one()
            connection.commit()
        except SQLAlchemyError:
            connection.close()
            self._lease_connection = None
            self._lease_lock_id = None
            return False
        return True

    def require_lease(self) -> None:
        """Fail closed before archive I/O when the singleton fence is lost."""

        if not self.lease_healthy():
            raise ArchiveLeaseLostError(
                "PostgreSQL archive advisory lock connection was lost"
            )

    def release_lease(self) -> None:
        connection = self._lease_connection
        lock_id = self._lease_lock_id
        self._lease_connection = None
        self._lease_lock_id = None
        if connection is None:
            return
        try:
            if lock_id is not None:
                connection.execute(
                    text("SELECT pg_advisory_unlock(:lock_id)"),
                    {"lock_id": lock_id},
                )
                connection.commit()
        except SQLAlchemyError:
            pass
        finally:
            connection.close()

    def close(self) -> None:
        self.release_lease()
        self._engine.dispose()

    def oldest_active_expiration_date(self, *, before: date) -> date | None:
        """Find stale active coverage so downtime cannot strand expired rows."""

        with self.session() as session:
            value = session.execute(
                text(
                    """
                    SELECT min(expiration_date)
                    FROM torghut_options_contract_catalog
                    WHERE status = 'active'
                      AND expiration_date < :before
                    """
                ),
                {"before": before},
            ).scalar_one()
            return cast(date | None, value)

    def prepare_shard(
        self,
        *,
        shard: ArchiveShard,
        query_fingerprint: str,
        observed_at: datetime,
    ) -> ArchiveCheckpoint:
        """Load a resumable shard or reset only that shard when state is unsafe."""

        with self.session() as session, session.begin():
            row = self._select_watermark(session, shard.key, for_update=True)
            checkpoint: ArchiveCheckpoint | None = None
            reset_request: ArchiveResetRequest | None = None
            if row is None:
                reset_request = ArchiveResetRequest(
                    shard=shard,
                    query_fingerprint=query_fingerprint,
                    observed_at=observed_at,
                    reason="new_shard",
                    last_success_at=None,
                )
            else:
                checkpoint = self._checkpoint_from_row(shard, row)
                reset_reason: str | None = None
                if checkpoint.query_fingerprint != query_fingerprint:
                    reset_reason = "query_fingerprint_changed"
                elif checkpoint.status == "complete" and checkpoint.due(observed_at):
                    reset_reason = "refresh_due"
                elif checkpoint.status not in _IN_PROGRESS_STATUSES | {"complete"}:
                    reset_reason = "invalid_status"
                elif checkpoint.status in _IN_PROGRESS_STATUSES:
                    membership_count = self._membership_count(
                        session,
                        shard_key=shard.key,
                        query_fingerprint=query_fingerprint,
                    )
                    if membership_count != checkpoint.seen_count:
                        reset_reason = "membership_count_mismatch"
                if reset_reason is not None:
                    reset_request = ArchiveResetRequest(
                        shard=shard,
                        query_fingerprint=query_fingerprint,
                        observed_at=observed_at,
                        reason=reset_reason,
                        last_success_at=checkpoint.last_success_at,
                    )
            if reset_request is not None:
                result = self._reset_shard(session, reset_request)
            elif checkpoint is not None:
                result = checkpoint
            else:
                raise ArchiveStateError("archive shard preparation produced no state")
            return result

    def reset_shard(
        self,
        *,
        shard: ArchiveShard,
        query_fingerprint: str,
        observed_at: datetime,
        reason: str,
    ) -> ArchiveCheckpoint:
        """Discard only the current shard's partial state."""

        with self.session() as session, session.begin():
            row = self._select_watermark(session, shard.key, for_update=True)
            last_success_at = (
                cast(datetime | None, row.get("last_success_ts"))
                if row is not None
                else None
            )
            return self._reset_shard(
                session,
                ArchiveResetRequest(
                    shard=shard,
                    query_fingerprint=query_fingerprint,
                    observed_at=observed_at,
                    reason=reason,
                    last_success_at=last_success_at,
                ),
            )

    def checkpoint_page(
        self,
        *,
        checkpoint: ArchiveCheckpoint,
        observed_at: datetime,
        contract_symbols: set[str],
        next_cursor: str | None,
    ) -> ArchiveCheckpoint:
        """Atomically persist exact membership and the next provider cursor."""

        normalized_symbols = sorted(
            {symbol.strip().upper() for symbol in contract_symbols if symbol.strip()}
        )
        with self.session() as session, session.begin():
            row = self._select_watermark(session, checkpoint.shard.key, for_update=True)
            if row is None:
                raise ArchiveStateError("archive watermark disappeared during page")
            current = self._checkpoint_from_row(checkpoint.shard, row)
            if current.query_fingerprint != checkpoint.query_fingerprint:
                raise ArchiveStateError("archive query fingerprint changed during page")
            if current.status not in {"running", "retry"}:
                raise ArchiveStateError(
                    f"cannot checkpoint archive page from status {current.status}"
                )
            if next_cursor is not None and next_cursor == current.cursor:
                raise ArchiveStateError("provider repeated the current page cursor")
            if normalized_symbols:
                session.execute(
                    text(
                        f"""
                        INSERT INTO {ARCHIVE_MEMBERSHIP_TABLE} (
                          component,
                          query_fingerprint,
                          shard_key,
                          contract_symbol,
                          observed_at
                        )
                        SELECT :component,
                               :query_fingerprint,
                               :shard_key,
                               symbol,
                               :observed_at
                        FROM unnest(CAST(:contract_symbols AS TEXT[])) AS symbol
                        ON CONFLICT DO NOTHING
                        """
                    ),
                    {
                        "component": ARCHIVE_COMPONENT,
                        "query_fingerprint": checkpoint.query_fingerprint,
                        "shard_key": checkpoint.shard.key,
                        "contract_symbols": normalized_symbols,
                        "observed_at": observed_at,
                    },
                )
            seen_count = self._membership_count(
                session,
                shard_key=checkpoint.shard.key,
                query_fingerprint=checkpoint.query_fingerprint,
            )
            status = "finalizing" if next_cursor is None else "running"
            page_count = current.page_count + 1
            updated = ArchiveCheckpoint(
                shard=checkpoint.shard,
                query_fingerprint=checkpoint.query_fingerprint,
                status=status,
                cursor=next_cursor,
                page_count=page_count,
                seen_count=seen_count,
                retry_count=0,
                next_eligible_at=None,
                last_success_at=current.last_success_at,
            )
            session.execute(
                text(
                    """
                    UPDATE torghut_options_watermarks
                    SET cursor = :cursor,
                        last_event_ts = :observed_at,
                        next_eligible_ts = NULL,
                        retry_count = 0,
                        metadata = CAST(:metadata AS JSONB)
                    WHERE component = :component
                      AND scope_type = :scope_type
                      AND scope_key = :scope_key
                    """
                ),
                {
                    "cursor": next_cursor,
                    "observed_at": observed_at,
                    "metadata": _metadata_json(updated),
                    "component": ARCHIVE_COMPONENT,
                    "scope_type": ARCHIVE_SCOPE_TYPE,
                    "scope_key": checkpoint.shard.key,
                },
            )
            return updated

    def record_failure(
        self,
        *,
        checkpoint: ArchiveCheckpoint,
        observed_at: datetime,
        failure: ArchiveFailure,
    ) -> ArchiveCheckpoint:
        """Retain the current cursor and back off after a bounded failure."""

        with self.session() as session, session.begin():
            row = self._select_watermark(session, checkpoint.shard.key, for_update=True)
            if row is None:
                raise ArchiveStateError(
                    "cannot record failure without archive watermark"
                )
            current = self._checkpoint_from_row(checkpoint.shard, row)
            if current.query_fingerprint != checkpoint.query_fingerprint:
                raise ArchiveStateError("cannot record failure for stale fingerprint")
            retry_count = current.retry_count + 1
            exponent = min(max(retry_count - 1, 0), 10)
            delay_seconds = min(
                failure.retry_base_seconds * (2**exponent),
                failure.retry_max_seconds,
            )
            next_eligible_at = observed_at + timedelta(seconds=delay_seconds)
            failure_status = "finalizing" if current.status == "finalizing" else "retry"
            failed = ArchiveCheckpoint(
                shard=checkpoint.shard,
                query_fingerprint=checkpoint.query_fingerprint,
                status=failure_status,
                cursor=current.cursor,
                page_count=current.page_count,
                seen_count=current.seen_count,
                retry_count=retry_count,
                next_eligible_at=next_eligible_at,
                last_success_at=current.last_success_at,
            )
            session.execute(
                text(
                    """
                    UPDATE torghut_options_watermarks
                    SET last_event_ts = :observed_at,
                        next_eligible_ts = :next_eligible_at,
                        retry_count = :retry_count,
                        metadata = CAST(:metadata AS JSONB)
                    WHERE component = :component
                      AND scope_type = :scope_type
                      AND scope_key = :scope_key
                    """
                ),
                {
                    "observed_at": observed_at,
                    "next_eligible_at": next_eligible_at,
                    "retry_count": retry_count,
                    "metadata": _metadata_json(
                        failed,
                        extra={
                            "last_error_code": failure.error_code[:100],
                            "last_error_detail": failure.error_detail[:500],
                        },
                    ),
                    "component": ARCHIVE_COMPONENT,
                    "scope_type": ARCHIVE_SCOPE_TYPE,
                    "scope_key": checkpoint.shard.key,
                },
            )
            return failed

    def finalize_shard(
        self,
        *,
        checkpoint: ArchiveCheckpoint,
        observed_at: datetime,
        refresh_seconds: int,
    ) -> ArchiveCompletion:
        """Apply missing transitions only after exact shard membership is complete."""

        shard = checkpoint.shard
        query_fingerprint = checkpoint.query_fingerprint
        with self.session() as session, session.begin():
            row = self._select_watermark(session, shard.key, for_update=True)
            if row is None:
                raise ArchiveStateError("cannot finalize missing archive watermark")
            current = self._checkpoint_from_row(shard, row)
            if current.query_fingerprint != query_fingerprint:
                raise ArchiveStateError("cannot finalize stale archive fingerprint")
            if current.status != "finalizing":
                raise ArchiveStateError(
                    f"cannot finalize archive shard from status {current.status}"
                )
            membership_count = self._membership_count(
                session,
                shard_key=shard.key,
                query_fingerprint=query_fingerprint,
            )
            if membership_count != current.seen_count:
                raise ArchiveStateError(
                    "archive membership count changed before finalize"
                )
            active_count = _as_int(
                session.execute(
                    text(
                        """
                        SELECT count(*)
                        FROM torghut_options_contract_catalog
                        WHERE status = 'active'
                          AND expiration_date BETWEEN :start_date AND :end_date
                        """
                    ),
                    {"start_date": shard.start, "end_date": shard.end},
                ).scalar_one()
            )
            if (
                membership_count == 0
                and active_count > 0
                and shard.end >= observed_at.date()
            ):
                raise ArchiveStateError(
                    "refusing empty archive result for a nonempty active shard"
                )
            transition_result = cast(
                CursorResult[object],
                session.execute(
                    text(
                        f"""
                    UPDATE torghut_options_contract_catalog AS catalog
                    SET status = CASE
                          WHEN catalog.expiration_date < CAST(:observed_at AS DATE)
                            THEN 'expired'
                          ELSE 'inactive'
                        END,
                        last_seen_ts = :observed_at
                    WHERE catalog.status = 'active'
                      AND catalog.expiration_date BETWEEN :start_date AND :end_date
                      AND NOT EXISTS (
                        SELECT 1
                        FROM {ARCHIVE_MEMBERSHIP_TABLE} AS membership
                        WHERE membership.component = :component
                          AND membership.query_fingerprint = :query_fingerprint
                          AND membership.shard_key = :shard_key
                          AND membership.contract_symbol = catalog.contract_symbol
                      )
                        """
                    ),
                    {
                        "observed_at": observed_at,
                        "start_date": shard.start,
                        "end_date": shard.end,
                        "component": ARCHIVE_COMPONENT,
                        "query_fingerprint": query_fingerprint,
                        "shard_key": shard.key,
                    },
                ),
            )
            transitioned_count = max(transition_result.rowcount or 0, 0)
            next_eligible_at = observed_at + timedelta(seconds=refresh_seconds)
            completed = ArchiveCheckpoint(
                shard=shard,
                query_fingerprint=query_fingerprint,
                status="complete",
                cursor=None,
                page_count=current.page_count,
                seen_count=current.seen_count,
                retry_count=0,
                next_eligible_at=next_eligible_at,
                last_success_at=observed_at,
            )
            session.execute(
                text(
                    """
                    UPDATE torghut_options_watermarks
                    SET cursor = NULL,
                        last_event_ts = :observed_at,
                        last_success_ts = :observed_at,
                        next_eligible_ts = :next_eligible_at,
                        retry_count = 0,
                        metadata = CAST(:metadata AS JSONB)
                    WHERE component = :component
                      AND scope_type = :scope_type
                      AND scope_key = :scope_key
                    """
                ),
                {
                    "observed_at": observed_at,
                    "next_eligible_at": next_eligible_at,
                    "metadata": _metadata_json(
                        completed,
                        extra={"transitioned_count": transitioned_count},
                    ),
                    "component": ARCHIVE_COMPONENT,
                    "scope_type": ARCHIVE_SCOPE_TYPE,
                    "scope_key": shard.key,
                },
            )
            self._delete_membership(session, shard_key=shard.key)
            return ArchiveCompletion(
                checkpoint=completed,
                transitioned_count=transitioned_count,
            )

    def _select_watermark(
        self, session: Session, shard_key: str, *, for_update: bool
    ) -> Mapping[str, object] | None:
        suffix = " FOR UPDATE" if for_update else ""
        row = (
            session.execute(
                text(
                    """
                    SELECT cursor,
                           last_success_ts,
                           next_eligible_ts,
                           retry_count,
                           metadata
                    FROM torghut_options_watermarks
                    WHERE component = :component
                      AND scope_type = :scope_type
                      AND scope_key = :scope_key
                    """
                    + suffix
                ),
                {
                    "component": ARCHIVE_COMPONENT,
                    "scope_type": ARCHIVE_SCOPE_TYPE,
                    "scope_key": shard_key,
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            return None
        return {str(key): value for key, value in row.items()}

    def _reset_shard(
        self,
        session: Session,
        request: ArchiveResetRequest,
    ) -> ArchiveCheckpoint:
        reset = ArchiveCheckpoint(
            shard=request.shard,
            query_fingerprint=request.query_fingerprint,
            status="running",
            cursor=None,
            page_count=0,
            seen_count=0,
            retry_count=0,
            next_eligible_at=None,
            last_success_at=request.last_success_at,
        )
        self._delete_membership(session, shard_key=request.shard.key)
        session.execute(
            text(
                """
                INSERT INTO torghut_options_watermarks (
                  component,
                  scope_type,
                  scope_key,
                  cursor,
                  last_event_ts,
                  last_success_ts,
                  next_eligible_ts,
                  retry_count,
                  metadata
                ) VALUES (
                  :component,
                  :scope_type,
                  :scope_key,
                  NULL,
                  :observed_at,
                  :last_success_at,
                  NULL,
                  0,
                  CAST(:metadata AS JSONB)
                )
                ON CONFLICT (component, scope_type, scope_key) DO UPDATE
                SET cursor = NULL,
                    last_event_ts = EXCLUDED.last_event_ts,
                    next_eligible_ts = NULL,
                    retry_count = 0,
                    metadata = EXCLUDED.metadata
                """
            ),
            {
                "component": ARCHIVE_COMPONENT,
                "scope_type": ARCHIVE_SCOPE_TYPE,
                "scope_key": request.shard.key,
                "observed_at": request.observed_at,
                "last_success_at": request.last_success_at,
                "metadata": _metadata_json(
                    reset,
                    extra={"reset_reason": request.reason[:100]},
                ),
            },
        )
        return reset

    def _membership_count(
        self,
        session: Session,
        *,
        shard_key: str,
        query_fingerprint: str,
    ) -> int:
        return _as_int(
            session.execute(
                text(
                    f"""
                    SELECT count(*)
                    FROM {ARCHIVE_MEMBERSHIP_TABLE}
                    WHERE component = :component
                      AND query_fingerprint = :query_fingerprint
                      AND shard_key = :shard_key
                    """
                ),
                {
                    "component": ARCHIVE_COMPONENT,
                    "query_fingerprint": query_fingerprint,
                    "shard_key": shard_key,
                },
            ).scalar_one()
        )

    def _delete_membership(self, session: Session, *, shard_key: str) -> None:
        session.execute(
            text(
                f"""
                DELETE FROM {ARCHIVE_MEMBERSHIP_TABLE}
                WHERE component = :component
                  AND shard_key = :shard_key
                """
            ),
            {"component": ARCHIVE_COMPONENT, "shard_key": shard_key},
        )

    @staticmethod
    def _checkpoint_from_row(
        shard: ArchiveShard, row: Mapping[str, object]
    ) -> ArchiveCheckpoint:
        metadata = _metadata(row.get("metadata"))
        return ArchiveCheckpoint(
            shard=shard,
            query_fingerprint=str(metadata.get("query_fingerprint") or ""),
            status=str(metadata.get("status") or "invalid"),
            cursor=(
                str(row["cursor"])
                if row.get("cursor") is not None and str(row["cursor"]).strip()
                else None
            ),
            page_count=_as_int(metadata.get("page_count")),
            seen_count=_as_int(metadata.get("seen_count")),
            retry_count=_as_int(row.get("retry_count")),
            next_eligible_at=cast(datetime | None, row.get("next_eligible_ts")),
            last_success_at=cast(datetime | None, row.get("last_success_ts")),
        )
