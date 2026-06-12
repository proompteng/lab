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
from .part_02_kservice_env import *


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
    timeout_seconds = _safe_int(
        settings.get("timeout_seconds"), default=DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS
    )
    poll_seconds = _safe_int(
        settings.get("poll_seconds"), default=DEFAULT_RUN_MONITOR_POLL_SECONDS
    )
    cursor_grace_seconds = _safe_int(
        settings.get("cursor_grace_seconds"),
        default=DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
    )
    cursor_terminal_tolerance_seconds = _safe_int(
        settings.get("cursor_terminal_tolerance_seconds"),
        default=DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS,
    )
    deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
    polls: list[dict[str, Any]] = []
    cursor_reached_at: datetime | None = None
    while True:
        snapshot = _simulation_progress_snapshot(
            resources=resources,
            postgres_config=postgres_config,
            clickhouse_config=clickhouse_config,
        )
        polled_at = datetime.now(timezone.utc)
        poll_payload = {"polled_at": polled_at.isoformat(), **snapshot}
        polls.append(poll_payload)
        activity_state = _activity_state(
            manifest=manifest,
            runtime_verify=runtime_verify,
            snapshot=snapshot,
        )
        effective_terminal_signal_ts = _parse_rfc3339_timestamp(
            _as_text(activity_state.get("effective_terminal_signal_ts")),
            label="effective_terminal_signal_ts",
        )
        cursor_at = _parse_optional_rfc3339_timestamp(
            _as_text(activity_state.get("cursor_at"))
        )
        cursor_reached = _cursor_reached_terminal(
            cursor_at,
            effective_terminal_signal_ts,
            tolerance_seconds=cursor_terminal_tolerance_seconds,
        )
        completion_ready = bool(activity_state.get("thresholds_met")) and bool(
            activity_state.get("order_event_contract_met")
        )

        if cursor_reached and cursor_reached_at is None:
            cursor_reached_at = polled_at
        if cursor_reached and completion_ready:
            return {
                "status": "ok",
                "activity_classification": "success",
                "monitor": settings,
                "poll_count": len(polls),
                "final_snapshot": poll_payload,
                "polls": polls[-20:],
                **activity_state,
            }
        if polled_at >= deadline or (
            cursor_reached
            and cursor_reached_at is not None
            and int((polled_at - cursor_reached_at).total_seconds())
            >= cursor_grace_seconds
        ):
            classification = (
                _as_text(activity_state.get("activity_classification")) or "unknown"
            )
            return {
                "status": "ok" if classification == "success" else "degraded",
                "activity_classification": classification,
                "monitor": settings,
                "poll_count": len(polls),
                "final_snapshot": poll_payload,
                "polls": polls[-20:],
                **activity_state,
            }
        time.sleep(poll_seconds)


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
    clickhouse_signal_table = _as_text(
        _resource_attr(resources, "clickhouse_signal_table")
    )
    clickhouse_price_table = _as_text(
        _resource_attr(resources, "clickhouse_price_table")
    )
    ta_group_id = _as_text(_resource_attr(resources, "ta_group_id"))
    warm_lane_enabled = bool(
        _resource_attr(resources, "warm_lane_enabled", default=False)
    )
    simulation_db = _as_text(_resource_attr(postgres_config, "simulation_db"))
    simulation_dsn = _as_text(_resource_attr(postgres_config, "simulation_dsn"))
    simulation_topics_disjoint = all(
        simulation_topic_by_role.get(role) != source_topic_by_role.get(role)
        for role in lane_contract.replay_roles
    )
    signal_basename = lane_contract.clickhouse_simulation_table_by_role[
        lane_contract.signal_table_role
    ]
    price_basename = lane_contract.clickhouse_simulation_table_by_role[
        lane_contract.price_table_role
    ]
    signal_table_isolated = bool(
        clickhouse_signal_table
        and clickhouse_signal_table.endswith(f".{signal_basename}")
    )
    price_table_isolated = bool(
        clickhouse_price_table and clickhouse_price_table.endswith(f".{price_basename}")
    )
    auxiliary_tables_isolated = all(
        table.endswith(f".{lane_contract.clickhouse_simulation_table_by_role[role]}")
        for role, table in clickhouse_table_by_role.items()
        if role not in {lane_contract.signal_table_role, lane_contract.price_table_role}
    )
    postgres_database_isolated = bool(simulation_db and simulation_db != "torghut")
    report = {
        "lane": lane_contract.lane,
        "simulation_topics_isolated_from_sources": simulation_topics_disjoint,
        "ta_group_isolated": warm_lane_enabled
        or ta_group_id != _as_text(ta_data.get(lane_contract.ta_group_id_key)),
        "signal_table_isolated": signal_table_isolated,
        "price_table_isolated": price_table_isolated,
        "auxiliary_tables_isolated": auxiliary_tables_isolated,
        "postgres_database_isolated": postgres_database_isolated,
        "simulation_dsn": simulation_dsn,
    }
    if not all(bool(item) for item in report.values() if isinstance(item, bool)):
        failed = [
            key
            for key, passed in report.items()
            if isinstance(passed, bool) and not passed
        ]
        raise RuntimeError(f"isolation_guard_failed:{','.join(failed)}")
    return report


