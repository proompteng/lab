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
from app.db import SessionLocal
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

from .simulation_context import (
    APPLY_CONFIRMATION_PHRASE,
    KafkaRuntimeConfig,
    SIMULATION_CLICKHOUSE_SCHEMA_SOURCE_DATABASE,
    SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_ATTEMPTS,
    SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_SLEEP_SECONDS,
    VECTOR_EXTENSION_NAME,
    _cluster_service_host_candidates,
)
from .runtime_config import (
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    PostgresRuntimeConfig,
    SimulationResources,
    _as_mapping,
    _as_text,
    _redact_dsn_credentials,
    _replace_database_in_dsn,
    _safe_int,
    _username_from_dsn,
    _validate_window_policy,
)
from .resource_planning import _build_rollouts_analysis_config
from .kubernetes_argocd import (
    _is_vector_extension_create_permission_error,
    _kubectl_json,
    _postgres_extension_exists,
    _run_with_transient_postgres_retry,
)
from .service_environment import (
    _dump_artifact_manifest_path,
    _performance_config,
    _run_state_path,
    _state_paths,
    _ta_restore_policy,
    _torghut_env_overrides_from_manifest,
)
from .state_and_cache import _save_json


def _load_optional_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, Mapping):
        return None
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _dump_marker_path(dump_path: Path) -> Path:
    return dump_path.with_suffix(".dump-marker.json")


def _parse_dump_timestamp_bounds(payload: Mapping[str, Any]) -> tuple[int, int] | None:
    min_raw = payload.get("min_source_timestamp_ms")
    max_raw = payload.get("max_source_timestamp_ms")
    if min_raw is None or max_raw is None:
        return None
    min_ms = _safe_int(min_raw, default=-1)
    max_ms = _safe_int(max_raw, default=-1)
    if min_ms < 0 or max_ms < min_ms:
        return None
    return min_ms, max_ms


def _scan_dump_timestamp_bounds(dump_path: Path) -> tuple[int | None, int | None]:
    from .topic_dumping import _open_dump_reader

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
            source_timestamp_ms = _safe_int(
                payload.get("source_timestamp_ms"), default=-1
            )
            if source_timestamp_ms < 0:
                continue
            if min_ms is None or source_timestamp_ms < min_ms:
                min_ms = source_timestamp_ms
            if max_ms is None or source_timestamp_ms > max_ms:
                max_ms = source_timestamp_ms
    return min_ms, max_ms


