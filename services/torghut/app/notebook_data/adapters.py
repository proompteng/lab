"""Read-only live and explicit-fixture adapters for Torghut notebooks."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import LiteralString, Protocol, cast

import psycopg
from psycopg.rows import dict_row

from .fixtures import fixture_query
from .models import MAX_PROJECTED_ROWS, QueryResult, Record, Records, parse_utc
from .queries import assert_query_contract

STATEMENT_TIMEOUT_MS = 30_000


class NotebookDataError(RuntimeError):
    """A source failed without any synthetic fallback."""


class DataAdapter(Protocol):
    @property
    def mode(self) -> str: ...

    def postgres(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult: ...

    def clickhouse(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult: ...

    def status(self, query_identifier: str) -> QueryResult: ...


def _bounded_limit(row_limit: int) -> int:
    if row_limit < 1 or row_limit > MAX_PROJECTED_ROWS:
        raise ValueError(f"row_limit must be between 1 and {MAX_PROJECTED_ROWS}")
    return row_limit


def _watermark(records: Records) -> datetime | None:
    values: list[datetime] = []
    for record in records:
        for key in (
            "source_watermark",
            "latest_ingest_ts",
            "latest_bucket_ended_at",
            "last_activity_at",
            "computed_at",
        ):
            parsed = parse_utc(record.get(key))
            if parsed is not None:
                values.append(parsed)
                break
    return max(values) if values else None


def _json_safe(value: object) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    return str(value)


@dataclass(frozen=True, slots=True)
class LiveDataAdapter:
    """Bounded live reads using dedicated PostgreSQL and ClickHouse principals."""

    postgres_host: str
    postgres_port: int
    postgres_database: str
    postgres_user: str
    postgres_password: str
    clickhouse_url: str
    clickhouse_database: str
    clickhouse_user: str
    clickhouse_password: str
    status_url: str
    mode: str = "live"

    @classmethod
    def from_environment(cls) -> LiveDataAdapter:
        required = {
            "PGHOST": os.getenv("PGHOST"),
            "PGDATABASE": os.getenv("PGDATABASE"),
            "PGUSER": os.getenv("PGUSER"),
            "PGPASSWORD": os.getenv("PGPASSWORD"),
            "CLICKHOUSE_URL": os.getenv("CLICKHOUSE_URL"),
            "CLICKHOUSE_USER": os.getenv("CLICKHOUSE_USER"),
            "CLICKHOUSE_PASSWORD": os.getenv("CLICKHOUSE_PASSWORD"),
            "TORGHUT_STATUS_URL": os.getenv("TORGHUT_STATUS_URL"),
        }
        missing = sorted(name for name, value in required.items() if not value)
        if missing:
            raise NotebookDataError(
                "live notebook configuration is incomplete: " + ", ".join(missing)
            )
        return cls(
            postgres_host=str(required["PGHOST"]),
            postgres_port=int(os.getenv("PGPORT", "5432")),
            postgres_database=str(required["PGDATABASE"]),
            postgres_user=str(required["PGUSER"]),
            postgres_password=str(required["PGPASSWORD"]),
            clickhouse_url=str(required["CLICKHOUSE_URL"]).rstrip("/"),
            clickhouse_database=os.getenv("CLICKHOUSE_DATABASE", "torghut"),
            clickhouse_user=str(required["CLICKHOUSE_USER"]),
            clickhouse_password=str(required["CLICKHOUSE_PASSWORD"]),
            status_url=str(required["TORGHUT_STATUS_URL"]),
        )

    def postgres(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        limit = _bounded_limit(row_limit)
        assert_query_contract(query_identifier, sql)
        query_parameters = dict(parameters)
        query_parameters["limit"] = limit
        try:
            with psycopg.Connection[Record].connect(
                host=self.postgres_host,
                port=self.postgres_port,
                dbname=self.postgres_database,
                user=self.postgres_user,
                password=self.postgres_password,
                options=(
                    "-c default_transaction_read_only=on "
                    f"-c statement_timeout={STATEMENT_TIMEOUT_MS}"
                ),
                row_factory=dict_row,
                connect_timeout=10,
            ) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SET TRANSACTION READ ONLY")
                    cursor.execute(cast(LiteralString, sql), query_parameters)
                    raw_records = cursor.fetchmany(limit)
        except psycopg.Error as error:
            detail = str(error).splitlines()[0][:240]
            raise NotebookDataError(
                f"PostgreSQL query {query_identifier} failed: {error.__class__.__name__}: {detail}"
            ) from error
        truncated = len(raw_records) >= limit
        records = tuple(dict(record) for record in raw_records)
        return QueryResult(records, _watermark(records), truncated)

    def clickhouse(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        limit = _bounded_limit(row_limit)
        assert_query_contract(query_identifier, sql)
        request = self._clickhouse_request(
            sql, self._clickhouse_parameters(parameters, limit)
        )
        payload = self._read_clickhouse_response(request, query_identifier)
        records = self._clickhouse_records(payload, query_identifier)
        return QueryResult(records, _watermark(records), len(records) >= limit)

    def _clickhouse_parameters(
        self, parameters: Mapping[str, object], limit: int
    ) -> dict[str, str]:
        # The dedicated ClickHouse profile enforces readonly mode and resource caps.
        # Sending those settings per request is invalid under readonly=1 because
        # readonly users cannot change settings, even to the configured value.
        query_parameters = {"database": self.clickhouse_database}
        for name, value in parameters.items():
            query_parameters[f"param_{name}"] = _json_safe(value)
        query_parameters["param_limit"] = str(limit)
        return query_parameters

    def _clickhouse_request(
        self, sql: str, query_parameters: Mapping[str, str]
    ) -> urllib.request.Request:
        url = f"{self.clickhouse_url}/?{urllib.parse.urlencode(query_parameters)}"
        return urllib.request.Request(
            url,
            data=sql.encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "text/plain; charset=utf-8",
                "X-ClickHouse-User": self.clickhouse_user,
                "X-ClickHouse-Key": self.clickhouse_password,
            },
        )

    @staticmethod
    def _read_clickhouse_response(
        request: urllib.request.Request, query_identifier: str
    ) -> object:
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read(1024).decode("utf-8", errors="replace").strip()
            raise NotebookDataError(
                f"ClickHouse query {query_identifier} failed with HTTP {error.code}: {detail[:500]}"
            ) from error
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise NotebookDataError(
                f"ClickHouse query {query_identifier} failed: {error.__class__.__name__}"
            ) from error

    @staticmethod
    def _clickhouse_records(payload_raw: object, query_identifier: str) -> Records:
        if not isinstance(payload_raw, dict):
            raise NotebookDataError(
                f"ClickHouse query {query_identifier} returned an invalid JSON schema"
            )
        payload = cast(dict[str, object], payload_raw)
        data_raw = payload.get("data")
        if not isinstance(data_raw, list):
            raise NotebookDataError(
                f"ClickHouse query {query_identifier} returned an invalid JSON schema"
            )
        data = cast(list[object], data_raw)
        if any(not isinstance(item, dict) for item in data):
            raise NotebookDataError(
                f"ClickHouse query {query_identifier} returned an invalid JSON schema"
            )
        return tuple(cast(Record, item) for item in data)

    def status(self, query_identifier: str) -> QueryResult:
        request = urllib.request.Request(
            self.status_url,
            method="GET",
            headers={"Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload_raw: object = json.load(response)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise NotebookDataError(
                f"Torghut status query {query_identifier} failed: {error.__class__.__name__}"
            ) from error
        if not isinstance(payload_raw, dict):
            raise NotebookDataError("Torghut status response is not a JSON object")
        payload = cast(Record, payload_raw)
        action_authority_raw = payload.get("action_authority")
        action_authority = (
            cast(Record, action_authority_raw)
            if isinstance(action_authority_raw, dict)
            else None
        )
        observed = parse_utc(
            action_authority.get("evaluated_at")
            if action_authority is not None
            else None
        )
        return QueryResult((payload,), observed, False)


@dataclass(frozen=True, slots=True)
class FixtureDataAdapter:
    """Deterministic CI adapter. It is selected only through an explicit mode."""

    mode: str = "fixture"

    def postgres(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        _bounded_limit(row_limit)
        assert_query_contract(query_identifier, sql)
        return fixture_query(query_identifier, parameters, row_limit=row_limit)

    def clickhouse(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        _bounded_limit(row_limit)
        assert_query_contract(query_identifier, sql)
        return fixture_query(query_identifier, parameters, row_limit=row_limit)

    def status(self, query_identifier: str) -> QueryResult:
        return fixture_query(query_identifier, {}, row_limit=1)


def adapter_from_environment() -> DataAdapter:
    mode = os.getenv("TORGHUT_NOTEBOOK_DATA_MODE", "live").strip().lower()
    if mode == "fixture":
        return FixtureDataAdapter()
    if mode == "live":
        return LiveDataAdapter.from_environment()
    raise NotebookDataError(
        "TORGHUT_NOTEBOOK_DATA_MODE must be exactly 'live' or 'fixture'"
    )


def mode_banner(adapter: DataAdapter | None = None) -> str:
    selected = adapter or adapter_from_environment()
    if selected.mode == "fixture":
        return "🧪 FIXTURE MODE — deterministic CI evidence; not live Torghut data"
    return "🔴 LIVE MODE — read-only Torghut production evidence"
