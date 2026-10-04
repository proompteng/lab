#!/usr/bin/env python3
"""Search replay candidates using holdout fitness plus full-window consistency penalties."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Callable, Mapping, Sequence

import yaml


from scripts.consistent_profitability_frontier.repair_math import (
    _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE,
    _capital_repair_exposure_scale,
    _decimal_or_none,
    _decimal_payload,
    _reduced_exposure,
    _tightened_bps,
)

from scripts.consistent_profitability_frontier.candidate_generation import (
    _candidate_search_key,
    _candidate_universe_symbols,
)

_LOSS_REPAIR_TRIGGER_REASONS = frozenset(
    {
        "train_worst_day_loss_above_screen",
        "worst_day_loss_above_max",
        "max_drawdown_above_max",
        "conformal_tail_risk_below_target",
        "daily_net_below_min",
        "gross_exposure_pct_equity_above_max",
        "min_cash_below_min",
    }
)

_LOSS_REPAIR_TRIGGER_SUFFIXES = (
    "_worst_day_loss_above_max",
    "_max_drawdown_above_max",
)

_LOSS_REPAIR_BPS_FLOORS = {
    "long_stop_loss_bps": Decimal("4"),
    "short_stop_loss_bps": Decimal("4"),
    "long_trailing_stop_drawdown_bps": Decimal("3"),
    "short_trailing_stop_drawdown_bps": Decimal("3"),
    "negative_exit_loss_bps": Decimal("4"),
    "max_session_negative_exit_bps": Decimal("4"),
}

_LOSS_REPAIR_EXIT_LIMIT_KEYS = (
    "max_stop_loss_exits_per_session",
    "max_negative_exits_per_session",
)

_LOSS_REPAIR_LOCKOUT_KEYS = (
    "stop_loss_lockout_seconds",
    "negative_exit_lockout_seconds",
)

_LOSS_REPAIR_PARAM_EXPOSURE_KEYS = ("max_gross_exposure_pct_equity",)

_LOSS_REPAIR_STRATEGY_EXPOSURE_KEYS = (
    "max_notional_per_trade",
    "max_position_pct_equity",
)

_CONSISTENCY_REPAIR_TRIGGER_REASONS = frozenset(
    {
        "active_day_ratio_below_min",
        "avg_daily_notional_below_min",
        "best_day_share_above_max",
        "second_oos_net_per_day_below_target",
    }
)

_CONSISTENCY_REPAIR_UNSAFE_REASONS = frozenset(
    {
        "gross_exposure_pct_equity_above_max",
        "min_cash_below_min",
        "negative_cash_observation_count_above_max",
    }
)

_CONSISTENCY_REPAIR_ENTRY_KEYS = (
    "max_entries_per_session",
    "max_entries_per_day",
)

_CONSISTENCY_REPAIR_BREADTH_KEYS = ("top_n",)

_CONSISTENCY_REPAIR_COOLDOWN_KEYS = (
    "entry_cooldown_seconds",
    "signal_cooldown_seconds",
)

_CONSISTENCY_REPAIR_SIGNAL_THRESHOLD_KEYS = (
    "min_cross_section_continuation_rank",
    "min_cross_section_reversal_rank",
    "min_cross_section_opening_window_return_rank",
    "isolated_same_day_min_session_open_rank",
    "isolated_same_day_min_opening_window_return_rank",
    "isolated_same_day_min_continuation_rank",
    "min_cross_section_continuation_breadth",
    "min_recent_above_opening_window_close_ratio",
    "min_recent_above_opening_range_high_ratio",
    "min_recent_above_vwap_w5m_ratio",
    "min_recent_microprice_bias_bps",
    "min_recent_imbalance_pressure",
    "min_imbalance_pressure",
)

_CONSISTENCY_REPAIR_RANK_STEP = Decimal("0.05")

_CONSISTENCY_REPAIR_MIN_RANK_THRESHOLD = Decimal("0.01")

_CONSISTENCY_REPAIR_THRESHOLD_SCALE = Decimal("0.80")

_CONSISTENCY_REPAIR_MAX_SIGNAL_THRESHOLD_RELAXATIONS = 2


def _generate_symbol_prune_children(
    *,
    cli_symbols: tuple[str, ...],
    strategy_overrides: Mapping[str, Any],
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
    symbol_contributions: Mapping[str, Mapping[str, Any]],
    branch_count: int,
    min_universe_size: int,
) -> list[tuple[str, dict[str, Any]]]:
    if cli_symbols:
        return []
    universe = list(
        _candidate_universe_symbols(
            cli_symbols=cli_symbols,
            strategy_overrides=strategy_overrides,
            configmap_payload=configmap_payload,
            strategy_name=strategy_name,
        )
    )
    if len(universe) <= max(1, min_universe_size):
        return []

    ranked_symbols = [symbol for symbol in symbol_contributions if symbol in universe]
    children: list[tuple[str, dict[str, Any]]] = []
    for symbol in ranked_symbols[: max(1, branch_count)]:
        pruned_universe = [item for item in universe if item != symbol]
        if len(pruned_universe) < max(1, min_universe_size):
            continue
        next_override = dict(strategy_overrides)
        next_override["universe_symbols"] = pruned_universe
        children.append((symbol, next_override))
    return children


def _strategy_item_from_configmap(
    *,
    configmap_payload: Mapping[str, Any],
    strategy_name: str,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    data = configmap_payload.get("data")
    if not isinstance(data, Mapping):
        return {}, {}
    strategies_yaml = data.get("strategies.yaml")
    if not isinstance(strategies_yaml, str):
        return {}, {}
    catalog = yaml.safe_load(strategies_yaml)
    if not isinstance(catalog, Mapping):
        return {}, {}
    strategies = catalog.get("strategies")
    if not isinstance(strategies, list):
        return {}, {}
    for item in strategies:
        if not isinstance(item, Mapping):
            continue
        if str(item.get("name") or "").strip() != strategy_name:
            continue
        params = item.get("params")
        return item, params if isinstance(params, Mapping) else {}
    return {}, {}


def _loss_repair_trigger_reason(
    *,
    hard_vetoes: Sequence[Any],
    full_window_summary: Mapping[str, Any],
) -> str | None:
    for raw_reason in hard_vetoes:
        reason = str(raw_reason)
        if reason in _LOSS_REPAIR_TRIGGER_REASONS:
            return reason
        if reason.endswith(_LOSS_REPAIR_TRIGGER_SUFFIXES):
            return reason
    try:
        daily_net_below_min_count = int(
            full_window_summary.get("daily_net_below_min_count") or 0
        )
    except (TypeError, ValueError):
        daily_net_below_min_count = 0
    if daily_net_below_min_count > 0:
        return "daily_net_below_min"
    return None


def _apply_loss_control_tightening(
    *,
    params: dict[str, Any],
    strategy_params: Mapping[str, Any],
) -> bool:
    changed = False
    for key, floor in _LOSS_REPAIR_BPS_FLOORS.items():
        if key not in params and key not in strategy_params:
            continue
        tightened = _tightened_bps(
            params.get(key, strategy_params.get(key)), floor=floor
        )
        if tightened is not None:
            params[key] = tightened
            changed = True

    for key in _LOSS_REPAIR_EXIT_LIMIT_KEYS:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current <= 1:
            continue
        params[key] = "1"
        changed = True

    for key in _LOSS_REPAIR_LOCKOUT_KEYS:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current < 0:
            continue
        repaired = min(
            Decimal("14400"),
            max(Decimal("1800"), current * Decimal("2")),
        ).quantize(Decimal("1"))
        if repaired > current:
            params[key] = _decimal_payload(repaired)
            changed = True
    return changed


def _apply_exposure_clamp(
    *,
    params: dict[str, Any],
    overrides: dict[str, Any],
    strategy_item: Mapping[str, Any],
    strategy_params: Mapping[str, Any],
    scale: Decimal = _LOSS_REPAIR_DEFAULT_EXPOSURE_SCALE,
) -> bool:
    changed = False
    for key in _LOSS_REPAIR_PARAM_EXPOSURE_KEYS:
        if key not in params and key not in strategy_params:
            continue
        reduced = _reduced_exposure(
            params.get(key, strategy_params.get(key)), scale=scale
        )
        if reduced is not None:
            params[key] = reduced
            changed = True

    for key in _LOSS_REPAIR_STRATEGY_EXPOSURE_KEYS:
        if key not in overrides and key not in strategy_item:
            continue
        reduced = _reduced_exposure(
            overrides.get(key, strategy_item.get(key)), scale=scale
        )
        if reduced is not None:
            overrides[key] = reduced
            changed = True
    return changed


def _generate_loss_repair_children(
    *,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    candidate_configmap: Mapping[str, Any],
    strategy_name: str,
    hard_vetoes: Sequence[Any],
    full_window_summary: Mapping[str, Any],
    branch_count: int,
    policy_required_max_gross_exposure_pct_equity: Decimal | None = None,
    policy_required_min_cash: Decimal | None = None,
) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    trigger_reason = _loss_repair_trigger_reason(
        hard_vetoes=hard_vetoes,
        full_window_summary=full_window_summary,
    )
    if trigger_reason is None:
        return []

    strategy_item, strategy_params = _strategy_item_from_configmap(
        configmap_payload=candidate_configmap,
        strategy_name=strategy_name,
    )
    parent_key = _candidate_search_key(
        params_candidate=params_candidate,
        strategy_overrides=strategy_overrides,
    )
    exposure_repair_scale = _capital_repair_exposure_scale(
        full_window_summary,
        policy_required_max_gross_exposure_pct_equity=policy_required_max_gross_exposure_pct_equity,
        policy_required_min_cash=policy_required_min_cash,
    )
    children: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    seen: set[str] = {parent_key}

    def add_child(label: str, *, tighten_losses: bool, clamp_exposure: bool) -> None:
        if len(children) >= max(1, branch_count):
            return
        next_params = dict(params_candidate)
        next_overrides = dict(strategy_overrides)
        changed = False
        if tighten_losses:
            changed = (
                _apply_loss_control_tightening(
                    params=next_params,
                    strategy_params=strategy_params,
                )
                or changed
            )
        if clamp_exposure:
            changed = (
                _apply_exposure_clamp(
                    params=next_params,
                    overrides=next_overrides,
                    strategy_item=strategy_item,
                    strategy_params=strategy_params,
                    scale=exposure_repair_scale,
                )
                or changed
            )
        if not changed:
            return
        child_key = _candidate_search_key(
            params_candidate=next_params,
            strategy_overrides=next_overrides,
        )
        if child_key in seen:
            return
        seen.add(child_key)
        children.append((f"{label}:{trigger_reason}", next_params, next_overrides))

    add_child("loss_controls_and_exposure", tighten_losses=True, clamp_exposure=True)
    add_child("loss_controls", tighten_losses=True, clamp_exposure=False)
    add_child("exposure_clamp", tighten_losses=False, clamp_exposure=True)
    return children


def _positive_capital_safe_summary(full_window_summary: Mapping[str, Any]) -> bool:
    net_per_day = _decimal_or_none(
        full_window_summary.get("net_per_day")
        or full_window_summary.get("net_pnl_per_day")
    )
    max_gross = _decimal_or_none(
        full_window_summary.get("max_gross_exposure_pct_equity")
    )
    min_cash = _decimal_or_none(full_window_summary.get("min_cash"))
    if net_per_day is None or max_gross is None or min_cash is None:
        return False
    if net_per_day <= 0 or max_gross > 1 or min_cash < 0:
        return False
    try:
        negative_cash_count = int(
            full_window_summary.get("negative_cash_observation_count") or 0
        )
    except (TypeError, ValueError):
        negative_cash_count = 1
    return negative_cash_count <= 0


def _consistency_repair_trigger_reason(
    *,
    hard_vetoes: Sequence[Any],
    full_window_summary: Mapping[str, Any],
) -> str | None:
    reasons = [str(raw_reason) for raw_reason in hard_vetoes]
    if any(reason in _CONSISTENCY_REPAIR_UNSAFE_REASONS for reason in reasons):
        return None
    if not _positive_capital_safe_summary(full_window_summary):
        return None
    for reason in reasons:
        if reason in _CONSISTENCY_REPAIR_TRIGGER_REASONS:
            return reason
    return None


def _increment_integer_candidate_param(
    *,
    params: dict[str, Any],
    strategy_params: Mapping[str, Any],
    keys: Sequence[str],
) -> bool:
    for key in keys:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current < 1:
            continue
        params[key] = _decimal_payload(current.to_integral_value() + 1)
        return True
    return False


def _halve_positive_integer_candidate_param(
    *,
    params: dict[str, Any],
    strategy_params: Mapping[str, Any],
    keys: Sequence[str],
) -> bool:
    for key in keys:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current <= 1:
            continue
        repaired = max(Decimal("1"), (current / Decimal("2")).quantize(Decimal("1")))
        params[key] = _decimal_payload(repaired)
        return True
    return False


def _relax_signal_threshold_candidate_param(
    *,
    params: dict[str, Any],
    strategy_params: Mapping[str, Any],
    keys: Sequence[str],
) -> bool:
    relaxed_count = 0
    for key in keys:
        if key not in params and key not in strategy_params:
            continue
        current = _decimal_or_none(params.get(key, strategy_params.get(key)))
        if current is None or current <= 0:
            continue
        if current <= Decimal("1"):
            repaired = max(
                _CONSISTENCY_REPAIR_MIN_RANK_THRESHOLD,
                (current - _CONSISTENCY_REPAIR_RANK_STEP).quantize(Decimal("0.01")),
            )
        else:
            repaired = (current * _CONSISTENCY_REPAIR_THRESHOLD_SCALE).quantize(
                Decimal("0.01")
            )
        if repaired >= current:
            continue
        params[key] = _decimal_payload(repaired)
        relaxed_count += 1
        if relaxed_count >= _CONSISTENCY_REPAIR_MAX_SIGNAL_THRESHOLD_RELAXATIONS:
            break
    return relaxed_count > 0


def _generate_consistency_repair_children(
    *,
    params_candidate: Mapping[str, Any],
    strategy_overrides: Mapping[str, Any],
    candidate_configmap: Mapping[str, Any],
    strategy_name: str,
    hard_vetoes: Sequence[Any],
    full_window_summary: Mapping[str, Any],
    branch_count: int,
) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    trigger_reason = _consistency_repair_trigger_reason(
        hard_vetoes=hard_vetoes,
        full_window_summary=full_window_summary,
    )
    if trigger_reason is None:
        return []

    _, strategy_params = _strategy_item_from_configmap(
        configmap_payload=candidate_configmap,
        strategy_name=strategy_name,
    )
    parent_key = _candidate_search_key(
        params_candidate=params_candidate,
        strategy_overrides=strategy_overrides,
    )
    children: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    seen: set[str] = {parent_key}

    def add_child(label: str, mutator: Callable[[dict[str, Any]], bool]) -> None:
        if len(children) >= max(1, branch_count):
            return
        next_params = dict(params_candidate)
        next_overrides = dict(strategy_overrides)
        if not mutator(next_params):
            return
        child_key = _candidate_search_key(
            params_candidate=next_params,
            strategy_overrides=next_overrides,
        )
        if child_key in seen:
            return
        seen.add(child_key)
        children.append((f"{label}:{trigger_reason}", next_params, next_overrides))

    add_child(
        "consistency_signal_thresholds",
        lambda next_params: _relax_signal_threshold_candidate_param(
            params=next_params,
            strategy_params=strategy_params,
            keys=_CONSISTENCY_REPAIR_SIGNAL_THRESHOLD_KEYS,
        ),
    )
    add_child(
        "consistency_breadth",
        lambda next_params: _increment_integer_candidate_param(
            params=next_params,
            strategy_params=strategy_params,
            keys=_CONSISTENCY_REPAIR_BREADTH_KEYS,
        ),
    )
    add_child(
        "consistency_entries",
        lambda next_params: _increment_integer_candidate_param(
            params=next_params,
            strategy_params=strategy_params,
            keys=_CONSISTENCY_REPAIR_ENTRY_KEYS,
        ),
    )
    add_child(
        "consistency_cooldown",
        lambda next_params: _halve_positive_integer_candidate_param(
            params=next_params,
            strategy_params=strategy_params,
            keys=_CONSISTENCY_REPAIR_COOLDOWN_KEYS,
        ),
    )
    return children


def _selected_normalization_regime(
    *,
    strategy_overrides: Mapping[str, Any],
    template_allowed_normalizations: tuple[str, ...],
) -> str | None:
    override = str(strategy_overrides.get("normalization_regime") or "").strip()
    if override:
        return override
    return (
        template_allowed_normalizations[0] if template_allowed_normalizations else None
    )


__all__ = [
    "_generate_symbol_prune_children",
    "_strategy_item_from_configmap",
    "_loss_repair_trigger_reason",
    "_apply_loss_control_tightening",
    "_apply_exposure_clamp",
    "_generate_loss_repair_children",
    "_positive_capital_safe_summary",
    "_consistency_repair_trigger_reason",
    "_increment_integer_candidate_param",
    "_halve_positive_integer_candidate_param",
    "_relax_signal_threshold_candidate_param",
    "_generate_consistency_repair_children",
    "_selected_normalization_regime",
]
