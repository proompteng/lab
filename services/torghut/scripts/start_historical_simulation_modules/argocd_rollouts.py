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
    DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
    DEFAULT_RUN_MONITOR_MIN_DECISIONS,
    DEFAULT_RUN_MONITOR_MIN_EXECUTIONS,
    DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
    DEFAULT_RUN_MONITOR_MIN_TCA,
    DEFAULT_RUN_MONITOR_POLL_SECONDS,
    DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS,
    US_EQUITIES_REGULAR_MINUTES,
    US_EQUITIES_REGULAR_PROFILE,
)
from .runtime_config import (
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    SimulationResources,
    _as_mapping,
    _as_text,
    _normalize_kubernetes_name_token,
    _resolve_window_bounds,
    _safe_int,
)
from .resource_planning import _run_command
from .kubernetes_argocd import (
    _argocd_ignore_differences_cover_runtime_mutations,
    _clone_json_mapping,
    _kubectl_apply,
    _kubectl_delete_if_exists,
    _kubectl_json,
    _manual_argocd_application_sync_policy,
    _merge_argocd_application_ignore_differences,
    _normalized_argocd_ignore_differences,
    _normalized_automation_mode,
    _read_argocd_automation_mode,
    _read_named_argocd_application_sync_policy,
    _run_with_transient_postgres_retry,
    _set_argocd_application_sync_policy,
    _set_argocd_automation_mode,
    _simulation_runtime_argocd_ignore_differences,
)
from .service_environment import (
    _artifact_path,
    _set_argocd_application_ignore_differences,
    _wait_for_argocd_application_mode,
)
from .state_and_cache import _save_json
from .kafka_runtime import (
    _condition_status,
    _runtime_verify,
)


def _prepare_argocd_for_run(
    *,
    config: ArgocdAutomationConfig,
    resources: SimulationResources,
) -> dict[str, Any]:
    if not config.manage_automation:
        return {
            "managed": False,
            "changed": False,
            "current_mode": None,
            "previous_mode": None,
        }
    automation_state = _read_argocd_automation_mode(config=config)
    current_mode = _normalized_automation_mode(_as_text(automation_state.get("mode")))
    child_sync_state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=config.app_name,
    )
    root_sync_state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=config.root_app_name,
    )
    root_application_report = _set_argocd_application_sync_policy(
        config=config,
        app_name=config.root_app_name,
        desired_sync_policy=_manual_argocd_application_sync_policy(
            cast(Mapping[str, Any] | None, root_sync_state.get("sync_policy"))
        ),
    )
    applicationset_report = _set_argocd_automation_mode(
        config=config,
        desired_mode=config.desired_mode_during_run,
    )
    application_ignore_differences_report = _set_argocd_application_ignore_differences(
        config=config,
        app_name=config.app_name,
        required_ignore_differences=_simulation_runtime_argocd_ignore_differences(
            resources=resources
        ),
        desired_ignore_differences=_merge_argocd_application_ignore_differences(
            current_ignore_differences=cast(
                Sequence[Mapping[str, Any]] | None,
                child_sync_state.get("ignore_differences"),
            ),
            resources=resources,
        ),
    )
    child_application_report = _set_argocd_application_sync_policy(
        config=config,
        app_name=config.app_name,
        desired_sync_policy=_manual_argocd_application_sync_policy(
            cast(Mapping[str, Any] | None, child_sync_state.get("sync_policy"))
        ),
    )
    application_mode_report = _wait_for_argocd_application_mode(
        config=config,
        app_name=config.app_name,
        desired_mode=config.desired_mode_during_run,
    )
    return {
        "managed": True,
        "changed": (
            child_application_report["changed"]
            or root_application_report["changed"]
            or application_ignore_differences_report["changed"]
            or applicationset_report["changed"]
        ),
        "pointer": automation_state.get("pointer"),
        "previous_mode": current_mode,
        "desired_mode": config.desired_mode_during_run,
        "current_mode": application_mode_report["current_mode"],
        "applicationset_managed": True,
        "applicationset": applicationset_report,
        "application_sync_policy": child_application_report,
        "application_ignore_differences": application_ignore_differences_report,
        "root_application": root_application_report,
        "application": application_mode_report,
    }


