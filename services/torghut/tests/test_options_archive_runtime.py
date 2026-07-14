from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
import importlib
from types import ModuleType, SimpleNamespace
import sys
import threading
from typing import cast
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
import pytest

from app.options_lane.alpaca import AlpacaApiError, AlpacaOptionsClient
from app.options_lane.archive_model import ArchiveShard, archive_query_fingerprint
from app.options_lane.archive_repository import (
    ArchiveCheckpoint,
    ArchiveCompletion,
    ArchiveStateError,
    OptionsArchiveRepository,
    _as_int,
    _metadata,
    archive_advisory_lock_id,
)
from app.options_lane.archive_state import ArchiveRuntimeState, ArchiveStateUpdate
from app.options_lane.archive_worker import (
    OptionsArchiveWorker,
    _normalize_archive_page,
)
from app.options_lane.repository import OptionsRepository
from app.options_lane.settings import OptionsLaneSettings


NOW = datetime(2026, 7, 14, 12, tzinfo=UTC)


def _shard() -> ArchiveShard:
    return ArchiveShard(start=date(2026, 7, 13), end=date(2026, 7, 19))


def _checkpoint(
    *,
    status: str = "running",
    cursor: str | None = None,
    next_eligible_at: datetime | None = None,
    retry_count: int = 0,
) -> ArchiveCheckpoint:
    shard = _shard()
    return ArchiveCheckpoint(
        shard=shard,
        query_fingerprint=archive_query_fingerprint(shard=shard, page_limit=10_000),
        status=status,
        cursor=cursor,
        page_count=1,
        seen_count=1,
        retry_count=retry_count,
        next_eligible_at=next_eligible_at,
        last_success_at=None,
    )


def _settings(**overrides: object) -> OptionsLaneSettings:
    values: dict[str, object] = {
        "options_contract_archive_horizon_days": 730,
        "options_contract_archive_lock_name": "archive-lock",
        "options_contract_archive_page_limit": 10_000,
        "options_contract_archive_refresh_sec": 86_400,
        "options_contract_archive_finalize_batch_size": 1_000,
        "options_contract_archive_finalize_interval_ms": 0,
        "options_contract_archive_statement_timeout_ms": 30_000,
        "options_contract_archive_lock_timeout_ms": 5_000,
        "options_contract_archive_requests_per_second": 0.1,
        "options_contract_archive_retry_base_sec": 30,
        "options_contract_archive_retry_max_sec": 900,
    }
    values.update(overrides)
    return cast(OptionsLaneSettings, SimpleNamespace(**values))


def _worker(
    *,
    archive_repository: OptionsArchiveRepository | None = None,
    catalog_repository: OptionsRepository | None = None,
    client: AlpacaOptionsClient | None = None,
    state: ArchiveRuntimeState | None = None,
    stop_event: threading.Event | None = None,
    settings: OptionsLaneSettings | None = None,
) -> OptionsArchiveWorker:
    return OptionsArchiveWorker(
        settings=settings or _settings(),
        archive_repository=archive_repository
        or MagicMock(spec=OptionsArchiveRepository),
        catalog_repository=catalog_repository or MagicMock(spec=OptionsRepository),
        client=client or MagicMock(spec=AlpacaOptionsClient),
        state=state or ArchiveRuntimeState(),
        stop_event=stop_event or threading.Event(),
        now=lambda: NOW,
    )


def test_normalize_archive_page_sorts_and_validates_provider_rows() -> None:
    rows = _normalize_archive_page(
        [
            {"symbol": "MSFT260717C00300000", "expiration_date": "2026-07-17"},
            {"symbol": "AAPL260717C00200000", "expiration_date": "2026-07-17"},
        ],
        shard=_shard(),
        observed_at=NOW,
    )

    assert [row["contract_symbol"] for row in rows] == [
        "AAPL260717C00200000",
        "MSFT260717C00300000",
    ]

    with pytest.raises(ArchiveStateError, match="missing contract symbol"):
        _normalize_archive_page([{}], shard=_shard(), observed_at=NOW)

    with pytest.raises(ArchiveStateError, match="out-of-shard"):
        _normalize_archive_page(
            [{"symbol": "AAPL260724C00200000", "expiration_date": "2026-07-24"}],
            shard=_shard(),
            observed_at=NOW,
        )


