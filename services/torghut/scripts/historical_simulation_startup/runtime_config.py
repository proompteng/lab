#!/usr/bin/env python3
"""Single-entrypoint historical simulation workflow for Torghut."""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Mapping, cast
from urllib.parse import quote, quote_plus, unquote_plus, urlsplit
from zoneinfo import ZoneInfo

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
    APPLY_CONFIRMATION_PHRASE,
    DEFAULT_COVERAGE_STRICT_RATIO,
    KafkaRuntimeConfig,
    LEGACY_SIMULATION_STRATEGY_TOKENS,
    US_EQUITIES_REGULAR_MINUTES,
    US_EQUITIES_REGULAR_PROFILE,
    US_EQUITIES_REGULAR_TIMEZONE,
)


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

    @property
    def admin_simulation_dsn(self) -> str:
        return _replace_database_in_dsn(
            self.admin_dsn,
            database=self.simulation_db,
            label="manifest.postgres.admin_dsn",
        )


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


@dataclass(frozen=True)
class AutonomyLaneConfig:
    enabled: bool
    signals_path: Path | None = None
    strategy_config_path: Path | None = None
    gate_policy_path: Path | None = None
    output_dir: Path | None = None
    artifact_path: Path | None = None
    repository: str | None = None
    base: str | None = None
    head: str | None = None
    priority_id: str | None = None
    design_doc: str | None = None
    promotion_target: str = "paper"
    strategy_configmap_path: Path | None = None
    approval_token: str | None = None
    persist_results: bool = True
    alpha_train_prices_path: Path | None = None
    alpha_test_prices_path: Path | None = None
    alpha_gate_policy_path: Path | None = None


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Plan/run/apply/report/teardown historical simulation runs with isolated Kafka and storage targets.",
    )
    parser.add_argument(
        "--mode", choices=["plan", "run", "apply", "report", "teardown"], default="plan"
    )
    parser.add_argument(
        "--run-id",
        required=True,
        help="Stable simulation run id (used for all isolation names).",
    )
    parser.add_argument(
        "--dataset-manifest",
        required=True,
        help="JSON or YAML manifest describing dataset + infra endpoints.",
    )
    parser.add_argument(
        "--confirm",
        default="",
        help=f"Apply confirmation phrase: {APPLY_CONFIRMATION_PHRASE}",
    )
    parser.add_argument(
        "--json", action="store_true", help="Emit machine-readable JSON output only."
    )
    parser.add_argument(
        "--force-replay",
        action="store_true",
        help="Replay dump even when replay marker exists.",
    )
    parser.add_argument(
        "--force-dump",
        action="store_true",
        help="Re-dump source topics even when dump file exists.",
    )
    parser.add_argument(
        "--allow-missing-state",
        action="store_true",
        help="Allow teardown without an existing state file (no-op restore).",
    )
    parser.add_argument(
        "--skip-teardown",
        action="store_true",
        help="Do not teardown runtime after mode=run/report (for debugging only).",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="With mode=run, execute report generation after monitor without calling apply.",
    )
    return parser.parse_args()


def _load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"dataset manifest not found: {path}")
    raw = path.read_text(encoding="utf-8")
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml"}:
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)
    if not isinstance(payload, Mapping):
        raise SystemExit("dataset manifest must parse to a mapping object")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _normalize_run_token(run_id: str) -> str:
    token = re.sub(r"[^a-zA-Z0-9]+", "_", run_id.strip().lower()).strip("_")
    token = re.sub(r"_+", "_", token)
    if not token:
        raise SystemExit("run-id must contain at least one alphanumeric character")
    return token


