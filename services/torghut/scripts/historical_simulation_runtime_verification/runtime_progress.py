from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from urllib.parse import urlsplit

import psycopg

from .shared_runtime import (
    DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
    DEFAULT_RUN_MONITOR_MIN_DECISIONS,
    DEFAULT_RUN_MONITOR_MIN_EXECUTIONS,
    DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
    DEFAULT_RUN_MONITOR_MIN_TCA,
    _as_mapping,
    _as_text,
    _http_clickhouse_query,
    _parse_optional_rfc3339_timestamp,
    _resolve_window_bounds,
    _resource_attr,
    _run_with_transient_postgres_retry,
    _safe_int,
)


@dataclass(frozen=True)
class _ActivityWindow:
    start: datetime
    end: datetime
    monitor: Mapping[str, Any]
    timestamps: Mapping[str, datetime | None]
    cursor_at: datetime | None
    cursor_terminal_tolerance_seconds: int
    effective_terminal_signal_ts: datetime


@dataclass(frozen=True)
class _ActivityCompletion:
    thresholds_met: bool
    order_event_contract_met: bool
    terminal_reached: bool
    classification: str


def _monitor_snapshot(postgres_config: Any) -> dict[str, Any]:
    dsn = _as_text(_resource_attr(postgres_config, "torghut_runtime_dsn")) or _as_text(
        _resource_attr(postgres_config, "simulation_dsn")
    )
    if dsn is None:
        raise RuntimeError("postgres runtime dsn is required")

    def _snapshot() -> dict[str, Any]:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                      (SELECT count(*) FROM trade_decisions) AS trade_decisions,
                      (SELECT count(*) FROM executions) AS executions,
                      (SELECT count(*) FROM execution_tca_metrics) AS execution_tca_metrics,
                      (SELECT count(*) FROM execution_order_events) AS execution_order_events,
                      (SELECT max(cursor_at) FROM trade_cursor WHERE source = 'clickhouse') AS cursor_at
                    """
                )
                row = cursor.fetchone()
                trade_decisions = _safe_int(row[0] if row else 0)
                executions = _safe_int(row[1] if row else 0)
                execution_tca_metrics = _safe_int(row[2] if row else 0)
                execution_order_events = _safe_int(row[3] if row else 0)
                cursor_at_raw = row[4] if row else None
                cursor_at = (
                    cursor_at_raw.astimezone(timezone.utc)
                    if isinstance(cursor_at_raw, datetime)
                    else None
                )
        return {
            "trade_decisions": trade_decisions,
            "executions": executions,
            "execution_tca_metrics": execution_tca_metrics,
            "execution_order_events": execution_order_events,
            "cursor_at": cursor_at.isoformat() if cursor_at is not None else None,
        }

    return cast(
        dict[str, Any],
        _run_with_transient_postgres_retry(
            label="monitor_snapshot", operation=_snapshot
        ),
    )


def _progress_component_snapshot(
    *, resources: Any, postgres_config: Any
) -> dict[str, dict[str, Any]]:
    dsn = _as_text(_resource_attr(postgres_config, "torghut_runtime_dsn")) or _as_text(
        _resource_attr(postgres_config, "simulation_dsn")
    )
    run_id = _as_text(_resource_attr(resources, "run_id"))
    if dsn is None or run_id is None:
        return {}

    def _load() -> dict[str, dict[str, Any]]:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                      component,
                      status,
                      dataset_id,
                      lane,
                      workflow_name,
                      last_source_ts,
                      last_signal_ts,
                      last_price_ts,
                      cursor_at,
                      records_dumped,
                      records_replayed,
                      trade_decisions,
                      executions,
                      execution_tca_metrics,
                      execution_order_events,
                      strategy_type,
                      legacy_path_count,
                      fallback_count,
                      terminal_state,
                      last_error_code,
                      last_error_message,
                      payload_json
                    FROM simulation_run_progress
                    WHERE run_id = %s
                    """,
                    (run_id,),
                )
                rows = cursor.fetchall()
        components: dict[str, dict[str, Any]] = {}
        for row in rows:
            component = _as_text(row[0])
            if component is None:
                continue
            components[component] = {
                "status": _as_text(row[1]),
                "dataset_id": _as_text(row[2]),
                "lane": _as_text(row[3]),
                "workflow_name": _as_text(row[4]),
                "last_source_ts": row[5].astimezone(timezone.utc).isoformat()
                if isinstance(row[5], datetime)
                else None,
                "last_signal_ts": row[6].astimezone(timezone.utc).isoformat()
                if isinstance(row[6], datetime)
                else None,
                "last_price_ts": row[7].astimezone(timezone.utc).isoformat()
                if isinstance(row[7], datetime)
                else None,
                "cursor_at": row[8].astimezone(timezone.utc).isoformat()
                if isinstance(row[8], datetime)
                else None,
                "records_dumped": _safe_int(row[9]),
                "records_replayed": _safe_int(row[10]),
                "trade_decisions": _safe_int(row[11]),
                "executions": _safe_int(row[12]),
                "execution_tca_metrics": _safe_int(row[13]),
                "execution_order_events": _safe_int(row[14]),
                "strategy_type": _as_text(row[15]),
                "legacy_path_count": _safe_int(row[16]),
                "fallback_count": _safe_int(row[17]),
                "terminal_state": _as_text(row[18]),
                "last_error_code": _as_text(row[19]),
                "last_error_message": _as_text(row[20]),
                "payload": _as_mapping(row[21]),
            }
        return components

    try:
        return cast(
            dict[str, dict[str, Any]],
            _run_with_transient_postgres_retry(
                label="progress_component_snapshot", operation=_load
            ),
        )
    except Exception:
        return {}