def test_archive_repository_helpers_are_stable_and_fail_closed() -> None:
    assert archive_advisory_lock_id("archive-lock") == archive_advisory_lock_id(
        "archive-lock"
    )
    assert _metadata({"status": "running"}) == {"status": "running"}
    assert _metadata('{"status":"complete"}') == {"status": "complete"}
    assert _metadata("not-json") == {}
    assert _metadata("[]") == {}
    assert _as_int("12") == 12
    assert _as_int("invalid", default=7) == 7


def test_archive_repository_constructs_and_disposes_without_opening_a_connection() -> (
    None
):
    repository = OptionsArchiveRepository(
        "postgresql+psycopg://unused:unused@localhost/unused"
    )

    repository.close()


def test_archive_repository_cancels_the_inflight_driver_statement() -> None:
    repository = OptionsArchiveRepository(
        "postgresql+psycopg://unused:unused@localhost/unused"
    )
    driver_connection = MagicMock()
    repository._active_driver_connection = driver_connection

    assert repository.cancel_active_work()

    driver_connection.cancel_safe.assert_called_once_with(timeout=5.0)
    repository._active_driver_connection = None
    repository.close()


def test_run_pass_processes_every_shard_and_bounds_idle_time() -> None:
    repository = MagicMock(spec=OptionsArchiveRepository)
    repository.oldest_active_expiration_date.return_value = date(2026, 7, 1)
    worker = _worker(archive_repository=repository)
    first = ArchiveShard(start=date(2026, 6, 30), end=date(2026, 7, 6))
    second = _shard()
    later = _checkpoint(next_eligible_at=NOW + timedelta(seconds=420))
    sooner = _checkpoint(next_eligible_at=NOW + timedelta(seconds=120))

    with (
        patch(
            "app.options_lane.archive_worker.archive_shards",
            return_value=(first, second),
        ) as shards,
        patch.object(worker, "_process_shard", side_effect=(later, sooner)) as process,
    ):
        idle_seconds = worker.run_pass()

    assert idle_seconds == 120
    repository.oldest_active_expiration_date.assert_called_once_with(before=NOW.date())
    shards.assert_called_once_with(
        today=NOW.date(),
        horizon_days=730,
        coverage_start=date(2026, 7, 1),
    )
    assert [call.args[0] for call in process.call_args_list] == [first, second]


def test_run_pass_uses_max_idle_when_no_checkpoint_has_a_deadline() -> None:
    repository = MagicMock(spec=OptionsArchiveRepository)
    repository.oldest_active_expiration_date.return_value = None
    worker = _worker(archive_repository=repository)

    with (
        patch(
            "app.options_lane.archive_worker.archive_shards", return_value=(_shard(),)
        ),
        patch.object(worker, "_process_shard", return_value=_checkpoint()),
    ):
        assert worker.run_pass() == 300


def test_process_shard_skips_not_yet_due_checkpoint() -> None:
    repository = MagicMock(spec=OptionsArchiveRepository)
    checkpoint = _checkpoint(next_eligible_at=NOW + timedelta(hours=1))
    repository.prepare_shard.return_value = checkpoint
    worker = _worker(archive_repository=repository)

    with patch.object(worker, "_scan_pages") as scan_pages:
        assert worker._process_shard(_shard()) == checkpoint

    repository.require_lease.assert_called_once_with()
    scan_pages.assert_not_called()


def test_process_shard_resumes_finalization() -> None:
    repository = MagicMock(spec=OptionsArchiveRepository)
    checkpoint = _checkpoint(status="finalizing")
    repository.prepare_shard.return_value = checkpoint
    worker = _worker(archive_repository=repository)

    with patch.object(worker, "_finalize", return_value=checkpoint) as finalize:
        assert worker._process_shard(_shard()) == checkpoint

    finalize.assert_called_once_with(checkpoint)


def test_runtime_state_exposes_durable_finalization_progress() -> None:
    state = ArchiveRuntimeState()
    checkpoint = ArchiveCheckpoint(
        shard=_shard(),
        query_fingerprint="f" * 64,
        status="finalizing",
        cursor=None,
        page_count=4,
        seen_count=2_000,
        retry_count=0,
        next_eligible_at=None,
        last_success_at=None,
        finalize_after_expiration_date=date(2026, 7, 17),
        finalize_after_contract_symbol="MSFT-CONTRACT",
        transitioned_count=731,
    )

    state.update(
        ArchiveStateUpdate(
            phase="finalizing",
            observed_at=NOW,
            checkpoint=checkpoint,
        )
    )

    snapshot = state.snapshot()
    assert snapshot["finalization_cursor_present"] is True
    assert snapshot["finalize_after_expiration_date"] == "2026-07-17"
    assert snapshot["finalize_after_contract_symbol"] == "MSFT-CONTRACT"
    assert snapshot["transitioned_count"] == 731


