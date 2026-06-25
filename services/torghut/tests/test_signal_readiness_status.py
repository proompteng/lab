from __future__ import annotations

from datetime import datetime, timezone

from app.trading.ingest import ClickHouseSignalIngestor
from app.trading.ingest.shared_context import coerce_count


class ReadinessCountingIngestor(ClickHouseSignalIngestor):
    def __init__(
        self,
        *args: object,
        latest_signal_ts: datetime,
        signal_rows: int,
        symbol_count: int,
        **kwargs: object,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.latest_signal_ts = latest_signal_ts
        self.signal_rows = signal_rows
        self.symbol_count = symbol_count
        self.queries: list[str] = []

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "latest_signal_ts" in query:
            return [{"latest_signal_ts": self.latest_signal_ts.isoformat()}]
        if "count() AS signal_rows" in query:
            return [
                {
                    "signal_rows": str(self.signal_rows),
                    "symbol_count": str(self.symbol_count),
                }
            ]
        return []


class SourceFilteredReadinessIngestor(ReadinessCountingIngestor):
    def _source_where_clause(self) -> str | None:
        return "lower(source) IN ('ta')"


class FailingReadinessIngestor(ReadinessCountingIngestor):
    def _latest_signal_readiness_counts(
        self,
        *,
        time_column: str,
        latest_signal_at: datetime,
    ) -> dict[str, object]:
        raise RuntimeError("count query unavailable")


def test_coerce_count_handles_clickhouse_json_values() -> None:
    assert coerce_count(True) == 1
    assert coerce_count(12) == 12
    assert coerce_count(6.9) == 6
    assert coerce_count(" 8 ") == 8
    assert coerce_count("bad") == 0
    assert coerce_count("") == 0


def test_latest_signal_status_includes_readiness_counts() -> None:
    latest = datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc)
    ingestor = ReadinessCountingIngestor(
        schema="envelope",
        table="torghut.ta_signals",
        url="http://example",
        latest_signal_ts=latest,
        signal_rows=12,
        symbol_count=6,
    )

    status = ingestor.latest_signal_status()

    assert status["state"] == "current"
    assert status["signal_rows"] == 12
    assert status["symbol_count"] == 6
    assert status["readiness_window_end"] == latest
    assert any("count() AS signal_rows" in query for query in ingestor.queries)


def test_latest_signal_status_keeps_current_state_when_readiness_count_fails() -> None:
    latest = datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc)
    ingestor = FailingReadinessIngestor(
        schema="envelope",
        table="torghut.ta_signals",
        url="http://example",
        latest_signal_ts=latest,
        signal_rows=12,
        symbol_count=6,
    )

    status = ingestor.latest_signal_status()

    assert status["state"] == "current"
    assert status["readiness_reason_codes"] == ["clickhouse_ta_readiness_query_failed"]
    assert "count query unavailable" in status["readiness_detail"]


def test_latest_signal_readiness_counts_include_source_filter() -> None:
    latest = datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc)
    ingestor = SourceFilteredReadinessIngestor(
        schema="envelope",
        table="torghut.ta_signals",
        url="http://example",
        latest_signal_ts=latest,
        signal_rows=12,
        symbol_count=6,
    )

    status = ingestor.latest_signal_status()

    assert status["signal_rows"] == 12
    readiness_queries = [
        query for query in ingestor.queries if "count() AS signal_rows" in query
    ]
    assert readiness_queries
    assert "lower(source) IN ('ta')" in readiness_queries[0]