def _reusable_dump_report(dump_path: Path) -> dict[str, Any] | None:
    from .topic_dumping import _count_lines, _dump_format_for_path

    if not dump_path.exists():
        return None
    marker_path = _dump_marker_path(dump_path)
    marker = _load_optional_json(marker_path)
    if marker is None:
        return None

    expected_sha = _as_text(marker.get("dump_sha256"))
    raw_expected_records = marker.get("records")
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
            (min_ms, max_ms) if min_ms is not None and max_ms is not None else None
        )
        if timestamp_bounds is not None:
            marker_with_bounds = dict(marker)
            marker_with_bounds["min_source_timestamp_ms"] = timestamp_bounds[0]
            marker_with_bounds["max_source_timestamp_ms"] = timestamp_bounds[1]
            _save_json(marker_path, marker_with_bounds)
    min_source_timestamp_ms = (
        timestamp_bounds[0] if timestamp_bounds is not None else None
    )
    max_source_timestamp_ms = (
        timestamp_bounds[1] if timestamp_bounds is not None else None
    )
    return {
        "path": str(dump_path),
        "dump_format": _dump_format_for_path(dump_path),
        "records": actual_records,
        "sha256": actual_sha,
        "reused_existing_dump": True,
        "min_source_timestamp_ms": min_source_timestamp_ms,
        "max_source_timestamp_ms": max_source_timestamp_ms,
        "artifact_manifest_path": str(_dump_artifact_manifest_path(dump_path)),
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
    window = _as_mapping(manifest.get("window"))
    torghut_env_overrides = _torghut_env_overrides_from_manifest(manifest)
    window_policy = _validate_window_policy(manifest)
    rollouts_config = _build_rollouts_analysis_config(manifest)
    ta_restore = _ta_restore_policy(manifest)
    performance_cfg = _performance_config(manifest)
    return {
        "status": "ok",
        "run_id": resources.run_id,
        "dataset_id": resources.dataset_id,
        "lane": resources.lane,
        "resources": {
            "namespace": resources.namespace,
            "ta_configmap": resources.ta_configmap,
            "ta_deployment": resources.ta_deployment,
            "torghut_service": resources.torghut_service,
            "source_topics": resources.source_topic_by_role,
            "simulation_topics": resources.simulation_topic_by_role,
            "replay_topic_by_source_topic": resources.replay_topic_by_source_topic,
            "ta_group_id": resources.ta_group_id,
            "order_feed_group_id": resources.order_feed_group_id,
            "clickhouse_database": resources.clickhouse_db,
            "clickhouse_tables": resources.clickhouse_table_by_role,
            "clickhouse_signal_table": resources.clickhouse_signal_table,
            "clickhouse_price_table": resources.clickhouse_price_table,
            "postgres_database": postgres_config.simulation_db,
            "postgres_simulation_dsn": _redact_dsn_credentials(
                postgres_config.simulation_dsn
            ),
            "postgres_runtime_simulation_dsn": _redact_dsn_credentials(
                postgres_config.torghut_runtime_dsn
            ),
        },
        "window": {
            "start": _as_text(window.get("start")),
            "end": _as_text(window.get("end")),
            "policy": window_policy,
        },
        "torghut_env_overrides": torghut_env_overrides,
        "kafka": {
            "bootstrap_servers": kafka_config.bootstrap_servers,
            "runtime_bootstrap_servers": kafka_config.runtime_bootstrap,
            "security_protocol": kafka_config.security_protocol,
            "runtime_security_protocol": kafka_config.runtime_security,
            "runtime_sasl_mechanism": kafka_config.runtime_sasl,
            "runtime_sasl_username": kafka_config.runtime_username,
        },
        "clickhouse": {
            "http_url": clickhouse_config.http_url,
            "username": clickhouse_config.username,
        },
        "argocd": asdict(argocd_config),
        "rollouts": asdict(rollouts_config),
        "ta_restore": ta_restore,
        "performance": performance_cfg,
        "artifacts": {
            "state_path": str(state_path),
            "run_manifest_path": str(run_manifest_path),
            "dump_path": str(dump_path),
            "dump_manifest_path": str(_dump_artifact_manifest_path(dump_path)),
            "run_state_path": str(run_state_path),
        },
        "confirmation_phrase": APPLY_CONFIRMATION_PHRASE,
    }


def _http_clickhouse_query(
    *,
    config: ClickHouseRuntimeConfig,
    query: str,
) -> tuple[int, str]:
    request_url = config.http_url
    parsed = urlsplit(request_url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise RuntimeError(f"unsupported_clickhouse_scheme:{scheme or 'missing'}")
    if not parsed.hostname:
        raise RuntimeError("invalid_clickhouse_host")

    headers = {"Content-Type": "text/plain"}
    if config.username:
        headers["X-ClickHouse-User"] = config.username
    if config.password:
        headers["X-ClickHouse-Key"] = config.password

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port)
    try:
        connection.request("POST", path, body=query.encode("utf-8"), headers=headers)
        response = connection.getresponse()
        body = response.read().decode("utf-8", errors="replace").strip()
        return response.status, body
    finally:
        connection.close()


def _http_request(
    *,
    base_url: str,
    path: str,
    method: str = "GET",
    body: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> tuple[int, str]:
    parsed = urlsplit(base_url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise RuntimeError(f"unsupported_http_scheme:{scheme or 'missing'}")
    if not parsed.hostname:
        raise RuntimeError("invalid_http_host")

    target_path = parsed.path or "/"
    if path and path != "/":
        target_path = f"{target_path.rstrip('/')}/{path.lstrip('/')}"
    request_headers = dict(headers or {})
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    payload = body.encode("utf-8") if body is not None else None
    last_error: OSError | None = None
    for hostname in _cluster_service_host_candidates(parsed.hostname):
        connection = connection_class(hostname, parsed.port)
        try:
            connection.request(
                method.upper(), target_path, body=payload, headers=request_headers
            )
            response = connection.getresponse()
            response_body = response.read().decode("utf-8", errors="replace")
            return response.status, response_body
        except OSError as exc:
            last_error = exc
            continue
        finally:
            connection.close()
    if last_error is not None:
        raise last_error
    raise RuntimeError("http_request_failed_without_attempts")


def _clickhouse_query_configs(
    config: ClickHouseRuntimeConfig,
) -> list[ClickHouseRuntimeConfig]:
    parsed = urlsplit(config.http_url)
    host = parsed.hostname
    if not host or ".svc" not in host:
        return [config]

    host_parts = host.split(".")
    if len(host_parts) < 2:
        return [config]

    service_name = host_parts[0]
    namespace = host_parts[1]
    try:
        payload = _kubectl_json(
            namespace, ["get", "endpoints", service_name, "-o", "json"]
        )
    except Exception:
        return [config]

    resolved_configs: list[ClickHouseRuntimeConfig] = []
    seen_urls: set[str] = set()
    subsets = payload.get("subsets")
    if isinstance(subsets, Sequence):
        for subset in subsets:
            if not isinstance(subset, Mapping):
                continue
            addresses = subset.get("addresses")
            if not isinstance(addresses, Sequence):
                continue
            for address in addresses:
                if not isinstance(address, Mapping):
                    continue
                ip = _as_text(address.get("ip"))
                if not ip:
                    continue
                netloc = f"{ip}:{parsed.port}" if parsed.port is not None else ip
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
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", database):
        raise RuntimeError(f"invalid_clickhouse_database_name:{database}")
    create_query = f"CREATE DATABASE IF NOT EXISTS {database}"
    for endpoint_config in _clickhouse_query_configs(config):
        status, body = _http_clickhouse_query(
            config=endpoint_config, query=create_query
        )
        if status < 200 or status >= 300:
            raise RuntimeError(
                f"clickhouse_create_database_failed:{status}:{body[:200]}"
            )
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
    status, body = _http_clickhouse_query(
        config=query_config, query=f"SHOW CREATE TABLE {table}"
    )
    if status < 200 or status >= 300:
        raise RuntimeError(
            f"clickhouse_show_create_failed:{table}:{status}:{body[:200]}"
        )
    ddl = body.strip()
    if "\\n" in ddl:
        ddl = ddl.replace("\\n", "\n")
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
    ddl = source_ddl.strip().rstrip(";")
    ddl = ddl.replace(
        f"CREATE TABLE {source_table}",
        f"CREATE TABLE IF NOT EXISTS {database}.{table}",
        1,
    )
    engine_pattern = re.compile(
        r"ReplicatedReplacingMergeTree\('([^']+)',\s*'\{replica\}'",
        re.MULTILINE,
    )
    replicated_path = f"/clickhouse/tables/{{cluster}}/{{shard}}/{database}/{table}"
    if not engine_pattern.search(ddl):
        raise RuntimeError(
            f"clickhouse_schema_missing_replicated_engine:{source_table}"
        )
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
    lane: str = "equity",
) -> None:
    lane_contract = simulation_lane_contract(lane)
    endpoint_configs = _clickhouse_query_configs(config)
    for role, table in lane_contract.clickhouse_simulation_table_by_role.items():
        source_basename = lane_contract.clickhouse_source_table_by_role[role]
        source_table = (
            f"{SIMULATION_CLICKHOUSE_SCHEMA_SOURCE_DATABASE}.{source_basename}"
        )
        source_ddl = _show_create_clickhouse_table(
            config=endpoint_configs[0], table=source_table
        )
        create_query = _rewrite_clickhouse_table_ddl_for_simulation(
            source_ddl=source_ddl,
            source_table=source_table,
            database=database,
            table=table,
        )
        for endpoint_config in endpoint_configs:
            status, body = _http_clickhouse_query(
                config=endpoint_config, query=create_query
            )
            if status < 200 or status >= 300:
                raise RuntimeError(
                    f"clickhouse_create_table_failed:{database}.{table}:{status}:{body[:200]}"
                )
            _wait_for_clickhouse_table(
                config=endpoint_config,
                database=database,
                table=table,
            )
            reset_query = f"TRUNCATE TABLE {database}.{table}"
            status, body = _http_clickhouse_query(
                config=endpoint_config, query=reset_query
            )
            if status < 200 or status >= 300:
                raise RuntimeError(
                    f"clickhouse_truncate_table_failed:{database}.{table}:{status}:{body[:200]}"
                )


def _clickhouse_database_precreated(manifest: Mapping[str, Any]) -> bool:
    clickhouse = _as_mapping(manifest.get("clickhouse"))
    raw_value = clickhouse.get("database_precreated")
    if raw_value is None:
        raw_value = clickhouse.get("skip_database_create")
    return str(raw_value or "false").strip().lower() in {"1", "true", "yes", "on"}


def _postgres_database_precreated(manifest: Mapping[str, Any]) -> bool:
    postgres = _as_mapping(manifest.get("postgres"))
    raw_value = postgres.get("database_precreated")
    if raw_value is None:
        raw_value = postgres.get("skip_database_create")
    return str(raw_value or "false").strip().lower() in {"1", "true", "yes", "on"}


def _wait_for_clickhouse_table(
    *,
    config: ClickHouseRuntimeConfig,
    database: str,
    table: str,
    attempts: int = SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_ATTEMPTS,
    sleep_seconds: float = SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_SLEEP_SECONDS,
) -> None:
    if attempts <= 0:
        raise RuntimeError("clickhouse_table_visibility_attempts_must_be_positive")
    exists_query = f"EXISTS TABLE {database}.{table}"
    last_body = ""
    for attempt in range(1, attempts + 1):
        status, body = _http_clickhouse_query(config=config, query=exists_query)
        last_body = body[:200]
        if 200 <= status < 300 and body.strip() == "1":
            return
        if attempt < attempts:
            time.sleep(sleep_seconds)
    raise RuntimeError(f"clickhouse_table_not_visible:{database}.{table}:{last_body}")


def _wait_for_clickhouse_database(
    *,
    config: ClickHouseRuntimeConfig,
    database: str,
    attempts: int = SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_ATTEMPTS,
    sleep_seconds: float = SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_SLEEP_SECONDS,
) -> None:
    if attempts <= 0:
        raise RuntimeError("clickhouse_database_visibility_attempts_must_be_positive")
    exists_query = f"EXISTS DATABASE {database}"
    last_body = ""
    for attempt in range(1, attempts + 1):
        status, body = _http_clickhouse_query(config=config, query=exists_query)
        last_body = body[:200]
        if 200 <= status < 300 and body.strip() == "1":
            return
        if attempt < attempts:
            time.sleep(sleep_seconds)
    raise RuntimeError(f"clickhouse_database_not_visible:{database}:{last_body}")


def _ensure_postgres_database(config: PostgresRuntimeConfig) -> None:
    simulation_role = _username_from_dsn(
        config.torghut_runtime_dsn
    ) or _username_from_dsn(config.simulation_dsn)

    def _ensure() -> None:
        with psycopg.connect(config.admin_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT 1 FROM pg_database WHERE datname = %s",
                    (config.simulation_db,),
                )
                exists = cursor.fetchone() is not None
                if not exists:
                    if simulation_role:
                        cursor.execute(
                            sql.SQL("CREATE DATABASE {} OWNER {}").format(
                                sql.Identifier(config.simulation_db),
                                sql.Identifier(simulation_role),
                            )
                        )
                    else:
                        cursor.execute(
                            sql.SQL("CREATE DATABASE {}").format(
                                sql.Identifier(config.simulation_db)
                            )
                        )

    _run_with_transient_postgres_retry(
        label="ensure_postgres_database",
        operation=_ensure,
    )


def _ensure_postgres_runtime_permissions(
    config: PostgresRuntimeConfig,
) -> dict[str, Any]:
    simulation_role = _username_from_dsn(
        config.torghut_runtime_dsn
    ) or _username_from_dsn(config.simulation_dsn)
    admin_role = _username_from_dsn(config.admin_dsn)
    admin_simulation_dsn = _replace_database_in_dsn(
        config.admin_dsn,
        database=config.simulation_db,
        label="manifest.postgres.admin_dsn",
    )

    def _ensure() -> dict[str, Any]:
        grants_applied = False
        default_privileges_applied = False
        with psycopg.connect(config.admin_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                if simulation_role:
                    cursor.execute(
                        sql.SQL("GRANT ALL PRIVILEGES ON DATABASE {} TO {}").format(
                            sql.Identifier(config.simulation_db),
                            sql.Identifier(simulation_role),
                        )
                    )
                    grants_applied = True

        with psycopg.connect(admin_simulation_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                has_vector_extension = _postgres_extension_exists(
                    cursor, VECTOR_EXTENSION_NAME
                )
                if not has_vector_extension:
                    try:
                        cursor.execute(
                            sql.SQL("CREATE EXTENSION IF NOT EXISTS {}").format(
                                sql.Identifier(VECTOR_EXTENSION_NAME)
                            )
                        )
                        has_vector_extension = True
                    except Exception as exc:
                        if _is_vector_extension_create_permission_error(exc):
                            if _postgres_extension_exists(
                                cursor, VECTOR_EXTENSION_NAME
                            ):
                                has_vector_extension = True
                            else:
                                has_vector_extension = False
                        else:
                            raise
                if simulation_role:
                    cursor.execute(
                        sql.SQL("GRANT USAGE, CREATE ON SCHEMA public TO {}").format(
                            sql.Identifier(simulation_role),
                        )
                    )
                    cursor.execute(
                        sql.SQL(
                            "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO {}"
                        ).format(
                            sql.Identifier(simulation_role),
                        )
                    )
                    cursor.execute(
                        sql.SQL(
                            "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO {}"
                        ).format(
                            sql.Identifier(simulation_role),
                        )
                    )
                    cursor.execute(
                        sql.SQL(
                            "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO {}"
                        ).format(
                            sql.Identifier(simulation_role),
                        )
                    )
                    if admin_role:
                        cursor.execute(
                            sql.SQL(
                                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                                "GRANT ALL PRIVILEGES ON TABLES TO {}"
                            ).format(
                                sql.Identifier(admin_role),
                                sql.Identifier(simulation_role),
                            )
                        )
                        cursor.execute(
                            sql.SQL(
                                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                                "GRANT ALL PRIVILEGES ON SEQUENCES TO {}"
                            ).format(
                                sql.Identifier(admin_role),
                                sql.Identifier(simulation_role),
                            )
                        )
                        cursor.execute(
                            sql.SQL(
                                "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                                "GRANT EXECUTE ON FUNCTIONS TO {}"
                            ).format(
                                sql.Identifier(admin_role),
                                sql.Identifier(simulation_role),
                            )
                        )
                    else:
                        cursor.execute(
                            sql.SQL(
                                "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                                "GRANT ALL PRIVILEGES ON TABLES TO {}"
                            ).format(
                                sql.Identifier(simulation_role),
                            )
                        )
                        cursor.execute(
                            sql.SQL(
                                "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                                "GRANT ALL PRIVILEGES ON SEQUENCES TO {}"
                            ).format(
                                sql.Identifier(simulation_role),
                            )
                        )
                        cursor.execute(
                            sql.SQL(
                                "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                                "GRANT EXECUTE ON FUNCTIONS TO {}"
                            ).format(
                                sql.Identifier(simulation_role),
                            )
                        )
                    grants_applied = True
                    default_privileges_applied = True
        return {
            "simulation_role": simulation_role,
            "grants_applied": grants_applied,
            "default_privileges_applied": default_privileges_applied,
            "vector_extension_checked": has_vector_extension,
        }

    return cast(
        dict[str, Any],
        _run_with_transient_postgres_retry(
            label="ensure_postgres_runtime_permissions",
            operation=_ensure,
        ),
    )


__all__ = (
    "Any",
    "COMPONENT_ARTIFACTS",
    "COMPONENT_REPLAY",
    "COMPONENT_TA",
    "COMPONENT_TORGHUT",
    "Callable",
    "CephS3Client",
    "DOC29_SIMULATION_FULL_DAY_GATE",
    "DOC29_SIMULATION_SMOKE_GATE",
    "Decimal",
    "EQUITY_SIMULATION_LANE",
    "HTTPConnection",
    "HTTPSConnection",
    "Mapping",
    "Path",
    "SIMULATION_PROGRESS_COMPONENTS",
    "Sequence",
    "SessionLocal",
    "TRACE_STATUS_BLOCKED",
    "TRACE_STATUS_SATISFIED",
    "ZoneInfo",
    "annotations",
    "argparse",
    "asdict",
    "base64",
    "build_completion_trace",
    "build_fill_price_error_budget_report_v1",
    "cast",
    "contextmanager",
    "create_engine",
    "dataclass",
    "date",
    "datetime",
    "gzip",
    "hashlib",
    "importlib",
    "json",
    "os",
    "persist_completion_trace",
    "psycopg",
    "quote",
    "quote_plus",
    "re",
    "replace",
    "run_autonomous_lane",
    "sessionmaker",
    "shlex",
    "shutil",
    "simulation_clickhouse_table_names",
    "simulation_lane_contract",
    "simulation_lane_contract_for_manifest",
    "simulation_schema_registry_subject_roles",
    "simulation_verification",
    "socket",
    "sql",
    "subprocess",
    "sys",
    "time",
    "timedelta",
    "timezone",
    "unquote_plus",
    "urlsplit",
    "uuid",
    "yaml",
    "_build_plan_report",
    "_clickhouse_database_precreated",
    "_clickhouse_query_configs",
    "_dump_marker_path",
    "_ensure_clickhouse_database",
    "_ensure_clickhouse_runtime_tables",
    "_ensure_postgres_database",
    "_ensure_postgres_runtime_permissions",
    "_file_sha256",
    "_http_clickhouse_query",
    "_http_request",
    "_load_optional_json",
    "_parse_dump_timestamp_bounds",
    "_postgres_database_precreated",
    "_reusable_dump_report",
    "_rewrite_clickhouse_table_ddl_for_simulation",
    "_scan_dump_timestamp_bounds",
    "_show_create_clickhouse_table",
    "_wait_for_clickhouse_database",
    "_wait_for_clickhouse_table",
)
