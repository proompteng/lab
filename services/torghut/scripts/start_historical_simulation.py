#!/usr/bin/env python3
"""Single-entrypoint historical simulation workflow for Torghut."""

from __future__ import annotations

import argparse
import base64
import gzip
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
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, cast
from urllib.parse import quote, quote_plus, unquote_plus, urlsplit
from http.client import HTTPConnection, HTTPSConnection
from zoneinfo import ZoneInfo

import psycopg
from psycopg import sql
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import yaml
from app.db import SessionLocal  # noqa: F401 - imported for unit-test patch targets
from app.trading.completion import (
    DOC29_SIMULATION_FULL_DAY_GATE,
    DOC29_SIMULATION_SMOKE_GATE,
    TRACE_STATUS_BLOCKED,
    TRACE_STATUS_SATISFIED,
    build_completion_trace,
    persist_completion_trace,
)
from app.trading.evaluation import build_fill_price_error_budget_report_v1
from app.trading.simulation_progress import (
    COMPONENT_ARTIFACTS,
    COMPONENT_REPLAY,
    COMPONENT_TA,
    COMPONENT_TORGHUT,
)
from scripts import historical_simulation_verification as simulation_verification
from scripts.simulation_lane_contracts import (
    EQUITY_SIMULATION_LANE,
    simulation_clickhouse_table_names,
    simulation_lane_contract,
    simulation_lane_contract_for_manifest,
    simulation_schema_registry_subject_roles,
)

APPLY_CONFIRMATION_PHRASE = 'START_HISTORICAL_SIMULATION'
DEFAULT_NAMESPACE = 'torghut'
DEFAULT_TA_CONFIGMAP = 'torghut-ta-config'
DEFAULT_TA_DEPLOYMENT = 'torghut-ta'
DEFAULT_TORGHUT_SERVICE = 'torghut'
DEFAULT_SIM_TA_CONFIGMAP = 'torghut-ta-sim-config'
DEFAULT_SIM_TA_DEPLOYMENT = 'torghut-ta-sim'
DEFAULT_SIM_TORGHUT_SERVICE = 'torghut-sim'
DEFAULT_SIM_FORECAST_SERVICE = 'torghut-forecast-sim'
DEFAULT_OUTPUT_ROOT = Path('artifacts/torghut/simulations')

PRODUCTION_TOPIC_BY_ROLE = dict(EQUITY_SIMULATION_LANE.source_topic_by_role)
SIMULATION_TOPIC_BY_ROLE = dict(EQUITY_SIMULATION_LANE.simulation_topic_by_role)
TA_TOPIC_KEY_BY_ROLE = dict(EQUITY_SIMULATION_LANE.ta_topic_key_by_role)

TORGHUT_ENV_KEYS = [
    'DB_DSN',
    'TRADING_ENABLED',
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
    'TRADING_SIMULATION_CLOCK_MODE',
    'TRADING_SIMULATION_WINDOW_START',
    'TRADING_SIMULATION_WINDOW_END',
    'TRADING_SIMULATION_ORDER_UPDATES_TOPIC',
    'TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS',
    'TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL',
    'TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM',
    'TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME',
    'TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD',
    'TRADING_FORECAST_SERVICE_URL',
    'TRADING_FORECAST_ROUTER_PROVIDER_MODE',
    'TRADING_FORECAST_ROUTER_PROVIDER_URL',
]

SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST = frozenset(
    {
        'TRADING_FEATURE_QUALITY_ENABLED',
        'TRADING_FEATURE_MAX_REQUIRED_NULL_RATE',
        'TRADING_FEATURE_MAX_STALENESS_MS',
        'TRADING_FEATURE_MAX_DUPLICATE_RATIO',
        'TRADING_STRATEGY_RUNTIME_MODE',
        'TRADING_STRATEGY_SCHEDULER_ENABLED',
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
DEFAULT_WARM_LANE_SIMULATION_DATABASE = 'torghut_sim_default'
DEFAULT_SIMULATION_DUMP_FORMAT = 'jsonl.zst'
SUPPORTED_SIMULATION_DUMP_FORMATS = {
    'ndjson': '.ndjson',
    'jsonl.gz': '.jsonl.gz',
    'jsonl.zst': '.jsonl.zst',
}
DEFAULT_SIMULATION_REPLAY_PROFILE = 'smoke'
REPLAY_PROFILE_DEFAULTS: dict[str, dict[str, float | int | str]] = {
    'compact': {
        'producer_linger_ms': 5,
        'producer_batch_size': 524_288,
        'producer_buffer_memory': 67_108_864,
        'producer_compression_type': 'gzip',
        'status_update_every_records': 5_000,
        'status_update_every_seconds': 5.0,
        'flush_every_records': 5_000,
        'flush_timeout_seconds': 15.0,
        'final_flush_timeout_seconds': 60.0,
    },
    'smoke': {
        'producer_linger_ms': 5,
        'producer_batch_size': 1_048_576,
        'producer_buffer_memory': 134_217_728,
        'producer_compression_type': 'gzip',
        'status_update_every_records': 10_000,
        'status_update_every_seconds': 10.0,
        'flush_every_records': 10_000,
        'flush_timeout_seconds': 20.0,
        'final_flush_timeout_seconds': 90.0,
    },
    'hourly': {
        'producer_linger_ms': 10,
        'producer_batch_size': 1_048_576,
        'producer_buffer_memory': 268_435_456,
        'producer_compression_type': 'gzip',
        'status_update_every_records': 25_000,
        'status_update_every_seconds': 15.0,
        'flush_every_records': 25_000,
        'flush_timeout_seconds': 30.0,
        'final_flush_timeout_seconds': 120.0,
    },
    'full_day': {
        'producer_linger_ms': 20,
        'producer_batch_size': 2_097_152,
        'producer_buffer_memory': 536_870_912,
        'producer_compression_type': 'gzip',
        'status_update_every_records': 50_000,
        'status_update_every_seconds': 30.0,
        'flush_every_records': 50_000,
        'flush_timeout_seconds': 45.0,
        'final_flush_timeout_seconds': 180.0,
    },
}
LEGACY_SIMULATION_STRATEGY_TOKENS = ('legacy_macd_rsi',)
DEFAULT_ARGOCD_APPSET_NAME = 'product'
DEFAULT_ARGOCD_NAMESPACE = 'argocd'
DEFAULT_ARGOCD_APP_NAME = 'torghut'
DEFAULT_ARGOCD_ROOT_APP_NAME = 'root'
DEFAULT_ARGOCD_RUN_MODE = 'manual'
DEFAULT_ROLLOUTS_NAMESPACE = 'torghut'
DEFAULT_ROLLOUTS_RUNTIME_TEMPLATE = 'torghut-simulation-runtime-ready'
DEFAULT_ROLLOUTS_ACTIVITY_TEMPLATE = 'torghut-simulation-activity'
DEFAULT_ROLLOUTS_TEARDOWN_TEMPLATE = 'torghut-simulation-teardown-clean'
DEFAULT_ROLLOUTS_ARTIFACT_TEMPLATE = 'torghut-simulation-artifact-bundle'
DEFAULT_ROLLOUTS_VERIFY_TIMEOUT_SECONDS = 1800
DEFAULT_ROLLOUTS_VERIFY_POLL_SECONDS = 5
SIMULATION_RUNTIME_LOCK_NAME = 'torghut-historical-simulation-lock'
SIMULATION_CLICKHOUSE_SCHEMA_SOURCE_DATABASE = 'torghut'
SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_ATTEMPTS = 10
SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_SLEEP_SECONDS = 0.2
TRANSIENT_POSTGRES_ERROR_PATTERNS = (
    'connection refused',
    'connection reset by peer',
    'could not receive data from server',
    'server closed the connection unexpectedly',
    'connection to server at',
    'terminating connection due to administrator command',
    'timeout expired',
)
NON_TRANSIENT_POSTGRES_ERROR_PATTERNS = (
    'password authentication failed',
    'no pg_hba.conf entry',
    'role "',
    'database "',
    'permission denied',
    'must be superuser',
)
VECTOR_EXTENSION_NAME = 'vector'
POSTGRES_VECTOR_EXTENSION_PERMISSION_ERROR_MARKERS = (
    'permission denied to create extension',
    'must be superuser to create this extension',
)
TRANSIENT_POSTGRES_RETRY_ATTEMPTS = 8
TRANSIENT_POSTGRES_RETRY_SLEEP_SECONDS = 0.5
SIMULATION_POSTGRES_RUNTIME_RESET_TABLES = (
    'trade_cursor',
    'trade_decisions',
    'executions',
    'execution_tca_metrics',
    'execution_order_events',
)
KAFKA_API_VERSION = (4, 1, 1)
SCHEMA_REGISTRY_CONTENT_TYPE = 'application/vnd.schemaregistry.v1+json'
EMBEDDED_SCHEMA_REGISTRY_SCHEMA_BY_SUFFIX = {
    'docs/torghut/schemas/ta-bars-1s.avsc': (
        '{"type":"record","name":"TaBar1s","namespace":"torghut.ta","fields":['
        '{"name":"ingest_ts","type":"string"},'
        '{"name":"event_ts","type":"string"},'
        '{"name":"symbol","type":"string"},'
        '{"name":"seq","type":"long"},'
        '{"name":"is_final","type":["null","boolean"],"default":null},'
        '{"name":"source","type":["null","string"],"default":null},'
        '{"name":"window","type":["null",{"type":"record","name":"WindowBar1s","fields":['
        '{"name":"size","type":"string"},'
        '{"name":"step","type":["null","string"],"default":null},'
        '{"name":"start","type":["null","string"],"default":null},'
        '{"name":"end","type":["null","string"],"default":null}'
        ']}],"default":null},'
        '{"name":"o","type":"double"},'
        '{"name":"h","type":"double"},'
        '{"name":"l","type":"double"},'
        '{"name":"c","type":"double"},'
        '{"name":"v","type":"double"},'
        '{"name":"vwap","type":["null","double"],"default":null},'
        '{"name":"count","type":"long"},'
        '{"name":"version","type":["int","null"],"default":1}'
        ']}'
    ),
    'docs/torghut/schemas/ta-signals.avsc': (
        '{"type":"record","name":"TaSignal","namespace":"torghut.ta","fields":['
        '{"name":"ingest_ts","type":"string"},'
        '{"name":"event_ts","type":"string"},'
        '{"name":"symbol","type":"string"},'
        '{"name":"seq","type":"long"},'
        '{"name":"feature_schema_version","type":["null","string"],"default":null},'
        '{"name":"is_final","type":["null","boolean"],"default":null},'
        '{"name":"signal_quality_flag","type":["null","string"],"default":null},'
        '{"name":"source","type":["null","string"],"default":null},'
        '{"name":"window","type":["null",{"type":"record","name":"WindowSignal","fields":['
        '{"name":"size","type":"string"},'
        '{"name":"step","type":["null","string"],"default":null},'
        '{"name":"start","type":["null","string"],"default":null},'
        '{"name":"end","type":["null","string"],"default":null}'
        ']}],"default":null},'
        '{"name":"macd","type":["null",{"type":"record","name":"Macd","fields":['
        '{"name":"macd","type":"double"},'
        '{"name":"signal","type":"double"},'
        '{"name":"hist","type":"double"}'
        ']}],"default":null},'
        '{"name":"ema","type":["null",{"type":"record","name":"Ema","fields":['
        '{"name":"ema12","type":"double"},'
        '{"name":"ema26","type":"double"}'
        ']}],"default":null},'
        '{"name":"rsi14","type":["null","double"],"default":null},'
        '{"name":"boll","type":["null",{"type":"record","name":"Bollinger","fields":['
        '{"name":"mid","type":"double"},'
        '{"name":"upper","type":"double"},'
        '{"name":"lower","type":"double"}'
        ']}],"default":null},'
        '{"name":"vwap","type":["null",{"type":"record","name":"Vwap","fields":['
        '{"name":"session","type":"double"},'
        '{"name":"w5m","type":["null","double"],"default":null}'
        ']}],"default":null},'
        '{"name":"imbalance","type":["null",{"type":"record","name":"Imbalance","fields":['
        '{"name":"spread","type":"double"},'
        '{"name":"bid_px","type":"double"},'
        '{"name":"ask_px","type":"double"},'
        '{"name":"bid_sz","type":"double"},'
        '{"name":"ask_sz","type":"double"}'
        ']}],"default":null},'
        '{"name":"vol_realized","type":["null",{"type":"record","name":"RealizedVol","fields":['
        '{"name":"w60s","type":"double"}'
        ']}],"default":null},'
        '{"name":"microstructure_signal_v1","type":["null",{"type":"record","name":"MicrostructureSignalV1","fields":['
        '{"name":"schema_version","type":"string"},'
        '{"name":"symbol","type":"string"},'
        '{"name":"horizon","type":"string"},'
        '{"name":"direction_probabilities","type":{"type":"record","name":"DirectionProbabilities","fields":['
        '{"name":"up","type":"double"},'
        '{"name":"flat","type":"double"},'
        '{"name":"down","type":"double"}'
        ']}},'
        '{"name":"uncertainty_band","type":"string"},'
        '{"name":"expected_spread_impact_bps","type":"double"},'
        '{"name":"expected_slippage_bps","type":"double"},'
        '{"name":"feature_quality_status","type":"string"},'
        '{"name":"artifact","type":{"type":"record","name":"MicrostructureSignalArtifact","fields":['
        '{"name":"model_id","type":"string"},'
        '{"name":"feature_schema_version","type":"string"},'
        '{"name":"training_run_id","type":"string"}'
        ']}}'
        ']}],"default":null},'
        '{"name":"version","type":["int","null"],"default":1}'
        ']}'
    ),
}
KAFKA_HOST_SUFFIX_FALLBACKS = (
    '.kafka-kafka-brokers.kafka.svc.cluster.local',
    '.kafka-kafka-brokers.kafka.svc',
    '.kafka.svc.cluster.local',
    '.kafka.svc',
    '.svc.cluster.local',
    '.svc',
)
_ORIGINAL_GETADDRINFO = socket.getaddrinfo


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


def _kafka_host_candidates(host: str) -> list[str]:
    candidates = _cluster_service_host_candidates(host)
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
    lane: str
    target_mode: str
    namespace: str
    ta_configmap: str
    ta_deployment: str
    torghut_service: str
    torghut_forecast_service: str
    output_root: Path
    source_topic_by_role: dict[str, str]
    simulation_topic_by_role: dict[str, str]
    replay_topic_by_source_topic: dict[str, str]
    ta_group_id: str
    order_feed_group_id: str
    clickhouse_db: str
    clickhouse_table_by_role: dict[str, str]
    clickhouse_signal_table: str
    clickhouse_price_table: str
    warm_lane_enabled: bool = False


@dataclass(frozen=True)
class ArgocdAutomationConfig:
    manage_automation: bool
    applicationset_name: str
    applicationset_namespace: str
    app_name: str
    root_app_name: str
    desired_mode_during_run: str
    restore_mode_after_run: str
    verify_timeout_seconds: int


@dataclass(frozen=True)
class RolloutsAnalysisConfig:
    enabled: bool
    namespace: str
    runtime_template: str
    activity_template: str
    teardown_template: str
    artifact_template: str
    verify_timeout_seconds: int
    verify_poll_seconds: int


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


def _normalize_kubernetes_name_token(value: str) -> str:
    token = re.sub(r'[^a-z0-9]+', '-', value.strip().lower()).strip('-')
    token = re.sub(r'-+', '-', token)
    if not token:
        raise SystemExit('kubernetes name token must contain at least one alphanumeric character')
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


def _as_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := _as_text(item))]


def _simulation_evidence_lineage(manifest: Mapping[str, Any]) -> dict[str, Any]:
    return {
        'dataset_snapshot_ref': _as_text(manifest.get('dataset_snapshot_ref')),
        'candidate_id': _as_text(manifest.get('candidate_id')),
        'baseline_candidate_id': _as_text(manifest.get('baseline_candidate_id')),
        'strategy_spec_ref': _as_text(manifest.get('strategy_spec_ref')),
        'model_refs': _as_string_list(manifest.get('model_refs')),
        'runtime_version_refs': _as_string_list(manifest.get('runtime_version_refs')),
    }


def _experimental_allow_legacy_strategy(manifest: Mapping[str, Any]) -> bool:
    experimental = _as_mapping(manifest.get('experimental'))
    value = experimental.get('allowLegacyStrategy')
    if value is None:
        value = experimental.get('allow_legacy_strategy')
    normalized = (_as_text(value) or '').strip().lower()
    return normalized in {'1', 'true', 'yes', 'on'}


def _contains_legacy_strategy_reference(manifest: Mapping[str, Any]) -> bool:
    model_refs = _as_string_list(manifest.get('model_refs'))
    candidate_id = _as_text(manifest.get('candidate_id')) or ''
    baseline_candidate_id = _as_text(manifest.get('baseline_candidate_id')) or ''
    strategy_spec_ref = _as_text(manifest.get('strategy_spec_ref')) or ''
    values = [candidate_id, baseline_candidate_id, strategy_spec_ref, *model_refs]
    normalized_values = [value.strip().lower() for value in values if value.strip()]
    return any(
        token in value
        for token in LEGACY_SIMULATION_STRATEGY_TOKENS
        for value in normalized_values
    )