def _clickhouse_table_activity(*, config: Any, table: str) -> dict[str, Any]:
    last_status, last_body = _http_clickhouse_query(
        config=config,
        query=f"SELECT toString(maxOrNull(event_ts)) FROM {table}",
    )
    last_event_ts = None
    if 200 <= last_status < 300:
        parsed = _parse_optional_rfc3339_timestamp(_as_text(last_body.strip()))
        last_event_ts = parsed.isoformat() if parsed is not None else None
    return {
        "rows": 1 if last_event_ts is not None else 0,
        "last_event_ts": last_event_ts,
    }


def _signal_snapshot(*, resources: Any, clickhouse_config: Any) -> dict[str, Any]:
    counts: dict[str, Any] = {}
    for key, table in {
        "signal_rows": _resource_attr(resources, "clickhouse_signal_table"),
        "price_rows": _resource_attr(resources, "clickhouse_price_table"),
    }.items():
        activity = _clickhouse_table_activity(
            config=clickhouse_config, table=str(table)
        )
        counts[key] = _safe_int(activity.get("rows"), default=0)
        if key == "signal_rows":
            counts["last_signal_ts"] = _as_text(activity.get("last_event_ts"))
        elif key == "price_rows":
            counts["last_price_ts"] = _as_text(activity.get("last_event_ts"))
    return counts


def _simulation_progress_snapshot(
    *,
    resources: Any,
    postgres_config: Any,
    clickhouse_config: Any,
) -> dict[str, Any]:
    components = _progress_component_snapshot(
        resources=resources, postgres_config=postgres_config
    )
    direct_snapshot = _monitor_snapshot(postgres_config)
    if not components:
        snapshot = direct_snapshot
        snapshot.update(
            _signal_snapshot(resources=resources, clickhouse_config=clickhouse_config)
        )
        snapshot["progress_source"] = "direct_tables"
        snapshot["components"] = {}
        return snapshot

    torghut = _as_mapping(components.get("torghut"))
    replay = _as_mapping(components.get("replay"))
    ta = _as_mapping(components.get("ta"))
    cursor_at = _latest_progress_cursor(torghut, direct_snapshot)
    counts = _progress_counts(torghut, direct_snapshot)
    signal_snapshot = _signal_snapshot(
        resources=resources, clickhouse_config=clickhouse_config
    )
    timestamps = _progress_timestamps(signal_snapshot, torghut, replay, ta)
    progress_source = _progress_source(
        cursor_at=cursor_at,
        progress_cursor_at=_parse_optional_rfc3339_timestamp(
            _as_text(torghut.get("cursor_at"))
        ),
        counts=counts,
        torghut=torghut,
    )
    return {
        "progress_source": progress_source,
        "components": components,
        **counts,
        "cursor_at": cursor_at.isoformat() if cursor_at is not None else None,
        "signal_rows": 1 if timestamps["last_signal_ts"] is not None else 0,
        "price_rows": 1 if timestamps["last_price_ts"] is not None else 0,
        **timestamps,
        "records_dumped": _safe_int(replay.get("records_dumped")),
        "records_replayed": _safe_int(replay.get("records_replayed")),
        "strategy_type": _as_text(torghut.get("strategy_type"))
        or _as_text(replay.get("strategy_type")),
        "legacy_path_count": _safe_int(torghut.get("legacy_path_count")),
        "fallback_count": _safe_int(torghut.get("fallback_count")),
    }


