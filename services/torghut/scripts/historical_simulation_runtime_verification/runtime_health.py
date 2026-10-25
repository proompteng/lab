from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, cast
from urllib.parse import quote_plus

from .runtime_progress import (
    _activity_state,
    _classify_activity_snapshot,
    _clickhouse_database_from_jdbc_url,
    _clickhouse_database_from_table_name,
    _clickhouse_table_activity,
    _cursor_reached_terminal,
    _effective_terminal_signal_ts,
    _monitor_snapshot,
    _progress_component_snapshot,
    _signal_snapshot,
    _simulation_progress_snapshot,
)
from .shared_runtime import (
    DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
    DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
    DEFAULT_RUN_MONITOR_MIN_DECISIONS,
    DEFAULT_RUN_MONITOR_MIN_EXECUTIONS,
    DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
    DEFAULT_RUN_MONITOR_MIN_TCA,
    DEFAULT_RUN_MONITOR_POLL_SECONDS,
    DEFAULT_RUN_MONITOR_PROFILE,
    DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS,
    MONITOR_PROFILE_DEFAULTS,
    US_EQUITIES_REGULAR_MINUTES,
    _as_mapping,
    _as_text,
    _condition_status,
    _deployment_replica_health,
    _flink_runtime_health,
    _kubectl_json,
    _normalized_string_set,
    _resolve_window_bounds,
    _resource_attr,
    _resource_lane_contract,
    _safe_int,
)


@dataclass(frozen=True)
class _RuntimeVerifyContext:
    resources: Any
    namespace: str
    torghut_service: str
    ta_deployment: str
    ta_configmap: str
    window_start: datetime
    window_end: datetime
    lane_contract: Any
    expected_topics: Mapping[str, Any]
    expected_order_updates_topic: str | None
    warm_lane_enabled: bool


@dataclass(frozen=True)
class _TorghutServiceState:
    service: Mapping[str, Any]
    ready: bool
    latest_ready_revision: str | None
    revision_health: Mapping[str, Any] | None
    trading_config: Mapping[str, bool]
    trading_config_complete: bool


@dataclass(frozen=True)
class _TaRuntimeState:
    ta_data: Mapping[str, Any]
    ta_health: Mapping[str, Any]
    ta_runtime_config: Mapping[str, Any]
    ta_runtime_config_complete: bool
    schema_registry: Mapping[str, Any]


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
    env = [
        *_configmap_env_entries(namespace=namespace, env_from=container.get("envFrom")),
        *_direct_env_entries(container.get("env")),
    ]
    return container_name, env


def _configmap_env_entries(
    *, namespace: str | None, env_from: Any
) -> list[dict[str, Any]]:
    if not namespace or not isinstance(env_from, list):
        return []
    entries: list[dict[str, Any]] = []
    for item in env_from:
        if not isinstance(item, Mapping):
            continue
        config_map_ref = _as_mapping(cast(Mapping[str, Any], item).get("configMapRef"))
        config_map_name = _as_text(config_map_ref.get("name"))
        if config_map_name is None:
            continue
        config_map = _kubectl_json(
            namespace, ["get", "configmap", config_map_name, "-o", "json"]
        )
        entries.extend(
            {"name": key, "value": str(value)}
            for key, value in _as_mapping(config_map.get("data")).items()
        )
    return entries


def _direct_env_entries(env_raw: Any) -> list[dict[str, Any]]:
    if not isinstance(env_raw, list):
        return []
    return [_as_mapping(item) for item in env_raw if isinstance(item, Mapping)]


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


def _runtime_verify(*, resources: Any, manifest: Mapping[str, Any]) -> dict[str, Any]:
    from .artifact_verification import (
        _analysis_image_freshness,
        _analysis_template_names,
    )

    ctx = _runtime_verify_context(resources=resources, manifest=manifest)
    service_state = _torghut_service_state(ctx)
    ta_state = _ta_runtime_state(ctx)
    analysis_template_names = _analysis_template_names(manifest)
    analysis_images = _analysis_image_freshness(
        namespace=ctx.namespace,
        service=service_state.service,
        template_names=analysis_template_names,
    )
    environment_complete = _environment_complete(
        trading_config_complete=service_state.trading_config_complete,
        ta_runtime_config_complete=ta_state.ta_runtime_config_complete,
        schema_registry=ta_state.schema_registry,
        analysis_images=analysis_images,
    )
    return {
        "runtime_state": _runtime_state(
            ready=service_state.ready,
            revision_health=service_state.revision_health,
            ta_health=ta_state.ta_health,
            environment_complete=environment_complete,
        ),
        "target_mode": _as_text(_resource_attr(resources, "target_mode")),
        "window_start": ctx.window_start.astimezone(timezone.utc).isoformat(),
        "window_end": ctx.window_end.astimezone(timezone.utc).isoformat(),
        "torghut_service": {
            "name": ctx.torghut_service,
            "ready": service_state.ready,
            "latest_ready_revision": service_state.latest_ready_revision,
            "revision_health": service_state.revision_health,
            "trading_config": service_state.trading_config,
        },
        "ta_runtime": ta_state.ta_health,
        "ta_runtime_config": ta_state.ta_runtime_config,
        "schema_registry": ta_state.schema_registry,
        "analysis_images": analysis_images,
        "environment_state": "complete"
        if environment_complete
        else "environment_incomplete",
    }


