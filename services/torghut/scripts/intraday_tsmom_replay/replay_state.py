from __future__ import annotations

import time as time_mod
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from app.trading.costs import TransactionCostModel
from app.trading.decisions import DecisionEngine
from app.trading.economic_policy import EconomicPolicy
from app.trading.evaluation_trace import NearMissRecord, ReplayTraceRecord
from app.trading.execution_policy import ExecutionPolicy
from app.trading.models import SignalEnvelope
from app.trading.quote_quality import SignalQuoteQualityTracker
from app.trading.session_context import SessionContextTracker

from .ledger import _build_replay_ledger_context
from .order_lifecycle import _init_order_lifecycle_stats
from .replay_stats import _init_day_stats, _init_funnel_stats
from .replay_types import ClosedTrade, PendingOrder, PositionState, ReplayConfig
from .strategy_loading import _load_strategies


@dataclass
class ReplayRunState:
    config: ReplayConfig
    economic_policy: EconomicPolicy
    strategies: list[Any]
    strategies_by_id: dict[str, Any]
    capture_runtime_traces: bool
    engine: Any
    execution_policy: ExecutionPolicy
    quote_quality: SignalQuoteQualityTracker
    session_context: SessionContextTracker
    cost_model: TransactionCostModel
    ledger_context: Any | None
    exact_ledger_rows: list[dict[str, Any]] | None
    positions: dict[tuple[str, str], PositionState]
    pending_orders: dict[tuple[str, str], PendingOrder]
    last_prices: dict[str, Decimal]
    last_signals: dict[str, SignalEnvelope]
    cash: Decimal
    day_stats: dict[str, dict[str, Any]]
    funnel_stats: dict[tuple[str, str], dict[str, Any]]
    order_lifecycle_stats: dict[str, Any]
    order_lifecycle_day_stats: dict[str, dict[str, Any]]
    order_lifecycle_symbol_stats: dict[str, dict[str, Any]]
    trace_records: list[ReplayTraceRecord]
    near_misses: dict[str, list[NearMissRecord]]
    all_closed_trades: list[ClosedTrade]
    current_day: date | None
    signals_seen: int
    replay_started_at: float
    last_progress_at: float

    @classmethod
    def create(
        cls,
        config: ReplayConfig,
        economic_policy: EconomicPolicy,
    ) -> "ReplayRunState":
        strategies = _load_strategies(config.strategy_configmap_path)
        cost_model = TransactionCostModel(economic_policy.cost_model_config())
        ledger_context = (
            _build_replay_ledger_context(
                config=config,
                cost_model=cost_model,
                economic_policy=economic_policy,
            )
            if config.capture_exact_replay_ledger
            else None
        )
        capture_runtime_traces = config.capture_traces or config.capture_trace_funnel
        quote_policy = economic_policy.quote_quality_policy()
        replay_started_at = time_mod.monotonic()
        return cls(
            config=config,
            economic_policy=economic_policy,
            strategies=strategies,
            strategies_by_id={str(strategy.id): strategy for strategy in strategies},
            capture_runtime_traces=capture_runtime_traces,
            engine=DecisionEngine(
                price_fetcher=None,
                runtime_trace_enabled=capture_runtime_traces,
            ),
            execution_policy=ExecutionPolicy(economic_policy=economic_policy),
            quote_quality=SignalQuoteQualityTracker(policy=quote_policy),
            session_context=SessionContextTracker(quote_quality_policy=quote_policy),
            cost_model=cost_model,
            ledger_context=ledger_context,
            exact_ledger_rows=[] if ledger_context is not None else None,
            positions={},
            pending_orders={},
            last_prices={},
            last_signals={},
            cash=config.start_equity,
            day_stats={},
            funnel_stats={},
            order_lifecycle_stats=_init_order_lifecycle_stats(),
            order_lifecycle_day_stats={},
            order_lifecycle_symbol_stats={},
            trace_records=[],
            near_misses={},
            all_closed_trades=[],
            current_day=None,
            signals_seen=0,
            replay_started_at=replay_started_at,
            last_progress_at=replay_started_at,
        )


def _active_day_stats(state: ReplayRunState, target_day: date) -> dict[str, Any]:
    return state.day_stats.setdefault(target_day.isoformat(), _init_day_stats())


def _active_symbol_funnel(
    state: ReplayRunState,
    target_day: date,
    symbol: str,
) -> dict[str, Any]:
    return state.funnel_stats.setdefault(
        (target_day.isoformat(), symbol),
        _init_funnel_stats(),
    )


__all__ = [
    "ReplayRunState",
    "_active_day_stats",
    "_active_symbol_funnel",
]
