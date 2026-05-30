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
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    PositionSnapshot,
    RejectedSignalOutcomeEvent,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from app.trading.paper_route_evidence import (
    RUNTIME_LEDGER_PROOF_PACKET_HANDOFF_SCHEMA_VERSION,
    _account_window_start_snapshot_audit,
    _next_regular_equities_session_window,
    _normalized_open_positions,
    _paper_route_probe_summary,
    _runtime_ledger_row_diagnostic_expectancy_bps,
    build_paper_route_evidence_audit,
    build_paper_route_target_plan_payload,
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

    def _add_flat_account_start_snapshot(
        self,
        session: Session,
        *,
        account_label: str,
        window_start: datetime,
    ) -> None:
        session.add(
            PositionSnapshot(
                alpaca_account_label=account_label,
                as_of=window_start - timedelta(seconds=30),
                equity=Decimal("100000"),
                cash=Decimal("100000"),
                buying_power=Decimal("200000"),
                positions=[],
            )
        )

    def _add_account_position_snapshot(
        self,
        session: Session,
        *,
        account_label: str,
        as_of: datetime,
        positions: list[dict[str, object]],
    ) -> None:
        session.add(
            PositionSnapshot(
                alpaca_account_label=account_label,
                as_of=as_of,
                equity=Decimal("100000"),
                cash=Decimal("100000"),
                buying_power=Decimal("200000"),
                positions=positions,
            )
        )

    def _build_basic_paper_route_target_plan(
        self,
        session: Session,
        *,
        generated_at: datetime,
    ) -> dict[str, object]:
        return build_paper_route_target_plan_payload(
            session,
            live_submission_gate={
                "allowed": False,
                "reason": "paper_route_probe_only",
                "blocked_reasons": [],
                "promotion_eligible_total": 0,
                "dependency_quorum_decision": "allow",
                "continuity_ok": True,
                "continuity_reason": "signal_continuity_nominal",
                "drift_ok": True,
                "drift_reason": "drift_live_promotion_eligible",
                "runtime_ledger_paper_probation_import_plan": {
                    "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                    "target_count": 1,
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "candidate-pre-session",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_pairs",
                            "strategy_name": "paper-route-candidate-v1",
                            "account_label": "TORGHUT_REPLAY",
                            "source_kind": "durable_runtime_ledger_bucket",
                            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
                            "dataset_snapshot_ref": "dataset://paper-route",
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
                    "paper_route_probe_eligible_symbols": ["AAPL", "AMZN"],
                    "paper_route_probe_active_symbols": [],
                },
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "next_session_max_notional": "25",
                    "eligible_symbol_count": 2,
                    "eligible_symbols": ["AAPL", "AMZN"],
                    "blocking_reasons": ["market_session_closed"],
                },
            },
            generated_at=generated_at,
        )

    def test_normalized_open_positions_handles_flat_short_and_implicit_market_value(
        self,
    ) -> None:
        positions = _normalized_open_positions(
            [
                {
                    "symbol": "FLAT",
                    "qty": "0",
                    "market_value": "100",
                },
                {
                    "symbol": "AAPL",
                    "qty": "2",
                    "side": "short",
                    "avg_entry_price": "150",
                },
                {
                    "symbol": "",
                    "qty": "1",
                    "market_value": "10",
                },
            ],
            target_symbols={"AAPL"},
        )

        self.assertEqual(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "qty": "-2",
                    "side": "short",
                    "market_value": "300",
                    "target_symbol": True,
                }
            ],
        )

    def test_account_window_start_snapshot_audit_blocks_stale_snapshot(self) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                PositionSnapshot(
                    alpaca_account_label="TORGHUT_SIM",
                    as_of=window_start - timedelta(minutes=16),
                    equity=Decimal("100000"),
                    cash=Decimal("100000"),
                    buying_power=Decimal("200000"),
                    positions=[],
                )
            )
            session.commit()

            audit = _account_window_start_snapshot_audit(
                session,
                account_label="TORGHUT_SIM",
                symbols=["AAPL"],
                window_start=window_start,
            )

        self.assertFalse(audit["flat"])
        self.assertEqual(audit["snapshot_offset_seconds"], -960)
        self.assertEqual(
            audit["blockers"],
            ["paper_route_account_window_start_snapshot_stale"],
        )

    def test_pre_session_dirty_account_skips_next_paper_route_target(self) -> None:
        generated_at = datetime(2026, 5, 26, 13, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=generated_at - timedelta(seconds=30),
                positions=[
                    {
                        "symbol": "AAPL",
                        "qty": "2",
                        "side": "long",
                        "market_value": "400",
                    },
                    {
                        "symbol": "MSFT",
                        "qty": "1",
                        "side": "long",
                        "market_value": "300",
                    },
                ],
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 0)
        self.assertEqual(plan["runtime_window_import_handoff"]["target_count"], 0)
        self.assertEqual(plan["skipped_target_count"], 1)
        skipped = plan["skipped_targets"][0]
        self.assertEqual(skipped["reason"], "paper_route_account_pre_session_not_clean")
        self.assertEqual(
            skipped["paper_route_account_pre_session_state"]["state"], "blocked"
        )
        blockers = skipped["paper_route_account_pre_session_blockers"]
        self.assertIn("paper_route_account_pre_session_not_flat", blockers)
        self.assertIn("paper_route_account_pre_session_positions_present", blockers)
        self.assertIn(
            "paper_route_account_pre_session_target_positions_present", blockers
        )
        self.assertIn(
            "paper_route_account_pre_session_non_target_positions_present", blockers
        )
        readiness = plan["account_pre_session_readiness"]
        self.assertEqual(readiness["required_target_count"], 1)
        self.assertEqual(readiness["clean_target_count"], 0)
        self.assertIn("paper_route_account_pre_session_not_flat", readiness["blockers"])

    def test_pre_session_missing_account_snapshot_skips_target(self) -> None:
        generated_at = datetime(2026, 5, 26, 13, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 0)
        self.assertEqual(plan["skipped_target_count"], 1)
        skipped = plan["skipped_targets"][0]
        self.assertEqual(
            skipped["paper_route_account_pre_session_blockers"],
            ["paper_route_account_pre_session_snapshot_missing"],
        )
        self.assertEqual(
            plan["account_pre_session_readiness"]["blockers"],
            ["paper_route_account_pre_session_snapshot_missing"],
        )
        source_plan = payload["source_runtime_window_import_plan"]
        self.assertEqual(source_plan["target_count"], 1)
        self.assertEqual(
            source_plan["targets"][0]["candidate_id"], "candidate-pre-session"
        )
        self.assertEqual(
            source_plan["targets"][0]["paper_route_account_pre_session_blockers"],
            ["paper_route_account_pre_session_snapshot_missing"],
        )
        self.assertEqual(
            payload["summary"]["source_runtime_window_target_count"],
            1,
        )

    def test_runtime_ledger_diagnostic_expectancy_prefers_payload_value(self) -> None:
        row = StrategyRuntimeLedgerBucket(
            run_id="diagnostic-runtime-ledger-run",
            candidate_id="candidate-diagnostic",
            hypothesis_id="H-DIAGNOSTIC",
            observed_stage="paper",
            bucket_started_at=datetime(2026, 5, 28, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 5, 28, 15, 30, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            runtime_strategy_name="diagnostic-strategy",
            strategy_family="microbar_pairs",
            fill_count=2,
            decision_count=1,
            submitted_order_count=1,
            closed_trade_count=0,
            open_position_count=1,
            filled_notional=Decimal("1000"),
            gross_strategy_pnl=Decimal("20"),
            cost_amount=Decimal("1"),
            net_strategy_pnl_after_costs=Decimal("19"),
            post_cost_expectancy_bps=None,
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            execution_policy_hash_counts={"policy-a": 1},
            cost_model_hash_counts={"cost-a": 1},
            lineage_hash_counts={"lineage-a": 1},
            blockers_json=["unclosed_position"],
            payload_json={"diagnostic_closed_trade_expectancy_bps": "12.5"},
        )

        self.assertEqual(
            _runtime_ledger_row_diagnostic_expectancy_bps(row),
            Decimal("12.5"),
        )

    def test_runtime_ledger_diagnostic_expectancy_requires_closed_trade(self) -> None:
        row = StrategyRuntimeLedgerBucket(
            run_id="diagnostic-runtime-ledger-run",
            candidate_id="candidate-diagnostic",
            hypothesis_id="H-DIAGNOSTIC",
            observed_stage="paper",
            bucket_started_at=datetime(2026, 5, 28, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 5, 28, 15, 30, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            runtime_strategy_name="diagnostic-strategy",
            strategy_family="microbar_pairs",
            fill_count=1,
            decision_count=1,
            submitted_order_count=1,
            closed_trade_count=0,
            open_position_count=1,
            filled_notional=Decimal("1000"),
            gross_strategy_pnl=Decimal("20"),
            cost_amount=Decimal("1"),
            net_strategy_pnl_after_costs=Decimal("19"),
            post_cost_expectancy_bps=None,
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            execution_policy_hash_counts={"policy-a": 1},
            cost_model_hash_counts={"cost-a": 1},
            lineage_hash_counts={"lineage-a": 1},
            blockers_json=["closed_round_trip_missing"],
            payload_json={},
        )

        self.assertIsNone(_runtime_ledger_row_diagnostic_expectancy_bps(row))

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
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": True,
                    "continuity_reason": "signal_continuity_nominal",
                    "drift_ok": True,
                    "drift_reason": "drift_live_promotion_eligible",
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
                                "candidate_blockers": [
                                    "paper_route_runtime_ledger_import_pending",
                                    "custom_runtime_blocker",
                                    "custom_runtime_blocker",
                                ],
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
        self.assertEqual(plan["session_readiness"]["state"], "waiting_for_session_open")
        self.assertFalse(plan["session_readiness"]["window_open"])
        self.assertFalse(plan["session_readiness"]["window_closed"])
        self.assertFalse(plan["session_readiness"]["import_ready"])
        self.assertEqual(plan["session_readiness"]["settlement_seconds"], 3600)
        self.assertEqual(
            plan["session_readiness"]["settlement_ready_at"],
            "2026-05-26T21:00:00+00:00",
        )
        self.assertEqual(
            plan["session_readiness"]["import_blockers"],
            ["paper_route_session_window_not_open"],
        )
        handoff = plan["runtime_window_import_handoff"]
        self.assertEqual(
            handoff["runner"], "scripts/renew_latest_empirical_promotion_jobs.py"
        )
        self.assertEqual(
            handoff["target_plan_endpoint"], "/trading/paper-route-target-plan"
        )
        self.assertIn("--runtime-window-import", handoff["required_flags"])
        self.assertIn(
            "--runtime-window-target-plan-settlement-seconds",
            handoff["required_flags"],
        )
        self.assertEqual(handoff["target_plan_settlement_seconds"], 3600)
        self.assertEqual(handoff["settlement_ready_at"], "2026-05-26T21:00:00+00:00")
        self.assertFalse(handoff["import_ready"])
        self.assertEqual(
            handoff["import_blockers"],
            ["paper_route_session_window_not_open"],
        )
        self.assertFalse(handoff["promotion_allowed"])
        self.assertFalse(handoff["final_promotion_authorized"])
        self.assertEqual(handoff["target_dsn_env"], "SIM_DB_DSN")
        target = plan["targets"][0]
        self.assertEqual(target["account_label"], "TORGHUT_SIM")
        self.assertEqual(target["source_account_label"], "TORGHUT_REPLAY")
        self.assertEqual(target["source_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_kind"], "paper_route_probe_runtime_observed")
        self.assertEqual(target["dependency_quorum_decision"], "allow")
        self.assertEqual(target["continuity_ok"], "true")
        self.assertEqual(target["continuity_reason"], "signal_continuity_nominal")
        self.assertEqual(target["drift_ok"], "true")
        self.assertEqual(target["drift_reason"], "drift_live_promotion_eligible")
        self.assertEqual(target["runtime_window_import_health_gate"]["ready"], True)
        self.assertEqual(target["runtime_window_import_health_gate"]["blockers"], [])
        self.assertEqual(
            plan["runtime_window_import_health_gate"]["continuity_reasons"],
            ["signal_continuity_nominal"],
        )
        self.assertEqual(
            plan["runtime_window_import_health_gate"]["drift_reasons"],
            ["drift_live_promotion_eligible"],
        )
        self.assertEqual(target["max_notional"], "0")
        self.assertEqual(target["paper_route_probe_symbols"], ["AAPL"])
        self.assertEqual(target["paper_route_probe_next_session_max_notional"], "25")
        self.assertEqual(
            target["source_decision_readiness"]["blockers"],
            ["source_strategy_missing"],
        )
        self.assertFalse(target["source_decision_readiness"]["ready"])
        self.assertEqual(
            plan["source_decision_readiness"]["blockers"],
            ["source_strategy_missing"],
        )
        self.assertEqual(plan["source_decision_readiness"]["ready_target_count"], 0)
        self.assertEqual(plan["source_decision_readiness"]["blocked_target_count"], 1)
        self.assertEqual(
            plan["paper_route_probe"]["blocking_reasons"],
            ["not_paper_mode", "market_session_closed"],
        )
        self.assertEqual(
            target["paper_route_session_readiness_state"], "waiting_for_session_open"
        )
        self.assertFalse(target["paper_route_session_import_ready"])
        self.assertEqual(
            target["paper_route_session_import_blockers"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            target["paper_route_runtime_window_import_not_before"],
            "2026-05-26T21:00:00+00:00",
        )
        self.assertEqual(
            target["paper_route_runtime_import_handoff"]["target_plan_endpoint"],
            "/trading/paper-route-target-plan",
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(
            import_audit["schema_version"],
            "torghut.paper-route-runtime-window-import-audit.v1",
        )
        self.assertEqual(import_audit["state"], "waiting_for_session_open")
        self.assertEqual(import_audit["next_action"], "wait_for_regular_session_open")
        self.assertFalse(import_audit["import_ready"])
        self.assertEqual(
            import_audit["blockers"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(import_audit["counts"]["source_plan_target_count"], 2)
        self.assertEqual(import_audit["counts"]["selected_target_count"], 1)
        self.assertEqual(import_audit["counts"]["next_runtime_window_target_count"], 1)
        summary = payload["summary"]
        self.assertEqual(summary["next_runtime_window_target_count"], 1)
        self.assertEqual(summary["next_runtime_window_selected_target_count"], 1)
        self.assertEqual(
            summary["next_runtime_window_target_with_source_activity_count"],
            0,
        )
        self.assertEqual(
            summary["next_runtime_window_target_with_runtime_ledger_count"],
            0,
        )
        self.assertEqual(
            summary["next_runtime_window_import_next_action"],
            "wait_for_regular_session_open",
        )
        self.assertEqual(len(summary["next_paper_route_targets"]), 1)
        summary_target = summary["next_paper_route_targets"][0]
        self.assertEqual(summary_target["candidate_id"], "candidate-paper-route")
        self.assertEqual(summary_target["hypothesis_id"], "H-PAPER-ROUTE")
        self.assertEqual(
            summary_target["runtime_strategy_id"],
            "paper-route-candidate-v1",
        )
        self.assertEqual(summary_target["symbols"], ["AAPL"])
        self.assertEqual(
            summary_target["session_start"],
            "2026-05-26T13:30:00+00:00",
        )
        self.assertEqual(
            summary_target["session_end"],
            "2026-05-26T20:00:00+00:00",
        )
        self.assertFalse(summary_target["import_ready"])
        self.assertEqual(
            summary_target["import_blockers"],
            ["paper_route_session_window_not_open"],
        )
        self.assertFalse(summary_target["promotion_allowed"])
        self.assertTrue(summary_target["promotion_blocked"])
        self.assertFalse(summary_target["source_decision_ready"])
        self.assertEqual(
            summary_target["source_decision_blockers"],
            ["source_strategy_missing"],
        )
        self.assertEqual(
            import_audit["diagnostics"]["target_blockers_effective_when"],
            "runtime_window_import_ready",
        )
        self.assertEqual(len(import_audit["target_blockers"]), 1)
        target_blocker = import_audit["target_blockers"][0]
        self.assertEqual(target_blocker["candidate_id"], "candidate-paper-route")
        self.assertEqual(target_blocker["hypothesis_id"], "H-PAPER-ROUTE")
        self.assertEqual(target_blocker["paper_route_probe_symbols"], ["AAPL"])
        self.assertEqual(
            target_blocker["source_activity"],
            {
                "decision_count": 0,
                "execution_count": 0,
                "filled_execution_count": 0,
                "tca_sample_count": 0,
                "last_decision_at": None,
                "last_execution_at": None,
                "last_tca_at": None,
            },
        )
        self.assertIn("source_decisions_missing", target_blocker["blockers"])
        self.assertIn("runtime_ledger_bucket_missing", target_blocker["blockers"])
        self.assertIn("promotion_decision_missing", target_blocker["blockers"])
        self.assertFalse(import_audit["promotion_authority"]["allowed"])
        proof_handoff = payload["runtime_ledger_proof_packet_handoff"]
        self.assertEqual(
            proof_handoff["schema_version"],
            RUNTIME_LEDGER_PROOF_PACKET_HANDOFF_SCHEMA_VERSION,
        )
        self.assertFalse(proof_handoff["promotion_allowed"])
        self.assertFalse(proof_handoff["final_promotion_authorized"])
        self.assertEqual(
            proof_handoff["source_endpoints"],
            {
                "status": "/trading/status",
                "paper_route_evidence": "/trading/paper-route-evidence",
                "completion_doc29": "/trading/completion/doc29",
            },
        )
        self.assertEqual(
            proof_handoff["targets"],
            {
                "proof_mode": "authority",
                "final_authority": True,
                "evidence_collection_only": False,
                "min_runtime_ledger_net_pnl_after_costs": "10000",
                "min_runtime_ledger_daily_net_pnl_after_costs": "500",
                "min_runtime_ledger_trading_days": 20,
                "max_runtime_ledger_drawdown_pct_equity": "0.03",
                "max_runtime_ledger_best_day_share": "0.25",
                "max_runtime_ledger_symbol_concentration_share": "0.35",
            },
        )
        self.assertEqual(
            proof_handoff["runtime_window"]["import_audit_state"],
            "waiting_for_session_open",
        )
        self.assertEqual(
            proof_handoff["runtime_window"]["import_blockers"],
            ["paper_route_session_window_not_open"],
        )
        self.assertEqual(
            proof_handoff["runtime_window"]["health_gate"]["ready_target_count"],
            1,
        )
        self.assertEqual(
            proof_handoff["runtime_window"]["source_decision_readiness"][
                "blocked_target_count"
            ],
            1,
        )
        self.assertEqual(
            proof_handoff["default_live_service_base_url"],
            "http://torghut.torghut.svc.cluster.local",
        )
        self.assertEqual(
            proof_handoff["default_paper_route_service_base_url"],
            "http://torghut-sim.torghut.svc.cluster.local",
        )
        self.assertEqual(
            proof_handoff["source_service_authority"],
            {
                "status": "live_torghut_service",
                "paper_route_evidence": "torghut_sim_service",
                "completion_doc29": "live_torghut_service",
            },
        )
        waiting_argv = proof_handoff["commands"]["waiting_packet"]["argv"]
        self.assertIn("--status-service-base-url", waiting_argv)
        self.assertIn("--paper-route-service-base-url", waiting_argv)
        self.assertIn("--completion-service-base-url", waiting_argv)
        self.assertIn("$TORGHUT_LIVE_SERVICE_BASE_URL", waiting_argv)
        self.assertIn("$TORGHUT_PAPER_ROUTE_SERVICE_BASE_URL", waiting_argv)
        self.assertIn("--proof-mode", waiting_argv)
        self.assertIn("smoke", waiting_argv)
        self.assertIn("--min-runtime-ledger-net-pnl", waiting_argv)
        authority_argv = proof_handoff["commands"]["authority_packet_after_import"][
            "argv"
        ]
        self.assertIn("--proof-mode", authority_argv)
        self.assertIn("authority", authority_argv)
        self.assertIn("10000", authority_argv)
        self.assertIn("20", authority_argv)
        self.assertIn("--runtime-window-import-file", authority_argv)
        self.assertIn("artifacts/runtime-window-import.json", authority_argv)
        self.assertIn("--artifact-prefix", authority_argv)
        self.assertIn("runtime-ledger-proof-packets/{run_id}", authority_argv)
        self.assertIn("--require-artifact-upload", authority_argv)
        self.assertTrue(
            proof_handoff["commands"]["authority_packet_after_import"][
                "requires_durable_artifact_upload"
            ]
        )
        self.assertEqual(
            proof_handoff["required_inputs"]["durable_artifact_upload"][
                "artifact_prefix"
            ],
            "runtime-ledger-proof-packets/{run_id}",
        )
        self.assertEqual(
            proof_handoff["required_inputs"]["runtime_window_import"]["required_when"],
            "runtime_window.import_ready",
        )
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertEqual(
            target["candidate_blockers"],
            [
                "paper_route_runtime_ledger_import_pending",
                "custom_runtime_blocker",
            ],
        )
        self.assertIn(
            "paper_route_runtime_ledger_import_pending",
            target["runtime_ledger_target_metadata_blockers"],
        )

    def test_next_paper_route_targets_surface_source_decision_readiness(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 24, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="paper route source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                    max_notional_per_trade=Decimal("31590"),
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
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": True,
                    "continuity_reason": "signal_continuity_nominal",
                    "drift_ok": True,
                    "drift_reason": "drift_live_promotion_eligible",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-paper-route",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": (
                                    "69cf50e3-4815-47c2-b802-1efbaac09ecb"
                                ),
                                "runtime_strategy_name": (
                                    "69cf50e3-4815-47c2-b802-1efbaac09ecb"
                                ),
                                "strategy_lookup_names": [
                                    "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                    "microbar-cross-sectional-pairs-v1",
                                ],
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "durable_runtime_ledger_bucket",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
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
                        "paper_route_probe_eligible_symbols": ["AAPL", "AMZN", "INTC"],
                        "paper_route_probe_active_symbols": [],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "63180",
                        "eligible_symbol_count": 3,
                        "eligible_symbols": ["AAPL", "AMZN", "INTC"],
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(
            plan["source_decision_readiness"]["ready_target_count"],
            1,
        )
        self.assertEqual(plan["source_decision_readiness"]["blocked_target_count"], 0)
        self.assertEqual(plan["source_decision_readiness"]["blockers"], [])
        target = plan["targets"][0]
        readiness = target["source_decision_readiness"]
        self.assertTrue(readiness["ready"])
        self.assertEqual(readiness["blockers"], [])
        self.assertEqual(
            readiness["matched_strategy"]["strategy_name"],
            "microbar-cross-sectional-pairs-v1",
        )
        self.assertEqual(readiness["matched_strategy"]["base_timeframe"], "1Sec")
        self.assertEqual(
            readiness["matched_strategy"]["universe_symbols"],
            ["AAPL", "AMZN"],
        )
        self.assertEqual(readiness["scoped_probe_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(
            target["paper_route_probe_out_of_strategy_scope_symbols"],
            ["INTC"],
        )
        self.assertEqual(
            target["paper_route_probe_missing_strategy_universe_symbols"],
            [],
        )
        summary_target = payload["summary"]["next_paper_route_targets"][0]
        self.assertTrue(summary_target["source_decision_ready"])
        self.assertEqual(summary_target["source_decision_blockers"], [])

    def test_next_paper_route_targets_use_strategy_universe_when_route_probe_empty(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 24, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="paper route source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                    max_notional_per_trade=Decimal("31590"),
                )
            )
            session.commit()
            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 0,
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": True,
                    "continuity_reason": "signal_continuity_nominal",
                    "drift_ok": True,
                    "drift_reason": "drift_live_promotion_eligible",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-paper-route",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": (
                                    "69cf50e3-4815-47c2-b802-1efbaac09ecb"
                                ),
                                "runtime_strategy_name": (
                                    "69cf50e3-4815-47c2-b802-1efbaac09ecb"
                                ),
                                "strategy_lookup_names": [
                                    "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                    "microbar-cross-sectional-pairs-v1",
                                ],
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "durable_runtime_ledger_bucket",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
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
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "63180",
                        "eligible_symbol_count": 0,
                        "eligible_symbols": [],
                        "active_symbols": [],
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=generated_at,
            )

        plan = payload["runtime_window_import_plan"]
        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["source_decision_readiness"]["ready_target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["paper_route_probe_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(
            target["paper_route_probe_scope_authority"], "strategy_universe"
        )
        self.assertTrue(target["paper_route_probe_strategy_scope_applied"])
        self.assertTrue(target["paper_route_probe_strategy_universe_fallback"])
        self.assertEqual(target["paper_route_probe_raw_target_symbols"], [])
        self.assertEqual(
            target["source_decision_readiness"]["scoped_probe_symbols"],
            ["AAPL", "AMZN"],
        )

    def test_source_collection_target_uses_strategy_universe_when_route_probe_empty(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 24, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="source collection strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                    max_notional_per_trade=Decimal("31590"),
                )
            )
            session.commit()
            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "source_collection_pending",
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "promotion_eligible_total": 0,
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": True,
                    "continuity_reason": "signal_continuity_nominal",
                    "drift_ok": True,
                    "drift_reason": "drift_live_promotion_eligible",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "c88421d619759b2cfaa6f4d0",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "runtime_strategy_name": (
                                    "microbar-cross-sectional-pairs-v1"
                                ),
                                "strategy_lookup_names": [
                                    "microbar-cross-sectional-pairs-v1"
                                ],
                                "account_label": "TORGHUT_SIM",
                                "source_kind": (
                                    "runtime_ledger_source_collection_candidate"
                                ),
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                                "source_collection_authorized": True,
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
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "63180",
                        "eligible_symbol_count": 0,
                        "eligible_symbols": [],
                        "active_symbols": [],
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=generated_at,
            )

        plan = payload["runtime_window_import_plan"]
        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["paper_route_probe_symbols"], ["AAPL", "AMZN"])
        self.assertTrue(target["paper_route_probe_strategy_universe_fallback"])
        self.assertEqual(
            target["paper_route_probe_scope_authority"], "strategy_universe"
        )

    def test_builder_exports_missing_runtime_window_health_gate_as_blockers(
        self,
    ) -> None:
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
                        "target_count": 1,
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
                            }
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["AAPL"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                        "blocking_reasons": [],
                    },
                },
                generated_at=generated_at,
            )

        target = payload["next_paper_route_runtime_window_targets"]["targets"][0]
        self.assertEqual(target["dependency_quorum_decision"], "missing")
        self.assertEqual(target["continuity_ok"], "false")
        self.assertEqual(target["drift_ok"], "false")
        self.assertEqual(
            target["runtime_window_import_health_gate"]["blockers"],
            [
                "runtime_window_import_dependency_quorum_missing",
                "runtime_window_import_continuity_missing",
            ],
        )
        self.assertEqual(
            target["runtime_window_import_health_gate"]["promotion_blockers"],
            ["runtime_window_import_drift_missing"],
        )
        self.assertIn(
            "runtime_window_import_dependency_quorum_missing",
            target["candidate_blockers"],
        )
        self.assertIn(
            "runtime_window_import_drift_missing",
            target["runtime_ledger_target_metadata_blockers"],
        )
        health_gate = payload["next_paper_route_runtime_window_targets"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 0)
        self.assertEqual(health_gate["blocked_target_count"], 1)
        self.assertEqual(
            health_gate["promotion_blockers"],
            ["runtime_window_import_drift_missing"],
        )

    def test_builder_exports_non_allow_runtime_window_health_gate_blockers(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 24, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 0,
                    "dependency_quorum_decision": "block",
                    "continuity_ok": "false",
                    "continuity_reason": "signal_continuity_alert_active",
                    "drift_ok": "false",
                    "drift_reason": "drift_live_promotion_ineligible",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAPER-ROUTE",
                                "candidate_id": "candidate-paper-route",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "paper-route-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
                                "continuity_ok": "unknown",
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
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                        "blocking_reasons": [],
                    },
                },
                generated_at=generated_at,
            )

        target = payload["next_paper_route_runtime_window_targets"]["targets"][0]
        gate = target["runtime_window_import_health_gate"]
        self.assertEqual(gate["dependency_quorum_decision"], "block")
        self.assertEqual(gate["dependency_quorum_source"], "live_submission_gate")
        self.assertEqual(gate["continuity_ok"], "false")
        self.assertEqual(gate["continuity_source"], "live_submission_gate")
        self.assertEqual(gate["continuity_reason"], "signal_continuity_alert_active")
        self.assertEqual(gate["drift_ok"], "false")
        self.assertEqual(gate["drift_reason"], "drift_live_promotion_ineligible")
        self.assertEqual(
            gate["blockers"],
            [
                "dependency_quorum_not_allow",
                "evidence_continuity_not_ok",
            ],
        )
        self.assertEqual(gate["promotion_blockers"], ["drift_checks_not_ok"])
        self.assertEqual(
            target["runtime_window_import_promotion_blockers"],
            ["drift_checks_not_ok"],
        )
        self.assertEqual(target["drift_reason"], "drift_live_promotion_ineligible")

    def test_next_paper_route_session_readiness_tracks_collection_and_import(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)

        def build(generated_at: datetime) -> dict[str, object]:
            with Session(self.engine) as session:
                self._add_flat_account_start_snapshot(
                    session,
                    account_label="TORGHUT_REPLAY",
                    window_start=window_start,
                )
                self._add_flat_account_start_snapshot(
                    session,
                    account_label="TORGHUT_SIM",
                    window_start=window_start,
                )
                if window_start <= generated_at < window_end:
                    self._add_account_position_snapshot(
                        session,
                        account_label="TORGHUT_SIM",
                        as_of=generated_at - timedelta(seconds=30),
                        positions=[],
                    )
                session.flush()
                return build_paper_route_evidence_audit(
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
                                    "hypothesis_id": "H-PAPER-ROUTE",
                                    "candidate_id": "candidate-paper-route",
                                    "observed_stage": "paper",
                                    "strategy_family": "microbar_pairs",
                                    "strategy_name": "paper-route-candidate-v1",
                                    "account_label": "TORGHUT_REPLAY",
                                    "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
                                    "dataset_snapshot_ref": "dataset://paper-route",
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
                        },
                        "paper_route_probe": {
                            "configured_enabled": True,
                            "active": True,
                            "next_session_max_notional": "25",
                            "eligible_symbol_count": 1,
                            "blocking_reasons": [],
                        },
                    },
                    generated_at=generated_at,
                )

        collecting_payload = build(datetime(2026, 5, 26, 15, tzinfo=timezone.utc))
        collecting_readiness = collecting_payload[
            "next_paper_route_runtime_window_targets"
        ]["session_readiness"]
        self.assertEqual(collecting_readiness["state"], "collecting_session_evidence")
        self.assertTrue(collecting_readiness["window_open"])
        self.assertFalse(collecting_readiness["window_closed"])
        self.assertFalse(collecting_readiness["import_ready"])
        self.assertEqual(
            collecting_readiness["import_blockers"],
            ["paper_route_session_window_not_closed"],
        )

        settlement_payload = build(datetime(2026, 5, 26, 20, 30, tzinfo=timezone.utc))
        settlement_readiness = settlement_payload[
            "next_paper_route_runtime_window_targets"
        ]["session_readiness"]
        self.assertEqual(
            settlement_readiness["state"], "window_closed_settlement_pending"
        )
        self.assertFalse(settlement_readiness["window_open"])
        self.assertTrue(settlement_readiness["window_closed"])
        self.assertFalse(settlement_readiness["settlement_ready"])
        self.assertFalse(settlement_readiness["import_ready"])
        self.assertEqual(settlement_readiness["seconds_until_import_ready"], 1800)
        self.assertEqual(
            settlement_readiness["import_blockers"],
            ["paper_route_session_settlement_pending"],
        )
        settlement_target = settlement_payload[
            "next_paper_route_runtime_window_targets"
        ]["targets"][0]
        self.assertEqual(
            settlement_target["paper_route_session_readiness_state"],
            "window_closed_settlement_pending",
        )
        self.assertEqual(
            settlement_target["paper_route_runtime_window_import_not_before"],
            "2026-05-26T21:00:00+00:00",
        )

        import_payload = build(datetime(2026, 5, 26, 21, tzinfo=timezone.utc))
        import_readiness = import_payload["next_paper_route_runtime_window_targets"][
            "session_readiness"
        ]
        self.assertEqual(import_readiness["state"], "window_closed_import_ready")
        self.assertFalse(import_readiness["window_open"])
        self.assertTrue(import_readiness["window_closed"])
        self.assertTrue(import_readiness["settlement_ready"])
        self.assertTrue(import_readiness["probe_ready"])
        self.assertTrue(import_readiness["import_ready"])
        self.assertEqual(import_readiness["import_blockers"], [])
        import_target = import_payload["next_paper_route_runtime_window_targets"][
            "targets"
        ][0]
        self.assertEqual(
            import_target["paper_route_session_readiness_state"],
            "window_closed_import_ready",
        )
        self.assertTrue(import_target["paper_route_session_import_ready"])
        self.assertEqual(import_target["paper_route_session_import_blockers"], [])
        import_audit = import_payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "import_due_source_activity_missing")
        self.assertEqual(
            import_audit["next_action"],
            "inspect_paper_route_source_activity_before_import",
        )
        self.assertTrue(import_audit["import_ready"])
        self.assertEqual(
            import_audit["blockers"],
            [
                "paper_route_source_activity_missing",
                "source_decisions_missing",
                "source_executions_missing",
                "source_tca_missing",
            ],
        )
        import_handoff = import_payload["runtime_ledger_proof_packet_handoff"]
        self.assertTrue(import_handoff["runtime_window"]["import_ready"])
        self.assertEqual(
            import_handoff["runtime_window"]["import_audit_state"],
            "import_due_source_activity_missing",
        )
        self.assertEqual(
            import_handoff["commands"]["authority_packet_after_import"][
                "expected_verdict"
            ],
            "promotion_authority_allowed",
        )
        self.assertTrue(
            import_handoff["commands"]["authority_packet_after_import"][
                "allowed_only_if_packet_ok"
            ]
        )
        self.assertTrue(
            import_handoff["commands"]["authority_packet_after_import"][
                "requires_durable_artifact_upload"
            ]
        )

    def test_runtime_window_import_audit_tracks_missing_and_non_grade_ledger(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, tzinfo=timezone.utc)
        strategy_name = "ledger-audit-paper-route"

        def build(session: Session) -> dict[str, object]:
            return build_paper_route_evidence_audit(
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
                                "hypothesis_id": "H-LEDGER-AUDIT",
                                "candidate_id": "candidate-ledger-audit",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-ledger-audit.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL"],
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
                        "paper_route_probe_active_symbols": ["AAPL"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": True,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                    },
                },
                generated_at=now,
            )

        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="paper route ledger audit fixture",
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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "2",
                    "candidate_id": "candidate-ledger-audit",
                    "hypothesis_id": "H-LEDGER-AUDIT",
                },
                rationale="paper route ledger audit fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=10),
                executed_at=window_start + timedelta(minutes=11),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="ledger-audit-order-1",
                client_order_id="ledger-audit-client-1",
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
            session.add(
                ExecutionTCAMetric(
                    execution_id=execution.id,
                    trade_decision_id=decision.id,
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
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
                )
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            session.commit()

            missing_ledger_payload = build(session)
            missing_ledger_audit = missing_ledger_payload["runtime_window_import_audit"]
            self.assertEqual(
                missing_ledger_audit["state"], "import_due_runtime_ledger_missing"
            )
            self.assertEqual(
                missing_ledger_audit["next_action"],
                "run_runtime_window_import_or_repair_source_materialization",
            )
            self.assertEqual(
                missing_ledger_audit["blockers"],
                [
                    "runtime_ledger_bucket_missing",
                    "runtime_ledger_source_bucket_missing",
                    "source_activity_present_runtime_ledger_not_materialized",
                ],
            )
            self.assertEqual(
                missing_ledger_audit["diagnostics"][
                    "source_activity_to_runtime_ledger_blockers"
                ],
                [
                    "runtime_ledger_source_bucket_missing",
                    "source_activity_present_runtime_ledger_not_materialized",
                ],
            )
            self.assertEqual(
                missing_ledger_audit["counts"]["targets_with_source_activity"], 1
            )
            self.assertEqual(
                missing_ledger_audit["counts"]["targets_with_runtime_ledger"], 0
            )

            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="paper-route-ledger-audit",
                    candidate_id="candidate-ledger-audit",
                    hypothesis_id="H-LEDGER-AUDIT",
                    observed_stage="paper",
                    bucket_started_at=window_start,
                    bucket_ended_at=window_end,
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name=strategy_name,
                    strategy_family="microbar_pairs",
                    fill_count=2,
                    decision_count=1,
                    submitted_order_count=1,
                    closed_trade_count=0,
                    open_position_count=1,
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
                    blockers_json=["open_position_count_nonzero"],
                )
            )
            session.commit()

            non_grade_payload = build(session)
            non_grade_audit = non_grade_payload["runtime_window_import_audit"]
            self.assertEqual(
                non_grade_audit["state"],
                "runtime_ledger_imported_but_not_evidence_grade",
            )
            self.assertEqual(
                non_grade_audit["next_action"],
                "repair_runtime_ledger_bucket_authority_or_candidate",
            )
            self.assertEqual(
                non_grade_audit["blockers"],
                [
                    "open_position_count_nonzero",
                    "runtime_ledger_evidence_grade_bucket_missing",
                ],
            )
            self.assertEqual(
                non_grade_audit["counts"]["targets_with_runtime_ledger"], 1
            )
            self.assertEqual(
                non_grade_audit["counts"]["targets_with_evidence_grade_runtime_ledger"],
                0,
            )

    def test_runtime_window_import_audit_explains_quote_rejected_source_activity(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add_all(
                [
                    RejectedSignalOutcomeEvent(
                        event_id="paper-route-reject-aapl",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="TORGHUT_SIM",
                        symbol="AAPL",
                        event_ts=window_start + timedelta(minutes=20),
                        timeframe="1Sec",
                        seq="1",
                        reject_reason="spread_bps_exceeded",
                        spread_bps=Decimal("51.35410106"),
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=[
                            "counterfactual_return",
                            "route_tca",
                            "post_cost_net_pnl",
                            "executable_quote",
                        ],
                        event_payload_json={
                            "event_id": "paper-route-reject-aapl",
                            "signal_payload": {
                                "price": "309.615",
                                "imbalance": {
                                    "bid_px": "308.82",
                                    "ask_px": "310.41",
                                },
                            },
                        },
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="paper-route-reject-amzn",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="TORGHUT_SIM",
                        symbol="AMZN",
                        event_ts=window_start + timedelta(minutes=21),
                        timeframe="1Sec",
                        seq="2",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=[
                            "counterfactual_return",
                            "route_tca",
                            "post_cost_net_pnl",
                            "executable_quote",
                        ],
                        event_payload_json={"event_id": "paper-route-reject-amzn"},
                    ),
                ]
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
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
                                "hypothesis_id": "H-QUOTE-REJECT",
                                "candidate_id": "candidate-quote-reject",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-quote-reject.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "max_notional": "63180",
                            }
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["AAPL", "AMZN"],
                        "paper_route_probe_active_symbols": ["AAPL", "AMZN"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": True,
                        "next_session_max_notional": "63180",
                        "eligible_symbol_count": 2,
                    },
                },
                generated_at=datetime(2026, 5, 26, 21, tzinfo=timezone.utc),
            )

        target_audit = payload["next_runtime_window_target_audits"][0]
        rejected_activity = target_audit["rejected_signal_activity"]
        self.assertEqual(rejected_activity["event_count"], 2)
        self.assertEqual(
            rejected_activity["blocking_reasons"],
            [
                "source_signal_rejected_by_quote_quality",
                "source_reject_missing_executable_quote",
                "source_reject_spread_bps_exceeded",
            ],
        )
        self.assertEqual(rejected_activity["max_spread_bps"], "51.35410106")
        self.assertIn(
            "source_reject_spread_bps_exceeded",
            target_audit["readiness"]["blockers"],
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "import_due_source_activity_missing")
        self.assertEqual(
            import_audit["counts"]["targets_with_rejected_signal_activity"],
            1,
        )
        self.assertIn(
            "source_signal_rejected_by_quote_quality",
            import_audit["blockers"],
        )
        self.assertIn("source_reject_spread_bps_exceeded", import_audit["blockers"])

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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-post-window",
                    "hypothesis_id": "H-POST-WINDOW",
                },
                rationale="post window fixture",
                status="executed",
                created_at=window_end + timedelta(minutes=5),
                executed_at=window_end + timedelta(minutes=6),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
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
                    alpaca_account_label="TORGHUT_SIM",
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
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-post-window.json",
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

    def test_source_activity_uses_order_feed_event_time_for_execution_window(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        event_at = window_start + timedelta(minutes=20)
        strategy_name = "event-time-paper-route"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="paper route source activity from order-feed event time",
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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-event-time",
                    "hypothesis_id": "H-EVENT-TIME",
                },
                rationale="event time fixture",
                status="executed",
                created_at=event_at - timedelta(minutes=1),
                executed_at=event_at,
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="event-time-order-1",
                client_order_id="event-time-client-1",
                symbol="AAPL",
                side="buy",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                status="filled",
                raw_order={},
                created_at=window_end + timedelta(minutes=5),
                updated_at=window_end + timedelta(minutes=5),
                last_update_at=event_at,
                order_feed_last_event_ts=event_at,
            )
            session.add(execution)
            session.flush()
            session.add(
                ExecutionTCAMetric(
                    execution_id=execution.id,
                    trade_decision_id=decision.id,
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
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
                    computed_at=event_at + timedelta(minutes=1),
                    created_at=event_at + timedelta(minutes=1),
                    updated_at=event_at + timedelta(minutes=1),
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
                                "hypothesis_id": "H-EVENT-TIME",
                                "candidate_id": "candidate-event-time",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "source_kind": "paper_route_probe_runtime_observed",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-event-time.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL"],
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
                        "paper_route_probe_active_symbols": ["AAPL"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": True,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                    },
                },
                generated_at=window_start - timedelta(days=2),
            )

        source_activity = payload["targets"][0]["source_activity"]
        self.assertFalse(source_activity["missing"])
        self.assertEqual(source_activity["decision_count"], 1)
        self.assertEqual(source_activity["execution_count"], 1)
        self.assertEqual(source_activity["filled_execution_count"], 1)
        self.assertEqual(source_activity["tca_sample_count"], 1)
        self.assertEqual(source_activity["last_execution_at"], event_at.isoformat())
        self.assertEqual(source_activity["missing_reasons"], [])
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["counts"]["targets_with_source_activity"], 1)
        self.assertNotIn("source_executions_missing", import_audit["blockers"])

    def test_source_activity_accepts_order_feed_fill_lifecycle_without_tca(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        event_at = window_start + timedelta(minutes=20)
        strategy_name = "order-feed-source-activity"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="paper route source activity from order-feed lifecycle",
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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-order-feed",
                    "hypothesis_id": "H-ORDER-FEED",
                },
                rationale="order-feed lifecycle fixture",
                status="executed",
                created_at=event_at - timedelta(minutes=1),
                executed_at=event_at,
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="order-feed-order-1",
                client_order_id="order-feed-client-1",
                symbol="AAPL",
                side="buy",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                status="filled",
                raw_order={},
                created_at=event_at,
                updated_at=event_at,
                last_update_at=event_at,
                order_feed_last_event_ts=event_at,
            )
            session.add(execution)
            session.flush()
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="order-feed-fill-event",
                    source_topic="trade_updates",
                    source_partition=0,
                    source_offset=1,
                    alpaca_account_label="TORGHUT_SIM",
                    feed_seq=10,
                    event_ts=event_at,
                    symbol="AAPL",
                    alpaca_order_id="order-feed-order-1",
                    client_order_id="order-feed-client-1",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    raw_event={
                        "event": "fill",
                        "order": {
                            "id": "order-feed-order-1",
                            "client_order_id": "order-feed-client-1",
                            "symbol": "AAPL",
                            "status": "filled",
                            "qty": "1",
                            "filled_qty": "1",
                            "filled_avg_price": "100",
                        },
                    },
                    execution_id=execution.id,
                    trade_decision_id=decision.id,
                    created_at=event_at,
                )
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
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
                                "hypothesis_id": "H-ORDER-FEED",
                                "candidate_id": "candidate-order-feed",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "source_kind": "paper_route_probe_runtime_observed",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-order-feed.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL"],
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
                        "paper_route_probe_active_symbols": ["AAPL"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": True,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                    },
                },
                generated_at=window_end + timedelta(hours=2),
            )

        source_activity = payload["targets"][0]["source_activity"]
        self.assertFalse(source_activity["missing"])
        self.assertEqual(source_activity["decision_count"], 1)
        self.assertEqual(source_activity["execution_count"], 1)
        self.assertEqual(source_activity["filled_execution_count"], 1)
        self.assertEqual(source_activity["tca_sample_count"], 0)
        self.assertEqual(source_activity["order_event_count"], 1)
        self.assertEqual(source_activity["fill_order_event_count"], 1)
        self.assertEqual(source_activity["complete_fill_order_event_count"], 1)
        self.assertEqual(source_activity["last_order_event_at"], event_at.isoformat())
        self.assertEqual(source_activity["missing_reasons"], [])
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "import_due_runtime_ledger_missing")
        self.assertEqual(import_audit["counts"]["targets_with_source_activity"], 1)
        self.assertNotIn(
            "paper_route_source_activity_missing", import_audit["blockers"]
        )
        self.assertNotIn("source_tca_missing", import_audit["blockers"])

    def test_current_paper_route_probe_symbols_extend_next_window_target_scope(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        strategy_name = "next-window-paper-route-symbol-refresh"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="paper route source activity from refreshed probe symbols",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN", "INTC"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="INTC",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-refreshed-probe",
                    "hypothesis_id": "H-REFRESHED-PROBE",
                },
                rationale="refreshed probe symbol fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=5),
                executed_at=window_start + timedelta(minutes=6),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="refreshed-probe-order-1",
                client_order_id="refreshed-probe-client-1",
                symbol="INTC",
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
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="INTC",
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
                    "allowed": True,
                    "reason": "non_live_mode",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 0,
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-REFRESHED-PROBE",
                                "candidate_id": "candidate-refreshed-probe",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
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
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 3,
                        "eligible_symbols": ["AMZN", "AAPL", "INTC"],
                        "active_symbols": [],
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=window_start - timedelta(days=2),
            )

        target = payload["targets"][0]["target"]
        source_activity = payload["targets"][0]["source_activity"]
        self.assertEqual(target["paper_route_probe_symbols"], ["AAPL", "AMZN", "INTC"])
        self.assertEqual(source_activity["symbols"], ["AAPL", "AMZN", "INTC"])
        self.assertFalse(source_activity["missing"])
        self.assertEqual(source_activity["decision_count"], 1)
        self.assertEqual(source_activity["execution_count"], 1)
        self.assertEqual(source_activity["filled_execution_count"], 1)
        self.assertEqual(source_activity["tca_sample_count"], 1)

    def test_external_target_plan_scope_is_preserved_in_next_window_audit(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": True,
                    "reason": "non_live_mode",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 0,
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.next-paper-route-runtime-window-targets.v1"
                        ),
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-external-scope",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "external-scope-strategy",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_route_target_plan_source": (
                                    "external_target_plan_url"
                                ),
                                "paper_route_probe_scope_authority": (
                                    "external_target_plan"
                                ),
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
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "63180",
                        "eligible_symbol_count": 3,
                        "eligible_symbols": ["AMZN", "AAPL", "INTC"],
                        "active_symbols": [],
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=window_start - timedelta(days=2),
            )

        probe = payload["paper_route_probe"]
        self.assertEqual(probe["eligible_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(probe["eligible_symbol_count"], 2)
        self.assertEqual(probe["raw_eligible_symbols"], ["AMZN", "AAPL", "INTC"])
        self.assertEqual(probe["out_of_scope_symbols"], ["INTC"])
        self.assertEqual(probe["missing_scope_symbols"], [])
        self.assertEqual(probe["target_plan_source"], "external_target_plan_url")
        self.assertTrue(probe["target_plan_scope_applied"])
        self.assertEqual(probe["target_plan_scope_symbols"], ["AAPL", "AMZN"])
        plan_probe = payload["next_paper_route_runtime_window_targets"][
            "paper_route_probe"
        ]
        self.assertEqual(plan_probe["symbols"], ["AAPL", "AMZN"])
        self.assertEqual(plan_probe["raw_symbols"], ["AMZN", "AAPL", "INTC"])
        self.assertEqual(plan_probe["out_of_scope_symbols"], ["INTC"])
        self.assertTrue(plan_probe["target_plan_scope_applied"])
        next_target = payload["next_paper_route_runtime_window_targets"]["targets"][0]
        self.assertEqual(next_target["paper_route_probe_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(
            next_target["paper_route_probe_scope_authority"],
            "external_target_plan",
        )
        next_audit_target = payload["next_runtime_window_target_audits"][0]["target"]
        self.assertEqual(
            next_audit_target["paper_route_probe_symbols"], ["AAPL", "AMZN"]
        )
        self.assertNotIn("INTC", next_audit_target["paper_route_probe_symbols"])

    def test_next_window_targets_are_scoped_to_strategy_universe(self) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="pairs runtime strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            session.commit()

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": True,
                    "reason": "non_live_mode",
                    "blocked_reasons": [],
                    "promotion_eligible_total": 0,
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.next-paper-route-runtime-window-targets.v1"
                        ),
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-hpairs",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "runtime_strategy_name": "candidate-runtime-name",
                                "strategy_lookup_names": [
                                    "candidate-runtime-name",
                                    "microbar-cross-sectional-pairs-v1",
                                ],
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": [
                                    "AAPL",
                                    "AMZN",
                                    "INTC",
                                    "NVDA",
                                ],
                                "paper_route_target_plan_source": (
                                    "external_target_plan_url"
                                ),
                                "paper_route_probe_scope_authority": (
                                    "external_target_plan"
                                ),
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
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "63180",
                        "eligible_symbol_count": 4,
                        "eligible_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
                        "active_symbols": [],
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=window_start - timedelta(days=2),
            )

        target = payload["next_paper_route_runtime_window_targets"]["targets"][0]
        self.assertEqual(target["paper_route_probe_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(
            target["paper_route_probe_raw_target_symbols"],
            ["AAPL", "AMZN", "INTC", "NVDA"],
        )
        self.assertTrue(target["paper_route_probe_strategy_scope_applied"])
        self.assertEqual(
            target["paper_route_probe_strategy_universe_symbols"],
            ["AAPL", "AMZN"],
        )
        self.assertEqual(
            target["paper_route_probe_out_of_strategy_scope_symbols"],
            ["INTC", "NVDA"],
        )
        self.assertEqual(
            target["paper_route_probe_missing_strategy_universe_symbols"], []
        )
        self.assertEqual(
            target["paper_route_probe_scope_authority"], "strategy_universe"
        )
        next_audit_target = payload["next_runtime_window_target_audits"][0]["target"]
        self.assertEqual(
            next_audit_target["paper_route_probe_symbols"], ["AAPL", "AMZN"]
        )
        self.assertNotIn("INTC", next_audit_target["paper_route_probe_symbols"])

    def test_external_target_plan_probe_reports_missing_scope_and_plan_error(
        self,
    ) -> None:
        probe = _paper_route_probe_summary(
            {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "eligible_symbols": ["AAPL"],
                    "active_symbols": ["AAPL"],
                    "blocking_reasons": ["market_session_closed"],
                },
            },
            target_plan={
                "targets": [
                    {
                        "paper_route_probe_symbols": " AAPL, AMZN ",
                    }
                ]
            },
            target_plan_source="external_target_plan_url",
            target_plan_error="external_target_plan_fetch_failed",
        )

        self.assertEqual(probe["eligible_symbols"], ["AAPL"])
        self.assertEqual(probe["target_plan_scope_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(probe["missing_scope_symbols"], ["AMZN"])
        self.assertIn("external_target_plan_fetch_failed", probe["blocking_reasons"])
        self.assertIn("external_target_plan_symbols_missing", probe["blocking_reasons"])

    def test_external_target_plan_probe_fail_closes_without_scope_symbols(
        self,
    ) -> None:
        probe = _paper_route_probe_summary(
            {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "paper_route_probe": {
                    "configured_enabled": True,
                    "active": False,
                    "eligible_symbols": ["AAPL", "AMZN"],
                    "active_symbols": ["AAPL"],
                    "blocking_reasons": [],
                },
            },
            target_plan={"targets": [{"paper_route_probe_symbols": []}]},
            target_plan_source="external_target_plan_url",
        )

        self.assertEqual(probe["eligible_symbols"], [])
        self.assertEqual(probe["active_symbols"], [])
        self.assertEqual(probe["out_of_scope_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(
            probe["blocking_reasons"], ["external_target_plan_probe_symbols_missing"]
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
                                "source_manifest_ref": "config/trading/hypotheses/h-scoped-source.json",
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
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, tzinfo=timezone.utc)
        strategy_name = "active-paper-route"
        target_strategy_name = "69cf50e3-4815-47c2-b802-1efbaac09ecb"
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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "2",
                    "candidate_id": "candidate-active-route",
                    "hypothesis_id": "H-ACTIVE-ROUTE",
                },
                rationale="paper route fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=10),
                executed_at=window_start + timedelta(minutes=11),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
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
                        alpaca_account_label="TORGHUT_SIM",
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
                        bucket_ended_at=window_end,
                        account_label="TORGHUT_SIM",
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
                    StrategyRuntimeLedgerBucket(
                        run_id="paper-route-run-2",
                        candidate_id="candidate-active-route",
                        hypothesis_id="H-ACTIVE-ROUTE",
                        observed_stage="paper",
                        bucket_started_at=window_start,
                        bucket_ended_at=window_end,
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name=strategy_name,
                        strategy_family="microbar_pairs",
                        fill_count=50,
                        decision_count=25,
                        submitted_order_count=25,
                        closed_trade_count=1,
                        open_position_count=1,
                        filled_notional=Decimal("1000000"),
                        gross_strategy_pnl=Decimal("110000"),
                        cost_amount=Decimal("10000"),
                        net_strategy_pnl_after_costs=Decimal("100000"),
                        post_cost_expectancy_bps=None,
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy-a": 25},
                        cost_model_hash_counts={"cost-a": 25},
                        lineage_hash_counts={"lineage-a": 25},
                        blockers_json=["open_position_count_nonzero"],
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
                    RejectedSignalOutcomeEvent(
                        event_id="paper-route-reject-filled-aapl",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="TORGHUT_SIM",
                        symbol="AAPL",
                        event_ts=window_start + timedelta(minutes=14),
                        timeframe="1Sec",
                        seq="reject-after-fill",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=[
                            "counterfactual_return",
                            "route_tca",
                            "post_cost_net_pnl",
                            "executable_quote",
                        ],
                        event_payload_json={
                            "event_id": "paper-route-reject-filled-aapl"
                        },
                    ),
                ]
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
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
                                "strategy_name": target_strategy_name,
                                "strategy_id": "active_paper_route@research",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-active-route.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
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
        self.assertEqual(audit["target"]["strategy_name"], target_strategy_name)
        self.assertIn(strategy_name, audit["target"]["strategy_lookup_names"])
        self.assertFalse(audit["source_activity"]["missing"])
        self.assertEqual(audit["source_activity"]["decision_count"], 1)
        self.assertEqual(audit["source_activity"]["execution_count"], 1)
        self.assertEqual(audit["source_activity"]["filled_execution_count"], 1)
        self.assertEqual(audit["source_activity"]["tca_sample_count"], 1)
        self.assertEqual(audit["rejected_signal_activity"]["event_count"], 1)
        self.assertEqual(
            audit["rejected_signal_activity"]["blocking_reasons"],
            [
                "source_signal_rejected_by_quote_quality",
                "source_reject_missing_executable_quote",
            ],
        )
        self.assertEqual(audit["runtime_ledger"]["bucket_count"], 2)
        self.assertEqual(audit["runtime_ledger"]["evidence_grade_bucket_count"], 1)
        self.assertEqual(audit["runtime_ledger"]["non_evidence_grade_bucket_count"], 1)
        self.assertEqual(
            audit["runtime_ledger"]["non_evidence_grade_diagnostic"]["scope"],
            "non_evidence_grade_runtime_ledger_buckets_diagnostic_only_not_promotion_proof",
        )
        self.assertEqual(
            audit["runtime_ledger"]["non_evidence_grade_diagnostic"][
                "diagnostic_bucket_count"
            ],
            1,
        )
        self.assertEqual(
            audit["runtime_ledger"]["non_evidence_grade_diagnostic"][
                "net_strategy_pnl_after_costs"
            ],
            "100000",
        )
        self.assertEqual(
            audit["runtime_ledger"]["non_evidence_grade_diagnostic"][
                "diagnostic_closed_trade_expectancy_bps"
            ],
            "1000",
        )
        self.assertEqual(
            audit["runtime_ledger"]["non_evidence_grade_diagnostic"]["blocker_counts"],
            {"open_position_count_nonzero": 1},
        )
        self.assertEqual(
            audit["runtime_ledger"]["proof_scope"],
            "evidence_grade_runtime_ledger_buckets_only",
        )
        self.assertEqual(audit["runtime_ledger"]["filled_notional"], "200")
        self.assertEqual(audit["runtime_ledger"]["net_strategy_pnl_after_costs"], "10")
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
        self.assertEqual(
            payload["summary"]["target_with_evidence_grade_runtime_ledger_count"], 1
        )
        self.assertEqual(payload["summary"]["target_with_promotion_decision_count"], 1)
        self.assertEqual(payload["summary"]["promotion_allowed_count"], 0)
        self.assertEqual(payload["summary"]["final_promotion_allowed_count"], 0)
        self.assertEqual(payload["summary"]["source_promotion_allowed_count"], 1)
        self.assertEqual(payload["summary"]["source_final_promotion_allowed_count"], 1)
        self.assertEqual(
            payload["summary"]["promotion_authority"]["reason"],
            "paper_route_evidence_audit_observability_only",
        )
        self.assertEqual(
            payload["summary"]["runtime_window_import_audit_state"],
            "runtime_ledger_ready_for_gate_review",
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "runtime_ledger_ready_for_gate_review")
        self.assertEqual(
            import_audit["next_action"], "review_runtime_ledger_profit_gates"
        )
        self.assertTrue(import_audit["import_ready"])
        self.assertEqual(import_audit["blockers"], [])
        self.assertEqual(
            import_audit["diagnostics"]["rejected_signal_diagnostic_reasons"], []
        )
        self.assertEqual(len(import_audit["target_blockers"]), 1)
        self.assertEqual(
            import_audit["target_blockers"][0]["blockers"],
            ["open_position_count_nonzero"],
        )
        self.assertEqual(import_audit["counts"]["source_plan_target_count"], 1)
        self.assertEqual(import_audit["counts"]["selected_target_count"], 1)
        self.assertEqual(import_audit["counts"]["targets_with_source_activity"], 1)
        self.assertEqual(import_audit["counts"]["targets_with_runtime_ledger"], 1)
        self.assertEqual(
            import_audit["counts"]["targets_with_evidence_grade_runtime_ledger"], 1
        )
        self.assertFalse(import_audit["promotion_authority"]["allowed"])

    def test_account_contamination_blocks_runtime_window_import(self) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, 5, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            strategy = Strategy(
                name="contamination-proof-strategy",
                description="paper account contamination fixture",
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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "sell",
                    "qty": "1",
                    "candidate_id": "candidate-contamination",
                    "hypothesis_id": "H-CONTAMINATION",
                },
                rationale="paper route contamination fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=10),
                executed_at=window_start + timedelta(minutes=11),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="torghut-linked-order",
                client_order_id="torghut-linked-client",
                symbol="AAPL",
                side="sell",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
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
                        alpaca_account_label="TORGHUT_SIM",
                        symbol="AAPL",
                        side="sell",
                        arrival_price=Decimal("101"),
                        avg_fill_price=Decimal("100"),
                        filled_qty=Decimal("1"),
                        signed_qty=Decimal("-1"),
                        slippage_bps=Decimal("5"),
                        shortfall_notional=Decimal("1"),
                        realized_shortfall_bps=Decimal("5"),
                        churn_qty=Decimal("0"),
                        churn_ratio=Decimal("0"),
                        computed_at=window_start + timedelta(minutes=13),
                        created_at=window_start + timedelta(minutes=13),
                        updated_at=window_start + timedelta(minutes=13),
                    ),
                    StrategyPromotionDecision(
                        run_id="paper-route-contamination-run",
                        candidate_id="candidate-contamination",
                        hypothesis_id="H-CONTAMINATION",
                        promotion_target="paper",
                        state="allowed",
                        allowed=True,
                        reason_summary="paper_evidence_collecting",
                        created_at=now,
                        updated_at=now,
                    ),
                    ExecutionOrderEvent(
                        event_fingerprint="external-autonomous-trader-order-event",
                        source_topic="alpaca.trade_updates",
                        source_partition=0,
                        source_offset=42,
                        alpaca_account_label="TORGHUT_SIM",
                        event_ts=window_start + timedelta(minutes=20),
                        symbol="AAPL",
                        alpaca_order_id="external-order-1",
                        client_order_id="autonomous-trader-AAPL-cover-external-1",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("101"),
                        raw_event={"source": "external_autonomous_trader"},
                        execution_id=None,
                        trade_decision_id=None,
                    ),
                ]
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            session.commit()

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": "1",
                        "targets": [
                            {
                                "hypothesis_id": "H-CONTAMINATION",
                                "candidate_id": "candidate-contamination",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "contamination-proof-strategy",
                                "strategy_id": "contamination_proof_strategy@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-contamination.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
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

        audit = payload["next_runtime_window_target_audits"][0]
        contamination = audit["account_contamination"]
        self.assertTrue(contamination["contaminated"])
        self.assertEqual(contamination["unlinked_order_event_count"], 1)
        self.assertEqual(
            contamination["sample_client_order_ids"],
            ["autonomous-trader-AAPL-cover-external-1"],
        )
        self.assertIn(
            "paper_route_account_contamination_detected",
            audit["readiness"]["blockers"],
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(
            import_audit["state"], "import_due_account_contamination_detected"
        )
        self.assertEqual(
            import_audit["next_action"],
            "isolate_paper_account_or_discard_contaminated_window",
        )
        self.assertIn("unlinked_order_events_present", import_audit["blockers"])
        self.assertEqual(
            import_audit["target_blockers"][0]["account_contamination"][
                "client_order_id_count"
            ],
            1,
        )

    def test_account_window_start_positions_block_runtime_window_import(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, 5, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            strategy = Strategy(
                name="account-state-proof-strategy",
                description="paper account state fixture",
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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "sell",
                    "qty": "1",
                    "candidate_id": "candidate-account-state",
                    "hypothesis_id": "H-ACCOUNT-STATE",
                },
                rationale="paper route account state fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=10),
                executed_at=window_start + timedelta(minutes=11),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="torghut-account-state-order",
                client_order_id="torghut-account-state-client",
                symbol="AAPL",
                side="sell",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
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
                    PositionSnapshot(
                        alpaca_account_label="TORGHUT_SIM",
                        as_of=window_start - timedelta(seconds=30),
                        equity=Decimal("100000"),
                        cash=Decimal("99500"),
                        buying_power=Decimal("199000"),
                        positions=[
                            {
                                "symbol": "AMAT",
                                "qty": "0.5",
                                "side": "long",
                                "market_value": "250",
                            },
                            {
                                "symbol": "AAPL",
                                "qty": "1",
                                "side": "long",
                                "market_value": "200",
                            },
                        ],
                    ),
                    ExecutionTCAMetric(
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        strategy_id=strategy.id,
                        alpaca_account_label="TORGHUT_SIM",
                        symbol="AAPL",
                        side="sell",
                        arrival_price=Decimal("101"),
                        avg_fill_price=Decimal("100"),
                        filled_qty=Decimal("1"),
                        signed_qty=Decimal("-1"),
                        slippage_bps=Decimal("5"),
                        shortfall_notional=Decimal("1"),
                        realized_shortfall_bps=Decimal("5"),
                        churn_qty=Decimal("0"),
                        churn_ratio=Decimal("0"),
                        computed_at=window_start + timedelta(minutes=13),
                        created_at=window_start + timedelta(minutes=13),
                        updated_at=window_start + timedelta(minutes=13),
                    ),
                    StrategyPromotionDecision(
                        run_id="paper-route-account-state-run",
                        candidate_id="candidate-account-state",
                        hypothesis_id="H-ACCOUNT-STATE",
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
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": "1",
                        "targets": [
                            {
                                "hypothesis_id": "H-ACCOUNT-STATE",
                                "candidate_id": "candidate-account-state",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "account-state-proof-strategy",
                                "strategy_id": "account_state_proof_strategy@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-account-state.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
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

        audit = payload["next_runtime_window_target_audits"][0]
        account_state = audit["account_state"]
        self.assertFalse(account_state["flat"])
        self.assertEqual(account_state["position_count"], 2)
        self.assertEqual(account_state["target_symbol_position_count"], 1)
        self.assertEqual(account_state["non_target_symbol_position_count"], 1)
        self.assertEqual(account_state["gross_position_market_value"], "450")
        self.assertIn(
            "paper_route_account_window_start_not_flat",
            audit["readiness"]["blockers"],
        )
        self.assertIn(
            "paper_route_account_window_start_non_target_positions_present",
            audit["readiness"]["blockers"],
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "import_due_account_state_not_clean")
        self.assertEqual(
            import_audit["next_action"],
            "reset_paper_account_or_discard_contaminated_window",
        )
        self.assertIn(
            "paper_route_account_window_start_positions_present",
            import_audit["blockers"],
        )
        self.assertEqual(
            import_audit["target_blockers"][0]["account_state"]["position_count"],
            2,
        )

    def test_paper_route_source_activity_requires_candidate_lineage(self) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="base strategy source activity",
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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"action": "sell", "qty": "1"},
                rationale="unscoped base-strategy source activity",
                status="executed",
                created_at=window_start + timedelta(minutes=10),
                executed_at=window_start + timedelta(minutes=11),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="unscoped-paper-route-order",
                client_order_id="unscoped-paper-route-client",
                symbol="AAPL",
                side="sell",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                status="filled",
                raw_order={},
                created_at=window_start + timedelta(minutes=12),
                updated_at=window_start + timedelta(minutes=12),
                last_update_at=window_start + timedelta(minutes=12),
            )
            session.add(execution)
            session.flush()
            session.add(
                ExecutionTCAMetric(
                    execution_id=execution.id,
                    trade_decision_id=decision.id,
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AAPL",
                    side="sell",
                    arrival_price=Decimal("101"),
                    avg_fill_price=Decimal("100"),
                    filled_qty=Decimal("1"),
                    signed_qty=Decimal("-1"),
                    slippage_bps=Decimal("5"),
                    shortfall_notional=Decimal("1"),
                    realized_shortfall_bps=Decimal("5"),
                    churn_qty=Decimal("0"),
                    churn_ratio=Decimal("0"),
                    computed_at=window_start + timedelta(minutes=13),
                    created_at=window_start + timedelta(minutes=13),
                    updated_at=window_start + timedelta(minutes=13),
                )
            )
            session.commit()

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": "1",
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-pairs-a",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
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
            decision.decision_json = {
                "action": "sell",
                "qty": "1",
                "params": {
                    "paper_route_probe": {
                        "source_candidate_ids": ["candidate-pairs-a"],
                        "source_hypothesis_ids": ["H-PAIRS-01"],
                    }
                },
            }
            session.add(decision)
            session.commit()
            matched_payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": "1",
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-pairs-a",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
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

        source_activity = payload["targets"][0]["source_activity"]
        self.assertTrue(source_activity["lineage_required"])
        self.assertEqual(source_activity["raw_decision_count"], 1)
        self.assertEqual(source_activity["decision_count"], 0)
        self.assertEqual(source_activity["execution_count"], 0)
        self.assertEqual(source_activity["tca_sample_count"], 0)
        self.assertEqual(
            source_activity["lineage_blockers"],
            ["source_candidate_lineage_missing", "source_hypothesis_lineage_missing"],
        )
        self.assertIn(
            "source_candidate_lineage_missing",
            payload["targets"][0]["readiness"]["evidence_collection_blockers"],
        )
        self.assertIn(
            "source_hypothesis_lineage_missing",
            payload["targets"][0]["readiness"]["evidence_collection_blockers"],
        )
        self.assertEqual(payload["summary"]["target_with_source_activity_count"], 0)
        matched_source_activity = matched_payload["targets"][0]["source_activity"]
        self.assertEqual(matched_source_activity["raw_decision_count"], 1)
        self.assertEqual(matched_source_activity["lineage_matched_decision_count"], 1)
        self.assertEqual(matched_source_activity["decision_count"], 1)
        self.assertEqual(matched_source_activity["execution_count"], 1)
        self.assertEqual(matched_source_activity["tca_sample_count"], 1)
        self.assertFalse(matched_source_activity["missing"])
        self.assertEqual(
            matched_payload["summary"]["target_with_source_activity_count"], 1
        )

    def test_next_runtime_window_targets_dedupe_same_execution_source(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="canonical executable H-PAIRS source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                    created_at=window_start,
                    updated_at=window_start,
                )
            )
            session.commit()

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": "2",
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-pairs-a",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                "runtime_strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                                "strategy_lookup_names": [
                                    "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                                    "microbar-cross-sectional-pairs-v1",
                                ],
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                            },
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-pairs-b",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "09fabf57-71ec-44c9-af1a-4d2df98e7d83",
                                "runtime_strategy_name": "09fabf57-71ec-44c9-af1a-4d2df98e7d83",
                                "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                                "strategy_lookup_names": [
                                    "09fabf57-71ec-44c9-af1a-4d2df98e7d83",
                                    "microbar-cross-sectional-pairs-v1",
                                ],
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                            },
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["AAPL", "AMZN"],
                        "paper_route_probe_active_symbols": ["AAPL", "AMZN"],
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

        next_targets = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(next_targets["target_count"], 1)
        self.assertEqual(next_targets["skipped_target_count"], 1)
        self.assertEqual(
            next_targets["targets"][0]["candidate_id"], "candidate-pairs-a"
        )
        self.assertEqual(
            next_targets["targets"][0]["paper_route_execution_source_key"]["strategy"],
            "microbar-cross-sectional-pairs-v1",
        )
        self.assertEqual(
            next_targets["skipped_targets"][0]["reason"],
            "duplicate_next_paper_route_runtime_window_execution_source",
        )
        self.assertEqual(
            next_targets["skipped_targets"][0]["duplicate_of_candidate_id"],
            "candidate-pairs-a",
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["counts"]["selected_target_count"], 1)
        self.assertEqual(import_audit["counts"]["next_runtime_window_target_count"], 1)

    def test_runtime_import_audit_counts_selected_targets_not_raw_plan_noise(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, tzinfo=timezone.utc)
        strategy_name = "selected-paper-route"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="selected paper route source activity",
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
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "2",
                    "candidate_id": "candidate-selected-route",
                    "hypothesis_id": "H-SELECTED-ROUTE",
                },
                rationale="selected paper route fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=10),
                executed_at=window_start + timedelta(minutes=11),
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="selected-paper-route-order-1",
                client_order_id="selected-paper-route-client-1",
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
                        alpaca_account_label="TORGHUT_SIM",
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
                        run_id="selected-paper-route-run",
                        candidate_id="candidate-selected-route",
                        hypothesis_id="H-SELECTED-ROUTE",
                        observed_stage="paper",
                        bucket_started_at=window_start,
                        bucket_ended_at=window_end,
                        account_label="TORGHUT_SIM",
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
                ]
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
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
                        "target_count": "3",
                        "targets": [
                            {
                                "hypothesis_id": "H-SELECTED-ROUTE",
                                "candidate_id": "candidate-selected-route",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-selected-route.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                            },
                            {
                                "hypothesis_id": "H-SKIPPED-A",
                                "candidate_id": "candidate-skipped-a",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "skipped-no-manifest-a",
                                "account_label": "paper",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                            },
                            {
                                "hypothesis_id": "H-SKIPPED-B",
                                "candidate_id": "candidate-skipped-b",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "skipped-no-manifest-b",
                                "account_label": "paper",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                            },
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

        next_targets = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(next_targets["target_count"], 1)
        self.assertEqual(next_targets["skipped_target_count"], 2)
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "runtime_ledger_ready_for_gate_review")
        self.assertEqual(import_audit["blockers"], [])
        self.assertEqual(import_audit["counts"]["source_plan_target_count"], 3)
        self.assertEqual(import_audit["counts"]["selected_target_count"], 1)
        self.assertEqual(import_audit["counts"]["next_runtime_window_target_count"], 1)
        self.assertEqual(import_audit["counts"]["targets_with_source_activity"], 1)
        self.assertEqual(import_audit["counts"]["targets_with_runtime_ledger"], 1)
        self.assertEqual(
            import_audit["counts"]["targets_with_evidence_grade_runtime_ledger"],
            1,
        )
        self.assertEqual(
            import_audit["counts"]["raw_source_plan_targets_with_source_activity"],
            1,
        )
        self.assertEqual(
            import_audit["counts"]["raw_source_plan_targets_with_runtime_ledger"],
            1,
        )
        next_window_audits = payload["next_runtime_window_target_audits"]
        self.assertEqual(len(next_window_audits), 1)
        self.assertEqual(
            next_window_audits[0]["target"]["account_label"], "TORGHUT_SIM"
        )

    def test_runtime_import_audit_does_not_count_historical_ledger_as_next_window(
        self,
    ) -> None:
        historical_start = datetime(2026, 5, 21, 17, tzinfo=timezone.utc)
        historical_end = datetime(2026, 5, 21, 17, 30, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, tzinfo=timezone.utc)
        next_window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        strategy_name = "historical-paper-route"
        with Session(self.engine) as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="historical-paper-route-run",
                    candidate_id="candidate-historical-route",
                    hypothesis_id="H-HISTORICAL-ROUTE",
                    observed_stage="paper",
                    bucket_started_at=historical_start,
                    bucket_ended_at=historical_end,
                    account_label="TORGHUT_REPLAY",
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
                )
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_REPLAY",
                window_start=historical_start,
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=next_window_start,
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
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-HISTORICAL-ROUTE",
                                "candidate_id": "candidate-historical-route",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "TORGHUT_REPLAY",
                                "source_manifest_ref": "config/trading/hypotheses/h-historical-route.json",
                                "window_start": historical_start.isoformat(),
                                "window_end": historical_end.isoformat(),
                                "paper_probation_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
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

        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "import_due_source_activity_missing")
        self.assertEqual(import_audit["counts"]["selected_target_count"], 1)
        self.assertEqual(import_audit["counts"]["targets_with_source_activity"], 0)
        self.assertEqual(import_audit["counts"]["targets_with_runtime_ledger"], 0)
        self.assertEqual(
            import_audit["counts"]["targets_with_evidence_grade_runtime_ledger"],
            0,
        )
        self.assertEqual(
            import_audit["counts"]["raw_source_plan_targets_with_runtime_ledger"],
            1,
        )
        self.assertEqual(
            import_audit["blockers"],
            [
                "paper_route_source_activity_missing",
                "source_decisions_missing",
                "source_executions_missing",
                "source_tca_missing",
            ],
        )
        next_window_audit = payload["next_runtime_window_target_audits"][0]
        self.assertEqual(next_window_audit["target"]["account_label"], "TORGHUT_SIM")
        self.assertEqual(next_window_audit["runtime_ledger"]["bucket_count"], 0)

    def test_runtime_ledger_summary_is_scoped_to_target_stage_account_and_strategy(
        self,
    ) -> None:
        now = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        window_start = now - timedelta(hours=6)
        strategy_name = "paper-route-scoped-ledger"
        with Session(self.engine) as session:
            for suffix, observed_stage, account_label, runtime_strategy_name in (
                ("wrong-stage", "live", "paper", strategy_name),
                ("wrong-account", "paper", "other-paper", strategy_name),
                ("wrong-strategy", "paper", "paper", "different-paper-route"),
            ):
                session.add(
                    StrategyRuntimeLedgerBucket(
                        run_id=f"paper-route-{suffix}",
                        candidate_id="candidate-scoped-ledger",
                        hypothesis_id="H-SCOPED-LEDGER",
                        observed_stage=observed_stage,
                        bucket_started_at=window_start,
                        bucket_ended_at=now,
                        account_label=account_label,
                        runtime_strategy_name=runtime_strategy_name,
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
                                "hypothesis_id": "H-SCOPED-LEDGER",
                                "candidate_id": "candidate-scoped-ledger",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "paper",
                                "window_start": window_start.isoformat(),
                                "window_end": now.isoformat(),
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
                generated_at=now,
            )

        runtime_ledger = payload["targets"][0]["runtime_ledger"]
        self.assertEqual(
            runtime_ledger["filters"],
            {
                "hypothesis_id": "H-SCOPED-LEDGER",
                "candidate_id": "candidate-scoped-ledger",
                "observed_stage": "paper",
                "account_label": "paper",
                "strategy_name": strategy_name,
                "strategy_lookup_names": [strategy_name],
                "strategy_family": "microbar_pairs",
            },
        )
        self.assertEqual(runtime_ledger["bucket_count"], 0)
        self.assertEqual(runtime_ledger["evidence_grade_bucket_count"], 0)
        self.assertIn(
            "runtime_ledger_bucket_missing",
            payload["targets"][0]["readiness"]["evidence_collection_blockers"],
        )
        self.assertIn(
            "runtime_ledger_evidence_grade_bucket_missing",
            payload["targets"][0]["readiness"]["evidence_collection_blockers"],
        )
