"""Public facade for historical simulation verification helpers."""

from __future__ import annotations

import time
from collections.abc import Callable
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, TypeVar

from scripts.historical_simulation_verification_modules import (
    artifact_verification as _artifact,
)
from scripts.historical_simulation_verification_modules import (
    runtime_health as _runtime,
)
from scripts.historical_simulation_verification_modules import shared_runtime as _shared

_T = TypeVar("_T")

PRODUCTION_TOPIC_BY_ROLE = _shared.PRODUCTION_TOPIC_BY_ROLE
TORGHUT_ENV_KEYS = _shared.TORGHUT_ENV_KEYS
US_EQUITIES_REGULAR_PROFILE = _shared.US_EQUITIES_REGULAR_PROFILE
US_EQUITIES_REGULAR_TIMEZONE = _shared.US_EQUITIES_REGULAR_TIMEZONE
US_EQUITIES_REGULAR_MINUTES = _shared.US_EQUITIES_REGULAR_MINUTES
DEFAULT_COVERAGE_STRICT_RATIO = _shared.DEFAULT_COVERAGE_STRICT_RATIO
DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS = _shared.DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS
DEFAULT_RUN_MONITOR_POLL_SECONDS = _shared.DEFAULT_RUN_MONITOR_POLL_SECONDS
DEFAULT_RUN_MONITOR_MIN_DECISIONS = _shared.DEFAULT_RUN_MONITOR_MIN_DECISIONS
DEFAULT_RUN_MONITOR_MIN_EXECUTIONS = _shared.DEFAULT_RUN_MONITOR_MIN_EXECUTIONS
DEFAULT_RUN_MONITOR_MIN_TCA = _shared.DEFAULT_RUN_MONITOR_MIN_TCA
DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS = _shared.DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS
DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS = (
    _shared.DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS
)
DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS = (
    _shared.DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS
)
DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS = _shared.DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS
DEFAULT_RUN_MONITOR_PROFILE = _shared.DEFAULT_RUN_MONITOR_PROFILE
DEFAULT_WARM_LANE_SIMULATION_DATABASE = _shared.DEFAULT_WARM_LANE_SIMULATION_DATABASE
DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID = _shared.DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID
DEFAULT_SIMULATION_TA_GROUP_ID = _shared.DEFAULT_SIMULATION_TA_GROUP_ID
MONITOR_PROFILE_DEFAULTS = _shared.MONITOR_PROFILE_DEFAULTS
TRANSIENT_POSTGRES_ERROR_PATTERNS = _shared.TRANSIENT_POSTGRES_ERROR_PATTERNS

_ORIGINAL_HTTP_CLICKHOUSE_QUERY = _shared._http_clickhouse_query
_ORIGINAL_DEPLOYMENT_REPLICA_HEALTH = _shared._deployment_replica_health
_ORIGINAL_FLINK_RUNTIME_HEALTH = _shared._flink_runtime_health
_ORIGINAL_KSERVICE_ENV = _runtime._kservice_env
_ORIGINAL_MONITOR_SNAPSHOT = _runtime._monitor_snapshot
_ORIGINAL_PROGRESS_COMPONENT_SNAPSHOT = _runtime._progress_component_snapshot
_ORIGINAL_CLICKHOUSE_TABLE_ACTIVITY = _runtime._clickhouse_table_activity
_ORIGINAL_SIGNAL_SNAPSHOT = _runtime._signal_snapshot
_ORIGINAL_SIMULATION_PROGRESS_SNAPSHOT = _runtime._simulation_progress_snapshot
_ORIGINAL_ACTIVITY_STATE = _runtime._activity_state
_ORIGINAL_RUNTIME_VERIFY = _runtime._runtime_verify
_ORIGINAL_SCHEMA_REGISTRY_HEALTH = _runtime._schema_registry_health
_ORIGINAL_HTTP_JSON_GET = _artifact._http_json_get
_ORIGINAL_ANALYSIS_IMAGE_FRESHNESS = _artifact._analysis_image_freshness
_ORIGINAL_ANALYSIS_TEMPLATE_NAMES = _artifact._analysis_template_names
_ORIGINAL_ANALYSIS_TEMPLATE_IMAGE = _artifact._analysis_template_image
_ORIGINAL_CURRENT_ACTIVITY_REPORT = _artifact._current_activity_report
_ORIGINAL_MONITOR_RUN_COMPLETION = _artifact._monitor_run_completion
_ORIGINAL_VERIFY_ISOLATION_GUARDS = _artifact._verify_isolation_guards
_ORIGINAL_TEARDOWN_CLEAN = _artifact._teardown_clean
_ORIGINAL_ARTIFACT_BUNDLE = _artifact._artifact_bundle
_ORIGINAL_PATCH_TARGETS: dict[str, object] = {}
_FACADE_PATCH_TARGETS: dict[str, object] = {}

