from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager, nullcontext
from datetime import UTC, date, datetime, timedelta
import threading
from types import SimpleNamespace
from typing import cast
from unittest.mock import MagicMock, patch
from urllib.request import Request

import pytest
from sqlalchemy.orm import Session
from sqlalchemy.sql import Executable

from app.options_lane.alpaca import AlpacaOptionsClient, OptionsContractsQuery
from app.options_lane.archive_model import (
    ArchiveShard,
    archive_query_fingerprint,
    archive_shards,
)
from app.options_lane.archive_repository import (
    ArchiveCheckpoint,
    ArchiveFailure,
    ArchiveLeaseLostError,
    ArchiveStateError,
    OptionsArchiveRepository,
)
from app.options_lane.archive_state import (
    ArchiveRuntimeState,
    ArchiveStateUpdate,
    archive_is_ready,
)
from app.options_lane.archive_worker import OptionsArchiveWorker
from app.options_lane.repository import OptionsRepository
from app.options_lane.settings import OptionsLaneSettings


class _Result:
    def __init__(
        self,
        *,
        scalar: object = 0,
        rowcount: int = 0,
        rows: list[dict[str, object]] | None = None,
    ) -> None:
        self._scalar = scalar
        self.rowcount = rowcount
        self._rows = rows or []

    def scalar_one(self) -> object:
        return self._scalar

    def mappings(self) -> _Result:
        return self

    def all(self) -> list[dict[str, object]]:
        return self._rows


class _ArchiveSession:
    def __init__(
        self,
        *,
        active_count: int = 0,
        transition_count: int = 0,
        candidate_rows: list[dict[str, object]] | None = None,
    ) -> None:
        self.active_count = active_count
        self.transition_count = transition_count
        self.candidate_rows = candidate_rows or []
        self.calls: list[tuple[str, object]] = []

    def begin(self) -> object:
        return nullcontext()

    def execute(self, statement: object, parameters: object = None) -> _Result:
        sql = str(statement)
        self.calls.append((sql, parameters))
        if "SELECT EXISTS" in sql and "contract_catalog" in sql:
            return _Result(scalar=self.active_count > 0)
        if "SELECT catalog.expiration_date" in sql:
            return _Result(rows=self.candidate_rows)
        if "UPDATE torghut_options_contract_catalog" in sql:
            return _Result(rowcount=self.transition_count)
        return _Result()


class _ArchiveRepository(OptionsArchiveRepository):
    def __init__(
        self,
        *,
        row: Mapping[str, object],
        membership_count: int,
        session: _ArchiveSession | None = None,
        lease_healthy: bool = True,
    ) -> None:
        self.row = row
        self.membership_count = membership_count
        self.fake_session = session or _ArchiveSession()
        self.lease_is_healthy = lease_healthy

    @contextmanager
    def session(self) -> Iterator[Session]:
        yield cast(Session, self.fake_session)

    def _select_watermark(
        self, session: Session, shard_key: str, *, for_update: bool
    ) -> Mapping[str, object] | None:
        del session, shard_key, for_update
        return self.row

    def _membership_count(
        self,
        session: Session,
        *,
        shard_key: str,
        query_fingerprint: str,
    ) -> int:
        del session, shard_key, query_fingerprint
        return self.membership_count

    def lease_healthy(self) -> bool:
        return self.lease_is_healthy

    def _execute_cancellable(
        self,
        session: Session,
        statement: Executable,
        parameters: Mapping[str, object] | None = None,
    ) -> object:
        return cast(_ArchiveSession, session).execute(statement, parameters)


class _SequencedLeaseRepository:
    def __init__(self, lease_results: list[bool]) -> None:
        self.lease_results = lease_results

    def require_lease(self) -> None:
        if not self.lease_results.pop(0):
            raise ArchiveLeaseLostError("archive lease lost during provider request")


