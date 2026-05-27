#!/usr/bin/env python3
"""Deterministically search Torghut replay configs on a 10d train / 5d holdout window."""

from __future__ import annotations

import argparse
import itertools
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Mapping, cast

import yaml

from app.trading.discovery.dataset_snapshot import resolve_expected_last_trading_day
from app.trading.reporting import (
    ProfitabilityConstraintPolicy,
    score_replay_profitability_candidate,
)
from scripts.local_intraday_tsmom_replay import (
    ReplayConfig,
    _http_query,
    default_strategy_configmap_path,
    run_replay,
)

_SWEEP_SCHEMA_VERSION = "torghut.replay-frontier-sweep.v1"
_REPLAY_SIGNAL_TABLE = "torghut.ta_signals"
_LOCAL_ONLY_STRATEGY_OVERRIDE_KEYS = frozenset({"normalization_regime"})


@dataclass(frozen=True)
class SweepWindow:
    train_days: tuple[date, ...]
    holdout_days: tuple[date, ...]

    @property
    def train_start(self) -> date:
        return self.train_days[0]

    @property
    def train_end(self) -> date:
        return self.train_days[-1]

    @property
    def holdout_start(self) -> date:
        return self.holdout_days[0]

    @property
    def holdout_end(self) -> date:
        return self.holdout_days[-1]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Search profitability frontier candidates using the local Torghut replay.",
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=default_strategy_configmap_path(),
    )
    parser.add_argument(
        "--sweep-config",
        type=Path,
        default=Path("config/trading/profitability-frontier-breakout.yaml"),
    )
    parser.add_argument(
        "--clickhouse-http-url",
        default=os.environ.get(
            "TA_CLICKHOUSE_URL",
            "http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        ),
    )
    parser.add_argument(
        "--clickhouse-username",
        default=os.environ.get(
            "TA_CLICKHOUSE_USERNAME",
            os.environ.get("CLICKHOUSE_USERNAME", "torghut"),
        ),
    )
    parser.add_argument(
        "--clickhouse-password",
        default=os.environ.get(
            "TA_CLICKHOUSE_PASSWORD",
            os.environ.get("CLICKHOUSE_PASSWORD", ""),
        ),
    )
    parser.add_argument("--start-equity", default="31590.02")
    parser.add_argument("--chunk-minutes", type=int, default=10)
    parser.add_argument("--symbols", default="")
    parser.add_argument("--progress-log-seconds", type=int, default=30)
    parser.add_argument("--train-days", type=int, default=10)
    parser.add_argument("--holdout-days", type=int, default=5)
    parser.add_argument("--top-n", type=int, default=10)
    parser.add_argument("--json-output", type=Path)
    return parser.parse_args()


def _resolve_recent_trading_days(
    *,
    clickhouse_http_url: str,
    clickhouse_username: str | None,
    clickhouse_password: str | None,
    limit: int,
    latest_trading_day: date | None = None,
) -> tuple[date, ...]:
    resolved_latest_day = latest_trading_day or resolve_expected_last_trading_day(
        explicit_day=None
    )
    raw = _http_query(
        url=clickhouse_http_url,
        username=clickhouse_username,
        password=clickhouse_password,
        query=(
            "SELECT DISTINCT toDate(event_ts) AS trading_day "
            f"FROM {_REPLAY_SIGNAL_TABLE} "
            "WHERE source = 'ta' "
            "  AND window_size = 'PT1S' "
            f"  AND toDate(event_ts) <= toDate('{resolved_latest_day.isoformat()}') "
            "ORDER BY trading_day DESC "
            f"LIMIT {max(1, int(limit))} "
            "FORMAT TSVRaw"
        ),
    )
    values = [
        date.fromisoformat(line.strip()) for line in raw.splitlines() if line.strip()
    ]
    values = [value for value in values if value <= resolved_latest_day]
    values.sort()
    return tuple(values)


def resolve_sweep_window(
    recent_days: Iterable[date],
    *,
    train_days: int,
    holdout_days: int,
) -> SweepWindow:
    ordered = sorted(dict.fromkeys(recent_days))
    required = max(1, train_days) + max(1, holdout_days)
    if len(ordered) < required:
        raise ValueError(f"insufficient_recent_trading_days:{len(ordered)}<{required}")
    selected = ordered[-required:]
    return SweepWindow(
        train_days=tuple(selected[:train_days]),
        holdout_days=tuple(selected[train_days:]),
    )


def _load_sweep_config(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("sweep_config_not_mapping")
    schema_version = str(payload.get("schema_version") or "").strip()
    if schema_version != _SWEEP_SCHEMA_VERSION:
        raise ValueError(f"sweep_config_schema_version_invalid:{schema_version}")
    return payload


def _optional_decimal_constraint(
    constraints: Mapping[str, Any], key: str, *, default: str | None = None
) -> Decimal | None:
    value = constraints.get(key, default)
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return Decimal(text)


def iter_parameter_candidates(
    parameter_grid: Mapping[str, Iterable[Any]],
) -> list[dict[str, Any]]:
    items = []
    for key, values in parameter_grid.items():
        if isinstance(values, (str, bytes)):
            raise ValueError(f"parameter_values_not_sequence:{key}")
        if isinstance(values, Mapping):
            raise ValueError(f"parameter_values_not_sequence:{key}")
        if not isinstance(values, Iterable):
            raise ValueError(f"parameter_values_not_iterable:{key}")
        value_list = list(values)
        items.append((str(key), value_list))
    if not items:
        return [{}]
    names = [name for name, _ in items]
    value_sets = [values for _, values in items]
    candidates: list[dict[str, Any]] = []
    for combination in itertools.product(*value_sets):
        candidates.append(
            {name: value for name, value in zip(names, combination, strict=True)}
        )
    return candidates


def _coerce_strategy_configmap_payload(
    configmap_payload: Mapping[str, Any],
) -> dict[str, Any]:
    root = json.loads(json.dumps(configmap_payload))
    if not isinstance(root, dict):
        raise ValueError("strategy_configmap_not_mapping")
    data = root.get("data")
    if isinstance(data, dict):
        return root
    if isinstance(root.get("strategies"), list):
        return {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {"name": "mounted-strategy-catalog"},
            "data": {"strategies.yaml": yaml.safe_dump(root, sort_keys=False)},
        }
    raise ValueError("strategy_configmap_missing_data")


def apply_candidate_to_configmap(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
    candidate_params: Mapping[str, Any],
    disable_other_strategies: bool,
    strategy_overrides: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    candidate_params = dict(candidate_params)
    strategy_overrides = dict(strategy_overrides or {})
    if disable_other_strategies:
        candidate_params.setdefault("position_isolation_mode", "per_strategy")
    root = _coerce_strategy_configmap_payload(configmap_payload)
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
        if item_name == strategy_name:
            params = item.setdefault("params", {})
            if not isinstance(params, dict):
                params = {}
                item["params"] = params
            params.update(dict(candidate_params))
            for key, value in strategy_overrides.items():
                if key == "params":
                    raise ValueError("strategy_override_key_reserved:params")
                if key in _LOCAL_ONLY_STRATEGY_OVERRIDE_KEYS:
                    continue
                item[key] = value
            item["enabled"] = True
            matched = True
        elif disable_other_strategies:
            item["enabled"] = False
    if not matched:
        raise ValueError(f"strategy_not_found:{strategy_name}")

    data["strategies.yaml"] = yaml.safe_dump(catalog, sort_keys=False)
    return root


def _build_replay_config(
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
    capture_trace_funnel: bool = False,
    capture_exact_replay_ledger: bool = False,
    replay_tape_path: Path | None = None,
    replay_tape_manifest_path: Path | None = None,
    allow_stale_tape: bool = False,
) -> ReplayConfig:
    return ReplayConfig(
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
        replay_tape_path=replay_tape_path,
        replay_tape_manifest_path=replay_tape_manifest_path,
        allow_stale_tape=allow_stale_tape,
        progress_log_interval_seconds=progress_log_interval_seconds,
        capture_trace_funnel=capture_trace_funnel,
        capture_exact_replay_ledger=capture_exact_replay_ledger,
        force_position_isolation=True,
    )


def main() -> int:
    args = _parse_args()
    sweep_config = _load_sweep_config(args.sweep_config.resolve())
    recent_days = _resolve_recent_trading_days(
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        limit=max(1, int(args.train_days)) + max(1, int(args.holdout_days)),
    )
    window = resolve_sweep_window(
        recent_days,
        train_days=max(1, int(args.train_days)),
        holdout_days=max(1, int(args.holdout_days)),
    )

    base_configmap = yaml.safe_load(
        args.strategy_configmap.resolve().read_text(encoding="utf-8")
    )
    if not isinstance(base_configmap, dict):
        raise ValueError("base_strategy_configmap_not_mapping")

    family = str(sweep_config.get("family") or "").strip()
    strategy_name = str(sweep_config.get("strategy_name") or "").strip()
    if not family or not strategy_name:
        raise ValueError("sweep_config_missing_family_or_strategy_name")
    disable_other_strategies = bool(sweep_config.get("disable_other_strategies", True))
    parameter_grid = sweep_config.get("parameters")
    if not isinstance(parameter_grid, Mapping):
        raise ValueError("sweep_config_parameters_not_mapping")
    strategy_override_grid = sweep_config.get("strategy_overrides") or {}
    if not isinstance(strategy_override_grid, Mapping):
        raise ValueError("sweep_config_strategy_overrides_not_mapping")
    strategy_override_candidates = (
        tuple(iter_parameter_candidates(strategy_override_grid))
        if strategy_override_grid
        else ({},)
    )

    constraints_value = sweep_config.get("constraints")
    if constraints_value is None:
        constraints: Mapping[str, Any] = {}
    elif isinstance(constraints_value, Mapping):
        constraints = cast(Mapping[str, Any], constraints_value)
    else:
        raise ValueError("sweep_config_constraints_not_mapping")
    policy = ProfitabilityConstraintPolicy(
        holdout_target_net_per_day=Decimal(
            str(constraints.get("holdout_target_net_per_day", "250"))
        ),
        min_active_holdout_days=int(constraints.get("min_active_holdout_days", 3)),
        max_worst_holdout_day_loss=Decimal(
            str(constraints.get("max_worst_holdout_day_loss", "150"))
        ),
        max_holdout_drawdown_pct_equity=_optional_decimal_constraint(
            constraints, "max_holdout_drawdown_pct_equity", default="0.05"
        ),
        min_holdout_p10_daily_net=_optional_decimal_constraint(
            constraints, "min_holdout_p10_daily_net"
        ),
        min_profit_factor=Decimal(str(constraints.get("min_profit_factor", "1.5"))),
        require_training_decisions=bool(
            constraints.get("require_training_decisions", True)
        ),
        require_holdout_decisions=bool(
            constraints.get("require_holdout_decisions", True)
        ),
    )
    symbols = tuple(
        symbol.strip().upper()
        for symbol in str(args.symbols or "").split(",")
        if symbol.strip()
    )
    scored = []

    with tempfile.TemporaryDirectory(
        prefix="torghut-profitability-frontier-"
    ) as tmpdir:
        root = Path(tmpdir)
        index = 0
        for candidate in iter_parameter_candidates(parameter_grid):
            for strategy_overrides in strategy_override_candidates:
                index += 1
                candidate_configmap = apply_candidate_to_configmap(
                    configmap_payload=base_configmap,
                    strategy_name=strategy_name,
                    candidate_params=candidate,
                    disable_other_strategies=disable_other_strategies,
                    strategy_overrides=strategy_overrides,
                )
                candidate_configmap_path = root / f"candidate-{index:04d}.yaml"
                candidate_configmap_path.write_text(
                    yaml.safe_dump(candidate_configmap, sort_keys=False),
                    encoding="utf-8",
                )

                train_payload = run_replay(
                    _build_replay_config(
                        strategy_configmap_path=candidate_configmap_path,
                        clickhouse_http_url=str(args.clickhouse_http_url),
                        clickhouse_username=(
                            str(args.clickhouse_username).strip() or None
                        ),
                        clickhouse_password=(
                            str(args.clickhouse_password).strip() or None
                        ),
                        start_date=window.train_start,
                        end_date=window.train_end,
                        start_equity=Decimal(str(args.start_equity)),
                        chunk_minutes=max(1, int(args.chunk_minutes)),
                        symbols=symbols,
                        progress_log_interval_seconds=max(
                            1, int(args.progress_log_seconds)
                        ),
                    )
                )
                holdout_payload = run_replay(
                    _build_replay_config(
                        strategy_configmap_path=candidate_configmap_path,
                        clickhouse_http_url=str(args.clickhouse_http_url),
                        clickhouse_username=(
                            str(args.clickhouse_username).strip() or None
                        ),
                        clickhouse_password=(
                            str(args.clickhouse_password).strip() or None
                        ),
                        start_date=window.holdout_start,
                        end_date=window.holdout_end,
                        start_equity=Decimal(str(args.start_equity)),
                        chunk_minutes=max(1, int(args.chunk_minutes)),
                        symbols=symbols,
                        progress_log_interval_seconds=max(
                            1, int(args.progress_log_seconds)
                        ),
                    )
                )
                scored.append(
                    score_replay_profitability_candidate(
                        family=family,
                        strategy_name=strategy_name,
                        replay_config={
                            "candidate_index": index,
                            "params": candidate,
                            "strategy_overrides": dict(strategy_overrides),
                            "train_start_date": window.train_start.isoformat(),
                            "train_end_date": window.train_end.isoformat(),
                            "holdout_start_date": window.holdout_start.isoformat(),
                            "holdout_end_date": window.holdout_end.isoformat(),
                        },
                        train_payload=train_payload,
                        holdout_payload=holdout_payload,
                        policy=policy,
                    )
                )

    scored.sort(
        key=lambda item: (
            item.score,
            item.holdout_net_per_day,
            item.profit_factor or Decimal("-1"),
        ),
        reverse=True,
    )
    payload = {
        "schema_version": _SWEEP_SCHEMA_VERSION,
        "family": family,
        "strategy_name": strategy_name,
        "window": {
            "train_days": [item.isoformat() for item in window.train_days],
            "holdout_days": [item.isoformat() for item in window.holdout_days],
        },
        "constraints": {
            "holdout_target_net_per_day": str(policy.holdout_target_net_per_day),
            "min_active_holdout_days": policy.min_active_holdout_days,
            "max_worst_holdout_day_loss": str(policy.max_worst_holdout_day_loss),
            "max_holdout_drawdown_pct_equity": str(
                policy.max_holdout_drawdown_pct_equity
            )
            if policy.max_holdout_drawdown_pct_equity is not None
            else None,
            "min_holdout_p10_daily_net": str(policy.min_holdout_p10_daily_net)
            if policy.min_holdout_p10_daily_net is not None
            else None,
            "min_profit_factor": str(policy.min_profit_factor),
            "require_training_decisions": policy.require_training_decisions,
            "require_holdout_decisions": policy.require_holdout_decisions,
        },
        "candidate_count": len(scored),
        "top": [item.to_payload() for item in scored[: max(1, int(args.top_n))]],
    }

    if args.json_output:
        args.json_output.write_text(
            json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8"
        )
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def cli_main() -> int:
    try:
        return main()
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(cli_main())
