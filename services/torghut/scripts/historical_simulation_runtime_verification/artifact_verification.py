from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlsplit

from scripts.simulation_lane_contracts import simulation_schema_registry_subject_roles

from .runtime_health import (
    _activity_state,
    _clickhouse_database_from_jdbc_url,
    _cursor_reached_terminal,
    _kservice_env,
    _monitor_settings,
    _simulation_progress_snapshot,
)
from .shared_runtime import (
    DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS,
    DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
    DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
    DEFAULT_RUN_MONITOR_POLL_SECONDS,
    DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS,
    DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID,
    DEFAULT_SIMULATION_TA_GROUP_ID,
    DEFAULT_WARM_LANE_SIMULATION_DATABASE,
    _as_mapping,
    _as_text,
    _cluster_service_host_candidates,
    _database_name_from_dsn,
    _flink_runtime_health,
    _kubectl_json,
    _parse_optional_rfc3339_timestamp,
    _parse_rfc3339_timestamp,
    _resource_asdict,
    _resource_attr,
    _resource_lane_contract,
    _run_scoped_simulation_topic,
    _safe_int,
)


@dataclass(frozen=True)
class _MonitorTiming:
    timeout_seconds: int
    poll_seconds: int
    cursor_grace_seconds: int
    cursor_terminal_tolerance_seconds: int


@dataclass(frozen=True)
class _MonitorPollRequest:
    resources: Any
    postgres_config: Any
    clickhouse_config: Any
    manifest: Mapping[str, Any]
    runtime_verify: Mapping[str, Any]
    cursor_terminal_tolerance_seconds: int


@dataclass(frozen=True)
class _MonitorResultRequest:
    status: str
    classification: str
    settings: Mapping[str, Any]
    polls: list[dict[str, Any]]
    payload: Mapping[str, Any]
    activity_state: Mapping[str, Any]


@dataclass(frozen=True)
class _TeardownBaselineState:
    warm_lane: Mapping[str, bool]
    dedicated_service: Mapping[str, bool]
    dedicated_service_disabled: Mapping[str, bool]
    restored: bool


@dataclass(frozen=True)
class _TeardownContext:
    resource_payload: Mapping[str, Any]
    lane_contract: Any
    namespace: str
    torghut_service: str
    ta_configmap: str
    ta_deployment: str
    run_id: str
    dataset_id: str
    runtime_dsn: str
    simulation_clickhouse_db: str
    clickhouse_signal_table: str
    clickhouse_price_table: str
    order_feed_group_id: str
    ta_group_id: str
    target_mode: str
    warm_lane_enabled: bool
    run_scoped_order_updates_topic: str
    lane_default_order_updates_topic: str
    lane_default_signal_table: str
    lane_default_price_table: str
    run_scoped_order_updates_topic_is_distinct: bool


def _expected_schema_subjects(
    *,
    ta_data: Mapping[str, Any],
    lane_contract: Any,
) -> list[str]:
    subjects: list[str] = []
    topic_keys = cast(Mapping[str, str], lane_contract.ta_topic_key_by_role)
    for role in simulation_schema_registry_subject_roles(lane_contract):
        key = topic_keys.get(role)
        if not key:
            continue
        topic = _as_text(ta_data.get(key))
        if not topic:
            continue
        subjects.append(f"{topic}-value")
    return sorted(set(subjects))


def _http_json_get(
    base_url: str,
    path: str,
    *,
    timeout_seconds: int = DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS,
) -> tuple[int, str]:
    parsed = urlsplit(base_url)
    if not parsed.scheme or not parsed.hostname:
        raise RuntimeError(f"invalid_http_url:{base_url}")
    connection_class = HTTPSConnection if parsed.scheme == "https" else HTTPConnection
    target_path = parsed.path or "/"
    if path and path != "/":
        target_path = f"{target_path.rstrip('/')}/{path.lstrip('/')}"
    last_error: OSError | None = None
    for hostname in _cluster_service_host_candidates(parsed.hostname):
        connection = connection_class(hostname, parsed.port, timeout=timeout_seconds)
        try:
            connection.request("GET", target_path)
            response = connection.getresponse()
            return response.status, response.read().decode("utf-8", errors="replace")
        except OSError as exc:
            last_error = exc
            continue
        finally:
            connection.close()
    if last_error is not None:
        raise last_error
    raise RuntimeError("http_request_failed_without_attempts")


