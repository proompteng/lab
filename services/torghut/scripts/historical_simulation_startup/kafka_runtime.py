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
    DEFAULT_SIMULATION_REPLAY_PROFILE,
    EMBEDDED_SCHEMA_REGISTRY_SCHEMA_BY_SUFFIX,
    KafkaRuntimeConfig,
    REPLAY_PROFILE_DEFAULTS,
    SCHEMA_REGISTRY_CONTENT_TYPE,
    TORGHUT_ENV_KEYS,
)
from .runtime_config import (
    SimulationResources,
    _as_mapping,
    _as_text,
    _safe_int,
)
from .kubernetes_argocd import _kubectl_json
from .service_environment import _kservice_env
from .storage_and_database import _http_request


def _restore_torghut_env_required(
    resources: SimulationResources, state: Mapping[str, Any]
) -> bool:
    service = _kubectl_json(
        resources.namespace,
        ["get", "kservice", resources.torghut_service, "-o", "json"],
    )
    _, current_env = _kservice_env(service)
    current_env_by_name = {
        _as_text(entry.get("name")): _as_mapping(entry)
        for entry in current_env
        if _as_text(entry.get("name"))
    }
    snapshot = _as_mapping(state.get("torghut_env_snapshot"))
    for key in TORGHUT_ENV_KEYS:
        snapshot_entry = snapshot.get(key)
        if snapshot_entry is None:
            if current_env_by_name.get(key) is not None:
                return True
            continue
        entry_map = _as_mapping(snapshot_entry)
        expected_entry = {
            "name": key,
            **{k: v for k, v in entry_map.items() if k != "name"},
        }
        if current_env_by_name.get(key) != expected_entry:
            return True
    return False


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


def _fink_runtime_health(namespace: str, name: str) -> dict[str, Any]:
    deployment = _kubectl_json(
        namespace, ["get", "flinkdeployment", name, "-o", "json"]
    )
    spec = _as_mapping(deployment.get("spec"))
    status = _as_mapping(deployment.get("status"))
    job_status = _as_mapping(status.get("jobStatus"))
    lifecycle_state = _as_text(job_status.get("state")) or _as_text(
        status.get("jobManagerDeploymentStatus")
    )
    return {
        "name": name,
        "desired_state": _as_text(_as_mapping(spec.get("job")).get("state"))
        or "unknown",
        "lifecycle_state": lifecycle_state or "unknown",
        "job_manager_status": _as_text(status.get("jobManagerDeploymentStatus"))
        or "unknown",
    }