class _ArchiveCatalogRepository:
    def __init__(self) -> None:
        self.sync_calls = 0

    @staticmethod
    def acquire_rate_bucket(
        bucket_name: str, refill_per_second: float, burst_capacity: int
    ) -> bool:
        del bucket_name, refill_per_second, burst_capacity
        return True

    def sync_contract_catalog_page(
        self,
        contracts: list[dict[str, object]],
        *,
        observed_at: datetime,
    ) -> list[dict[str, object]]:
        del contracts, observed_at
        self.sync_calls += 1
        return []


class _ArchiveClient:
    def __init__(self) -> None:
        self.calls = 0

    def list_archive_contracts(
        self, *, query: OptionsContractsQuery
    ) -> tuple[list[dict[str, object]], None]:
        del query
        self.calls += 1
        return [], None


class _Response:
    status = 200

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    @staticmethod
    def read() -> bytes:
        return b'{"option_contracts":[],"next_page_token":null}'


def _shard() -> ArchiveShard:
    return ArchiveShard(start=date(2026, 7, 13), end=date(2026, 7, 19))


def _watermark_row(
    *,
    fingerprint: str,
    status: str,
    cursor: str | None = None,
    page_count: int = 0,
    seen_count: int = 0,
    retry_count: int = 0,
    next_eligible_ts: datetime | None = None,
    finalize_after_expiration_date: date | None = None,
    finalize_after_contract_symbol: str | None = None,
    transitioned_count: int = 0,
) -> dict[str, object]:
    return {
        "cursor": cursor,
        "last_success_ts": None,
        "next_eligible_ts": next_eligible_ts,
        "retry_count": retry_count,
        "metadata": {
            "query_fingerprint": fingerprint,
            "status": status,
            "page_count": page_count,
            "seen_count": seen_count,
            "finalize_after_expiration_date": (
                finalize_after_expiration_date.isoformat()
                if finalize_after_expiration_date is not None
                else None
            ),
            "finalize_after_contract_symbol": finalize_after_contract_symbol,
            "transitioned_count": transitioned_count,
        },
    }


def test_archive_shards_are_stable_calendar_weeks() -> None:
    shards = archive_shards(
        today=date(2026, 7, 15),
        horizon_days=10,
        coverage_start=date(2026, 7, 8),
    )

    assert shards == (
        ArchiveShard(start=date(2026, 7, 6), end=date(2026, 7, 12)),
        ArchiveShard(start=date(2026, 7, 13), end=date(2026, 7, 19)),
        ArchiveShard(start=date(2026, 7, 20), end=date(2026, 7, 26)),
    )
    assert shards[0].key == "2026-07-06/2026-07-12"


def test_archive_query_fingerprint_covers_shard_and_limit() -> None:
    first = archive_query_fingerprint(shard=_shard(), page_limit=10_000)

    assert len(first) == 64
    assert first == archive_query_fingerprint(shard=_shard(), page_limit=10_000)
    assert first != archive_query_fingerprint(shard=_shard(), page_limit=9_999)


def test_archive_client_allows_unbounded_underlyings_only_for_bounded_dates() -> None:
    client = AlpacaOptionsClient(
        key_id="key",
        secret_key="secret",
        contracts_base_url="https://paper-api.alpaca.markets",
        data_base_url="https://data.alpaca.markets",
        feed="indicative",
    )
    captured: list[Request] = []

    def _urlopen(request: Request, *, timeout: int) -> _Response:
        assert timeout == 30
        captured.append(request)
        return _Response()

    with patch("app.options_lane.alpaca.urlopen", side_effect=_urlopen):
        rows, cursor = client.list_archive_contracts(
            query=OptionsContractsQuery(
                status="active",
                limit=10_000,
                expiration_date_gte=date(2026, 7, 13),
                expiration_date_lte=date(2026, 7, 19),
            )
        )

    assert rows == []
    assert cursor is None
    assert len(captured) == 1
    assert "expiration_date_gte=2026-07-13" in captured[0].full_url
    assert "expiration_date_lte=2026-07-19" in captured[0].full_url
    assert "underlying_symbols=" not in captured[0].full_url

    with pytest.raises(ValueError, match="one to seven days"):
        client.list_archive_contracts(
            query=OptionsContractsQuery(
                status="active",
                limit=10_000,
                expiration_date_gte=date(2026, 7, 13),
                expiration_date_lte=date(2026, 7, 20),
            )
        )