def _ensure_argocd_manual_before_runtime_mutation(
    *,
    config: ArgocdAutomationConfig,
    resources: SimulationResources,
) -> dict[str, Any]:
    if not config.manage_automation:
        return {
            "managed": False,
            "changed": False,
            "reason": "automation_management_disabled",
        }

    desired_mode = _normalized_automation_mode(config.desired_mode_during_run)
    applicationset_state = _read_argocd_automation_mode(config=config)
    application_state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=config.app_name,
    )
    root_state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=config.root_app_name,
    )
    desired_root_sync_policy = _manual_argocd_application_sync_policy(
        cast(Mapping[str, Any] | None, root_state.get("sync_policy"))
    )
    current_application_mode = _normalized_automation_mode(
        _as_text(application_state.get("automation_mode"))
    )
    current_root_sync_policy = _clone_json_mapping(
        cast(Mapping[str, Any] | None, root_state.get("sync_policy"))
    )
    current_applicationset_mode = _normalized_automation_mode(
        _as_text(applicationset_state.get("mode"))
    )
    current_ignore_differences = cast(
        Sequence[Mapping[str, Any]] | None, application_state.get("ignore_differences")
    )
    current_runtime_guard_complete = _argocd_ignore_differences_cover_runtime_mutations(
        current_ignore_differences=current_ignore_differences,
        resources=resources,
    )
    if (
        current_applicationset_mode == desired_mode
        and current_application_mode == desired_mode
        and current_runtime_guard_complete
        and current_root_sync_policy == desired_root_sync_policy
    ):
        return {
            "managed": True,
            "changed": False,
            "reason": "already_manual",
            "desired_mode": desired_mode,
            "current_mode": current_application_mode,
            "applicationset_managed": True,
            "applicationset": {
                "pointer": applicationset_state.get("pointer"),
                "current_mode": current_applicationset_mode,
                "desired_mode": desired_mode,
                "changed": False,
            },
            "root_application": {
                "current_sync_policy": current_root_sync_policy,
                "desired_sync_policy": desired_root_sync_policy,
                "changed": False,
            },
            "application": {
                "app_name": config.app_name,
                "current_mode": current_application_mode,
            },
            "application_ignore_differences": {
                "app_name": config.app_name,
                "current_ignore_differences": _normalized_argocd_ignore_differences(
                    current_ignore_differences
                ),
                "required_ignore_differences": _simulation_runtime_argocd_ignore_differences(
                    resources=resources
                ),
                "coverage_complete": current_runtime_guard_complete,
                "changed": False,
            },
        }

    report = _prepare_argocd_for_run(config=config, resources=resources)
    report["reason"] = "reasserted_manual_before_runtime_mutation"
    return report


def _restore_argocd_after_run(
    *,
    config: ArgocdAutomationConfig,
    previous_mode: str | None,
    previous_root_sync_policy: Mapping[str, Any] | None,
    previous_child_sync_policy: Mapping[str, Any] | None,
    previous_child_ignore_differences: Sequence[Mapping[str, Any]] | None,
) -> dict[str, Any]:
    if not config.manage_automation:
        return {
            "managed": False,
            "changed": False,
            "restored_mode": None,
        }
    restored_mode = previous_mode
    if config.restore_mode_after_run != "previous":
        restored_mode = config.restore_mode_after_run
    if restored_mode is None:
        restored_mode = "auto"

    applicationset_report = _set_argocd_automation_mode(
        config=config,
        desired_mode=restored_mode,
    )
    child_application_report = _set_argocd_application_sync_policy(
        config=config,
        app_name=config.app_name,
        desired_sync_policy=previous_child_sync_policy,
    )
    child_ignore_differences_report = _set_argocd_application_ignore_differences(
        config=config,
        app_name=config.app_name,
        desired_ignore_differences=previous_child_ignore_differences,
    )
    root_application_report = _set_argocd_application_sync_policy(
        config=config,
        app_name=config.root_app_name,
        desired_sync_policy=previous_root_sync_policy,
    )
    application_mode_report = _wait_for_argocd_application_mode(
        config=config,
        app_name=config.app_name,
        desired_mode=restored_mode,
    )
    return {
        "managed": True,
        "changed": (
            child_application_report["changed"]
            or child_ignore_differences_report["changed"]
            or root_application_report["changed"]
            or applicationset_report["changed"]
        ),
        "restored_mode": restored_mode,
        "previous_mode": previous_mode,
        "current_mode": application_mode_report["current_mode"],
        "applicationset_managed": True,
        "applicationset": applicationset_report,
        "application_sync_policy": child_application_report,
        "application_ignore_differences": child_ignore_differences_report,
        "root_application": root_application_report,
        "application": application_mode_report,
    }


