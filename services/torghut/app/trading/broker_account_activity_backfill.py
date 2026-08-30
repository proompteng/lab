"""Paginated Alpaca account-activity backfill and durable cursor handling."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..alpaca_client import classify_alpaca_trading_endpoint
from ..models import BrokerAccountActivity, BrokerAccountActivityCursor
from .broker_account_activities import (
    BrokerAccountActivityContradiction,
    BrokerAccountActivityError,
    BrokerAccountActivityPayloadError,
    BrokerActivityObservation,
    ALPACA_PROVIDER,
    ACCOUNT_ACTIVITIES_REST_SOURCE,
    as_utc,
    required_text,
    normalize_broker_account_activity,
)
from .broker_mutation_receipts import fingerprint_broker_endpoint


logger = logging.getLogger(__name__)

_INITIAL_SCAN_AFTER = datetime(2016, 1, 1, tzinfo=timezone.utc)
# Alpaca posts date-only crypto fee activities after the trading day closes.
# Re-read two full UTC dates so those immutable late arrivals cannot fall behind
# a cursor that already advanced past their settlement date.
_SCAN_OVERLAP = timedelta(days=2)
_PAGE_SIZE = 100
_HTTP_TIMEOUT_SECONDS = 10.0
_DEFAULT_PAGES_PER_RUN = 3


class _Response(Protocol):
    status: int

    def read(self) -> bytes: ...

    def __enter__(self) -> _Response: ...

    def __exit__(self, *args: object) -> None: ...


JsonGet = Callable[..., object]
SessionFactory = Callable[[], Session]


@dataclass(frozen=True, slots=True)
class AlpacaAccountActivityPage:
    """One bounded, ascending page from Alpaca's account-activities API."""

    activities: tuple[dict[str, object], ...]
    request_page_token: str | None
    next_page_token: str | None

    @property
    def complete(self) -> bool:
        return self.next_page_token is None


@dataclass(frozen=True, slots=True)
class BrokerAccountActivityIngestResult:
    """Durable outcome of one page fetch and commit."""

    seen: int
    inserted: int
    duplicates: int
    complete: bool
    next_page_token: str | None


@dataclass(frozen=True, slots=True)
class _Scan:
    after: datetime
    until: datetime
    page_token: str | None


def _get_json(
    *,
    url: str,
    headers: Mapping[str, str],
    params: Mapping[str, str | int],
    timeout: float,
) -> object:
    request = Request(
        f"{url}?{urlencode(params)}",
        headers=dict(headers),
        method="GET",
    )
    try:
        with cast(_Response, urlopen(request, timeout=timeout)) as response:
            if response.status != 200:
                raise BrokerAccountActivityError(
                    f"alpaca_account_activities_http_{response.status}"
                )
            body = response.read()
    except HTTPError as exc:
        raise BrokerAccountActivityError(
            f"alpaca_account_activities_http_{exc.code}"
        ) from exc
    except (TimeoutError, URLError) as exc:
        raise BrokerAccountActivityError(
            "alpaca_account_activities_request_failed"
        ) from exc
    try:
        return json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BrokerAccountActivityPayloadError(
            "alpaca_account_activities_invalid_json"
        ) from exc