def test_prepare_resets_only_current_shard_after_unlogged_membership_loss() -> None:
    fingerprint = archive_query_fingerprint(shard=_shard(), page_limit=10_000)
    session = _ArchiveSession()
    repository = _ArchiveRepository(
        row=_watermark_row(
            fingerprint=fingerprint,
            status="running",
            cursor="page-3",
            page_count=3,
            seen_count=20_000,
        ),
        membership_count=0,
        session=session,
    )

    checkpoint = repository.prepare_shard(
        shard=_shard(),
        query_fingerprint=fingerprint,
        observed_at=datetime(2026, 7, 14, 12, tzinfo=UTC),
    )

    assert checkpoint.status == "running"
    assert checkpoint.cursor is None
    assert checkpoint.page_count == 0
    assert checkpoint.seen_count == 0
    delete_sql, delete_parameters = session.calls[0]
    assert "DELETE FROM torghut_options_archive_membership" in delete_sql
    assert delete_parameters == {
        "component": "catalog_archive",
        "shard_key": _shard().key,
    }
    assert "membership_count_mismatch" in str(session.calls[1][1])


def test_repository_fails_closed_when_archive_lease_is_lost() -> None:
    repository = _ArchiveRepository(
        row={},
        membership_count=0,
        lease_healthy=False,
    )

    with pytest.raises(ArchiveLeaseLostError, match="advisory lock"):
        repository.require_lease()


def test_worker_does_not_write_page_after_lease_loss() -> None:
    archive_repository = _SequencedLeaseRepository([True, False])
    catalog_repository = _ArchiveCatalogRepository()
    client = _ArchiveClient()
    worker = OptionsArchiveWorker(
        settings=cast(
            OptionsLaneSettings,
            SimpleNamespace(
                options_contract_archive_page_limit=10_000,
                options_contract_archive_requests_per_second=0.1,
            ),
        ),
        archive_repository=cast(OptionsArchiveRepository, archive_repository),
        catalog_repository=cast(OptionsRepository, catalog_repository),
        client=cast(AlpacaOptionsClient, client),
        state=ArchiveRuntimeState(),
        stop_event=threading.Event(),
        now=lambda: datetime(2026, 7, 14, 12, tzinfo=UTC),
    )
    checkpoint = ArchiveCheckpoint(
        shard=_shard(),
        query_fingerprint=archive_query_fingerprint(shard=_shard(), page_limit=10_000),
        status="running",
        cursor=None,
        page_count=0,
        seen_count=0,
        retry_count=0,
        next_eligible_at=None,
        last_success_at=None,
    )

    with pytest.raises(ArchiveLeaseLostError, match="during provider request"):
        worker._scan_pages(checkpoint)

    assert client.calls == 1
    assert catalog_repository.sync_calls == 0


def test_worker_records_known_archive_state_failure() -> None:
    checkpoint = ArchiveCheckpoint(
        shard=_shard(),
        query_fingerprint=archive_query_fingerprint(shard=_shard(), page_limit=10_000),
        status="running",
        cursor=None,
        page_count=0,
        seen_count=0,
        retry_count=0,
        next_eligible_at=None,
        last_success_at=None,
    )
    archive_repository = MagicMock(spec=OptionsArchiveRepository)
    archive_repository.prepare_shard.return_value = checkpoint
    worker = OptionsArchiveWorker(
        settings=cast(
            OptionsLaneSettings,
            SimpleNamespace(options_contract_archive_page_limit=10_000),
        ),
        archive_repository=archive_repository,
        catalog_repository=MagicMock(spec=OptionsRepository),
        client=MagicMock(spec=AlpacaOptionsClient),
        state=ArchiveRuntimeState(),
        stop_event=threading.Event(),
        now=lambda: datetime(2026, 7, 14, 12, tzinfo=UTC),
    )

    with (
        patch.object(
            worker,
            "_scan_pages",
            side_effect=ArchiveStateError("invalid archive page"),
        ),
        patch.object(
            worker, "_record_failure", return_value=checkpoint
        ) as record_failure,
    ):
        result = worker._process_shard(_shard())

    assert result == checkpoint
    record_failure.assert_called_once_with(
        checkpoint,
        error_code="archive_shard_failed",
        error_detail="invalid archive page",
    )


