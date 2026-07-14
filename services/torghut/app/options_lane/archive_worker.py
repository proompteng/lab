"""Crash-resumable options archive worker with singleton lease fencing."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
import logging
import threading
from typing import cast

from sqlalchemy.exc import SQLAlchemyError

from .alpaca import (
    AlpacaApiError,
    AlpacaOptionsClient,
    OptionsContractsQuery,
    normalize_contract_record,
)
from .archive_model import ArchiveShard, archive_query_fingerprint, archive_shards
from .archive_repository import (
    ArchiveCheckpoint,
    ArchiveFailure,
    ArchiveLeaseLostError,
    ArchiveStateError,
    OptionsArchiveRepository,
)
from .archive_state import ArchiveRuntimeState, ArchiveStateUpdate
from .repository import OptionsRepository
from .session import utc_now
from .settings import OptionsLaneSettings


logger = logging.getLogger("uvicorn.error")
ARCHIVE_RATE_BUCKET = "contracts_archive"
LEASE_RETRY_SECONDS = 30.0
PASS_MAX_IDLE_SECONDS = 300.0


def _normalize_archive_page(
    rows: list[dict[str, object]],
    *,
    shard: ArchiveShard,
    observed_at: datetime,
) -> list[dict[str, object]]:
    normalized_rows: list[dict[str, object]] = []
    for row in rows:
        if not str(row.get("symbol") or "").strip():
            raise ArchiveStateError("archive provider row is missing contract symbol")
        normalized = normalize_contract_record(row, observed_at=observed_at)
        expiration_date = cast(date, normalized["expiration_date"])
        if not shard.start <= expiration_date <= shard.end:
            raise ArchiveStateError(
                "archive provider returned an out-of-shard contract"
            )
        normalized_rows.append(normalized)
    return sorted(normalized_rows, key=lambda row: cast(str, row["contract_symbol"]))


class OptionsArchiveWorker:
    """Sequential shard worker with durable per-page checkpoints."""

    def __init__(
        self,
        *,
        settings: OptionsLaneSettings,
        archive_repository: OptionsArchiveRepository,
        catalog_repository: OptionsRepository,
        client: AlpacaOptionsClient,
        state: ArchiveRuntimeState,
        stop_event: threading.Event,
        now: Callable[[], datetime] = utc_now,
    ) -> None:
        self._settings = settings
        self._archive_repository = archive_repository
        self._catalog_repository = catalog_repository
        self._client = client
        self._state = state
        self._stop_event = stop_event
        self._now = now

    def run_forever(self) -> None:
        while not self._stop_event.is_set():
            if not self._archive_repository.try_acquire_lease(
                self._settings.options_contract_archive_lock_name
            ):
                self._state.update(
                    ArchiveStateUpdate(
                        phase="standby",
                        observed_at=self._now(),
                        lease_acquired=False,
                    )
                )
                self._stop_event.wait(LEASE_RETRY_SECONDS)
                continue
            self._state.update(
                ArchiveStateUpdate(
                    phase="running",
                    observed_at=self._now(),
                    lease_acquired=True,
                )
            )
            try:
                idle_seconds = self.run_pass()
            except ArchiveLeaseLostError as exc:
                self._archive_repository.release_lease()
                self._state.update(
                    ArchiveStateUpdate(
                        phase="standby",
                        observed_at=self._now(),
                        lease_acquired=False,
                        error_code="archive_lease_lost",
                        error_detail=str(exc),
                    )
                )
                self._stop_event.wait(LEASE_RETRY_SECONDS)
                continue
            except (ArchiveStateError, SQLAlchemyError, TypeError, ValueError) as exc:
                logger.exception("options archive pass failed")
                self._state.update(
                    ArchiveStateUpdate(
                        phase="degraded",
                        observed_at=self._now(),
                        error_code="archive_pass_failed",
                        error_detail=str(exc)[:500],
                    )
                )
                idle_seconds = LEASE_RETRY_SECONDS
            if not self._archive_repository.lease_healthy():
                self._archive_repository.release_lease()
                self._state.update(
                    ArchiveStateUpdate(
                        phase="standby",
                        observed_at=self._now(),
                        lease_acquired=False,
                        error_code="archive_lease_lost",
                        error_detail="PostgreSQL archive advisory lock connection was lost",
                    )
                )
                continue
            self._stop_event.wait(idle_seconds)

    def run_pass(self) -> float:
        now = self._now()
        earliest_next: datetime | None = None
        coverage_start = self._archive_repository.oldest_active_expiration_date(
            before=now.date()
        )
        for shard in archive_shards(
            today=now.date(),
            horizon_days=self._settings.options_contract_archive_horizon_days,
            coverage_start=coverage_start,
        ):
            if self._stop_event.is_set():
                break
            checkpoint = self._process_shard(shard)
            if checkpoint.next_eligible_at is not None:
                if earliest_next is None or checkpoint.next_eligible_at < earliest_next:
                    earliest_next = checkpoint.next_eligible_at
        if earliest_next is None:
            return PASS_MAX_IDLE_SECONDS
        seconds = max((earliest_next - self._now()).total_seconds(), 1.0)
        return min(seconds, PASS_MAX_IDLE_SECONDS)

    def _process_shard(self, shard: ArchiveShard) -> ArchiveCheckpoint:
        self._archive_repository.require_lease()
        fingerprint = archive_query_fingerprint(
            shard=shard,
            page_limit=self._settings.options_contract_archive_page_limit,
        )
        checkpoint = self._archive_repository.prepare_shard(
            shard=shard,
            query_fingerprint=fingerprint,
            observed_at=self._now(),
        )
        self._state.update(
            ArchiveStateUpdate(
                phase=checkpoint.status,
                observed_at=self._now(),
                checkpoint=checkpoint,
            )
        )
        if not checkpoint.due(self._now()):
            return checkpoint
        try:
            if checkpoint.status == "finalizing":
                return self._finalize(checkpoint)
            return self._scan_pages(checkpoint)
        except ArchiveLeaseLostError:
            raise
        except AlpacaApiError as exc:
            checkpoint = self._archive_repository.prepare_shard(
                shard=shard,
                query_fingerprint=fingerprint,
                observed_at=self._now(),
            )
            if exc.status_code == 429:
                self._catalog_repository.halve_rate_bucket(ARCHIVE_RATE_BUCKET)
            if checkpoint.cursor is not None and exc.status_code in {400, 404, 422}:
                checkpoint = self._archive_repository.reset_shard(
                    shard=shard,
                    query_fingerprint=fingerprint,
                    observed_at=self._now(),
                    reason="provider_cursor_rejected",
                )
            return self._record_failure(
                checkpoint,
                error_code=str(exc.status_code or "alpaca_api_error"),
                error_detail=exc.body,
            )
        except (ArchiveStateError, SQLAlchemyError, TypeError, ValueError) as exc:
            return self._record_failure(
                checkpoint,
                error_code="archive_shard_failed",
                error_detail=str(exc),
            )

    def _scan_pages(self, checkpoint: ArchiveCheckpoint) -> ArchiveCheckpoint:
        while not self._stop_event.is_set():
            self._wait_for_rate_token()
            if self._stop_event.is_set():
                return checkpoint
            self._archive_repository.require_lease()
            observed_at = self._now()
            rows, next_cursor = self._client.list_archive_contracts(
                query=OptionsContractsQuery(
                    status="active",
                    limit=self._settings.options_contract_archive_page_limit,
                    expiration_date_gte=checkpoint.shard.start,
                    expiration_date_lte=checkpoint.shard.end,
                    page_token=checkpoint.cursor,
                )
            )
            self._archive_repository.require_lease()
            normalized_rows = _normalize_archive_page(
                rows,
                shard=checkpoint.shard,
                observed_at=observed_at,
            )
            # Archive rows intentionally do not publish to Kafka. A direct publish
            # cannot atomically pair the DB commit with a broker acknowledgment;
            # the overlapping live universe remains the event-producing path.
            changed_rows = self._catalog_repository.sync_contract_catalog_page(
                normalized_rows,
                observed_at=observed_at,
            )
            # If the fencing session disappeared during the catalog transaction,
            # leave the page uncheckpointed so the next lease owner safely replays it.
            self._archive_repository.require_lease()
            checkpoint = self._archive_repository.checkpoint_page(
                checkpoint=checkpoint,
                observed_at=observed_at,
                contract_symbols={
                    cast(str, row["contract_symbol"]) for row in normalized_rows
                },
                next_cursor=next_cursor,
            )
            self._state.update(
                ArchiveStateUpdate(
                    phase=checkpoint.status,
                    observed_at=observed_at,
                    checkpoint=checkpoint,
                )
            )
            logger.info(
                "options archive progress shard=%s pages=%s seen=%s changed=%s has_next=%s",
                checkpoint.shard.key,
                checkpoint.page_count,
                checkpoint.seen_count,
                len(changed_rows),
                checkpoint.cursor is not None,
            )
            if checkpoint.status == "finalizing":
                return self._finalize(checkpoint)
        return checkpoint

    def _finalize(self, checkpoint: ArchiveCheckpoint) -> ArchiveCheckpoint:
        self._archive_repository.require_lease()
        observed_at = self._now()
        completion = self._archive_repository.finalize_shard(
            checkpoint=checkpoint,
            observed_at=observed_at,
            refresh_seconds=self._settings.options_contract_archive_refresh_sec,
        )
        logger.info(
            "options archive shard completed shard=%s pages=%s seen=%s transitions=%s",
            completion.checkpoint.shard.key,
            completion.checkpoint.page_count,
            completion.checkpoint.seen_count,
            completion.transitioned_count,
        )
        self._state.update(
            ArchiveStateUpdate(
                phase="complete",
                observed_at=observed_at,
                checkpoint=completion.checkpoint,
                completed=True,
            )
        )
        return completion.checkpoint

    def _record_failure(
        self,
        checkpoint: ArchiveCheckpoint,
        *,
        error_code: str,
        error_detail: str,
    ) -> ArchiveCheckpoint:
        observed_at = self._now()
        failed = self._archive_repository.record_failure(
            checkpoint=checkpoint,
            observed_at=observed_at,
            failure=ArchiveFailure(
                error_code=error_code,
                error_detail=error_detail,
                retry_base_seconds=self._settings.options_contract_archive_retry_base_sec,
                retry_max_seconds=self._settings.options_contract_archive_retry_max_sec,
            ),
        )
        self._state.update(
            ArchiveStateUpdate(
                phase=failed.status,
                observed_at=observed_at,
                checkpoint=failed,
                error_code=error_code,
                error_detail=error_detail[:500],
            )
        )
        logger.warning(
            "options archive shard retry shard=%s retries=%s error=%s",
            failed.shard.key,
            failed.retry_count,
            error_code,
        )
        return failed

    def _wait_for_rate_token(self) -> None:
        retry_seconds = max(
            1.0,
            1.0 / self._settings.options_contract_archive_requests_per_second,
        )
        while not self._catalog_repository.acquire_rate_bucket(
            ARCHIVE_RATE_BUCKET,
            self._settings.options_contract_archive_requests_per_second,
            1,
        ):
            if self._stop_event.wait(retry_seconds):
                return
