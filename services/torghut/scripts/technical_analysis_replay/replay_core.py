#!/usr/bin/env python3
"""Execute the standardized Torghut TA replay rollout workflow."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from base64 import b64encode
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.error import URLError
from urllib.request import Request, urlopen

import yaml


TA_CONFIGMAP = "torghut-ta-config"

TA_DEPLOYMENT = "torghut-ta"

APPLY_CONFIRMATION_PHRASE = "REPLAY_TA_CANARY"

SUPPORTED_NAMESPACE = "torghut"

FAILED_RUN_STATES = {
    "FAILED",
    "FAILED_FINISHED",
    "FAILED_RESTARTING",
}

MILLISECONDS_PER_DAY = 86_400_000

DEFAULT_KAFKA_RETENTION_TOPICS: Mapping[str, str] = {
    "trades": "torghut.trades.v1",
    "quotes": "torghut.quotes.v1",
    "bars1m": "torghut.bars.1m.v1",
    "ta_microbars": "torghut.ta.bars.1s.v1",
    "ta_signals": "torghut.ta.signals.v1",
}

RAW_REPLAY_SOURCE_TOPIC_ROLES = frozenset({"trades", "quotes", "bars1m"})

DERIVED_TA_TOPIC_ROLES = frozenset({"ta_microbars", "ta_signals"})

CLICKHOUSE_TA_TTL_DAYS: Mapping[str, int] = {
    "ta_microbars": 35,
    "ta_signals": 35,
}


@dataclass(frozen=True)
class ReplayState:
    namespace: str
    ta_group_id: str
    ta_auto_offset_reset: str
    flink_job_state: str | None
    flink_restart_nonce: int
    flink_status_state: str | None


def _require_kubectl() -> None:
    if shutil.which("kubectl") is None:
        raise SystemExit("kubectl not found in PATH")


def _require_supported_namespace(namespace: str) -> None:
    if namespace != SUPPORTED_NAMESPACE:
        raise SystemExit(
            f"unsupported namespace {namespace!r}; only {SUPPORTED_NAMESPACE!r} is allowed"
        )


def _kubectl_binary() -> str:
    kubectl = shutil.which("kubectl")
    if not kubectl:
        raise SystemExit("kubectl not found in PATH")
    return kubectl


def _run_kubectl(
    args: list[str],
    *,
    input: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [_kubectl_binary(), *args],
        check=True,
        text=True,
        capture_output=True,
        input=input,
    )


def _kubectl_get_ta_config_json() -> dict[str, Any]:
    result = _run_kubectl(
        ["-n", SUPPORTED_NAMESPACE, "get", "configmap", TA_CONFIGMAP, "-o", "json"]
    )
    return json.loads(result.stdout)


def _kubectl_get_ta_deployment_json() -> dict[str, Any]:
    result = _run_kubectl(
        [
            "-n",
            SUPPORTED_NAMESPACE,
            "get",
            "flinkdeployment",
            TA_DEPLOYMENT,
            "-o",
            "json",
        ]
    )
    return json.loads(result.stdout)


def _kubectl_get_kafka_topics_json(
    namespace: str, topic_names: list[str]
) -> dict[str, Any]:
    result = _run_kubectl(
        [
            "-n",
            namespace,
            "get",
            "kafkatopic",
            *topic_names,
            "-o",
            "json",
            "--ignore-not-found=true",
        ]
    )
    return json.loads(result.stdout)


def _kubectl_merge_patch(kind: str, name: str, patch: dict[str, Any]) -> None:
    _run_kubectl(
        [
            "-n",
            SUPPORTED_NAMESPACE,
            "patch",
            kind,
            name,
            "--type",
            "merge",
            "-p",
            yaml.safe_dump(patch),
        ]
    )


def _parse_int(value: object, fallback: int = 0) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            pass
    return fallback


def _load_state(namespace: str) -> ReplayState:
    _require_supported_namespace(namespace)

    cm = _kubectl_get_ta_config_json()
    cm_data = cm.get("data")
    if not isinstance(cm_data, dict):
        raise SystemExit("configmap data is not parseable")

    ta_group_id = str(cm_data.get("TA_GROUP_ID", "")).strip()
    ta_auto_offset_reset = str(cm_data.get("TA_AUTO_OFFSET_RESET", "latest")).strip()
    if not ta_group_id:
        raise SystemExit("TA_GROUP_ID missing in torghut-ta-config")

    flink = _kubectl_get_ta_deployment_json()
    spec = flink.get("spec")
    if not isinstance(spec, dict):
        raise SystemExit("flinkdeployment spec is missing")

    job_spec = spec.get("job")
    job_state = None
    if isinstance(job_spec, dict):
        raw_job_state = job_spec.get("state")
        if isinstance(raw_job_state, str):
            job_state = raw_job_state.strip() or None

    restart_nonce = _parse_int(spec.get("restartNonce"), 0)

    status = flink.get("status")
    flink_status_state = None
    if isinstance(status, dict):
        job_status = status.get("jobStatus")
        if isinstance(job_status, dict):
            raw_status = job_status.get("state")
            if isinstance(raw_status, str):
                flink_status_state = raw_status.strip() or None

    return ReplayState(
        namespace=namespace,
        ta_group_id=ta_group_id,
        ta_auto_offset_reset=ta_auto_offset_reset,
        flink_job_state=job_state,
        flink_restart_nonce=restart_nonce,
        flink_status_state=flink_status_state,
    )


def _plan_command(
    replay_id: str, group_prefix: str, auto_offset_reset: str
) -> dict[str, str]:
    if not replay_id:
        raise SystemExit("replay-id must be provided")
    normalized_prefix = group_prefix.strip().replace("__", "-").strip("-")
    normalized_id = replay_id.strip().replace("__", "-").strip("-")
    replay_group_id = f"{normalized_prefix}-{normalized_id}"
    auto_offset_reset = auto_offset_reset.strip() or "earliest"
    return {
        "replay_group_id": replay_group_id,
        "ta_auto_offset_reset": auto_offset_reset,
    }


def _validate_plan_args(replay_id: str, group_prefix: str) -> None:
    if not replay_id.strip():
        raise SystemExit("replay-id cannot be empty")
    if not group_prefix.strip():
        raise SystemExit("group-prefix cannot be empty")


def _validate_apply_preconditions(
    *,
    state: ReplayState,
    plan: dict[str, str],
    allow_existing_group: bool,
) -> list[str]:
    warnings: list[str] = []
    if state.ta_group_id == plan["replay_group_id"] and not allow_existing_group:
        warnings.append(
            "planned TA_GROUP_ID already equals current value; pass --allow-existing-group-id to continue"
        )
    if state.ta_auto_offset_reset == plan["ta_auto_offset_reset"]:
        warnings.append("TA_AUTO_OFFSET_RESET already matches the replay target")
    return warnings


def _build_plan_report(
    *,
    status: str = "ok",
    namespace: str,
    mode: str,
    state: ReplayState,
    plan: dict[str, str],
    warnings: list[str],
    verify: bool,
    verification: dict[str, bool] | None = None,
    coverage: dict[str, Any] | None = None,
    kafka_retention: dict[str, Any] | None = None,
    replay_feasibility: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "mode": mode,
        "namespace": namespace,
        "current": {
            "ta_group_id": state.ta_group_id,
            "ta_auto_offset_reset": state.ta_auto_offset_reset,
            "flink_job_state": state.flink_job_state,
            "flink_restart_nonce": state.flink_restart_nonce,
            "flink_status_state": state.flink_status_state,
        },
        "plan": plan,
        "warnings": warnings,
        "verify": verification,
        "verify_requested": verify,
        "coverage": coverage,
        "kafka_retention": kafka_retention,
        "replay_feasibility": replay_feasibility,
    }


def _print_plan_text(
    state: ReplayState,
    plan: dict[str, str],
    namespace: str,
    dry_run: bool,
    warnings: list[str],
    coverage: dict[str, Any] | None = None,
    kafka_retention: dict[str, Any] | None = None,
    replay_feasibility: dict[str, Any] | None = None,
) -> None:
    print("Current replay state:")
    print(f"  namespace: {namespace}")
    print(f"  TA_GROUP_ID: {state.ta_group_id}")
    print(f"  TA_AUTO_OFFSET_RESET: {state.ta_auto_offset_reset}")
    print(f"  TA job state: {state.flink_job_state or 'unknown'}")
    print(f"  TA restartNonce: {state.flink_restart_nonce}")
    print(f"  TA status state: {state.flink_status_state or 'unknown'}")
    print("")
    print("Planned action:")
    print(f"  replay-group: {plan['replay_group_id']}")
    print(f"  ta-auto-offset-reset: {plan['ta_auto_offset_reset']}")
    print("Execution sequence (non-destructive replay mode):")
    print("  1) Set TA_GROUP_ID and TA_AUTO_OFFSET_RESET in torghut-ta-config")
    print("  2) Suspend torghut-ta if currently running")
    print("  3) Resume torghut-ta with an incremented restartNonce")
    if dry_run:
        print("  4) Optional post-change verify")
    if warnings:
        print("Warnings:")
        for warning in warnings:
            print(f"  - {warning}")
    if coverage is not None:
        summary_payload = coverage.get("summary")
        summary: Mapping[str, Any] = (
            summary_payload if isinstance(summary_payload, dict) else {}
        )
        print("Coverage preflight:")
        print(f"  status: {coverage.get('status')}")
        print(f"  required-trading-days: {summary.get('required_trading_days', 0)}")
        print(f"  signal-days: {summary.get('ta_signals_days', 0)}")
        print(f"  microbar-days: {summary.get('ta_microbars_days', 0)}")
        print(
            f"  missing-signal-days-vs-required: {summary.get('missing_signal_days_vs_required', 0)}"
        )
        print(f"  microbar-only-days: {summary.get('microbar_only_day_count', 0)}")
    if kafka_retention is not None:
        summary_payload = kafka_retention.get("summary")
        summary: Mapping[str, Any] = (
            summary_payload if isinstance(summary_payload, dict) else {}
        )
        print("Kafka retention preflight:")
        print(f"  status: {kafka_retention.get('status')}")
        print(f"  required-calendar-days: {summary.get('required_calendar_days', 0)}")
        topics_payload = kafka_retention.get("topics")
        topics = topics_payload if isinstance(topics_payload, list) else []
        for topic in topics:
            if not isinstance(topic, dict):
                continue
            retention_days = topic.get("retention_days")
            retention_display = (
                f"{retention_days}d" if retention_days is not None else "unknown"
            )
            print(f"  {topic.get('role')}: {retention_display} ({topic.get('topic')})")
        blockers_payload = kafka_retention.get("blockers")
        blockers = blockers_payload if isinstance(blockers_payload, list) else []
        if blockers:
            print("  blockers:")
            for blocker in blockers:
                print(f"    - {blocker}")
    if replay_feasibility is not None:
        print("Replay feasibility:")
        print(f"  status: {replay_feasibility.get('status')}")
        print(
            f"  exact-replay-capture-ready: {replay_feasibility.get('exact_replay_capture_ready')}"
        )
        print(
            "  non-destructive-replay-admission: "
            f"{replay_feasibility.get('non_destructive_replay_admission')}"
        )
        print(
            f"  current-window-complete: {replay_feasibility.get('current_window_complete')}"
        )
        print(
            f"  source-replay-possible: {replay_feasibility.get('source_replay_possible')}"
        )
        print(
            f"  clickhouse-ttl-sufficient: {replay_feasibility.get('clickhouse_ttl_sufficient')}"
        )
        actions_payload = replay_feasibility.get("required_actions")
        actions = actions_payload if isinstance(actions_payload, list) else []
        if actions:
            print("  required-actions:")
            for action in actions:
                print(f"    - {action}")
    if dry_run:
        print(
            f"Use --mode=apply --confirm {APPLY_CONFIRMATION_PHRASE} to execute the plan."
        )


def _clickhouse_basic_auth(username: str, password: str) -> str:
    token = b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _clickhouse_query(
    *,
    http_url: str,
    username: str,
    password: str,
    query: str,
    timeout_seconds: int,
) -> str:
    request = Request(
        http_url,
        data=query.encode("utf-8"),
        method="POST",
        headers={"Authorization": _clickhouse_basic_auth(username, password)},
    )
    try:
        with urlopen(request, timeout=max(1, timeout_seconds)) as response:
            return response.read().decode("utf-8")
    except URLError as exc:
        raise RuntimeError(f"clickhouse_coverage_query_failed:{exc}") from exc


def _parse_tsv_with_names(raw: str) -> list[dict[str, str]]:
    lines = [line for line in raw.splitlines() if line.strip()]
    if not lines:
        return []
    header = lines[0].split("\t")
    rows: list[dict[str, str]] = []
    for line in lines[1:]:
        values = line.split("\t")
        rows.append(
            {
                name: values[index] if index < len(values) else ""
                for index, name in enumerate(header)
            }
        )
    return rows


def _parse_int_field(row: Mapping[str, str] | None, name: str) -> int:
    if row is None:
        return 0
    try:
        return int(row.get(name, "0") or "0")
    except ValueError:
        return 0


def _table_coverage_query() -> str:
    return """
