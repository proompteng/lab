#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

import itertools
import json
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping

import yaml


from scripts.consistent_profitability_frontier.common import (
    _replay_tape_selection_metadata,
)

from scripts.consistent_profitability_frontier.candidate_loading import (
    FrontierReplayWindows,
    _WorklistItem,
    _stable_payload_hash,
)

_LOCAL_ONLY_OVERRIDE_KEYS = frozenset({"normalization_regime"})


def _iter_strategy_override_candidates(
    strategy_override_grid: Mapping[str, Iterable[Any]] | None,
) -> list[dict[str, Any]]:
    if strategy_override_grid is None:
        return [{}]
    return list(_iter_parameter_candidates(strategy_override_grid))


def _candidate_record_seed(
    *,
    path: Path,
    strategy_name: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"candidate_record_not_mapping:{path}")
    raw_strategy = payload.get("candidate_strategy")
    if not isinstance(raw_strategy, Mapping):
        raise ValueError(f"candidate_record_missing_candidate_strategy:{path}")
    record_strategy_name = str(raw_strategy.get("strategy_name") or "").strip()
    if record_strategy_name and record_strategy_name != strategy_name:
        raise ValueError(
            f"candidate_record_strategy_mismatch:{path}:{record_strategy_name}!={strategy_name}"
        )

    params: dict[str, Any] = {}
    raw_params = raw_strategy.get("params")
    if isinstance(raw_params, Mapping):
        params.update({str(key): value for key, value in raw_params.items()})

    overrides: dict[str, Any] = {}
    for key in (
        "universe_symbols",
        "max_notional_per_trade",
        "max_position_pct_equity",
    ):
        value = raw_strategy.get(key)
        if value is not None:
            overrides[key] = value

    if not params and not overrides:
        raise ValueError(f"candidate_record_empty_candidate_strategy:{path}")
    return params, overrides


