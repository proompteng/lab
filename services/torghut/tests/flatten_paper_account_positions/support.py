from __future__ import annotations

import json
import sys
from contextlib import redirect_stdout
from datetime import datetime, timezone
from decimal import Decimal
from io import StringIO
from types import SimpleNamespace
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Execution, ExecutionOrderEvent, Strategy, TradeDecision
from app.trading.models import StrategyDecision
from scripts import flatten_paper_account_positions as flatten_script
from scripts.flatten_paper_account_positions import (
    flatten_paper_account_positions,
)


class FakeFlattenClient:
    def __init__(self, positions: list[dict[str, Any]] | None = None) -> None:
        self.positions = positions or []
        self.cancelled = False
        self.submitted: list[dict[str, Any]] = []

    def list_positions(self) -> list[dict[str, Any]]:
        return self.positions

    def cancel_all_orders(self) -> list[dict[str, Any]]:
        self.cancelled = True
        return [{"id": "cancel-1", "status": "canceled"}]

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _ = limit_price, stop_price
        order = {
            "id": f"order-{len(self.submitted) + 1}",
            "symbol": symbol,
            "side": side,
            "qty": str(qty),
            "type": order_type,
            "time_in_force": time_in_force,
            "limit_price": limit_price,
            "status": "accepted",
            "filled_qty": "0",
            "extended_hours": (extra_params or {}).get("extended_hours"),
            "client_order_id": (extra_params or {}).get("client_order_id"),
        }
        self.submitted.append(order)
        return order


class RejectingFlattenClient(FakeFlattenClient):
    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        _ = (
            symbol,
            side,
            qty,
            order_type,
            time_in_force,
            limit_price,
            stop_price,
            extra_params,
        )
        raise RuntimeError("simulated close rejection")


class MissingOrderIdFlattenClient(FakeFlattenClient):
    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        order = super().submit_order(
            symbol,
            side,
            qty,
            order_type,
            time_in_force,
            limit_price,
            stop_price,
            extra_params,
        )
        order.pop("id", None)
        return order


class SequencedFlattenClient(FakeFlattenClient):
    def __init__(self, position_snapshots: list[list[dict[str, Any]]]) -> None:
        super().__init__(position_snapshots[0] if position_snapshots else [])
        self.position_snapshots = list(position_snapshots)

    def list_positions(self) -> list[dict[str, Any]]:
        if len(self.position_snapshots) > 1:
            return self.position_snapshots.pop(0)
        return self.position_snapshots[0] if self.position_snapshots else []


class FakeSessionContext:
    def __enter__(self) -> object:
        return object()

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None


class FakeHttpResponse:
    def __init__(self, payload: object, status: int = 200) -> None:
        self.payload = payload
        self.status = status

    def __enter__(self) -> "FakeHttpResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class FakeBytesResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self.body = body
        self.status = status

    def __enter__(self) -> "FakeBytesResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


def _memory_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False, future=True)


def _source_strategy(session: Session) -> Strategy:
    strategy = Strategy(
        name="microbar-cross-sectional-pairs-v1",
        description="H-PAIRS runtime source strategy",
        enabled=True,
        base_timeframe="1Min",
        universe_type="symbols",
        universe_symbols=["AMAT"],
    )
    session.add(strategy)
    session.commit()
    session.refresh(strategy)
    return strategy


def _source_decision(session: Session, strategy: Strategy) -> TradeDecision:
    decision = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label="TORGHUT_SIM",
        symbol="AMAT",
        timeframe="1Min",
        decision_json={
            "action": "buy",
            "qty": "2",
            "source_candidate_ids": ["c88421d619759b2cfaa6f4d0"],
            "source_hypothesis_ids": ["H-PAIRS-01"],
            "source_strategy_names": ["microbar-cross-sectional-pairs-v1"],
            "source_decision_mode": "strategy_signal_paper",
            "profit_proof_eligible": True,
        },
        rationale="source runtime paper decision",
        decision_hash="source-decision-hash",
        status="submitted",
    )
    session.add(decision)
    session.commit()
    session.refresh(decision)
    return decision


class _TestFlattenPaperAccountPositionsBase(TestCase):
    pass


__all__ = [
    "Any",
    "Base",
    "Decimal",
    "Execution",
    "ExecutionOrderEvent",
    "FakeBytesResponse",
    "FakeFlattenClient",
    "FakeHttpResponse",
    "FakeSessionContext",
    "MissingOrderIdFlattenClient",
    "RejectingFlattenClient",
    "SequencedFlattenClient",
    "Session",
    "SimpleNamespace",
    "Strategy",
    "StrategyDecision",
    "StringIO",
    "TestCase",
    "TradeDecision",
    "_TestFlattenPaperAccountPositionsBase",
    "_memory_session",
    "_source_decision",
    "_source_strategy",
    "cast",
    "create_engine",
    "datetime",
    "flatten_paper_account_positions",
    "flatten_script",
    "json",
    "patch",
    "redirect_stdout",
    "select",
    "sys",
    "timezone",
]