@pytest.mark.parametrize(
    ("status_code", "cursor", "expected_reset", "expected_halving"),
    (
        (429, "page-2", False, True),
        (422, "page-2", True, False),
    ),
)
def test_process_shard_handles_provider_failures_without_losing_progress(
    status_code: int,
    cursor: str | None,
    expected_reset: bool,
    expected_halving: bool,
) -> None:
    repository = MagicMock(spec=OptionsArchiveRepository)
    catalog_repository = MagicMock(spec=OptionsRepository)
    checkpoint = _checkpoint(cursor=cursor)
    reset = _checkpoint()
    repository.prepare_shard.side_effect = (checkpoint, checkpoint)
    repository.reset_shard.return_value = reset
    worker = _worker(
        archive_repository=repository,
        catalog_repository=catalog_repository,
    )

    with (
        patch.object(
            worker,
            "_scan_pages",
            side_effect=AlpacaApiError(status_code=status_code, body="provider failed"),
        ),
        patch.object(worker, "_record_failure", return_value=reset) as record_failure,
    ):
        assert worker._process_shard(_shard()) == reset

    assert repository.reset_shard.called is expected_reset
    assert catalog_repository.halve_rate_bucket.called is expected_halving
    record_failure.assert_called_once_with(
        reset if expected_reset else checkpoint,
        error_code=str(status_code),
        error_detail="provider failed",
    )


def test_scan_pages_persists_page_then_finalizes() -> None:
    repository = MagicMock(spec=OptionsArchiveRepository)
    catalog_repository = MagicMock(spec=OptionsRepository)
    client = MagicMock(spec=AlpacaOptionsClient)
    state = ArchiveRuntimeState()
    initial = _checkpoint()
    finalizing = _checkpoint(status="finalizing")
    completed = _checkpoint(status="complete", next_eligible_at=NOW + timedelta(days=1))
    repository.checkpoint_page.return_value = finalizing
    repository.finalize_shard.return_value = ArchiveCompletion(
        checkpoint=completed,
        transitioned_count=2,
    )
    catalog_repository.acquire_rate_bucket.return_value = True
    catalog_repository.sync_contract_catalog_page.return_value = [{"changed": True}]
    client.list_archive_contracts.return_value = (
        [{"symbol": "AAPL260717C00200000", "expiration_date": "2026-07-17"}],
        None,
    )
    worker = _worker(
        archive_repository=repository,
        catalog_repository=catalog_repository,
        client=client,
        state=state,
    )

    assert worker._scan_pages(initial) == completed

    assert repository.require_lease.call_count == 4
    catalog_repository.sync_contract_catalog_page.assert_called_once()
    repository.checkpoint_page.assert_called_once()
    repository.finalize_shard.assert_called_once_with(
        checkpoint=finalizing,
        observed_at=NOW,
        refresh_seconds=86_400,
        batch_size=1_000,
        statement_timeout_ms=30_000,
        lock_timeout_ms=5_000,
    )
    snapshot = state.snapshot()
    assert snapshot["phase"] == "complete"
    assert snapshot["last_success_ts"] == NOW.isoformat()


def test_finalize_runs_committed_batches_until_an_empty_scan_completes() -> None:
    repository = MagicMock(spec=OptionsArchiveRepository)
    state = ArchiveRuntimeState()
    initial = _checkpoint(status="finalizing")
    progressed = ArchiveCheckpoint(
        shard=initial.shard,
        query_fingerprint=initial.query_fingerprint,
        status="finalizing",
        cursor=None,
        page_count=initial.page_count,
        seen_count=initial.seen_count,
        retry_count=0,
        next_eligible_at=None,
        last_success_at=None,
        finalize_after_expiration_date=date(2026, 7, 17),
        finalize_after_contract_symbol="MSFT-CONTRACT",
        transitioned_count=700,
    )
    completed = ArchiveCheckpoint(
        shard=initial.shard,
        query_fingerprint=initial.query_fingerprint,
        status="complete",
        cursor=None,
        page_count=initial.page_count,
        seen_count=initial.seen_count,
        retry_count=0,
        next_eligible_at=NOW + timedelta(days=1),
        last_success_at=NOW,
        transitioned_count=700,
    )
    repository.finalize_shard.side_effect = (
        ArchiveCompletion(
            checkpoint=progressed,
            transitioned_count=700,
            batch_scanned_count=1_000,
            batch_transitioned_count=700,
        ),
        ArchiveCompletion(checkpoint=completed, transitioned_count=700),
    )
    worker = _worker(archive_repository=repository, state=state)

    assert worker._finalize(initial) == completed

    assert repository.finalize_shard.call_count == 2
    assert state.snapshot()["phase"] == "complete"
    assert state.snapshot()["transitioned_count"] == 700


