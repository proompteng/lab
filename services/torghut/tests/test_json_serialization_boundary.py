from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Execution, LLMDecisionReview, PositionSnapshot, Strategy, TradeDecision
from app.snapshots import snapshot_account_and_positions, sync_order_to_db


def _assert_no_uuid(value: Any) -> None:
    if isinstance(value, uuid.UUID):
        raise AssertionError("uuid.UUID instance leaked into JSON payload")
    if isinstance(value, Mapping):
        for child in value.values():
            _assert_no_uuid(child)
        return
    if isinstance(value, list):
        for child in value:
            _assert_no_uuid(child)


class UUIDPositionsAlpacaClient:
    def get_account(self) -> dict[str, Any]:  # pragma: no cover - simple stub
        return {
            "equity": "10000",
            "cash": "5000",
            "buying_power": "20000",
        }

    def list_positions(self) -> list[dict[str, Any]]:  # pragma: no cover - simple stub
        return [
            {"symbol": "AAPL", "qty": "1", "asset_id": uuid.uuid4()},
        ]


class TestJsonSerializationBoundary(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_trade_decision_decision_json_coerces_uuid(self) -> None:
        with Session(self.engine) as session:
            strategy = Strategy(
                name="demo",
                description="demo strat",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()

            payload = {"decision_id": uuid.uuid4(), "nested": {"strategy_id": uuid.uuid4()}}
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=payload,
                rationale="test",
                decision_hash="decision-uuid",
            )
            session.add(decision)
            session.commit()

            stored = session.execute(select(TradeDecision)).scalar_one()
            _assert_no_uuid(stored.decision_json)
            json.dumps(stored.decision_json)

    def test_execution_raw_order_coerces_uuid(self) -> None:
        with Session(self.engine) as session:
            sync_order_to_db(
                session,
                {
                    "id": "order-uuid",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "asset_id": uuid.uuid4(),
                },
            )

            stored = session.execute(select(Execution)).scalar_one()
            _assert_no_uuid(stored.raw_order)
            json.dumps(stored.raw_order)

    def test_position_snapshot_positions_coerces_uuid(self) -> None:
        client = UUIDPositionsAlpacaClient()
        with Session(self.engine) as session:
            snapshot_account_and_positions(session, client, "paper")

            stored = session.execute(select(PositionSnapshot)).scalar_one()
            _assert_no_uuid(stored.positions)
            json.dumps(stored.positions)

    def test_llm_decision_review_input_and_response_json_coerces_uuid(self) -> None:
        review_id = uuid.uuid4()
        with Session(self.engine) as session:
            strategy = Strategy(
                name="demo",
                description="demo strat",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"action": "buy", "qty": "1"},
                rationale="test",
                decision_hash="decision-uuid-review",
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)

            review = LLMDecisionReview(
                trade_decision_id=decision.id,
                model="gpt-test",
                prompt_version="v0",
                input_json={"review_id": review_id},
                response_json={"review_id": review_id},
                verdict="approve",
                confidence=None,
                adjusted_qty=None,
                adjusted_order_type=None,
                rationale=None,
                risk_flags=None,
                tokens_prompt=None,
                tokens_completion=None,
            )
            session.add(review)
            session.commit()
            session.refresh(review)

            stored = session.execute(select(LLMDecisionReview)).scalar_one()
            _assert_no_uuid(stored.input_json)
            _assert_no_uuid(stored.response_json)
            json.dumps(stored.input_json)
            json.dumps(stored.response_json)

    def test_json_type_accepts_uuid_in_update_path(self) -> None:
        with Session(self.engine) as session:
            execution = Execution(
                trade_decision_id=None,
                alpaca_order_id="order-2",
                client_order_id="client-2",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="accepted",
                raw_order={"id": "order-2"},
                last_update_at=datetime.now(timezone.utc),
            )
            session.add(execution)
            session.commit()

            execution.raw_order = {"id": "order-2", "updated_by": uuid.uuid4()}
            session.add(execution)
            session.commit()

            stored = session.execute(select(Execution)).scalar_one()
            _assert_no_uuid(stored.raw_order)
            json.dumps(stored.raw_order)

