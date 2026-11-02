"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, cast


import yaml

from ..features import (
    extract_price,
    extract_rsi,
)
from ..models import SignalEnvelope
from ..reporting import (
    EvaluationReport,
)
from ..strategy_specs import (
    compile_strategy_spec_v2,
    load_strategy_spec_v2_payload,
    strategy_type_supports_spec_v2,
)
from .gates import (
    PromotionTarget,
)
from .runtime import (
    StrategyRuntimeConfig,
    compile_runtime_config,
)

from .lane_run_summary import (
    strategy_universe_type as _strategy_universe_type,
)


def load_runtime_strategy_config(path: Path) -> list[StrategyRuntimeConfig]:
    raw = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".yaml", ".yml"}:
        payload_raw: object = yaml.safe_load(raw)
    else:
        payload_raw = json.loads(raw)

    if isinstance(payload_raw, Mapping):
        payload_mapping = cast(Mapping[str, Any], payload_raw)
        payload: object = payload_mapping.get("strategies", payload_raw)
    else:
        payload = payload_raw
    if not isinstance(payload, list):
        raise ValueError("strategy config must be a list or include strategies key")

    strategies: list[StrategyRuntimeConfig] = []
    for index, item_raw in enumerate(cast(list[object], payload)):
        if not isinstance(item_raw, Mapping):
            raise ValueError(f"invalid strategy entry at index {index}")
        item = cast(Mapping[str, Any], item_raw)
        strategy_id = str(
            item.get("strategy_id") or item.get("name") or f"strategy-{index + 1}"
        )
        strategy_spec_raw = item.get("strategy_spec_v2")
        if isinstance(strategy_spec_raw, Mapping):
            strategy_spec = load_strategy_spec_v2_payload(
                dict(cast(Mapping[str, Any], strategy_spec_raw))
            )
            strategy_params_raw = item.get("params", {})
            if isinstance(strategy_params_raw, Mapping) and strategy_params_raw:
                strategy_spec_payload = strategy_spec.to_payload()
                strategy_spec_payload["runtime_parameters"] = {
                    **dict(strategy_spec.runtime_parameters),
                    **dict(cast(Mapping[str, Any], strategy_params_raw)),
                }
                strategy_spec = load_strategy_spec_v2_payload(strategy_spec_payload)
            compiled = compile_strategy_spec_v2(strategy_spec)
            strategies.append(
                StrategyRuntimeConfig(
                    strategy_id=strategy_spec.strategy_id or strategy_id,
                    strategy_type=str(
                        compiled.shadow_runtime_config.get(
                            "strategy_type", "legacy_macd_rsi"
                        )
                    ),
                    version=str(compiled.shadow_runtime_config.get("version", "1.0.0")),
                    params=cast(
                        dict[str, Any], compiled.shadow_runtime_config.get("params", {})
                    )
                    if isinstance(
                        compiled.shadow_runtime_config.get("params", {}), dict
                    )
                    else {},
                    base_timeframe=str(
                        compiled.shadow_runtime_config.get("base_timeframe", "1Min")
                    ),
                    enabled=bool(item.get("enabled", True)),
                    priority=int(item.get("priority", 100)),
                    compiler_source="spec_v2",
                    strategy_spec=compiled.strategy_spec.to_payload(),
                    compiled_targets={
                        "evaluator_config": compiled.evaluator_config,
                        "shadow_runtime_config": compiled.shadow_runtime_config,
                        "live_runtime_config": compiled.live_runtime_config,
                        "promotion_metadata": compiled.promotion_metadata,
                    },
                )
            )
            continue

        strategy_type = str(item.get("strategy_type", "legacy_macd_rsi"))
        version = str(item.get("version", "1.0.0"))
        params_raw = item.get("params")
        if params_raw is None:
            params = {
                "buy_rsi_threshold": item.get("buy_rsi_threshold", 35),
                "sell_rsi_threshold": item.get("sell_rsi_threshold", 65),
                "qty": item.get("qty", 1),
            }
        elif isinstance(params_raw, Mapping):
            params = dict(cast(Mapping[str, Any], params_raw))
        else:
            raise ValueError(f"params for strategy {strategy_id} must be an object")
        config = StrategyRuntimeConfig(
            strategy_id=strategy_id,
            strategy_type=strategy_type,
            version=version,
            params=params,
            base_timeframe=str(item.get("base_timeframe", "1Min")),
            enabled=bool(item.get("enabled", True)),
            priority=int(item.get("priority", 100)),
        )
        if strategy_type_supports_spec_v2(strategy_type):
            config = compile_runtime_config(config)
        strategies.append(config)

    return sorted(strategies, key=lambda item: (item.priority, item.strategy_id))


def _load_signals(path: Path) -> list[SignalEnvelope]:
    payload: object = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("signals payload must be a list")
    signals = [
        SignalEnvelope.model_validate(item) for item in cast(list[object], payload)
    ]
    return sorted(signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))