def _runtime_verify_context(
    *, resources: Any, manifest: Mapping[str, Any]
) -> _RuntimeVerifyContext:
    window_start, window_end = _resolve_window_bounds(manifest)
    torghut_service = _as_text(_resource_attr(resources, "torghut_service"))
    ta_deployment = _as_text(_resource_attr(resources, "ta_deployment"))
    ta_configmap = _as_text(_resource_attr(resources, "ta_configmap"))
    if torghut_service is None or ta_deployment is None or ta_configmap is None:
        raise RuntimeError("simulation resources are incomplete")
    expected_topics = _as_mapping(_resource_attr(resources, "simulation_topic_by_role"))
    return _RuntimeVerifyContext(
        resources=resources,
        namespace=_as_text(_resource_attr(resources, "namespace")) or "torghut",
        torghut_service=torghut_service,
        ta_deployment=ta_deployment,
        ta_configmap=ta_configmap,
        window_start=window_start,
        window_end=window_end,
        lane_contract=_resource_lane_contract(resources),
        expected_topics=expected_topics,
        expected_order_updates_topic=_as_text(expected_topics.get("order_updates")),
        warm_lane_enabled=bool(
            _resource_attr(resources, "warm_lane_enabled", default=False)
        ),
    )


def _torghut_service_state(ctx: _RuntimeVerifyContext) -> _TorghutServiceState:
    service = _kubectl_json(
        ctx.namespace, ["get", "kservice", ctx.torghut_service, "-o", "json"]
    )
    service_status = _as_mapping(service.get("status"))
    latest_ready_revision = _as_text(service_status.get("latestReadyRevisionName"))
    _, env_entries = _kservice_env(service, namespace=ctx.namespace)
    trading_config = _runtime_trading_config(
        ctx=ctx, env_by_name=_env_by_name(env_entries)
    )
    return _TorghutServiceState(
        service=service,
        ready=_condition_status(service_status, condition_type="Ready") == "True",
        latest_ready_revision=latest_ready_revision,
        revision_health=_revision_health(
            namespace=ctx.namespace, latest_ready_revision=latest_ready_revision
        ),
        trading_config=trading_config,
        trading_config_complete=all(trading_config.values()),
    )


def _revision_health(
    *, namespace: str, latest_ready_revision: str | None
) -> Mapping[str, Any] | None:
    if latest_ready_revision is None:
        return None
    return _deployment_replica_health(namespace, f"{latest_ready_revision}-deployment")


def _ta_runtime_state(ctx: _RuntimeVerifyContext) -> _TaRuntimeState:
    ta_config = _kubectl_json(
        ctx.namespace, ["get", "configmap", ctx.ta_configmap, "-o", "json"]
    )
    ta_data = _as_mapping(ta_config.get("data"))
    ta_runtime_config = _ta_runtime_config(ctx=ctx, ta_data=ta_data)
    return _TaRuntimeState(
        ta_data=ta_data,
        ta_health=_flink_runtime_health(ctx.namespace, ctx.ta_deployment),
        ta_runtime_config=ta_runtime_config,
        ta_runtime_config_complete=_ta_runtime_config_complete(ta_runtime_config),
        schema_registry=_schema_registry_health(
            ta_data=ta_data,
            lane_contract=ctx.lane_contract,
        ),
    )


def _ta_runtime_config_complete(config: Mapping[str, Any]) -> bool:
    return all(
        value
        for key, value in config.items()
        if key not in {"expected_clickhouse_database", "current_clickhouse_database"}
    )


def _env_by_name(env_entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        name: entry
        for entry in env_entries
        if (name := _as_text(entry.get("name"))) is not None
    }


def _env_value(env_by_name: Mapping[str, Any], name: str) -> str | None:
    return _as_text(_as_mapping(env_by_name.get(name)).get("value"))


