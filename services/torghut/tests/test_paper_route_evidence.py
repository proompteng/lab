from __future__ import annotations

import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import app.trading.paper_route_evidence as paper_route_evidence
from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    OrderFeedSourceWindow,
    PositionSnapshot,
    RejectedSignalOutcomeEvent,
    Strategy,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from app.trading.paper_route_evidence import (
    PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT,
    PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT,
    RUNTIME_LEDGER_PROOF_PACKET_HANDOFF_SCHEMA_VERSION,
    _account_contamination_reason,
    _account_pre_session_snapshot_audit,
    _account_window_start_snapshot_audit,
    _balanced_pair_probe_symbol_actions,
    _hpairs_round_trip_identity_blockers,
    _hpairs_zero_activity_reason_flags,
    _hpairs_zero_activity_state,
    _next_regular_equities_session_window,
    _normalized_open_positions,
    _order_event_source_offset_refs,
    _paper_route_probe_summary,
    _paper_route_probe_symbol_quantities,
    _pair_probe_balance_state,
    _runtime_ledger_bucket_evidence_grade,
    _runtime_ledger_non_evidence_diagnostic_summary,
    _runtime_ledger_row_diagnostic_expectancy_bps,
    _source_activity_stage_diagnostics,
    _strategy_source_activity,
    _strategy_source_decision_readiness,
    _target_audit_fail_closed,
    build_paper_route_evidence_audit,
    build_paper_route_target_plan_payload,
)
from app.trading.paper_route_target_plan import (
    materialize_bounded_paper_route_target_plan,
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

    def test_order_event_source_offset_refs_skip_deduplicate_and_limit(self) -> None:
        rows = [
            SimpleNamespace(source_topic=None, source_partition=0, source_offset=1),
            SimpleNamespace(
                source_topic="trade_updates",
                source_partition=0,
                source_offset=1,
            ),
            SimpleNamespace(
                source_topic="trade_updates",
                source_partition=0,
                source_offset=1,
            ),
        ]
        rows.extend(
            SimpleNamespace(
                source_topic="trade_updates",
                source_partition=0,
                source_offset=offset,
            )
            for offset in range(2, PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT + 4)
        )

        refs = _order_event_source_offset_refs(rows)

        self.assertEqual(len(refs), PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT)
        self.assertEqual(
            refs[0],
            {"topic": "trade_updates", "partition": 0, "offset": 1},
        )
        self.assertEqual(
            refs[-1],
            {
                "topic": "trade_updates",
                "partition": 0,
                "offset": PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT,
            },
        )

    def test_source_activity_reports_source_window_query_unavailable(self) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        event_at = window_start + timedelta(minutes=15)
        with Session(self.engine) as session:
            strategy = Strategy(
                name="source-window-query-unavailable",
                enabled=True,
                base_timeframe="1m",
                universe_type="static",
                universe_symbols=["AAPL"],
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
                    "candidate_id": "candidate-source-window-unavailable",
                    "hypothesis_id": "H-ORDER-FEED",
                },
                rationale="source window unavailable fixture",
                status="executed",
                created_at=event_at,
                executed_at=event_at,
            )
            session.add(decision)
            session.flush()
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="source-window-unavailable-event",
                    source_topic="trade_updates",
                    source_partition=0,
                    source_offset=42,
                    alpaca_account_label="TORGHUT_SIM",
                    event_ts=event_at,
                    symbol="AAPL",
                    alpaca_order_id="source-window-unavailable-order",
                    client_order_id="source-window-unavailable-client",
                    event_type="fill",
                    status="filled",
                    raw_event={},
                    trade_decision_id=decision.id,
                    source_window_id="00000000-0000-0000-0000-000000000999",
                    created_at=event_at,
                )
            )
            session.commit()
            original_execute = session.execute

            def execute_with_source_window_failure(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                if "order_feed_source_windows" in str(statement):
                    raise SQLAlchemyError("source window table unavailable")
                return original_execute(statement, *args, **kwargs)

            with patch.object(session, "execute", execute_with_source_window_failure):
                source_activity = _strategy_source_activity(
                    session,
                    strategy_name="source-window-query-unavailable",
                    account_label="TORGHUT_SIM",
                    symbols=["AAPL"],
                    window_start=window_start,
                    window_end=window_start + timedelta(hours=1),
                    candidate_id="candidate-source-window-unavailable",
                    hypothesis_id="H-ORDER-FEED",
                    require_source_lineage=True,
                )

        self.assertTrue(source_activity["missing"])
        self.assertEqual(
            source_activity["missing_reasons"],
            ["source_windows_unavailable"],
        )
        self.assertEqual(source_activity["raw_decision_count"], 1)
        self.assertEqual(source_activity["lineage_matched_decision_count"], 1)

    def test_hpairs_source_activity_surfaces_unfilled_closeout_fillability(
        self,
    ) -> None:
        window_start = datetime(2026, 6, 2, 13, 30, tzinfo=timezone.utc)
        event_at = window_start + timedelta(minutes=10)
        exit_due_at = window_start + timedelta(minutes=60)
        candidate_id = "c88421d619759b2cfaa6f4d0"
        with Session(self.engine) as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add(strategy)
            session.flush()
            entry_decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": candidate_id,
                    "hypothesis_id": "H-PAIRS-01",
                    "params": {
                        "source_candidate_ids": [candidate_id],
                        "source_hypothesis_ids": ["H-PAIRS-01"],
                    },
                },
                rationale="H-PAIRS entry with unfilled closeout fixture",
                status="executed",
                created_at=event_at,
                executed_at=event_at,
            )
            session.add(entry_decision)
            session.flush()
            session.add(
                Execution(
                    trade_decision_id=entry_decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="hpairs-fillability-entry",
                    client_order_id="hpairs-fillability-entry",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    status="filled",
                    raw_order={},
                    created_at=event_at,
                    updated_at=event_at,
                    last_update_at=event_at,
                )
            )
            closeout_decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={
                    "action": "sell",
                    "qty": "1",
                    "candidate_id": candidate_id,
                    "hypothesis_id": "H-PAIRS-01",
                    "params": {
                        "source_candidate_ids": [candidate_id],
                        "source_hypothesis_ids": ["H-PAIRS-01"],
                        "paper_route_probe_exit": {
                            "mode": "paper_route_exit",
                            "exit_due_at": exit_due_at.isoformat(),
                        },
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    },
                },
                rationale="H-PAIRS unfilled closeout fixture",
                status="submitted",
                created_at=exit_due_at,
            )
            session.add(closeout_decision)
            session.flush()
            closeout_ref = str(closeout_decision.id)
            session.add(
                Execution(
                    trade_decision_id=closeout_decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="hpairs-fillability-exit",
                    client_order_id="hpairs-fillability-exit",
                    symbol="AAPL",
                    side="sell",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("0"),
                    avg_fill_price=Decimal("0"),
                    status="submitted",
                    raw_order={},
                    created_at=exit_due_at,
                    updated_at=exit_due_at,
                    last_update_at=exit_due_at,
                )
            )
            session.commit()

            source_activity = _strategy_source_activity(
                session,
                strategy_name="microbar-cross-sectional-pairs-v1",
                account_label="TORGHUT_SIM",
                symbols=["AAPL", "AMZN"],
                window_start=window_start,
                window_end=window_start + timedelta(hours=6, minutes=30),
                candidate_id=candidate_id,
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )

        closeout_fillability = source_activity["closeout_fillability"]
        self.assertEqual(closeout_fillability["closeout_decision_count"], 1)
        self.assertEqual(closeout_fillability["closeout_filled_execution_count"], 0)
        self.assertEqual(closeout_fillability["closeout_decision_refs"], [closeout_ref])
        self.assertIn(
            "source_closeout_fillability_missing",
            closeout_fillability["blockers"],
        )
        self.assertIn(
            "source_closeout_fillability_missing",
            source_activity["source_lifecycle_blockers"],
        )
        self.assertIn(
            "source_closed_round_trip_missing",
            source_activity["source_lifecycle_blockers"],
        )

    def _seed_hpairs_strategy_and_flat_snapshot(
        self,
        session: Session,
        *,
        window_start: datetime,
    ) -> None:
        session.add(
            Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1m",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("25"),
            )
        )
        session.add(
            PositionSnapshot(
                alpaca_account_label="TORGHUT_SIM",
                as_of=window_start,
                equity=Decimal("100000"),
                cash=Decimal("100000"),
                buying_power=Decimal("100000"),
                positions=[],
            )
        )
        session.commit()

    def _hpairs_live_submission_gate(
        self,
        *,
        candidate_blockers: list[str],
        continuity_ok: bool,
        continuity_reason: str,
        drift_ok: bool,
        drift_reason: str,
        paper_probation_satisfied: bool = True,
        source_collection_authorized: bool = False,
        source_collection_reason_codes: list[str] | None = None,
    ) -> dict[str, object]:
        return {
            "allowed": False,
            "reason": "paper_route_probe_only",
            "blocked_reasons": [],
            "promotion_eligible_total": 0,
            "dependency_quorum_decision": "allow",
            "continuity_ok": continuity_ok,
            "continuity_reason": continuity_reason,
            "drift_ok": drift_ok,
            "drift_reason": drift_reason,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "observed_stage": "paper",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                        "strategy_lookup_names": [
                            "microbar-cross-sectional-pairs-v1",
                        ],
                        "account_label": "TORGHUT_SIM",
                        "source_account_label": "TORGHUT_SIM",
                        "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                        "source_kind": "paper_route_probe_runtime_observed",
                        "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        "paper_probation_satisfied_for_bounded_live_paper_collection": paper_probation_satisfied,
                        "source_collection_authorized": source_collection_authorized,
                        "source_collection_authorization_scope": (
                            "bounded_paper_route_source_decision_collection_only"
                            if source_collection_authorized
                            else ""
                        ),
                        "source_collection_reason_codes": (
                            source_collection_reason_codes or []
                        ),
                        "evidence_collection_ok": True,
                        "promotion_allowed": False,
                        "final_promotion_authorized": False,
                        "final_promotion_allowed": False,
                        "candidate_blockers": candidate_blockers,
                        "runtime_ledger_target_metadata_blockers": candidate_blockers,
                    }
                ],
            },
        }

    def _hpairs_route_reacquisition_book(
        self,
        *,
        blocking_reasons: list[str] | None = None,
    ) -> dict[str, object]:
        return {
            "schema_version": "torghut.route-reacquisition-book.v1",
            "state": "repair_only",
            "summary": {
                "paper_route_probe_eligible_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_active_symbols": ["AAPL", "AMZN"],
            },
            "paper_route_probe": {
                "configured_enabled": True,
                "active": True,
                "effective_max_notional": "25",
                "next_session_max_notional": "25",
                "eligible_symbol_count": 2,
                "blocking_reasons": blocking_reasons or [],
            },
        }

    def test_hpairs_fresh_collection_clears_stale_drift_and_signal_blockers(
        self,
    ) -> None:
        generated_at = datetime(2026, 6, 2, 15, tzinfo=timezone.utc)
        window_start, _window_end = _next_regular_equities_session_window(generated_at)
        with Session(self.engine) as session:
            self._seed_hpairs_strategy_and_flat_snapshot(
                session,
                window_start=window_start,
            )

            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate=self._hpairs_live_submission_gate(
                    candidate_blockers=[
                        "drift_checks_missing",
                        "signal_lag_exceeded",
                        "paper_route_runtime_ledger_import_pending",
                    ],
                    continuity_ok=True,
                    continuity_reason="signals_present",
                    drift_ok=True,
                    drift_reason="drift_checks_recent",
                ),
                route_reacquisition_book=self._hpairs_route_reacquisition_book(),
                generated_at=generated_at,
                include_runtime_window_import_audit=False,
            )

        target = payload["targets"][0]
        self.assertTrue(target["evidence_collection_ok"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertNotIn("drift_checks_missing", target["candidate_blockers"])
        self.assertNotIn("signal_lag_exceeded", target["candidate_blockers"])
        self.assertIn(
            "paper_route_runtime_ledger_import_pending",
            target["candidate_blockers"],
        )
        self.assertEqual(
            target["stale_collection_blockers_cleared_by_current_inputs"],
            ["drift_checks_missing", "signal_lag_exceeded"],
        )

    def test_hpairs_source_collection_does_not_require_existing_paper_probation(
        self,
    ) -> None:
        generated_at = datetime(2026, 6, 2, 15, tzinfo=timezone.utc)
        window_start, _window_end = _next_regular_equities_session_window(generated_at)
        with Session(self.engine) as session:
            self._seed_hpairs_strategy_and_flat_snapshot(
                session,
                window_start=window_start,
            )

            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate=self._hpairs_live_submission_gate(
                    candidate_blockers=[
                        "runtime_ledger_source_decisions_missing",
                        "source_backed_paper_probation_required",
                        "paper_route_runtime_ledger_import_pending",
                    ],
                    continuity_ok=True,
                    continuity_reason="signals_present",
                    drift_ok=True,
                    drift_reason="drift_checks_recent",
                    paper_probation_satisfied=False,
                    source_collection_authorized=True,
                    source_collection_reason_codes=[
                        "runtime_ledger_source_decisions_missing",
                        "bounded_paper_route_manifest_seed",
                    ],
                ),
                route_reacquisition_book=self._hpairs_route_reacquisition_book(),
                generated_at=generated_at,
                include_runtime_window_import_audit=False,
            )

        target = payload["targets"][0]
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertTrue(target["evidence_collection_ok"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            target["source_decision_mode"], "bounded_paper_route_collection"
        )
        self.assertTrue(target["profit_proof_eligible"])
        self.assertNotIn(
            "paper_probation_prerequisites_not_satisfied_for_bounded_collection",
            target["bounded_evidence_collection_blockers"],
        )
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_hpairs_stale_signal_and_missing_drift_block_collection_when_current(
        self,
    ) -> None:
        generated_at = datetime(2026, 6, 2, 15, tzinfo=timezone.utc)
        window_start, _window_end = _next_regular_equities_session_window(generated_at)
        with Session(self.engine) as session:
            self._seed_hpairs_strategy_and_flat_snapshot(
                session,
                window_start=window_start,
            )

            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate=self._hpairs_live_submission_gate(
                    candidate_blockers=[
                        "drift_checks_missing",
                        "signal_lag_exceeded",
                    ],
                    continuity_ok=False,
                    continuity_reason="signal_lag_exceeded",
                    drift_ok=False,
                    drift_reason="drift_live_promotion_eligible_missing",
                ),
                route_reacquisition_book=self._hpairs_route_reacquisition_book(),
                generated_at=generated_at,
                include_runtime_window_import_audit=False,
            )

        target = payload["targets"][0]
        self.assertFalse(target["evidence_collection_ok"])
        self.assertFalse(target["bounded_evidence_collection_authorized"])
        self.assertIn("signal_lag_exceeded", target["candidate_blockers"])
        self.assertIn("drift_checks_missing", target["candidate_blockers"])
        self.assertIn(
            "signal_lag_exceeded",
            target["bounded_evidence_collection_blockers"],
        )
        self.assertIn(
            "drift_checks_missing",
            target["bounded_evidence_collection_blockers"],
        )
        self.assertIn(
            "drift_checks_missing",
            target["runtime_ledger_target_metadata_blockers"],
        )
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_hpairs_after_hours_market_session_closed_is_not_bypassed(self) -> None:
        generated_at = datetime(2026, 6, 2, 21, tzinfo=timezone.utc)
        window_start, _window_end = _next_regular_equities_session_window(generated_at)
        with Session(self.engine) as session:
            self._seed_hpairs_strategy_and_flat_snapshot(
                session,
                window_start=window_start,
            )

            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate=self._hpairs_live_submission_gate(
                    candidate_blockers=["signal_lag_exceeded"],
                    continuity_ok=True,
                    continuity_reason="signals_present",
                    drift_ok=True,
                    drift_reason="drift_checks_recent",
                ),
                route_reacquisition_book=self._hpairs_route_reacquisition_book(
                    blocking_reasons=["market_session_closed"],
                ),
                generated_at=generated_at,
                include_runtime_window_import_audit=False,
            )

        target = payload["targets"][0]
        self.assertIn(
            "market_session_closed",
            payload["paper_route_probe"]["blocking_reasons"],
        )
        self.assertFalse(target["evidence_collection_ok"])
        self.assertFalse(target["bounded_evidence_collection_authorized"])
        self.assertIn(
            "paper_route_session_window_closed",
            target["bounded_evidence_collection_blockers"],
        )
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_balanced_pair_probe_infers_missing_leg_opposite_existing_action(
        self,
    ) -> None:
        actions = _balanced_pair_probe_symbol_actions(
            {
                "strategy_family": "microbar_cross_sectional_pairs",
                "paper_route_probe_symbol_actions": {"AAPL": "buy"},
            },
            ["AAPL", "AMZN"],
        )

        self.assertEqual(actions, {"AAPL": "buy", "AMZN": "sell"})
        self.assertEqual(_pair_probe_balance_state(actions), "balanced")

    def test_probe_symbol_quantities_preserve_explicit_values_before_fallback(
        self,
    ) -> None:
        quantities = _paper_route_probe_symbol_quantities(
            {
                "paper_route_probe_symbol_quantities": {"AAPL": "0.5"},
                "target_symbol_quantities": {"AAPL": "0.8", "AMZN": "0.7"},
                "target_quantity": "2",
            },
            ["AAPL", "AMZN"],
        )

        self.assertEqual(quantities, {"AAPL": "0.5", "AMZN": "0.7"})

    def test_account_contamination_reason_reports_mixed_foreign_and_unlinked(
        self,
    ) -> None:
        self.assertEqual(
            _account_contamination_reason(
                unlinked_order_event_count=1,
                foreign_linked_order_event_count=1,
            ),
            "unlinked_and_foreign_account_order_events_present",
        )

    def test_balanced_pair_probe_accepts_explicit_true_and_short_alias(self) -> None:
        actions = _balanced_pair_probe_symbol_actions(
            {
                "paper_route_probe_pair_balance_required": "true",
                "paper_route_probe_symbol_actions": {"AAPL": "short"},
            },
            ["AAPL", "AMZN"],
        )

        self.assertEqual(actions, {"AAPL": "sell", "AMZN": "buy"})
        self.assertEqual(_pair_probe_balance_state(actions), "balanced")

    def test_hpairs_bounded_collection_requires_torghut_sim_paper_identity(
        self,
    ) -> None:
        self.assertEqual(
            _hpairs_round_trip_identity_blockers(
                {
                    "hypothesis_id": "H-CONTROL-01",
                    "candidate_id": "candidate-control",
                    "account_label": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "runtime_strategy_name": "control-strategy",
                    "source_kind": "paper_route_probe_runtime_observed",
                }
            ),
            [],
        )
        self.assertEqual(
            _hpairs_round_trip_identity_blockers(
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "candidate-hpairs",
                    "account_label": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "source_kind": "paper_route_probe_runtime_observed",
                }
            ),
            [],
        )

        missing_identity_blockers = _hpairs_round_trip_identity_blockers(
            {
                "source_manifest_ref": "H-PAIRS-01",
                "bounded_evidence_collection_authorized": True,
            }
        )

        self.assertIn(
            "paper_route_hpairs_candidate_id_missing",
            missing_identity_blockers,
        )
        self.assertIn(
            "paper_route_hpairs_hypothesis_id_missing",
            missing_identity_blockers,
        )
        self.assertIn(
            "paper_route_hpairs_account_label_missing",
            missing_identity_blockers,
        )
        self.assertIn(
            "paper_route_hpairs_paper_stage_required",
            missing_identity_blockers,
        )
        self.assertIn(
            "paper_route_hpairs_runtime_strategy_name_missing",
            missing_identity_blockers,
        )
        self.assertIn(
            "paper_route_hpairs_source_kind_missing",
            missing_identity_blockers,
        )

        blockers = _hpairs_round_trip_identity_blockers(
            {
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": "candidate-hpairs",
                "account_label": "TORGHUT_LIVE",
                "observed_stage": "live",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "source_kind": "paper_route_probe_runtime_observed",
            }
        )

        self.assertIn("paper_route_hpairs_torghut_sim_account_required", blockers)
        self.assertIn("paper_route_hpairs_paper_stage_required", blockers)

        missing_blockers = _hpairs_round_trip_identity_blockers(
            {
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "observed_stage": "paper",
                "bounded_evidence_collection_authorized": True,
            }
        )
        for blocker in (
            "paper_route_hpairs_candidate_id_missing",
            "paper_route_hpairs_hypothesis_id_missing",
            "paper_route_hpairs_account_label_missing",
            "paper_route_hpairs_runtime_strategy_name_missing",
            "paper_route_hpairs_source_kind_missing",
        ):
            self.assertIn(blocker, missing_blockers)

        self.assertEqual(
            _hpairs_round_trip_identity_blockers(
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "candidate-hpairs",
                    "account_label": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "source_kind": "paper_route_probe_runtime_observed",
                }
            ),
            [],
        )

    def test_target_audit_timeout_fails_closed_with_explicit_blockers(self) -> None:
        with Session(self.engine) as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                audit = _target_audit_fail_closed(
                    session,
                    raw_target={
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": "candidate-1",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "strategy_lookup_names": ["microbar-cross-sectional-pairs-v1"],
                        "account_label": "TORGHUT_SIM",
                        "observed_stage": "paper",
                        "window_start": "2026-05-29T13:30:00+00:00",
                        "window_end": "2026-05-29T20:00:00+00:00",
                        "promotion_allowed": False,
                        "final_promotion_allowed": False,
                    },
                    probe={
                        "configured_enabled": True,
                        "eligible_symbol_count": 2,
                        "symbols": ["AAPL", "MSFT"],
                        "blocking_reasons": [],
                    },
                    generated_at=datetime(2026, 5, 29, 21, 0, tzinfo=timezone.utc),
                    lookback_hours=72,
                    error_source="paper_route_source_target_audit",
                )

        readiness = audit["readiness"]
        self.assertEqual(readiness["state"], "evidence_collection_blocked")
        self.assertFalse(readiness["promotion_authority"]["allowed"])
        self.assertIn(
            "paper_route_evidence_db_unavailable",
            readiness["capital_promotion_blockers"],
        )
        self.assertIn("paper_route_evidence_db_unavailable", readiness["blockers"])
        self.assertIn(
            "paper_route_source_target_audit_db_unavailable",
            readiness["blockers"],
        )
        self.assertGreaterEqual(rollback.call_count, 1)

    def _runtime_ledger_source_authority_payload(
        self,
        *,
        window_start: datetime,
        window_end: datetime,
        suffix: str = "fixture",
    ) -> dict[str, object]:
        return {
            "source_window_start": window_start.isoformat(),
            "source_window_end": window_end.isoformat(),
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 1,
                "executions": 1,
                "execution_order_events": 2,
                "order_feed_source_windows": 1,
            },
            "trade_decision_ids": [f"decision-{suffix}"],
            "execution_ids": [f"execution-{suffix}"],
            "execution_order_event_ids": [
                f"event-new-{suffix}",
                f"event-fill-{suffix}",
            ],
            "source_window_ids": [f"source-window-{suffix}"],
            "source_offsets": [
                {
                    "topic": "alpaca.trade_updates",
                    "partition": 0,
                    "offset": 100,
                },
                {
                    "topic": "alpaca.trade_updates",
                    "partition": 0,
                    "offset": 101,
                },
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            "source_decision_mode_counts": {"strategy_signal_paper": 1},
        }

    def test_source_activity_query_timeout_fails_closed(self) -> None:
        window_start = datetime(2026, 5, 13, 17, tzinfo=timezone.utc)
        window_end = window_start + timedelta(minutes=30)
        with Session(self.engine) as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                activity = _strategy_source_activity(
                    session,
                    strategy_name="microbar-cross-sectional-pairs-v1",
                    account_label="TORGHUT_REPLAY",
                    symbols=["AAPL", "INTC"],
                    window_start=window_start,
                    window_end=window_end,
                    candidate_id="candidate-timeout",
                    hypothesis_id="hypothesis-timeout",
                    require_source_lineage=True,
                )

        rollback.assert_called_once()
        self.assertTrue(activity["missing"])
        self.assertTrue(activity["query_unavailable"])
        self.assertEqual(activity["unavailable_source"], "trade_decisions")
        self.assertEqual(activity["missing_reasons"], ["source_decisions_unavailable"])
        self.assertEqual(activity["raw_decision_count"], 0)
        self.assertEqual(activity["lineage_matched_decision_count"], 0)

    def test_source_activity_timeout_suppresses_rollback_failure(self) -> None:
        window_start = datetime(2026, 5, 13, 17, tzinfo=timezone.utc)
        window_end = window_start + timedelta(minutes=30)
        with Session(self.engine) as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(
                    session,
                    "rollback",
                    side_effect=SQLAlchemyError("rollback failed"),
                ) as rollback,
            ):
                activity = _strategy_source_activity(
                    session,
                    strategy_name="microbar-cross-sectional-pairs-v1",
                    account_label="TORGHUT_REPLAY",
                    symbols=["AAPL", "INTC"],
                    window_start=window_start,
                    window_end=window_end,
                )

        rollback.assert_called_once()
        self.assertTrue(activity["query_unavailable"])
        self.assertEqual(activity["missing_reasons"], ["source_decisions_unavailable"])

    def _seed_source_activity_decision(
        self,
        session: Session,
        *,
        window_start: datetime,
    ) -> None:
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="paper route source timeout fixture",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL", "INTC"],
            created_at=window_start,
            updated_at=window_start,
        )
        session.add(strategy)
        session.flush()
        session.add(
            TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_REPLAY",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-timeout",
                    "hypothesis_id": "hypothesis-timeout",
                },
                rationale="paper route source timeout fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=5),
                executed_at=window_start + timedelta(minutes=6),
            )
        )
        session.flush()

    def _source_activity_with_failing_query(
        self,
        *,
        failure_call: int,
    ) -> tuple[dict[str, object], int]:
        window_start = datetime(2026, 5, 13, 17, tzinfo=timezone.utc)
        window_end = window_start + timedelta(minutes=30)
        with Session(self.engine) as session:
            self._seed_source_activity_decision(session, window_start=window_start)
            original_execute = session.execute
            call_count = 0

            def execute_or_fail(*args: object, **kwargs: object) -> object:
                nonlocal call_count
                call_count += 1
                if call_count == failure_call:
                    raise SQLAlchemyError("statement timeout")
                return original_execute(*args, **kwargs)

            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=execute_or_fail,
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                activity = _strategy_source_activity(
                    session,
                    strategy_name="microbar-cross-sectional-pairs-v1",
                    account_label="TORGHUT_REPLAY",
                    symbols=["AAPL", "INTC"],
                    window_start=window_start,
                    window_end=window_end,
                    candidate_id="candidate-timeout",
                    hypothesis_id="hypothesis-timeout",
                    require_source_lineage=True,
                )
                rollback_count = rollback.call_count
        return activity, rollback_count

    def test_source_activity_execution_query_timeout_fails_closed(self) -> None:
        activity, rollback_count = self._source_activity_with_failing_query(
            failure_call=2
        )

        self.assertEqual(rollback_count, 1)
        self.assertTrue(activity["query_unavailable"])
        self.assertEqual(activity["unavailable_source"], "executions")
        self.assertEqual(activity["missing_reasons"], ["source_executions_unavailable"])
        self.assertEqual(activity["raw_decision_count"], 1)
        self.assertEqual(activity["lineage_matched_decision_count"], 1)

    def test_source_activity_order_event_query_timeout_fails_closed(self) -> None:
        activity, rollback_count = self._source_activity_with_failing_query(
            failure_call=3
        )

        self.assertEqual(rollback_count, 1)
        self.assertTrue(activity["query_unavailable"])
        self.assertEqual(activity["unavailable_source"], "execution_order_events")
        self.assertEqual(
            activity["missing_reasons"], ["source_order_events_unavailable"]
        )
        self.assertEqual(activity["raw_decision_count"], 1)
        self.assertEqual(activity["lineage_matched_decision_count"], 1)

    def test_source_activity_tca_query_timeout_fails_closed(self) -> None:
        activity, rollback_count = self._source_activity_with_failing_query(
            failure_call=4
        )

        self.assertEqual(rollback_count, 1)
        self.assertTrue(activity["query_unavailable"])
        self.assertEqual(activity["unavailable_source"], "execution_tca_metrics")
        self.assertEqual(activity["missing_reasons"], ["source_tca_unavailable"])
        self.assertEqual(activity["raw_decision_count"], 1)
        self.assertEqual(activity["lineage_matched_decision_count"], 1)

    def test_source_activity_noisy_dataset_is_bounded_and_reports_truncation(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc)
        window_end = window_start + timedelta(hours=1)
        strategy_name = "paper-route-noisy-readback"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="noisy bounded readback fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add(strategy)
            session.flush()
            for index in range(PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT + 7):
                session.add(
                    TradeDecision(
                        strategy_id=strategy.id,
                        alpaca_account_label="TORGHUT_SIM",
                        symbol="AAPL",
                        timeframe="1Min",
                        decision_json={
                            "action": "buy",
                            "qty": "1",
                            "candidate_id": "candidate-noisy-readback",
                            "hypothesis_id": "H-NOISY-READBACK",
                        },
                        rationale="bounded noisy source readback",
                        status="planned",
                        created_at=window_start + timedelta(seconds=index),
                        executed_at=None,
                    )
                )
            session.commit()

            activity = _strategy_source_activity(
                session,
                strategy_name=strategy_name,
                account_label="TORGHUT_SIM",
                symbols=["AAPL"],
                window_start=window_start,
                window_end=window_end,
                candidate_id="candidate-noisy-readback",
                hypothesis_id="H-NOISY-READBACK",
                require_source_lineage=True,
            )

        self.assertEqual(
            activity["raw_decision_count"], PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT
        )
        self.assertEqual(
            activity["lineage_matched_decision_count"],
            PAPER_ROUTE_SOURCE_ACTIVITY_ROW_LIMIT,
        )
        self.assertEqual(
            len(activity["decision_refs"]), PAPER_ROUTE_SOURCE_ACTIVITY_REF_LIMIT
        )
        self.assertEqual(activity["readback_state"], "source_decisions_present")
        self.assertTrue(activity["stage_presence"]["source_decisions_present"])
        self.assertFalse(activity["stage_presence"]["submitted_lifecycle_present"])
        self.assertEqual(
            activity["query_limits"]["truncated_sources"], ["trade_decisions"]
        )
        self.assertTrue(activity["query_limits"]["decision_truncated"])
        self.assertIn("source_executions_missing", activity["missing_reasons"])
        self.assertEqual(
            activity["submitted_order_blockers"],
            ["source_submitted_orders_missing", "source_execution_refs_missing"],
        )
        self.assertIn(
            "source_submitted_orders_missing",
            activity["source_lifecycle_blockers"],
        )

    def test_evidence_readback_diagnostics_distinguish_source_lifecycle_and_blockers(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc)
        window_end = window_start + timedelta(hours=1)
        event_at = window_start + timedelta(minutes=5)
        strategy_name = "paper-route-diagnostic-readback"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="diagnostic readback fixture",
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
                    "candidate_id": "candidate-diagnostic-readback",
                    "hypothesis_id": "H-DIAGNOSTIC-READBACK",
                },
                rationale="diagnostic source-backed readback",
                status="executed",
                created_at=event_at,
                executed_at=event_at,
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="diagnostic-readback-order",
                client_order_id="diagnostic-readback-client",
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
            )
            session.add(execution)
            session.flush()
            session.add_all(
                [
                    ExecutionOrderEvent(
                        event_fingerprint="diagnostic-readback-fill",
                        source_topic="trade_updates",
                        source_partition=0,
                        source_offset=501,
                        alpaca_account_label="TORGHUT_SIM",
                        feed_seq=501,
                        event_ts=event_at,
                        symbol="AAPL",
                        alpaca_order_id="diagnostic-readback-order",
                        client_order_id="diagnostic-readback-client",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        filled_qty_delta=Decimal("1"),
                        filled_notional_delta=Decimal("100"),
                        avg_fill_price=Decimal("100"),
                        raw_event={"event": "fill", "side": "buy"},
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        created_at=event_at,
                    ),
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
                        computed_at=event_at,
                        created_at=event_at,
                        updated_at=event_at,
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="diagnostic-readback-ledger",
                        candidate_id="candidate-diagnostic-readback",
                        hypothesis_id="H-DIAGNOSTIC-READBACK",
                        observed_stage="paper",
                        bucket_started_at=window_start,
                        bucket_ended_at=window_end,
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name=strategy_name,
                        strategy_family="microbar_pairs",
                        fill_count=1,
                        decision_count=1,
                        submitted_order_count=1,
                        closed_trade_count=0,
                        open_position_count=1,
                        filled_notional=Decimal("100"),
                        gross_strategy_pnl=Decimal("1"),
                        cost_amount=Decimal("0.25"),
                        net_strategy_pnl_after_costs=Decimal("0.75"),
                        post_cost_expectancy_bps=Decimal("75"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy": 1},
                        cost_model_hash_counts={"cost": 1},
                        lineage_hash_counts={"lineage": 1},
                        blockers_json=["paper_route_missing_close"],
                    ),
                    StrategyPromotionDecision(
                        run_id="diagnostic-readback-ledger",
                        candidate_id="candidate-diagnostic-readback",
                        hypothesis_id="H-DIAGNOSTIC-READBACK",
                        promotion_target="paper",
                        state="blocked",
                        allowed=False,
                        reason_summary="paper_probation_evidence_collection_only",
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
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-DIAGNOSTIC-READBACK",
                                "candidate_id": "candidate-diagnostic-readback",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-diagnostic.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
                                "promotion_allowed": False,
                                "final_promotion_allowed": False,
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
                generated_at=window_end + timedelta(minutes=5),
            )

        diagnostic = payload["targets"][0]["evidence_readback"]
        self.assertEqual(diagnostic["state"], "runtime_buckets_present")
        self.assertTrue(diagnostic["source_decisions_present"])
        self.assertTrue(diagnostic["submitted_lifecycle_present"])
        self.assertTrue(diagnostic["fills_or_executions_present"])
        self.assertTrue(diagnostic["source_refs_present"])
        self.assertTrue(diagnostic["runtime_buckets_present"])
        self.assertTrue(diagnostic["final_promotion_authority_blocked"])
        self.assertIn("final_promotion_authority_blocked", diagnostic["blockers"])
        self.assertIn("paper_route_missing_close", diagnostic["blockers"])
        summary = payload["summary"]["readback"]
        self.assertEqual(summary["source_decisions_present_count"], 1)
        self.assertEqual(summary["submitted_lifecycle_present_count"], 1)
        self.assertEqual(summary["fills_or_executions_present_count"], 1)
        self.assertEqual(summary["runtime_buckets_present_count"], 1)
        self.assertEqual(summary["final_promotion_authority_blocked_count"], 1)

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

    def _add_flat_account_close_snapshot(
        self,
        session: Session,
        *,
        account_label: str,
        window_end: datetime,
        positions: list[dict[str, object]] | None = None,
    ) -> None:
        session.add(
            PositionSnapshot(
                alpaca_account_label=account_label,
                as_of=window_end + timedelta(minutes=5),
                equity=Decimal("100000"),
                cash=Decimal("100000"),
                buying_power=Decimal("200000"),
                positions=positions or [],
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
        include_runtime_window_import_audit: bool | None = True,
        target_account_audit_available: bool = True,
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
                            "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
            include_runtime_window_import_audit=include_runtime_window_import_audit,
            target_account_audit_available=target_account_audit_available,
        )

    def test_target_plan_can_defer_full_runtime_window_audit(self) -> None:
        generated_at = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            with patch(
                "app.trading.paper_route_evidence._target_audit",
                side_effect=AssertionError("full runtime-window audit should defer"),
            ):
                payload = self._build_basic_paper_route_target_plan(
                    session,
                    generated_at=generated_at,
                    include_runtime_window_import_audit=False,
                )

        self.assertEqual(
            payload["runtime_window_import_audit_mode"],
            "deferred_until_import_ready",
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "waiting_for_session_open")
        self.assertEqual(
            import_audit["next_action"],
            "wait_for_regular_session_open",
        )
        self.assertIn(
            "paper_route_session_window_not_open",
            import_audit["blockers"],
        )
        self.assertEqual(
            import_audit["counts"]["source_plan_target_count"],
            1,
        )
        self.assertEqual(
            import_audit["counts"]["selected_target_count"],
            1,
        )

    def test_target_plan_deferred_mode_builds_only_next_window(self) -> None:
        generated_at = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        window_purposes: list[str] = []
        original_builder = paper_route_evidence._next_paper_route_runtime_window_targets

        def _record_window_build(*args: object, **kwargs: object) -> dict[str, object]:
            window_purposes.append(str(kwargs.get("purpose") or "next_session"))
            return original_builder(*args, **kwargs)

        with Session(self.engine) as session:
            with patch(
                "app.trading.paper_route_evidence._next_paper_route_runtime_window_targets",
                side_effect=_record_window_build,
            ):
                payload = self._build_basic_paper_route_target_plan(
                    session,
                    generated_at=generated_at,
                    include_runtime_window_import_audit=False,
                )

        self.assertEqual(window_purposes, ["next_session"])
        self.assertEqual(payload["source_runtime_window_import_plan"], {})
        self.assertEqual(
            payload["latest_closed_paper_route_runtime_window_targets"], {}
        )
        self.assertEqual(
            payload["runtime_window_import_audit_mode"],
            "deferred_until_import_ready",
        )
        self.assertEqual(payload["runtime_window_import_plan"]["target_count"], 1)
        self.assertEqual(
            payload["summary"]["source_runtime_window_target_count"],
            0,
        )
        self.assertEqual(
            payload["summary"]["latest_closed_runtime_window_target_count"],
            0,
        )

    def test_target_plan_auto_runs_full_runtime_window_audit_when_import_ready(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 22, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
                include_runtime_window_import_audit=None,
            )

        self.assertEqual(payload["runtime_window_import_audit_mode"], "full")
        import_audit = payload["runtime_window_import_audit"]
        self.assertNotIn(
            "runtime_window_import_audit_deferred_until_import_ready",
            import_audit["blockers"],
        )
        self.assertEqual(import_audit["import_ready"], True)
        self.assertEqual(
            import_audit["diagnostics"]["source_activity_missing_reasons"],
            [
                "source_decisions_missing",
                "source_executions_missing",
                "source_tca_missing",
            ],
        )

    def test_evidence_audit_records_target_db_timeout_as_fail_closed_blocker(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            with patch(
                "app.trading.paper_route_evidence._strategy_source_activity",
                side_effect=SQLAlchemyError("statement timeout"),
            ):
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
                                    "candidate_id": "candidate-pre-session",
                                    "observed_stage": "paper",
                                    "strategy_family": "microbar_pairs",
                                    "strategy_name": "paper-route-candidate-v1",
                                    "account_label": "TORGHUT_REPLAY",
                                    "source_kind": "durable_runtime_ledger_bucket",
                                    "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
                                    "dataset_snapshot_ref": "dataset://paper-route",
                                    "paper_probation_authorized": True,
                                    "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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

        self.assertEqual(payload["schema_version"], "torghut.paper-route-evidence.v1")
        source_audit = payload["targets"][0]
        source_blockers = set(source_audit["readiness"]["blockers"])
        self.assertIn("paper_route_evidence_db_unavailable", source_blockers)
        self.assertIn("paper_route_source_target_audit_db_unavailable", source_blockers)
        self.assertFalse(source_audit["readiness"]["promotion_authority"]["allowed"])
        self.assertEqual(
            source_audit["source_activity"]["db_load_error"]["error_type"],
            "SQLAlchemyError",
        )
        next_audit = payload["next_runtime_window_target_audits"][0]
        next_blockers = set(next_audit["readiness"]["blockers"])
        self.assertIn("paper_route_evidence_db_unavailable", next_blockers)
        self.assertIn("paper_route_next_target_audit_db_unavailable", next_blockers)
        self.assertFalse(payload["summary"]["promotion_authority"]["allowed"])

    def test_source_activity_timeout_keeps_runtime_ledger_evidence_visible(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        generated_at = datetime(2026, 5, 26, 21, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="paper-route-ledger-source-timeout",
                    candidate_id="candidate-source-timeout",
                    hypothesis_id="H-SOURCE-TIMEOUT",
                    observed_stage="paper",
                    bucket_started_at=window_start,
                    bucket_ended_at=window_end,
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name="paper-route-candidate-v1",
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
                    payload_json=self._runtime_ledger_source_authority_payload(
                        window_start=window_start,
                        window_end=window_end,
                        suffix="source-timeout",
                    ),
                )
            )
            session.commit()

            with patch(
                "app.trading.paper_route_evidence._strategy_source_activity",
                side_effect=SQLAlchemyError("statement timeout"),
            ):
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
                                    "hypothesis_id": "H-SOURCE-TIMEOUT",
                                    "candidate_id": "candidate-source-timeout",
                                    "observed_stage": "paper",
                                    "strategy_family": "microbar_pairs",
                                    "strategy_name": "paper-route-candidate-v1",
                                    "account_label": "TORGHUT_SIM",
                                    "source_kind": "durable_runtime_ledger_bucket",
                                    "source_manifest_ref": "config/trading/hypotheses/h-source-timeout.json",
                                    "dataset_snapshot_ref": "dataset://paper-route",
                                    "window_start": window_start.isoformat(),
                                    "window_end": window_end.isoformat(),
                                    "paper_probation_authorized": True,
                                    "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                            "eligible_symbols": ["AAPL"],
                            "blocking_reasons": ["market_session_closed"],
                        },
                    },
                    generated_at=generated_at,
                )

        audit = payload["targets"][0]
        self.assertTrue(audit["source_activity"]["missing"])
        self.assertIn(
            "paper_route_source_target_audit_db_unavailable",
            audit["source_activity"]["missing_reasons"],
        )
        self.assertEqual(audit["runtime_ledger"]["bucket_count"], 1)
        self.assertEqual(audit["runtime_ledger"]["evidence_grade_bucket_count"], 1)
        self.assertEqual(audit["runtime_ledger"]["net_strategy_pnl_after_costs"], "10")
        self.assertEqual(payload["summary"]["target_with_runtime_ledger_count"], 1)
        self.assertEqual(
            payload["summary"]["target_with_evidence_grade_runtime_ledger_count"],
            1,
        )
        self.assertEqual(payload["summary"]["target_with_source_activity_count"], 0)
        blockers = set(audit["readiness"]["blockers"])
        self.assertIn("paper_route_evidence_db_unavailable", blockers)
        self.assertIn("paper_route_source_target_audit_db_unavailable", blockers)

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

    def test_account_window_start_snapshot_audit_defers_future_window(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        generated_at = window_start - timedelta(hours=1)
        with Session(self.engine) as session:
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=generated_at - timedelta(seconds=30),
                positions=[
                    {
                        "symbol": "AAPL",
                        "qty": "1",
                        "side": "long",
                        "market_value": "200",
                    }
                ],
            )
            session.commit()

            audit = _account_window_start_snapshot_audit(
                session,
                account_label="TORGHUT_SIM",
                symbols=["AAPL"],
                window_start=window_start,
                generated_at=generated_at,
            )

        self.assertEqual(audit["state"], "pending_until_window_start")
        self.assertFalse(audit["required"])
        self.assertIsNone(audit["flat"])
        self.assertEqual(audit["position_count"], 0)
        self.assertEqual(audit["sample_positions"], [])
        self.assertEqual(audit["blockers"], [])

    def test_future_runtime_window_defers_stale_account_state_blockers(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        generated_at = window_start - timedelta(hours=1)
        with Session(self.engine) as session:
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=generated_at - timedelta(seconds=30),
                positions=[
                    {
                        "symbol": "AAPL",
                        "qty": "1",
                        "side": "long",
                        "market_value": "200",
                    }
                ],
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
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-FUTURE-ACCOUNT",
                                "candidate_id": "candidate-future-account",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "future-account-state-strategy",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-future-account.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                generated_at=generated_at,
            )

        audit = payload["next_runtime_window_target_audits"][0]
        self.assertEqual(audit["account_state"]["state"], "pending_until_window_start")
        self.assertEqual(audit["account_state"]["blockers"], [])
        self.assertNotIn(
            "paper_route_account_window_start_not_flat",
            audit["readiness"]["blockers"],
        )
        self.assertNotIn(
            "paper_route_account_window_start_positions_present",
            audit["readiness"]["evidence_collection_blockers"],
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertNotEqual(import_audit["state"], "import_due_account_state_not_clean")
        self.assertEqual(import_audit["diagnostics"]["account_state_blockers"], [])

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
        self.assertEqual(readiness["state"], "blocked")
        self.assertEqual(readiness["target_count"], 1)
        self.assertEqual(readiness["required_target_count"], 1)
        self.assertEqual(readiness["not_yet_required_target_count"], 0)
        self.assertEqual(readiness["pending_target_count"], 0)
        self.assertEqual(readiness["clean_target_count"], 0)
        self.assertEqual(readiness["blocked_target_count"], 1)
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
            source_plan["account_pre_session_readiness"]["blockers"],
            ["paper_route_account_pre_session_snapshot_missing"],
        )

    def test_pre_session_snapshot_within_readiness_window_remains_clean_after_open(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 13, 41, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=datetime(2026, 5, 26, 13, 25, tzinfo=timezone.utc),
                positions=[],
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["skipped_target_count"], 0)
        readiness = plan["account_pre_session_readiness"]
        self.assertEqual(readiness["state"], "clean")
        self.assertEqual(readiness["clean_target_count"], 1)
        target_state = plan["targets"][0]["paper_route_account_pre_session_state"]
        self.assertEqual(target_state["state"], "clean")
        self.assertEqual(target_state["snapshot_age_seconds"], 960)
        self.assertEqual(target_state["snapshot_window_start_offset_seconds"], -300)
        self.assertNotIn(
            "paper_route_account_pre_session_snapshot_stale",
            target_state["blockers"],
        )

    def test_flat_clean_baseline_allows_bounded_collection_readiness(self) -> None:
        generated_at = datetime(2026, 5, 26, 13, 35, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="paper-route-candidate-v1",
                    description="clean baseline source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=window_start - timedelta(minutes=5),
                positions=[],
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(
            target["paper_route_clean_window_state"], "clean_window_collection_ready"
        )
        self.assertEqual(
            target["paper_route_clean_window_baseline_state"]["state"],
            "clean",
        )
        self.assertEqual(target["paper_route_clean_window_baseline_blockers"], [])
        self.assertTrue(target["evidence_collection_ok"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            target["source_decision_mode"], "bounded_paper_route_collection"
        )
        self.assertTrue(target["source_decision_mode_profit_proof_eligible"])
        self.assertTrue(target["profit_proof_eligible"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        clean_readiness = plan["clean_window_baseline_readiness"]
        self.assertEqual(clean_readiness["state"], "clean")
        self.assertEqual(clean_readiness["clean_target_count"], 1)
        self.assertEqual(clean_readiness["blockers"], [])

    def test_clean_hpairs_target_plan_materializes_nonzero_source_decisions(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 13, 35, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="paper-route-candidate-v1",
                    description="clean materialization source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=window_start - timedelta(minutes=5),
                positions=[],
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )
            plan = payload["next_paper_route_runtime_window_targets"]
            target = plan["targets"][0]
            self.assertEqual(
                target["paper_route_probe_symbol_quantities"],
                {"AAPL": "1", "AMZN": "1"},
            )
            self.assertFalse(target["promotion_allowed"])
            self.assertFalse(target["final_promotion_allowed"])

            materialized = materialize_bounded_paper_route_target_plan(
                session,
                plan,
                generated_at=generated_at,
                bounded_notional_limit=Decimal("25"),
            )

        self.assertEqual(materialized["materialized_decision_count"], 2)
        self.assertEqual(materialized["route_submission_count"], 2)
        self.assertEqual(materialized["blocked_target_count"], 0)
        self.assertFalse(materialized["promotion_allowed"])
        self.assertFalse(materialized["final_promotion_allowed"])
        self.assertFalse(materialized["live_capital_routing_enabled"])

    def test_older_contaminated_window_does_not_poison_later_clean_target_window(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 13, 35, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="paper-route-candidate-v1",
                    description="clean isolated target window source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="older-contaminated-window-aapl-fill",
                    source_topic="alpaca.trade_updates",
                    source_partition=0,
                    source_offset=41,
                    alpaca_account_label="TORGHUT_SIM",
                    event_ts=window_start - timedelta(days=1),
                    symbol="AAPL",
                    alpaca_order_id="older-contaminated-order-1",
                    client_order_id="intraday-tsmom-AAPL-older-contamination-1",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("101"),
                    raw_event={"source": "older_intraday_tsmom_window"},
                    execution_id=None,
                    trade_decision_id=None,
                )
            )
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=window_start - timedelta(minutes=5),
                positions=[],
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        contamination = target["paper_route_account_contamination_state"]
        self.assertFalse(contamination["contaminated"])
        self.assertEqual(contamination["order_event_count"], 0)
        self.assertEqual(contamination["unlinked_order_event_count"], 0)
        self.assertEqual(contamination["sample_client_order_ids"], [])
        self.assertEqual(contamination["sample_order_event_refs"], [])
        contamination_readiness = plan["account_contamination_readiness"]
        self.assertEqual(contamination_readiness["state"], "clean")
        self.assertEqual(contamination_readiness["clean_target_count"], 1)
        self.assertEqual(contamination_readiness["contaminated_target_count"], 0)
        self.assertEqual(contamination_readiness["unlinked_order_event_count"], 0)
        self.assertEqual(contamination_readiness["blockers"], [])
        self.assertEqual(
            target["paper_route_clean_window_state"], "clean_window_collection_ready"
        )
        self.assertTrue(target["evidence_collection_ok"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            target["source_decision_mode"], "bounded_paper_route_collection"
        )
        self.assertTrue(target["source_decision_mode_profit_proof_eligible"])
        self.assertTrue(target["profit_proof_eligible"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_target_account_audit_unavailable_blocks_collection_readiness(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 13, 35, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="paper-route-candidate-v1",
                    description="clean baseline source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=window_start - timedelta(minutes=5),
                positions=[],
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
                target_account_audit_available=False,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(
            target["paper_route_clean_window_state"],
            "target_account_audit_unavailable",
        )
        self.assertEqual(
            target["paper_route_target_account_audit_state"]["state"],
            "unavailable",
        )
        self.assertIn(
            "paper_route_target_account_audit_unavailable",
            target["paper_route_target_account_audit_blockers"],
        )
        self.assertIn(
            "paper_route_target_account_audit_unavailable",
            target["bounded_evidence_collection_blockers"],
        )
        self.assertFalse(target["evidence_collection_ok"])
        self.assertFalse(target["canary_collection_authorized"])
        self.assertFalse(target["bounded_evidence_collection_authorized"])
        self.assertFalse(target["bounded_live_paper_collection_authorized"])
        self.assertEqual(target["source_decision_mode"], "route_acquisition_probe")
        self.assertFalse(target["source_decision_mode_profit_proof_eligible"])
        self.assertFalse(target["profit_proof_eligible"])
        self.assertEqual(plan["target_account_audit_readiness"]["state"], "unavailable")

    def test_clean_baseline_allows_collection_when_health_gate_blocks_promotion(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 13, 35, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="paper-route-candidate-v1",
                    description="clean baseline source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=window_start - timedelta(minutes=5),
                positions=[],
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
                    "continuity_ok": "false",
                    "continuity_reason": "signal_continuity_missing",
                    "drift_ok": "false",
                    "drift_reason": "drift_live_promotion_ineligible",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-clean-but-not-promotable",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "paper-route-candidate-v1",
                                "account_label": "TORGHUT_REPLAY",
                                "source_kind": "durable_runtime_ledger_bucket",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
                                "dataset_snapshot_ref": "dataset://paper-route",
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "blocking_reasons": [],
                    },
                },
                generated_at=generated_at,
            )

        target = payload["next_paper_route_runtime_window_targets"]["targets"][0]
        self.assertEqual(
            target["runtime_window_import_health_gate"]["blockers"],
            ["evidence_continuity_not_ok"],
        )
        self.assertEqual(
            target["runtime_window_import_promotion_blockers"],
            ["drift_checks_not_ok"],
        )
        self.assertTrue(target["evidence_collection_ok"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            target["source_decision_mode"], "bounded_paper_route_collection"
        )
        self.assertTrue(target["source_decision_mode_profit_proof_eligible"])
        self.assertTrue(target["profit_proof_eligible"])
        self.assertIn("evidence_continuity_not_ok", target["candidate_blockers"])
        self.assertIn(
            "evidence_continuity_not_ok",
            target["runtime_ledger_target_metadata_blockers"],
        )
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_missing_clean_baseline_blocks_bounded_collection_readiness(self) -> None:
        generated_at = datetime(2026, 5, 26, 13, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="paper-route-candidate-v1",
                    description="missing baseline source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        next_plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(next_plan["target_count"], 0)
        self.assertEqual(next_plan["skipped_target_count"], 1)
        source_plan = payload["source_runtime_window_import_plan"]
        target = source_plan["targets"][0]
        self.assertEqual(
            target["paper_route_clean_window_state"], "clean_window_required"
        )
        self.assertFalse(target["evidence_collection_ok"])
        self.assertFalse(target["bounded_evidence_collection_authorized"])
        self.assertIn(
            "paper_route_account_pre_session_snapshot_missing",
            target["paper_route_clean_window_baseline_blockers"],
        )

    def test_non_target_clean_baseline_position_blocks_collection_readiness(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 13, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="paper-route-candidate-v1",
                    description="non-target baseline source strategy",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=generated_at - timedelta(seconds=30),
                positions=[
                    {
                        "symbol": "MSFT",
                        "qty": "1",
                        "side": "long",
                        "market_value": "300",
                    }
                ],
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        source_plan = payload["source_runtime_window_import_plan"]
        target = source_plan["targets"][0]
        self.assertEqual(
            target["paper_route_clean_window_state"], "clean_window_required"
        )
        self.assertFalse(target["evidence_collection_ok"])
        self.assertFalse(target["bounded_evidence_collection_authorized"])
        self.assertIn(
            "paper_route_account_pre_session_non_target_positions_present",
            target["paper_route_clean_window_baseline_blockers"],
        )

    def test_pre_session_after_open_snapshot_does_not_satisfy_readiness(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 13, 41, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=datetime(2026, 5, 26, 13, 35, tzinfo=timezone.utc),
                positions=[],
            )
            session.commit()

            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 0)
        self.assertEqual(plan["skipped_target_count"], 1)
        self.assertEqual(
            plan["account_pre_session_readiness"]["blockers"],
            ["paper_route_account_pre_session_snapshot_missing"],
        )

    def test_pre_session_snapshot_before_readiness_window_blocks_stale(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        generated_at = datetime(2026, 5, 26, 13, 41, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=datetime(2026, 5, 26, 13, 14, 59, tzinfo=timezone.utc),
                positions=[],
            )
            session.commit()

            audit = _account_pre_session_snapshot_audit(
                session,
                account_label="TORGHUT_SIM",
                symbols=["AAPL", "AMZN"],
                generated_at=generated_at,
                window_start=window_start,
                window_end=datetime(2026, 5, 26, 20, tzinfo=timezone.utc),
            )

        self.assertFalse(audit["flat"])
        self.assertEqual(
            audit["blockers"], ["paper_route_account_pre_session_snapshot_stale"]
        )
        self.assertEqual(audit["snapshot_window_start_offset_seconds"], -901)

    def test_target_plan_import_plan_skips_closed_window_without_source_evidence(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 30, 8, 23, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        import_plan = payload["runtime_window_import_plan"]
        self.assertEqual(
            import_plan["purpose"],
            "next_session_paper_route_runtime_window_evidence_collection",
        )
        self.assertEqual(
            import_plan["session_window"],
            {
                "start": "2026-06-01T13:30:00+00:00",
                "end": "2026-06-01T20:00:00+00:00",
            },
        )
        self.assertFalse(import_plan["session_readiness"]["import_ready"])
        self.assertEqual(import_plan["target_count"], 1)
        latest_closed = payload["latest_closed_paper_route_runtime_window_targets"]
        self.assertEqual(
            latest_closed["session_window"],
            {
                "start": "2026-05-29T13:30:00+00:00",
                "end": "2026-05-29T20:00:00+00:00",
            },
        )
        self.assertTrue(latest_closed["session_readiness"]["import_ready"])
        next_plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(next_plan["session_window"], import_plan["session_window"])
        self.assertEqual(
            payload["summary"]["runtime_window_import_plan_purpose"],
            "next_session_paper_route_runtime_window_evidence_collection",
        )

    def test_evidence_import_audit_uses_latest_closed_window_before_next_open(
        self,
    ) -> None:
        generated_at = datetime(2026, 6, 1, 5, tzinfo=timezone.utc)
        closed_start = datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc)
        closed_end = datetime(2026, 5, 29, 20, tzinfo=timezone.utc)
        strategy_name = "closed-window-paper-route"
        with Session(self.engine) as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="closed-window-paper-route-run",
                    candidate_id="candidate-closed-window",
                    hypothesis_id="H-CLOSED-WINDOW",
                    observed_stage="paper",
                    bucket_started_at=closed_start + timedelta(minutes=30),
                    bucket_ended_at=closed_start + timedelta(minutes=60),
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
                    payload_json=self._runtime_ledger_source_authority_payload(
                        window_start=closed_start,
                        window_end=closed_end,
                        suffix="closed-window",
                    ),
                )
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
                                "hypothesis_id": "H-CLOSED-WINDOW",
                                "candidate_id": "candidate-closed-window",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-closed-window.json",
                                "window_start": "2026-06-01T13:30:00+00:00",
                                "window_end": "2026-06-01T20:00:00+00:00",
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                generated_at=generated_at,
            )

        next_plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(
            next_plan["session_window"],
            {
                "start": "2026-06-01T13:30:00+00:00",
                "end": "2026-06-01T20:00:00+00:00",
            },
        )
        import_plan = payload["runtime_window_import_plan"]
        self.assertEqual(
            import_plan["purpose"],
            "latest_closed_session_paper_route_runtime_window_import",
        )
        self.assertEqual(
            import_plan["session_window"],
            {
                "start": "2026-05-29T13:30:00+00:00",
                "end": "2026-05-29T20:00:00+00:00",
            },
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["session_window"], import_plan["session_window"])
        self.assertTrue(import_audit["import_ready"])
        self.assertEqual(import_audit["counts"]["targets_with_runtime_ledger"], 1)
        self.assertEqual(
            import_audit["counts"]["targets_with_evidence_grade_runtime_ledger"],
            1,
        )
        self.assertEqual(
            payload["summary"][
                "runtime_window_import_target_with_runtime_ledger_count"
            ],
            1,
        )
        self.assertEqual(
            payload["summary"][
                "runtime_window_import_target_with_evidence_grade_runtime_ledger_count"
            ],
            1,
        )
        self.assertEqual(
            payload["summary"]["next_runtime_window_target_with_runtime_ledger_count"],
            0,
        )
        runtime_import_audit = payload["runtime_window_import_target_audits"][0]
        self.assertEqual(runtime_import_audit["window"], import_plan["session_window"])
        self.assertEqual(runtime_import_audit["runtime_ledger"]["bucket_count"], 1)

    def test_source_runtime_window_import_plan_keeps_next_session_window(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 30, 8, 23, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = self._build_basic_paper_route_target_plan(
                session,
                generated_at=generated_at,
            )

        source_plan = payload["source_runtime_window_import_plan"]
        self.assertEqual(
            source_plan["session_window"],
            {
                "start": "2026-06-01T13:30:00+00:00",
                "end": "2026-06-01T20:00:00+00:00",
            },
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

    def test_runtime_ledger_evidence_grade_requires_source_authority_payload(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 28, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 28, 15, 30, tzinfo=timezone.utc)
        row = StrategyRuntimeLedgerBucket(
            run_id="aggregate-only-runtime-ledger-run",
            candidate_id="candidate-aggregate-only",
            hypothesis_id="H-AGGREGATE-ONLY",
            observed_stage="paper",
            bucket_started_at=window_start,
            bucket_ended_at=window_end,
            account_label="TORGHUT_SIM",
            runtime_strategy_name="aggregate-only-strategy",
            strategy_family="microbar_pairs",
            fill_count=2,
            decision_count=1,
            submitted_order_count=1,
            closed_trade_count=1,
            open_position_count=0,
            filled_notional=Decimal("1000"),
            gross_strategy_pnl=Decimal("20"),
            cost_amount=Decimal("1"),
            net_strategy_pnl_after_costs=Decimal("19"),
            post_cost_expectancy_bps=Decimal("190"),
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            execution_policy_hash_counts={"policy-a": 1},
            cost_model_hash_counts={"cost-a": 1},
            lineage_hash_counts={"lineage-a": 1},
            blockers_json=[],
            payload_json={},
        )

        self.assertFalse(_runtime_ledger_bucket_evidence_grade(row))
        diagnostic = _runtime_ledger_non_evidence_diagnostic_summary([row])
        blocker_counts = diagnostic["blocker_counts"]
        self.assertIn("runtime_ledger_source_window_missing", blocker_counts)
        self.assertIn("runtime_ledger_source_refs_missing", blocker_counts)
        self.assertIn("runtime_ledger_trade_decision_refs_missing", blocker_counts)
        self.assertIn("runtime_ledger_execution_refs_missing", blocker_counts)
        self.assertIn(
            "runtime_ledger_execution_order_event_refs_missing", blocker_counts
        )
        self.assertIn("runtime_ledger_source_offsets_missing", blocker_counts)
        self.assertIn("runtime_ledger_source_materialization_missing", blocker_counts)
        self.assertIn("runtime_ledger_authority_class_missing", blocker_counts)

        row.payload_json = self._runtime_ledger_source_authority_payload(
            window_start=window_start,
            window_end=window_end,
            suffix="aggregate-source",
        )
        self.assertTrue(_runtime_ledger_bucket_evidence_grade(row))

    def test_runtime_ledger_diagnostic_splits_route_probe_from_profit_source(
        self,
    ) -> None:
        strategy_row = StrategyRuntimeLedgerBucket(
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
            closed_trade_count=1,
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
            payload_json={"source_decision_mode_counts": {"strategy_signal_paper": 1}},
        )
        route_probe_row = StrategyRuntimeLedgerBucket(
            run_id="diagnostic-runtime-ledger-run",
            candidate_id="candidate-diagnostic",
            hypothesis_id="H-DIAGNOSTIC",
            observed_stage="paper",
            bucket_started_at=datetime(2026, 5, 28, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 5, 28, 15, 30, tzinfo=timezone.utc),
            account_label="TORGHUT_SIM",
            runtime_strategy_name="diagnostic-strategy",
            strategy_family="microbar_pairs",
            fill_count=10,
            decision_count=10,
            submitted_order_count=10,
            closed_trade_count=10,
            open_position_count=1,
            filled_notional=Decimal("1000000"),
            gross_strategy_pnl=Decimal("100001"),
            cost_amount=Decimal("1"),
            net_strategy_pnl_after_costs=Decimal("100000"),
            post_cost_expectancy_bps=None,
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            execution_policy_hash_counts={"policy-a": 1},
            cost_model_hash_counts={"cost-a": 1},
            lineage_hash_counts={"lineage-a": 1},
            blockers_json=["unclosed_position"],
            payload_json={
                "source_decision_mode_counts": {"route_acquisition_probe": 10}
            },
        )

        summary = _runtime_ledger_non_evidence_diagnostic_summary(
            [strategy_row, route_probe_row]
        )

        self.assertEqual(
            summary["source_decision_mode_counts"],
            {"route_acquisition_probe": 10, "strategy_signal_paper": 1},
        )
        self.assertEqual(
            summary["source_decision_mode_bucket_counts"],
            {"route_acquisition_probe": 1, "strategy_signal_paper": 1},
        )
        self.assertEqual(
            summary["profit_proof_eligible_diagnostic"]["net_strategy_pnl_after_costs"],
            "19",
        )
        self.assertEqual(
            summary["non_profit_proof_diagnostic"]["net_strategy_pnl_after_costs"],
            "100000",
        )
        self.assertEqual(
            summary["non_profit_proof_diagnostic"]["source_decision_modes"],
            ["route_acquisition_probe"],
        )

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
        self.assertEqual(
            set(audit["readiness"]["capital_promotion_blockers"]), blockers
        )
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
        account_pre_session = plan["account_pre_session_readiness"]
        self.assertEqual(account_pre_session["state"], "pending_until_pre_session")
        self.assertEqual(account_pre_session["target_count"], 1)
        self.assertEqual(account_pre_session["required_target_count"], 0)
        self.assertEqual(account_pre_session["not_yet_required_target_count"], 1)
        self.assertEqual(account_pre_session["pending_target_count"], 1)
        self.assertEqual(account_pre_session["clean_target_count"], 0)
        self.assertEqual(account_pre_session["blocked_target_count"], 0)
        self.assertEqual(
            account_pre_session["next_required_after"],
            "2026-05-26T13:15:00+00:00",
        )
        self.assertEqual(account_pre_session["blockers"], [])
        clean_window = plan["clean_window_baseline_readiness"]
        self.assertEqual(clean_window["state"], "clean_window_required")
        self.assertEqual(
            clean_window["blockers"],
            ["paper_route_clean_window_baseline_snapshot_pending"],
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
        self.assertEqual(
            payload["runtime_window_import_plan"]["purpose"],
            "next_session_paper_route_runtime_window_evidence_collection",
        )
        self.assertEqual(import_audit["state"], "waiting_for_session_open")
        self.assertEqual(
            import_audit["next_action"],
            "wait_for_regular_session_open",
        )
        self.assertFalse(import_audit["import_ready"])
        self.assertIn(
            "paper_route_session_window_not_open",
            import_audit["blockers"],
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
        self.assertFalse(summary_target["evidence_collection_ok"])
        self.assertFalse(summary_target["canary_collection_authorized"])
        self.assertFalse(summary_target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            summary_target["bounded_evidence_collection_blockers"],
            [
                "paper_route_session_window_not_open",
                "source_strategy_missing",
                "paper_route_clean_window_baseline_snapshot_pending",
            ],
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
                "evidence_collection_ok": False,
                "canary_collection_authorized": False,
                "promotion_allowed": False,
                "capital_promotion_allowed": False,
                "final_promotion_allowed": False,
                "min_runtime_ledger_net_pnl_after_costs": "10000",
                "min_runtime_ledger_daily_net_pnl_after_costs": "500",
                "min_runtime_ledger_trading_days": 20,
                "min_runtime_ledger_closed_round_trips": 300,
                "min_runtime_ledger_filled_notional": "10000000",
                "min_runtime_ledger_median_daily_net_pnl_after_costs": "250",
                "min_runtime_ledger_p10_daily_net_pnl_after_costs": "-250",
                "min_runtime_ledger_worst_day_net_pnl_after_costs": "-750",
                "max_runtime_ledger_drawdown_pct_equity": "0.03",
                "max_runtime_ledger_intraday_drawdown": "1500",
                "max_runtime_ledger_best_day_share": "0.25",
                "max_runtime_ledger_symbol_concentration_share": "0.35",
            },
        )
        self.assertEqual(
            proof_handoff["runtime_window"]["import_audit_state"],
            "waiting_for_session_open",
        )
        self.assertIn(
            "paper_route_session_window_not_open",
            proof_handoff["runtime_window"]["import_blockers"],
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
                "paper_route_session_window_not_open",
                "source_strategy_missing",
                "paper_route_clean_window_baseline_snapshot_pending",
            ],
        )
        self.assertIn(
            "paper_route_runtime_ledger_import_pending",
            target["runtime_ledger_target_metadata_blockers"],
        )

    def test_next_paper_route_targets_surface_source_decision_readiness(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 13, 35, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
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
            self._add_account_position_snapshot(
                session,
                account_label="TORGHUT_SIM",
                as_of=window_start - timedelta(minutes=5),
                positions=[],
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
                                "source_collection_authorized": True,
                                "source_collection_authorization_scope": (
                                    "source_window_evidence_collection_only"
                                ),
                                "source_collection_reason_codes": [
                                    "source_window_evidence_collection_pending"
                                ],
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
        self.assertEqual(
            target["paper_route_clean_window_state"], "clean_window_collection_ready"
        )
        self.assertEqual(
            target["paper_route_clean_window_baseline_state"]["state"], "clean"
        )
        readiness = target["source_decision_readiness"]
        self.assertTrue(readiness["ready"])
        self.assertEqual(readiness["blockers"], [])
        self.assertEqual(target["strategy_name"], "microbar-cross-sectional-pairs-v1")
        self.assertEqual(
            target["runtime_strategy_name"], "microbar-cross-sectional-pairs-v1"
        )
        self.assertEqual(
            target["source_strategy_name"],
            "69cf50e3-4815-47c2-b802-1efbaac09ecb",
        )
        self.assertEqual(
            target["source_runtime_strategy_name"],
            "69cf50e3-4815-47c2-b802-1efbaac09ecb",
        )
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
        self.assertEqual(target["max_notional"], "0")
        self.assertEqual(target["paper_route_probe_next_session_max_notional"], "63180")
        self.assertEqual(target["paper_route_probe_effective_max_notional"], "63180")
        self.assertEqual(
            target["paper_route_probe_symbol_actions"],
            {"AAPL": "buy", "AMZN": "sell"},
        )
        self.assertTrue(target["paper_route_probe_pair_balance_required"])
        self.assertEqual(target["paper_route_probe_pair_balance_state"], "balanced")
        self.assertTrue(target["evidence_collection_ok"])
        self.assertTrue(target["canary_collection_authorized"])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertEqual(target["proof_mode"], "probation")
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            target["bounded_evidence_collection_scope"],
            "paper_route_probe_next_session_only",
        )
        self.assertEqual(target["bounded_evidence_collection_max_notional"], "63180")
        self.assertTrue(target["source_collection_authorized"])
        self.assertEqual(
            target["source_collection_authorization_scope"],
            "source_window_evidence_collection_only",
        )
        self.assertEqual(
            target["source_collection_reason_codes"],
            ["source_window_evidence_collection_pending"],
        )
        self.assertEqual(
            target["source_decision_mode"], "bounded_paper_route_collection"
        )
        self.assertTrue(target["source_decision_mode_profit_proof_eligible"])
        self.assertTrue(target["profit_proof_eligible"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertFalse(target["final_promotion_allowed"])
        summary_target = payload["summary"]["next_paper_route_targets"][0]
        self.assertTrue(summary_target["source_decision_ready"])
        self.assertEqual(summary_target["source_decision_blockers"], [])
        self.assertTrue(summary_target["evidence_collection_ok"])
        self.assertTrue(summary_target["canary_collection_authorized"])
        self.assertFalse(summary_target["capital_promotion_allowed"])
        self.assertEqual(summary_target["proof_mode"], "probation")
        self.assertTrue(summary_target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            summary_target["bounded_evidence_collection_max_notional"], "63180"
        )
        self.assertTrue(summary_target["source_collection_authorized"])
        self.assertEqual(
            summary_target["symbol_actions"], {"AAPL": "buy", "AMZN": "sell"}
        )
        self.assertTrue(summary_target["pair_balance_required"])
        self.assertEqual(summary_target["pair_balance_state"], "balanced")
        self.assertEqual(
            summary_target["source_decision_mode"],
            "bounded_paper_route_collection",
        )
        self.assertTrue(summary_target["profit_proof_eligible"])

    def test_hpairs_next_window_requires_aapl_amzn_pair_legs(self) -> None:
        generated_at = datetime(2026, 5, 24, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="H-PAIRS missing leg fixture",
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
                                "candidate_id": "candidate-hpairs-missing-leg",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "durable_runtime_ledger_bucket",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "paper_route_probe_symbols": ["AAPL"],
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "active": False,
                        "next_session_max_notional": "63180",
                        "eligible_symbol_count": 1,
                        "eligible_symbols": ["AAPL"],
                    },
                },
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 0)
        self.assertEqual(plan["skipped_target_count"], 1)
        blockers = plan["skipped_targets"][0]["missing_or_blocking_fields"]
        self.assertIn("paper_route_hpairs_aapl_amzn_legs_missing", blockers)
        self.assertIn("paper_route_hpairs_amzn_leg_missing", blockers)
        self.assertFalse(plan["promotion_allowed"])
        self.assertFalse(plan["final_promotion_allowed"])

    def test_runtime_window_import_surfaces_stale_quote_submit_blocker(self) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="stale quote route fixture",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                )
            )
            session.add(
                RejectedSignalOutcomeEvent(
                    event_id="paper-route-stale-quote",
                    source="quote_quality_gate",
                    paper_source="paper-arxiv-2605.12151",
                    paper_claim_id="stale-quote",
                    account_label="TORGHUT_SIM",
                    symbol="AAPL",
                    event_ts=window_start + timedelta(minutes=20),
                    timeframe="1Sec",
                    seq="1",
                    reject_reason="stale_quote",
                    outcome_label_status="pending",
                    counterfactual_required=True,
                    required_outcome_fields_json=["executable_quote"],
                    event_payload_json={"event_id": "paper-route-stale-quote"},
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
                                "hypothesis_id": "H-STALE-QUOTE",
                                "candidate_id": "candidate-stale-quote",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-stale-quote.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "paper_route_probe_eligible_symbols": ["AAPL", "AMZN"],
                        "paper_route_probe_active_symbols": ["AAPL", "AMZN"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": True,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 1,
                    },
                },
                generated_at=window_end + timedelta(hours=1),
            )

        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "import_due_source_activity_missing")
        self.assertIn("paper_route_submit_blocked", import_audit["blockers"])
        self.assertIn("paper_route_stale_quote", import_audit["blockers"])
        rejected = payload["next_runtime_window_target_audits"][0][
            "rejected_signal_activity"
        ]
        self.assertIn("source_reject_stale_quote", rejected["blocking_reasons"])

    def test_runtime_window_import_requires_flatten_handoff_after_closed_fills(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        strategy_name = "hpairs-flatten-handoff"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="H-PAIRS flatten handoff fixture",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add(strategy)
            session.flush()
            for index, (symbol, side) in enumerate(
                [("AAPL", "buy"), ("AAPL", "sell"), ("AMZN", "sell"), ("AMZN", "buy")]
            ):
                event_at = window_start + timedelta(minutes=10 + index)
                decision = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol=symbol,
                    timeframe="1Sec",
                    decision_json={
                        "action": side,
                        "qty": "1",
                        "candidate_id": "candidate-flatten-handoff",
                        "hypothesis_id": "H-PAIRS-01",
                    },
                    rationale="H-PAIRS closed route fixture",
                    status="executed",
                    created_at=event_at,
                    executed_at=event_at,
                )
                session.add(decision)
                session.flush()
                execution = Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id=f"flatten-handoff-order-{index}",
                    client_order_id=f"flatten-handoff-{side}-{symbol.lower()}-{index}",
                    symbol=symbol,
                    side=side,
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
                )
                session.add(execution)
                session.flush()
                session.add(
                    ExecutionOrderEvent(
                        event_fingerprint=f"flatten-handoff-fill-{index}",
                        source_topic="trade_updates",
                        source_partition=0,
                        source_offset=200 + index,
                        alpaca_account_label="TORGHUT_SIM",
                        feed_seq=200 + index,
                        event_ts=event_at,
                        symbol=symbol,
                        alpaca_order_id=f"flatten-handoff-order-{index}",
                        client_order_id=f"flatten-handoff-{side}-{symbol.lower()}-{index}",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        filled_qty_delta=Decimal("1"),
                        filled_notional_delta=Decimal("100"),
                        avg_fill_price=Decimal("100"),
                        raw_event={
                            "event": "fill",
                            "side": side,
                            "order": {
                                "id": f"flatten-handoff-order-{index}",
                                "client_order_id": f"flatten-handoff-{side}-{symbol.lower()}-{index}",
                                "symbol": symbol,
                                "side": side,
                                "status": "filled",
                            },
                        },
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        created_at=event_at,
                    )
                )
                session.add(
                    ExecutionTCAMetric(
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        strategy_id=strategy.id,
                        alpaca_account_label="TORGHUT_SIM",
                        symbol=symbol,
                        side=side,
                        arrival_price=Decimal("100"),
                        avg_fill_price=Decimal("100"),
                        filled_qty=Decimal("1"),
                        signed_qty=Decimal("-1") if side == "sell" else Decimal("1"),
                        slippage_bps=Decimal("0"),
                        shortfall_notional=Decimal("0"),
                        realized_shortfall_bps=Decimal("0"),
                        churn_qty=Decimal("0"),
                        churn_ratio=Decimal("0"),
                        computed_at=event_at,
                        created_at=event_at,
                        updated_at=event_at,
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
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-flatten-handoff",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                generated_at=window_end + timedelta(hours=1),
            )

        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "import_due_flatten_handoff_missing")
        self.assertEqual(
            import_audit["next_action"],
            "run_paper_account_flatten_and_persist_position_snapshot",
        )
        self.assertIn("paper_route_flatten_handoff_missing", import_audit["blockers"])
        self.assertIn(
            "paper_route_account_window_close_snapshot_missing",
            import_audit["blockers"],
        )
        close_state = payload["next_runtime_window_target_audits"][0][
            "account_close_state"
        ]
        self.assertFalse(close_state["zero_open_position_evidence"])
        self.assertEqual(
            close_state["flatten_handoff"]["runner"],
            "scripts/flatten_paper_account_positions.py",
        )

    def test_source_backed_runtime_ledger_satisfied_blockers_require_current_evidence(
        self,
    ) -> None:
        def satisfied_blockers(
            *,
            source_reference_blockers: list[str] | None = None,
            closed_round_trip_evidence: bool = True,
            evidence_grade_bucket_count: int = 1,
            closed_trade_count: int = 1,
            open_position_count: int = 0,
            filled_notional: str = "400",
            net_strategy_pnl_after_costs: str = "10",
        ) -> set[str]:
            return (
                paper_route_evidence._source_backed_runtime_ledger_satisfied_blockers(
                    source_activity={
                        "missing": False,
                        "source_lifecycle_blockers": [],
                        "source_reference_blockers": source_reference_blockers or [],
                        "source_lifecycle": {
                            "closed_round_trip_evidence": closed_round_trip_evidence,
                        },
                    },
                    account_close_state={
                        "blockers": [],
                        "zero_open_position_evidence": True,
                    },
                    runtime_ledger={
                        "evidence_grade_bucket_count": evidence_grade_bucket_count,
                        "closed_trade_count": closed_trade_count,
                        "open_position_count": open_position_count,
                        "filled_notional": filled_notional,
                        "net_strategy_pnl_after_costs": net_strategy_pnl_after_costs,
                    },
                )
            )

        satisfied = satisfied_blockers()
        self.assertIn("paper_route_runtime_ledger_import_pending", satisfied)
        self.assertIn("post_cost_pnl_non_positive", satisfied)
        self.assertNotIn(
            "post_cost_pnl_non_positive",
            satisfied_blockers(net_strategy_pnl_after_costs="0"),
        )

        for blockers in (
            satisfied_blockers(source_reference_blockers=["source_ref_missing"]),
            satisfied_blockers(closed_round_trip_evidence=False),
            satisfied_blockers(evidence_grade_bucket_count=0),
            satisfied_blockers(closed_trade_count=0),
            satisfied_blockers(open_position_count=1),
            satisfied_blockers(filled_notional="0"),
        ):
            self.assertEqual(blockers, set())

    def test_successful_bounded_collection_emits_source_backed_import_ready_metadata(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        strategy_name = "hpairs-source-backed-ready"
        candidate_id = "candidate-source-backed-ready"
        stale_import_blockers = [
            "paper_route_runtime_ledger_import_pending",
            "runtime_ledger_candidate_mismatch",
            "runtime_ledger_source_window_evidence_pending",
            "closed_round_trip_missing",
            "runtime_ledger_closed_trades_missing",
            "runtime_ledger_expectancy_missing",
            "runtime_ledger_post_cost_expectancy_missing",
            "unclosed_position",
            "post_cost_pnl_non_positive",
        ]
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="H-PAIRS source-backed import-ready fixture",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add(strategy)
            session.flush()
            for index, (symbol, side) in enumerate(
                [("AAPL", "buy"), ("AAPL", "sell"), ("AMZN", "sell"), ("AMZN", "buy")]
            ):
                event_at = window_start + timedelta(minutes=10 + index)
                decision = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol=symbol,
                    timeframe="1Sec",
                    decision_json={
                        "action": side,
                        "qty": "1",
                        "candidate_id": candidate_id,
                        "hypothesis_id": "H-PAIRS-01",
                    },
                    rationale="H-PAIRS import ready fixture",
                    status="executed",
                    created_at=event_at,
                    executed_at=event_at,
                )
                session.add(decision)
                session.flush()
                execution = Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id=f"source-backed-order-{index}",
                    client_order_id=f"source-backed-{side}-{symbol.lower()}-{index}",
                    symbol=symbol,
                    side=side,
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
                )
                session.add(execution)
                session.flush()
                session.add(
                    ExecutionOrderEvent(
                        event_fingerprint=f"source-backed-fill-{index}",
                        source_topic="trade_updates",
                        source_partition=0,
                        source_offset=index,
                        alpaca_account_label="TORGHUT_SIM",
                        feed_seq=index,
                        event_ts=event_at,
                        symbol=symbol,
                        alpaca_order_id=f"source-backed-order-{index}",
                        client_order_id=f"source-backed-{side}-{symbol.lower()}-{index}",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        filled_qty_delta=Decimal("1"),
                        filled_notional_delta=Decimal("100"),
                        avg_fill_price=Decimal("100"),
                        raw_event={
                            "event": "fill",
                            "side": side,
                            "order": {
                                "id": f"source-backed-order-{index}",
                                "client_order_id": f"source-backed-{side}-{symbol.lower()}-{index}",
                                "symbol": symbol,
                                "side": side,
                                "status": "filled",
                            },
                        },
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        created_at=event_at,
                    )
                )
                session.add(
                    ExecutionTCAMetric(
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        strategy_id=strategy.id,
                        alpaca_account_label="TORGHUT_SIM",
                        symbol=symbol,
                        side=side,
                        arrival_price=Decimal("100"),
                        avg_fill_price=Decimal("100"),
                        filled_qty=Decimal("1"),
                        signed_qty=Decimal("-1") if side == "sell" else Decimal("1"),
                        slippage_bps=Decimal("0"),
                        shortfall_notional=Decimal("0"),
                        realized_shortfall_bps=Decimal("0"),
                        churn_qty=Decimal("0"),
                        churn_ratio=Decimal("0"),
                        computed_at=event_at,
                        created_at=event_at,
                        updated_at=event_at,
                    )
                )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            self._add_flat_account_close_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_end=window_end,
            )
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="source-backed-import-ready",
                    candidate_id=candidate_id,
                    hypothesis_id="H-PAIRS-01",
                    observed_stage="paper",
                    bucket_started_at=window_start,
                    bucket_ended_at=window_end,
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name=strategy_name,
                    strategy_family="microbar_cross_sectional_pairs",
                    fill_count=4,
                    decision_count=4,
                    submitted_order_count=4,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=2,
                    open_position_count=0,
                    filled_notional=Decimal("400"),
                    gross_strategy_pnl=Decimal("12"),
                    cost_amount=Decimal("2"),
                    net_strategy_pnl_after_costs=Decimal("10"),
                    post_cost_expectancy_bps=Decimal("250"),
                    ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                    pnl_basis="realized_strategy_pnl_after_explicit_costs",
                    execution_policy_hash_counts={"policy-a": 4},
                    cost_model_hash_counts={"cost-a": 4},
                    lineage_hash_counts={"lineage-a": 4},
                    blockers_json=[],
                    payload_json=self._runtime_ledger_source_authority_payload(
                        window_start=window_start,
                        window_end=window_end,
                        suffix="source-backed",
                    ),
                )
            )
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="source-backed-import-ready-stale-diagnostic",
                    candidate_id=candidate_id,
                    hypothesis_id="H-PAIRS-01",
                    observed_stage="paper",
                    bucket_started_at=window_start,
                    bucket_ended_at=window_end,
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name=strategy_name,
                    strategy_family="microbar_cross_sectional_pairs",
                    fill_count=4,
                    decision_count=4,
                    submitted_order_count=4,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=0,
                    open_position_count=1,
                    filled_notional=Decimal("400"),
                    gross_strategy_pnl=Decimal("-1"),
                    cost_amount=Decimal("2"),
                    net_strategy_pnl_after_costs=Decimal("-3"),
                    post_cost_expectancy_bps=None,
                    ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                    pnl_basis="realized_strategy_pnl_after_explicit_costs",
                    execution_policy_hash_counts={"policy-a": 4},
                    cost_model_hash_counts={"cost-a": 4},
                    lineage_hash_counts={"lineage-a": 4},
                    blockers_json=stale_import_blockers,
                    payload_json=self._runtime_ledger_source_authority_payload(
                        window_start=window_start,
                        window_end=window_end,
                        suffix="source-backed-stale-diagnostic",
                    ),
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
                                "candidate_id": candidate_id,
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": strategy_name,
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "final_promotion_blockers": [
                                    "paper_probation_evidence_collection_only",
                                    "live_runtime_ledger_required",
                                    *stale_import_blockers,
                                ],
                                "candidate_blockers": [
                                    "paper_probation_evidence_collection_only",
                                    "live_runtime_ledger_required",
                                    "runtime_ledger_source_collection_only",
                                    "runtime_ledger_stage_not_live",
                                    *stale_import_blockers,
                                ],
                                "runtime_ledger_target_metadata_blockers": [
                                    "live_runtime_ledger_required",
                                    "runtime_ledger_source_collection_only",
                                    "runtime_ledger_stage_not_live",
                                    *stale_import_blockers,
                                ],
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
                generated_at=window_end + timedelta(hours=1),
            )

        target_audit = payload["next_runtime_window_target_audits"][0]
        metadata = target_audit["source_backed_import_ready_metadata"]
        self.assertTrue(metadata["ready"])
        self.assertFalse(metadata["synthetic_pnl_used"])
        self.assertEqual(metadata["submitted_order_count"], 4)
        self.assertEqual(metadata["fill_count"], 4)
        self.assertEqual(metadata["filled_notional"], "400")
        self.assertTrue(metadata["closed_round_trip_evidence"])
        self.assertTrue(metadata["zero_open_position_evidence"])
        self.assertGreaterEqual(
            set(metadata["stale_blockers_satisfied_by_source_backed_evidence"]),
            set(stale_import_blockers),
        )
        self.assertEqual(metadata["blockers"], [])
        readiness_blockers = target_audit["readiness"]["blockers"]
        evidence_readback_blockers = target_audit["evidence_readback"]["blockers"]
        import_audit = payload["runtime_window_import_audit"]
        target_blocker_reasons = [
            blocker
            for target_blocker in import_audit["target_blockers"]
            for blocker in target_blocker["blockers"]
        ]
        for stale_blocker in stale_import_blockers:
            self.assertNotIn(stale_blocker, readiness_blockers)
            self.assertNotIn(stale_blocker, evidence_readback_blockers)
            self.assertNotIn(stale_blocker, target_blocker_reasons)
        self.assertIn("live_runtime_ledger_required", readiness_blockers)
        self.assertIn("runtime_ledger_source_collection_only", readiness_blockers)
        self.assertIn("runtime_ledger_stage_not_live", readiness_blockers)
        self.assertEqual(target_audit["readiness"]["evidence_collection_blockers"], [])
        self.assertEqual(
            import_audit["state"],
            "runtime_ledger_ready_for_gate_review",
        )
        self.assertEqual(import_audit["blockers"], [])
        self.assertEqual(
            import_audit["counts"]["targets_with_source_backed_import_ready"],
            1,
        )
        self.assertFalse(payload["runtime_window_import_plan"]["promotion_allowed"])
        self.assertFalse(
            payload["runtime_window_import_plan"]["final_promotion_allowed"]
        )

    def test_strategy_source_decision_readiness_queries_session_without_prefetch(
        self,
    ) -> None:
        with Session(self.engine) as session:
            strategy = Strategy(
                name="session-source-strategy",
                description="source decision session lookup fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "MSFT"],
                max_notional_per_trade=Decimal("25000"),
            )
            session.add(strategy)
            session.commit()
            strategy_id = str(strategy.id)

            readiness = _strategy_source_decision_readiness(
                session,
                strategy_lookup_names=["session-source-strategy"],
                raw_probe_symbols=["AAPL", "GOOG"],
                scoped_probe_symbols=["AAPL"],
            )

        self.assertTrue(readiness["ready"])
        self.assertEqual(readiness["blockers"], [])
        self.assertEqual(
            readiness["matched_strategy"],
            {
                "strategy_id": strategy_id,
                "strategy_name": "session-source-strategy",
                "enabled": True,
                "base_timeframe": "1Min",
                "universe_symbols": ["AAPL", "MSFT"],
                "max_notional_per_trade": "25000",
            },
        )
        self.assertEqual(
            readiness["strategy_lookup_names"], ["session-source-strategy"]
        )
        self.assertEqual(readiness["raw_probe_symbols"], ["AAPL", "GOOG"])
        self.assertEqual(readiness["scoped_probe_symbols"], ["AAPL"])

    def test_next_paper_route_targets_use_family_runtime_harness_from_strategy_id(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 29, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="intraday-tsmom-profit-v3",
                    description="runtime harness strategy",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["NVDA", "AAPL"],
                    max_notional_per_trade=Decimal("25000"),
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
                                "hypothesis_id": "H-TSMOM-LIQ",
                                "candidate_id": "candidate-tsmom",
                                "observed_stage": "paper",
                                "strategy_family": "intraday_tsmom_consistent",
                                "strategy_name": "intraday-tsmom-v2",
                                "runtime_strategy_name": "intraday-tsmom-v2",
                                "strategy_id": "intraday_tsmom_v2@research",
                                "strategy_lookup_names": ["intraday-tsmom-v2"],
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "durable_runtime_ledger_bucket",
                                "source_manifest_ref": "config/trading/hypotheses/h-tsmom-liq.json",
                                "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["NVDA", "AAPL", "MSFT"],
                        "paper_route_probe_active_symbols": [],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": False,
                        "next_session_max_notional": "25000",
                        "eligible_symbol_count": 3,
                        "eligible_symbols": ["NVDA", "AAPL", "MSFT"],
                        "blocking_reasons": ["market_session_closed"],
                    },
                },
                generated_at=generated_at,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["source_decision_readiness"]["ready_target_count"], 1)
        target = plan["targets"][0]
        readiness = target["source_decision_readiness"]
        self.assertTrue(readiness["ready"])
        self.assertEqual(readiness["blockers"], [])
        self.assertEqual(target["strategy_name"], "intraday-tsmom-profit-v3")
        self.assertEqual(target["runtime_strategy_name"], "intraday-tsmom-profit-v3")
        self.assertEqual(target["source_strategy_name"], "intraday-tsmom-v2")
        self.assertEqual(target["source_runtime_strategy_name"], "intraday-tsmom-v2")
        self.assertEqual(
            target["strategy_lookup_names"],
            ["intraday-tsmom-profit-v3", "intraday-tsmom-v2"],
        )
        self.assertEqual(
            readiness["matched_strategy"]["strategy_name"],
            "intraday-tsmom-profit-v3",
        )
        self.assertEqual(readiness["scoped_probe_symbols"], ["NVDA", "AAPL"])
        self.assertEqual(
            target["paper_route_probe_out_of_strategy_scope_symbols"],
            ["MSFT"],
        )

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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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

    def test_live_target_plan_preserves_source_collection_targets_when_audit_unavailable(
        self,
    ) -> None:
        generated_at = datetime(2026, 6, 2, 15, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "source_collection_pending",
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "promotion_eligible_total": 0,
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
                                "source_account_label": "TORGHUT_REPLAY",
                                "source_dsn_env": "SIM_DB_DSN",
                                "target_dsn_env": "SIM_DB_DSN",
                                "source_kind": (
                                    "runtime_ledger_source_collection_candidate"
                                ),
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                                "window_start": "2026-06-02T13:30:00+00:00",
                                "window_end": "2026-06-02T20:00:00+00:00",
                                "source_collection_authorized": True,
                                "source_collection_reason_codes": [
                                    "runtime_ledger_source_decisions_missing"
                                ],
                                "promotion_allowed": True,
                                "final_promotion_authorized": True,
                                "max_notional": "25000",
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
                include_runtime_window_import_audit=False,
                target_account_audit_available=False,
            )

        source_plan = payload["source_runtime_window_import_plan"]
        self.assertEqual(source_plan["target_count"], 1)
        source_target = source_plan["targets"][0]
        self.assertEqual(
            source_target["source_kind"],
            "runtime_ledger_source_collection_candidate",
        )
        self.assertEqual(
            source_target["handoff"],
            "runtime_ledger_source_collection_import",
        )
        self.assertTrue(source_target["source_collection_authorized"])
        self.assertEqual(source_target["source_account_label"], "TORGHUT_REPLAY")
        self.assertEqual(source_target["max_notional"], "0")
        self.assertFalse(source_target["promotion_allowed"])
        self.assertFalse(source_target["final_promotion_allowed"])
        self.assertTrue(source_target["stripped_source_promotion_authority"])

        gate_plan = payload["live_submission_gate"][
            "runtime_ledger_paper_probation_import_plan"
        ]
        self.assertEqual(gate_plan["source_collection_target_count"], 1)
        self.assertEqual(len(gate_plan["targets"]), 1)
        self.assertEqual(
            gate_plan["targets"][0]["handoff"],
            "runtime_ledger_source_collection_import",
        )
        self.assertFalse(gate_plan["targets"][0]["promotion_allowed"])

        self.assertEqual(payload["target_count"], 1)
        self.assertEqual(payload["targets"][0]["handoff"], source_target["handoff"])
        self.assertEqual(payload["summary"]["source_runtime_window_target_count"], 1)
        self.assertEqual(
            payload["summary"]["promotion_authority"]["blockers"],
            ["live_runtime_ledger_required"],
        )

    def test_source_collection_import_plan_sanitizer_filters_and_preserves_refs(
        self,
    ) -> None:
        live_gate = {
            "blocked_reasons": ["runtime_ledger_source_collection_pending"],
        }

        plan = paper_route_evidence._runtime_ledger_source_collection_import_plan_for_payload(
            plan={
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "targets": [
                    {
                        "hypothesis_id": "H-SKIP",
                        "candidate_id": "skip-paper-route",
                        "source_kind": "paper_route_probe_runtime_observed",
                    },
                    {
                        "hypothesis_id": "H-KEEP",
                        "candidate_id": "keep-source-collection",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "source_collection_authorized": "true",
                        "source_account_label": "TORGHUT_REPLAY",
                        "source_dsn_env": "DB_DSN",
                        "target_dsn_env": "SIM_DB_DSN",
                        "runtime_ledger_bucket_ref": (
                            "strategy_runtime_ledger_buckets:run-1:start:end"
                        ),
                        "artifact_refs": [
                            "runtime-ledger/proof.json",
                            "",
                            "runtime-ledger/proof.json",
                        ],
                    },
                    {
                        "hypothesis_id": "H-LIMIT",
                        "candidate_id": "limit-source-collection",
                        "source_kind": "runtime_ledger_source_collection_candidate",
                    },
                ],
            },
            live_submission_gate=live_gate,
            target_limit=1,
        )

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "keep-source-collection")
        self.assertEqual(target["source_account_label"], "TORGHUT_REPLAY")
        self.assertEqual(target["source_dsn_env"], "DB_DSN")
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(
            target["runtime_ledger_bucket_ref"],
            "strategy_runtime_ledger_buckets:run-1:start:end",
        )
        self.assertEqual(target["artifact_refs"], ["runtime-ledger/proof.json"])
        self.assertEqual(target["max_notional"], "0")
        self.assertFalse(target["promotion_allowed"])

        empty_plan = paper_route_evidence._runtime_ledger_source_collection_import_plan_for_payload(
            plan={
                "targets": [
                    {
                        "hypothesis_id": "H-SKIP",
                        "candidate_id": "skip-paper-route",
                        "source_kind": "paper_route_probe_runtime_observed",
                    }
                ],
            },
            live_submission_gate=live_gate,
            target_limit=10,
        )
        self.assertEqual(empty_plan, {})

    def test_source_collection_import_plan_uses_direct_gate_candidates(
        self,
    ) -> None:
        live_gate = {
            "blocked_reasons": ["runtime_ledger_source_collection_pending"],
            "runtime_ledger_source_collection_candidates": [
                {
                    "hypothesis_id": "H-DIRECT",
                    "candidate_id": "direct-source-collection",
                    "observed_stage": "paper",
                    "strategy_family": "intraday_tsmom_consistent",
                    "strategy_name": "intraday-tsmom-profit-v3",
                    "runtime_strategy_name": "intraday-tsmom-profit-v3",
                    "account": "TORGHUT_SIM",
                    "source_account_label": "TORGHUT_SIM",
                    "source_dsn_env": "SIM_DB_DSN",
                    "target_dsn_env": "SIM_DB_DSN",
                    "window_start": "2026-06-02T13:30:00+00:00",
                    "window_end": "2026-06-02T20:00:00+00:00",
                    "source_collection_authorized": True,
                    "source_collection_reason_codes": [
                        "runtime_ledger_source_collection_pending"
                    ],
                    "fill_count": 1,
                    "submitted_order_count": 1,
                    "filled_notional": "100",
                    "promotion_allowed": True,
                    "final_promotion_allowed": True,
                    "max_notional": "25000",
                }
            ],
        }

        plan = paper_route_evidence._runtime_ledger_source_collection_import_plan_for_payload(
            plan={"targets": []},
            live_submission_gate=live_gate,
            target_limit=5,
        )

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["source_collection_target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "direct-source-collection")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")
        self.assertEqual(target["source_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["max_notional"], "0")
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertTrue(target["stripped_source_promotion_authority"])

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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                    "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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

        close_boundary_payload = build(window_end)
        close_boundary_readiness = close_boundary_payload[
            "next_paper_route_runtime_window_targets"
        ]["session_readiness"]
        self.assertEqual(
            close_boundary_readiness["state"],
            "collecting_session_evidence",
        )
        self.assertTrue(close_boundary_readiness["window_open"])
        self.assertFalse(close_boundary_readiness["window_closed"])
        close_boundary_target_audit = close_boundary_payload[
            "next_runtime_window_target_audits"
        ][0]
        close_boundary_close_state = close_boundary_target_audit["account_close_state"]
        self.assertFalse(close_boundary_close_state["required"])
        self.assertEqual(
            close_boundary_close_state["state"],
            "pending_until_window_close",
        )
        self.assertEqual(close_boundary_close_state["blockers"], [])
        close_boundary_import_audit = close_boundary_payload[
            "runtime_window_import_audit"
        ]
        self.assertEqual(
            close_boundary_import_audit["state"],
            "collecting_session_evidence",
        )
        self.assertEqual(
            close_boundary_import_audit["blockers"],
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
        self.assertFalse(settlement_target["evidence_collection_ok"])
        self.assertFalse(settlement_target["bounded_evidence_collection_authorized"])
        self.assertEqual(
            settlement_target["paper_route_session_collection_blockers"],
            ["paper_route_session_settlement_pending"],
        )
        self.assertIn(
            "paper_route_session_settlement_pending",
            settlement_target["bounded_evidence_collection_blockers"],
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                    payload_json=self._runtime_ledger_source_authority_payload(
                        window_start=window_start,
                        window_end=window_end,
                        suffix="ledger-audit-open",
                    ),
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

    def test_runtime_window_import_audit_reports_observed_source_blockers_without_session_readiness(
        self,
    ) -> None:
        audit = paper_route_evidence._runtime_window_import_audit(
            next_targets={
                "target_count": 1,
                "source": "paper_route_observed_strategy_source_collection",
                "targets": [
                    {
                        "hypothesis_id": "H-TSMOM-LIQ-01",
                        "candidate_id": "ca4e6e3c7d639e3363dc5860",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "runtime_strategy_name": "intraday-tsmom-profit-v3",
                        "account_label": "TORGHUT_SIM",
                    }
                ],
            },
            target_audits=[
                {
                    "source_activity": {"missing": False, "decision_count": 8},
                    "runtime_ledger": {
                        "bucket_count": 1,
                        "evidence_grade_bucket_count": 0,
                        "blockers": [
                            "runtime_ledger_source_offsets_missing",
                            "runtime_ledger_source_materialization_missing",
                        ],
                    },
                    "promotion_decisions": {"decision_count": 1},
                }
            ],
            next_target_audits=[
                {
                    "target": {
                        "hypothesis_id": "H-TSMOM-LIQ-01",
                        "candidate_id": "ca4e6e3c7d639e3363dc5860",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "runtime_strategy_name": "intraday-tsmom-profit-v3",
                        "account_label": "TORGHUT_SIM",
                    },
                    "source_activity": {"missing": False, "decision_count": 8},
                    "runtime_ledger": {
                        "bucket_count": 1,
                        "evidence_grade_bucket_count": 0,
                        "blockers": [
                            "runtime_ledger_source_offsets_missing",
                            "runtime_ledger_source_materialization_missing",
                        ],
                    },
                    "promotion_decisions": {"decision_count": 1},
                }
            ],
        )

        self.assertEqual(
            audit["state"], "runtime_ledger_imported_but_not_evidence_grade"
        )
        self.assertEqual(
            audit["next_action"], "repair_runtime_ledger_bucket_authority_or_candidate"
        )
        self.assertFalse(audit["import_ready"])
        self.assertFalse(audit["proof_allowed"])
        self.assertEqual(
            audit["evidence_window_state"],
            "runtime_ledger_evidence_grade_required",
        )
        self.assertEqual(
            audit["blockers"],
            [
                "runtime_ledger_evidence_grade_bucket_missing",
                "runtime_ledger_source_materialization_missing",
                "runtime_ledger_source_offsets_missing",
            ],
        )
        self.assertTrue(
            audit["diagnostics"]["observed_source_evidence_ready_for_diagnostics"]
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                "paper_route_submit_blocked",
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

    def test_source_activity_readback_exposes_rejected_decision_submit_blocker(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="H-PAIRS paper route source strategy",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add(strategy)
            session.flush()
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AAPL",
                    timeframe="1Sec",
                    decision_json={
                        "action": "buy",
                        "qty": "1",
                        "source_candidate_ids": ["c88421d619759b2cfaa6f4d0"],
                        "source_hypothesis_ids": ["H-PAIRS-01"],
                        "source_strategy_names": ["microbar-cross-sectional-pairs-v1"],
                        "risk_reasons": ["missing_executable_quote"],
                        "reject_reason_atomic": ["missing_executable_quote"],
                        "params": {
                            "quote_routeability": {
                                "status": "blocked",
                                "reason": "missing_executable_quote",
                                "readiness": {
                                    "state": "blocked",
                                    "blockers": ["missing_executable_quote"],
                                },
                            }
                        },
                    },
                    rationale="target source decision rejected before submit",
                    status="rejected",
                    created_at=window_start + timedelta(minutes=20),
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
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "c88421d619759b2cfaa6f4d0",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "runtime_strategy_name": (
                                    "microbar-cross-sectional-pairs-v1"
                                ),
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": (
                                    "config/trading/hypotheses/h-pairs-01.json"
                                ),
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_route_probe_symbol_actions": {
                                    "AAPL": "buy",
                                    "AMZN": "sell",
                                },
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
                                "promotion_allowed": False,
                                "final_promotion_authorized": False,
                                "max_notional": "25",
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
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 2,
                    },
                },
                generated_at=datetime(2026, 5, 26, 21, tzinfo=timezone.utc),
            )

        target_audit = payload["next_runtime_window_target_audits"][0]
        source_activity = target_audit["source_activity"]
        self.assertEqual(source_activity["decision_count"], 1)
        self.assertEqual(source_activity["submitted_order_count"], 0)
        self.assertIn(
            "source_reject_missing_executable_quote",
            source_activity["submitted_order_blockers"],
        )
        self.assertIn(
            "source_reject_missing_executable_quote",
            source_activity["missing_reasons"],
        )
        self.assertIn(
            "source_reject_missing_executable_quote",
            target_audit["readiness"]["blockers"],
        )

    def test_hpairs_zero_activity_diagnostics_report_market_window_blocker(
        self,
    ) -> None:
        generated_at = datetime(2026, 5, 26, 12, 0, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="H-PAIRS paper route source strategy",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                    created_at=generated_at,
                    updated_at=generated_at,
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
                    "continuity_reason": "expected_market_closed_staleness",
                    "drift_ok": True,
                    "drift_reason": "drift_live_promotion_eligible",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "c88421d619759b2cfaa6f4d0",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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

        diagnostics = payload["summary"]["hpairs_zero_activity_diagnostics"]
        self.assertEqual(
            diagnostics["schema_version"],
            "torghut.hpairs-zero-activity-diagnostics.v1",
        )
        self.assertEqual(diagnostics["state"], "no_market_window")
        self.assertTrue(diagnostics["reason_flags"]["no_market_window"])
        self.assertFalse(
            diagnostics["reason_flags"]["no_candidate_target_materialization"]
        )
        self.assertFalse(diagnostics["reason_flags"]["paper_route_disabled"])
        self.assertEqual(diagnostics["counts"]["hpairs_target_count"], 1)
        self.assertEqual(diagnostics["counts"]["hpairs_symbol_count"], 2)
        self.assertEqual(diagnostics["counts"]["hpairs_decision_count"], 0)
        self.assertIn("market_session_closed", diagnostics["blockers"])
        self.assertNotIn("c88421d619759b2cfaa6f4d0", diagnostics["blockers"])
        self.assertNotIn("H-PAIRS-01", diagnostics["blockers"])
        self.assertNotIn("AAPL", diagnostics["blockers"])
        self.assertNotIn("AMZN", diagnostics["blockers"])
        self.assertNotIn("TORGHUT_SIM", diagnostics["blockers"])
        self.assertFalse(diagnostics["safe_to_promote"])
        self.assertFalse(diagnostics["proof_semantics"]["synthetic_orders_or_fills"])
        stage_diagnostics = diagnostics["source_activity_stage_diagnostics"]
        self.assertFalse(stage_diagnostics["source_decisions_present"])
        self.assertFalse(stage_diagnostics["source_executions_present"])
        self.assertFalse(stage_diagnostics["source_tca_present"])
        self.assertFalse(stage_diagnostics["runtime_ledger_buckets_present"])
        self.assertIn("source_decisions_missing", stage_diagnostics["blockers"])
        self.assertNotIn("source_executions_missing", stage_diagnostics["blockers"])
        self.assertNotIn("source_tca_missing", stage_diagnostics["blockers"])
        self.assertIn("runtime_ledger_bucket_missing", stage_diagnostics["blockers"])

    def test_hpairs_zero_activity_reason_flags_distinguish_source_stages(
        self,
    ) -> None:
        no_decisions = _hpairs_zero_activity_reason_flags(
            blockers=["source_decisions_missing", "runtime_ledger_bucket_missing"],
            probe={"configured_enabled": True},
            runtime_window_import_audit={"state": "import_due_source_activity_missing"},
            hpairs_target_count=1,
            hpairs_symbol_count=2,
            hpairs_source_decision_ready_count=1,
            hpairs_decision_count=0,
            hpairs_submitted_order_count=0,
            hpairs_tca_sample_count=0,
            hpairs_runtime_bucket_count=0,
        )
        self.assertTrue(no_decisions["source_decisions_missing"])
        self.assertFalse(no_decisions["source_executions_missing"])
        self.assertFalse(no_decisions["source_tca_missing"])
        self.assertTrue(no_decisions["runtime_ledger_bucket_missing"])

        decisions_without_execution = _hpairs_zero_activity_reason_flags(
            blockers=[],
            probe={"configured_enabled": True},
            runtime_window_import_audit={"import_ready": True},
            hpairs_target_count=1,
            hpairs_symbol_count=2,
            hpairs_source_decision_ready_count=1,
            hpairs_decision_count=2,
            hpairs_submitted_order_count=0,
            hpairs_tca_sample_count=0,
            hpairs_runtime_bucket_count=0,
        )
        self.assertFalse(decisions_without_execution["source_decisions_missing"])
        self.assertTrue(decisions_without_execution["source_executions_missing"])
        self.assertFalse(decisions_without_execution["source_tca_missing"])
        self.assertTrue(decisions_without_execution["runtime_ledger_bucket_missing"])

        closed_import_ready_window = _hpairs_zero_activity_reason_flags(
            blockers=[
                "market_session_closed",
                "paper_route_session_window_not_open",
                "source_executions_missing",
            ],
            probe={"configured_enabled": True},
            runtime_window_import_audit={
                "import_ready": True,
                "session_state": "window_closed_import_ready",
                "state": "runtime_ledger_imported_but_not_evidence_grade",
            },
            hpairs_target_count=1,
            hpairs_symbol_count=2,
            hpairs_source_decision_ready_count=1,
            hpairs_decision_count=2,
            hpairs_submitted_order_count=0,
            hpairs_tca_sample_count=0,
            hpairs_runtime_bucket_count=0,
        )
        self.assertFalse(closed_import_ready_window["no_market_window"])
        self.assertTrue(closed_import_ready_window["source_executions_missing"])
        self.assertEqual(
            _hpairs_zero_activity_state(closed_import_ready_window),
            "source_ledger_import_not_running",
        )

        stale_stage_blockers_with_decisions = _hpairs_zero_activity_reason_flags(
            blockers=[
                "source_decisions_missing",
                "source_executions_missing",
                "source_tca_missing",
                "runtime_ledger_bucket_missing",
            ],
            probe={"configured_enabled": True},
            runtime_window_import_audit={"import_ready": True},
            hpairs_target_count=1,
            hpairs_symbol_count=2,
            hpairs_source_decision_ready_count=1,
            hpairs_decision_count=2,
            hpairs_submitted_order_count=0,
            hpairs_tca_sample_count=0,
            hpairs_runtime_bucket_count=0,
        )
        self.assertFalse(
            stale_stage_blockers_with_decisions["source_decisions_missing"]
        )
        self.assertTrue(
            stale_stage_blockers_with_decisions["source_executions_missing"]
        )
        self.assertFalse(stale_stage_blockers_with_decisions["source_tca_missing"])

        executions_without_tca = _hpairs_zero_activity_reason_flags(
            blockers=[],
            probe={"configured_enabled": True},
            runtime_window_import_audit={"import_ready": True},
            hpairs_target_count=1,
            hpairs_symbol_count=2,
            hpairs_source_decision_ready_count=1,
            hpairs_decision_count=2,
            hpairs_submitted_order_count=2,
            hpairs_tca_sample_count=0,
            hpairs_runtime_bucket_count=0,
        )
        self.assertFalse(executions_without_tca["source_decisions_missing"])
        self.assertFalse(executions_without_tca["source_executions_missing"])
        self.assertTrue(executions_without_tca["source_tca_missing"])
        self.assertTrue(executions_without_tca["runtime_ledger_bucket_missing"])

    def test_source_activity_stage_diagnostics_exposes_runtime_bucket_absence(
        self,
    ) -> None:
        diagnostics = _source_activity_stage_diagnostics(
            source_activity={
                "decision_count": 2,
                "execution_count": 2,
                "tca_sample_count": 1,
                "stage_presence": {
                    "source_decisions_present": True,
                    "submitted_lifecycle_present": True,
                    "runtime_execution_economics_present": True,
                },
            },
            runtime_ledger={"bucket_count": 0},
        )

        self.assertTrue(diagnostics["source_decisions_present"])
        self.assertTrue(diagnostics["source_executions_present"])
        self.assertTrue(diagnostics["source_tca_present"])
        self.assertFalse(diagnostics["runtime_ledger_buckets_present"])
        self.assertEqual(diagnostics["blockers"], ["runtime_ledger_bucket_missing"])

    def test_hpairs_zero_activity_diagnostics_surface_route_vetoes(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="H-PAIRS paper route source strategy",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                    created_at=window_start,
                    updated_at=window_start,
                )
            )
            session.add(
                RejectedSignalOutcomeEvent(
                    event_id="hpairs-reject-aapl",
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
                    event_payload_json={"event_id": "hpairs-reject-aapl"},
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
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": True,
                    "continuity_reason": "signals_present",
                    "drift_ok": True,
                    "drift_reason": "drift_live_promotion_eligible",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "c88421d619759b2cfaa6f4d0",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["AAPL", "AMZN"],
                        "paper_route_probe_active_symbols": ["AAPL", "AMZN"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": True,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 2,
                    },
                },
                generated_at=datetime(2026, 5, 26, 21, 0, tzinfo=timezone.utc),
            )

        diagnostics = payload["summary"]["hpairs_zero_activity_diagnostics"]
        self.assertTrue(diagnostics["reason_flags"]["route_veto"])
        self.assertIn("source_reject_spread_bps_exceeded", diagnostics["blockers"])
        self.assertEqual(diagnostics["counts"]["hpairs_decision_count"], 0)
        self.assertEqual(diagnostics["counts"]["hpairs_submitted_order_count"], 0)
        self.assertFalse(diagnostics["safe_to_promote"])

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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed",
                source_topic="trade_updates",
                source_partition=0,
                alpaca_account_label="TORGHUT_SIM",
                assignment_mode="group",
                collector_identity="test-order-feed",
                source_revision="alpaca_trade_updates_v1",
                window_started_at=event_at,
                window_ended_at=event_at,
                start_offset=1,
                end_offset=1,
                consumed_count=1,
                inserted_count=1,
                status="inserted",
                status_reason="linked_execution_and_decision",
                payload_json={
                    "source_ref": {
                        "topic": "trade_updates",
                        "partition": 0,
                        "offset": 1,
                    },
                    "source_coverage_complete": True,
                    "promotion_authority_eligible": False,
                },
            )
            session.add(source_window)
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
                    source_window_id=source_window.id,
                    created_at=event_at,
                )
            )
            decision_ref = str(decision.id)
            execution_ref = str(execution.id)
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
        self.assertEqual(source_activity["source_window_count"], 1)
        self.assertEqual(source_activity["linked_source_window_count"], 1)
        self.assertEqual(len(source_activity["source_window_refs"]), 1)
        self.assertEqual(
            source_activity["source_offset_refs"],
            [{"topic": "trade_updates", "partition": 0, "offset": 1}],
        )
        self.assertEqual(source_activity["last_order_event_at"], event_at.isoformat())
        self.assertEqual(source_activity["missing_reasons"], [])
        self.assertEqual(source_activity["decision_refs"], [decision_ref])
        self.assertEqual(source_activity["execution_refs"], [execution_ref])
        self.assertEqual(len(source_activity["order_lifecycle_refs"]), 1)
        self.assertIn(
            "source_explicit_costs_missing",
            source_activity["source_reference_blockers"],
        )
        self.assertNotIn(
            "source_window_refs_missing",
            source_activity["source_reference_blockers"],
        )
        self.assertNotIn(
            "source_offsets_missing",
            source_activity["source_reference_blockers"],
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "import_due_runtime_ledger_missing")
        self.assertEqual(import_audit["counts"]["targets_with_source_activity"], 1)
        self.assertNotIn(
            "paper_route_source_activity_missing", import_audit["blockers"]
        )
        self.assertNotIn("source_tca_missing", import_audit["blockers"])

    def test_source_activity_signs_order_feed_fills_from_linked_execution_side(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        event_at = window_start + timedelta(minutes=20)
        strategy_name = "order-feed-linked-side"
        candidate_id = "candidate-linked-side"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="paper route source activity signs linked execution side",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add(strategy)
            session.flush()
            source_window = OrderFeedSourceWindow(
                consumer_group="torghut-order-feed",
                source_topic="trade_updates",
                source_partition=0,
                alpaca_account_label="TORGHUT_SIM",
                assignment_mode="group",
                collector_identity="test-order-feed",
                source_revision="alpaca_trade_updates_v1",
                window_started_at=event_at,
                window_ended_at=event_at + timedelta(minutes=1),
                start_offset=10,
                end_offset=11,
                consumed_count=2,
                inserted_count=2,
                status="inserted",
                status_reason="linked_execution_and_decision",
                payload_json={},
            )
            session.add(source_window)
            session.flush()
            for index, side in enumerate(("buy", "sell"), start=1):
                opaque_order_id = f"linked-side-order-{index}"
                opaque_client_order_id = f"linked-side-client-{index}"
                decision = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json={
                        "action": side,
                        "qty": "1",
                        "candidate_id": candidate_id,
                        "hypothesis_id": "H-LINKED-SIDE",
                    },
                    rationale="linked execution side fixture",
                    status="executed",
                    created_at=event_at + timedelta(seconds=index),
                    executed_at=event_at + timedelta(seconds=index),
                )
                session.add(decision)
                session.flush()
                execution = Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id=opaque_order_id,
                    client_order_id=opaque_client_order_id,
                    symbol="AAPL",
                    side=side,
                    order_type="limit",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    status="filled",
                    raw_order={},
                    created_at=event_at + timedelta(seconds=index),
                    updated_at=event_at + timedelta(seconds=index),
                    last_update_at=event_at + timedelta(seconds=index),
                    order_feed_last_event_ts=event_at + timedelta(seconds=index),
                )
                session.add(execution)
                session.flush()
                session.add(
                    ExecutionOrderEvent(
                        event_fingerprint=f"linked-side-fill-event-{side}",
                        source_topic="trade_updates",
                        source_partition=0,
                        source_offset=10 + index,
                        alpaca_account_label="TORGHUT_SIM",
                        feed_seq=10 + index,
                        event_ts=event_at + timedelta(seconds=index),
                        symbol="AAPL",
                        alpaca_order_id=opaque_order_id,
                        client_order_id=opaque_client_order_id,
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        filled_qty_delta=Decimal("1"),
                        avg_fill_price=Decimal("100"),
                        filled_notional_delta=Decimal("100"),
                        raw_event={
                            "event": "fill",
                            "order": {
                                "id": opaque_order_id,
                                "client_order_id": opaque_client_order_id,
                                "symbol": "AAPL",
                                "status": "filled",
                                "qty": "1",
                                "filled_qty": "1",
                                "filled_avg_price": "100",
                            },
                        },
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        source_window_id=source_window.id,
                        created_at=event_at + timedelta(seconds=index),
                    )
                )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            self._add_flat_account_close_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_end=window_end,
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
                                "hypothesis_id": "H-LINKED-SIDE",
                                "candidate_id": candidate_id,
                                "observed_stage": "paper",
                                "strategy_family": "intraday_tsmom_consistent",
                                "strategy_name": strategy_name,
                                "source_kind": "paper_route_probe_runtime_observed",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-linked-side.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL"],
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
        lifecycle = source_activity["source_lifecycle"]
        self.assertEqual(source_activity["execution_count"], 2)
        self.assertEqual(source_activity["fill_order_event_count"], 2)
        self.assertEqual(lifecycle["net_filled_qty_by_symbol"], {"AAPL": "0"})
        self.assertEqual(lifecycle["open_symbols_after_source_fills"], [])
        self.assertTrue(lifecycle["closed_round_trip_evidence"])
        self.assertNotIn(
            "source_close_missing",
            source_activity["source_lifecycle_blockers"],
        )
        self.assertNotIn(
            "source_closed_round_trip_missing",
            source_activity["source_lifecycle_blockers"],
        )

    def test_hpairs_collection_blocks_missing_lifecycle_costs_and_flatten(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        event_at = window_start + timedelta(minutes=20)
        strategy_name = "hpairs-missing-roundtrip"
        candidate_id = "candidate-hpairs-missing-roundtrip"
        with Session(self.engine) as session:
            strategy = Strategy(
                name=strategy_name,
                description="H-PAIRS missing round-trip fixture",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add(strategy)
            session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": candidate_id,
                    "hypothesis_id": "H-PAIRS-01",
                },
                rationale="H-PAIRS missing round-trip fixture",
                status="executed",
                created_at=event_at,
                executed_at=event_at,
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="hpairs-missing-roundtrip-order",
                client_order_id="hpairs-missing-roundtrip-client",
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
            )
            session.add(execution)
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            session.flush()
            decision_ref = str(decision.id)
            execution_ref = str(execution.id)
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
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": candidate_id,
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": strategy_name,
                                "runtime_strategy_name": strategy_name,
                                "source_kind": "paper_route_probe_runtime_observed",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "paper_route_probe_active_symbols": ["AAPL", "AMZN"],
                    },
                    "paper_route_probe": {
                        "configured_enabled": True,
                        "active": True,
                        "next_session_max_notional": "25",
                        "eligible_symbol_count": 2,
                    },
                },
                generated_at=window_end + timedelta(hours=2),
            )

        source_activity = payload["targets"][0]["source_activity"]
        self.assertTrue(source_activity["missing"])
        self.assertEqual(source_activity["decision_refs"], [decision_ref])
        self.assertEqual(source_activity["execution_refs"], [execution_ref])
        self.assertEqual(source_activity["order_lifecycle_refs"], [])
        self.assertIn(
            "source_order_lifecycle_refs_missing",
            source_activity["source_reference_blockers"],
        )
        self.assertIn(
            "source_explicit_costs_missing",
            source_activity["source_reference_blockers"],
        )
        for blocker in (
            "source_order_lifecycle_refs_missing",
            "source_explicit_costs_missing",
            "source_close_missing",
            "source_closed_round_trip_missing",
        ):
            self.assertIn(blocker, source_activity["source_lifecycle_blockers"])
        readiness = payload["targets"][0]["readiness"]
        self.assertEqual(readiness["state"], "evidence_collection_blocked")
        self.assertFalse(readiness["evidence_collection_ok"])
        self.assertFalse(readiness["capital_promotion_allowed"])
        self.assertFalse(readiness["final_authority_ok"])
        self.assertIn("source_tca_missing", readiness["evidence_collection_blockers"])
        self.assertIn("runtime_ledger_bucket_missing", readiness["blockers"])
        self.assertIn(
            "runtime_ledger_evidence_grade_bucket_missing",
            readiness["blockers"],
        )
        self.assertFalse(readiness["promotion_authority"]["allowed"])
        self.assertFalse(readiness["promotion_authority"]["final_authority_ok"])

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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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

            with patch(
                "app.trading.paper_route_evidence.settings.trading_account_label",
                "other-paper",
            ):
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
                                    "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
        account_diagnostics = payload["targets"][0][
            "source_activity_account_diagnostics"
        ]
        self.assertTrue(account_diagnostics["diagnostic_only"])
        self.assertEqual(
            account_diagnostics["readiness_authority"],
            "not_used_for_import_or_promotion_readiness",
        )
        self.assertFalse(account_diagnostics["target_scope_activity_present"])
        self.assertTrue(account_diagnostics["configured_account_activity_present"])
        self.assertTrue(account_diagnostics["alternate_account_activity_present"])
        self.assertTrue(
            account_diagnostics["alternate_account_target_strategy_activity_present"]
        )
        self.assertIn(
            "source_activity_on_non_target_account",
            account_diagnostics["scope_mismatch_reasons"],
        )
        configured_account_summary = next(
            item
            for item in account_diagnostics["account_summaries"]
            if item["account_label"] == "other-paper"
        )
        self.assertEqual(configured_account_summary["decision_count"], 1)
        self.assertEqual(configured_account_summary["execution_count"], 1)
        self.assertEqual(configured_account_summary["tca_sample_count"], 1)
        self.assertEqual(
            configured_account_summary["target_strategy_decision_count"], 1
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
                        payload_json=self._runtime_ledger_source_authority_payload(
                            window_start=window_start,
                            window_end=window_end,
                            suffix="active-grade",
                        ),
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
                        payload_json=self._runtime_ledger_source_authority_payload(
                            window_start=window_start,
                            window_end=window_end,
                            suffix="active-open",
                        ),
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
        self.assertFalse(gate_plan["stripped_source_promotion_authority"])
        audit = payload["targets"][0]
        self.assertFalse(audit["target"]["promotion_allowed"])
        self.assertFalse(audit["target"]["final_promotion_allowed"])
        self.assertTrue(audit["target"]["stripped_source_promotion_authority"])
        self.assertNotIn("source_promotion_allowed", audit["target"])
        self.assertNotIn("source_final_promotion_allowed", audit["target"])
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
                "paper_route_submit_blocked",
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
                "final_authority_ok": False,
                "reason": "paper_route_evidence_audit_observability_only",
                "stripped_source_promotion_authority": True,
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
        self.assertEqual(
            payload["summary"]["stripped_source_promotion_authority_count"], 1
        )
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

            live_submission_gate = {
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
                            "paper_probation_satisfied_for_bounded_live_paper_collection": True,
                        }
                    ],
                },
            }
            route_reacquisition_book = {
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
            }

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate=live_submission_gate,
                route_reacquisition_book=route_reacquisition_book,
                generated_at=now,
            )
            target_plan_payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate=live_submission_gate,
                route_reacquisition_book=route_reacquisition_book,
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
        self.assertEqual(
            contamination["reason"], "unlinked_account_order_events_present"
        )
        self.assertEqual(
            contamination["sample_order_event_refs"][0]["event_fingerprint"],
            "external-autonomous-trader-order-event",
        )
        self.assertIn(
            "paper_route_account_contamination_detected",
            audit["readiness"]["blockers"],
        )
        contract = audit["evidence_window_contract"]
        self.assertEqual(contract["state"], "contaminated_window_discarded")
        self.assertEqual(contract["reason"], "unlinked_account_order_events_present")
        self.assertFalse(contract["proof_allowed"])
        self.assertFalse(contract["promotion_allowed"])
        self.assertFalse(contract["final_promotion_allowed"])
        self.assertEqual(
            contract["sample_order_event_refs"][0]["client_order_id"],
            "autonomous-trader-AAPL-cover-external-1",
        )
        latest_closed_selection = payload[
            "latest_closed_runtime_window_import_selection"
        ]
        self.assertFalse(latest_closed_selection["selected"])
        self.assertEqual(
            latest_closed_selection["state"],
            "rejected_contaminated_or_unclean",
        )
        self.assertEqual(
            latest_closed_selection["reason"],
            "latest_closed_window_must_be_discarded",
        )
        self.assertTrue(latest_closed_selection["source_backed_evidence_present"])
        self.assertFalse(latest_closed_selection["clean_window_importable"])
        self.assertIn(
            "unlinked_order_events_present",
            latest_closed_selection["discard_blockers"],
        )
        self.assertEqual(
            latest_closed_selection["sample_client_order_ids"],
            ["autonomous-trader-AAPL-cover-external-1"],
        )
        followup_plan = payload[
            "next_clean_paper_route_runtime_window_targets_after_discard"
        ]
        self.assertEqual(
            followup_plan["purpose"],
            "next_clean_session_paper_route_runtime_window_collection_after_discard",
        )
        self.assertEqual(
            followup_plan["session_window"]["start"],
            "2026-05-27T13:30:00+00:00",
        )
        self.assertEqual(
            followup_plan["session_window"]["end"],
            "2026-05-27T20:00:00+00:00",
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(
            import_audit["state"],
            "waiting_for_session_open",
        )
        self.assertEqual(
            import_audit["evidence_window_state"], "clean_window_collection_pending"
        )
        self.assertFalse(import_audit["proof_allowed"])
        self.assertEqual(
            import_audit["next_action"],
            "wait_for_regular_session_open",
        )
        self.assertIn("paper_route_session_window_not_open", import_audit["blockers"])
        self.assertEqual(
            import_audit["session_window"]["start"], "2026-05-27T13:30:00+00:00"
        )
        target_plan_import_audit = target_plan_payload["runtime_window_import_audit"]
        self.assertEqual(
            target_plan_import_audit["state"],
            "waiting_for_session_open",
        )
        target_plan_selection = target_plan_payload[
            "latest_closed_runtime_window_import_selection"
        ]
        self.assertFalse(target_plan_selection["selected"])
        self.assertEqual(
            target_plan_selection["state"],
            "rejected_contaminated_or_unclean",
        )
        self.assertIn(
            "paper_route_session_window_not_open",
            target_plan_payload["summary"]["runtime_window_import_audit_blockers"],
        )
        self.assertEqual(
            target_plan_import_audit["evidence_window_state"],
            "clean_window_collection_pending",
        )
        self.assertEqual(
            target_plan_payload["runtime_window_import_plan"]["purpose"],
            "next_clean_session_paper_route_runtime_window_collection_after_discard",
        )
        self.assertEqual(
            target_plan_payload["purpose"],
            "next_clean_session_paper_route_runtime_window_collection_after_discard",
        )
        self.assertEqual(
            target_plan_payload["targets"][0]["paper_route_probe_window_start"],
            "2026-05-27T13:30:00+00:00",
        )
        self.assertEqual(
            target_plan_payload["targets"][0]["paper_route_clean_window_state"],
            "clean_window_required",
        )
        self.assertEqual(
            target_plan_payload["targets"][0][
                "paper_route_account_contamination_blockers"
            ],
            [],
        )

    def test_active_window_contamination_blocks_target_plan_collection(self) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 18, 5, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            strategy = Strategy(
                name="active-contamination-proof-strategy",
                description="active paper account contamination fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add(strategy)
            session.flush()
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="active-external-autonomous-trader-event",
                    source_topic="alpaca.trade_updates",
                    source_partition=0,
                    source_offset=42,
                    alpaca_account_label="TORGHUT_SIM",
                    event_ts=window_start + timedelta(minutes=20),
                    symbol="AAPL",
                    alpaca_order_id="active-external-order-1",
                    client_order_id="autonomous-trader-AAPL-cover-active-1",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("101"),
                    raw_event={"source": "external_autonomous_trader"},
                    execution_id=None,
                    trade_decision_id=None,
                )
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            session.commit()

            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.runtime-ledger-paper-probation-import-plan.v1"
                        ),
                        "target_count": "1",
                        "targets": [
                            {
                                "hypothesis_id": "H-CONTAMINATION",
                                "candidate_id": "candidate-contamination",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": strategy.name,
                                "strategy_id": "active_contamination_strategy@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": (
                                    "config/trading/hypotheses/h-contamination.json"
                                ),
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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

        target = payload["next_paper_route_runtime_window_targets"]["targets"][0]
        self.assertFalse(target["evidence_collection_ok"])
        self.assertFalse(target["canary_collection_authorized"])
        self.assertFalse(target["bounded_live_paper_collection_authorized"])
        self.assertEqual(
            target["paper_route_clean_window_state"],
            "contaminated_window_discarded",
        )
        self.assertIn(
            "paper_route_account_contamination_detected",
            target["paper_route_account_contamination_blockers"],
        )
        self.assertIn(
            "unlinked_order_events_present",
            target["bounded_evidence_collection_blockers"],
        )
        contamination_readiness = payload["next_paper_route_runtime_window_targets"][
            "account_contamination_readiness"
        ]
        self.assertEqual(
            contamination_readiness["state"], "contaminated_window_discarded"
        )
        self.assertEqual(contamination_readiness["contaminated_target_count"], 1)
        self.assertEqual(contamination_readiness["unlinked_order_event_count"], 1)
        self.assertEqual(
            contamination_readiness["sample_client_order_ids"],
            ["autonomous-trader-AAPL-cover-active-1"],
        )
        self.assertEqual(
            contamination_readiness["sample_order_event_refs"][0]["event_fingerprint"],
            "active-external-autonomous-trader-event",
        )

    def test_active_window_foreign_linked_order_events_block_target_plan_collection(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 18, 5, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            target_strategy = Strategy(
                name="hpairs-target-contamination-strategy",
                description="target bounded paper route strategy",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                created_at=window_start,
                updated_at=window_start,
            )
            foreign_strategy = Strategy(
                name="intraday-tsmom-profit-v3",
                description="foreign paper account strategy",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add_all([target_strategy, foreign_strategy])
            session.flush()
            foreign_decision = TradeDecision(
                strategy_id=foreign_strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-tsmom",
                    "hypothesis_id": "H-TSMOM-LIQ",
                },
                rationale="foreign linked paper route contamination fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=5),
                executed_at=window_start + timedelta(minutes=6),
            )
            session.add(foreign_decision)
            session.flush()
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="foreign-linked-tsmom-paper-event",
                    source_topic="alpaca.trade_updates",
                    source_partition=0,
                    source_offset=43,
                    alpaca_account_label="TORGHUT_SIM",
                    event_ts=window_start + timedelta(minutes=20),
                    symbol="AAPL",
                    alpaca_order_id="foreign-linked-order-1",
                    client_order_id="tsmom-AAPL-foreign-linked-1",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("101"),
                    raw_event={"source": "foreign_tsmom_strategy"},
                    execution_id=None,
                    trade_decision_id=foreign_decision.id,
                )
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            session.commit()

            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.runtime-ledger-paper-probation-import-plan.v1"
                        ),
                        "target_count": "1",
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-hpairs",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": target_strategy.name,
                                "strategy_id": "hpairs_target_strategy@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": (
                                    "config/trading/hypotheses/h-pairs-01.json"
                                ),
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "effective_max_notional": 25,
                        "next_session_max_notional": 25,
                        "eligible_symbols": ["AAPL", "AMZN"],
                    },
                },
                generated_at=now,
            )

        target = payload["next_paper_route_runtime_window_targets"]["targets"][0]
        contamination = target["paper_route_account_contamination_state"]
        self.assertTrue(contamination["contaminated"])
        self.assertEqual(contamination["unlinked_order_event_count"], 0)
        self.assertEqual(contamination["foreign_linked_order_event_count"], 1)
        self.assertEqual(contamination["target_linked_order_event_count"], 0)
        self.assertEqual(
            contamination["foreign_strategy_counts"],
            {"intraday-tsmom-profit-v3": 1},
        )
        self.assertEqual(
            contamination["reason"], "foreign_account_order_events_present"
        )
        self.assertEqual(
            contamination["sample_order_event_refs"][0]["strategy_name"],
            "intraday-tsmom-profit-v3",
        )
        self.assertFalse(target["evidence_collection_ok"])
        self.assertIn(
            "foreign_order_events_present",
            target["bounded_evidence_collection_blockers"],
        )
        contamination_readiness = payload["next_paper_route_runtime_window_targets"][
            "account_contamination_readiness"
        ]
        self.assertEqual(
            contamination_readiness["state"], "contaminated_window_discarded"
        )
        self.assertEqual(contamination_readiness["contaminated_target_count"], 1)
        self.assertEqual(contamination_readiness["foreign_linked_order_event_count"], 1)
        self.assertEqual(
            contamination_readiness["sample_order_event_refs"][0]["client_order_id"],
            "tsmom-AAPL-foreign-linked-1",
        )

    def test_target_plan_uses_observed_foreign_strategy_source_collection(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, 5, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            target_strategy = Strategy(
                name="hpairs-target-observed-contamination-strategy",
                description="target bounded paper route strategy",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                created_at=window_start,
                updated_at=window_start,
            )
            foreign_strategy = Strategy(
                name="intraday-tsmom-profit-v3",
                description="observed paper account strategy",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN", "INTC"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add_all([target_strategy, foreign_strategy])
            session.flush()
            foreign_decision = TradeDecision(
                strategy_id=foreign_strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-tsmom",
                    "hypothesis_id": "H-TSMOM-LIQ-01",
                },
                rationale="observed foreign source collection fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=5),
                executed_at=window_start + timedelta(minutes=6),
            )
            session.add(foreign_decision)
            session.flush()
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="observed-tsmom-paper-event",
                    source_topic="alpaca.trade_updates",
                    source_partition=0,
                    source_offset=44,
                    alpaca_account_label="TORGHUT_SIM",
                    event_ts=window_start + timedelta(minutes=20),
                    symbol="AAPL",
                    alpaca_order_id="observed-tsmom-order-1",
                    client_order_id="tsmom-AAPL-observed-1",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("101"),
                    raw_event={"source": "foreign_tsmom_strategy"},
                    execution_id=None,
                    trade_decision_id=foreign_decision.id,
                )
            )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            session.commit()

            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": "true",
                    "continuity_reason": "expected_market_closed_staleness",
                    "drift_ok": "false",
                    "drift_reason": "drift_live_promotion_ineligible",
                    "runtime_ledger_repair_candidates": [
                        {
                            "hypothesis_id": "H-TSMOM-LIQ-01",
                            "candidate_id": "candidate-tsmom",
                            "observed_stage": "paper",
                            "strategy_family": "intraday_tsmom_consistent",
                            "strategy_name": "intraday-tsmom-profit-v3",
                            "runtime_strategy_name": "intraday-tsmom-profit-v3",
                            "strategy_id": "intraday_tsmom_v2@research",
                            "account": "TORGHUT_SIM",
                            "dataset_snapshot_ref": (
                                "portfolio-profit-autoresearch-500-v1"
                            ),
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-tsmom-liq-01.json"
                            ),
                            "fill_count": 1,
                            "submitted_order_count": 1,
                            "filled_notional": "101",
                            "reason_codes": [
                                "runtime_ledger_source_collection_pending",
                                "closed_round_trip_missing",
                            ],
                        }
                    ],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.runtime-ledger-paper-probation-import-plan.v1"
                        ),
                        "target_count": "1",
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-hpairs",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": target_strategy.name,
                                "strategy_id": "hpairs_target_strategy@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": (
                                    "config/trading/hypotheses/h-pairs-01.json"
                                ),
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "effective_max_notional": 25,
                        "next_session_max_notional": 25,
                        "eligible_symbols": ["AAPL", "AMZN"],
                    },
                },
                generated_at=now,
            )

        runtime_plan = payload["runtime_window_import_plan"]
        self.assertEqual(
            runtime_plan["source"], "paper_route_observed_strategy_source_collection"
        )
        self.assertEqual(runtime_plan["target_count"], 1)
        self.assertTrue(runtime_plan["session_readiness"]["import_ready"])
        self.assertTrue(runtime_plan["runtime_window_import_handoff"]["import_ready"])
        self.assertEqual(
            runtime_plan["runtime_window_import_health_gate"]["blocked_target_count"],
            0,
        )
        target = runtime_plan["targets"][0]
        self.assertEqual(target["candidate_id"], "candidate-tsmom")
        self.assertEqual(target["hypothesis_id"], "H-TSMOM-LIQ-01")
        self.assertEqual(target["runtime_strategy_name"], "intraday-tsmom-profit-v3")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")
        self.assertEqual(
            target["source_kind"], "runtime_ledger_source_collection_candidate"
        )
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(target["promotion_allowed"])
        self.assertNotIn("paper_route_probe_symbols", target)
        self.assertEqual(target["dependency_quorum_decision"], "allow")
        self.assertEqual(target["continuity_ok"], "true")
        self.assertEqual(target["drift_ok"], "false")
        self.assertTrue(target["runtime_window_import_health_gate"]["ready"])
        self.assertEqual(target["runtime_window_import_health_gate_blockers"], [])
        self.assertEqual(
            target["runtime_window_import_promotion_blockers"],
            ["drift_checks_not_ok"],
        )
        self.assertEqual(
            target["observed_from_contaminated_target"]["strategy_name"],
            "intraday-tsmom-profit-v3",
        )
        self.assertEqual(payload["targets"][0]["candidate_id"], "candidate-tsmom")
        self.assertEqual(
            payload["source_runtime_window_import_plan"]["source"],
            "paper_route_observed_strategy_source_collection",
        )

    def test_evidence_selects_observed_strategy_source_collection_plan(self) -> None:
        generated_at = datetime(2026, 6, 2, 22, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 2, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 2, 20, tzinfo=timezone.utc)
        event_at = window_start + timedelta(minutes=30)

        with Session(self.engine) as session:
            hpairs_strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
            )
            tsmom_strategy = Strategy(
                name="intraday-tsmom-profit-v3",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add_all([hpairs_strategy, tsmom_strategy])
            session.flush()
            decision = TradeDecision(
                strategy_id=tsmom_strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-tsmom",
                    "hypothesis_id": "H-TSMOM-LIQ-01",
                },
                rationale="foreign TSMOM source collection fixture",
                status="executed",
                created_at=event_at,
                executed_at=event_at,
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="tsmom-source-order",
                client_order_id="tsmom-source-client",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                status="filled",
                raw_order={},
                created_at=event_at,
                updated_at=event_at,
                last_update_at=event_at,
            )
            session.add(execution)
            session.flush()
            session.add_all(
                [
                    ExecutionOrderEvent(
                        event_fingerprint="tsmom-source-order-event",
                        source_topic="trade_updates",
                        source_partition=0,
                        source_offset=101,
                        alpaca_account_label="TORGHUT_SIM",
                        event_ts=event_at,
                        symbol="AAPL",
                        alpaca_order_id="tsmom-source-order",
                        client_order_id="tsmom-source-client",
                        event_type="fill",
                        status="filled",
                        raw_event={},
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        created_at=event_at,
                    ),
                    ExecutionTCAMetric(
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        strategy_id=tsmom_strategy.id,
                        alpaca_account_label="TORGHUT_SIM",
                        symbol="AAPL",
                        side="buy",
                        arrival_price=Decimal("99"),
                        avg_fill_price=Decimal("100"),
                        filled_qty=Decimal("1"),
                        signed_qty=Decimal("1"),
                        slippage_bps=Decimal("10"),
                        shortfall_notional=Decimal("1"),
                        realized_shortfall_bps=Decimal("10"),
                        churn_qty=Decimal("0"),
                        churn_ratio=Decimal("0"),
                        computed_at=event_at,
                        created_at=event_at,
                        updated_at=event_at,
                    ),
                ]
            )
            session.commit()

            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": "true",
                    "continuity_reason": "expected_market_closed_staleness",
                    "drift_ok": "false",
                    "drift_reason": "drift_live_promotion_ineligible",
                    "runtime_ledger_repair_candidates": [
                        {
                            "hypothesis_id": "H-TSMOM-LIQ-01",
                            "candidate_id": "candidate-tsmom",
                            "observed_stage": "paper",
                            "strategy_family": "intraday_tsmom_consistent",
                            "strategy_name": "intraday-tsmom-profit-v3",
                            "runtime_strategy_name": "intraday-tsmom-profit-v3",
                            "strategy_id": "intraday_tsmom_v2@research",
                            "account": "TORGHUT_SIM",
                            "dataset_snapshot_ref": (
                                "portfolio-profit-autoresearch-500-v1"
                            ),
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-tsmom-liq-01.json"
                            ),
                            "reason_codes": [
                                "runtime_ledger_source_collection_pending"
                            ],
                        }
                    ],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.runtime-ledger-paper-probation-import-plan.v1"
                        ),
                        "target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-PAIRS-01",
                                "candidate_id": "candidate-hpairs",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": hpairs_strategy.name,
                                "strategy_id": "hpairs_target_strategy@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": (
                                    "config/trading/hypotheses/h-pairs-01.json"
                                ),
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "effective_max_notional": 25,
                        "next_session_max_notional": 25,
                        "eligible_symbols": ["AAPL", "AMZN"],
                    },
                },
                generated_at=generated_at,
            )

        next_plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(
            next_plan["schema_version"],
            paper_route_evidence.NEXT_PAPER_ROUTE_RUNTIME_WINDOW_TARGETS_SCHEMA_VERSION,
        )
        self.assertEqual(next_plan["source"], "paper_route_evidence_audit")
        self.assertEqual(next_plan["targets"][0]["candidate_id"], "candidate-hpairs")
        self.assertEqual(
            next_plan["targets"][0]["selected_by"],
            "paper_route_evidence_audit",
        )
        self.assertFalse(next_plan["targets"][0]["promotion_allowed"])
        self.assertIn(
            "paper_route_runtime_ledger_import_pending",
            next_plan["targets"][0]["final_promotion_blockers"],
        )
        runtime_plan = payload["runtime_window_import_plan"]
        self.assertEqual(
            runtime_plan["source"], "paper_route_observed_strategy_source_collection"
        )
        self.assertTrue(runtime_plan["session_readiness"]["import_ready"])
        self.assertTrue(runtime_plan["runtime_window_import_handoff"]["import_ready"])
        self.assertEqual(
            runtime_plan["runtime_window_import_health_gate"]["blocked_target_count"],
            0,
        )
        self.assertEqual(runtime_plan["targets"][0]["candidate_id"], "candidate-tsmom")
        self.assertEqual(
            runtime_plan["targets"][0]["selected_by"],
            "paper_route_observed_strategy_source_collection",
        )
        self.assertEqual(
            runtime_plan["targets"][0]["dependency_quorum_decision"], "allow"
        )
        self.assertEqual(runtime_plan["targets"][0]["continuity_ok"], "true")
        self.assertEqual(runtime_plan["targets"][0]["drift_ok"], "false")
        self.assertTrue(
            runtime_plan["targets"][0]["runtime_window_import_health_gate"]["ready"]
        )
        self.assertEqual(
            runtime_plan["targets"][0]["runtime_window_import_health_gate_blockers"],
            [],
        )
        self.assertFalse(runtime_plan["targets"][0]["promotion_allowed"])
        self.assertIn(
            "runtime_ledger_source_collection_only",
            runtime_plan["targets"][0]["final_promotion_blockers"],
        )
        self.assertEqual(
            payload["source_runtime_window_import_plan"]["source"],
            "paper_route_observed_strategy_source_collection",
        )
        self.assertEqual(
            payload["observed_strategy_source_runtime_window_import_plan"]["source"],
            "paper_route_observed_strategy_source_collection",
        )
        self.assertEqual(payload["raw_next_paper_route_runtime_window_targets"], {})
        self.assertEqual(
            next_plan["targets"][0]["paper_route_account_contamination_state"][
                "foreign_strategy_counts"
            ],
            {"intraday-tsmom-profit-v3": 1},
        )
        self.assertEqual(
            payload["summary"]["selected_next_runtime_window_plan_source"],
            "paper_route_evidence_audit",
        )
        self.assertEqual(
            payload["summary"]["runtime_window_import_plan_source"],
            "paper_route_observed_strategy_source_collection",
        )
        summary = payload["summary"]
        self.assertEqual(
            summary["summary_target_audit_source"],
            "runtime_window_import_target_audits",
        )
        self.assertEqual(summary["source_plan_target_with_source_activity_count"], 0)
        self.assertEqual(summary["target_with_source_activity_count"], 1)
        self.assertEqual(summary["target_with_runtime_ledger_count"], 0)
        self.assertEqual(
            summary["runtime_window_import_target_with_source_activity_count"], 1
        )
        self.assertEqual(summary["readback"]["source_decisions_present_count"], 1)
        self.assertEqual(summary["readback"]["submitted_lifecycle_present_count"], 1)
        self.assertEqual(summary["readback"]["fills_or_executions_present_count"], 1)
        self.assertEqual(summary["readback"]["source_refs_present_count"], 1)
        self.assertNotIn("source_decisions_missing", summary["blockers"])
        self.assertNotIn("source_executions_missing", summary["blockers"])
        self.assertNotIn("source_tca_missing", summary["blockers"])
        self.assertIn("runtime_ledger_bucket_missing", summary["blockers"])

    def test_observed_strategy_source_collection_plan_limits_targets(self) -> None:
        target_template = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "candidate-hpairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "window_start": "2026-06-02T13:30:00+00:00",
            "window_end": "2026-06-02T20:00:00+00:00",
            "paper_route_account_contamination_state": {
                "foreign_strategy_counts": {
                    "intraday-tsmom-profit-v3": 2,
                    "other-observed-source-strategy": 1,
                },
            },
        }

        plan = paper_route_evidence._observed_strategy_source_collection_import_plan(
            live_submission_gate={
                "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                "runtime_ledger_repair_candidates": [
                    {
                        "hypothesis_id": "H-TSMOM-LIQ-01",
                        "candidate_id": "candidate-tsmom",
                        "strategy_family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "runtime_strategy_name": "intraday-tsmom-profit-v3",
                    },
                    {
                        "hypothesis_id": "H-OTHER",
                        "candidate_id": "candidate-other",
                        "strategy_family": "intraday_other",
                        "strategy_name": "other-observed-source-strategy",
                    },
                ],
            },
            candidate_plans=[
                {
                    "targets": [
                        dict(target_template),
                        {
                            **target_template,
                            "candidate_id": "candidate-hpairs-second-window",
                        },
                    ],
                },
                {"targets": [dict(target_template)]},
            ],
            target_limit=1,
        )

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "candidate-tsmom")
        self.assertEqual(
            target["source_manifest_ref"],
            "config/trading/hypotheses/h-tsmom-liq-01.json",
        )
        self.assertEqual(
            target["observed_from_contaminated_target"]["order_event_count"], 2
        )

    def test_observed_strategy_source_collection_plan_uses_plan_count_pending(
        self,
    ) -> None:
        plan = paper_route_evidence._observed_strategy_source_collection_import_plan(
            live_submission_gate={
                "blocked_reasons": [],
                "runtime_ledger_repair_candidates": [
                    {
                        "hypothesis_id": "H-TSMOM-LIQ-01",
                        "candidate_id": "candidate-tsmom",
                        "strategy_family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "runtime_strategy_name": "intraday-tsmom-profit-v3",
                    }
                ],
                "runtime_ledger_paper_probation_import_plan": {
                    "source_collection_target_count": 1,
                    "targets": [],
                },
            },
            candidate_plans=[
                {
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "candidate-hpairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "window_start": "2026-06-02T13:30:00+00:00",
                            "window_end": "2026-06-02T20:00:00+00:00",
                            "paper_route_account_contamination_state": {
                                "foreign_strategy_counts": {
                                    "intraday-tsmom-profit-v3": 3,
                                },
                            },
                        }
                    ],
                }
            ],
            target_limit=5,
        )

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "candidate-tsmom")
        self.assertEqual(target["runtime_strategy_name"], "intraday-tsmom-profit-v3")
        self.assertEqual(
            target["selected_by"], "paper_route_observed_strategy_source_collection"
        )

    def test_source_collection_pending_accepts_candidate_shapes(self) -> None:
        self.assertTrue(
            paper_route_evidence._live_gate_has_source_collection_pending(
                {
                    "blocked_reasons": [],
                    "runtime_ledger_source_collection_candidates": [
                        {"candidate_id": "candidate-tsmom"}
                    ],
                }
            )
        )
        self.assertTrue(
            paper_route_evidence._live_gate_has_source_collection_pending(
                {
                    "blocked_reasons": [],
                    "runtime_ledger_source_collection_candidate_total": 1,
                }
            )
        )

    def test_observed_strategy_source_collection_plan_skips_unmapped_noise(
        self,
    ) -> None:
        plan = paper_route_evidence._observed_strategy_source_collection_import_plan(
            live_submission_gate={
                "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                "runtime_ledger_repair_candidates": [
                    {
                        "hypothesis_id": "H-TSMOM-LIQ-01",
                        "candidate_id": "candidate-tsmom",
                        "strategy_family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                    }
                ],
            },
            candidate_plans=[
                {
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "candidate-hpairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "window_start": "2026-06-02T13:30:00+00:00",
                            "window_end": "2026-06-02T20:00:00+00:00",
                            "paper_route_account_contamination_state": {
                                "foreign_strategy_counts": {
                                    "missing": 5,
                                    "unmapped-observed-strategy": 4,
                                },
                            },
                        }
                    ],
                }
            ],
            target_limit=5,
        )

        self.assertEqual(plan, {})

    def test_observed_strategy_source_collection_plan_skips_incomplete_candidate(
        self,
    ) -> None:
        plan = paper_route_evidence._observed_strategy_source_collection_import_plan(
            live_submission_gate={
                "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                "runtime_ledger_repair_candidates": [
                    {
                        "hypothesis_id": "H-TSMOM-LIQ-01",
                        "strategy_family": "intraday_tsmom_consistent",
                        "strategy_name": "intraday-tsmom-profit-v3",
                    }
                ],
            },
            candidate_plans=[
                {
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "candidate-hpairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "window_start": "2026-06-02T13:30:00+00:00",
                            "window_end": "2026-06-02T20:00:00+00:00",
                            "paper_route_account_contamination_state": {
                                "foreign_strategy_counts": {
                                    "intraday-tsmom-profit-v3": 1,
                                },
                            },
                        }
                    ],
                }
            ],
            target_limit=5,
        )

        self.assertEqual(plan, {})

    def test_account_contamination_summary_deduplicates_and_caps_order_event_refs(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 18, 5, tzinfo=timezone.utc)

        with Session(self.engine) as session:
            first_strategy = Strategy(
                name="hpairs-overlap-aapl",
                description="overlap target fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                created_at=window_start,
                updated_at=window_start,
            )
            second_strategy = Strategy(
                name="hpairs-overlap-pair",
                description="overlap target pair fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                created_at=window_start,
                updated_at=window_start,
            )
            foreign_strategy = Strategy(
                name="intraday-tsmom-overlap",
                description="foreign paper account fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AMZN"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add_all([first_strategy, second_strategy, foreign_strategy])
            session.flush()
            foreign_decision = TradeDecision(
                strategy_id=foreign_strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AMZN",
                timeframe="1Min",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-foreign",
                    "hypothesis_id": "H-FOREIGN",
                },
                rationale="foreign linked overlap contamination fixture",
                status="executed",
                created_at=window_start + timedelta(minutes=49),
                executed_at=window_start + timedelta(minutes=50),
            )
            session.add(foreign_decision)
            session.flush()
            session.add(
                ExecutionOrderEvent(
                    event_fingerprint="overlap-foreign-amzn-event",
                    source_topic="alpaca.trade_updates",
                    source_partition=0,
                    source_offset=90,
                    alpaca_account_label="TORGHUT_SIM",
                    event_ts=window_start + timedelta(minutes=50),
                    symbol="AMZN",
                    alpaca_order_id="overlap-foreign-amzn-order",
                    client_order_id="tsmom-AMZN-foreign-overlap",
                    event_type="fill",
                    status="filled",
                    qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("101"),
                    raw_event={"source": "foreign_tsmom_strategy"},
                    execution_id=None,
                    trade_decision_id=foreign_decision.id,
                )
            )
            for index in range(5):
                session.add(
                    ExecutionOrderEvent(
                        event_fingerprint=f"overlap-unlinked-aapl-event-{index}",
                        source_topic="alpaca.trade_updates",
                        source_partition=0,
                        source_offset=100 + index,
                        alpaca_account_label="TORGHUT_SIM",
                        event_ts=window_start + timedelta(minutes=40, seconds=index),
                        symbol="AAPL",
                        alpaca_order_id=f"overlap-unlinked-aapl-order-{index}",
                        client_order_id=f"external-AAPL-overlap-{index}",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("101"),
                        raw_event={"source": "external_unlinked_aapl"},
                        execution_id=None,
                        trade_decision_id=None,
                    )
                )
            for index in range(5):
                session.add(
                    ExecutionOrderEvent(
                        event_fingerprint=f"overlap-unlinked-amzn-event-{index}",
                        source_topic="alpaca.trade_updates",
                        source_partition=0,
                        source_offset=200 + index,
                        alpaca_account_label="TORGHUT_SIM",
                        event_ts=window_start + timedelta(minutes=20, seconds=index),
                        symbol="AMZN",
                        alpaca_order_id=f"overlap-unlinked-amzn-order-{index}",
                        client_order_id=f"external-AMZN-overlap-{index}",
                        event_type="fill",
                        status="filled",
                        qty=Decimal("1"),
                        filled_qty=Decimal("1"),
                        avg_fill_price=Decimal("101"),
                        raw_event={"source": "external_unlinked_amzn"},
                        execution_id=None,
                        trade_decision_id=None,
                    )
                )
            self._add_flat_account_start_snapshot(
                session,
                account_label="TORGHUT_SIM",
                window_start=window_start,
            )
            session.commit()

            payload = build_paper_route_target_plan_payload(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "paper_route_probe_only",
                    "blocked_reasons": [],
                    "dependency_quorum_decision": "allow",
                    "continuity_ok": True,
                    "continuity_reason": "signal_continuity_nominal",
                    "drift_ok": True,
                    "drift_reason": "drift_live_promotion_eligible",
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": (
                            "torghut.runtime-ledger-paper-probation-import-plan.v1"
                        ),
                        "target_count": "2",
                        "targets": [
                            {
                                "hypothesis_id": "H-OVERLAP-AAPL",
                                "candidate_id": "candidate-overlap-aapl",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": first_strategy.name,
                                "strategy_id": "hpairs_overlap_aapl@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": (
                                    "config/trading/hypotheses/overlap-aapl.json"
                                ),
                                "paper_route_probe_scope_authority": (
                                    "external_target_plan"
                                ),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
                            },
                            {
                                "hypothesis_id": "H-OVERLAP-PAIR",
                                "candidate_id": "candidate-overlap-pair",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_pairs",
                                "strategy_name": second_strategy.name,
                                "strategy_id": "hpairs_overlap_pair@research",
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "source_manifest_ref": (
                                    "config/trading/hypotheses/overlap-pair.json"
                                ),
                                "paper_route_probe_scope_authority": (
                                    "external_target_plan"
                                ),
                                "paper_route_probe_symbols": ["AAPL"],
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "eligible_symbols": ["AAPL", "AMZN"],
                    },
                },
                generated_at=now,
            )

        plan = payload["next_paper_route_runtime_window_targets"]
        self.assertEqual(plan["target_count"], 2)
        self.assertEqual(plan["skipped_target_count"], 0)
        first_target = plan["targets"][0]
        second_target = plan["targets"][1]
        self.assertEqual(second_target["candidate_id"], "candidate-overlap-pair")
        self.assertEqual(
            first_target["paper_route_account_contamination_state"]["reason"],
            "unlinked_and_foreign_account_order_events_present",
        )
        contamination_readiness = plan["account_contamination_readiness"]
        self.assertEqual(
            contamination_readiness["state"], "contaminated_window_discarded"
        )
        self.assertEqual(contamination_readiness["target_count"], 2)
        self.assertEqual(contamination_readiness["contaminated_target_count"], 2)
        self.assertEqual(contamination_readiness["unlinked_order_event_count"], 15)
        self.assertEqual(contamination_readiness["foreign_linked_order_event_count"], 1)
        sample_refs = contamination_readiness["sample_order_event_refs"]
        self.assertEqual(len(sample_refs), 10)
        sample_keys = {
            (item["event_fingerprint"], item["client_order_id"]) for item in sample_refs
        }
        self.assertEqual(len(sample_keys), 10)
        self.assertNotIn(
            ("overlap-foreign-amzn-event", "tsmom-AMZN-foreign-overlap"),
            sample_keys,
        )
        self.assertEqual(
            sum(
                1
                for item in sample_refs
                if str(item["event_fingerprint"]).startswith(
                    "overlap-unlinked-aapl-event"
                )
            ),
            5,
        )
        self.assertEqual(
            sum(
                1
                for item in sample_refs
                if str(item["event_fingerprint"]).startswith(
                    "overlap-unlinked-amzn-event"
                )
            ),
            5,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
        contract = audit["evidence_window_contract"]
        self.assertEqual(contract["state"], "clean_window_required")
        self.assertFalse(contract["proof_allowed"])
        self.assertFalse(contract["promotion_allowed"])
        self.assertFalse(contract["final_promotion_allowed"])
        latest_closed_selection = payload[
            "latest_closed_runtime_window_import_selection"
        ]
        self.assertFalse(latest_closed_selection["selected"])
        self.assertEqual(
            latest_closed_selection["state"],
            "rejected_contaminated_or_unclean",
        )
        self.assertIn(
            "paper_route_account_window_start_positions_present",
            latest_closed_selection["discard_blockers"],
        )
        self.assertIn(
            "paper_route_account_window_start_non_target_positions_present",
            latest_closed_selection["discard_blockers"],
        )
        self.assertEqual(
            payload["runtime_window_import_plan"]["purpose"],
            "next_clean_session_paper_route_runtime_window_collection_after_discard",
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["state"], "waiting_for_session_open")
        self.assertEqual(
            import_audit["evidence_window_state"], "clean_window_collection_pending"
        )
        self.assertFalse(import_audit["proof_allowed"])
        self.assertEqual(
            import_audit["next_action"],
            "wait_for_regular_session_open",
        )
        self.assertIn(
            "paper_route_session_window_not_open",
            import_audit["blockers"],
        )
        self.assertEqual(
            import_audit["session_window"]["start"], "2026-05-27T13:30:00+00:00"
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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

    def test_hpairs_audit_surfaces_shared_source_lineage_candidate_mismatch(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 21, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            hpairs_strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="canonical H-PAIRS strategy",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                created_at=window_start,
                updated_at=window_start,
            )
            source_strategy = Strategy(
                name="intraday-tsmom-profit-v3",
                description="external target-plan source strategy",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN", "INTC", "NVDA"],
                created_at=window_start,
                updated_at=window_start,
            )
            session.add_all([hpairs_strategy, source_strategy])
            session.flush()
            session.add(
                TradeDecision(
                    strategy_id=source_strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json={
                        "action": "buy",
                        "qty": "1",
                        "params": {
                            "lineage": {
                                "candidate_id": "candidate-tsmom",
                                "hypothesis_id": "H-TSMOM-LIQ-01",
                            },
                            "paper_route_probe": {
                                "source_candidate_ids": ["candidate-tsmom"],
                                "source_hypothesis_ids": [
                                    "H-PAIRS-01",
                                    "H-TSMOM-LIQ-01",
                                ],
                                "source_strategy_names": [
                                    "microbar-cross-sectional-pairs-v1",
                                    "intraday-tsmom-profit-v3",
                                ],
                            },
                        },
                    },
                    rationale="shared target-plan row with mismatched candidate",
                    status="executed",
                    created_at=window_start + timedelta(minutes=5),
                    executed_at=window_start + timedelta(minutes=6),
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
                                "candidate_id": "candidate-pairs",
                                "observed_stage": "paper",
                                "strategy_family": "microbar_cross_sectional_pairs",
                                "strategy_name": "microbar-cross-sectional-pairs-v1",
                                "strategy_id": (
                                    "microbar_cross_sectional_pairs_v1@research"
                                ),
                                "account_label": "TORGHUT_SIM",
                                "source_kind": "paper_route_probe_runtime_observed",
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                        "effective_max_notional": 25,
                        "next_session_max_notional": 25,
                    },
                },
                generated_at=now,
            )

        target = payload["targets"][0]
        source_activity = target["source_activity"]
        observation = source_activity["source_lineage_observation"]
        self.assertEqual(source_activity["raw_decision_count"], 0)
        self.assertEqual(source_activity["decision_count"], 0)
        self.assertTrue(source_activity["missing"])
        self.assertEqual(observation["observed_decision_count"], 1)
        self.assertEqual(observation["hypothesis_match_decision_count"], 1)
        self.assertEqual(observation["candidate_match_decision_count"], 0)
        self.assertEqual(observation["exact_match_decision_count"], 0)
        self.assertEqual(observation["strategy_names"], ["intraday-tsmom-profit-v3"])
        self.assertIn(
            "source_lineage_partial_match_only",
            source_activity["missing_reasons"],
        )
        self.assertIn(
            "source_candidate_lineage_mismatch_current_activity",
            source_activity["missing_reasons"],
        )
        self.assertIn(
            "source_strategy_filter_mismatch_current_activity",
            source_activity["missing_reasons"],
        )
        self.assertIn(
            "source_candidate_lineage_mismatch_current_activity",
            target["readiness"]["blockers"],
        )
        self.assertEqual(payload["summary"]["target_with_source_activity_count"], 0)

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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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

    def test_next_paper_route_runtime_window_allows_distinct_account_window_targets(
        self,
    ) -> None:
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, tzinfo=timezone.utc)
        now = datetime(2026, 5, 26, 12, tzinfo=timezone.utc)
        with Session(self.engine) as session:
            session.add_all(
                [
                    Strategy(
                        name="paper-route-alpha",
                        description="first paper route target",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        created_at=window_start,
                        updated_at=window_start,
                    ),
                    Strategy(
                        name="paper-route-beta",
                        description="second paper route target",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["MSFT"],
                        created_at=window_start,
                        updated_at=window_start,
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
                        "target_count": "2",
                        "targets": [
                            {
                                "hypothesis_id": "H-PAPER-ALPHA",
                                "candidate_id": "candidate-paper-alpha",
                                "observed_stage": "paper",
                                "strategy_family": "paper_route_alpha",
                                "strategy_name": "paper-route-alpha",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-paper-alpha.json",
                                "paper_route_probe_symbols": ["AAPL"],
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
                            },
                            {
                                "hypothesis_id": "H-PAPER-BETA",
                                "candidate_id": "candidate-paper-beta",
                                "observed_stage": "paper",
                                "strategy_family": "paper_route_beta",
                                "strategy_name": "paper-route-beta",
                                "account_label": "TORGHUT_SIM",
                                "source_manifest_ref": "config/trading/hypotheses/h-paper-beta.json",
                                "paper_route_probe_symbols": ["MSFT"],
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "paper_probation_authorized": True,
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
                            },
                        ],
                    },
                },
                route_reacquisition_book={
                    "schema_version": "torghut.route-reacquisition-book.v1",
                    "state": "repair_only",
                    "summary": {
                        "paper_route_probe_eligible_symbols": ["AAPL", "MSFT"],
                        "paper_route_probe_active_symbols": ["AAPL", "MSFT"],
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
        self.assertEqual(next_targets["target_count"], 2)
        self.assertEqual(next_targets["skipped_target_count"], 0)
        self.assertEqual(
            next_targets["targets"][0]["candidate_id"], "candidate-paper-alpha"
        )
        self.assertEqual(
            next_targets["targets"][1]["candidate_id"], "candidate-paper-beta"
        )
        self.assertEqual(next_targets["targets"][0]["account_label"], "TORGHUT_SIM")
        self.assertEqual(next_targets["targets"][1]["account_label"], "TORGHUT_SIM")
        self.assertNotIn(
            "paper_route_account_window_already_assigned",
            [str(skipped.get("reason")) for skipped in next_targets["skipped_targets"]],
        )
        import_audit = payload["runtime_window_import_audit"]
        self.assertEqual(import_audit["counts"]["source_plan_target_count"], 2)
        self.assertEqual(import_audit["counts"]["selected_target_count"], 2)
        self.assertEqual(import_audit["counts"]["next_runtime_window_target_count"], 2)

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
                        payload_json=self._runtime_ledger_source_authority_payload(
                            window_start=window_start,
                            window_end=window_end,
                            suffix="selected-grade",
                        ),
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
                                "paper_probation_satisfied_for_bounded_live_paper_collection": True,
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
            payload["targets"][0]["readiness"]["blockers"],
        )
        self.assertIn(
            "runtime_ledger_evidence_grade_bucket_missing",
            payload["targets"][0]["readiness"]["blockers"],
        )

    def test_source_collection_target_audit_reads_source_dsn_activity(
        self,
    ) -> None:
        source_db = tempfile.NamedTemporaryFile(suffix=".db")
        self.addCleanup(source_db.close)
        source_dsn = f"sqlite+pysqlite:///{source_db.name}"
        source_engine = create_engine(source_dsn, future=True)
        self.addCleanup(source_engine.dispose)
        Base.metadata.create_all(source_engine)

        now = datetime(2026, 6, 2, 21, 5, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 2, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 2, 20, tzinfo=timezone.utc)
        event_at = window_start + timedelta(minutes=30)
        strategy_name = "intraday-tsmom-profit-v3"

        with Session(source_engine) as source_session:
            strategy = Strategy(
                name=strategy_name,
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            source_session.add(strategy)
            source_session.flush()
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SOURCE",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={
                    "action": "buy",
                    "qty": "1",
                    "candidate_id": "candidate-source-dsn",
                    "hypothesis_id": "H-SOURCE-DSN",
                },
                rationale="source dsn paper activity fixture",
                status="executed",
                created_at=event_at,
                executed_at=event_at,
            )
            source_session.add(decision)
            source_session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_account_label="TORGHUT_SOURCE",
                alpaca_order_id="source-dsn-order",
                client_order_id="source-dsn-client",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                status="filled",
                raw_order={},
                created_at=event_at,
                updated_at=event_at,
                last_update_at=event_at,
            )
            source_session.add(execution)
            source_session.flush()
            source_session.add_all(
                [
                    ExecutionOrderEvent(
                        event_fingerprint="source-dsn-order-event",
                        source_topic="trade_updates",
                        source_partition=0,
                        source_offset=202,
                        alpaca_account_label="TORGHUT_SOURCE",
                        event_ts=event_at,
                        symbol="AAPL",
                        alpaca_order_id="source-dsn-order",
                        client_order_id="source-dsn-client",
                        event_type="fill",
                        status="filled",
                        raw_event={},
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        created_at=event_at,
                    ),
                    ExecutionTCAMetric(
                        execution_id=execution.id,
                        trade_decision_id=decision.id,
                        strategy_id=strategy.id,
                        alpaca_account_label="TORGHUT_SOURCE",
                        symbol="AAPL",
                        side="buy",
                        arrival_price=Decimal("99"),
                        avg_fill_price=Decimal("100"),
                        filled_qty=Decimal("1"),
                        signed_qty=Decimal("1"),
                        slippage_bps=Decimal("10"),
                        shortfall_notional=Decimal("1"),
                        realized_shortfall_bps=Decimal("10"),
                        churn_qty=Decimal("0"),
                        churn_ratio=Decimal("0"),
                        computed_at=event_at,
                        created_at=event_at,
                        updated_at=event_at,
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="source-dsn-runtime-bucket",
                        candidate_id="candidate-source-dsn",
                        hypothesis_id="H-SOURCE-DSN",
                        observed_stage="paper",
                        bucket_started_at=window_start,
                        bucket_ended_at=window_end,
                        account_label="TORGHUT_SOURCE",
                        runtime_strategy_name=strategy_name,
                        strategy_family="intraday_tsmom_consistent",
                        fill_count=1,
                        decision_count=1,
                        submitted_order_count=1,
                        closed_trade_count=1,
                        open_position_count=0,
                        filled_notional=Decimal("100"),
                        gross_strategy_pnl=Decimal("8"),
                        cost_amount=Decimal("1"),
                        net_strategy_pnl_after_costs=Decimal("7"),
                        post_cost_expectancy_bps=Decimal("700"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy-a": 1},
                        cost_model_hash_counts={"cost-a": 1},
                        lineage_hash_counts={"lineage-a": 1},
                        blockers_json=[],
                        payload_json={
                            "source_window_start": window_start.isoformat(),
                            "source_window_end": window_end.isoformat(),
                            "source_refs": [
                                "trade_decisions",
                                "executions",
                                "execution_order_events",
                                "order_feed_source_windows",
                            ],
                            "source_row_counts": {
                                "trade_decisions": 1,
                                "executions": 1,
                                "execution_order_events": 1,
                                "order_feed_source_windows": 1,
                            },
                            "source_window_ids": ["source-dsn-window"],
                            "trade_decision_ids": [str(decision.id)],
                            "execution_ids": [str(execution.id)],
                            "execution_order_event_ids": ["source-dsn-order-event"],
                            "source_offsets": [
                                {
                                    "topic": "trade_updates",
                                    "partition": 0,
                                    "offset": 202,
                                }
                            ],
                            "order_feed_lifecycle_complete": True,
                            "execution_economics_complete": True,
                            "execution_economics_required": True,
                            "cost_basis": "broker_statement_fee",
                            "cost_basis_counts": {"broker_statement_fee": 1},
                            "source_materialization": "execution_order_events",
                            "authority_class": (
                                "event_sourced_runtime_ledger_profit_proof"
                            ),
                            "authority_reason": (
                                "event_sourced_runtime_ledger_profit_proof"
                            ),
                            "promotion_authority": True,
                        },
                    ),
                ]
            )
            source_session.commit()

        with (
            patch.dict(
                "os.environ",
                {"TORGHUT_SOURCE_TEST_DSN": source_dsn},
                clear=False,
            ),
            Session(self.engine) as session,
        ):
            payload = build_paper_route_evidence_audit(
                session,
                live_submission_gate={
                    "allowed": False,
                    "reason": "source_collection_pending",
                    "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                    "runtime_ledger_paper_probation_import_plan": {
                        "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                        "target_count": 1,
                        "source_collection_target_count": 1,
                        "targets": [
                            {
                                "hypothesis_id": "H-SOURCE-DSN",
                                "candidate_id": "candidate-source-dsn",
                                "observed_stage": "paper",
                                "strategy_family": "intraday_tsmom_consistent",
                                "strategy_name": strategy_name,
                                "runtime_strategy_name": strategy_name,
                                "account_label": "TORGHUT_SIM",
                                "source_account_label": "TORGHUT_SOURCE",
                                "source_dsn_env": "TORGHUT_SOURCE_TEST_DSN",
                                "target_dsn_env": "SIM_DB_DSN",
                                "source_kind": (
                                    "runtime_ledger_source_collection_candidate"
                                ),
                                "window_start": window_start.isoformat(),
                                "window_end": window_end.isoformat(),
                                "source_collection_authorized": True,
                                "promotion_allowed": False,
                                "final_promotion_allowed": False,
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

        target_audit = payload["targets"][0]
        source_activity = target_audit["source_activity"]
        runtime_ledger = target_audit["runtime_ledger"]
        readback = target_audit["evidence_readback"]
        self.assertTrue(source_activity["source_audit_scope"]["source_session_used"])
        self.assertEqual(source_activity["account_label"], "TORGHUT_SOURCE")
        self.assertEqual(source_activity["decision_count"], 1)
        self.assertEqual(source_activity["execution_count"], 1)
        self.assertEqual(source_activity["filled_execution_count"], 1)
        self.assertEqual(source_activity["tca_sample_count"], 1)
        self.assertTrue(runtime_ledger["source_audit_scope"]["source_session_used"])
        self.assertEqual(runtime_ledger["filters"]["account_label"], "TORGHUT_SOURCE")
        self.assertEqual(runtime_ledger["bucket_count"], 1)
        self.assertEqual(runtime_ledger["evidence_grade_bucket_count"], 1)
        self.assertEqual(readback["state"], "evidence_grade_runtime_buckets_present")
        self.assertTrue(readback["source_decisions_present"])
        self.assertTrue(readback["submitted_lifecycle_present"])
        self.assertTrue(readback["fills_or_executions_present"])
        self.assertTrue(readback["source_refs_present"])
        self.assertTrue(readback["runtime_buckets_present"])
        self.assertTrue(readback["evidence_grade_runtime_buckets_present"])
        self.assertFalse(target_audit["readiness"]["promotion_authority"]["allowed"])

    def test_source_audit_sqlalchemy_dsn_uses_installed_psycopg_driver(
        self,
    ) -> None:
        self.assertEqual(
            paper_route_evidence._source_audit_sqlalchemy_dsn(
                "postgres://user:pass@postgres/torghut"
            ),
            "postgresql+psycopg://user:pass@postgres/torghut",
        )
        self.assertEqual(
            paper_route_evidence._source_audit_sqlalchemy_dsn(
                "postgresql://user:pass@postgres/torghut"
            ),
            "postgresql+psycopg://user:pass@postgres/torghut",
        )
        self.assertEqual(
            paper_route_evidence._source_audit_sqlalchemy_dsn(
                "postgresql+psycopg://user:pass@postgres/torghut"
            ),
            "postgresql+psycopg://user:pass@postgres/torghut",
        )
        self.assertEqual(
            paper_route_evidence._source_audit_sqlalchemy_dsn(
                "sqlite+pysqlite:///:memory:"
            ),
            "sqlite+pysqlite:///:memory:",
        )
