"""Manifest-verified replay tape artifacts for Torghut research replays."""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, TextIO, cast

from app.trading.models import SignalEnvelope
from app.trading.session_context import (
    regular_session_close_utc_for,
    regular_session_open_utc_for,
)

REPLAY_TAPE_SCHEMA_VERSION = "torghut.replay-tape.v1"
REPLAY_TAPE_MANIFEST_SCHEMA_VERSION = "torghut.replay-tape-manifest.v1"
_DECIMAL_TAG = "__torghut_decimal__"
_DATETIME_TAG = "__torghut_datetime__"


def _empty_row_count_by_trading_day() -> dict[str, int]:
    return {}


def _empty_row_count_by_symbol_trading_day() -> dict[str, dict[str, int]]:
    return {}


class ReplayTapeCoverageError(ValueError):
    def __init__(self, reason: str, *, diagnostics: Mapping[str, Any]) -> None:
        super().__init__(reason)
        self.reason = reason
        self.diagnostics = dict(diagnostics)


@dataclass(frozen=True)
class ReplayTapeManifest:
    schema_version: str
    dataset_snapshot_ref: str
    symbols: tuple[str, ...]
    row_symbols: tuple[str, ...]
    start_date: date
    end_date: date
    start_ts: datetime
    end_ts: datetime
    min_event_ts: datetime | None
    max_event_ts: datetime | None
    trading_day_count: int
    row_count: int
    source_query_digest: str
    content_sha256: str
    artifact_refs: Mapping[str, str]
    source_table_versions: Mapping[str, str]
    created_at: datetime
    requested_trading_days: tuple[date, ...] = ()
    observed_trading_days: tuple[date, ...] = ()
    missing_trading_days: tuple[date, ...] = ()
    row_count_by_trading_day: Mapping[str, int] = field(
        default_factory=_empty_row_count_by_trading_day
    )
    missing_symbol_trading_days: tuple[str, ...] = ()
    row_count_by_symbol_trading_day: Mapping[str, Mapping[str, int]] = field(
        default_factory=_empty_row_count_by_symbol_trading_day
    )

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "dataset_snapshot_ref": self.dataset_snapshot_ref,
            "symbols": list(self.symbols),
            "row_symbols": list(self.row_symbols),
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "start_ts": self.start_ts.isoformat(),
            "end_ts": self.end_ts.isoformat(),
            "min_event_ts": self.min_event_ts.isoformat()
            if self.min_event_ts is not None
            else None,
            "max_event_ts": self.max_event_ts.isoformat()
            if self.max_event_ts is not None
            else None,
            "trading_day_count": self.trading_day_count,
            "row_count": self.row_count,
            "source_query_digest": self.source_query_digest,
            "content_sha256": self.content_sha256,
            "artifact_refs": dict(self.artifact_refs),
            "source_table_versions": dict(self.source_table_versions),
            "created_at": self.created_at.isoformat(),
            "requested_trading_days": [
                item.isoformat() for item in self.requested_trading_days
            ],
            "observed_trading_days": [
                item.isoformat() for item in self.observed_trading_days
            ],
            "missing_trading_days": [
                item.isoformat() for item in self.missing_trading_days
            ],
            "row_count_by_trading_day": dict(self.row_count_by_trading_day),
            "missing_symbol_trading_days": list(self.missing_symbol_trading_days),
            "row_count_by_symbol_trading_day": {
                symbol: dict(days)
                for symbol, days in self.row_count_by_symbol_trading_day.items()
            },
            "coverage_status": _coverage_status(
                missing_trading_days=self.missing_trading_days,
                missing_symbol_trading_days=self.missing_symbol_trading_days,
            ),
        }

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ReplayTapeManifest":
        schema_version = str(payload.get("schema_version") or "")
        if schema_version != REPLAY_TAPE_MANIFEST_SCHEMA_VERSION:
            raise ValueError(f"replay_tape_manifest_schema_invalid:{schema_version}")
        return cls(
            schema_version=schema_version,
            dataset_snapshot_ref=str(payload.get("dataset_snapshot_ref") or ""),
            symbols=_string_tuple(payload.get("symbols")),
            row_symbols=_string_tuple(payload.get("row_symbols")),
            start_date=date.fromisoformat(str(payload["start_date"])),
            end_date=date.fromisoformat(str(payload["end_date"])),
            start_ts=_parse_datetime(str(payload["start_ts"])),
            end_ts=_parse_datetime(str(payload["end_ts"])),
            min_event_ts=(
                _parse_datetime(str(payload["min_event_ts"]))
                if payload.get("min_event_ts")
                else None
            ),
            max_event_ts=(
                _parse_datetime(str(payload["max_event_ts"]))
                if payload.get("max_event_ts")
                else None
            ),
            trading_day_count=int(payload.get("trading_day_count") or 0),
            row_count=int(payload.get("row_count") or 0),
            source_query_digest=str(payload.get("source_query_digest") or ""),
            content_sha256=str(payload.get("content_sha256") or ""),
            artifact_refs=_string_mapping(payload.get("artifact_refs")),
            source_table_versions=_string_mapping(payload.get("source_table_versions")),
            created_at=_parse_datetime(str(payload["created_at"])),
            requested_trading_days=_date_tuple(payload.get("requested_trading_days")),
            observed_trading_days=_date_tuple(payload.get("observed_trading_days")),
            missing_trading_days=_date_tuple(payload.get("missing_trading_days")),
            row_count_by_trading_day=_int_mapping(
                payload.get("row_count_by_trading_day")
            ),
            missing_symbol_trading_days=_string_tuple(
                payload.get("missing_symbol_trading_days")
            ),
            row_count_by_symbol_trading_day=_nested_int_mapping(
                payload.get("row_count_by_symbol_trading_day")
            ),
        )


