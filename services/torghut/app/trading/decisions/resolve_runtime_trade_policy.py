"""Trading decision engine based on TA signals."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Literal, Optional, cast

from ...models import Strategy
from ..features import (
    optional_decimal,
)
from ..models import SignalEnvelope, StrategyDecision
from ..strategy_runtime import (
    StrategyRuntime,
)


from .shared_context import (
    MICROBAR_PAIR_EXIT_RATIONALE,
    RUNTIME_TRADE_POLICY_SHARED_OWNER,
    RuntimeTradePolicySessionState,
)
from .resolve_qty_for_aggregated import (
    runtime_trade_policy_key,
)
from .positions_for_strategy_action import (
    exit_position_side_for_strategies,
    is_entry_action_for_strategies,
    is_exit_action_for_strategies,
    passes_exit_profit_policy,
    position_avg_entry_price_for_symbol,
    position_qty_for_symbol,
    position_qty_from_payload,
    realized_exit_bps,
    reference_exit_price as resolve_reference_exit_price,
    resolve_max_nonnegative_strategy_param,
)
from .count_open_short_positions import (
    count_open_short_positions,
)


def _int_param(value: Any) -> int:
    if value is None:
        return 0
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def resolve_runtime_trade_policy(
    strategies: list[Strategy],
) -> dict[str, int | Decimal]:
    entry_cooldown = 0
    exit_cooldown = 0
    min_hold = 0
    max_hold_candidates: list[int] = []
    max_concurrent_candidates: list[int] = []
    max_entries_per_session_candidates: list[int] = []
    max_stop_loss_exits_candidates: list[int] = []
    max_negative_exits_candidates: list[int] = []
    stop_loss_lockout = 0
    negative_exit_lockout = 0
    negative_exit_loss_bps_candidates: list[Decimal] = []
    max_session_negative_exit_bps_candidates: list[Decimal] = []
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        entry_cooldown = max(
            entry_cooldown,
            _int_param(params.get("entry_cooldown_seconds")),
        )
        exit_cooldown = max(
            exit_cooldown,
            _int_param(params.get("exit_cooldown_seconds")),
        )
        min_hold = max(
            min_hold,
            _int_param(params.get("min_hold_seconds")),
        )
        max_hold_seconds = _int_param(params.get("max_hold_seconds"))
        if max_hold_seconds > 0:
            max_hold_candidates.append(max_hold_seconds)
        max_concurrent_positions = _int_param(params.get("max_concurrent_positions"))
        if max_concurrent_positions > 0:
            max_concurrent_candidates.append(max_concurrent_positions)
        max_entries_per_session = _int_param(params.get("max_entries_per_session"))
        if max_entries_per_session > 0:
            max_entries_per_session_candidates.append(max_entries_per_session)
        max_stop_loss_exits = _int_param(params.get("max_stop_loss_exits_per_session"))
        if max_stop_loss_exits > 0:
            max_stop_loss_exits_candidates.append(max_stop_loss_exits)
        max_negative_exits = _int_param(params.get("max_negative_exits_per_session"))
        if max_negative_exits > 0:
            max_negative_exits_candidates.append(max_negative_exits)
        stop_loss_lockout = max(
            stop_loss_lockout,
            _int_param(params.get("stop_loss_lockout_seconds")),
        )
        negative_exit_lockout = max(
            negative_exit_lockout,
            _int_param(params.get("negative_exit_lockout_seconds")),
        )
        negative_exit_loss_bps = optional_decimal(params.get("negative_exit_loss_bps"))
        if negative_exit_loss_bps is not None and negative_exit_loss_bps > 0:
            negative_exit_loss_bps_candidates.append(negative_exit_loss_bps)
        max_session_negative_exit_bps = optional_decimal(
            params.get("max_session_negative_exit_bps")
        )
        if (
            max_session_negative_exit_bps is not None
            and max_session_negative_exit_bps > 0
        ):
            max_session_negative_exit_bps_candidates.append(
                max_session_negative_exit_bps
            )
    return {
        "entry_cooldown_seconds": entry_cooldown,
        "exit_cooldown_seconds": exit_cooldown,
        "min_hold_seconds": min_hold,
        "max_hold_seconds": min(max_hold_candidates) if max_hold_candidates else 0,
        "max_concurrent_positions": (
            min(max_concurrent_candidates) if max_concurrent_candidates else 0
        ),
        "max_entries_per_session": (
            min(max_entries_per_session_candidates)
            if max_entries_per_session_candidates
            else 0
        ),
        "max_stop_loss_exits_per_session": (
            min(max_stop_loss_exits_candidates) if max_stop_loss_exits_candidates else 0
        ),
        "max_negative_exits_per_session": (
            min(max_negative_exits_candidates) if max_negative_exits_candidates else 0
        ),
        "stop_loss_lockout_seconds": stop_loss_lockout,
        "negative_exit_lockout_seconds": negative_exit_lockout,
        "negative_exit_loss_bps": (
            min(negative_exit_loss_bps_candidates)
            if negative_exit_loss_bps_candidates
            else Decimal("0")
        ),
        "max_session_negative_exit_bps": (
            min(max_session_negative_exit_bps_candidates)
            if max_session_negative_exit_bps_candidates
            else Decimal("0")
        ),
    }


def passes_runtime_trade_policy(
    *,
    strategies: list[Strategy],
    last_emitted_action_at: dict[tuple[str, str, str | None], datetime],
    runtime_trade_policy_state: dict[tuple[str, str], RuntimeTradePolicySessionState],
    signal_ts: datetime,
    symbol: str,
    action: str,
    position_owner: str,
    positions: Optional[list[dict[str, Any]]],
    policy: Mapping[str, int | Decimal],
    position_exit_type: str | None = None,
    runtime_exit_side: Literal["long", "short"] | None = None,
    state_scope_key: str | None = None,
) -> bool:
    normalized_action = action.strip().lower()
    session_state = resolve_runtime_trade_policy_session_state(
        runtime_trade_policy_state=runtime_trade_policy_state,
        signal_ts=signal_ts,
        symbol=symbol,
        position_owner=position_owner,
    )
    entry_action = runtime_exit_side is None and is_entry_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    exit_action = runtime_exit_side is not None or is_exit_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    if entry_action:
        max_concurrent_positions = max(
            0, int(policy.get("max_concurrent_positions", 0))
        )
        if max_concurrent_positions > 0 and (
            (
                normalized_action == "buy"
                and count_open_long_positions(positions) >= max_concurrent_positions
            )
            or (
                normalized_action == "sell"
                and count_open_short_positions(positions) >= max_concurrent_positions
            )
        ):
            return False
        max_entries_per_session = max(0, int(policy.get("max_entries_per_session", 0)))
        if (
            max_entries_per_session > 0
            and session_state.entry_count >= max_entries_per_session
        ):
            return False
        max_stop_loss_exits = max(
            0, int(policy.get("max_stop_loss_exits_per_session", 0))
        )
        if (
            max_stop_loss_exits > 0
            and session_state.stop_loss_exit_count >= max_stop_loss_exits
        ):
            return False
        max_negative_exits = max(
            0, int(policy.get("max_negative_exits_per_session", 0))
        )
        if (
            max_negative_exits > 0
            and session_state.negative_exit_count >= max_negative_exits
        ):
            return False
        max_session_negative_exit_bps = optional_decimal(
            policy.get("max_session_negative_exit_bps")
        )
        if (
            max_session_negative_exit_bps is not None
            and max_session_negative_exit_bps > 0
            and session_state.cumulative_negative_exit_bps
            >= max_session_negative_exit_bps
        ):
            return False
        stop_loss_lockout_seconds = max(
            0, int(policy.get("stop_loss_lockout_seconds", 0))
        )
        if (
            stop_loss_lockout_seconds > 0
            and session_state.last_stop_loss_exit_at is not None
            and (
                signal_ts.astimezone(timezone.utc)
                - session_state.last_stop_loss_exit_at.astimezone(timezone.utc)
            ).total_seconds()
            < stop_loss_lockout_seconds
        ):
            return False
        negative_exit_lockout_seconds = max(
            0, int(policy.get("negative_exit_lockout_seconds", 0))
        )
        if (
            negative_exit_lockout_seconds > 0
            and session_state.last_negative_exit_at is not None
            and (
                signal_ts.astimezone(timezone.utc)
                - session_state.last_negative_exit_at.astimezone(timezone.utc)
            ).total_seconds()
            < negative_exit_lockout_seconds
        ):
            return False

    cooldown_key = "entry_cooldown_seconds" if entry_action else "exit_cooldown_seconds"
    cooldown_seconds = max(0, int(policy.get(cooldown_key, 0)))
    last_emitted = last_emitted_action_at.get(
        runtime_trade_policy_key(
            symbol=symbol,
            action=normalized_action,
            state_scope_key=state_scope_key,
        )
    )
    if (
        cooldown_seconds > 0
        and last_emitted is not None
        and (
            signal_ts.astimezone(timezone.utc) - last_emitted.astimezone(timezone.utc)
        ).total_seconds()
        < cooldown_seconds
    ):
        return False

    if not exit_action:
        return True

    if position_exit_bypasses_min_hold(position_exit_type):
        return True

    min_hold_seconds = max(0, int(policy.get("min_hold_seconds", 0)))
    if min_hold_seconds <= 0:
        return True
    position_opened_at = position_opened_at_for_symbol(positions, symbol)
    if position_opened_at is None:
        return True
    age_seconds = (
        signal_ts.astimezone(timezone.utc) - position_opened_at.astimezone(timezone.utc)
    ).total_seconds()
    return age_seconds >= min_hold_seconds


def decision_position_exit_type(decision: StrategyDecision) -> str | None:
    position_exit = decision.params.get("position_exit")
    if not isinstance(position_exit, Mapping):
        return None
    normalized = str(cast(Mapping[str, Any], position_exit).get("type") or "").strip()
    return normalized or None


def position_exit_bypasses_min_hold(position_exit_type: str | None) -> bool:
    normalized = str(position_exit_type or "").strip().lower()
    return normalized in {
        "long_stop_loss_bps",
        "short_stop_loss_bps",
        "max_hold_seconds",
        "session_flatten_minute_utc",
    }


def resolve_strategy_time_in_force(
    *,
    strategies: list[Strategy],
    action: str,
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> str:
    normalized_action = str(action or "").strip().lower()
    param_key = (
        "exit_time_in_force"
        if runtime_exit_side is not None
        else "entry_time_in_force"
        if is_entry_action_for_strategies(
            strategies=strategies, action=normalized_action
        )
        else "exit_time_in_force"
    )
    supported_values = {"day", "gtc", "ioc", "fok"}
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        candidate = str(params.get(param_key) or "").strip().lower()
        if candidate in supported_values:
            return candidate
    if normalized_action == "buy":
        continuation_strategy_types = {
            "breakout_continuation_long_v1",
            "late_day_continuation_long_v1",
        }
        if any(
            str(strategy.universe_type or "").strip().lower()
            in continuation_strategy_types
            for strategy in strategies
        ):
            return "ioc"
    return "day"


def runtime_trade_policy_owner(
    *,
    primary_strategy_id: str,
    position_isolation_mode: str | None,
) -> str:
    if str(position_isolation_mode or "").strip().lower() == "per_strategy":
        return primary_strategy_id
    return RUNTIME_TRADE_POLICY_SHARED_OWNER


def resolve_runtime_trade_policy_session_state(
    *,
    runtime_trade_policy_state: dict[tuple[str, str], RuntimeTradePolicySessionState],
    signal_ts: datetime,
    symbol: str,
    position_owner: str,
) -> RuntimeTradePolicySessionState:
    session_day = signal_ts.astimezone(timezone.utc).date()
    key = (
        symbol.strip().upper(),
        position_owner.strip() or RUNTIME_TRADE_POLICY_SHARED_OWNER,
    )
    state = runtime_trade_policy_state.get(key)
    if state is None or state.session_day != session_day:
        state = RuntimeTradePolicySessionState(session_day=session_day)
        runtime_trade_policy_state[key] = state
    return state


def record_runtime_trade_policy_decision(
    *,
    strategies: list[Strategy],
    runtime_trade_policy_state: dict[tuple[str, str], RuntimeTradePolicySessionState],
    signal_ts: datetime,
    symbol: str,
    position_owner: str,
    action: str,
    policy: Mapping[str, int | Decimal],
    positions: Optional[list[dict[str, Any]]],
    signal: SignalEnvelope,
    price: Decimal | None,
    decision: StrategyDecision,
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> None:
    normalized_action = action.strip().lower()
    state = resolve_runtime_trade_policy_session_state(
        runtime_trade_policy_state=runtime_trade_policy_state,
        signal_ts=signal_ts,
        symbol=symbol,
        position_owner=position_owner,
    )
    entry_action = runtime_exit_side is None and is_entry_action_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    exit_side = runtime_exit_side or exit_position_side_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    if entry_action:
        state.entry_count += 1
        return
    if exit_side is None or price is None or price <= 0:
        return

    position_exit = decision.params.get("position_exit")
    position_exit_type = (
        str(cast(Mapping[str, Any], position_exit).get("type") or "").strip()
        if isinstance(position_exit, Mapping)
        else ""
    )
    if position_exit_type in {"long_stop_loss_bps", "short_stop_loss_bps"}:
        state.stop_loss_exit_count += 1
        state.last_stop_loss_exit_at = signal_ts

    avg_entry_price = position_avg_entry_price_for_symbol(positions, symbol)
    if avg_entry_price is None or avg_entry_price <= 0:
        return
    realized_bps = realized_exit_bps(
        avg_entry_price=avg_entry_price,
        exit_price=resolve_reference_exit_price(
            price=price,
            signal=signal,
            action=normalized_action,
        ),
        position_side=exit_side,
    )
    if realized_bps >= 0:
        return

    negative_exit_loss_bps = optional_decimal(policy.get("negative_exit_loss_bps"))
    loss_bps = abs(realized_bps)
    if (
        negative_exit_loss_bps is not None
        and negative_exit_loss_bps > 0
        and loss_bps < negative_exit_loss_bps
    ):
        return
    state.negative_exit_count += 1
    state.last_negative_exit_at = signal_ts
    state.cumulative_negative_exit_bps += loss_bps


def passes_signal_exit_policy(
    *,
    strategies: list[Strategy],
    symbol: str,
    action: str,
    price: Optional[Decimal],
    signal: SignalEnvelope,
    positions: Optional[list[dict[str, Any]]],
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> bool:
    normalized_action = action.strip().lower()
    exit_side = runtime_exit_side or exit_position_side_for_strategies(
        strategies=strategies,
        action=normalized_action,
    )
    if exit_side is None or price is None or price <= 0:
        return True

    position_qty = position_qty_for_symbol(positions, symbol)
    if (exit_side == "long" and (position_qty is None or position_qty <= 0)) or (
        exit_side == "short" and (position_qty is None or position_qty >= 0)
    ):
        return True

    avg_entry_price = position_avg_entry_price_for_symbol(positions, symbol)
    if avg_entry_price is None or avg_entry_price <= 0:
        return True

    reference_exit_price = resolve_reference_exit_price(
        price=price,
        signal=signal,
        action=normalized_action,
    )
    realized_bps = realized_exit_bps(
        avg_entry_price=avg_entry_price,
        exit_price=reference_exit_price,
        position_side=exit_side,
    )
    return passes_exit_profit_policy(
        strategies=strategies,
        realized_bps=realized_bps,
    )


def runtime_intent_exit_side(
    *,
    action: str,
    explain: tuple[str, ...],
) -> Literal["long", "short"] | None:
    tokens = {str(item).strip().lower() for item in explain if str(item).strip()}
    if MICROBAR_PAIR_EXIT_RATIONALE not in tokens:
        return None
    normalized_action = action.strip().lower()
    if normalized_action == "sell":
        return "long"
    if normalized_action == "buy":
        return "short"
    return None


def default_trailing_stop_requires_structure_loss(
    strategies: list[Strategy],
) -> bool:
    continuation_strategy_types = {
        "breakout_continuation_long_v1",
        "late_day_continuation_long_v1",
    }
    return any(
        str(strategy.universe_type or "").strip().lower() in continuation_strategy_types
        for strategy in strategies
    )


def trailing_stop_structure_loss_confirmed(
    *,
    signal: SignalEnvelope,
    price: Decimal,
    strategies: list[Strategy],
) -> bool:
    payload = signal.payload or {}
    vwap_threshold = resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key="long_trailing_stop_structure_loss_vwap_bps",
    )
    if vwap_threshold is None:
        vwap_threshold = Decimal("0")
    opening_range_high_threshold = resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key="long_trailing_stop_structure_loss_price_vs_opening_range_high_bps",
    )
    if opening_range_high_threshold is None:
        opening_range_high_threshold = Decimal("0")
    session_range_position_max = resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key="long_trailing_stop_structure_loss_session_range_position_max",
    )
    if session_range_position_max is None:
        session_range_position_max = Decimal("0.80")
    price_vs_vwap_w5m_bps = signal_decimal_feature_bps(
        signal,
        key="price_vs_vwap_w5m_bps",
        price=price,
        reference_key="vwap_w5m",
    )
    price_vs_opening_range_high_bps = signal_decimal_feature_bps(
        signal,
        key="price_vs_opening_range_high_bps",
        price=price,
        reference_key="opening_range_high",
    )
    price_position_in_session_range = optional_decimal(
        payload.get("price_position_in_session_range")
    )
    return (
        price_vs_opening_range_high_bps is not None
        and price_vs_opening_range_high_bps <= opening_range_high_threshold
    ) or (
        price_vs_vwap_w5m_bps is not None
        and price_vs_vwap_w5m_bps <= vwap_threshold
        and price_position_in_session_range is not None
        and price_position_in_session_range <= session_range_position_max
    )


def signal_spread(signal: SignalEnvelope) -> Decimal | None:
    payload = signal.payload or {}
    spread = optional_decimal(payload.get("spread"))
    if spread is not None and spread > 0:
        return spread

    bid = optional_decimal(payload.get("imbalance_bid_px"))
    ask = optional_decimal(payload.get("imbalance_ask_px"))
    imbalance_payload = payload.get("imbalance")
    if isinstance(imbalance_payload, Mapping):
        imbalance_mapping = cast(Mapping[str, Any], imbalance_payload)
        if bid is None:
            bid = optional_decimal(imbalance_mapping.get("bid_px"))
        if ask is None:
            ask = optional_decimal(imbalance_mapping.get("ask_px"))
        if spread is None:
            spread = optional_decimal(imbalance_mapping.get("spread"))
    if spread is not None and spread > 0:
        return spread
    if bid is None or ask is None or ask <= bid:
        return None
    return ask - bid


def signal_decimal_feature_bps(
    signal: SignalEnvelope,
    *,
    key: str,
    price: Decimal,
    reference_key: str,
) -> Decimal | None:
    payload = signal.payload or {}
    direct_value = optional_decimal(payload.get(key))
    if direct_value is not None:
        return direct_value
    reference_value = optional_decimal(payload.get(reference_key))
    if reference_value is None or reference_value <= 0 or price <= 0:
        return None
    return ((price - reference_value) / reference_value) * Decimal("10000")


def near_touch_exit_price(
    price: Decimal,
    spread: Decimal | None,
    action: str,
) -> Decimal:
    if spread is None or spread <= 0:
        return normalize_exit_price(price)
    half_spread = spread / Decimal("2")
    if action == "buy":
        return normalize_exit_price(price + half_spread)
    return normalize_exit_price(price - half_spread)


def normalize_exit_price(price: Decimal) -> Decimal:
    tick_size = (
        Decimal("0.0001") if price.copy_abs() < Decimal("1") else Decimal("0.01")
    )
    return price.quantize(tick_size, rounding=ROUND_HALF_UP)


def position_opened_at_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> datetime | None:
    if not positions:
        return None
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != symbol.strip().upper():
            continue
        raw = position.get("opened_at")
        if raw is None:
            return None
        try:
            parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return None


def position_age_seconds_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
    *,
    signal_ts: datetime,
) -> int | None:
    opened_at = position_opened_at_for_symbol(positions, symbol)
    if opened_at is None:
        return None
    age_seconds = (
        signal_ts.astimezone(timezone.utc) - opened_at.astimezone(timezone.utc)
    ).total_seconds()
    return max(0, int(age_seconds))


def count_open_long_positions(positions: Optional[list[dict[str, Any]]]) -> int:
    if not positions:
        return 0
    open_symbols: set[str] = set()
    for position in positions:
        symbol = str(position.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        qty = position_qty_from_payload(position)
        if qty is not None:
            if qty > 0:
                open_symbols.add(symbol)
            continue
        raw_value = (
            position.get("market_value")
            or position.get("current_value")
            or position.get("notional")
        )
        if raw_value is None:
            continue
        try:
            market_value = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        if market_value > 0:
            open_symbols.add(symbol)
    return len(open_symbols)


__all__ = (
    "decision_position_exit_type",
    "passes_runtime_trade_policy",
    "passes_signal_exit_policy",
    "record_runtime_trade_policy_decision",
    "resolve_runtime_trade_policy",
    "resolve_strategy_time_in_force",
    "runtime_intent_exit_side",
    "runtime_trade_policy_owner",
    "count_open_long_positions",
    "default_trailing_stop_requires_structure_loss",
    "near_touch_exit_price",
    "normalize_exit_price",
    "position_age_seconds_for_symbol",
    "position_exit_bypasses_min_hold",
    "position_opened_at_for_symbol",
    "resolve_runtime_trade_policy_session_state",
    "signal_decimal_feature_bps",
    "signal_spread",
    "trailing_stop_structure_loss_confirmed",
)