def _validate_simulation_strategy_policy(manifest: Mapping[str, Any]) -> None:
    if _contains_legacy_strategy_reference(manifest) and not _experimental_allow_legacy_strategy(manifest):
        raise RuntimeError(
            'legacy_strategy_not_allowed: set experimental.allowLegacyStrategy=true for non-promotable legacy replays'
        )


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
            normalized_tail = normalized[len('uv run --frozen alembic upgrade'):].lstrip()
            if normalized_tail:
                normalized = f'{uv_path} run --frozen {alembic_path} upgrade {normalized_tail}'
            else:
                normalized = f'{uv_path} run --frozen {alembic_path} upgrade'
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


def _ta_topic_key_by_role(*, lane: str, manifest: Mapping[str, Any]) -> dict[str, str]:
    lane_contract = simulation_lane_contract(lane)
    ta_config = _as_mapping(manifest.get('ta_config'))
    overrides = _as_mapping(ta_config.get('topic_key_by_role'))
    return _merge_topics(lane_contract.ta_topic_key_by_role, overrides)


def _ta_clickhouse_url_key(*, lane: str, manifest: Mapping[str, Any]) -> str:
    lane_contract = simulation_lane_contract(lane)
    ta_config = _as_mapping(manifest.get('ta_config'))
    return _as_text(ta_config.get('clickhouse_url_key')) or lane_contract.ta_clickhouse_url_key


def _ta_group_id_key(*, lane: str, manifest: Mapping[str, Any]) -> str:
    lane_contract = simulation_lane_contract(lane)
    ta_config = _as_mapping(manifest.get('ta_config'))
    return _as_text(ta_config.get('group_id_key')) or lane_contract.ta_group_id_key


def _ta_auto_offset_reset_key(*, lane: str, manifest: Mapping[str, Any]) -> str:
    lane_contract = simulation_lane_contract(lane)
    ta_config = _as_mapping(manifest.get('ta_config'))
    return (
        _as_text(ta_config.get('auto_offset_reset_key'))
        or lane_contract.ta_auto_offset_reset_key
    )


def _warm_lane_enabled(*, manifest: Mapping[str, Any], lane: str, target_mode: str) -> bool:
    runtime = _as_mapping(manifest.get('runtime'))
    explicit = runtime.get('use_warm_lane')
    if explicit is None:
        explicit = runtime.get('useWarmLane')
    return explicit is not None and str(explicit).strip().lower() in {'1', 'true', 'yes', 'on'}


def _default_simulation_postgres_db(resources: SimulationResources) -> str:
    if resources.warm_lane_enabled:
        return DEFAULT_WARM_LANE_SIMULATION_DATABASE
    return f'torghut_sim_{resources.run_token}'


def _build_resources(run_id: str, manifest: Mapping[str, Any]) -> SimulationResources:
    _validate_simulation_strategy_policy(manifest)
    lane_contract = simulation_lane_contract_for_manifest(manifest)
    run_token = _normalize_run_token(run_id)
    dataset_id = _as_text(manifest.get('dataset_id'))
    if not dataset_id:
        raise SystemExit('manifest.dataset_id is required')

    runtime = _as_mapping(manifest.get('runtime'))
    target_mode = (_as_text(runtime.get('target_mode')) or 'dedicated_service').strip().lower()
    if target_mode not in {'dedicated_service', 'in_place'}:
        raise RuntimeError('runtime.target_mode must be one of: dedicated_service,in_place')
    warm_lane = _warm_lane_enabled(
        manifest=manifest,
        lane=lane_contract.lane,
        target_mode=target_mode,
    )
    output_root_raw = _as_text(runtime.get('output_root'))
    if output_root_raw:
        output_root = Path(output_root_raw)
    elif lane_contract.lane != 'equity':
        output_root = DEFAULT_OUTPUT_ROOT / lane_contract.lane
    else:
        output_root = DEFAULT_OUTPUT_ROOT

    source_topics = _merge_topics(
        lane_contract.source_topic_by_role,
        _as_mapping(manifest.get('source_topics')),
    )
    simulation_topic_overrides = _as_mapping(manifest.get('simulation_topics'))
    simulation_topics = _merge_topics(
        lane_contract.simulation_topic_by_role,
        simulation_topic_overrides,
    )
    if not warm_lane:
        for role, topic in list(simulation_topics.items()):
            if role in simulation_topic_overrides:
                continue
            simulation_topics[role] = f'{topic}.{run_token}'

    replay_topic_by_source_topic = {
        source_topics[role]: simulation_topics[role]
        for role in lane_contract.replay_roles
    }

    clickhouse_cfg = _as_mapping(manifest.get('clickhouse'))
    clickhouse_db = (
        _as_text(clickhouse_cfg.get('simulation_database'))
        or (DEFAULT_WARM_LANE_SIMULATION_DATABASE if warm_lane else f'torghut_sim_{run_token}')
    )
    clickhouse_table_by_role = simulation_clickhouse_table_names(
        lane=lane_contract.lane,
        database=clickhouse_db,
    )
    clickhouse_signal_table = clickhouse_table_by_role[lane_contract.signal_table_role]
    clickhouse_price_table = clickhouse_table_by_role[lane_contract.price_table_role]

    default_ta_configmap = DEFAULT_SIM_TA_CONFIGMAP if target_mode == 'dedicated_service' else DEFAULT_TA_CONFIGMAP
    default_ta_deployment = DEFAULT_SIM_TA_DEPLOYMENT if target_mode == 'dedicated_service' else DEFAULT_TA_DEPLOYMENT
    default_torghut_service = (
        DEFAULT_SIM_TORGHUT_SERVICE if target_mode == 'dedicated_service' else DEFAULT_TORGHUT_SERVICE
    )
    default_forecast_service = (
        DEFAULT_SIM_FORECAST_SERVICE if target_mode == 'dedicated_service' else 'torghut-forecast'
    )
    ta_group_prefix = 'torghut-options-ta-sim' if lane_contract.lane == 'options' else 'torghut-ta-sim'
    order_feed_group_prefix = (
        'torghut-options-order-feed-sim'
        if lane_contract.lane == 'options'
        else 'torghut-order-feed-sim'
    )
    # Warm lanes reuse infrastructure, not consumer offsets. Each replay still needs
    # a fresh TA consumer group so the source stream is re-read deterministically.
    ta_group_id = f'{ta_group_prefix}-{run_token}'
    order_feed_group_id = (
        f'{order_feed_group_prefix}-default'
        if warm_lane
        else f'{order_feed_group_prefix}-{run_token}'
    )

    return SimulationResources(
        run_id=run_id,
        run_token=run_token,
        dataset_id=dataset_id,
        lane=lane_contract.lane,
        target_mode=target_mode,
        namespace=_as_text(runtime.get('namespace')) or DEFAULT_NAMESPACE,
        ta_configmap=_as_text(runtime.get('ta_configmap')) or default_ta_configmap,
        ta_deployment=_as_text(runtime.get('ta_deployment')) or default_ta_deployment,
        torghut_service=_as_text(runtime.get('torghut_service')) or default_torghut_service,
        torghut_forecast_service=(
            _as_text(runtime.get('torghut_forecast_service')) or default_forecast_service
        ),
        output_root=output_root,
        source_topic_by_role=source_topics,
        simulation_topic_by_role=simulation_topics,
        replay_topic_by_source_topic=replay_topic_by_source_topic,
        ta_group_id=ta_group_id,
        order_feed_group_id=order_feed_group_id,
        clickhouse_db=clickhouse_db,
        clickhouse_table_by_role=clickhouse_table_by_role,
        clickhouse_signal_table=clickhouse_signal_table,
        clickhouse_price_table=clickhouse_price_table,
        warm_lane_enabled=warm_lane,
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
        root_app_name=_as_text(argocd.get('root_app_name')) or DEFAULT_ARGOCD_ROOT_APP_NAME,
        desired_mode_during_run=desired_mode,
        restore_mode_after_run=restore_mode,
        verify_timeout_seconds=verify_timeout_seconds,
    )


def _build_rollouts_analysis_config(manifest: Mapping[str, Any]) -> RolloutsAnalysisConfig:
    rollouts = _as_mapping(manifest.get('rollouts'))
    enabled = str(rollouts.get('enabled', 'false')).strip().lower() in {
        '1',
        'true',
        'yes',
        'on',
    }
    verify_timeout_seconds = _safe_int(
        rollouts.get('verify_timeout_seconds'),
        default=DEFAULT_ROLLOUTS_VERIFY_TIMEOUT_SECONDS,
    )
    if verify_timeout_seconds <= 0:
        raise RuntimeError('rollouts.verify_timeout_seconds must be > 0')
    verify_poll_seconds = _safe_int(
        rollouts.get('verify_poll_seconds'),
        default=DEFAULT_ROLLOUTS_VERIFY_POLL_SECONDS,
    )
    if verify_poll_seconds <= 0:
        raise RuntimeError('rollouts.verify_poll_seconds must be > 0')
    return RolloutsAnalysisConfig(
        enabled=enabled,
        namespace=_as_text(rollouts.get('namespace')) or DEFAULT_ROLLOUTS_NAMESPACE,
        runtime_template=_as_text(rollouts.get('runtime_template')) or DEFAULT_ROLLOUTS_RUNTIME_TEMPLATE,
        activity_template=_as_text(rollouts.get('activity_template')) or DEFAULT_ROLLOUTS_ACTIVITY_TEMPLATE,
        teardown_template=_as_text(rollouts.get('teardown_template')) or DEFAULT_ROLLOUTS_TEARDOWN_TEMPLATE,
        artifact_template=_as_text(rollouts.get('artifact_template')) or DEFAULT_ROLLOUTS_ARTIFACT_TEMPLATE,
        verify_timeout_seconds=verify_timeout_seconds,
        verify_poll_seconds=verify_poll_seconds,
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
    if any(pattern in message for pattern in NON_TRANSIENT_POSTGRES_ERROR_PATTERNS):
        return False
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


def _kubectl_apply(namespace: str, payload: Mapping[str, Any]) -> None:
    _run_command(
        ['kubectl', '-n', namespace, 'apply', '-f', '-'],
        input_text=yaml.safe_dump(dict(payload), sort_keys=False),
    )


def _kubectl_delete(namespace: str, kind: str, name: str) -> None:
    _run_command(
        [
            'kubectl',
            '-n',
            namespace,
            'delete',
            kind,
            name,
            '--ignore-not-found=true',
        ]
    )


def _kubectl_delete_if_exists(namespace: str, kind: str, name: str) -> None:
    _run_command(
        [
            'kubectl',
            '-n',
            namespace,
            'delete',
            kind,
            name,
            '--ignore-not-found=true',
            '--wait=false',
        ]
    )


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


def _clone_json_mapping(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return cast(dict[str, Any], json.loads(json.dumps(dict(value))))


def _simulation_lock_payload(
    *,
    resources: SimulationResources,
    state_path: Path,
) -> dict[str, str]:
    return {
        'run_id': resources.run_id,
        'run_token': resources.run_token,
        'dataset_id': resources.dataset_id,
        'state_path': str(state_path),
        'acquired_at': datetime.now(timezone.utc).isoformat(),
    }


def _read_simulation_runtime_lock(namespace: str) -> dict[str, str] | None:
    try:
        payload = _kubectl_json(namespace, ['get', 'configmap', SIMULATION_RUNTIME_LOCK_NAME, '-o', 'json'])
    except RuntimeError as exc:
        if 'notfound' in str(exc).lower():
            return None
        raise
    data = _as_mapping(payload.get('data'))
    return {str(key): str(value) for key, value in data.items()}


def _acquire_simulation_runtime_lock(
    *,
    resources: SimulationResources,
    state_path: Path,
) -> dict[str, str]:
    payload = _simulation_lock_payload(resources=resources, state_path=state_path)
    try:
        _run_command(
            [
                'kubectl',
                '-n',
                resources.namespace,
                'create',
                'configmap',
                SIMULATION_RUNTIME_LOCK_NAME,
                *(f'--from-literal={key}={value}' for key, value in payload.items()),
            ]
        )
        return {
            'status': 'acquired',
            **payload,
        }
    except RuntimeError as exc:
        if 'already exists' not in str(exc).lower():
            raise
    existing = _read_simulation_runtime_lock(resources.namespace)
    if existing is None:
        raise RuntimeError('simulation_runtime_lock_missing_after_conflict')
    if existing.get('run_id') == resources.run_id:
        return {
            'status': 'reused',
            **existing,
        }
    raise RuntimeError(
        'simulation_runtime_lock_held:'
        f'{existing.get("run_id") or "unknown"}:'
        f'{existing.get("dataset_id") or "unknown"}'
    )


def _release_simulation_runtime_lock(
    *,
    resources: SimulationResources,
) -> dict[str, str]:
    existing = _read_simulation_runtime_lock(resources.namespace)
    if existing is None:
        return {'status': 'missing'}
    if existing.get('run_id') != resources.run_id:
        return {
            'status': 'not_owner',
            **existing,
        }
    _kubectl_delete(resources.namespace, 'configmap', SIMULATION_RUNTIME_LOCK_NAME)
    return {
        'status': 'released',
        **existing,
    }


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


def _argocd_application_mode_from_sync_policy(
    sync_policy: Mapping[str, Any] | None,
) -> str:
    if sync_policy is None:
        return 'manual'
    automated = _as_mapping(sync_policy.get('automated'))
    if not automated:
        return 'manual'
    enabled = automated.get('enabled')
    return 'auto' if bool(enabled) else 'manual'


def _read_named_argocd_application_sync_policy(
    *,
    namespace: str,
    app_name: str,
) -> dict[str, Any]:
    payload = _kubectl_json_global(
        [
            '-n',
            namespace,
            'get',
            'application',
            app_name,
            '-o',
            'json',
        ]
    )
    spec = _as_mapping(payload.get('spec'))
    sync_policy_raw = spec.get('syncPolicy')
    sync_policy = _clone_json_mapping(_as_mapping(sync_policy_raw) if isinstance(sync_policy_raw, Mapping) else None)
    automation_mode = _argocd_application_mode_from_sync_policy(sync_policy)
    return {
        'sync_policy': sync_policy,
        'automation_mode': automation_mode,
    }


def _read_argocd_application_sync_policy(
    *,
    config: ArgocdAutomationConfig,
) -> dict[str, Any]:
    return _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=config.app_name,
    )


def _manual_argocd_application_sync_policy(
    current_sync_policy: Mapping[str, Any] | None,
) -> dict[str, Any]:
    manual_policy = _clone_json_mapping(current_sync_policy) or {}
    automated = _as_mapping(manual_policy.get('automated'))
    manual_automated = dict(automated)
    manual_automated['enabled'] = False
    manual_automated['prune'] = False
    manual_automated['selfHeal'] = False
    manual_policy['automated'] = manual_automated
    return manual_policy


def _set_argocd_application_sync_policy(
    *,
    config: ArgocdAutomationConfig,
    app_name: str | None = None,
    desired_sync_policy: Mapping[str, Any] | None,
) -> dict[str, Any]:
    desired_policy = _clone_json_mapping(desired_sync_policy)
    target_app_name = app_name or config.app_name
    state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=target_app_name,
    )
    current_policy = _clone_json_mapping(cast(Mapping[str, Any] | None, state.get('sync_policy')))
    changed = current_policy != desired_policy
    if changed:
        if desired_policy is None:
            _kubectl_patch_json(
                config.applicationset_namespace,
                'application',
                target_app_name,
                [{'op': 'remove', 'path': '/spec/syncPolicy'}],
            )
        else:
            _kubectl_patch(
                config.applicationset_namespace,
                'application',
                target_app_name,
                {'spec': {'syncPolicy': desired_policy}},
            )

    deadline = datetime.now(timezone.utc) + timedelta(seconds=config.verify_timeout_seconds)
    verified_policy = current_policy
    while True:
        verified_state = _read_named_argocd_application_sync_policy(
            namespace=config.applicationset_namespace,
            app_name=target_app_name,
        )
        verified_policy = _clone_json_mapping(cast(Mapping[str, Any] | None, verified_state.get('sync_policy')))
        if verified_policy == desired_policy:
            break
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(
                'argocd_application_sync_policy_verify_timeout '
                f'desired={json.dumps(desired_policy, sort_keys=True)} '
                f'observed={json.dumps(verified_policy, sort_keys=True)}'
            )
        time.sleep(2)

    return {
        'previous_sync_policy': current_policy,
        'current_sync_policy': verified_policy,
        'changed': changed,
    }


