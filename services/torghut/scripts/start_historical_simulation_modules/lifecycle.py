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

from .simulation_context import KafkaRuntimeConfig
from .runtime_config import (
    ArgocdAutomationConfig,
    AutonomyLaneConfig,
    ClickHouseRuntimeConfig,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    SimulationResources,
    _as_mapping,
    _as_text,
    _parse_optional_rfc3339_timestamp,
    _safe_int,
    _validate_window_policy,
)
from .resource_planning import (
    _ensure_supported_binary,
    _run_simulation_autonomy_lane,
)
from .kubernetes_argocd import (
    _argocd_ignore_differences_cover_runtime_mutations,
    _clone_json_list,
    _clone_json_mapping,
    _normalized_automation_mode,
    _read_argocd_application_sync_policy,
    _read_argocd_automation_mode,
    _read_named_argocd_application_sync_policy,
)
from .service_environment import (
    _artifact_path,
    _state_paths,
)
from .state_and_cache import (
    _save_json,
    _update_run_state,
    _upsert_simulation_progress_row,
)
from .runtime_migrations import _runtime_sessionmaker
from .kafka_runtime import _runtime_verify
from .replay_execution import (
    _apply,
    _replay_dump,
    _teardown,
)
from .argocd_rollouts import (
    _build_fill_price_error_budget_payload,
    _prepare_argocd_for_run,
    _report_simulation,
    _restore_argocd_after_run,
    _run_rollouts_analysis,
    _wait_for_runtime_verify,
    _wait_for_torghut_service_revision_ready,
)
from .proof_artifacts import (
    _build_gate_input,
    _build_performance_report,
    _build_run_summary,
    _build_simulation_completion_trace,
    _build_strategy_proof_artifact,
)


