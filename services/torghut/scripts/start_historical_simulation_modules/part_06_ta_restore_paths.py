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

from .part_01_statements_64 import *
from .part_02_clickhouseruntimeconfig import *
from .part_03_normalize_migrations_command import *
from .part_04_is_vector_extension_create_permission_erro import *
from .part_05_set_argocd_application_ignore_differences import *


def _ta_restore_paths(ta_data: Mapping[str, Any]) -> dict[str, str | None]:
    return {
        "checkpoint_dir": _as_text(ta_data.get("TA_CHECKPOINT_DIR")),
        "savepoint_dir": _as_text(ta_data.get("TA_SAVEPOINT_DIR")),
    }


def _resolve_ta_restore_configuration(
    *,
    ta_data: Mapping[str, Any],
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    policy = _ta_restore_policy(manifest)
    paths = _ta_restore_paths(ta_data)
    missing = [name for name, value in paths.items() if not value]
    if policy["mode"] == "stateless":
        return {
            **policy,
            **paths,
            "configured": not missing,
            "effective_upgrade_mode": "stateless",
            "fallback_applied": False,
            "reason": "profile_default_stateless"
            if str(policy.get("source", "")).startswith("profile_default:")
            else "explicit_stateless",
        }
    if missing:
        missing_reason = f"restore_state_missing:{','.join(sorted(missing))}"
        if policy["mode"] == "stateless_if_missing":
            return {
                **policy,
                **paths,
                "configured": False,
                "effective_upgrade_mode": "stateless",
                "fallback_applied": True,
                "reason": missing_reason,
            }
        raise RuntimeError(missing_reason)
    return {
        **policy,
        **paths,
        "configured": True,
        "effective_upgrade_mode": "last-state",
        "fallback_applied": False,
        "reason": "restore_state_configured",
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
        "run_id": resources.run_id,
        "dataset_id": resources.dataset_id,
        "run_token": resources.run_token,
        "history": [],
    }
    history_raw = state.get("history")
    if not isinstance(history_raw, list):
        history: list[dict[str, Any]] = []
    else:
        history = [
            _as_mapping(item) for item in history_raw if isinstance(item, Mapping)
        ]
    event = {
        "phase": phase,
        "status": status,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    if details:
        event["details"] = dict(details)
    history.append(event)
    state["history"] = history
    state["last_phase"] = phase
    state["last_status"] = status
    state["updated_at"] = event["at"]
    _save_json(state_path, state)
    print(
        "RUN_STATE "
        + json.dumps(
            {
                "at": event["at"],
                "phase": phase,
                "status": status,
                "details": event.get("details", {}),
            },
            sort_keys=True,
        ),
        flush=True,
    )
    return state


def _log_script_event(message: str, **fields: Any) -> None:
    if fields:
        payload = " ".join(f"{key}={value!r}" for key, value in fields.items())
        print(f"RUN_LOG {message} {payload}", file=sys.stderr, flush=True)
    else:
        print(f"RUN_LOG {message}", file=sys.stderr, flush=True)


def _ensure_directory(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _save_json(path: Path, payload: Mapping[str, Any]) -> None:
    _ensure_directory(path)
    path.write_text(
        json.dumps(dict(payload), indent=2, sort_keys=True), encoding="utf-8"
    )


def _write_dump_marker(
    *,
    dump_path: Path,
    dump_sha256: str,
    records: int,
    dump_format: str,
    min_source_timestamp_ms: int | None,
    max_source_timestamp_ms: int | None,
) -> None:
    _save_json(
        _dump_marker_path(dump_path),
        {
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "dump_sha256": dump_sha256,
            "records": records,
            "dump_format": dump_format,
            "min_source_timestamp_ms": min_source_timestamp_ms,
            "max_source_timestamp_ms": max_source_timestamp_ms,
        },
    )


def _write_dump_marker_from_manifest(
    *,
    dump_path: Path,
    artifact_manifest: Mapping[str, Any],
) -> None:
    chunks = artifact_manifest.get("chunks")
    if not isinstance(chunks, list) or not chunks:
        raise RuntimeError("cache_manifest_missing_chunks")
    first_chunk = _as_mapping(chunks[0])
    dump_sha256 = _as_text(first_chunk.get("sha256"))
    records = _safe_int(first_chunk.get("records"), default=-1)
    if not dump_sha256 or records < 0:
        raise RuntimeError("cache_manifest_missing_required_chunk_fields")
    dump_format = _as_text(
        artifact_manifest.get("dump_format")
    ) or _dump_format_for_path(dump_path)
    _write_dump_marker(
        dump_path=dump_path,
        dump_sha256=dump_sha256,
        records=records,
        dump_format=dump_format,
        min_source_timestamp_ms=_safe_int(
            first_chunk.get("min_source_timestamp_ms"), default=-1
        )
        if first_chunk.get("min_source_timestamp_ms") is not None
        else None,
        max_source_timestamp_ms=_safe_int(
            first_chunk.get("max_source_timestamp_ms"), default=-1
        )
        if first_chunk.get("max_source_timestamp_ms") is not None
        else None,
    )


def _simulation_cache_client_from_env(
    timeout_seconds: int | None = None,
) -> tuple[CephS3Client | None, str]:
    access_key = (
        os.getenv("TORGHUT_SIM_CACHE_CEPH_ACCESS_KEY", "").strip()
        or os.getenv("AWS_ACCESS_KEY_ID", "").strip()
    )
    secret_key = (
        os.getenv("TORGHUT_SIM_CACHE_CEPH_SECRET_KEY", "").strip()
        or os.getenv("AWS_SECRET_ACCESS_KEY", "").strip()
    )
    bucket = (
        os.getenv("TORGHUT_SIM_CACHE_CEPH_BUCKET", "").strip()
        or DEFAULT_SIMULATION_CACHE_BUCKET
    )
    endpoint = (
        os.getenv("TORGHUT_SIM_CACHE_CEPH_ENDPOINT", "").strip()
        or DEFAULT_SIMULATION_CACHE_ENDPOINT
    )
    region = (
        os.getenv("TORGHUT_SIM_CACHE_CEPH_REGION", "us-east-1").strip() or "us-east-1"
    )
    effective_timeout_seconds = max(
        1,
        timeout_seconds
        if timeout_seconds is not None
        else int(
            os.getenv(
                "TORGHUT_SIM_CACHE_CEPH_TIMEOUT_SECONDS",
                str(DEFAULT_SIMULATION_CACHE_CEPH_TIMEOUT_SECONDS),
            )
            or str(DEFAULT_SIMULATION_CACHE_CEPH_TIMEOUT_SECONDS)
        ),
    )
    if not access_key or not secret_key or not endpoint:
        return None, bucket
    return (
        CephS3Client(
            endpoint=endpoint,
            access_key=access_key,
            secret_key=secret_key,
            region=region,
            timeout_seconds=effective_timeout_seconds,
        ),
        bucket,
    )


def _simulation_cache_upload_timeout_seconds(dump_path: Path) -> int:
    configured_timeout_seconds = max(
        1,
        int(
            os.getenv(
                "TORGHUT_SIM_CACHE_CEPH_TIMEOUT_SECONDS",
                str(DEFAULT_SIMULATION_CACHE_CEPH_TIMEOUT_SECONDS),
            )
            or str(DEFAULT_SIMULATION_CACHE_CEPH_TIMEOUT_SECONDS)
        ),
    )
    size_bytes = max(dump_path.stat().st_size, 0)
    size_based_timeout_seconds = SIMULATION_CACHE_UPLOAD_TIMEOUT_SLACK_SECONDS
    if size_bytes > 0:
        size_based_timeout_seconds += int(
            (size_bytes + SIMULATION_CACHE_UPLOAD_BYTES_PER_SECOND_FLOOR - 1)
            // SIMULATION_CACHE_UPLOAD_BYTES_PER_SECOND_FLOOR
        )
    return min(
        SIMULATION_CACHE_UPLOAD_TIMEOUT_MAX_SECONDS,
        max(
            configured_timeout_seconds,
            SIMULATION_CACHE_UPLOAD_MIN_TIMEOUT_SECONDS,
            size_based_timeout_seconds,
        ),
    )


def _simulation_cache_upload_attempts() -> tuple[int, float]:
    attempts = max(
        1,
        _safe_int(
            os.getenv(
                "TORGHUT_SIM_CACHE_CEPH_UPLOAD_RETRY_ATTEMPTS",
                str(SIMULATION_CACHE_UPLOAD_RETRY_ATTEMPTS),
            ),
            default=SIMULATION_CACHE_UPLOAD_RETRY_ATTEMPTS,
        ),
    )
    try:
        sleep_seconds = float(
            os.getenv(
                "TORGHUT_SIM_CACHE_CEPH_UPLOAD_RETRY_SLEEP_SECONDS",
                str(SIMULATION_CACHE_UPLOAD_RETRY_SLEEP_SECONDS),
            )
            or str(SIMULATION_CACHE_UPLOAD_RETRY_SLEEP_SECONDS)
        )
    except ValueError:
        sleep_seconds = SIMULATION_CACHE_UPLOAD_RETRY_SLEEP_SECONDS
    return attempts, max(sleep_seconds, 0.0)


def _is_transient_simulation_cache_upload_error(error: Exception) -> bool:
    if isinstance(error, (TimeoutError, OSError)):
        return True
    message = str(error).lower()
    if not message:
        return False
    transient_markers = (
        "timed out",
        "timeout",
        "temporary failure",
        "temporarily unavailable",
        "connection reset",
        "connection aborted",
        "broken pipe",
        "service unavailable",
        "ceph_upload_http_500",
        "ceph_upload_http_502",
        "ceph_upload_http_503",
        "ceph_upload_http_504",
    )
    return any(marker in message for marker in transient_markers)


def _cache_metadata(manifest: Mapping[str, Any]) -> dict[str, str]:
    metadata = _as_mapping(manifest.get("metadata"))
    performance_cfg = _performance_config(manifest)
    cache_decision = (_as_text(metadata.get("cacheDecision")) or "").lower()
    cache_key = _as_text(metadata.get("cacheKey")) or _derived_simulation_cache_key(
        manifest
    )
    cache_artifact_path = _as_text(metadata.get("cacheArtifactPath")) or ""
    cache_manifest_path = _as_text(metadata.get("cacheChunkManifestPath")) or ""
    if cache_key and (not cache_artifact_path or not cache_manifest_path):
        derived_paths = _derived_simulation_cache_paths(
            cache_key,
            _as_text(performance_cfg.get("dump_format"))
            or DEFAULT_SIMULATION_DUMP_FORMAT,
        )
        if not cache_artifact_path:
            cache_artifact_path = derived_paths["cache_artifact_path"]
        if not cache_manifest_path:
            cache_manifest_path = derived_paths["cache_manifest_path"]
    if (
        not cache_decision
        and (_as_text(performance_cfg.get("cache_policy")) or "prefer_cache")
        == "refresh"
    ):
        cache_decision = "refresh"
    return {
        "cache_key": cache_key,
        "cache_decision": cache_decision,
        "cache_artifact_path": cache_artifact_path,
        "cache_manifest_path": cache_manifest_path,
    }


def _s3_bucket_key(uri: str) -> tuple[str, str] | None:
    normalized = uri.strip()
    if not normalized.startswith("s3://"):
        return None
    path = normalized[len("s3://") :]
    bucket, _, key = path.partition("/")
    bucket = bucket.strip()
    key = key.strip("/")
    if not bucket or not key:
        return None
    return bucket, key


def _restore_cached_dump_if_available(
    *,
    manifest: Mapping[str, Any],
    dump_path: Path,
) -> dict[str, Any] | None:
    cache = _cache_metadata(manifest)
    cache_artifact_path = cache["cache_artifact_path"]
    cache_manifest_path = cache["cache_manifest_path"]
    cache_policy = (
        _as_text(_performance_config(manifest).get("cache_policy")) or "prefer_cache"
    )
    cache_decision = cache["cache_decision"]
    if cache_decision and cache_decision != "hit":
        if cache_policy == "require_cache":
            raise RuntimeError(f"required_cache_not_ready:{cache_decision}")
        return None
    if not cache_artifact_path:
        if cache_policy == "require_cache":
            raise RuntimeError("required_cache_artifact_path_missing")
        return None

    artifact_ref = _s3_bucket_key(cache_artifact_path)
    manifest_ref = _s3_bucket_key(cache_manifest_path) if cache_manifest_path else None
    if artifact_ref is None:
        if cache_policy == "require_cache":
            raise RuntimeError(
                f"required_cache_artifact_uri_invalid:{cache_artifact_path}"
            )
        return None

    client, default_bucket = _simulation_cache_client_from_env()
    if client is None:
        if cache_policy == "require_cache":
            raise RuntimeError("required_cache_client_unavailable")
        return None

    bucket, key = artifact_ref
    bucket = bucket or default_bucket
    try:
        payload = client.get_object(bucket=bucket, key=key)
        _ensure_directory(dump_path)
        dump_path.write_bytes(payload)
        if manifest_ref is not None:
            manifest_bucket, manifest_key = manifest_ref
            manifest_payload = client.get_object(
                bucket=manifest_bucket or default_bucket, key=manifest_key
            )
            artifact_manifest = json.loads(manifest_payload.decode("utf-8"))
            if not isinstance(artifact_manifest, Mapping):
                raise RuntimeError("cache_manifest_invalid_payload")
            if not _cache_artifact_lineage_matches(
                manifest=manifest,
                artifact_manifest=cast(Mapping[str, Any], artifact_manifest),
            ):
                raise RuntimeError("cache_manifest_lineage_mismatch")
            _dump_artifact_manifest_path(dump_path).write_text(
                json.dumps(dict(artifact_manifest), indent=2, sort_keys=True),
                encoding="utf-8",
            )
            _write_dump_marker_from_manifest(
                dump_path=dump_path,
                artifact_manifest=artifact_manifest,
            )
        else:
            _write_dump_marker(
                dump_path=dump_path,
                dump_sha256=_file_sha256(dump_path),
                records=_count_lines(dump_path),
                dump_format=_dump_format_for_path(dump_path),
                min_source_timestamp_ms=None,
                max_source_timestamp_ms=None,
            )
        report = _reusable_dump_report(dump_path)
        if report is None:
            raise RuntimeError("downloaded_cache_dump_validation_failed")
        report["restored_from_cache"] = True
        report["cache_artifact_path"] = cache_artifact_path
        report["cache_manifest_path"] = cache_manifest_path or None
        _log_script_event(
            "Restored simulation dump from durable cache",
            cache_key=cache["cache_key"] or "unknown",
            cache_artifact_path=cache_artifact_path,
        )
        return report
    except Exception as exc:
        dump_path.unlink(missing_ok=True)
        _dump_artifact_manifest_path(dump_path).unlink(missing_ok=True)
        if cache_policy == "require_cache":
            raise
        _log_script_event(
            "Failed to restore simulation dump from durable cache",
            cache_key=cache["cache_key"] or "unknown",
            cache_artifact_path=cache_artifact_path,
            error=str(exc),
        )
        return None


def _upload_dump_to_cache(
    *,
    manifest: Mapping[str, Any],
    dump_path: Path,
) -> dict[str, Any] | None:
    cache = _cache_metadata(manifest)
    cache_key = cache["cache_key"]
    if not cache_key:
        return None

    artifact_ref = _s3_bucket_key(cache["cache_artifact_path"])
    manifest_ref = _s3_bucket_key(cache["cache_manifest_path"])
    if artifact_ref is None or manifest_ref is None:
        return None

    timeout_seconds = _simulation_cache_upload_timeout_seconds(dump_path)
    client, default_bucket = _simulation_cache_client_from_env(
        timeout_seconds=timeout_seconds
    )
    if client is None:
        return None

    bucket, key = artifact_ref
    manifest_bucket, manifest_key = manifest_ref
    bucket = bucket or default_bucket
    manifest_bucket = manifest_bucket or default_bucket

    dump_content_type = {
        "ndjson": "application/x-ndjson",
        "jsonl.gz": "application/gzip",
        "jsonl.zst": "application/zstd",
    }[_dump_format_for_path(dump_path)]
    manifest_path = _dump_artifact_manifest_path(dump_path)
    dump_body = dump_path.read_bytes()
    manifest_body = manifest_path.read_bytes()
    retry_attempts, retry_sleep_seconds = _simulation_cache_upload_attempts()
    last_error: Exception | None = None

    for attempt in range(1, retry_attempts + 1):
        try:
            dump_result = client.put_object(
                bucket=bucket,
                key=key,
                body=dump_body,
                content_type=dump_content_type,
            )
            manifest_result = client.put_object(
                bucket=manifest_bucket,
                key=manifest_key,
                body=manifest_body,
                content_type="application/json",
            )
            return {
                "status": "ok",
                "cache_key": cache_key,
                "artifact_path": f"s3://{bucket}/{key}",
                "artifact_etag": dump_result.get("etag"),
                "manifest_path": f"s3://{manifest_bucket}/{manifest_key}",
                "manifest_etag": manifest_result.get("etag"),
                "timeout_seconds": timeout_seconds,
                "attempt_count": attempt,
            }
        except Exception as exc:
            last_error = exc
            if (
                attempt >= retry_attempts
                or not _is_transient_simulation_cache_upload_error(exc)
            ):
                break
            time.sleep(retry_sleep_seconds * attempt)

    if last_error is None:
        return None
    raise last_error


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
                        "run_id": resources.run_id,
                        "component": component,
                        "dataset_id": resources.dataset_id,
                        "lane": resources.lane,
                        "workflow_name": workflow_name,
                        "status": status,
                        "last_source_ts": last_source_ts,
                        "last_signal_ts": last_signal_ts,
                        "last_price_ts": last_price_ts,
                        "cursor_at": cursor_at,
                        "records_dumped": int(records_dumped),
                        "records_replayed": int(records_replayed),
                        "trade_decisions": int(trade_decisions),
                        "executions": int(executions),
                        "execution_tca_metrics": int(execution_tca_metrics),
                        "execution_order_events": int(execution_order_events),
                        "strategy_type": strategy_type,
                        "legacy_path_count": int(legacy_path_count),
                        "fallback_count": int(fallback_count),
                        "terminal_state": terminal_state,
                        "last_error_code": last_error_code,
                        "last_error_message": last_error_message,
                        "payload_json": json.dumps(dict(payload or {}), sort_keys=True),
                    },
                )
            conn.commit()

    try:
        _run_with_transient_postgres_retry(
            label=f"upsert_simulation_progress:{component}",
            operation=_write,
        )
    except Exception as exc:
        _log_script_event(
            "Failed to write simulation progress row",
            run_id=resources.run_id,
            component=component,
            error=str(exc),
        )


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"expected file is missing: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise SystemExit(f"file must contain a JSON object: {path}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


__all__ = [name for name in globals() if not name.startswith("__")]
