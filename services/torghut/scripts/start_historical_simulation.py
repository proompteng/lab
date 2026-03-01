#!/usr/bin/env python3
"""Single-entrypoint historical simulation workflow for Torghut."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import socket
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, cast
from urllib.parse import quote, quote_plus, unquote_plus, urlsplit
from http.client import HTTPConnection, HTTPSConnection
from zoneinfo import ZoneInfo

import psycopg
from psycopg import sql
import yaml

APPLY_CONFIRMATION_PHRASE = 'START_HISTORICAL_SIMULATION'
DEFAULT_NAMESPACE = 'torghut'
DEFAULT_TA_CONFIGMAP = 'torghut-ta-config'
DEFAULT_TA_DEPLOYMENT = 'torghut-ta'
DEFAULT_TORGHUT_SERVICE = 'torghut'
DEFAULT_OUTPUT_ROOT = Path('artifacts/torghut/simulations')

PRODUCTION_TOPIC_BY_ROLE = {
    'trades': 'torghut.trades.v1',
    'quotes': 'torghut.quotes.v1',
    'bars': 'torghut.bars.1m.v1',
    'status': 'torghut.status.v1',
    'ta_microbars': 'torghut.ta.bars.1s.v1',
    'ta_signals': 'torghut.ta.signals.v1',
    'ta_status': 'torghut.ta.status.v1',
    'order_updates': 'torghut.trade-updates.v1',
}

SIMULATION_TOPIC_BY_ROLE = {
    'trades': 'torghut.sim.trades.v1',
    'quotes': 'torghut.sim.quotes.v1',
    'bars': 'torghut.sim.bars.1m.v1',
    'status': 'torghut.sim.status.v1',
    'ta_microbars': 'torghut.sim.ta.bars.1s.v1',
    'ta_signals': 'torghut.sim.ta.signals.v1',
    'ta_status': 'torghut.sim.ta.status.v1',
    'order_updates': 'torghut.sim.trade-updates.v1',
}

TA_TOPIC_KEY_BY_ROLE = {
    'trades': 'TA_TRADES_TOPIC',
    'quotes': 'TA_QUOTES_TOPIC',
    'bars': 'TA_BARS1M_TOPIC',
    'ta_microbars': 'TA_MICROBARS_TOPIC',
    'ta_signals': 'TA_SIGNALS_TOPIC',
}

TORGHUT_ENV_KEYS = [
    'DB_DSN',
    'TRADING_MODE',
    'TRADING_LIVE_ENABLED',
    'TRADING_FEATURE_FLAGS_ENABLED',
    'TRADING_FEATURE_QUALITY_ENABLED',
    'TRADING_FEATURE_MAX_REQUIRED_NULL_RATE',
    'TRADING_FEATURE_MAX_STALENESS_MS',
    'TRADING_FEATURE_MAX_DUPLICATE_RATIO',
    'TRADING_STRATEGY_RUNTIME_MODE',
    'TRADING_STRATEGY_SCHEDULER_ENABLED',
    'TRADING_STRATEGY_RUNTIME_FALLBACK_LEGACY',
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

SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST = frozenset(
    {
        'TRADING_FEATURE_QUALITY_ENABLED',
        'TRADING_FEATURE_MAX_REQUIRED_NULL_RATE',
        'TRADING_FEATURE_MAX_STALENESS_MS',
        'TRADING_FEATURE_MAX_DUPLICATE_RATIO',
        'TRADING_STRATEGY_RUNTIME_MODE',
        'TRADING_STRATEGY_SCHEDULER_ENABLED',
        'TRADING_STRATEGY_RUNTIME_FALLBACK_LEGACY',
        'TRADING_SIGNAL_LOOKBACK_MINUTES',
    }
)
SIMULATION_FEATURE_STALENESS_MARGIN_MS = 300_000
SIMULATION_FEATURE_STALENESS_MIN_MS = 120_000
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
DEFAULT_ARGOCD_APPSET_NAME = 'product'
DEFAULT_ARGOCD_NAMESPACE = 'argocd'
DEFAULT_ARGOCD_APP_NAME = 'torghut'
DEFAULT_ARGOCD_RUN_MODE = 'manual'
TRANSIENT_POSTGRES_ERROR_PATTERNS = (
    'connection refused',
    'connection reset by peer',
    'could not receive data from server',
    'server closed the connection unexpectedly',
    'connection to server at',
    'terminating connection due to administrator command',
    'timeout expired',
)
VECTOR_EXTENSION_NAME = 'vector'
POSTGRES_VECTOR_EXTENSION_PERMISSION_ERROR_MARKERS = (
    'permission denied to create extension',
    'must be superuser to create this extension',
)
TRANSIENT_POSTGRES_RETRY_ATTEMPTS = 8
TRANSIENT_POSTGRES_RETRY_SLEEP_SECONDS = 0.5
KAFKA_API_VERSION = (4, 1, 1)
KAFKA_HOST_SUFFIX_FALLBACKS = (
    '.kafka-kafka-brokers.kafka.svc.cluster.local',
    '.kafka-kafka-brokers.kafka.svc',
    '.kafka.svc.cluster.local',
    '.kafka.svc',
    '.svc.cluster.local',
    '.svc',
)
_ORIGINAL_GETADDRINFO = socket.getaddrinfo


def _kafka_host_candidates(host: str) -> list[str]:
    host = host.strip()
    if not host:
        return []

    candidates = [host]
    if '.' not in host:
        for suffix in KAFKA_HOST_SUFFIX_FALLBACKS:
            candidates.append(f'{host}{suffix}')
    return candidates


def _getaddrinfo_with_kafka_fallback(
    host: Any,
    port: Any,
    *args: Any,
    **kwargs: Any,
) -> Any:
    if not isinstance(host, str):
        return _ORIGINAL_GETADDRINFO(host, port, *args, **kwargs)

    last_error: Exception | None = None
    for candidate in _kafka_host_candidates(host):
        try:
            return _ORIGINAL_GETADDRINFO(candidate, port, *args, **kwargs)
        except OSError as exc:  # pragma: no cover - exercised by kafka runtime path only
            last_error = exc
            continue
    if last_error is None:
        raise
    raise last_error


socket.getaddrinfo = _getaddrinfo_with_kafka_fallback


@dataclass(frozen=True)
class KafkaRuntimeConfig:
    bootstrap_servers: str
    security_protocol: str | None
    sasl_mechanism: str | None
    sasl_username: str | None
    sasl_password: str | None
    runtime_bootstrap_servers: str | None = None
    runtime_security_protocol: str | None = None
    runtime_sasl_mechanism: str | None = None
    runtime_sasl_username: str | None = None
    runtime_sasl_password: str | None = None

    @property
    def runtime_bootstrap(self) -> str:
        return self.runtime_bootstrap_servers or self.bootstrap_servers

    @property
    def runtime_security(self) -> str | None:
        return self.runtime_security_protocol or self.security_protocol

    @property
    def runtime_sasl(self) -> str | None:
        return self.runtime_sasl_mechanism or self.sasl_mechanism

    @property
    def runtime_username(self) -> str | None:
        return self.runtime_sasl_username or self.sasl_username

    @property
    def runtime_password(self) -> str | None:
        return self.runtime_sasl_password or self.sasl_password

    def kafka_client_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            'bootstrap_servers': [
                item.strip()
                for item in self.bootstrap_servers.split(',')
                if item.strip()
            ],
        }
        if self.security_protocol:
            kwargs['security_protocol'] = self.security_protocol
        if self.sasl_mechanism:
            kwargs['sasl_mechanism'] = self.sasl_mechanism
        if self.sasl_username:
            kwargs['sasl_plain_username'] = self.sasl_username
        if self.sasl_password:
            kwargs['sasl_plain_password'] = self.sasl_password
        kwargs['api_version'] = KAFKA_API_VERSION
        kwargs['api_version_auto_timeout_ms'] = 5000
        return kwargs

    def kafka_runtime_client_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            'bootstrap_servers': [
                item.strip()
                for item in self.runtime_bootstrap.split(',')
                if item.strip()
            ],
        }
        if self.runtime_security:
            kwargs['security_protocol'] = self.runtime_security
        if self.runtime_sasl:
            kwargs['sasl_mechanism'] = self.runtime_sasl
        if self.runtime_username:
            kwargs['sasl_plain_username'] = self.runtime_username
        if self.runtime_password:
            kwargs['sasl_plain_password'] = self.runtime_password
        kwargs['api_version'] = KAFKA_API_VERSION
        kwargs['api_version_auto_timeout_ms'] = 5000
        return kwargs


@dataclass(frozen=True)
class ClickHouseRuntimeConfig:
    http_url: str
    username: str | None
    password: str | None


@dataclass(frozen=True)
class PostgresRuntimeConfig:
    admin_dsn: str
    simulation_dsn: str
    simulation_db: str
    migrations_command: str
    runtime_simulation_dsn: str | None = None

    @property
    def torghut_runtime_dsn(self) -> str:
        return self.runtime_simulation_dsn or self.simulation_dsn


@dataclass(frozen=True)
class SimulationResources:
    run_id: str
    run_token: str
    dataset_id: str
    namespace: str
    ta_configmap: str
    ta_deployment: str
    torghut_service: str
    output_root: Path
    source_topic_by_role: dict[str, str]
    simulation_topic_by_role: dict[str, str]
    replay_topic_by_source_topic: dict[str, str]
    ta_group_id: str
    order_feed_group_id: str
    clickhouse_db: str
    clickhouse_signal_table: str
    clickhouse_price_table: str


@dataclass(frozen=True)
class ArgocdAutomationConfig:
    manage_automation: bool
    applicationset_name: str
    applicationset_namespace: str
    app_name: str
    desired_mode_during_run: str
    restore_mode_after_run: str
    verify_timeout_seconds: int


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Plan/run/apply/report/teardown historical simulation runs with isolated Kafka and storage targets.',
    )
    parser.add_argument('--mode', choices=['plan', 'run', 'apply', 'report', 'teardown'], default='plan')
    parser.add_argument('--run-id', required=True, help='Stable simulation run id (used for all isolation names).')
    parser.add_argument('--dataset-manifest', required=True, help='JSON or YAML manifest describing dataset + infra endpoints.')
    parser.add_argument('--confirm', default='', help=f'Apply confirmation phrase: {APPLY_CONFIRMATION_PHRASE}')
    parser.add_argument('--json', action='store_true', help='Emit machine-readable JSON output only.')
    parser.add_argument('--force-replay', action='store_true', help='Replay dump even when replay marker exists.')
    parser.add_argument('--force-dump', action='store_true', help='Re-dump source topics even when dump file exists.')
    parser.add_argument(
        '--allow-missing-state',
        action='store_true',
        help='Allow teardown without an existing state file (no-op restore).',
    )
    parser.add_argument(
        '--skip-teardown',
        action='store_true',
        help='Do not teardown runtime after mode=run/report (for debugging only).',
    )
    parser.add_argument(
        '--report-only',
        action='store_true',
        help='With mode=run, execute report generation after monitor without calling apply.',
    )
    return parser.parse_args()


def _load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f'dataset manifest not found: {path}')
    raw = path.read_text(encoding='utf-8')
    suffix = path.suffix.lower()
    if suffix in {'.yaml', '.yml'}:
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)
    if not isinstance(payload, Mapping):
        raise SystemExit('dataset manifest must parse to a mapping object')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _normalize_run_token(run_id: str) -> str:
    token = re.sub(r'[^a-zA-Z0-9]+', '_', run_id.strip().lower()).strip('_')
    token = re.sub(r'_+', '_', token)
    if not token:
        raise SystemExit('run-id must contain at least one alphanumeric character')
    return token


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

    expected_start_local = datetime(
        trading_day.year,
        trading_day.month,
        trading_day.day,
        9,
        30,
        tzinfo=local_tz,
    )
    expected_end_local = datetime(
        trading_day.year,
        trading_day.month,
        trading_day.day,
        16,
        0,
        tzinfo=local_tz,
    )
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
        _validate_us_equities_regular_profile(
            start=start,
            end=end,
            window=window,
        )
    elif profile is not None:
        raise RuntimeError(f'unsupported_window_profile:{profile}')

    min_coverage_minutes = _window_min_coverage_minutes(window, profile=profile)
    observed_minutes = (end - start).total_seconds() / 60.0
    if min_coverage_minutes is not None and observed_minutes < float(min_coverage_minutes):
        raise RuntimeError(
            'window_coverage_too_short '
            f'observed_minutes={observed_minutes:.2f} '
            f'required_minutes={min_coverage_minutes}'
        )
    strict_ratio_raw = window.get('strict_coverage_ratio')
    strict_ratio = (
        _safe_float(strict_ratio_raw, default=DEFAULT_COVERAGE_STRICT_RATIO)
        if strict_ratio_raw is not None
        else DEFAULT_COVERAGE_STRICT_RATIO
    )
    if strict_ratio <= 0 or strict_ratio > 1:
        raise RuntimeError('window.strict_coverage_ratio must be within (0,1]')

    return {
        'start': start.isoformat(),
        'end': end.isoformat(),
        'duration_minutes': observed_minutes,
        'profile': profile,
        'min_coverage_minutes': min_coverage_minutes,
        'strict_coverage_ratio': strict_ratio,
    }


def _validate_dump_coverage(
    *,
    manifest: Mapping[str, Any],
    dump_report: Mapping[str, Any],
) -> dict[str, Any]:
    window = _as_mapping(manifest.get('window'))
    profile = (_as_text(window.get('profile')) or '').strip().lower() or None
    min_coverage_minutes = _window_min_coverage_minutes(window, profile=profile)
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


def _build_kafka_runtime_config(manifest: Mapping[str, Any]) -> KafkaRuntimeConfig:
    kafka = _as_mapping(manifest.get('kafka'))
    bootstrap_servers = _as_text(kafka.get('bootstrap_servers'))
    if not bootstrap_servers:
        raise SystemExit('manifest.kafka.bootstrap_servers is required')
    runtime_bootstrap_servers = _as_text(kafka.get('runtime_bootstrap_servers')) or bootstrap_servers
    security_protocol = _as_text(kafka.get('security_protocol'))
    sasl_mechanism = _as_text(kafka.get('sasl_mechanism'))
    sasl_username = _as_text(kafka.get('sasl_username'))
    runtime_security_protocol = (
        _as_text(kafka.get('runtime_security_protocol'))
        or security_protocol
    )
    runtime_sasl_mechanism = (
        _as_text(kafka.get('runtime_sasl_mechanism'))
        or sasl_mechanism
    )
    runtime_sasl_username = (
        _as_text(kafka.get('runtime_sasl_username'))
        or sasl_username
    )
    password = _as_text(kafka.get('sasl_password'))
    password_env = _as_text(kafka.get('sasl_password_env'))
    if password is None and password_env:
        password = _as_text(os.environ.get(password_env))
    runtime_password = _as_text(kafka.get('runtime_sasl_password'))
    runtime_password_env = _as_text(kafka.get('runtime_sasl_password_env'))
    if runtime_password is None and runtime_password_env:
        runtime_password = _as_text(os.environ.get(runtime_password_env))
    if runtime_password is None:
        runtime_password = password
    if runtime_security_protocol and runtime_security_protocol.upper().startswith('SASL'):
        if not runtime_sasl_mechanism:
            raise SystemExit('manifest.kafka.runtime_sasl_mechanism is required for SASL runtime')
        if not runtime_sasl_username:
            raise SystemExit('manifest.kafka.runtime_sasl_username is required for SASL runtime')
        if not runtime_password:
            raise SystemExit(
                'manifest.kafka.runtime_sasl_password is missing for SASL runtime. '
                'Set manifest.kafka.runtime_sasl_password_env/runtime_sasl_password '
                'or fallback fields manifest.kafka.sasl_password_env/sasl_password'
            )
    return KafkaRuntimeConfig(
        bootstrap_servers=bootstrap_servers,
        security_protocol=security_protocol,
        sasl_mechanism=sasl_mechanism,
        sasl_username=sasl_username,
        sasl_password=password,
        runtime_bootstrap_servers=runtime_bootstrap_servers,
        runtime_security_protocol=runtime_security_protocol,
        runtime_sasl_mechanism=runtime_sasl_mechanism,
        runtime_sasl_username=runtime_sasl_username,
        runtime_sasl_password=runtime_password,
    )


def _build_clickhouse_runtime_config(manifest: Mapping[str, Any]) -> ClickHouseRuntimeConfig:
    clickhouse = _as_mapping(manifest.get('clickhouse'))
    http_url = _as_text(clickhouse.get('http_url'))
    if not http_url:
        raise SystemExit('manifest.clickhouse.http_url is required')
    password = _as_text(clickhouse.get('password'))
    if password is None:
        password_env = _as_text(clickhouse.get('password_env'))
        if password_env:
            password = _as_text(os.environ.get(password_env))
    return ClickHouseRuntimeConfig(
        http_url=http_url.rstrip('/'),
        username=_as_text(clickhouse.get('username')),
        password=password,
    )


def _derive_simulation_dsn(admin_dsn: str, db_name: str) -> str:
    parsed = urlsplit(admin_dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit('manifest.postgres.admin_dsn must be a valid URL')
    suffix = f'?{parsed.query}' if parsed.query else ''
    return f'{parsed.scheme}://{parsed.netloc}/{quote_plus(db_name)}{suffix}'


def _database_name_from_dsn(dsn: str, *, label: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit(f'{label} must be a valid URL')
    raw_path = parsed.path.lstrip('/')
    if not raw_path:
        raise SystemExit(f'{label} must include a database path')
    database = unquote_plus(raw_path).strip()
    if not database:
        raise SystemExit(f'{label} must include a database path')
    return database


def _replace_database_in_dsn(dsn: str, *, database: str, label: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit(f'{label} must be a valid URL')
    return parsed._replace(path='/' + quote_plus(database)).geturl()


def _replace_password_in_dsn(dsn: str, *, password: str, label: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise RuntimeError(f'{label} must be a valid URL')
    if parsed.username is None:
        raise RuntimeError(f'{label} must include a username')

    host = parsed.hostname
    if host is None:
        raise RuntimeError(f'{label} must include a hostname')
    if parsed.port:
        host = f'{host}:{parsed.port}'

    return parsed._replace(netloc=f'{quote_plus(parsed.username)}:{quote_plus(password)}@{host}').geturl()


def _ensure_dsn_password(dsn: str, *, password: str | None, label: str) -> str:
    if password is None:
        return dsn
    parsed = urlsplit(dsn)
    if parsed.password is not None:
        return dsn
    if parsed.username is None:
        return dsn
    return _replace_password_in_dsn(dsn, password=password, label=label)


def _username_from_dsn(dsn: str) -> str | None:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        return None
    if parsed.username is None:
        return None
    username = unquote_plus(parsed.username).strip()
    return username or None


def _redact_dsn_credentials(dsn: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        return dsn
    hostname = parsed.hostname
    if not hostname:
        return dsn
    host = hostname
    if ':' in host and not host.startswith('['):
        host = f'[{host}]'
    if parsed.port is not None:
        host = f'{host}:{parsed.port}'
    username = parsed.username
    password = parsed.password
    if username is None:
        netloc = host
    elif password is None:
        netloc = f'{quote(username, safe="")}@{host}'
    else:
        netloc = f'{quote(username, safe="")}:***@{host}'
    return parsed._replace(netloc=netloc).geturl()


def _normalize_migrations_command(command: str) -> str:
    normalized = command.strip()
    if not normalized:
        return normalized
    uv_path = shutil.which('uv') or 'uv'
    alembic_path = shutil.which('alembic') or 'alembic'
    if normalized in {'uv', 'uv run --frozen alembic upgrade heads'}:
        normalized = f'{uv_path} run --frozen {alembic_path} upgrade heads'
    elif normalized.startswith('uv '):
        if normalized.startswith('uv run --frozen alembic upgrade'):
            normalized = (
                f'{uv_path} run --frozen {alembic_path} '
                f'{normalized[len("uv run --frozen alembic upgrade"):].lstrip()}'
            ).strip()
        else:
            normalized = f'{uv_path} {normalized[len("uv "):]}'
    elif normalized.startswith('alembic '):
        normalized = f'{alembic_path} {normalized[len("alembic "):]}'
    return re.sub(
        r'\balembic\s+upgrade\s+head\b',
        'alembic upgrade heads',
        normalized,
    )


def _find_vector_extension_blocking_revision(repo_root: Path) -> str | None:
    migrations_dir = repo_root / 'migrations' / 'versions'
    if not migrations_dir.is_dir():
        return None

    revision_re = re.compile(r'^\s*revision\s*=\s*([\'"])(.*?)\1')
    down_revision_re = re.compile(r'^\s*down_revision\s*=\s*([\'"])(.*?)\1')

    vector_revision_targets: list[str] = []
    for migration_file in sorted(migrations_dir.glob('*.py')):
        try:
            payload = migration_file.read_text(encoding='utf-8')
        except OSError:
            continue
        lowered = payload.lower()
        if 'create extension if not exists vector' not in lowered:
            continue

        revision = None
        down_revision = None
        for line in payload.splitlines():
            if revision is None:
                revision_match = revision_re.match(line)
                if revision_match:
                    revision = _as_text(revision_match.group(2))

            if down_revision is None:
                down_match = down_revision_re.match(line)
                if down_match:
                    down_revision = _as_text(down_match.group(2))

            if revision is not None and down_revision is not None:
                break

        if revision is None:
            continue

        if down_revision in (None, 'None'):
            return 'base'
        vector_revision_targets.append(down_revision)

    if not vector_revision_targets:
        return None
    return vector_revision_targets[0]


def _replace_alembic_upgrade_target(command: str, target: str) -> str | None:
    try:
        tokens = shlex.split(command)
    except Exception:
        return None
    try:
        upgrade_index = tokens.index('upgrade')
    except ValueError:
        return None
    if len(tokens) <= upgrade_index + 1:
        return None
    tokens[upgrade_index + 1] = target
    return ' '.join(shlex.quote(item) for item in tokens)


def _run_alembic_upgrade(
    *,
    command: str,
    env: Mapping[str, str],
    cwd: Path,
    label: str = 'run_migrations',
) -> None:
    _run_with_transient_postgres_retry(
        label=label,
        operation=lambda: _run_command(
            shlex.split(command),
            cwd=cwd,
            env=env,
        ),
    )


def _build_postgres_runtime_config(
    manifest: Mapping[str, Any],
    *,
    simulation_db: str,
) -> PostgresRuntimeConfig:
    postgres = _as_mapping(manifest.get('postgres'))
    admin_dsn = _as_text(postgres.get('admin_dsn'))
    admin_dsn_env = _as_text(postgres.get('admin_dsn_env'))
    if admin_dsn is None and admin_dsn_env:
        admin_dsn = _as_text(os.environ.get(admin_dsn_env))
    if not admin_dsn:
        raise SystemExit('manifest.postgres.admin_dsn is required')
    admin_password = _as_text(postgres.get('admin_dsn_password'))
    if admin_password is None:
        admin_password_env = _as_text(postgres.get('admin_dsn_password_env'))
        if admin_password_env:
            admin_password = _as_text(os.environ.get(admin_password_env))
    if admin_password:
        admin_dsn = _replace_password_in_dsn(
            admin_dsn,
            password=admin_password,
            label='manifest.postgres.admin_dsn',
        )

    simulation_dsn = _as_text(postgres.get('simulation_dsn'))
    simulation_template = _as_text(postgres.get('simulation_dsn_template'))
    if simulation_dsn is None and simulation_template is not None:
        simulation_dsn = simulation_template.replace('{db}', simulation_db)
    if simulation_dsn is None:
        simulation_dsn = _derive_simulation_dsn(admin_dsn, simulation_db)
    simulation_dsn = _ensure_dsn_password(
        simulation_dsn,
        password=admin_password,
        label='manifest.postgres.simulation_dsn',
    )
    simulation_db = _database_name_from_dsn(
        simulation_dsn,
        label='manifest.postgres.simulation_dsn',
    )
    runtime_simulation_dsn = _as_text(postgres.get('runtime_simulation_dsn'))
    runtime_template = _as_text(postgres.get('runtime_simulation_dsn_template'))
    if runtime_simulation_dsn is None and runtime_template is not None:
        runtime_simulation_dsn = runtime_template.replace('{db}', simulation_db)
    if runtime_simulation_dsn is not None:
        runtime_simulation_dsn = _ensure_dsn_password(
            runtime_simulation_dsn,
            password=admin_password,
            label='manifest.postgres.runtime_simulation_dsn',
        )
        runtime_db = _database_name_from_dsn(
            runtime_simulation_dsn,
            label='manifest.postgres.runtime_simulation_dsn',
        )
        if runtime_db != simulation_db:
            raise SystemExit(
                'manifest.postgres.runtime_simulation_dsn must target the same database as '
                'manifest.postgres.simulation_dsn'
            )

    migrations_command_raw = (
        _as_text(postgres.get('migrations_command'))
        or 'uv run --frozen alembic upgrade heads'
    )
    migrations_command = _normalize_migrations_command(migrations_command_raw)
    return PostgresRuntimeConfig(
        admin_dsn=admin_dsn,
        simulation_dsn=simulation_dsn,
        simulation_db=simulation_db,
        migrations_command=migrations_command,
        runtime_simulation_dsn=runtime_simulation_dsn,
    )


def _merge_topics(
    base: Mapping[str, str],
    override: Mapping[str, Any],
) -> dict[str, str]:
    merged = {key: str(value) for key, value in base.items()}
    for key, value in override.items():
        text = _as_text(value)
        if not text:
            continue
        merged[str(key)] = text
    return merged


def _build_resources(run_id: str, manifest: Mapping[str, Any]) -> SimulationResources:
    run_token = _normalize_run_token(run_id)
    dataset_id = _as_text(manifest.get('dataset_id'))
    if not dataset_id:
        raise SystemExit('manifest.dataset_id is required')

    runtime = _as_mapping(manifest.get('runtime'))
    output_root_raw = _as_text(runtime.get('output_root'))
    output_root = Path(output_root_raw) if output_root_raw else DEFAULT_OUTPUT_ROOT

    source_topics = _merge_topics(
        PRODUCTION_TOPIC_BY_ROLE,
        _as_mapping(manifest.get('source_topics')),
    )
    simulation_topics = _merge_topics(
        SIMULATION_TOPIC_BY_ROLE,
        _as_mapping(manifest.get('simulation_topics')),
    )

    replay_topic_by_source_topic = {
        source_topics['trades']: simulation_topics['trades'],
        source_topics['quotes']: simulation_topics['quotes'],
        source_topics['bars']: simulation_topics['bars'],
        source_topics['status']: simulation_topics['status'],
    }

    clickhouse_cfg = _as_mapping(manifest.get('clickhouse'))
    clickhouse_db = (
        _as_text(clickhouse_cfg.get('simulation_database'))
        or f'torghut_sim_{run_token}'
    )
    clickhouse_signal_table = f'{clickhouse_db}.ta_signals'
    clickhouse_price_table = f'{clickhouse_db}.ta_microbars'

    return SimulationResources(
        run_id=run_id,
        run_token=run_token,
        dataset_id=dataset_id,
        namespace=_as_text(runtime.get('namespace')) or DEFAULT_NAMESPACE,
        ta_configmap=_as_text(runtime.get('ta_configmap')) or DEFAULT_TA_CONFIGMAP,
        ta_deployment=_as_text(runtime.get('ta_deployment')) or DEFAULT_TA_DEPLOYMENT,
        torghut_service=_as_text(runtime.get('torghut_service')) or DEFAULT_TORGHUT_SERVICE,
        output_root=output_root,
        source_topic_by_role=source_topics,
        simulation_topic_by_role=simulation_topics,
        replay_topic_by_source_topic=replay_topic_by_source_topic,
        ta_group_id=f'torghut-ta-sim-{run_token}',
        order_feed_group_id=f'torghut-order-feed-sim-{run_token}',
        clickhouse_db=clickhouse_db,
        clickhouse_signal_table=clickhouse_signal_table,
        clickhouse_price_table=clickhouse_price_table,
    )


def _build_argocd_automation_config(manifest: Mapping[str, Any]) -> ArgocdAutomationConfig:
    argocd = _as_mapping(manifest.get('argocd'))
    manage_automation = str(argocd.get('manage_automation', 'false')).strip().lower() in {
        '1',
        'true',
        'yes',
        'on',
    }
    desired_mode = (_as_text(argocd.get('desired_mode_during_run')) or DEFAULT_ARGOCD_RUN_MODE).lower()
    if desired_mode not in {'manual', 'auto'}:
        raise RuntimeError('argocd.desired_mode_during_run must be one of: manual,auto')
    restore_mode = (_as_text(argocd.get('restore_mode_after_run')) or 'previous').lower()
    if restore_mode not in {'previous', 'manual', 'auto'}:
        raise RuntimeError('argocd.restore_mode_after_run must be one of: previous,manual,auto')
    verify_timeout_seconds = _safe_int(argocd.get('verify_timeout_seconds'), default=600)
    if verify_timeout_seconds <= 0:
        raise RuntimeError('argocd.verify_timeout_seconds must be > 0')
    return ArgocdAutomationConfig(
        manage_automation=manage_automation,
        applicationset_name=_as_text(argocd.get('applicationset_name')) or DEFAULT_ARGOCD_APPSET_NAME,
        applicationset_namespace=_as_text(argocd.get('applicationset_namespace')) or DEFAULT_ARGOCD_NAMESPACE,
        app_name=_as_text(argocd.get('app_name')) or DEFAULT_ARGOCD_APP_NAME,
        desired_mode_during_run=desired_mode,
        restore_mode_after_run=restore_mode,
        verify_timeout_seconds=verify_timeout_seconds,
    )


def _ensure_supported_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f'{name} not found in PATH')


def _ensure_lz4_codec_available() -> None:
    try:
        importlib.import_module('lz4.frame')
    except Exception as exc:
        raise RuntimeError(
            'kafka_lz4_codec_unavailable: install lz4 (for example `uv sync --frozen --extra dev`)'
        ) from exc


def _run_command(
    args: Sequence[str],
    *,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(args),
            check=True,
            text=True,
            capture_output=True,
            cwd=str(cwd) if cwd is not None else None,
            env=dict(env) if env is not None else None,
            input=input_text,
        )
    except subprocess.CalledProcessError as exc:
        stdout = (exc.stdout or '').strip()
        stderr = (exc.stderr or '').strip()
        detail = stderr or stdout or str(exc)
        raise RuntimeError(f'command_failed: {" ".join(args)}: {detail}') from exc


def _is_transient_postgres_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(pattern in message for pattern in TRANSIENT_POSTGRES_ERROR_PATTERNS)


def _is_vector_extension_create_permission_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(marker in message for marker in POSTGRES_VECTOR_EXTENSION_PERMISSION_ERROR_MARKERS)


def _postgres_extension_exists(cursor: psycopg.Cursor, extension: str) -> bool:
    cursor.execute(
        'SELECT 1 FROM pg_extension WHERE extname = %s LIMIT 1',
        (extension,)
    )
    return cursor.fetchone() is not None


def _run_with_transient_postgres_retry(
    *,
    label: str,
    operation: Callable[[], Any],
    attempts: int = TRANSIENT_POSTGRES_RETRY_ATTEMPTS,
    sleep_seconds: float = TRANSIENT_POSTGRES_RETRY_SLEEP_SECONDS,
) -> Any:
    if attempts <= 0:
        raise RuntimeError(f'{label}: attempts must be > 0')
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except Exception as exc:  # pragma: no cover - exercised by integration/runtime failures
            if not _is_transient_postgres_error(exc):
                raise
            last_error = exc
            if attempt >= attempts:
                break
            time.sleep(sleep_seconds * attempt)
    if last_error is None:
        raise RuntimeError(f'{label}: transient retry failed without captured exception')
    raise RuntimeError(f'{label}: exhausted transient retries: {last_error}') from last_error


def _kubectl_json(namespace: str, args: Sequence[str]) -> dict[str, Any]:
    result = _run_command(['kubectl', '-n', namespace, *args])
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError('kubectl did not return a mapping payload')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _kubectl_json_global(args: Sequence[str]) -> dict[str, Any]:
    result = _run_command(['kubectl', *args])
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError('kubectl did not return a mapping payload')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _kubectl_patch(namespace: str, kind: str, name: str, patch: Mapping[str, Any]) -> None:
    _run_command(
        [
            'kubectl',
            '-n',
            namespace,
            'patch',
            kind,
            name,
            '--type',
            'merge',
            '-p',
            json.dumps(dict(patch), separators=(',', ':')),
        ]
    )


def _kubectl_patch_json(
    namespace: str,
    kind: str,
    name: str,
    patch_ops: Sequence[Mapping[str, Any]],
) -> None:
    _run_command(
        [
            'kubectl',
            '-n',
            namespace,
            'patch',
            kind,
            name,
            '--type',
            'json',
            '-p',
            json.dumps(list(patch_ops), separators=(',', ':')),
        ]
    )


def _json_pointer_escape(value: str) -> str:
    return value.replace('~', '~0').replace('/', '~1')


def _json_pointer_unescape(value: str) -> str:
    return value.replace('~1', '/').replace('~0', '~')


def _discover_automation_pointer(
    node: Any,
    *,
    app_name: str,
    path: str = '',
) -> tuple[str, str] | None:
    if isinstance(node, Mapping):
        elements = node.get('elements')
        if isinstance(elements, list):
            elements_path = f'{path}/{_json_pointer_escape("elements")}'
            for idx, entry in enumerate(elements):
                if not isinstance(entry, Mapping):
                    continue
                name = _as_text(entry.get('name'))
                automation = _as_text(entry.get('automation'))
                if name == app_name and automation is not None:
                    pointer = (
                        f'{elements_path}/{idx}/{_json_pointer_escape("automation")}'
                    )
                    return pointer, automation
        for key, value in node.items():
            child_path = f'{path}/{_json_pointer_escape(str(key))}'
            found = _discover_automation_pointer(value, app_name=app_name, path=child_path)
            if found is not None:
                return found
        return None
    if isinstance(node, list):
        for idx, value in enumerate(node):
            child_path = f'{path}/{idx}'
            found = _discover_automation_pointer(value, app_name=app_name, path=child_path)
            if found is not None:
                return found
    return None


def _json_pointer_get(payload: Any, pointer: str) -> Any:
    if pointer == '':
        return payload
    current = payload
    for token in pointer.lstrip('/').split('/'):
        part = _json_pointer_unescape(token)
        if isinstance(current, list):
            index = _safe_int(part, default=-1)
            if index < 0 or index >= len(current):
                raise RuntimeError(f'invalid_json_pointer:{pointer}')
            current = current[index]
            continue
        if isinstance(current, Mapping):
            if part not in current:
                raise RuntimeError(f'invalid_json_pointer:{pointer}')
            current = current[part]
            continue
        raise RuntimeError(f'invalid_json_pointer:{pointer}')
    return current


def _normalized_automation_mode(value: str | None) -> str:
    normalized = (value or '').strip().lower()
    if normalized not in {'manual', 'auto'}:
        raise RuntimeError(f'unsupported_automation_mode:{value}')
    return normalized


def _read_argocd_automation_mode(
    *,
    config: ArgocdAutomationConfig,
) -> dict[str, Any]:
    payload = _kubectl_json_global(
        [
            '-n',
            config.applicationset_namespace,
            'get',
            'applicationset',
            config.applicationset_name,
            '-o',
            'json',
        ]
    )
    discovered = _discover_automation_pointer(payload, app_name=config.app_name)
    if discovered is None:
        raise RuntimeError(
            'argocd_automation_path_not_found '
            f'applicationset={config.applicationset_name} app={config.app_name}'
        )
    pointer, automation = discovered
    mode = _normalized_automation_mode(automation)
    return {
        'pointer': pointer,
        'mode': mode,
    }


def _set_argocd_automation_mode(
    *,
    config: ArgocdAutomationConfig,
    desired_mode: str,
) -> dict[str, Any]:
    normalized_desired = _normalized_automation_mode(desired_mode)
    state = _read_argocd_automation_mode(config=config)
    pointer = str(state['pointer'])
    current_mode = _normalized_automation_mode(_as_text(state.get('mode')))
    changed = current_mode != normalized_desired
    if changed:
        _kubectl_patch_json(
            config.applicationset_namespace,
            'applicationset',
            config.applicationset_name,
            [
                {
                    'op': 'replace',
                    'path': pointer,
                    'value': normalized_desired,
                }
            ],
        )

    started = datetime.now(timezone.utc)
    deadline = started + timedelta(seconds=config.verify_timeout_seconds)
    verified_mode = current_mode
    while True:
        verified_state = _read_argocd_automation_mode(config=config)
        pointer_observed = str(verified_state['pointer'])
        if pointer_observed != pointer:
            raise RuntimeError(
                'argocd_automation_pointer_changed '
                f'expected={pointer} observed={pointer_observed}'
            )
        verified_mode = _normalized_automation_mode(_as_text(verified_state.get('mode')))
        if verified_mode == normalized_desired:
            break
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(
                'argocd_automation_verify_timeout '
                f'desired={normalized_desired} observed={verified_mode}'
            )
        time.sleep(2)

    return {
        'pointer': pointer,
        'previous_mode': current_mode,
        'desired_mode': normalized_desired,
        'current_mode': verified_mode,
        'changed': changed,
    }


def _kservice_env(service: Mapping[str, Any]) -> tuple[str, list[dict[str, Any]]]:
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
    env_raw = container.get('env')
    env: list[dict[str, Any]] = []
    if isinstance(env_raw, list):
        for item in env_raw:
            if isinstance(item, Mapping):
                env.append(_as_mapping(item))
    return container_name, env


def _kservice_container_with_env(
    service: Mapping[str, Any],
    env_entries: list[dict[str, Any]],
) -> dict[str, Any]:
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
    updated = dict(container)
    updated['env'] = list(env_entries)
    return updated


def _merge_env_entries(
    env: list[dict[str, Any]],
    updates: Mapping[str, Any],
) -> list[dict[str, Any]]:
    merged = [dict(item) for item in env]
    index_by_name = {
        _as_text(item.get('name')): idx
        for idx, item in enumerate(merged)
        if _as_text(item.get('name'))
    }
    for key, raw_value in updates.items():
        if raw_value is None:
            existing_idx = index_by_name.get(key)
            if existing_idx is not None:
                merged.pop(existing_idx)
                index_by_name = {
                    _as_text(item.get('name')): idx
                    for idx, item in enumerate(merged)
                    if _as_text(item.get('name'))
                }
            continue
        if isinstance(raw_value, Mapping):
            entry = {'name': key, **_as_mapping(raw_value)}
        else:
            entry = {'name': key, 'value': str(raw_value)}
        existing_idx = index_by_name.get(key)
        if existing_idx is None:
            merged.append(entry)
            index_by_name[key] = len(merged) - 1
        else:
            merged[existing_idx] = entry
    return merged


def _recommended_simulation_feature_staleness_ms(
    manifest: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> int | None:
    window = _as_mapping(manifest.get('window'))
    window_start_raw = _as_text(window.get('start'))
    if window_start_raw is None:
        return None

    try:
        window_start = _parse_rfc3339_timestamp(window_start_raw, label='window.start')
    except SystemExit:
        return None

    reference_now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age_ms = max(0, int((reference_now - window_start).total_seconds() * 1000))
    return max(
        SIMULATION_FEATURE_STALENESS_MIN_MS,
        age_ms + SIMULATION_FEATURE_STALENESS_MARGIN_MS,
    )


def _torghut_env_overrides_from_manifest(
    manifest: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> dict[str, str]:
    overrides_raw = _as_mapping(manifest.get('torghut_env_overrides'))
    overrides: dict[str, str] = {}
    for key, raw_value in overrides_raw.items():
        env_key = str(key).strip()
        if env_key not in SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST:
            raise RuntimeError(
                f'disallowed_torghut_env_override:{env_key} '
                f'allowed={",".join(sorted(SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST))}'
            )
        value = _as_text(raw_value)
        if value is None:
            raise RuntimeError(f'invalid_torghut_env_override_value:{env_key}')
        overrides[env_key] = value

    if 'TRADING_FEATURE_MAX_STALENESS_MS' not in overrides:
        recommended = _recommended_simulation_feature_staleness_ms(
            manifest,
            now=now,
        )
        if recommended is not None:
            overrides['TRADING_FEATURE_MAX_STALENESS_MS'] = str(recommended)
    return overrides


def _state_paths(resources: SimulationResources) -> tuple[Path, Path, Path]:
    run_dir = resources.output_root / resources.run_token
    state_path = run_dir / 'state.json'
    run_manifest_path = run_dir / 'run-manifest.json'
    dump_path = run_dir / 'source-dump.ndjson'
    return state_path, run_manifest_path, dump_path


def _run_state_path(resources: SimulationResources) -> Path:
    run_dir = resources.output_root / resources.run_token
    return run_dir / 'run-state.json'


def _update_run_state(
    *,
    resources: SimulationResources,
    phase: str,
    status: str,
    details: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    state_path = _run_state_path(resources)
    state = _load_optional_json(state_path) or {
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'run_token': resources.run_token,
        'history': [],
    }
    history_raw = state.get('history')
    if not isinstance(history_raw, list):
        history: list[dict[str, Any]] = []
    else:
        history = [
            _as_mapping(item)
            for item in history_raw
            if isinstance(item, Mapping)
        ]
    event = {
        'phase': phase,
        'status': status,
        'at': datetime.now(timezone.utc).isoformat(),
    }
    if details:
        event['details'] = dict(details)
    history.append(event)
    state['history'] = history
    state['last_phase'] = phase
    state['last_status'] = status
    state['updated_at'] = event['at']
    _save_json(state_path, state)
    print(
        'RUN_STATE '
        + json.dumps(
            {
                'at': event['at'],
                'phase': phase,
                'status': status,
                'details': event.get('details', {}),
            },
            sort_keys=True,
        ),
        flush=True,
    )
    return state


def _log_script_event(message: str, **fields: Any) -> None:
    if fields:
        payload = ' '.join(f'{key}={value!r}' for key, value in fields.items())
        print(f'RUN_LOG {message} {payload}', file=sys.stderr, flush=True)
    else:
        print(f'RUN_LOG {message}', file=sys.stderr, flush=True)


def _ensure_directory(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _save_json(path: Path, payload: Mapping[str, Any]) -> None:
    _ensure_directory(path)
    path.write_text(json.dumps(dict(payload), indent=2, sort_keys=True), encoding='utf-8')


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f'expected file is missing: {path}')
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise SystemExit(f'file must contain a JSON object: {path}')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _load_optional_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None
    if not isinstance(payload, Mapping):
        return None
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _dump_marker_path(dump_path: Path) -> Path:
    return dump_path.with_suffix('.dump-marker.json')


def _parse_dump_timestamp_bounds(payload: Mapping[str, Any]) -> tuple[int, int] | None:
    min_raw = payload.get('min_source_timestamp_ms')
    max_raw = payload.get('max_source_timestamp_ms')
    if min_raw is None or max_raw is None:
        return None
    min_ms = _safe_int(min_raw, default=-1)
    max_ms = _safe_int(max_raw, default=-1)
    if min_ms < 0 or max_ms < min_ms:
        return None
    return min_ms, max_ms


def _scan_dump_timestamp_bounds(dump_path: Path) -> tuple[int | None, int | None]:
    min_ms: int | None = None
    max_ms: int | None = None
    with dump_path.open('r', encoding='utf-8') as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
            except Exception:
                continue
            if not isinstance(payload, Mapping):
                continue
            source_timestamp_ms = _safe_int(payload.get('source_timestamp_ms'), default=-1)
            if source_timestamp_ms < 0:
                continue
            if min_ms is None or source_timestamp_ms < min_ms:
                min_ms = source_timestamp_ms
            if max_ms is None or source_timestamp_ms > max_ms:
                max_ms = source_timestamp_ms
    return min_ms, max_ms


def _reusable_dump_report(dump_path: Path) -> dict[str, Any] | None:
    if not dump_path.exists():
        return None
    marker_path = _dump_marker_path(dump_path)
    marker = _load_optional_json(marker_path)
    if marker is None:
        return None

    expected_sha = _as_text(marker.get('dump_sha256'))
    raw_expected_records = marker.get('records')
    if expected_sha is None or raw_expected_records is None:
        return None
    try:
        expected_records = int(raw_expected_records)
    except (TypeError, ValueError):
        return None

    actual_sha = _file_sha256(dump_path)
    actual_records = _count_lines(dump_path)
    if expected_sha != actual_sha or expected_records != actual_records:
        return None
    timestamp_bounds = _parse_dump_timestamp_bounds(marker)
    if timestamp_bounds is None:
        min_ms, max_ms = _scan_dump_timestamp_bounds(dump_path)
        timestamp_bounds = (
            (min_ms, max_ms)
            if min_ms is not None and max_ms is not None
            else None
        )
        if timestamp_bounds is not None:
            marker_with_bounds = dict(marker)
            marker_with_bounds['min_source_timestamp_ms'] = timestamp_bounds[0]
            marker_with_bounds['max_source_timestamp_ms'] = timestamp_bounds[1]
            _save_json(marker_path, marker_with_bounds)
    min_source_timestamp_ms = timestamp_bounds[0] if timestamp_bounds is not None else None
    max_source_timestamp_ms = timestamp_bounds[1] if timestamp_bounds is not None else None
    return {
        'path': str(dump_path),
        'records': actual_records,
        'sha256': actual_sha,
        'reused_existing_dump': True,
        'min_source_timestamp_ms': min_source_timestamp_ms,
        'max_source_timestamp_ms': max_source_timestamp_ms,
    }


def _build_plan_report(
    *,
    resources: SimulationResources,
    kafka_config: KafkaRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    postgres_config: PostgresRuntimeConfig,
    argocd_config: ArgocdAutomationConfig,
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    state_path, run_manifest_path, dump_path = _state_paths(resources)
    run_state_path = _run_state_path(resources)
    window = _as_mapping(manifest.get('window'))
    torghut_env_overrides = _torghut_env_overrides_from_manifest(manifest)
    window_policy = _validate_window_policy(manifest)
    return {
        'status': 'ok',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'resources': {
            'namespace': resources.namespace,
            'ta_configmap': resources.ta_configmap,
            'ta_deployment': resources.ta_deployment,
            'torghut_service': resources.torghut_service,
            'source_topics': resources.source_topic_by_role,
            'simulation_topics': resources.simulation_topic_by_role,
            'replay_topic_by_source_topic': resources.replay_topic_by_source_topic,
            'ta_group_id': resources.ta_group_id,
            'order_feed_group_id': resources.order_feed_group_id,
            'clickhouse_database': resources.clickhouse_db,
            'clickhouse_signal_table': resources.clickhouse_signal_table,
            'clickhouse_price_table': resources.clickhouse_price_table,
            'postgres_database': postgres_config.simulation_db,
            'postgres_simulation_dsn': _redact_dsn_credentials(postgres_config.simulation_dsn),
            'postgres_runtime_simulation_dsn': _redact_dsn_credentials(postgres_config.torghut_runtime_dsn),
        },
        'window': {
            'start': _as_text(window.get('start')),
            'end': _as_text(window.get('end')),
            'policy': window_policy,
        },
        'torghut_env_overrides': torghut_env_overrides,
        'kafka': {
            'bootstrap_servers': kafka_config.bootstrap_servers,
            'runtime_bootstrap_servers': kafka_config.runtime_bootstrap,
            'security_protocol': kafka_config.security_protocol,
            'runtime_security_protocol': kafka_config.runtime_security,
            'runtime_sasl_mechanism': kafka_config.runtime_sasl,
            'runtime_sasl_username': kafka_config.runtime_username,
        },
        'clickhouse': {
            'http_url': clickhouse_config.http_url,
            'username': clickhouse_config.username,
        },
        'argocd': asdict(argocd_config),
        'artifacts': {
            'state_path': str(state_path),
            'run_manifest_path': str(run_manifest_path),
            'dump_path': str(dump_path),
            'run_state_path': str(run_state_path),
        },
        'confirmation_phrase': APPLY_CONFIRMATION_PHRASE,
    }


def _http_clickhouse_query(
    *,
    config: ClickHouseRuntimeConfig,
    query: str,
) -> tuple[int, str]:
    request_url = config.http_url
    parsed = urlsplit(request_url)
    scheme = parsed.scheme.lower()
    if scheme not in {'http', 'https'}:
        raise RuntimeError(f'unsupported_clickhouse_scheme:{scheme or "missing"}')
    if not parsed.hostname:
        raise RuntimeError('invalid_clickhouse_host')

    headers = {'Content-Type': 'text/plain'}
    if config.username:
        headers['X-ClickHouse-User'] = config.username
    if config.password:
        headers['X-ClickHouse-Key'] = config.password

    path = parsed.path or '/'
    if parsed.query:
        path = f'{path}?{parsed.query}'
    connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port)
    try:
        connection.request('POST', path, body=query.encode('utf-8'), headers=headers)
        response = connection.getresponse()
        body = response.read().decode('utf-8', errors='replace').strip()
        return response.status, body
    finally:
        connection.close()


def _ensure_clickhouse_database(
    *,
    config: ClickHouseRuntimeConfig,
    database: str,
) -> None:
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', database):
        raise RuntimeError(f'invalid_clickhouse_database_name:{database}')
    create_query = f'CREATE DATABASE IF NOT EXISTS {database}'
    status, body = _http_clickhouse_query(config=config, query=create_query)
    if status < 200 or status >= 300:
        raise RuntimeError(f'clickhouse_create_database_failed:{status}:{body[:200]}')


def _ensure_postgres_database(config: PostgresRuntimeConfig) -> None:
    simulation_role = _username_from_dsn(config.torghut_runtime_dsn) or _username_from_dsn(config.simulation_dsn)

    def _ensure() -> None:
        with psycopg.connect(config.admin_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT 1 FROM pg_database WHERE datname = %s', (config.simulation_db,))
                exists = cursor.fetchone() is not None
                if not exists:
                    if simulation_role:
                        cursor.execute(
                            sql.SQL('CREATE DATABASE {} OWNER {}').format(
                                sql.Identifier(config.simulation_db),
                                sql.Identifier(simulation_role),
                            )
                        )
                    else:
                        cursor.execute(
                            sql.SQL('CREATE DATABASE {}').format(
                                sql.Identifier(config.simulation_db)
                            )
                        )

    _run_with_transient_postgres_retry(
        label='ensure_postgres_database',
        operation=_ensure,
    )


def _ensure_postgres_runtime_permissions(config: PostgresRuntimeConfig) -> dict[str, Any]:
    simulation_role = _username_from_dsn(config.torghut_runtime_dsn) or _username_from_dsn(config.simulation_dsn)
    admin_simulation_dsn = _replace_database_in_dsn(
        config.admin_dsn,
        database=config.simulation_db,
        label='manifest.postgres.admin_dsn',
    )

    def _ensure() -> dict[str, Any]:
        grants_applied = False
        with psycopg.connect(config.admin_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                if simulation_role:
                    cursor.execute(
                        sql.SQL('GRANT ALL PRIVILEGES ON DATABASE {} TO {}').format(
                            sql.Identifier(config.simulation_db),
                            sql.Identifier(simulation_role),
                        )
                    )
                    grants_applied = True

        with psycopg.connect(admin_simulation_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                has_vector_extension = _postgres_extension_exists(cursor, VECTOR_EXTENSION_NAME)
                if not has_vector_extension:
                    try:
                        cursor.execute(
                            sql.SQL('CREATE EXTENSION IF NOT EXISTS {}').format(
                                sql.Identifier(VECTOR_EXTENSION_NAME)
                            )
                        )
                        has_vector_extension = True
                    except Exception as exc:
                        if _is_vector_extension_create_permission_error(exc):
                            if _postgres_extension_exists(cursor, VECTOR_EXTENSION_NAME):
                                has_vector_extension = True
                            else:
                                has_vector_extension = False
                        else:
                            raise
                if simulation_role:
                    cursor.execute(
                        sql.SQL('GRANT USAGE, CREATE ON SCHEMA public TO {}').format(
                            sql.Identifier(simulation_role),
                        )
                    )
                    cursor.execute(
                        sql.SQL('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO {}').format(
                            sql.Identifier(simulation_role),
                        )
                    )
                    cursor.execute(
                        sql.SQL('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO {}').format(
                            sql.Identifier(simulation_role),
                        )
                    )
                    grants_applied = True
        return {
            'simulation_role': simulation_role,
            'grants_applied': grants_applied,
            'vector_extension_checked': has_vector_extension,
        }

    return cast(
        dict[str, Any],
        _run_with_transient_postgres_retry(
            label='ensure_postgres_runtime_permissions',
            operation=_ensure,
        ),
    )


def _run_migrations(config: PostgresRuntimeConfig) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    env = dict(os.environ)
    env['DB_DSN'] = config.torghut_runtime_dsn

    def _run(command: str) -> None:
        _run_command(
            shlex.split(command),
            cwd=repo_root,
            env=env,
        )

    migration_error: Exception | None = None

    try:
        _run_with_transient_postgres_retry(
            label='run_migrations',
            operation=lambda: _run(config.migrations_command),
        )
        return
    except RuntimeError as exc:
        if not _is_vector_extension_create_permission_error(exc):
            raise
        migration_error = exc

    fallback_revision = _find_vector_extension_blocking_revision(repo_root)
    if fallback_revision is None:
        raise RuntimeError(
            'run_migrations_fallback_not_applicable: vector extension permission error occurred but '
            'a migration target for a pre-vector revision could not be discovered'
        ) from migration_error

    fallback_command = _replace_alembic_upgrade_target(
        command=config.migrations_command,
        target=fallback_revision,
    )
    if fallback_command is None:
        raise RuntimeError(
            f'run_migrations_fallback_target_parse_failed: command={config.migrations_command} target={fallback_revision}'
        ) from migration_error

    _run_with_transient_postgres_retry(
        label='run_migrations_fallback_pre_vector',
        operation=lambda: _run(fallback_command),
    )


def _capture_cluster_state(resources: SimulationResources) -> dict[str, Any]:
    ta_config = _kubectl_json(
        resources.namespace,
        ['get', 'configmap', resources.ta_configmap, '-o', 'json'],
    )
    ta_data = _as_mapping(ta_config.get('data'))

    ta_deployment = _kubectl_json(
        resources.namespace,
        ['get', 'flinkdeployment', resources.ta_deployment, '-o', 'json'],
    )
    deployment_spec = _as_mapping(ta_deployment.get('spec'))
    deployment_job = _as_mapping(deployment_spec.get('job'))

    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    _container_name, env_entries = _kservice_env(service)
    env_by_name = {
        _as_text(entry.get('name')): entry
        for entry in env_entries
        if _as_text(entry.get('name'))
    }

    return {
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'ta_data': ta_data,
        'ta_restart_nonce': int(deployment_spec.get('restartNonce') or 0),
        'ta_job_state': _as_text(deployment_job.get('state')),
        'torghut_env_snapshot': {
            key: env_by_name.get(key)
            for key in TORGHUT_ENV_KEYS
        },
    }


def _replace_clickhouse_jdbc_database(raw_url: str, new_database: str) -> str:
    match = re.match(r'^(jdbc:clickhouse://[^/]+/)([^?]+)(.*)$', raw_url.strip())
    if match is None:
        raise RuntimeError(f'invalid_clickhouse_jdbc_url:{raw_url}')
    return f'{match.group(1)}{new_database}{match.group(3)}'


def _configure_ta_for_simulation(
    *,
    resources: SimulationResources,
    ta_data: Mapping[str, Any],
    clickhouse_database: str,
    auto_offset_reset: str,
) -> None:
    updates: dict[str, str] = {
        'TA_GROUP_ID': resources.ta_group_id,
        'TA_AUTO_OFFSET_RESET': auto_offset_reset,
    }

    for role, key in TA_TOPIC_KEY_BY_ROLE.items():
        topic = resources.simulation_topic_by_role.get(role)
        if not topic:
            continue
        updates[key] = topic

    existing_jdbc = _as_text(ta_data.get('TA_CLICKHOUSE_URL'))
    if existing_jdbc:
        updates['TA_CLICKHOUSE_URL'] = _replace_clickhouse_jdbc_database(
            existing_jdbc,
            clickhouse_database,
        )

    _kubectl_patch(
        resources.namespace,
        'configmap',
        resources.ta_configmap,
        {'data': updates},
    )


def _restart_ta_deployment(resources: SimulationResources, *, desired_state: str) -> int:
    deployment = _kubectl_json(
        resources.namespace,
        ['get', 'flinkdeployment', resources.ta_deployment, '-o', 'json'],
    )
    spec = _as_mapping(deployment.get('spec'))
    current_state = _as_text(_as_mapping(spec.get('job')).get('state')) or 'running'
    restart_nonce = int(spec.get('restartNonce') or 0)

    if current_state != 'suspended':
        _kubectl_patch(
            resources.namespace,
            'flinkdeployment',
            resources.ta_deployment,
            {'spec': {'job': {'state': 'suspended'}}},
        )
    next_nonce = restart_nonce + 1
    _kubectl_patch(
        resources.namespace,
        'flinkdeployment',
        resources.ta_deployment,
        {
            'spec': {
                'restartNonce': next_nonce,
                'job': {'state': desired_state},
            }
        },
    )
    return next_nonce


def _configure_torghut_service_for_simulation(
    *,
    resources: SimulationResources,
    postgres_config: PostgresRuntimeConfig,
    kafka_config: KafkaRuntimeConfig,
    torghut_env_overrides: Mapping[str, Any] | None = None,
) -> None:
    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    _, current_env = _kservice_env(service)

    updates = {
        'DB_DSN': postgres_config.torghut_runtime_dsn,
        'TRADING_MODE': 'paper',
        'TRADING_LIVE_ENABLED': 'false',
        'TRADING_FEATURE_FLAGS_ENABLED': 'false',
        'TRADING_SIGNAL_TABLE': resources.clickhouse_signal_table,
        'TRADING_PRICE_TABLE': resources.clickhouse_price_table,
        'TRADING_ORDER_FEED_ENABLED': 'true',
        'TRADING_ORDER_FEED_BOOTSTRAP_SERVERS': kafka_config.runtime_bootstrap,
        'TRADING_ORDER_FEED_SECURITY_PROTOCOL': kafka_config.runtime_security,
        'TRADING_ORDER_FEED_SASL_MECHANISM': kafka_config.runtime_sasl,
        'TRADING_ORDER_FEED_SASL_USERNAME': kafka_config.runtime_username,
        'TRADING_ORDER_FEED_SASL_PASSWORD': kafka_config.runtime_password,
        'TRADING_ORDER_FEED_TOPIC': resources.simulation_topic_by_role['order_updates'],
        'TRADING_ORDER_FEED_TOPIC_V2': '',
        'TRADING_ORDER_FEED_GROUP_ID': resources.order_feed_group_id,
        'TRADING_EXECUTION_ADAPTER': 'simulation',
        'TRADING_EXECUTION_FALLBACK_ADAPTER': 'none',
        'TRADING_SIMULATION_ENABLED': 'true',
        'TRADING_SIMULATION_RUN_ID': resources.run_id,
        'TRADING_SIMULATION_DATASET_ID': resources.dataset_id,
        'TRADING_SIMULATION_ORDER_UPDATES_TOPIC': resources.simulation_topic_by_role['order_updates'],
        'TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS': kafka_config.runtime_bootstrap,
        'TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL': kafka_config.runtime_security,
        'TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM': kafka_config.runtime_sasl,
        'TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME': kafka_config.runtime_username,
        'TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD': kafka_config.runtime_password,
    }
    if torghut_env_overrides:
        for key, value in torghut_env_overrides.items():
            updates[str(key)] = str(value)
    merged_env = _merge_env_entries(current_env, updates)
    patched_container = _kservice_container_with_env(service, merged_env)
    _kubectl_patch(
        resources.namespace,
        'kservice',
        resources.torghut_service,
        {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [patched_container]
                    }
                }
            }
        },
    )


def _restore_ta_configuration(resources: SimulationResources, state: Mapping[str, Any]) -> None:
    ta_data = _as_mapping(state.get('ta_data'))
    existing = _kubectl_json(
        resources.namespace,
        ['get', 'configmap', resources.ta_configmap, '-o', 'json'],
    )
    existing_data = _as_mapping(existing.get('data'))
    patch_data: dict[str, Any] = dict(ta_data)
    for key in existing_data:
        if key not in ta_data:
            patch_data[key] = None
    _kubectl_patch(
        resources.namespace,
        'configmap',
        resources.ta_configmap,
        {'data': patch_data},
    )


def _restore_torghut_env(resources: SimulationResources, state: Mapping[str, Any]) -> None:
    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    _, current_env = _kservice_env(service)
    snapshot = _as_mapping(state.get('torghut_env_snapshot'))
    merged = list(current_env)
    for key in TORGHUT_ENV_KEYS:
        snapshot_entry = snapshot.get(key)
        if snapshot_entry is None:
            merged = _merge_env_entries(merged, {key: None})
            continue
        entry_map = _as_mapping(snapshot_entry)
        entry_map.pop('name', None)
        merged = _merge_env_entries(merged, {key: entry_map})

    patched_container = _kservice_container_with_env(service, merged)
    _kubectl_patch(
        resources.namespace,
        'kservice',
        resources.torghut_service,
        {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [patched_container]
                    }
                }
            }
        },
    )


def _kafka_admin_client(config: KafkaRuntimeConfig) -> Any:
    from kafka.admin import KafkaAdminClient  # type: ignore[import-not-found]

    kwargs = config.kafka_client_kwargs()
    kwargs['client_id'] = f'torghut-sim-admin-{int(time.time())}'
    return KafkaAdminClient(**kwargs)


def _source_topic_partition_counts(admin: Any, topics: Sequence[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    topic_descriptions = admin.describe_topics(list(topics))
    if not isinstance(topic_descriptions, list):
        return counts
    for item in topic_descriptions:
        if not isinstance(item, Mapping):
            continue
        topic = _as_text(item.get('topic'))
        partitions = item.get('partitions')
        if topic is None or not isinstance(partitions, list):
            continue
        counts[topic] = len(partitions)
    return counts


def _kafka_available_broker_count(admin: Any) -> int:
    try:
        cluster = getattr(admin, '_client').cluster
        brokers = cluster.brokers()
    except Exception:
        return 1
    try:
        return max(1, len(brokers))
    except Exception:
        return 1


def _ensure_topics(
    *,
    resources: SimulationResources,
    config: KafkaRuntimeConfig,
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    from kafka.admin import NewTopic  # type: ignore[import-not-found]

    kafka = _as_mapping(manifest.get('kafka'))
    default_partitions = int(kafka.get('default_partitions') or 6)
    replication_factor = int(kafka.get('replication_factor') or 1)
    max_partitions_per_topic = _safe_int(kafka.get('max_partitions_per_topic'), default=0)
    if max_partitions_per_topic < 0:
        raise RuntimeError('kafka.max_partitions_per_topic cannot be negative')

    admin = _kafka_admin_client(config)
    try:
        existing_topics = set(admin.list_topics())
        available_broker_count = _kafka_available_broker_count(admin)
        source_topics = list(resources.replay_topic_by_source_topic.keys())
        source_partition_counts = _source_topic_partition_counts(admin, source_topics)

        planned_topics = set(resources.simulation_topic_by_role.values())
        new_topics: list[Any] = []
        partition_caps: list[dict[str, int]] = []
        for topic in sorted(planned_topics):
            if topic in existing_topics:
                continue
            requested_partitions = default_partitions
            for source_topic, replay_topic in resources.replay_topic_by_source_topic.items():
                if replay_topic == topic:
                    requested_partitions = source_partition_counts.get(source_topic, default_partitions)
                    break
            partitions = min(
                max(requested_partitions, 1),
                available_broker_count,
            )
            if max_partitions_per_topic > 0:
                partitions = min(partitions, max_partitions_per_topic)
            if partitions < requested_partitions:
                partition_caps.append(
                    {
                        'topic': topic,
                        'requested_partitions': int(requested_partitions),
                        'applied_partitions': int(partitions),
                    }
                )
            new_topics.append(
                NewTopic(
                    name=topic,
                    num_partitions=max(partitions, 1),
                    replication_factor=max(replication_factor, 1),
                )
            )

        if new_topics:
            admin.create_topics(new_topics=new_topics, validate_only=False)
        return {
            'existing': sorted(existing_topics),
            'created': [topic.name for topic in new_topics],
            'available_brokers': available_broker_count,
            'partition_caps': partition_caps,
            'max_partitions_per_topic': max_partitions_per_topic if max_partitions_per_topic > 0 else None,
        }
    finally:
        admin.close()


def _consumer_for_dump(config: KafkaRuntimeConfig, run_token: str) -> Any:
    from kafka import KafkaConsumer  # type: ignore[import-not-found]

    kwargs = config.kafka_client_kwargs()
    kwargs.update(
        {
            'client_id': f'torghut-sim-dump-{run_token}',
            'enable_auto_commit': False,
            'auto_offset_reset': 'earliest',
            'consumer_timeout_ms': 1000,
            'value_deserializer': None,
            'key_deserializer': None,
        }
    )
    return KafkaConsumer(**kwargs)


def _producer_for_replay(config: KafkaRuntimeConfig, run_token: str) -> Any:
    from kafka import KafkaProducer  # type: ignore[import-not-found]

    kwargs = config.kafka_runtime_client_kwargs()
    kwargs.update(
        {
            'client_id': f'torghut-sim-replay-{run_token}',
            'acks': 'all',
            'retries': 3,
            'linger_ms': 5,
            'value_serializer': None,
            'key_serializer': None,
        }
    )
    return KafkaProducer(**kwargs)


def _bytes_to_b64(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return base64.b64encode(value).decode('ascii')
    if isinstance(value, bytearray):
        return base64.b64encode(bytes(value)).decode('ascii')
    return base64.b64encode(str(value).encode('utf-8')).decode('ascii')


def _b64_to_bytes(value: Any) -> bytes | None:
    if value is None:
        return None
    return base64.b64decode(str(value).encode('ascii'))


def _headers_to_json(value: Any) -> list[list[str | None]]:
    if not isinstance(value, list):
        return []
    headers: list[list[str | None]] = []
    for item in value:
        if not isinstance(item, tuple) or len(item) != 2:
            continue
        key = _as_text(item[0])
        if key is None:
            continue
        encoded = _bytes_to_b64(item[1])
        headers.append([key, encoded])
    return headers


def _json_to_headers(value: Any) -> list[tuple[str, bytes]]:
    if not isinstance(value, list):
        return []
    headers: list[tuple[str, bytes]] = []
    for item in value:
        if not isinstance(item, list) or len(item) != 2:
            continue
        key = _as_text(item[0])
        payload_b64 = item[1]
        if key is None or payload_b64 is None:
            continue
        headers.append((key, _b64_to_bytes(payload_b64) or b''))
    return headers


def _offset_for_time_lookup(*, metadata: Any, fallback: int) -> int:
    if metadata is None:
        return fallback
    raw_offset = getattr(metadata, 'offset', None)
    try:
        offset = int(raw_offset)
    except (TypeError, ValueError):
        return fallback
    if offset < 0:
        return fallback
    return offset


def _dump_topics(
    *,
    resources: SimulationResources,
    kafka_config: KafkaRuntimeConfig,
    manifest: Mapping[str, Any],
    dump_path: Path,
    force: bool,
) -> dict[str, Any]:
    if not force:
        reusable_report = _reusable_dump_report(dump_path)
        if reusable_report is not None:
            return reusable_report

    window = _as_mapping(manifest.get('window'))
    start = _parse_rfc3339_timestamp(_as_text(window.get('start')), label='window.start')
    end = _parse_rfc3339_timestamp(_as_text(window.get('end')), label='window.end')
    if end <= start:
        raise RuntimeError('window.end must be after window.start')

    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    from kafka import TopicPartition  # type: ignore[import-not-found]

    consumer = _consumer_for_dump(kafka_config, resources.run_token)
    hasher = hashlib.sha256()
    count = 0
    count_by_topic: dict[str, int] = {}
    min_source_timestamp_ms: int | None = None
    max_source_timestamp_ms: int | None = None
    try:
        topic_partitions: list[Any] = []
        for topic in resources.replay_topic_by_source_topic.keys():
            partitions = consumer.partitions_for_topic(topic)
            if not partitions:
                raise RuntimeError(f'source topic has no partitions or does not exist: {topic}')
            for partition in sorted(partitions):
                topic_partitions.append(TopicPartition(topic, int(partition)))

        consumer.assign(topic_partitions)
        beginning_offsets = consumer.beginning_offsets(topic_partitions)
        end_offsets = consumer.end_offsets(topic_partitions)
        start_offsets_raw = consumer.offsets_for_times(
            {tp: start_ms for tp in topic_partitions}
        )
        stop_offsets_raw = consumer.offsets_for_times(
            {tp: end_ms + 1 for tp in topic_partitions}
        )

        start_offsets: dict[Any, int] = {}
        stop_offsets: dict[Any, int] = {}
        for tp in topic_partitions:
            start_meta = start_offsets_raw.get(tp)
            stop_meta = stop_offsets_raw.get(tp)
            partition_beginning = int(beginning_offsets[tp])
            partition_end = int(end_offsets[tp])
            start_offset = _offset_for_time_lookup(
                metadata=start_meta,
                fallback=partition_end,
            )
            stop_offset = _offset_for_time_lookup(
                metadata=stop_meta,
                fallback=partition_end,
            )
            start_offsets[tp] = min(max(start_offset, partition_beginning), partition_end)
            stop_offsets[tp] = min(max(stop_offset, start_offsets[tp]), partition_end)
            consumer.seek(tp, start_offsets[tp])

        _ensure_directory(dump_path)
        done: set[Any] = set()
        with dump_path.open('w', encoding='utf-8') as handle:
            idle_polls = 0
            while len(done) < len(topic_partitions):
                polled = consumer.poll(timeout_ms=1000, max_records=2000)
                if not polled:
                    idle_polls += 1
                    for tp in topic_partitions:
                        if tp in done:
                            continue
                        if consumer.position(tp) >= stop_offsets[tp]:
                            done.add(tp)
                    if idle_polls > 4 and all(
                        consumer.position(tp) >= stop_offsets[tp]
                        for tp in topic_partitions
                    ):
                        break
                    continue

                idle_polls = 0
                for tp, records in polled.items():
                    stop_offset = stop_offsets.get(tp)
                    if stop_offset is None:
                        continue
                    for record in records:
                        if int(record.offset) >= stop_offset:
                            done.add(tp)
                            break
                        source_topic = str(record.topic)
                        replay_topic = resources.replay_topic_by_source_topic[source_topic]
                        line_payload = {
                            'source_topic': source_topic,
                            'source_partition': int(record.partition),
                            'source_offset': int(record.offset),
                            'source_timestamp_ms': int(record.timestamp),
                            'dataset_event_id': f'{source_topic}:{record.partition}:{record.offset}',
                            'replay_topic': replay_topic,
                            'key_b64': _bytes_to_b64(record.key),
                            'value_b64': _bytes_to_b64(record.value),
                            'headers': _headers_to_json(getattr(record, 'headers', [])),
                        }
                        line = json.dumps(line_payload, sort_keys=True)
                        handle.write(line)
                        handle.write('\n')
                        hasher.update(line.encode('utf-8'))
                        hasher.update(b'\n')
                        count += 1
                        count_by_topic[source_topic] = count_by_topic.get(source_topic, 0) + 1
                        source_timestamp_ms = int(record.timestamp)
                        if min_source_timestamp_ms is None or source_timestamp_ms < min_source_timestamp_ms:
                            min_source_timestamp_ms = source_timestamp_ms
                        if max_source_timestamp_ms is None or source_timestamp_ms > max_source_timestamp_ms:
                            max_source_timestamp_ms = source_timestamp_ms
                    if consumer.position(tp) >= stop_offset:
                        done.add(tp)

        report = {
            'path': str(dump_path),
            'records': count,
            'sha256': hasher.hexdigest(),
            'records_by_topic': count_by_topic,
            'start': start.isoformat(),
            'end': end.isoformat(),
            'reused_existing_dump': False,
            'min_source_timestamp_ms': min_source_timestamp_ms,
            'max_source_timestamp_ms': max_source_timestamp_ms,
        }
        _save_json(
            _dump_marker_path(dump_path),
            {
                'completed_at': datetime.now(timezone.utc).isoformat(),
                'dump_sha256': report['sha256'],
                'records': report['records'],
                'min_source_timestamp_ms': report['min_source_timestamp_ms'],
                'max_source_timestamp_ms': report['max_source_timestamp_ms'],
            },
        )
        return report
    finally:
        consumer.close()


def _pacing_delay_seconds(
    *,
    mode: str,
    previous_timestamp_ms: int | None,
    current_timestamp_ms: int | None,
    acceleration: float,
) -> float:
    if mode == 'max_throughput':
        return 0.0
    if previous_timestamp_ms is None or current_timestamp_ms is None:
        return 0.0
    delta_ms = current_timestamp_ms - previous_timestamp_ms
    if delta_ms <= 0:
        return 0.0
    if mode == 'event_time':
        return delta_ms / 1000.0
    if mode == 'accelerated':
        return (delta_ms / 1000.0) / max(acceleration, 0.0001)
    raise RuntimeError(f'unsupported replay pace mode: {mode}')


def _count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open('r', encoding='utf-8') as handle:
        return sum(1 for _ in handle)


def _dump_sha256_for_replay(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('r', encoding='utf-8') as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            hasher.update(stripped.encode('utf-8'))
            hasher.update(b'\n')
    return hasher.hexdigest()


def _producer_flush_with_retry(
    producer: Any,
    *,
    timeout_seconds: float,
    attempts: int,
) -> None:
    for attempt in range(1, attempts + 1):
        try:
            producer.flush(timeout=timeout_seconds)
            return
        except Exception as exc:
            message = str(exc)
            timed_out = 'KafkaTimeoutError' in message or 'Timeout waiting for future' in message
            if not timed_out or attempt >= attempts:
                raise
            time.sleep(min(2.0, 0.25 * attempt))


def _replay_dump(
    *,
    resources: SimulationResources,
    kafka_config: KafkaRuntimeConfig,
    manifest: Mapping[str, Any],
    dump_path: Path,
    force: bool,
) -> dict[str, Any]:
    if not dump_path.exists():
        raise RuntimeError(f'dump file does not exist: {dump_path}')

    marker_path = dump_path.with_suffix('.replay-marker.json')
    if marker_path.exists() and not force:
        marker_payload = _load_json(marker_path)
        marker_dump_sha = _as_text(marker_payload.get('dump_sha256'))
        current_dump_sha = _dump_sha256_for_replay(dump_path)
        if marker_dump_sha == current_dump_sha:
            marker_payload['reused_existing_replay'] = True
            return marker_payload

    replay_cfg = _as_mapping(manifest.get('replay'))
    pace_mode = (_as_text(replay_cfg.get('pace_mode')) or 'max_throughput').lower()
    acceleration = float(replay_cfg.get('acceleration') or 60.0)
    max_sleep_seconds = float(replay_cfg.get('max_sleep_seconds') or 5.0)
    status_update_every_records = max(
        1,
        _safe_int(replay_cfg.get('status_update_every_records'), default=25_000),
    )
    status_update_every_seconds = max(
        1.0,
        _safe_float(replay_cfg.get('status_update_every_seconds'), default=30.0),
    )
    flush_every_records = max(1, _safe_int(replay_cfg.get('flush_every_records'), default=10_000))
    flush_timeout_seconds = max(1.0, _safe_float(replay_cfg.get('flush_timeout_seconds'), default=30.0))
    final_flush_timeout_seconds = max(
        flush_timeout_seconds,
        _safe_float(replay_cfg.get('final_flush_timeout_seconds'), default=300.0),
    )
    flush_retry_attempts = max(1, _safe_int(replay_cfg.get('flush_retry_attempts'), default=6))

    producer = _producer_for_replay(kafka_config, resources.run_token)
    count = 0
    count_by_topic: dict[str, int] = {}
    previous_ts_ms: int | None = None
    checksum = hashlib.sha256()
    replay_topic_overrides = 0
    next_status_update_at = time.monotonic() + status_update_every_seconds
    try:
        with dump_path.open('r', encoding='utf-8') as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                checksum.update(stripped.encode('utf-8'))
                checksum.update(b'\n')

                payload = json.loads(stripped)
                if not isinstance(payload, Mapping):
                    continue
                row = _as_mapping(payload)
                source_topic = _as_text(row.get('source_topic'))
                mapped_replay_topic = (
                    resources.replay_topic_by_source_topic.get(source_topic)
                    if source_topic is not None
                    else None
                )
                dump_replay_topic = _as_text(row.get('replay_topic'))
                replay_topic = mapped_replay_topic or dump_replay_topic
                if replay_topic is None:
                    raise RuntimeError('dump row is missing replay_topic and cannot infer mapping')
                if (
                    mapped_replay_topic is not None
                    and dump_replay_topic is not None
                    and mapped_replay_topic != dump_replay_topic
                ):
                    replay_topic_overrides += 1

                current_ts_ms = cast(int | None, row.get('source_timestamp_ms'))
                delay = _pacing_delay_seconds(
                    mode=pace_mode,
                    previous_timestamp_ms=previous_ts_ms,
                    current_timestamp_ms=current_ts_ms,
                    acceleration=acceleration,
                )
                if delay > 0:
                    time.sleep(min(delay, max_sleep_seconds))

                key = _b64_to_bytes(row.get('key_b64'))
                value = _b64_to_bytes(row.get('value_b64'))
                headers = _json_to_headers(row.get('headers'))
                producer.send(
                    replay_topic,
                    key=key,
                    value=value,
                    headers=headers,
                    timestamp_ms=current_ts_ms,
                )
                count += 1
                count_by_topic[replay_topic] = count_by_topic.get(replay_topic, 0) + 1
                previous_ts_ms = current_ts_ms
                now = time.monotonic()
                if (
                    count % status_update_every_records == 0
                    or now >= next_status_update_at
                ):
                    _update_run_state(
                        resources=resources,
                        phase='apply',
                        status='running',
                        details={
                            'subphase': 'replay',
                            'records': count,
                            'records_by_topic': count_by_topic,
                        },
                    )
                    next_status_update_at = now + status_update_every_seconds
                if count % flush_every_records == 0:
                    _producer_flush_with_retry(
                        producer,
                        timeout_seconds=flush_timeout_seconds,
                        attempts=flush_retry_attempts,
                    )
        _update_run_state(
            resources=resources,
            phase='apply',
            status='running',
            details={
                'subphase': 'replay',
                'records': count,
                'records_by_topic': count_by_topic,
                'flush_reason': 'completed',
            },
        )
        _producer_flush_with_retry(
            producer,
            timeout_seconds=final_flush_timeout_seconds,
            attempts=flush_retry_attempts,
        )
    finally:
        try:
            producer.close(timeout=max(10.0, flush_timeout_seconds))
        except Exception:
            pass

    marker_payload = {
        'reused_existing_replay': False,
        'records': count,
        'records_by_topic': count_by_topic,
        'pace_mode': pace_mode,
        'acceleration': acceleration,
        'flush_every_records': flush_every_records,
        'flush_timeout_seconds': flush_timeout_seconds,
        'final_flush_timeout_seconds': final_flush_timeout_seconds,
        'flush_retry_attempts': flush_retry_attempts,
        'replay_topic_overrides': replay_topic_overrides,
        'dump_sha256': checksum.hexdigest(),
        'completed_at': datetime.now(timezone.utc).isoformat(),
    }
    _save_json(marker_path, marker_payload)
    return marker_payload


def _verify_isolation_guards(
    *,
    resources: SimulationResources,
    postgres_config: PostgresRuntimeConfig,
    ta_data: Mapping[str, Any],
) -> dict[str, bool]:
    source_topics = {topic for topic in resources.source_topic_by_role.values() if topic}
    simulation_topics = {topic for topic in resources.simulation_topic_by_role.values() if topic}
    replay_source_topics = {topic for topic in resources.replay_topic_by_source_topic.keys() if topic}
    replay_target_topics = {topic for topic in resources.replay_topic_by_source_topic.values() if topic}
    production_topics = {topic for topic in PRODUCTION_TOPIC_BY_ROLE.values() if topic}

    checks = {
        'clickhouse_db_isolated': resources.clickhouse_db != 'torghut',
        'postgres_db_isolated': postgres_config.simulation_db != 'torghut',
        'simulation_topics_isolated_from_sources': simulation_topics.isdisjoint(source_topics),
        'replay_targets_isolated_from_replay_sources': replay_target_topics.isdisjoint(replay_source_topics),
        'simulation_topics_not_production_defaults': simulation_topics.isdisjoint(production_topics),
        'ta_group_isolated': resources.ta_group_id != _as_text(ta_data.get('TA_GROUP_ID')),
    }
    if not all(checks.values()):
        failed = [key for key, passed in checks.items() if not passed]
        raise RuntimeError(f'isolation_guard_failed:{",".join(failed)}')
    return checks


def _apply(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    kafka_config: KafkaRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    postgres_config: PostgresRuntimeConfig,
    force_dump: bool,
    force_replay: bool,
) -> dict[str, Any]:
    _ensure_supported_binary('kubectl')
    _ensure_lz4_codec_available()
    window_policy = _validate_window_policy(manifest)
    torghut_env_overrides = _torghut_env_overrides_from_manifest(manifest)

    state_path, run_manifest_path, dump_path = _state_paths(resources)
    _ensure_directory(state_path)

    if state_path.exists():
        state = _load_json(state_path)
    else:
        state = _capture_cluster_state(resources)
        _save_json(state_path, state)

    ta_data = _as_mapping(state.get('ta_data'))
    _verify_isolation_guards(
        resources=resources,
        postgres_config=postgres_config,
        ta_data=ta_data,
    )

    topics_report = _ensure_topics(
        resources=resources,
        config=kafka_config,
        manifest=manifest,
    )
    _ensure_clickhouse_database(config=clickhouse_config, database=resources.clickhouse_db)
    _ensure_postgres_database(postgres_config)
    postgres_permissions_report = _ensure_postgres_runtime_permissions(postgres_config)
    _run_migrations(postgres_config)

    dump_report = _dump_topics(
        resources=resources,
        kafka_config=kafka_config,
        manifest=manifest,
        dump_path=dump_path,
        force=force_dump,
    )
    dump_coverage = _validate_dump_coverage(
        manifest=manifest,
        dump_report=dump_report,
    )
    replay_report = _replay_dump(
        resources=resources,
        kafka_config=kafka_config,
        manifest=manifest,
        dump_path=dump_path,
        force=force_replay,
    )

    replay_cfg = _as_mapping(manifest.get('replay'))
    auto_offset_reset = (_as_text(replay_cfg.get('auto_offset_reset')) or 'earliest').lower()
    _configure_ta_for_simulation(
        resources=resources,
        ta_data=ta_data,
        clickhouse_database=resources.clickhouse_db,
        auto_offset_reset=auto_offset_reset,
    )
    ta_restart_nonce = _restart_ta_deployment(resources, desired_state='running')

    _configure_torghut_service_for_simulation(
        resources=resources,
        postgres_config=postgres_config,
        kafka_config=kafka_config,
        torghut_env_overrides=torghut_env_overrides,
    )

    report = {
        'status': 'ok',
        'mode': 'apply',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'applied_at': datetime.now(timezone.utc).isoformat(),
        'state_path': str(state_path),
        'dump': dump_report,
        'dump_coverage': dump_coverage,
        'replay': replay_report,
        'topics': topics_report,
        'ta_restart_nonce': ta_restart_nonce,
        'resources': asdict(resources)
        | {
            'output_root': str(resources.output_root),
        },
        'postgres': {
            'simulation_dsn': _redact_dsn_credentials(postgres_config.simulation_dsn),
            'simulation_db': postgres_config.simulation_db,
            'runtime_permissions': postgres_permissions_report,
        },
        'clickhouse': {
            'http_url': clickhouse_config.http_url,
            'database': resources.clickhouse_db,
        },
        'torghut_env_overrides': torghut_env_overrides,
        'window_policy': window_policy,
    }
    _save_json(run_manifest_path, report)
    return report


def _teardown(
    *,
    resources: SimulationResources,
    allow_missing_state: bool,
) -> dict[str, Any]:
    _ensure_supported_binary('kubectl')
    state_path, run_manifest_path, dump_path = _state_paths(resources)
    if not state_path.exists():
        if allow_missing_state:
            return {
                'status': 'ok',
                'mode': 'teardown',
                'run_id': resources.run_id,
                'teardown_at': datetime.now(timezone.utc).isoformat(),
                'state_found': False,
            }
        raise SystemExit(f'state file not found: {state_path}')

    state = _load_json(state_path)
    _restore_ta_configuration(resources, state)
    _restore_torghut_env(resources, state)

    original_state = _as_text(state.get('ta_job_state')) or 'running'
    ta_restart_nonce = _restart_ta_deployment(resources, desired_state=original_state)
    report = {
        'status': 'ok',
        'mode': 'teardown',
        'run_id': resources.run_id,
        'teardown_at': datetime.now(timezone.utc).isoformat(),
        'state_path': str(state_path),
        'run_manifest_path': str(run_manifest_path),
        'dump_path': str(dump_path),
        'ta_restart_nonce': ta_restart_nonce,
        'restored_ta_state': original_state,
    }
    _save_json(run_manifest_path.with_name('teardown-manifest.json'), report)
    return report


def _monitor_settings(manifest: Mapping[str, Any]) -> dict[str, int]:
    monitor = _as_mapping(manifest.get('monitor'))
    timeout_seconds = _safe_int(
        monitor.get('timeout_seconds'),
        default=DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS,
    )
    poll_seconds = _safe_int(
        monitor.get('poll_seconds'),
        default=DEFAULT_RUN_MONITOR_POLL_SECONDS,
    )
    min_decisions = _safe_int(
        monitor.get('min_trade_decisions'),
        default=DEFAULT_RUN_MONITOR_MIN_DECISIONS,
    )
    min_executions = _safe_int(
        monitor.get('min_executions'),
        default=DEFAULT_RUN_MONITOR_MIN_EXECUTIONS,
    )
    min_tca = _safe_int(
        monitor.get('min_execution_tca_metrics'),
        default=DEFAULT_RUN_MONITOR_MIN_TCA,
    )
    min_order_events = _safe_int(
        monitor.get('min_execution_order_events'),
        default=DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
    )
    cursor_grace_seconds = _safe_int(
        monitor.get('cursor_grace_seconds'),
        default=DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
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
        'timeout_seconds': timeout_seconds,
        'poll_seconds': poll_seconds,
        'min_trade_decisions': min_decisions,
        'min_executions': min_executions,
        'min_execution_tca_metrics': min_tca,
        'min_execution_order_events': min_order_events,
        'cursor_grace_seconds': cursor_grace_seconds,
    }


def _monitor_snapshot(postgres_config: PostgresRuntimeConfig) -> dict[str, Any]:
    def _snapshot() -> dict[str, Any]:
        with psycopg.connect(postgres_config.torghut_runtime_dsn) as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT count(*) FROM trade_decisions')
                decision_row = cursor.fetchone()
                trade_decisions = _safe_int(decision_row[0] if decision_row else 0)
                cursor.execute('SELECT count(*) FROM executions')
                execution_row = cursor.fetchone()
                executions = _safe_int(execution_row[0] if execution_row else 0)
                cursor.execute('SELECT count(*) FROM execution_tca_metrics')
                tca_row = cursor.fetchone()
                execution_tca_metrics = _safe_int(tca_row[0] if tca_row else 0)
                cursor.execute('SELECT count(*) FROM execution_order_events')
                order_event_row = cursor.fetchone()
                execution_order_events = _safe_int(order_event_row[0] if order_event_row else 0)
                cursor.execute(
                    "SELECT max(cursor_at) FROM trade_cursor WHERE source='clickhouse'"
                )
                row = cursor.fetchone()
                cursor_at_raw = row[0] if row else None
                cursor_at = (
                    cursor_at_raw.astimezone(timezone.utc)
                    if isinstance(cursor_at_raw, datetime)
                    else None
                )
        return {
            'trade_decisions': trade_decisions,
            'executions': executions,
            'execution_tca_metrics': execution_tca_metrics,
            'execution_order_events': execution_order_events,
            'cursor_at': cursor_at.isoformat() if cursor_at is not None else None,
        }

    return cast(
        dict[str, Any],
        _run_with_transient_postgres_retry(
            label='monitor_snapshot',
            operation=_snapshot,
        ),
    )


def _monitor_run_completion(
    *,
    manifest: Mapping[str, Any],
    postgres_config: PostgresRuntimeConfig,
) -> dict[str, Any]:
    start, end = _resolve_window_bounds(manifest)
    settings = _monitor_settings(manifest)
    deadline = datetime.now(timezone.utc) + timedelta(seconds=settings['timeout_seconds'])
    polls: list[dict[str, Any]] = []
    cursor_reached_at: datetime | None = None
    while True:
        snapshot = _monitor_snapshot(postgres_config)
        polled_at = datetime.now(timezone.utc)
        poll_payload = {
            'polled_at': polled_at.isoformat(),
            **snapshot,
        }
        polls.append(poll_payload)
        cursor_at_raw = snapshot.get('cursor_at')
        cursor_at = (
            _parse_rfc3339_timestamp(cast(str | None, cursor_at_raw), label='cursor_at')
            if isinstance(cursor_at_raw, str)
            else None
        )
        cursor_reached = cursor_at is not None and cursor_at >= end
        thresholds_met = (
            _safe_int(snapshot.get('trade_decisions')) >= settings['min_trade_decisions']
            and _safe_int(snapshot.get('executions')) >= settings['min_executions']
            and _safe_int(snapshot.get('execution_tca_metrics'))
            >= settings['min_execution_tca_metrics']
            and _safe_int(snapshot.get('execution_order_events'))
            >= settings['min_execution_order_events']
        )
        executions = _safe_int(snapshot.get('executions'))
        order_events = _safe_int(snapshot.get('execution_order_events'))
        order_event_contract_met = executions <= 0 or order_events > 0
        completion_ready = thresholds_met and order_event_contract_met

        if cursor_reached and cursor_reached_at is None:
            cursor_reached_at = polled_at
        if cursor_reached and completion_ready:
            return {
                'status': 'ok',
                'window_start': start.isoformat(),
                'window_end': end.isoformat(),
                'monitor': settings,
                'poll_count': len(polls),
                'final_snapshot': poll_payload,
                'polls': polls[-20:],
            }
        if cursor_reached and cursor_reached_at is not None and not completion_ready:
            waited_seconds = int((polled_at - cursor_reached_at).total_seconds())
            if waited_seconds >= settings['cursor_grace_seconds']:
                raise RuntimeError(
                    'monitor_thresholds_not_met_after_cursor_reached '
                    f'waited_seconds={waited_seconds} '
                    f'trade_decisions={snapshot.get("trade_decisions")} '
                    f'executions={snapshot.get("executions")} '
                    f'execution_tca_metrics={snapshot.get("execution_tca_metrics")} '
                    f'execution_order_events={snapshot.get("execution_order_events")}'
                )

        if polled_at >= deadline:
            raise RuntimeError(
                'monitor_timeout '
                f'trade_decisions={snapshot.get("trade_decisions")} '
                f'executions={snapshot.get("executions")} '
                f'execution_tca_metrics={snapshot.get("execution_tca_metrics")} '
                f'execution_order_events={snapshot.get("execution_order_events")} '
                f'cursor_at={snapshot.get("cursor_at")}'
            )
        time.sleep(settings['poll_seconds'])


def _prepare_argocd_for_run(
    *,
    config: ArgocdAutomationConfig,
) -> dict[str, Any]:
    if not config.manage_automation:
        return {
            'managed': False,
            'changed': False,
            'current_mode': None,
            'previous_mode': None,
        }
    patch_report = _set_argocd_automation_mode(
        config=config,
        desired_mode=config.desired_mode_during_run,
    )
    return {
        'managed': True,
        **patch_report,
    }


def _restore_argocd_after_run(
    *,
    config: ArgocdAutomationConfig,
    previous_mode: str | None,
) -> dict[str, Any]:
    if not config.manage_automation:
        return {
            'managed': False,
            'changed': False,
            'restored_mode': None,
        }
    restore_mode = config.restore_mode_after_run
    if restore_mode == 'previous':
        target_mode = previous_mode or 'auto'
    else:
        target_mode = restore_mode
    report = _set_argocd_automation_mode(
        config=config,
        desired_mode=target_mode,
    )
    return {
        'managed': True,
        'restored_mode': target_mode,
        **report,
    }


def _report_simulation(
    *,
    resources: SimulationResources,
    manifest_path: Path,
    postgres_config: PostgresRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
) -> dict[str, Any]:
    script_path = Path(__file__).resolve().with_name('analyze_historical_simulation.py')
    if not script_path.exists():
        raise RuntimeError(f'report_script_missing:{script_path}')
    report_dir = resources.output_root / resources.run_token / 'report'
    report_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(script_path),
        '--run-id',
        resources.run_id,
        '--dataset-manifest',
        str(manifest_path),
        '--simulation-dsn',
        postgres_config.torghut_runtime_dsn,
        '--output-dir',
        str(report_dir),
        '--json',
    ]
    if clickhouse_config.http_url:
        command.extend(['--clickhouse-http-url', clickhouse_config.http_url])
    if clickhouse_config.username:
        command.extend(['--clickhouse-username', clickhouse_config.username])
    if clickhouse_config.password:
        command.extend(['--clickhouse-password', clickhouse_config.password])

    result = cast(
        subprocess.CompletedProcess[str],
        _run_with_transient_postgres_retry(
            label='report_simulation',
            operation=lambda: _run_command(command),
        ),
    )
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError('simulation report output must be a JSON object')
    report = {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}
    report['report_dir'] = str(report_dir)
    return report


def _run_full_lifecycle(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    manifest_path: Path,
    kafka_config: KafkaRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    postgres_config: PostgresRuntimeConfig,
    argocd_config: ArgocdAutomationConfig,
    force_dump: bool,
    force_replay: bool,
    skip_teardown: bool,
    report_only: bool,
) -> dict[str, Any]:
    _ensure_supported_binary('kubectl')
    _validate_window_policy(manifest)
    _update_run_state(resources=resources, phase='preflight', status='ok')

    argocd_prepare_report: dict[str, Any] | None = None
    argocd_restore_report: dict[str, Any] | None = None
    apply_report: dict[str, Any] | None = None
    monitor_report: dict[str, Any] | None = None
    analytics_report: dict[str, Any] | None = None
    teardown_report: dict[str, Any] | None = None
    errors: list[str] = []
    previous_automation_mode: str | None = None
    argocd_prepare_succeeded = False
    argocd_restore_required = False

    try:
        if report_only:
            argocd_prepare_report = {
                'managed': False,
                'changed': False,
                'reason': 'report_only',
            }
            _update_run_state(
                resources=resources,
                phase='argocd_prepare',
                status='skipped',
                details=argocd_prepare_report,
            )
        else:
            _update_run_state(resources=resources, phase='argocd_prepare', status='running')
            if argocd_config.manage_automation:
                current_state = _read_argocd_automation_mode(config=argocd_config)
                previous_automation_mode = _normalized_automation_mode(
                    _as_text(current_state.get('mode'))
                )
                argocd_restore_required = (
                    previous_automation_mode != _normalized_automation_mode(argocd_config.desired_mode_during_run)
                )
            argocd_prepare_report = _prepare_argocd_for_run(config=argocd_config)
            if previous_automation_mode is None:
                previous_automation_mode = _as_text(argocd_prepare_report.get('previous_mode'))
            argocd_prepare_succeeded = True
            _update_run_state(
                resources=resources,
                phase='argocd_prepare',
                status='ok',
                details=argocd_prepare_report,
            )

        if not report_only:
            _update_run_state(resources=resources, phase='apply', status='running')
            apply_report = _apply(
                resources=resources,
                manifest=manifest,
                kafka_config=kafka_config,
                clickhouse_config=clickhouse_config,
                postgres_config=postgres_config,
                force_dump=force_dump,
                force_replay=force_replay,
            )
            _update_run_state(resources=resources, phase='apply', status='ok')

            _update_run_state(resources=resources, phase='monitor', status='running')
            monitor_report = _monitor_run_completion(
                manifest=manifest,
                postgres_config=postgres_config,
            )
            _update_run_state(resources=resources, phase='monitor', status='ok')
        else:
            _update_run_state(
                resources=resources,
                phase='apply',
                status='skipped',
                details={'report_only': True},
            )
            _update_run_state(
                resources=resources,
                phase='monitor',
                status='skipped',
                details={'report_only': True},
            )

        _update_run_state(resources=resources, phase='report', status='running')
        analytics_report = _report_simulation(
            resources=resources,
            manifest_path=manifest_path,
            postgres_config=postgres_config,
            clickhouse_config=clickhouse_config,
        )
        _update_run_state(resources=resources, phase='report', status='ok')
    except Exception as exc:
        errors.append(str(exc))
        _update_run_state(
            resources=resources,
            phase='run',
            status='error',
            details={'error': str(exc)},
        )
    finally:
        if not skip_teardown:
            try:
                _update_run_state(resources=resources, phase='teardown', status='running')
                teardown_report = _teardown(
                    resources=resources,
                    allow_missing_state=True,
                )
                _update_run_state(resources=resources, phase='teardown', status='ok')
            except Exception as exc:
                errors.append(f'teardown:{exc}')
                _update_run_state(
                    resources=resources,
                    phase='teardown',
                    status='error',
                    details={'error': str(exc)},
                )
        else:
            _update_run_state(
                resources=resources,
                phase='teardown',
                status='skipped',
                details={'skip_teardown': True},
            )

        if report_only:
            argocd_restore_report = {
                'managed': False,
                'changed': False,
                'reason': 'report_only',
            }
            _update_run_state(
                resources=resources,
                phase='argocd_restore',
                status='skipped',
                details=argocd_restore_report,
            )
        elif not argocd_prepare_succeeded and not argocd_restore_required:
            argocd_restore_report = {
                'managed': False,
                'changed': False,
                'reason': 'argocd_prepare_failed',
            }
            _update_run_state(
                resources=resources,
                phase='argocd_restore',
                status='skipped',
                details=argocd_restore_report,
            )
        else:
            try:
                _update_run_state(resources=resources, phase='argocd_restore', status='running')
                argocd_restore_report = _restore_argocd_after_run(
                    config=argocd_config,
                    previous_mode=previous_automation_mode,
                )
                _update_run_state(resources=resources, phase='argocd_restore', status='ok')
            except Exception as exc:
                errors.append(f'argocd_restore:{exc}')
                _update_run_state(
                    resources=resources,
                    phase='argocd_restore',
                    status='error',
                    details={'error': str(exc)},
                )

    report = {
        'status': 'ok' if not errors else 'error',
        'mode': 'run',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'completed_at': datetime.now(timezone.utc).isoformat(),
        'argocd_prepare': argocd_prepare_report,
        'argocd_restore': argocd_restore_report,
        'apply': apply_report,
        'monitor': monitor_report,
        'report': analytics_report,
        'teardown': teardown_report,
        'errors': errors,
    }
    run_manifest_path = _state_paths(resources)[1]
    _save_json(run_manifest_path.with_name('run-full-lifecycle-manifest.json'), report)
    if errors:
        raise RuntimeError('simulation_run_failed:' + '; '.join(errors))
    return report


def _render_report(payload: Mapping[str, Any], *, json_only: bool) -> None:
    if json_only:
        print(json.dumps(dict(payload), sort_keys=True, separators=(',', ':')))
        return
    print(json.dumps(dict(payload), indent=2, sort_keys=True))


def main() -> None:
    args = _parse_args()
    manifest_path = Path(args.dataset_manifest)
    _log_script_event(
        'starting_simulation',
        mode=args.mode,
        run_id=args.run_id,
        dataset_manifest=str(manifest_path),
        json_output=bool(args.json),
        confirm_phrase_provided=bool(args.confirm),
    )
    manifest = _load_manifest(manifest_path)
    window = _as_mapping(manifest.get('window'))
    _log_script_event(
        'manifest_loaded',
        dataset_id=_as_text(manifest.get('dataset_id')) or 'missing',
        trading_day=_as_text(window.get('trading_day')),
        start=_as_text(window.get('start')),
        end=_as_text(window.get('end')),
        min_coverage_minutes=_as_text(window.get('min_coverage_minutes')),
        strict_coverage_ratio=window.get('strict_coverage_ratio'),
    )
    resources = _build_resources(args.run_id, manifest)
    _log_script_event(
        'resources_built',
        run_token=resources.run_token,
        dataset_id=resources.dataset_id,
        output_root=str(resources.output_root),
        namespace=resources.namespace,
        ta_configmap=resources.ta_configmap,
        ta_deployment=resources.ta_deployment,
    )
    kafka_config = _build_kafka_runtime_config(manifest)
    _log_script_event(
        'kafka_config_ready',
        bootstrap_servers=kafka_config.bootstrap_servers,
        runtime_bootstrap_servers=kafka_config.runtime_bootstrap,
        security_protocol=kafka_config.security_protocol,
        runtime_security_protocol=kafka_config.runtime_security,
        sasl_mechanism=kafka_config.sasl_mechanism,
        runtime_sasl_mechanism=kafka_config.runtime_sasl,
        runtime_username_present=bool(kafka_config.runtime_username),
        runtime_password_present=bool(kafka_config.runtime_password),
    )
    clickhouse_config = _build_clickhouse_runtime_config(manifest)
    _log_script_event(
        'clickhouse_config_ready',
        http_url=clickhouse_config.http_url,
        username=clickhouse_config.username or 'none',
        password_present=bool(clickhouse_config.password),
    )
    argocd_config = _build_argocd_automation_config(manifest)
    _log_script_event(
        'argocd_config_ready',
        manage_automation=argocd_config.manage_automation,
        applicationset_name=argocd_config.applicationset_name,
        app_name=argocd_config.app_name,
        desired_mode_during_run=argocd_config.desired_mode_during_run,
    )
    postgres_config = _build_postgres_runtime_config(
        manifest,
        simulation_db=f'torghut_sim_{resources.run_token}',
    )
    _log_script_event(
        'postgres_config_ready',
        admin_dsn=_redact_dsn_credentials(postgres_config.admin_dsn),
        simulation_dsn=_redact_dsn_credentials(postgres_config.simulation_dsn),
        simulation_db=postgres_config.simulation_db,
        migration_command=postgres_config.migrations_command,
    )

    plan_report = _build_plan_report(
        resources=resources,
        kafka_config=kafka_config,
        clickhouse_config=clickhouse_config,
        postgres_config=postgres_config,
        argocd_config=argocd_config,
        manifest=manifest,
    )

    if args.mode == 'plan':
        _log_script_event('plan_mode_start')
        _render_report(plan_report, json_only=args.json)
        return

    if args.mode == 'apply':
        _log_script_event('apply_mode_start')
        if args.confirm != APPLY_CONFIRMATION_PHRASE:
            raise SystemExit(
                f'--confirm must equal {APPLY_CONFIRMATION_PHRASE!r} when mode=apply'
            )
        report = _apply(
            resources=resources,
            manifest=manifest,
            kafka_config=kafka_config,
            clickhouse_config=clickhouse_config,
            postgres_config=postgres_config,
            force_dump=bool(args.force_dump),
            force_replay=bool(args.force_replay),
        )
        _render_report(report, json_only=args.json)
        return

    if args.mode == 'report':
        _log_script_event('report_mode_start')
        report = _report_simulation(
            resources=resources,
            manifest_path=manifest_path,
            postgres_config=postgres_config,
            clickhouse_config=clickhouse_config,
        )
        if not args.skip_teardown:
            teardown_report = _teardown(
                resources=resources,
                allow_missing_state=True,
            )
            report = dict(report)
            report['teardown'] = teardown_report
        _render_report(report, json_only=args.json)
        return

    if args.mode == 'run':
        _log_script_event('run_mode_start')
        if args.confirm != APPLY_CONFIRMATION_PHRASE:
            raise SystemExit(
                f'--confirm must equal {APPLY_CONFIRMATION_PHRASE!r} when mode=run'
            )
        report = _run_full_lifecycle(
            resources=resources,
            manifest=manifest,
            manifest_path=manifest_path,
            kafka_config=kafka_config,
            clickhouse_config=clickhouse_config,
            postgres_config=postgres_config,
            argocd_config=argocd_config,
            force_dump=bool(args.force_dump),
            force_replay=bool(args.force_replay),
            skip_teardown=bool(args.skip_teardown),
            report_only=bool(args.report_only),
        )
        _render_report(report, json_only=args.json)
        return

    report = _teardown(
        resources=resources,
        allow_missing_state=bool(args.allow_missing_state),
    )
    _render_report(report, json_only=args.json)


if __name__ == '__main__':
    main()
