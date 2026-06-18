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
from scripts import (
    historical_simulation_runtime_verification as simulation_verification,
)
from scripts.simulation_lane_contracts import (
    EQUITY_SIMULATION_LANE,
    simulation_clickhouse_table_names,
    simulation_lane_contract,
    simulation_lane_contract_for_manifest,
    simulation_schema_registry_subject_roles,
)

from .simulation_context import (
    KafkaRuntimeConfig,
    SIMULATION_POSTGRES_REQUIRED_METADATA_TABLES,
    SIMULATION_POSTGRES_RUNTIME_RESET_TABLES,
    TORGHUT_ENV_KEYS,
)
from .runtime_config import (
    ClickHouseRuntimeConfig,
    PostgresRuntimeConfig,
    SimulationResources,
    _as_mapping,
    _as_text,
    _resolve_window_bounds,
)
from .resource_planning import (
    _find_vector_extension_blocking_revision,
    _replace_alembic_upgrade_target,
    _run_alembic_upgrade,
    _ta_auto_offset_reset_key,
    _ta_clickhouse_url_key,
    _ta_group_id_key,
    _ta_topic_key_by_role,
)
from .kubernetes_argocd import (
    _is_vector_extension_create_permission_error,
    _kubectl_json,
    _kubectl_patch,
    _run_with_transient_postgres_retry,
)
from .service_environment import (
    _kservice_container_with_env,
    _kservice_env,
    _merge_env_entries,
    _simulation_account_label,
)
from .state_and_cache import _cache_metadata


def _run_migrations(config: PostgresRuntimeConfig) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    env = dict(os.environ)
    env["DB_DSN"] = config.admin_simulation_dsn
    _remove_appledouble_sidecars(repo_root / "migrations" / "versions")

    migration_error: Exception | None = None

    try:
        _run_alembic_upgrade(
            command=config.migrations_command,
            env=env,
            cwd=repo_root,
            label="run_migrations",
        )
        _assert_required_simulation_metadata_tables(config)
        return
    except RuntimeError as exc:
        if not _is_vector_extension_create_permission_error(exc):
            raise
        migration_error = exc

    fallback_revision = _find_vector_extension_blocking_revision(repo_root)
    if fallback_revision is None:
        raise RuntimeError(
            "run_migrations_fallback_not_applicable: vector extension permission error occurred but "
            "a migration target for a pre-vector revision could not be discovered"
        ) from migration_error

    fallback_command = _replace_alembic_upgrade_target(
        command=config.migrations_command,
        target=fallback_revision,
    )
    if fallback_command is None:
        raise RuntimeError(
            f"run_migrations_fallback_target_parse_failed: command={config.migrations_command} target={fallback_revision}"
        ) from migration_error

    _run_alembic_upgrade(
        command=fallback_command,
        env=env,
        cwd=repo_root,
        label="run_migrations_fallback_pre_vector",
    )
    _assert_required_simulation_metadata_tables(config)


