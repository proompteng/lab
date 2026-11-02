"""Lazy dependency helpers for decision-engine core methods."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Literal, Optional

from ...models import Strategy
from ..models import SignalEnvelope, StrategyDecision


def resolve_signal_timeframe(signal: SignalEnvelope) -> Optional[str]:
    from .count_open_short_positions import (
        resolve_signal_timeframe,
    )

    return resolve_signal_timeframe(signal)


def runtime_enabled() -> bool:
    from .count_open_short_positions import (
        runtime_enabled,
    )

    return runtime_enabled()


def actual_positions_only(
    positions: Optional[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    from .positions_for_strategy_action import (
        actual_positions_only as actual_only,
    )

    return actual_only(positions) or []


def position_qty_for_symbol(*args: Any, **kwargs: Any) -> Decimal | None:
    from .positions_for_strategy_action import (
        position_qty_for_symbol,
    )

    return position_qty_for_symbol(*args, **kwargs)


def position_qty_from_payload(position: Mapping[str, Any]) -> Decimal | None:
    from .positions_for_strategy_action import (
        position_qty_from_payload,
    )

    return position_qty_from_payload(position)


def position_avg_entry_price_for_symbol(*args: Any, **kwargs: Any) -> Decimal | None:
    from .positions_for_strategy_action import (
        position_avg_entry_price_for_symbol as avg_entry_price_for_symbol,
    )

    return avg_entry_price_for_symbol(*args, **kwargs)


def positions_for_strategy_action(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    from .positions_for_strategy_action import (
        positions_for_strategy_action,
    )

    return positions_for_strategy_action(*args, **kwargs) or []


def build_runtime_position_exit_overlay(**kwargs: Any) -> StrategyDecision | None:
    from .resolve_qty_for_aggregated import (
        build_runtime_position_exit_overlay as build_overlay,
    )

    return build_overlay(**kwargs)


def resolve_qty_for_aggregated(
    *args: Any, **kwargs: Any
) -> tuple[Decimal, dict[str, Any]]:
    from .aggregated_qty import (
        resolve_qty_for_aggregated as resolve_qty,
    )

    return resolve_qty(*args, **kwargs)


def strategy_uses_position_isolation(strategy: Strategy) -> bool:
    from .resolve_qty_for_aggregated import (
        strategy_uses_position_isolation,
    )

    return strategy_uses_position_isolation(strategy)


def position_state_scope_key(*args: Any, **kwargs: Any) -> str | None:
    from .resolve_qty_for_aggregated import (
        position_state_scope_key,
    )

    return position_state_scope_key(*args, **kwargs)


def runtime_trade_policy_key(*args: Any, **kwargs: Any) -> tuple[str, str, str | None]:
    from .resolve_qty_for_aggregated import (
        runtime_trade_policy_key,
    )

    return runtime_trade_policy_key(*args, **kwargs)


def skip_non_executable_decision_qty(*args: Any, **kwargs: Any) -> bool:
    from .single_strategy_qty import (
        skip_non_executable_decision_qty as skip_non_executable_qty,
    )

    return skip_non_executable_qty(*args, **kwargs)


def resolve_runtime_trade_policy(*args: Any, **kwargs: Any) -> Any:
    from .resolve_runtime_trade_policy import (
        resolve_runtime_trade_policy,
    )

    return resolve_runtime_trade_policy(*args, **kwargs)


def passes_runtime_trade_policy(*args: Any, **kwargs: Any) -> bool:
    from .resolve_runtime_trade_policy import (
        passes_runtime_trade_policy,
    )

    return passes_runtime_trade_policy(*args, **kwargs)


def runtime_trade_policy_owner(*args: Any, **kwargs: Any) -> str | None:
    from .resolve_runtime_trade_policy import (
        runtime_trade_policy_owner,
    )

    return runtime_trade_policy_owner(*args, **kwargs)


def passes_signal_exit_policy(*args: Any, **kwargs: Any) -> bool:
    from .resolve_runtime_trade_policy import (
        passes_signal_exit_policy,
    )

    return passes_signal_exit_policy(*args, **kwargs)


def resolve_strategy_time_in_force(*args: Any, **kwargs: Any) -> str:
    from .resolve_runtime_trade_policy import (
        resolve_strategy_time_in_force,
    )

    return resolve_strategy_time_in_force(*args, **kwargs)


def decision_position_exit_type(decision: StrategyDecision) -> str | None:
    from .resolve_runtime_trade_policy import (
        decision_position_exit_type,
    )

    return decision_position_exit_type(decision)


def record_runtime_trade_policy_decision(*args: Any, **kwargs: Any) -> None:
    from .resolve_runtime_trade_policy import (
        record_runtime_trade_policy_decision as record_decision,
    )

    record_decision(*args, **kwargs)


def runtime_intent_exit_side(
    *args: Any, **kwargs: Any
) -> Literal["long", "short"] | None:
    from .resolve_runtime_trade_policy import (
        runtime_intent_exit_side,
    )

    return runtime_intent_exit_side(*args, **kwargs)


def build_params(**kwargs: Any) -> dict[str, Any]:
    from .decision_engine_runtime_methods import (
        build_params,
    )

    return build_params(**kwargs)


__all__ = [
    "actual_positions_only",
    "build_params",
    "build_runtime_position_exit_overlay",
    "decision_position_exit_type",
    "passes_runtime_trade_policy",
    "passes_signal_exit_policy",
    "position_avg_entry_price_for_symbol",
    "position_qty_for_symbol",
    "position_qty_from_payload",
    "position_state_scope_key",
    "positions_for_strategy_action",
    "record_runtime_trade_policy_decision",
    "resolve_qty_for_aggregated",
    "resolve_runtime_trade_policy",
    "resolve_signal_timeframe",
    "resolve_strategy_time_in_force",
    "runtime_enabled",
    "runtime_intent_exit_side",
    "runtime_trade_policy_key",
    "runtime_trade_policy_owner",
    "skip_non_executable_decision_qty",
    "strategy_uses_position_isolation",
]
