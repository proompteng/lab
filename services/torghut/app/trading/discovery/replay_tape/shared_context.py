"""Manifest-verified replay tape artifacts for Torghut research replays."""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
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

from .manifest import REPLAY_TAPE_MANIFEST_SCHEMA_VERSION, ReplayTapeManifest
from .point_in_time import (
    PointInTimeReceiptSpec,
    build_point_in_time_data_receipt,
    verify_point_in_time_data_receipt,
)


REPLAY_TAPE_SCHEMA_VERSION = "torghut.replay-tape.v1"

REPLAY_TAPE_CACHE_IDENTITY_SCHEMA_VERSION = "torghut.replay-tape-cache-identity.v1"

HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION = "torghut.hpairs-replay-tape-features.v1"

HPAIRS_REPLAY_TAPE_FEATURE_CONTRACT_SCHEMA_VERSION = (
    "torghut.hpairs-replay-tape-feature-contract.v1"
)

HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION = "torghut.hpairs-ofi-memory-regime-slices.v1"

HPAIRS_CLUSTERLOB_FEATURE_VERSION = "torghut.hpairs-clusterlob-feature-buckets.v1"

HPAIRS_OFI_FEATURE_VERSION = HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION

DECIMAL_TAG = "__torghut_decimal__"

DATETIME_TAG = "__torghut_datetime__"


class ReplayTapeCoverageError(ValueError):
    def __init__(self, reason: str, *, diagnostics: Mapping[str, Any]) -> None:
        super().__init__(reason)
        self.reason = reason
        self.diagnostics = dict(diagnostics)


@dataclass(frozen=True)
class ReplayTape:
    manifest: ReplayTapeManifest
    rows: tuple[SignalEnvelope, ...]


def default_manifest_path(tape_path: Path) -> Path:
    return tape_path.with_name(f"{tape_path.name}.manifest.json")


def mean_decimal(values: Iterable[Any]) -> Decimal | None:
    parsed = tuple(
        value
        for value in (decimal_or_none(item) for item in values)
        if value is not None
    )
    if not parsed:
        return None
    return sum(parsed, Decimal("0")) / Decimal(len(parsed))


def bounded_decimal(value: Decimal) -> Decimal:
    return max(Decimal("-1"), min(Decimal("1"), value))


def decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f")


def first_decimal_with_key(
    payload: Mapping[str, Any], keys: Sequence[str]
) -> tuple[Decimal | None, str | None]:
    for key in keys:
        value = decimal_or_none(payload.get(key))
        if value is not None:
            return value, key
    return None, None


