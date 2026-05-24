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
from app.trading.paper_route_evidence import (
    _next_regular_equities_session_window,
    build_paper_route_evidence_audit,
)


class TestPaperRouteEvidenceAudit(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)

    def test_next_paper_route_window_stays_on_current_session_for_import(
        self,
    ) -> None:
        cases = [
            (
                datetime(2026, 5, 24, 14, 38, tzinfo=timezone.utc),
                "2026-05-26T13:30:00+00:00",
                "2026-05-26T20:00:00+00:00",
            ),
            (
                datetime(2026, 5, 26, 12, 0, tzinfo=timezone.utc),
                "2026-05-26T13:30:00+00:00",
                "2026-05-26T20:00:00+00:00",
            ),
            (
                datetime(2026, 5, 26, 15, 0, tzinfo=timezone.utc),
                "2026-05-26T13:30:00+00:00",
                "2026-05-26T20:00:00+00:00",
            ),
            (
                datetime(2026, 5, 26, 21, 23, tzinfo=timezone.utc),
                "2026-05-26T13:30:00+00:00",
                "2026-05-26T20:00:00+00:00",
            ),
            (
                datetime(2026, 5, 27, 4, 1, tzinfo=timezone.utc),
                "2026-05-27T13:30:00+00:00",
                "2026-05-27T20:00:00+00:00",
            ),
        ]
        for generated_at, expected_start, expected_end in cases:
            with self.subTest(generated_at=generated_at):
                start, end = _next_regular_equities_session_window(generated_at)
                self.assertEqual(start.isoformat(), expected_start)
                self.assertEqual(end.isoformat(), expected_end)

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

    def test_builder_exports_next_paper_route_runtime_window_targets(self) -> None:
        generated_at = datetime(2026, 5, 24, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 0,
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 2,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAPER-ROUTE",
                                "candidate_id": "candidate-paper-route",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "paper-route-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_kind": "durable_runtime_ledger_bucket",
                                "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
                                "dataset_snapshot_ref": "dataset://paper-route",
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "max_notional": "0",
                            },
                            {
                                "hypothesis_id": "H-PAPER-ROUTE",
                                "candidate_id": "candidate-paper-route",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "paper-route-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_kind": "durable_runtime_ledger_bucket",
                                "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
                                "dataset_snapshot_ref": "dataset://paper-route",
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "max_notional": "0",
                            },
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["aapl"],
                        "paper_route_probe_active_symbols": [],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                        "blocking_reasons": [
                            "not_paper_mode",
                            "market_session_closed",
                        ],
                    },
                },
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(
            plan["schema_version"], "torghut.next-paper-route-runtime-window-targets.v1"
        )
        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["skipped_target_count"], 1)
        self.assertEqual(
            plan["skipped_targets"][0]["reason"],
            "duplicate_next_paper_route_runtime_window_target",
        )
        self.assertEqual(
            plan["session_window"],
            {
                "start": "2026-05-26T13:30:00+00:00",
                "end": "2026-05-26T20:00:00+00:00",
            },
        )
        target = plan["targets"][0]
        self.assertEqual(target["account_label"], "TORGHUT_SIM")
        self.assertEqual(target["source_account_label"], "TORGHUT_REPLAY")
        self.assertEqual(target["source_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_kind"], "paper_route_probe_runtime_observed")
        self.assertEqual(target["max_notional"], "0")
        self.assertEqual(target["paper_route_probe_symbols"], ["AAPL"])
        self.assertEqual(target["paper_route_probe_next_session_max_notional"], "25")
        self.assertEqual(
            plan["paper_route_probe"]["blocking_reasons"],
            ["not_paper_mode", "market_session_closed"],
        )
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertIn(
            "paper_route_runtime_ledger_import_pending",
            target["runtime_ledger_target_metadata_blockers"],
        )

    def test_source_activity_is_bound_to_target_window_end(self) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        strategy_name = "post-window-paper-route"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="post-window paper route source activity",
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
                decision_json={"action": "buy", "qty": "1"},
                rationale="post window fixture",
                status="executed",
                created_at=window_end + timedelta(minutes=5),
                executed_at=window_end + timedelta(minutes=6),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="paper",
                alpaca_order_id="post-window-order-1",
                client_order_id="post-window-client-1",
                symbol="AAPL",
                side="buy",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                status="filled",
                raw_order={},
                created_at=window_end + timedelta(minutes=6),
                updated_at=window_end + timedelta(minutes=6),
                last_update_at=window_end + timedelta(minutes=6),
            )
            session.add(execution)
            session.flush()
            session.add(
                ExecutionTCAMetric(
                    execution_id=execution.id,
                    trade_decision_id=decision.id,
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    side="buy",
                    arrival_price=Decimal("99"),
                    avg_fill_price=Decimal("100"),
                    filled_qty=Decimal("1"),
                    signed_qty=Decimal("1"),
                    slippage_bps=Decimal("5"),
                    shortfall_notional=Decimal("1"),
                    realized_shortfall_bps=Decimal("5"),
                    churn_qty=Decimal("0"),
                    churn_ratio=Decimal("0"),
                    computed_at=window_end + timedelta(minutes=7),
                    created_at=window_end + timedelta(minutes=7),
                    updated_at=window_end + timedelta(minutes=7),
                )
            )
            session.commit()

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 0,
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-POST-WINDOW",
                                "candidate_id": "candidate-post-window",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "paper",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": [" aapl ", "AAPL"],
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "max_notional": "0",
                            }
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["AAPL", "MSFT"],
                        "paper_route_probe_active_symbols": [],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=window_start - timedelta(days=2),
            )

        source_activity = payload["targets"][0]["source_activity"]
        self.assertEqual(source_activity["symbols"], ["AAPL"])
        self.assertTrue(source_activity["missing"])
        self.assertEqual(source_activity["decision_count"], 0)
        self.assertEqual(source_activity["execution_count"], 0)
        self.assertEqual(source_activity["tca_sample_count"], 0)
        self.assertEqual(
            source_activity["missing_reasons"],
            [
                "source_decisions_missing",
                "source_executions_missing",
                "source_tca_missing",
            ],
        )
        self.assertIn(
            "source_decisions_missing",
            payload["targets"][0]["readiness"]["evidence_collection_blockers"],
        )

    def test_source_activity_is_scoped_to_target_account_and_probe_symbols(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        strategy_name = "wrong-account-or-symbol-paper-route"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="wrong account and symbol paper route source activity",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "MSFT"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add(strategy)
            session.flush()
            for suffix, account_label, symbol in (
                ("wrong-account", "other-paper", "AAPL"),
                ("wrong-symbol", "paper", "MSFT"),
            ):
                decision = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label=account_label,
                    symbol=symbol,
                    timeframe="1Min",
                    decision_json={"action": "buy", "qty": "1"},
                    rationale=f"{suffix} fixture",
                    status="executed",
                    created_at=window_start + timedelta(minutes=5),
                    executed_at=window_start + timedelta(minutes=6),
                )
                session.add(decision)
                session.flush()
                execution = Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label=account_label,
                    alpaca_order_id=f"{suffix}-order-1",
                    client_order_id=f"{suffix}-client-1",
                    symbol=symbol,
                    side="buy",
                    order_type="limit",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    status="filled",
                    raw_order={},
                    created_at=window_start + timedelta(minutes=6),
                    updated_at=window_start + timedelta(minutes=6),
                    last_update_at=window_start + timedelta(minutes=6),
                )
                session.add(execution)
                session.flush()
                session.add(
                    ExecutionTCAMetric(
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        strategy_id=strategy.id,
                        alpaca_account_label=account_label,
                        symbol=symbol,
                        side="buy",
                        arrival_price=Decimal("99"),
                        avg_fill_price=Decimal("100"),
                        filled_qty=Decimal("1"),
                        signed_qty=Decimal("1"),
                        slippage_bps=Decimal("5"),
                        shortfall_notional=Decimal("1"),
                        realized_shortfall_bps=Decimal("5"),
                        churn_qty=Decimal("0"),
                        churn_ratio=Decimal("0"),
                        computed_at=window_start + timedelta(minutes=7),
                        created_at=window_start + timedelta(minutes=7),
                        updated_at=window_start + timedelta(minutes=7),
                    )
                )
            session.commit()

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 0,
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-SCOPED-SOURCE",
                                "candidate_id": "candidate-scoped-source",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "paper",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "max_notional": "0",
                            }
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["AAPL"],
                        "paper_route_probe_active_symbols": [],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=window_start - timedelta(days=2),
            )

        source_activity = payload["targets"][0]["source_activity"]
        self.assertEqual(source_activity["account_label"], "paper")
        self.assertEqual(source_activity["symbols"], ["AAPL"])
        self.assertTrue(source_activity["missing"])
        self.assertEqual(source_activity["decision_count"], 0)
        self.assertEqual(source_activity["execution_count"], 0)
        self.assertEqual(source_activity["tca_sample_count"], 0)
        self.assertIn(
            "source_decisions_missing",
            payload["targets"][0]["readiness"]["evidence_collection_blockers"],
        )

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

        gate_plan = payload["live_submission_gate"][
            "runtime_ledger_paper_probation_import_plan"
        ]
        self.assertFalse(gate_plan["promotion_allowed"])
        self.assertFalse(gate_plan["final_promotion_allowed"])
        audit = payload["targets"][0]
        self.assertFalse(audit["target"]["promotion_allowed"])
        self.assertFalse(audit["target"]["final_promotion_allowed"])
        self.assertTrue(audit["target"]["source_promotion_allowed"])
        self.assertTrue(audit["target"]["source_final_promotion_allowed"])
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
        self.assertEqual(audit["readiness"]["evidence_collection_blockers"], [])
        self.assertEqual(
            audit["readiness"]["promotion_authority"],
            {
                "allowed": False,
                "reason": "paper_route_evidence_audit_observability_only",
                "source_promotion_allowed": True,
                "source_final_promotion_allowed": True,
                "blockers": [
                    "paper_probation_evidence_collection_only",
                    "paper_route_evidence_audit_stripped_promotion_authority",
                ],
            },
        )
        self.assertEqual(
            audit["readiness"]["blockers"],
            [
                "paper_probation_evidence_collection_only",
                "paper_route_evidence_audit_stripped_promotion_authority",
            ],
        )
        self.assertEqual(payload["summary"]["target_with_source_activity_count"], 1)
        self.assertEqual(payload["summary"]["target_with_runtime_ledger_count"], 1)
        self.assertEqual(payload["summary"]["target_with_promotion_decision_count"], 1)
        self.assertEqual(payload["summary"]["promotion_allowed_count"], 0)
        self.assertEqual(payload["summary"]["final_promotion_allowed_count"], 0)
        self.assertEqual(payload["summary"]["source_promotion_allowed_count"], 1)
        self.assertEqual(payload["summary"]["source_final_promotion_allowed_count"], 1)
        self.assertEqual(
            payload["summary"]["promotion_authority"]["reason"],
            "paper_route_evidence_audit_observability_only",
        )