def _assert_required_simulation_metadata_tables(config: PostgresRuntimeConfig) -> None:
    def _validate() -> None:
        with psycopg.connect(config.admin_simulation_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                missing_tables: list[str] = []
                for table in SIMULATION_POSTGRES_REQUIRED_METADATA_TABLES:
                    cursor.execute("SELECT to_regclass(%s)", (f"public.{table}",))
                    row = cursor.fetchone()
                    if row is None or row[0] is None:
                        missing_tables.append(table)
                if missing_tables:
                    raise RuntimeError(
                        "required_simulation_metadata_tables_missing:"
                        + ",".join(sorted(missing_tables))
                    )

    _run_with_transient_postgres_retry(
        label="assert_required_simulation_metadata_tables",
        operation=_validate,
    )


def _remove_appledouble_sidecars(directory: Path) -> None:
    if not directory.exists():
        return
    for candidate in directory.glob("._*.py"):
        candidate.unlink(missing_ok=True)


def _supersede_stale_simulation_progress_rows(config: PostgresRuntimeConfig) -> None:
    def _supersede() -> None:
        with psycopg.connect(config.torghut_runtime_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE simulation_run_progress
                    SET status = 'superseded',
                        terminal_state = COALESCE(terminal_state, 'superseded'),
                        last_error_code = COALESCE(last_error_code, 'superseded_by_runtime_reset'),
                        last_error_message = COALESCE(
                            last_error_message,
                            'historical simulation runtime reset superseded stale non-terminal progress rows'
                        ),
                        payload_json = COALESCE(payload_json, '{}'::jsonb) ||
                          '{"superseded_reason":"runtime_reset"}'::jsonb,
                        updated_at = NOW()
                    WHERE terminal_state IS NULL
                    """
                )

    _run_with_transient_postgres_retry(
        label="supersede_stale_simulation_progress_rows",
        operation=_supersede,
    )


def _reset_postgres_runtime_state(config: PostgresRuntimeConfig) -> None:
    _supersede_stale_simulation_progress_rows(config)

    def _reset() -> None:
        with psycopg.connect(config.torghut_runtime_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                for table in SIMULATION_POSTGRES_RUNTIME_RESET_TABLES:
                    cursor.execute("SELECT to_regclass(%s)", (table,))
                    row = cursor.fetchone()
                    if row is None or row[0] is None:
                        continue
                    cursor.execute(
                        sql.SQL("TRUNCATE TABLE {} RESTART IDENTITY CASCADE").format(
                            sql.Identifier(table),
                        )
                    )

    _run_with_transient_postgres_retry(
        label="reset_postgres_runtime_state",
        operation=_reset,
    )


def _seed_simulation_trade_cursor(
    *,
    config: PostgresRuntimeConfig,
    manifest: Mapping[str, Any],
    account_label: str,
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
                        "id": uuid.uuid4(),
                        "account_label": account_label,
                        "cursor_at": window_start,
                    },
                )

    _run_with_transient_postgres_retry(
        label="seed_simulation_trade_cursor",
        operation=_seed,
    )
    return window_start


def _upsert_simulation_runtime_context(
    *,
    config: PostgresRuntimeConfig,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    account_label: str,
) -> None:
    window_start, window_end = _resolve_window_bounds(manifest)
    cache_metadata = _cache_metadata(manifest)

    def _write() -> None:
        with psycopg.connect(config.torghut_runtime_dsn, autocommit=True) as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO simulation_runtime_context (
                      lane,
                      account_label,
                      run_id,
                      dataset_id,
                      window_start,
                      window_end,
                      cache_key,
                      cache_artifact_path,
                      cache_manifest_path,
                      warm_lane_enabled,
                      metadata_json
                    ) VALUES (
                      %(lane)s,
                      %(account_label)s,
                      %(run_id)s,
                      %(dataset_id)s,
                      %(window_start)s,
                      %(window_end)s,
                      %(cache_key)s,
                      %(cache_artifact_path)s,
                      %(cache_manifest_path)s,
                      %(warm_lane_enabled)s,
                      %(metadata_json)s::jsonb
                    )
                    ON CONFLICT (lane, account_label) DO UPDATE SET
                      run_id = EXCLUDED.run_id,
                      dataset_id = EXCLUDED.dataset_id,
                      window_start = EXCLUDED.window_start,
                      window_end = EXCLUDED.window_end,
                      cache_key = EXCLUDED.cache_key,
                      cache_artifact_path = EXCLUDED.cache_artifact_path,
                      cache_manifest_path = EXCLUDED.cache_manifest_path,
                      warm_lane_enabled = EXCLUDED.warm_lane_enabled,
                      metadata_json = COALESCE(simulation_runtime_context.metadata_json, '{}'::jsonb)
                        || COALESCE(EXCLUDED.metadata_json, '{}'::jsonb),
                      updated_at = NOW()
                    """,
                    {
                        "lane": resources.lane,
                        "account_label": account_label,
                        "run_id": resources.run_id,
                        "dataset_id": resources.dataset_id,
                        "window_start": window_start,
                        "window_end": window_end,
                        "cache_key": cache_metadata["cache_key"] or None,
                        "cache_artifact_path": cache_metadata["cache_artifact_path"]
                        or None,
                        "cache_manifest_path": cache_metadata["cache_manifest_path"]
                        or None,
                        "warm_lane_enabled": resources.warm_lane_enabled,
                        "metadata_json": json.dumps(
                            {
                                "run_token": resources.run_token,
                                "cache_decision": cache_metadata["cache_decision"]
                                or None,
                                "window_start": window_start.astimezone(
                                    timezone.utc
                                ).isoformat(),
                                "window_end": window_end.astimezone(
                                    timezone.utc
                                ).isoformat(),
                            },
                            sort_keys=True,
                        ),
                    },
                )

    _run_with_transient_postgres_retry(
        label="upsert_simulation_runtime_context",
        operation=_write,
    )


def _runtime_sessionmaker(config: PostgresRuntimeConfig) -> tuple[Any, Any]:
    runtime_dsn = config.torghut_runtime_dsn
    if runtime_dsn.startswith("postgresql://"):
        runtime_dsn = "postgresql+psycopg://" + runtime_dsn[len("postgresql://") :]
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
        ["get", "configmap", resources.ta_configmap, "-o", "json"],
    )
    ta_data = _as_mapping(ta_config.get("data"))

    ta_deployment = _kubectl_json(
        resources.namespace,
        ["get", "flinkdeployment", resources.ta_deployment, "-o", "json"],
    )
    deployment_spec = _as_mapping(ta_deployment.get("spec"))
    deployment_job = _as_mapping(deployment_spec.get("job"))

    service = _kubectl_json(
        resources.namespace,
        ["get", "kservice", resources.torghut_service, "-o", "json"],
    )
    _container_name, env_entries = _kservice_env(service)
    env_by_name = {
        _as_text(entry.get("name")): entry
        for entry in env_entries
        if _as_text(entry.get("name"))
    }

    return {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "ta_data": ta_data,
        "ta_restart_nonce": int(deployment_spec.get("restartNonce") or 0),
        "ta_job_state": _as_text(deployment_job.get("state")),
        "torghut_env_snapshot": {key: env_by_name.get(key) for key in TORGHUT_ENV_KEYS},
    }