SELECT
  table_name,
  countDistinct(trading_day) AS days,
  min(trading_day) AS first_day,
  max(trading_day) AS last_day,
  sum(rows) AS rows
FROM (
  SELECT
    'ta_signals' AS table_name,
    toDate(event_ts) AS trading_day,
    count() AS rows
  FROM torghut.ta_signals
  WHERE source = 'ta' AND window_size = 'PT1S'
  GROUP BY trading_day
  UNION ALL
  SELECT
    'ta_microbars' AS table_name,
    toDate(event_ts) AS trading_day,
    count() AS rows
  FROM torghut.ta_microbars
  WHERE source = 'ta' AND window_size = 'PT1S'
  GROUP BY trading_day
)
GROUP BY table_name ORDER BY table_name FORMAT TSVWithNames
""".strip()


def _day_gap_query(limit: int) -> str:
    return f"""
SELECT
  trading_day,
  sumIf(rows, table_name = 'ta_signals') AS signal_rows,
  sumIf(rows, table_name = 'ta_microbars') AS microbar_rows
FROM (
  SELECT
    'ta_signals' AS table_name,
    toDate(event_ts) AS trading_day,
    count() AS rows
  FROM torghut.ta_signals
  WHERE source = 'ta' AND window_size = 'PT1S'
  GROUP BY trading_day
  UNION ALL
  SELECT
    'ta_microbars' AS table_name,
    toDate(event_ts) AS trading_day,
    count() AS rows
  FROM torghut.ta_microbars
  WHERE source = 'ta' AND window_size = 'PT1S'
  GROUP BY trading_day
)
GROUP BY trading_day ORDER BY trading_day DESC LIMIT {max(1, int(limit))} FORMAT TSVWithNames
""".strip()


def _load_clickhouse_coverage(args: argparse.Namespace) -> dict[str, Any] | None:
    if not bool(getattr(args, "check_clickhouse_coverage", False)):
        return None
    password = str(getattr(args, "clickhouse_password", "") or "")
    if not password:
        password = os.environ.get(
            str(getattr(args, "clickhouse_password_env", "") or ""), ""
        )
    if not password:
        raise SystemExit(
            f"--check-clickhouse-coverage requires --clickhouse-password or ${args.clickhouse_password_env}"
        )
    query_args = {
        "http_url": str(args.clickhouse_http_url),
        "username": str(args.clickhouse_username),
        "password": password,
        "timeout_seconds": int(args.clickhouse_timeout_seconds),
    }
    table_rows = _parse_tsv_with_names(
        _clickhouse_query(query=_table_coverage_query(), **query_args)
    )
    day_rows = _parse_tsv_with_names(
        _clickhouse_query(
            query=_day_gap_query(int(args.coverage_day_limit)), **query_args
        )
    )
    table_by_name = {row.get("table_name", ""): row for row in table_rows}
    signal_days = _parse_int_field(table_by_name.get("ta_signals"), "days")
    microbar_days = _parse_int_field(table_by_name.get("ta_microbars"), "days")
    required_days = max(0, int(args.required_trading_days or 0))
    microbar_only_days = [
        row.get("trading_day", "")
        for row in day_rows
        if _parse_int_field(row, "signal_rows") <= 0
        and _parse_int_field(row, "microbar_rows") > 0
    ]
    missing_signal_days = max(0, required_days - signal_days) if required_days else 0
    status = "ok"
    blockers: list[str] = []
    if missing_signal_days:
        status = "insufficient_ta_signal_days"
        blockers.append(f"insufficient_ta_signal_days:{signal_days}<{required_days}")
    if microbar_only_days:
        blockers.append(f"microbar_only_days:{len(microbar_only_days)}")
    return {
        "schema_version": "torghut.ta-replay-coverage-preflight.v1",
        "status": status,
        "blockers": blockers,
        "summary": {
            "required_trading_days": required_days,
            "ta_signals_days": signal_days,
            "ta_microbars_days": microbar_days,
            "missing_signal_days_vs_required": missing_signal_days,
            "microbar_only_day_count": len(microbar_only_days),
            "microbar_only_days": microbar_only_days,
        },
        "tables": table_rows,
        "day_gaps": day_rows,
    }


def _required_calendar_days_from_trading_days(required_trading_days: int) -> int:
    if required_trading_days <= 0:
        return 0
    return (required_trading_days * 7 + 4) // 5


def _parse_kafka_retention_topic_overrides(values: list[str]) -> dict[str, str]:
    topics = dict(DEFAULT_KAFKA_RETENTION_TOPICS)
    for raw_value in values:
        if "=" not in raw_value:
            raise SystemExit(
                f"--kafka-retention-topic must be role=topic, got {raw_value!r}"
            )
        role, topic = raw_value.split("=", 1)
        role = role.strip()
        topic = topic.strip()
        if role not in topics:
            valid_roles = ", ".join(sorted(topics))
            raise SystemExit(
                f"unknown kafka retention topic role {role!r}; expected one of: {valid_roles}"
            )
        if not topic:
            raise SystemExit(f"kafka retention topic for role {role!r} cannot be empty")
        topics[role] = topic
    return topics


def _kafka_topic_items_by_name(
    payload: Mapping[str, Any],
) -> dict[str, Mapping[str, Any]]:
    items_payload = payload.get("items")
    if isinstance(items_payload, list):
        items = items_payload
    else:
        items = [payload]
    by_name: dict[str, Mapping[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        metadata = item.get("metadata")
        if not isinstance(metadata, dict):
            continue
        name = metadata.get("name")
        if isinstance(name, str) and name:
            by_name[name] = item
    return by_name


def _kafka_topic_ready_status(item: Mapping[str, Any]) -> str:
    status = item.get("status")
    if not isinstance(status, dict):
        return "unknown"
    conditions = status.get("conditions")
    if not isinstance(conditions, list):
        return "unknown"
    for condition in conditions:
        if not isinstance(condition, dict):
            continue
        if condition.get("type") == "Ready":
            ready = condition.get("status")
            return str(ready) if ready is not None else "unknown"
    return "unknown"


def _kafka_topic_config(item: Mapping[str, Any]) -> Mapping[str, Any]:
    spec = item.get("spec")
    if not isinstance(spec, dict):
        return {}
    config = spec.get("config")
    return config if isinstance(config, dict) else {}


def _parse_retention_ms(value: object) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _retention_days(retention_ms: int | None) -> float | None:
    if retention_ms is None:
        return None
    return round(retention_ms / MILLISECONDS_PER_DAY, 2)


def _topic_role_has_blocker(blocker: str, role: str) -> bool:
    return (
        (blocker.startswith("retention_") and f":{role}:" in blocker)
        or blocker.startswith(f"kafka_topic_missing:{role}:")
        or blocker.startswith(f"kafka_topic_not_ready:{role}:")
    )