def test_worker_does_not_swallow_unexpected_programming_error() -> None:
    checkpoint = ArchiveCheckpoint(
        shard=_shard(),
        query_fingerprint=archive_query_fingerprint(shard=_shard(), page_limit=10_000),
        status="running",
        cursor=None,
        page_count=0,
        seen_count=0,
        retry_count=0,
        next_eligible_at=None,
        last_success_at=None,
    )
    archive_repository = MagicMock(spec=OptionsArchiveRepository)
    archive_repository.prepare_shard.return_value = checkpoint
    worker = OptionsArchiveWorker(
        settings=cast(
            OptionsLaneSettings,
            SimpleNamespace(options_contract_archive_page_limit=10_000),
        ),
        archive_repository=archive_repository,
        catalog_repository=MagicMock(spec=OptionsRepository),
        client=MagicMock(spec=AlpacaOptionsClient),
        state=ArchiveRuntimeState(),
        stop_event=threading.Event(),
        now=lambda: datetime(2026, 7, 14, 12, tzinfo=UTC),
    )

    with (
        patch.object(
            worker, "_scan_pages", side_effect=RuntimeError("programming defect")
        ),
        pytest.raises(RuntimeError, match="programming defect"),
    ):
        worker._process_shard(_shard())


def test_page_checkpoint_persists_exact_membership_and_next_cursor() -> None:
    fingerprint = archive_query_fingerprint(shard=_shard(), page_limit=10_000)
    session = _ArchiveSession()
    repository = _ArchiveRepository(
        row=_watermark_row(
            fingerprint=fingerprint,
            status="running",
            cursor="page-2",
            page_count=2,
            seen_count=2,
        ),
        membership_count=4,
        session=session,
    )

    checkpoint = repository.checkpoint_page(
        checkpoint=ArchiveCheckpoint(
            shard=_shard(),
            query_fingerprint=fingerprint,
            status="running",
            cursor="page-2",
            page_count=2,
            seen_count=2,
            retry_count=0,
            next_eligible_at=None,
            last_success_at=None,
        ),
        observed_at=datetime(2026, 7, 14, 12, tzinfo=UTC),
        contract_symbols={"msft-contract", "AAPL-CONTRACT", "aapl-contract"},
        next_cursor="page-3",
    )

    assert checkpoint.status == "running"
    assert checkpoint.cursor == "page-3"
    assert checkpoint.page_count == 3
    assert checkpoint.seen_count == 4
    insert_sql, insert_parameters = session.calls[0]
    assert "ON CONFLICT DO NOTHING" in insert_sql
    assert isinstance(insert_parameters, dict)
    assert insert_parameters["contract_symbols"] == [
        "AAPL-CONTRACT",
        "MSFT-CONTRACT",
    ]


def test_record_failure_retains_cursor_and_caps_exponential_backoff() -> None:
    fingerprint = archive_query_fingerprint(shard=_shard(), page_limit=10_000)
    observed_at = datetime(2026, 7, 14, 12, tzinfo=UTC)
    session = _ArchiveSession()
    repository = _ArchiveRepository(
        row=_watermark_row(
            fingerprint=fingerprint,
            status="running",
            cursor="page-4",
            page_count=4,
            seen_count=30_000,
            retry_count=3,
        ),
        membership_count=30_000,
        session=session,
    )

    failed = repository.record_failure(
        checkpoint=ArchiveCheckpoint(
            shard=_shard(),
            query_fingerprint=fingerprint,
            status="running",
            cursor="page-4",
            page_count=4,
            seen_count=30_000,
            retry_count=3,
            next_eligible_at=None,
            last_success_at=None,
        ),
        observed_at=observed_at,
        failure=ArchiveFailure(
            error_code="provider_timeout",
            error_detail="request timed out",
            retry_base_seconds=10,
            retry_max_seconds=30,
        ),
    )

    assert failed.status == "retry"
    assert failed.cursor == "page-4"
    assert failed.retry_count == 4
    assert failed.next_eligible_at == observed_at + timedelta(seconds=30)
    update_sql, update_parameters = session.calls[-1]
    assert "UPDATE torghut_options_watermarks" in update_sql
    assert isinstance(update_parameters, dict)
    assert update_parameters["retry_count"] == 4
    assert "provider_timeout" in str(update_parameters["metadata"])