def _clickhouse_jdbc_url_for_database(raw_url: str, new_database: str) -> str:
    parsed = urlsplit(raw_url.strip())
    if not parsed.hostname:
        raise RuntimeError(f"invalid_clickhouse_http_url:{raw_url}")
    netloc = parsed.netloc
    suffix = f"?{parsed.query}" if parsed.query else ""
    return f"jdbc:clickhouse://{netloc}/{new_database}{suffix}"


def _configure_ta_for_simulation(
    *,
    resources: SimulationResources,
    clickhouse_config: ClickHouseRuntimeConfig,
    clickhouse_database: str,
    auto_offset_reset: str,
    manifest: Mapping[str, Any],
) -> None:
    updates = _desired_ta_simulation_config(
        resources=resources,
        clickhouse_config=clickhouse_config,
        clickhouse_database=clickhouse_database,
        auto_offset_reset=auto_offset_reset,
        manifest=manifest,
    )
    _kubectl_patch(
        resources.namespace,
        "configmap",
        resources.ta_configmap,
        {"data": updates},
    )


def _desired_ta_simulation_config(
    *,
    resources: SimulationResources,
    clickhouse_config: ClickHouseRuntimeConfig,
    clickhouse_database: str,
    auto_offset_reset: str,
    manifest: Mapping[str, Any],
) -> dict[str, str]:
    updates: dict[str, str] = {
        _ta_group_id_key(lane=resources.lane, manifest=manifest): resources.ta_group_id,
        _ta_auto_offset_reset_key(
            lane=resources.lane, manifest=manifest
        ): auto_offset_reset,
    }

    for role, key in _ta_topic_key_by_role(
        lane=resources.lane, manifest=manifest
    ).items():
        topic = resources.simulation_topic_by_role.get(role)
        if not topic:
            continue
        updates[key] = topic

    updates[_ta_clickhouse_url_key(lane=resources.lane, manifest=manifest)] = (
        _clickhouse_jdbc_url_for_database(
            clickhouse_config.http_url,
            clickhouse_database,
        )
    )
    return updates


def _ta_runtime_reconfigure_required(
    *,
    resources: SimulationResources,
    clickhouse_config: ClickHouseRuntimeConfig,
    clickhouse_database: str,
    auto_offset_reset: str,
    manifest: Mapping[str, Any],
) -> bool:
    current = _kubectl_json(
        resources.namespace,
        ["get", "configmap", resources.ta_configmap, "-o", "json"],
    )
    current_data = _as_mapping(current.get("data"))
    expected = _desired_ta_simulation_config(
        resources=resources,
        clickhouse_config=clickhouse_config,
        clickhouse_database=clickhouse_database,
        auto_offset_reset=auto_offset_reset,
        manifest=manifest,
    )
    return any(
        _as_text(current_data.get(key)) != value for key, value in expected.items()
    )