_as_mapping = _shared._as_mapping
_as_text = _shared._as_text
_safe_int = _shared._safe_int
_safe_float = _shared._safe_float
_cluster_service_host_candidates = _shared._cluster_service_host_candidates
_normalized_string_set = _shared._normalized_string_set
_resource_attr = _shared._resource_attr
_resource_asdict = _shared._resource_asdict
_resource_lane_contract = _shared._resource_lane_contract
_parse_rfc3339_timestamp = _shared._parse_rfc3339_timestamp
_parse_optional_rfc3339_timestamp = _shared._parse_optional_rfc3339_timestamp
_resolve_window_bounds = _shared._resolve_window_bounds
_run_scoped_simulation_topic = _shared._run_scoped_simulation_topic
_window_min_coverage_minutes = _shared._window_min_coverage_minutes
_validate_us_equities_regular_profile = _shared._validate_us_equities_regular_profile
_validate_window_policy = _shared._validate_window_policy
_validate_dump_coverage = _shared._validate_dump_coverage
_replace_database_in_dsn = _shared._replace_database_in_dsn
_database_name_from_dsn = _shared._database_name_from_dsn
_run_command = _shared._run_command
_kubectl_json = _shared._kubectl_json
_cluster_service_http_urls = _shared._cluster_service_http_urls
_is_transient_postgres_error = _shared._is_transient_postgres_error
_run_with_transient_postgres_retry = _shared._run_with_transient_postgres_retry
_condition_status = _shared._condition_status
_first_text = _shared._first_text
_classify_restore_state_error = _shared._classify_restore_state_error


def _sync_patch_targets() -> None:
    patch_targets = {
        "HTTPConnection": HTTPConnection,
        "HTTPSConnection": HTTPSConnection,
        "time": time,
        "_kubectl_json": _kubectl_json,
        "_deployment_replica_health": _deployment_replica_health,
        "_flink_runtime_health": _flink_runtime_health,
        "_http_json_get": _http_json_get,
        "_monitor_snapshot": _monitor_snapshot,
        "_signal_snapshot": _signal_snapshot,
        "_progress_component_snapshot": _progress_component_snapshot,
        "_simulation_progress_snapshot": _simulation_progress_snapshot,
    }
    for module in (_shared, _runtime, _artifact):
        for name, value in patch_targets.items():
            if hasattr(module, name):
                facade = _FACADE_PATCH_TARGETS.get(name)
                if facade is not None and value is facade:
                    value = _ORIGINAL_PATCH_TARGETS[name]
                setattr(module, name, value)


def _delegate(func: Callable[..., _T], *args: Any, **kwargs: Any) -> _T:
    _sync_patch_targets()
    return func(*args, **kwargs)


def _http_clickhouse_query(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_HTTP_CLICKHOUSE_QUERY, *args, **kwargs)


def _deployment_replica_health(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_DEPLOYMENT_REPLICA_HEALTH, *args, **kwargs)


def _flink_runtime_health(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_FLINK_RUNTIME_HEALTH, *args, **kwargs)


def _kservice_env(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_KSERVICE_ENV, *args, **kwargs)


def _monitor_snapshot(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_MONITOR_SNAPSHOT, *args, **kwargs)


def _progress_component_snapshot(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_PROGRESS_COMPONENT_SNAPSHOT, *args, **kwargs)


def _clickhouse_table_activity(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_CLICKHOUSE_TABLE_ACTIVITY, *args, **kwargs)


def _signal_snapshot(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_SIGNAL_SNAPSHOT, *args, **kwargs)


def _simulation_progress_snapshot(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_SIMULATION_PROGRESS_SNAPSHOT, *args, **kwargs)


def _activity_state(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_ACTIVITY_STATE, *args, **kwargs)


def _runtime_verify(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_RUNTIME_VERIFY, *args, **kwargs)


def _schema_registry_health(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_SCHEMA_REGISTRY_HEALTH, *args, **kwargs)


def _http_json_get(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_HTTP_JSON_GET, *args, **kwargs)


def _analysis_image_freshness(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_ANALYSIS_IMAGE_FRESHNESS, *args, **kwargs)


def _analysis_template_names(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_ANALYSIS_TEMPLATE_NAMES, *args, **kwargs)


def _analysis_template_image(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_ANALYSIS_TEMPLATE_IMAGE, *args, **kwargs)


def _current_activity_report(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_CURRENT_ACTIVITY_REPORT, *args, **kwargs)


def _monitor_run_completion(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_MONITOR_RUN_COMPLETION, *args, **kwargs)


def _verify_isolation_guards(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_VERIFY_ISOLATION_GUARDS, *args, **kwargs)


def _teardown_clean(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_TEARDOWN_CLEAN, *args, **kwargs)


def _artifact_bundle(*args: Any, **kwargs: Any) -> Any:
    return _delegate(_ORIGINAL_ARTIFACT_BUNDLE, *args, **kwargs)