def _analysis_image_freshness(
    *,
    namespace: str,
    service: Mapping[str, Any],
    template_names: Sequence[str],
) -> dict[str, Any]:
    spec = _as_mapping(service.get("spec"))
    template = _as_mapping(spec.get("template"))
    template_spec = _as_mapping(template.get("spec"))
    containers = template_spec.get("containers")
    service_image: str | None = None
    if isinstance(containers, list) and containers:
        first = containers[0]
        if isinstance(first, Mapping):
            service_image = _as_text(cast(Mapping[str, Any], first).get("image"))
    if not service_image:
        return {
            "ready": True,
            "reason": "service_image_not_declared",
            "service_image": None,
            "analysis_images": {},
        }
    analysis_images: dict[str, str] = {}
    mismatched: dict[str, str] = {}
    for template_name in template_names:
        template_payload = _kubectl_json(
            namespace, ["get", "analysistemplate", template_name, "-o", "json"]
        )
        image = _analysis_template_image(template_payload)
        if not image:
            continue
        analysis_images[template_name] = image
        if image != service_image:
            mismatched[template_name] = image
    return {
        "ready": len(mismatched) == 0,
        "reason": "ok" if not mismatched else "analysis_image_stale",
        "service_image": service_image,
        "analysis_images": analysis_images,
        "mismatched_templates": mismatched,
    }


def _analysis_template_names(manifest: Mapping[str, Any]) -> tuple[str, str]:
    rollouts = _as_mapping(manifest.get("rollouts"))
    runtime_template = (
        _as_text(rollouts.get("runtime_template")) or "torghut-simulation-runtime-ready"
    )
    activity_template = (
        _as_text(rollouts.get("activity_template")) or "torghut-simulation-activity"
    )
    return runtime_template, activity_template


def _analysis_template_image(template_payload: Mapping[str, Any]) -> str | None:
    spec = _as_mapping(template_payload.get("spec"))
    metrics = spec.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        return None
    provider = _as_mapping(_as_mapping(metrics[0]).get("provider"))
    job_spec = _as_mapping(provider.get("job"))
    template = _as_mapping(_as_mapping(job_spec.get("spec")).get("template"))
    pod_spec = _as_mapping(template.get("spec"))
    containers = pod_spec.get("containers")
    if not isinstance(containers, list) or not containers:
        return None
    first = containers[0]
    if not isinstance(first, Mapping):
        return None
    return _as_text(cast(Mapping[str, Any], first).get("image"))


def _current_activity_report(
    *,
    resources: Any,
    manifest: Mapping[str, Any],
    postgres_config: Any,
    clickhouse_config: Any,
    runtime_verify: Mapping[str, Any],
) -> dict[str, Any]:
    settings = _monitor_settings(manifest)
    snapshot = _simulation_progress_snapshot(
        resources=resources,
        postgres_config=postgres_config,
        clickhouse_config=clickhouse_config,
    )
    activity_state = _activity_state(
        manifest=manifest,
        runtime_verify=runtime_verify,
        snapshot=snapshot,
    )
    classification = (
        _as_text(activity_state.get("activity_classification")) or "unknown"
    )
    return {
        "status": "ok" if classification == "success" else "degraded",
        "activity_classification": classification,
        "monitor": settings,
        "poll_count": 1,
        "final_snapshot": {
            "polled_at": datetime.now(timezone.utc).isoformat(),
            **snapshot,
        },
        "polls": [],
        **activity_state,
    }