def json_ready(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        return {
            str(key): json_ready(item)
            for key, item in cast(Mapping[object, object], value).items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [json_ready(item) for item in cast(Sequence[object], value)]
    return value


def hpairs_capacity_notional_lineage(
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
            lineage[key] = json_ready(raw)
    for key in (
        "target_implied_notional",
        "required_daily_notional",
        "max_notional_per_trade",
        "configured_daily_notional_capacity",
        "adv_notional_capacity",
        "dollar_volume",
    ):
        parsed = decimal_or_none(payload.get(key))
        if parsed is None:
            continue
        source_fields.add(key)
        lineage[key] = str(parsed)
    return lineage


def tag_tuple(
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


def stress_tag_tuple(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> tuple[str, ...]:
    tags = set(
        tag_tuple(
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


def first_text(
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


def decimal_or_none(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def open_text_writer(path: Path) -> TextIO:
    if path.suffix == ".gz":
        return gzip.open(path, "wt", encoding="utf-8")
    return path.open("w", encoding="utf-8")


def open_text_reader(path: Path) -> TextIO:
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def normalize_symbols(symbols: Sequence[str]) -> tuple[str, ...]:
    return tuple(
        sorted(
            {str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()}
        )
    )


def business_days(start_day: date, end_day: date) -> tuple[date, ...]:
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


def symbol_day_entry(*, symbol: str, day: date) -> str:
    return f"{symbol}:{day.isoformat()}"


def parse_symbol_day_entry(entry: str) -> tuple[str, date] | None:
    symbol, sep, raw_day = entry.partition(":")
    if not sep or not symbol:
        return None
    try:
        parsed_day = date.fromisoformat(raw_day)
    except ValueError:
        return None
    return symbol, parsed_day


def symbol_day_entry_in_window(
    entry: str,
    *,
    start_date: date,
    end_date: date,
    requested_symbols: set[str],
) -> bool:
    parsed = parse_symbol_day_entry(entry)
    if parsed is None:
        return False
    symbol, day = parsed
    if requested_symbols and symbol not in requested_symbols:
        return False
    return start_date <= day <= end_date


def missing_symbol_trading_days(
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
                entries.append(symbol_day_entry(symbol=symbol, day=day))
    return tuple(entries)


def coverage_status(
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


def coverage_error_diagnostics(
    *,
    trading_days: tuple[Sequence[date], Sequence[date], Sequence[date]],
    row_count_by_trading_day: Mapping[str, int],
    missing_symbol_trading_days: Sequence[str],
    row_count_by_symbol_trading_day: Mapping[str, Mapping[str, int]],
) -> dict[str, Any]:
    requested_trading_days, observed_trading_days, missing_trading_days = trading_days
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


def string_mapping(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): str(item)
        for key, item in cast(Mapping[object, object], value).items()
    }


def encode_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return {DECIMAL_TAG: str(value)}
    if isinstance(value, datetime):
        return {DATETIME_TAG: value.astimezone(timezone.utc).isoformat()}
    if isinstance(value, Mapping):
        return {
            str(key): encode_value(item)
            for key, item in cast(Mapping[object, object], value).items()
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [encode_value(item) for item in cast(Sequence[object], value)]
    return value


def decode_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        if set(mapping) == {DECIMAL_TAG}:
            return Decimal(str(mapping[DECIMAL_TAG]))
        if set(mapping) == {DATETIME_TAG}:
            return parse_datetime(str(mapping[DATETIME_TAG]))
        return {str(key): decode_value(item) for key, item in mapping.items()}
    if isinstance(value, list):
        return [decode_value(item) for item in cast(list[object], value)]
    return value


def signal_sort_key(signal: SignalEnvelope) -> tuple[datetime, str, int]:
    seq = signal.seq if signal.seq is not None else 0
    return (signal.event_ts.astimezone(timezone.utc), signal.symbol.upper(), seq)


def build_source_query_digest(payload: Mapping[str, Any]) -> str:
    raw = json.dumps(
        json_ready(payload),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def hpairs_replay_tape_feature_versions() -> dict[str, str]:
    return {
        "hpairs": HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
        "cluster_lob": HPAIRS_CLUSTERLOB_FEATURE_VERSION,
        "ofi_memory_regime": HPAIRS_OFI_FEATURE_VERSION,
    }


def hpairs_replay_tape_feature_contract() -> dict[str, Any]:
    """Return the stable H-PAIRS replay-tape discovery feature contract.

    The contract is intentionally proof-neutral. Its hash can be supplied as a
    replay tape ``feature_schema_hash`` so ClusterLOB/OFI discovery features are
    part of cache lineage without changing runtime-ledger authority.
    """

    return {
        "schema_version": HPAIRS_REPLAY_TAPE_FEATURE_CONTRACT_SCHEMA_VERSION,
        "feature_schema_version": HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
        "feature_versions": hpairs_replay_tape_feature_versions(),
        "mechanisms": [
            "clusterlob_clustered_event_quote_behavior_buckets",
            "horizon_specific_ofi_memory_regime_slices",
            "proof_neutral_candidate_discovery_prefilter",
        ],
        "cluster_lob": {
            "event_fields": [
                "cluster_lob_label",
                "cluster_label",
                "order_cluster",
                "lob_event_type",
                "event_type",
            ],
            "bucket_fields": [
                "cluster_lob_bucket",
                "cluster_bucket",
                "participant_bucket",
                "behavior_bucket",
            ],
            "quote_fields": [
                "bid_size",
                "bid_qty",
                "best_bid_size",
                "ask_size",
                "ask_qty",
                "best_ask_size",
            ],
            "bucket_policy": "deterministic_source_bucket_or_event_quote_fallback",
        },
        "ofi_memory_regime": {
            "horizon_slices": ["instant", "short", "medium", "long"],
            "preferred_horizon_keys": ["instant", "3_events", "12_events", "36_events"],
            "decay_memory_fields": [
                "ofi_decay_memory",
                "ofi_memory",
                "order_flow_memory",
                "ofi_decay",
            ],
            "regime_fields": [
                "regime_tags",
                "regime_tag",
                "market_regime",
                "liquidity_regime",
            ],
            "stress_fields": [
                "macro_event_window",
                "macro_announcement_window",
                "news_event_window",
                "stress_veto_window",
            ],
        },
        "lineage": {
            "serializable": True,
            "deterministic": True,
            "hashable": True,
            "hash_function": "sha256_canonical_json",
        },
        "proof_neutrality": {
            "proof_source": "prefilter_only",
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "runtime_ledger_authority": False,
            "requires_exact_replay": True,
            "requires_source_backed_runtime_ledger": True,
        },
    }


def build_hpairs_replay_tape_feature_schema_hash() -> str:
    return build_source_query_digest(hpairs_replay_tape_feature_contract())


def build_replay_tape_cache_key(
    *,
    dataset_snapshot_ref: str,
    symbols: Sequence[str],
    start_date: date,
    end_date: date,
    source_query_digest: str,
    feature_schema_hash: str = "",
    cost_model_hash: str = "",
    strategy_family: str = "",
    feature_versions: Mapping[str, str] | None = None,
    source_table_versions: Mapping[str, str] | None = None,
) -> str:
    """Build a stable cache key for a manifest-verified replay tape input set."""

    return build_source_query_digest(
        {
            "schema_version": "torghut.replay-tape-cache-key.v1",
            "dataset_snapshot_ref": dataset_snapshot_ref,
            "symbols": normalize_symbols(symbols),
            "start_date": start_date,
            "end_date": end_date,
            "source_query_digest": source_query_digest,
            "feature_schema_hash": str(feature_schema_hash or ""),
            "cost_model_hash": str(cost_model_hash or ""),
            "strategy_family": str(strategy_family or ""),
            "feature_versions": string_mapping(feature_versions),
            "source_table_versions": dict(source_table_versions or {}),
        }
    )


def build_replay_tape_cache_identity_diagnostics(
    *,
    dataset_snapshot_ref: str,
    symbols: Sequence[str],
    start_date: date,
    end_date: date,
    source_query_digest: str,
    feature_schema_hash: str = "",
    cost_model_hash: str = "",
    strategy_family: str = "",
    feature_versions: Mapping[str, str] | None = None,
    source_table_versions: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Report whether the replay/cache identity has all local reproducibility keys.

    This does not synthesize missing values. Empty optional hashes/family values are
    preserved in the cache key for deterministic compatibility, while the returned
    blockers make missing local identity components explicit to downstream preview
    and SIM queue artifacts.
    """

    normalized_symbols = normalize_symbols(symbols)
    missing_components: list[str] = []
    if not str(dataset_snapshot_ref or "").strip():
        missing_components.append("dataset_snapshot_ref")
    if not normalized_symbols:
        missing_components.append("symbol_universe")
    if not str(source_query_digest or "").strip():
        missing_components.append("source_query_digest")
    if not str(feature_schema_hash or "").strip():
        missing_components.append("feature_schema_hash")
    if not str(cost_model_hash or "").strip():
        missing_components.append("cost_model_hash")
    if not str(strategy_family or "").strip():
        missing_components.append("strategy_family")

    blockers = [
        f"replay_tape_cache_identity_missing_{component}"
        for component in missing_components
    ]
    return {
        "schema_version": REPLAY_TAPE_CACHE_IDENTITY_SCHEMA_VERSION,
        "status": "complete" if not missing_components else "incomplete",
        "diagnostic_only": True,
        "cache_reuse_identity_complete": not missing_components,
        "missing_components": missing_components,
        "blockers": blockers,
        "components": {
            "dataset_snapshot_ref": str(dataset_snapshot_ref or ""),
            "symbol_universe": list(normalized_symbols),
            "date_range": {
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
            },
            "source_query_digest": str(source_query_digest or ""),
            "feature_schema_hash": str(feature_schema_hash or ""),
            "cost_model_hash": str(cost_model_hash or ""),
            "strategy_family": str(strategy_family or ""),
            "feature_versions": string_mapping(feature_versions),
            "source_table_versions": dict(source_table_versions or {}),
        },
    }


def resolve_replay_feature_versions(
    *,
    feature_schema_hash: str,
    strategy_family: str,
    feature_versions: Mapping[str, str] | None,
) -> dict[str, str]:
    explicit_versions = string_mapping(feature_versions)
    if explicit_versions:
        return explicit_versions
    normalized_family = str(strategy_family or "").lower()
    if (
        str(feature_schema_hash or "") == build_hpairs_replay_tape_feature_schema_hash()
        or "hpairs" in normalized_family
        or "microbar_cross_sectional_pairs" in normalized_family
    ):
        return hpairs_replay_tape_feature_versions()
    return {}


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
    feature_schema_hash: str = "",
    cost_model_hash: str = "",
    strategy_family: str = "",
    feature_versions: Mapping[str, str] | None = None,
    source_table_versions: Mapping[str, str] | None = None,
    artifact_refs: Mapping[str, str] | None = None,
    created_at: datetime | None = None,
    require_complete_coverage: bool = False,
    point_in_time_spec: PointInTimeReceiptSpec | None = None,
    require_point_in_time_receipt: bool = False,
) -> ReplayTapeManifest:
    from .validate_tape_freshness import canonical_row_json as _canonical_row_json

    ordered_rows = tuple(sorted(rows, key=signal_sort_key))
    normalized_symbols = normalize_symbols(symbols)
    event_dates = {row.event_ts.astimezone(timezone.utc).date() for row in ordered_rows}
    event_times = tuple(row.event_ts.astimezone(timezone.utc) for row in ordered_rows)
    requested_trading_days = business_days(start_date, end_date)
    observed_trading_days = tuple(sorted(event_dates))
    missing_trading_days = tuple(
        day for day in requested_trading_days if day not in event_dates
    )
    row_count_by_symbol_trading_day = _row_count_by_symbol_trading_day(ordered_rows)
    missing_symbol_day_entries = missing_symbol_trading_days(
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
        missing_trading_days or missing_symbol_day_entries
    ):
        reason = _incomplete_coverage_reason(
            missing_trading_days=missing_trading_days,
            missing_symbol_trading_days=missing_symbol_day_entries,
        )
        raise ReplayTapeCoverageError(
            reason,
            diagnostics=coverage_error_diagnostics(
                trading_days=(
                    requested_trading_days,
                    observed_trading_days,
                    missing_trading_days,
                ),
                row_count_by_trading_day=row_count_by_trading_day,
                missing_symbol_trading_days=missing_symbol_day_entries,
                row_count_by_symbol_trading_day=row_count_by_symbol_trading_day,
            ),
        )

    tape_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_ref = manifest_path or default_manifest_path(tape_path)
    manifest_ref.parent.mkdir(parents=True, exist_ok=True)
    resolved_feature_versions = resolve_replay_feature_versions(
        feature_schema_hash=feature_schema_hash,
        strategy_family=strategy_family,
        feature_versions=feature_versions,
    )

    content_hash = hashlib.sha256()
    for row in ordered_rows:
        line = _canonical_row_json(row)
        content_hash.update(line.encode("utf-8"))
        content_hash.update(b"\n")
    content_sha256 = content_hash.hexdigest()
    if require_point_in_time_receipt and point_in_time_spec is None:
        raise ValueError("point_in_time_receipt_required")
    point_in_time_receipt = (
        build_point_in_time_data_receipt(
            rows=ordered_rows,
            content_sha256=content_sha256,
            feature_schema_hash=feature_schema_hash,
            source_table_versions=dict(source_table_versions or {}),
            spec=point_in_time_spec,
            require_complete=require_point_in_time_receipt,
        )
        if point_in_time_spec is not None
        else None
    )

    # Validate every fail-closed receipt before replacing an existing artifact.
    with open_text_writer(tape_path) as handle:
        for row in ordered_rows:
            handle.write(f"{_canonical_row_json(row)}\n")

    start_ts = regular_session_open_utc_for(start_date)
    end_ts = regular_session_close_utc_for(end_date)
    resolved_artifact_refs = {
        "tape_path": str(tape_path),
        **dict(artifact_refs or {}),
    }
    replay_cache_key = build_replay_tape_cache_key(
        dataset_snapshot_ref=dataset_snapshot_ref,
        symbols=normalized_symbols,
        start_date=start_date,
        end_date=end_date,
        source_query_digest=source_query_digest,
        feature_schema_hash=feature_schema_hash,
        cost_model_hash=cost_model_hash,
        strategy_family=strategy_family,
        feature_versions=resolved_feature_versions,
        source_table_versions=source_table_versions,
    )
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
        content_sha256=content_sha256,
        feature_schema_hash=str(feature_schema_hash or ""),
        cost_model_hash=str(cost_model_hash or ""),
        strategy_family=str(strategy_family or ""),
        replay_cache_key=replay_cache_key,
        feature_versions=resolved_feature_versions,
        artifact_refs=resolved_artifact_refs,
        source_table_versions=dict(source_table_versions or {}),
        created_at=created_at or datetime.now(timezone.utc),
        point_in_time_receipt=point_in_time_receipt,
        requested_trading_days=requested_trading_days,
        observed_trading_days=observed_trading_days,
        missing_trading_days=missing_trading_days,
        row_count_by_trading_day=row_count_by_trading_day,
        missing_symbol_trading_days=missing_symbol_day_entries,
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
    from .validate_tape_freshness import signal_from_tape_payload

    manifest_ref = manifest_path or default_manifest_path(tape_path)
    manifest = ReplayTapeManifest.from_payload(
        json.loads(manifest_ref.read_text(encoding="utf-8"))
    )
    rows: list[SignalEnvelope] = []
    content_hash = hashlib.sha256()
    with open_text_reader(tape_path) as handle:
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
    rows.sort(key=signal_sort_key)
    if manifest.point_in_time_receipt is not None:
        diagnostics = verify_point_in_time_data_receipt(
            manifest.point_in_time_receipt,
            rows=rows,
            content_sha256=content_hash.hexdigest(),
            feature_schema_hash=manifest.feature_schema_hash,
            source_table_versions=manifest.source_table_versions,
        )
        if diagnostics["status"] != "complete":
            reasons = ",".join(cast(Sequence[str], diagnostics["reason_codes"]))
            raise ValueError(f"point_in_time_receipt_invalid:{reasons}")
    return ReplayTape(manifest=manifest, rows=tuple(rows))
