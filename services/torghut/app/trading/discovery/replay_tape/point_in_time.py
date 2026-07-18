"""Immutable causal lineage for replay-tape datasets and feature matrices."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, cast

from app.trading.models import SignalEnvelope


POINT_IN_TIME_RECEIPT_SCHEMA_VERSION = "torghut.point-in-time-data-receipt.v1"
POINT_IN_TIME_RECEIPT_SPEC_SCHEMA_VERSION = "torghut.point-in-time-receipt-spec.v1"
POINT_IN_TIME_AVAILABILITY_POLICY = "max_signal_and_microbar_ingest_time_v1"

_SOURCE_INGEST_KEY = "_source_ingest_ts"
_SOURCE_VERSION_KEY = "_source_versions"
_WINDOW_SIZE_KEY = "window_size"
_REQUIRED_SOURCES = ("ta_microbars", "ta_signals")
_SHA256_RE = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
_CODE_DIGEST_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64})$")


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("point_in_time_timestamp_timezone_missing")
    return value.astimezone(timezone.utc)


def _datetime_from_payload(value: object, *, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise ValueError(f"point_in_time_datetime_invalid:{field}") from exc
    return _aware_utc(parsed)


def _json_ready(value: Any) -> Any:
    if isinstance(value, datetime):
        return {"__datetime__": _aware_utc(value).isoformat()}
    if isinstance(value, Decimal):
        return {"__decimal__": str(value)}
    if isinstance(value, Mapping):
        return {
            str(key): _json_ready(item)
            for key, item in cast(Mapping[object, object], value).items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_ready(item) for item in cast(Sequence[object], value)]
    return value


def _canonical_json(payload: Mapping[str, Any]) -> str:
    return json.dumps(
        _json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def _sha256_payload(payload: Mapping[str, Any]) -> str:
    encoded = _canonical_json(payload).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _hash_records(records: Iterable[Mapping[str, Any]]) -> str:
    digest = hashlib.sha256()
    for record in records:
        digest.update(_canonical_json(record).encode("utf-8"))
        digest.update(b"\n")
    return f"sha256:{digest.hexdigest()}"


def _normalized_symbols(symbols: Iterable[str]) -> tuple[str, ...]:
    return tuple(
        sorted(
            {str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()}
        )
    )


def _source_ingest_times(row: SignalEnvelope) -> dict[str, datetime]:
    raw = row.payload.get(_SOURCE_INGEST_KEY)
    if not isinstance(raw, Mapping):
        return {}
    parsed: dict[str, datetime] = {}
    for source, value in cast(Mapping[object, object], raw).items():
        if isinstance(value, datetime):
            parsed[str(source)] = _aware_utc(value)
            continue
        try:
            parsed[str(source)] = _datetime_from_payload(
                value,
                field=f"source_ingest.{source}",
            )
        except ValueError:
            continue
    return parsed


def _source_versions(row: SignalEnvelope) -> dict[str, int]:
    raw = row.payload.get(_SOURCE_VERSION_KEY)
    if not isinstance(raw, Mapping):
        return {}
    parsed: dict[str, int] = {}
    for source, value in cast(Mapping[object, object], raw).items():
        if isinstance(value, bool):
            continue
        try:
            revision = int(str(value))
        except (TypeError, ValueError):
            continue
        if revision < 0 or revision > 2**32 - 1:
            continue
        parsed[str(source)] = revision
    return parsed


def _input_row_identity(row: SignalEnvelope) -> dict[str, Any]:
    return {
        "symbol": row.symbol.upper(),
        "event_ts": _aware_utc(row.event_ts),
        "available_ts": _aware_utc(row.ingest_ts)
        if row.ingest_ts is not None
        else None,
        "seq": row.seq,
        "source": row.source,
        "window_size": str(row.payload.get(_WINDOW_SIZE_KEY) or ""),
        "source_ingest_ts": _source_ingest_times(row),
        "source_versions": _source_versions(row),
    }


def input_row_set_sha256(rows: Iterable[SignalEnvelope]) -> str:
    return _hash_records(_input_row_identity(row) for row in rows)


def _feature_matrix_row(row: SignalEnvelope) -> dict[str, Any]:
    source_features = dict(row.payload)
    # This field is deterministically injected while loading a tape from the
    # separately serialized hpairs feature block. It is derived output, not a
    # second causal input authority.
    source_features.pop("hpairs_replay_tape_features", None)
    # Arrival times and row revisions are already canonicalized in the input
    # identity above. Do not represent the same causal inputs twice.
    source_features.pop(_SOURCE_INGEST_KEY, None)
    source_features.pop(_SOURCE_VERSION_KEY, None)
    source_features.pop(_WINDOW_SIZE_KEY, None)
    return {
        **_input_row_identity(row),
        "timeframe": row.timeframe,
        "features": source_features,
    }


def feature_matrix_sha256(rows: Iterable[SignalEnvelope]) -> str:
    return _hash_records(_feature_matrix_row(row) for row in rows)


@dataclass(frozen=True)
class SourceWatermark:
    source: str
    row_count: int
    min_event_ts: datetime
    max_event_ts: datetime
    min_arrival_ts: datetime
    max_arrival_ts: datetime

    def to_payload(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "row_count": self.row_count,
            "min_event_ts": _aware_utc(self.min_event_ts).isoformat(),
            "max_event_ts": _aware_utc(self.max_event_ts).isoformat(),
            "min_arrival_ts": _aware_utc(self.min_arrival_ts).isoformat(),
            "max_arrival_ts": _aware_utc(self.max_arrival_ts).isoformat(),
        }

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "SourceWatermark":
        return cls(
            source=str(payload.get("source") or ""),
            row_count=int(payload.get("row_count") or 0),
            min_event_ts=_datetime_from_payload(
                payload.get("min_event_ts"), field="min_event_ts"
            ),
            max_event_ts=_datetime_from_payload(
                payload.get("max_event_ts"), field="max_event_ts"
            ),
            min_arrival_ts=_datetime_from_payload(
                payload.get("min_arrival_ts"),
                field="min_arrival_ts",
            ),
            max_arrival_ts=_datetime_from_payload(
                payload.get("max_arrival_ts"),
                field="max_arrival_ts",
            ),
        )


def build_source_watermarks(
    rows: Sequence[SignalEnvelope],
) -> dict[str, SourceWatermark]:
    events: dict[str, list[datetime]] = {}
    arrivals: dict[str, list[datetime]] = {}
    for row in rows:
        event_ts = _aware_utc(row.event_ts)
        for source, arrival_ts in _source_ingest_times(row).items():
            events.setdefault(source, []).append(event_ts)
            arrivals.setdefault(source, []).append(arrival_ts)
    return {
        source: SourceWatermark(
            source=source,
            row_count=len(source_events),
            min_event_ts=min(source_events),
            max_event_ts=max(source_events),
            min_arrival_ts=min(arrivals[source]),
            max_arrival_ts=max(arrivals[source]),
        )
        for source, source_events in sorted(events.items())
        if arrivals.get(source)
    }


@dataclass(frozen=True)
class PointInTimeReceiptSpec:
    observation_cutoff: datetime
    feed_identity: str
    session_calendar_version: str
    session_calendar_sha256: str
    universe_version: str
    universe_sha256: str
    universe_symbols: tuple[str, ...]
    corporate_actions_version: str
    corporate_actions_sha256: str
    adjustment_policy: str
    adjustment_policy_sha256: str
    code_digest: str
    economic_policy_digest: str
    feature_pipeline_sha256: str
    timezone_name: str = "America/New_York"
    availability_policy: str = POINT_IN_TIME_AVAILABILITY_POLICY

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": POINT_IN_TIME_RECEIPT_SPEC_SCHEMA_VERSION,
            "observation_cutoff": _aware_utc(self.observation_cutoff).isoformat(),
            "feed_identity": self.feed_identity,
            "timezone": self.timezone_name,
            "session_calendar_version": self.session_calendar_version,
            "session_calendar_sha256": self.session_calendar_sha256,
            "universe_version": self.universe_version,
            "universe_sha256": self.universe_sha256,
            "universe_symbols": list(_normalized_symbols(self.universe_symbols)),
            "corporate_actions_version": self.corporate_actions_version,
            "corporate_actions_sha256": self.corporate_actions_sha256,
            "adjustment_policy": self.adjustment_policy,
            "adjustment_policy_sha256": self.adjustment_policy_sha256,
            "code_digest": self.code_digest,
            "economic_policy_digest": self.economic_policy_digest,
            "feature_pipeline_sha256": self.feature_pipeline_sha256,
            "availability_policy": self.availability_policy,
        }

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "PointInTimeReceiptSpec":
        schema_version = str(payload.get("schema_version") or "")
        if schema_version != POINT_IN_TIME_RECEIPT_SPEC_SCHEMA_VERSION:
            raise ValueError(
                f"point_in_time_receipt_spec_schema_invalid:{schema_version}"
            )
        return cls(
            observation_cutoff=_datetime_from_payload(
                payload.get("observation_cutoff"),
                field="observation_cutoff",
            ),
            feed_identity=str(payload.get("feed_identity") or ""),
            timezone_name=str(payload.get("timezone") or ""),
            session_calendar_version=str(payload.get("session_calendar_version") or ""),
            session_calendar_sha256=str(payload.get("session_calendar_sha256") or ""),
            universe_version=str(payload.get("universe_version") or ""),
            universe_sha256=str(payload.get("universe_sha256") or ""),
            universe_symbols=_normalized_symbols(
                cast(Iterable[str], payload.get("universe_symbols") or ())
            ),
            corporate_actions_version=str(
                payload.get("corporate_actions_version") or ""
            ),
            corporate_actions_sha256=str(payload.get("corporate_actions_sha256") or ""),
            adjustment_policy=str(payload.get("adjustment_policy") or ""),
            adjustment_policy_sha256=str(payload.get("adjustment_policy_sha256") or ""),
            code_digest=str(payload.get("code_digest") or ""),
            economic_policy_digest=str(payload.get("economic_policy_digest") or ""),
            feature_pipeline_sha256=str(payload.get("feature_pipeline_sha256") or ""),
            availability_policy=str(
                payload.get("availability_policy") or POINT_IN_TIME_AVAILABILITY_POLICY
            ),
        )


@dataclass(frozen=True)
class PointInTimeDataReceipt:
    schema_version: str
    observation_cutoff: datetime
    min_event_ts: datetime
    max_event_ts: datetime
    min_arrival_ts: datetime
    max_arrival_ts: datetime
    availability_policy: str
    feed_identity: str
    timezone_name: str
    session_calendar_version: str
    session_calendar_sha256: str
    universe_version: str
    universe_sha256: str
    universe_symbols: tuple[str, ...]
    corporate_actions_version: str
    corporate_actions_sha256: str
    adjustment_policy: str
    adjustment_policy_sha256: str
    code_digest: str
    economic_policy_digest: str
    feature_schema_hash: str
    feature_pipeline_sha256: str
    source_table_versions: Mapping[str, str]
    source_watermarks: Mapping[str, SourceWatermark]
    input_row_set_sha256: str
    feature_matrix_sha256: str
    replay_tape_sha256: str
    receipt_sha256: str

    def to_payload(self, *, include_receipt_sha256: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema_version": self.schema_version,
            "observation_cutoff": _aware_utc(self.observation_cutoff).isoformat(),
            "event_time_boundary": {
                "min": _aware_utc(self.min_event_ts).isoformat(),
                "max": _aware_utc(self.max_event_ts).isoformat(),
            },
            "arrival_time_boundary": {
                "min": _aware_utc(self.min_arrival_ts).isoformat(),
                "max": _aware_utc(self.max_arrival_ts).isoformat(),
            },
            "availability_policy": self.availability_policy,
            "feed_identity": self.feed_identity,
            "timezone": self.timezone_name,
            "session_calendar_version": self.session_calendar_version,
            "session_calendar_sha256": self.session_calendar_sha256,
            "universe_version": self.universe_version,
            "universe_sha256": self.universe_sha256,
            "universe_symbols": list(self.universe_symbols),
            "corporate_actions_version": self.corporate_actions_version,
            "corporate_actions_sha256": self.corporate_actions_sha256,
            "adjustment_policy": self.adjustment_policy,
            "adjustment_policy_sha256": self.adjustment_policy_sha256,
            "code_digest": self.code_digest,
            "economic_policy_digest": self.economic_policy_digest,
            "feature_schema_hash": self.feature_schema_hash,
            "feature_pipeline_sha256": self.feature_pipeline_sha256,
            "source_table_versions": dict(self.source_table_versions),
            "source_watermarks": {
                source: watermark.to_payload()
                for source, watermark in sorted(self.source_watermarks.items())
            },
            "input_row_set_sha256": self.input_row_set_sha256,
            "feature_matrix_sha256": self.feature_matrix_sha256,
            "replay_tape_sha256": self.replay_tape_sha256,
        }
        if include_receipt_sha256:
            payload["receipt_sha256"] = self.receipt_sha256
        return payload

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "PointInTimeDataReceipt":
        event_boundary = cast(
            Mapping[str, Any], payload.get("event_time_boundary") or {}
        )
        arrival_boundary = cast(
            Mapping[str, Any], payload.get("arrival_time_boundary") or {}
        )
        raw_watermarks_value: object = payload.get("source_watermarks")
        raw_watermarks: Mapping[object, object]
        if isinstance(raw_watermarks_value, Mapping):
            raw_watermarks = cast(Mapping[object, object], raw_watermarks_value)
        else:
            raw_watermarks = {}
        watermarks = {
            str(source): SourceWatermark.from_payload(
                cast(Mapping[str, Any], watermark)
            )
            for source, watermark in raw_watermarks.items()
            if isinstance(watermark, Mapping)
        }
        return cls(
            schema_version=str(payload.get("schema_version") or ""),
            observation_cutoff=_datetime_from_payload(
                payload.get("observation_cutoff"),
                field="observation_cutoff",
            ),
            min_event_ts=_datetime_from_payload(
                event_boundary.get("min"), field="event_time_min"
            ),
            max_event_ts=_datetime_from_payload(
                event_boundary.get("max"), field="event_time_max"
            ),
            min_arrival_ts=_datetime_from_payload(
                arrival_boundary.get("min"),
                field="arrival_time_min",
            ),
            max_arrival_ts=_datetime_from_payload(
                arrival_boundary.get("max"),
                field="arrival_time_max",
            ),
            availability_policy=str(payload.get("availability_policy") or ""),
            feed_identity=str(payload.get("feed_identity") or ""),
            timezone_name=str(payload.get("timezone") or ""),
            session_calendar_version=str(payload.get("session_calendar_version") or ""),
            session_calendar_sha256=str(payload.get("session_calendar_sha256") or ""),
            universe_version=str(payload.get("universe_version") or ""),
            universe_sha256=str(payload.get("universe_sha256") or ""),
            universe_symbols=_normalized_symbols(
                cast(Iterable[str], payload.get("universe_symbols") or ())
            ),
            corporate_actions_version=str(
                payload.get("corporate_actions_version") or ""
            ),
            corporate_actions_sha256=str(payload.get("corporate_actions_sha256") or ""),
            adjustment_policy=str(payload.get("adjustment_policy") or ""),
            adjustment_policy_sha256=str(payload.get("adjustment_policy_sha256") or ""),
            code_digest=str(payload.get("code_digest") or ""),
            economic_policy_digest=str(payload.get("economic_policy_digest") or ""),
            feature_schema_hash=str(payload.get("feature_schema_hash") or ""),
            feature_pipeline_sha256=str(payload.get("feature_pipeline_sha256") or ""),
            source_table_versions={
                str(key): str(value)
                for key, value in cast(
                    Mapping[object, object],
                    payload.get("source_table_versions") or {},
                ).items()
            },
            source_watermarks=watermarks,
            input_row_set_sha256=str(payload.get("input_row_set_sha256") or ""),
            feature_matrix_sha256=str(payload.get("feature_matrix_sha256") or ""),
            replay_tape_sha256=str(payload.get("replay_tape_sha256") or ""),
            receipt_sha256=str(payload.get("receipt_sha256") or ""),
        )


def _metadata_reason_codes(receipt: PointInTimeDataReceipt) -> list[str]:
    reasons: list[str] = []
    required_text = {
        "feed_identity": receipt.feed_identity,
        "session_calendar_version": receipt.session_calendar_version,
        "universe_version": receipt.universe_version,
        "corporate_actions_version": receipt.corporate_actions_version,
        "adjustment_policy": receipt.adjustment_policy,
    }
    for field, value in required_text.items():
        if not str(value).strip():
            reasons.append(f"point_in_time_{field}_missing")
    required_sha256 = {
        "session_calendar_sha256": receipt.session_calendar_sha256,
        "universe_sha256": receipt.universe_sha256,
        "corporate_actions_sha256": receipt.corporate_actions_sha256,
        "adjustment_policy_sha256": receipt.adjustment_policy_sha256,
        "economic_policy_digest": receipt.economic_policy_digest,
        "feature_schema_hash": receipt.feature_schema_hash,
        "feature_pipeline_sha256": receipt.feature_pipeline_sha256,
        "input_row_set_sha256": receipt.input_row_set_sha256,
        "feature_matrix_sha256": receipt.feature_matrix_sha256,
        "replay_tape_sha256": receipt.replay_tape_sha256,
    }
    for field, value in required_sha256.items():
        if _SHA256_RE.fullmatch(str(value).strip().lower()) is None:
            reasons.append(f"point_in_time_{field}_invalid")
    if _CODE_DIGEST_RE.fullmatch(receipt.code_digest.strip().lower()) is None:
        reasons.append("point_in_time_code_digest_invalid")
    if receipt.availability_policy != POINT_IN_TIME_AVAILABILITY_POLICY:
        reasons.append("point_in_time_availability_policy_invalid")
    if receipt.timezone_name != "America/New_York":
        reasons.append("point_in_time_timezone_invalid")
    table_versions = {
        str(name).split(".")[-1]: str(version).strip()
        for name, version in receipt.source_table_versions.items()
    }
    for source in _REQUIRED_SOURCES:
        if not table_versions.get(source):
            reasons.append(f"point_in_time_source_table_version_missing:{source}")
        if source not in receipt.source_watermarks:
            reasons.append(f"point_in_time_source_watermark_missing:{source}")
    return reasons


def _row_reason_codes(
    rows: Sequence[SignalEnvelope],
    *,
    observation_cutoff: datetime,
    universe_symbols: Sequence[str],
) -> list[str]:
    reasons: set[str] = set()
    cutoff = _aware_utc(observation_cutoff)
    universe = set(_normalized_symbols(universe_symbols))
    identities: set[tuple[str, datetime, int | None, str | None, str]] = set()
    if not rows:
        reasons.add("point_in_time_rows_empty")
    for row in rows:
        try:
            event_ts = _aware_utc(row.event_ts)
        except ValueError:
            reasons.add("point_in_time_event_timezone_missing")
            continue
        if row.ingest_ts is None:
            reasons.add("point_in_time_arrival_missing")
            continue
        try:
            available_ts = _aware_utc(row.ingest_ts)
        except ValueError:
            reasons.add("point_in_time_arrival_timezone_missing")
            continue
        if event_ts > available_ts:
            reasons.add("point_in_time_negative_feature_age")
        if available_ts > cutoff:
            reasons.add("point_in_time_arrival_after_observation_cutoff")
        window_size = str(row.payload.get(_WINDOW_SIZE_KEY) or "")
        identity = (row.symbol.upper(), event_ts, row.seq, row.source, window_size)
        if identity in identities:
            reasons.add("point_in_time_duplicate_input_identity")
        identities.add(identity)
        if row.seq is None or row.seq < 0:
            reasons.add("point_in_time_sequence_invalid")
        if row.source != "ta":
            reasons.add("point_in_time_source_invalid")
        if row.timeframe != "1Sec" or window_size != "PT1S":
            reasons.add("point_in_time_window_invalid")
        if row.symbol.upper() not in universe:
            reasons.add(f"point_in_time_symbol_outside_universe:{row.symbol.upper()}")
        source_times = _source_ingest_times(row)
        source_versions = _source_versions(row)
        for source in _REQUIRED_SOURCES:
            if source not in source_times:
                reasons.add(f"point_in_time_row_source_arrival_missing:{source}")
            if source not in source_versions:
                reasons.add(f"point_in_time_row_source_revision_missing:{source}")
        required_sources = set(_REQUIRED_SOURCES)
        if set(source_times) - required_sources:
            reasons.add("point_in_time_source_arrival_set_invalid")
        if set(source_versions) - required_sources:
            reasons.add("point_in_time_source_revision_set_invalid")
        if source_times:
            if max(source_times.values()) != available_ts:
                reasons.add("point_in_time_available_timestamp_mismatch")
            if any(source_ts < event_ts for source_ts in source_times.values()):
                reasons.add("point_in_time_source_arrival_before_event")
            if any(source_ts > cutoff for source_ts in source_times.values()):
                reasons.add("point_in_time_source_arrival_after_observation_cutoff")
    return sorted(reasons)


def _receipt_sha256(receipt: PointInTimeDataReceipt) -> str:
    return _sha256_payload(receipt.to_payload(include_receipt_sha256=False))


def build_point_in_time_data_receipt(
    *,
    rows: Sequence[SignalEnvelope],
    content_sha256: str,
    feature_schema_hash: str,
    source_table_versions: Mapping[str, str],
    spec: PointInTimeReceiptSpec,
    require_complete: bool = True,
) -> PointInTimeDataReceipt:
    if not rows:
        raise ValueError("point_in_time_rows_empty")
    ordered_rows = tuple(rows)
    preflight_reasons = _row_reason_codes(
        ordered_rows,
        observation_cutoff=spec.observation_cutoff,
        universe_symbols=spec.universe_symbols,
    )
    if require_complete and preflight_reasons:
        raise ValueError(
            "point_in_time_receipt_incomplete:" + ",".join(preflight_reasons)
        )
    event_times = tuple(_aware_utc(row.event_ts) for row in ordered_rows)
    arrival_times = tuple(
        _aware_utc(row.ingest_ts) for row in ordered_rows if row.ingest_ts is not None
    )
    if not arrival_times:
        raise ValueError("point_in_time_arrival_missing")
    receipt = PointInTimeDataReceipt(
        schema_version=POINT_IN_TIME_RECEIPT_SCHEMA_VERSION,
        observation_cutoff=_aware_utc(spec.observation_cutoff),
        min_event_ts=min(event_times),
        max_event_ts=max(event_times),
        min_arrival_ts=min(arrival_times),
        max_arrival_ts=max(arrival_times),
        availability_policy=spec.availability_policy,
        feed_identity=spec.feed_identity.strip(),
        timezone_name=spec.timezone_name.strip(),
        session_calendar_version=spec.session_calendar_version.strip(),
        session_calendar_sha256=spec.session_calendar_sha256.strip().lower(),
        universe_version=spec.universe_version.strip(),
        universe_sha256=spec.universe_sha256.strip().lower(),
        universe_symbols=_normalized_symbols(spec.universe_symbols),
        corporate_actions_version=spec.corporate_actions_version.strip(),
        corporate_actions_sha256=spec.corporate_actions_sha256.strip().lower(),
        adjustment_policy=spec.adjustment_policy.strip(),
        adjustment_policy_sha256=spec.adjustment_policy_sha256.strip().lower(),
        code_digest=spec.code_digest.strip().lower(),
        economic_policy_digest=spec.economic_policy_digest.strip().lower(),
        feature_schema_hash=feature_schema_hash.strip().lower(),
        feature_pipeline_sha256=spec.feature_pipeline_sha256.strip().lower(),
        source_table_versions=dict(source_table_versions),
        source_watermarks=build_source_watermarks(ordered_rows),
        input_row_set_sha256=input_row_set_sha256(ordered_rows),
        feature_matrix_sha256=feature_matrix_sha256(ordered_rows),
        replay_tape_sha256=f"sha256:{content_sha256.removeprefix('sha256:')}",
        receipt_sha256="",
    )
    receipt = replace(receipt, receipt_sha256=_receipt_sha256(receipt))
    diagnostics = verify_point_in_time_data_receipt(
        receipt,
        rows=ordered_rows,
        content_sha256=content_sha256,
        feature_schema_hash=feature_schema_hash,
        source_table_versions=source_table_versions,
    )
    if require_complete and diagnostics["status"] != "complete":
        reasons = ",".join(cast(Sequence[str], diagnostics["reason_codes"]))
        raise ValueError(f"point_in_time_receipt_incomplete:{reasons}")
    return receipt


def verify_point_in_time_data_receipt(
    receipt: PointInTimeDataReceipt,
    *,
    rows: Sequence[SignalEnvelope],
    content_sha256: str,
    feature_schema_hash: str,
    source_table_versions: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    reasons = _metadata_reason_codes(receipt)
    reasons.extend(
        _row_reason_codes(
            rows,
            observation_cutoff=receipt.observation_cutoff,
            universe_symbols=receipt.universe_symbols,
        )
    )
    expected_content_hash = f"sha256:{content_sha256.removeprefix('sha256:')}"
    if receipt.schema_version != POINT_IN_TIME_RECEIPT_SCHEMA_VERSION:
        reasons.append("point_in_time_receipt_schema_invalid")
    if receipt.replay_tape_sha256 != expected_content_hash:
        reasons.append("point_in_time_replay_tape_hash_mismatch")
    if receipt.feature_schema_hash != feature_schema_hash.strip().lower():
        reasons.append("point_in_time_feature_schema_hash_mismatch")
    if source_table_versions is not None and dict(
        receipt.source_table_versions
    ) != dict(source_table_versions):
        reasons.append("point_in_time_source_table_versions_mismatch")
    event_times = tuple(_aware_utc(row.event_ts) for row in rows)
    arrival_times = tuple(
        _aware_utc(row.ingest_ts) for row in rows if row.ingest_ts is not None
    )
    if event_times and (
        receipt.min_event_ts != min(event_times)
        or receipt.max_event_ts != max(event_times)
    ):
        reasons.append("point_in_time_event_boundary_mismatch")
    if arrival_times and (
        receipt.min_arrival_ts != min(arrival_times)
        or receipt.max_arrival_ts != max(arrival_times)
    ):
        reasons.append("point_in_time_arrival_boundary_mismatch")
    computed_input_hash = input_row_set_sha256(rows)
    computed_feature_hash = feature_matrix_sha256(rows)
    if receipt.input_row_set_sha256 != computed_input_hash:
        reasons.append("point_in_time_input_row_set_hash_mismatch")
    if receipt.feature_matrix_sha256 != computed_feature_hash:
        reasons.append("point_in_time_feature_matrix_hash_mismatch")
    computed_watermarks = build_source_watermarks(rows)
    if {
        source: watermark.to_payload()
        for source, watermark in receipt.source_watermarks.items()
    } != {
        source: watermark.to_payload()
        for source, watermark in computed_watermarks.items()
    }:
        reasons.append("point_in_time_source_watermarks_mismatch")
    computed_receipt_hash = _receipt_sha256(replace(receipt, receipt_sha256=""))
    if receipt.receipt_sha256 != computed_receipt_hash:
        reasons.append("point_in_time_receipt_hash_mismatch")
    unique_reasons = sorted(set(reasons))
    return {
        "schema_version": "torghut.point-in-time-data-receipt-verification.v1",
        "status": "complete" if not unique_reasons else "incomplete",
        "reason_codes": unique_reasons,
        "receipt_sha256": receipt.receipt_sha256,
        "input_row_set_sha256": computed_input_hash,
        "feature_matrix_sha256": computed_feature_hash,
        "row_count": len(rows),
    }


__all__ = [
    "POINT_IN_TIME_AVAILABILITY_POLICY",
    "POINT_IN_TIME_RECEIPT_SCHEMA_VERSION",
    "POINT_IN_TIME_RECEIPT_SPEC_SCHEMA_VERSION",
    "PointInTimeDataReceipt",
    "PointInTimeReceiptSpec",
    "SourceWatermark",
    "build_point_in_time_data_receipt",
    "build_source_watermarks",
    "feature_matrix_sha256",
    "input_row_set_sha256",
    "verify_point_in_time_data_receipt",
]
