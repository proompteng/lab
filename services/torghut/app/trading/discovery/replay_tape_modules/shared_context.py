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


__all__ = [name for name in globals() if not name.startswith("__")]
