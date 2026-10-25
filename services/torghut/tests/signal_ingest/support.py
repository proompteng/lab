from __future__ import annotations


import json
from datetime import datetime, timedelta, timezone
from typing import Optional
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, TradeCursor
from app.config import settings
from app.trading.ingest import ClickHouseSignalIngestor
from app.trading.quote_quality import assess_signal_quote_quality


class CapturingIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.last_query: str | None = None

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.last_query = query
        return []


class SchemaDiscoveringIngestor(CapturingIngestor):
    def __init__(self, *args, columns: set[str], **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._columns = columns

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if query.strip().startswith("SELECT name FROM system.columns"):
            return [{"name": column} for column in self._columns]
        return super()._query_clickhouse(query)


class StaticLatestIngestor(ClickHouseSignalIngestor):
    def __init__(
        self, *args, latest_signal_ts: Optional[datetime] = None, **kwargs
    ) -> None:
        super().__init__(*args, **kwargs)
        self._latest_signal_ts = latest_signal_ts

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if "latest_signal_ts" in query:
            return (
                [{"latest_signal_ts": self._latest_signal_ts.isoformat()}]
                if self._latest_signal_ts is not None
                else []
            )
        return []


class FlakyLatestIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, responses: list[object], **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.responses = list(responses)

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if "latest_signal_ts" not in query:
            return []
        if not self.responses:
            return []
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class SimulationWindowIngestor(ClickHouseSignalIngestor):
    def __init__(
        self,
        *args,
        latest_signal_ts: datetime,
        rows: list[dict[str, object]] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._latest_signal_ts = latest_signal_ts
        self.rows = list(rows or [])
        self.queries: list[str] = []

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "latest_signal_ts" in query:
            return [{"latest_signal_ts": self._latest_signal_ts.isoformat()}]
        return list(self.rows)


class SimulationWindowNoLatestIngestor(ClickHouseSignalIngestor):
    def __init__(
        self, *args, rows: list[dict[str, object]] | None = None, **kwargs
    ) -> None:
        super().__init__(*args, **kwargs)
        self.rows = list(rows or [])
        self.queries: list[str] = []

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "latest_signal_ts" in query:
            raise RuntimeError("clickhouse probe unavailable")
        return list(self.rows)


class MetadataLatestIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args, latest_signal_ts: datetime, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.latest_signal_ts = latest_signal_ts
        self.queries: list[str] = []

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "ORDER BY event_ts DESC, symbol DESC, seq DESC" in query:
            return [{"latest_signal_ts": self.latest_signal_ts.isoformat()}]
        if "SELECT max(" in query or "FROM system.parts" in query:
            raise AssertionError(
                "expected descending latest-timestamp query to avoid aggregate freshness scans"
            )
        return []


class _TestSignalIngestBase(TestCase):
    pass


__all__: tuple[str, ...] = (
    "Base",
    "CapturingIngestor",
    "ClickHouseSignalIngestor",
    "FlakyLatestIngestor",
    "MetadataLatestIngestor",
    "Optional",
    "SchemaDiscoveringIngestor",
    "SimulationWindowIngestor",
    "SimulationWindowNoLatestIngestor",
    "StaticLatestIngestor",
    "TestCase",
    "TradeCursor",
    "_TestSignalIngestBase",
    "assess_signal_quote_quality",
    "create_engine",
    "datetime",
    "json",
    "patch",
    "select",
    "sessionmaker",
    "settings",
    "timedelta",
    "timezone",
)
