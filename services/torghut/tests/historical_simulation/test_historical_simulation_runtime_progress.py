from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from scripts.historical_simulation_verification_modules import runtime_progress


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


class _FakeCursor:
    def __init__(self, *, row=None, rows=None) -> None:
        self._row = row
        self._rows = rows or []

    def __enter__(self):
        return self

    def __exit__(self, *_exc_info) -> None:
        return None

    def execute(self, *_args) -> None:
        return None

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_exc_info) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self._cursor


def test_runtime_progress_monitor_snapshot_loads_direct_counts(monkeypatch) -> None:
    cursor = _FakeCursor(
        row=(3, 2, 2, 2, _ts("2026-03-13T20:00:00Z")),
    )
    monkeypatch.setattr(
        runtime_progress,
        "_run_with_transient_postgres_retry",
        lambda *, label, operation: operation(),
    )
    monkeypatch.setattr(
        runtime_progress.psycopg,
        "connect",
        lambda _dsn: _FakeConnection(cursor),
    )

    snapshot = runtime_progress._monitor_snapshot(
        SimpleNamespace(simulation_dsn="postgres://runtime")
    )

    assert snapshot == {
        "trade_decisions": 3,
        "executions": 2,
        "execution_tca_metrics": 2,
        "execution_order_events": 2,
        "cursor_at": "2026-03-13T20:00:00+00:00",
    }


def test_runtime_progress_monitor_snapshot_requires_dsn() -> None:
    try:
        runtime_progress._monitor_snapshot(SimpleNamespace())
    except RuntimeError as exc:
        assert str(exc) == "postgres runtime dsn is required"
    else:
        raise AssertionError("expected RuntimeError")


def test_runtime_progress_component_snapshot_loads_rows(monkeypatch) -> None:
    row = (
        "torghut",
        "ready",
        "dataset-a",
        "equity",
        "workflow",
        _ts("2026-03-13T13:30:00Z"),
        _ts("2026-03-13T19:59:00Z"),
        _ts("2026-03-13T20:00:00Z"),
        _ts("2026-03-13T20:00:00Z"),
        "10",
        "9",
        "5",
        "2",
        "2",
        "2",
        "hpairs",
        "1",
        "0",
        "done",
        None,
        None,
        {"ok": True},
    )
    cursor = _FakeCursor(rows=[(None, *row[1:]), row])
    monkeypatch.setattr(
        runtime_progress,
        "_run_with_transient_postgres_retry",
        lambda *, label, operation: operation(),
    )
    monkeypatch.setattr(
        runtime_progress.psycopg,
        "connect",
        lambda _dsn: _FakeConnection(cursor),
    )

    components = runtime_progress._progress_component_snapshot(
        resources=SimpleNamespace(run_id="sim-1"),
        postgres_config=SimpleNamespace(simulation_dsn="postgres://runtime"),
    )

    assert components["torghut"]["status"] == "ready"
    assert components["torghut"]["records_dumped"] == 10
    assert components["torghut"]["payload"] == {"ok": True}


