"""Dataset snapshot authority helpers for strategy discovery."""

from __future__ import annotations

import hashlib
import http.client
import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from urllib import error, request
from typing import Any, Mapping, Sequence, cast
from zoneinfo import ZoneInfo

_NEW_YORK = ZoneInfo('America/New_York')
_REGULAR_CLOSE_ET = time(hour=16, minute=5)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def _business_days(start_day: date, end_day: date) -> tuple[date, ...]:
    if start_day > end_day:
        return ()
    current = start_day
    values: list[date] = []
    while current <= end_day:
        if current.weekday() < 5:
            values.append(current)
        current += timedelta(days=1)
    return tuple(values)


def _most_recent_business_day(day: date) -> date:
    current = day
    while current.weekday() >= 5:
        current -= timedelta(days=1)
    return current


def resolve_expected_last_trading_day(
    *,
    explicit_day: date | None,
    now_utc: datetime | None = None,
) -> date:
    if explicit_day is not None:
        return explicit_day
    now_value = now_utc or datetime.now(timezone.utc)
    now_et = now_value.astimezone(_NEW_YORK)
    candidate_day = now_et.date()
    if now_et.time() < _REGULAR_CLOSE_ET:
        candidate_day -= timedelta(days=1)
    return _most_recent_business_day(candidate_day)


def _query_scalar(
    *,
    clickhouse_http_url: str,
    clickhouse_username: str | None,
    clickhouse_password: str | None,
    query: str,
) -> str:
    return _http_query(
        url=clickhouse_http_url,
        username=clickhouse_username,
        password=clickhouse_password,
        query=f'{query} FORMAT TSVRaw',
    ).strip()


def _http_query(
    *,
    url: str,
    username: str | None,
    password: str | None,
    query: str,
) -> str:
    body = query.encode('utf-8')
    last_error: Exception | None = None
    for attempt in range(3):
        req = request.Request(url=url.rstrip('/') + '/', data=body, method='POST')
        if username:
            req.add_header('Authorization', 'Basic ' + _b64(f'{username}:{password or ""}'.encode('utf-8')))
        try:
            with request.urlopen(req, timeout=120) as response:
                return response.read().decode('utf-8')
        except error.HTTPError as exc:
            payload = exc.read().decode('utf-8', errors='replace')
            raise RuntimeError(f'clickhouse_http_error: {exc.code}: {payload}') from exc
        except http.client.IncompleteRead as exc:
            if exc.partial:
                return exc.partial.decode('utf-8', errors='replace')
            last_error = exc
        except Exception as exc:  # pragma: no cover - flaky transport retry path
            last_error = exc
        from time import sleep

        sleep(0.5 * (attempt + 1))
    if last_error is None:
        raise RuntimeError('clickhouse_http_query_failed')
    raise RuntimeError(f'clickhouse_http_query_failed: {last_error}') from last_error


def _b64(raw: bytes) -> str:
    import base64

    return base64.b64encode(raw).decode('ascii')


def _query_days(
    *,
    clickhouse_http_url: str,
    clickhouse_username: str | None,
    clickhouse_password: str | None,
    table: str,
    source: str,
    window_size: str,
    start_day: date,
    end_day: date,
) -> tuple[date, ...]:
    raw = _query_scalar(
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        query=(
            'SELECT DISTINCT toDate(event_ts) AS trading_day '
            f'FROM {table} '
            f"WHERE source = '{source}' "
            f"  AND window_size = '{window_size}' "
            f"  AND toDate(event_ts) >= toDate('{start_day.isoformat()}') "
            f"  AND toDate(event_ts) <= toDate('{end_day.isoformat()}') "
            'ORDER BY trading_day ASC'
        ),
    )
    values = [
        date.fromisoformat(line.strip())
        for line in raw.splitlines()
        if line.strip()
    ]
    return tuple(values)


@dataclass(frozen=True)
class DatasetWitness:
    name: str
    payload: dict[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            'name': self.name,
            'payload': dict(self.payload),
        }


@dataclass(frozen=True)
class DatasetSnapshotReceipt:
    snapshot_id: str
    source: str
    window_size: str
    start_day: date
    end_day: date
    expected_last_trading_day: date
    is_fresh: bool
    missing_days: tuple[date, ...]
    row_count: int
    witnesses: tuple[DatasetWitness, ...]
    stale_override_used: bool = False

    def to_payload(self) -> dict[str, Any]:
        return {
            'snapshot_id': self.snapshot_id,
            'source': self.source,
            'window_size': self.window_size,
            'start_day': self.start_day.isoformat(),
            'end_day': self.end_day.isoformat(),
            'expected_last_trading_day': self.expected_last_trading_day.isoformat(),
            'is_fresh': self.is_fresh,
            'missing_days': [item.isoformat() for item in self.missing_days],
            'row_count': self.row_count,
            'stale_override_used': self.stale_override_used,
            'witnesses': [item.to_payload() for item in self.witnesses],
        }