def _restart_ta_deployment(
    resources: SimulationResources,
    *,
    desired_state: str,
    upgrade_mode: str = "last-state",
) -> int:
    deployment = _kubectl_json(
        resources.namespace,
        ["get", "flinkdeployment", resources.ta_deployment, "-o", "json"],
    )
    spec = _as_mapping(deployment.get("spec"))
    current_state = _as_text(_as_mapping(spec.get("job")).get("state")) or "running"
    restart_nonce = int(spec.get("restartNonce") or 0)

    if current_state != "suspended":
        _kubectl_patch(
            resources.namespace,
            "flinkdeployment",
            resources.ta_deployment,
            {"spec": {"job": {"state": "suspended"}}},
        )
    next_nonce = restart_nonce + 1
    _kubectl_patch(
        resources.namespace,
        "flinkdeployment",
        resources.ta_deployment,
        {
            "spec": {
                "restartNonce": next_nonce,
                "job": {"state": desired_state, "upgradeMode": upgrade_mode},
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
        ["get", "kservice", resources.torghut_service, "-o", "json"],
    )
    merged_env = _torghut_service_env_for_simulation(
        service=service,
        resources=resources,
        manifest=manifest,
        postgres_config=postgres_config,
        clickhouse_config=clickhouse_config,
        kafka_config=kafka_config,
        torghut_env_overrides=torghut_env_overrides,
    )
    patched_container = _kservice_container_with_env(service, merged_env)
    _kubectl_patch(
        resources.namespace,
        "kservice",
        resources.torghut_service,
        {"spec": {"template": {"spec": {"containers": [patched_container]}}}},
    )


def _torghut_service_env_for_simulation(
    *,
    service: Mapping[str, Any],
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    postgres_config: PostgresRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    kafka_config: KafkaRuntimeConfig,
    torghut_env_overrides: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    _, current_env = _kservice_env(service)
    window_start, window_end = _resolve_window_bounds(manifest)
    warm_lane_enabled = resources.warm_lane_enabled
    account_label = _simulation_account_label(
        resources=resources,
        manifest=manifest,
        torghut_env_overrides=torghut_env_overrides,
    )

    updates = {
        "DB_DSN": postgres_config.torghut_runtime_dsn,
        "TRADING_ENABLED": "true",
        "TRADING_MODE": "paper",
        "TRADING_ACCOUNT_LABEL": account_label,
        "TRADING_FEATURE_FLAGS_ENABLED": "false",
        "TRADING_STRATEGY_RUNTIME_MODE": "scheduler_v3",
        "TRADING_STRATEGY_SCHEDULER_ENABLED": "true",
        "TA_CLICKHOUSE_URL": clickhouse_config.http_url,
        "TA_CLICKHOUSE_USERNAME": clickhouse_config.username or "",
        "TA_CLICKHOUSE_PASSWORD": clickhouse_config.password or "",
        "TRADING_SIGNAL_TABLE": resources.clickhouse_signal_table,
        "TRADING_PRICE_TABLE": resources.clickhouse_price_table,
        "TRADING_SIGNAL_ALLOWED_SOURCES": "ws,ta",
        "TRADING_ORDER_FEED_ENABLED": "true",
        "TRADING_ORDER_FEED_BOOTSTRAP_SERVERS": kafka_config.runtime_bootstrap,
        "TRADING_ORDER_FEED_SECURITY_PROTOCOL": kafka_config.runtime_security,
        "TRADING_ORDER_FEED_SASL_MECHANISM": kafka_config.runtime_sasl,
        "TRADING_ORDER_FEED_SASL_USERNAME": kafka_config.runtime_username,
        "TRADING_ORDER_FEED_SASL_PASSWORD": kafka_config.runtime_password,
        "TRADING_ORDER_FEED_TOPIC": resources.simulation_topic_by_role["order_updates"],
        "TRADING_ORDER_FEED_TOPIC_V2": "",
        "TRADING_ORDER_FEED_GROUP_ID": resources.order_feed_group_id,
        "TRADING_ORDER_FEED_AUTO_OFFSET_RESET": "earliest",
        "TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED": "true",
        "TRADING_SIMULATION_ENABLED": "true",
        "TRADING_SIMULATION_RUN_ID": "" if warm_lane_enabled else resources.run_id,
        "TRADING_SIMULATION_DATASET_ID": ""
        if warm_lane_enabled
        else resources.dataset_id,
        "TRADING_SIMULATION_CLOCK_MODE": "cursor",
        "TRADING_SIMULATION_WINDOW_START": (
            ""
            if warm_lane_enabled
            else window_start.astimezone(timezone.utc).isoformat()
        ),
        "TRADING_SIMULATION_WINDOW_END": (
            "" if warm_lane_enabled else window_end.astimezone(timezone.utc).isoformat()
        ),
        "TRADING_SIMULATION_ORDER_UPDATES_TOPIC": resources.simulation_topic_by_role[
            "order_updates"
        ],
        "TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS": kafka_config.runtime_bootstrap,
        "TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL": kafka_config.runtime_security,
        "TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM": kafka_config.runtime_sasl,
        "TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME": kafka_config.runtime_username,
        "TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD": kafka_config.runtime_password,
    }
    if torghut_env_overrides:
        for key, value in torghut_env_overrides.items():
            updates[str(key)] = str(value)
    return _merge_env_entries(current_env, updates)


def _torghut_service_reconfigure_required(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    postgres_config: PostgresRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    kafka_config: KafkaRuntimeConfig,
    torghut_env_overrides: Mapping[str, Any] | None = None,
) -> bool:
    service = _kubectl_json(
        resources.namespace,
        ["get", "kservice", resources.torghut_service, "-o", "json"],
    )
    _, current_env = _kservice_env(service)
    expected_env = _torghut_service_env_for_simulation(
        service=service,
        resources=resources,
        manifest=manifest,
        postgres_config=postgres_config,
        clickhouse_config=clickhouse_config,
        kafka_config=kafka_config,
        torghut_env_overrides=torghut_env_overrides,
    )
    expected_by_name = {
        _as_text(entry.get("name")): _as_mapping(entry)
        for entry in expected_env
        if _as_text(entry.get("name"))
    }
    current_by_name = {
        _as_text(entry.get("name")): _as_mapping(entry)
        for entry in current_env
        if _as_text(entry.get("name"))
    }
    return any(
        current_by_name.get(name) != entry for name, entry in expected_by_name.items()
    )


def _restore_ta_configuration(
    resources: SimulationResources, state: Mapping[str, Any]
) -> None:
    ta_data = _as_mapping(state.get("ta_data"))
    existing = _kubectl_json(
        resources.namespace,
        ["get", "configmap", resources.ta_configmap, "-o", "json"],
    )
    existing_data = _as_mapping(existing.get("data"))
    patch_data: dict[str, Any] = dict(ta_data)
    for key in existing_data:
        if key not in ta_data:
            patch_data[key] = None
    _kubectl_patch(
        resources.namespace,
        "configmap",
        resources.ta_configmap,
        {"data": patch_data},
    )


def _restore_ta_configuration_required(
    resources: SimulationResources, state: Mapping[str, Any]
) -> bool:
    ta_data = _as_mapping(state.get("ta_data"))
    existing = _kubectl_json(
        resources.namespace,
        ["get", "configmap", resources.ta_configmap, "-o", "json"],
    )
    existing_data = _as_mapping(existing.get("data"))
    patch_data: dict[str, Any] = dict(ta_data)
    for key in existing_data:
        if key not in ta_data:
            patch_data[key] = None
    for key, value in patch_data.items():
        if value is None:
            if key in existing_data:
                return True
            continue
        if _as_text(existing_data.get(key)) != _as_text(value):
            return True
    return False


def _restore_torghut_env(
    resources: SimulationResources, state: Mapping[str, Any]
) -> None:
    service = _kubectl_json(
        resources.namespace,
        ["get", "kservice", resources.torghut_service, "-o", "json"],
    )
    _, current_env = _kservice_env(service)
    snapshot = _as_mapping(state.get("torghut_env_snapshot"))
    merged = list(current_env)
    for key in TORGHUT_ENV_KEYS:
        snapshot_entry = snapshot.get(key)
        if snapshot_entry is None:
            merged = _merge_env_entries(merged, {key: None})
            continue
        entry_map = _as_mapping(snapshot_entry)
        entry_map.pop("name", None)
        merged = _merge_env_entries(merged, {key: entry_map})

    patched_container = _kservice_container_with_env(service, merged)
    _kubectl_patch(
        resources.namespace,
        "kservice",
        resources.torghut_service,
        {"spec": {"template": {"spec": {"containers": [patched_container]}}}},
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
    "_assert_required_simulation_metadata_tables",
    "_capture_cluster_state",
    "_clickhouse_jdbc_url_for_database",
    "_configure_ta_for_simulation",
    "_configure_torghut_service_for_simulation",
    "_desired_ta_simulation_config",
    "_remove_appledouble_sidecars",
    "_reset_postgres_runtime_state",
    "_restart_ta_deployment",
    "_restore_ta_configuration",
    "_restore_ta_configuration_required",
    "_restore_torghut_env",
    "_run_migrations",
    "_runtime_sessionmaker",
    "_seed_simulation_trade_cursor",
    "_supersede_stale_simulation_progress_rows",
    "_ta_runtime_reconfigure_required",
    "_torghut_service_env_for_simulation",
    "_torghut_service_reconfigure_required",
    "_upsert_simulation_runtime_context",
)
