from __future__ import annotations

import json
import re
import subprocess
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timezone
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, cast
from urllib.parse import quote_plus, unquote_plus, urlsplit
from zoneinfo import ZoneInfo

from scripts.simulation_lane_contracts import (
    EQUITY_SIMULATION_LANE,
    simulation_lane_contract,
)

PRODUCTION_TOPIC_BY_ROLE = dict(EQUITY_SIMULATION_LANE.source_topic_by_role)

TORGHUT_ENV_KEYS = [
    "DB_DSN",
    "TRADING_MODE",
    "TRADING_FEATURE_FLAGS_ENABLED",
    "TRADING_FEATURE_QUALITY_ENABLED",
    "TRADING_FEATURE_MAX_REQUIRED_NULL_RATE",
    "TRADING_FEATURE_MAX_STALENESS_MS",
    "TRADING_FEATURE_MAX_DUPLICATE_RATIO",
    "TRADING_STRATEGY_RUNTIME_MODE",
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
    "TRADING_SIMULATION_ENABLED",
    "TRADING_SIMULATION_RUN_ID",
    "TRADING_SIMULATION_DATASET_ID",
    "TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
    "TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS",
    "TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL",
    "TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM",
    "TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME",
    "TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD",
]

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

DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS = 1

DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS = 5

DEFAULT_RUN_MONITOR_PROFILE = "smoke"

DEFAULT_WARM_LANE_SIMULATION_DATABASE = "torghut_sim_default"

DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID = "torghut-order-feed-sim-default"

DEFAULT_SIMULATION_TA_GROUP_ID = "torghut-ta-sim-default"

MONITOR_PROFILE_DEFAULTS: dict[str, dict[str, int]] = {
    "compact": {
        "timeout_seconds": 300,
        "poll_seconds": 5,
        "cursor_grace_seconds": 15,
    },
    "smoke": {
        "timeout_seconds": 900,
        "poll_seconds": 10,
        "cursor_grace_seconds": 30,
    },
    "hourly": {
        "timeout_seconds": 1500,
        "poll_seconds": 10,
        "cursor_grace_seconds": 45,
    },
    "full_day": {
        "timeout_seconds": 3600,
        "poll_seconds": 20,
        "cursor_grace_seconds": 120,
    },
}

TRANSIENT_POSTGRES_ERROR_PATTERNS = (
    "connection refused",
    "connection reset by peer",
    "could not receive data from server",
    "server closed the connection unexpectedly",
    "connection to server at",
    "terminating connection due to administrator command",
    "timeout expired",
)


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


def _normalized_string_set(raw: str | None) -> set[str]:
    if raw is None:
        return set()
    return {token.strip().lower() for token in raw.split(",") if token.strip()}


def _resource_attr(resource: Any, key: str, *, default: Any = None) -> Any:
    if isinstance(resource, Mapping):
        return resource.get(key, default)
    return getattr(resource, key, default)


def _resource_asdict(resource: Any) -> dict[str, Any]:
    if isinstance(resource, Mapping):
        return {
            str(key): value for key, value in cast(Mapping[str, Any], resource).items()
        }
    if is_dataclass(resource):
        payload = asdict(resource)
        return {str(key): value for key, value in cast(dict[str, Any], payload).items()}
    return dict(vars(resource))


def _resource_lane_contract(resource: Any):
    lane = _as_text(_resource_attr(resource, "lane")) or "equity"
    return simulation_lane_contract(lane)


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


def _resolve_window_bounds(manifest: Mapping[str, Any]) -> tuple[datetime, datetime]:
    window = _as_mapping(manifest.get("window"))
    start = _parse_rfc3339_timestamp(
        _as_text(window.get("start")), label="window.start"
    )
    end = _parse_rfc3339_timestamp(_as_text(window.get("end")), label="window.end")
    if end <= start:
        raise RuntimeError("window.end must be after window.start")
    return start, end