@dataclass(frozen=True)
class ReplayTape:
    manifest: ReplayTapeManifest
    rows: tuple[SignalEnvelope, ...]


def default_manifest_path(tape_path: Path) -> Path:
    return tape_path.with_name(f"{tape_path.name}.manifest.json")


def build_source_query_digest(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(
        _json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def materialize_signal_tape(
    *,
    rows: Iterable[SignalEnvelope],
    tape_path: Path,
    manifest_path: Path | None = None,
    dataset_snapshot_ref: str,
    symbols: Sequence[str] = (),
    start_date: date,
    end_date: date,
    source_query_digest: str,
    source_table_versions: Mapping[str, str] | None = None,
    artifact_refs: Mapping[str, str] | None = None,
    created_at: datetime | None = None,
    require_complete_coverage: bool = False,
) -> ReplayTapeManifest:
    ordered_rows = tuple(sorted(rows, key=_signal_sort_key))
    normalized_symbols = _normalize_symbols(symbols)
    event_dates = {row.event_ts.astimezone(timezone.utc).date() for row in ordered_rows}
    event_times = tuple(row.event_ts.astimezone(timezone.utc) for row in ordered_rows)
    requested_trading_days = _business_days(start_date, end_date)
    observed_trading_days = tuple(sorted(event_dates))
    missing_trading_days = tuple(
        day for day in requested_trading_days if day not in event_dates
    )
    row_count_by_symbol_trading_day = _row_count_by_symbol_trading_day(ordered_rows)
    missing_symbol_trading_days = _missing_symbol_trading_days(
        row_count_by_symbol_trading_day=row_count_by_symbol_trading_day,
        requested_symbols=normalized_symbols,
        requested_trading_days=requested_trading_days,
        observed_trading_days=observed_trading_days,
    )
    row_count_by_trading_day: dict[str, int] = {}
    for row in ordered_rows:
        key = row.event_ts.astimezone(timezone.utc).date().isoformat()
        row_count_by_trading_day[key] = row_count_by_trading_day.get(key, 0) + 1
    if require_complete_coverage and (
        missing_trading_days or missing_symbol_trading_days
    ):
        reason = _incomplete_coverage_reason(
            missing_trading_days=missing_trading_days,
            missing_symbol_trading_days=missing_symbol_trading_days,
        )
        raise ReplayTapeCoverageError(
            reason,
            diagnostics=_coverage_error_diagnostics(
                requested_trading_days=requested_trading_days,
                observed_trading_days=observed_trading_days,
                missing_trading_days=missing_trading_days,
                row_count_by_trading_day=row_count_by_trading_day,
                missing_symbol_trading_days=missing_symbol_trading_days,
                row_count_by_symbol_trading_day=row_count_by_symbol_trading_day,
            ),
        )

    tape_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_ref = manifest_path or default_manifest_path(tape_path)
    manifest_ref.parent.mkdir(parents=True, exist_ok=True)

    content_hash = hashlib.sha256()
    with _open_text_writer(tape_path) as handle:
        for row in ordered_rows:
            line = _canonical_row_json(row)
            content_hash.update(line.encode("utf-8"))
            content_hash.update(b"\n")
            handle.write(f"{line}\n")

    start_ts = regular_session_open_utc_for(start_date)
    end_ts = regular_session_close_utc_for(end_date)
    resolved_artifact_refs = {
        "tape_path": str(tape_path),
        **dict(artifact_refs or {}),
    }
    manifest = ReplayTapeManifest(
        schema_version=REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
        dataset_snapshot_ref=dataset_snapshot_ref,
        symbols=normalized_symbols,
        row_symbols=tuple(sorted({row.symbol.upper() for row in ordered_rows})),
        start_date=start_date,
        end_date=end_date,
        start_ts=start_ts,
        end_ts=end_ts,
        min_event_ts=min(event_times) if event_times else None,
        max_event_ts=max(event_times) if event_times else None,
        trading_day_count=len(event_dates),
        row_count=len(ordered_rows),
        source_query_digest=source_query_digest,
        content_sha256=content_hash.hexdigest(),
        artifact_refs=resolved_artifact_refs,
        source_table_versions=dict(source_table_versions or {}),
        created_at=created_at or datetime.now(timezone.utc),
        requested_trading_days=requested_trading_days,
        observed_trading_days=observed_trading_days,
        missing_trading_days=missing_trading_days,
        row_count_by_trading_day=row_count_by_trading_day,
        missing_symbol_trading_days=missing_symbol_trading_days,
        row_count_by_symbol_trading_day=row_count_by_symbol_trading_day,
    )
    manifest_ref.write_text(
        json.dumps(manifest.to_payload(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def load_replay_tape(
    tape_path: Path,
    *,
    manifest_path: Path | None = None,
    verify_digest: bool = True,
) -> ReplayTape:
    manifest_ref = manifest_path or default_manifest_path(tape_path)
    manifest = ReplayTapeManifest.from_payload(
        json.loads(manifest_ref.read_text(encoding="utf-8"))
    )
    rows: list[SignalEnvelope] = []
    content_hash = hashlib.sha256()
    with _open_text_reader(tape_path) as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            content_hash.update(stripped.encode("utf-8"))
            content_hash.update(b"\n")
            rows.append(signal_from_tape_payload(json.loads(stripped)))

    if verify_digest and content_hash.hexdigest() != manifest.content_sha256:
        raise ValueError("replay_tape_digest_mismatch")
    if len(rows) != manifest.row_count:
        raise ValueError(
            f"replay_tape_row_count_mismatch:{len(rows)}!={manifest.row_count}"
        )
    rows.sort(key=_signal_sort_key)
    return ReplayTape(manifest=manifest, rows=tuple(rows))


def validate_tape_freshness(
    manifest: ReplayTapeManifest,
    *,
    start_date: date,
    end_date: date,
    symbols: Sequence[str] = (),
    allow_stale_tape: bool = False,
) -> dict[str, Any]:
    reasons: list[str] = []
    if manifest.start_date > start_date or manifest.end_date < end_date:
        reasons.append(
            "window_not_covered:"
            f"{manifest.start_date.isoformat()}..{manifest.end_date.isoformat()}"
            f"<{start_date.isoformat()}..{end_date.isoformat()}"
        )

    requested_symbols = set(_normalize_symbols(symbols))
    coverage_symbols = set(manifest.symbols or manifest.row_symbols)
    if requested_symbols:
        missing = sorted(requested_symbols - coverage_symbols)
        if missing:
            reasons.append(f"symbols_not_covered:{','.join(missing)}")

    missing_trading_days = tuple(
        day for day in manifest.missing_trading_days if start_date <= day <= end_date
    )
    if missing_trading_days:
        reasons.append(
            "trading_days_missing:"
            + ",".join(day.isoformat() for day in missing_trading_days)
        )

    requested_trading_days = _business_days(start_date, end_date)
    observed_day_set = {
        day for day in manifest.observed_trading_days if start_date <= day <= end_date
    }
    for raw_day, raw_count in manifest.row_count_by_trading_day.items():
        try:
            day = date.fromisoformat(str(raw_day))
        except ValueError:
            continue
        if start_date <= day <= end_date and int(raw_count or 0) > 0:
            observed_day_set.add(day)
    observed_trading_days = tuple(sorted(observed_day_set))
    missing_symbol_entries = set(
        entry
        for entry in manifest.missing_symbol_trading_days
        if _symbol_day_entry_in_window(
            entry,
            start_date=start_date,
            end_date=end_date,
            requested_symbols=requested_symbols,
        )
    )
    missing_symbol_entries.update(
        _missing_symbol_trading_days(
            row_count_by_symbol_trading_day=manifest.row_count_by_symbol_trading_day,
            requested_symbols=tuple(sorted(requested_symbols)),
            requested_trading_days=requested_trading_days,
            observed_trading_days=observed_trading_days,
        )
    )
    missing_symbol_trading_days = tuple(sorted(missing_symbol_entries))
    if missing_symbol_trading_days:
        reasons.append(
            "symbol_trading_days_missing:" + ",".join(missing_symbol_trading_days)
        )

    if reasons and not allow_stale_tape:
        raise ValueError(f"replay_tape_stale:{';'.join(reasons)}")
    return {
        "schema_version": "torghut.replay-tape-validation.v1",
        "status": "stale_override" if reasons else "valid",
        "reasons": reasons,
        "stale_override_used": bool(reasons),
        "content_sha256": manifest.content_sha256,
        "dataset_snapshot_ref": manifest.dataset_snapshot_ref,
        "row_count": manifest.row_count,
        "trading_day_count": manifest.trading_day_count,
        "requested_symbols": sorted(requested_symbols),
        "requested_trading_days": [
            item.isoformat() for item in manifest.requested_trading_days
        ],
        "observed_trading_days": [
            item.isoformat() for item in manifest.observed_trading_days
        ],
        "missing_trading_days": [item.isoformat() for item in missing_trading_days],
        "row_count_by_trading_day": dict(manifest.row_count_by_trading_day),
        "missing_symbol_trading_days": list(missing_symbol_trading_days),
        "row_count_by_symbol_trading_day": {
            symbol: dict(days)
            for symbol, days in manifest.row_count_by_symbol_trading_day.items()
        },
        "coverage_status": _coverage_status(
            missing_trading_days=missing_trading_days,
            missing_symbol_trading_days=missing_symbol_trading_days,
        ),
    }


def slice_tape_by_window(
    rows: Iterable[SignalEnvelope],
    *,
    start_date: date,
    end_date: date,
) -> tuple[SignalEnvelope, ...]:
    selected = (
        row
        for row in rows
        if start_date <= row.event_ts.astimezone(timezone.utc).date() <= end_date
    )
    return tuple(sorted(selected, key=_signal_sort_key))


def slice_tape_by_symbols(
    rows: Iterable[SignalEnvelope],
    *,
    symbols: Sequence[str] = (),
) -> tuple[SignalEnvelope, ...]:
    selected_symbols = set(_normalize_symbols(symbols))
    if not selected_symbols:
        return tuple(sorted(rows, key=_signal_sort_key))
    selected = (row for row in rows if row.symbol.upper() in selected_symbols)
    return tuple(sorted(selected, key=_signal_sort_key))


def signal_to_tape_payload(signal: SignalEnvelope) -> dict[str, Any]:
    return {
        "schema_version": REPLAY_TAPE_SCHEMA_VERSION,
        "event_ts": signal.event_ts.astimezone(timezone.utc).isoformat(),
        "symbol": signal.symbol,
        "payload": _encode_value(signal.payload),
        "timeframe": signal.timeframe,
        "ingest_ts": signal.ingest_ts.astimezone(timezone.utc).isoformat()
        if signal.ingest_ts is not None
        else None,
        "seq": signal.seq,
        "source": signal.source,
    }


def signal_from_tape_payload(payload: Mapping[str, Any]) -> SignalEnvelope:
    schema_version = str(payload.get("schema_version") or "")
    if schema_version != REPLAY_TAPE_SCHEMA_VERSION:
        raise ValueError(f"replay_tape_row_schema_invalid:{schema_version}")
    ingest_ts = payload.get("ingest_ts")
    return SignalEnvelope(
        event_ts=_parse_datetime(str(payload["event_ts"])),
        symbol=str(payload["symbol"]),
        payload=_decode_value(payload.get("payload") or {}),
        timeframe=str(payload["timeframe"]) if payload.get("timeframe") else None,
        ingest_ts=_parse_datetime(str(ingest_ts)) if ingest_ts else None,
        seq=int(payload["seq"]) if payload.get("seq") is not None else None,
        source=str(payload["source"]) if payload.get("source") else None,
    )


def _canonical_row_json(signal: SignalEnvelope) -> str:
    return json.dumps(
        signal_to_tape_payload(signal),
        sort_keys=True,
        separators=(",", ":"),
    )


def _signal_sort_key(signal: SignalEnvelope) -> tuple[datetime, str, int]:
    seq = signal.seq if signal.seq is not None else 0
    return (signal.event_ts.astimezone(timezone.utc), signal.symbol.upper(), seq)


def _open_text_writer(path: Path) -> TextIO:
    if path.suffix == ".gz":
        return gzip.open(path, "wt", encoding="utf-8")
    return path.open("w", encoding="utf-8")


def _open_text_reader(path: Path) -> TextIO:
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalize_symbols(symbols: Sequence[str]) -> tuple[str, ...]:
    return tuple(
        sorted(
            {str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()}
        )
    )


def _business_days(start_day: date, end_day: date) -> tuple[date, ...]:
    if start_day > end_day:
        return ()
    current = start_day
    values: list[date] = []
    while current <= end_day:
        if current.weekday() < 5:
            values.append(current)
        current += timedelta(days=1)
    return tuple(values)


def _row_count_by_symbol_trading_day(
    rows: Sequence[SignalEnvelope],
) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for row in rows:
        symbol = row.symbol.strip().upper()
        if not symbol:
            continue
        day = row.event_ts.astimezone(timezone.utc).date().isoformat()
        symbol_counts = counts.setdefault(symbol, {})
        symbol_counts[day] = symbol_counts.get(day, 0) + 1
    return counts


def _missing_symbol_trading_days(
    *,
    row_count_by_symbol_trading_day: Mapping[str, Mapping[str, int]],
    requested_symbols: Sequence[str],
    requested_trading_days: Sequence[date],
    observed_trading_days: Sequence[date],
) -> tuple[str, ...]:
    if not requested_symbols:
        return ()
    observed_days = set(observed_trading_days)
    entries: list[str] = []
    for symbol in requested_symbols:
        symbol_counts = row_count_by_symbol_trading_day.get(symbol, {})
        for day in requested_trading_days:
            if day not in observed_days:
                continue
            if int(symbol_counts.get(day.isoformat()) or 0) <= 0:
                entries.append(_symbol_day_entry(symbol=symbol, day=day))
    return tuple(entries)


def _symbol_day_entry(*, symbol: str, day: date) -> str:
    return f"{symbol}:{day.isoformat()}"


def _parse_symbol_day_entry(entry: str) -> tuple[str, date] | None:
    symbol, sep, raw_day = entry.partition(":")
    if not sep or not symbol:
        return None
    try:
        parsed_day = date.fromisoformat(raw_day)
    except ValueError:
        return None
    return symbol, parsed_day


def _symbol_day_entry_in_window(
    entry: str,
    *,
    start_date: date,
    end_date: date,
    requested_symbols: set[str],
) -> bool:
    parsed = _parse_symbol_day_entry(entry)
    if parsed is None:
        return False
    symbol, day = parsed
    if requested_symbols and symbol not in requested_symbols:
        return False
    return start_date <= day <= end_date


def _coverage_status(
    *,
    missing_trading_days: Sequence[date],
    missing_symbol_trading_days: Sequence[str],
) -> str:
    if missing_trading_days:
        return "missing_days"
    if missing_symbol_trading_days:
        return "missing_symbol_days"
    return "complete"


def _incomplete_coverage_reason(
    *,
    missing_trading_days: Sequence[date],
    missing_symbol_trading_days: Sequence[str],
) -> str:
    parts: list[str] = []
    if missing_trading_days:
        missing = ",".join(day.isoformat() for day in missing_trading_days)
        parts.append(f"missing_days={missing}")
    if missing_symbol_trading_days:
        missing_symbols = ",".join(missing_symbol_trading_days)
        parts.append(f"missing_symbol_days={missing_symbols}")
    return "replay_tape_incomplete_coverage:" + ":".join(parts)


def _coverage_error_diagnostics(
    *,
    requested_trading_days: Sequence[date],
    observed_trading_days: Sequence[date],
    missing_trading_days: Sequence[date],
    row_count_by_trading_day: Mapping[str, int],
    missing_symbol_trading_days: Sequence[str],
    row_count_by_symbol_trading_day: Mapping[str, Mapping[str, int]],
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.replay-tape-coverage-error.v1",
        "requested_trading_days": [item.isoformat() for item in requested_trading_days],
        "observed_executable_trading_days": [
            item.isoformat() for item in observed_trading_days
        ],
        "missing_trading_days": [item.isoformat() for item in missing_trading_days],
        "materialized_executable_rows_by_trading_day": dict(row_count_by_trading_day),
        "missing_symbol_trading_days": list(missing_symbol_trading_days),
        "materialized_executable_rows_by_symbol_trading_day": {
            symbol: dict(days)
            for symbol, days in row_count_by_symbol_trading_day.items()
        },
    }


def _date_tuple(value: Any) -> tuple[date, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    parsed: list[date] = []
    for item in cast(Sequence[object], value):
        try:
            parsed.append(date.fromisoformat(str(item)))
        except ValueError:
            continue
    return tuple(parsed)


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    return tuple(str(item) for item in cast(Sequence[object], value))


def _string_mapping(value: Any) -> Mapping[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): str(item)
        for key, item in cast(Mapping[object, object], value).items()
    }


def _int_mapping(value: Any) -> Mapping[str, int]:
    if not isinstance(value, Mapping):
        return {}
    parsed: dict[str, int] = {}
    for key, item in cast(Mapping[object, object], value).items():
        try:
            parsed[str(key)] = int(str(item))
        except (TypeError, ValueError):
            continue
    return parsed


def _nested_int_mapping(value: Any) -> Mapping[str, Mapping[str, int]]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): _int_mapping(item)
        for key, item in cast(Mapping[object, object], value).items()
    }


def _encode_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return {_DECIMAL_TAG: str(value)}
    if isinstance(value, datetime):
        return {_DATETIME_TAG: value.astimezone(timezone.utc).isoformat()}
    if isinstance(value, Mapping):
        return {
            str(key): _encode_value(item)
            for key, item in cast(Mapping[object, object], value).items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_encode_value(item) for item in cast(Sequence[object], value)]
    return value


def _decode_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        if set(mapping) == {_DECIMAL_TAG}:
            return Decimal(str(mapping[_DECIMAL_TAG]))
        if set(mapping) == {_DATETIME_TAG}:
            return _parse_datetime(str(mapping[_DATETIME_TAG]))
        return {str(key): _decode_value(item) for key, item in mapping.items()}
    if isinstance(value, list):
        return [_decode_value(item) for item in cast(list[object], value)]
    return value


def _json_ready(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        return {
            str(key): _json_ready(item)
            for key, item in cast(Mapping[object, object], value).items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_ready(item) for item in cast(Sequence[object], value)]
    return value


__all__ = [
    "REPLAY_TAPE_MANIFEST_SCHEMA_VERSION",
    "REPLAY_TAPE_SCHEMA_VERSION",
    "ReplayTape",
    "ReplayTapeCoverageError",
    "ReplayTapeManifest",
    "build_source_query_digest",
    "default_manifest_path",
    "load_replay_tape",
    "materialize_signal_tape",
    "signal_from_tape_payload",
    "signal_to_tape_payload",
    "slice_tape_by_symbols",
    "slice_tape_by_window",
    "validate_tape_freshness",
]