def _runtime_trading_config(
    *, ctx: _RuntimeVerifyContext, env_by_name: Mapping[str, Any]
) -> dict[str, bool]:
    pipeline_mode = _env_value(env_by_name, "TRADING_PIPELINE_MODE")
    runtime_mode = _env_value(env_by_name, "TRADING_STRATEGY_RUNTIME_MODE")
    strategy_runtime_active = runtime_mode == "scheduler_v3"
    simple_pipeline = pipeline_mode == "simple"
    return {
        "trading_enabled": _env_value(env_by_name, "TRADING_ENABLED") == "true",
        "simulation_enabled": _env_value(env_by_name, "TRADING_SIMULATION_ENABLED")
        == "true",
        "strategy_runtime_mode": runtime_mode == "scheduler_v3",
        "strategy_runtime_active": strategy_runtime_active,
        "signal_table": _env_value(env_by_name, "TRADING_SIGNAL_TABLE")
        == _as_text(_resource_attr(ctx.resources, "clickhouse_signal_table")),
        "price_table": _env_value(env_by_name, "TRADING_PRICE_TABLE")
        == _as_text(_resource_attr(ctx.resources, "clickhouse_price_table")),
        "order_feed_enabled": _env_value(env_by_name, "TRADING_ORDER_FEED_ENABLED")
        == "true",
        "order_feed_topic": _env_value(env_by_name, "TRADING_ORDER_FEED_TOPIC")
        == ctx.expected_order_updates_topic,
        "order_feed_auto_offset_reset": (
            not simple_pipeline
            or _env_value(env_by_name, "TRADING_ORDER_FEED_AUTO_OFFSET_RESET")
            == "earliest"
        ),
        "simple_order_feed_telemetry": (
            not simple_pipeline
            or _env_value(env_by_name, "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED")
            == "true"
        ),
        "simulation_order_updates_topic": _env_value(
            env_by_name, "TRADING_SIMULATION_ORDER_UPDATES_TOPIC"
        )
        == ctx.expected_order_updates_topic,
        "simulation_run_id": ctx.warm_lane_enabled
        or _env_value(env_by_name, "TRADING_SIMULATION_RUN_ID")
        == _as_text(_resource_attr(ctx.resources, "run_id")),
        "signal_allowed_sources": "ta"
        in _normalized_string_set(
            _env_value(env_by_name, "TRADING_SIGNAL_ALLOWED_SOURCES")
        ),
    }


def _expected_clickhouse_database(ctx: _RuntimeVerifyContext) -> str | None:
    return (
        _as_text(_resource_attr(ctx.resources, "clickhouse_db"))
        or _clickhouse_database_from_table_name(
            _as_text(_resource_attr(ctx.resources, "clickhouse_signal_table"))
        )
        or _clickhouse_database_from_table_name(
            _as_text(_resource_attr(ctx.resources, "clickhouse_price_table"))
        )
    )


def _ta_runtime_config(
    *, ctx: _RuntimeVerifyContext, ta_data: Mapping[str, Any]
) -> dict[str, Any]:
    expected_database = _expected_clickhouse_database(ctx)
    current_database = _clickhouse_database_from_jdbc_url(
        _as_text(ta_data.get(ctx.lane_contract.ta_clickhouse_url_key))
    )
    config = {
        f"{role}_topic": _as_text(ta_data.get(key))
        == _as_text(ctx.expected_topics.get(role))
        for role, key in ctx.lane_contract.ta_topic_key_by_role.items()
        if role in ctx.expected_topics
    }
    config["clickhouse_database"] = current_database == expected_database
    config["expected_clickhouse_database"] = expected_database
    config["current_clickhouse_database"] = current_database
    return config


def _environment_complete(
    *,
    trading_config_complete: bool,
    ta_runtime_config_complete: bool,
    schema_registry: Mapping[str, Any],
    analysis_images: Mapping[str, Any],
) -> bool:
    return (
        trading_config_complete
        and ta_runtime_config_complete
        and bool(schema_registry.get("ready"))
        and bool(analysis_images.get("ready"))
    )


def _runtime_state(
    *,
    ready: bool,
    revision_health: Mapping[str, Any] | None,
    ta_health: Mapping[str, Any],
    environment_complete: bool,
) -> str:
    runtime_ready = (
        ready
        and revision_health is not None
        and revision_health["ready_replicas"] > 0
        and ta_health["desired_state"] == "running"
        and ta_health["lifecycle_state"] in {"RUNNING", "running", "DEPLOYED"}
        and environment_complete
    )
    return "ready" if runtime_ready else "not_ready"


def _schema_registry_health(
    *,
    ta_data: Mapping[str, Any],
    lane_contract: Any,
) -> dict[str, Any]:
    from .artifact_verification import _expected_schema_subjects, _http_json_get

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


__all__ = [
    "_activity_state",
    "_classify_activity_snapshot",
    "_clickhouse_database_from_jdbc_url",
    "_clickhouse_database_from_table_name",
    "_clickhouse_table_activity",
    "_cursor_reached_terminal",
    "_effective_terminal_signal_ts",
    "_infer_monitor_profile",
    "_kservice_env",
    "_monitor_settings",
    "_monitor_snapshot",
    "_progress_component_snapshot",
    "_runtime_verify",
    "_schema_registry_health",
    "_signal_snapshot",
    "_simulation_progress_snapshot",
]