_infer_monitor_profile = _runtime._infer_monitor_profile
_monitor_settings = _runtime._monitor_settings
_effective_terminal_signal_ts = _runtime._effective_terminal_signal_ts
_clickhouse_database_from_jdbc_url = _runtime._clickhouse_database_from_jdbc_url
_clickhouse_database_from_table_name = _runtime._clickhouse_database_from_table_name
_cursor_reached_terminal = _runtime._cursor_reached_terminal
_classify_activity_snapshot = _runtime._classify_activity_snapshot
_expected_schema_subjects = _artifact._expected_schema_subjects

_ORIGINAL_PATCH_TARGETS.update(
    {
        "_deployment_replica_health": _ORIGINAL_DEPLOYMENT_REPLICA_HEALTH,
        "_flink_runtime_health": _ORIGINAL_FLINK_RUNTIME_HEALTH,
        "_http_json_get": _ORIGINAL_HTTP_JSON_GET,
        "_monitor_snapshot": _ORIGINAL_MONITOR_SNAPSHOT,
        "_progress_component_snapshot": _ORIGINAL_PROGRESS_COMPONENT_SNAPSHOT,
        "_signal_snapshot": _ORIGINAL_SIGNAL_SNAPSHOT,
        "_simulation_progress_snapshot": _ORIGINAL_SIMULATION_PROGRESS_SNAPSHOT,
    }
)
_FACADE_PATCH_TARGETS.update(
    {
        "_deployment_replica_health": _deployment_replica_health,
        "_flink_runtime_health": _flink_runtime_health,
        "_http_json_get": _http_json_get,
        "_monitor_snapshot": _monitor_snapshot,
        "_progress_component_snapshot": _progress_component_snapshot,
        "_signal_snapshot": _signal_snapshot,
        "_simulation_progress_snapshot": _simulation_progress_snapshot,
    }
)

__all__ = [
    "DEFAULT_COVERAGE_STRICT_RATIO",
    "DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS",
    "DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS",
    "DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS",
    "DEFAULT_RUN_MONITOR_MIN_DECISIONS",
    "DEFAULT_RUN_MONITOR_MIN_EXECUTIONS",
    "DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS",
    "DEFAULT_RUN_MONITOR_MIN_TCA",
    "DEFAULT_RUN_MONITOR_POLL_SECONDS",
    "DEFAULT_RUN_MONITOR_PROFILE",
    "DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS",
    "DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID",
    "DEFAULT_SIMULATION_TA_GROUP_ID",
    "DEFAULT_WARM_LANE_SIMULATION_DATABASE",
    "HTTPConnection",
    "HTTPSConnection",
    "MONITOR_PROFILE_DEFAULTS",
    "PRODUCTION_TOPIC_BY_ROLE",
    "TORGHUT_ENV_KEYS",
    "TRANSIENT_POSTGRES_ERROR_PATTERNS",
    "US_EQUITIES_REGULAR_MINUTES",
    "US_EQUITIES_REGULAR_PROFILE",
    "US_EQUITIES_REGULAR_TIMEZONE",
    "_activity_state",
    "_analysis_image_freshness",
    "_analysis_template_image",
    "_analysis_template_names",
    "_artifact_bundle",
    "_as_mapping",
    "_as_text",
    "_classify_activity_snapshot",
    "_classify_restore_state_error",
    "_clickhouse_database_from_jdbc_url",
    "_clickhouse_database_from_table_name",
    "_clickhouse_table_activity",
    "_cluster_service_host_candidates",
    "_cluster_service_http_urls",
    "_condition_status",
    "_current_activity_report",
    "_cursor_reached_terminal",
    "_database_name_from_dsn",
    "_deployment_replica_health",
    "_effective_terminal_signal_ts",
    "_expected_schema_subjects",
    "_first_text",
    "_flink_runtime_health",
    "_http_clickhouse_query",
    "_http_json_get",
    "_infer_monitor_profile",
    "_is_transient_postgres_error",
    "_kservice_env",
    "_kubectl_json",
    "_monitor_run_completion",
    "_monitor_settings",
    "_monitor_snapshot",
    "_normalized_string_set",
    "_parse_optional_rfc3339_timestamp",
    "_parse_rfc3339_timestamp",
    "_progress_component_snapshot",
    "_replace_database_in_dsn",
    "_resolve_window_bounds",
    "_resource_asdict",
    "_resource_attr",
    "_resource_lane_contract",
    "_run_command",
    "_run_scoped_simulation_topic",
    "_run_with_transient_postgres_retry",
    "_runtime_verify",
    "_safe_float",
    "_safe_int",
    "_schema_registry_health",
    "_signal_snapshot",
    "_simulation_progress_snapshot",
    "_sync_patch_targets",
    "_teardown_clean",
    "_validate_dump_coverage",
    "_validate_us_equities_regular_profile",
    "_validate_window_policy",
    "_verify_isolation_guards",
    "_window_min_coverage_minutes",
    "time",
]
