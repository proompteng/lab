from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base
from app.trading.ingest import ClickHouseSignalIngestor
from app.trading.ingest import (
    _normalized_signal_symbols,
    _normalized_signal_timeframes,
    _timeframes_to_iso_durations,
)
from app.trading.models import SignalEnvelope


class TimeoutAfterLatestIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args: Any, latest_signal_ts: datetime, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.latest_signal_ts = latest_signal_ts
        self.queries: list[str] = []
        self._columns = {"event_ts", "symbol", "payload", "window_size", "seq", "source"}
        self._time_column = "event_ts"

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        self.queries.append(query)
        if "latest_signal_ts" in query:
            return [{"latest_signal_ts": self.latest_signal_ts.isoformat()}]
        raise TimeoutError("timed out")


class ScopedLatestResponsesIngestor(ClickHouseSignalIngestor):
    def __init__(self, *args: Any, responses: list[object], **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.responses = list(responses)
        self._columns = {"event_ts", "symbol", "payload", "window_size", "seq"}
        self._time_column = "event_ts"

    def _query_clickhouse(self, query: str) -> list[dict[str, object]]:
        if not self.responses:
            return []
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_scoped_timeout_returns_only_non_authority_last_good_fallback() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
    signal = SignalEnvelope(
        event_ts=now - timedelta(seconds=5),
        symbol="AAPL",
        payload={"price": "100"},
        timeframe="1Sec",
        seq=1,
    )
    ingestor = TimeoutAfterLatestIngestor(
        schema="envelope",
        table="torghut.ta_signals",
        url="http://clickhouse.test",
        latest_signal_ts=now,
        fast_forward_stale_cursor=False,
        account_label="TORGHUT_SIM",
    )
    ingestor._remember_last_good_signals(
        scope_key=(("AAPL", "AMZN"), ("1Sec",)),
        signals=[signal],
        query_start=now - timedelta(seconds=10),
        query_end=now,
        observed_at=now - timedelta(seconds=1),
    )

    with session_local() as session, patch("app.trading.ingest.trading_now", return_value=now):
        batch = ingestor.fetch_signals(
            session,
            symbols={"AAPL", "AMZN"},
            timeframes={"1Sec"},
        )

    assert batch.signals == []
    assert batch.no_signal_reason == "clickhouse_signal_query_timeout"
    assert batch.signals_authoritative is False
    assert batch.degraded_signal_source == "last_good_non_authority_stale_bounded"
    assert len(batch.fallback_signals) == 1
    fallback_payload = batch.fallback_signals[0].payload
    assert fallback_payload["signal_authority"] == "non_authority_stale_bounded_fallback"
    assert fallback_payload["signal_ingest_fallback"]["reason"] == "clickhouse_signal_query_timeout"
    assert any("symbol IN ('AAPL', 'AMZN')" in query for query in ingestor.queries)
    assert any("window_size IN ('PT1S')" in query for query in ingestor.queries)


def test_scoped_latest_timestamp_cache_and_refresh_failure_paths() -> None:
    latest = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
    ingestor = ScopedLatestResponsesIngestor(
        schema="envelope",
        table="torghut.ta_signals",
        url="http://clickhouse.test",
        responses=[
            [{"latest_signal_ts": latest.isoformat()}],
            TimeoutError("scoped latest timeout"),
        ],
    )

    first = ingestor._latest_signal_timestamp(
        "event_ts",
        symbols=("AAPL",),
        timeframes=("1Sec",),
    )
    second = ingestor._latest_signal_timestamp(
        "event_ts",
        symbols=("AAPL",),
        timeframes=("1Sec",),
    )
    ingestor._latest_signal_ts_scoped_checked_at[(("AAPL",), ("1Sec",))] = (
        datetime.now(timezone.utc) - timedelta(seconds=31)
    )
    third = ingestor._latest_signal_timestamp(
        "event_ts",
        symbols=("AAPL",),
        timeframes=("1Sec",),
    )

    assert first == latest
    assert second == latest
    assert third == latest


def test_scoped_latest_timestamp_caches_empty_result() -> None:
    ingestor = ScopedLatestResponsesIngestor(
        schema="envelope",
        table="torghut.ta_signals",
        url="http://clickhouse.test",
        responses=[[]],
    )

    latest = ingestor._latest_signal_timestamp(
        "event_ts",
        symbols=("AAPL",),
        timeframes=("1Sec",),
    )

    assert latest is None
    assert ingestor._latest_signal_ts_scoped_cache[(("AAPL",), ("1Sec",))] is None


def test_timeframe_scope_clause_uses_available_schema_columns() -> None:
    ingestor = ClickHouseSignalIngestor(schema="auto", url="http://clickhouse.test")
    ingestor._columns = {"event_ts", "symbol", "timeframe"}
    assert ingestor._timeframe_where_clause(("1Sec",)) == "timeframe IN ('1Sec')"
    ingestor._columns = {"event_ts", "symbol", "window_size"}
    assert ingestor._timeframe_where_clause(("1Sec",)) == "window_size IN ('PT1S')"
    ingestor._columns = {"event_ts", "symbol", "window_step"}
    assert ingestor._timeframe_where_clause(("1Min",)) == "window_step IN ('PT1M')"
    ingestor._columns = {"event_ts", "symbol"}
    assert ingestor._timeframe_where_clause(("1Hour",)) is None

    flat_ingestor = ClickHouseSignalIngestor(schema="flat")
    assert flat_ingestor._timeframe_where_clause(("1Sec",)) == "timeframe IN ('1Sec')"
    auto_ingestor = ClickHouseSignalIngestor(schema="auto")
    assert auto_ingestor._timeframe_where_clause(("1Sec",)) is None


def test_scope_normalization_filters_invalid_values_and_renders_iso_durations() -> None:
    assert _normalized_signal_symbols({"AAPL", "bad symbol", "amzn"}) == (
        "AAPL",
        "AMZN",
    )
    assert _normalized_signal_timeframes({"1Sec", "bad timeframe!"}) == ("1Sec",)
    assert _timeframes_to_iso_durations(("1Sec", "5Min", "2Hour", "custom")) == (
        "PT1S",
        "PT5M",
        "PT2H",
        "custom",
    )
