from __future__ import annotations

# ruff: noqa: F401,F403,F405

from tests.submission_council.support import (
    Any,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    Base,
    Decimal,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    StaticPool,
    Strategy,
    SubmissionCouncilTestCase,
    TradeDecision,
    _next_paper_route_target_summaries,
    cast,
    create_engine,
    datetime,
    func,
    materialize_bounded_paper_route_target_plan,
    select,
    sessionmaker,
    source_decision_mode_is_profit_proof_eligible,
    timezone,
)


class TestSubmissionCouncilPaperRouteTargetPlan(SubmissionCouncilTestCase):
    def test_hpairs_target_plan_materializes_auditable_source_decisions(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        generated_at = datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc)
        with session_local() as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="H-PAIRS bounded paper materialization fixture",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                    max_notional_per_trade=Decimal("20"),
                )
            )
            session.commit()

            result = materialize_bounded_paper_route_target_plan(
                session,
                self._hpairs_clean_target_plan(),
                generated_at=generated_at,
                bounded_notional_limit=Decimal("25"),
            )
            session.commit()

            rows = list(
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.symbol.asc())
                ).scalars()
            )

        self.assertFalse(result["promotion_allowed"])
        self.assertFalse(result["final_promotion_authorized"])
        self.assertFalse(result["live_capital_routing_enabled"])
        self.assertEqual(result["materialized_decision_count"], 2)
        self.assertEqual(result["route_submission_count"], 2)
        self.assertEqual(result["blocked_target_count"], 0)
        self.assertEqual(
            result["source_decision_mode"],
            BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual([row.symbol for row in rows], ["AAPL", "AMZN"])
        for row in rows:
            payload = row.decision_json
            self.assertEqual(row.alpaca_account_label, "TORGHUT_SIM")
            self.assertEqual(row.status, "planned")
            self.assertEqual(
                payload["source_decision_mode"],
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            )
            self.assertEqual(payload["hypothesis_id"], "H-PAIRS-01")
            self.assertEqual(payload["candidate_id"], "c88421d619759b2cfaa6f4d0")
            self.assertEqual(
                payload["runtime_strategy_name"],
                "microbar-cross-sectional-pairs-v1",
            )
            self.assertEqual(payload["account_label"], "TORGHUT_SIM")
            self.assertEqual(
                payload["source_plan_ref"],
                "paper-route-plan:c88421d619759b2cfaa6f4d0",
            )
            self.assertEqual(payload["target_notional"], "20")
            self.assertEqual(
                payload["bounded_collection_stage"],
                "bounded_paper_collection",
            )
            self.assertFalse(payload["promotion_allowed"])
            self.assertFalse(payload["final_promotion_authorized"])
            self.assertFalse(payload["live_capital_routing_enabled"])
            self.assertTrue(payload["route_submission_enabled"])
            route_submission = payload["paper_route_order_submission"]
            self.assertTrue(route_submission["submission_enabled"])
            self.assertFalse(route_submission["live_capital_routing_enabled"])
            self.assertEqual(route_submission["account_label"], "TORGHUT_SIM")
            self.assertEqual(
                route_submission["submission_authority"],
                "bounded_paper_collection_only",
            )
            self.assertEqual(
                route_submission["execution_adapter_scope"], "paper_or_sim"
            )
            self.assertEqual(
                route_submission["idempotency_key_basis"],
                "trade_decision_hash_client_order_id",
            )
            self.assertEqual(
                route_submission["order_feed_linkage_keys"],
                ["alpaca_account_label", "client_order_id"],
            )
            self.assertEqual(
                payload["target_plan_identity"]["hypothesis_id"],
                "H-PAIRS-01",
            )
            self.assertEqual(
                payload["target_plan_identity"]["candidate_id"],
                "c88421d619759b2cfaa6f4d0",
            )
            self.assertEqual(payload["target_plan_identity"]["target_notional"], "20")
            self.assertEqual(payload["target_plan_identity"]["target_quantity"], "0.20")
            self.assertEqual(
                payload["target_plan_identity"]["target_symbol_quantities"],
                {"AAPL": "0.10", "AMZN": "0.10"},
            )

    def test_hpairs_target_summary_reads_audit_target_and_bounded_notional(
        self,
    ) -> None:
        target = cast(dict[str, Any], self._hpairs_clean_target_plan()["targets"][0])
        target = {
            **target,
            "target_notional": "1000000",
            "bounded_evidence_collection_max_notional": "1000000",
            "paper_route_probe_next_session_max_notional": "1000000",
            "paper_route_probe_effective_max_notional": "1000000",
            "paper_route_probe_symbol_quantities": {},
            "paper_route_probe_symbol_quantity_source": (
                "target_notional_runtime_sizing"
            ),
            "max_notional": "0",
        }

        summaries = _next_paper_route_target_summaries(
            [
                {
                    "target": target,
                    "readiness": {"state": "paper_evidence_collecting"},
                }
            ]
        )

        self.assertEqual(len(summaries), 1)
        summary = summaries[0]
        self.assertEqual(summary["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(summary["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(summary["symbols"], ["AAPL", "AMZN"])
        self.assertEqual(
            summary["symbol_actions"],
            {"AAPL": "buy", "AMZN": "sell"},
        )
        self.assertEqual(
            summary["symbol_quantities"],
            {"AAPL": "1", "AMZN": "1"},
        )
        self.assertEqual(
            summary["symbol_quantity_source"],
            "target_notional_runtime_sizing_seed",
        )
        self.assertEqual(summary["target_notional"], "1000000")
        self.assertEqual(summary["bounded_paper_collection_notional"], "1000000")
        self.assertEqual(summary["bounded_evidence_collection_max_notional"], "1000000")
        self.assertEqual(summary["next_session_max_notional"], "1000000")
        self.assertEqual(summary["capital_promotion_max_notional"], "0")
        self.assertFalse(summary["final_promotion_allowed"])

    def test_hpairs_target_plan_materialization_blocks_dirty_incomplete_or_unbounded_targets(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        plan = self._hpairs_clean_target_plan()
        target_template = cast(list[dict[str, Any]], plan["targets"])[0]
        dirty_target = dict(target_template)
        dirty_target["paper_route_clean_window_baseline_state"] = {
            "state": "blocked",
            "blockers": ["paper_route_account_contamination_detected"],
        }
        missing_target = dict(target_template)
        missing_target.pop("paper_route_clean_window_baseline_state")
        wrong_account_target = dict(target_template)
        wrong_account_target["account_label"] = "paper"
        unbounded_target = dict(target_template)
        unbounded_target["target_notional"] = "250"

        with session_local() as session:
            result = materialize_bounded_paper_route_target_plan(
                session,
                {
                    **plan,
                    "targets": [
                        dirty_target,
                        missing_target,
                        wrong_account_target,
                        unbounded_target,
                    ],
                },
                generated_at=datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc),
                bounded_notional_limit=Decimal("25"),
            )
            row_count = session.execute(
                select(func.count()).select_from(TradeDecision)
            ).scalar_one()

        self.assertEqual(result["materialized_decision_count"], 0)
        self.assertEqual(result["blocked_target_count"], 4)
        self.assertEqual(row_count, 0)
        self.assertIn("paper_route_account_contamination_detected", result["blockers"])
        self.assertIn(
            "paper_route_clean_window_baseline_missing_or_dirty",
            result["blockers"],
        )
        self.assertIn(
            "paper_route_target_torghut_sim_account_required",
            result["blockers"],
        )
        self.assertIn(
            "paper_route_target_notional_exceeds_bounded_collection_limit",
            result["blockers"],
        )
        self.assertFalse(result["promotion_allowed"])
        self.assertFalse(result["final_promotion_authorized"])
        self.assertFalse(result["live_capital_routing_enabled"])

    def test_source_decision_mode_profit_proof_scope_is_bounded_paper_only(
        self,
    ) -> None:
        self.assertFalse(
            source_decision_mode_is_profit_proof_eligible(
                ROUTE_ACQUISITION_SOURCE_DECISION_MODE
            )
        )
        self.assertTrue(
            source_decision_mode_is_profit_proof_eligible(
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
            )
        )