def _run_full_lifecycle(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    manifest_path: Path,
    autonomy_config: AutonomyLaneConfig | None = None,
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
    resolved_autonomy_config = autonomy_config or AutonomyLaneConfig(enabled=False)
    _ensure_supported_binary("kubectl")
    _validate_window_policy(manifest)
    _update_run_state(resources=resources, phase="preflight", status="ok")

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
    autonomy_report: dict[str, Any] | None = None
    teardown_report: dict[str, Any] | None = None
    teardown_settle_report: dict[str, Any] | None = None
    rollouts_report: dict[str, Any] = {
        "enabled": bool(
            rollouts_config.enabled and resources.target_mode == "dedicated_service"
        ),
        "runtime_analysis_run": None,
        "activity_analysis_run": None,
        "teardown_analysis_run": None,
        "artifact_analysis_run": None,
    }
    errors: list[str] = []
    previous_automation_mode: str | None = None
    argocd_prepare_succeeded = False
    argocd_restore_required = False
    previous_root_application_sync_policy: dict[str, Any] | None = None
    previous_child_application_sync_policy: dict[str, Any] | None = None
    previous_child_ignore_differences: list[dict[str, Any]] | None = None
    teardown_succeeded = False

    try:
        if report_only:
            argocd_prepare_report = {
                "managed": False,
                "changed": False,
                "reason": "report_only",
            }
            _update_run_state(
                resources=resources,
                phase="argocd_prepare",
                status="skipped",
                details=argocd_prepare_report,
            )
        else:
            _update_run_state(
                resources=resources, phase="argocd_prepare", status="running"
            )
            if argocd_config.manage_automation:
                current_state = _read_argocd_automation_mode(config=argocd_config)
                previous_automation_mode = _normalized_automation_mode(
                    _as_text(current_state.get("mode"))
                )
                current_root_app_state = _read_named_argocd_application_sync_policy(
                    namespace=argocd_config.applicationset_namespace,
                    app_name=argocd_config.root_app_name,
                )
                previous_root_application_sync_policy = _clone_json_mapping(
                    cast(
                        Mapping[str, Any] | None,
                        current_root_app_state.get("sync_policy"),
                    )
                )
                current_app_state = _read_argocd_application_sync_policy(
                    config=argocd_config
                )
                previous_child_application_sync_policy = _clone_json_mapping(
                    cast(Mapping[str, Any] | None, current_app_state.get("sync_policy"))
                )
                previous_child_ignore_differences = _clone_json_list(
                    cast(
                        Sequence[Any] | None,
                        current_app_state.get("ignore_differences"),
                    )
                )
                argocd_restore_required = (
                    previous_automation_mode
                    != _normalized_automation_mode(
                        argocd_config.desired_mode_during_run
                    )
                )
                if (
                    _normalized_automation_mode(
                        _as_text(current_app_state.get("automation_mode"))
                    )
                    != "manual"
                ):
                    argocd_restore_required = True
                if not _argocd_ignore_differences_cover_runtime_mutations(
                    current_ignore_differences=cast(
                        Sequence[Mapping[str, Any]] | None,
                        current_app_state.get("ignore_differences"),
                    ),
                    resources=resources,
                ):
                    argocd_restore_required = True
            argocd_prepare_report = _prepare_argocd_for_run(
                config=argocd_config, resources=resources
            )
            if previous_automation_mode is None:
                previous_automation_mode = _as_text(
                    argocd_prepare_report.get("previous_mode")
                )
            if previous_root_application_sync_policy is None:
                application_report = _as_mapping(
                    argocd_prepare_report.get("root_application")
                )
                previous_root_application_sync_policy = _clone_json_mapping(
                    cast(
                        Mapping[str, Any] | None,
                        application_report.get("previous_sync_policy"),
                    )
                )
            if previous_child_application_sync_policy is None:
                application_report = _as_mapping(
                    argocd_prepare_report.get("application_sync_policy")
                )
                previous_child_application_sync_policy = _clone_json_mapping(
                    cast(
                        Mapping[str, Any] | None,
                        application_report.get("previous_sync_policy"),
                    )
                )
            if previous_child_ignore_differences is None:
                ignore_report = _as_mapping(
                    argocd_prepare_report.get("application_ignore_differences")
                )
                previous_child_ignore_differences = _clone_json_list(
                    cast(
                        Sequence[Any] | None,
                        ignore_report.get("previous_ignore_differences"),
                    )
                )
            argocd_prepare_succeeded = True
            _update_run_state(
                resources=resources,
                phase="argocd_prepare",
                status="ok",
                details=argocd_prepare_report,
            )

        if not report_only:
            _update_run_state(
                resources=resources, phase="dataset_prepare", status="running"
            )
            apply_report = _apply(
                resources=resources,
                manifest=manifest,
                kafka_config=kafka_config,
                clickhouse_config=clickhouse_config,
                postgres_config=postgres_config,
                argocd_config=argocd_config,
                force_dump=force_dump,
                force_replay=force_replay,
            )
            _save_json(_artifact_path(resources, "run-manifest.json"), apply_report)
            _update_run_state(resources=resources, phase="dataset_prepare", status="ok")

            _update_run_state(
                resources=resources, phase="runtime_verify", status="running"
            )
            if bool(rollouts_report["enabled"]):
                runtime_analysis_run = _run_rollouts_analysis(
                    resources=resources,
                    manifest=manifest,
                    postgres_config=postgres_config,
                    clickhouse_config=clickhouse_config,
                    rollouts_config=rollouts_config,
                    phase="runtime-ready",
                    template_name=rollouts_config.runtime_template,
                )
                rollouts_report["runtime_analysis_run"] = runtime_analysis_run
                runtime_verify_report = _runtime_verify(
                    resources=resources, manifest=manifest
                )
            else:
                runtime_verify_report = _wait_for_runtime_verify(
                    resources=resources,
                    manifest=manifest,
                    timeout_seconds=rollouts_config.verify_timeout_seconds,
                    poll_seconds=rollouts_config.verify_poll_seconds,
                )
            assert runtime_verify_report is not None
            runtime_verify_report["analysis_run"] = rollouts_report[
                "runtime_analysis_run"
            ]
            _save_json(
                _artifact_path(resources, "runtime-verify.json"), runtime_verify_report
            )
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_TA,
                status="ready"
                if runtime_verify_report.get("runtime_state") == "ready"
                else "not_ready",
                terminal_state="complete"
                if runtime_verify_report.get("runtime_state") == "ready"
                else None,
                payload=runtime_verify_report,
            )
            _update_run_state(
                resources=resources,
                phase="runtime_verify",
                status="ok"
                if runtime_verify_report.get("runtime_state") == "ready"
                else "error",
                details=runtime_verify_report,
            )
            if runtime_verify_report.get("runtime_state") != "ready" or (
                bool(rollouts_report["enabled"])
                and _as_mapping(
                    cast(Mapping[str, Any], rollouts_report["runtime_analysis_run"])
                ).get("phase")
                != "Successful"
            ):
                runtime_failure = {
                    "reason": "environment_incomplete",
                    "runtime_state": runtime_verify_report.get("runtime_state"),
                    "analysis_run": rollouts_report["runtime_analysis_run"],
                }
                _update_run_state(
                    resources=resources,
                    phase="replay",
                    status="skipped",
                    details=runtime_failure,
                )
                _update_run_state(
                    resources=resources,
                    phase="activity_verify",
                    status="skipped",
                    details=runtime_failure,
                )
                raise RuntimeError("environment_incomplete")

            _update_run_state(resources=resources, phase="replay", status="running")
            replay_report = _replay_dump(
                resources=resources,
                kafka_config=kafka_config,
                manifest=manifest,
                dump_path=_state_paths(resources, manifest)[2],
                force=force_replay,
                postgres_config=postgres_config,
            )
            _save_json(_artifact_path(resources, "replay-report.json"), replay_report)
            _update_run_state(
                resources=resources,
                phase="replay",
                status="ok",
                details=replay_report,
            )

            _update_run_state(
                resources=resources, phase="activity_verify", status="running"
            )
            monitor_report = _monitor_run_completion(
                resources=resources,
                manifest=manifest,
                postgres_config=postgres_config,
                clickhouse_config=clickhouse_config,
                runtime_verify=runtime_verify_report,
            )
            assert monitor_report is not None
            final_snapshot = _as_mapping(monitor_report.get("final_snapshot"))
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_TORGHUT,
                status="activity_verified",
                last_signal_ts=_parse_optional_rfc3339_timestamp(
                    _as_text(final_snapshot.get("last_signal_ts"))
                ),
                last_price_ts=_parse_optional_rfc3339_timestamp(
                    _as_text(final_snapshot.get("last_price_ts"))
                ),
                cursor_at=_parse_optional_rfc3339_timestamp(
                    _as_text(final_snapshot.get("cursor_at"))
                ),
                trade_decisions=_safe_int(final_snapshot.get("trade_decisions")),
                executions=_safe_int(final_snapshot.get("executions")),
                execution_tca_metrics=_safe_int(
                    final_snapshot.get("execution_tca_metrics")
                ),
                execution_order_events=_safe_int(
                    final_snapshot.get("execution_order_events")
                ),
                legacy_path_count=_safe_int(final_snapshot.get("legacy_path_count")),
                fallback_count=_safe_int(final_snapshot.get("fallback_count")),
                terminal_state="complete"
                if _as_text(monitor_report.get("activity_classification")) == "success"
                else None,
                payload={
                    "activity_classification": monitor_report.get(
                        "activity_classification"
                    ),
                    "effective_terminal_signal_ts": monitor_report.get(
                        "effective_terminal_signal_ts"
                    ),
                },
            )
            if bool(rollouts_report["enabled"]):
                try:
                    activity_analysis_run = _run_rollouts_analysis(
                        resources=resources,
                        manifest=manifest,
                        postgres_config=postgres_config,
                        clickhouse_config=clickhouse_config,
                        rollouts_config=rollouts_config,
                        phase="activity",
                        template_name=rollouts_config.activity_template,
                    )
                except Exception as exc:
                    activity_analysis_run = {
                        "status": "error",
                        "phase": "Error",
                        "message": str(exc),
                    }
                rollouts_report["activity_analysis_run"] = activity_analysis_run
            monitor_report["analysis_run"] = rollouts_report["activity_analysis_run"]
            _save_json(_artifact_path(resources, "activity-debug.json"), monitor_report)
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_ARTIFACTS,
                status="activity_verified",
                last_signal_ts=_parse_optional_rfc3339_timestamp(
                    _as_text(
                        _as_mapping(monitor_report.get("final_snapshot")).get(
                            "last_signal_ts"
                        )
                    )
                ),
                last_price_ts=_parse_optional_rfc3339_timestamp(
                    _as_text(
                        _as_mapping(monitor_report.get("final_snapshot")).get(
                            "last_price_ts"
                        )
                    )
                ),
                cursor_at=_parse_optional_rfc3339_timestamp(
                    _as_text(
                        _as_mapping(monitor_report.get("final_snapshot")).get(
                            "cursor_at"
                        )
                    )
                ),
                payload=monitor_report,
            )
            _save_json(
                _artifact_path(resources, "signal-activity.json"),
                {
                    "activity_classification": monitor_report.get(
                        "activity_classification"
                    ),
                    "signal_rows": _as_mapping(
                        monitor_report.get("final_snapshot")
                    ).get("signal_rows"),
                    "price_rows": _as_mapping(monitor_report.get("final_snapshot")).get(
                        "price_rows"
                    ),
                    "analysis_run": rollouts_report["activity_analysis_run"],
                },
            )
            _save_json(
                _artifact_path(resources, "decision-activity.json"),
                {
                    "activity_classification": monitor_report.get(
                        "activity_classification"
                    ),
                    "trade_decisions": _as_mapping(
                        monitor_report.get("final_snapshot")
                    ).get("trade_decisions"),
                    "cursor_at": _as_mapping(monitor_report.get("final_snapshot")).get(
                        "cursor_at"
                    ),
                    "analysis_run": rollouts_report["activity_analysis_run"],
                },
            )
            _save_json(
                _artifact_path(resources, "execution-activity.json"),
                {
                    "activity_classification": monitor_report.get(
                        "activity_classification"
                    ),
                    "executions": _as_mapping(monitor_report.get("final_snapshot")).get(
                        "executions"
                    ),
                    "execution_tca_metrics": _as_mapping(
                        monitor_report.get("final_snapshot")
                    ).get("execution_tca_metrics"),
                    "execution_order_events": _as_mapping(
                        monitor_report.get("final_snapshot")
                    ).get("execution_order_events"),
                    "analysis_run": rollouts_report["activity_analysis_run"],
                },
            )
            _update_run_state(
                resources=resources,
                phase="activity_verify",
                status="ok"
                if monitor_report.get("activity_classification") == "success"
                else "degraded",
                details=monitor_report,
            )
            activity_classification = (
                _as_text(monitor_report.get("activity_classification")) or "unknown"
            )
            if activity_classification != "success":
                errors.append(f"activity:{activity_classification}")
        else:
            _update_run_state(
                resources=resources,
                phase="dataset_prepare",
                status="skipped",
                details={"report_only": True},
            )
            _update_run_state(
                resources=resources,
                phase="runtime_verify",
                status="skipped",
                details={"report_only": True},
            )
            _update_run_state(
                resources=resources,
                phase="replay",
                status="skipped",
                details={"report_only": True},
            )
            _update_run_state(
                resources=resources,
                phase="activity_verify",
                status="skipped",
                details={"report_only": True},
            )

        _update_run_state(resources=resources, phase="report", status="running")
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
        _save_json(
            _artifact_path(resources, "strategy-proof.json"), strategy_proof_report
        )
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
        _save_json(_artifact_path(resources, "performance.json"), performance_report)
        gate_input_report = _build_gate_input(
            resources=resources,
            manifest=manifest,
            monitor_report=monitor_report,
            strategy_proof_report=strategy_proof_report,
            fill_price_error_budget_report=fill_price_error_budget_report,
        )
        _save_json(_artifact_path(resources, "gate-input.json"), gate_input_report)
        autonomy_report = _run_simulation_autonomy_lane(
            resources=resources,
            autonomy_config=resolved_autonomy_config,
        )
        run_summary_report = _build_run_summary(
            resources=resources,
            manifest=manifest,
            runtime_verify_report=runtime_verify_report,
            monitor_report=monitor_report,
            analytics_report=analytics_report,
            strategy_proof_report=strategy_proof_report,
            autonomy_report=autonomy_report,
            errors=errors,
        )
        _save_json(_artifact_path(resources, "run-summary.json"), run_summary_report)
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_TORGHUT,
            status="reported",
            strategy_type=_as_text(strategy_proof_report.get("strategy_type")),
            legacy_path_count=_safe_int(strategy_proof_report.get("legacy_path_count")),
            fallback_count=_safe_int(strategy_proof_report.get("fallback_order_count")),
            terminal_state="complete",
            payload={
                "strategy_type": strategy_proof_report.get("strategy_type"),
                "legacy_path_count": strategy_proof_report.get("legacy_path_count"),
                "fallback_order_count": strategy_proof_report.get(
                    "fallback_order_count"
                ),
            },
        )
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_ARTIFACTS,
            status="reported",
            terminal_state="complete",
            strategy_type=_as_text(strategy_proof_report.get("strategy_type")),
            legacy_path_count=_safe_int(strategy_proof_report.get("legacy_path_count")),
            fallback_count=_safe_int(strategy_proof_report.get("fallback_count")),
            payload={
                "activity_debug_path": str(
                    _artifact_path(resources, "activity-debug.json")
                ),
                "strategy_proof_path": str(
                    _artifact_path(resources, "strategy-proof.json")
                ),
                "performance_path": str(_artifact_path(resources, "performance.json")),
                "run_summary_path": str(_artifact_path(resources, "run-summary.json")),
                "gate_input_path": str(_artifact_path(resources, "gate-input.json")),
            },
        )
        _update_run_state(resources=resources, phase="report", status="ok")
    except Exception as exc:
        errors.append(str(exc))
        _update_run_state(
            resources=resources,
            phase="run",
            status="error",
            details={"error": str(exc)},
        )
    finally:
        if not skip_teardown:
            try:
                _update_run_state(
                    resources=resources, phase="teardown", status="running"
                )
                teardown_report = _teardown(
                    resources=resources,
                    manifest=manifest,
                    allow_missing_state=True,
                )
                teardown_succeeded = True
                _update_run_state(resources=resources, phase="teardown", status="ok")
            except Exception as exc:
                errors.append(f"teardown:{exc}")
                _update_run_state(
                    resources=resources,
                    phase="teardown",
                    status="error",
                    details={"error": str(exc)},
                )
        else:
            _update_run_state(
                resources=resources,
                phase="teardown",
                status="skipped",
                details={"skip_teardown": True},
            )

        if report_only:
            argocd_restore_report = {
                "managed": False,
                "changed": False,
                "reason": "report_only",
            }
            _update_run_state(
                resources=resources,
                phase="argocd_restore",
                status="skipped",
                details=argocd_restore_report,
            )
        elif not argocd_prepare_succeeded and not argocd_restore_required:
            argocd_restore_report = {
                "managed": False,
                "changed": False,
                "reason": "argocd_prepare_failed",
            }
            _update_run_state(
                resources=resources,
                phase="argocd_restore",
                status="skipped",
                details=argocd_restore_report,
            )
        else:
            try:
                _update_run_state(
                    resources=resources, phase="argocd_restore", status="running"
                )
                argocd_restore_report = _restore_argocd_after_run(
                    config=argocd_config,
                    previous_mode=previous_automation_mode,
                    previous_root_sync_policy=previous_root_application_sync_policy,
                    previous_child_sync_policy=previous_child_application_sync_policy,
                    previous_child_ignore_differences=previous_child_ignore_differences,
                )
                _update_run_state(
                    resources=resources, phase="argocd_restore", status="ok"
                )
            except Exception as exc:
                errors.append(f"argocd_restore:{exc}")
                _update_run_state(
                    resources=resources,
                    phase="argocd_restore",
                    status="error",
                    details={"error": str(exc)},
                )

        if (
            teardown_succeeded
            and not report_only
            and bool(rollouts_report["enabled"])
            and argocd_config.manage_automation
            and resources.target_mode == "dedicated_service"
            and not any(error.startswith("argocd_restore:") for error in errors)
        ):
            _update_run_state(
                resources=resources, phase="teardown_settle", status="running"
            )
            teardown_settle_report = _wait_for_torghut_service_revision_ready(
                resources=resources,
                timeout_seconds=rollouts_config.verify_timeout_seconds,
                poll_seconds=rollouts_config.verify_poll_seconds,
            )
            rollouts_report["teardown_settle"] = teardown_settle_report
            if teardown_report is None:
                teardown_report = {}
            teardown_report["service_revision_settle"] = teardown_settle_report
            if teardown_settle_report.get("ready"):
                _update_run_state(
                    resources=resources,
                    phase="teardown_settle",
                    status="ok",
                    details=teardown_settle_report,
                )
            else:
                errors.append("teardown_settle:runtime_not_ready")
                _update_run_state(
                    resources=resources,
                    phase="teardown_settle",
                    status="error",
                    details=teardown_settle_report,
                )

        if (
            teardown_succeeded
            and not report_only
            and bool(rollouts_report["enabled"])
            and not any(error.startswith("argocd_restore:") for error in errors)
            and not any(error.startswith("teardown_settle:") for error in errors)
        ):
            try:
                teardown_analysis_run = _run_rollouts_analysis(
                    resources=resources,
                    manifest=manifest,
                    postgres_config=postgres_config,
                    clickhouse_config=clickhouse_config,
                    rollouts_config=rollouts_config,
                    phase="teardown-clean",
                    template_name=rollouts_config.teardown_template,
                )
                rollouts_report["teardown_analysis_run"] = teardown_analysis_run
                if teardown_report is None:
                    teardown_report = {}
                teardown_report["analysis_run"] = teardown_analysis_run
                if _as_mapping(teardown_analysis_run).get("phase") != "Successful":
                    errors.append("teardown:environment_incomplete")
            except Exception as exc:
                errors.append(f"teardown:{exc}")
                if teardown_report is None:
                    teardown_report = {}
                teardown_report["analysis_run_error"] = str(exc)

    report = {
        "status": "ok" if not errors else "error",
        "mode": "run",
        "run_id": resources.run_id,
        "dataset_id": resources.dataset_id,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "argocd_prepare": argocd_prepare_report,
        "argocd_restore": argocd_restore_report,
        "apply": apply_report,
        "replay": replay_report,
        "runtime_verify": runtime_verify_report,
        "monitor": monitor_report,
        "report": analytics_report,
        "strategy_proof": strategy_proof_report,
        "performance": performance_report,
        "run_summary": run_summary_report,
        "gate_input": gate_input_report,
        "autonomy": autonomy_report,
        "fill_price_error_budget": fill_price_error_budget_report,
        "teardown": teardown_report,
        "rollouts": rollouts_report,
        "errors": errors,
    }
    run_manifest_path = _state_paths(resources, manifest)[1]
    if apply_report is not None:
        updated_apply_report = dict(apply_report)
        updated_apply_report["replay"] = replay_report
        updated_apply_report["rollouts"] = rollouts_report
        _save_json(run_manifest_path, updated_apply_report)
    _save_json(run_manifest_path.with_name("run-full-lifecycle-manifest.json"), report)
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
    completion_trace_path = _artifact_path(resources, "completion-trace.json")
    _save_json(completion_trace_path, completion_trace)
    gate_row_ids: dict[str, Any] = {}
    completion_trace_db_refs = _as_mapping(completion_trace.get("db_row_refs"))
    runtime_session_factory, runtime_engine = _runtime_sessionmaker(postgres_config)
    try:
        try:
            with runtime_session_factory() as session:
                gate_row_ids = persist_completion_trace(
                    session=session,
                    trace_payload=completion_trace,
                    default_artifact_ref=str(completion_trace_path),
                )
                session.commit()
        except Exception as exc:
            completion_trace_db_refs["completion_gate_persist_error"] = str(exc)
            errors.append(f"completion_trace_persist:{exc}")
    finally:
        runtime_engine.dispose()
    completion_trace_db_refs["completion_gate_row_ids"] = gate_row_ids
    completion_trace["db_row_refs"] = completion_trace_db_refs
    _save_json(completion_trace_path, completion_trace)
    if errors:
        error_payload = {
            "errors": errors,
            "completion_trace_path": str(completion_trace_path),
        }
        for component in SIMULATION_PROGRESS_COMPONENTS:
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=component,
                status="failed",
                terminal_state="complete",
                last_error_code="simulation_run_failed",
                last_error_message="; ".join(errors),
                payload=error_payload,
            )
    if errors:
        raise RuntimeError("simulation_run_failed:" + "; ".join(errors))
    return report


def _render_report(payload: Mapping[str, Any], *, json_only: bool) -> None:
    if json_only:
        print(json.dumps(dict(payload), sort_keys=True, separators=(",", ":")))
        return
    print(json.dumps(dict(payload), indent=2, sort_keys=True))


_http_clickhouse_query = simulation_verification._http_clickhouse_query

_monitor_run_completion = simulation_verification._monitor_run_completion


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
    "_http_clickhouse_query",
    "_monitor_run_completion",
    "_render_report",
    "_run_full_lifecycle",
)
