from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, NamedTuple

from sqlalchemy.orm import Session

from ....models import Strategy
from ...models import StrategyDecision
from ..pipeline.contexts import AllocationDecisionContext
from ..target_plan_helpers import PaperRouteRetryTransition


class PaperRouteProbeRunContext(NamedTuple):
    session: Session
    strategies: list[Strategy]
    account: dict[str, str]
    positions: list[dict[str, Any]]
    allowed_symbols: set[str]


class PaperRouteProbeTargetLookup(NamedTuple):
    session: Session | None = None
    strategies: Sequence[Strategy] | None = None


class PaperRouteProbeContextRequest(NamedTuple):
    proof_floor: Mapping[str, object]
    decision: StrategyDecision
    strategy: Strategy | None = None
    target_lookup: PaperRouteProbeTargetLookup = PaperRouteProbeTargetLookup()


class PaperRouteProbeExitPositionRestoreContext(NamedTuple):
    positions: list[dict[str, Any]]
    decision: StrategyDecision
    metadata: Mapping[str, Any]
    price: Decimal | None
    execution_adapter: Any | None
    trading_mode: str | None


class PaperRouteProbeExitRecordLookup(NamedTuple):
    session: Session
    strategy: Strategy
    symbol: str
    session_open: datetime
    exit_due_at: datetime


class PaperRouteProbeExitPlan(NamedTuple):
    exit_minute: int
    effective_exit_minute: int
    exit_due_at: datetime
    exit_event_ts: datetime


class PaperRouteProbeContextPayloadParts(NamedTuple):
    proof_floor: Mapping[str, object]
    decision: StrategyDecision
    symbol: str
    cap: Decimal
    target_context: Any
    eligibility: Any
    exit_timing: Any
    mode: Any


class PaperRouteProbeFilledExecution(NamedTuple):
    strategy: Strategy
    symbol: str
    timeframe: str
    session_open: datetime
    side: Literal["buy", "sell"]
    filled_qty: Decimal
    avg_fill_price: Decimal | None
    exit_minute_after_open: int | None
    exit_source: str | None
    lineage: Mapping[str, Any]
    execution_created_at: datetime

    @property
    def exposure_key(self) -> tuple[str, str, str]:
        return (str(self.strategy.id), self.symbol, self.session_open.isoformat())


def _lineage_dict() -> dict[str, Any]:
    return {}


@dataclass
class PaperRouteProbeExposure:
    strategy: Strategy
    symbol: str
    timeframe: str
    session_open: datetime
    net_qty: Decimal = Decimal("0")
    buy_qty: Decimal = Decimal("0")
    buy_notional: Decimal = Decimal("0")
    sell_qty: Decimal = Decimal("0")
    sell_notional: Decimal = Decimal("0")
    latest_entry_at: datetime | None = None
    exit_minute_after_open: int | None = None
    exit_source: str | None = None
    lineage: dict[str, Any] = field(default_factory=_lineage_dict)

    @property
    def exit_action(self) -> Literal["buy", "sell"]:
        return "sell" if self.net_qty > 0 else "buy"

    @property
    def exit_qty(self) -> Decimal:
        return abs(self.net_qty)

    @property
    def avg_entry_price(self) -> Decimal | None:
        if self.net_qty > 0 and self.buy_qty > 0:
            return self.buy_notional / self.buy_qty
        if self.net_qty < 0 and self.sell_qty > 0:
            return self.sell_notional / self.sell_qty
        return None

    def record_fill(self, fill: PaperRouteProbeFilledExecution) -> None:
        signed_qty = fill.filled_qty if fill.side == "buy" else -fill.filled_qty
        self.net_qty += signed_qty
        if fill.exit_source is not None:
            self.exit_source = fill.exit_source
        if fill.exit_minute_after_open is not None:
            self.exit_minute_after_open = fill.exit_minute_after_open
        if fill.avg_fill_price is not None and fill.avg_fill_price > 0:
            notional = fill.filled_qty * fill.avg_fill_price
            if fill.side == "buy":
                self.buy_qty += fill.filled_qty
                self.buy_notional += notional
            else:
                self.sell_qty += fill.filled_qty
                self.sell_notional += notional
        if (
            self.latest_entry_at is None
            or fill.execution_created_at > self.latest_entry_at
        ):
            self.latest_entry_at = fill.execution_created_at


class PaperRouteProbeRuntime:
    account_label: str
    executor: Any
    execution_adapter: Any | None
    state: Any

    def _trading_now(self) -> datetime:
        raise NotImplementedError

    def _is_market_session_open(self, *args: Any, **kwargs: Any) -> bool:
        raise NotImplementedError

    def _record_bounded_target_plan_blocker(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        raise NotImplementedError

    def _paper_route_retry_transition(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> PaperRouteRetryTransition | None:
        raise NotImplementedError

    def _paper_route_probe_retry_decisions(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> list[StrategyDecision]:
        raise NotImplementedError

    def _paper_route_probe_exit_decisions(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> list[StrategyDecision]:
        raise NotImplementedError

    def _paper_route_probe_entry_after_exit_minute(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError

    def _paper_route_probe_exit_minute_after_open(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> int | None:
        raise NotImplementedError

    def _paper_route_target_plan_reserves_account(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError

    def _handle_decision(
        self,
        context: AllocationDecisionContext,
        decision: StrategyDecision,
    ) -> Any: ...

    def _apply_simple_projected_buying_power(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        raise NotImplementedError

    def _apply_simple_projected_position(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        raise NotImplementedError

    def _proof_floor_market_session_open(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> bool:
        raise NotImplementedError

    def _external_paper_route_target_probe_symbols_cached(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> tuple[set[str], str | None, list[dict[str, Any]]]:
        raise NotImplementedError

    def _paper_route_target_source_cap(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> Decimal | None:
        raise NotImplementedError

    def _proof_floor_symbol_route_probe_reasons(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> set[str]:
        raise NotImplementedError

    def _proof_floor_paper_route_probe_symbols(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> set[str]:
        raise NotImplementedError

    def _proof_floor_route_repair_symbols(
        self,
        *args: Any,
        **kwargs: Any,
    ) -> set[str]:
        raise NotImplementedError