def _normalize_kubernetes_name_token(value: str) -> str:
    token = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    token = re.sub(r"-+", "-", token)
    if not token:
        raise SystemExit(
            "kubernetes name token must contain at least one alphanumeric character"
        )
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
        "dataset_snapshot_ref": _as_text(manifest.get("dataset_snapshot_ref")),
        "candidate_id": _as_text(manifest.get("candidate_id")),
        "baseline_candidate_id": _as_text(manifest.get("baseline_candidate_id")),
        "strategy_spec_ref": _as_text(manifest.get("strategy_spec_ref")),
        "model_refs": _as_string_list(manifest.get("model_refs")),
        "runtime_version_refs": _as_string_list(manifest.get("runtime_version_refs")),
    }


def _experimental_allow_legacy_strategy(manifest: Mapping[str, Any]) -> bool:
    experimental = _as_mapping(manifest.get("experimental"))
    value = experimental.get("allowLegacyStrategy")
    if value is None:
        value = experimental.get("allow_legacy_strategy")
    normalized = (_as_text(value) or "").strip().lower()
    return normalized in {"1", "true", "yes", "on"}


def _contains_legacy_strategy_reference(manifest: Mapping[str, Any]) -> bool:
    model_refs = _as_string_list(manifest.get("model_refs"))
    candidate_id = _as_text(manifest.get("candidate_id")) or ""
    baseline_candidate_id = _as_text(manifest.get("baseline_candidate_id")) or ""
    strategy_spec_ref = _as_text(manifest.get("strategy_spec_ref")) or ""
    values = [candidate_id, baseline_candidate_id, strategy_spec_ref, *model_refs]
    normalized_values = [value.strip().lower() for value in values if value.strip()]
    return any(
        token in value
        for token in LEGACY_SIMULATION_STRATEGY_TOKENS
        for value in normalized_values
    )


def _validate_simulation_strategy_policy(manifest: Mapping[str, Any]) -> None:
    if _contains_legacy_strategy_reference(
        manifest
    ) and not _experimental_allow_legacy_strategy(manifest):
        raise RuntimeError(
            "legacy_strategy_not_allowed: set experimental.allowLegacyStrategy=true for non-promotable legacy replays"
        )


def _parse_rfc3339_timestamp(value: str | None, *, label: str) -> datetime:
    if value is None:
        raise SystemExit(f"{label} is required in manifest")
    cleaned = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError as exc:
        raise SystemExit(f"invalid {label} timestamp: {value}") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_optional_rfc3339_timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return _parse_rfc3339_timestamp(value, label="timestamp")
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


def _truthy(value: Any) -> bool:
    return str(value or "false").strip().lower() in {"1", "true", "yes", "on"}


def _resolve_manifest_relative_path(
    value: Any,
    *,
    manifest_path: Path,
    label: str,
    must_exist: bool = True,
) -> Path | None:
    text = _as_text(value)
    if text is None:
        return None
    resolved = Path(text)
    if not resolved.is_absolute():
        resolved = manifest_path.parent / resolved
    resolved = resolved.resolve()
    if must_exist and not resolved.exists():
        raise RuntimeError(f"{label} not found: {resolved}")
    return resolved


def _resolve_window_bounds(manifest: Mapping[str, Any]) -> tuple[datetime, datetime]:
    window = _as_mapping(manifest.get("window"))
    start = _parse_rfc3339_timestamp(
        _as_text(window.get("start")), label="window.start"
    )
    end = _parse_rfc3339_timestamp(_as_text(window.get("end")), label="window.end")
    if end <= start:
        raise RuntimeError("window.end must be after window.start")
    return start, end


def _window_min_coverage_minutes(
    window: Mapping[str, Any], *, profile: str | None
) -> int | None:
    raw_minutes = window.get("min_coverage_minutes")
    if raw_minutes is not None:
        minutes = _safe_int(raw_minutes, default=-1)
        if minutes <= 0:
            raise RuntimeError("window.min_coverage_minutes must be > 0 when provided")
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
    trading_day_raw = _as_text(window.get("trading_day"))
    if trading_day_raw is None:
        raise RuntimeError(
            "window.trading_day is required when window.profile=us_equities_regular"
        )
    timezone_name = _as_text(window.get("timezone")) or US_EQUITIES_REGULAR_TIMEZONE
    try:
        local_tz = ZoneInfo(timezone_name)
    except Exception as exc:
        raise RuntimeError(f"invalid_window_timezone:{timezone_name}") from exc
    try:
        trading_day = date.fromisoformat(trading_day_raw)
    except ValueError as exc:
        raise RuntimeError(f"invalid_window_trading_day:{trading_day_raw}") from exc

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
            "window_profile_mismatch:us_equities_regular "
            f"expected_start={expected_start_utc.isoformat()} "
            f"expected_end={expected_end_utc.isoformat()} "
            f"observed_start={start.isoformat()} "
            f"observed_end={end.isoformat()}"
        )


