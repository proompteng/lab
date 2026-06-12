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
from .part_06_ta_restore_paths import *
from .part_07_load_optional_json import *
from .part_08_run_migrations import *
from .part_09_restore_torghut_env_required import *
from .part_10_dump_topics import *


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
        raise RuntimeError(f"dump file does not exist: {dump_path}")

    marker_path = dump_path.with_suffix(".replay-marker.json")
    if marker_path.exists() and not force:
        marker_payload = _load_json(marker_path)
        marker_dump_sha = _as_text(marker_payload.get("dump_sha256"))
        current_dump_sha = _dump_sha256_for_replay(dump_path)
        if marker_dump_sha == current_dump_sha:
            marker_payload["reused_existing_replay"] = True
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_REPLAY,
                status="replay_reused",
                records_replayed=_safe_int(marker_payload.get("records")),
                last_source_ts=_utc_from_millis(
                    _safe_int(marker_payload.get("max_source_timestamp_ms"), default=0)
                    or None
                ),
                payload={
                    "dump_format": marker_payload.get("dump_format"),
                    "reused_existing_replay": True,
                    "records_by_topic": marker_payload.get("records_by_topic", {}),
                    "replay_profile": marker_payload.get("replay_profile"),
                },
            )
            return marker_payload

    performance_cfg = _performance_config(manifest)
    replay_profile = (
        _as_text(performance_cfg.get("replay_profile"))
        or DEFAULT_SIMULATION_REPLAY_PROFILE
    )
    profile_defaults = REPLAY_PROFILE_DEFAULTS[replay_profile]
    replay_cfg = _as_mapping(manifest.get("replay"))
    pace_mode = (_as_text(replay_cfg.get("pace_mode")) or "max_throughput").lower()
    acceleration = float(replay_cfg.get("acceleration") or 60.0)
    max_sleep_seconds = float(replay_cfg.get("max_sleep_seconds") or 5.0)
    status_update_every_records = max(
        1,
        _safe_int(
            replay_cfg.get("status_update_every_records"),
            default=int(profile_defaults["status_update_every_records"]),
        ),
    )
    status_update_every_seconds = max(
        1.0,
        _safe_float(
            replay_cfg.get("status_update_every_seconds"),
            default=float(profile_defaults["status_update_every_seconds"]),
        ),
    )
    flush_every_records = max(
        1,
        _safe_int(
            replay_cfg.get("flush_every_records"),
            default=int(profile_defaults["flush_every_records"]),
        ),
    )
    flush_timeout_seconds = max(
        1.0,
        _safe_float(
            replay_cfg.get("flush_timeout_seconds"),
            default=float(profile_defaults["flush_timeout_seconds"]),
        ),
    )
    final_flush_timeout_seconds = max(
        flush_timeout_seconds,
        _safe_float(
            replay_cfg.get("final_flush_timeout_seconds"),
            default=float(profile_defaults["final_flush_timeout_seconds"]),
        ),
    )
    flush_retry_attempts = max(
        1, _safe_int(replay_cfg.get("flush_retry_attempts"), default=6)
    )

    producer = _producer_for_replay(
        kafka_config, resources.run_token, profile=replay_profile
    )
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
                checksum.update(stripped.encode("utf-8"))
                checksum.update(b"\n")

                payload = json.loads(stripped)
                if not isinstance(payload, Mapping):
                    continue
                row = _as_mapping(payload)
                source_topic = _as_text(row.get("source_topic"))
                mapped_replay_topic = (
                    resources.replay_topic_by_source_topic.get(source_topic)
                    if source_topic is not None
                    else None
                )
                dump_replay_topic = _as_text(row.get("replay_topic"))
                replay_topic = mapped_replay_topic or dump_replay_topic
                if replay_topic is None:
                    raise RuntimeError(
                        "dump row is missing replay_topic and cannot infer mapping"
                    )
                if (
                    mapped_replay_topic is not None
                    and dump_replay_topic is not None
                    and mapped_replay_topic != dump_replay_topic
                ):
                    replay_topic_overrides += 1

                current_ts_ms = cast(int | None, row.get("source_timestamp_ms"))
                delay = _pacing_delay_seconds(
                    mode=pace_mode,
                    previous_timestamp_ms=previous_ts_ms,
                    current_timestamp_ms=current_ts_ms,
                    acceleration=acceleration,
                )
                if delay > 0:
                    time.sleep(min(delay, max_sleep_seconds))

                key = _b64_to_bytes(row.get("key_b64"))
                value = _b64_to_bytes(row.get("value_b64"))
                headers = _json_to_headers(row.get("headers"))
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
                        phase="apply",
                        status="running",
                        details={
                            "subphase": "replay",
                            "records": count,
                            "records_by_topic": count_by_topic,
                        },
                    )
                    _upsert_simulation_progress_row(
                        postgres_config=postgres_config,
                        resources=resources,
                        component=COMPONENT_REPLAY,
                        status="replaying",
                        records_replayed=count,
                        last_source_ts=_utc_from_millis(current_ts_ms),
                        payload={
                            "records_by_topic": count_by_topic,
                            "replay_profile": replay_profile,
                            "pace_mode": pace_mode,
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
            phase="apply",
            status="running",
            details={
                "subphase": "replay",
                "records": count,
                "records_by_topic": count_by_topic,
                "flush_reason": "completed",
            },
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_REPLAY,
            status="replay_flush",
            records_replayed=count,
            last_source_ts=_utc_from_millis(previous_ts_ms),
            payload={
                "records_by_topic": count_by_topic,
                "flush_reason": "completed",
                "replay_profile": replay_profile,
                "pace_mode": pace_mode,
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

    duration_seconds = max(
        (datetime.now(timezone.utc) - replay_started_at).total_seconds(), 0.001
    )
    marker_payload = {
        "reused_existing_replay": False,
        "dump_format": _dump_format_for_path(dump_path),
        "replay_profile": replay_profile,
        "records": count,
        "records_by_topic": count_by_topic,
        "pace_mode": pace_mode,
        "acceleration": acceleration,
        "flush_every_records": flush_every_records,
        "flush_timeout_seconds": flush_timeout_seconds,
        "final_flush_timeout_seconds": final_flush_timeout_seconds,
        "flush_retry_attempts": flush_retry_attempts,
        "replay_topic_overrides": replay_topic_overrides,
        "dump_sha256": checksum.hexdigest(),
        "duration_seconds": duration_seconds,
        "records_per_second": count / duration_seconds if count > 0 else 0.0,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }
    _upsert_simulation_progress_row(
        postgres_config=postgres_config,
        resources=resources,
        component=COMPONENT_REPLAY,
        status="replayed",
        records_replayed=count,
        last_source_ts=_utc_from_millis(previous_ts_ms),
        terminal_state="complete",
        payload={
            "records_by_topic": count_by_topic,
            "dump_format": _dump_format_for_path(dump_path),
            "replay_profile": replay_profile,
            "pace_mode": pace_mode,
            "records_per_second": marker_payload["records_per_second"],
            "duration_seconds": duration_seconds,
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
    source_topics = {
        topic for topic in resources.source_topic_by_role.values() if topic
    }
    simulation_topics = {
        topic for topic in resources.simulation_topic_by_role.values() if topic
    }
    replay_source_topics = {
        topic for topic in resources.replay_topic_by_source_topic.keys() if topic
    }
    replay_target_topics = {
        topic for topic in resources.replay_topic_by_source_topic.values() if topic
    }
    production_topics = {topic for topic in PRODUCTION_TOPIC_BY_ROLE.values() if topic}

    checks = {
        "clickhouse_db_isolated": resources.clickhouse_db != "torghut",
        "postgres_db_isolated": postgres_config.simulation_db != "torghut",
        "simulation_topics_isolated_from_sources": simulation_topics.isdisjoint(
            source_topics
        ),
        "replay_targets_isolated_from_replay_sources": replay_target_topics.isdisjoint(
            replay_source_topics
        ),
        "simulation_topics_not_production_defaults": simulation_topics.isdisjoint(
            production_topics
        ),
        "ta_group_isolated": resources.warm_lane_enabled
        or resources.ta_group_id != _as_text(ta_data.get("TA_GROUP_ID")),
    }
    if not all(checks.values()):
        failed = [key for key, passed in checks.items() if not passed]
        raise RuntimeError(f"isolation_guard_failed:{','.join(failed)}")
    return checks


def _apply(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    kafka_config: KafkaRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    postgres_config: PostgresRuntimeConfig,
    argocd_config: ArgocdAutomationConfig | None = None,
    force_dump: bool,
    force_replay: bool,
) -> dict[str, Any]:
    _ensure_supported_binary("kubectl")
    _ensure_lz4_codec_available()
    window_start, window_end = _resolve_window_bounds(manifest)
    window_policy = _validate_window_policy(manifest)
    torghut_env_overrides = _torghut_env_overrides_from_manifest(manifest)
    warm_lane_enabled = resources.warm_lane_enabled
    account_label = _simulation_account_label(
        resources=resources,
        manifest=manifest,
        torghut_env_overrides=torghut_env_overrides,
    )
    ta_reconfigured = False
    torghut_reconfigured = False
    ta_restart_nonce: int | None = None
    argocd_runtime_guard_report: dict[str, Any] | None = None

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

        ta_data = _as_mapping(state.get("ta_data"))
        ta_restore = _resolve_ta_restore_configuration(
            ta_data=ta_data,
            manifest=manifest,
        )
        if bool(ta_restore.get("fallback_applied")):
            _log_script_event(
                "Using stateless TA recovery for simulation run",
                run_id=resources.run_id,
                reason=ta_restore.get("reason"),
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
            _ensure_clickhouse_database(
                config=clickhouse_config, database=resources.clickhouse_db
            )
        _ensure_clickhouse_runtime_tables(
            config=clickhouse_config,
            database=resources.clickhouse_db,
            lane=resources.lane,
        )
        postgres_database_precreated = _postgres_database_precreated(manifest)
        if not postgres_database_precreated:
            _ensure_postgres_database(postgres_config)
        _ensure_postgres_runtime_permissions(postgres_config)
        _run_migrations(postgres_config)
        # Alembic runs under the admin role, so newly created objects must be re-granted to the runtime role.
        postgres_permissions_report = _ensure_postgres_runtime_permissions(
            postgres_config
        )
        _reset_postgres_runtime_state(postgres_config)
        seeded_cursor_at = _seed_simulation_trade_cursor(
            config=postgres_config,
            manifest=manifest,
            account_label=account_label,
        )
        _upsert_simulation_runtime_context(
            config=postgres_config,
            resources=resources,
            manifest=manifest,
            account_label=account_label,
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_REPLAY,
            status="pending",
            payload={
                "phase": "apply",
                "window_start": window_start.astimezone(timezone.utc).isoformat(),
                "window_end": window_end.astimezone(timezone.utc).isoformat(),
                "warm_lane_enabled": warm_lane_enabled,
            },
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_TA,
            status="pending",
            payload={
                "phase": "runtime_verify",
                "window_start": window_start.astimezone(timezone.utc).isoformat(),
                "window_end": window_end.astimezone(timezone.utc).isoformat(),
                "warm_lane_enabled": warm_lane_enabled,
            },
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_TORGHUT,
            status="pending",
            payload={
                "phase": "runtime_verify",
                "window_start": window_start.astimezone(timezone.utc).isoformat(),
                "window_end": window_end.astimezone(timezone.utc).isoformat(),
                "warm_lane_enabled": warm_lane_enabled,
            },
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_ARTIFACTS,
            status="pending",
            payload={
                "phase": "report",
                "window_start": window_start.astimezone(timezone.utc).isoformat(),
                "window_end": window_end.astimezone(timezone.utc).isoformat(),
                "warm_lane_enabled": warm_lane_enabled,
            },
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
        replay_cfg = _as_mapping(manifest.get("replay"))
        auto_offset_reset = (
            _as_text(replay_cfg.get("auto_offset_reset")) or "earliest"
        ).lower()
        if argocd_config is not None and resources.target_mode == "dedicated_service":
            argocd_runtime_guard_report = _ensure_argocd_manual_before_runtime_mutation(
                config=argocd_config,
                resources=resources,
            )
        ta_reconfigured = _ta_runtime_reconfigure_required(
            resources=resources,
            clickhouse_config=clickhouse_config,
            clickhouse_database=resources.clickhouse_db,
            auto_offset_reset=auto_offset_reset,
            manifest=manifest,
        )
        ta_restart_required = warm_lane_enabled or ta_reconfigured
        ta_restart_forced = warm_lane_enabled and not ta_reconfigured
        if ta_reconfigured:
            _configure_ta_for_simulation(
                resources=resources,
                clickhouse_config=clickhouse_config,
                clickhouse_database=resources.clickhouse_db,
                auto_offset_reset=auto_offset_reset,
                manifest=manifest,
            )
        if ta_restart_required:
            ta_restart_nonce = _restart_ta_deployment(
                resources,
                desired_state="running",
                upgrade_mode=str(
                    ta_restore.get("effective_upgrade_mode") or "last-state"
                ),
            )
        else:
            ta_restart_nonce = None

        torghut_reconfigured = _torghut_service_reconfigure_required(
            resources=resources,
            manifest=manifest,
            postgres_config=postgres_config,
            clickhouse_config=clickhouse_config,
            kafka_config=kafka_config,
            torghut_env_overrides=torghut_env_overrides,
        )
        if torghut_reconfigured:
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
        "status": "ok",
        "mode": "apply",
        "run_id": resources.run_id,
        "dataset_id": resources.dataset_id,
        "applied_at": datetime.now(timezone.utc).isoformat(),
        "state_path": str(state_path),
        "dump": dump_report,
        "dump_coverage": dump_coverage,
        "topics": topics_report,
        "schema_registry": schema_registry_report,
        "ta_restart_nonce": ta_restart_nonce,
        "ta_restart_forced": ta_restart_forced,
        "ta_reconfigured": ta_reconfigured,
        "torghut_reconfigured": torghut_reconfigured,
        "argocd_runtime_guard": argocd_runtime_guard_report,
        "warm_lane_enabled": warm_lane_enabled,
        "account_label": account_label,
        "seeded_cursor_at": seeded_cursor_at.isoformat(),
        "resources": asdict(resources)
        | {
            "output_root": str(resources.output_root),
        },
        "postgres": {
            "simulation_dsn": _redact_dsn_credentials(postgres_config.simulation_dsn),
            "simulation_db": postgres_config.simulation_db,
            "database_precreated": postgres_database_precreated,
            "runtime_permissions": postgres_permissions_report,
        },
        "clickhouse": {
            "http_url": clickhouse_config.http_url,
            "database": resources.clickhouse_db,
            "database_precreated": clickhouse_database_precreated,
        },
        "simulation_lock": runtime_lock,
        "evidence_lineage": _simulation_evidence_lineage(manifest),
        "torghut_env_overrides": torghut_env_overrides,
        "ta_restore": ta_restore,
        "window_policy": window_policy,
    }
    _save_json(run_manifest_path, report)
    return report


def _teardown(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any] | None = None,
    allow_missing_state: bool,
) -> dict[str, Any]:
    _ensure_supported_binary("kubectl")
    warm_lane_enabled = resources.warm_lane_enabled
    state_path, run_manifest_path, dump_path = _state_paths(resources, manifest)
    if not state_path.exists():
        lock_report = _release_simulation_runtime_lock(resources=resources)
        if allow_missing_state:
            return {
                "status": "ok",
                "mode": "teardown",
                "run_id": resources.run_id,
                "teardown_at": datetime.now(timezone.utc).isoformat(),
                "state_found": False,
                "simulation_lock": lock_report,
            }
        raise SystemExit(f"state file not found: {state_path}")

    runtime_lock = _read_simulation_runtime_lock(resources.namespace)
    if runtime_lock is None:
        return {
            "status": "degraded",
            "mode": "teardown",
            "run_id": resources.run_id,
            "teardown_at": datetime.now(timezone.utc).isoformat(),
            "state_path": str(state_path),
            "run_manifest_path": str(run_manifest_path),
            "dump_path": str(dump_path),
            "simulation_lock": {"status": "missing"},
            "skipped_restore": True,
            "reason": "simulation_runtime_lock_missing_for_teardown",
        }
    if runtime_lock.get("run_id") != resources.run_id:
        return {
            "status": "degraded",
            "mode": "teardown",
            "run_id": resources.run_id,
            "teardown_at": datetime.now(timezone.utc).isoformat(),
            "state_path": str(state_path),
            "run_manifest_path": str(run_manifest_path),
            "dump_path": str(dump_path),
            "simulation_lock": {
                "status": "not_owner",
                **runtime_lock,
            },
            "skipped_restore": True,
            "reason": "simulation_runtime_lock_not_owned_by_run",
        }

    state = _load_json(state_path)
    original_state = _as_text(state.get("ta_job_state")) or "running"
    if warm_lane_enabled:
        ta_reconfigured = False
        torghut_reconfigured = False
        ta_restart_nonce = None
        skipped_restore = True
        retained_warm_lane_baseline = True
    else:
        ta_reconfigured = _restore_ta_configuration_required(resources, state)
        torghut_reconfigured = _restore_torghut_env_required(resources, state)
        if ta_reconfigured:
            _restore_ta_configuration(resources, state)
        if torghut_reconfigured:
            _restore_torghut_env(resources, state)
        ta_restart_nonce = (
            _restart_ta_deployment(resources, desired_state=original_state)
            if ta_reconfigured
            else None
        )
        skipped_restore = False
        retained_warm_lane_baseline = False
    lock_report = _release_simulation_runtime_lock(resources=resources)
    report = {
        "status": "ok",
        "mode": "teardown",
        "run_id": resources.run_id,
        "teardown_at": datetime.now(timezone.utc).isoformat(),
        "state_path": str(state_path),
        "run_manifest_path": str(run_manifest_path),
        "dump_path": str(dump_path),
        "ta_restart_nonce": ta_restart_nonce,
        "ta_reconfigured": ta_reconfigured,
        "torghut_reconfigured": torghut_reconfigured,
        "restored_ta_state": original_state,
        "warm_lane_enabled": warm_lane_enabled,
        "skipped_restore": skipped_restore,
        "retained_warm_lane_baseline": retained_warm_lane_baseline,
        "simulation_lock": lock_report,
    }
    _save_json(run_manifest_path.with_name("teardown-manifest.json"), report)
    return report


__all__ = [name for name in globals() if not name.startswith("__")]
