# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
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
from app.trading.autonomy.lane import run_autonomous_lane
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
    SIMULATION_PROGRESS_COMPONENTS,
    COMPONENT_TA,
    COMPONENT_TORGHUT,
)
from app.whitepapers.workflow import CephS3Client
from scripts import historical_simulation_verification as simulation_verification
from scripts.simulation_lane_contracts import (
    EQUITY_SIMULATION_LANE,
    simulation_clickhouse_table_names,
    simulation_lane_contract,
    simulation_lane_contract_for_manifest,
    simulation_schema_registry_subject_roles,
)

# ruff: noqa: F401,F403,F405,F811,F821


APPLY_CONFIRMATION_PHRASE = "START_HISTORICAL_SIMULATION"

DEFAULT_NAMESPACE = "torghut"

DEFAULT_TA_CONFIGMAP = "torghut-ta-config"

DEFAULT_TA_DEPLOYMENT = "torghut-ta"

DEFAULT_TORGHUT_SERVICE = "torghut"

DEFAULT_SIM_TA_CONFIGMAP = "torghut-ta-sim-config"

DEFAULT_SIM_TA_DEPLOYMENT = "torghut-ta-sim"

DEFAULT_SIM_TORGHUT_SERVICE = "torghut-sim"

DEFAULT_OUTPUT_ROOT = Path("artifacts/torghut/simulations")

DEFAULT_SIMULATION_CACHE_BUCKET = "argo-workflows"

DEFAULT_SIMULATION_CACHE_ENDPOINT = (
    "http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80"
)

DEFAULT_SIMULATION_CACHE_PREFIX = "torghut-simulation-cache"

SIMULATION_CACHE_KEY_SCHEMA_VERSION = "torghut-simulation-cache-v2"

PRODUCTION_TOPIC_BY_ROLE = dict(EQUITY_SIMULATION_LANE.source_topic_by_role)

SIMULATION_TOPIC_BY_ROLE = dict(EQUITY_SIMULATION_LANE.simulation_topic_by_role)

TA_TOPIC_KEY_BY_ROLE = dict(EQUITY_SIMULATION_LANE.ta_topic_key_by_role)

TORGHUT_ENV_KEYS = [
    "DB_DSN",
    "TRADING_ENABLED",
    "TRADING_MODE",
    "TRADING_FEATURE_FLAGS_ENABLED",
    "TRADING_FEATURE_QUALITY_ENABLED",
    "TRADING_FEATURE_MAX_REQUIRED_NULL_RATE",
    "TRADING_FEATURE_MAX_STALENESS_MS",
    "TRADING_FEATURE_MAX_DUPLICATE_RATIO",
    "TRADING_STRATEGY_RUNTIME_MODE",
    "TRADING_STRATEGY_SCHEDULER_ENABLED",
    "TRADING_SIGNAL_TABLE",
    "TRADING_PRICE_TABLE",
    "TRADING_ORDER_FEED_ENABLED",
    "TRADING_ORDER_FEED_BOOTSTRAP_SERVERS",
    "TRADING_ORDER_FEED_SECURITY_PROTOCOL",
    "TRADING_ORDER_FEED_SASL_MECHANISM",
    "TRADING_ORDER_FEED_SASL_USERNAME",
    "TRADING_ORDER_FEED_SASL_PASSWORD",
    "TRADING_ORDER_FEED_TOPIC",
    "TRADING_ORDER_FEED_TOPIC_V2",
    "TRADING_ORDER_FEED_GROUP_ID",
    "TRADING_ORDER_FEED_AUTO_OFFSET_RESET",
    "TRADING_SIMULATION_ENABLED",
    "TRADING_SIMULATION_RUN_ID",
    "TRADING_SIMULATION_DATASET_ID",
    "TRADING_SIMULATION_CLOCK_MODE",
    "TRADING_SIMULATION_FETCH_WINDOW_SECONDS",
    "TRADING_SIMULATION_WINDOW_START",
    "TRADING_SIMULATION_WINDOW_END",
    "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
    "TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS",
    "TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL",
    "TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM",
    "TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME",
    "TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD",
]

SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST = frozenset(
    {
        "TRADING_ACCOUNT_LABEL",
        "TRADING_FEATURE_QUALITY_ENABLED",
        "TRADING_FEATURE_MAX_REQUIRED_NULL_RATE",
        "TRADING_FEATURE_MAX_STALENESS_MS",
        "TRADING_FEATURE_MAX_DUPLICATE_RATIO",
        "TRADING_STRATEGY_RUNTIME_MODE",
        "TRADING_STRATEGY_SCHEDULER_ENABLED",
        "TRADING_SIGNAL_LOOKBACK_MINUTES",
        "TRADING_SIGNAL_ALLOWED_SOURCES",
        "TRADING_SIMULATION_FETCH_WINDOW_SECONDS",
    }
)

SIMULATION_TORGHUT_PATCH_ENV_KEYS = frozenset(
    {
        "TA_CLICKHOUSE_PASSWORD",
        "TA_CLICKHOUSE_URL",
        "TA_CLICKHOUSE_USERNAME",
        "TRADING_SIGNAL_ALLOWED_SOURCES",
    }
)

SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_KEYS = tuple(
    sorted(
        set(TORGHUT_ENV_KEYS)
        | SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST
        | SIMULATION_TORGHUT_PATCH_ENV_KEYS
    )
)

SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_JQ = (
    ".spec.template.spec.containers[0].env[] | select("
    + " or ".join(
        f".name == {json.dumps(name)}"
        for name in SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_KEYS
    )
    + ")"
)

SIMULATION_FEATURE_STALENESS_MARGIN_MS = 300_000

SIMULATION_FEATURE_STALENESS_MIN_MS = 120_000

US_EQUITIES_REGULAR_PROFILE = "us_equities_regular"

US_EQUITIES_REGULAR_TIMEZONE = "America/New_York"

US_EQUITIES_REGULAR_MINUTES = 390

DEFAULT_COVERAGE_STRICT_RATIO = 0.95

DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS = 900

DEFAULT_RUN_MONITOR_POLL_SECONDS = 15

DEFAULT_RUN_MONITOR_MIN_DECISIONS = 1

DEFAULT_RUN_MONITOR_MIN_EXECUTIONS = 1

DEFAULT_RUN_MONITOR_MIN_TCA = 1

DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS = 0

DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS = 120

DEFAULT_WARM_LANE_SIMULATION_DATABASE = "torghut_sim_default"

DEFAULT_SIMULATION_DUMP_FORMAT = "jsonl.zst"

DEFAULT_SIMULATION_DUMP_SORT_MEMORY_LIMIT = "512M"

SUPPORTED_SIMULATION_DUMP_FORMATS = {
    "ndjson": ".ndjson",
    "jsonl.gz": ".jsonl.gz",
    "jsonl.zst": ".jsonl.zst",
}

DEFAULT_SIMULATION_REPLAY_PROFILE = "smoke"

REPLAY_PROFILE_DEFAULTS: dict[str, dict[str, float | int | str]] = {
    "compact": {
        "producer_linger_ms": 5,
        "producer_batch_size": 524_288,
        "producer_buffer_memory": 67_108_864,
        "producer_compression_type": "gzip",
        "status_update_every_records": 5_000,
        "status_update_every_seconds": 5.0,
        "flush_every_records": 5_000,
        "flush_timeout_seconds": 15.0,
        "final_flush_timeout_seconds": 60.0,
    },
    "smoke": {
        "producer_linger_ms": 5,
        "producer_batch_size": 1_048_576,
        "producer_buffer_memory": 134_217_728,
        "producer_compression_type": "gzip",
        "status_update_every_records": 10_000,
        "status_update_every_seconds": 10.0,
        "flush_every_records": 10_000,
        "flush_timeout_seconds": 20.0,
        "final_flush_timeout_seconds": 90.0,
    },
    "hourly": {
        "producer_linger_ms": 10,
        "producer_batch_size": 1_048_576,
        "producer_buffer_memory": 268_435_456,
        "producer_compression_type": "gzip",
        "status_update_every_records": 25_000,
        "status_update_every_seconds": 15.0,
        "flush_every_records": 25_000,
        "flush_timeout_seconds": 30.0,
        "final_flush_timeout_seconds": 120.0,
    },
    "full_day": {
        "producer_linger_ms": 20,
        "producer_batch_size": 2_097_152,
        "producer_buffer_memory": 536_870_912,
        "producer_compression_type": "gzip",
        "status_update_every_records": 50_000,
        "status_update_every_seconds": 30.0,
        "flush_every_records": 50_000,
        "flush_timeout_seconds": 45.0,
        "final_flush_timeout_seconds": 180.0,
    },
}

