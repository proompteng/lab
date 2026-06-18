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
    DEFAULT_ARGOCD_APPSET_NAME,
    DEFAULT_ARGOCD_APP_NAME,
    DEFAULT_ARGOCD_NAMESPACE,
    DEFAULT_ARGOCD_ROOT_APP_NAME,
    DEFAULT_ARGOCD_RUN_MODE,
    DEFAULT_NAMESPACE,
    DEFAULT_OUTPUT_ROOT,
    DEFAULT_ROLLOUTS_ACTIVITY_TEMPLATE,
    DEFAULT_ROLLOUTS_ARTIFACT_TEMPLATE,
    DEFAULT_ROLLOUTS_NAMESPACE,
    DEFAULT_ROLLOUTS_RUNTIME_TEMPLATE,
    DEFAULT_ROLLOUTS_TEARDOWN_TEMPLATE,
    DEFAULT_ROLLOUTS_VERIFY_POLL_SECONDS,
    DEFAULT_ROLLOUTS_VERIFY_TIMEOUT_SECONDS,
    DEFAULT_SIM_TA_CONFIGMAP,
    DEFAULT_SIM_TA_DEPLOYMENT,
    DEFAULT_SIM_TORGHUT_SERVICE,
    DEFAULT_TA_CONFIGMAP,
    DEFAULT_TA_DEPLOYMENT,
    DEFAULT_TORGHUT_SERVICE,
    DEFAULT_WARM_LANE_SIMULATION_DATABASE,
    NON_TRANSIENT_POSTGRES_ERROR_PATTERNS,
    TRANSIENT_POSTGRES_ERROR_PATTERNS,
)
from .runtime_config import (
    ArgocdAutomationConfig,
    AutonomyLaneConfig,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    SimulationResources,
    _as_mapping,
    _as_text,
    _database_name_from_dsn,
    _derive_simulation_dsn,
    _ensure_dsn_password,
    _normalize_run_token,
    _replace_database_in_dsn,
    _replace_password_in_dsn,
    _resolve_manifest_relative_path,
    _safe_int,
    _truthy,
    _validate_simulation_strategy_policy,
)


def _normalize_migrations_command(command: str) -> str:
    normalized = command.strip()
    if not normalized:
        return normalized
    uv_path = shutil.which("uv") or "uv"
    alembic_path = shutil.which("alembic") or "alembic"
    if normalized in {"uv", "uv run --frozen alembic upgrade heads"}:
        normalized = f"{uv_path} run --frozen {alembic_path} upgrade heads"
    elif normalized.startswith("uv "):
        if normalized.startswith("uv run --frozen alembic upgrade"):
            normalized_tail = normalized[
                len("uv run --frozen alembic upgrade") :
            ].lstrip()
            if normalized_tail:
                normalized = (
                    f"{uv_path} run --frozen {alembic_path} upgrade {normalized_tail}"
                )
            else:
                normalized = f"{uv_path} run --frozen {alembic_path} upgrade"
        else:
            normalized = f"{uv_path} {normalized[len('uv ') :]}"
    elif normalized.startswith("alembic "):
        normalized = f"{alembic_path} {normalized[len('alembic ') :]}"
    return re.sub(
        r"\balembic\s+upgrade\s+head\b",
        "alembic upgrade heads",
        normalized,
    )


def _find_vector_extension_blocking_revision(repo_root: Path) -> str | None:
    migrations_dir = repo_root / "migrations" / "versions"
    if not migrations_dir.is_dir():
        return None

    revision_re = re.compile(r'^\s*revision\s*=\s*([\'"])(.*?)\1')
    down_revision_re = re.compile(r'^\s*down_revision\s*=\s*([\'"])(.*?)\1')

    vector_revision_targets: list[str] = []
    for migration_file in sorted(migrations_dir.glob("*.py")):
        try:
            payload = migration_file.read_text(encoding="utf-8")
        except OSError:
            continue
        lowered = payload.lower()
        if "create extension if not exists vector" not in lowered:
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

        if down_revision in (None, "None"):
            return "base"
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
        upgrade_index = tokens.index("upgrade")
    except ValueError:
        return None
    if len(tokens) <= upgrade_index + 1:
        return None
    tokens[upgrade_index + 1] = target
    return " ".join(shlex.quote(item) for item in tokens)