def _monitor_run_completion(
    *,
    resources: Any,
    manifest: Mapping[str, Any],
    postgres_config: Any,
    clickhouse_config: Any,
    runtime_verify: Mapping[str, Any],
) -> dict[str, Any]:
    settings = _monitor_settings(manifest)
    timing = _monitor_timing(settings)
    deadline = datetime.now(timezone.utc) + timedelta(seconds=timing.timeout_seconds)
    polls: list[dict[str, Any]] = []
    cursor_reached_at: datetime | None = None
    while True:
        poll = _monitor_poll(
            _MonitorPollRequest(
                resources=resources,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                manifest=manifest,
                runtime_verify=runtime_verify,
                cursor_terminal_tolerance_seconds=timing.cursor_terminal_tolerance_seconds,
            )
        )
        poll_payload = cast(dict[str, Any], poll["payload"])
        polls.append(poll_payload)
        if poll["cursor_reached"] and cursor_reached_at is None:
            cursor_reached_at = cast(datetime, poll["polled_at"])
        if poll["cursor_reached"] and poll["completion_ready"]:
            return _monitor_result(
                _MonitorResultRequest(
                    status="ok",
                    classification="success",
                    settings=settings,
                    polls=polls,
                    payload=poll_payload,
                    activity_state=cast(Mapping[str, Any], poll["activity_state"]),
                )
            )
        if _monitor_finished(
            polled_at=cast(datetime, poll["polled_at"]),
            deadline=deadline,
            cursor_reached=bool(poll["cursor_reached"]),
            cursor_reached_at=cursor_reached_at,
            cursor_grace_seconds=timing.cursor_grace_seconds,
        ):
            activity_state = cast(Mapping[str, Any], poll["activity_state"])
            classification = _as_text(activity_state.get("activity_classification"))
            return _monitor_result(
                _MonitorResultRequest(
                    status="ok" if classification == "success" else "degraded",
                    classification=classification or "unknown",
                    settings=settings,
                    polls=polls,
                    payload=poll_payload,
                    activity_state=activity_state,
                )
            )
        time.sleep(timing.poll_seconds)


def _monitor_timing(settings: Mapping[str, Any]) -> _MonitorTiming:
    return _MonitorTiming(
        timeout_seconds=_safe_int(
            settings.get("timeout_seconds"), default=DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS
        ),
        poll_seconds=_safe_int(
            settings.get("poll_seconds"), default=DEFAULT_RUN_MONITOR_POLL_SECONDS
        ),
        cursor_grace_seconds=_safe_int(
            settings.get("cursor_grace_seconds"),
            default=DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
        ),
        cursor_terminal_tolerance_seconds=_safe_int(
            settings.get("cursor_terminal_tolerance_seconds"),
            default=DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
        ),
    )


def _monitor_poll(request: _MonitorPollRequest) -> dict[str, Any]:
    snapshot = _simulation_progress_snapshot(
        resources=request.resources,
        postgres_config=request.postgres_config,
        clickhouse_config=request.clickhouse_config,
    )
    polled_at = datetime.now(timezone.utc)
    activity_state = _activity_state(
        manifest=request.manifest,
        runtime_verify=request.runtime_verify,
        snapshot=snapshot,
    )
    effective_terminal_signal_ts = _parse_rfc3339_timestamp(
        _as_text(activity_state.get("effective_terminal_signal_ts")),
        label="effective_terminal_signal_ts",
    )
    cursor_reached = _cursor_reached_terminal(
        _parse_optional_rfc3339_timestamp(_as_text(activity_state.get("cursor_at"))),
        effective_terminal_signal_ts,
        tolerance_seconds=request.cursor_terminal_tolerance_seconds,
    )
    return {
        "polled_at": polled_at,
        "payload": {"polled_at": polled_at.isoformat(), **snapshot},
        "activity_state": activity_state,
        "cursor_reached": cursor_reached,
        "completion_ready": bool(activity_state.get("thresholds_met"))
        and bool(activity_state.get("order_event_contract_met")),
    }


def _monitor_finished(
    *,
    polled_at: datetime,
    deadline: datetime,
    cursor_reached: bool,
    cursor_reached_at: datetime | None,
    cursor_grace_seconds: int,
) -> bool:
    if polled_at >= deadline:
        return True
    return (
        cursor_reached
        and cursor_reached_at is not None
        and int((polled_at - cursor_reached_at).total_seconds()) >= cursor_grace_seconds
    )


