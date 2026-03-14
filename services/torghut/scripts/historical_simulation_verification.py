from __future__ import annotations

import json
import subprocess
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timedelta, timezone
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote_plus, urlsplit
from zoneinfo import ZoneInfo

import psycopg
from scripts.simulation_lane_contracts import (
    EQUITY_SIMULATION_LANE,
    simulation_lane_contract,
    simulation_schema_registry_subject_roles,
)

PRODUCTION_TOPIC_BY_ROLE = dict(EQUITY_SIMULATION_LANE.source_topic_by_role)

TORGHUT_ENV_KEYS = [
    'DB_DSN',
    'TRADING_MODE',
    'TRADING_FEATURE_FLAGS_ENABLED',
    'TRADING_FEATURE_QUALITY_ENABLED',
    'TRADING_FEATURE_MAX_REQUIRED_NULL_RATE',
    'TRADING_FEATURE_MAX_STALENESS_MS',
    'TRADING_FEATURE_MAX_DUPLICATE_RATIO',
    'TRADING_STRATEGY_RUNTIME_MODE',
    'TRADING_STRATEGY_SCHEDULER_ENABLED',
    'TRADING_SIGNAL_TABLE',
    'TRADING_PRICE_TABLE',
    'TRADING_ORDER_FEED_ENABLED',
    'TRADING_ORDER_FEED_BOOTSTRAP_SERVERS',
    'TRADING_ORDER_FEED_SECURITY_PROTOCOL',
    'TRADING_ORDER_FEED_SASL_MECHANISM',
    'TRADING_ORDER_FEED_SASL_USERNAME',
    'TRADING_ORDER_FEED_SASL_PASSWORD',
    'TRADING_ORDER_FEED_TOPIC',
    'TRADING_ORDER_FEED_TOPIC_V2',
    'TRADING_ORDER_FEED_GROUP_ID',
    'TRADING_EXECUTION_ADAPTER',
    'TRADING_EXECUTION_FALLBACK_ADAPTER',
    'TRADING_SIMULATION_ENABLED',
    'TRADING_SIMULATION_RUN_ID',
    'TRADING_SIMULATION_DATASET_ID',
    'TRADING_SIMULATION_ORDER_UPDATES_TOPIC',
    'TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS',
    'TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL',
    'TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM',
    'TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME',
    'TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD',
]

US_EQUITIES_REGULAR_PROFILE = 'us_equities_regular'
US_EQUITIES_REGULAR_TIMEZONE = 'America/New_York'
US_EQUITIES_REGULAR_MINUTES = 390
DEFAULT_COVERAGE_STRICT_RATIO = 0.95
DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS = 900
DEFAULT_RUN_MONITOR_POLL_SECONDS = 15
DEFAULT_RUN_MONITOR_MIN_DECISIONS = 1
DEFAULT_RUN_MONITOR_MIN_EXECUTIONS = 1
DEFAULT_RUN_MONITOR_MIN_TCA = 1
DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS = 0
DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS = 120
DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS = 5
DEFAULT_RUN_MONITOR_PROFILE = 'smoke'
MONITOR_PROFILE_DEFAULTS: dict[str, dict[str, int]] = {
    'compact': {
        'timeout_seconds': 300,
        'poll_seconds': 5,
        'cursor_grace_seconds': 15,
    },
    'smoke': {
        'timeout_seconds': 900,
        'poll_seconds': 10,
        'cursor_grace_seconds': 30,
    },
    'hourly': {
        'timeout_seconds': 1500,
        'poll_seconds': 10,
        'cursor_grace_seconds': 45,
    },
    'full_day': {
        'timeout_seconds': 3600,
        'poll_seconds': 20,
        'cursor_grace_seconds': 120,
    },
}
TRANSIENT_POSTGRES_ERROR_PATTERNS = (
    'connection refused',
    'connection reset by peer',
    'could not receive data from server',
    'server closed the connection unexpectedly',
    'connection to server at',
    'terminating connection due to administrator command',
    'timeout expired',
)


def _as_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[str, Any], value).items()}


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text


