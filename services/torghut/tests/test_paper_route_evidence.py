from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import (
    Base,
    Execution,
    ExecutionTCAMetric,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from app.trading.paper_route_evidence import build_paper_route_evidence_audit


class TestPaperRouteEvidenceAudit(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)

    def test_builder_reports_missing_import_plan_without_promotion_authority(
        self,
    ) -> None:
        with Session(self.engine) as session:
            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "runtime_ledger_missing",
                    "blocked_reasons": "not-a-list",
                    "promotion_eligible_total": 3.8,
                },
                route_reacquisition_book={
                    "summary": "not-a-dict",
                    "paper_route_probe": {
                        "configured_enabled": False,
                        "eligible_symbol_count": "not-an-int",
                    },
                },
                generated_at=datetime(2026, 5, 24, 12, tzinfo=timezone.utc),
                target_limit=3,
            )

        self.assertEqual(payload["summary"]["target_count"], 0)
        self.assertEqual(
            payload["summary"]["blockers"],
            ["paper_probation_import_plan_missing"],
        )
        self.assertEqual(payload["paper_route_probe"]["schema_version"], "missing")
        self.assertEqual(payload["paper_route_probe"]["state"], "unknown")
        self.assertEqual(
            payload["live_submission_gate"]["promotion_eligible_total"],
            3,
        )

    def test_builder_blocks_target_without_identity_or_probe_candidate(self) -> None:
        now = datetime(2026, 5, 24, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_probe_disabled",
                    "blocked_reasons": ["paper_probe_disabled"],
                    "promotion_eligible_total": 0,
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": Decimal("1"),
                        "skipped_target_count": True,
                        "promotion_allowed": False,
                        "final_promotion_authorized": False,
                        "targets": [
                            {
                                "window_start": now.isoformat(),
                                "window_end": (now - timedelta(hours=1)).isoformat(),
                                "promotion_allowed": False,
                                "candidate_blockers": ["manual_review_required"],
                            }
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "paper_route_probe": {
                        "configured_enabled": False,
                        "active": False,
                        "effective_max_notional": None,
                        "next_session_max_notional": None,
                        "eligible_symbol_count": 0,
                        "blocking_reasons": ["paper_route_probe_disabled"],
                    },
                },
                generated_at=now,
                lookback_hours=6,
            )

        self.assertEqual(payload["summary"]["target_count"], 1)
        self.assertEqual(
            payload["live_submission_gate"][
                "runtime_ledger_paper_probation_import_plan"
            ]["target_count"],
            1,
        )
        self.assertEqual(
            payload["live_submission_gate"][
                "runtime_ledger_paper_probation_import_plan"
            ]["skipped_target_count"],
            1,
        )
        audit = payload["targets"][0]
        self.assertIsNone(audit["target"]["hypothesis_id"])
        self.assertEqual(
            audit["source_activity"]["missing_reasons"], ["strategy_name_missing"]
        )
        blockers = set(audit["readiness"]["blockers"])
        self.assertIn("manual_review_required", blockers)
        self.assertIn("paper_probation_evidence_collection_only", blockers)
        self.assertIn("paper_route_probe_disabled", blockers)
        self.assertIn("paper_route_probe_candidate_missing", blockers)
        self.assertIn("runtime_ledger_bucket_missing", blockers)
        self.assertIn("runtime_ledger_evidence_grade_bucket_missing", blockers)
        self.assertIn("hypothesis_window_missing", blockers)
        self.assertIn("promotion_decision_missing", blockers)

    def test_builder_joins_source_activity_runtime_ledger_and_decisions(self) -> None:
        now = datetime(2026, 5, 24, 12, tzinfo=timezone.utc)
        window_start = now - timedelta(hours=2)
        strategy_name = "active-paper-route"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="paper route source activity",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"action": "buy", "qty": "2"},
                rationale="paper route fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=10),
                executed_at=window_start + timedelta(minutes=11),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="paper",
                alpaca_order_id="paper-route-order-1",
                client_order_id="paper-route-client-1",
                symbol="AAPL",
                side="buy",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("2"),
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("100"),
                status="filled",
                raw_order={},
                created_at=window_start + timedelta(minutes=12),
                updated_at=window_start + timedelta(minutes=12),
                last_update_at=window_start + timedelta(minutes=12),
            )
            session.add(execution)
            session.flush()
            session.add_all(
                [
                    ExecutionTCAMetric(
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        strategy_id=strategy.id,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        side="buy",
                        arrival_price=Decimal("99"),
                        avg_fill_price=Decimal("100"),
                        filled_qty=Decimal("2"),
                        signed_qty=Decimal("2"),
                        slippage_bps=Decimal("5"),
                        shortfall_notional=Decimal("1"),
                        realized_shortfall_bps=Decimal("5"),
                        churn_qty=Decimal("0"),
                        churn_ratio=Decimal("0"),
                        computed_at=window_start + timedelta(minutes=13),
                        created_at=window_start + timedelta(minutes=13),
                        updated_at=window_start + timedelta(minutes=13),
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="paper-route-run-2",
                        candidate_id="candidate-active-route",
                        hypothesis_id="H-ACTIVE-ROUTE",
                        observed_stage="paper",
                        bucket_started_at=window_start,
                        bucket_ended_at=now,
                        account_label="paper",
                        runtime_strategy_name=strategy_name,
                        strategy_family="microbar_pairs",
                        fill_count=2,
                        decision_count=1,
                        submitted_order_count=1,
                        closed_trade_count=1,
                        open_position_count=0,
                        filled_notional=Decimal("200"),
                        gross_strategy_pnl=Decimal("12"),
                        cost_amount=Decimal("2"),
                        net_strategy_pnl_after_costs=Decimal("10"),
                        post_cost_expectancy_bps=Decimal("500"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy-a": 1},
                        cost_model_hash_counts={"cost-a": 1},
                        lineage_hash_counts={"lineage-a": 1},
                        blockers_json=[],
                    ),
                    StrategyHypothesisMetricWindow(
                        run_id="paper-route-run-2",
                        candidate_id="candidate-active-route",
                        hypothesis_id="H-ACTIVE-ROUTE",
                        observed_stage="paper",
                        window_started_at=window_start,
                        window_ended_at=now,
                        market_session_count=1,
                        decision_count=1,
                        trade_count=1,
                        order_count=1,
                        evidence_provenance=None,
                        evidence_maturity=None,
                    ),
                    StrategyPromotionDecision(
                        run_id="paper-route-run-2",
                        candidate_id="candidate-active-route",
                        hypothesis_id="H-ACTIVE-ROUTE",
                        promotion_target="paper",
                        state="allowed",
                        allowed=True,
                        reason_summary="paper_evidence_collecting",
                        created_at=now,
                        updated_at=now,
                    ),
                ]
            )
            session.commit()

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 1,
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": "1",
                        "targets": [
                            {
                                "hypothesis_id": "H-ACTIVE-ROUTE",
                                "candidate_id": "candidate-active-route",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "paper",
                                "window_start": window_start.isoformat(),
                                "window_end": now.isoformat(),
                                "paper_probation_authorized": True,
                                "promotion_allowed": True,
                                "final_promotion_authorized": True,
                                "max_notional": True,
                            }
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["AAPL"],
                        "paper_route_probe_active_symbols": ["AAPL"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": True,
                        "effective_max_notional": 25,
                        "next_session_max_notional": 25,
                    },
                },
                generated_at=now,
            )

        audit = payload["targets"][0]
        self.assertFalse(audit["source_activity"]["missing"])
        self.assertEqual(audit["source_activity"]["decision_count"], 1)
        self.assertEqual(audit["source_activity"]["execution_count"], 1)
        self.assertEqual(audit["source_activity"]["filled_execution_count"], 1)
        self.assertEqual(audit["source_activity"]["tca_sample_count"], 1)
        self.assertEqual(audit["runtime_ledger"]["evidence_grade_bucket_count"], 1)
        self.assertEqual(audit["runtime_ledger"]["post_cost_expectancy_bps"], "500")
        self.assertEqual(
            audit["hypothesis_windows"]["evidence_provenance_counts"],
            {"missing": 1},
        )
        self.assertEqual(audit["promotion_decisions"]["allowed_count"], 1)
        self.assertEqual(audit["readiness"]["state"], "paper_evidence_collecting")
        self.assertEqual(audit["readiness"]["blockers"], [])
        self.assertEqual(payload["summary"]["target_with_source_activity_count"], 1)
        self.assertEqual(payload["summary"]["target_with_runtime_ledger_count"], 1)
        self.assertEqual(payload["summary"]["target_with_promotion_decision_count"], 1)