def _monitor_result(request: _MonitorResultRequest) -> dict[str, Any]:
    return {
        "status": request.status,
        "activity_classification": request.classification,
        "monitor": request.settings,
        "poll_count": len(request.polls),
        "final_snapshot": request.payload,
        "polls": request.polls[-20:],
        **request.activity_state,
    }


def _verify_isolation_guards(
    *,
    resources: Any,
    postgres_config: Any,
    ta_data: Mapping[str, Any],
) -> dict[str, Any]:
    lane_contract = _resource_lane_contract(resources)
    source_topic_by_role = cast(
        dict[str, str], _resource_attr(resources, "source_topic_by_role")
    )
    simulation_topic_by_role = cast(
        dict[str, str], _resource_attr(resources, "simulation_topic_by_role")
    )
    clickhouse_table_by_role = cast(
        dict[str, str],
        _resource_attr(resources, "clickhouse_table_by_role", default={}),
    )
    report = {
        "lane": lane_contract.lane,
        "simulation_topics_isolated_from_sources": _simulation_topics_disjoint(
            lane_contract=lane_contract,
            source_topic_by_role=source_topic_by_role,
            simulation_topic_by_role=simulation_topic_by_role,
        ),
        "ta_group_isolated": _ta_group_isolated(
            resources=resources, ta_data=ta_data, lane_contract=lane_contract
        ),
        **_clickhouse_isolation_report(
            resources=resources,
            lane_contract=lane_contract,
            clickhouse_table_by_role=clickhouse_table_by_role,
        ),
        "postgres_database_isolated": _postgres_database_isolated(postgres_config),
        "simulation_dsn": _as_text(_resource_attr(postgres_config, "simulation_dsn")),
    }
    failed = _failed_boolean_guards(report)
    if failed:
        raise RuntimeError(f"isolation_guard_failed:{','.join(failed)}")
    return report


def _simulation_topics_disjoint(
    *,
    lane_contract: Any,
    source_topic_by_role: Mapping[str, str],
    simulation_topic_by_role: Mapping[str, str],
) -> bool:
    return all(
        simulation_topic_by_role.get(role) != source_topic_by_role.get(role)
        for role in lane_contract.replay_roles
    )


def _ta_group_isolated(
    *, resources: Any, ta_data: Mapping[str, Any], lane_contract: Any
) -> bool:
    warm_lane_enabled = bool(
        _resource_attr(resources, "warm_lane_enabled", default=False)
    )
    return warm_lane_enabled or _as_text(
        _resource_attr(resources, "ta_group_id")
    ) != _as_text(ta_data.get(lane_contract.ta_group_id_key))


def _clickhouse_isolation_report(
    *,
    resources: Any,
    lane_contract: Any,
    clickhouse_table_by_role: Mapping[str, str],
) -> dict[str, bool]:
    signal_basename = lane_contract.clickhouse_simulation_table_by_role[
        lane_contract.signal_table_role
    ]
    price_basename = lane_contract.clickhouse_simulation_table_by_role[
        lane_contract.price_table_role
    ]
    clickhouse_signal_table = _as_text(
        _resource_attr(resources, "clickhouse_signal_table")
    )
    clickhouse_price_table = _as_text(
        _resource_attr(resources, "clickhouse_price_table")
    )
    return {
        "signal_table_isolated": bool(
            clickhouse_signal_table
            and clickhouse_signal_table.endswith(f".{signal_basename}")
        ),
        "price_table_isolated": bool(
            clickhouse_price_table
            and clickhouse_price_table.endswith(f".{price_basename}")
        ),
        "auxiliary_tables_isolated": all(
            table.endswith(
                f".{lane_contract.clickhouse_simulation_table_by_role[role]}"
            )
            for role, table in clickhouse_table_by_role.items()
            if role
            not in {lane_contract.signal_table_role, lane_contract.price_table_role}
        ),
    }


def _postgres_database_isolated(postgres_config: Any) -> bool:
    simulation_db = _as_text(_resource_attr(postgres_config, "simulation_db"))
    return bool(simulation_db and simulation_db != "torghut")