def test_finalize_scans_one_bounded_batch_and_persists_cursor() -> None:
    fingerprint = archive_query_fingerprint(shard=_shard(), page_limit=10_000)
    session = _ArchiveSession(
        active_count=3,
        transition_count=1,
        candidate_rows=[
            {
                "expiration_date": date(2026, 7, 14),
                "contract_symbol": "AAPL-CONTRACT",
            },
            {
                "expiration_date": date(2026, 7, 15),
                "contract_symbol": "MSFT-CONTRACT",
            },
        ],
    )
    repository = _ArchiveRepository(
        row=_watermark_row(
            fingerprint=fingerprint,
            status="finalizing",
            page_count=2,
            seen_count=2,
        ),
        membership_count=2,
        session=session,
    )

    completion = repository.finalize_shard(
        checkpoint=ArchiveCheckpoint(
            shard=_shard(),
            query_fingerprint=fingerprint,
            status="finalizing",
            cursor=None,
            page_count=2,
            seen_count=2,
            retry_count=0,
            next_eligible_at=None,
            last_success_at=None,
        ),
        observed_at=datetime(2026, 7, 14, 12, tzinfo=UTC),
        refresh_seconds=86400,
        batch_size=1000,
        statement_timeout_ms=30000,
        lock_timeout_ms=5000,
    )

    assert completion.transitioned_count == 1
    assert completion.batch_scanned_count == 2
    assert completion.batch_transitioned_count == 1
    assert completion.checkpoint.status == "finalizing"
    assert completion.checkpoint.finalize_after_expiration_date == date(2026, 7, 15)
    assert completion.checkpoint.finalize_after_contract_symbol == "MSFT-CONTRACT"
    candidate_sql = next(
        sql for sql, _ in session.calls if "SELECT catalog.expiration_date" in sql
    )
    assert "LIMIT :batch_size" in candidate_sql
    assert "ORDER BY catalog.expiration_date, catalog.contract_symbol" in candidate_sql
    transition_sql = next(
        sql
        for sql, _ in session.calls
        if "UPDATE torghut_options_contract_catalog" in sql
    )
    assert "CAST(:candidate_symbols AS TEXT[])" in transition_sql
    assert "membership.query_fingerprint = :query_fingerprint" in transition_sql
    assert "membership.shard_key = :shard_key" in transition_sql
    assert not any(
        "DELETE FROM torghut_options_archive_membership" in sql
        for sql, _ in session.calls
    )


def test_finalize_completes_only_after_the_cursor_exhausts_candidates() -> None:
    fingerprint = archive_query_fingerprint(shard=_shard(), page_limit=10_000)
    session = _ArchiveSession(active_count=3)
    repository = _ArchiveRepository(
        row=_watermark_row(
            fingerprint=fingerprint,
            status="finalizing",
            page_count=2,
            seen_count=2,
            finalize_after_expiration_date=date(2026, 7, 15),
            finalize_after_contract_symbol="MSFT-CONTRACT",
            transitioned_count=1,
        ),
        membership_count=2,
        session=session,
    )

    completion = repository.finalize_shard(
        checkpoint=ArchiveCheckpoint(
            shard=_shard(),
            query_fingerprint=fingerprint,
            status="finalizing",
            cursor=None,
            page_count=2,
            seen_count=2,
            retry_count=0,
            next_eligible_at=None,
            last_success_at=None,
        ),
        observed_at=datetime(2026, 7, 14, 12, tzinfo=UTC),
        refresh_seconds=86400,
        batch_size=1000,
        statement_timeout_ms=30000,
        lock_timeout_ms=5000,
    )

    assert completion.checkpoint.status == "complete"
    assert completion.transitioned_count == 1
    candidate_sql = next(
        sql for sql, _ in session.calls if "SELECT catalog.expiration_date" in sql
    )
    assert ":after_expiration_date" in candidate_sql
    assert "DELETE FROM torghut_options_archive_membership" in session.calls[-1][0]