def _run_scoped_simulation_topic(topic: str, run_id: str) -> str:
    token = re.sub(r"[^a-zA-Z0-9]+", "_", run_id.strip().lower()).strip("_")
    token = re.sub(r"_+", "_", token)
    if not token:
        return topic
    return f"{topic}.{token}"


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
        trading_day.year, trading_day.month, trading_day.day, 9, 30, tzinfo=local_tz
    )
    expected_end_local = datetime(
        trading_day.year, trading_day.month, trading_day.day, 16, 0, tzinfo=local_tz
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
        _validate_us_equities_regular_profile(start=start, end=end, window=window)
    elif profile is not None:
        raise RuntimeError(f"unsupported_window_profile:{profile}")

    min_coverage_minutes = _window_min_coverage_minutes(window, profile=profile)
    observed_minutes = (end - start).total_seconds() / 60.0
    if min_coverage_minutes is not None and observed_minutes < float(
        min_coverage_minutes
    ):
        raise RuntimeError(
            "window_coverage_too_small "
            f"observed_minutes={observed_minutes:.3f} "
            f"minimum_required={min_coverage_minutes}"
        )

    strict_ratio = _safe_float(
        window.get("strict_coverage_ratio"), default=DEFAULT_COVERAGE_STRICT_RATIO
    )
    if strict_ratio <= 0 or strict_ratio > 1:
        raise RuntimeError("window.strict_coverage_ratio must be in (0, 1]")

    return {
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "profile": profile,
        "min_coverage_minutes": min_coverage_minutes,
        "observed_minutes": observed_minutes,
        "strict_coverage_ratio": strict_ratio,
    }


def _validate_dump_coverage(
    *,
    manifest: Mapping[str, Any],
    dump_report: Mapping[str, Any],
) -> dict[str, Any]:
    window = _as_mapping(manifest.get("window"))
    profile = (_as_text(window.get("profile")) or "").strip().lower() or None
    min_coverage_minutes = _window_min_coverage_minutes(
        window,
        profile=profile,
    )
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


def _replace_database_in_dsn(dsn: str, *, database: str, label: str) -> str:
    parsed = urlsplit(dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit(f"{label} must be a valid URL")
    return parsed._replace(path="/" + quote_plus(database)).geturl()


def _database_name_from_dsn(raw_dsn: str | None) -> str | None:
    text = (raw_dsn or "").strip()
    if not text:
        return None
    parsed = urlsplit(text)
    if not parsed.scheme or not parsed.netloc:
        return None
    raw_path = parsed.path.lstrip("/")
    if not raw_path:
        return None
    database = unquote_plus(raw_path).strip()
    return database or None


def _run_command(
    args: Sequence[str],
    *,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(args),
            check=True,
            text=True,
            capture_output=True,
            input=input_text,
        )
    except subprocess.CalledProcessError as exc:
        stdout = (exc.stdout or "").strip()
        stderr = (exc.stderr or "").strip()
        detail = stderr or stdout or str(exc)
        raise RuntimeError(f"command_failed: {' '.join(args)}: {detail}") from exc


def _kubectl_json(namespace: str, args: Sequence[str]) -> dict[str, Any]:
    result = _run_command(["kubectl", "-n", namespace, *args])
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError("kubectl did not return a mapping payload")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _cluster_service_http_urls(raw_url: str) -> list[str]:
    parsed = urlsplit(raw_url)
    host = parsed.hostname
    if host is None or ".svc" not in host:
        return [raw_url]

    host_parts = host.split(".")
    if len(host_parts) < 2:
        return [raw_url]

    service_name = host_parts[0]
    namespace = host_parts[1]
    resolved_urls = [raw_url]
    seen_urls = {raw_url}

    def _append_host(candidate_host: str | None) -> None:
        if candidate_host is None:
            return
        candidate_host = candidate_host.strip()
        if not candidate_host or candidate_host.lower() == "none":
            return
        netloc = (
            f"{candidate_host}:{parsed.port}"
            if parsed.port is not None
            else candidate_host
        )
        candidate_url = parsed._replace(netloc=netloc).geturl()
        if candidate_url in seen_urls:
            return
        seen_urls.add(candidate_url)
        resolved_urls.append(candidate_url)

    try:
        service_payload = _kubectl_json(
            namespace, ["get", "service", service_name, "-o", "json"]
        )
    except Exception:
        service_payload = {}
    _append_host(
        _as_text(_as_mapping(_as_mapping(service_payload).get("spec")).get("clusterIP"))
    )

    try:
        endpoint_payload = _kubectl_json(
            namespace, ["get", "endpoints", service_name, "-o", "json"]
        )
    except Exception:
        endpoint_payload = {}
    subsets = endpoint_payload.get("subsets")
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
                _append_host(_as_text(address.get("ip")))
    return resolved_urls


def _is_transient_postgres_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(pattern in message for pattern in TRANSIENT_POSTGRES_ERROR_PATTERNS)


def _run_with_transient_postgres_retry(
    *,
    label: str,
    operation: Callable[[], Any],
    attempts: int = 8,
    sleep_seconds: float = 0.5,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except Exception as exc:
            if not _is_transient_postgres_error(exc):
                raise
            last_error = exc
            if attempt >= attempts:
                break
            time.sleep(sleep_seconds * attempt)
    if last_error is None:
        raise RuntimeError(
            f"{label}: transient retry failed without captured exception"
        )
    raise RuntimeError(
        f"{label}: exhausted transient retries: {last_error}"
    ) from last_error


def _http_clickhouse_query(
    *,
    config: Any,
    query: str,
) -> tuple[int, str]:
    http_url = _as_text(_resource_attr(config, "http_url"))
    if http_url is None:
        raise RuntimeError("clickhouse http_url is required")
    headers = {"Content-Type": "text/plain"}
    username = _as_text(_resource_attr(config, "username"))
    password = _as_text(_resource_attr(config, "password"))
    if username is not None:
        headers["X-ClickHouse-User"] = username
    if password is not None:
        headers["X-ClickHouse-Key"] = password

    last_error: OSError | None = None
    for candidate_url in _cluster_service_http_urls(http_url):
        parsed = urlsplit(candidate_url)
        if not parsed.scheme or not parsed.hostname:
            raise RuntimeError(f"invalid_clickhouse_http_url:{candidate_url}")
        connection_class = (
            HTTPSConnection if parsed.scheme == "https" else HTTPConnection
        )
        connection: HTTPConnection | HTTPSConnection | None = None
        try:
            connection = connection_class(parsed.hostname, parsed.port)
            path = parsed.path or "/"
            if parsed.query:
                path = f"{path}?{parsed.query}"
            connection.request(
                "POST", path, body=query.encode("utf-8"), headers=headers
            )
            response = connection.getresponse()
            return response.status, response.read().decode("utf-8")
        except OSError as exc:
            last_error = exc
            continue
        finally:
            if connection is not None:
                connection.close()
    if last_error is not None:
        raise last_error
    raise RuntimeError(f"invalid_clickhouse_http_url:{http_url}")


def _condition_status(payload: Mapping[str, Any], *, condition_type: str) -> str | None:
    conditions = payload.get("conditions")
    if not isinstance(conditions, list):
        return None
    for raw_item in conditions:
        if not isinstance(raw_item, Mapping):
            continue
        item = cast(Mapping[str, Any], raw_item)
        if _as_text(item.get("type")) == condition_type:
            return _as_text(item.get("status"))
    return None


def _deployment_replica_health(namespace: str, name: str) -> dict[str, Any]:
    deployment = _kubectl_json(namespace, ["get", "deployment", name, "-o", "json"])
    status = _as_mapping(deployment.get("status"))
    return {
        "name": name,
        "ready_replicas": int(status.get("readyReplicas") or 0),
        "available_replicas": int(status.get("availableReplicas") or 0),
        "replicas": int(status.get("replicas") or 0),
    }


def _flink_runtime_health(namespace: str, name: str) -> dict[str, Any]:
    deployment = _kubectl_json(
        namespace, ["get", "flinkdeployment", name, "-o", "json"]
    )
    spec = _as_mapping(deployment.get("spec"))
    status = _as_mapping(deployment.get("status"))
    job_status = _as_mapping(status.get("jobStatus"))
    lifecycle_state = _as_text(job_status.get("state")) or _as_text(
        status.get("jobManagerDeploymentStatus")
    )
    job_spec = _as_mapping(spec.get("job"))
    restore_error = _classify_restore_state_error(
        _first_text(
            job_status.get("error"),
            job_status.get("message"),
            status.get("error"),
            status.get("message"),
        )
    )
    return {
        "name": name,
        "desired_state": _as_text(job_spec.get("state")) or "unknown",
        "lifecycle_state": lifecycle_state or "unknown",
        "job_manager_status": _as_text(status.get("jobManagerDeploymentStatus"))
        or "unknown",
        "upgrade_mode": _as_text(job_spec.get("upgradeMode")) or "unknown",
        "status_error": _first_text(
            job_status.get("error"),
            job_status.get("message"),
            status.get("error"),
            status.get("message"),
        ),
        "restore_state_reason": restore_error,
    }


def _first_text(*values: Any) -> str | None:
    for value in values:
        text = _as_text(value)
        if text:
            return text
    return None


def _classify_restore_state_error(message: str | None) -> str | None:
    normalized = (message or "").strip().lower()
    if not normalized:
        return None
    has_state_term = any(
        term in normalized for term in ("checkpoint", "savepoint", "last-state")
    )
    has_missing_term = any(
        term in normalized
        for term in ("not found", "no such file", "does not exist", "missing")
    )
    if has_state_term and has_missing_term:
        return "restore_state_missing"
    return None


__all__ = [
    "DEFAULT_COVERAGE_STRICT_RATIO",
    "DEFAULT_HTTP_PROBE_TIMEOUT_SECONDS",
    "DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS",
    "DEFAULT_RUN_MONITOR_CURSOR_TERMINAL_TOLERANCE_SECONDS",
    "DEFAULT_RUN_MONITOR_MIN_DECISIONS",
    "DEFAULT_RUN_MONITOR_MIN_EXECUTIONS",
    "DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS",
    "DEFAULT_RUN_MONITOR_MIN_TCA",
    "DEFAULT_RUN_MONITOR_POLL_SECONDS",
    "DEFAULT_RUN_MONITOR_PROFILE",
    "DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS",
    "DEFAULT_SIMULATION_ORDER_FEED_GROUP_ID",
    "DEFAULT_SIMULATION_TA_GROUP_ID",
    "DEFAULT_WARM_LANE_SIMULATION_DATABASE",
    "MONITOR_PROFILE_DEFAULTS",
    "PRODUCTION_TOPIC_BY_ROLE",
    "TORGHUT_ENV_KEYS",
    "TRANSIENT_POSTGRES_ERROR_PATTERNS",
    "US_EQUITIES_REGULAR_MINUTES",
    "US_EQUITIES_REGULAR_PROFILE",
    "US_EQUITIES_REGULAR_TIMEZONE",
    "_as_mapping",
    "_as_text",
    "_classify_restore_state_error",
    "_cluster_service_host_candidates",
    "_cluster_service_http_urls",
    "_condition_status",
    "_database_name_from_dsn",
    "_deployment_replica_health",
    "_first_text",
    "_flink_runtime_health",
    "_http_clickhouse_query",
    "_is_transient_postgres_error",
    "_kubectl_json",
    "_normalized_string_set",
    "_parse_optional_rfc3339_timestamp",
    "_parse_rfc3339_timestamp",
    "_replace_database_in_dsn",
    "_resolve_window_bounds",
    "_resource_asdict",
    "_resource_attr",
    "_resource_lane_contract",
    "_run_command",
    "_run_scoped_simulation_topic",
    "_run_with_transient_postgres_retry",
    "_safe_float",
    "_safe_int",
    "_validate_dump_coverage",
    "_validate_us_equities_regular_profile",
    "_validate_window_policy",
    "_window_min_coverage_minutes",
]