def _validate_window_policy(manifest: Mapping[str, Any]) -> dict[str, Any]:
    start, end = _resolve_window_bounds(manifest)
    window = _as_mapping(manifest.get("window"))
    profile = (_as_text(window.get("profile")) or "").strip().lower() or None
    if profile == US_EQUITIES_REGULAR_PROFILE:
        _validate_us_equities_regular_profile(
            start=start,
            end=end,
            window=window,
        )
    elif profile is not None:
        raise RuntimeError(f"unsupported_window_profile:{profile}")

    min_coverage_minutes = _window_min_coverage_minutes(window, profile=profile)
    observed_minutes = (end - start).total_seconds() / 60.0
    if min_coverage_minutes is not None and observed_minutes < float(
        min_coverage_minutes
    ):
        raise RuntimeError(
            "window_coverage_too_short "
            f"observed_minutes={observed_minutes:.2f} "
            f"required_minutes={min_coverage_minutes}"
        )
    strict_ratio_raw = window.get("strict_coverage_ratio")
    strict_ratio = (
        _safe_float(strict_ratio_raw, default=DEFAULT_COVERAGE_STRICT_RATIO)
        if strict_ratio_raw is not None
        else DEFAULT_COVERAGE_STRICT_RATIO
    )
    if strict_ratio <= 0 or strict_ratio > 1:
        raise RuntimeError("window.strict_coverage_ratio must be within (0,1]")

    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "duration_minutes": observed_minutes,
        "profile": profile,
        "min_coverage_minutes": min_coverage_minutes,
        "strict_coverage_ratio": strict_ratio,
    }


def _validate_dump_coverage(
    *,
    manifest: Mapping[str, Any],
    dump_report: Mapping[str, Any],
) -> dict[str, Any]:
    window = _as_mapping(manifest.get("window"))
    profile = (_as_text(window.get("profile")) or "").strip().lower() or None
    min_coverage_minutes = _window_min_coverage_minutes(window, profile=profile)
    strict_ratio_raw = window.get("strict_coverage_ratio")
    strict_ratio = (
        _safe_float(strict_ratio_raw, default=DEFAULT_COVERAGE_STRICT_RATIO)
        if strict_ratio_raw is not None
        else DEFAULT_COVERAGE_STRICT_RATIO
    )

    records = _safe_int(dump_report.get("records"))
    if records <= 0:
        raise RuntimeError("dump_records_empty")

    min_source_timestamp_ms = dump_report.get("min_source_timestamp_ms")
    max_source_timestamp_ms = dump_report.get("max_source_timestamp_ms")
    if min_source_timestamp_ms is None or max_source_timestamp_ms is None:
        return {
            "applied": False,
            "reason": "timestamp_coverage_unavailable",
        }

    min_ms = _safe_int(min_source_timestamp_ms, default=-1)
    max_ms = _safe_int(max_source_timestamp_ms, default=-1)
    if min_ms < 0 or max_ms < 0 or max_ms < min_ms:
        raise RuntimeError("dump_timestamp_coverage_invalid")
    observed_minutes = (max_ms - min_ms) / 60_000.0
    coverage_ratio = (
        observed_minutes / float(min_coverage_minutes)
        if min_coverage_minutes is not None and float(min_coverage_minutes) > 0
        else None
    )

    if min_coverage_minutes is not None:
        required_minutes = float(min_coverage_minutes) * strict_ratio
        if observed_minutes < required_minutes:
            raise RuntimeError(
                "dump_coverage_too_short "
                f"observed_minutes={observed_minutes:.2f} "
                f"required_minutes={required_minutes:.2f} "
                f"strict_ratio={strict_ratio:.4f}"
            )
        return {
            "applied": True,
            "observed_minutes": observed_minutes,
            "coverage_ratio": coverage_ratio,
            "required_minutes": required_minutes,
            "min_source_timestamp_ms": min_ms,
            "max_source_timestamp_ms": max_ms,
            "strict_ratio": strict_ratio,
            "profile": profile,
        }
    return {
        "applied": False,
        "observed_minutes": observed_minutes,
        "coverage_ratio": coverage_ratio,
        "reason": "no_minimum_coverage_policy",
        "min_source_timestamp_ms": min_ms,
        "max_source_timestamp_ms": max_ms,
    }


