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

REPLAY_TAPE_SCHEMA_VERSION = "torghut.replay-tape.v1"
REPLAY_TAPE_MANIFEST_SCHEMA_VERSION = "torghut.replay-tape-manifest.v1"
REPLAY_TAPE_CACHE_IDENTITY_SCHEMA_VERSION = "torghut.replay-tape-cache-identity.v1"
HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION = "torghut.hpairs-replay-tape-features.v1"
HPAIRS_REPLAY_TAPE_FEATURE_CONTRACT_SCHEMA_VERSION = (
    "torghut.hpairs-replay-tape-feature-contract.v1"
)
HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION = "torghut.hpairs-ofi-memory-regime-slices.v1"
HPAIRS_CLUSTERLOB_FEATURE_VERSION = "torghut.hpairs-clusterlob-feature-buckets.v1"
HPAIRS_OFI_FEATURE_VERSION = HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION
_DECIMAL_TAG = "__torghut_decimal__"
_DATETIME_TAG = "__torghut_datetime__"


def _empty_row_count_by_trading_day() -> dict[str, int]:
    return {}


def _empty_row_count_by_symbol_trading_day() -> dict[str, dict[str, int]]:
    return {}


def _empty_string_mapping() -> dict[str, str]:
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
    feature_schema_hash: str = ""
    cost_model_hash: str = ""
    strategy_family: str = ""
    replay_cache_key: str = ""
    feature_versions: Mapping[str, str] = field(default_factory=_empty_string_mapping)
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
            "feature_schema_hash": self.feature_schema_hash,
            "cost_model_hash": self.cost_model_hash,
            "strategy_family": self.strategy_family,
            "replay_cache_key": self.replay_cache_key,
            "feature_versions": dict(self.feature_versions),
            "cache_identity": self.cache_identity_diagnostics(),
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

    def cache_identity_diagnostics(self) -> dict[str, Any]:
        return build_replay_tape_cache_identity_diagnostics(
            dataset_snapshot_ref=self.dataset_snapshot_ref,
            symbols=self.symbols,
            start_date=self.start_date,
            end_date=self.end_date,
            source_query_digest=self.source_query_digest,
            feature_schema_hash=self.feature_schema_hash,
            cost_model_hash=self.cost_model_hash,
            strategy_family=self.strategy_family,
            feature_versions=self.feature_versions,
            source_table_versions=self.source_table_versions,
        )

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
            feature_schema_hash=str(payload.get("feature_schema_hash") or ""),
            cost_model_hash=str(payload.get("cost_model_hash") or ""),
            strategy_family=str(payload.get("strategy_family") or ""),
            replay_cache_key=str(payload.get("replay_cache_key") or ""),
            feature_versions=_string_mapping(payload.get("feature_versions")),
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
            "symbols": _normalize_symbols(symbols),
            "start_date": start_date,
            "end_date": end_date,
            "source_query_digest": source_query_digest,
            "feature_schema_hash": str(feature_schema_hash or ""),
            "cost_model_hash": str(cost_model_hash or ""),
            "strategy_family": str(strategy_family or ""),
            "feature_versions": _string_mapping(feature_versions),
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

    normalized_symbols = _normalize_symbols(symbols)
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
            "feature_versions": _string_mapping(feature_versions),
            "source_table_versions": dict(source_table_versions or {}),
        },
    }