def test_finalize_rejects_empty_result_for_nonempty_active_shard() -> None:
    fingerprint = archive_query_fingerprint(shard=_shard(), page_limit=10_000)
    repository = _ArchiveRepository(
        row=_watermark_row(
            fingerprint=fingerprint,
            status="finalizing",
            page_count=1,
            seen_count=0,
        ),
        membership_count=0,
        session=_ArchiveSession(active_count=1),
    )

    with pytest.raises(ArchiveStateError, match="nonempty active shard"):
        repository.finalize_shard(
            checkpoint=ArchiveCheckpoint(
                shard=_shard(),
                query_fingerprint=fingerprint,
                status="finalizing",
                cursor=None,
                page_count=1,
                seen_count=0,
                retry_count=0,
                next_eligible_at=None,
                last_success_at=None,
            ),
            observed_at=datetime(2026, 7, 14, 12, tzinfo=UTC),
            refresh_seconds=86400,
            batch_size=1000,
            statement_timeout_ms=30000,
            lock_timeout_ms=5000,
        )


def test_finalize_allows_empty_completed_shard_after_every_contract_expired() -> None:
    shard = ArchiveShard(start=date(2026, 7, 6), end=date(2026, 7, 12))
    fingerprint = archive_query_fingerprint(shard=shard, page_limit=10_000)
    repository = _ArchiveRepository(
        row=_watermark_row(
            fingerprint=fingerprint,
            status="finalizing",
            page_count=1,
            seen_count=0,
        ),
        membership_count=0,
        session=_ArchiveSession(active_count=3),
    )
    repository.row = _watermark_row(
        fingerprint=fingerprint,
        status="finalizing",
        page_count=1,
        seen_count=0,
        finalize_after_expiration_date=date(2026, 7, 12),
        finalize_after_contract_symbol="ZZZ-CONTRACT",
        transitioned_count=3,
    )

    completion = repository.finalize_shard(
        checkpoint=ArchiveCheckpoint(
            shard=shard,
            query_fingerprint=fingerprint,
            status="finalizing",
            cursor=None,
            page_count=1,
            seen_count=0,
            retry_count=0,
            next_eligible_at=None,
            last_success_at=None,
        ),
        observed_at=datetime(2026, 7, 14, 12, tzinfo=UTC),
        refresh_seconds=86400,
        batch_size=1000,
        statement_timeout_ms=30000,
        lock_timeout_ms=5000,
    )

    assert completion.transitioned_count == 3
    assert completion.checkpoint.status == "complete"


def test_archive_readiness_requires_healthy_singleton_lease() -> None:
    runtime_state = ArchiveRuntimeState()
    runtime_state.update(
        ArchiveStateUpdate(
            phase="running",
            observed_at=datetime(2026, 7, 14, 12, tzinfo=UTC),
            lease_acquired=True,
        )
    )

    assert archive_is_ready(runtime_state.snapshot())


def test_archive_retry_remains_live_but_not_ready() -> None:
    runtime_state = ArchiveRuntimeState()
    runtime_state.update(
        ArchiveStateUpdate(
            phase="retry",
            observed_at=datetime(2026, 7, 14, 12, tzinfo=UTC),
            lease_acquired=True,
            error_code="429",
            error_detail="rate limited",
        )
    )

    assert not archive_is_ready(runtime_state.snapshot())