def _failed_boolean_guards(report: Mapping[str, Any]) -> list[str]:
    return [
        key for key, passed in report.items() if isinstance(passed, bool) and not passed
    ]


def _teardown_clean(
    *,
    resources: Any,
    postgres_config: Any,
) -> dict[str, Any]:
    ctx = _teardown_context(resources=resources, postgres_config=postgres_config)
    service = _kubectl_json(
        ctx.namespace, ["get", "kservice", ctx.torghut_service, "-o", "json"]
    )
    _, env_entries = _kservice_env(service, namespace=ctx.namespace)
    env_by_name = _env_by_name(env_entries)
    ta_config = _kubectl_json(
        ctx.namespace, ["get", "configmap", ctx.ta_configmap, "-o", "json"]
    )
    ta_data = _as_mapping(ta_config.get("data"))
    ta_health = _flink_runtime_health(ctx.namespace, ctx.ta_deployment)
    run_scoped_markers_present = _run_scoped_markers_present(ctx, env_by_name)
    simulation_markers_present = _simulation_markers_present(
        ctx=ctx,
        env_by_name=env_by_name,
        ta_data=ta_data,
        run_scoped_markers_present=run_scoped_markers_present,
    )
    baseline = _teardown_baseline_state(
        ctx=ctx,
        env_by_name=env_by_name,
        ta_data=ta_data,
        run_scoped_markers_present=run_scoped_markers_present,
        simulation_markers_present=simulation_markers_present,
    )

    return {
        "status": "ok" if baseline.restored else "degraded",
        "activity_classification": "success"
        if baseline.restored
        else "environment_incomplete",
        "restored": baseline.restored,
        "warm_lane_enabled": ctx.warm_lane_enabled,
        "ta_runtime": ta_health,
        "run_scoped_markers_present": run_scoped_markers_present,
        "simulation_markers_present": simulation_markers_present,
        "warm_lane_baseline": baseline.warm_lane,
        "dedicated_service_baseline": baseline.dedicated_service,
        "dedicated_service_disabled_baseline": baseline.dedicated_service_disabled,
    }


def _teardown_context(*, resources: Any, postgres_config: Any) -> _TeardownContext:
    payload = _resource_asdict(resources)
    lane_contract = _resource_lane_contract(resources)
    topic_context = _teardown_topic_context(
        payload=payload, lane_contract=lane_contract
    )
    torghut_service = _as_text(payload.get("torghut_service"))
    ta_configmap = _as_text(payload.get("ta_configmap"))
    ta_deployment = _as_text(payload.get("ta_deployment"))
    if torghut_service is None or ta_configmap is None or ta_deployment is None:
        raise RuntimeError(
            "simulation resources are incomplete for teardown validation"
        )
    return _TeardownContext(
        resource_payload=payload,
        lane_contract=lane_contract,
        namespace=_as_text(payload.get("namespace")) or "torghut",
        torghut_service=torghut_service,
        ta_configmap=ta_configmap,
        ta_deployment=ta_deployment,
        run_id=_as_text(payload.get("run_id")) or "",
        dataset_id=_as_text(payload.get("dataset_id")) or "",
        runtime_dsn=_as_text(_resource_attr(postgres_config, "torghut_runtime_dsn"))
        or "",
        simulation_clickhouse_db=_as_text(payload.get("clickhouse_db")) or "",
        clickhouse_signal_table=_as_text(payload.get("clickhouse_signal_table")) or "",
        clickhouse_price_table=_as_text(payload.get("clickhouse_price_table")) or "",
        order_feed_group_id=_as_text(payload.get("order_feed_group_id")) or "",
        ta_group_id=_as_text(payload.get("ta_group_id")) or "",
        target_mode=_as_text(payload.get("target_mode")) or "",
        warm_lane_enabled=bool(
            _resource_attr(resources, "warm_lane_enabled", default=False)
        ),
        run_scoped_order_updates_topic=topic_context["run_scoped_order_updates_topic"],
        lane_default_order_updates_topic=topic_context[
            "lane_default_order_updates_topic"
        ],
        lane_default_signal_table=topic_context["lane_default_signal_table"],
        lane_default_price_table=topic_context["lane_default_price_table"],
        run_scoped_order_updates_topic_is_distinct=topic_context[
            "run_scoped_order_updates_topic_is_distinct"
        ],
    )