def _resolve_replay_feature_versions(
    *,
    feature_schema_hash: str,
    strategy_family: str,
    feature_versions: Mapping[str, str] | None,
) -> dict[str, str]:
    explicit_versions = _string_mapping(feature_versions)
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
    resolved_feature_versions = _resolve_replay_feature_versions(
        feature_schema_hash=feature_schema_hash,
        strategy_family=strategy_family,
        feature_versions=feature_versions,
    )

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
        content_sha256=content_hash.hexdigest(),
        feature_schema_hash=str(feature_schema_hash or ""),
        cost_model_hash=str(cost_model_hash or ""),
        strategy_family=str(strategy_family or ""),
        replay_cache_key=replay_cache_key,
        feature_versions=resolved_feature_versions,
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
    require_exact_cache_identity: bool = False,
    expected_dataset_snapshot_ref: str | None = None,
    expected_source_query_digest: str | None = None,
    expected_feature_schema_hash: str | None = None,
    expected_cost_model_hash: str | None = None,
    expected_strategy_family: str | None = None,
    expected_replay_cache_key: str | None = None,
    expected_feature_versions: Mapping[str, str] | None = None,
    expected_source_table_versions: Mapping[str, str] | None = None,
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

    cache_identity_reasons = _replay_tape_cache_identity_mismatch_reasons(
        manifest,
        start_date=start_date,
        end_date=end_date,
        symbols=tuple(sorted(requested_symbols)),
        require_exact_cache_identity=require_exact_cache_identity,
        expected_dataset_snapshot_ref=expected_dataset_snapshot_ref,
        expected_source_query_digest=expected_source_query_digest,
        expected_feature_schema_hash=expected_feature_schema_hash,
        expected_cost_model_hash=expected_cost_model_hash,
        expected_strategy_family=expected_strategy_family,
        expected_replay_cache_key=expected_replay_cache_key,
        expected_feature_versions=expected_feature_versions,
        expected_source_table_versions=expected_source_table_versions,
    )
    if cache_identity_reasons:
        raise ValueError(
            "replay_tape_cache_identity_mismatch:" + ";".join(cache_identity_reasons)
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
        "source_query_digest": manifest.source_query_digest,
        "source_table_versions": dict(manifest.source_table_versions),
        "feature_schema_hash": manifest.feature_schema_hash,
        "cost_model_hash": manifest.cost_model_hash,
        "strategy_family": manifest.strategy_family,
        "feature_versions": dict(manifest.feature_versions),
        "replay_cache_key": manifest.replay_cache_key,
        "cache_identity": manifest.cache_identity_diagnostics(),
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


def _replay_tape_cache_identity_mismatch_reasons(
    manifest: ReplayTapeManifest,
    *,
    start_date: date,
    end_date: date,
    symbols: Sequence[str],
    require_exact_cache_identity: bool,
    expected_dataset_snapshot_ref: str | None,
    expected_source_query_digest: str | None,
    expected_feature_schema_hash: str | None,
    expected_cost_model_hash: str | None,
    expected_strategy_family: str | None,
    expected_replay_cache_key: str | None,
    expected_feature_versions: Mapping[str, str] | None,
    expected_source_table_versions: Mapping[str, str] | None,
) -> list[str]:
    reasons: list[str] = []
    requested_symbols = _normalize_symbols(symbols)

    if require_exact_cache_identity:
        diagnostics = manifest.cache_identity_diagnostics()
        raw_missing_components = diagnostics.get("missing_components", ())
        missing_component_values: Sequence[Any] = ()
        if isinstance(raw_missing_components, Sequence) and not isinstance(
            raw_missing_components, (str, bytes, bytearray)
        ):
            missing_component_values = cast(Sequence[Any], raw_missing_components)
        missing_components = tuple(
            str(component) for component in missing_component_values if str(component)
        )
        if missing_components:
            reasons.append("missing_components:" + ",".join(sorted(missing_components)))
        if manifest.start_date != start_date or manifest.end_date != end_date:
            reasons.append(
                "date_range:"
                f"{manifest.start_date.isoformat()}..{manifest.end_date.isoformat()}"
                f"!={start_date.isoformat()}..{end_date.isoformat()}"
            )
        if requested_symbols and tuple(manifest.symbols) != requested_symbols:
            reasons.append(
                "symbol_universe:"
                f"{','.join(manifest.symbols)}!={','.join(requested_symbols)}"
            )
        recomputed_cache_key = build_replay_tape_cache_key(
            dataset_snapshot_ref=manifest.dataset_snapshot_ref,
            symbols=manifest.symbols,
            start_date=manifest.start_date,
            end_date=manifest.end_date,
            source_query_digest=manifest.source_query_digest,
            feature_schema_hash=manifest.feature_schema_hash,
            cost_model_hash=manifest.cost_model_hash,
            strategy_family=manifest.strategy_family,
            feature_versions=manifest.feature_versions,
            source_table_versions=manifest.source_table_versions,
        )
        if manifest.replay_cache_key != recomputed_cache_key:
            reasons.append(
                f"replay_cache_key:{manifest.replay_cache_key}!={recomputed_cache_key}"
            )

    def append_string_mismatch(
        component: str,
        observed: str,
        expected: str | None,
    ) -> None:
        if expected is None:
            return
        expected_value = str(expected or "")
        if str(observed or "") != expected_value:
            reasons.append(f"{component}:{observed}!={expected_value}")

    append_string_mismatch(
        "dataset_snapshot_ref",
        manifest.dataset_snapshot_ref,
        expected_dataset_snapshot_ref,
    )
    append_string_mismatch(
        "source_query_digest",
        manifest.source_query_digest,
        expected_source_query_digest,
    )
    append_string_mismatch(
        "feature_schema_hash",
        manifest.feature_schema_hash,
        expected_feature_schema_hash,
    )
    append_string_mismatch(
        "cost_model_hash",
        manifest.cost_model_hash,
        expected_cost_model_hash,
    )
    append_string_mismatch(
        "strategy_family",
        manifest.strategy_family,
        expected_strategy_family,
    )
    append_string_mismatch(
        "replay_cache_key",
        manifest.replay_cache_key,
        expected_replay_cache_key,
    )

    if expected_feature_versions is not None:
        expected_versions = _string_mapping(expected_feature_versions)
        if dict(manifest.feature_versions) != expected_versions:
            reasons.append(
                "feature_versions:"
                f"{dict(manifest.feature_versions)}!={expected_versions}"
            )
    if expected_source_table_versions is not None:
        expected_table_versions = dict(expected_source_table_versions)
        if dict(manifest.source_table_versions) != expected_table_versions:
            reasons.append(
                "source_table_versions:"
                f"{dict(manifest.source_table_versions)}!={expected_table_versions}"
            )
    return reasons


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
        "hpairs_features": _encode_value(hpairs_replay_tape_features(signal)),
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
    decoded_signal_payload = _decode_value(payload.get("payload") or {})
    signal_payload: dict[str, Any] = (
        dict(cast(Mapping[str, Any], decoded_signal_payload))
        if isinstance(decoded_signal_payload, Mapping)
        else {}
    )
    hpairs_features = _decode_value(payload.get("hpairs_features") or {})
    if (
        isinstance(hpairs_features, Mapping)
        and hpairs_features
        and "hpairs_replay_tape_features" not in signal_payload
    ):
        signal_payload["hpairs_replay_tape_features"] = dict(
            cast(Mapping[str, Any], hpairs_features)
        )
    return SignalEnvelope(
        event_ts=_parse_datetime(str(payload["event_ts"])),
        symbol=str(payload["symbol"]),
        payload=signal_payload,
        timeframe=str(payload["timeframe"]) if payload.get("timeframe") else None,
        ingest_ts=_parse_datetime(str(ingest_ts)) if ingest_ts else None,
        seq=int(payload["seq"]) if payload.get("seq") is not None else None,
        source=str(payload["source"]) if payload.get("source") else None,
    )


def hpairs_replay_tape_features(signal: SignalEnvelope) -> dict[str, Any]:
    """Normalize H-PAIRS discovery features carried by a replay-tape row.

    The representation is deliberately metadata-only: it preserves ClusterLOB/
    OFI-style inputs for deterministic offline candidate narrowing, but marks
    every row as prefilter-only so a downstream consumer cannot treat it as
    runtime-ledger proof or promotion authority.
    """

    payload = signal.payload
    source_fields: set[str] = set()
    horizon_ofi = _hpairs_ofi_horizons(payload, source_fields=source_fields)
    decay_memory = _hpairs_ofi_decay_memory(payload, source_fields=source_fields)
    regime_tags = _tag_tuple(
        payload,
        ("regime_tags", "regime_tag", "market_regime", "liquidity_regime"),
        source_fields=source_fields,
    )
    stress_tags = _stress_tag_tuple(payload, source_fields=source_fields)
    cluster_lob = _hpairs_cluster_lob_payload(payload, source_fields=source_fields)
    ofi_memory_regime_slices = _hpairs_ofi_memory_regime_slices(
        horizon_ofi=horizon_ofi,
        decay_memory=decay_memory,
        regime_tags=regime_tags,
        stress_tags=stress_tags,
    )
    capacity_notional_lineage = _hpairs_capacity_notional_lineage(
        payload,
        source_fields=source_fields,
    )
    return {
        "schema_version": HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
        "feature_schema_hash": build_hpairs_replay_tape_feature_schema_hash(),
        "order_flow_imbalance_horizons": horizon_ofi,
        "ofi_decay_memory": decay_memory,
        "ofi_memory_regime_slices": ofi_memory_regime_slices,
        "cluster_lob": cluster_lob,
        "regime_tags": list(regime_tags),
        "stress_tags": list(stress_tags),
        "capacity_notional_lineage": capacity_notional_lineage,
        "source_fields": sorted(source_fields),
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "proof_semantics_label": (
            "hpairs_replay_tape_features_prefilter_only_exact_replay_and_runtime_ledger_required"
        ),
    }


def _canonical_row_json(signal: SignalEnvelope) -> str:
    return json.dumps(
        signal_to_tape_payload(signal),
        sort_keys=True,
        separators=(",", ":"),
    )


def _signal_sort_key(signal: SignalEnvelope) -> tuple[datetime, str, int]:
    seq = signal.seq if signal.seq is not None else 0
    return (signal.event_ts.astimezone(timezone.utc), signal.symbol.upper(), seq)


def _hpairs_ofi_horizons(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> dict[str, str]:
    horizons: dict[str, str] = {}
    for key in (
        "order_flow_imbalance_horizons",
        "ofi_horizons",
        "horizon_ofi",
        "ofi_by_horizon",
    ):
        raw = payload.get(key)
        if not isinstance(raw, Mapping):
            continue
        source_fields.add(key)
        for horizon, value in cast(Mapping[object, object], raw).items():
            parsed = _decimal_or_none(value)
            if parsed is not None:
                horizons[str(horizon)] = str(parsed)
    for key in (
        "ofi_pressure_score",
        "order_flow_imbalance",
        "ofi",
        "signed_order_flow_imbalance",
        "queue_imbalance",
        "book_imbalance",
        "depth_imbalance",
    ):
        parsed = _decimal_or_none(payload.get(key))
        if parsed is not None:
            source_fields.add(key)
            horizons.setdefault("instant", str(parsed))
            break
    for key, value in payload.items():
        text_key = str(key)
        if not (
            text_key.startswith("ofi_horizon_")
            or text_key.startswith("order_flow_imbalance_horizon_")
        ):
            continue
        parsed = _decimal_or_none(value)
        if parsed is None:
            continue
        source_fields.add(text_key)
        horizons[text_key.rsplit("_", 1)[-1]] = str(parsed)
    return dict(sorted(horizons.items()))


def _hpairs_ofi_decay_memory(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> dict[str, str]:
    memory: dict[str, str] = {}
    for key in (
        "ofi_decay_memory",
        "ofi_memory",
        "order_flow_memory",
        "ofi_decay",
    ):
        raw = payload.get(key)
        if not isinstance(raw, Mapping):
            continue
        source_fields.add(key)
        for name, value in cast(Mapping[object, object], raw).items():
            parsed = _decimal_or_none(value)
            if parsed is not None:
                memory[str(name)] = str(parsed)
    for key in (
        "ofi_decay_score",
        "ofi_memory_score",
        "ofi_ewma_short",
        "ofi_ewma_long",
    ):
        parsed = _decimal_or_none(payload.get(key))
        if parsed is None:
            continue
        source_fields.add(key)
        memory[key] = str(parsed)
    return dict(sorted(memory.items()))


def _hpairs_cluster_lob_payload(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> dict[str, Any]:
    label = _first_text(
        payload,
        (
            "cluster_lob_label",
            "cluster_label",
            "order_cluster",
            "lob_event_type",
            "event_type",
        ),
        source_fields=source_fields,
    )
    raw_bucket = _first_text(
        payload,
        (
            "cluster_lob_bucket",
            "cluster_bucket",
            "participant_bucket",
            "behavior_bucket",
        ),
        source_fields=source_fields,
    )
    behavior_bucket = raw_bucket or _cluster_lob_behavior_bucket(label)
    quote_behavior_bucket = _quote_behavior_bucket(payload, source_fields=source_fields)
    return {
        "label": label,
        "bucket": behavior_bucket,
        "source_bucket": raw_bucket,
        "behavior_bucket": behavior_bucket,
        "quote_behavior_bucket": quote_behavior_bucket,
        "bucket_policy": (
            "source_bucket"
            if raw_bucket
            else "deterministic_event_quote_behavior_fallback"
        ),
    }


def _cluster_lob_behavior_bucket(label: str | None) -> str:
    text = str(label or "").strip().lower()
    if not text:
        return "unknown"
    if any(token in text for token in ("buy", "bid", "lift", "add_bid")):
        return "aggressive_buy_pressure"
    if any(token in text for token in ("sell", "ask", "hit", "add_ask")):
        return "aggressive_sell_pressure"
    if any(token in text for token in ("cancel", "delete", "remove", "withdraw")):
        return "liquidity_withdrawal"
    if any(token in text for token in ("quote", "replace", "modify", "update")):
        return "quote_revision"
    if "trade" in text or "print" in text:
        return "trade_print"
    return text.replace(" ", "_")


def _quote_behavior_bucket(
    payload: Mapping[str, Any],
    *,
    source_fields: set[str],
) -> str:
    bid_size = _first_decimal_with_key(
        payload,
        (
            "bid_size",
            "bid_qty",
            "best_bid_size",
            "best_bid_qty",
            "bid_depth",
            "bid_volume",
        ),
    )
    ask_size = _first_decimal_with_key(
        payload,
        (
            "ask_size",
            "ask_qty",
            "best_ask_size",
            "best_ask_qty",
            "ask_depth",
            "ask_volume",
        ),
    )
    if bid_size[0] is None or ask_size[0] is None:
        return "quote_depth_missing"
    bid_value, bid_key = bid_size
    ask_value, ask_key = ask_size
    if bid_key is not None:
        source_fields.add(bid_key)
    if ask_key is not None:
        source_fields.add(ask_key)
    assert bid_value is not None
    assert ask_value is not None
    total = bid_value + ask_value
    if total <= 0:
        return "quote_depth_empty"
    imbalance = (bid_value - ask_value) / total
    if imbalance >= Decimal("0.20"):
        return "bid_depth_dominant"
    if imbalance <= Decimal("-0.20"):
        return "ask_depth_dominant"
    return "balanced_quote_depth"


def _hpairs_ofi_memory_regime_slices(
    *,
    horizon_ofi: Mapping[str, str],
    decay_memory: Mapping[str, str],
    regime_tags: Sequence[str],
    stress_tags: Sequence[str],
) -> dict[str, Any]:
    instant = _mean_decimal_for_keys(horizon_ofi, ("instant", "1", "1_events"))
    short = _mean_decimal_for_token(horizon_ofi, ("short", "3", "5"))
    medium = _mean_decimal_for_token(horizon_ofi, ("medium", "12", "15"))
    long = _mean_decimal_for_token(horizon_ofi, ("long", "36", "60"))
    all_horizon_mean = _mean_decimal(horizon_ofi.values())
    instant = instant if instant is not None else all_horizon_mean
    short = short if short is not None else instant
    medium = medium if medium is not None else short
    long = long if long is not None else medium
    memory_score = _mean_decimal(decay_memory.values())
    if memory_score is None:
        memory_score = _mean_decimal(
            value for value in (short, medium, long) if value is not None
        )
    bounded_memory_score = _bounded_decimal(memory_score or Decimal("0"))
    shock_score = _bounded_decimal((short or Decimal("0")) - (long or Decimal("0")))
    directional_alignment = _bounded_decimal(
        Decimal("0.60") * shock_score + Decimal("0.40") * bounded_memory_score
    )
    return {
        "schema_version": HPAIRS_OFI_MEMORY_REGIME_SCHEMA_VERSION,
        "horizons": {
            "instant": _decimal_text(instant or Decimal("0")),
            "short": _decimal_text(short or Decimal("0")),
            "medium": _decimal_text(medium or Decimal("0")),
            "long": _decimal_text(long or Decimal("0")),
        },
        "memory_score": _decimal_text(bounded_memory_score),
        "shock_score": _decimal_text(shock_score),
        "directional_alignment_score": _decimal_text(directional_alignment),
        "regime_bucket": _ofi_regime_bucket(
            memory_score=bounded_memory_score,
            shock_score=shock_score,
            regime_tags=regime_tags,
            stress_tags=stress_tags,
        ),
        "regime_tags": list(regime_tags),
        "stress_tags": list(stress_tags),
        "prefilter_only": True,
        "proof_authority": False,
        "promotion_authority": False,
    }


def _ofi_regime_bucket(
    *,
    memory_score: Decimal,
    shock_score: Decimal,
    regime_tags: Sequence[str],
    stress_tags: Sequence[str],
) -> str:
    if stress_tags:
        return "stress_veto_window"
    tags = {str(tag).strip().lower() for tag in regime_tags}
    if any("wide" in tag or "illiquid" in tag for tag in tags):
        return "wide_spread_liquidity_regime"
    if any("tight" in tag or "liquid" in tag for tag in tags):
        return "tight_spread_liquidity_regime"
    if shock_score >= Decimal("0.20"):
        return "positive_ofi_shock"
    if shock_score <= Decimal("-0.20"):
        return "negative_ofi_shock"
    if memory_score >= Decimal("0.20"):
        return "positive_ofi_memory"
    if memory_score <= Decimal("-0.20"):
        return "negative_ofi_memory"
    return "balanced_ofi_memory"


def _mean_decimal_for_keys(
    values: Mapping[str, str],
    keys: Sequence[str],
) -> Decimal | None:
    wanted = {str(key).lower() for key in keys}
    return _mean_decimal(
        value for key, value in values.items() if str(key).strip().lower() in wanted
    )


def _mean_decimal_for_token(
    values: Mapping[str, str],
    tokens: Sequence[str],
) -> Decimal | None:
    lowered_tokens = tuple(str(token).lower() for token in tokens)
    return _mean_decimal(
        value
        for key, value in values.items()
        if any(
            _horizon_key_matches_token(str(key).strip().lower(), token)
            for token in lowered_tokens
        )
    )


def _horizon_key_matches_token(key: str, token: str) -> bool:
    if key == token:
        return True
    if token in {"short", "medium", "long"}:
        return token in key
    return key.startswith(f"{token}_") or key.startswith(f"{token}-")


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
