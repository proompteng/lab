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


def _dump_topics(
    *,
    resources: SimulationResources,
    kafka_config: KafkaRuntimeConfig,
    manifest: Mapping[str, Any],
    dump_path: Path,
    force: bool,
    postgres_config: PostgresRuntimeConfig | None = None,
) -> dict[str, Any]:
    performance_cfg = _performance_config(manifest)
    if not force:
        reusable_report = _reusable_dump_report(dump_path)
        if reusable_report is not None:
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_REPLAY,
                status="dump_reused",
                records_dumped=_safe_int(reusable_report.get("records")),
                last_source_ts=_utc_from_millis(
                    _safe_int(reusable_report.get("max_source_timestamp_ms"), default=0)
                    or None
                ),
                payload={
                    "dump_path": str(dump_path),
                    "dump_format": reusable_report.get("dump_format"),
                    "reused_existing_dump": True,
                    "records_by_topic": reusable_report.get("records_by_topic", {}),
                },
            )
            return reusable_report
        restored_report = _restore_cached_dump_if_available(
            manifest=manifest,
            dump_path=dump_path,
        )
        if restored_report is not None:
            _upsert_simulation_progress_row(
                postgres_config=postgres_config,
                resources=resources,
                component=COMPONENT_REPLAY,
                status="dump_restored",
                records_dumped=_safe_int(restored_report.get("records")),
                last_source_ts=_utc_from_millis(
                    _safe_int(restored_report.get("max_source_timestamp_ms"), default=0)
                    or None
                ),
                payload={
                    "dump_path": str(dump_path),
                    "dump_format": restored_report.get("dump_format"),
                    "restored_from_cache": True,
                    "cache_artifact_path": restored_report.get("cache_artifact_path"),
                    "cache_manifest_path": restored_report.get("cache_manifest_path"),
                },
            )
            return restored_report

    window = _as_mapping(manifest.get("window"))
    start = _parse_rfc3339_timestamp(
        _as_text(window.get("start")), label="window.start"
    )
    end = _parse_rfc3339_timestamp(_as_text(window.get("end")), label="window.end")
    if end <= start:
        raise RuntimeError("window.end must be after window.start")

    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    from kafka import TopicPartition  # type: ignore[import-not-found]

    consumer = _consumer_for_dump(kafka_config, resources.run_token)
    count = 0
    count_by_topic: dict[str, int] = {}
    min_source_timestamp_ms: int | None = None
    max_source_timestamp_ms: int | None = None
    dump_started_at = datetime.now(timezone.utc)
    raw_dump_path = dump_path
    staged_dump_path = _dump_sort_stage_path(dump_path)
    dump_format = (
        _as_text(performance_cfg.get("dump_format")) or DEFAULT_SIMULATION_DUMP_FORMAT
    )
    if _dump_format_for_path(dump_path) != "ndjson":
        raw_dump_path = dump_path.with_suffix(dump_path.suffix + ".tmp.ndjson")
    sorted_dump_path = _dump_sort_output_path(raw_dump_path)
    try:
        topic_partitions: list[Any] = []
        for topic in resources.replay_topic_by_source_topic.keys():
            partitions = consumer.partitions_for_topic(topic)
            if not partitions:
                raise RuntimeError(
                    f"source topic has no partitions or does not exist: {topic}"
                )
            for partition in sorted(partitions):
                topic_partitions.append(TopicPartition(topic, int(partition)))

        consumer.assign(topic_partitions)
        beginning_offsets = consumer.beginning_offsets(topic_partitions)
        end_offsets = consumer.end_offsets(topic_partitions)
        start_offsets_raw = consumer.offsets_for_times(
            {tp: start_ms for tp in topic_partitions}
        )
        stop_offsets_raw = consumer.offsets_for_times(
            {tp: end_ms + 1 for tp in topic_partitions}
        )

        start_offsets: dict[Any, int] = {}
        stop_offsets: dict[Any, int] = {}
        for tp in topic_partitions:
            start_meta = start_offsets_raw.get(tp)
            stop_meta = stop_offsets_raw.get(tp)
            partition_beginning = int(beginning_offsets[tp])
            partition_end = int(end_offsets[tp])
            start_offset = _offset_for_time_lookup(
                metadata=start_meta,
                fallback=partition_end,
            )
            stop_offset = _offset_for_time_lookup(
                metadata=stop_meta,
                fallback=partition_end,
            )
            start_offsets[tp] = min(
                max(start_offset, partition_beginning), partition_end
            )
            stop_offsets[tp] = min(max(stop_offset, start_offsets[tp]), partition_end)
            consumer.seek(tp, start_offsets[tp])
        expected_records = sum(
            max(stop_offsets[tp] - start_offsets[tp], 0) for tp in topic_partitions
        )

        _ensure_directory(raw_dump_path)
        done: set[Any] = set()
        with staged_dump_path.open("w", encoding="utf-8") as handle:
            idle_polls = 0
            while len(done) < len(topic_partitions):
                if count >= expected_records:
                    done.update(topic_partitions)
                    break
                polled = consumer.poll(timeout_ms=1000, max_records=2000)
                if not polled:
                    idle_polls += 1
                    if count >= expected_records:
                        done.update(topic_partitions)
                        break
                    for tp in topic_partitions:
                        if tp in done:
                            continue
                        if consumer.position(tp) >= stop_offsets[tp]:
                            done.add(tp)
                    if idle_polls > 4 and all(
                        consumer.position(tp) >= stop_offsets[tp]
                        for tp in topic_partitions
                    ):
                        break
                    continue

                idle_polls = 0
                for tp, records in polled.items():
                    stop_offset = stop_offsets.get(tp)
                    if stop_offset is None:
                        continue
                    for record in records:
                        if int(record.offset) >= stop_offset:
                            done.add(tp)
                            break
                        source_topic = str(record.topic)
                        replay_topic = resources.replay_topic_by_source_topic[
                            source_topic
                        ]
                        line_payload = {
                            "source_topic": source_topic,
                            "source_partition": int(record.partition),
                            "source_offset": int(record.offset),
                            "source_timestamp_ms": int(record.timestamp),
                            "dataset_event_id": f"{source_topic}:{record.partition}:{record.offset}",
                            "replay_topic": replay_topic,
                            "key_b64": _bytes_to_b64(record.key),
                            "value_b64": _bytes_to_b64(record.value),
                            "headers": _headers_to_json(getattr(record, "headers", [])),
                        }
                        line = json.dumps(line_payload, sort_keys=True)
                        handle.write(
                            _dump_sort_key(
                                source_timestamp_ms=int(record.timestamp),
                                source_topic=source_topic,
                                source_partition=int(record.partition),
                                source_offset=int(record.offset),
                            )
                        )
                        handle.write("\t")
                        handle.write(line)
                        handle.write("\n")
                        count += 1
                        count_by_topic[source_topic] = (
                            count_by_topic.get(source_topic, 0) + 1
                        )
                        source_timestamp_ms = int(record.timestamp)
                        if (
                            min_source_timestamp_ms is None
                            or source_timestamp_ms < min_source_timestamp_ms
                        ):
                            min_source_timestamp_ms = source_timestamp_ms
                        if (
                            max_source_timestamp_ms is None
                            or source_timestamp_ms > max_source_timestamp_ms
                        ):
                            max_source_timestamp_ms = source_timestamp_ms
                        # kafka-python position() may lag the exclusive stop offset until a later poll.
                        # Mark the partition complete as soon as we write the final in-window record.
                        if int(record.offset) + 1 >= stop_offset:
                            done.add(tp)
                            break
                        if count >= expected_records:
                            done.update(topic_partitions)
                            break
                    if consumer.position(tp) >= stop_offset:
                        done.add(tp)
                    if count >= expected_records:
                        done.update(topic_partitions)
                        break

        payload_sha256 = _materialize_deterministic_dump(
            staged_path=staged_dump_path,
            dump_path=raw_dump_path,
        )
        if raw_dump_path != dump_path:
            _compress_dump_file(source_path=raw_dump_path, dump_path=dump_path)
        file_sha256 = _file_sha256(dump_path)
        duration_seconds = max(
            (datetime.now(timezone.utc) - dump_started_at).total_seconds(), 0.001
        )
        report = {
            "path": str(dump_path),
            "dump_format": dump_format,
            "records": count,
            "expected_records": expected_records,
            "sha256": file_sha256,
            "payload_sha256": payload_sha256,
            "records_by_topic": count_by_topic,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "reused_existing_dump": False,
            "min_source_timestamp_ms": min_source_timestamp_ms,
            "max_source_timestamp_ms": max_source_timestamp_ms,
            "duration_seconds": duration_seconds,
            "records_per_second": count / duration_seconds if count > 0 else 0.0,
            "cache_policy": _as_text(performance_cfg.get("cache_policy"))
            or "prefer_cache",
            "replay_profile": _as_text(performance_cfg.get("replay_profile"))
            or DEFAULT_SIMULATION_REPLAY_PROFILE,
        }
        cache_upload_report: dict[str, Any] | None = None
        _upsert_simulation_progress_row(
            postgres_config=postgres_config,
            resources=resources,
            component=COMPONENT_REPLAY,
            status="dumped",
            records_dumped=count,
            last_source_ts=_utc_from_millis(max_source_timestamp_ms),
            payload={
                "dump_path": str(dump_path),
                "dump_format": dump_format,
                "records_by_topic": count_by_topic,
                "payload_sha256": payload_sha256,
                "dump_sha256": file_sha256,
            },
        )
        _write_dump_marker(
            dump_path=dump_path,
            dump_sha256=file_sha256,
            records=report["records"],
            dump_format=dump_format,
            min_source_timestamp_ms=report["min_source_timestamp_ms"],
            max_source_timestamp_ms=report["max_source_timestamp_ms"],
        )
        _save_json(
            _dump_artifact_manifest_path(dump_path),
            {
                "dataset_id": resources.dataset_id,
                "run_id": resources.run_id,
                "lineage": _cache_lineage_payload(manifest),
                "dump_format": dump_format,
                "cache_policy": _as_text(performance_cfg.get("cache_policy"))
                or "prefer_cache",
                "replay_profile": _as_text(performance_cfg.get("replay_profile"))
                or DEFAULT_SIMULATION_REPLAY_PROFILE,
                "chunk_count": 1,
                "chunks": [
                    {
                        "path": str(dump_path),
                        "records": count,
                        "sha256": file_sha256,
                        "payload_sha256": payload_sha256,
                        "min_source_timestamp_ms": min_source_timestamp_ms,
                        "max_source_timestamp_ms": max_source_timestamp_ms,
                    }
                ],
            },
        )
        if _cache_metadata(manifest)["cache_decision"] != "hit":
            try:
                cache_upload_report = _upload_dump_to_cache(
                    manifest=manifest,
                    dump_path=dump_path,
                )
            except Exception as exc:
                cache_upload_report = {
                    "status": "error",
                    "cache_key": _cache_metadata(manifest).get("cache_key"),
                    "error": str(exc),
                }
                _log_script_event(
                    "Failed to upload simulation dump to durable cache",
                    cache_key=_cache_metadata(manifest).get("cache_key") or "unknown",
                    cache_artifact_path=_cache_metadata(manifest).get(
                        "cache_artifact_path"
                    )
                    or None,
                    error=str(exc),
                )
            if cache_upload_report is not None:
                report["cache_upload"] = cache_upload_report
        return report
    finally:
        if raw_dump_path != dump_path:
            raw_dump_path.unlink(missing_ok=True)
        staged_dump_path.unlink(missing_ok=True)
        sorted_dump_path.unlink(missing_ok=True)
        consumer.close()


