from __future__ import annotations

from tests.submission_council.support import (
    SimpleNamespace,
    SubmissionCouncilTestCase,
    build_live_submission_gate_payload,
)


class TestLiveSubmissionGateProbationDiagnostics(SubmissionCouncilTestCase):
    def test_build_live_submission_gate_payload_scopes_paper_probation_blockers_to_runtime_candidate(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=900,
                last_market_context_domain_states={"news": "stale"},
                market_context_alert_active=True,
                market_context_alert_reason="market_context_stale",
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 0,
                    "paper_probation_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 2},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "lane_id": "microbar-cross-sectional-pairs",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                        "promotion_eligible": False,
                        "paper_probation_eligible": True,
                        "capital_stage": "shadow",
                        "reasons": ["paper_probation_evidence_collection_only"],
                        "segment_dependencies": ["execution", "empirical", "ta-core"],
                    },
                    {
                        "hypothesis_id": "H-REV-01",
                        "candidate_id": "rev-candidate",
                        "lane_id": "event-reversion",
                        "strategy_family": "event_reversion",
                        "strategy_id": "microbar_prev_day_open45_reversal_long_top1_chip_v1@paper",
                        "promotion_eligible": False,
                        "paper_probation_eligible": False,
                        "capital_stage": "shadow",
                        "reasons": [],
                        "segment_dependencies": [
                            "execution",
                            "empirical",
                            "llm-review",
                            "market-context",
                            "ta-core",
                        ],
                    },
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "metric_window": self._metric_window(
                        observed_stage="paper",
                        run_id="pairs-paper-window",
                        candidate_id="c88421d619759b2cfaa6f4d0",
                        hypothesis_id="H-PAIRS-01",
                    ),
                    "promotion_decision": self._promotion_decision(
                        run_id="pairs-paper-window",
                        candidate_id="c88421d619759b2cfaa6f4d0",
                        hypothesis_id="H-PAIRS-01",
                    ),
                },
                {
                    "hypothesis_id": "H-REV-01",
                    "metric_window": self._metric_window(
                        run_id="rev-live-window",
                        candidate_id="rev-candidate",
                        hypothesis_id="H-REV-01",
                    ),
                    "promotion_decision": self._promotion_decision(
                        run_id="rev-live-window",
                        candidate_id="rev-candidate",
                        hypothesis_id="H-REV-01",
                    ),
                },
            ],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["reason"], "operational_submission_ready")
        self.assertEqual(result["blocked_reasons"], [])
        self.assertNotIn(
            "promotion_certificate_not_live_runtime",
            result["blocked_reasons"],
        )
        self.assertNotIn("segment_market-context_blocked", result["blocked_reasons"])
        self.assertNotIn("market_context_stale", result["blocked_reasons"])
        self.assertNotIn(
            "market_context_domain_news_stale",
            result["blocked_reasons"],
        )

    def test_build_live_submission_gate_payload_keeps_missing_certificate_diagnostic_only(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["capital_state"], "live")
        self.assertEqual(result["reason"], "operational_submission_ready")
        self.assertNotIn(
            "hypothesis_window_evidence_missing", result["blocked_reasons"]
        )
        contract = result["profit_window_contract"]
        self.assertEqual(
            contract["schema_version"], "torghut.profit-window-contract.v1"
        )
        self.assertEqual(contract["summary"]["windows_total"], 0)

    def test_build_live_submission_gate_payload_keeps_shadow_runtime_item_diagnostic_only(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "promotion_eligible": False,
                        "capital_stage": "shadow",
                        "reasons": ["signal_continuity_alert_active"],
                        "segment_dependencies": ["ta-core", "execution"],
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["capital_state"], "live")
        self.assertEqual(result["reason"], "operational_submission_ready")
        self.assertNotIn(
            "hypothesis_not_promotion_eligible",
            result["blocked_reasons"],
        )
        self.assertNotIn("alpha_hypothesis_shadow_only", result["blocked_reasons"])

    def test_build_live_submission_gate_payload_keeps_quant_health_diagnostic_only(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status={
                "required": True,
                "ok": False,
                "reason": "quant_health_not_configured",
                "blocking_reasons": ["quant_health_not_configured"],
                "account": "paper",
                "window": "15m",
                "status": "unknown",
                "source_url": None,
            },
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["reason"], "operational_submission_ready")
        self.assertNotIn("quant_health_not_configured", result["blocked_reasons"])
        self.assertIn(
            "quant_health_not_configured",
            result["quant_evidence"]["blocking_reasons"],
        )
