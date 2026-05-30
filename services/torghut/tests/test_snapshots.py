from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, List
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, ExecutionOrderEvent, OrderFeedSourceWindow, Strategy, TradeDecision
from app.snapshots import (
    _runtime_cost_payload_from_mapping,
    snapshot_account_and_positions,
    sync_order_to_db,
)


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

    def test_runtime_cost_payload_skips_non_promotion_grade_cost_basis(self) -> None:
        self.assertIsNone(
            _runtime_cost_payload_from_mapping(
                {
                    "cost_amount": "1.23",
                    "cost_basis": "modeled_paper_cost_budget",
                    "commission": "0.25",
                },
                source="audit",
                source_field_prefix="audit.",
            )
        )

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

    def test_sync_order_to_db_links_prior_order_feed_event(self) -> None:
        with Session(self.engine) as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="symbols_list",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"side": "buy"},
                decision_hash="client-linked",
                status="submitted",
            )
            session.add(decision)
            session.flush()
            source_window = OrderFeedSourceWindow(
                consumer_group="paper-route-client",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                alpaca_account_label="paper",
                assignment_mode="manual",
                collector_identity="paper-route-client",
                source_revision="alpaca_trade_updates_v1",
                window_started_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                window_ended_at=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                start_offset=12,
                end_offset=12,
                consumed_count=1,
                inserted_count=1,
                duplicate_count=0,
                malformed_count=0,
                missing_payload_count=0,
                missing_identity_count=0,
                out_of_scope_account_count=0,
                unlinked_execution_count=1,
                unlinked_decision_count=1,
                failed_unhandled_count=0,
                dropped_count=0,
                gap_count=0,
                status="inserted",
            )
            session.add(source_window)
            session.flush()
            event = ExecutionOrderEvent(
                event_fingerprint="order-linked-fill",
                source_topic="torghut.trade-updates.v1",
                source_partition=0,
                source_offset=12,
                alpaca_account_label="paper",
                feed_seq=10,
                event_ts=datetime(2026, 2, 1, 10, 0, tzinfo=timezone.utc),
                symbol="AAPL",
                alpaca_order_id="order-linked",
                client_order_id="client-linked",
                event_type="fill",
                status="filled",
                qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("190.20"),
                raw_event={"channel": "trade_updates"},
                source_window_id=source_window.id,
            )
            session.add(event)
            session.commit()

            execution = sync_order_to_db(
                session,
                {
                    "id": "order-linked",
                    "client_order_id": "client-linked",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                },
                trade_decision_id=str(decision.id),
                alpaca_account_label="paper",
            )
            session.refresh(event)
            session.refresh(source_window)
            session.refresh(decision)

            self.assertEqual(event.execution_id, execution.id)
            self.assertEqual(event.trade_decision_id, decision.id)
            self.assertEqual(source_window.unlinked_execution_count, 0)
            self.assertEqual(source_window.unlinked_decision_count, 0)
            self.assertEqual(execution.status, "filled")
            self.assertEqual(execution.filled_qty, Decimal("1"))
            self.assertEqual(execution.avg_fill_price, Decimal("190.20"))
            self.assertEqual(decision.status, "filled")

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
                            "source": "broker_reconciliation",
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
            self.assertEqual(fee_model.get("source"), "broker_reconciliation")

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
            cost = audit.get("modeled_paper_cost_estimate")
            self.assertIsInstance(cost, dict)
            assert isinstance(cost, dict)
            self.assertEqual(cost.get("cost_amount"), "0.15")
            self.assertEqual(cost.get("cost_basis"), "modeled_paper_cost_budget")
            self.assertEqual(cost.get("source"), "paper_cost_model_estimate")
            self.assertEqual(
                cost.get("source_field"), "cost_model.estimate.total_cost_bps"
            )
            self.assertEqual(raw_order.get("modeled_paper_cost_estimate"), cost)
            self.assertNotIn("runtime_ledger_cost", audit)
            self.assertNotIn("cost_amount", audit)
            self.assertNotIn("cost_amount", raw_order)
            self.assertNotIn("fee_model", audit)

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

    def test_sync_order_to_db_does_not_trust_payload_paper_marker_for_live_label(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-live-arg-no-modeled-cost",
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
                            "estimate": {
                                "notional": "200",
                                "total_cost_bps": "7.5",
                            },
                        },
                    },
                },
                alpaca_account_label="TORGHUT_LIVE",
            )

            audit = execution.execution_audit_json
            raw_order = execution.raw_order
            self.assertIsInstance(audit, dict)
            self.assertIsInstance(raw_order, dict)
            assert isinstance(audit, dict)
            assert isinstance(raw_order, dict)
            self.assertEqual(execution.alpaca_account_label, "TORGHUT_LIVE")
            self.assertNotIn("modeled_paper_cost_estimate", audit)
            self.assertNotIn("runtime_ledger_cost", audit)
            self.assertNotIn("cost_amount", audit)
            self.assertNotIn("cost_amount", raw_order)

    def test_sync_order_to_db_does_not_model_cost_when_label_has_live_marker(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-live-paper-label-no-modeled-cost",
                    "alpaca_account_label": "TORGHUT_LIVE_PAPER",
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
            self.assertNotIn("modeled_paper_cost_estimate", audit)
            self.assertNotIn("runtime_ledger_cost", audit)
            self.assertNotIn("cost_amount", audit)
            self.assertNotIn("cost_amount", raw_order)

    def test_sync_order_to_db_ignores_nested_spoofed_runtime_cost_metadata(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-nested-runtime-cost-spoof",
                    "alpaca_account_label": "TORGHUT_PAPER",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                    "status": "filled",
                    "_execution_audit": {
                        "analytics": {
                            "runtime_ledger_cost": {
                                "cost_amount": "0.01",
                                "cost_basis": "broker_reported_commission",
                                "source": "broker_reconciliation",
                            }
                        }
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

    def test_sync_order_to_db_prefers_broker_response_cost_over_audit_cost(
        self,
    ) -> None:
        with Session(self.engine) as session:
            execution = sync_order_to_db(
                session,
                {
                    "id": "order-broker-cost-wins",
                    "alpaca_account_label": "TORGHUT_PAPER",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "1",
                    "filled_avg_price": "100",
                    "status": "filled",
                    "commission": "0.25",
                    "_execution_audit": {
                        "cost_amount": "0",
                        "cost_basis": "broker_reported_commission",
                        "runtime_ledger_cost": {
                            "cost_amount": "0",
                            "cost_basis": "broker_reported_commission",
                            "source": "broker_reconciliation",
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
            self.assertEqual(cost.get("cost_amount"), "0.25")
            self.assertEqual(cost.get("source"), "broker_order_response")
            self.assertEqual(audit.get("cost_amount"), "0.25")
            self.assertEqual(raw_order.get("cost_amount"), "0.25")

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
