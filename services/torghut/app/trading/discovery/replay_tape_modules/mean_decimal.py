# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Manifest-verified replay tape artifacts for Torghut research replays."""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, TextIO, cast

from app.trading.models import SignalEnvelope
from app.trading.session_context import (
    iter_regular_equities_session_dates,
    regular_session_close_utc_for,
    regular_session_open_utc_for,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    HPAIRS_CLUSTERLOB_FEATURE_VERSION,
    HPAIRS_OFI_FEATURE_VERSION,
    HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION,
    HPAIRS_REPLAY_TAPE_FEATURE_CONTRACT_SCHEMA_VERSION,
    HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
    REPLAY_TAPE_CACHE_IDENTITY_SCHEMA_VERSION,
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    REPLAY_TAPE_SCHEMA_VERSION,
    ReplayTape,
    ReplayTapeCoverageError,
    ReplayTapeManifest,
    _DATETIME_TAG,
    _DECIMAL_TAG,
    _empty_row_count_by_symbol_trading_day,
    _empty_row_count_by_trading_day,
    _empty_string_mapping,
    _resolve_replay_feature_versions,
    build_hpairs_replay_tape_feature_schema_hash,
    build_replay_tape_cache_identity_diagnostics,
    build_replay_tape_cache_key,
    build_source_query_digest,
    default_manifest_path,
    hpairs_replay_tape_feature_contract,
    hpairs_replay_tape_feature_versions,
    load_replay_tape,
    materialize_signal_tape,
)
from .validate_tape_freshness import (
    _canonical_row_json,
    _cluster_lob_behavior_bucket,
    _horizon_key_matches_token,
    _hpairs_cluster_lob_payload,
    _hpairs_ofi_decay_memory,
    _hpairs_ofi_horizons,
    _hpairs_ofi_memory_regime_slices,
    _mean_decimal_for_keys,
    _mean_decimal_for_token,
    _ofi_regime_bucket,
    _quote_behavior_bucket,
    _replay_tape_cache_identity_mismatch_reasons,
    _signal_sort_key,
    hpairs_replay_tape_features,
    signal_from_tape_payload,
    signal_to_tape_payload,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)


def _mean_decimal(values: Iterable[Any]) -> Decimal | None:
    parsed = tuple(
        value
        for value in (_decimal_or_none(item) for item in values)
        if value is not None
    )
    if not parsed:
        return None
    return sum(parsed, Decimal("0")) / Decimal(len(parsed))


def _bounded_decimal(value: Decimal) -> Decimal:
    return max(Decimal("-1"), min(Decimal("1"), value))


def _decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _first_decimal_with_key(
    payload: Mapping[str, Any], keys: Sequence[str]
) -> tuple[Decimal | None, str | None]:
    for key in keys:
        value = _decimal_or_none(payload.get(key))
        if value is not None:
            return value, key
    return None, None


def _hpairs_capacity_notional_lineage(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> dict[str, Any]:
    lineage: dict[str, Any] = {
        "status": "source_row_metadata" if payload else "missing_inputs",
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
    }
    for key in (
        "capacity_notional_lineage",
        "impact_capacity_lineage",
        "target_implied_notional_context",
        "cost_impact_lineage",
    ):
        raw = payload.get(key)
        if isinstance(raw, Mapping):
            source_fields.add(key)
            lineage[key] = _json_ready(raw)
    for key in (
        "target_implied_notional",
        "required_daily_notional",
        "max_notional_per_trade",
        "configured_daily_notional_capacity",
        "adv_notional_capacity",
        "dollar_volume",
    ):
        parsed = _decimal_or_none(payload.get(key))
        if parsed is None:
            continue
        source_fields.add(key)
        lineage[key] = str(parsed)
    return lineage


def _stress_tag_tuple(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> tuple[str, ...]:
    tags = set(
        _tag_tuple(
            payload,
            ("stress_tags", "stress_tag", "news_stress_tag", "macro_stress_tag"),
            source_fields=source_fields,
        )
    )
    for key in (
        "macro_event_window",
        "macro_announcement_window",
        "news_event_window",
        "stress_veto_window",
    ):
        value = payload.get(key)
        if value is None:
            continue
        source_fields.add(key)
        if isinstance(value, bool):
            if value:
                tags.add(key)
            continue
        text = str(value).strip().lower()
        if text in {"yes", "true", "macro", "news", "event", "stress", "1"}:
            tags.add(key)
    return tuple(sorted(tags))


def _tag_tuple(
    payload: Mapping[str, Any],
    keys: Sequence[str],
    *,
    source_fields: set[str],
) -> tuple[str, ...]:
    tags: set[str] = set()
    for key in keys:
        if key not in payload:
            continue
        value = payload.get(key)
        source_fields.add(key)
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            for item in cast(Sequence[object], value):
                tag = str(item).strip().lower()
                if tag:
                    tags.add(tag)
            continue
        tag = str(value).strip().lower()
        if tag:
            tags.add(tag)
    return tuple(sorted(tags))


def _first_text(
    payload: Mapping[str, Any],
    keys: Sequence[str],
    *,
    source_fields: set[str],
) -> str | None:
    for key in keys:
        text = str(payload.get(key) or "").strip().lower()
        if not text:
            continue
        source_fields.add(key)
        return text
    return None


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


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
    return iter_regular_equities_session_dates(start_day, end_day)


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


def _string_mapping(value: Any) -> dict[str, str]:
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
    "REPLAY_TAPE_CACHE_IDENTITY_SCHEMA_VERSION",
    "HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION",
    "REPLAY_TAPE_MANIFEST_SCHEMA_VERSION",
    "REPLAY_TAPE_SCHEMA_VERSION",
    "ReplayTape",
    "ReplayTapeCoverageError",
    "ReplayTapeManifest",
    "build_replay_tape_cache_key",
    "build_replay_tape_cache_identity_diagnostics",
    "build_source_query_digest",
    "default_manifest_path",
    "load_replay_tape",
    "materialize_signal_tape",
    "hpairs_replay_tape_features",
    "signal_from_tape_payload",
    "signal_to_tape_payload",
    "slice_tape_by_symbols",
    "slice_tape_by_window",
    "validate_tape_freshness",
]


__all__ = [name for name in globals() if not name.startswith("__")]