class AlpacaAccountActivitiesClient:
    """Small read-only client for the endpoint absent from alpaca-py."""

    def __init__(
        self,
        *,
        api_key: str,
        secret_key: str,
        endpoint_url: str,
        get_json: JsonGet = _get_json,
    ) -> None:
        if not api_key.strip() or not secret_key.strip():
            raise ValueError("alpaca_account_activities_credentials_required")
        self.endpoint_url = endpoint_url.rstrip("/")
        if self.endpoint_url.endswith("/v2"):
            self.endpoint_url = self.endpoint_url[:-3]
        self.environment = classify_alpaca_trading_endpoint(self.endpoint_url)
        self._headers = {
            "APCA-API-KEY-ID": api_key,
            "APCA-API-SECRET-KEY": secret_key,
            "Accept": "application/json",
        }
        self._get_json = get_json

    def list_page(
        self,
        *,
        after: datetime,
        until: datetime,
        page_token: str | None,
    ) -> AlpacaAccountActivityPage:
        if after.tzinfo is None or until.tzinfo is None:
            raise ValueError("alpaca_account_activities_timezone_required")
        normalized_after = after.astimezone(timezone.utc)
        normalized_until = until.astimezone(timezone.utc)
        if normalized_after >= normalized_until:
            raise ValueError("alpaca_account_activities_window_invalid")
        params: dict[str, str | int] = {
            "after": normalized_after.isoformat().replace("+00:00", "Z"),
            "until": normalized_until.isoformat().replace("+00:00", "Z"),
            "direction": "asc",
            "page_size": _PAGE_SIZE,
        }
        if page_token:
            params["page_token"] = page_token
        payload = self._get_json(
            url=f"{self.endpoint_url}/v2/account/activities",
            headers=self._headers,
            params=params,
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        if not isinstance(payload, list):
            raise BrokerAccountActivityPayloadError(
                "alpaca_account_activities_page_not_array"
            )
        activities: list[dict[str, object]] = []
        for raw_object in cast(list[object], payload):
            if not isinstance(raw_object, Mapping):
                raise BrokerAccountActivityPayloadError(
                    "alpaca_account_activities_row_not_object"
                )
            raw = cast(Mapping[object, object], raw_object)
            if any(not isinstance(key, str) for key in raw):
                raise BrokerAccountActivityPayloadError(
                    "alpaca_account_activities_row_not_object"
                )
            activity = {cast(str, key): value for key, value in raw.items()}
            required_text(activity, "id", maximum=256)
            required_text(activity, "activity_type", maximum=32)
            activities.append(activity)
        next_page_token = None
        if len(activities) == _PAGE_SIZE:
            next_page_token = cast(str, activities[-1]["id"])
        return AlpacaAccountActivityPage(
            activities=tuple(activities),
            request_page_token=page_token,
            next_page_token=next_page_token,
        )


class BrokerAccountActivityIngestor:
    """Fetch one page outside a DB transaction, then atomically append and advance."""

    def __init__(
        self,
        *,
        client: AlpacaAccountActivitiesClient,
        session_factory: SessionFactory,
        account_label: str,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        if not account_label.strip():
            raise ValueError("broker_account_activity_account_label_required")
        self._client = client
        self._session_factory = session_factory
        self._account_label = account_label.strip()
        self._environment = client.environment
        self._endpoint_fingerprint = fingerprint_broker_endpoint(client.endpoint_url)
        self._now = now

    @property
    def account_label(self) -> str:
        return self._account_label

    @property
    def environment(self) -> str:
        return self._environment

    @property
    def endpoint_fingerprint(self) -> str:
        return self._endpoint_fingerprint

    def ingest_once(self) -> BrokerAccountActivityIngestResult:
        scan = self._prepare_scan()
        try:
            page = self._client.list_page(
                after=scan.after,
                until=scan.until,
                page_token=scan.page_token,
            )
            return self._persist_page(scan=scan, page=page)
        except (
            BrokerAccountActivityError,
            OSError,
            SQLAlchemyError,
            ValueError,
        ) as exc:
            self._record_error(scan=scan, exc=exc)
            raise

    def ingest_batch(
        self,
        *,
        max_pages: int = _DEFAULT_PAGES_PER_RUN,
    ) -> BrokerAccountActivityIngestResult:
        """Drain a few pages per background pass without monopolizing shutdown."""

        if max_pages <= 0:
            raise ValueError("broker_account_activity_max_pages_invalid")
        seen = inserted = duplicates = 0
        result: BrokerAccountActivityIngestResult | None = None
        for _ in range(max_pages):
            result = self.ingest_once()
            seen += result.seen
            inserted += result.inserted
            duplicates += result.duplicates
            if result.complete:
                break
        assert result is not None
        return BrokerAccountActivityIngestResult(
            seen=seen,
            inserted=inserted,
            duplicates=duplicates,
            complete=result.complete,
            next_page_token=result.next_page_token,
        )

    def _cursor_query(self):
        return select(BrokerAccountActivityCursor).where(
            BrokerAccountActivityCursor.provider == ALPACA_PROVIDER,
            BrokerAccountActivityCursor.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
            BrokerAccountActivityCursor.environment == self._environment,
            BrokerAccountActivityCursor.account_label == self._account_label,
            BrokerAccountActivityCursor.endpoint_fingerprint
            == self._endpoint_fingerprint,
        )

    def _prepare_scan(self) -> _Scan:
        now = as_utc(self._now())
        with self._session_factory() as session, session.begin():
            cursor = session.scalar(self._cursor_query().with_for_update())
            if cursor is None:
                cursor = BrokerAccountActivityCursor(
                    provider=ALPACA_PROVIDER,
                    source=ACCOUNT_ACTIVITIES_REST_SOURCE,
                    environment=self._environment,
                    account_label=self._account_label,
                    endpoint_fingerprint=self._endpoint_fingerprint,
                    status="idle",
                    scan_after=_INITIAL_SCAN_AFTER,
                )
                session.add(cursor)
                session.flush()
            if cursor.scan_until is None:
                cursor.scan_until = now
                cursor.next_page_token = None
                cursor.scan_started_at = now
            cursor.status = "scanning"
            cursor.last_error = None
            return _Scan(
                after=as_utc(cursor.scan_after),
                until=as_utc(cursor.scan_until),
                page_token=cursor.next_page_token,
            )

    def _persist_page(
        self,
        *,
        scan: _Scan,
        page: AlpacaAccountActivityPage,
    ) -> BrokerAccountActivityIngestResult:
        observed_at = as_utc(self._now())
        if page.request_page_token != scan.page_token:
            raise BrokerAccountActivityContradiction(
                "broker_account_activity_page_token_mismatch"
            )
        observation = BrokerActivityObservation(
            environment=self._environment,
            account_label=self._account_label,
            endpoint_fingerprint=self._endpoint_fingerprint,
            observed_at=observed_at,
        )
        normalized = tuple(
            normalize_broker_account_activity(
                payload,
                observation=observation,
                source_page_token=scan.page_token,
            )
            for payload in page.activities
        )
        external_ids = [row.external_activity_id for row in normalized]
        if len(external_ids) != len(set(external_ids)):
            raise BrokerAccountActivityPayloadError(
                "broker_account_activity_duplicate_id_in_page"
            )
        with self._session_factory() as session, session.begin():
            cursor = session.scalar(self._cursor_query().with_for_update())
            self._require_same_scan(cursor, scan)
            existing_by_id: dict[str, BrokerAccountActivity] = {}
            if external_ids:
                existing = session.scalars(
                    select(BrokerAccountActivity).where(
                        BrokerAccountActivity.provider == ALPACA_PROVIDER,
                        BrokerAccountActivity.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
                        BrokerAccountActivity.environment == self._environment,
                        BrokerAccountActivity.account_label == self._account_label,
                        BrokerAccountActivity.external_activity_id.in_(external_ids),
                    )
                )
                existing_by_id = {row.external_activity_id: row for row in existing}
            inserted = 0
            for row in normalized:
                existing = existing_by_id.get(row.external_activity_id)
                if existing is not None:
                    if existing.raw_payload_sha256 != row.raw_payload_sha256:
                        raise BrokerAccountActivityContradiction(
                            "broker_account_activity_payload_changed:"
                            f"{row.external_activity_id}"
                        )
                    continue
                session.add(row)
                inserted += 1
            assert cursor is not None
            cursor.pages_processed += 1
            cursor.activities_seen += len(normalized)
            cursor.activities_inserted += inserted
            cursor.updated_at = observed_at
            if normalized:
                cursor.last_activity_id = normalized[-1].external_activity_id
                cursor.last_activity_at = normalized[-1].event_at
            cursor.next_page_token = page.next_page_token
            if page.complete:
                cursor.status = "complete"
                cursor.last_completed_scan_until = scan.until
                cursor.scan_after = max(
                    _INITIAL_SCAN_AFTER,
                    scan.until - _SCAN_OVERLAP,
                )
                cursor.scan_until = None
                cursor.last_completed_at = observed_at
            else:
                cursor.status = "scanning"
        duplicates = len(normalized) - inserted
        logger.info(
            "Broker account activities page account=%s seen=%s inserted=%s duplicates=%s complete=%s",
            self._account_label,
            len(normalized),
            inserted,
            duplicates,
            page.complete,
        )
        return BrokerAccountActivityIngestResult(
            seen=len(normalized),
            inserted=inserted,
            duplicates=duplicates,
            complete=page.complete,
            next_page_token=page.next_page_token,
        )

    def _require_same_scan(
        self,
        cursor: BrokerAccountActivityCursor | None,
        scan: _Scan,
    ) -> None:
        if (
            cursor is None
            or cursor.status != "scanning"
            or as_utc(cursor.scan_after) != scan.after
            or cursor.scan_until is None
            or as_utc(cursor.scan_until) != scan.until
            or cursor.next_page_token != scan.page_token
        ):
            raise BrokerAccountActivityContradiction(
                "broker_account_activity_cursor_changed"
            )

    def _record_error(self, *, scan: _Scan, exc: Exception) -> None:
        try:
            with self._session_factory() as session, session.begin():
                cursor = session.scalar(self._cursor_query().with_for_update())
                if cursor is None:
                    return
                if (
                    as_utc(cursor.scan_after) == scan.after
                    and cursor.scan_until is not None
                    and as_utc(cursor.scan_until) == scan.until
                    and cursor.next_page_token == scan.page_token
                ):
                    cursor.status = "error"
                    cursor.last_error = f"{type(exc).__name__}:{exc}"[:500]
                    cursor.updated_at = as_utc(self._now())
        except (SQLAlchemyError, ValueError):
            logger.exception("Failed to record broker account activity ingest error")


__all__ = (
    "AlpacaAccountActivitiesClient",
    "AlpacaAccountActivityPage",
    "BrokerAccountActivityIngestResult",
    "BrokerAccountActivityIngestor",
)
