"""Public facade for historical simulation verification helpers."""

from __future__ import annotations

import time
from http.client import HTTPConnection, HTTPSConnection

from scripts.historical_simulation_verification_modules import (
    artifact_verification as _artifact,
)
from scripts.historical_simulation_verification_modules import (
    runtime_health as _runtime,
)
from scripts.historical_simulation_verification_modules import (
    runtime_progress as _progress,
)
from scripts.historical_simulation_verification_modules import shared_runtime as _shared


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


_http_clickhouse_query = _shared._http_clickhouse_query
_deployment_replica_health = _shared._deployment_replica_health
_flink_runtime_health = _shared._flink_runtime_health
_kservice_env = _runtime._kservice_env
_monitor_snapshot = _progress._monitor_snapshot
_progress_component_snapshot = _progress._progress_component_snapshot
_clickhouse_table_activity = _progress._clickhouse_table_activity
_signal_snapshot = _progress._signal_snapshot
_simulation_progress_snapshot = _progress._simulation_progress_snapshot
_activity_state = _progress._activity_state
_runtime_verify = _runtime._runtime_verify
_schema_registry_health = _runtime._schema_registry_health
_http_json_get = _artifact._http_json_get
_analysis_image_freshness = _artifact._analysis_image_freshness
_analysis_template_names = _artifact._analysis_template_names
_analysis_template_image = _artifact._analysis_template_image
_current_activity_report = _artifact._current_activity_report
_monitor_run_completion = _artifact._monitor_run_completion
_verify_isolation_guards = _artifact._verify_isolation_guards
_teardown_clean = _artifact._teardown_clean
_artifact_bundle = _artifact._artifact_bundle
_infer_monitor_profile = _runtime._infer_monitor_profile
_monitor_settings = _runtime._monitor_settings
_effective_terminal_signal_ts = _runtime._effective_terminal_signal_ts
_clickhouse_database_from_jdbc_url = _runtime._clickhouse_database_from_jdbc_url
_clickhouse_database_from_table_name = _runtime._clickhouse_database_from_table_name
_cursor_reached_terminal = _runtime._cursor_reached_terminal
_classify_activity_snapshot = _runtime._classify_activity_snapshot
_expected_schema_subjects = _artifact._expected_schema_subjects

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
    "_teardown_clean",
    "_validate_dump_coverage",
    "_validate_us_equities_regular_profile",
    "_validate_window_policy",
    "_verify_isolation_guards",
    "_window_min_coverage_minutes",
    "time",
]