def _wait_for_argocd_application_mode(
    *,
    config: ArgocdAutomationConfig,
    app_name: str,
    desired_mode: str,
) -> dict[str, Any]:
    normalized_desired = _normalized_automation_mode(desired_mode)
    state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=app_name,
    )
    current_mode = _normalized_automation_mode(_as_text(state.get('automation_mode')))
    deadline = datetime.now(timezone.utc) + timedelta(seconds=config.verify_timeout_seconds)
    verified_mode = current_mode
    while True:
        verified_state = _read_named_argocd_application_sync_policy(
            namespace=config.applicationset_namespace,
            app_name=app_name,
        )
        verified_mode = _normalized_automation_mode(_as_text(verified_state.get('automation_mode')))
        if verified_mode == normalized_desired:
            break
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(
                'argocd_application_mode_verify_timeout '
                f'app={app_name} desired={normalized_desired} observed={verified_mode}'
            )
        time.sleep(2)

    return {
        'app_name': app_name,
        'current_mode': verified_mode,
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


def _read_secret_key_ref(
    *,
    namespace: str,
    name: str,
    key: str,
) -> str:
    secret = _kubectl_json(namespace, ['get', 'secret', name, '-o', 'json'])
    data = _as_mapping(secret.get('data'))
    encoded = _as_text(data.get(key))
    if encoded is None:
        raise RuntimeError(f'secret_key_missing:{namespace}:{name}:{key}')
    try:
        decoded = _b64_to_bytes(encoded)
        if decoded is None:
            raise RuntimeError('empty_secret_value')
        return decoded.decode('utf-8')
    except Exception as exc:  # pragma: no cover - defensive decode guard
        raise RuntimeError(f'secret_key_decode_failed:{namespace}:{name}:{key}') from exc


def _read_configmap_key_ref(
    *,
    namespace: str,
    name: str,
    key: str,
) -> str:
    configmap = _kubectl_json(namespace, ['get', 'configmap', name, '-o', 'json'])
    data = _as_mapping(configmap.get('data'))
    value = _as_text(data.get(key))
    if value is None:
        raise RuntimeError(f'configmap_key_missing:{namespace}:{name}:{key}')
    return value


def _expand_env_value_refs(value: str, resolved: Mapping[str, str]) -> str:
    def _sub(match: re.Match[str]) -> str:
        key = match.group(1)
        return resolved.get(key, match.group(0))

    return re.sub(r'\$\(([A-Za-z_][A-Za-z0-9_]*)\)', _sub, value)


def _resolve_kservice_env_values(
    *,
    namespace: str,
    env_entries: Sequence[Mapping[str, Any]],
) -> dict[str, str]:
    resolved: dict[str, str] = {}
    deferred: dict[str, str] = {}
    for entry in env_entries:
        name = _as_text(entry.get('name'))
        if not name:
            continue
        raw_value = entry.get('value')
        if raw_value is not None:
            deferred[name] = str(raw_value)
            continue
        value_from = _as_mapping(entry.get('valueFrom'))
        secret_key_ref = _as_mapping(value_from.get('secretKeyRef'))
        if secret_key_ref:
            secret_name = _as_text(secret_key_ref.get('name'))
            secret_key = _as_text(secret_key_ref.get('key'))
            if not secret_name or not secret_key:
                raise RuntimeError(f'kservice_env_secret_key_ref_invalid:{name}')
            resolved[name] = _read_secret_key_ref(
                namespace=namespace,
                name=secret_name,
                key=secret_key,
            )
            continue
        configmap_key_ref = _as_mapping(value_from.get('configMapKeyRef'))
        if configmap_key_ref:
            configmap_name = _as_text(configmap_key_ref.get('name'))
            configmap_key = _as_text(configmap_key_ref.get('key'))
            if not configmap_name or not configmap_key:
                raise RuntimeError(f'kservice_env_configmap_key_ref_invalid:{name}')
            resolved[name] = _read_configmap_key_ref(
                namespace=namespace,
                name=configmap_name,
                key=configmap_key,
            )
    if deferred:
        for _ in range(len(deferred) + len(resolved) + 1):
            changed = False
            for key, value in deferred.items():
                expanded = _expand_env_value_refs(value, resolved)
                if key not in resolved or resolved[key] != expanded:
                    resolved[key] = expanded
                    changed = True
            if not changed:
                break
    return resolved


def _resolve_warm_lane_runtime_postgres_config(
    *,
    resources: SimulationResources,
    postgres_config: PostgresRuntimeConfig,
) -> PostgresRuntimeConfig:
    if postgres_config.runtime_simulation_dsn:
        return postgres_config
    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    _, env_entries = _kservice_env(service)
    resolved_env = _resolve_kservice_env_values(
        namespace=resources.namespace,
        env_entries=env_entries,
    )
    current_runtime_dsn = _as_text(resolved_env.get('DB_DSN'))
    if not current_runtime_dsn:
        raise RuntimeError(
            f'warm_lane_runtime_dsn_unavailable:{resources.namespace}:{resources.torghut_service}'
        )
    runtime_dsn = _replace_database_in_dsn(
        current_runtime_dsn,
        database=postgres_config.simulation_db,
        label=f'{resources.torghut_service}.env.DB_DSN',
    )
    return replace(postgres_config, runtime_simulation_dsn=runtime_dsn)


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


def _performance_config(manifest: Mapping[str, Any]) -> dict[str, Any]:
    performance = _as_mapping(manifest.get('performance'))
    replay_profile = (
        _as_text(performance.get('replayProfile'))
        or _as_text(performance.get('replay_profile'))
        or ''
    ).strip().lower()
    if not replay_profile:
        window = _as_mapping(manifest.get('window'))
        if _as_text(window.get('start')) and _as_text(window.get('end')):
            monitor_settings = simulation_verification._monitor_settings(manifest)
            replay_profile = _as_text(monitor_settings.get('profile')) or DEFAULT_SIMULATION_REPLAY_PROFILE
        else:
            replay_profile = DEFAULT_SIMULATION_REPLAY_PROFILE
    if replay_profile not in REPLAY_PROFILE_DEFAULTS:
        raise RuntimeError(f'unsupported_replay_profile:{replay_profile}')

    dump_format = (
        _as_text(performance.get('dumpFormat'))
        or _as_text(performance.get('dump_format'))
        or ''
    ).strip().lower()
    if not dump_format:
        if shutil.which('zstd'):
            dump_format = 'jsonl.zst'
        elif shutil.which('pigz'):
            dump_format = 'jsonl.gz'
        else:
            dump_format = 'ndjson'
    if dump_format not in SUPPORTED_SIMULATION_DUMP_FORMATS:
        raise RuntimeError(
            'performance.dumpFormat must be one of: ' + ','.join(sorted(SUPPORTED_SIMULATION_DUMP_FORMATS))
        )
    cache_policy = (
        _as_text(manifest.get('cachePolicy'))
        or _as_text(performance.get('cachePolicy'))
        or _as_text(performance.get('cache_policy'))
        or 'prefer_cache'
    ).strip().lower()
    if cache_policy not in {'prefer_cache', 'require_cache', 'refresh'}:
        raise RuntimeError('cachePolicy must be one of: prefer_cache,require_cache,refresh')
    return {
        'replay_profile': replay_profile,
        'dump_format': dump_format,
        'cache_policy': cache_policy,
    }


def _dump_suffix(dump_format: str) -> str:
    suffix = SUPPORTED_SIMULATION_DUMP_FORMATS.get(dump_format)
    if suffix is None:
        raise RuntimeError(f'unsupported_dump_format:{dump_format}')
    return suffix


def _state_paths(
    resources: SimulationResources,
    manifest: Mapping[str, Any] | None = None,
) -> tuple[Path, Path, Path]:
    run_dir = resources.output_root / resources.run_token
    state_path = run_dir / 'state.json'
    run_manifest_path = run_dir / 'run-manifest.json'
    dump_format = DEFAULT_SIMULATION_DUMP_FORMAT
    if manifest is not None:
        dump_format = _as_text(_performance_config(manifest).get('dump_format')) or DEFAULT_SIMULATION_DUMP_FORMAT
    dump_path = run_dir / f'source-dump{_dump_suffix(dump_format)}'
    return state_path, run_manifest_path, dump_path


def _dump_artifact_manifest_path(dump_path: Path) -> Path:
    return dump_path.with_suffix(dump_path.suffix + '.manifest.json')


def _run_state_path(resources: SimulationResources) -> Path:
    run_dir = resources.output_root / resources.run_token
    return run_dir / 'run-state.json'


def _artifact_path(resources: SimulationResources, filename: str) -> Path:
    run_dir = resources.output_root / resources.run_token
    return run_dir / filename


def _ta_restore_policy(manifest: Mapping[str, Any]) -> dict[str, Any]:
    ta_restore = _as_mapping(manifest.get('ta_restore'))
    replay_profile = _as_text(_performance_config(manifest).get('replay_profile')) or DEFAULT_SIMULATION_REPLAY_PROFILE
    explicit_mode = (_as_text(ta_restore.get('mode')) or '').strip().lower()
    mode = explicit_mode
    source = 'explicit'
    if not mode:
        mode = 'required' if replay_profile == 'full_day' else 'stateless'
        source = f'profile_default:{replay_profile}'
    allowed_modes = {'required', 'stateless_if_missing', 'stateless'}
    if mode not in allowed_modes:
        raise RuntimeError(
            'ta_restore.mode must be one of: required,stateless_if_missing,stateless'
        )
    return {
        'mode': mode,
        'source': source,
        'replay_profile': replay_profile,
        'stateless_recovery_enabled': mode in {'stateless_if_missing', 'stateless'},
    }


def _ta_restore_paths(ta_data: Mapping[str, Any]) -> dict[str, str | None]:
    return {
        'checkpoint_dir': _as_text(ta_data.get('TA_CHECKPOINT_DIR')),
        'savepoint_dir': _as_text(ta_data.get('TA_SAVEPOINT_DIR')),
    }


def _resolve_ta_restore_configuration(
    *,
    ta_data: Mapping[str, Any],
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    policy = _ta_restore_policy(manifest)
    paths = _ta_restore_paths(ta_data)
    missing = [name for name, value in paths.items() if not value]
    if policy['mode'] == 'stateless':
        return {
            **policy,
            **paths,
            'configured': not missing,
            'effective_upgrade_mode': 'stateless',
            'fallback_applied': False,
            'reason': 'profile_default_stateless' if str(policy.get('source', '')).startswith('profile_default:') else 'explicit_stateless',
        }
    if missing:
        missing_reason = f'restore_state_missing:{",".join(sorted(missing))}'
        if policy['mode'] == 'stateless_if_missing':
            return {
                **policy,
                **paths,
                'configured': False,
                'effective_upgrade_mode': 'stateless',
                'fallback_applied': True,
                'reason': missing_reason,
            }
        raise RuntimeError(missing_reason)
    return {
        **policy,
        **paths,
        'configured': True,
        'effective_upgrade_mode': 'last-state',
        'fallback_applied': False,
        'reason': 'restore_state_configured',
    }


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


def _utc_from_millis(value: int | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)


def _upsert_simulation_progress_row(
    *,
    postgres_config: PostgresRuntimeConfig | None,
    resources: SimulationResources,
    component: str,
    status: str,
    workflow_name: str | None = None,
    last_source_ts: datetime | None = None,
    last_signal_ts: datetime | None = None,
    last_price_ts: datetime | None = None,
    cursor_at: datetime | None = None,
    records_dumped: int = 0,
    records_replayed: int = 0,
    trade_decisions: int = 0,
    executions: int = 0,
    execution_tca_metrics: int = 0,
    execution_order_events: int = 0,
    strategy_type: str | None = None,
    legacy_path_count: int = 0,
    fallback_count: int = 0,
    terminal_state: str | None = None,
    last_error_code: str | None = None,
    last_error_message: str | None = None,
    payload: Mapping[str, Any] | None = None,
) -> None:
    if postgres_config is None:
        return
    dsn = postgres_config.torghut_runtime_dsn

    def _write() -> None:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO simulation_run_progress (
                      run_id,
                      component,
                      dataset_id,
                      lane,
                      workflow_name,
                      status,
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
                    ) VALUES (
                      %(run_id)s,
                      %(component)s,
                      %(dataset_id)s,
                      %(lane)s,
                      %(workflow_name)s,
                      %(status)s,
                      %(last_source_ts)s,
                      %(last_signal_ts)s,
                      %(last_price_ts)s,
                      %(cursor_at)s,
                      %(records_dumped)s,
                      %(records_replayed)s,
                      %(trade_decisions)s,
                      %(executions)s,
                      %(execution_tca_metrics)s,
                      %(execution_order_events)s,
                      %(strategy_type)s,
                      %(legacy_path_count)s,
                      %(fallback_count)s,
                      %(terminal_state)s,
                      %(last_error_code)s,
                      %(last_error_message)s,
                      %(payload_json)s::jsonb
                    )
                    ON CONFLICT (run_id, component) DO UPDATE SET
                      dataset_id = EXCLUDED.dataset_id,
                      lane = EXCLUDED.lane,
                      workflow_name = COALESCE(EXCLUDED.workflow_name, simulation_run_progress.workflow_name),
                      status = EXCLUDED.status,
                      last_source_ts = COALESCE(EXCLUDED.last_source_ts, simulation_run_progress.last_source_ts),
                      last_signal_ts = COALESCE(EXCLUDED.last_signal_ts, simulation_run_progress.last_signal_ts),
                      last_price_ts = COALESCE(EXCLUDED.last_price_ts, simulation_run_progress.last_price_ts),
                      cursor_at = COALESCE(EXCLUDED.cursor_at, simulation_run_progress.cursor_at),
                      records_dumped = EXCLUDED.records_dumped,
                      records_replayed = EXCLUDED.records_replayed,
                      trade_decisions = EXCLUDED.trade_decisions,
                      executions = EXCLUDED.executions,
                      execution_tca_metrics = EXCLUDED.execution_tca_metrics,
                      execution_order_events = EXCLUDED.execution_order_events,
                      strategy_type = COALESCE(EXCLUDED.strategy_type, simulation_run_progress.strategy_type),
                      legacy_path_count = EXCLUDED.legacy_path_count,
                      fallback_count = EXCLUDED.fallback_count,
                      terminal_state = COALESCE(EXCLUDED.terminal_state, simulation_run_progress.terminal_state),
                      last_error_code = COALESCE(EXCLUDED.last_error_code, simulation_run_progress.last_error_code),
                      last_error_message = COALESCE(EXCLUDED.last_error_message, simulation_run_progress.last_error_message),
                      payload_json = COALESCE(simulation_run_progress.payload_json, '{}'::jsonb) || COALESCE(EXCLUDED.payload_json, '{}'::jsonb),
                      updated_at = NOW()
                    """,
                    {
                        'run_id': resources.run_id,
                        'component': component,
                        'dataset_id': resources.dataset_id,
                        'lane': resources.lane,
                        'workflow_name': workflow_name,
                        'status': status,
                        'last_source_ts': last_source_ts,
                        'last_signal_ts': last_signal_ts,
                        'last_price_ts': last_price_ts,
                        'cursor_at': cursor_at,
                        'records_dumped': int(records_dumped),
                        'records_replayed': int(records_replayed),
                        'trade_decisions': int(trade_decisions),
                        'executions': int(executions),
                        'execution_tca_metrics': int(execution_tca_metrics),
                        'execution_order_events': int(execution_order_events),
                        'strategy_type': strategy_type,
                        'legacy_path_count': int(legacy_path_count),
                        'fallback_count': int(fallback_count),
                        'terminal_state': terminal_state,
                        'last_error_code': last_error_code,
                        'last_error_message': last_error_message,
                        'payload_json': json.dumps(dict(payload or {}), sort_keys=True),
                    },
                )
            conn.commit()

    try:
        _run_with_transient_postgres_retry(
            label=f'upsert_simulation_progress:{component}',
            operation=_write,
        )
    except Exception as exc:
        _log_script_event(
            'Failed to write simulation progress row',
            run_id=resources.run_id,
            component=component,
            error=str(exc),
        )


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
    with _open_dump_reader(dump_path) as handle:
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
        'dump_format': _dump_format_for_path(dump_path),
        'records': actual_records,
        'sha256': actual_sha,
        'reused_existing_dump': True,
        'min_source_timestamp_ms': min_source_timestamp_ms,
        'max_source_timestamp_ms': max_source_timestamp_ms,
        'artifact_manifest_path': str(_dump_artifact_manifest_path(dump_path)),
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
    state_path, run_manifest_path, dump_path = _state_paths(resources, manifest)
    run_state_path = _run_state_path(resources)
    window = _as_mapping(manifest.get('window'))
    torghut_env_overrides = _torghut_env_overrides_from_manifest(manifest)
    window_policy = _validate_window_policy(manifest)
    rollouts_config = _build_rollouts_analysis_config(manifest)
    ta_restore = _ta_restore_policy(manifest)
    performance_cfg = _performance_config(manifest)
    return {
        'status': 'ok',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'lane': resources.lane,
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
            'clickhouse_tables': resources.clickhouse_table_by_role,
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
        'rollouts': asdict(rollouts_config),
        'ta_restore': ta_restore,
        'performance': performance_cfg,
        'artifacts': {
            'state_path': str(state_path),
            'run_manifest_path': str(run_manifest_path),
            'dump_path': str(dump_path),
            'dump_manifest_path': str(_dump_artifact_manifest_path(dump_path)),
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


def _http_request(
    *,
    base_url: str,
    path: str,
    method: str = 'GET',
    body: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> tuple[int, str]:
    parsed = urlsplit(base_url)
    scheme = parsed.scheme.lower()
    if scheme not in {'http', 'https'}:
        raise RuntimeError(f'unsupported_http_scheme:{scheme or "missing"}')
    if not parsed.hostname:
        raise RuntimeError('invalid_http_host')

    target_path = parsed.path or '/'
    if path and path != '/':
        target_path = f'{target_path.rstrip("/")}/{path.lstrip("/")}'
    request_headers = dict(headers or {})
    connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
    payload = body.encode('utf-8') if body is not None else None
    last_error: OSError | None = None
    for hostname in _cluster_service_host_candidates(parsed.hostname):
        connection = connection_class(hostname, parsed.port)
        try:
            connection.request(method.upper(), target_path, body=payload, headers=request_headers)
            response = connection.getresponse()
            response_body = response.read().decode('utf-8', errors='replace')
            return response.status, response_body
        except OSError as exc:
            last_error = exc
            continue
        finally:
            connection.close()
    if last_error is not None:
        raise last_error
    raise RuntimeError('http_request_failed_without_attempts')


def _clickhouse_query_configs(config: ClickHouseRuntimeConfig) -> list[ClickHouseRuntimeConfig]:
    parsed = urlsplit(config.http_url)
    host = parsed.hostname
    if not host or '.svc' not in host:
        return [config]

    host_parts = host.split('.')
    if len(host_parts) < 2:
        return [config]

    service_name = host_parts[0]
    namespace = host_parts[1]
    try:
        payload = _kubectl_json(namespace, ['get', 'endpoints', service_name, '-o', 'json'])
    except Exception:
        return [config]

    resolved_configs: list[ClickHouseRuntimeConfig] = []
    seen_urls: set[str] = set()
    subsets = payload.get('subsets')
    if isinstance(subsets, Sequence):
        for subset in subsets:
            if not isinstance(subset, Mapping):
                continue
            addresses = subset.get('addresses')
            if not isinstance(addresses, Sequence):
                continue
            for address in addresses:
                if not isinstance(address, Mapping):
                    continue
                ip = _as_text(address.get('ip'))
                if not ip:
                    continue
                netloc = f'{ip}:{parsed.port}' if parsed.port is not None else ip
                endpoint_url = parsed._replace(netloc=netloc).geturl()
                if endpoint_url in seen_urls:
                    continue
                seen_urls.add(endpoint_url)
                resolved_configs.append(
                    ClickHouseRuntimeConfig(
                        http_url=endpoint_url,
                        username=config.username,
                        password=config.password,
                    )
                )
    return resolved_configs or [config]


def _ensure_clickhouse_database(
    *,
    config: ClickHouseRuntimeConfig,
    database: str,
) -> None:
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', database):
        raise RuntimeError(f'invalid_clickhouse_database_name:{database}')
    create_query = f'CREATE DATABASE IF NOT EXISTS {database}'
    for endpoint_config in _clickhouse_query_configs(config):
        status, body = _http_clickhouse_query(config=endpoint_config, query=create_query)
        if status < 200 or status >= 300:
            raise RuntimeError(f'clickhouse_create_database_failed:{status}:{body[:200]}')
        _wait_for_clickhouse_database(
            config=endpoint_config,
            database=database,
        )


def _show_create_clickhouse_table(
    *,
    config: ClickHouseRuntimeConfig,
    table: str,
) -> str:
    query_config = _clickhouse_query_configs(config)[0]
    status, body = _http_clickhouse_query(config=query_config, query=f'SHOW CREATE TABLE {table}')
    if status < 200 or status >= 300:
        raise RuntimeError(f'clickhouse_show_create_failed:{table}:{status}:{body[:200]}')
    ddl = body.strip()
    if '\\n' in ddl:
        ddl = ddl.replace('\\n', '\n')
    if "\\'" in ddl:
        ddl = ddl.replace("\\'", "'")
    return ddl.strip()


def _rewrite_clickhouse_table_ddl_for_simulation(
    *,
    source_ddl: str,
    source_table: str,
    database: str,
    table: str,
) -> str:
    ddl = source_ddl.strip().rstrip(';')
    ddl = ddl.replace(
        f'CREATE TABLE {source_table}',
        f'CREATE TABLE IF NOT EXISTS {database}.{table}',
        1,
    )
    engine_pattern = re.compile(
        r"ReplicatedReplacingMergeTree\('([^']+)',\s*'\{replica\}'",
        re.MULTILINE,
    )
    replicated_path = f"/clickhouse/tables/{{cluster}}/{{shard}}/{database}/{table}"
    if not engine_pattern.search(ddl):
        raise RuntimeError(f'clickhouse_schema_missing_replicated_engine:{source_table}')
    ddl = engine_pattern.sub(
        f"ReplicatedReplacingMergeTree('{replicated_path}', '{{replica}}'",
        ddl,
        count=1,
    )
    return ddl


def _ensure_clickhouse_runtime_tables(
    *,
    config: ClickHouseRuntimeConfig,
    database: str,
    lane: str = 'equity',
) -> None:
    lane_contract = simulation_lane_contract(lane)
    endpoint_configs = _clickhouse_query_configs(config)
    for role, table in lane_contract.clickhouse_simulation_table_by_role.items():
        source_basename = lane_contract.clickhouse_source_table_by_role[role]
        source_table = f'{SIMULATION_CLICKHOUSE_SCHEMA_SOURCE_DATABASE}.{source_basename}'
        source_ddl = _show_create_clickhouse_table(config=endpoint_configs[0], table=source_table)
        create_query = _rewrite_clickhouse_table_ddl_for_simulation(
            source_ddl=source_ddl,
            source_table=source_table,
            database=database,
            table=table,
        )
        for endpoint_config in endpoint_configs:
            status, body = _http_clickhouse_query(config=endpoint_config, query=create_query)
            if status < 200 or status >= 300:
                raise RuntimeError(f'clickhouse_create_table_failed:{database}.{table}:{status}:{body[:200]}')
            _wait_for_clickhouse_table(
                config=endpoint_config,
                database=database,
                table=table,
            )
            reset_query = f'TRUNCATE TABLE {database}.{table}'
            status, body = _http_clickhouse_query(config=endpoint_config, query=reset_query)
            if status < 200 or status >= 300:
                raise RuntimeError(f'clickhouse_truncate_table_failed:{database}.{table}:{status}:{body[:200]}')


def _clickhouse_database_precreated(manifest: Mapping[str, Any]) -> bool:
    clickhouse = _as_mapping(manifest.get('clickhouse'))
    raw_value = clickhouse.get('database_precreated')
    if raw_value is None:
        raw_value = clickhouse.get('skip_database_create')
    return str(raw_value or 'false').strip().lower() in {'1', 'true', 'yes', 'on'}


def _postgres_database_precreated(manifest: Mapping[str, Any]) -> bool:
    postgres = _as_mapping(manifest.get('postgres'))
    raw_value = postgres.get('database_precreated')
    if raw_value is None:
        raw_value = postgres.get('skip_database_create')
    return str(raw_value or 'false').strip().lower() in {'1', 'true', 'yes', 'on'}


def _wait_for_clickhouse_table(
    *,
    config: ClickHouseRuntimeConfig,
    database: str,
    table: str,
    attempts: int = SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_ATTEMPTS,
    sleep_seconds: float = SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_SLEEP_SECONDS,
) -> None:
    if attempts <= 0:
        raise RuntimeError('clickhouse_table_visibility_attempts_must_be_positive')
    exists_query = f'EXISTS TABLE {database}.{table}'
    last_body = ''
    for attempt in range(1, attempts + 1):
        status, body = _http_clickhouse_query(config=config, query=exists_query)
        last_body = body[:200]
        if 200 <= status < 300 and body.strip() == '1':
            return
        if attempt < attempts:
            time.sleep(sleep_seconds)
    raise RuntimeError(f'clickhouse_table_not_visible:{database}.{table}:{last_body}')


def _wait_for_clickhouse_database(
    *,
    config: ClickHouseRuntimeConfig,
    database: str,
    attempts: int = SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_ATTEMPTS,
    sleep_seconds: float = SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_SLEEP_SECONDS,
) -> None:
    if attempts <= 0:
        raise RuntimeError('clickhouse_database_visibility_attempts_must_be_positive')
    exists_query = f'EXISTS DATABASE {database}'
    last_body = ''
    for attempt in range(1, attempts + 1):
        status, body = _http_clickhouse_query(config=config, query=exists_query)
        last_body = body[:200]
        if 200 <= status < 300 and body.strip() == '1':
            return
        if attempt < attempts:
            time.sleep(sleep_seconds)
    raise RuntimeError(f'clickhouse_database_not_visible:{database}:{last_body}')


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
    _remove_appledouble_sidecars(repo_root / 'migrations' / 'versions')

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


def _remove_appledouble_sidecars(directory: Path) -> None:
    if not directory.exists():
        return
    for candidate in directory.glob('._*.py'):
        candidate.unlink(missing_ok=True)


def _reset_postgres_runtime_state(config: PostgresRuntimeConfig) -> None:
    def _reset() -> None:
        with psycopg.connect(config.torghut_runtime_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                for table in SIMULATION_POSTGRES_RUNTIME_RESET_TABLES:
                    cursor.execute('SELECT to_regclass(%s)', (table,))
                    row = cursor.fetchone()
                    if row is None or row[0] is None:
                        continue
                    cursor.execute(
                        sql.SQL('TRUNCATE TABLE {} RESTART IDENTITY CASCADE').format(
                            sql.Identifier(table),
                        )
                    )

    _run_with_transient_postgres_retry(
        label='reset_postgres_runtime_state',
        operation=_reset,
    )


def _seed_simulation_trade_cursor(
    *,
    config: PostgresRuntimeConfig,
    manifest: Mapping[str, Any],
    account_label: str = 'TORGHUT_SIM',
) -> datetime:
    window_start, _window_end = _resolve_window_bounds(manifest)

    def _seed() -> None:
        with psycopg.connect(config.torghut_runtime_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO trade_cursor (
                      id,
                      source,
                      account_label,
                      cursor_at,
                      cursor_seq,
                      cursor_symbol
                    ) VALUES (
                      %(id)s,
                      'clickhouse',
                      %(account_label)s,
                      %(cursor_at)s,
                      NULL,
                      NULL
                    )
                    ON CONFLICT (source, account_label) DO UPDATE SET
                      cursor_at = EXCLUDED.cursor_at,
                      cursor_seq = NULL,
                      cursor_symbol = NULL,
                      updated_at = NOW()
                    """,
                    {
                        'id': uuid.uuid4(),
                        'account_label': account_label,
                        'cursor_at': window_start,
                    },
                )

    _run_with_transient_postgres_retry(
        label='seed_simulation_trade_cursor',
        operation=_seed,
    )
    return window_start


def _runtime_sessionmaker(config: PostgresRuntimeConfig) -> tuple[Any, Any]:
    runtime_dsn = config.torghut_runtime_dsn
    if runtime_dsn.startswith('postgresql://'):
        runtime_dsn = 'postgresql+psycopg://' + runtime_dsn[len('postgresql://') :]
    engine = create_engine(runtime_dsn, future=True)
    factory = sessionmaker(
        bind=engine,
        expire_on_commit=False,
        future=True,
    )
    return factory, engine


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


def _clickhouse_jdbc_url_for_database(raw_url: str, new_database: str) -> str:
    parsed = urlsplit(raw_url.strip())
    if not parsed.hostname:
        raise RuntimeError(f'invalid_clickhouse_http_url:{raw_url}')
    netloc = parsed.netloc
    suffix = f'?{parsed.query}' if parsed.query else ''
    return f'jdbc:clickhouse://{netloc}/{new_database}{suffix}'


def _configure_ta_for_simulation(
    *,
    resources: SimulationResources,
    clickhouse_config: ClickHouseRuntimeConfig,
    clickhouse_database: str,
    auto_offset_reset: str,
    manifest: Mapping[str, Any],
) -> None:
    updates: dict[str, str] = {
        _ta_group_id_key(lane=resources.lane, manifest=manifest): resources.ta_group_id,
        _ta_auto_offset_reset_key(lane=resources.lane, manifest=manifest): auto_offset_reset,
    }

    for role, key in _ta_topic_key_by_role(lane=resources.lane, manifest=manifest).items():
        topic = resources.simulation_topic_by_role.get(role)
        if not topic:
            continue
        updates[key] = topic

    updates[_ta_clickhouse_url_key(lane=resources.lane, manifest=manifest)] = _clickhouse_jdbc_url_for_database(
        clickhouse_config.http_url,
        clickhouse_database,
    )

    _kubectl_patch(
        resources.namespace,
        'configmap',
        resources.ta_configmap,
        {'data': updates},
    )


def _restart_ta_deployment(
    resources: SimulationResources,
    *,
    desired_state: str,
    upgrade_mode: str = 'last-state',
) -> int:
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
                'job': {'state': desired_state, 'upgradeMode': upgrade_mode},
            }
        },
    )
    return next_nonce