def test_runtime_progress_component_snapshot_handles_missing_inputs_and_errors(
    monkeypatch,
) -> None:
    assert (
        runtime_progress._progress_component_snapshot(
            resources=SimpleNamespace(),
            postgres_config=SimpleNamespace(simulation_dsn="postgres://runtime"),
        )
        == {}
    )
    monkeypatch.setattr(
        runtime_progress,
        "_run_with_transient_postgres_retry",
        lambda *, label, operation: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    assert (
        runtime_progress._progress_component_snapshot(
            resources=SimpleNamespace(run_id="sim-1"),
            postgres_config=SimpleNamespace(simulation_dsn="postgres://runtime"),
        )
        == {}
    )


def test_runtime_progress_clickhouse_and_signal_snapshots(monkeypatch) -> None:
    monkeypatch.setattr(
        runtime_progress,
        "_http_clickhouse_query",
        lambda **_kwargs: (200, "2026-03-13T20:00:00Z"),
    )
    assert runtime_progress._clickhouse_table_activity(
        config=object(), table="sim.signals"
    ) == {
        "rows": 1,
        "last_event_ts": "2026-03-13T20:00:00+00:00",
    }

    monkeypatch.setattr(
        runtime_progress,
        "_http_clickhouse_query",
        lambda **_kwargs: (503, "unavailable"),
    )
    assert runtime_progress._clickhouse_table_activity(
        config=object(), table="sim.signals"
    ) == {"rows": 0, "last_event_ts": None}

    monkeypatch.setattr(
        runtime_progress,
        "_clickhouse_table_activity",
        lambda *, config, table: (
            {
                "rows": 7,
                "last_event_ts": "2026-03-13T20:00:00+00:00",
            }
            if table.endswith("signals")
            else {"rows": 8, "last_event_ts": "2026-03-13T19:59:00+00:00"}
        ),
    )
    signal_snapshot = runtime_progress._signal_snapshot(
        resources={
            "clickhouse_signal_table": "sim.signals",
            "clickhouse_price_table": "sim.prices",
        },
        clickhouse_config=object(),
    )

    assert signal_snapshot == {
        "signal_rows": 7,
        "last_signal_ts": "2026-03-13T20:00:00+00:00",
        "price_rows": 8,
        "last_price_ts": "2026-03-13T19:59:00+00:00",
    }


def test_runtime_progress_uses_direct_tables_when_no_progress_rows(
    monkeypatch,
) -> None:
    resources = {
        "clickhouse_signal_table": "sim.signals",
        "clickhouse_price_table": "sim.prices",
    }
    monkeypatch.setattr(
        runtime_progress,
        "_progress_component_snapshot",
        lambda **_kwargs: {},
    )
    monkeypatch.setattr(
        runtime_progress,
        "_monitor_snapshot",
        lambda _postgres_config: {
            "trade_decisions": 3,
            "executions": 2,
            "execution_tca_metrics": 2,
            "execution_order_events": 2,
            "cursor_at": "2026-03-13T20:00:00+00:00",
        },
    )
    monkeypatch.setattr(
        runtime_progress,
        "_signal_snapshot",
        lambda **_kwargs: {
            "signal_rows": 10,
            "price_rows": 11,
            "last_signal_ts": "2026-03-13T20:00:00+00:00",
            "last_price_ts": "2026-03-13T20:00:00+00:00",
        },
    )

    snapshot = runtime_progress._simulation_progress_snapshot(
        resources=resources,
        postgres_config=object(),
        clickhouse_config=object(),
    )

    assert snapshot["progress_source"] == "direct_tables"
    assert snapshot["trade_decisions"] == 3
    assert snapshot["signal_rows"] == 10


def test_runtime_progress_merges_progress_rows_with_direct_table_counts(
    monkeypatch,
) -> None:
    components = {
        "torghut": {
            "cursor_at": "2026-03-13T17:00:00+00:00",
            "trade_decisions": 1,
            "executions": 1,
            "execution_tca_metrics": 1,
            "execution_order_events": 1,
            "last_signal_ts": "2026-03-13T17:00:00+00:00",
            "strategy_type": "hpairs",
            "legacy_path_count": "2",
            "fallback_count": "0",
        },
        "replay": {
            "records_dumped": "10",
            "records_replayed": "9",
            "last_source_ts": "2026-03-13T19:00:00+00:00",
        },
        "ta": {"last_price_ts": "2026-03-13T18:00:00+00:00"},
    }
    monkeypatch.setattr(
        runtime_progress,
        "_progress_component_snapshot",
        lambda **_kwargs: components,
    )
    monkeypatch.setattr(
        runtime_progress,
        "_monitor_snapshot",
        lambda _postgres_config: {
            "trade_decisions": 5,
            "executions": 2,
            "execution_tca_metrics": 2,
            "execution_order_events": 2,
            "cursor_at": "2026-03-13T20:00:00+00:00",
        },
    )
    monkeypatch.setattr(
        runtime_progress,
        "_signal_snapshot",
        lambda **_kwargs: {
            "last_signal_ts": None,
            "last_price_ts": "2026-03-13T19:30:00+00:00",
        },
    )

    snapshot = runtime_progress._simulation_progress_snapshot(
        resources=SimpleNamespace(run_id="sim-1"),
        postgres_config=object(),
        clickhouse_config=object(),
    )

    assert snapshot["progress_source"] == "simulation_run_progress+direct_tables"
    assert snapshot["trade_decisions"] == 5
    assert snapshot["cursor_at"] == "2026-03-13T20:00:00+00:00"
    assert snapshot["last_signal_ts"] == "2026-03-13T17:00:00+00:00"
    assert snapshot["last_price_ts"] == "2026-03-13T19:30:00+00:00"
    assert snapshot["records_dumped"] == 10


def test_runtime_progress_activity_state_classifies_terminal_success() -> None:
    state = runtime_progress._activity_state(
        manifest={
            "window": {
                "start": "2026-03-13T13:30:00Z",
                "end": "2026-03-13T20:00:00Z",
            },
            "monitor": {
                "min_trade_decisions": 1,
                "min_executions": 1,
                "min_execution_tca_metrics": 1,
                "min_execution_order_events": 1,
            },
        },
        runtime_verify={"runtime_state": "ready"},
        snapshot={
            "last_source_ts": "2026-03-13T20:00:00Z",
            "last_signal_ts": "2026-03-13T20:00:00Z",
            "last_price_ts": "2026-03-13T20:00:00Z",
            "cursor_at": "2026-03-13T20:00:00Z",
            "signal_rows": 10,
            "trade_decisions": 2,
            "executions": 1,
            "execution_tca_metrics": 1,
            "execution_order_events": 1,
        },
    )

    assert state["activity_classification"] == "success"
    assert state["thresholds_met"] is True
    assert state["order_event_contract_met"] is True
    assert state["completion_reason"] == "window_end_reached"


def test_runtime_progress_activity_classification_branches() -> None:
    terminal = _ts("2026-03-13T20:00:00Z")

    assert (
        runtime_progress._classify_activity_snapshot(
            runtime_ready=False,
            snapshot={},
            effective_terminal_signal_ts=terminal,
        )
        == "infra_not_active"
    )
    assert (
        runtime_progress._classify_activity_snapshot(
            runtime_ready=True,
            snapshot={"signal_rows": 0},
            effective_terminal_signal_ts=terminal,
        )
        == "signals_absent"
    )
    assert (
        runtime_progress._classify_activity_snapshot(
            runtime_ready=True,
            snapshot={"signal_rows": 1},
            effective_terminal_signal_ts=terminal,
        )
        == "cursor_not_advancing"
    )
    assert (
        runtime_progress._classify_activity_snapshot(
            runtime_ready=True,
            snapshot={
                "signal_rows": 1,
                "cursor_at": "2026-03-13T19:00:00Z",
            },
            effective_terminal_signal_ts=terminal,
        )
        == "cursor_stalled_before_terminal_signal"
    )
    assert (
        runtime_progress._classify_activity_snapshot(
            runtime_ready=True,
            snapshot={
                "signal_rows": 1,
                "cursor_at": "2026-03-13T20:00:00Z",
                "trade_decisions": 0,
            },
            effective_terminal_signal_ts=terminal,
        )
        == "decisions_absent"
    )
    assert (
        runtime_progress._classify_activity_snapshot(
            runtime_ready=True,
            snapshot={
                "signal_rows": 1,
                "cursor_at": "2026-03-13T20:00:00Z",
                "trade_decisions": 1,
                "executions": 0,
            },
            effective_terminal_signal_ts=terminal,
        )
        == "executions_absent"
    )


def test_runtime_progress_database_parsers_and_cursor_helpers() -> None:
    assert (
        runtime_progress._clickhouse_database_from_jdbc_url("jdbc:http://host:8123/sim")
        == "sim"
    )
    assert (
        runtime_progress._clickhouse_database_from_jdbc_url("http://host:8123") is None
    )
    assert runtime_progress._clickhouse_database_from_table_name("sim.prices") == "sim"
    assert runtime_progress._clickhouse_database_from_table_name("prices") is None
    assert runtime_progress._cursor_reached_terminal(
        _ts("2026-03-13T19:59:50Z"),
        _ts("2026-03-13T20:00:00Z"),
        tolerance_seconds=10,
    )