def _runtime_verify(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    return cast(
        dict[str, Any],
        simulation_verification._runtime_verify(
            resources=resources,
            manifest=manifest,
        ),
    )


def _kafka_admin_client(config: KafkaRuntimeConfig) -> Any:
    KafkaAdminClient = cast(
        Any, importlib.import_module("kafka.admin").KafkaAdminClient
    )

    kwargs = config.kafka_client_kwargs()
    kwargs["client_id"] = f"torghut-sim-admin-{int(time.time())}"
    return KafkaAdminClient(**kwargs)


def _source_topic_partition_counts(admin: Any, topics: Sequence[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    topic_descriptions = admin.describe_topics(list(topics))
    if not isinstance(topic_descriptions, list):
        return counts
    for item in topic_descriptions:
        if not isinstance(item, Mapping):
            continue
        topic = _as_text(item.get("topic"))
        partitions = item.get("partitions")
        if topic is None or not isinstance(partitions, list):
            continue
        counts[topic] = len(partitions)
    return counts


def _kafka_available_broker_count(admin: Any) -> int:
    try:
        cluster = getattr(admin, "_client").cluster
        brokers = cluster.brokers()
    except Exception:
        return 1
    try:
        return max(1, len(brokers))
    except Exception:
        return 1


def _ensure_topics(
    *,
    resources: SimulationResources,
    config: KafkaRuntimeConfig,
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    NewTopic = cast(Any, importlib.import_module("kafka.admin").NewTopic)

    kafka = _as_mapping(manifest.get("kafka"))
    default_partitions = int(kafka.get("default_partitions") or 6)
    replication_factor = int(kafka.get("replication_factor") or 1)
    max_partitions_per_topic = _safe_int(
        kafka.get("max_partitions_per_topic"), default=0
    )
    if max_partitions_per_topic < 0:
        raise RuntimeError("kafka.max_partitions_per_topic cannot be negative")

    admin = _kafka_admin_client(config)
    try:
        existing_topics = set(admin.list_topics())
        available_broker_count = _kafka_available_broker_count(admin)
        source_topics = list(resources.replay_topic_by_source_topic.keys())
        source_partition_counts = _source_topic_partition_counts(admin, source_topics)

        planned_topics = set(resources.simulation_topic_by_role.values())
        new_topics: list[Any] = []
        partition_caps: list[dict[str, int]] = []
        for topic in sorted(planned_topics):
            if topic in existing_topics:
                continue
            requested_partitions = default_partitions
            for (
                source_topic,
                replay_topic,
            ) in resources.replay_topic_by_source_topic.items():
                if replay_topic == topic:
                    requested_partitions = source_partition_counts.get(
                        source_topic, default_partitions
                    )
                    break
            partitions = min(
                max(requested_partitions, 1),
                available_broker_count,
            )
            if max_partitions_per_topic > 0:
                partitions = min(partitions, max_partitions_per_topic)
            if partitions < requested_partitions:
                partition_caps.append(
                    {
                        "topic": topic,
                        "requested_partitions": int(requested_partitions),
                        "applied_partitions": int(partitions),
                    }
                )
            new_topics.append(
                NewTopic(
                    name=topic,
                    num_partitions=max(partitions, 1),
                    replication_factor=max(replication_factor, 1),
                )
            )

        if new_topics:
            admin.create_topics(new_topics=new_topics, validate_only=False)
        return {
            "existing": sorted(existing_topics),
            "created": [topic.name for topic in new_topics],
            "available_brokers": available_broker_count,
            "partition_caps": partition_caps,
            "max_partitions_per_topic": max_partitions_per_topic
            if max_partitions_per_topic > 0
            else None,
        }
    finally:
        admin.close()


def _simulation_schema_registry_subject_specs(
    *,
    resources: SimulationResources,
) -> list[dict[str, str]]:
    lane_contract = simulation_lane_contract(resources.lane)
    schema_files = cast(
        Mapping[str, str],
        lane_contract.schema_registry_schema_file_by_role,
    )
    specs: list[dict[str, str]] = []
    for role in simulation_schema_registry_subject_roles(lane_contract):
        topic = resources.simulation_topic_by_role.get(role)
        schema_relative = _as_text(schema_files.get(role))
        if not topic or not schema_relative:
            continue
        specs.append(
            {
                "role": role,
                "subject": f"{topic}-value",
                "schema_path": str(
                    _resolve_schema_registry_schema_path(schema_relative)
                ),
            }
        )
    return specs


def _resolve_schema_registry_schema_path(schema_relative: str) -> Path:
    script_path = Path(__file__).resolve()
    for candidate_root in (script_path.parent, *script_path.parents):
        candidate_path = (candidate_root / schema_relative).resolve()
        if candidate_path.exists():
            return candidate_path
    return (
        script_path.parents[min(3, len(script_path.parents) - 1)] / schema_relative
    ).resolve()


def _load_schema_registry_schema_literal(schema_path: str) -> str:
    path = Path(schema_path)
    if not path.exists():
        normalized_path = schema_path.replace("\\", "/")
        for suffix, schema_literal in EMBEDDED_SCHEMA_REGISTRY_SCHEMA_BY_SUFFIX.items():
            if normalized_path.endswith(suffix):
                return schema_literal
        raise RuntimeError(f"schema_registry_schema_file_missing:{schema_path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"schema_registry_schema_invalid:{schema_path}") from exc
    return json.dumps(payload, separators=(",", ":"))


def _ensure_simulation_schema_subjects(
    *,
    resources: SimulationResources,
    ta_data: Mapping[str, Any],
) -> dict[str, Any]:
    registry_url = _as_text(ta_data.get("TA_SCHEMA_REGISTRY_URL"))
    specs = _simulation_schema_registry_subject_specs(resources=resources)
    subjects_expected = [spec["subject"] for spec in specs]
    if not registry_url:
        return {
            "ready": True,
            "reason": "schema_registry_url_not_declared",
            "subjects_expected": subjects_expected,
            "subjects_existing": [],
            "subjects_registered": [],
        }
    if not specs:
        return {
            "ready": True,
            "reason": "schema_registry_subjects_not_declared",
            "url": registry_url,
            "subjects_expected": subjects_expected,
            "subjects_existing": [],
            "subjects_registered": [],
        }

    status, _ = _http_request(base_url=registry_url, path="/subjects")
    if status != 200:
        raise RuntimeError(f"schema_registry_not_ready:http_{status}")

    existing: list[str] = []
    registered: list[str] = []
    for spec in specs:
        subject = spec["subject"]
        subject_path = f"/subjects/{quote_plus(subject)}/versions/latest"
        subject_status, _ = _http_request(base_url=registry_url, path=subject_path)
        if subject_status == 200:
            existing.append(subject)
            continue
        if subject_status != 404:
            raise RuntimeError(
                f"schema_registry_subject_check_failed:{subject}:http_{subject_status}"
            )
        schema_literal = _load_schema_registry_schema_literal(spec["schema_path"])
        request_body = json.dumps({"schema": schema_literal})
        create_status, create_body = _http_request(
            base_url=registry_url,
            path=f"/subjects/{quote_plus(subject)}/versions",
            method="POST",
            body=request_body,
            headers={"Content-Type": SCHEMA_REGISTRY_CONTENT_TYPE},
        )
        if create_status not in {200, 201}:
            raise RuntimeError(
                f"schema_registry_subject_register_failed:{subject}:http_{create_status}:{create_body.strip()}"
            )
        registered.append(subject)

    return {
        "ready": True,
        "reason": "ok",
        "url": registry_url,
        "subjects_expected": subjects_expected,
        "subjects_existing": existing,
        "subjects_registered": registered,
    }


def _consumer_for_dump(config: KafkaRuntimeConfig, run_token: str) -> Any:
    KafkaConsumer = cast(Any, importlib.import_module("kafka").KafkaConsumer)

    kwargs = config.kafka_client_kwargs()
    kwargs.update(
        {
            "client_id": f"torghut-sim-dump-{run_token}",
            "enable_auto_commit": False,
            "auto_offset_reset": "earliest",
            "consumer_timeout_ms": 1000,
            "value_deserializer": None,
            "key_deserializer": None,
        }
    )
    return KafkaConsumer(**kwargs)


def _producer_for_replay(
    config: KafkaRuntimeConfig,
    run_token: str,
    *,
    profile: str | None = None,
) -> Any:
    KafkaProducer = cast(Any, importlib.import_module("kafka").KafkaProducer)

    resolved_profile = (profile or DEFAULT_SIMULATION_REPLAY_PROFILE).strip().lower()
    if resolved_profile not in REPLAY_PROFILE_DEFAULTS:
        raise RuntimeError(f"unsupported_replay_profile:{resolved_profile}")
    defaults = REPLAY_PROFILE_DEFAULTS[resolved_profile]
    kwargs = config.kafka_runtime_client_kwargs()
    kwargs.update(
        {
            "client_id": f"torghut-sim-replay-{run_token}",
            "acks": "all",
            "retries": 3,
            "linger_ms": int(defaults["producer_linger_ms"]),
            "batch_size": int(defaults["producer_batch_size"]),
            "buffer_memory": int(defaults["producer_buffer_memory"]),
            "compression_type": str(defaults["producer_compression_type"]),
            "max_in_flight_requests_per_connection": 5,
            "value_serializer": None,
            "key_serializer": None,
        }
    )
    return KafkaProducer(**kwargs)


def _bytes_to_b64(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, bytearray):
        return base64.b64encode(bytes(value)).decode("ascii")
    return base64.b64encode(str(value).encode("utf-8")).decode("ascii")


def _b64_to_bytes(value: Any) -> bytes | None:
    if value is None:
        return None
    return base64.b64decode(str(value).encode("ascii"))


def _headers_to_json(value: Any) -> list[list[str | None]]:
    if not isinstance(value, list):
        return []
    headers: list[list[str | None]] = []
    for item in value:
        if not isinstance(item, tuple) or len(item) != 2:
            continue
        key = _as_text(item[0])
        if key is None:
            continue
        encoded = _bytes_to_b64(item[1])
        headers.append([key, encoded])
    return headers


def _json_to_headers(value: Any) -> list[tuple[str, bytes]]:
    if not isinstance(value, list):
        return []
    headers: list[tuple[str, bytes]] = []
    for item in value:
        if not isinstance(item, list) or len(item) != 2:
            continue
        key = _as_text(item[0])
        payload_b64 = item[1]
        if key is None or payload_b64 is None:
            continue
        headers.append((key, _b64_to_bytes(payload_b64) or b""))
    return headers


def _offset_for_time_lookup(*, metadata: Any, fallback: int) -> int:
    if metadata is None:
        return fallback
    raw_offset = getattr(metadata, "offset", None)
    try:
        offset = int(raw_offset)
    except (TypeError, ValueError):
        return fallback
    if offset < 0:
        return fallback
    return offset


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
    "_b64_to_bytes",
    "_bytes_to_b64",
    "_condition_status",
    "_consumer_for_dump",
    "_deployment_replica_health",
    "_ensure_simulation_schema_subjects",
    "_ensure_topics",
    "_fink_runtime_health",
    "_headers_to_json",
    "_json_to_headers",
    "_kafka_admin_client",
    "_kafka_available_broker_count",
    "_load_schema_registry_schema_literal",
    "_offset_for_time_lookup",
    "_producer_for_replay",
    "_resolve_schema_registry_schema_path",
    "_restore_torghut_env_required",
    "_runtime_verify",
    "_simulation_schema_registry_subject_specs",
    "_source_topic_partition_counts",
)
