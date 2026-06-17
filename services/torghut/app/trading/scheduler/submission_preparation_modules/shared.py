from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
import logging
from typing import TYPE_CHECKING, Any, Literal, TypeAlias

from ..pipeline_modules.contexts import OrderSubmissionRequest

OrderSubmitRequest: TypeAlias = OrderSubmissionRequest

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from sqlalchemy.orm import Session

    from ....models import Strategy, TradeDecision
    from ...models import StrategyDecision
    from ...prices import MarketSnapshot
    from .quote_sizing import TargetProbeQuantityResolution


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SubmissionDecisionContext:
    session: Session
    decision_row: TradeDecision
    strategy: Strategy
    account: dict[str, str]
    positions: list[dict[str, Any]]


@dataclass(frozen=True)
class RiskVerdictRequest:
    context: SubmissionDecisionContext
    decision: StrategyDecision
    symbol_allowlist: set[str]
    execution_advisor: Mapping[str, Any] | None


@dataclass(frozen=True)
class TradingSubmissionRequest:
    session: Session
    decision: StrategyDecision
    decision_row: TradeDecision


@dataclass(frozen=True)
class SubmitRejectionRequest:
    session: Session
    decision: StrategyDecision
    decision_row: TradeDecision
    selected_adapter_name: str
    reason: str
    rejection_type: str
    metadata: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class QuoteRouteabilityInputs:
    price_snapshot: Mapping[str, Any]
    target_price_snapshot: Mapping[str, Any]
    target_quote_snapshot: Mapping[str, Any] | None
    snapshot: MarketSnapshot | None


@dataclass(frozen=True)
class QuoteRouteabilityValues:
    price: Decimal | None
    bid: Decimal | None
    ask: Decimal | None
    spread: Decimal | None
    source: str | None
    quote_as_of: datetime | None
    quote_lookup_diagnostics: Mapping[str, object] | None


@dataclass(frozen=True)
class QuoteRouteabilityPayloadRequest:
    decision: StrategyDecision
    status: Any
    source: str | None
    quote_as_of: datetime | None
    quote_lookup_diagnostics: Mapping[str, object] | None = None
    target_mismatch: Mapping[str, object] | None = None


@dataclass(frozen=True)
class SubmissionPreparationRequest:
    session: Session
    decision: StrategyDecision
    decision_row: TradeDecision
    strategy: Strategy
    account: dict[str, str]
    positions: list[dict[str, Any]]


@dataclass(frozen=True)
class TargetSizingPriceRequest:
    target: Mapping[str, Any]
    symbol: str
    action: Literal["buy", "sell"]
    event_ts: datetime
    timeframe: str


@dataclass(frozen=True)
class TargetQuantityResolutionRequest:
    target: Mapping[str, Any]
    symbol: str
    symbols: Sequence[str]
    action: Literal["buy", "sell"]
    requested_qty: Decimal
    symbol_quantities: Mapping[str, Decimal]
    max_notional: Decimal
    event_ts: datetime
    timeframe: str


@dataclass(frozen=True)
class TargetSizingContext:
    target: Mapping[str, Any]
    symbol: str
    symbols: list[str]
    symbol_quantities: Mapping[str, Decimal]
    requested_qty: Decimal
    action: Literal["buy", "sell"]
    max_notional: Decimal | None


@dataclass(frozen=True)
class TargetQuantityDecisionRequest:
    decision: StrategyDecision
    sizing_context: TargetSizingContext
    quantity_resolution: TargetProbeQuantityResolution | None
    positions: list[dict[str, Any]]
