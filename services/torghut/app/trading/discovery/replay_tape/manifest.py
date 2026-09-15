"""Replay-tape manifest model and backward-compatible decoding."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import cast

from .point_in_time import PointInTimeDataReceipt


REPLAY_TAPE_MANIFEST_SCHEMA_VERSION = "torghut.replay-tape-manifest.v2"
LEGACY_REPLAY_TAPE_MANIFEST_SCHEMA_VERSION = "torghut.replay-tape-manifest.v1"


def _empty_int_mapping() -> dict[str, int]:
    return {}


def _empty_nested_int_mapping() -> dict[str, dict[str, int]]:
    return {}


def _empty_string_mapping() -> dict[str, str]:
    return {}


def _string_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    items = cast(list[object] | tuple[object, ...], value)
    return tuple(str(item) for item in items)


def _date_tuple(value: object) -> tuple[date, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    items = cast(list[object] | tuple[object, ...], value)
    return tuple(date.fromisoformat(str(item)) for item in items)


def _string_mapping(value: object) -> Mapping[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): str(item)
        for key, item in cast(Mapping[object, object], value).items()
    }


def _int_mapping(value: object) -> Mapping[str, int]:
    if not isinstance(value, Mapping):
        return {}
    parsed: dict[str, int] = {}
    for key, item in cast(Mapping[object, object], value).items():
        try:
            parsed[str(key)] = int(str(item))
        except (TypeError, ValueError):
            continue
    return parsed


def _nested_int_mapping(value: object) -> Mapping[str, Mapping[str, int]]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): _int_mapping(item)
        for key, item in cast(Mapping[object, object], value).items()
    }


def _parse_datetime(value: object) -> datetime:
    parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


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
    point_in_time_receipt: PointInTimeDataReceipt | None = None
    feature_schema_hash: str = ""
    cost_model_hash: str = ""
    strategy_family: str = ""
    replay_cache_key: str = ""
    feature_versions: Mapping[str, str] = field(default_factory=_empty_string_mapping)
    requested_trading_days: tuple[date, ...] = ()
    observed_trading_days: tuple[date, ...] = ()
    missing_trading_days: tuple[date, ...] = ()
    row_count_by_trading_day: Mapping[str, int] = field(
        default_factory=_empty_int_mapping
    )
    missing_symbol_trading_days: tuple[str, ...] = ()
    row_count_by_symbol_trading_day: Mapping[str, Mapping[str, int]] = field(
        default_factory=_empty_nested_int_mapping
    )

    def to_payload(self) -> dict[str, object]:
        from .shared_context import (
            build_replay_tape_cache_identity_diagnostics,
            coverage_status,
        )

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
            if self.min_event_ts
            else None,
            "max_event_ts": self.max_event_ts.isoformat()
            if self.max_event_ts
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
            "cache_identity": build_replay_tape_cache_identity_diagnostics(
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
            ),
            "artifact_refs": dict(self.artifact_refs),
            "source_table_versions": dict(self.source_table_versions),
            "point_in_time_receipt": (
                self.point_in_time_receipt.to_payload()
                if self.point_in_time_receipt is not None
                else None
            ),
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
            "coverage_status": coverage_status(
                missing_trading_days=self.missing_trading_days,
                missing_symbol_trading_days=self.missing_symbol_trading_days,
            ),
        }

    def cache_identity_diagnostics(self) -> dict[str, object]:
        from .shared_context import build_replay_tape_cache_identity_diagnostics

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
    def from_payload(cls, payload: Mapping[str, object]) -> "ReplayTapeManifest":
        schema_version = str(payload.get("schema_version") or "")
        if schema_version not in {
            LEGACY_REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
            REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
        }:
            raise ValueError(f"replay_tape_manifest_schema_invalid:{schema_version}")
        raw_receipt = payload.get("point_in_time_receipt")
        return cls(
            schema_version=schema_version,
            dataset_snapshot_ref=str(payload.get("dataset_snapshot_ref") or ""),
            symbols=_string_tuple(payload.get("symbols")),
            row_symbols=_string_tuple(payload.get("row_symbols")),
            start_date=date.fromisoformat(str(payload["start_date"])),
            end_date=date.fromisoformat(str(payload["end_date"])),
            start_ts=_parse_datetime(payload["start_ts"]),
            end_ts=_parse_datetime(payload["end_ts"]),
            min_event_ts=_parse_datetime(payload["min_event_ts"])
            if payload.get("min_event_ts")
            else None,
            max_event_ts=_parse_datetime(payload["max_event_ts"])
            if payload.get("max_event_ts")
            else None,
            trading_day_count=int(str(payload.get("trading_day_count") or 0)),
            row_count=int(str(payload.get("row_count") or 0)),
            source_query_digest=str(payload.get("source_query_digest") or ""),
            content_sha256=str(payload.get("content_sha256") or ""),
            feature_schema_hash=str(payload.get("feature_schema_hash") or ""),
            cost_model_hash=str(payload.get("cost_model_hash") or ""),
            strategy_family=str(payload.get("strategy_family") or ""),
            replay_cache_key=str(payload.get("replay_cache_key") or ""),
            feature_versions=_string_mapping(payload.get("feature_versions")),
            artifact_refs=_string_mapping(payload.get("artifact_refs")),
            source_table_versions=_string_mapping(payload.get("source_table_versions")),
            created_at=_parse_datetime(payload["created_at"]),
            point_in_time_receipt=(
                PointInTimeDataReceipt.from_payload(
                    cast(Mapping[str, object], raw_receipt)
                )
                if isinstance(raw_receipt, Mapping)
                else None
            ),
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


__all__ = [
    "LEGACY_REPLAY_TAPE_MANIFEST_SCHEMA_VERSION",
    "REPLAY_TAPE_MANIFEST_SCHEMA_VERSION",
    "ReplayTapeManifest",
]