def _build_kafka_runtime_config(manifest: Mapping[str, Any]) -> KafkaRuntimeConfig:
    kafka = _as_mapping(manifest.get("kafka"))
    bootstrap_servers = _as_text(kafka.get("bootstrap_servers"))
    if not bootstrap_servers:
        raise SystemExit("manifest.kafka.bootstrap_servers is required")
    runtime_bootstrap_servers = (
        _as_text(kafka.get("runtime_bootstrap_servers")) or bootstrap_servers
    )
    security_protocol = _as_text(kafka.get("security_protocol"))
    sasl_mechanism = _as_text(kafka.get("sasl_mechanism"))
    sasl_username = _as_text(kafka.get("sasl_username"))
    runtime_security_protocol = (
        _as_text(kafka.get("runtime_security_protocol")) or security_protocol
    )
    runtime_sasl_mechanism = (
        _as_text(kafka.get("runtime_sasl_mechanism")) or sasl_mechanism
    )
    runtime_sasl_username = (
        _as_text(kafka.get("runtime_sasl_username")) or sasl_username
    )
    password = _as_text(kafka.get("sasl_password"))
    password_env = _as_text(kafka.get("sasl_password_env"))
    if password is None and password_env:
        password = _as_text(os.environ.get(password_env))
    runtime_password = _as_text(kafka.get("runtime_sasl_password"))
    runtime_password_env = _as_text(kafka.get("runtime_sasl_password_env"))
    if runtime_password is None and runtime_password_env:
        runtime_password = _as_text(os.environ.get(runtime_password_env))
    if runtime_password is None:
        runtime_password = password
    if runtime_security_protocol and runtime_security_protocol.upper().startswith(
        "SASL"
    ):
        if not runtime_sasl_mechanism:
            raise SystemExit(
                "manifest.kafka.runtime_sasl_mechanism is required for SASL runtime"
            )
        if not runtime_sasl_username:
            raise SystemExit(
                "manifest.kafka.runtime_sasl_username is required for SASL runtime"
            )
        if not runtime_password:
            raise SystemExit(
                "manifest.kafka.runtime_sasl_password is missing for SASL runtime. "
                "Set manifest.kafka.runtime_sasl_password_env/runtime_sasl_password "
                "or fallback fields manifest.kafka.sasl_password_env/sasl_password"
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


def _build_clickhouse_runtime_config(
    manifest: Mapping[str, Any],
) -> ClickHouseRuntimeConfig:
    clickhouse = _as_mapping(manifest.get("clickhouse"))
    http_url = _as_text(clickhouse.get("http_url"))
    if not http_url:
        raise SystemExit("manifest.clickhouse.http_url is required")
    password = _as_text(clickhouse.get("password"))
    if password is None:
        password_env = _as_text(clickhouse.get("password_env"))
        if password_env:
            password = _as_text(os.environ.get(password_env))
    return ClickHouseRuntimeConfig(
        http_url=http_url.rstrip("/"),
        username=_as_text(clickhouse.get("username")),
        password=password,
    )


def _derive_simulation_dsn(admin_dsn: str, db_name: str) -> str:
    parsed = urlsplit(admin_dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit("manifest.postgres.admin_dsn must be a valid URL")
    suffix = f"?{parsed.query}" if parsed.query else ""
    return f"{parsed.scheme}://{parsed.netloc}/{quote_plus(db_name)}{suffix}"


def _database_name_from_dsn(dsn: str, *, label: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit(f"{label} must be a valid URL")
    raw_path = parsed.path.lstrip("/")
    if not raw_path:
        raise SystemExit(f"{label} must include a database path")
    database = unquote_plus(raw_path).strip()
    if not database:
        raise SystemExit(f"{label} must include a database path")
    return database


def _replace_database_in_dsn(dsn: str, *, database: str, label: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit(f"{label} must be a valid URL")
    return parsed._replace(path="/" + quote_plus(database)).geturl()


def _replace_password_in_dsn(dsn: str, *, password: str, label: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise RuntimeError(f"{label} must be a valid URL")
    if parsed.username is None:
        raise RuntimeError(f"{label} must include a username")

    host = parsed.hostname
    if host is None:
        raise RuntimeError(f"{label} must include a hostname")
    if parsed.port:
        host = f"{host}:{parsed.port}"

    return parsed._replace(
        netloc=f"{quote_plus(parsed.username)}:{quote_plus(password)}@{host}"
    ).geturl()


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
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    username = parsed.username
    password = parsed.password
    if username is None:
        netloc = host
    elif password is None:
        netloc = f"{quote(username, safe='')}@{host}"
    else:
        netloc = f"{quote(username, safe='')}:***@{host}"
    return parsed._replace(netloc=netloc).geturl()


__all__ = (
    "ArgocdAutomationConfig",
    "AutonomyLaneConfig",
    "COMPONENT_ARTIFACTS",
    "COMPONENT_REPLAY",
    "COMPONENT_TA",
    "COMPONENT_TORGHUT",
    "CephS3Client",
    "ClickHouseRuntimeConfig",
    "DOC29_SIMULATION_FULL_DAY_GATE",
    "DOC29_SIMULATION_SMOKE_GATE",
    "EQUITY_SIMULATION_LANE",
    "PostgresRuntimeConfig",
    "RolloutsAnalysisConfig",
    "SIMULATION_PROGRESS_COMPONENTS",
    "SessionLocal",
    "SimulationResources",
    "TRACE_STATUS_BLOCKED",
    "TRACE_STATUS_SATISFIED",
    "build_completion_trace",
    "build_fill_price_error_budget_report_v1",
    "persist_completion_trace",
    "run_autonomous_lane",
    "simulation_clickhouse_table_names",
    "simulation_lane_contract",
    "simulation_lane_contract_for_manifest",
    "simulation_schema_registry_subject_roles",
    "simulation_verification",
    "_as_mapping",
    "_as_string_list",
    "_as_text",
    "_build_clickhouse_runtime_config",
    "_build_kafka_runtime_config",
    "_contains_legacy_strategy_reference",
    "_database_name_from_dsn",
    "_derive_simulation_dsn",
    "_ensure_dsn_password",
    "_experimental_allow_legacy_strategy",
    "_load_manifest",
    "_normalize_kubernetes_name_token",
    "_normalize_run_token",
    "_parse_args",
    "_parse_optional_rfc3339_timestamp",
    "_parse_rfc3339_timestamp",
    "_redact_dsn_credentials",
    "_replace_database_in_dsn",
    "_replace_password_in_dsn",
    "_resolve_manifest_relative_path",
    "_resolve_window_bounds",
    "_safe_float",
    "_safe_int",
    "_simulation_evidence_lineage",
    "_truthy",
    "_username_from_dsn",
    "_validate_dump_coverage",
    "_validate_simulation_strategy_policy",
    "_validate_us_equities_regular_profile",
    "_validate_window_policy",
    "_window_min_coverage_minutes",
)
