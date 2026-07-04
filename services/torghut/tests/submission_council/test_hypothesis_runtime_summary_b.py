from __future__ import annotations


from tests.submission_council.support import (
    Base,
    JangarDependencyQuorumStatus,
    SimpleNamespace,
    StaticPool,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    SubmissionCouncilTestCase,
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    create_engine,
    datetime,
    patch,
    sessionmaker,
    settings,
    timezone,
)


class TestSubmissionCouncilHypothesisRuntimeSummaryB(SubmissionCouncilTestCase):
    def test_hypothesis_runtime_summary_counts_allowed_paper_runtime_readiness_without_capital_promotion(
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
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-paper-proof-1",
                    candidate_id="cand-runtime-paper",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="shadow",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-paper-proof-1",
                    candidate_id="cand-runtime-paper",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="shadow",
                    allowed=True,
                    reason_summary="paper_runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                summary = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

            gate = build_live_submission_gate_payload(
                SimpleNamespace(
                    last_autonomy_promotion_eligible=True,
                    last_autonomy_promotion_action="promote",
                    drift_live_promotion_eligible=False,
                    last_market_context_freshness_seconds=45,
                ),
                hypothesis_summary=summary,
                empirical_jobs_status={"ready": True, "status": "healthy"},
                quant_health_status=self._healthy_quant_status(),
                promotion_certificate_evidence=[
                    {
                        "hypothesis_id": "H-CONT-01",
                        "metric_window": self._metric_window(
                            capital_stage="shadow",
                            observed_stage="paper",
                        ),
                        "promotion_decision": self._promotion_decision(
                            capital_stage="shadow"
                        ),
                    }
                ],
                session=session,
            )

        self.assertEqual(summary["promotion_eligible_total"], 0)
        self.assertEqual(summary["paper_probation_eligible_total"], 1)
        item = summary["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertTrue(item["paper_probation_eligible"])
        self.assertEqual(item["paper_probation_target_capital_stage"], "shadow")
        self.assertEqual(item["candidate_id"], "cand-runtime-paper")
        self.assertEqual(item["state"], "shadow")
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["capital_multiplier"], "0")
        self.assertEqual(item["reasons"], ["paper_probation_evidence_collection_only"])
        self.assertEqual(
            item["informational_reasons"],
            [
                "runtime_window_certificate_readiness_applied",
                "runtime_window_paper_probation_applied",
            ],
        )
        self.assertEqual(
            item["observed"]["runtime_window_prior_reasons"],
            ["drift_checks_missing"],
        )
        self.assertTrue(gate["allowed"])
        self.assertEqual(gate["reason"], "operational_submission_ready")
        self.assertEqual(gate["blocked_reasons"], [])
        self.assertNotIn(
            "hypothesis_not_promotion_eligible",
            gate["blocked_reasons"],
        )
        self.assertNotIn("promotion_certificate_shadow_only", gate["blocked_reasons"])
        self.assertNotIn("alpha_hypothesis_shadow_only", gate["blocked_reasons"])

        stale_summary = dict(summary)
        stale_summary.update(
            {
                "items": runtime_items,
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "reason_totals": {"drift_checks_missing": 1},
                "informational_reason_totals": {},
            }
        )
        stale_gate = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary=stale_summary,
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(
                        capital_stage="shadow",
                        observed_stage="paper",
                    ),
                    "promotion_decision": self._promotion_decision(
                        capital_stage="shadow"
                    ),
                }
            ],
            session=session,
        )

        self.assertEqual(stale_gate["promotion_eligible_total"], 0)
        self.assertEqual(stale_gate["paper_probation_eligible_total"], 1)
        self.assertTrue(stale_gate["allowed"])
        self.assertEqual(stale_gate["reason"], "operational_submission_ready")
        self.assertEqual(stale_gate["blocked_reasons"], [])

        non_shadow_paper_gate = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary=stale_summary,
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(
                        capital_stage="0.10x canary",
                        observed_stage="paper",
                    ),
                    "promotion_decision": self._promotion_decision(
                        capital_stage="0.10x canary"
                    ),
                }
            ],
            session=session,
        )

        self.assertEqual(non_shadow_paper_gate["promotion_eligible_total"], 0)
        self.assertEqual(non_shadow_paper_gate["paper_probation_eligible_total"], 1)
        self.assertTrue(non_shadow_paper_gate["allowed"])
        self.assertEqual(
            non_shadow_paper_gate["reason"], "operational_submission_ready"
        )
        self.assertNotIn(
            "hypothesis_not_promotion_eligible",
            non_shadow_paper_gate["blocked_reasons"],
        )
        self.assertNotIn(
            "promotion_certificate_not_live_runtime",
            non_shadow_paper_gate["blocked_reasons"],
        )

    def test_hypothesis_runtime_summary_rejects_unmatched_promotion_decision(
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
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-current",
                    candidate_id="cand-runtime-current",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-old",
                    candidate_id="cand-runtime-old",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="old_runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

            forced_item = dict(result["items"][0])
            forced_item.update(
                {
                    "promotion_eligible": True,
                    "capital_stage": "0.10x canary",
                    "capital_multiplier": "0.10",
                    "reasons": [],
                }
            )
            forced_summary = dict(result)
            forced_summary["promotion_eligible_total"] = 1
            forced_summary["items"] = [forced_item]
            gate = build_live_submission_gate_payload(
                SimpleNamespace(market_session_open=False),
                hypothesis_summary=forced_summary,
                empirical_jobs_status={"ready": True},
                dspy_runtime_status={"mode": "inactive"},
                quant_health_status={"required": False, "ok": True},
                session=session,
            )

        self.assertEqual(result["promotion_eligible_total"], 0)
        item = result["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["reasons"], ["drift_checks_missing"])
        self.assertTrue(gate["allowed"])
        self.assertEqual(gate["reason"], "operational_submission_ready")
        self.assertNotIn("promotion_decision_evidence_missing", gate["blocked_reasons"])
        self.assertNotIn("promotion_certificate_missing", gate["blocked_reasons"])

    def test_hypothesis_runtime_summary_rejects_failed_runtime_proof(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-2",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=False,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-2",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 0)
        item = result["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["reasons"], ["drift_checks_missing"])

    def test_hypothesis_runtime_summary_rejects_zero_activity_runtime_proof(
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
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-zero",
                    candidate_id="cand-runtime-zero",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=0,
                    trade_count=0,
                    order_count=0,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-zero",
                    candidate_id="cand-runtime-zero",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.runtime_summary.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 0)
        item = result["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(
            item["reasons"],
            [
                "drift_checks_missing",
                "hypothesis_window_decisions_missing",
                "hypothesis_window_trades_missing",
                "hypothesis_window_orders_missing",
            ],
        )
        self.assertEqual(
            item["informational_reasons"],
            ["runtime_window_certificate_rejected"],
        )
        self.assertTrue(item["observed"]["runtime_window_certificate_rejected"])
        self.assertEqual(item["observed"]["metric_window_decision_count"], 0)
        self.assertEqual(item["observed"]["metric_window_trade_count"], 0)
        self.assertEqual(item["observed"]["metric_window_order_count"], 0)