def _latest_progress_cursor(
    torghut: Mapping[str, Any], direct_snapshot: Mapping[str, Any]
) -> datetime | None:
    direct_cursor_at = _parse_optional_rfc3339_timestamp(
        _as_text(direct_snapshot.get("cursor_at"))
    )
    progress_cursor_at = _parse_optional_rfc3339_timestamp(
        _as_text(torghut.get("cursor_at"))
    )
    if direct_cursor_at and (
        progress_cursor_at is None or direct_cursor_at > progress_cursor_at
    ):
        return direct_cursor_at
    return progress_cursor_at


def _progress_counts(
    torghut: Mapping[str, Any], direct_snapshot: Mapping[str, Any]
) -> dict[str, int]:
    return {
        "trade_decisions": max(
            _safe_int(torghut.get("trade_decisions")),
            _safe_int(direct_snapshot.get("trade_decisions")),
        ),
        "executions": max(
            _safe_int(torghut.get("executions")),
            _safe_int(direct_snapshot.get("executions")),
        ),
        "execution_tca_metrics": max(
            _safe_int(torghut.get("execution_tca_metrics")),
            _safe_int(direct_snapshot.get("execution_tca_metrics")),
        ),
        "execution_order_events": max(
            _safe_int(torghut.get("execution_order_events")),
            _safe_int(direct_snapshot.get("execution_order_events")),
        ),
    }


def _progress_timestamps(
    signal_snapshot: Mapping[str, Any],
    torghut: Mapping[str, Any],
    replay: Mapping[str, Any],
    ta: Mapping[str, Any],
) -> dict[str, str | None]:
    return {
        "last_signal_ts": _as_text(signal_snapshot.get("last_signal_ts"))
        or _as_text(torghut.get("last_signal_ts"))
        or _as_text(replay.get("last_signal_ts"))
        or _as_text(ta.get("last_signal_ts")),
        "last_price_ts": _as_text(signal_snapshot.get("last_price_ts"))
        or _as_text(torghut.get("last_price_ts"))
        or _as_text(replay.get("last_price_ts"))
        or _as_text(ta.get("last_price_ts")),
        "last_source_ts": _as_text(replay.get("last_source_ts"))
        or _as_text(torghut.get("last_source_ts"))
        or _as_text(ta.get("last_source_ts")),
    }


def _progress_source(
    *,
    cursor_at: datetime | None,
    progress_cursor_at: datetime | None,
    counts: Mapping[str, int],
    torghut: Mapping[str, Any],
) -> str:
    direct_tables_contributed = any(
        counts[key] > _safe_int(torghut.get(key)) for key in counts
    ) or (
        cursor_at is not None
        and (progress_cursor_at is None or cursor_at > progress_cursor_at)
    )
    return (
        "simulation_run_progress+direct_tables"
        if direct_tables_contributed
        else "simulation_run_progress"
    )


def _effective_terminal_signal_ts(
    *,
    window_end: datetime,
    last_signal_ts: datetime | None,
    last_price_ts: datetime | None,
    last_source_ts: datetime | None,
) -> datetime:
    coverage_candidates = [
        timestamp
        for timestamp in (last_source_ts, last_price_ts, last_signal_ts)
        if timestamp is not None
    ]
    if not coverage_candidates:
        return window_end
    return min(max(coverage_candidates), window_end)


def _clickhouse_database_from_jdbc_url(raw_url: str | None) -> str | None:
    text = (raw_url or "").strip()
    if not text:
        return None
    if text.startswith("jdbc:"):
        text = text[len("jdbc:") :]
    parsed = urlsplit(text)
    if not parsed.path:
        return None
    database = parsed.path.lstrip("/").split("/", 1)[0]
    return database or None


