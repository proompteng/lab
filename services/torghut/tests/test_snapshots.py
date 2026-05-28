from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any, List
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.snapshots import snapshot_account_and_positions, sync_order_to_db


class DummyAlpacaClient:
    def __init__(self) -> None:
        self.positions: List[dict[str, Any]] = [
            {"symbol": "AAPL", "qty": "1"},
        ]

    def get_account(self) -> dict[str, Any]:  # pragma: no cover - simple stub
        return {
            "equity": "10000",
            "cash": "5000",
            "buying_power": "20000",
        }

    def list_positions(self) -> List[dict[str, Any]]:  # pragma: no cover - simple stub
        return self.positions


class TestSnapshots(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_snapshot_account_and_positions_inserts_row(self) -> None:
        client = DummyAlpacaClient()
        with Session(self.engine) as session:
            snapshot = snapshot_account_and_positions(session, client, "paper")

            rows = session.execute(select(type(snapshot))).scalars().all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(snapshot.equity, Decimal("10000"))
            self.assertEqual(snapshot.cash, Decimal("5000"))
            self.assertEqual(snapshot.buying_power, Decimal("20000"))
            self.assertEqual(len(snapshot.positions), 1)

    def test_snapshot_account_and_positions_serializes_uuid_payloads(self) -> None:
        client = DummyAlpacaClient()
        sample_id = uuid.uuid4()
        client.positions = [
            {
                "symbol": "AAPL",
                "qty": "1",
                "position_id": sample_id,
                "nested": {"order_id": sample_id},
            },
        ]
        with Session(self.engine) as session:
            snapshot = snapshot_account_and_positions(session, client, "paper")

            def contains_uuid(value: Any) -> bool:
                if isinstance(value, uuid.UUID):
                    return True
                if isinstance(value, dict):
                    return any(contains_uuid(item) for item in value.values())
                if isinstance(value, list):
                    return any(contains_uuid(item) for item in value)
                return False

            self.assertFalse(contains_uuid(snapshot.positions))
            self.assertEqual(snapshot.positions[0]["position_id"], str(sample_id))

    def test_sync_order_create_and_update(self) -> None:
        with Session(self.engine) as session:
            first = sync_order_to_db(
                session,
                {
                    "id": "order-xyz",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                },
            )

            self.assertEqual(first.filled_qty, Decimal("0"))

            updated = sync_order_to_db(
                session,
                {
                    "id": "order-xyz",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "1",
                    "filled_avg_price": "10.50",
                    "status": "filled",
                },
            )

            self.assertEqual(first.id, updated.id)
            self.assertEqual(updated.filled_qty, Decimal("1"))
            self.assertEqual(updated.avg_fill_price, Decimal("10.50"))

    def test_sync_order_to_db_serializes_uuid_payloads(self) -> None:
        sample_id = uuid.uuid4()
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-uuid-test",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "client_order_id": "client-order-1",
                    "meta": {"strategy_run_id": sample_id},
                },
            )

            self.assertEqual(
                execution.raw_order["meta"]["strategy_run_id"], str(sample_id)
            )

    def test_sync_order_to_db_normalizes_fallback_route_marker(self) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-fallback",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "execution_expected_adapter": "lean",
                    "_execution_route_actual": "alpaca_fallback",
                    "_execution_adapter": "alpaca_fallback",
                },
            )

            self.assertEqual(execution.execution_expected_adapter, "lean")
            self.assertEqual(execution.execution_actual_adapter, "alpaca")

    def test_sync_order_to_db_resolves_expected_from_actual_marker(self) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-only-actual",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "_execution_adapter": "lean",
                },
            )

            self.assertEqual(execution.execution_expected_adapter, "lean")
            self.assertEqual(execution.execution_actual_adapter, "lean")

    def test_sync_order_to_db_persists_execution_correlation_fields(self) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-correlation",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "_execution_correlation_id": "corr-123",
                    "_execution_idempotency_key": "idem-123",
                },
            )
            self.assertEqual(execution.execution_correlation_id, "corr-123")
            self.assertEqual(execution.execution_idempotency_key, "idem-123")

    def test_sync_order_to_db_persists_simulation_context_in_audit_and_raw_order(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "sim-order-1",
                    "client_order_id": "decision-hash-1",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "1",
                    "filled_avg_price": "100.5",
                    "status": "filled",
                    "_execution_adapter": "simulation",
                    "_execution_audit": {
                        "adapter": "simulation",
                        "simulation_context": {
                            "simulation_run_id": "sim-2026-02-27-01",
                            "dataset_id": "dataset-a",
                            "dataset_event_id": "evt-1",
                            "source_topic": "torghut.trades.v1",
                            "source_partition": 3,
                            "source_offset": 9001,
                        },
                    },
                },
                trade_decision_id="123e4567-e89b-12d3-a456-426614174000",
            )
            audit = execution.execution_audit_json
            raw_order = execution.raw_order
            self.assertIsInstance(audit, dict)
            self.assertIsInstance(raw_order, dict)
            assert isinstance(audit, dict)
            assert isinstance(raw_order, dict)
            simulation_context = audit.get("simulation_context")
            self.assertIsInstance(simulation_context, dict)
            assert isinstance(simulation_context, dict)
            self.assertEqual(
                simulation_context.get("simulation_run_id"), "sim-2026-02-27-01"
            )
            self.assertEqual(simulation_context.get("dataset_event_id"), "evt-1")
            self.assertEqual(raw_order.get("simulation_context"), simulation_context)

    def test_sync_order_to_db_preserves_execution_audit_metadata_on_update(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-runtime-audit",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "_execution_audit": {
                        "execution_policy_hash": "policy-sha",
                        "cost_model_hash": "cost-sha",
                        "lineage_hash": "lineage-sha",
                        "runtime_ledger_cost": {
                            "cost_amount": "0",
                            "cost_basis": "broker_reported_commission",
                        },
                    },
                },
            )

            updated = sync_order_to_db(
                session,
                {
                    "id": "order-runtime-audit",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                    "status": "filled",
                },
            )

            self.assertEqual(updated.id, execution.id)
            audit = updated.execution_audit_json
            self.assertIsInstance(audit, dict)
            assert isinstance(audit, dict)
            self.assertEqual(audit.get("execution_policy_hash"), "policy-sha")
            self.assertEqual(audit.get("cost_model_hash"), "cost-sha")
            self.assertEqual(audit.get("lineage_hash"), "lineage-sha")
            cost = audit.get("runtime_ledger_cost")
            self.assertIsInstance(cost, dict)
            assert isinstance(cost, dict)
            self.assertEqual(cost.get("cost_amount"), "0")
            self.assertEqual(cost.get("cost_basis"), "broker_reported_commission")

    def test_sync_order_to_db_normalizes_explicit_broker_cost_metadata(self) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-runtime-cost",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                    "status": "filled",
                    "commission": "0",
                },
            )

            audit = execution.execution_audit_json
            self.assertIsInstance(audit, dict)
            assert isinstance(audit, dict)
            cost = audit.get("runtime_ledger_cost")
            self.assertIsInstance(cost, dict)
            assert isinstance(cost, dict)
            self.assertEqual(cost.get("cost_amount"), "0")
            self.assertEqual(cost.get("cost_basis"), "broker_reported_commission")
            self.assertEqual(audit.get("cost_amount"), "0")
            self.assertEqual(audit.get("cost_basis"), "broker_reported_commission")
            self.assertIn("fee_model", audit)

    def test_sync_order_to_db_promotes_existing_audit_runtime_cost_metadata(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-audit-runtime-cost",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                    "status": "filled",
                    "_execution_audit": {
                        "runtime_ledger_cost": {
                            "fee_amount": "0.07",
                            "fee_basis": "broker_reported_fees",
                        },
                    },
                },
            )

            audit = execution.execution_audit_json
            raw_order = execution.raw_order
            self.assertIsInstance(audit, dict)
            self.assertIsInstance(raw_order, dict)
            assert isinstance(audit, dict)
            assert isinstance(raw_order, dict)
            self.assertEqual(audit.get("cost_amount"), "0.07")
            self.assertEqual(audit.get("cost_basis"), "broker_reported_fees")
            self.assertEqual(raw_order.get("cost_amount"), "0.07")
            self.assertEqual(raw_order.get("cost_basis"), "broker_reported_fees")
            fee_model = audit.get("fee_model")
            self.assertIsInstance(fee_model, dict)
            assert isinstance(fee_model, dict)
            self.assertEqual(fee_model.get("source"), "execution_audit_cost_payload")

    def test_sync_order_to_db_models_paper_cost_when_broker_omits_fees(self) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-modeled-paper-cost",
                    "alpaca_account_label": "TORGHUT_PAPER",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "2",
                    "filled_qty": "2",
                    "filled_avg_price": "100",
                    "status": "filled",
                    "_execution_audit": {
                        "execution_lane": "paper_route_probe",
                        "cost_model": {
                            "model": {"commission_bps": "0"},
                            "estimate": {
                                "notional": "200",
                                "total_cost_bps": "7.5",
                            },
                        },
                    },
                },
            )

            audit = execution.execution_audit_json
            raw_order = execution.raw_order
            self.assertIsInstance(audit, dict)
            self.assertIsInstance(raw_order, dict)
            assert isinstance(audit, dict)
            assert isinstance(raw_order, dict)
            cost = audit.get("runtime_ledger_cost")
            self.assertIsInstance(cost, dict)
            assert isinstance(cost, dict)
            self.assertEqual(cost.get("cost_amount"), "0.15")
            self.assertEqual(cost.get("cost_basis"), "modeled_paper_cost_budget")
            self.assertEqual(cost.get("source"), "paper_cost_model_estimate")
            self.assertEqual(
                cost.get("source_field"), "cost_model.estimate.total_cost_bps"
            )
            self.assertEqual(audit.get("cost_amount"), "0.15")
            self.assertEqual(raw_order.get("cost_amount"), "0.15")
            fee_model = audit.get("fee_model")
            self.assertIsInstance(fee_model, dict)
            assert isinstance(fee_model, dict)
            self.assertEqual(fee_model.get("source"), "paper_cost_model_estimate")

    def test_sync_order_to_db_does_not_model_live_cost_when_broker_omits_fees(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-live-no-modeled-cost",
                    "alpaca_account_label": "TORGHUT_LIVE",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "2",
                    "filled_qty": "2",
                    "filled_avg_price": "100",
                    "status": "filled",
                    "_execution_audit": {
                        "execution_lane": "live",
                        "cost_model": {
                            "estimate": {
                                "notional": "200",
                                "total_cost_bps": "7.5",
                            },
                        },
                    },
                },
            )

            audit = execution.execution_audit_json
            raw_order = execution.raw_order
            self.assertIsInstance(audit, dict)
            self.assertIsInstance(raw_order, dict)
            assert isinstance(audit, dict)
            assert isinstance(raw_order, dict)
            self.assertNotIn("runtime_ledger_cost", audit)
            self.assertNotIn("cost_amount", audit)
            self.assertNotIn("cost_amount", raw_order)

    def test_sync_order_to_db_requires_paper_marker_before_modeling_costs(self) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-unlabeled-no-modeled-cost",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "2",
                    "filled_qty": "2",
                    "filled_avg_price": "100",
                    "status": "filled",
                    "_execution_audit": {
                        "cost_model": {
                            "estimate": {
                                "notional": "200",
                                "total_cost_bps": "7.5",
                            },
                        },
                    },
                },
            )

            audit = execution.execution_audit_json
            raw_order = execution.raw_order
            self.assertIsInstance(audit, dict)
            self.assertIsInstance(raw_order, dict)
            assert isinstance(audit, dict)
            assert isinstance(raw_order, dict)
            self.assertNotIn("runtime_ledger_cost", audit)
            self.assertNotIn("cost_amount", audit)
            self.assertNotIn("cost_amount", raw_order)

    def test_sync_order_to_db_ignores_unrelated_estimate_payload_for_costs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-unrelated-estimate-no-cost",
                    "alpaca_account_label": "TORGHUT_PAPER",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "2",
                    "filled_qty": "2",
                    "filled_avg_price": "100",
                    "status": "filled",
                    "_execution_audit": {
                        "execution_lane": "paper_route_probe",
                        "analytics": {
                            "estimate": {
                                "notional": "200",
                                "total_cost_bps": "7.5",
                            },
                        },
                    },
                },
            )

            audit = execution.execution_audit_json
            raw_order = execution.raw_order
            self.assertIsInstance(audit, dict)
            self.assertIsInstance(raw_order, dict)
            assert isinstance(audit, dict)
            assert isinstance(raw_order, dict)
            self.assertNotIn("runtime_ledger_cost", audit)
            self.assertNotIn("cost_amount", audit)
            self.assertNotIn("cost_amount", raw_order)