def _configure_torghut_service_for_simulation(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    postgres_config: PostgresRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    kafka_config: KafkaRuntimeConfig,
    torghut_env_overrides: Mapping[str, Any] | None = None,
) -> None:
    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    _, current_env = _kservice_env(service)
    window_start, window_end = _resolve_window_bounds(manifest)
    forecast_base_url = (
        f'http://{resources.torghut_forecast_service}.{resources.namespace}.svc.cluster.local:8089'
    )

    updates = {
        'DB_DSN': postgres_config.torghut_runtime_dsn,
        'TRADING_ENABLED': 'true',
        'TRADING_MODE': 'paper',
        'TRADING_FEATURE_FLAGS_ENABLED': 'false',
        'TA_CLICKHOUSE_URL': clickhouse_config.http_url,
        'TA_CLICKHOUSE_USERNAME': clickhouse_config.username or '',
        'TA_CLICKHOUSE_PASSWORD': clickhouse_config.password or '',
        'TRADING_SIGNAL_TABLE': resources.clickhouse_signal_table,
        'TRADING_PRICE_TABLE': resources.clickhouse_price_table,
        'TRADING_SIGNAL_ALLOWED_SOURCES': 'ws,ta',
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
        'TRADING_SIMULATION_CLOCK_MODE': 'cursor',
        'TRADING_SIMULATION_WINDOW_START': window_start.astimezone(timezone.utc).isoformat(),
        'TRADING_SIMULATION_WINDOW_END': window_end.astimezone(timezone.utc).isoformat(),
        'TRADING_SIMULATION_ORDER_UPDATES_TOPIC': resources.simulation_topic_by_role['order_updates'],
        'TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS': kafka_config.runtime_bootstrap,
        'TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL': kafka_config.runtime_security,
        'TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM': kafka_config.runtime_sasl,
        'TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME': kafka_config.runtime_username,
        'TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD': kafka_config.runtime_password,
        'TRADING_FORECAST_SERVICE_URL': forecast_base_url,
        'TRADING_FORECAST_ROUTER_PROVIDER_MODE': 'http',
        'TRADING_FORECAST_ROUTER_PROVIDER_URL': forecast_base_url,
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


def _fink_runtime_health(namespace: str, name: str) -> dict[str, Any]:
    deployment = _kubectl_json(namespace, ['get', 'flinkdeployment', name, '-o', 'json'])
    spec = _as_mapping(deployment.get('spec'))
    status = _as_mapping(deployment.get('status'))
    job_status = _as_mapping(status.get('jobStatus'))
    lifecycle_state = _as_text(job_status.get('state')) or _as_text(status.get('jobManagerDeploymentStatus'))
    return {
        'name': name,
        'desired_state': _as_text(_as_mapping(spec.get('job')).get('state')) or 'unknown',
        'lifecycle_state': lifecycle_state or 'unknown',
        'job_manager_status': _as_text(status.get('jobManagerDeploymentStatus')) or 'unknown',
    }


def _runtime_verify(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    window_start, window_end = _resolve_window_bounds(manifest)
    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    service_status = _as_mapping(service.get('status'))
    latest_ready_revision = _as_text(service_status.get('latestReadyRevisionName'))
    ready = _condition_status(service_status, condition_type='Ready') == 'True'
    revision_health: dict[str, Any] | None = None
    if latest_ready_revision:
        revision_health = _deployment_replica_health(
            resources.namespace,
            f'{latest_ready_revision}-deployment',
        )
    ta_health = _fink_runtime_health(resources.namespace, resources.ta_deployment)
    forecast_health = _deployment_replica_health(
        resources.namespace,
        resources.torghut_forecast_service,
    )
    report = {
        'runtime_state': 'ready'
        if ready
        and revision_health is not None
        and revision_health['ready_replicas'] > 0
        and ta_health['desired_state'] == 'running'
        and ta_health['lifecycle_state'] in {'RUNNING', 'running', 'DEPLOYED'}
        and forecast_health['ready_replicas'] > 0
        else 'not_ready',
        'target_mode': resources.target_mode,
        'window_start': window_start.astimezone(timezone.utc).isoformat(),
        'window_end': window_end.astimezone(timezone.utc).isoformat(),
        'torghut_service': {
            'name': resources.torghut_service,
            'ready': ready,
            'latest_ready_revision': latest_ready_revision,
            'revision_health': revision_health,
        },
        'ta_runtime': ta_health,
        'forecast_runtime': forecast_health,
        'environment_state': 'complete'
        if forecast_health['ready_replicas'] > 0
        else 'environment_incomplete',
    }
    return report


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


def _simulation_schema_registry_subject_specs(
    *,
    resources: SimulationResources,
) -> list[dict[str, str]]:
    lane_contract = simulation_lane_contract(resources.lane)
    schema_files = cast(
        Mapping[str, str],
        lane_contract.schema_registry_schema_file_by_role,
    )
    specs: list[dict[str, str]] = []
    for role in simulation_schema_registry_subject_roles(lane_contract):
        topic = resources.simulation_topic_by_role.get(role)
        schema_relative = _as_text(schema_files.get(role))
        if not topic or not schema_relative:
            continue
        specs.append(
            {
                'role': role,
                'subject': f'{topic}-value',
                'schema_path': str(_resolve_schema_registry_schema_path(schema_relative)),
            }
        )
    return specs


def _resolve_schema_registry_schema_path(schema_relative: str) -> Path:
    script_path = Path(__file__).resolve()
    for candidate_root in (script_path.parent, *script_path.parents):
        candidate_path = (candidate_root / schema_relative).resolve()
        if candidate_path.exists():
            return candidate_path
    return (script_path.parents[min(3, len(script_path.parents) - 1)] / schema_relative).resolve()


def _load_schema_registry_schema_literal(schema_path: str) -> str:
    path = Path(schema_path)
    if not path.exists():
        normalized_path = schema_path.replace('\\', '/')
        for suffix, schema_literal in EMBEDDED_SCHEMA_REGISTRY_SCHEMA_BY_SUFFIX.items():
            if normalized_path.endswith(suffix):
                return schema_literal
        raise RuntimeError(f'schema_registry_schema_file_missing:{schema_path}')
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f'schema_registry_schema_invalid:{schema_path}') from exc
    return json.dumps(payload, separators=(',', ':'))


def _ensure_simulation_schema_subjects(
    *,
    resources: SimulationResources,
    ta_data: Mapping[str, Any],
) -> dict[str, Any]:
    registry_url = _as_text(ta_data.get('TA_SCHEMA_REGISTRY_URL'))
    specs = _simulation_schema_registry_subject_specs(resources=resources)
    subjects_expected = [spec['subject'] for spec in specs]
    if not registry_url:
        return {
            'ready': True,
            'reason': 'schema_registry_url_not_declared',
            'subjects_expected': subjects_expected,
            'subjects_existing': [],
            'subjects_registered': [],
        }
    if not specs:
        return {
            'ready': True,
            'reason': 'schema_registry_subjects_not_declared',
            'url': registry_url,
            'subjects_expected': subjects_expected,
            'subjects_existing': [],
            'subjects_registered': [],
        }

    status, _ = _http_request(base_url=registry_url, path='/subjects')
    if status != 200:
        raise RuntimeError(f'schema_registry_not_ready:http_{status}')

    existing: list[str] = []
    registered: list[str] = []
    for spec in specs:
        subject = spec['subject']
        subject_path = f"/subjects/{quote_plus(subject)}/versions/latest"
        subject_status, _ = _http_request(base_url=registry_url, path=subject_path)
        if subject_status == 200:
            existing.append(subject)
            continue
        if subject_status != 404:
            raise RuntimeError(f'schema_registry_subject_check_failed:{subject}:http_{subject_status}')
        schema_literal = _load_schema_registry_schema_literal(spec['schema_path'])
        request_body = json.dumps({'schema': schema_literal})
        create_status, create_body = _http_request(
            base_url=registry_url,
            path=f"/subjects/{quote_plus(subject)}/versions",
            method='POST',
            body=request_body,
            headers={'Content-Type': SCHEMA_REGISTRY_CONTENT_TYPE},
        )
        if create_status not in {200, 201}:
            raise RuntimeError(
                f'schema_registry_subject_register_failed:{subject}:http_{create_status}:{create_body.strip()}'
            )
        registered.append(subject)

    return {
        'ready': True,
        'reason': 'ok',
        'url': registry_url,
        'subjects_expected': subjects_expected,
        'subjects_existing': existing,
        'subjects_registered': registered,
    }


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


def _producer_for_replay(
    config: KafkaRuntimeConfig,
    run_token: str,
    *,
    profile: str | None = None,
) -> Any:
    from kafka import KafkaProducer  # type: ignore[import-not-found]

    resolved_profile = (profile or DEFAULT_SIMULATION_REPLAY_PROFILE).strip().lower()
    if resolved_profile not in REPLAY_PROFILE_DEFAULTS:
        raise RuntimeError(f'unsupported_replay_profile:{resolved_profile}')
    defaults = REPLAY_PROFILE_DEFAULTS[resolved_profile]
    kwargs = config.kafka_runtime_client_kwargs()
    kwargs.update(
        {
            'client_id': f'torghut-sim-replay-{run_token}',
            'acks': 'all',
            'retries': 3,
            'linger_ms': int(defaults['producer_linger_ms']),
            'batch_size': int(defaults['producer_batch_size']),
            'buffer_memory': int(defaults['producer_buffer_memory']),
            'compression_type': str(defaults['producer_compression_type']),
            'max_in_flight_requests_per_connection': 5,
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
    postgres_config: PostgresRuntimeConfig | None = None,
) -> dict[str, Any]:
    performance_cfg = _performance_config(manifest)
    if not force:
        reusable_report = _reusable_dump_report(dump_path)
        if reusable_report is not None:
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_REPLAY,
                status='dump_reused',
                records_dumped=_safe_int(reusable_report.get('records')),
                last_source_ts=_utc_from_millis(
                    _safe_int(reusable_report.get('max_source_timestamp_ms'), default=0) or None
                ),
                payload={
                    'dump_path': str(dump_path),
                    'dump_format': reusable_report.get('dump_format'),
                    'reused_existing_dump': True,
                    'records_by_topic': reusable_report.get('records_by_topic', {}),
                },
            )
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
    dump_started_at = datetime.now(timezone.utc)
    raw_dump_path = dump_path
    dump_format = _as_text(performance_cfg.get('dump_format')) or DEFAULT_SIMULATION_DUMP_FORMAT
    if _dump_format_for_path(dump_path) != 'ndjson':
        raw_dump_path = dump_path.with_suffix(dump_path.suffix + '.tmp.ndjson')
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
        expected_records = sum(
            max(stop_offsets[tp] - start_offsets[tp], 0)
            for tp in topic_partitions
        )

        _ensure_directory(raw_dump_path)
        done: set[Any] = set()
        with raw_dump_path.open('w', encoding='utf-8') as handle:
            idle_polls = 0
            while len(done) < len(topic_partitions):
                if count >= expected_records:
                    done.update(topic_partitions)
                    break
                polled = consumer.poll(timeout_ms=1000, max_records=2000)
                if not polled:
                    idle_polls += 1
                    if count >= expected_records:
                        done.update(topic_partitions)
                        break
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
                        # kafka-python position() may lag the exclusive stop offset until a later poll.
                        # Mark the partition complete as soon as we write the final in-window record.
                        if int(record.offset) + 1 >= stop_offset:
                            done.add(tp)
                            break
                        if count >= expected_records:
                            done.update(topic_partitions)
                            break
                    if consumer.position(tp) >= stop_offset:
                        done.add(tp)
                    if count >= expected_records:
                        done.update(topic_partitions)
                        break

        if raw_dump_path != dump_path:
            _compress_dump_file(source_path=raw_dump_path, dump_path=dump_path)
        file_sha256 = _file_sha256(dump_path)
        duration_seconds = max((datetime.now(timezone.utc) - dump_started_at).total_seconds(), 0.001)
        report = {
            'path': str(dump_path),
            'dump_format': dump_format,
            'records': count,
            'expected_records': expected_records,
            'sha256': file_sha256,
            'payload_sha256': hasher.hexdigest(),
            'records_by_topic': count_by_topic,
            'start': start.isoformat(),
            'end': end.isoformat(),
            'reused_existing_dump': False,
            'min_source_timestamp_ms': min_source_timestamp_ms,
            'max_source_timestamp_ms': max_source_timestamp_ms,
            'duration_seconds': duration_seconds,
            'records_per_second': count / duration_seconds if count > 0 else 0.0,
            'cache_policy': _as_text(performance_cfg.get('cache_policy')) or 'prefer_cache',
            'replay_profile': _as_text(performance_cfg.get('replay_profile')) or DEFAULT_SIMULATION_REPLAY_PROFILE,
        }
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_REPLAY,
            status='dumped',
            records_dumped=count,
            last_source_ts=_utc_from_millis(max_source_timestamp_ms),
            payload={
                'dump_path': str(dump_path),
                'dump_format': dump_format,
                'records_by_topic': count_by_topic,
                'payload_sha256': hasher.hexdigest(),
                'dump_sha256': file_sha256,
            },
        )
        _save_json(
            _dump_marker_path(dump_path),
            {
                'completed_at': datetime.now(timezone.utc).isoformat(),
                'dump_sha256': file_sha256,
                'records': report['records'],
                'dump_format': dump_format,
                'min_source_timestamp_ms': report['min_source_timestamp_ms'],
                'max_source_timestamp_ms': report['max_source_timestamp_ms'],
            },
        )
        _save_json(
            _dump_artifact_manifest_path(dump_path),
            {
                'dataset_id': resources.dataset_id,
                'run_id': resources.run_id,
                'dump_format': dump_format,
                'cache_policy': _as_text(performance_cfg.get('cache_policy')) or 'prefer_cache',
                'replay_profile': _as_text(performance_cfg.get('replay_profile')) or DEFAULT_SIMULATION_REPLAY_PROFILE,
                'chunk_count': 1,
                'chunks': [
                    {
                        'path': str(dump_path),
                        'records': count,
                        'sha256': file_sha256,
                        'payload_sha256': hasher.hexdigest(),
                        'min_source_timestamp_ms': min_source_timestamp_ms,
                        'max_source_timestamp_ms': max_source_timestamp_ms,
                    }
                ],
            },
        )
        return report
    finally:
        if raw_dump_path != dump_path:
            raw_dump_path.unlink(missing_ok=True)
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