def _load_candidate_record_seeds(
    *,
    paths: Iterable[Path],
    strategy_name: str,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    return [
        _candidate_record_seed(path=Path(path), strategy_name=strategy_name)
        for path in paths
    ]


def _parameter_grid_items(
    parameter_grid: Mapping[str, Iterable[Any]],
) -> list[tuple[str, list[Any]]]:
    items: list[tuple[str, list[Any]]] = []
    for key, values in parameter_grid.items():
        if isinstance(values, (str, bytes)):
            raise ValueError(f"parameter_values_not_sequence:{key}")
        if isinstance(values, Mapping):
            raise ValueError(f"parameter_values_not_sequence:{key}")
        if not isinstance(values, Iterable):
            raise ValueError(f"parameter_values_not_iterable:{key}")
        items.append((str(key), list(values)))
    return items


def _parameter_exploration_priority(name: str) -> int:
    lowered = name.lower()
    if lowered in {
        "rank_feature",
        "rank_count",
        "selection_mode",
        "signal_motif",
        "top_n",
    } or any(
        token in lowered
        for token in (
            "entry_minute",
            "exit_minute",
            "entry_window",
        )
    ):
        return 0
    if any(
        token in lowered
        for token in ("imbalance", "microprice", "recent_above", "spread", "quote")
    ):
        return 1
    if any(
        token in lowered
        for token in (
            "cross_section",
            "session_open",
            "opening_window",
            "range_position",
            "price_vs_vwap",
            "price_vs_opening",
            "price_above_ema",
            "entry_start",
            "entry_end",
        )
    ):
        return 2
    if any(
        token in lowered
        for token in ("bullish_hist", "bull_rsi", "vol_floor", "vol_ceil")
    ):
        return 3
    if any(
        token in lowered
        for token in ("universe_symbols", "max_notional", "position_pct")
    ):
        return 4
    if any(
        token in lowered
        for token in (
            "stop",
            "trailing",
            "flatten",
            "cooldown",
            "max_entries",
            "max_concurrent",
        )
    ):
        return 5
    return 6


def _candidate_payload_key(candidate: Mapping[str, Any]) -> str:
    return json.dumps(candidate, sort_keys=True, default=str)


def _iter_parameter_candidates(
    parameter_grid: Mapping[str, Iterable[Any]],
) -> Iterator[dict[str, Any]]:
    items = _parameter_grid_items(parameter_grid)
    if not items:
        yield {}
        return
    base_candidate = {name: values[0] for name, values in items if values}
    seen_candidates: set[str] = set()

    def emit(candidate: Mapping[str, Any]) -> dict[str, Any] | None:
        key = _candidate_payload_key(candidate)
        if key in seen_candidates:
            return None
        seen_candidates.add(key)
        return dict(candidate)

    emitted = emit(base_candidate)
    if emitted is not None:
        yield emitted

    priority_items = sorted(
        enumerate(items),
        key=lambda item: (_parameter_exploration_priority(item[1][0]), item[0]),
    )
    for _index, (name, values) in priority_items:
        for value in values[1:]:
            candidate = dict(base_candidate)
            candidate[name] = value
            emitted = emit(candidate)
            if emitted is not None:
                yield emitted

    names = [name for name, _ in items]
    value_sets = [values for _, values in items]
    for combination in itertools.product(*value_sets):
        candidate = {
            name: value for name, value in zip(names, combination, strict=True)
        }
        emitted = emit(candidate)
        if emitted is not None:
            yield emitted


def _iter_initial_worklist_candidates(
    *,
    parameter_grid: Mapping[str, Iterable[Any]],
    override_candidates: Iterable[Mapping[str, Any]],
    seed_candidates: Iterable[tuple[Mapping[str, Any], Mapping[str, Any]]] = (),
) -> Iterator[_WorklistItem]:
    for params_candidate, override_candidate in seed_candidates:
        yield _WorklistItem(
            params_candidate=dict(params_candidate),
            strategy_overrides=dict(override_candidate),
            candidate_record_seed=True,
        )
    for override_candidate in override_candidates:
        for params_candidate in _iter_parameter_candidates(parameter_grid):
            yield _WorklistItem(
                params_candidate=dict(params_candidate),
                strategy_overrides=dict(override_candidate),
            )


def _candidate_symbols(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
) -> tuple[str, ...]:
    if cli_symbols:
        return cli_symbols
    override_symbols = strategy_overrides.get("universe_symbols")
    if not isinstance(override_symbols, (list, tuple)):
        return ()
    values = tuple(
        str(item).strip().upper() for item in override_symbols if str(item).strip()
    )
    return values


def _strategy_universe_symbols(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    data = configmap_payload.get("data")
    if not isinstance(data, Mapping):
        return ()
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        return ()
    catalog = yaml.safe_load(strategies_yaml)
    if not isinstance(catalog, Mapping):
        return ()
    strategies = catalog.get("strategies")
    if not isinstance(strategies, list):
        return ()
    for item in strategies:
        if not isinstance(item, Mapping):
            continue
        if str(item.get("name") or "").strip() != strategy_name:
            continue
        raw_symbols = item.get("universe_symbols")
        if not isinstance(raw_symbols, (list, tuple)):
            return ()
        return tuple(
            str(symbol).strip().upper() for symbol in raw_symbols if str(symbol).strip()
        )
    return ()


def _candidate_universe_symbols(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[str, ...]:
    override_symbols = _candidate_symbols(
        cli_symbols=cli_symbols,
        strategy_overrides=strategy_overrides,
    )
    if override_symbols:
        return override_symbols
    if cli_symbols:
        return cli_symbols
    return _strategy_universe_symbols(
        configmap_payload=configmap_payload,
        strategy_name=strategy_name,
    )


def _candidate_search_key(
    *,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
) -> str:
    def _normalize(value: Any) -> Any:
        if isinstance(value, Mapping):
            return {
                str(key): _normalize(val)
                for key, val in sorted(value.items(), key=lambda item: str(item[0]))
            }
        if isinstance(value, tuple):
            return [_normalize(item) for item in value]
        if isinstance(value, list):
            return [_normalize(item) for item in value]
        return value

    return json.dumps(
        {
            "params": _normalize(params_candidate),
            "strategy_overrides": _normalize(
                {
                    str(key): value
                    for key, value in strategy_overrides.items()
                    if str(key) not in _LOCAL_ONLY_OVERRIDE_KEYS
                }
            ),
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _candidate_evaluation_key_payload(
    *,
    candidate_search_key: str,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    replay_lineage: Mapping[str, Any],
    replay_tape_validation: Mapping[str, Any] | None,
    window: FrontierReplayWindows,
    full_window_start: date,
    full_window_end: date,
    full_window_summary: Mapping[str, Any],
) -> dict[str, Any]:
    validation = dict(replay_tape_validation or {})
    payload: dict[str, Any] = {
        "schema_version": "torghut.candidate-evaluation-key.v1",
        "candidate_search_key": candidate_search_key,
        "candidate_params_sha256": _stable_payload_hash(params_candidate),
        "strategy_overrides_sha256": _stable_payload_hash(
            {
                str(key): value
                for key, value in strategy_overrides.items()
                if str(key) not in _LOCAL_ONLY_OVERRIDE_KEYS
            }
        ),
        "effective_strategy_config_sha256": str(
            replay_lineage.get("candidate_configmap_sha256") or ""
        ),
        "dataset_snapshot_id": str(replay_lineage.get("dataset_snapshot_id") or ""),
        "replay_lineage_hash": str(replay_lineage.get("lineage_hash") or ""),
        "replay_tape": _replay_tape_selection_metadata(validation),
        "replay_window_spec": {
            "train_start": window.train_start.isoformat(),
            "train_end": window.train_end.isoformat(),
            "holdout_start": window.holdout_start.isoformat(),
            "holdout_end": window.holdout_end.isoformat(),
            "second_oos_start": (
                window.second_oos_start.isoformat()
                if window.second_oos_start is not None
                else ""
            ),
            "second_oos_end": (
                window.second_oos_end.isoformat()
                if window.second_oos_end is not None
                else ""
            ),
            "full_window_start": full_window_start.isoformat(),
            "full_window_end": full_window_end.isoformat(),
        },
        "cost_model_signature": {
            "market_impact_stress_model": str(
                full_window_summary.get("market_impact_stress_model") or ""
            ),
            "market_impact_stress_cost_bps": str(
                full_window_summary.get("market_impact_stress_cost_bps") or "0"
            ),
            "delay_adjusted_depth_stress_model": str(
                full_window_summary.get("delay_adjusted_depth_stress_model") or ""
            ),
            "delay_adjusted_depth_stress_ms": str(
                full_window_summary.get("delay_adjusted_depth_stress_ms") or "0"
            ),
            "implementation_uncertainty_model": str(
                full_window_summary.get("implementation_uncertainty_model") or ""
            ),
        },
        "proof_basis_version": "post_cost_replay_net_pnl_with_cost_stress.v1",
    }
    payload["candidate_evaluation_key"] = _stable_payload_hash(payload)
    return payload


__all__ = [
    "_iter_strategy_override_candidates",
    "_candidate_record_seed",
    "_load_candidate_record_seeds",
    "_parameter_grid_items",
    "_parameter_exploration_priority",
    "_candidate_payload_key",
    "_iter_parameter_candidates",
    "_iter_initial_worklist_candidates",
    "_candidate_symbols",
    "_strategy_universe_symbols",
    "_candidate_universe_symbols",
    "_candidate_search_key",
    "_candidate_evaluation_key_payload",
]