def _clickhouse_database_from_table_name(table_name: str | None) -> str | None:
    text = (table_name or "").strip()
    if not text:
        return None
    database, separator, _table = text.partition(".")
    if not separator:
        return None
    database = database.strip()
    return database or None


def _cursor_reached_terminal(
    cursor_at: datetime | None,
    effective_terminal_signal_ts: datetime,
    *,
    tolerance_seconds: int,
) -> bool:
    if cursor_at is None:
        return False
    return (
        cursor_at + timedelta(seconds=max(0, tolerance_seconds))
        >= effective_terminal_signal_ts
    )


def _classify_activity_snapshot(
    *,
    runtime_ready: bool,
    snapshot: Mapping[str, Any],
    effective_terminal_signal_ts: datetime,
    cursor_terminal_tolerance_seconds: int = DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
) -> str:
    cursor_at = _parse_optional_rfc3339_timestamp(_as_text(snapshot.get("cursor_at")))
    cursor_at_raw = snapshot.get("cursor_at")
    signal_rows = _safe_int(snapshot.get("signal_rows"))
    trade_decisions = _safe_int(snapshot.get("trade_decisions"))
    executions = _safe_int(snapshot.get("executions"))
    execution_tca_metrics = _safe_int(snapshot.get("execution_tca_metrics"))
    execution_order_events = _safe_int(snapshot.get("execution_order_events"))
    cursor_terminal_reached = _cursor_reached_terminal(
        cursor_at,
        effective_terminal_signal_ts,
        tolerance_seconds=cursor_terminal_tolerance_seconds,
    )
    has_terminal_success_snapshot = (
        signal_rows > 0
        and cursor_terminal_reached
        and trade_decisions > 0
        and executions > 0
        and execution_tca_metrics > 0
        and execution_order_events > 0
    )
    classification = "success"
    if not has_terminal_success_snapshot and not runtime_ready:
        classification = "infra_not_active"
    elif not has_terminal_success_snapshot and signal_rows <= 0:
        classification = "signals_absent"
    elif not has_terminal_success_snapshot and (
        cursor_at_raw is None or cursor_at is None
    ):
        classification = "cursor_not_advancing"
    elif not has_terminal_success_snapshot and not cursor_terminal_reached:
        classification = "cursor_stalled_before_terminal_signal"
    elif not has_terminal_success_snapshot and trade_decisions <= 0:
        classification = "decisions_absent"
    elif not has_terminal_success_snapshot and (
        executions <= 0
        or execution_tca_metrics <= 0
        or (executions > 0 and execution_order_events <= 0)
    ):
        classification = "executions_absent"
    return classification


