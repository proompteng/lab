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
    DEFAULT_SIMULATION_DUMP_FORMAT,
    DEFAULT_SIMULATION_REPLAY_PROFILE,
    LEGACY_SIMULATION_STRATEGY_TOKENS,
    US_EQUITIES_REGULAR_MINUTES,
)
from .runtime_config import (
    PostgresRuntimeConfig,
    SimulationResources,
    _as_mapping,
    _as_string_list,
    _as_text,
    _safe_float,
    _safe_int,
)
from .kubernetes_argocd import _run_with_transient_postgres_retry
from .service_environment import (
    _artifact_path,
    _performance_config,
)
from .argocd_rollouts import _doc29_simulation_gate_ids


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
                "strategy_type": str(row[0]),
                "count": _safe_int(row[1]),
            }
            for row in strategy_rows
        ]
        legacy_path_count = sum(
            item["count"]
            for item in strategy_types
            if any(
                token in item["strategy_type"]
                for token in LEGACY_SIMULATION_STRATEGY_TOKENS
            )
        )
        return {
            "status": "ok",
            "expected_candidate_id": _as_text(manifest.get("candidate_id")),
            "expected_strategy_spec_ref": _as_text(manifest.get("strategy_spec_ref")),
            "model_refs": _as_string_list(manifest.get("model_refs")),
            "strategy_types": strategy_types,
            "legacy_path_count": legacy_path_count,
            "fallback_order_count": _safe_int(fallback_row[0]),
            "fallback_invocation_count": _safe_int(fallback_row[1]),
            "promotable": legacy_path_count == 0,
        }

    return cast(
        dict[str, Any],
        _run_with_transient_postgres_retry(
            label="strategy_proof",
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
        "status": "ok",
        "cache_policy": _as_text(performance_cfg.get("cache_policy")) or "prefer_cache",
        "replay_profile": _as_text(performance_cfg.get("replay_profile"))
        or DEFAULT_SIMULATION_REPLAY_PROFILE,
        "dump_format": _as_text(performance_cfg.get("dump_format"))
        or DEFAULT_SIMULATION_DUMP_FORMAT,
        "dump": _as_mapping(_as_mapping(apply_report).get("dump")),
        "replay": _as_mapping(replay_report),
        "monitor_profile": _as_text(
            _as_mapping(monitor_payload.get("monitor")).get("profile")
        ),
        "monitor_poll_count": _safe_int(monitor_payload.get("poll_count")),
        "effective_terminal_signal_ts": _as_text(
            monitor_payload.get("effective_terminal_signal_ts")
        ),
        "cursor_gap_seconds": monitor_payload.get("cursor_gap_seconds"),
    }


def _build_run_summary(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    runtime_verify_report: Mapping[str, Any] | None,
    monitor_report: Mapping[str, Any] | None,
    analytics_report: Mapping[str, Any] | None,
    strategy_proof_report: Mapping[str, Any] | None,
    autonomy_report: Mapping[str, Any] | None,
    errors: Sequence[str],
) -> dict[str, Any]:
    monitor_payload = _as_mapping(monitor_report)
    final_snapshot = _as_mapping(monitor_payload.get("final_snapshot"))
    return {
        "status": "ok" if not errors else "error",
        "run_id": resources.run_id,
        "dataset_id": resources.dataset_id,
        "candidate_id": _as_text(manifest.get("candidate_id")),
        "strategy_spec_ref": _as_text(manifest.get("strategy_spec_ref")),
        "runtime_state": _as_text(
            _as_mapping(runtime_verify_report).get("runtime_state")
        ),
        "activity_classification": _as_text(
            monitor_payload.get("activity_classification")
        ),
        "effective_terminal_signal_ts": _as_text(
            monitor_payload.get("effective_terminal_signal_ts")
        ),
        "cursor_at": _as_text(final_snapshot.get("cursor_at")),
        "trade_decisions": _safe_int(final_snapshot.get("trade_decisions")),
        "executions": _safe_int(final_snapshot.get("executions")),
        "execution_tca_metrics": _safe_int(final_snapshot.get("execution_tca_metrics")),
        "execution_order_events": _safe_int(
            final_snapshot.get("execution_order_events")
        ),
        "legacy_path_count": _safe_int(
            _as_mapping(strategy_proof_report).get("legacy_path_count")
        ),
        "fallback_order_count": _safe_int(
            _as_mapping(strategy_proof_report).get("fallback_order_count")
        ),
        "report_dir": _as_text(_as_mapping(analytics_report).get("report_dir")),
        "autonomy": _as_mapping(autonomy_report),
        "errors": list(errors),
    }


def _build_gate_input(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    monitor_report: Mapping[str, Any] | None,
    strategy_proof_report: Mapping[str, Any] | None,
    fill_price_error_budget_report: Mapping[str, Any] | None,
) -> dict[str, Any]:
    final_snapshot = _as_mapping(_as_mapping(monitor_report).get("final_snapshot"))
    return {
        "run_id": resources.run_id,
        "dataset_id": resources.dataset_id,
        "candidate_id": _as_text(manifest.get("candidate_id")),
        "baseline_candidate_id": _as_text(manifest.get("baseline_candidate_id")),
        "strategy_spec_ref": _as_text(manifest.get("strategy_spec_ref")),
        "model_refs": _as_string_list(manifest.get("model_refs")),
        "activity_classification": _as_text(
            _as_mapping(monitor_report).get("activity_classification")
        ),
        "effective_terminal_signal_ts": _as_text(
            _as_mapping(monitor_report).get("effective_terminal_signal_ts")
        ),
        "cursor_at": _as_text(final_snapshot.get("cursor_at")),
        "trade_decisions": _safe_int(final_snapshot.get("trade_decisions")),
        "executions": _safe_int(final_snapshot.get("executions")),
        "execution_tca_metrics": _safe_int(final_snapshot.get("execution_tca_metrics")),
        "execution_order_events": _safe_int(
            final_snapshot.get("execution_order_events")
        ),
        "strategy_proof": _as_mapping(strategy_proof_report),
        "fill_price_error_budget": _as_mapping(fill_price_error_budget_report),
    }


def _existing_artifact_refs(
    resources: SimulationResources, analytics_report: Mapping[str, Any] | None
) -> list[str]:
    artifact_candidates = [
        _artifact_path(resources, "run-manifest.json"),
        _artifact_path(resources, "run-full-lifecycle-manifest.json"),
        _artifact_path(resources, "runtime-verify.json"),
        _artifact_path(resources, "replay-report.json"),
        _artifact_path(resources, "signal-activity.json"),
        _artifact_path(resources, "decision-activity.json"),
        _artifact_path(resources, "execution-activity.json"),
        _artifact_path(resources, "activity-debug.json"),
        _artifact_path(resources, "strategy-proof.json"),
        _artifact_path(resources, "performance.json"),
        _artifact_path(resources, "run-summary.json"),
        _artifact_path(resources, "gate-input.json"),
        _artifact_path(resources, "autonomy-report.json"),
        _artifact_path(resources, "gates/fill-price-error-budget-report-v1.json"),
    ]
    report_dir = _as_text(_as_mapping(analytics_report).get("report_dir"))
    if report_dir:
        for path in sorted(Path(report_dir).glob("*")):
            if path.is_file():
                artifact_candidates.append(path)
    refs: list[str] = []
    for candidate in artifact_candidates:
        if isinstance(candidate, Path) and candidate.exists():
            refs.append(str(candidate))
    return refs


def _completion_trace_coverage_ratio(
    *,
    window_policy: Mapping[str, Any],
    dump_coverage: Mapping[str, Any],
    analytics_report: Mapping[str, Any],
) -> float:
    coverage_ratio = dump_coverage.get("coverage_ratio")
    if coverage_ratio is not None:
        return max(_safe_float(coverage_ratio), 0.0)

    observed_minutes = _safe_float(dump_coverage.get("observed_minutes"), default=0.0)
    min_coverage_minutes = _safe_int(
        window_policy.get("min_coverage_minutes"), default=0
    )
    if observed_minutes > 0 and min_coverage_minutes > 0:
        return max(observed_minutes / float(min_coverage_minutes), 0.0)

    report_coverage = _as_mapping(analytics_report.get("coverage"))
    report_ratio = report_coverage.get("window_coverage_ratio_from_dump")
    if report_ratio is not None:
        return max(_safe_float(report_ratio), 0.0)
    return 0.0


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
    final_snapshot = _as_mapping(monitor_payload.get("final_snapshot"))
    window_policy = _as_mapping(apply_payload.get("window_policy"))
    dump_coverage = _as_mapping(apply_payload.get("dump_coverage"))
    trade_decisions = _safe_int(final_snapshot.get("trade_decisions"))
    executions = _safe_int(final_snapshot.get("executions"))
    execution_tca_metrics = _safe_int(final_snapshot.get("execution_tca_metrics"))
    execution_order_events = _safe_int(final_snapshot.get("execution_order_events"))
    activity_classification = (
        _as_text(monitor_payload.get("activity_classification")) or "unknown"
    )
    runtime_state = _as_text(runtime_payload.get("runtime_state")) or "unknown"
    coverage_ratio = _completion_trace_coverage_ratio(
        window_policy=window_policy,
        dump_coverage=dump_coverage,
        analytics_report=analytics_payload,
    )
    strict_ratio = float(window_policy.get("strict_coverage_ratio") or 0.0)
    fill_price_payload = _as_mapping(fill_price_error_budget_report)
    gate_results: dict[str, dict[str, Any]] = {}
    blocked_reasons: dict[str, str] = {}
    artifact_refs = _existing_artifact_refs(resources, analytics_payload)

    for gate_id in gate_ids_attempted:
        requires_runtime_ready = gate_id == DOC29_SIMULATION_SMOKE_GATE
        satisfied = (
            activity_classification == "success"
            and trade_decisions >= 1
            and executions >= 1
            and execution_tca_metrics >= 1
            and execution_order_events >= 1
            and (runtime_state == "ready" or not requires_runtime_ready)
        )
        if gate_id == DOC29_SIMULATION_FULL_DAY_GATE:
            satisfied = (
                satisfied
                and coverage_ratio >= strict_ratio
                and _safe_int(window_policy.get("min_coverage_minutes"))
                >= US_EQUITIES_REGULAR_MINUTES
            )
        blocked_reason = None
        if not satisfied:
            if requires_runtime_ready and runtime_state != "ready":
                blocked_reason = "runtime_not_ready"
            elif activity_classification != "success":
                blocked_reason = f"activity_classification:{activity_classification}"
            elif trade_decisions <= 0:
                blocked_reason = "trade_decisions_empty"
            elif executions <= 0:
                blocked_reason = "executions_empty"
            elif execution_tca_metrics <= 0:
                blocked_reason = "execution_tca_metrics_empty"
            elif execution_order_events <= 0:
                blocked_reason = "execution_order_events_empty"
            else:
                blocked_reason = "coverage_threshold_not_met"
            blocked_reasons[gate_id] = blocked_reason
        gate_results[gate_id] = {
            "status": TRACE_STATUS_SATISFIED if satisfied else TRACE_STATUS_BLOCKED,
            "blocked_reason": blocked_reason,
            "artifact_ref": str(
                _artifact_path(resources, "run-full-lifecycle-manifest.json")
            ),
            "acceptance_snapshot": {
                "runtime_state": runtime_state,
                "activity_classification": activity_classification,
                "trade_decisions": trade_decisions,
                "executions": executions,
                "execution_tca_metrics": execution_tca_metrics,
                "execution_order_events": execution_order_events,
                "coverage_ratio": coverage_ratio,
                "strict_coverage_ratio": strict_ratio,
                "min_coverage_minutes": _safe_int(
                    window_policy.get("min_coverage_minutes")
                ),
                "fill_price_error_budget_status": _as_text(
                    fill_price_payload.get("status")
                ),
                "fill_price_error_budget_artifact_ref": (
                    str(
                        _artifact_path(
                            resources, "gates/fill-price-error-budget-report-v1.json"
                        )
                    )
                    if fill_price_payload
                    else None
                ),
            },
        }
    return build_completion_trace(
        doc_id="doc29",
        gate_ids_attempted=gate_ids_attempted,
        run_id=resources.run_id,
        dataset_snapshot_ref=_as_text(manifest.get("dataset_snapshot_ref")),
        candidate_id=_as_text(manifest.get("candidate_id")),
        workflow_name=_as_text(os.getenv("ARGO_WORKFLOW_NAME"))
        or f"torghut-historical-simulation:{resources.run_id}",
        analysis_run_names=[
            _as_text(
                _as_mapping(rollouts_payload.get("runtime_analysis_run")).get("name")
            )
            or "",
            _as_text(
                _as_mapping(rollouts_payload.get("activity_analysis_run")).get("name")
            )
            or "",
            _as_text(
                _as_mapping(rollouts_payload.get("teardown_analysis_run")).get("name")
            )
            or "",
        ],
        artifact_refs=artifact_refs,
        db_row_refs={
            "simulation_postgres_db": postgres_config.simulation_db,
            "simulation_clickhouse_db": resources.clickhouse_db,
            "funnel_counts": {
                "trade_decisions": trade_decisions,
                "executions": executions,
                "execution_tca_metrics": execution_tca_metrics,
                "execution_order_events": execution_order_events,
            },
            "fill_price_error_budget": fill_price_payload,
        },
        status_snapshot={
            "runtime_state": runtime_state,
            "activity_classification": activity_classification,
            "errors": list(errors),
            "rollouts": {
                "runtime_analysis_run": _as_text(
                    _as_mapping(rollouts_payload.get("runtime_analysis_run")).get(
                        "name"
                    )
                ),
                "activity_analysis_run": _as_text(
                    _as_mapping(rollouts_payload.get("activity_analysis_run")).get(
                        "name"
                    )
                ),
                "teardown_analysis_run": _as_text(
                    _as_mapping(rollouts_payload.get("teardown_analysis_run")).get(
                        "name"
                    )
                ),
            },
        },
        result_by_gate=gate_results,
        blocked_reasons=blocked_reasons,
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
    "_build_gate_input",
    "_build_performance_report",
    "_build_run_summary",
    "_build_simulation_completion_trace",
    "_build_strategy_proof_artifact",
    "_completion_trace_coverage_ratio",
    "_existing_artifact_refs",
)