def _deterministic_run_id(
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    promotion_target: PromotionTarget,
    alpha_train_prices_path: Path | None = None,
    alpha_test_prices_path: Path | None = None,
    alpha_gate_policy_path: Path | None = None,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(signals_path.read_bytes())
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(promotion_target.encode("utf-8"))
    for optional_path in (
        alpha_train_prices_path,
        alpha_test_prices_path,
        alpha_gate_policy_path,
    ):
        if optional_path is None:
            hasher.update(b"\x00")
            continue
        hasher.update(optional_path.read_bytes())
    return hasher.hexdigest()[:24]


def _required_feature_null_rate(signals: list[SignalEnvelope]) -> Decimal:
    required_keys = ("macd", "rsi", "price")
    missing = 0
    total = 0
    for signal in signals:
        payload = dict(signal.payload or {})
        for key in required_keys:
            total += 1
            if key == "macd":
                macd_block = payload.get("macd")
                macd_payload: dict[str, Any] = (
                    dict(cast(Mapping[str, Any], macd_block))
                    if isinstance(macd_block, Mapping)
                    else {}
                )
                if (
                    not macd_payload
                    or macd_payload.get("macd") is None
                    or macd_payload.get("signal") is None
                ):
                    missing += 1
            elif key == "rsi":
                if extract_rsi(payload) is None:
                    missing += 1
            elif key == "price":
                if extract_price(payload) is None:
                    missing += 1
            else:
                missing += 1
    if total == 0:
        return Decimal("1")
    return Decimal(missing) / Decimal(total)


def _compute_no_signal_feature_spec_hash(
    *,
    strategy_config_path: Path,
    gate_policy_path: Path,
    reason: str,
    query_start: datetime,
    query_end: datetime,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(reason.encode("utf-8"))
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(str(query_start).encode("utf-8"))
    hasher.update(str(query_end).encode("utf-8"))
    return hasher.hexdigest()[:128]


def _compute_no_signal_dataset_version_hash(
    *,
    query_start: datetime,
    query_end: datetime,
    no_signal_reason: str,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(str(query_start).encode("utf-8"))
    hasher.update(str(query_end).encode("utf-8"))
    hasher.update(no_signal_reason.encode("utf-8"))
    return hasher.hexdigest()[:64]


def _compute_feature_spec_hash(
    *,
    strategy_config_path: Path,
    gate_policy_path: Path,
    signals_path: Path,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(signals_path.read_bytes())
    return hasher.hexdigest()[:128]


def _compute_dataset_version_hash(*, signals_path: Path) -> str:
    hasher = hashlib.sha256()
    try:
        payload = json.loads(signals_path.read_text(encoding="utf-8"))
    except Exception:
        payload = []
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    hasher.update(payload_json.encode("utf-8"))
    return hasher.hexdigest()[:64]


def _strategy_parameter_set(
    runtime_strategies: list[StrategyRuntimeConfig],
) -> list[dict[str, Any]]:
    return [
        {
            "strategy_id": strategy.strategy_id,
            "strategy_type": strategy.strategy_type,
            "version": strategy.version,
            "priority": strategy.priority,
            "base_timeframe": strategy.base_timeframe,
            "enabled": strategy.enabled,
            "params": strategy.params,
        }
        for strategy in sorted(
            runtime_strategies, key=lambda item: (item.priority, item.strategy_id)
        )
    ]


def _strategy_universe_definition(
    runtime_strategies: list[StrategyRuntimeConfig],
    *,
    lifecycle_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not runtime_strategies:
        return {
            "autonomy_lifecycle": lifecycle_payload or {},
        }
    payload: dict[str, Any] = {
        "strategies": [
            {
                "strategy_id": item.strategy_id,
                "strategy_type": item.strategy_type,
                "universe_type": _strategy_universe_type(item.strategy_type),
            }
            for item in runtime_strategies
        ],
        "count": len(runtime_strategies),
    }
    payload["autonomy_lifecycle"] = lifecycle_payload or {}
    return payload


def _metric_counter_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    return 0


def _build_stress_bundle(report: EvaluationReport, stress_case: str) -> dict[str, Any]:
    return {
        "case": stress_case,
        "max_drawdown": str(report.metrics.max_drawdown),
        "cost_bps": str(report.metrics.cost_bps),
        "turnover_ratio": str(report.metrics.turnover_ratio),
        "net_pnl": str(report.metrics.net_pnl),
        "gross_pnl": str(report.metrics.gross_pnl),
        "decision_count": report.metrics.decision_count,
        "trade_count": report.metrics.trade_count,
    }


load_signals = _load_signals
deterministic_run_id = _deterministic_run_id
required_feature_null_rate = _required_feature_null_rate
compute_no_signal_feature_spec_hash = _compute_no_signal_feature_spec_hash
compute_no_signal_dataset_version_hash = _compute_no_signal_dataset_version_hash
compute_feature_spec_hash = _compute_feature_spec_hash
compute_dataset_version_hash = _compute_dataset_version_hash
strategy_parameter_set = _strategy_parameter_set
strategy_universe_definition = _strategy_universe_definition
metric_counter_int = _metric_counter_int
build_stress_bundle = _build_stress_bundle

__all__ = [
    "load_runtime_strategy_config",
    "_load_signals",
    "_deterministic_run_id",
    "_required_feature_null_rate",
    "_compute_no_signal_feature_spec_hash",
    "_compute_no_signal_dataset_version_hash",
    "_compute_feature_spec_hash",
    "_compute_dataset_version_hash",
    "_strategy_parameter_set",
    "_strategy_universe_definition",
    "_metric_counter_int",
    "_build_stress_bundle",
]