LEGACY_SIMULATION_STRATEGY_TOKENS = ("legacy_macd_rsi",)

DEFAULT_ARGOCD_APPSET_NAME = "product"

DEFAULT_ARGOCD_NAMESPACE = "argocd"

DEFAULT_ARGOCD_APP_NAME = "torghut"

DEFAULT_ARGOCD_ROOT_APP_NAME = "root"

DEFAULT_ARGOCD_RUN_MODE = "manual"

DEFAULT_ROLLOUTS_NAMESPACE = "torghut"

DEFAULT_ROLLOUTS_RUNTIME_TEMPLATE = "torghut-simulation-runtime-ready"

DEFAULT_ROLLOUTS_ACTIVITY_TEMPLATE = "torghut-simulation-activity"

DEFAULT_ROLLOUTS_TEARDOWN_TEMPLATE = "torghut-simulation-teardown-clean"

DEFAULT_ROLLOUTS_ARTIFACT_TEMPLATE = "torghut-simulation-artifact-bundle"

DEFAULT_ROLLOUTS_VERIFY_TIMEOUT_SECONDS = 1800

DEFAULT_ROLLOUTS_VERIFY_POLL_SECONDS = 5

DEFAULT_SIMULATION_CACHE_CEPH_TIMEOUT_SECONDS = 20

SIMULATION_CACHE_UPLOAD_MIN_TIMEOUT_SECONDS = 60

SIMULATION_CACHE_UPLOAD_TIMEOUT_MAX_SECONDS = 900

SIMULATION_CACHE_UPLOAD_BYTES_PER_SECOND_FLOOR = 2 * 1024 * 1024

SIMULATION_CACHE_UPLOAD_TIMEOUT_SLACK_SECONDS = 30

SIMULATION_CACHE_UPLOAD_RETRY_ATTEMPTS = 3

SIMULATION_CACHE_UPLOAD_RETRY_SLEEP_SECONDS = 2.0

SIMULATION_RUNTIME_LOCK_NAME = "torghut-historical-simulation-lock"

SIMULATION_CLICKHOUSE_SCHEMA_SOURCE_DATABASE = "torghut"

SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_ATTEMPTS = 10

SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_SLEEP_SECONDS = 0.2

TRANSIENT_POSTGRES_ERROR_PATTERNS = (
    "connection refused",
    "connection reset by peer",
    "could not receive data from server",
    "server closed the connection unexpectedly",
    "connection to server at",
    "terminating connection due to administrator command",
    "timeout expired",
)

NON_TRANSIENT_POSTGRES_ERROR_PATTERNS = (
    "password authentication failed",
    "no pg_hba.conf entry",
    'role "',
    'database "',
    "permission denied",
    "must be superuser",
)

VECTOR_EXTENSION_NAME = "vector"

POSTGRES_VECTOR_EXTENSION_PERMISSION_ERROR_MARKERS = (
    "permission denied to create extension",
    "must be superuser to create this extension",
)

TRANSIENT_POSTGRES_RETRY_ATTEMPTS = 8

TRANSIENT_POSTGRES_RETRY_SLEEP_SECONDS = 0.5

SIMULATION_POSTGRES_RUNTIME_RESET_TABLES = (
    "trade_cursor",
    "trade_decisions",
    "executions",
    "execution_tca_metrics",
    "execution_order_events",
)

