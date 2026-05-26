from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Execution, LeanExecutionShadowEvent, TradeDecision
from app.trading.execution import (
    _apply_execution_status,
    _extract_execution_metadata,
    _json_default,
    _normalize_reject_reason,
    _persist_lean_shadow_event,
    _stable_payload_hash,
)
from app.trading.models import StrategyDecision


class TestExecutionRuntimeMetadataCoverage(TestCase):
    def test_stable_payload_hash_handles_empty_and_non_json_scalars(self) -> None:
        self.assertIsNone(_stable_payload_hash(None))
        self.assertIsNone(_stable_payload_hash({}))
        self.assertEqual(
            _json_default(datetime(2026, 2, 10, 15, 30, tzinfo=timezone.utc)),
            "2026-02-10T15:30:00+00:00",
        )
        self.assertEqual(_json_default(Decimal("0.125")), "0.125")
        self.assertTrue(_json_default(object()).startswith("<object object at "))

        payload_hash = _stable_payload_hash(
            {
                "event_ts": datetime(2026, 2, 10, 15, 30, tzinfo=timezone.utc),
                "cost": Decimal("0.125"),
            }
        )

        self.assertIsNotNone(payload_hash)
        assert payload_hash is not None
        self.assertEqual(len(payload_hash), 64)

    def test_extract_execution_metadata_captures_direct_hashes_and_cost_fields(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1.0"),
            params={
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-model-sha",
                "lineage_hash": "lineage-sha",
                "candidate_evaluation_key": "candidate-eval-1",
                "source_query_digest": "dataset-sha",
                "commission": "0.42",
                "cost_basis": "broker_reported_commission",
            },
        )

        metadata = _extract_execution_metadata(decision)

        assert isinstance(metadata, dict)
        self.assertEqual(metadata.get("execution_policy_hash"), "policy-sha")
        self.assertEqual(metadata.get("cost_model_hash"), "cost-model-sha")
        self.assertEqual(metadata.get("lineage_hash"), "lineage-sha")
        self.assertEqual(metadata.get("candidate_evaluation_key"), "candidate-eval-1")
        self.assertEqual(metadata.get("replay_data_hash"), "dataset-sha")
        self.assertEqual(metadata.get("cost_amount"), "0.42")
        self.assertEqual(metadata.get("cost_basis"), "broker_reported_commission")

    def test_extract_execution_metadata_prefers_persisted_runtime_payload(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1.0"),
            params={
                "execution_cost": {
                    "fee_amount": "9.99",
                    "fee_basis": "transient_wrong_basis",
                },
            },
        )
        decision_row = TradeDecision(
            strategy_id=uuid.uuid4(),
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json={
                "params": {
                    "execution_cost": {
                        "fee_amount": "0.07",
                        "fee_basis": "broker_reported_fees",
                    },
                }
            },
            rationale=None,
            status="planned",
            decision_hash="runtime-cost",
        )

        metadata = _extract_execution_metadata(decision, decision_row=decision_row)

        assert isinstance(metadata, dict)
        self.assertEqual(
            metadata.get("runtime_ledger_cost"),
            {"fee_amount": "0.07", "fee_basis": "broker_reported_fees"},
        )
        self.assertEqual(metadata.get("cost_amount"), "0.07")
        self.assertEqual(metadata.get("cost_basis"), "broker_reported_fees")

    def test_normalize_reject_reason_material_taxonomy_edges(self) -> None:
        cases = {
            "market_context_stale": (
                "market_context_block",
                "market_context",
                "market_context",
            ),
            "symbol_capacity_exhausted": (
                "symbol_capacity_exhausted",
                "capacity",
                "portfolio_sizing",
            ),
            "max_position_pct_exceeded": (
                "max_position_pct_exceeded",
                "policy",
                "risk_engine",
            ),
            "local_pre_submit_rejected code=shorting_metadata_unavailable": (
                "shorting_metadata_unavailable",
                "broker_precheck",
                "local_pre_submit",
            ),
            "broker_precheck_rejected code=precheck_sell_qty_exceeds_available": (
                "sell_inventory_unavailable",
                "broker_precheck",
                "broker_precheck",
            ),
            "broker_precheck_rejected": (
                "broker_precheck_rejected",
                "broker_precheck",
                "broker_precheck",
            ),
        }

        for reason, expected in cases.items():
            with self.subTest(reason=reason):
                normalized = _normalize_reject_reason(reason)
                self.assertEqual(
                    (
                        normalized.atomic_reason,
                        normalized.reject_class,
                        normalized.reject_origin,
                    ),
                    expected,
                )

    def test_apply_execution_status_uses_simulation_signal_timestamp(self) -> None:
        decision_row = TradeDecision(
            strategy_id=uuid.uuid4(),
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json={"symbol": "AAPL"},
            rationale=None,
            status="planned",
            decision_hash="signal-timestamp",
        )
        execution = Execution(
            alpaca_account_label="paper",
            alpaca_order_id="filled-sim-order",
            client_order_id="signal-timestamp",
            symbol="AAPL",
            side="buy",
            order_type="market",
            time_in_force="day",
            submitted_qty=Decimal("1"),
            filled_qty=Decimal("1"),
            status="filled",
            raw_order={},
        )
        execution.simulation_json = {"signal_event_ts": "2026-02-10T15:30:00Z"}

        _apply_execution_status(decision_row, execution, "paper")

        self.assertEqual(
            decision_row.executed_at,
            datetime(2026, 2, 10, 15, 30, tzinfo=timezone.utc),
        )

    def test_persist_lean_shadow_event_records_unknown_parity_status(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        try:
            with Session(engine) as session:
                execution = Execution(
                    alpaca_account_label="paper",
                    alpaca_order_id="lean-shadow-order",
                    client_order_id="lean-shadow",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("2"),
                    filled_qty=Decimal("2"),
                    status="filled",
                    raw_order={},
                )
                session.add(execution)
                session.flush()

                decision = StrategyDecision(
                    strategy_id="strategy-1",
                    symbol="AAPL",
                    event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("2.0"),
                    params={"price": Decimal("100")},
                )

                _persist_lean_shadow_event(
                    session,
                    execution=execution,
                    order_payload={
                        "_execution_correlation_id": "corr-lean",
                        "_lean_shadow": {
                            "intent_notional": "200",
                            "parity_status": "   ",
                        },
                    },
                    decision=decision,
                )
                session.commit()

                event = session.execute(select(LeanExecutionShadowEvent)).scalar_one()
                self.assertEqual(event.correlation_id, "corr-lean")
                self.assertEqual(event.parity_status, "unknown")
                self.assertEqual(event.intent_notional, Decimal("200"))
        finally:
            engine.dispose()