def _teardown_topic_context(
    *, payload: Mapping[str, Any], lane_contract: Any
) -> dict[str, Any]:
    simulation_topics = _as_mapping(payload.get("simulation_topic_by_role"))
    run_topic = _as_text(simulation_topics.get("order_updates")) or ""
    default_topic = (
        _as_text(lane_contract.simulation_topic_by_role.get("order_updates")) or ""
    )
    run_id = _as_text(payload.get("run_id")) or ""
    if not run_topic or run_topic == default_topic:
        run_topic = _run_scoped_simulation_topic(default_topic, run_id)
    return {
        "run_scoped_order_updates_topic": run_topic,
        "lane_default_order_updates_topic": default_topic,
        "lane_default_signal_table": _lane_default_table(
            lane_contract, lane_contract.signal_table_role
        ),
        "lane_default_price_table": _lane_default_table(
            lane_contract, lane_contract.price_table_role
        ),
        "run_scoped_order_updates_topic_is_distinct": bool(
            run_topic and run_topic != default_topic
        ),
    }


def _lane_default_table(lane_contract: Any, role: str) -> str:
    return (
        f"{DEFAULT_WARM_LANE_SIMULATION_DATABASE}."
        f"{lane_contract.clickhouse_simulation_table_by_role[role]}"
    )