def _activity_state(
    *,
    manifest: Mapping[str, Any],
    runtime_verify: Mapping[str, Any],
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    window = _activity_window(manifest=manifest, snapshot=snapshot)
    completion = _activity_completion(
        runtime_verify=runtime_verify, snapshot=snapshot, window=window
    )
    return {
        "window_start": window.start.isoformat(),
        "window_end": window.end.isoformat(),
        "effective_terminal_signal_ts": window.effective_terminal_signal_ts.isoformat(),
        "last_signal_ts": _isoformat_or_none(window.timestamps["last_signal_ts"]),
        "last_price_ts": _isoformat_or_none(window.timestamps["last_price_ts"]),
        "last_source_ts": _isoformat_or_none(window.timestamps["last_source_ts"]),
        "cursor_at": _isoformat_or_none(window.cursor_at),
        "cursor_gap_seconds": _cursor_gap_seconds(window),
        "cursor_terminal_tolerance_seconds": window.cursor_terminal_tolerance_seconds,
        "thresholds_met": completion.thresholds_met,
        "order_event_contract_met": completion.order_event_contract_met,
        "terminal_reached": completion.terminal_reached,
        "activity_classification": completion.classification,
        "completion_reason": _terminal_reason(window)
        if completion.terminal_reached
        else "waiting_for_terminal_signal",
        "dataset_alignment": (
            "window_declared_beyond_dataset"
            if window.effective_terminal_signal_ts < window.end
            else "window_aligned_with_dataset"
        ),
    }


def _activity_window(
    *, manifest: Mapping[str, Any], snapshot: Mapping[str, Any]
) -> _ActivityWindow:
    start, end = _resolve_window_bounds(manifest)
    monitor = _as_mapping(manifest.get("monitor"))
    timestamps = _activity_timestamps(snapshot)
    return _ActivityWindow(
        start=start,
        end=end,
        monitor=monitor,
        timestamps=timestamps,
        cursor_at=_parse_optional_rfc3339_timestamp(
            _as_text(snapshot.get("cursor_at"))
        ),
        cursor_terminal_tolerance_seconds=_safe_int(
            monitor.get("cursor_terminal_tolerance_seconds"),
            default=DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
        ),
        effective_terminal_signal_ts=_effective_terminal_signal_ts(
            window_end=end,
            last_signal_ts=timestamps["last_signal_ts"],
            last_price_ts=timestamps["last_price_ts"],
            last_source_ts=timestamps["last_source_ts"],
        ),
    )


def _activity_completion(
    *,
    runtime_verify: Mapping[str, Any],
    snapshot: Mapping[str, Any],
    window: _ActivityWindow,
) -> _ActivityCompletion:
    counts = _activity_counts(snapshot)
    terminal_reached = _cursor_reached_terminal(
        window.cursor_at,
        window.effective_terminal_signal_ts,
        tolerance_seconds=window.cursor_terminal_tolerance_seconds,
    )
    return _ActivityCompletion(
        thresholds_met=_activity_thresholds_met(monitor=window.monitor, counts=counts),
        order_event_contract_met=(
            counts["executions"] <= 0 or counts["execution_order_events"] > 0
        ),
        terminal_reached=terminal_reached,
        classification=_classify_activity_snapshot(
            runtime_ready=bool(runtime_verify.get("runtime_state") == "ready"),
            snapshot=snapshot,
            effective_terminal_signal_ts=window.effective_terminal_signal_ts,
            cursor_terminal_tolerance_seconds=window.cursor_terminal_tolerance_seconds,
        ),
    )


def _activity_timestamps(snapshot: Mapping[str, Any]) -> dict[str, datetime | None]:
    return {
        "last_signal_ts": _parse_optional_rfc3339_timestamp(
            _as_text(snapshot.get("last_signal_ts"))
        ),
        "last_price_ts": _parse_optional_rfc3339_timestamp(
            _as_text(snapshot.get("last_price_ts"))
        ),
        "last_source_ts": _parse_optional_rfc3339_timestamp(
            _as_text(snapshot.get("last_source_ts"))
        ),
    }


def _activity_counts(snapshot: Mapping[str, Any]) -> dict[str, int]:
    return {
        "trade_decisions": _safe_int(snapshot.get("trade_decisions")),
        "executions": _safe_int(snapshot.get("executions")),
        "execution_tca_metrics": _safe_int(snapshot.get("execution_tca_metrics")),
        "execution_order_events": _safe_int(snapshot.get("execution_order_events")),
    }


def _activity_thresholds_met(
    *, monitor: Mapping[str, Any], counts: Mapping[str, int]
) -> bool:
    return (
        counts["trade_decisions"]
        >= _safe_int(
            monitor.get("min_trade_decisions"),
            default=DEFAULT_RUN_MONITOR_MIN_DECISIONS,
        )
        and counts["executions"]
        >= _safe_int(
            monitor.get("min_executions"),
            default=DEFAULT_RUN_MONITOR_MIN_EXECUTIONS,
        )
        and counts["execution_tca_metrics"]
        >= _safe_int(
            monitor.get("min_execution_tca_metrics"),
            default=DEFAULT_RUN_MONITOR_MIN_TCA,
        )
        and counts["execution_order_events"]
        >= _safe_int(
            monitor.get("min_execution_order_events"),
            default=DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
        )
    )


def _isoformat_or_none(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _cursor_gap_seconds(window: _ActivityWindow) -> float | None:
    if window.cursor_at is None:
        return None
    return max(
        (window.effective_terminal_signal_ts - window.cursor_at).total_seconds(), 0.0
    )


def _terminal_reason(window: _ActivityWindow) -> str:
    if window.effective_terminal_signal_ts < window.end:
        return "terminal_signal_reached"
    return "window_end_reached"


__all__ = [
    "_activity_state",
    "_classify_activity_snapshot",
    "_clickhouse_table_activity",
    "_cursor_reached_terminal",
    "_effective_terminal_signal_ts",
    "_monitor_snapshot",
    "_progress_component_snapshot",
    "_signal_snapshot",
    "_simulation_progress_snapshot",
]
