from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone

from app.trading.ingest import ClickHouseSignalIngestor
from app.trading.ingest.clickhouse_signal_source_freshness import (
    ClickHouseSignalFreshnessContext,
)
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
    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if "uniqExact(symbol)" in query:
            raise RuntimeError("count query unavailable")
        return super()._query_clickhouse(query)


class SourceFreshnessIngestor(SourceFilteredReadinessIngestor):
    def __init__(
        self,
        *args: object,
        source_rows: list[dict[str, object]],
        coverage_rows: list[dict[str, object]],
        now: datetime | None = None,
        **kwargs: object,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.source_rows = source_rows
        self.coverage_rows = coverage_rows
        self.now = now

    def _accepted_signal_sources(self) -> tuple[str, ...]:
        return ("ta",)

    def _signal_freshness_context(self) -> ClickHouseSignalFreshnessContext:
        context = super()._signal_freshness_context()
        now = self.now
        if now is None:
            return context
        return replace(context, now=lambda: now)

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "GROUP BY source" in query:
            return self.source_rows
        if "GROUP BY symbol" in query:
            return self.coverage_rows
        return super()._query_clickhouse(query)


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


def test_latest_signal_status_blocks_stale_accepted_source_and_reports_excluded_fresher_source() -> (
    None
):
    now = datetime(2026, 5, 13, 15, 30, tzinfo=timezone.utc)
    latest = now - timedelta(minutes=10)
    rest_latest = now - timedelta(minutes=2)
    ingestor = SourceFreshnessIngestor(
        schema="envelope",
        table="torghut.ta_signals",
        url="http://example",
        latest_signal_ts=latest,
        signal_rows=12,
        symbol_count=6,
        source_rows=[
            {
                "source": "rest",
                "latest_signal_ts": rest_latest.isoformat(),
                "signal_rows": "40",
                "symbol_count": "10",
            },
            {
                "source": "ta",
                "latest_signal_ts": latest.isoformat(),
                "signal_rows": "12",
                "symbol_count": "6",
            },
        ],
        coverage_rows=[
            {
                "symbol": "NVDA",
                "latest_signal_ts": latest.isoformat(),
                "signal_rows": "3",
            }
        ],
        now=now,
    )

    status = ingestor.latest_signal_status()

    assert status["accepted_sources"] == ["ta"]
    assert status["accepted_source_state"] == "stale"
    assert status["blocking_reason"] == "accepted_ta_signal_stale"
    assert status["market_session_state"] == "regular_open"
    assert status["regular_session_open"] is True
    assert status["excluded_fresher_sources"] == [
        {
            "source": "rest",
            "latest_signal_at": rest_latest,
            "lag_vs_accepted_seconds": 480,
            "signal_rows": 40,
            "symbol_count": 10,
            "excluded_reason": "source_not_allowed_for_live_runtime",
        }
    ]
    assert status["per_symbol_coverage"] == [
        {
            "symbol": "NVDA",
            "latest_signal_at": latest,
            "lag_seconds": 0,
            "signal_rows": 3,
        }
    ]


def test_latest_signal_status_does_not_hard_block_stale_accepted_source_after_close() -> (
    None
):
    now = datetime(2026, 7, 7, 22, 0, tzinfo=timezone.utc)
    latest = datetime(2026, 7, 7, 20, 47, 5, tzinfo=timezone.utc)
    rest_latest = datetime(2026, 7, 7, 20, 59, tzinfo=timezone.utc)
    ingestor = SourceFreshnessIngestor(
        schema="envelope",
        table="torghut.ta_signals",
        url="http://example",
        latest_signal_ts=latest,
        signal_rows=12,
        symbol_count=6,
        source_rows=[
            {
                "source": "rest",
                "latest_signal_ts": rest_latest.isoformat(),
                "signal_rows": "40",
                "symbol_count": "10",
            },
            {
                "source": "ta",
                "latest_signal_ts": latest.isoformat(),
                "signal_rows": "12",
                "symbol_count": "6",
            },
        ],
        coverage_rows=[
            {
                "symbol": "NVDA",
                "latest_signal_ts": latest.isoformat(),
                "signal_rows": "3",
            }
        ],
        now=now,
    )

    status = ingestor.latest_signal_status()

    assert status["accepted_sources"] == ["ta"]
    assert status["accepted_lag_seconds"] > status["accepted_max_lag_seconds"]
    assert status["accepted_source_state"] == "outside_regular_session"
    assert status["blocking_reason"] is None
    assert status["market_session_state"] == "after_market_close"
    assert status["regular_session_open"] is False
    assert status["freshness_reason_codes"] == [
        "accepted_ta_signal_outside_regular_session"
    ]