def test_record_failure_uses_bounded_retry_settings_and_updates_state() -> None:
    repository = MagicMock(spec=OptionsArchiveRepository)
    state = ArchiveRuntimeState()
    failed = _checkpoint(
        status="retry",
        cursor="page-2",
        next_eligible_at=NOW + timedelta(seconds=30),
        retry_count=1,
    )
    repository.record_failure.return_value = failed
    worker = _worker(archive_repository=repository, state=state)

    assert (
        worker._record_failure(
            _checkpoint(cursor="page-2"),
            error_code="429",
            error_detail="rate limited",
        )
        == failed
    )

    failure = repository.record_failure.call_args.kwargs["failure"]
    assert failure.retry_base_seconds == 30
    assert failure.retry_max_seconds == 900
    assert state.snapshot()["last_error_code"] == "429"


def test_wait_for_rate_token_stops_after_interruptible_wait() -> None:
    catalog_repository = MagicMock(spec=OptionsRepository)
    catalog_repository.acquire_rate_bucket.return_value = False
    stop_event = MagicMock(spec=threading.Event)
    stop_event.wait.return_value = True
    worker = _worker(
        catalog_repository=catalog_repository,
        stop_event=cast(threading.Event, stop_event),
    )

    worker._wait_for_rate_token()

    stop_event.wait.assert_called_once_with(10)


def _import_archive_service() -> tuple[ModuleType, MagicMock, MagicMock]:
    archive_repository = MagicMock(spec=OptionsArchiveRepository)
    catalog_repository = MagicMock(spec=OptionsRepository)
    settings = SimpleNamespace(
        sqlalchemy_dsn="postgresql+psycopg://unused:unused@localhost/unused",
        alpaca_key_id="key",
        alpaca_secret_key="secret",
        alpaca_contracts_base_url="https://paper-api.alpaca.markets",
        alpaca_data_base_url="https://data.alpaca.markets",
        alpaca_feed="indicative",
    )
    module_name = "app.options_lane.archive_service"
    sys.modules.pop(module_name, None)
    with (
        patch(
            "app.options_lane.settings.get_options_lane_settings",
            return_value=settings,
        ),
        patch(
            "app.options_lane.archive_repository.OptionsArchiveRepository",
            return_value=archive_repository,
        ),
        patch(
            "app.options_lane.repository.OptionsRepository",
            return_value=catalog_repository,
        ),
        patch("app.options_lane.alpaca.AlpacaOptionsClient"),
        patch("app.options_lane.archive_worker.OptionsArchiveWorker"),
    ):
        service = importlib.import_module(module_name)
    return service, archive_repository, catalog_repository


def test_archive_service_lifecycle_and_health_surfaces() -> None:
    service, archive_repository, catalog_repository = _import_archive_service()
    service.worker = SimpleNamespace(run_forever=lambda: service.stop_event.wait())

    async def exercise_lifespan() -> None:
        async with service.lifespan(service.app):
            assert service.healthz()["status"] == "ok"
            with pytest.raises(HTTPException) as not_ready:
                service.readyz()
            assert not_ready.value.status_code == 503
            service.state.update(
                ArchiveStateUpdate(
                    phase="running",
                    observed_at=NOW,
                    lease_acquired=True,
                )
            )
            assert service.readyz()["status"] == "ready"

    asyncio.run(exercise_lifespan())

    archive_repository.close.assert_called_once_with()
    archive_repository.cancel_active_work.assert_called_once_with()
    catalog_repository.close.assert_called_once_with()
    with pytest.raises(HTTPException) as unhealthy:
        service.healthz()
    assert unhealthy.value.status_code == 500
