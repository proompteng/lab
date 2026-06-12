# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
from __future__ import annotations

import json
import re
import subprocess
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timedelta, timezone
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote_plus, unquote_plus, urlsplit
from zoneinfo import ZoneInfo

import psycopg
from scripts.simulation_lane_contracts import (
    EQUITY_SIMULATION_LANE,
    simulation_lane_contract,
    simulation_schema_registry_subject_roles,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_23 import *


def _kservice_env(
    service: Mapping[str, Any],
    *,
    namespace: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    spec = _as_mapping(service.get("spec"))
    template = _as_mapping(spec.get("template"))
    template_spec = _as_mapping(template.get("spec"))
    containers = template_spec.get("containers")
    if not isinstance(containers, list) or not containers:
        raise RuntimeError("kservice container spec missing")
    first = containers[0]
    if not isinstance(first, Mapping):
        raise RuntimeError("kservice container spec invalid")
    container = _as_mapping(first)
    container_name = _as_text(container.get("name")) or "user-container"
    env: list[dict[str, Any]] = []
    env_from_raw = container.get("envFrom")
    if namespace and isinstance(env_from_raw, list):
        for item in env_from_raw:
            if not isinstance(item, Mapping):
                continue
            config_map_ref = _as_mapping(
                cast(Mapping[str, Any], item).get("configMapRef")
            )
            config_map_name = _as_text(config_map_ref.get("name"))
            if config_map_name is None:
                continue
            config_map = _kubectl_json(
                namespace, ["get", "configmap", config_map_name, "-o", "json"]
            )
            for key, value in _as_mapping(config_map.get("data")).items():
                env.append({"name": key, "value": str(value)})
    env_raw = container.get("env")
    if isinstance(env_raw, list):
        for item in env_raw:
            if isinstance(item, Mapping):
                env.append(_as_mapping(item))
    return container_name, env


def _infer_monitor_profile(*, start: datetime, end: datetime) -> str:
    duration_minutes = (end - start).total_seconds() / 60.0
    if duration_minutes <= 15:
        return "compact"
    if duration_minutes <= 90:
        return "hourly"
    if duration_minutes >= US_EQUITIES_REGULAR_MINUTES:
        return "full_day"
    return DEFAULT_RUN_MONITOR_PROFILE


def _monitor_settings(manifest: Mapping[str, Any]) -> dict[str, int | str]:
    monitor = _as_mapping(manifest.get("monitor"))
    start, end = _resolve_window_bounds(manifest)
    profile = (_as_text(monitor.get("profile")) or "").strip().lower()
    if not profile:
        profile = _infer_monitor_profile(start=start, end=end)
    if profile not in MONITOR_PROFILE_DEFAULTS:
        raise RuntimeError(f"unsupported_monitor_profile:{profile}")

    defaults = MONITOR_PROFILE_DEFAULTS[profile]
    timeout_seconds = _safe_int(
        monitor.get("timeout_seconds"),
        default=defaults.get("timeout_seconds", DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS),
    )
    poll_seconds = _safe_int(
        monitor.get("poll_seconds"),
        default=defaults.get("poll_seconds", DEFAULT_RUN_MONITOR_POLL_SECONDS),
    )
    min_decisions = _safe_int(
        monitor.get("min_trade_decisions"), default=DEFAULT_RUN_MONITOR_MIN_DECISIONS
    )
    min_executions = _safe_int(
        monitor.get("min_executions"), default=DEFAULT_RUN_MONITOR_MIN_EXECUTIONS
    )
    min_tca = _safe_int(
        monitor.get("min_execution_tca_metrics"), default=DEFAULT_RUN_MONITOR_MIN_TCA
    )
    min_order_events = _safe_int(
        monitor.get("min_execution_order_events"),
        default=DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
    )
    cursor_grace_seconds = _safe_int(
        monitor.get("cursor_grace_seconds"),
        default=defaults.get(
            "cursor_grace_seconds", DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS
        ),
    )
    cursor_terminal_tolerance_seconds = _safe_int(
        monitor.get("cursor_terminal_tolerance_seconds"),
        default=DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
    )
    if timeout_seconds <= 0:
        raise RuntimeError("monitor.timeout_seconds must be > 0")
    if poll_seconds <= 0:
        raise RuntimeError("monitor.poll_seconds must be > 0")
    if min_decisions < 0 or min_executions < 0 or min_tca < 0 or min_order_events < 0:
        raise RuntimeError("monitor minimum thresholds cannot be negative")
    if cursor_grace_seconds < 0:
        raise RuntimeError("monitor.cursor_grace_seconds cannot be negative")
    if cursor_terminal_tolerance_seconds < 0:
        raise RuntimeError(
            "monitor.cursor_terminal_tolerance_seconds cannot be negative"
        )
    return {
        "profile": profile,
        "timeout_seconds": timeout_seconds,
        "poll_seconds": poll_seconds,
        "min_trade_decisions": min_decisions,
        "min_executions": min_executions,
        "min_execution_tca_metrics": min_tca,
        "min_execution_order_events": min_order_events,
        "cursor_grace_seconds": cursor_grace_seconds,
        "cursor_terminal_tolerance_seconds": cursor_terminal_tolerance_seconds,
    }


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
    direct_cursor_at = _parse_optional_rfc3339_timestamp(
        _as_text(direct_snapshot.get("cursor_at"))
    )
    progress_cursor_at = _parse_optional_rfc3339_timestamp(
        _as_text(torghut.get("cursor_at"))
    )
    cursor_at = (
        direct_cursor_at
        if direct_cursor_at
        and (progress_cursor_at is None or direct_cursor_at > progress_cursor_at)
        else progress_cursor_at
    )
    trade_decisions = max(
        _safe_int(torghut.get("trade_decisions")),
        _safe_int(direct_snapshot.get("trade_decisions")),
    )
    executions = max(
        _safe_int(torghut.get("executions")),
        _safe_int(direct_snapshot.get("executions")),
    )
    execution_tca_metrics = max(
        _safe_int(torghut.get("execution_tca_metrics")),
        _safe_int(direct_snapshot.get("execution_tca_metrics")),
    )
    execution_order_events = max(
        _safe_int(torghut.get("execution_order_events")),
        _safe_int(direct_snapshot.get("execution_order_events")),
    )
    signal_snapshot = _signal_snapshot(
        resources=resources, clickhouse_config=clickhouse_config
    )
    last_signal_ts = (
        _as_text(signal_snapshot.get("last_signal_ts"))
        or _as_text(torghut.get("last_signal_ts"))
        or _as_text(replay.get("last_signal_ts"))
        or _as_text(ta.get("last_signal_ts"))
    )
    last_price_ts = (
        _as_text(signal_snapshot.get("last_price_ts"))
        or _as_text(torghut.get("last_price_ts"))
        or _as_text(replay.get("last_price_ts"))
        or _as_text(ta.get("last_price_ts"))
    )
    last_source_ts = (
        _as_text(replay.get("last_source_ts"))
        or _as_text(torghut.get("last_source_ts"))
        or _as_text(ta.get("last_source_ts"))
    )
    progress_source = "simulation_run_progress"
    if (
        trade_decisions > _safe_int(torghut.get("trade_decisions"))
        or executions > _safe_int(torghut.get("executions"))
        or execution_tca_metrics > _safe_int(torghut.get("execution_tca_metrics"))
        or execution_order_events > _safe_int(torghut.get("execution_order_events"))
        or (
            cursor_at is not None
            and (progress_cursor_at is None or cursor_at > progress_cursor_at)
        )
    ):
        progress_source = "simulation_run_progress+direct_tables"
    return {
        "progress_source": progress_source,
        "components": components,
        "trade_decisions": trade_decisions,
        "executions": executions,
        "execution_tca_metrics": execution_tca_metrics,
        "execution_order_events": execution_order_events,
        "cursor_at": cursor_at.isoformat() if cursor_at is not None else None,
        "signal_rows": 1 if last_signal_ts is not None else 0,
        "price_rows": 1 if last_price_ts is not None else 0,
        "last_signal_ts": last_signal_ts,
        "last_price_ts": last_price_ts,
        "last_source_ts": last_source_ts,
        "records_dumped": _safe_int(replay.get("records_dumped")),
        "records_replayed": _safe_int(replay.get("records_replayed")),
        "strategy_type": _as_text(torghut.get("strategy_type"))
        or _as_text(replay.get("strategy_type")),
        "legacy_path_count": _safe_int(torghut.get("legacy_path_count")),
        "fallback_count": _safe_int(torghut.get("fallback_count")),
    }


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
    if has_terminal_success_snapshot:
        return "success"
    if not runtime_ready:
        return "infra_not_active"
    if signal_rows <= 0:
        return "signals_absent"
    if cursor_at_raw is None or cursor_at is None:
        return "cursor_not_advancing"
    if not cursor_terminal_reached:
        return "cursor_stalled_before_terminal_signal"
    if trade_decisions <= 0:
        return "decisions_absent"
    if (
        executions <= 0
        or execution_tca_metrics <= 0
        or (executions > 0 and execution_order_events <= 0)
    ):
        return "executions_absent"
    return "success"


def _activity_state(
    *,
    manifest: Mapping[str, Any],
    runtime_verify: Mapping[str, Any],
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    start, end = _resolve_window_bounds(manifest)
    runtime_ready = bool(runtime_verify.get("runtime_state") == "ready")
    last_signal_ts = _parse_optional_rfc3339_timestamp(
        _as_text(snapshot.get("last_signal_ts"))
    )
    last_price_ts = _parse_optional_rfc3339_timestamp(
        _as_text(snapshot.get("last_price_ts"))
    )
    last_source_ts = _parse_optional_rfc3339_timestamp(
        _as_text(snapshot.get("last_source_ts"))
    )
    cursor_at = _parse_optional_rfc3339_timestamp(_as_text(snapshot.get("cursor_at")))
    cursor_terminal_tolerance_seconds = _safe_int(
        _as_mapping(manifest.get("monitor")).get("cursor_terminal_tolerance_seconds"),
        default=DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
    )
    effective_terminal_signal_ts = _effective_terminal_signal_ts(
        window_end=end,
        last_signal_ts=last_signal_ts,
        last_price_ts=last_price_ts,
        last_source_ts=last_source_ts,
    )
    trade_decisions = _safe_int(snapshot.get("trade_decisions"))
    executions = _safe_int(snapshot.get("executions"))
    execution_tca_metrics = _safe_int(snapshot.get("execution_tca_metrics"))
    execution_order_events = _safe_int(snapshot.get("execution_order_events"))
    thresholds_met = (
        trade_decisions
        >= _safe_int(
            _as_mapping(manifest.get("monitor")).get("min_trade_decisions"),
            default=DEFAULT_RUN_MONITOR_MIN_DECISIONS,
        )
        and executions
        >= _safe_int(
            _as_mapping(manifest.get("monitor")).get("min_executions"),
            default=DEFAULT_RUN_MONITOR_MIN_EXECUTIONS,
        )
        and execution_tca_metrics
        >= _safe_int(
            _as_mapping(manifest.get("monitor")).get("min_execution_tca_metrics"),
            default=DEFAULT_RUN_MONITOR_MIN_TCA,
        )
        and execution_order_events
        >= _safe_int(
            _as_mapping(manifest.get("monitor")).get("min_execution_order_events"),
            default=DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
        )
    )
    order_event_contract_met = executions <= 0 or execution_order_events > 0
    terminal_reached = _cursor_reached_terminal(
        cursor_at,
        effective_terminal_signal_ts,
        tolerance_seconds=cursor_terminal_tolerance_seconds,
    )
    classification = _classify_activity_snapshot(
        runtime_ready=runtime_ready,
        snapshot=snapshot,
        effective_terminal_signal_ts=effective_terminal_signal_ts,
        cursor_terminal_tolerance_seconds=cursor_terminal_tolerance_seconds,
    )
    cursor_gap_seconds: float | None = None
    if cursor_at is not None:
        cursor_gap_seconds = max(
            (effective_terminal_signal_ts - cursor_at).total_seconds(), 0.0
        )
    terminal_reason = (
        "terminal_signal_reached"
        if effective_terminal_signal_ts < end
        else "window_end_reached"
    )
    return {
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "effective_terminal_signal_ts": effective_terminal_signal_ts.isoformat(),
        "last_signal_ts": last_signal_ts.isoformat()
        if last_signal_ts is not None
        else None,
        "last_price_ts": last_price_ts.isoformat()
        if last_price_ts is not None
        else None,
        "last_source_ts": last_source_ts.isoformat()
        if last_source_ts is not None
        else None,
        "cursor_at": cursor_at.isoformat() if cursor_at is not None else None,
        "cursor_gap_seconds": cursor_gap_seconds,
        "cursor_terminal_tolerance_seconds": cursor_terminal_tolerance_seconds,
        "thresholds_met": thresholds_met,
        "order_event_contract_met": order_event_contract_met,
        "terminal_reached": terminal_reached,
        "activity_classification": classification,
        "completion_reason": terminal_reason
        if terminal_reached
        else "waiting_for_terminal_signal",
        "dataset_alignment": (
            "window_declared_beyond_dataset"
            if effective_terminal_signal_ts < end
            else "window_aligned_with_dataset"
        ),
    }


def _runtime_verify(*, resources: Any, manifest: Mapping[str, Any]) -> dict[str, Any]:
    window_start, window_end = _resolve_window_bounds(manifest)
    lane_contract = _resource_lane_contract(resources)
    namespace = _as_text(_resource_attr(resources, "namespace")) or "torghut"
    torghut_service = _as_text(_resource_attr(resources, "torghut_service"))
    ta_deployment = _as_text(_resource_attr(resources, "ta_deployment"))
    ta_configmap = _as_text(_resource_attr(resources, "ta_configmap"))
    if torghut_service is None or ta_deployment is None or ta_configmap is None:
        raise RuntimeError("simulation resources are incomplete")

    service = _kubectl_json(
        namespace, ["get", "kservice", torghut_service, "-o", "json"]
    )
    service_status = _as_mapping(service.get("status"))
    latest_ready_revision = _as_text(service_status.get("latestReadyRevisionName"))
    ready = _condition_status(service_status, condition_type="Ready") == "True"
    _, env_entries = _kservice_env(service, namespace=namespace)
    env_by_name = {
        _as_text(entry.get("name")): entry
        for entry in env_entries
        if _as_text(entry.get("name"))
    }

    def _env_value(name: str) -> str | None:
        return _as_text(_as_mapping(env_by_name.get(name)).get("value"))

    expected_order_updates_topic = _as_text(
        _as_mapping(_resource_attr(resources, "simulation_topic_by_role")).get(
            "order_updates"
        )
    )
    expected_topics = _as_mapping(_resource_attr(resources, "simulation_topic_by_role"))
    warm_lane_enabled = bool(
        _resource_attr(resources, "warm_lane_enabled", default=False)
    )
    pipeline_mode = _env_value("TRADING_PIPELINE_MODE")
    runtime_mode = _env_value("TRADING_STRATEGY_RUNTIME_MODE")
    scheduler_enabled = _env_value("TRADING_STRATEGY_SCHEDULER_ENABLED") == "true"
    strategy_runtime_active = runtime_mode == "plugin_v3" or (
        runtime_mode == "scheduler_v3" and scheduler_enabled
    )
    simple_pipeline = pipeline_mode == "simple"
    trading_config = {
        "trading_enabled": _env_value("TRADING_ENABLED") == "true",
        "simulation_enabled": _env_value("TRADING_SIMULATION_ENABLED") == "true",
        "strategy_runtime_mode": runtime_mode in {"plugin_v3", "scheduler_v3"},
        "strategy_runtime_active": strategy_runtime_active,
        "signal_table": _env_value("TRADING_SIGNAL_TABLE")
        == _as_text(_resource_attr(resources, "clickhouse_signal_table")),
        "price_table": _env_value("TRADING_PRICE_TABLE")
        == _as_text(_resource_attr(resources, "clickhouse_price_table")),
        "order_feed_enabled": _env_value("TRADING_ORDER_FEED_ENABLED") == "true",
        "order_feed_topic": _env_value("TRADING_ORDER_FEED_TOPIC")
        == expected_order_updates_topic,
        "order_feed_auto_offset_reset": (
            not simple_pipeline
            or _env_value("TRADING_ORDER_FEED_AUTO_OFFSET_RESET") == "earliest"
        ),
        "simple_order_feed_telemetry": (
            not simple_pipeline
            or _env_value("TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED") == "true"
        ),
        "simulation_order_updates_topic": _env_value(
            "TRADING_SIMULATION_ORDER_UPDATES_TOPIC"
        )
        == expected_order_updates_topic,
        "simulation_run_id": warm_lane_enabled
        or _env_value("TRADING_SIMULATION_RUN_ID")
        == _as_text(_resource_attr(resources, "run_id")),
        "signal_allowed_sources": "ta"
        in _normalized_string_set(_env_value("TRADING_SIGNAL_ALLOWED_SOURCES")),
    }
    trading_config_complete = all(trading_config.values())
    ta_config = _kubectl_json(
        namespace, ["get", "configmap", ta_configmap, "-o", "json"]
    )
    ta_data = _as_mapping(ta_config.get("data"))
    expected_clickhouse_database = (
        _as_text(_resource_attr(resources, "clickhouse_db"))
        or _clickhouse_database_from_table_name(
            _as_text(_resource_attr(resources, "clickhouse_signal_table"))
        )
        or _clickhouse_database_from_table_name(
            _as_text(_resource_attr(resources, "clickhouse_price_table"))
        )
    )
    ta_runtime_config = {
        f"{role}_topic": _as_text(ta_data.get(key))
        == _as_text(expected_topics.get(role))
        for role, key in lane_contract.ta_topic_key_by_role.items()
        if role in expected_topics
    }
    ta_runtime_config["clickhouse_database"] = (
        _clickhouse_database_from_jdbc_url(
            _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
        )
        == expected_clickhouse_database
    )
    ta_runtime_config["expected_clickhouse_database"] = expected_clickhouse_database
    ta_runtime_config["current_clickhouse_database"] = (
        _clickhouse_database_from_jdbc_url(
            _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
        )
    )
    ta_runtime_config_complete = all(
        value
        for key, value in ta_runtime_config.items()
        if key not in {"expected_clickhouse_database", "current_clickhouse_database"}
    )
    schema_registry = _schema_registry_health(
        ta_data=ta_data,
        lane_contract=lane_contract,
    )
    analysis_template_names = _analysis_template_names(manifest)
    analysis_images = _analysis_image_freshness(
        namespace=namespace,
        service=service,
        template_names=analysis_template_names,
    )
    revision_health: dict[str, Any] | None = None
    if latest_ready_revision:
        revision_health = _deployment_replica_health(
            namespace, f"{latest_ready_revision}-deployment"
        )
    ta_health = _flink_runtime_health(namespace, ta_deployment)
    return {
        "runtime_state": "ready"
        if ready
        and revision_health is not None
        and revision_health["ready_replicas"] > 0
        and ta_health["desired_state"] == "running"
        and ta_health["lifecycle_state"] in {"RUNNING", "running", "DEPLOYED"}
        and trading_config_complete
        and ta_runtime_config_complete
        and bool(schema_registry.get("ready"))
        and bool(analysis_images.get("ready"))
        else "not_ready",
        "target_mode": _as_text(_resource_attr(resources, "target_mode")),
        "window_start": window_start.astimezone(timezone.utc).isoformat(),
        "window_end": window_end.astimezone(timezone.utc).isoformat(),
        "torghut_service": {
            "name": torghut_service,
            "ready": ready,
            "latest_ready_revision": latest_ready_revision,
            "revision_health": revision_health,
            "trading_config": trading_config,
        },
        "ta_runtime": ta_health,
        "ta_runtime_config": ta_runtime_config,
        "schema_registry": schema_registry,
        "analysis_images": analysis_images,
        "environment_state": "complete"
        if (
            trading_config_complete
            and ta_runtime_config_complete
            and bool(schema_registry.get("ready"))
            and bool(analysis_images.get("ready"))
        )
        else "environment_incomplete",
    }


def _schema_registry_health(
    *,
    ta_data: Mapping[str, Any],
    lane_contract: Any,
) -> dict[str, Any]:
    registry_url = _as_text(ta_data.get("TA_SCHEMA_REGISTRY_URL"))
    if not registry_url:
        return {
            "ready": True,
            "reason": "schema_registry_url_not_declared",
            "subjects_checked": [],
            "subjects_missing": [],
        }
    subjects = _expected_schema_subjects(ta_data=ta_data, lane_contract=lane_contract)
    try:
        status, _ = _http_json_get(registry_url, "/subjects")
    except Exception as exc:
        return {
            "ready": False,
            "reason": f"schema_registry_not_ready:{exc}",
            "subjects_checked": subjects,
            "subjects_missing": subjects,
        }
    if status != 200:
        return {
            "ready": False,
            "reason": f"schema_registry_not_ready:http_{status}",
            "subjects_checked": subjects,
            "subjects_missing": subjects,
        }
    missing: list[str] = []
    for subject in subjects:
        subject_path = f"/subjects/{quote_plus(subject)}/versions/latest"
        subject_status, _ = _http_json_get(registry_url, subject_path)
        if subject_status != 200:
            missing.append(subject)
    return {
        "ready": len(missing) == 0,
        "reason": "ok" if not missing else "schema_subject_missing",
        "url": registry_url,
        "subjects_checked": subjects,
        "subjects_missing": missing,
    }


__all__ = [name for name in globals() if not name.startswith("__")]