SIMULATION_POSTGRES_REQUIRED_METADATA_TABLES = (
    "simulation_run_progress",
    "simulation_runtime_context",
    "vnext_completion_gate_results",
)

KAFKA_API_VERSION = (4, 1, 1)

SCHEMA_REGISTRY_CONTENT_TYPE = "application/vnd.schemaregistry.v1+json"

EMBEDDED_SCHEMA_REGISTRY_SCHEMA_BY_SUFFIX = {
    "docs/torghut/schemas/ta-bars-1s.avsc": (
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
        "]}"
    ),
    "docs/torghut/schemas/ta-signals.avsc": (
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
        "]}},"
        '{"name":"uncertainty_band","type":"string"},'
        '{"name":"expected_spread_impact_bps","type":"double"},'
        '{"name":"expected_slippage_bps","type":"double"},'
        '{"name":"feature_quality_status","type":"string"},'
        '{"name":"artifact","type":{"type":"record","name":"MicrostructureSignalArtifact","fields":['
        '{"name":"model_id","type":"string"},'
        '{"name":"feature_schema_version","type":"string"},'
        '{"name":"training_run_id","type":"string"}'
        "]}}"
        ']}],"default":null},'
        '{"name":"version","type":["int","null"],"default":1}'
        "]}"
    ),
}

KAFKA_HOST_SUFFIX_FALLBACKS = (
    ".kafka-kafka-brokers.kafka.svc.cluster.local",
    ".kafka-kafka-brokers.kafka.svc",
    ".kafka.svc.cluster.local",
    ".kafka.svc",
    ".svc.cluster.local",
    ".svc",
)

_ORIGINAL_GETADDRINFO = socket.getaddrinfo


def _cluster_service_host_candidates(host: str) -> list[str]:
    host = host.strip()
    if not host:
        return []

    candidates = [host]
    host_parts = host.split(".")
    if len(host_parts) == 2:
        candidates.append(f"{host}.svc")
        candidates.append(f"{host}.svc.cluster.local")
    if host.endswith(".svc") and not host.endswith(".svc.cluster.local"):
        candidates.append(f"{host}.cluster.local")
    return candidates


def _kafka_host_candidates(host: str) -> list[str]:
    candidates = _cluster_service_host_candidates(host)
    if "." not in host:
        for suffix in KAFKA_HOST_SUFFIX_FALLBACKS:
            candidates.append(f"{host}{suffix}")
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
        except (
            OSError
        ) as exc:  # pragma: no cover - exercised by kafka runtime path only
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
            "bootstrap_servers": [
                item.strip()
                for item in self.bootstrap_servers.split(",")
                if item.strip()
            ],
        }
        if self.security_protocol:
            kwargs["security_protocol"] = self.security_protocol
        if self.sasl_mechanism:
            kwargs["sasl_mechanism"] = self.sasl_mechanism
        if self.sasl_username:
            kwargs["sasl_plain_username"] = self.sasl_username
        if self.sasl_password:
            kwargs["sasl_plain_password"] = self.sasl_password
        kwargs["api_version"] = KAFKA_API_VERSION
        kwargs["api_version_auto_timeout_ms"] = 5000
        return kwargs

    def kafka_runtime_client_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "bootstrap_servers": [
                item.strip()
                for item in self.runtime_bootstrap.split(",")
                if item.strip()
            ],
        }
        if self.runtime_security:
            kwargs["security_protocol"] = self.runtime_security
        if self.runtime_sasl:
            kwargs["sasl_mechanism"] = self.runtime_sasl
        if self.runtime_username:
            kwargs["sasl_plain_username"] = self.runtime_username
        if self.runtime_password:
            kwargs["sasl_plain_password"] = self.runtime_password
        kwargs["api_version"] = KAFKA_API_VERSION
        kwargs["api_version_auto_timeout_ms"] = 5000
        return kwargs


__all__ = [name for name in globals() if not name.startswith("__")]