def _teardown_clean(
    *,
    resources: Any,
    postgres_config: Any,
) -> dict[str, Any]:
    resource_payload = _resource_asdict(resources)
    lane_contract = _resource_lane_contract(resources)
    namespace = _as_text(resource_payload.get("namespace")) or "torghut"
    torghut_service = _as_text(resource_payload.get("torghut_service"))
    ta_configmap = _as_text(resource_payload.get("ta_configmap"))
    ta_deployment = _as_text(resource_payload.get("ta_deployment"))
    run_id = _as_text(resource_payload.get("run_id")) or ""
    dataset_id = _as_text(resource_payload.get("dataset_id")) or ""
    simulation_clickhouse_db = _as_text(resource_payload.get("clickhouse_db")) or ""
    clickhouse_signal_table = (
        _as_text(resource_payload.get("clickhouse_signal_table")) or ""
    )
    clickhouse_price_table = (
        _as_text(resource_payload.get("clickhouse_price_table")) or ""
    )
    order_feed_group_id = _as_text(resource_payload.get("order_feed_group_id")) or ""
    ta_group_id = _as_text(resource_payload.get("ta_group_id")) or ""
    target_mode = _as_text(resource_payload.get("target_mode")) or ""
    warm_lane_enabled = bool(
        _resource_attr(resources, "warm_lane_enabled", default=False)
    )
    runtime_dsn = _as_text(_resource_attr(postgres_config, "torghut_runtime_dsn")) or ""
    simulation_topics = _as_mapping(resource_payload.get("simulation_topic_by_role"))
    run_scoped_order_updates_topic = (
        _as_text(simulation_topics.get("order_updates")) or ""
    )
    lane_default_order_updates_topic = (
        _as_text(lane_contract.simulation_topic_by_role.get("order_updates")) or ""
    )
    lane_default_signal_table = (
        f"{DEFAULT_WARM_LANE_SIMULATION_DATABASE}."
        f"{lane_contract.clickhouse_simulation_table_by_role[lane_contract.signal_table_role]}"
    )
    lane_default_price_table = (
        f"{DEFAULT_WARM_LANE_SIMULATION_DATABASE}."
        f"{lane_contract.clickhouse_simulation_table_by_role[lane_contract.price_table_role]}"
    )
    if (
        not run_scoped_order_updates_topic
        or run_scoped_order_updates_topic == lane_default_order_updates_topic
    ):
        run_scoped_order_updates_topic = _run_scoped_simulation_topic(
            lane_default_order_updates_topic,
            run_id,
        )
    run_scoped_order_updates_topic_is_distinct = bool(
        run_scoped_order_updates_topic
        and run_scoped_order_updates_topic != lane_default_order_updates_topic
    )

    if torghut_service is None or ta_configmap is None or ta_deployment is None:
        raise RuntimeError(
            "simulation resources are incomplete for teardown validation"
        )

    service = _kubectl_json(
        namespace, ["get", "kservice", torghut_service, "-o", "json"]
    )
    _, env_entries = _kservice_env(service, namespace=namespace)
    env_by_name = {
        _as_text(entry.get("name")): entry
        for entry in env_entries
        if _as_text(entry.get("name"))
    }
    ta_config = _kubectl_json(
        namespace, ["get", "configmap", ta_configmap, "-o", "json"]
    )
    ta_data = _as_mapping(ta_config.get("data"))
    ta_health = _flink_runtime_health(namespace, ta_deployment)

    def env_value(key: str) -> str | None:
        return _as_text(_as_mapping(env_by_name.get(key)).get("value"))

    runtime_database = _database_name_from_dsn(env_value("DB_DSN"))
    run_scoped_markers_present = {
        "trading_simulation_run_id": env_value("TRADING_SIMULATION_RUN_ID") == run_id,
        "trading_simulation_dataset_id": env_value("TRADING_SIMULATION_DATASET_ID")
        == dataset_id,
        "order_feed_topic": run_scoped_order_updates_topic_is_distinct
        and env_value("TRADING_ORDER_FEED_TOPIC") == run_scoped_order_updates_topic,
        "simulation_order_updates_topic": (
            run_scoped_order_updates_topic_is_distinct
            and env_value("TRADING_SIMULATION_ORDER_UPDATES_TOPIC")
            == run_scoped_order_updates_topic
        ),
    }

    simulation_markers_present = {
        "trading_simulation_enabled": _as_text(
            _as_mapping(env_by_name.get("TRADING_SIMULATION_ENABLED")).get("value")
        )
        == "true",
        "trading_simulation_run_id": run_scoped_markers_present[
            "trading_simulation_run_id"
        ],
        "trading_simulation_dataset_id": run_scoped_markers_present[
            "trading_simulation_dataset_id"
        ],
        "db_dsn": _as_text(_as_mapping(env_by_name.get("DB_DSN")).get("value"))
        == runtime_dsn,
        "signal_table": _as_text(
            _as_mapping(env_by_name.get("TRADING_SIGNAL_TABLE")).get("value")
        )
        == clickhouse_signal_table,
        "price_table": _as_text(
            _as_mapping(env_by_name.get("TRADING_PRICE_TABLE")).get("value")
        )
        == clickhouse_price_table,
        "order_feed_topic": run_scoped_markers_present["order_feed_topic"],
        "simulation_order_updates_topic": run_scoped_markers_present[
            "simulation_order_updates_topic"
        ],
        "order_feed_group_id": _as_text(
            _as_mapping(env_by_name.get("TRADING_ORDER_FEED_GROUP_ID")).get("value")
        )
        == order_feed_group_id,
        "ta_group_id": _as_text(ta_data.get(lane_contract.ta_group_id_key))
        == ta_group_id,
        "ta_clickhouse_database": _clickhouse_database_from_jdbc_url(
            _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
        )
        == simulation_clickhouse_db,
    }

    dedicated_service_disabled_baseline = {}

    if warm_lane_enabled:
        warm_lane_baseline = {
            "trading_simulation_enabled": env_value("TRADING_SIMULATION_ENABLED")
            == "true",
            "trading_simulation_run_id_cleared": not env_value(
                "TRADING_SIMULATION_RUN_ID"
            ),
            "trading_simulation_dataset_id_cleared": not env_value(
                "TRADING_SIMULATION_DATASET_ID"
            ),
            "signal_table": env_value("TRADING_SIGNAL_TABLE")
            == clickhouse_signal_table,
            "price_table": env_value("TRADING_PRICE_TABLE") == clickhouse_price_table,
            "order_feed_topic": env_value("TRADING_ORDER_FEED_TOPIC")
            == lane_default_order_updates_topic,
            "simulation_order_updates_topic": (
                env_value("TRADING_SIMULATION_ORDER_UPDATES_TOPIC")
                == lane_default_order_updates_topic
            ),
            "order_feed_group_id": env_value("TRADING_ORDER_FEED_GROUP_ID")
            == order_feed_group_id,
            "ta_group_id": _as_text(ta_data.get(lane_contract.ta_group_id_key))
            == ta_group_id,
            "ta_clickhouse_database": _clickhouse_database_from_jdbc_url(
                _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
            )
            == simulation_clickhouse_db,
        }
        dedicated_service_baseline = {}
        restored = all(warm_lane_baseline.values()) and not any(
            run_scoped_markers_present.values()
        )
    elif target_mode == "dedicated_service":
        warm_lane_baseline = {}
        dedicated_service_baseline = {
            "trading_simulation_enabled": env_value("TRADING_SIMULATION_ENABLED")
            == "true",
            "trading_simulation_run_id_cleared": not env_value(
                "TRADING_SIMULATION_RUN_ID"
            ),
            "trading_simulation_dataset_id_cleared": not env_value(
                "TRADING_SIMULATION_DATASET_ID"
            ),
            "db_dsn_database": runtime_database
            == DEFAULT_WARM_LANE_SIMULATION_DATABASE,
            "signal_table": env_value("TRADING_SIGNAL_TABLE")
            == lane_default_signal_table,
            "price_table": env_value("TRADING_PRICE_TABLE") == lane_default_price_table,
            "order_feed_topic": env_value("TRADING_ORDER_FEED_TOPIC")
            == lane_default_order_updates_topic,
            "simulation_order_updates_topic": (
                env_value("TRADING_SIMULATION_ORDER_UPDATES_TOPIC")
                == lane_default_order_updates_topic
            ),
            "order_feed_group_id": env_value("TRADING_ORDER_FEED_GROUP_ID")
            == DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID,
            "ta_group_id": _as_text(ta_data.get(lane_contract.ta_group_id_key))
            == DEFAULT_SIMULATION_TA_GROUP_ID,
            "ta_clickhouse_database": _clickhouse_database_from_jdbc_url(
                _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
            )
            == DEFAULT_WARM_LANE_SIMULATION_DATABASE,
        }
        dedicated_service_disabled_baseline = {
            "trading_simulation_disabled": env_value("TRADING_SIMULATION_ENABLED")
            != "true",
            "trading_simulation_run_id_cleared": not env_value(
                "TRADING_SIMULATION_RUN_ID"
            ),
            "trading_simulation_dataset_id_cleared": not env_value(
                "TRADING_SIMULATION_DATASET_ID"
            ),
            "db_dsn_database": runtime_database
            == DEFAULT_WARM_LANE_SIMULATION_DATABASE,
            "order_feed_topic": env_value("TRADING_ORDER_FEED_TOPIC")
            == lane_default_order_updates_topic,
            "simulation_order_updates_topic": (
                env_value("TRADING_SIMULATION_ORDER_UPDATES_TOPIC")
                == lane_default_order_updates_topic
            ),
            "order_feed_group_id": env_value("TRADING_ORDER_FEED_GROUP_ID")
            == DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID,
            "ta_group_id": _as_text(ta_data.get(lane_contract.ta_group_id_key))
            == DEFAULT_SIMULATION_TA_GROUP_ID,
            "ta_clickhouse_database": _clickhouse_database_from_jdbc_url(
                _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
            )
            == DEFAULT_WARM_LANE_SIMULATION_DATABASE,
        }
        restored = (
            all(dedicated_service_baseline.values())
            or (
                all(dedicated_service_disabled_baseline.values())
                and not any(simulation_markers_present.values())
            )
        ) and not any(run_scoped_markers_present.values())
    else:
        warm_lane_baseline = {}
        dedicated_service_baseline = {}
        restored = not any(simulation_markers_present.values())

    return {
        "status": "ok" if restored else "degraded",
        "activity_classification": "success" if restored else "environment_incomplete",
        "restored": restored,
        "warm_lane_enabled": warm_lane_enabled,
        "ta_runtime": ta_health,
        "run_scoped_markers_present": run_scoped_markers_present,
        "simulation_markers_present": simulation_markers_present,
        "warm_lane_baseline": warm_lane_baseline,
        "dedicated_service_baseline": dedicated_service_baseline,
        "dedicated_service_disabled_baseline": dedicated_service_disabled_baseline,
    }


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
    "DEFAULT_COVERAGE_STRICT_RATIO",
    "DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS",
    "DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS",
    "DEFAULT_RUN_MONITOR_MIN_DECISIONS",
    "DEFAULT_RUN_MONITOR_MIN_EXECUTIONS",
    "DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS",
    "DEFAULT_RUN_MONITOR_MIN_TCA",
    "DEFAULT_RUN_MONITOR_POLL_SECONDS",
    "DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS",
    "PRODUCTION_TOPIC_BY_ROLE",
    "TORGHUT_ENV_KEYS",
    "_artifact_bundle",
    "_as_mapping",
    "_as_text",
    "_current_activity_report",
    "_http_clickhouse_query",
    "_monitor_run_completion",
    "_monitor_snapshot",
    "_resolve_window_bounds",
    "_runtime_verify",
    "_safe_float",
    "_safe_int",
    "_signal_snapshot",
    "_teardown_clean",
    "_validate_dump_coverage",
    "_validate_window_policy",
    "_verify_isolation_guards",
]


__all__ = [name for name in globals() if not name.startswith("__")]