def _analysis_run_name(*, phase: str, run_token: str) -> str:
    kubernetes_run_token = _normalize_kubernetes_name_token(run_token)
    base = f"torghut-sim-{phase}-{kubernetes_run_token}"
    if len(base) <= 63:
        return base
    prefix = f"torghut-sim-{phase}-"
    remaining = 63 - len(prefix)
    return prefix + kubernetes_run_token[:remaining].rstrip("-")


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
        "runId": resources.run_id,
        "datasetId": resources.dataset_id,
        "runToken": resources.run_token,
        "namespace": resources.namespace,
        "torghutService": resources.torghut_service,
        "taConfigmap": resources.ta_configmap,
        "taDeployment": resources.ta_deployment,
        "windowStart": window_start.isoformat(),
        "windowEnd": window_end.isoformat(),
        "signalTable": resources.clickhouse_signal_table,
        "priceTable": resources.clickhouse_price_table,
        "postgresDatabase": postgres_config.simulation_db,
        "clickhouseHttpUrl": clickhouse_config.http_url,
        "clickhouseUsername": clickhouse_config.username or "",
        "runtimeVerifyTimeoutSeconds": str(rollouts_config.verify_timeout_seconds),
        "runtimeVerifyPollSeconds": str(rollouts_config.verify_poll_seconds),
    }
    monitor = _as_mapping(manifest.get("monitor"))
    if phase == "activity":
        args.update(
            {
                "monitorTimeoutSeconds": str(
                    _safe_int(
                        monitor.get("timeout_seconds"),
                        default=DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS,
                    )
                ),
                "monitorPollSeconds": str(
                    _safe_int(
                        monitor.get("poll_seconds"),
                        default=DEFAULT_RUN_MONITOR_POLL_SECONDS,
                    )
                ),
                "minTradeDecisions": str(
                    _safe_int(
                        monitor.get("min_trade_decisions"),
                        default=DEFAULT_RUN_MONITOR_MIN_DECISIONS,
                    )
                ),
                "minExecutions": str(
                    _safe_int(
                        monitor.get("min_executions"),
                        default=DEFAULT_RUN_MONITOR_MIN_EXECUTIONS,
                    )
                ),
                "minExecutionTcaMetrics": str(
                    _safe_int(
                        monitor.get("min_execution_tca_metrics"),
                        default=DEFAULT_RUN_MONITOR_MIN_TCA,
                    )
                ),
                "minExecutionOrderEvents": str(
                    _safe_int(
                        monitor.get("min_execution_order_events"),
                        default=DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
                    )
                ),
                "cursorGraceSeconds": str(
                    _safe_int(
                        monitor.get("cursor_grace_seconds"),
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
        ["get", "analysistemplate", template_name, "-o", "json"],
    )
    template_spec = _as_mapping(template_payload.get("spec"))
    template_args = template_spec.get("args")
    resolved_args: list[dict[str, Any]] = []
    if isinstance(template_args, list):
        for raw_arg in template_args:
            if not isinstance(raw_arg, Mapping):
                continue
            entry = _as_mapping(raw_arg)
            arg_name = _as_text(entry.get("name"))
            if arg_name is None:
                continue
            resolved: dict[str, Any] = {"name": arg_name}
            if arg_name in args_by_name:
                resolved["value"] = args_by_name[arg_name]
            elif "value" in entry:
                resolved["value"] = entry.get("value")
            elif "valueFrom" in entry:
                resolved["valueFrom"] = entry.get("valueFrom")
            else:
                raise RuntimeError(
                    f"missing_analysis_template_arg:{template_name}:{arg_name}"
                )
            resolved_args.append(resolved)

    metrics = template_spec.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        raise RuntimeError(f"invalid_analysis_template_metrics:{template_name}")

    analysis_run_spec: dict[str, Any] = {
        "args": resolved_args,
        "metrics": metrics,
    }
    for key in ("dryRun", "measurementRetention"):
        if key in template_spec:
            analysis_run_spec[key] = template_spec[key]

    return {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "AnalysisRun",
        "metadata": {
            "name": name,
            "namespace": rollouts_config.namespace,
            "labels": {
                "app.kubernetes.io/name": "torghut",
                "torghut.proompteng.ai/analysis-template": template_name,
            },
        },
        "spec": analysis_run_spec,
    }


def _wait_for_analysis_run(
    *,
    namespace: str,
    name: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
    while True:
        payload = _kubectl_json(namespace, ["get", "analysisrun", name, "-o", "json"])
        status = _as_mapping(payload.get("status"))
        phase = _as_text(status.get("phase")) or "Pending"
        metric_results = status.get("metricResults")
        report = {
            "name": name,
            "namespace": namespace,
            "phase": phase,
            "message": _as_text(status.get("message")),
            "started_at": _as_text(status.get("startedAt")),
            "completed_at": _as_text(status.get("completedAt")),
            "metric_results": metric_results
            if isinstance(metric_results, list)
            else [],
        }
        if phase in {"Successful", "Failed", "Error", "Inconclusive"}:
            report["status"] = "ok" if phase == "Successful" else "degraded"
            return report
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(f"analysisrun_timeout:{name}:{phase}")
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
    while report.get("runtime_state") != "ready":
        if datetime.now(timezone.utc) >= deadline:
            return report
        time.sleep(poll_seconds)
        report = _runtime_verify(resources=resources, manifest=manifest)
    return report


def _torghut_service_revision_ready(
    *,
    resources: SimulationResources,
) -> dict[str, Any]:
    service = _kubectl_json(
        resources.namespace,
        ["get", "kservice", resources.torghut_service, "-o", "json"],
    )
    service_status = _as_mapping(service.get("status"))
    latest_created_revision = _as_text(service_status.get("latestCreatedRevisionName"))
    latest_ready_revision = _as_text(service_status.get("latestReadyRevisionName"))
    ready_condition = _condition_status(service_status, condition_type="Ready")
    revision_settled = (
        latest_created_revision is None
        or latest_ready_revision == latest_created_revision
    )
    return {
        "ready": ready_condition == "True" and revision_settled,
        "condition_ready": ready_condition,
        "latest_created_revision": latest_created_revision,
        "latest_ready_revision": latest_ready_revision,
        "revision_settled": revision_settled,
    }


def _wait_for_torghut_service_revision_ready(
    *,
    resources: SimulationResources,
    timeout_seconds: int,
    poll_seconds: int,
) -> dict[str, Any]:
    deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
    report = _torghut_service_revision_ready(resources=resources)
    while not report.get("ready"):
        if datetime.now(timezone.utc) >= deadline:
            return report
        time.sleep(poll_seconds)
        report = _torghut_service_revision_ready(resources=resources)
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
    _kubectl_delete_if_exists(rollouts_config.namespace, "analysisrun", analysis_name)
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
    script_path = Path(__file__).resolve().with_name("analyze_historical_simulation.py")
    if not script_path.exists():
        raise RuntimeError(f"report_script_missing:{script_path}")
    report_dir = resources.output_root / resources.run_token / "report"
    report_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(script_path),
        "--run-id",
        resources.run_id,
        "--dataset-manifest",
        str(manifest_path),
        "--simulation-dsn",
        postgres_config.torghut_runtime_dsn,
        "--output-dir",
        str(report_dir),
        "--json",
    ]
    if clickhouse_config.http_url:
        command.extend(["--clickhouse-http-url", clickhouse_config.http_url])
    if clickhouse_config.username:
        command.extend(["--clickhouse-username", clickhouse_config.username])
    if clickhouse_config.password:
        command.extend(["--clickhouse-password", clickhouse_config.password])

    result = cast(
        subprocess.CompletedProcess[str],
        _run_with_transient_postgres_retry(
            label="report_simulation",
            operation=lambda: _run_command(command),
        ),
    )
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError("simulation report output must be a JSON object")
    report = {
        str(key): value for key, value in cast(Mapping[str, Any], payload).items()
    }
    report["report_dir"] = str(report_dir)
    return report


def _doc29_simulation_gate_ids(manifest: Mapping[str, Any]) -> list[str]:
    window = _as_mapping(manifest.get("window"))
    profile = (_as_text(window.get("profile")) or "").strip().lower() or None
    min_coverage_minutes = _safe_int(window.get("min_coverage_minutes"), default=0)
    if (
        profile == US_EQUITIES_REGULAR_PROFILE
        or min_coverage_minutes >= US_EQUITIES_REGULAR_MINUTES
    ):
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
                return Decimal("0")
    return Decimal("0")


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
    execution_quality = _as_mapping(analytics_payload.get("execution_quality"))
    slippage_payload = _as_mapping(execution_quality.get("slippage_bps"))
    if not slippage_payload:
        return None, None
    reporting = _as_mapping(manifest.get("reporting"))
    budget_payload = _as_mapping(manifest.get("fill_price_error_budget"))
    metric_observation_complete = all(
        _has_decimal_value(slippage_payload.get(key))
        for key in ("p50_abs", "p95_abs", "max_abs")
    )
    venue = (
        _as_text(budget_payload.get("venue"))
        or _as_text(reporting.get("venue"))
        or "us_equities"
    )
    report = build_fill_price_error_budget_report_v1(
        run_id=resources.run_id,
        venue=venue,
        order_count=_safe_int(
            _as_mapping(analytics_payload.get("funnel")).get("execution_tca_metrics")
        ),
        median_abs_slippage_bps=_decimal_or_zero(slippage_payload.get("p50_abs")),
        p95_abs_slippage_bps=_decimal_or_zero(slippage_payload.get("p95_abs")),
        max_abs_slippage_bps=_decimal_or_zero(slippage_payload.get("max_abs")),
        budget_median_abs_slippage_bps=_decimal_or_zero(
            budget_payload.get("budget_median_abs_slippage_bps")
            or reporting.get("budget_median_abs_slippage_bps")
            or "12"
        ),
        budget_p95_abs_slippage_bps=_decimal_or_zero(
            budget_payload.get("budget_p95_abs_slippage_bps")
            or reporting.get("budget_p95_abs_slippage_bps")
            or "25"
        ),
        metric_observation_complete=metric_observation_complete,
    )
    artifact_path = _artifact_path(
        resources, "gates/fill-price-error-budget-report-v1.json"
    )
    _save_json(artifact_path, report.to_payload())
    return report.to_payload(), artifact_path


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
    "_analysis_run_args",
    "_analysis_run_name",
    "_build_fill_price_error_budget_payload",
    "_decimal_or_zero",
    "_doc29_simulation_gate_ids",
    "_ensure_argocd_manual_before_runtime_mutation",
    "_has_decimal_value",
    "_prepare_argocd_for_run",
    "_render_analysis_run_spec",
    "_report_simulation",
    "_restore_argocd_after_run",
    "_run_rollouts_analysis",
    "_torghut_service_revision_ready",
    "_wait_for_analysis_run",
    "_wait_for_runtime_verify",
    "_wait_for_torghut_service_revision_ready",
)