def _resolve_command_args(command: str) -> list[str]:
    try:
        tokens = shlex.split(command)
    except Exception as exc:
        raise RuntimeError(f"command_parse_failed:{command}") from exc
    if not tokens:
        raise RuntimeError("command_parse_failed:empty")
    binary = tokens[0]
    if os.path.isabs(binary) and not Path(binary).exists():
        fallback_binary = shutil.which(Path(binary).name)
        if fallback_binary:
            from .state_and_cache import _log_script_event

            _log_script_event(
                "command_binary_resolved",
                original_binary=binary,
                resolved_binary=fallback_binary,
            )
            tokens[0] = fallback_binary
        else:
            raise RuntimeError(f"command_binary_not_found:{binary}")
    return tokens


def _run_alembic_upgrade(
    *,
    command: str,
    env: Mapping[str, str],
    cwd: Path,
    label: str = "run_migrations",
) -> None:
    from .kubernetes_argocd import _run_with_transient_postgres_retry

    _run_with_transient_postgres_retry(
        label=label,
        operation=lambda: _run_command(
            _resolve_command_args(command),
            cwd=cwd,
            env=env,
        ),
    )


def _build_postgres_runtime_config(
    manifest: Mapping[str, Any],
    *,
    simulation_db: str,
) -> PostgresRuntimeConfig:
    postgres = _as_mapping(manifest.get("postgres"))
    admin_dsn = _as_text(postgres.get("admin_dsn"))
    admin_dsn_env = _as_text(postgres.get("admin_dsn_env"))
    if admin_dsn is None and admin_dsn_env:
        admin_dsn = _as_text(os.environ.get(admin_dsn_env))
    if not admin_dsn:
        raise SystemExit("manifest.postgres.admin_dsn is required")
    admin_password = _as_text(postgres.get("admin_dsn_password"))
    if admin_password is None:
        admin_password_env = _as_text(postgres.get("admin_dsn_password_env"))
        if admin_password_env:
            admin_password = _as_text(os.environ.get(admin_password_env))
    if admin_password:
        admin_dsn = _replace_password_in_dsn(
            admin_dsn,
            password=admin_password,
            label="manifest.postgres.admin_dsn",
        )
    simulation_password = _as_text(postgres.get("simulation_dsn_password"))
    if simulation_password is None:
        simulation_password_env = _as_text(postgres.get("simulation_dsn_password_env"))
        if simulation_password_env:
            simulation_password = _as_text(os.environ.get(simulation_password_env))
    effective_simulation_password = simulation_password or admin_password

    simulation_dsn = _as_text(postgres.get("simulation_dsn"))
    simulation_template = _as_text(postgres.get("simulation_dsn_template"))
    if simulation_dsn is None and simulation_template is not None:
        simulation_dsn = simulation_template.replace("{db}", simulation_db)
    if simulation_dsn is None:
        simulation_dsn = _derive_simulation_dsn(admin_dsn, simulation_db)
    simulation_dsn = _ensure_dsn_password(
        simulation_dsn,
        password=effective_simulation_password,
        label="manifest.postgres.simulation_dsn",
    )
    simulation_db = _database_name_from_dsn(
        simulation_dsn,
        label="manifest.postgres.simulation_dsn",
    )
    runtime_password = _as_text(postgres.get("runtime_simulation_dsn_password"))
    if runtime_password is None:
        runtime_password_env = _as_text(
            postgres.get("runtime_simulation_dsn_password_env")
        )
        if runtime_password_env:
            runtime_password = _as_text(os.environ.get(runtime_password_env))
    effective_runtime_password = runtime_password or effective_simulation_password
    runtime_simulation_dsn = _as_text(postgres.get("runtime_simulation_dsn"))
    runtime_template = _as_text(postgres.get("runtime_simulation_dsn_template"))
    if runtime_simulation_dsn is None and runtime_template is not None:
        runtime_simulation_dsn = runtime_template.replace("{db}", simulation_db)
    if runtime_simulation_dsn is not None:
        runtime_simulation_dsn = _ensure_dsn_password(
            runtime_simulation_dsn,
            password=effective_runtime_password,
            label="manifest.postgres.runtime_simulation_dsn",
        )
        runtime_db = _database_name_from_dsn(
            runtime_simulation_dsn,
            label="manifest.postgres.runtime_simulation_dsn",
        )
        if runtime_db != simulation_db:
            raise SystemExit(
                "manifest.postgres.runtime_simulation_dsn must target the same database as "
                "manifest.postgres.simulation_dsn"
            )

    migrations_command_raw = (
        _as_text(postgres.get("migrations_command"))
        or "uv run --frozen alembic upgrade heads"
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
    ta_config = _as_mapping(manifest.get("ta_config"))
    overrides = _as_mapping(ta_config.get("topic_key_by_role"))
    return _merge_topics(lane_contract.ta_topic_key_by_role, overrides)


def _ta_clickhouse_url_key(*, lane: str, manifest: Mapping[str, Any]) -> str:
    lane_contract = simulation_lane_contract(lane)
    ta_config = _as_mapping(manifest.get("ta_config"))
    return (
        _as_text(ta_config.get("clickhouse_url_key"))
        or lane_contract.ta_clickhouse_url_key
    )


def _ta_group_id_key(*, lane: str, manifest: Mapping[str, Any]) -> str:
    lane_contract = simulation_lane_contract(lane)
    ta_config = _as_mapping(manifest.get("ta_config"))
    return _as_text(ta_config.get("group_id_key")) or lane_contract.ta_group_id_key


def _ta_auto_offset_reset_key(*, lane: str, manifest: Mapping[str, Any]) -> str:
    lane_contract = simulation_lane_contract(lane)
    ta_config = _as_mapping(manifest.get("ta_config"))
    return (
        _as_text(ta_config.get("auto_offset_reset_key"))
        or lane_contract.ta_auto_offset_reset_key
    )


def _warm_lane_enabled(
    *, manifest: Mapping[str, Any], lane: str, target_mode: str
) -> bool:
    runtime = _as_mapping(manifest.get("runtime"))
    explicit = runtime.get("use_warm_lane")
    if explicit is None:
        explicit = runtime.get("useWarmLane")
    return explicit is not None and str(explicit).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _default_simulation_postgres_db(resources: SimulationResources) -> str:
    if resources.warm_lane_enabled:
        return DEFAULT_WARM_LANE_SIMULATION_DATABASE
    return f"torghut_sim_{resources.run_token}"


def _build_resources(run_id: str, manifest: Mapping[str, Any]) -> SimulationResources:
    _validate_simulation_strategy_policy(manifest)
    lane_contract = simulation_lane_contract_for_manifest(manifest)
    run_token = _normalize_run_token(run_id)
    dataset_id = _as_text(manifest.get("dataset_id"))
    if not dataset_id:
        raise SystemExit("manifest.dataset_id is required")

    runtime = _as_mapping(manifest.get("runtime"))
    target_mode = (
        (_as_text(runtime.get("target_mode")) or "dedicated_service").strip().lower()
    )
    if target_mode not in {"dedicated_service", "in_place"}:
        raise RuntimeError(
            "runtime.target_mode must be one of: dedicated_service,in_place"
        )
    warm_lane = _warm_lane_enabled(
        manifest=manifest,
        lane=lane_contract.lane,
        target_mode=target_mode,
    )
    output_root_raw = _as_text(runtime.get("output_root"))
    if output_root_raw:
        output_root = Path(output_root_raw)
    elif lane_contract.lane != "equity":
        output_root = DEFAULT_OUTPUT_ROOT / lane_contract.lane
    else:
        output_root = DEFAULT_OUTPUT_ROOT

    source_topics = _merge_topics(
        lane_contract.source_topic_by_role,
        _as_mapping(manifest.get("source_topics")),
    )
    simulation_topic_overrides = _as_mapping(manifest.get("simulation_topics"))
    simulation_topics = _merge_topics(
        lane_contract.simulation_topic_by_role,
        simulation_topic_overrides,
    )
    for role, topic in list(simulation_topics.items()):
        if role in simulation_topic_overrides:
            continue
        simulation_topics[role] = topic if warm_lane else f"{topic}.{run_token}"

    replay_topic_by_source_topic = {
        source_topics[role]: simulation_topics[role]
        for role in lane_contract.replay_roles
    }

    clickhouse_cfg = _as_mapping(manifest.get("clickhouse"))
    clickhouse_db = (
        DEFAULT_WARM_LANE_SIMULATION_DATABASE
        if warm_lane
        else (
            _as_text(clickhouse_cfg.get("simulation_database"))
            or f"torghut_sim_{run_token}"
        )
    )
    clickhouse_table_by_role = simulation_clickhouse_table_names(
        lane=lane_contract.lane,
        database=clickhouse_db,
    )
    clickhouse_signal_table = clickhouse_table_by_role[lane_contract.signal_table_role]
    clickhouse_price_table = clickhouse_table_by_role[lane_contract.price_table_role]

    default_ta_configmap = (
        DEFAULT_SIM_TA_CONFIGMAP
        if target_mode == "dedicated_service"
        else DEFAULT_TA_CONFIGMAP
    )
    default_ta_deployment = (
        DEFAULT_SIM_TA_DEPLOYMENT
        if target_mode == "dedicated_service"
        else DEFAULT_TA_DEPLOYMENT
    )
    default_torghut_service = (
        DEFAULT_SIM_TORGHUT_SERVICE
        if target_mode == "dedicated_service"
        else DEFAULT_TORGHUT_SERVICE
    )
    ta_group_prefix = (
        "torghut-options-ta-sim"
        if lane_contract.lane == "options"
        else "torghut-ta-sim"
    )
    order_feed_group_prefix = (
        "torghut-options-order-feed-sim"
        if lane_contract.lane == "options"
        else "torghut-order-feed-sim"
    )
    ta_group_id = (
        f"{ta_group_prefix}-default" if warm_lane else f"{ta_group_prefix}-{run_token}"
    )
    order_feed_group_id = (
        f"{order_feed_group_prefix}-default"
        if warm_lane
        else f"{order_feed_group_prefix}-{run_token}"
    )

    return SimulationResources(
        run_id=run_id,
        run_token=run_token,
        dataset_id=dataset_id,
        lane=lane_contract.lane,
        target_mode=target_mode,
        namespace=_as_text(runtime.get("namespace")) or DEFAULT_NAMESPACE,
        ta_configmap=_as_text(runtime.get("ta_configmap")) or default_ta_configmap,
        ta_deployment=_as_text(runtime.get("ta_deployment")) or default_ta_deployment,
        torghut_service=_as_text(runtime.get("torghut_service"))
        or default_torghut_service,
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


def _canonicalize_warm_lane_manifest(
    manifest: Mapping[str, Any],
    *,
    resources: SimulationResources,
) -> dict[str, Any]:
    if not resources.warm_lane_enabled:
        return _as_mapping(manifest)

    normalized = cast(dict[str, Any], json.loads(json.dumps(dict(manifest))))
    clickhouse = _as_mapping(normalized.get("clickhouse"))
    clickhouse["simulation_database"] = resources.clickhouse_db
    normalized["clickhouse"] = clickhouse

    postgres = _as_mapping(normalized.get("postgres"))
    simulation_db = _default_simulation_postgres_db(resources)
    simulation_dsn = _as_text(postgres.get("simulation_dsn"))
    if simulation_dsn:
        postgres["simulation_dsn"] = _replace_database_in_dsn(
            simulation_dsn,
            database=simulation_db,
            label="manifest.postgres.simulation_dsn",
        )
    runtime_simulation_dsn = _as_text(postgres.get("runtime_simulation_dsn"))
    if runtime_simulation_dsn:
        postgres["runtime_simulation_dsn"] = _replace_database_in_dsn(
            runtime_simulation_dsn,
            database=simulation_db,
            label="manifest.postgres.runtime_simulation_dsn",
        )
    normalized["postgres"] = postgres
    return normalized


def _build_argocd_automation_config(
    manifest: Mapping[str, Any],
) -> ArgocdAutomationConfig:
    argocd = _as_mapping(manifest.get("argocd"))
    manage_automation = str(
        argocd.get("manage_automation", "false")
    ).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    desired_mode = (
        _as_text(argocd.get("desired_mode_during_run")) or DEFAULT_ARGOCD_RUN_MODE
    ).lower()
    if desired_mode not in {"manual", "auto"}:
        raise RuntimeError("argocd.desired_mode_during_run must be one of: manual,auto")
    restore_mode = (
        _as_text(argocd.get("restore_mode_after_run")) or "previous"
    ).lower()
    if restore_mode not in {"previous", "manual", "auto"}:
        raise RuntimeError(
            "argocd.restore_mode_after_run must be one of: previous,manual,auto"
        )
    verify_timeout_seconds = _safe_int(
        argocd.get("verify_timeout_seconds"), default=600
    )
    if verify_timeout_seconds <= 0:
        raise RuntimeError("argocd.verify_timeout_seconds must be > 0")
    return ArgocdAutomationConfig(
        manage_automation=manage_automation,
        applicationset_name=_as_text(argocd.get("applicationset_name"))
        or DEFAULT_ARGOCD_APPSET_NAME,
        applicationset_namespace=_as_text(argocd.get("applicationset_namespace"))
        or DEFAULT_ARGOCD_NAMESPACE,
        app_name=_as_text(argocd.get("app_name")) or DEFAULT_ARGOCD_APP_NAME,
        root_app_name=_as_text(argocd.get("root_app_name"))
        or DEFAULT_ARGOCD_ROOT_APP_NAME,
        desired_mode_during_run=desired_mode,
        restore_mode_after_run=restore_mode,
        verify_timeout_seconds=verify_timeout_seconds,
    )


def _build_rollouts_analysis_config(
    manifest: Mapping[str, Any],
) -> RolloutsAnalysisConfig:
    rollouts = _as_mapping(manifest.get("rollouts"))
    enabled = str(rollouts.get("enabled", "false")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    verify_timeout_seconds = _safe_int(
        rollouts.get("verify_timeout_seconds"),
        default=DEFAULT_ROLLOUTS_VERIFY_TIMEOUT_SECONDS,
    )
    if verify_timeout_seconds <= 0:
        raise RuntimeError("rollouts.verify_timeout_seconds must be > 0")
    verify_poll_seconds = _safe_int(
        rollouts.get("verify_poll_seconds"),
        default=DEFAULT_ROLLOUTS_VERIFY_POLL_SECONDS,
    )
    if verify_poll_seconds <= 0:
        raise RuntimeError("rollouts.verify_poll_seconds must be > 0")
    return RolloutsAnalysisConfig(
        enabled=enabled,
        namespace=_as_text(rollouts.get("namespace")) or DEFAULT_ROLLOUTS_NAMESPACE,
        runtime_template=_as_text(rollouts.get("runtime_template"))
        or DEFAULT_ROLLOUTS_RUNTIME_TEMPLATE,
        activity_template=_as_text(rollouts.get("activity_template"))
        or DEFAULT_ROLLOUTS_ACTIVITY_TEMPLATE,
        teardown_template=_as_text(rollouts.get("teardown_template"))
        or DEFAULT_ROLLOUTS_TEARDOWN_TEMPLATE,
        artifact_template=_as_text(rollouts.get("artifact_template"))
        or DEFAULT_ROLLOUTS_ARTIFACT_TEMPLATE,
        verify_timeout_seconds=verify_timeout_seconds,
        verify_poll_seconds=verify_poll_seconds,
    )


def _build_autonomy_lane_config(
    manifest: Mapping[str, Any],
    *,
    manifest_path: Path,
    resources: SimulationResources,
) -> AutonomyLaneConfig:
    autonomy = _as_mapping(manifest.get("autonomy"))
    enabled = _truthy(autonomy.get("enabled"))
    if not enabled:
        return AutonomyLaneConfig(enabled=False)

    promotion_target = (_as_text(autonomy.get("promotion_target")) or "paper").lower()
    if promotion_target not in {"shadow", "paper", "live"}:
        raise RuntimeError(
            "autonomy.promotion_target must be one of: shadow,paper,live"
        )

    output_dir = _resolve_manifest_relative_path(
        autonomy.get("output_dir"),
        manifest_path=manifest_path,
        label="autonomy.output_dir",
        must_exist=False,
    )
    artifact_path = _resolve_manifest_relative_path(
        autonomy.get("artifact_path"),
        manifest_path=manifest_path,
        label="autonomy.artifact_path",
        must_exist=False,
    )
    default_output_dir = resources.output_root / resources.run_token / "autonomy"

    return AutonomyLaneConfig(
        enabled=True,
        signals_path=_resolve_manifest_relative_path(
            autonomy.get("signals"),
            manifest_path=manifest_path,
            label="autonomy.signals",
        ),
        strategy_config_path=_resolve_manifest_relative_path(
            autonomy.get("strategy_config"),
            manifest_path=manifest_path,
            label="autonomy.strategy_config",
        ),
        gate_policy_path=_resolve_manifest_relative_path(
            autonomy.get("gate_policy"),
            manifest_path=manifest_path,
            label="autonomy.gate_policy",
        ),
        output_dir=output_dir or default_output_dir,
        artifact_path=artifact_path or output_dir or default_output_dir,
        repository=_as_text(autonomy.get("repository")),
        base=_as_text(autonomy.get("base")),
        head=_as_text(autonomy.get("head")),
        priority_id=_as_text(autonomy.get("priority_id")),
        design_doc=_as_text(autonomy.get("design_doc")),
        promotion_target=promotion_target,
        strategy_configmap_path=_resolve_manifest_relative_path(
            autonomy.get("strategy_configmap"),
            manifest_path=manifest_path,
            label="autonomy.strategy_configmap",
        ),
        approval_token=_as_text(autonomy.get("approval_token")),
        persist_results=not _truthy(autonomy.get("no_persist_results")),
        alpha_train_prices_path=_resolve_manifest_relative_path(
            autonomy.get("alpha_train_prices"),
            manifest_path=manifest_path,
            label="autonomy.alpha_train_prices",
        ),
        alpha_test_prices_path=_resolve_manifest_relative_path(
            autonomy.get("alpha_test_prices"),
            manifest_path=manifest_path,
            label="autonomy.alpha_test_prices",
        ),
        alpha_gate_policy_path=_resolve_manifest_relative_path(
            autonomy.get("alpha_gate_policy"),
            manifest_path=manifest_path,
            label="autonomy.alpha_gate_policy",
        ),
    )


def _run_simulation_autonomy_lane(
    *,
    resources: SimulationResources,
    autonomy_config: AutonomyLaneConfig,
) -> dict[str, Any] | None:
    if not autonomy_config.enabled:
        return None
    if autonomy_config.signals_path is None:
        raise RuntimeError("autonomy.signals is required when autonomy.enabled=true")
    if autonomy_config.strategy_config_path is None:
        raise RuntimeError(
            "autonomy.strategy_config is required when autonomy.enabled=true"
        )
    if autonomy_config.gate_policy_path is None:
        raise RuntimeError(
            "autonomy.gate_policy is required when autonomy.enabled=true"
        )
    if autonomy_config.output_dir is None:
        raise RuntimeError("autonomy.output_dir could not be resolved")

    result = run_autonomous_lane(
        signals_path=autonomy_config.signals_path,
        strategy_config_path=autonomy_config.strategy_config_path,
        gate_policy_path=autonomy_config.gate_policy_path,
        output_dir=autonomy_config.output_dir,
        repository=autonomy_config.repository,
        base=autonomy_config.base,
        head=autonomy_config.head,
        artifact_path=str(autonomy_config.artifact_path)
        if autonomy_config.artifact_path is not None
        else None,
        priority_id=autonomy_config.priority_id,
        design_doc=autonomy_config.design_doc,
        promotion_target=cast(Any, autonomy_config.promotion_target),
        strategy_configmap_path=autonomy_config.strategy_configmap_path,
        code_version="historical-simulation-wrapper",
        approval_token=autonomy_config.approval_token,
        persist_results=autonomy_config.persist_results,
        alpha_train_prices_path=autonomy_config.alpha_train_prices_path,
        alpha_test_prices_path=autonomy_config.alpha_test_prices_path,
        alpha_gate_policy_path=autonomy_config.alpha_gate_policy_path,
    )
    report = {
        "status": "ok",
        "run_id": result.run_id,
        "candidate_id": result.candidate_id,
        "output_dir": str(result.output_dir),
        "gate_report_path": str(result.gate_report_path),
        "actuation_intent_path": str(result.actuation_intent_path)
        if result.actuation_intent_path
        else None,
        "paper_patch_path": str(result.paper_patch_path)
        if result.paper_patch_path
        else None,
        "phase_manifest_path": str(result.phase_manifest_path),
        "recommendation_artifact_path": str(result.recommendation_artifact_path),
        "candidate_spec_path": str(result.candidate_spec_path),
        "candidate_generation_manifest_path": str(
            result.candidate_generation_manifest_path
        ),
        "evaluation_manifest_path": str(result.evaluation_manifest_path),
        "recommendation_manifest_path": str(result.recommendation_manifest_path),
        "profitability_manifest_path": str(result.profitability_manifest_path),
        "benchmark_parity_path": str(result.benchmark_parity_path),
        "foundation_router_parity_path": str(result.foundation_router_parity_path),
        "stage_trace_ids": dict(result.stage_trace_ids),
        "stage_lineage_root": result.stage_lineage_root,
        "promotion_target": autonomy_config.promotion_target,
    }
    from .service_environment import _artifact_path
    from .state_and_cache import _save_json

    _save_json(_artifact_path(resources, "autonomy-report.json"), report)
    return report


def _ensure_supported_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"{name} not found in PATH")


def _ensure_lz4_codec_available() -> None:
    try:
        importlib.import_module("lz4.frame")
    except Exception as exc:
        raise RuntimeError(
            "kafka_lz4_codec_unavailable: install lz4 (for example `uv sync --frozen --extra dev`)"
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
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"command_missing: {' '.join(args)}: {exc.filename}"
        ) from exc
    except subprocess.CalledProcessError as exc:
        stdout = (exc.stdout or "").strip()
        stderr = (exc.stderr or "").strip()
        detail = stderr or stdout or str(exc)
        raise RuntimeError(f"command_failed: {' '.join(args)}: {detail}") from exc


def _is_transient_postgres_error(error: Exception) -> bool:
    message = str(error).lower()
    if any(pattern in message for pattern in NON_TRANSIENT_POSTGRES_ERROR_PATTERNS):
        return False
    return any(pattern in message for pattern in TRANSIENT_POSTGRES_ERROR_PATTERNS)


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
    "_build_argocd_automation_config",
    "_build_autonomy_lane_config",
    "_build_postgres_runtime_config",
    "_build_resources",
    "_build_rollouts_analysis_config",
    "_canonicalize_warm_lane_manifest",
    "_default_simulation_postgres_db",
    "_ensure_lz4_codec_available",
    "_ensure_supported_binary",
    "_find_vector_extension_blocking_revision",
    "_is_transient_postgres_error",
    "_merge_topics",
    "_normalize_migrations_command",
    "_replace_alembic_upgrade_target",
    "_resolve_command_args",
    "_run_alembic_upgrade",
    "_run_command",
    "_run_simulation_autonomy_lane",
    "_ta_auto_offset_reset_key",
    "_ta_clickhouse_url_key",
    "_ta_group_id_key",
    "_ta_topic_key_by_role",
    "_warm_lane_enabled",
)