def build_dataset_snapshot_receipt(
    *,
    clickhouse_http_url: str,
    clickhouse_username: str | None,
    clickhouse_password: str | None,
    start_day: date,
    end_day: date,
    source: str = 'ta',
    window_size: str = 'PT1S',
    signals_table: str = 'torghut.ta_signals',
    microbars_table: str = 'torghut.ta_microbars',
    expected_last_trading_day: date | None = None,
    expected_trading_days: Sequence[date] | None = None,
    allow_stale_tape: bool = False,
    now_utc: datetime | None = None,
) -> DatasetSnapshotReceipt:
    resolved_expected_last_day = resolve_expected_last_trading_day(
        explicit_day=expected_last_trading_day,
        now_utc=now_utc,
    )
    observed_days = _query_days(
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        table=signals_table,
        source=source,
        window_size=window_size,
        start_day=start_day,
        end_day=end_day,
    )
    expected_days = tuple(expected_trading_days or _business_days(start_day, min(end_day, resolved_expected_last_day)))
    observed_day_set = set(observed_days)
    missing_days = tuple(day for day in expected_days if day not in observed_day_set)

    signals_row_count = int(
        _query_scalar(
            clickhouse_http_url=clickhouse_http_url,
            clickhouse_username=clickhouse_username,
            clickhouse_password=clickhouse_password,
            query=(
                f'SELECT count() FROM {signals_table} '
                f"WHERE source = '{source}' "
                f"  AND window_size = '{window_size}' "
                f"  AND toDate(event_ts) >= toDate('{start_day.isoformat()}') "
                f"  AND toDate(event_ts) <= toDate('{end_day.isoformat()}')"
            ),
        )
        or '0'
    )
    microbars_row_count = int(
        _query_scalar(
            clickhouse_http_url=clickhouse_http_url,
            clickhouse_username=clickhouse_username,
            clickhouse_password=clickhouse_password,
            query=(
                f'SELECT count() FROM {microbars_table} '
                f"WHERE source = '{source}' "
                f"  AND window_size = '{window_size}' "
                f"  AND toDate(event_ts) >= toDate('{start_day.isoformat()}') "
                f"  AND toDate(event_ts) <= toDate('{end_day.isoformat()}')"
            ),
        )
        or '0'
    )
    signals_max_ts = _query_scalar(
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        query=(
            f'SELECT toString(max(event_ts)) FROM {signals_table} '
            f"WHERE source = '{source}' "
            f"  AND window_size = '{window_size}'"
        ),
    )
    microbars_max_ts = _query_scalar(
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        query=(
            f'SELECT toString(max(event_ts)) FROM {microbars_table} '
            f"WHERE source = '{source}' "
            f"  AND window_size = '{window_size}'"
        ),
    )
    latest_signals_day = _query_scalar(
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        query=(
            f'SELECT toString(max(toDate(event_ts))) FROM {signals_table} '
            f"WHERE source = '{source}' "
            f"  AND window_size = '{window_size}'"
        ),
    )
    latest_microbars_day = _query_scalar(
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        query=(
            f'SELECT toString(max(toDate(event_ts))) FROM {microbars_table} '
            f"WHERE source = '{source}' "
            f"  AND window_size = '{window_size}'"
        ),
    )

    latest_days = [
        date.fromisoformat(raw_day)
        for raw_day in (latest_signals_day, latest_microbars_day)
        if raw_day
    ]
    if not latest_days:
        latest_observed_day = start_day
    else:
        latest_observed_day = max(latest_days)
    is_fresh = latest_observed_day >= resolved_expected_last_day
    witness_payload = {
        'source': source,
        'window_size': window_size,
        'start_day': start_day.isoformat(),
        'end_day': end_day.isoformat(),
        'expected_last_trading_day': resolved_expected_last_day.isoformat(),
        'latest_observed_day': latest_observed_day.isoformat(),
        'row_count': signals_row_count,
        'microbar_row_count': microbars_row_count,
        'observed_days': [item.isoformat() for item in observed_days],
        'missing_days': [item.isoformat() for item in missing_days],
    }
    snapshot_id = f'snap-{_stable_hash(witness_payload)[:24]}'

    return DatasetSnapshotReceipt(
        snapshot_id=snapshot_id,
        source=source,
        window_size=window_size,
        start_day=start_day,
        end_day=end_day,
        expected_last_trading_day=resolved_expected_last_day,
        is_fresh=is_fresh,
        missing_days=missing_days,
        row_count=signals_row_count,
        stale_override_used=allow_stale_tape and not is_fresh,
        witnesses=(
            DatasetWitness(
                name='ta_signals',
                payload={
                    'table': signals_table,
                    'latest_observed_day': latest_signals_day,
                    'max_event_ts': signals_max_ts,
                    'row_count': signals_row_count,
                    'observed_days': [item.isoformat() for item in observed_days],
                },
            ),
            DatasetWitness(
                name='ta_microbars',
                payload={
                    'table': microbars_table,
                    'latest_observed_day': latest_microbars_day,
                    'max_event_ts': microbars_max_ts,
                    'row_count': microbars_row_count,
                },
            ),
        ),
    )


def ensure_fresh_snapshot(
    receipt: DatasetSnapshotReceipt,
    *,
    allow_stale_tape: bool,
) -> None:
    if receipt.is_fresh or allow_stale_tape:
        return
    raise ValueError(
        'stale_tape:'
        f'expected_last_trading_day={receipt.expected_last_trading_day.isoformat()}:'
        f'end_day={receipt.end_day.isoformat()}'
    )


def witness_map(receipt: DatasetSnapshotReceipt) -> dict[str, Mapping[str, Any]]:
    return {
        item.name: cast(Mapping[str, Any], item.payload)
        for item in receipt.witnesses
    }