def _pacing_delay_seconds(
    *,
    mode: str,
    previous_timestamp_ms: int | None,
    current_timestamp_ms: int | None,
    acceleration: float,
) -> float:
    if mode == "max_throughput":
        return 0.0
    if previous_timestamp_ms is None or current_timestamp_ms is None:
        return 0.0
    delta_ms = current_timestamp_ms - previous_timestamp_ms
    if delta_ms <= 0:
        return 0.0
    if mode == "event_time":
        return delta_ms / 1000.0
    if mode == "accelerated":
        return (delta_ms / 1000.0) / max(acceleration, 0.0001)
    raise RuntimeError(f"unsupported replay pace mode: {mode}")


def _dump_format_for_path(path: Path) -> str:
    path_str = str(path)
    for dump_format, suffix in sorted(
        SUPPORTED_SIMULATION_DUMP_FORMATS.items(),
        key=lambda item: len(item[1]),
        reverse=True,
    ):
        if path_str.endswith(suffix):
            return dump_format
    raise RuntimeError(f"unsupported_dump_path:{path}")


@contextmanager
def _open_dump_reader(path: Path):
    dump_format = _dump_format_for_path(path)
    if dump_format == "ndjson":
        with path.open("r", encoding="utf-8") as handle:
            yield handle
        return
    if dump_format == "jsonl.gz":
        if shutil.which("pigz"):
            process = subprocess.Popen(
                ["pigz", "-dc", str(path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
            if process.stdout is None:
                raise RuntimeError("pigz_reader_missing_stdout")
            try:
                yield process.stdout
            finally:
                process.stdout.close()
                stderr = (
                    process.stderr.read().strip() if process.stderr is not None else ""
                )
                if process.stderr is not None:
                    process.stderr.close()
                return_code = process.wait()
                if return_code != 0:
                    raise RuntimeError(
                        f"pigz_decompress_failed:{stderr or return_code}"
                    )
            return
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            yield handle
        return
    if dump_format == "jsonl.zst":
        process = subprocess.Popen(
            ["zstd", "-d", "-q", "-c", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        if process.stdout is None:
            raise RuntimeError("zstd_reader_missing_stdout")
        try:
            yield process.stdout
        finally:
            process.stdout.close()
            stderr = process.stderr.read().strip() if process.stderr is not None else ""
            if process.stderr is not None:
                process.stderr.close()
            return_code = process.wait()
            if return_code != 0:
                raise RuntimeError(f"zstd_decompress_failed:{stderr or return_code}")
        return
    raise RuntimeError(f"unsupported_dump_format:{dump_format}")


def _compress_dump_file(*, source_path: Path, dump_path: Path) -> None:
    dump_format = _dump_format_for_path(dump_path)
    _ensure_directory(dump_path)
    if dump_format == "ndjson":
        shutil.move(str(source_path), str(dump_path))
        return
    if dump_format == "jsonl.gz":
        if shutil.which("pigz"):
            with dump_path.open("wb") as output:
                result = subprocess.run(
                    ["pigz", "-c", "-6", str(source_path)],
                    check=False,
                    stdout=output,
                    stderr=subprocess.PIPE,
                )
            if result.returncode != 0:
                detail = (
                    (result.stderr or b"").decode("utf-8", errors="replace").strip()
                )
                raise RuntimeError(
                    f"pigz_compress_failed:{detail or result.returncode}"
                )
        else:
            with (
                source_path.open("rb") as source,
                gzip.open(dump_path, "wb", compresslevel=6) as output,
            ):
                shutil.copyfileobj(source, output)
        source_path.unlink(missing_ok=True)
        return
    if dump_format == "jsonl.zst":
        with dump_path.open("wb") as output:
            result = subprocess.run(
                ["zstd", "-q", "-T0", "-3", "-c", str(source_path)],
                check=False,
                stdout=output,
                stderr=subprocess.PIPE,
            )
        if result.returncode != 0:
            detail = (result.stderr or b"").decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"zstd_compress_failed:{detail or result.returncode}")
        source_path.unlink(missing_ok=True)
        return
    raise RuntimeError(f"unsupported_dump_format:{dump_format}")


def _count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    with _open_dump_reader(path) as handle:
        return sum(1 for _ in handle)


def _dump_sha256_for_replay(path: Path) -> str:
    hasher = hashlib.sha256()
    with _open_dump_reader(path) as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            hasher.update(stripped.encode("utf-8"))
            hasher.update(b"\n")
    return hasher.hexdigest()


def _producer_flush_with_retry(
    producer: Any,
    *,
    timeout_seconds: float,
    attempts: int,
) -> None:
    for attempt in range(1, attempts + 1):
        try:
            producer.flush(timeout=timeout_seconds)
            return
        except Exception as exc:
            message = str(exc)
            timed_out = (
                "KafkaTimeoutError" in message
                or "Timeout waiting for future" in message
            )
            if not timed_out or attempt >= attempts:
                raise
            time.sleep(min(2.0, 0.25 * attempt))


__all__ = [name for name in globals() if not name.startswith("__")]
