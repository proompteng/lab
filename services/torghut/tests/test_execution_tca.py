from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from unittest import TestCase
from unittest.mock import MagicMock

from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import Base, Execution, ExecutionTCAMetric, Strategy, TradeDecision
from app.trading.tca import (
    build_tca_gate_inputs,
    refresh_execution_tca_metrics,
    upsert_execution_tca_metric,
)


class TestExecutionTcaCostLineage(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )

    def test_upsert_repairs_source_backed_cost_lineage(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = self._insert_decision(
                session,
                strategy,
                decision_hash="source-backed-decision",
                execution_policy={"version": "adaptive-limit-v1", "max_bps": "12"},
            )
            execution = self._insert_execution(
                session,
                decision,
                order_id="source-backed-order",
                raw_order={
                    "commission": "0.02",
                    "cost_model": {
                        "source": "broker_reported_commission",
                        "version": "alpaca-paper-explicit",
                    },
                },
            )

            metric = upsert_execution_tca_metric(session, execution)
            session.flush()
            lineage = self._lineage(execution)
            tca_inputs = build_tca_gate_inputs(
                session,
                strategy_id=str(strategy.id),
                account_label="paper",
                symbols=["AAPL"],
            )

        self.assertEqual(metric.execution_id, execution.id)
        self.assertEqual(lineage["status"], "source_backed")
        self.assertEqual(lineage["blockers"], [])
        self.assertEqual(lineage["filled_notional"], "1000")
        self.assertEqual(lineage["explicit_cost_amount"], "0.02")
        self.assertEqual(lineage["cost_basis"], "broker_reported_commission")
        self.assertIsInstance(lineage["execution_policy_hash"], str)
        self.assertIsInstance(lineage["cost_model_hash"], str)
        self.assertFalse(lineage["promotion_authority"])
        runtime_lineage = tca_inputs["runtime_ledger_lineage"]
        assert isinstance(runtime_lineage, dict)
        self.assertEqual(runtime_lineage["status"], "source_backed")
        self.assertEqual(runtime_lineage["source_backed_count"], 1)
        self.assertEqual(runtime_lineage["explicit_cost_count"], 1)
        self.assertTrue(runtime_lineage["coverage_exact"])

    def test_build_tca_gate_inputs_bounds_lineage_sample_fail_closed(self) -> None:
        original_limit = settings.trading_tca_status_lineage_sample_limit
        settings.trading_tca_status_lineage_sample_limit = 1
        self.addCleanup(
            setattr,
            settings,
            "trading_tca_status_lineage_sample_limit",
            original_limit,
        )

        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            for idx in range(3):
                decision = self._insert_decision(
                    session,
                    strategy,
                    decision_hash=f"source-backed-decision-{idx}",
                    execution_policy={"version": "adaptive-limit-v1"},
                )
                execution = self._insert_execution(
                    session,
                    decision,
                    order_id=f"source-backed-order-{idx}",
                    raw_order={
                        "commission": "0.02",
                        "cost_model": {"source": "broker_reported_commission"},
                    },
                )
                upsert_execution_tca_metric(session, execution)
            session.flush()

            tca_inputs = build_tca_gate_inputs(
                session,
                strategy_id=str(strategy.id),
                account_label="paper",
                symbols=["AAPL"],
            )

        runtime_lineage = tca_inputs["runtime_ledger_lineage"]
        assert isinstance(runtime_lineage, dict)
        self.assertEqual(runtime_lineage["status"], "blocked")
        self.assertFalse(runtime_lineage["coverage_exact"])
        self.assertTrue(runtime_lineage["truncated"])
        self.assertEqual(runtime_lineage["query_limit"], 1)
        self.assertEqual(runtime_lineage["sampled_execution_count"], 1)
        self.assertEqual(runtime_lineage["total_filled_execution_count"], 3)
        self.assertFalse(runtime_lineage["promotion_authority"])
        self.assertIn(
            "runtime_tca_cost_lineage_sample_truncated",
            runtime_lineage["blockers"],
        )

    def test_build_tca_gate_inputs_keeps_tca_rows_when_coverage_times_out(
        self,
    ) -> None:
        computed_at = datetime(2026, 6, 3, 13, 0, tzinfo=timezone.utc)
        aggregate_result = MagicMock()
        aggregate_result.one.return_value = (
            3,
            Decimal("1.1"),
            Decimal("1.5"),
            Decimal("0.03"),
            Decimal("0.03"),
            Decimal("0.02"),
            Decimal("0.4"),
            Decimal("0.4"),
            3,
            Decimal("2.0"),
            Decimal("4.0"),
            Decimal("0.7"),
            Decimal("0.7"),
            Decimal("1.3"),
            computed_at,
        )
        symbol_result = MagicMock()
        symbol_result.all.return_value = [
            (
                "AMZN",
                3,
                Decimal("1.5"),
                Decimal("2.1"),
                computed_at,
                Decimal("0.7"),
            )
        ]
        session = MagicMock()
        session.execute.side_effect = [
            aggregate_result,
            symbol_result,
            SQLAlchemyError("statement timeout"),
        ]

        summary = build_tca_gate_inputs(
            session,
            account_label="paper",
            symbols=["AMZN"],
        )

        self.assertEqual(summary["order_count"], 3)
        self.assertEqual(summary["scope_symbols"], ["AMZN"])
        self.assertEqual(summary["read_model_status"], "degraded")
        self.assertEqual(
            summary["reason_codes"],
            ["execution_tca_execution_coverage_query_unavailable"],
        )
        self.assertEqual(summary["filled_execution_count"], 0)
        self.assertEqual(summary["unsettled_execution_count"], 0)
        self.assertEqual(summary["last_computed_at"], computed_at)
        symbol_breakdown = summary["symbol_breakdown"]
        assert isinstance(symbol_breakdown, list)
        self.assertEqual(symbol_breakdown[0]["symbol"], "AMZN")
        self.assertEqual(symbol_breakdown[0]["order_count"], 3)
        runtime_lineage = summary["runtime_ledger_lineage"]
        assert isinstance(runtime_lineage, dict)
        self.assertEqual(runtime_lineage["status"], "blocked")
        self.assertTrue(runtime_lineage["read_model_unavailable"])
        self.assertIn(
            "execution_tca_execution_coverage_query_unavailable",
            runtime_lineage["blockers"],
        )
        session.rollback.assert_called_once()

    def test_build_tca_gate_inputs_marks_symbol_breakdown_timeout(self) -> None:
        computed_at = datetime(2026, 6, 3, 13, 5, tzinfo=timezone.utc)
        aggregate_result = MagicMock()
        aggregate_result.one.return_value = (
            2,
            Decimal("1.1"),
            Decimal("1.5"),
            Decimal("0.03"),
            Decimal("0.03"),
            Decimal("0.02"),
            Decimal("0.4"),
            Decimal("0.4"),
            2,
            Decimal("2.0"),
            Decimal("4.0"),
            Decimal("0.7"),
            Decimal("0.7"),
            Decimal("1.3"),
            computed_at,
        )
        execution_result = MagicMock()
        execution_result.one.return_value = (0, None)
        unsettled_result = MagicMock()
        unsettled_result.scalar_one.return_value = 0
        lineage_result = MagicMock()
        lineage_result.scalars.return_value.all.return_value = []
        session = MagicMock()
        session.execute.side_effect = [
            aggregate_result,
            SQLAlchemyError("symbol timeout"),
            execution_result,
            unsettled_result,
            lineage_result,
        ]

        summary = build_tca_gate_inputs(
            session,
            account_label="paper",
            symbols=["AMZN"],
        )

        self.assertEqual(summary["read_model_status"], "degraded")
        self.assertEqual(
            summary["reason_codes"],
            ["execution_tca_symbol_breakdown_query_unavailable"],
        )
        symbol_breakdown = summary["symbol_breakdown"]
        assert isinstance(symbol_breakdown, list)
        self.assertEqual(symbol_breakdown[0]["symbol"], "AMZN")
        self.assertEqual(symbol_breakdown[0]["order_count"], 0)
        self.assertTrue(symbol_breakdown[0]["read_model_unavailable"])
        self.assertEqual(
            symbol_breakdown[0]["reason_codes"],
            ["execution_tca_symbol_breakdown_query_unavailable"],
        )
        session.rollback.assert_called_once()

    def test_build_tca_gate_inputs_marks_lineage_timeout(self) -> None:
        computed_at = datetime(2026, 6, 3, 13, 10, tzinfo=timezone.utc)
        aggregate_result = MagicMock()
        aggregate_result.one.return_value = (
            2,
            Decimal("1.1"),
            Decimal("1.5"),
            Decimal("0.03"),
            Decimal("0.03"),
            Decimal("0.02"),
            Decimal("0.4"),
            Decimal("0.4"),
            2,
            Decimal("2.0"),
            Decimal("4.0"),
            Decimal("0.7"),
            Decimal("0.7"),
            Decimal("1.3"),
            computed_at,
        )
        symbol_result = MagicMock()
        symbol_result.all.return_value = [
            (
                "AMZN",
                2,
                Decimal("1.5"),
                Decimal("2.1"),
                computed_at,
                Decimal("0.7"),
            )
        ]
        execution_result = MagicMock()
        execution_result.one.return_value = (2, computed_at)
        unsettled_result = MagicMock()
        unsettled_result.scalar_one.return_value = 0
        session = MagicMock()
        session.execute.side_effect = [
            aggregate_result,
            symbol_result,
            execution_result,
            unsettled_result,
            SQLAlchemyError("lineage timeout"),
        ]

        summary = build_tca_gate_inputs(
            session,
            account_label="paper",
            symbols=["AMZN"],
        )

        self.assertEqual(summary["read_model_status"], "degraded")
        self.assertEqual(
            summary["reason_codes"],
            ["runtime_tca_cost_lineage_query_unavailable"],
        )
        runtime_lineage = summary["runtime_ledger_lineage"]
        assert isinstance(runtime_lineage, dict)
        self.assertTrue(runtime_lineage["read_model_unavailable"])
        self.assertTrue(runtime_lineage["truncated"])
        self.assertEqual(runtime_lineage["total_filled_execution_count"], 2)
        self.assertIn(
            "runtime_tca_cost_lineage_query_unavailable",
            runtime_lineage["blockers"],
        )
        session.rollback.assert_called_once()

    def test_upsert_blocks_missing_explicit_cost_without_inference(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = self._insert_decision(
                session,
                strategy,
                decision_hash="missing-cost-decision",
                execution_policy={"version": "adaptive-limit-v1"},
            )
            execution = self._insert_execution(
                session,
                decision,
                order_id="missing-cost-order",
                raw_order={"cost_model": {"version": "present-but-no-cost"}},
            )

            upsert_execution_tca_metric(session, execution)
            session.flush()
            lineage = self._lineage(execution)

        self.assertEqual(lineage["status"], "blocked")
        self.assertIn("explicit_cost_missing", lineage["blockers"])
        self.assertEqual(lineage["filled_notional"], "1000")
        self.assertIsNone(lineage["explicit_cost_amount"])

    def test_upsert_derives_alpaca_equity_fee_schedule_cost_lineage(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = self._insert_decision(
                session,
                strategy,
                decision_hash="alpaca-fee-schedule-decision",
                execution_policy=None,
                decision_json={
                    "strategy_id": None,
                    "symbol": "AAPL",
                    "action": "sell",
                    "qty": "10",
                    "order_type": "market",
                    "time_in_force": "day",
                    "submission_stage": "paper_direct",
                    "params": {"price": "100"},
                },
            )
            execution = self._insert_execution(
                session,
                decision,
                order_id="alpaca-fee-schedule-order",
                side="sell",
                raw_order={
                    "asset_class": "us_equity",
                    "symbol": "AAPL",
                    "side": "sell",
                    "filled_qty": "10",
                    "filled_avg_price": "100",
                },
                execution_audit_json={
                    "submit_path": "direct_alpaca",
                    "execution_lane": "simple",
                },
            )

            upsert_execution_tca_metric(session, execution)
            session.flush()
            lineage = self._lineage(execution)

        self.assertEqual(lineage["status"], "source_backed")
        self.assertEqual(lineage["blockers"], [])
        self.assertEqual(lineage["filled_notional"], "1000")
        self.assertEqual(lineage["explicit_cost_amount"], "0.04")
        self.assertEqual(
            lineage["cost_basis"], "alpaca_2026_equity_sec_taf_cat_fee_schedule"
        )
        self.assertIsInstance(lineage["execution_policy_hash"], str)
        self.assertIsInstance(lineage["cost_model_hash"], str)
        self.assertEqual(
            lineage["source_fields"]["explicit_cost"],
            "alpaca_2026_equity_fee_schedule",
        )
        self.assertEqual(
            lineage["source_fields"]["execution_policy_hash"],
            "trade_decisions.decision_json+executions.order_fields",
        )

    def test_upsert_blocks_ambiguous_policy_and_cost_model_hashes(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = self._insert_decision(
                session,
                strategy,
                decision_hash="ambiguous-hash-decision",
                execution_policy=None,
            )
            execution = self._insert_execution(
                session,
                decision,
                order_id="ambiguous-hash-order",
                execution_audit_json={
                    "execution_policy_hash": "policy-a",
                    "cost_model_hash": "cost-a",
                },
                raw_order={
                    "commission": "0.02",
                    "execution_policy_hash": "policy-b",
                    "cost_model_hash": "cost-b",
                },
            )

            upsert_execution_tca_metric(session, execution)
            session.flush()
            lineage = self._lineage(execution)

        self.assertEqual(lineage["status"], "blocked")
        self.assertIn("execution_policy_hash_ambiguous", lineage["blockers"])
        self.assertIn("cost_model_hash_ambiguous", lineage["blockers"])
        self.assertIsNone(lineage["execution_policy_hash"])
        self.assertIsNone(lineage["cost_model_hash"])

    def test_refresh_is_idempotent_for_audit_lineage(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = self._insert_decision(
                session,
                strategy,
                decision_hash="idempotent-refresh-decision",
                execution_policy={"version": "adaptive-limit-v1"},
            )
            execution = self._insert_execution(
                session,
                decision,
                order_id="idempotent-refresh-order",
                raw_order={
                    "commission": "0.02",
                    "cost_model": {"source": "broker_reported_commission"},
                },
            )
            session.commit()

            first = refresh_execution_tca_metrics(session, limit=10)
            session.commit()
            first_audit = dict(execution.execution_audit_json)

            second = refresh_execution_tca_metrics(session, limit=10)
            session.commit()
            second_audit = dict(execution.execution_audit_json)
            metric_count = session.scalar(select(func.count(ExecutionTCAMetric.id)))

        self.assertEqual(first["selected"], 1)
        self.assertEqual(first["refreshed"], 1)
        self.assertEqual(second["selected"], 1)
        self.assertEqual(second["refreshed"], 1)
        self.assertEqual(first_audit, second_audit)
        self.assertEqual(metric_count, 1)

    def _insert_strategy(self, session: Session) -> Strategy:
        strategy = Strategy(
            name="execution-tca-lineage-test",
            description="test",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        session.add(strategy)
        session.commit()
        session.refresh(strategy)
        return strategy

    def _insert_decision(
        self,
        session: Session,
        strategy: Strategy,
        *,
        decision_hash: str,
        execution_policy: dict[str, object] | None,
        decision_json: dict[str, object] | None = None,
    ) -> TradeDecision:
        params: dict[str, object] = {"price": "100"}
        if execution_policy is not None:
            params["execution_policy"] = execution_policy
        payload = decision_json or {
            "strategy_id": str(strategy.id),
            "symbol": "AAPL",
            "action": "buy",
            "qty": "10",
            "params": params,
        }
        if payload.get("strategy_id") is None:
            payload = {**payload, "strategy_id": str(strategy.id)}
        decision = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json=payload,
            rationale="test",
            status="submitted",
            decision_hash=decision_hash,
        )
        session.add(decision)
        session.flush()
        return decision

    def _insert_execution(
        self,
        session: Session,
        decision: TradeDecision,
        *,
        order_id: str,
        raw_order: dict[str, object],
        side: str = "buy",
        execution_audit_json: dict[str, object] | None = None,
    ) -> Execution:
        execution = Execution(
            trade_decision_id=decision.id,
            alpaca_order_id=order_id,
            client_order_id=f"client-{order_id}",
            symbol="AAPL",
            side=side,
            order_type="market",
            time_in_force="day",
            submitted_qty=Decimal("10"),
            filled_qty=Decimal("10"),
            avg_fill_price=Decimal("100"),
            status="filled",
            alpaca_account_label="paper",
            execution_expected_adapter="alpaca",
            execution_actual_adapter="alpaca",
            execution_audit_json=execution_audit_json,
            raw_order={
                "id": order_id,
                "filled_at": datetime(2026, 6, 1, tzinfo=timezone.utc).isoformat(),
                **raw_order,
            },
        )
        session.add(execution)
        session.flush()
        return execution

    def _lineage(self, execution: Execution) -> dict[str, Any]:
        audit = execution.execution_audit_json
        assert isinstance(audit, dict)
        lineage = audit["runtime_ledger_lineage"]
        assert isinstance(lineage, dict)
        return lineage
