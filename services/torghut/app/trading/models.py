"""Pydantic models for trading pipeline data transfer objects."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class SignalEnvelope(BaseModel):
    """Normalized signal payload from ClickHouse."""

    model_config = ConfigDict(extra="allow")

    event_ts: datetime
    symbol: str
    payload: dict[str, Any] = Field(default_factory=dict)
    timeframe: Optional[str] = None
    ingest_ts: Optional[datetime] = None
    seq: Optional[int] = None
    source: Optional[str] = None


class StrategyDecision(BaseModel):
    """Decision emitted by a strategy evaluation."""

    model_config = ConfigDict(extra="allow")

    strategy_id: str
    symbol: str
    event_ts: datetime
    timeframe: str
    action: Literal["buy", "sell"]
    qty: Decimal
    order_type: Literal["market", "limit", "stop", "stop_limit"] = "market"
    time_in_force: Literal["day", "gtc", "ioc", "fok"] = "day"
    limit_price: Optional[Decimal] = None
    stop_price: Optional[Decimal] = None
    rationale: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)


class RiskCheckResult(BaseModel):
    """Risk engine verdict."""

    approved: bool
    reasons: list[str] = Field(default_factory=list)


class ExecutionRequest(BaseModel):
    """Execution request sent to Alpaca."""

    model_config = ConfigDict(extra="allow")

    decision_id: str
    symbol: str
    side: Literal["buy", "sell"]
    qty: Decimal
    order_type: Literal["market", "limit", "stop", "stop_limit"]
    time_in_force: Literal["day", "gtc", "ioc", "fok"]
    limit_price: Optional[Decimal] = None
    stop_price: Optional[Decimal] = None
    client_order_id: Optional[str] = None
    extra_params: dict[str, Any] = Field(default_factory=dict)


def decision_hash(decision: StrategyDecision) -> str:
    """Create an idempotency hash for a strategy decision."""

    params_payload = {
        "strategy_id": decision.strategy_id,
        "symbol": decision.symbol,
        "event_ts": decision.event_ts.isoformat(),
        "action": decision.action,
        "qty": str(decision.qty),
        "order_type": decision.order_type,
        "time_in_force": decision.time_in_force,
        "limit_price": str(decision.limit_price) if decision.limit_price is not None else None,
        "stop_price": str(decision.stop_price) if decision.stop_price is not None else None,
        "params": decision.params,
    }
    raw = json.dumps(params_payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


__all__ = [
    "SignalEnvelope",
    "StrategyDecision",
    "RiskCheckResult",
    "ExecutionRequest",
    "decision_hash",
]