def _dump_format_for_path(path: Path) -> str:
    path_str = str(path)
    for dump_format, suffix in sorted(
        SUPPORTED_SIMULATION_DUMP_FORMATS.items(),
        key=lambda item: len(item[1]),
        reverse=True,
    ):
        if path_str.endswith(suffix):
            return dump_format
    raise RuntimeError(f'unsupported_dump_path:{path}')


@contextmanager
def _open_dump_reader(path: Path):
    dump_format = _dump_format_for_path(path)
    if dump_format == 'ndjson':
        with path.open('r', encoding='utf-8') as handle:
            yield handle
        return
    if dump_format == 'jsonl.gz':
        if shutil.which('pigz'):
            process = subprocess.Popen(
                ['pigz', '-dc', str(path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding='utf-8',
            )
            if process.stdout is None:
                raise RuntimeError('pigz_reader_missing_stdout')
            try:
                yield process.stdout
            finally:
                process.stdout.close()
                stderr = process.stderr.read().strip() if process.stderr is not None else ''
                if process.stderr is not None:
                    process.stderr.close()
                return_code = process.wait()
                if return_code != 0:
                    raise RuntimeError(f'pigz_decompress_failed:{stderr or return_code}')
            return
        with gzip.open(path, 'rt', encoding='utf-8') as handle:
            yield handle
        return
    if dump_format == 'jsonl.zst':
        process = subprocess.Popen(
            ['zstd', '-d', '-q', '-c', str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
        )
        if process.stdout is None:
            raise RuntimeError('zstd_reader_missing_stdout')
        try:
            yield process.stdout
        finally:
            process.stdout.close()
            stderr = process.stderr.read().strip() if process.stderr is not None else ''
            if process.stderr is not None:
                process.stderr.close()
            return_code = process.wait()
            if return_code != 0:
                raise RuntimeError(f'zstd_decompress_failed:{stderr or return_code}')
        return
    raise RuntimeError(f'unsupported_dump_format:{dump_format}')


def _compress_dump_file(*, source_path: Path, dump_path: Path) -> None:
    dump_format = _dump_format_for_path(dump_path)
    _ensure_directory(dump_path)
    if dump_format == 'ndjson':
        shutil.move(str(source_path), str(dump_path))
        return
    if dump_format == 'jsonl.gz':
        if shutil.which('pigz'):
            with dump_path.open('wb') as output:
                result = subprocess.run(
                    ['pigz', '-c', '-6', str(source_path)],
                    check=False,
                    stdout=output,
                    stderr=subprocess.PIPE,
                )
            if result.returncode != 0:
                detail = (result.stderr or b'').decode('utf-8', errors='replace').strip()
                raise RuntimeError(f'pigz_compress_failed:{detail or result.returncode}')
        else:
            with source_path.open('rb') as source, gzip.open(dump_path, 'wb', compresslevel=6) as output:
                shutil.copyfileobj(source, output)
        source_path.unlink(missing_ok=True)
        return
    if dump_format == 'jsonl.zst':
        with dump_path.open('wb') as output:
            result = subprocess.run(
                ['zstd', '-q', '-T0', '-3', '-c', str(source_path)],
                check=False,
                stdout=output,
                stderr=subprocess.PIPE,
            )
        if result.returncode != 0:
            detail = (result.stderr or b'').decode('utf-8', errors='replace').strip()
            raise RuntimeError(f'zstd_compress_failed:{detail or result.returncode}')
        source_path.unlink(missing_ok=True)
        return
    raise RuntimeError(f'unsupported_dump_format:{dump_format}')


def _count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    with _open_dump_reader(path) as handle:
        return sum(1 for _ in handle)


def _dump_sha256_for_replay(path: Path) -> str:
    hasher = hashlib.sha256()
    with _open_dump_reader(path) as handle:
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
    postgres_config: PostgresRuntimeConfig | None = None,
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
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_REPLAY,
                status='replay_reused',
                records_replayed=_safe_int(marker_payload.get('records')),
                last_source_ts=_utc_from_millis(
                    _safe_int(marker_payload.get('max_source_timestamp_ms'), default=0) or None
                ),
                payload={
                    'dump_format': marker_payload.get('dump_format'),
                    'reused_existing_replay': True,
                    'records_by_topic': marker_payload.get('records_by_topic', {}),
                    'replay_profile': marker_payload.get('replay_profile'),
                },
            )
            return marker_payload

    performance_cfg = _performance_config(manifest)
    replay_profile = _as_text(performance_cfg.get('replay_profile')) or DEFAULT_SIMULATION_REPLAY_PROFILE
    profile_defaults = REPLAY_PROFILE_DEFAULTS[replay_profile]
    replay_cfg = _as_mapping(manifest.get('replay'))
    pace_mode = (_as_text(replay_cfg.get('pace_mode')) or 'max_throughput').lower()
    acceleration = float(replay_cfg.get('acceleration') or 60.0)
    max_sleep_seconds = float(replay_cfg.get('max_sleep_seconds') or 5.0)
    status_update_every_records = max(
        1,
        _safe_int(
            replay_cfg.get('status_update_every_records'),
            default=int(profile_defaults['status_update_every_records']),
        ),
    )
    status_update_every_seconds = max(
        1.0,
        _safe_float(
            replay_cfg.get('status_update_every_seconds'),
            default=float(profile_defaults['status_update_every_seconds']),
        ),
    )
    flush_every_records = max(
        1,
        _safe_int(
            replay_cfg.get('flush_every_records'),
            default=int(profile_defaults['flush_every_records']),
        ),
    )
    flush_timeout_seconds = max(
        1.0,
        _safe_float(
            replay_cfg.get('flush_timeout_seconds'),
            default=float(profile_defaults['flush_timeout_seconds']),
        ),
    )
    final_flush_timeout_seconds = max(
        flush_timeout_seconds,
        _safe_float(
            replay_cfg.get('final_flush_timeout_seconds'),
            default=float(profile_defaults['final_flush_timeout_seconds']),
        ),
    )
    flush_retry_attempts = max(1, _safe_int(replay_cfg.get('flush_retry_attempts'), default=6))

    producer = _producer_for_replay(kafka_config, resources.run_token, profile=replay_profile)
    count = 0
    count_by_topic: dict[str, int] = {}
    previous_ts_ms: int | None = None
    checksum = hashlib.sha256()
    replay_topic_overrides = 0
    next_status_update_at = time.monotonic() + status_update_every_seconds
    replay_started_at = datetime.now(timezone.utc)
    try:
        with _open_dump_reader(dump_path) as handle:
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
                    _upsert_simulation_progress_row(
                        postgres_config=postgres_config,
                        resources=resources,
                        component=COMPONENT_REPLAY,
                        status='replaying',
                        records_replayed=count,
                        last_source_ts=_utc_from_millis(current_ts_ms),
                        payload={
                            'records_by_topic': count_by_topic,
                            'replay_profile': replay_profile,
                            'pace_mode': pace_mode,
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
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_REPLAY,
            status='replay_flush',
            records_replayed=count,
            last_source_ts=_utc_from_millis(previous_ts_ms),
            payload={
                'records_by_topic': count_by_topic,
                'flush_reason': 'completed',
                'replay_profile': replay_profile,
                'pace_mode': pace_mode,
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

    duration_seconds = max((datetime.now(timezone.utc) - replay_started_at).total_seconds(), 0.001)
    marker_payload = {
        'reused_existing_replay': False,
        'dump_format': _dump_format_for_path(dump_path),
        'replay_profile': replay_profile,
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
        'duration_seconds': duration_seconds,
        'records_per_second': count / duration_seconds if count > 0 else 0.0,
        'completed_at': datetime.now(timezone.utc).isoformat(),
    }
    _upsert_simulation_progress_row(
        postgres_config=postgres_config,
        resources=resources,
        component=COMPONENT_REPLAY,
        status='replayed',
        records_replayed=count,
        last_source_ts=_utc_from_millis(previous_ts_ms),
        terminal_state='complete',
        payload={
            'records_by_topic': count_by_topic,
            'dump_format': _dump_format_for_path(dump_path),
            'replay_profile': replay_profile,
            'pace_mode': pace_mode,
            'records_per_second': marker_payload['records_per_second'],
            'duration_seconds': duration_seconds,
        },
    )
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
    warm_lane_enabled = resources.warm_lane_enabled

    state_path, run_manifest_path, dump_path = _state_paths(resources, manifest)
    _ensure_directory(state_path)
    runtime_lock = _acquire_simulation_runtime_lock(
        resources=resources,
        state_path=state_path,
    )

    try:
        if state_path.exists():
            state = _load_json(state_path)
        else:
            state = _capture_cluster_state(resources)
            _save_json(state_path, state)

        ta_data = _as_mapping(state.get('ta_data'))
        ta_restore = _resolve_ta_restore_configuration(
            ta_data=ta_data,
            manifest=manifest,
        )
        if bool(ta_restore.get('fallback_applied')):
            _log_script_event(
                'Using stateless TA recovery for simulation run',
                run_id=resources.run_id,
                reason=ta_restore.get('reason'),
            )
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
        schema_registry_report = _ensure_simulation_schema_subjects(
            resources=resources,
            ta_data=ta_data,
        )
        clickhouse_database_precreated = _clickhouse_database_precreated(manifest)
        if not clickhouse_database_precreated:
            _ensure_clickhouse_database(config=clickhouse_config, database=resources.clickhouse_db)
        _ensure_clickhouse_runtime_tables(
            config=clickhouse_config,
            database=resources.clickhouse_db,
            lane=resources.lane,
        )
        postgres_database_precreated = _postgres_database_precreated(manifest)
        if not postgres_database_precreated:
            _ensure_postgres_database(postgres_config)
        postgres_permissions_report = _ensure_postgres_runtime_permissions(postgres_config)
        _run_migrations(postgres_config)
        _reset_postgres_runtime_state(postgres_config)
        seeded_cursor_at = _seed_simulation_trade_cursor(
            config=postgres_config,
            manifest=manifest,
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_REPLAY,
            status='pending',
            payload={'phase': 'apply'},
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_TA,
            status='pending',
            payload={'phase': 'runtime_verify'},
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_ARTIFACTS,
            status='pending',
            payload={'phase': 'report'},
        )

        dump_report = _dump_topics(
            resources=resources,
            kafka_config=kafka_config,
            manifest=manifest,
            dump_path=dump_path,
            force=force_dump,
            postgres_config=postgres_config,
        )
        dump_coverage = _validate_dump_coverage(
            manifest=manifest,
            dump_report=dump_report,
        )
        replay_cfg = _as_mapping(manifest.get('replay'))
        auto_offset_reset = (_as_text(replay_cfg.get('auto_offset_reset')) or 'earliest').lower()
        _configure_ta_for_simulation(
            resources=resources,
            clickhouse_config=clickhouse_config,
            clickhouse_database=resources.clickhouse_db,
            auto_offset_reset=auto_offset_reset,
            manifest=manifest,
        )
        ta_restart_nonce = _restart_ta_deployment(
            resources,
            desired_state='running',
            upgrade_mode=str(ta_restore.get('effective_upgrade_mode') or 'last-state'),
        )

        _configure_torghut_service_for_simulation(
            resources=resources,
            manifest=manifest,
            postgres_config=postgres_config,
            clickhouse_config=clickhouse_config,
            kafka_config=kafka_config,
            torghut_env_overrides=torghut_env_overrides,
        )
    except Exception:
        _release_simulation_runtime_lock(resources=resources)
        raise

    report = {
        'status': 'ok',
        'mode': 'apply',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'applied_at': datetime.now(timezone.utc).isoformat(),
        'state_path': str(state_path),
        'dump': dump_report,
        'dump_coverage': dump_coverage,
        'topics': topics_report,
        'schema_registry': schema_registry_report,
        'ta_restart_nonce': ta_restart_nonce,
        'warm_lane_enabled': warm_lane_enabled,
        'seeded_cursor_at': seeded_cursor_at.isoformat(),
        'resources': asdict(resources)
        | {
            'output_root': str(resources.output_root),
        },
        'postgres': {
            'simulation_dsn': _redact_dsn_credentials(postgres_config.simulation_dsn),
            'simulation_db': postgres_config.simulation_db,
            'database_precreated': postgres_database_precreated,
            'runtime_permissions': postgres_permissions_report,
        },
        'clickhouse': {
            'http_url': clickhouse_config.http_url,
            'database': resources.clickhouse_db,
            'database_precreated': clickhouse_database_precreated,
        },
        'simulation_lock': runtime_lock,
        'evidence_lineage': _simulation_evidence_lineage(manifest),
        'torghut_env_overrides': torghut_env_overrides,
        'ta_restore': ta_restore,
        'window_policy': window_policy,
    }
    _save_json(run_manifest_path, report)
    return report


def _teardown(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any] | None = None,
    allow_missing_state: bool,
) -> dict[str, Any]:
    _ensure_supported_binary('kubectl')
    warm_lane_enabled = resources.warm_lane_enabled
    state_path, run_manifest_path, dump_path = _state_paths(resources, manifest)
    if not state_path.exists():
        lock_report = _release_simulation_runtime_lock(resources=resources)
        if allow_missing_state:
            return {
                'status': 'ok',
                'mode': 'teardown',
                'run_id': resources.run_id,
                'teardown_at': datetime.now(timezone.utc).isoformat(),
                'state_found': False,
                'simulation_lock': lock_report,
            }
        raise SystemExit(f'state file not found: {state_path}')

    runtime_lock = _read_simulation_runtime_lock(resources.namespace)
    if runtime_lock is None:
        return {
            'status': 'degraded',
            'mode': 'teardown',
            'run_id': resources.run_id,
            'teardown_at': datetime.now(timezone.utc).isoformat(),
            'state_path': str(state_path),
            'run_manifest_path': str(run_manifest_path),
            'dump_path': str(dump_path),
            'simulation_lock': {'status': 'missing'},
            'skipped_restore': True,
            'reason': 'simulation_runtime_lock_missing_for_teardown',
        }
    if runtime_lock.get('run_id') != resources.run_id:
        return {
            'status': 'degraded',
            'mode': 'teardown',
            'run_id': resources.run_id,
            'teardown_at': datetime.now(timezone.utc).isoformat(),
            'state_path': str(state_path),
            'run_manifest_path': str(run_manifest_path),
            'dump_path': str(dump_path),
            'simulation_lock': {
                'status': 'not_owner',
                **runtime_lock,
            },
            'skipped_restore': True,
            'reason': 'simulation_runtime_lock_not_owned_by_run',
        }

    state = _load_json(state_path)
    _restore_ta_configuration(resources, state)
    _restore_torghut_env(resources, state)
    original_state = _as_text(state.get('ta_job_state')) or 'running'
    ta_restart_nonce = _restart_ta_deployment(resources, desired_state=original_state)
    lock_report = _release_simulation_runtime_lock(resources=resources)
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
        'warm_lane_enabled': warm_lane_enabled,
        'skipped_restore': False,
        'simulation_lock': lock_report,
    }
    _save_json(run_manifest_path.with_name('teardown-manifest.json'), report)
    return report


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
    automation_state = _read_argocd_automation_mode(config=config)
    current_mode = _normalized_automation_mode(_as_text(automation_state.get('mode')))
    root_sync_state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=config.root_app_name,
    )
    root_application_report = _set_argocd_application_sync_policy(
        config=config,
        app_name=config.root_app_name,
        desired_sync_policy=_manual_argocd_application_sync_policy(
            cast(Mapping[str, Any] | None, root_sync_state.get('sync_policy'))
        ),
    )
    applicationset_report = _set_argocd_automation_mode(
        config=config,
        desired_mode=config.desired_mode_during_run,
    )
    application_mode_report = _wait_for_argocd_application_mode(
        config=config,
        app_name=config.app_name,
        desired_mode=config.desired_mode_during_run,
    )
    return {
        'managed': True,
        'changed': root_application_report['changed'] or applicationset_report['changed'],
        'pointer': automation_state.get('pointer'),
        'previous_mode': current_mode,
        'desired_mode': config.desired_mode_during_run,
        'current_mode': application_mode_report['current_mode'],
        'applicationset_managed': True,
        'applicationset': applicationset_report,
        'root_application': root_application_report,
        'application': application_mode_report,
    }


def _restore_argocd_after_run(
    *,
    config: ArgocdAutomationConfig,
    previous_mode: str | None,
    previous_sync_policy: Mapping[str, Any] | None,
) -> dict[str, Any]:
    if not config.manage_automation:
        return {
            'managed': False,
            'changed': False,
            'restored_mode': None,
        }
    restored_mode = previous_mode
    if config.restore_mode_after_run != 'previous':
        restored_mode = config.restore_mode_after_run
    if restored_mode is None:
        restored_mode = 'auto'

    applicationset_report = _set_argocd_automation_mode(
        config=config,
        desired_mode=restored_mode,
    )
    root_application_report = _set_argocd_application_sync_policy(
        config=config,
        app_name=config.root_app_name,
        desired_sync_policy=previous_sync_policy,
    )
    application_mode_report = _wait_for_argocd_application_mode(
        config=config,
        app_name=config.app_name,
        desired_mode=restored_mode,
    )
    return {
        'managed': True,
        'changed': root_application_report['changed'] or applicationset_report['changed'],
        'restored_mode': restored_mode,
        'previous_mode': previous_mode,
        'current_mode': application_mode_report['current_mode'],
        'applicationset_managed': True,
        'applicationset': applicationset_report,
        'root_application': root_application_report,
        'application': application_mode_report,
    }


def _analysis_run_name(*, phase: str, run_token: str) -> str:
    kubernetes_run_token = _normalize_kubernetes_name_token(run_token)
    base = f'torghut-sim-{phase}-{kubernetes_run_token}'
    if len(base) <= 63:
        return base
    prefix = f'torghut-sim-{phase}-'
    remaining = 63 - len(prefix)
    return prefix + kubernetes_run_token[:remaining].rstrip('-')


def _analysis_run_args(
    *,
    phase: str,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    postgres_config: PostgresRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    rollouts_config: RolloutsAnalysisConfig,
) -> dict[str, str]:
    window_start, window_end = _resolve_window_bounds(manifest)
    args: dict[str, str] = {
        'runId': resources.run_id,
        'datasetId': resources.dataset_id,
        'runToken': resources.run_token,
        'namespace': resources.namespace,
        'torghutService': resources.torghut_service,
        'taConfigmap': resources.ta_configmap,
        'taDeployment': resources.ta_deployment,
        'forecastService': resources.torghut_forecast_service,
        'windowStart': window_start.isoformat(),
        'windowEnd': window_end.isoformat(),
        'signalTable': resources.clickhouse_signal_table,
        'priceTable': resources.clickhouse_price_table,
        'postgresDatabase': postgres_config.simulation_db,
        'clickhouseHttpUrl': clickhouse_config.http_url,
        'clickhouseUsername': clickhouse_config.username or '',
        'runtimeVerifyTimeoutSeconds': str(rollouts_config.verify_timeout_seconds),
        'runtimeVerifyPollSeconds': str(rollouts_config.verify_poll_seconds),
    }
    monitor = _as_mapping(manifest.get('monitor'))
    if phase == 'activity':
        args.update(
            {
                'monitorTimeoutSeconds': str(
                    _safe_int(monitor.get('timeout_seconds'), default=DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS)
                ),
                'monitorPollSeconds': str(
                    _safe_int(monitor.get('poll_seconds'), default=DEFAULT_RUN_MONITOR_POLL_SECONDS)
                ),
                'minTradeDecisions': str(
                    _safe_int(monitor.get('min_trade_decisions'), default=DEFAULT_RUN_MONITOR_MIN_DECISIONS)
                ),
                'minExecutions': str(
                    _safe_int(monitor.get('min_executions'), default=DEFAULT_RUN_MONITOR_MIN_EXECUTIONS)
                ),
                'minExecutionTcaMetrics': str(
                    _safe_int(
                        monitor.get('min_execution_tca_metrics'),
                        default=DEFAULT_RUN_MONITOR_MIN_TCA,
                    )
                ),
                'minExecutionOrderEvents': str(
                    _safe_int(
                        monitor.get('min_execution_order_events'),
                        default=DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
                    )
                ),
                'cursorGraceSeconds': str(
                    _safe_int(
                        monitor.get('cursor_grace_seconds'),
                        default=DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
                    )
                ),
            }
        )
    return args


def _render_analysis_run_spec(
    *,
    rollouts_config: RolloutsAnalysisConfig,
    template_name: str,
    name: str,
    args_by_name: Mapping[str, str],
) -> dict[str, Any]:
    template_payload = _kubectl_json(
        rollouts_config.namespace,
        ['get', 'analysistemplate', template_name, '-o', 'json'],
    )
    template_spec = _as_mapping(template_payload.get('spec'))
    template_args = template_spec.get('args')
    resolved_args: list[dict[str, Any]] = []
    if isinstance(template_args, list):
        for raw_arg in template_args:
            if not isinstance(raw_arg, Mapping):
                continue
            entry = _as_mapping(raw_arg)
            arg_name = _as_text(entry.get('name'))
            if arg_name is None:
                continue
            resolved: dict[str, Any] = {'name': arg_name}
            if arg_name in args_by_name:
                resolved['value'] = args_by_name[arg_name]
            elif 'value' in entry:
                resolved['value'] = entry.get('value')
            elif 'valueFrom' in entry:
                resolved['valueFrom'] = entry.get('valueFrom')
            else:
                raise RuntimeError(f'missing_analysis_template_arg:{template_name}:{arg_name}')
            resolved_args.append(resolved)

    metrics = template_spec.get('metrics')
    if not isinstance(metrics, list) or not metrics:
        raise RuntimeError(f'invalid_analysis_template_metrics:{template_name}')

    analysis_run_spec: dict[str, Any] = {
        'args': resolved_args,
        'metrics': metrics,
    }
    for key in ('dryRun', 'measurementRetention'):
        if key in template_spec:
            analysis_run_spec[key] = template_spec[key]

    return {
        'apiVersion': 'argoproj.io/v1alpha1',
        'kind': 'AnalysisRun',
        'metadata': {
            'name': name,
            'namespace': rollouts_config.namespace,
            'labels': {
                'app.kubernetes.io/name': 'torghut',
                'torghut.proompteng.ai/analysis-template': template_name,
            },
        },
        'spec': analysis_run_spec,
    }


def _wait_for_analysis_run(
    *,
    namespace: str,
    name: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
    while True:
        payload = _kubectl_json(namespace, ['get', 'analysisrun', name, '-o', 'json'])
        status = _as_mapping(payload.get('status'))
        phase = _as_text(status.get('phase')) or 'Pending'
        metric_results = status.get('metricResults')
        report = {
            'name': name,
            'namespace': namespace,
            'phase': phase,
            'message': _as_text(status.get('message')),
            'started_at': _as_text(status.get('startedAt')),
            'completed_at': _as_text(status.get('completedAt')),
            'metric_results': metric_results if isinstance(metric_results, list) else [],
        }
        if phase in {'Successful', 'Failed', 'Error', 'Inconclusive'}:
            report['status'] = 'ok' if phase == 'Successful' else 'degraded'
            return report
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(f'analysisrun_timeout:{name}:{phase}')
        time.sleep(5)


def _wait_for_runtime_verify(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    timeout_seconds: int,
    poll_seconds: int,
) -> dict[str, Any]:
    deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
    report = _runtime_verify(resources=resources, manifest=manifest)
    while report.get('runtime_state') != 'ready':
        if datetime.now(timezone.utc) >= deadline:
            return report
        time.sleep(poll_seconds)
        report = _runtime_verify(resources=resources, manifest=manifest)
    return report


def _run_rollouts_analysis(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    postgres_config: PostgresRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    rollouts_config: RolloutsAnalysisConfig,
    phase: str,
    template_name: str,
) -> dict[str, Any]:
    analysis_name = _analysis_run_name(phase=phase, run_token=resources.run_token)
    _kubectl_delete_if_exists(rollouts_config.namespace, 'analysisrun', analysis_name)
    payload = _render_analysis_run_spec(
        rollouts_config=rollouts_config,
        template_name=template_name,
        name=analysis_name,
        args_by_name=_analysis_run_args(
            phase=phase,
            resources=resources,
            manifest=manifest,
            postgres_config=postgres_config,
            clickhouse_config=clickhouse_config,
            rollouts_config=rollouts_config,
        ),
    )
    _kubectl_apply(rollouts_config.namespace, payload)
    return _wait_for_analysis_run(
        namespace=rollouts_config.namespace,
        name=analysis_name,
        timeout_seconds=rollouts_config.verify_timeout_seconds,
    )


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


def _doc29_simulation_gate_ids(manifest: Mapping[str, Any]) -> list[str]:
    window = _as_mapping(manifest.get('window'))
    profile = (_as_text(window.get('profile')) or '').strip().lower() or None
    min_coverage_minutes = _safe_int(window.get('min_coverage_minutes'), default=0)
    if profile == US_EQUITIES_REGULAR_PROFILE or min_coverage_minutes >= US_EQUITIES_REGULAR_MINUTES:
        return [DOC29_SIMULATION_FULL_DAY_GATE]
    return [DOC29_SIMULATION_SMOKE_GATE]


def _decimal_or_zero(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return Decimal(stripped)
            except Exception:
                return Decimal('0')
    return Decimal('0')


def _has_decimal_value(value: Any) -> bool:
    if isinstance(value, Decimal):
        return True
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return False
        try:
            Decimal(stripped)
        except Exception:
            return False
        return True
    return False


def _build_fill_price_error_budget_payload(
    *,
    resources: SimulationResources,
    analytics_report: Mapping[str, Any] | None,
    manifest: Mapping[str, Any],
) -> tuple[dict[str, Any] | None, Path | None]:
    analytics_payload = _as_mapping(analytics_report)
    execution_quality = _as_mapping(analytics_payload.get('execution_quality'))
    slippage_payload = _as_mapping(execution_quality.get('slippage_bps'))
    if not slippage_payload:
        return None, None
    reporting = _as_mapping(manifest.get('reporting'))
    budget_payload = _as_mapping(manifest.get('fill_price_error_budget'))
    metric_observation_complete = all(
        _has_decimal_value(slippage_payload.get(key))
        for key in ('p50_abs', 'p95_abs', 'max_abs')
    )
    venue = (
        _as_text(budget_payload.get('venue'))
        or _as_text(reporting.get('venue'))
        or 'us_equities'
    )
    report = build_fill_price_error_budget_report_v1(
        run_id=resources.run_id,
        venue=venue,
        order_count=_safe_int(_as_mapping(analytics_payload.get('funnel')).get('execution_tca_metrics')),
        median_abs_slippage_bps=_decimal_or_zero(slippage_payload.get('p50_abs')),
        p95_abs_slippage_bps=_decimal_or_zero(slippage_payload.get('p95_abs')),
        max_abs_slippage_bps=_decimal_or_zero(slippage_payload.get('max_abs')),
        budget_median_abs_slippage_bps=_decimal_or_zero(
            budget_payload.get('budget_median_abs_slippage_bps') or reporting.get('budget_median_abs_slippage_bps') or '12'
        ),
        budget_p95_abs_slippage_bps=_decimal_or_zero(
            budget_payload.get('budget_p95_abs_slippage_bps') or reporting.get('budget_p95_abs_slippage_bps') or '25'
        ),
        metric_observation_complete=metric_observation_complete,
    )
    artifact_path = _artifact_path(resources, 'gates/fill-price-error-budget-report-v1.json')
    _save_json(artifact_path, report.to_payload())
    return report.to_payload(), artifact_path


def _build_strategy_proof_artifact(
    *,
    postgres_config: PostgresRuntimeConfig,
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    def _query() -> dict[str, Any]:
        with psycopg.connect(postgres_config.torghut_runtime_dsn) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT COALESCE(s.universe_type, 'unknown') AS strategy_type, count(*)::bigint
                    FROM trade_decisions td
                    LEFT JOIN strategies s ON s.id = td.strategy_id
                    GROUP BY 1
                    ORDER BY 2 DESC, 1 ASC
                    """
                )
                strategy_rows = cursor.fetchall() or []
                cursor.execute(
                    """
                    SELECT
                      COALESCE(sum(CASE WHEN execution_fallback_count > 0 THEN 1 ELSE 0 END), 0)::bigint,
                      COALESCE(sum(execution_fallback_count), 0)::bigint
                    FROM executions
                    """
                )
                fallback_row = cursor.fetchone() or (0, 0)
        strategy_types = [
            {
                'strategy_type': str(row[0]),
                'count': _safe_int(row[1]),
            }
            for row in strategy_rows
        ]
        legacy_path_count = sum(
            item['count']
            for item in strategy_types
            if any(token in item['strategy_type'] for token in LEGACY_SIMULATION_STRATEGY_TOKENS)
        )
        return {
            'status': 'ok',
            'expected_candidate_id': _as_text(manifest.get('candidate_id')),
            'expected_strategy_spec_ref': _as_text(manifest.get('strategy_spec_ref')),
            'model_refs': _as_string_list(manifest.get('model_refs')),
            'strategy_types': strategy_types,
            'legacy_path_count': legacy_path_count,
            'fallback_order_count': _safe_int(fallback_row[0]),
            'fallback_invocation_count': _safe_int(fallback_row[1]),
            'promotable': legacy_path_count == 0,
        }

    return cast(
        dict[str, Any],
        _run_with_transient_postgres_retry(
            label='strategy_proof',
            operation=_query,
        ),
    )


def _build_performance_report(
    *,
    manifest: Mapping[str, Any],
    apply_report: Mapping[str, Any] | None,
    replay_report: Mapping[str, Any] | None,
    monitor_report: Mapping[str, Any] | None,
) -> dict[str, Any]:
    performance_cfg = _performance_config(manifest)
    monitor_payload = _as_mapping(monitor_report)
    return {
        'status': 'ok',
        'cache_policy': _as_text(performance_cfg.get('cache_policy')) or 'prefer_cache',
        'replay_profile': _as_text(performance_cfg.get('replay_profile')) or DEFAULT_SIMULATION_REPLAY_PROFILE,
        'dump_format': _as_text(performance_cfg.get('dump_format')) or DEFAULT_SIMULATION_DUMP_FORMAT,
        'dump': _as_mapping(_as_mapping(apply_report).get('dump')),
        'replay': _as_mapping(replay_report),
        'monitor_profile': _as_text(_as_mapping(monitor_payload.get('monitor')).get('profile')),
        'monitor_poll_count': _safe_int(monitor_payload.get('poll_count')),
        'effective_terminal_signal_ts': _as_text(monitor_payload.get('effective_terminal_signal_ts')),
        'cursor_gap_seconds': monitor_payload.get('cursor_gap_seconds'),
    }


def _build_run_summary(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    runtime_verify_report: Mapping[str, Any] | None,
    monitor_report: Mapping[str, Any] | None,
    analytics_report: Mapping[str, Any] | None,
    strategy_proof_report: Mapping[str, Any] | None,
    errors: Sequence[str],
) -> dict[str, Any]:
    monitor_payload = _as_mapping(monitor_report)
    final_snapshot = _as_mapping(monitor_payload.get('final_snapshot'))
    return {
        'status': 'ok' if not errors else 'error',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'candidate_id': _as_text(manifest.get('candidate_id')),
        'strategy_spec_ref': _as_text(manifest.get('strategy_spec_ref')),
        'runtime_state': _as_text(_as_mapping(runtime_verify_report).get('runtime_state')),
        'activity_classification': _as_text(monitor_payload.get('activity_classification')),
        'effective_terminal_signal_ts': _as_text(monitor_payload.get('effective_terminal_signal_ts')),
        'cursor_at': _as_text(final_snapshot.get('cursor_at')),
        'trade_decisions': _safe_int(final_snapshot.get('trade_decisions')),
        'executions': _safe_int(final_snapshot.get('executions')),
        'execution_tca_metrics': _safe_int(final_snapshot.get('execution_tca_metrics')),
        'execution_order_events': _safe_int(final_snapshot.get('execution_order_events')),
        'legacy_path_count': _safe_int(_as_mapping(strategy_proof_report).get('legacy_path_count')),
        'fallback_order_count': _safe_int(_as_mapping(strategy_proof_report).get('fallback_order_count')),
        'report_dir': _as_text(_as_mapping(analytics_report).get('report_dir')),
        'errors': list(errors),
    }


def _build_gate_input(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    monitor_report: Mapping[str, Any] | None,
    strategy_proof_report: Mapping[str, Any] | None,
    fill_price_error_budget_report: Mapping[str, Any] | None,
) -> dict[str, Any]:
    final_snapshot = _as_mapping(_as_mapping(monitor_report).get('final_snapshot'))
    return {
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'candidate_id': _as_text(manifest.get('candidate_id')),
        'baseline_candidate_id': _as_text(manifest.get('baseline_candidate_id')),
        'strategy_spec_ref': _as_text(manifest.get('strategy_spec_ref')),
        'model_refs': _as_string_list(manifest.get('model_refs')),
        'activity_classification': _as_text(_as_mapping(monitor_report).get('activity_classification')),
        'effective_terminal_signal_ts': _as_text(_as_mapping(monitor_report).get('effective_terminal_signal_ts')),
        'cursor_at': _as_text(final_snapshot.get('cursor_at')),
        'trade_decisions': _safe_int(final_snapshot.get('trade_decisions')),
        'executions': _safe_int(final_snapshot.get('executions')),
        'execution_tca_metrics': _safe_int(final_snapshot.get('execution_tca_metrics')),
        'execution_order_events': _safe_int(final_snapshot.get('execution_order_events')),
        'strategy_proof': _as_mapping(strategy_proof_report),
        'fill_price_error_budget': _as_mapping(fill_price_error_budget_report),
    }


def _existing_artifact_refs(resources: SimulationResources, analytics_report: Mapping[str, Any] | None) -> list[str]:
    artifact_candidates = [
        _artifact_path(resources, 'run-manifest.json'),
        _artifact_path(resources, 'run-full-lifecycle-manifest.json'),
        _artifact_path(resources, 'runtime-verify.json'),
        _artifact_path(resources, 'replay-report.json'),
        _artifact_path(resources, 'signal-activity.json'),
        _artifact_path(resources, 'decision-activity.json'),
        _artifact_path(resources, 'execution-activity.json'),
        _artifact_path(resources, 'activity-debug.json'),
        _artifact_path(resources, 'strategy-proof.json'),
        _artifact_path(resources, 'performance.json'),
        _artifact_path(resources, 'run-summary.json'),
        _artifact_path(resources, 'gate-input.json'),
        _artifact_path(resources, 'gates/fill-price-error-budget-report-v1.json'),
    ]
    report_dir = _as_text(_as_mapping(analytics_report).get('report_dir'))
    if report_dir:
        for path in sorted(Path(report_dir).glob('*')):
            if path.is_file():
                artifact_candidates.append(path)
    refs: list[str] = []
    for candidate in artifact_candidates:
        if isinstance(candidate, Path) and candidate.exists():
            refs.append(str(candidate))
    return refs


def _build_simulation_completion_trace(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    postgres_config: PostgresRuntimeConfig,
    apply_report: Mapping[str, Any] | None,
    runtime_verify_report: Mapping[str, Any] | None,
    monitor_report: Mapping[str, Any] | None,
    analytics_report: Mapping[str, Any] | None,
    fill_price_error_budget_report: Mapping[str, Any] | None,
    rollouts_report: Mapping[str, Any] | None,
    errors: Sequence[str],
) -> dict[str, Any]:
    gate_ids_attempted = _doc29_simulation_gate_ids(manifest)
    apply_payload = _as_mapping(apply_report)
    runtime_payload = _as_mapping(runtime_verify_report)
    monitor_payload = _as_mapping(monitor_report)
    analytics_payload = _as_mapping(analytics_report)
    rollouts_payload = _as_mapping(rollouts_report)
    final_snapshot = _as_mapping(monitor_payload.get('final_snapshot'))
    window_policy = _as_mapping(apply_payload.get('window_policy'))
    dump_coverage = _as_mapping(apply_payload.get('dump_coverage'))
    trade_decisions = _safe_int(final_snapshot.get('trade_decisions'))
    executions = _safe_int(final_snapshot.get('executions'))
    execution_tca_metrics = _safe_int(final_snapshot.get('execution_tca_metrics'))
    execution_order_events = _safe_int(final_snapshot.get('execution_order_events'))
    activity_classification = _as_text(monitor_payload.get('activity_classification')) or 'unknown'
    runtime_state = _as_text(runtime_payload.get('runtime_state')) or 'unknown'
    coverage_ratio = float(dump_coverage.get('coverage_ratio') or 0.0)
    strict_ratio = float(window_policy.get('strict_coverage_ratio') or 0.0)
    fill_price_payload = _as_mapping(fill_price_error_budget_report)
    gate_results: dict[str, dict[str, Any]] = {}
    blocked_reasons: dict[str, str] = {}
    artifact_refs = _existing_artifact_refs(resources, analytics_payload)

    for gate_id in gate_ids_attempted:
        requires_runtime_ready = gate_id == DOC29_SIMULATION_SMOKE_GATE
        satisfied = (
            activity_classification == 'success'
            and trade_decisions >= 1
            and executions >= 1
            and execution_tca_metrics >= 1
            and execution_order_events >= 1
            and (runtime_state == 'ready' or not requires_runtime_ready)
        )
        if gate_id == DOC29_SIMULATION_FULL_DAY_GATE:
            satisfied = satisfied and coverage_ratio >= strict_ratio and _safe_int(
                window_policy.get('min_coverage_minutes')
            ) >= US_EQUITIES_REGULAR_MINUTES
        blocked_reason = None
        if not satisfied:
            if requires_runtime_ready and runtime_state != 'ready':
                blocked_reason = 'runtime_not_ready'
            elif activity_classification != 'success':
                blocked_reason = f'activity_classification:{activity_classification}'
            elif trade_decisions <= 0:
                blocked_reason = 'trade_decisions_empty'
            elif executions <= 0:
                blocked_reason = 'executions_empty'
            elif execution_tca_metrics <= 0:
                blocked_reason = 'execution_tca_metrics_empty'
            elif execution_order_events <= 0:
                blocked_reason = 'execution_order_events_empty'
            else:
                blocked_reason = 'coverage_threshold_not_met'
            blocked_reasons[gate_id] = blocked_reason
        gate_results[gate_id] = {
            'status': TRACE_STATUS_SATISFIED if satisfied else TRACE_STATUS_BLOCKED,
            'blocked_reason': blocked_reason,
            'artifact_ref': str(_artifact_path(resources, 'run-full-lifecycle-manifest.json')),
            'acceptance_snapshot': {
                'runtime_state': runtime_state,
                'activity_classification': activity_classification,
                'trade_decisions': trade_decisions,
                'executions': executions,
                'execution_tca_metrics': execution_tca_metrics,
                'execution_order_events': execution_order_events,
                'coverage_ratio': coverage_ratio,
                'strict_coverage_ratio': strict_ratio,
                'min_coverage_minutes': _safe_int(window_policy.get('min_coverage_minutes')),
                'fill_price_error_budget_status': _as_text(fill_price_payload.get('status')),
                'fill_price_error_budget_artifact_ref': (
                    str(_artifact_path(resources, 'gates/fill-price-error-budget-report-v1.json'))
                    if fill_price_payload
                    else None
                ),
            },
        }
    return build_completion_trace(
        doc_id='doc29',
        gate_ids_attempted=gate_ids_attempted,
        run_id=resources.run_id,
        dataset_snapshot_ref=_as_text(manifest.get('dataset_snapshot_ref')),
        candidate_id=_as_text(manifest.get('candidate_id')),
        workflow_name=_as_text(os.getenv('ARGO_WORKFLOW_NAME')) or f'torghut-historical-simulation:{resources.run_id}',
        analysis_run_names=[
            _as_text(_as_mapping(rollouts_payload.get('runtime_analysis_run')).get('name')) or '',
            _as_text(_as_mapping(rollouts_payload.get('activity_analysis_run')).get('name')) or '',
            _as_text(_as_mapping(rollouts_payload.get('teardown_analysis_run')).get('name')) or '',
        ],
        artifact_refs=artifact_refs,
        db_row_refs={
            'simulation_postgres_db': postgres_config.simulation_db,
            'simulation_clickhouse_db': resources.clickhouse_db,
            'funnel_counts': {
                'trade_decisions': trade_decisions,
                'executions': executions,
                'execution_tca_metrics': execution_tca_metrics,
                'execution_order_events': execution_order_events,
            },
            'fill_price_error_budget': fill_price_payload,
        },
        status_snapshot={
            'runtime_state': runtime_state,
            'activity_classification': activity_classification,
            'errors': list(errors),
            'rollouts': {
                'runtime_analysis_run': _as_text(_as_mapping(rollouts_payload.get('runtime_analysis_run')).get('name')),
                'activity_analysis_run': _as_text(_as_mapping(rollouts_payload.get('activity_analysis_run')).get('name')),
                'teardown_analysis_run': _as_text(_as_mapping(rollouts_payload.get('teardown_analysis_run')).get('name')),
            },
        },
        result_by_gate=gate_results,
        blocked_reasons=blocked_reasons,
    )


def _run_full_lifecycle(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    manifest_path: Path,
    kafka_config: KafkaRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    postgres_config: PostgresRuntimeConfig,
    argocd_config: ArgocdAutomationConfig,
    rollouts_config: RolloutsAnalysisConfig,
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
    replay_report: dict[str, Any] | None = None
    runtime_verify_report: dict[str, Any] | None = None
    monitor_report: dict[str, Any] | None = None
    analytics_report: dict[str, Any] | None = None
    strategy_proof_report: dict[str, Any] | None = None
    performance_report: dict[str, Any] | None = None
    run_summary_report: dict[str, Any] | None = None
    gate_input_report: dict[str, Any] | None = None
    fill_price_error_budget_report: dict[str, Any] | None = None
    teardown_report: dict[str, Any] | None = None
    rollouts_report: dict[str, Any] = {
        'enabled': bool(
            rollouts_config.enabled
            and resources.target_mode == 'dedicated_service'
        ),
        'runtime_analysis_run': None,
        'activity_analysis_run': None,
        'teardown_analysis_run': None,
        'artifact_analysis_run': None,
    }
    errors: list[str] = []
    previous_automation_mode: str | None = None
    argocd_prepare_succeeded = False
    argocd_restore_required = False
    previous_root_application_sync_policy: dict[str, Any] | None = None
    teardown_succeeded = False

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
                current_root_app_state = _read_named_argocd_application_sync_policy(
                    namespace=argocd_config.applicationset_namespace,
                    app_name=argocd_config.root_app_name,
                )
                previous_root_application_sync_policy = _clone_json_mapping(
                    cast(Mapping[str, Any] | None, current_root_app_state.get('sync_policy'))
                )
                current_app_state = _read_argocd_application_sync_policy(config=argocd_config)
                argocd_restore_required = (
                    previous_automation_mode != _normalized_automation_mode(argocd_config.desired_mode_during_run)
                )
                if _normalized_automation_mode(_as_text(current_app_state.get('automation_mode'))) != 'manual':
                    argocd_restore_required = True
            argocd_prepare_report = _prepare_argocd_for_run(config=argocd_config)
            if previous_automation_mode is None:
                previous_automation_mode = _as_text(argocd_prepare_report.get('previous_mode'))
            if previous_root_application_sync_policy is None:
                application_report = _as_mapping(argocd_prepare_report.get('root_application'))
                previous_root_application_sync_policy = _clone_json_mapping(
                    cast(Mapping[str, Any] | None, application_report.get('previous_sync_policy'))
                )
            argocd_prepare_succeeded = True
            _update_run_state(
                resources=resources,
                phase='argocd_prepare',
                status='ok',
                details=argocd_prepare_report,
            )

        if not report_only:
            _update_run_state(resources=resources, phase='dataset_prepare', status='running')
            apply_report = _apply(
                resources=resources,
                manifest=manifest,
                kafka_config=kafka_config,
                clickhouse_config=clickhouse_config,
                postgres_config=postgres_config,
                force_dump=force_dump,
                force_replay=force_replay,
            )
            _save_json(_artifact_path(resources, 'run-manifest.json'), apply_report)
            _update_run_state(resources=resources, phase='dataset_prepare', status='ok')

            _update_run_state(resources=resources, phase='runtime_verify', status='running')
            if bool(rollouts_report['enabled']):
                runtime_analysis_run = _run_rollouts_analysis(
                    resources=resources,
                    manifest=manifest,
                    postgres_config=postgres_config,
                    clickhouse_config=clickhouse_config,
                    rollouts_config=rollouts_config,
                    phase='runtime-ready',
                    template_name=rollouts_config.runtime_template,
                )
                rollouts_report['runtime_analysis_run'] = runtime_analysis_run
                runtime_verify_report = _runtime_verify(resources=resources, manifest=manifest)
            else:
                runtime_verify_report = _wait_for_runtime_verify(
                    resources=resources,
                    manifest=manifest,
                    timeout_seconds=rollouts_config.verify_timeout_seconds,
                    poll_seconds=rollouts_config.verify_poll_seconds,
                )
            runtime_verify_report['analysis_run'] = rollouts_report['runtime_analysis_run']
            _save_json(_artifact_path(resources, 'runtime-verify.json'), runtime_verify_report)
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_TA,
                status='ready' if runtime_verify_report.get('runtime_state') == 'ready' else 'not_ready',
                terminal_state='complete' if runtime_verify_report.get('runtime_state') == 'ready' else None,
                payload=runtime_verify_report,
            )
            _update_run_state(
                resources=resources,
                phase='runtime_verify',
                status='ok' if runtime_verify_report.get('runtime_state') == 'ready' else 'error',
                details=runtime_verify_report,
            )
            if runtime_verify_report.get('runtime_state') != 'ready' or (
                bool(rollouts_report['enabled'])
                and _as_mapping(cast(Mapping[str, Any], rollouts_report['runtime_analysis_run'])).get('phase') != 'Successful'
            ):
                runtime_failure = {
                    'reason': 'environment_incomplete',
                    'runtime_state': runtime_verify_report.get('runtime_state'),
                    'analysis_run': rollouts_report['runtime_analysis_run'],
                }
                _update_run_state(
                    resources=resources,
                    phase='replay',
                    status='skipped',
                    details=runtime_failure,
                )
                _update_run_state(
                    resources=resources,
                    phase='activity_verify',
                    status='skipped',
                    details=runtime_failure,
                )
                raise RuntimeError('environment_incomplete')

            _update_run_state(resources=resources, phase='replay', status='running')
            replay_report = _replay_dump(
                resources=resources,
                kafka_config=kafka_config,
                manifest=manifest,
                dump_path=_state_paths(resources, manifest)[2],
                force=force_replay,
                postgres_config=postgres_config,
            )
            _save_json(_artifact_path(resources, 'replay-report.json'), replay_report)
            _update_run_state(
                resources=resources,
                phase='replay',
                status='ok',
                details=replay_report,
            )

            _update_run_state(resources=resources, phase='activity_verify', status='running')
            monitor_report = _monitor_run_completion(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify=runtime_verify_report,
            )
            final_snapshot = _as_mapping(monitor_report.get('final_snapshot'))
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_TORGHUT,
                status='activity_verified',
                last_signal_ts=_parse_optional_rfc3339_timestamp(
                    _as_text(final_snapshot.get('last_signal_ts'))
                ),
                last_price_ts=_parse_optional_rfc3339_timestamp(
                    _as_text(final_snapshot.get('last_price_ts'))
                ),
                cursor_at=_parse_optional_rfc3339_timestamp(
                    _as_text(final_snapshot.get('cursor_at'))
                ),
                trade_decisions=_safe_int(final_snapshot.get('trade_decisions')),
                executions=_safe_int(final_snapshot.get('executions')),
                execution_tca_metrics=_safe_int(final_snapshot.get('execution_tca_metrics')),
                execution_order_events=_safe_int(final_snapshot.get('execution_order_events')),
                legacy_path_count=_safe_int(final_snapshot.get('legacy_path_count')),
                fallback_count=_safe_int(final_snapshot.get('fallback_count')),
                terminal_state='complete'
                if _as_text(monitor_report.get('activity_classification')) == 'success'
                else None,
                payload={
                    'activity_classification': monitor_report.get('activity_classification'),
                    'effective_terminal_signal_ts': monitor_report.get('effective_terminal_signal_ts'),
                },
            )
            if bool(rollouts_report['enabled']):
                try:
                    activity_analysis_run = _run_rollouts_analysis(
                        resources=resources,
                        manifest=manifest,
                        postgres_config=postgres_config,
                        clickhouse_config=clickhouse_config,
                        rollouts_config=rollouts_config,
                        phase='activity',
                        template_name=rollouts_config.activity_template,
                    )
                except Exception as exc:
                    activity_analysis_run = {
                        'status': 'error',
                        'phase': 'Error',
                        'message': str(exc),
                    }
                rollouts_report['activity_analysis_run'] = activity_analysis_run
            monitor_report['analysis_run'] = rollouts_report['activity_analysis_run']
            _save_json(_artifact_path(resources, 'activity-debug.json'), monitor_report)
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_ARTIFACTS,
                status='activity_verified',
                last_signal_ts=_parse_optional_rfc3339_timestamp(
                    _as_text(_as_mapping(monitor_report.get('final_snapshot')).get('last_signal_ts'))
                ),
                last_price_ts=_parse_optional_rfc3339_timestamp(
                    _as_text(_as_mapping(monitor_report.get('final_snapshot')).get('last_price_ts'))
                ),
                cursor_at=_parse_optional_rfc3339_timestamp(
                    _as_text(_as_mapping(monitor_report.get('final_snapshot')).get('cursor_at'))
                ),
                payload=monitor_report,
            )
            _save_json(_artifact_path(resources, 'signal-activity.json'), {
                'activity_classification': monitor_report.get('activity_classification'),
                'signal_rows': _as_mapping(monitor_report.get('final_snapshot')).get('signal_rows'),
                'price_rows': _as_mapping(monitor_report.get('final_snapshot')).get('price_rows'),
                'analysis_run': rollouts_report['activity_analysis_run'],
            })
            _save_json(_artifact_path(resources, 'decision-activity.json'), {
                'activity_classification': monitor_report.get('activity_classification'),
                'trade_decisions': _as_mapping(monitor_report.get('final_snapshot')).get('trade_decisions'),
                'cursor_at': _as_mapping(monitor_report.get('final_snapshot')).get('cursor_at'),
                'analysis_run': rollouts_report['activity_analysis_run'],
            })
            _save_json(_artifact_path(resources, 'execution-activity.json'), {
                'activity_classification': monitor_report.get('activity_classification'),
                'executions': _as_mapping(monitor_report.get('final_snapshot')).get('executions'),
                'execution_tca_metrics': _as_mapping(monitor_report.get('final_snapshot')).get('execution_tca_metrics'),
                'execution_order_events': _as_mapping(monitor_report.get('final_snapshot')).get('execution_order_events'),
                'analysis_run': rollouts_report['activity_analysis_run'],
            })
            _update_run_state(
                resources=resources,
                phase='activity_verify',
                status='ok' if monitor_report.get('activity_classification') == 'success' else 'degraded',
                details=monitor_report,
            )
            activity_classification = _as_text(monitor_report.get('activity_classification')) or 'unknown'
            if activity_classification != 'success':
                errors.append(f'activity:{activity_classification}')
        else:
            _update_run_state(
                resources=resources,
                phase='dataset_prepare',
                status='skipped',
                details={'report_only': True},
            )
            _update_run_state(
                resources=resources,
                phase='runtime_verify',
                status='skipped',
                details={'report_only': True},
            )
            _update_run_state(
                resources=resources,
                phase='replay',
                status='skipped',
                details={'report_only': True},
            )
            _update_run_state(
                resources=resources,
                phase='activity_verify',
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
        strategy_proof_report = _build_strategy_proof_artifact(
            postgres_config=postgres_config,
            manifest=manifest,
        )
        _save_json(_artifact_path(resources, 'strategy-proof.json'), strategy_proof_report)
        fill_price_error_budget_report, _ = _build_fill_price_error_budget_payload(
            resources=resources,
            analytics_report=analytics_report,
            manifest=manifest,
        )
        performance_report = _build_performance_report(
            manifest=manifest,
            apply_report=apply_report,
            replay_report=replay_report,
            monitor_report=monitor_report,
        )
        _save_json(_artifact_path(resources, 'performance.json'), performance_report)
        gate_input_report = _build_gate_input(
            resources=resources,
            manifest=manifest,
            monitor_report=monitor_report,
            strategy_proof_report=strategy_proof_report,
            fill_price_error_budget_report=fill_price_error_budget_report,
        )
        _save_json(_artifact_path(resources, 'gate-input.json'), gate_input_report)
        run_summary_report = _build_run_summary(
            resources=resources,
            manifest=manifest,
            runtime_verify_report=runtime_verify_report,
            monitor_report=monitor_report,
            analytics_report=analytics_report,
            strategy_proof_report=strategy_proof_report,
            errors=errors,
        )
        _save_json(_artifact_path(resources, 'run-summary.json'), run_summary_report)
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_TORGHUT,
            status='reported',
            strategy_type=_as_text(strategy_proof_report.get('strategy_type')),
            legacy_path_count=_safe_int(strategy_proof_report.get('legacy_path_count')),
            fallback_count=_safe_int(strategy_proof_report.get('fallback_order_count')),
            terminal_state='complete',
            payload={
                'strategy_type': strategy_proof_report.get('strategy_type'),
                'legacy_path_count': strategy_proof_report.get('legacy_path_count'),
                'fallback_order_count': strategy_proof_report.get('fallback_order_count'),
            },
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_ARTIFACTS,
            status='reported',
            terminal_state='complete',
            strategy_type=_as_text(strategy_proof_report.get('strategy_type')),
            legacy_path_count=_safe_int(strategy_proof_report.get('legacy_path_count')),
            fallback_count=_safe_int(strategy_proof_report.get('fallback_count')),
            payload={
                'activity_debug_path': str(_artifact_path(resources, 'activity-debug.json')),
                'strategy_proof_path': str(_artifact_path(resources, 'strategy-proof.json')),
                'performance_path': str(_artifact_path(resources, 'performance.json')),
                'run_summary_path': str(_artifact_path(resources, 'run-summary.json')),
                'gate_input_path': str(_artifact_path(resources, 'gate-input.json')),
            },
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
                    manifest=manifest,
                    allow_missing_state=True,
                )
                teardown_succeeded = True
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
                    previous_sync_policy=previous_root_application_sync_policy,
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

        if (
            teardown_succeeded
            and not report_only
            and bool(rollouts_report['enabled'])
            and not any(error.startswith('argocd_restore:') for error in errors)
        ):
            try:
                teardown_analysis_run = _run_rollouts_analysis(
                    resources=resources,
                    manifest=manifest,
                    postgres_config=postgres_config,
                    clickhouse_config=clickhouse_config,
                    rollouts_config=rollouts_config,
                    phase='teardown-clean',
                    template_name=rollouts_config.teardown_template,
                )
                rollouts_report['teardown_analysis_run'] = teardown_analysis_run
                if teardown_report is None:
                    teardown_report = {}
                teardown_report['analysis_run'] = teardown_analysis_run
                if _as_mapping(teardown_analysis_run).get('phase') != 'Successful':
                    errors.append('teardown:environment_incomplete')
            except Exception as exc:
                errors.append(f'teardown:{exc}')
                if teardown_report is None:
                    teardown_report = {}
                teardown_report['analysis_run_error'] = str(exc)

    report = {
        'status': 'ok' if not errors else 'error',
        'mode': 'run',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'completed_at': datetime.now(timezone.utc).isoformat(),
        'argocd_prepare': argocd_prepare_report,
        'argocd_restore': argocd_restore_report,
        'apply': apply_report,
        'replay': replay_report,
        'runtime_verify': runtime_verify_report,
        'monitor': monitor_report,
        'report': analytics_report,
        'strategy_proof': strategy_proof_report,
        'performance': performance_report,
        'run_summary': run_summary_report,
        'gate_input': gate_input_report,
        'fill_price_error_budget': fill_price_error_budget_report,
        'teardown': teardown_report,
        'rollouts': rollouts_report,
        'errors': errors,
    }
    run_manifest_path = _state_paths(resources, manifest)[1]
    if apply_report is not None:
        updated_apply_report = dict(apply_report)
        updated_apply_report['replay'] = replay_report
        updated_apply_report['rollouts'] = rollouts_report
        _save_json(run_manifest_path, updated_apply_report)
    _save_json(run_manifest_path.with_name('run-full-lifecycle-manifest.json'), report)
    completion_trace = _build_simulation_completion_trace(
        resources=resources,
        manifest=manifest,
        postgres_config=postgres_config,
        apply_report=apply_report,
        runtime_verify_report=runtime_verify_report,
        monitor_report=monitor_report,
        analytics_report=analytics_report,
        fill_price_error_budget_report=fill_price_error_budget_report,
        rollouts_report=rollouts_report,
        errors=errors,
    )
    completion_trace_path = _artifact_path(resources, 'completion-trace.json')
    _save_json(completion_trace_path, completion_trace)
    runtime_session_factory, runtime_engine = _runtime_sessionmaker(postgres_config)
    try:
        with runtime_session_factory() as session:
            gate_row_ids = persist_completion_trace(
                session=session,
                trace_payload=completion_trace,
                default_artifact_ref=str(completion_trace_path),
            )
            session.commit()
    finally:
        runtime_engine.dispose()
    updated_db_refs = _as_mapping(completion_trace.get('db_row_refs'))
    updated_db_refs['completion_gate_row_ids'] = gate_row_ids
    completion_trace['db_row_refs'] = updated_db_refs
    _save_json(completion_trace_path, completion_trace)
    if errors:
        raise RuntimeError('simulation_run_failed:' + '; '.join(errors))
    return report


def _render_report(payload: Mapping[str, Any], *, json_only: bool) -> None:
    if json_only:
        print(json.dumps(dict(payload), sort_keys=True, separators=(',', ':')))
        return
    print(json.dumps(dict(payload), indent=2, sort_keys=True))


_http_clickhouse_query = simulation_verification._http_clickhouse_query
_monitor_run_completion = simulation_verification._monitor_run_completion
_monitor_snapshot = simulation_verification._monitor_snapshot
_runtime_verify = simulation_verification._runtime_verify
_signal_snapshot = simulation_verification._signal_snapshot
_validate_dump_coverage = simulation_verification._validate_dump_coverage
_validate_window_policy = simulation_verification._validate_window_policy
_verify_isolation_guards = simulation_verification._verify_isolation_guards


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
    rollouts_config = _build_rollouts_analysis_config(manifest)
    _log_script_event(
        'rollouts_config_ready',
        enabled=rollouts_config.enabled,
        namespace=rollouts_config.namespace,
        runtime_template=rollouts_config.runtime_template,
        activity_template=rollouts_config.activity_template,
        teardown_template=rollouts_config.teardown_template,
    )
    postgres_config = _build_postgres_runtime_config(
        manifest,
        simulation_db=_default_simulation_postgres_db(resources),
    )
    if resources.warm_lane_enabled:
        postgres_config = _resolve_warm_lane_runtime_postgres_config(
            resources=resources,
            postgres_config=postgres_config,
        )
    _log_script_event(
        'postgres_config_ready',
        admin_dsn=_redact_dsn_credentials(postgres_config.admin_dsn),
        simulation_dsn=_redact_dsn_credentials(postgres_config.simulation_dsn),
        runtime_simulation_dsn=_redact_dsn_credentials(postgres_config.torghut_runtime_dsn),
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
            rollouts_config=rollouts_config,
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
