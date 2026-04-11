"""MLX-oriented snapshot manifest helpers for local autoresearch."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from decimal import Decimal
from typing import Any, Iterable, Mapping, cast

from app.trading.discovery.autoresearch import SnapshotPolicy, StrategyAutoresearchProgram


def _stable_hash(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()


def _string(value: Any) -> str:
    return str(value or '').strip()


def _string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    raw_values = cast(list[Any], value)
    return tuple(_string(item) for item in raw_values if _string(item))


def _json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Mapping):
        mapping_value = cast(Mapping[Any, Any], value)
        return {str(key): _json_safe(item) for key, item in mapping_value.items()}
    if isinstance(value, tuple):
        tuple_value = cast(tuple[Any, ...], value)
        return [_json_safe(item) for item in tuple_value]
    if isinstance(value, list):
        list_value = cast(list[Any], value)
        return [_json_safe(item) for item in list_value]
    return value


@dataclass(frozen=True)
class MlxSignalBundleStats:
    path: str
    row_count: int
    symbol_count: int
    first_event_ts: str
    last_event_ts: str

    def to_payload(self) -> dict[str, Any]:
        return {
            'path': self.path,
            'row_count': self.row_count,
            'symbol_count': self.symbol_count,
            'first_event_ts': self.first_event_ts,
            'last_event_ts': self.last_event_ts,
        }


@dataclass(frozen=True)
class MlxSnapshotManifest:
    snapshot_id: str
    created_at: str
    source_window_start: str
    source_window_end: str
    train_days: int
    holdout_days: int
    full_window_days: int
    symbols: tuple[str, ...]
    bar_interval: str
    quote_quality_policy_id: str
    feature_set_id: str
    cross_sectional_feature_flags: Mapping[str, bool]
    prior_day_feature_flags: Mapping[str, bool]
    tape_freshness_receipts: tuple[Mapping[str, Any], ...]
    row_counts: Mapping[str, int]
    tensor_bundle_paths: Mapping[str, str]
    manifest_hash: str

    def to_payload(self) -> dict[str, Any]:
        return {
            'snapshot_id': self.snapshot_id,
            'created_at': self.created_at,
            'source_window_start': self.source_window_start,
            'source_window_end': self.source_window_end,
            'train_days': self.train_days,
            'holdout_days': self.holdout_days,
            'full_window_days': self.full_window_days,
            'symbols': list(self.symbols),
            'bar_interval': self.bar_interval,
            'quote_quality_policy_id': self.quote_quality_policy_id,
            'feature_set_id': self.feature_set_id,
            'cross_sectional_feature_flags': dict(self.cross_sectional_feature_flags),
            'prior_day_feature_flags': dict(self.prior_day_feature_flags),
            'tape_freshness_receipts': [dict(item) for item in self.tape_freshness_receipts],
            'row_counts': dict(self.row_counts),
            'tensor_bundle_paths': dict(self.tensor_bundle_paths),
            'manifest_hash': self.manifest_hash,
        }


def build_mlx_snapshot_manifest(
    *,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    symbols: str,
    train_days: int,
    holdout_days: int,
    full_window_start_date: str,
    full_window_end_date: str,
    tensor_bundle_paths: Mapping[str, str] | None = None,
    tape_freshness_receipts: tuple[Mapping[str, Any], ...] = (),
    row_counts: Mapping[str, int] | None = None,
) -> MlxSnapshotManifest:
    resolved_tensor_bundle_paths = dict(tensor_bundle_paths or {})
    resolved_row_counts = dict(row_counts or {})
    payload = {
        'runner_run_id': runner_run_id,
        'program_id': program.program_id,
        'symbols': list(_string_list(symbols.split(','))) if symbols else [],
        'source_window_start': _string(full_window_start_date),
        'source_window_end': _string(full_window_end_date),
        'train_days': int(train_days),
        'holdout_days': int(holdout_days),
        'full_window_days': int(max(1, train_days) + max(1, holdout_days)),
        'snapshot_policy': program.snapshot_policy.to_payload(),
        'tensor_bundle_paths': resolved_tensor_bundle_paths,
        'tape_freshness_receipts': [dict(item) for item in tape_freshness_receipts],
        'row_counts': resolved_row_counts,
    }
    manifest_hash = _stable_hash(payload)
    policy: SnapshotPolicy = program.snapshot_policy
    return MlxSnapshotManifest(
        snapshot_id=f'mlx-snap-{manifest_hash[:24]}',
        created_at=datetime.now(UTC).isoformat(),
        source_window_start=_string(full_window_start_date),
        source_window_end=_string(full_window_end_date),
        train_days=int(train_days),
        holdout_days=int(holdout_days),
        full_window_days=int(max(1, train_days) + max(1, holdout_days)),
        symbols=tuple(_string_list(symbols.split(','))) if symbols else (),
        bar_interval=policy.bar_interval,
        quote_quality_policy_id=policy.quote_quality_policy_id,
        feature_set_id=policy.feature_set_id,
        cross_sectional_feature_flags={
            'allow_cross_sectional_features': bool(policy.allow_cross_sectional_features),
        },
        prior_day_feature_flags={
            'allow_prior_day_features': bool(policy.allow_prior_day_features),
        },
        tape_freshness_receipts=tape_freshness_receipts,
        row_counts=resolved_row_counts,
        tensor_bundle_paths=resolved_tensor_bundle_paths,
        manifest_hash=manifest_hash,
    )


def write_mlx_snapshot_manifest(path: Path, manifest: MlxSnapshotManifest) -> Path:
    path.write_text(json.dumps(manifest.to_payload(), indent=2, sort_keys=True), encoding='utf-8')
    return path


def write_mlx_signal_bundle(path: Path, rows: Iterable[Any]) -> MlxSignalBundleStats:
    row_count = 0
    symbols: set[str] = set()
    first_event_ts = ''
    last_event_ts = ''
    with path.open('w', encoding='utf-8', buffering=1) as handle:
        for row in rows:
            event_ts = _string(getattr(row, 'event_ts', ''))
            symbol = _string(getattr(row, 'symbol', '')).upper()
            payload = {
                'event_ts': event_ts,
                'symbol': symbol,
                'seq': getattr(row, 'seq', None),
                'timeframe': _string(getattr(row, 'timeframe', '')),
                'source': _string(getattr(row, 'source', '')),
                'payload': _json_safe(getattr(row, 'payload', {})),
            }
            handle.write(json.dumps(payload, sort_keys=True) + '\n')
            row_count += 1
            if symbol:
                symbols.add(symbol)
            if event_ts and not first_event_ts:
                first_event_ts = event_ts
            if event_ts:
                last_event_ts = event_ts
    return MlxSignalBundleStats(
        path=str(path),
        row_count=row_count,
        symbol_count=len(symbols),
        first_event_ts=first_event_ts,
        last_event_ts=last_event_ts,
    )
