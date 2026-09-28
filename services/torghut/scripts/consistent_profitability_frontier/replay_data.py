#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

import contextlib
import heapq
from datetime import date, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence, cast
from unittest.mock import patch

import yaml

from app.trading.discovery.dataset_snapshot import (
    DatasetSnapshotReceipt,
    DatasetWitness,
)
from app.trading.discovery.replay_tape import (
    ReplayTape,
    load_replay_tape,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.search_profitability_frontier import (
    apply_candidate_to_configmap,
)


from scripts.consistent_profitability_frontier.candidate_generation import (
    _candidate_symbols,
    _strategy_universe_symbols,
)

_LOCAL_ONLY_OVERRIDE_KEYS = frozenset({"normalization_regime"})


def _resolve_prefetch_symbols(
    *,
    cli_symbols: tuple[str, ...],
    override_candidates: Iterable[Mapping[str, Any]],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    if cli_symbols:
        return cli_symbols
    ordered: list[str] = []
    seen: set[str] = set()
    for candidate in override_candidates:
        for symbol in _candidate_symbols(cli_symbols=(), strategy_overrides=candidate):
            if symbol in seen:
                continue
            seen.add(symbol)
            ordered.append(symbol)
    if ordered:
        return tuple(ordered)
    return _strategy_universe_symbols(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
    )


def _prefetch_signal_rows(
    *,
    strategy_configmap_path: Path,
    clickhouse_http_url: str,
    clickhouse_username: str | None,
    clickhouse_password: str | None,
    start_date: date,
    end_date: date,
    start_equity: Decimal,
    chunk_minutes: int,
    symbols: tuple[str, ...],
    progress_log_interval_seconds: int,
) -> list[Any]:
    config = replay_mod.ReplayConfig(
        strategy_configmap_path=strategy_configmap_path,
        clickhouse_http_url=clickhouse_http_url,
        clickhouse_username=clickhouse_username,
        clickhouse_password=clickhouse_password,
        start_date=start_date,
        end_date=end_date,
        chunk_minutes=chunk_minutes,
        flatten_eod=True,
        start_equity=start_equity,
        symbols=symbols,
        progress_log_interval_seconds=progress_log_interval_seconds,
    )
    rows = list(replay_mod._iter_signal_rows(config))
    rows.sort(key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
    return rows


def _cached_iter_signal_rows_factory(
    rows: list[Any],
) -> Callable[[replay_mod.ReplayConfig], Iterator[Any]]:
    rows_by_day: dict[date, list[tuple[int, Any]]] = {}
    rows_by_day_symbol: dict[date, dict[str, list[tuple[int, Any]]]] = {}
    for index, row in enumerate(rows):
        signal_day = row.event_ts.date()
        indexed_row = (index, row)
        rows_by_day.setdefault(signal_day, []).append(indexed_row)
        rows_by_day_symbol.setdefault(signal_day, {}).setdefault(
            str(row.symbol).upper(), []
        ).append(indexed_row)

    def _iter_signal_rows(config: replay_mod.ReplayConfig) -> Iterator[Any]:
        selected_symbols = (
            {symbol.upper() for symbol in config.symbols} if config.symbols else None
        )
        if config.start_date > config.end_date:
            return
        for day_offset in range((config.end_date - config.start_date).days + 1):
            signal_day = config.start_date + timedelta(days=day_offset)
            if selected_symbols is None:
                for _, row in rows_by_day.get(signal_day, ()):
                    yield row
                continue
            day_symbols = rows_by_day_symbol.get(signal_day)
            if not day_symbols:
                continue
            symbol_rows = [
                iter(day_symbols[symbol])
                for symbol in selected_symbols
                if symbol in day_symbols
            ]
            for _, row in heapq.merge(*symbol_rows, key=lambda item: item[0]):
                yield row

    return _iter_signal_rows


@contextlib.contextmanager
def _cached_signal_rows_patch(rows: list[Any]) -> Iterator[None]:
    with patch.object(
        replay_mod,
        "_iter_signal_rows",
        _cached_iter_signal_rows_factory(rows),
    ):
        yield


def _load_replay_tape_rows(
    *,
    tape_path: Path,
    manifest_path: Path | None,
    start_date: date,
    end_date: date,
    symbols: tuple[str, ...],
    allow_stale_tape: bool,
    tape: ReplayTape | None = None,
) -> tuple[list[Any], dict[str, Any]]:
    loaded_tape = tape or load_replay_tape(tape_path, manifest_path=manifest_path)
    validation = validate_tape_freshness(
        loaded_tape.manifest,
        start_date=start_date,
        end_date=end_date,
        symbols=symbols,
        allow_stale_tape=allow_stale_tape,
    )
    rows = slice_tape_by_window(
        loaded_tape.rows,
        start_date=start_date,
        end_date=end_date,
    )
    rows = slice_tape_by_symbols(rows, symbols=symbols)
    validation["tape_path"] = str(tape_path)
    validation["manifest_path"] = str(manifest_path) if manifest_path else ""
    validation["selected_row_count"] = len(rows)
    validation["selected_symbols"] = sorted({row.symbol.upper() for row in rows})
    validation["source_query_digest"] = loaded_tape.manifest.source_query_digest
    validation["manifest_start_date"] = loaded_tape.manifest.start_date.isoformat()
    validation["manifest_end_date"] = loaded_tape.manifest.end_date.isoformat()
    validation["row_symbols"] = list(loaded_tape.manifest.row_symbols)
    validation["source_table_versions"] = dict(
        loaded_tape.manifest.source_table_versions
    )
    validation["artifact_refs"] = dict(loaded_tape.manifest.artifact_refs)
    return list(rows), validation


def _replay_tape_trading_days(tape: ReplayTape) -> tuple[date, ...]:
    return tuple(
        sorted({row.event_ts.astimezone(timezone.utc).date() for row in tape.rows})
    )


def _build_replay_tape_snapshot_receipt(
    *,
    validation: Mapping[str, Any],
    rows: Sequence[Any],
    start_day: date,
    end_day: date,
    expected_last_trading_day: date,
    expected_trading_days: Sequence[date],
    allow_stale_tape: bool,
) -> DatasetSnapshotReceipt:
    observed_days = _replay_tape_row_days(rows)
    observed_day_set = set(observed_days)
    missing_days = tuple(
        day for day in expected_trading_days if day not in observed_day_set
    )
    latest_observed_day = observed_days[-1] if observed_days else start_day
    is_fresh = (
        str(validation.get("status") or "") == "valid"
        and latest_observed_day >= expected_last_trading_day
        and not missing_days
    )
    snapshot_id = str(validation.get("dataset_snapshot_ref") or "").strip()
    if not snapshot_id:
        snapshot_id = f"replay-tape-{str(validation.get('content_sha256') or '')[:24]}"
    return DatasetSnapshotReceipt(
        snapshot_id=snapshot_id,
        source="replay_tape",
        window_size="PT1S",
        start_day=start_day,
        end_day=end_day,
        expected_last_trading_day=expected_last_trading_day,
        is_fresh=is_fresh,
        missing_days=missing_days,
        row_count=len(rows),
        stale_override_used=bool(validation.get("stale_override_used"))
        or (allow_stale_tape and not is_fresh),
        witnesses=(
            DatasetWitness(
                name="replay_tape_manifest",
                payload={
                    "dataset_snapshot_ref": str(
                        validation.get("dataset_snapshot_ref") or ""
                    ),
                    "content_sha256": str(validation.get("content_sha256") or ""),
                    "source_query_digest": str(
                        validation.get("source_query_digest") or ""
                    ),
                    "manifest_start_date": str(
                        validation.get("manifest_start_date") or ""
                    ),
                    "manifest_end_date": str(validation.get("manifest_end_date") or ""),
                    "row_count": int(validation.get("row_count") or 0),
                    "trading_day_count": int(validation.get("trading_day_count") or 0),
                    "requested_trading_days": list(
                        cast(
                            Sequence[Any],
                            validation.get("requested_trading_days") or [],
                        )
                    ),
                    "observed_trading_days": list(
                        cast(
                            Sequence[Any],
                            validation.get("observed_trading_days") or [],
                        )
                    ),
                    "missing_trading_days": list(
                        cast(
                            Sequence[Any],
                            validation.get("missing_trading_days") or [],
                        )
                    ),
                    "row_count_by_trading_day": dict(
                        cast(
                            Mapping[str, Any],
                            validation.get("row_count_by_trading_day") or {},
                        )
                    ),
                    "missing_symbol_trading_days": list(
                        cast(
                            Sequence[Any],
                            validation.get("missing_symbol_trading_days") or [],
                        )
                    ),
                    "row_count_by_symbol_trading_day": dict(
                        cast(
                            Mapping[str, Any],
                            validation.get("row_count_by_symbol_trading_day") or {},
                        )
                    ),
                    "coverage_status": str(validation.get("coverage_status") or ""),
                    "source_table_versions": dict(
                        cast(
                            Mapping[str, Any],
                            validation.get("source_table_versions") or {},
                        )
                    ),
                    "artifact_refs": dict(
                        cast(Mapping[str, Any], validation.get("artifact_refs") or {})
                    ),
                    "point_in_time_receipt": dict(
                        cast(
                            Mapping[str, Any],
                            validation.get("point_in_time_receipt") or {},
                        )
                    ),
                },
            ),
            DatasetWitness(
                name="replay_tape_selected_rows",
                payload={
                    "row_count": len(rows),
                    "observed_days": [item.isoformat() for item in observed_days],
                    "missing_days": [item.isoformat() for item in missing_days],
                    "selected_symbols": list(
                        cast(Sequence[Any], validation.get("selected_symbols") or [])
                    ),
                    "status": str(validation.get("status") or ""),
                    "reasons": list(
                        cast(Sequence[Any], validation.get("reasons") or [])
                    ),
                },
            ),
        ),
    )


def _replay_tape_row_days(rows: Iterable[Any]) -> tuple[date, ...]:
    return tuple(sorted({row.event_ts.astimezone(timezone.utc).date() for row in rows}))


def apply_candidate_to_configmap_with_overrides(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
    candidate_params: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    disable_other_strategies: bool,
) -> dict[str, Any]:
    candidate_params = dict(candidate_params)
    if disable_other_strategies:
        candidate_params.setdefault("position_isolation_mode", "per_strategy")
    root = apply_candidate_to_configmap(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
        candidate_params=candidate_params,
        disable_other_strategies=disable_other_strategies,
    )
    if not strategy_overrides:
        return root

    data = root.get("data")
    if not isinstance(data, dict):
        raise ValueError("strategy_configmap_missing_data")
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        raise ValueError("strategy_configmap_missing_strategies_yaml")
    catalog = yaml.safe_load(strategies_yaml)
    if not isinstance(catalog, dict):
        raise ValueError("strategy_catalog_not_mapping")
    strategies = catalog.get("strategies")
    if not isinstance(strategies, list):
        raise ValueError("strategy_catalog_missing_strategies")

    matched = False
    for item in strategies:
        if not isinstance(item, dict):
            continue
        item_name = str(item.get("name") or "").strip()
        if item_name != strategy_name:
            continue
        matched = True
        for key, value in strategy_overrides.items():
            if key == "params":
                raise ValueError("strategy_override_key_reserved:params")
            if key in _LOCAL_ONLY_OVERRIDE_KEYS:
                continue
            item[key] = value
        break
    if not matched:
        raise ValueError(f"strategy_not_found:{strategy_name}")

    data["strategies.yaml"] = yaml.safe_dump(catalog, sort_keys=False)
    return root


__all__ = [
    "_resolve_prefetch_symbols",
    "_prefetch_signal_rows",
    "_cached_iter_signal_rows_factory",
    "_cached_signal_rows_patch",
    "_load_replay_tape_rows",
    "_replay_tape_trading_days",
    "_build_replay_tape_snapshot_receipt",
    "_replay_tape_row_days",
    "apply_candidate_to_configmap_with_overrides",
]