def _safe_int(value: Any, *, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return int(stripped)
            except ValueError:
                return default
    return default


def _safe_float(value: Any, *, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return float(stripped)
            except ValueError:
                return default
    return default


def _cluster_service_host_candidates(host: str) -> list[str]:
    host = host.strip()
    if not host:
        return []

    candidates = [host]
    host_parts = host.split('.')
    if len(host_parts) == 2:
        candidates.append(f'{host}.svc')
        candidates.append(f'{host}.svc.cluster.local')
    if host.endswith('.svc') and not host.endswith('.svc.cluster.local'):
        candidates.append(f'{host}.cluster.local')
    return candidates


def _normalized_string_set(raw: str | None) -> set[str]:
    if raw is None:
        return set()
    return {
        token.strip().lower()
        for token in raw.split(',')
        if token.strip()
    }


def _resource_attr(resource: Any, key: str, *, default: Any = None) -> Any:
    if isinstance(resource, Mapping):
        return resource.get(key, default)
    return getattr(resource, key, default)


def _resource_asdict(resource: Any) -> dict[str, Any]:
    if isinstance(resource, Mapping):
        return {str(key): value for key, value in cast(Mapping[str, Any], resource).items()}
    if is_dataclass(resource):
        payload = asdict(resource)
        return {str(key): value for key, value in cast(dict[str, Any], payload).items()}
    return dict(vars(resource))


def _resource_lane_contract(resource: Any):
    lane = _as_text(_resource_attr(resource, 'lane')) or 'equity'
    return simulation_lane_contract(lane)


def _parse_rfc3339_timestamp(value: str | None, *, label: str) -> datetime:
    if value is None:
        raise SystemExit(f'{label} is required in manifest')
    cleaned = value.replace('Z', '+00:00')
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError as exc:
        raise SystemExit(f'invalid {label} timestamp: {value}') from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_optional_rfc3339_timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return _parse_rfc3339_timestamp(value, label='timestamp')
    except Exception:
        return None


def _resolve_window_bounds(manifest: Mapping[str, Any]) -> tuple[datetime, datetime]:
    window = _as_mapping(manifest.get('window'))
    start = _parse_rfc3339_timestamp(_as_text(window.get('start')), label='window.start')
    end = _parse_rfc3339_timestamp(_as_text(window.get('end')), label='window.end')
    if end <= start:
        raise RuntimeError('window.end must be after window.start')
    return start, end


def _window_min_coverage_minutes(window: Mapping[str, Any], *, profile: str | None) -> int | None:
    raw_minutes = window.get('min_coverage_minutes')
    if raw_minutes is not None:
        minutes = _safe_int(raw_minutes, default=-1)
        if minutes <= 0:
            raise RuntimeError('window.min_coverage_minutes must be > 0 when provided')
        return minutes
    if profile == US_EQUITIES_REGULAR_PROFILE:
        return US_EQUITIES_REGULAR_MINUTES
    return None


def _validate_us_equities_regular_profile(
    *,
    start: datetime,
    end: datetime,
    window: Mapping[str, Any],
) -> None:
    trading_day_raw = _as_text(window.get('trading_day'))
    if trading_day_raw is None:
        raise RuntimeError('window.trading_day is required when window.profile=us_equities_regular')
    timezone_name = _as_text(window.get('timezone')) or US_EQUITIES_REGULAR_TIMEZONE
    try:
        local_tz = ZoneInfo(timezone_name)
    except Exception as exc:
        raise RuntimeError(f'invalid_window_timezone:{timezone_name}') from exc
    try:
        trading_day = date.fromisoformat(trading_day_raw)
    except ValueError as exc:
        raise RuntimeError(f'invalid_window_trading_day:{trading_day_raw}') from exc

    expected_start_local = datetime(trading_day.year, trading_day.month, trading_day.day, 9, 30, tzinfo=local_tz)
    expected_end_local = datetime(trading_day.year, trading_day.month, trading_day.day, 16, 0, tzinfo=local_tz)
    expected_start_utc = expected_start_local.astimezone(timezone.utc)
    expected_end_utc = expected_end_local.astimezone(timezone.utc)
    if start != expected_start_utc or end != expected_end_utc:
        raise RuntimeError(
            'window_profile_mismatch:us_equities_regular '
            f'expected_start={expected_start_utc.isoformat()} '
            f'expected_end={expected_end_utc.isoformat()} '
            f'observed_start={start.isoformat()} '
            f'observed_end={end.isoformat()}'
        )


def _validate_window_policy(manifest: Mapping[str, Any]) -> dict[str, Any]:
    start, end = _resolve_window_bounds(manifest)
    window = _as_mapping(manifest.get('window'))
    profile = (_as_text(window.get('profile')) or '').strip().lower() or None
    if profile == US_EQUITIES_REGULAR_PROFILE:
        _validate_us_equities_regular_profile(start=start, end=end, window=window)
    elif profile is not None:
        raise RuntimeError(f'unsupported_window_profile:{profile}')

    min_coverage_minutes = _window_min_coverage_minutes(window, profile=profile)
    observed_minutes = (end - start).total_seconds() / 60.0
    if min_coverage_minutes is not None and observed_minutes < float(min_coverage_minutes):
        raise RuntimeError(
            'window_coverage_too_small '
            f'observed_minutes={observed_minutes:.3f} '
            f'minimum_required={min_coverage_minutes}'
        )

    strict_ratio = _safe_float(window.get('strict_coverage_ratio'), default=DEFAULT_COVERAGE_STRICT_RATIO)
    if strict_ratio <= 0 or strict_ratio > 1:
        raise RuntimeError('window.strict_coverage_ratio must be in (0, 1]')

    return {
        'window_start': start.isoformat(),
        'window_end': end.isoformat(),
        'profile': profile,
        'min_coverage_minutes': min_coverage_minutes,
        'observed_minutes': observed_minutes,
        'strict_coverage_ratio': strict_ratio,
    }


def _validate_dump_coverage(
    *,
    manifest: Mapping[str, Any],
    dump_report: Mapping[str, Any],
) -> dict[str, Any]:
    window = _as_mapping(manifest.get('window'))
    profile = (_as_text(window.get('profile')) or '').strip().lower() or None
    min_coverage_minutes = _window_min_coverage_minutes(
        window,
        profile=profile,
    )
    strict_ratio_raw = window.get('strict_coverage_ratio')
    strict_ratio = (
        _safe_float(strict_ratio_raw, default=DEFAULT_COVERAGE_STRICT_RATIO)
        if strict_ratio_raw is not None
        else DEFAULT_COVERAGE_STRICT_RATIO
    )

    records = _safe_int(dump_report.get('records'))
    if records <= 0:
        raise RuntimeError('dump_records_empty')

    min_source_timestamp_ms = dump_report.get('min_source_timestamp_ms')
    max_source_timestamp_ms = dump_report.get('max_source_timestamp_ms')
    if min_source_timestamp_ms is None or max_source_timestamp_ms is None:
        return {
            'applied': False,
            'reason': 'timestamp_coverage_unavailable',
        }

    min_ms = _safe_int(min_source_timestamp_ms, default=-1)
    max_ms = _safe_int(max_source_timestamp_ms, default=-1)
    if min_ms < 0 or max_ms < 0 or max_ms < min_ms:
        raise RuntimeError('dump_timestamp_coverage_invalid')
    observed_minutes = (max_ms - min_ms) / 60_000.0

    if min_coverage_minutes is not None:
        required_minutes = float(min_coverage_minutes) * strict_ratio
        if observed_minutes < required_minutes:
            raise RuntimeError(
                'dump_coverage_too_short '
                f'observed_minutes={observed_minutes:.2f} '
                f'required_minutes={required_minutes:.2f} '
                f'strict_ratio={strict_ratio:.4f}'
            )
        return {
            'applied': True,
            'observed_minutes': observed_minutes,
            'required_minutes': required_minutes,
            'min_source_timestamp_ms': min_ms,
            'max_source_timestamp_ms': max_ms,
            'strict_ratio': strict_ratio,
            'profile': profile,
        }
    return {
        'applied': False,
        'observed_minutes': observed_minutes,
        'reason': 'no_minimum_coverage_policy',
        'min_source_timestamp_ms': min_ms,
        'max_source_timestamp_ms': max_ms,
    }


def _replace_database_in_dsn(dsn: str, *, database: str, label: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit(f'{label} must be a valid URL')
    return parsed._replace(path='/' + quote_plus(database)).geturl()


def _run_command(
    args: Sequence[str],
    *,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(args),
            check=True,
            text=True,
            capture_output=True,
            input=input_text,
        )
    except subprocess.CalledProcessError as exc:
        stdout = (exc.stdout or '').strip()
        stderr = (exc.stderr or '').strip()
        detail = stderr or stdout or str(exc)
        raise RuntimeError(f'command_failed: {" ".join(args)}: {detail}') from exc


def _kubectl_json(namespace: str, args: Sequence[str]) -> dict[str, Any]:
    result = _run_command(['kubectl', '-n', namespace, *args])
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError('kubectl did not return a mapping payload')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _is_transient_postgres_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(pattern in message for pattern in TRANSIENT_POSTGRES_ERROR_PATTERNS)


def _run_with_transient_postgres_retry(
    *,
    label: str,
    operation: Callable[[], Any],
    attempts: int = 8,
    sleep_seconds: float = 0.5,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except Exception as exc:
            if not _is_transient_postgres_error(exc):
                raise
            last_error = exc
            if attempt >= attempts:
                break
            time.sleep(sleep_seconds * attempt)
    if last_error is None:
        raise RuntimeError(f'{label}: transient retry failed without captured exception')
    raise RuntimeError(f'{label}: exhausted transient retries: {last_error}') from last_error


def _http_clickhouse_query(
    *,
    config: Any,
    query: str,
) -> tuple[int, str]:
    http_url = _as_text(_resource_attr(config, 'http_url'))
    if http_url is None:
        raise RuntimeError('clickhouse http_url is required')
    parsed = urlsplit(http_url)
    if not parsed.scheme or not parsed.hostname:
        raise RuntimeError(f'invalid_clickhouse_http_url:{http_url}')

    connection_class = HTTPSConnection if parsed.scheme == 'https' else HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port)
    path = parsed.path or '/'
    if parsed.query:
        path = f'{path}?{parsed.query}'

    headers = {'Content-Type': 'text/plain'}
    username = _as_text(_resource_attr(config, 'username'))
    password = _as_text(_resource_attr(config, 'password'))
    if username is not None:
        headers['X-ClickHouse-User'] = username
    if password is not None:
        headers['X-ClickHouse-Key'] = password

    try:
        connection.request('POST', path, body=query.encode('utf-8'), headers=headers)
        response = connection.getresponse()
        return response.status, response.read().decode('utf-8')
    finally:
        connection.close()


def _condition_status(payload: Mapping[str, Any], *, condition_type: str) -> str | None:
    conditions = payload.get('conditions')
    if not isinstance(conditions, list):
        return None
    for raw_item in conditions:
        if not isinstance(raw_item, Mapping):
            continue
        item = cast(Mapping[str, Any], raw_item)
        if _as_text(item.get('type')) == condition_type:
            return _as_text(item.get('status'))
    return None


def _deployment_replica_health(namespace: str, name: str) -> dict[str, Any]:
    deployment = _kubectl_json(namespace, ['get', 'deployment', name, '-o', 'json'])
    status = _as_mapping(deployment.get('status'))
    return {
        'name': name,
        'ready_replicas': int(status.get('readyReplicas') or 0),
        'available_replicas': int(status.get('availableReplicas') or 0),
        'replicas': int(status.get('replicas') or 0),
    }


def _flink_runtime_health(namespace: str, name: str) -> dict[str, Any]:
    deployment = _kubectl_json(namespace, ['get', 'flinkdeployment', name, '-o', 'json'])
    spec = _as_mapping(deployment.get('spec'))
    status = _as_mapping(deployment.get('status'))
    job_status = _as_mapping(status.get('jobStatus'))
    lifecycle_state = _as_text(job_status.get('state')) or _as_text(status.get('jobManagerDeploymentStatus'))
    job_spec = _as_mapping(spec.get('job'))
    restore_error = _classify_restore_state_error(
        _first_text(
            job_status.get('error'),
            job_status.get('message'),
            status.get('error'),
            status.get('message'),
        )
    )
    return {
        'name': name,
        'desired_state': _as_text(job_spec.get('state')) or 'unknown',
        'lifecycle_state': lifecycle_state or 'unknown',
        'job_manager_status': _as_text(status.get('jobManagerDeploymentStatus')) or 'unknown',
        'upgrade_mode': _as_text(job_spec.get('upgradeMode')) or 'unknown',
        'status_error': _first_text(
            job_status.get('error'),
            job_status.get('message'),
            status.get('error'),
            status.get('message'),
        ),
        'restore_state_reason': restore_error,
    }


def _first_text(*values: Any) -> str | None:
    for value in values:
        text = _as_text(value)
        if text:
            return text
    return None


def _classify_restore_state_error(message: str | None) -> str | None:
    normalized = (message or '').strip().lower()
    if not normalized:
        return None
    has_state_term = any(term in normalized for term in ('checkpoint', 'savepoint', 'last-state'))
    has_missing_term = any(
        term in normalized for term in ('not found', 'no such file', 'does not exist', 'missing')
    )
    if has_state_term and has_missing_term:
        return 'restore_state_missing'
    return None


def _kservice_env(
    service: Mapping[str, Any],
    *,
    namespace: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    spec = _as_mapping(service.get('spec'))
    template = _as_mapping(spec.get('template'))
    template_spec = _as_mapping(template.get('spec'))
    containers = template_spec.get('containers')
    if not isinstance(containers, list) or not containers:
        raise RuntimeError('kservice container spec missing')
    first = containers[0]
    if not isinstance(first, Mapping):
        raise RuntimeError('kservice container spec invalid')
    container = _as_mapping(first)
    container_name = _as_text(container.get('name')) or 'user-container'
    env: list[dict[str, Any]] = []
    env_from_raw = container.get('envFrom')
    if namespace and isinstance(env_from_raw, list):
        for item in env_from_raw:
            if not isinstance(item, Mapping):
                continue
            config_map_ref = _as_mapping(cast(Mapping[str, Any], item).get('configMapRef'))
            config_map_name = _as_text(config_map_ref.get('name'))
            if config_map_name is None:
                continue
            config_map = _kubectl_json(namespace, ['get', 'configmap', config_map_name, '-o', 'json'])
            for key, value in _as_mapping(config_map.get('data')).items():
                env.append({'name': key, 'value': str(value)})
    env_raw = container.get('env')
    if isinstance(env_raw, list):
        for item in env_raw:
            if isinstance(item, Mapping):
                env.append(_as_mapping(item))
    return container_name, env


def _infer_monitor_profile(*, start: datetime, end: datetime) -> str:
    duration_minutes = (end - start).total_seconds() / 60.0
    if duration_minutes <= 15:
        return 'compact'
    if duration_minutes <= 90:
        return 'hourly'
    if duration_minutes >= US_EQUITIES_REGULAR_MINUTES:
        return 'full_day'
    return DEFAULT_RUN_MONITOR_PROFILE


def _monitor_settings(manifest: Mapping[str, Any]) -> dict[str, int | str]:
    monitor = _as_mapping(manifest.get('monitor'))
    start, end = _resolve_window_bounds(manifest)
    profile = (_as_text(monitor.get('profile')) or '').strip().lower()
    if not profile:
        profile = _infer_monitor_profile(start=start, end=end)
    if profile not in MONITOR_PROFILE_DEFAULTS:
        raise RuntimeError(f'unsupported_monitor_profile:{profile}')

    defaults = MONITOR_PROFILE_DEFAULTS[profile]
    timeout_seconds = _safe_int(
        monitor.get('timeout_seconds'),
        default=defaults.get('timeout_seconds', DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS),
    )
    poll_seconds = _safe_int(
        monitor.get('poll_seconds'),
        default=defaults.get('poll_seconds', DEFAULT_RUN_MONITOR_POLL_SECONDS),
    )
    min_decisions = _safe_int(monitor.get('min_trade_decisions'), default=DEFAULT_RUN_MONITOR_MIN_DECISIONS)
    min_executions = _safe_int(monitor.get('min_executions'), default=DEFAULT_RUN_MONITOR_MIN_EXECUTIONS)
    min_tca = _safe_int(monitor.get('min_execution_tca_metrics'), default=DEFAULT_RUN_MONITOR_MIN_TCA)
    min_order_events = _safe_int(
        monitor.get('min_execution_order_events'),
        default=DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
    )
    cursor_grace_seconds = _safe_int(
        monitor.get('cursor_grace_seconds'),
        default=defaults.get('cursor_grace_seconds', DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS),
    )
    if timeout_seconds <= 0:
        raise RuntimeError('monitor.timeout_seconds must be > 0')
    if poll_seconds <= 0:
        raise RuntimeError('monitor.poll_seconds must be > 0')
    if min_decisions < 0 or min_executions < 0 or min_tca < 0 or min_order_events < 0:
        raise RuntimeError('monitor minimum thresholds cannot be negative')
    if cursor_grace_seconds < 0:
        raise RuntimeError('monitor.cursor_grace_seconds cannot be negative')
    return {
        'profile': profile,
        'timeout_seconds': timeout_seconds,
        'poll_seconds': poll_seconds,
        'min_trade_decisions': min_decisions,
        'min_executions': min_executions,
        'min_execution_tca_metrics': min_tca,
        'min_execution_order_events': min_order_events,
        'cursor_grace_seconds': cursor_grace_seconds,
    }


def _monitor_snapshot(postgres_config: Any) -> dict[str, Any]:
    dsn = _as_text(_resource_attr(postgres_config, 'torghut_runtime_dsn')) or _as_text(_resource_attr(postgres_config, 'simulation_dsn'))
    if dsn is None:
        raise RuntimeError('postgres runtime dsn is required')

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
                cursor_at = cursor_at_raw.astimezone(timezone.utc) if isinstance(cursor_at_raw, datetime) else None
        return {
            'trade_decisions': trade_decisions,
            'executions': executions,
            'execution_tca_metrics': execution_tca_metrics,
            'execution_order_events': execution_order_events,
            'cursor_at': cursor_at.isoformat() if cursor_at is not None else None,
        }

    return cast(
        dict[str, Any],
        _run_with_transient_postgres_retry(label='monitor_snapshot', operation=_snapshot),
    )


def _progress_component_snapshot(*, resources: Any, postgres_config: Any) -> dict[str, dict[str, Any]]:
    dsn = _as_text(_resource_attr(postgres_config, 'torghut_runtime_dsn')) or _as_text(_resource_attr(postgres_config, 'simulation_dsn'))
    run_id = _as_text(_resource_attr(resources, 'run_id'))
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
                'status': _as_text(row[1]),
                'dataset_id': _as_text(row[2]),
                'lane': _as_text(row[3]),
                'workflow_name': _as_text(row[4]),
                'last_source_ts': row[5].astimezone(timezone.utc).isoformat() if isinstance(row[5], datetime) else None,
                'last_signal_ts': row[6].astimezone(timezone.utc).isoformat() if isinstance(row[6], datetime) else None,
                'last_price_ts': row[7].astimezone(timezone.utc).isoformat() if isinstance(row[7], datetime) else None,
                'cursor_at': row[8].astimezone(timezone.utc).isoformat() if isinstance(row[8], datetime) else None,
                'records_dumped': _safe_int(row[9]),
                'records_replayed': _safe_int(row[10]),
                'trade_decisions': _safe_int(row[11]),
                'executions': _safe_int(row[12]),
                'execution_tca_metrics': _safe_int(row[13]),
                'execution_order_events': _safe_int(row[14]),
                'strategy_type': _as_text(row[15]),
                'legacy_path_count': _safe_int(row[16]),
                'fallback_count': _safe_int(row[17]),
                'terminal_state': _as_text(row[18]),
                'last_error_code': _as_text(row[19]),
                'last_error_message': _as_text(row[20]),
                'payload': _as_mapping(row[21]),
            }
        return components

    try:
        return cast(
            dict[str, dict[str, Any]],
            _run_with_transient_postgres_retry(label='progress_component_snapshot', operation=_load),
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
        'rows': 1 if last_event_ts is not None else 0,
        'last_event_ts': last_event_ts,
    }


def _signal_snapshot(*, resources: Any, clickhouse_config: Any) -> dict[str, Any]:
    counts: dict[str, Any] = {}
    for key, table in {
        'signal_rows': _resource_attr(resources, 'clickhouse_signal_table'),
        'price_rows': _resource_attr(resources, 'clickhouse_price_table'),
    }.items():
        activity = _clickhouse_table_activity(config=clickhouse_config, table=str(table))
        counts[key] = _safe_int(activity.get('rows'), default=0)
        if key == 'signal_rows':
            counts['last_signal_ts'] = _as_text(activity.get('last_event_ts'))
        elif key == 'price_rows':
            counts['last_price_ts'] = _as_text(activity.get('last_event_ts'))
    return counts


def _simulation_progress_snapshot(
    *,
    resources: Any,
    postgres_config: Any,
    clickhouse_config: Any,
) -> dict[str, Any]:
    components = _progress_component_snapshot(resources=resources, postgres_config=postgres_config)
    if not components:
        snapshot = _monitor_snapshot(postgres_config)
        snapshot.update(_signal_snapshot(resources=resources, clickhouse_config=clickhouse_config))
        snapshot['progress_source'] = 'direct_tables'
        snapshot['components'] = {}
        return snapshot

    torghut = _as_mapping(components.get('torghut'))
    replay = _as_mapping(components.get('replay'))
    ta = _as_mapping(components.get('ta'))
    signal_snapshot = _signal_snapshot(resources=resources, clickhouse_config=clickhouse_config)
    last_signal_ts = (
        _as_text(signal_snapshot.get('last_signal_ts'))
        or _as_text(torghut.get('last_signal_ts'))
        or _as_text(replay.get('last_signal_ts'))
        or _as_text(ta.get('last_signal_ts'))
    )
    last_price_ts = (
        _as_text(signal_snapshot.get('last_price_ts'))
        or _as_text(torghut.get('last_price_ts'))
        or _as_text(replay.get('last_price_ts'))
        or _as_text(ta.get('last_price_ts'))
    )
    return {
        'progress_source': 'simulation_run_progress',
        'components': components,
        'trade_decisions': _safe_int(torghut.get('trade_decisions')),
        'executions': _safe_int(torghut.get('executions')),
        'execution_tca_metrics': _safe_int(torghut.get('execution_tca_metrics')),
        'execution_order_events': _safe_int(torghut.get('execution_order_events')),
        'cursor_at': _as_text(torghut.get('cursor_at')),
        'signal_rows': 1 if last_signal_ts is not None else 0,
        'price_rows': 1 if last_price_ts is not None else 0,
        'last_signal_ts': last_signal_ts,
        'last_price_ts': last_price_ts,
        'records_dumped': _safe_int(replay.get('records_dumped')),
        'records_replayed': _safe_int(replay.get('records_replayed')),
        'strategy_type': _as_text(torghut.get('strategy_type')) or _as_text(replay.get('strategy_type')),
        'legacy_path_count': _safe_int(torghut.get('legacy_path_count')),
        'fallback_count': _safe_int(torghut.get('fallback_count')),
    }


def _effective_terminal_signal_ts(
    *,
    window_end: datetime,
    last_signal_ts: datetime | None,
) -> datetime:
    if last_signal_ts is None:
        return window_end
    if last_signal_ts < window_end:
        return last_signal_ts
    return window_end


def _clickhouse_database_from_jdbc_url(raw_url: str | None) -> str | None:
    text = (raw_url or '').strip()
    if not text:
        return None
    if text.startswith('jdbc:'):
        text = text[len('jdbc:') :]
    parsed = urlsplit(text)
    if not parsed.path:
        return None
    database = parsed.path.lstrip('/').split('/', 1)[0]
    return database or None


def _clickhouse_database_from_table_name(table_name: str | None) -> str | None:
    text = (table_name or '').strip()
    if not text:
        return None
    database, separator, _table = text.partition('.')
    if not separator:
        return None
    database = database.strip()
    return database or None


def _classify_activity_snapshot(
    *,
    runtime_ready: bool,
    snapshot: Mapping[str, Any],
    effective_terminal_signal_ts: datetime,
) -> str:
    cursor_at = _parse_optional_rfc3339_timestamp(_as_text(snapshot.get('cursor_at')))
    cursor_at_raw = snapshot.get('cursor_at')
    if not runtime_ready:
        return 'infra_not_active'
    if _safe_int(snapshot.get('signal_rows')) <= 0:
        return 'signals_absent'
    if cursor_at_raw is None or cursor_at is None:
        return 'cursor_not_advancing'
    if cursor_at < effective_terminal_signal_ts:
        return 'cursor_stalled_before_terminal_signal'
    if _safe_int(snapshot.get('trade_decisions')) <= 0:
        return 'decisions_absent'
    if (
        _safe_int(snapshot.get('executions')) <= 0
        or _safe_int(snapshot.get('execution_tca_metrics')) <= 0
        or (
            _safe_int(snapshot.get('executions')) > 0
            and _safe_int(snapshot.get('execution_order_events')) <= 0
        )
    ):
        return 'executions_absent'
    return 'success'


def _activity_state(
    *,
    manifest: Mapping[str, Any],
    runtime_verify: Mapping[str, Any],
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    start, end = _resolve_window_bounds(manifest)
    runtime_ready = bool(runtime_verify.get('runtime_state') == 'ready')
    last_signal_ts = _parse_optional_rfc3339_timestamp(_as_text(snapshot.get('last_signal_ts')))
    last_price_ts = _parse_optional_rfc3339_timestamp(_as_text(snapshot.get('last_price_ts')))
    cursor_at = _parse_optional_rfc3339_timestamp(_as_text(snapshot.get('cursor_at')))
    effective_terminal_signal_ts = _effective_terminal_signal_ts(
        window_end=end,
        last_signal_ts=last_signal_ts,
    )
    trade_decisions = _safe_int(snapshot.get('trade_decisions'))
    executions = _safe_int(snapshot.get('executions'))
    execution_tca_metrics = _safe_int(snapshot.get('execution_tca_metrics'))
    execution_order_events = _safe_int(snapshot.get('execution_order_events'))
    thresholds_met = (
        trade_decisions >= _safe_int(_as_mapping(manifest.get('monitor')).get('min_trade_decisions'), default=DEFAULT_RUN_MONITOR_MIN_DECISIONS)
        and executions >= _safe_int(_as_mapping(manifest.get('monitor')).get('min_executions'), default=DEFAULT_RUN_MONITOR_MIN_EXECUTIONS)
        and execution_tca_metrics >= _safe_int(
            _as_mapping(manifest.get('monitor')).get('min_execution_tca_metrics'),
            default=DEFAULT_RUN_MONITOR_MIN_TCA,
        )
        and execution_order_events >= _safe_int(
            _as_mapping(manifest.get('monitor')).get('min_execution_order_events'),
            default=DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
        )
    )
    order_event_contract_met = executions <= 0 or execution_order_events > 0
    terminal_reached = cursor_at is not None and cursor_at >= effective_terminal_signal_ts
    classification = _classify_activity_snapshot(
        runtime_ready=runtime_ready,
        snapshot=snapshot,
        effective_terminal_signal_ts=effective_terminal_signal_ts,
    )
    cursor_gap_seconds: float | None = None
    if cursor_at is not None:
        cursor_gap_seconds = max((effective_terminal_signal_ts - cursor_at).total_seconds(), 0.0)
    terminal_reason = 'window_end_reached'
    if last_signal_ts is not None and last_signal_ts < end:
        terminal_reason = 'terminal_signal_reached'
    return {
        'window_start': start.isoformat(),
        'window_end': end.isoformat(),
        'effective_terminal_signal_ts': effective_terminal_signal_ts.isoformat(),
        'last_signal_ts': last_signal_ts.isoformat() if last_signal_ts is not None else None,
        'last_price_ts': last_price_ts.isoformat() if last_price_ts is not None else None,
        'cursor_at': cursor_at.isoformat() if cursor_at is not None else None,
        'cursor_gap_seconds': cursor_gap_seconds,
        'thresholds_met': thresholds_met,
        'order_event_contract_met': order_event_contract_met,
        'terminal_reached': terminal_reached,
        'activity_classification': classification,
        'completion_reason': terminal_reason if terminal_reached else 'waiting_for_terminal_signal',
        'dataset_alignment': (
            'window_declared_beyond_dataset'
            if last_signal_ts is not None and last_signal_ts < end
            else 'window_aligned_with_dataset'
        ),
    }


def _runtime_verify(*, resources: Any, manifest: Mapping[str, Any]) -> dict[str, Any]:
    window_start, window_end = _resolve_window_bounds(manifest)
    lane_contract = _resource_lane_contract(resources)
    namespace = _as_text(_resource_attr(resources, 'namespace')) or 'torghut'
    torghut_service = _as_text(_resource_attr(resources, 'torghut_service'))
    ta_deployment = _as_text(_resource_attr(resources, 'ta_deployment'))
    ta_configmap = _as_text(_resource_attr(resources, 'ta_configmap'))
    forecast_service = _as_text(_resource_attr(resources, 'torghut_forecast_service'))
    if torghut_service is None or ta_deployment is None or ta_configmap is None or forecast_service is None:
        raise RuntimeError('simulation resources are incomplete')

    service = _kubectl_json(namespace, ['get', 'kservice', torghut_service, '-o', 'json'])
    service_status = _as_mapping(service.get('status'))
    latest_ready_revision = _as_text(service_status.get('latestReadyRevisionName'))
    ready = _condition_status(service_status, condition_type='Ready') == 'True'
    _, env_entries = _kservice_env(service, namespace=namespace)
    env_by_name = {
        _as_text(entry.get('name')): entry
        for entry in env_entries
        if _as_text(entry.get('name'))
    }

    def _env_value(name: str) -> str | None:
        return _as_text(_as_mapping(env_by_name.get(name)).get('value'))

    expected_order_updates_topic = _as_text(
        _as_mapping(_resource_attr(resources, 'simulation_topic_by_role')).get('order_updates')
    )
    expected_topics = _as_mapping(_resource_attr(resources, 'simulation_topic_by_role'))
    warm_lane_enabled = bool(_resource_attr(resources, 'warm_lane_enabled', default=False))
    runtime_mode = _env_value('TRADING_STRATEGY_RUNTIME_MODE')
    scheduler_enabled = _env_value('TRADING_STRATEGY_SCHEDULER_ENABLED') == 'true'
    strategy_runtime_active = runtime_mode == 'plugin_v3' or (
        runtime_mode == 'scheduler_v3' and scheduler_enabled
    )
    trading_config = {
        'trading_enabled': _env_value('TRADING_ENABLED') == 'true',
        'simulation_enabled': _env_value('TRADING_SIMULATION_ENABLED') == 'true',
        'strategy_runtime_mode': runtime_mode in {'plugin_v3', 'scheduler_v3'},
        'strategy_runtime_active': strategy_runtime_active,
        'signal_table': _env_value('TRADING_SIGNAL_TABLE')
        == _as_text(_resource_attr(resources, 'clickhouse_signal_table')),
        'price_table': _env_value('TRADING_PRICE_TABLE')
        == _as_text(_resource_attr(resources, 'clickhouse_price_table')),
        'order_feed_enabled': _env_value('TRADING_ORDER_FEED_ENABLED') == 'true',
        'order_feed_topic': _env_value('TRADING_ORDER_FEED_TOPIC') == expected_order_updates_topic,
        'simulation_order_updates_topic': _env_value('TRADING_SIMULATION_ORDER_UPDATES_TOPIC')
        == expected_order_updates_topic,
        'simulation_run_id': warm_lane_enabled
        or _env_value('TRADING_SIMULATION_RUN_ID') == _as_text(_resource_attr(resources, 'run_id')),
        'signal_allowed_sources': 'ta' in _normalized_string_set(_env_value('TRADING_SIGNAL_ALLOWED_SOURCES')),
    }
    trading_config_complete = all(trading_config.values())
    ta_config = _kubectl_json(namespace, ['get', 'configmap', ta_configmap, '-o', 'json'])
    ta_data = _as_mapping(ta_config.get('data'))
    expected_clickhouse_database = (
        _as_text(_resource_attr(resources, 'clickhouse_db'))
        or _clickhouse_database_from_table_name(_as_text(_resource_attr(resources, 'clickhouse_signal_table')))
        or _clickhouse_database_from_table_name(_as_text(_resource_attr(resources, 'clickhouse_price_table')))
    )
    ta_runtime_config = {
        f'{role}_topic': _as_text(ta_data.get(key)) == _as_text(expected_topics.get(role))
        for role, key in lane_contract.ta_topic_key_by_role.items()
        if role in expected_topics
    }
    ta_runtime_config['clickhouse_database'] = _clickhouse_database_from_jdbc_url(
        _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
    ) == expected_clickhouse_database
    ta_runtime_config['expected_clickhouse_database'] = expected_clickhouse_database
    ta_runtime_config['current_clickhouse_database'] = _clickhouse_database_from_jdbc_url(
        _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
    )
    ta_runtime_config_complete = all(
        value for key, value in ta_runtime_config.items() if key not in {'expected_clickhouse_database', 'current_clickhouse_database'}
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
        revision_health = _deployment_replica_health(namespace, f'{latest_ready_revision}-deployment')
    ta_health = _flink_runtime_health(namespace, ta_deployment)
    forecast_health = _deployment_replica_health(namespace, forecast_service)
    return {
        'runtime_state': 'ready'
        if ready
        and revision_health is not None
        and revision_health['ready_replicas'] > 0
        and ta_health['desired_state'] == 'running'
        and ta_health['lifecycle_state'] in {'RUNNING', 'running', 'DEPLOYED'}
        and forecast_health['ready_replicas'] > 0
        and trading_config_complete
        and ta_runtime_config_complete
        and bool(schema_registry.get('ready'))
        and bool(analysis_images.get('ready'))
        else 'not_ready',
        'target_mode': _as_text(_resource_attr(resources, 'target_mode')),
        'window_start': window_start.astimezone(timezone.utc).isoformat(),
        'window_end': window_end.astimezone(timezone.utc).isoformat(),
        'torghut_service': {
            'name': torghut_service,
            'ready': ready,
            'latest_ready_revision': latest_ready_revision,
            'revision_health': revision_health,
            'trading_config': trading_config,
        },
        'ta_runtime': ta_health,
        'ta_runtime_config': ta_runtime_config,
        'schema_registry': schema_registry,
        'analysis_images': analysis_images,
        'forecast_runtime': forecast_health,
        'environment_state': 'complete'
        if (
            forecast_health['ready_replicas'] > 0
            and trading_config_complete
            and ta_runtime_config_complete
            and bool(schema_registry.get('ready'))
            and bool(analysis_images.get('ready'))
        )
        else 'environment_incomplete',
    }


def _schema_registry_health(
    *,
    ta_data: Mapping[str, Any],
    lane_contract: Any,
) -> dict[str, Any]:
    registry_url = _as_text(ta_data.get('TA_SCHEMA_REGISTRY_URL'))
    if not registry_url:
        return {
            'ready': True,
            'reason': 'schema_registry_url_not_declared',
            'subjects_checked': [],
            'subjects_missing': [],
        }
    subjects = _expected_schema_subjects(ta_data=ta_data, lane_contract=lane_contract)
    try:
        status, _ = _http_json_get(registry_url, '/subjects')
    except Exception as exc:
        return {
            'ready': False,
            'reason': f'schema_registry_not_ready:{exc}',
            'subjects_checked': subjects,
            'subjects_missing': subjects,
        }
    if status != 200:
        return {
            'ready': False,
            'reason': f'schema_registry_not_ready:http_{status}',
            'subjects_checked': subjects,
            'subjects_missing': subjects,
        }
    missing: list[str] = []
    for subject in subjects:
        subject_path = f"/subjects/{quote_plus(subject)}/versions/latest"
        subject_status, _ = _http_json_get(registry_url, subject_path)
        if subject_status != 200:
            missing.append(subject)
    return {
        'ready': len(missing) == 0,
        'reason': 'ok' if not missing else 'schema_subject_missing',
        'url': registry_url,
        'subjects_checked': subjects,
        'subjects_missing': missing,
    }


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
        subjects.append(f'{topic}-value')
    return sorted(set(subjects))


def _http_json_get(
    base_url: str,
    path: str,
    *,
    timeout_seconds: int = DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS,
) -> tuple[int, str]:
    parsed = urlsplit(base_url)
    if not parsed.scheme or not parsed.hostname:
        raise RuntimeError(f'invalid_http_url:{base_url}')
    connection_class = HTTPSConnection if parsed.scheme == 'https' else HTTPConnection
    target_path = parsed.path or '/'
    if path and path != '/':
        target_path = f'{target_path.rstrip("/")}/{path.lstrip("/")}'
    last_error: OSError | None = None
    for hostname in _cluster_service_host_candidates(parsed.hostname):
        connection = connection_class(hostname, parsed.port, timeout=timeout_seconds)
        try:
            connection.request('GET', target_path)
            response = connection.getresponse()
            return response.status, response.read().decode('utf-8', errors='replace')
        except OSError as exc:
            last_error = exc
            continue
        finally:
            connection.close()
    if last_error is not None:
        raise last_error
    raise RuntimeError('http_request_failed_without_attempts')


def _analysis_image_freshness(
    *,
    namespace: str,
    service: Mapping[str, Any],
    template_names: Sequence[str],
) -> dict[str, Any]:
    spec = _as_mapping(service.get('spec'))
    template = _as_mapping(spec.get('template'))
    template_spec = _as_mapping(template.get('spec'))
    containers = template_spec.get('containers')
    service_image: str | None = None
    if isinstance(containers, list) and containers:
        first = containers[0]
        if isinstance(first, Mapping):
            service_image = _as_text(cast(Mapping[str, Any], first).get('image'))
    if not service_image:
        return {
            'ready': True,
            'reason': 'service_image_not_declared',
            'service_image': None,
            'analysis_images': {},
        }
    analysis_images: dict[str, str] = {}
    mismatched: dict[str, str] = {}
    for template_name in template_names:
        template_payload = _kubectl_json(namespace, ['get', 'analysistemplate', template_name, '-o', 'json'])
        image = _analysis_template_image(template_payload)
        if not image:
            continue
        analysis_images[template_name] = image
        if image != service_image:
            mismatched[template_name] = image
    return {
        'ready': len(mismatched) == 0,
        'reason': 'ok' if not mismatched else 'analysis_image_stale',
        'service_image': service_image,
        'analysis_images': analysis_images,
        'mismatched_templates': mismatched,
    }

def _analysis_template_names(manifest: Mapping[str, Any]) -> tuple[str, str]:
    rollouts = _as_mapping(manifest.get('rollouts'))
    runtime_template = _as_text(rollouts.get('runtime_template')) or 'torghut-simulation-runtime-ready'
    activity_template = _as_text(rollouts.get('activity_template')) or 'torghut-simulation-activity'
    return runtime_template, activity_template


def _analysis_template_image(template_payload: Mapping[str, Any]) -> str | None:
    spec = _as_mapping(template_payload.get('spec'))
    metrics = spec.get('metrics')
    if not isinstance(metrics, list) or not metrics:
        return None
    provider = _as_mapping(_as_mapping(metrics[0]).get('provider'))
    job_spec = _as_mapping(provider.get('job'))
    template = _as_mapping(_as_mapping(job_spec.get('spec')).get('template'))
    pod_spec = _as_mapping(template.get('spec'))
    containers = pod_spec.get('containers')
    if not isinstance(containers, list) or not containers:
        return None
    first = containers[0]
    if not isinstance(first, Mapping):
        return None
    return _as_text(cast(Mapping[str, Any], first).get('image'))


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
    classification = _as_text(activity_state.get('activity_classification')) or 'unknown'
    return {
        'status': 'ok' if classification == 'success' else 'degraded',
        'activity_classification': classification,
        'monitor': settings,
        'poll_count': 1,
        'final_snapshot': {
            'polled_at': datetime.now(timezone.utc).isoformat(),
            **snapshot,
        },
        'polls': [],
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
    timeout_seconds = _safe_int(settings.get('timeout_seconds'), default=DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS)
    poll_seconds = _safe_int(settings.get('poll_seconds'), default=DEFAULT_RUN_MONITOR_POLL_SECONDS)
    cursor_grace_seconds = _safe_int(
        settings.get('cursor_grace_seconds'),
        default=DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
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
        poll_payload = {'polled_at': polled_at.isoformat(), **snapshot}
        polls.append(poll_payload)
        activity_state = _activity_state(
            manifest=manifest,
            runtime_verify=runtime_verify,
            snapshot=snapshot,
        )
        effective_terminal_signal_ts = _parse_rfc3339_timestamp(
            _as_text(activity_state.get('effective_terminal_signal_ts')),
            label='effective_terminal_signal_ts',
        )
        cursor_at = _parse_optional_rfc3339_timestamp(_as_text(activity_state.get('cursor_at')))
        cursor_reached = cursor_at is not None and cursor_at >= effective_terminal_signal_ts
        completion_ready = bool(activity_state.get('thresholds_met')) and bool(activity_state.get('order_event_contract_met'))

        if cursor_reached and cursor_reached_at is None:
            cursor_reached_at = polled_at
        if cursor_reached and completion_ready:
            return {
                'status': 'ok',
                'activity_classification': 'success',
                'monitor': settings,
                'poll_count': len(polls),
                'final_snapshot': poll_payload,
                'polls': polls[-20:],
                **activity_state,
            }
        if polled_at >= deadline or (
            cursor_reached
            and cursor_reached_at is not None
            and int((polled_at - cursor_reached_at).total_seconds()) >= cursor_grace_seconds
        ):
            classification = _as_text(activity_state.get('activity_classification')) or 'unknown'
            return {
                'status': 'ok' if classification == 'success' else 'degraded',
                'activity_classification': classification,
                'monitor': settings,
                'poll_count': len(polls),
                'final_snapshot': poll_payload,
                'polls': polls[-20:],
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
    source_topic_by_role = cast(dict[str, str], _resource_attr(resources, 'source_topic_by_role'))
    simulation_topic_by_role = cast(dict[str, str], _resource_attr(resources, 'simulation_topic_by_role'))
    clickhouse_table_by_role = cast(
        dict[str, str],
        _resource_attr(resources, 'clickhouse_table_by_role', default={}),
    )
    clickhouse_signal_table = _as_text(_resource_attr(resources, 'clickhouse_signal_table'))
    clickhouse_price_table = _as_text(_resource_attr(resources, 'clickhouse_price_table'))
    ta_group_id = _as_text(_resource_attr(resources, 'ta_group_id'))
    warm_lane_enabled = bool(_resource_attr(resources, 'warm_lane_enabled', default=False))
    simulation_db = _as_text(_resource_attr(postgres_config, 'simulation_db'))
    simulation_dsn = _as_text(_resource_attr(postgres_config, 'simulation_dsn'))
    simulation_topics_disjoint = all(
        simulation_topic_by_role.get(role) != source_topic_by_role.get(role)
        for role in lane_contract.replay_roles
    )
    signal_basename = lane_contract.clickhouse_simulation_table_by_role[lane_contract.signal_table_role]
    price_basename = lane_contract.clickhouse_simulation_table_by_role[lane_contract.price_table_role]
    signal_table_isolated = bool(clickhouse_signal_table and clickhouse_signal_table.endswith(f'.{signal_basename}'))
    price_table_isolated = bool(clickhouse_price_table and clickhouse_price_table.endswith(f'.{price_basename}'))
    auxiliary_tables_isolated = all(
        table.endswith(f'.{lane_contract.clickhouse_simulation_table_by_role[role]}')
        for role, table in clickhouse_table_by_role.items()
        if role not in {lane_contract.signal_table_role, lane_contract.price_table_role}
    )
    postgres_database_isolated = bool(simulation_db and simulation_db != 'torghut')
    report = {
        'lane': lane_contract.lane,
        'simulation_topics_isolated_from_sources': simulation_topics_disjoint,
        'ta_group_isolated': warm_lane_enabled
        or ta_group_id != _as_text(ta_data.get(lane_contract.ta_group_id_key)),
        'signal_table_isolated': signal_table_isolated,
        'price_table_isolated': price_table_isolated,
        'auxiliary_tables_isolated': auxiliary_tables_isolated,
        'postgres_database_isolated': postgres_database_isolated,
        'simulation_dsn': simulation_dsn,
    }
    if not all(bool(item) for item in report.values() if isinstance(item, bool)):
        failed = [key for key, passed in report.items() if isinstance(passed, bool) and not passed]
        raise RuntimeError(f'isolation_guard_failed:{",".join(failed)}')
    return report


def _teardown_clean(
    *,
    resources: Any,
    postgres_config: Any,
) -> dict[str, Any]:
    resource_payload = _resource_asdict(resources)
    lane_contract = _resource_lane_contract(resources)
    namespace = _as_text(resource_payload.get('namespace')) or 'torghut'
    torghut_service = _as_text(resource_payload.get('torghut_service'))
    ta_configmap = _as_text(resource_payload.get('ta_configmap'))
    ta_deployment = _as_text(resource_payload.get('ta_deployment'))
    run_id = _as_text(resource_payload.get('run_id')) or ''
    dataset_id = _as_text(resource_payload.get('dataset_id')) or ''
    simulation_clickhouse_db = _as_text(resource_payload.get('clickhouse_db')) or ''
    clickhouse_signal_table = _as_text(resource_payload.get('clickhouse_signal_table')) or ''
    clickhouse_price_table = _as_text(resource_payload.get('clickhouse_price_table')) or ''
    order_feed_group_id = _as_text(resource_payload.get('order_feed_group_id')) or ''
    ta_group_id = _as_text(resource_payload.get('ta_group_id')) or ''
    warm_lane_enabled = bool(_resource_attr(resources, 'warm_lane_enabled', default=False))
    runtime_dsn = _as_text(_resource_attr(postgres_config, 'torghut_runtime_dsn')) or ''
    simulation_topics = _as_mapping(resource_payload.get('simulation_topic_by_role'))
    run_scoped_order_updates_topic = _as_text(simulation_topics.get('order_updates')) or ''
    lane_default_order_updates_topic = _as_text(lane_contract.simulation_topic_by_role.get('order_updates')) or ''

    if torghut_service is None or ta_configmap is None or ta_deployment is None:
        raise RuntimeError('simulation resources are incomplete for teardown validation')

    service = _kubectl_json(namespace, ['get', 'kservice', torghut_service, '-o', 'json'])
    _, env_entries = _kservice_env(service, namespace=namespace)
    env_by_name = {
        _as_text(entry.get('name')): entry
        for entry in env_entries
        if _as_text(entry.get('name'))
    }
    ta_config = _kubectl_json(namespace, ['get', 'configmap', ta_configmap, '-o', 'json'])
    ta_data = _as_mapping(ta_config.get('data'))
    ta_health = _flink_runtime_health(namespace, ta_deployment)

    def env_value(key: str) -> str | None:
        return _as_text(_as_mapping(env_by_name.get(key)).get('value'))

    run_scoped_markers_present = {
        'trading_simulation_run_id': env_value('TRADING_SIMULATION_RUN_ID') == run_id,
        'trading_simulation_dataset_id': env_value('TRADING_SIMULATION_DATASET_ID') == dataset_id,
        'order_feed_topic': env_value('TRADING_ORDER_FEED_TOPIC') == run_scoped_order_updates_topic,
        'simulation_order_updates_topic': (
            env_value('TRADING_SIMULATION_ORDER_UPDATES_TOPIC') == run_scoped_order_updates_topic
        ),
    }

    simulation_markers_present = {
        'trading_simulation_enabled': _as_text(_as_mapping(env_by_name.get('TRADING_SIMULATION_ENABLED')).get('value')) == 'true',
        'trading_simulation_run_id': run_scoped_markers_present['trading_simulation_run_id'],
        'trading_simulation_dataset_id': run_scoped_markers_present['trading_simulation_dataset_id'],
        'db_dsn': _as_text(_as_mapping(env_by_name.get('DB_DSN')).get('value')) == runtime_dsn,
        'signal_table': _as_text(_as_mapping(env_by_name.get('TRADING_SIGNAL_TABLE')).get('value')) == clickhouse_signal_table,
        'price_table': _as_text(_as_mapping(env_by_name.get('TRADING_PRICE_TABLE')).get('value')) == clickhouse_price_table,
        'order_feed_topic': run_scoped_markers_present['order_feed_topic'],
        'simulation_order_updates_topic': run_scoped_markers_present['simulation_order_updates_topic'],
        'order_feed_group_id': _as_text(_as_mapping(env_by_name.get('TRADING_ORDER_FEED_GROUP_ID')).get('value')) == order_feed_group_id,
        'ta_group_id': _as_text(ta_data.get(lane_contract.ta_group_id_key)) == ta_group_id,
        'ta_clickhouse_database': _clickhouse_database_from_jdbc_url(
            _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
        )
        == simulation_clickhouse_db,
    }

    if warm_lane_enabled:
        warm_lane_baseline = {
            'trading_simulation_enabled': env_value('TRADING_SIMULATION_ENABLED') == 'true',
            'trading_simulation_run_id_cleared': not env_value('TRADING_SIMULATION_RUN_ID'),
            'trading_simulation_dataset_id_cleared': not env_value('TRADING_SIMULATION_DATASET_ID'),
            'signal_table': env_value('TRADING_SIGNAL_TABLE') == clickhouse_signal_table,
            'price_table': env_value('TRADING_PRICE_TABLE') == clickhouse_price_table,
            'order_feed_topic': env_value('TRADING_ORDER_FEED_TOPIC') == lane_default_order_updates_topic,
            'simulation_order_updates_topic': (
                env_value('TRADING_SIMULATION_ORDER_UPDATES_TOPIC') == lane_default_order_updates_topic
            ),
            'order_feed_group_id': env_value('TRADING_ORDER_FEED_GROUP_ID') == order_feed_group_id,
            'ta_group_id': _as_text(ta_data.get(lane_contract.ta_group_id_key)) == ta_group_id,
            'ta_clickhouse_database': _clickhouse_database_from_jdbc_url(
                _as_text(ta_data.get(lane_contract.ta_clickhouse_url_key))
            )
            == simulation_clickhouse_db,
        }
        restored = all(warm_lane_baseline.values()) and not any(run_scoped_markers_present.values())
    else:
        warm_lane_baseline = {}
        restored = not any(simulation_markers_present.values())

    return {
        'status': 'ok' if restored else 'degraded',
        'activity_classification': 'success' if restored else 'environment_incomplete',
        'restored': restored,
        'warm_lane_enabled': warm_lane_enabled,
        'ta_runtime': ta_health,
        'run_scoped_markers_present': run_scoped_markers_present,
        'simulation_markers_present': simulation_markers_present,
        'warm_lane_baseline': warm_lane_baseline,
    }


def _artifact_bundle(
    *,
    run_dir: Path,
) -> dict[str, Any]:
    required = [
        'run-manifest.json',
        'runtime-verify.json',
        'replay-report.json',
        'signal-activity.json',
        'decision-activity.json',
        'execution-activity.json',
        'report/simulation-report.json',
    ]
    existing = [path for path in required if (run_dir / path).exists()]
    missing = [path for path in required if path not in existing]
    return {
        'status': 'ok' if not missing else 'degraded',
        'activity_classification': 'success' if not missing else 'environment_incomplete',
        'run_dir': str(run_dir),
        'existing': existing,
        'missing': missing,
    }


__all__ = [
    'DEFAULT_COVERAGE_STRICT_RATIO',
    'DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS',
    'DEFAULT_RUN_MONITOR_MIN_DECISIONS',
    'DEFAULT_RUN_MONITOR_MIN_EXECUTIONS',
    'DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS',
    'DEFAULT_RUN_MONITOR_MIN_TCA',
    'DEFAULT_RUN_MONITOR_POLL_SECONDS',
    'DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS',
    'PRODUCTION_TOPIC_BY_ROLE',
    'TORGHUT_ENV_KEYS',
    '_artifact_bundle',
    '_as_mapping',
    '_as_text',
    '_current_activity_report',
    '_http_clickhouse_query',
    '_monitor_run_completion',
    '_monitor_snapshot',
    '_resolve_window_bounds',
    '_runtime_verify',
    '_safe_float',
    '_safe_int',
    '_signal_snapshot',
    '_teardown_clean',
    '_validate_dump_coverage',
    '_validate_window_policy',
    '_verify_isolation_guards',
]