def _env_by_name(env_entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {
        name: entry
        for entry in env_entries
        if (name := _as_text(entry.get("name"))) is not None
    }


def _env_value(env_by_name: Mapping[str, Any], key: str) -> str | None:
    return _as_text(_as_mapping(env_by_name.get(key)).get("value"))


def _run_scoped_markers_present(
    ctx: _TeardownContext, env_by_name: Mapping[str, Any]
) -> dict[str, bool]:
    return {
        "trading_simulation_run_id": _env_value(
            env_by_name, "TRADING_SIMULATION_RUN_ID"
        )
        == ctx.run_id,
        "trading_simulation_dataset_id": _env_value(
            env_by_name, "TRADING_SIMULATION_DATASET_ID"
        )
        == ctx.dataset_id,
        "order_feed_topic": ctx.run_scoped_order_updates_topic_is_distinct
        and _env_value(env_by_name, "TRADING_ORDER_FEED_TOPIC")
        == ctx.run_scoped_order_updates_topic,
        "simulation_order_updates_topic": (
            ctx.run_scoped_order_updates_topic_is_distinct
            and _env_value(env_by_name, "TRADING_SIMULATION_ORDER_UPDATES_TOPIC")
            == ctx.run_scoped_order_updates_topic
        ),
    }


def _simulation_markers_present(
    *,
    ctx: _TeardownContext,
    env_by_name: Mapping[str, Any],
    ta_data: Mapping[str, Any],
    run_scoped_markers_present: Mapping[str, bool],
) -> dict[str, bool]:
    return {
        "trading_simulation_enabled": _env_value(
            env_by_name, "TRADING_SIMULATION_ENABLED"
        )
        == "true",
        "trading_simulation_run_id": run_scoped_markers_present[
            "trading_simulation_run_id"
        ],
        "trading_simulation_dataset_id": run_scoped_markers_present[
            "trading_simulation_dataset_id"
        ],
        "db_dsn": _env_value(env_by_name, "DB_DSN") == ctx.runtime_dsn,
        "signal_table": _env_value(env_by_name, "TRADING_SIGNAL_TABLE")
        == ctx.clickhouse_signal_table,
        "price_table": _env_value(env_by_name, "TRADING_PRICE_TABLE")
        == ctx.clickhouse_price_table,
        "order_feed_topic": run_scoped_markers_present["order_feed_topic"],
        "simulation_order_updates_topic": run_scoped_markers_present[
            "simulation_order_updates_topic"
        ],
        "order_feed_group_id": _env_value(env_by_name, "TRADING_ORDER_FEED_GROUP_ID")
        == ctx.order_feed_group_id,
        "ta_group_id": _as_text(ta_data.get(ctx.lane_contract.ta_group_id_key))
        == ctx.ta_group_id,
        "ta_clickhouse_database": _clickhouse_database_from_jdbc_url(
            _as_text(ta_data.get(ctx.lane_contract.ta_clickhouse_url_key))
        )
        == ctx.simulation_clickhouse_db,
    }


def _teardown_baseline_state(
    *,
    ctx: _TeardownContext,
    env_by_name: Mapping[str, Any],
    ta_data: Mapping[str, Any],
    run_scoped_markers_present: Mapping[str, bool],
    simulation_markers_present: Mapping[str, bool],
) -> dict[str, Any]:
    warm_lane = _warm_lane_baseline(ctx=ctx, env_by_name=env_by_name, ta_data=ta_data)
    dedicated = _dedicated_service_baseline(
        ctx=ctx, env_by_name=env_by_name, ta_data=ta_data
    )
    dedicated_disabled = _dedicated_service_disabled_baseline(
        ctx=ctx, env_by_name=env_by_name, ta_data=ta_data
    )
    return _TeardownBaselineState(
        warm_lane=warm_lane if ctx.warm_lane_enabled else {},
        dedicated_service=dedicated
        if ctx.target_mode == "dedicated_service" and not ctx.warm_lane_enabled
        else {},
        dedicated_service_disabled=dedicated_disabled
        if ctx.target_mode == "dedicated_service" and not ctx.warm_lane_enabled
        else {},
        restored=_teardown_restored(
            ctx=ctx,
            baseline=_TeardownBaselineState(
                warm_lane=warm_lane,
                dedicated_service=dedicated,
                dedicated_service_disabled=dedicated_disabled,
                restored=False,
            ),
            run_scoped_markers_present=run_scoped_markers_present,
            simulation_markers_present=simulation_markers_present,
        ),
    )


def _teardown_restored(
    *,
    ctx: _TeardownContext,
    baseline: _TeardownBaselineState,
    run_scoped_markers_present: Mapping[str, bool],
    simulation_markers_present: Mapping[str, bool],
) -> bool:
    if ctx.warm_lane_enabled:
        return all(baseline.warm_lane.values()) and not any(
            run_scoped_markers_present.values()
        )
    if ctx.target_mode != "dedicated_service":
        return not any(simulation_markers_present.values())
    return (
        all(baseline.dedicated_service.values())
        or (
            all(baseline.dedicated_service_disabled.values())
            and not any(simulation_markers_present.values())
        )
    ) and not any(run_scoped_markers_present.values())


def _warm_lane_baseline(
    *, ctx: _TeardownContext, env_by_name: Mapping[str, Any], ta_data: Mapping[str, Any]
) -> dict[str, bool]:
    return {
        "trading_simulation_enabled": _env_value(
            env_by_name, "TRADING_SIMULATION_ENABLED"
        )
        == "true",
        "trading_simulation_run_id_cleared": not _env_value(
            env_by_name, "TRADING_SIMULATION_RUN_ID"
        ),
        "trading_simulation_dataset_id_cleared": not _env_value(
            env_by_name, "TRADING_SIMULATION_DATASET_ID"
        ),
        "signal_table": _env_value(env_by_name, "TRADING_SIGNAL_TABLE")
        == ctx.clickhouse_signal_table,
        "price_table": _env_value(env_by_name, "TRADING_PRICE_TABLE")
        == ctx.clickhouse_price_table,
        "order_feed_topic": _env_value(env_by_name, "TRADING_ORDER_FEED_TOPIC")
        == ctx.lane_default_order_updates_topic,
        "simulation_order_updates_topic": _env_value(
            env_by_name, "TRADING_SIMULATION_ORDER_UPDATES_TOPIC"
        )
        == ctx.lane_default_order_updates_topic,
        "order_feed_group_id": _env_value(env_by_name, "TRADING_ORDER_FEED_GROUP_ID")
        == ctx.order_feed_group_id,
        "ta_group_id": _as_text(ta_data.get(ctx.lane_contract.ta_group_id_key))
        == ctx.ta_group_id,
        "ta_clickhouse_database": _clickhouse_database_from_jdbc_url(
            _as_text(ta_data.get(ctx.lane_contract.ta_clickhouse_url_key))
        )
        == ctx.simulation_clickhouse_db,
    }


def _dedicated_service_baseline(
    *, ctx: _TeardownContext, env_by_name: Mapping[str, Any], ta_data: Mapping[str, Any]
) -> dict[str, bool]:
    return {
        "trading_simulation_enabled": _env_value(
            env_by_name, "TRADING_SIMULATION_ENABLED"
        )
        == "true",
        "trading_simulation_run_id_cleared": not _env_value(
            env_by_name, "TRADING_SIMULATION_RUN_ID"
        ),
        "trading_simulation_dataset_id_cleared": not _env_value(
            env_by_name, "TRADING_SIMULATION_DATASET_ID"
        ),
        "db_dsn_database": _database_name_from_dsn(_env_value(env_by_name, "DB_DSN"))
        == DEFAULT_WARM_LANE_SIMULATION_DATABASE,
        "signal_table": _env_value(env_by_name, "TRADING_SIGNAL_TABLE")
        == ctx.lane_default_signal_table,
        "price_table": _env_value(env_by_name, "TRADING_PRICE_TABLE")
        == ctx.lane_default_price_table,
        "order_feed_topic": _env_value(env_by_name, "TRADING_ORDER_FEED_TOPIC")
        == ctx.lane_default_order_updates_topic,
        "simulation_order_updates_topic": _env_value(
            env_by_name, "TRADING_SIMULATION_ORDER_UPDATES_TOPIC"
        )
        == ctx.lane_default_order_updates_topic,
        "order_feed_group_id": _env_value(env_by_name, "TRADING_ORDER_FEED_GROUP_ID")
        == DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID,
        "ta_group_id": _as_text(ta_data.get(ctx.lane_contract.ta_group_id_key))
        == DEFAULT_SIMULATION_TA_GROUP_ID,
        "ta_clickhouse_database": _clickhouse_database_from_jdbc_url(
            _as_text(ta_data.get(ctx.lane_contract.ta_clickhouse_url_key))
        )
        == DEFAULT_WARM_LANE_SIMULATION_DATABASE,
    }


def _dedicated_service_disabled_baseline(
    *, ctx: _TeardownContext, env_by_name: Mapping[str, Any], ta_data: Mapping[str, Any]
) -> dict[str, bool]:
    baseline = _dedicated_service_baseline(
        ctx=ctx, env_by_name=env_by_name, ta_data=ta_data
    )
    baseline.pop("signal_table")
    baseline.pop("price_table")
    baseline["trading_simulation_disabled"] = (
        _env_value(env_by_name, "TRADING_SIMULATION_ENABLED") != "true"
    )
    baseline.pop("trading_simulation_enabled")
    return baseline


def _artifact_bundle(
    *,
    run_dir: Path,
) -> dict[str, Any]:
    required = [
        "run-manifest.json",
        "runtime-verify.json",
        "replay-report.json",
        "signal-activity.json",
        "decision-activity.json",
        "execution-activity.json",
        "report/simulation-report.json",
    ]
    existing = [path for path in required if (run_dir / path).exists()]
    missing = [path for path in required if path not in existing]
    return {
        "status": "ok" if not missing else "degraded",
        "activity_classification": "success"
        if not missing
        else "environment_incomplete",
        "run_dir": str(run_dir),
        "existing": existing,
        "missing": missing,
    }


__all__ = [
    "_analysis_image_freshness",
    "_analysis_template_image",
    "_analysis_template_names",
    "_artifact_bundle",
    "_current_activity_report",
    "_expected_schema_subjects",
    "_http_json_get",
    "_monitor_run_completion",
    "_teardown_clean",
    "_verify_isolation_guards",
]
