from __future__ import annotations

from tests.verify_trading_readiness.support import (
    Path,
    _TestVerifyTradingReadinessBase,
    _load_from_test_server,
    _paper_route_evidence,
    _proofs_evidence,
    _ready_status,
    evaluate_trading_readiness,
    json,
    tempfile,
    verifier,
)


class TestPaperRouteTargetPlanCanBeRequiredBeforeSessionOpen(
    _TestVerifyTradingReadinessBase
):
    def test_paper_route_target_plan_can_be_required_before_session_open(self) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0

        result = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(),
            require_market_open=False,
            require_paper_route_target_plan=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["paper_route_target_plan"]["target_count"], 1)
        self.assertEqual(
            result["paper_route_target_plan"]["import_blockers"],
            ["alpaca_regular_session_closed"],
        )
        self.assertEqual(
            result["paper_route_target_plan"]["missing_required_flags"], []
        )
        self.assertEqual(result["paper_route_target_plan"]["missing_identity_count"], 0)

    def test_paper_route_target_plan_fails_closed_on_dirty_account(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                account_state_blockers=["paper_route_account_window_start_not_flat"],
                account_contamination_blockers=[
                    "paper_route_account_contamination_detected"
                ],
            ),
            require_paper_route_target_plan=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("paper_route_target_plan_account_clean", result["failed_checks"])
        self.assertEqual(
            result["paper_route_target_plan"]["account_clean_blockers"],
            [
                "paper_route_account_contamination_detected",
                "paper_route_account_window_start_not_flat",
            ],
        )

    def test_preopen_paper_route_evidence_collection_softens_current_route_failures(
        self,
    ) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "hypothesis_not_promotion_eligible",
                    "degraded",
                    "execution_tca_slippage_guardrail_exceeded",
                ],
            }
        )
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get("dimension") == "alpha_readiness":
                dimension["state"] = "fail"
                dimension["reason"] = "hypothesis_not_promotion_eligible"
            if dimension.get("dimension") == "execution_tca":
                dimension["state"] = "fail"
                dimension["reason"] = "execution_tca_slippage_guardrail_exceeded"
                source_ref = dimension["source_ref"]
                assert isinstance(source_ref, dict)
                symbol_routes = source_ref["symbol_routes"]
                assert isinstance(symbol_routes, dict)
                symbol_routes.update(
                    {
                        "routeable_symbol_count": 0,
                        "routeable_symbols": [],
                    }
                )

        status["route_reacquisition_board"] = {
            "schema_version": "torghut.route-reacquisition-board.v1",
            "state": "repair_only",
            "capital_state": "zero_notional",
            "jangar_continuity": {
                "epoch_id": "truth-settlement:paper_canary:preopen",
                "state": "present",
                "decision": "allow",
                "fresh_until": "2026-05-29T13:30:00+00:00",
                "blocking_reasons": [],
            },
            "summary": {
                "row_count": 4,
                "state_counts": {"probing": 4},
                "zero_notional_row_count": 4,
                "expected_unblock_value": 12,
                "top_repair_symbols": ["AAPL", "AMZN", "INTC", "NVDA"],
                "capital_eligible_symbol_count": 0,
            },
            "rows": [
                {"symbol": "AAPL", "state": "probing", "max_notional": "0"},
                {"symbol": "AMZN", "state": "probing", "max_notional": "0"},
            ],
        }
        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        route_book["state"] = "repair_only"
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "active": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "63180.0",
                "eligible_symbol_count": 2,
                "eligible_symbols": ["AAPL", "AMZN"],
                "active_symbols": [],
                "blocking_reasons": ["market_session_closed"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_eligible_symbols"] = ["AAPL", "AMZN"]
        summary["paper_route_probe_active_symbols"] = []

        strict = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(),
            require_market_open=False,
            require_quant_fresh=False,
            require_paper_route_probe_candidate=True,
            require_paper_route_target_plan=True,
        )
        preopen = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(),
            require_market_open=False,
            require_quant_fresh=False,
            require_paper_route_probe_candidate=True,
            require_paper_route_target_plan=True,
            allow_paper_route_preopen_evidence_collection=True,
        )

        self.assertFalse(strict["ok"])
        self.assertIn("max_notional_positive", strict["failed_checks"])
        self.assertTrue(preopen["ok"], preopen)
        preopen_summary = preopen["paper_route_preopen_evidence_collection"]
        self.assertTrue(preopen_summary["ready"])
        self.assertIn(
            "max_notional_positive",
            preopen_summary["softened_checks"],
        )
        self.assertTrue(
            preopen["checks"]["max_notional_positive"]["detail"][
                "preopen_evidence_collection_override"
            ]
        )

    def test_preopen_target_plan_check_does_not_require_separate_probe_flag(
        self,
    ) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "hypothesis_not_promotion_eligible",
                    "execution_tca_slippage_guardrail_exceeded",
                ],
            }
        )
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get("dimension") == "alpha_readiness":
                dimension["state"] = "fail"
                dimension["reason"] = "hypothesis_not_promotion_eligible"
            if dimension.get("dimension") == "execution_tca":
                dimension["state"] = "fail"
                dimension["reason"] = "execution_tca_slippage_guardrail_exceeded"

        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        route_book["state"] = "repair_only"
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "active": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "63180.0",
                "eligible_symbol_count": 2,
                "eligible_symbols": ["AAPL", "AMZN"],
                "active_symbols": [],
                "blocking_reasons": ["market_session_closed"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_eligible_symbols"] = ["AAPL", "AMZN"]
        summary["paper_route_probe_active_symbols"] = []

        result = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(),
            require_market_open=False,
            require_quant_fresh=False,
            require_paper_route_target_plan=True,
            allow_paper_route_preopen_evidence_collection=True,
        )

        self.assertTrue(result["ok"], result)
        preopen_summary = result["paper_route_preopen_evidence_collection"]
        self.assertTrue(preopen_summary["ready"])
        self.assertTrue(
            preopen_summary["conditions"]["probe_candidate_requirement_satisfied"]
        )

    def test_preopen_softening_requires_clean_paper_account(self) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "hypothesis_not_promotion_eligible",
                    "execution_tca_slippage_guardrail_exceeded",
                ],
            }
        )
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get("dimension") == "alpha_readiness":
                dimension["state"] = "fail"
                dimension["reason"] = "hypothesis_not_promotion_eligible"
            if dimension.get("dimension") == "execution_tca":
                dimension["state"] = "fail"
                dimension["reason"] = "execution_tca_slippage_guardrail_exceeded"

        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        route_book["state"] = "repair_only"
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "active": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "63180.0",
                "eligible_symbol_count": 2,
                "eligible_symbols": ["AAPL", "AMZN"],
                "active_symbols": [],
                "blocking_reasons": ["market_session_closed"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_eligible_symbols"] = ["AAPL", "AMZN"]
        summary["paper_route_probe_active_symbols"] = []

        result = evaluate_trading_readiness(
            status,
            paper_route_evidence=_paper_route_evidence(
                account_state_blockers=["paper_route_account_window_start_not_flat"],
            ),
            require_market_open=False,
            require_quant_fresh=False,
            require_paper_route_target_plan=True,
            allow_paper_route_preopen_evidence_collection=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("paper_route_target_plan_account_clean", result["failed_checks"])
        preopen_summary = result["paper_route_preopen_evidence_collection"]
        self.assertFalse(preopen_summary["ready"])
        self.assertFalse(preopen_summary["conditions"]["target_plan_account_clean"])

    def test_proofs_payload_summarizes_target_plan_readiness(self) -> None:
        summary = verifier._paper_route_target_plan_summary(
            _proofs_evidence(
                state="proof_ready",
                blockers=[],
                account_blockers=["account_not_flat_after_window"],
                health_blockers=["dependency_quorum_blocked"],
            )
        )

        self.assertTrue(summary["present"])
        self.assertEqual(summary["schema_version"], "torghut.proofs.v1")
        self.assertEqual(summary["target_count"], 1)
        self.assertEqual(summary["probe_contract_count"], 1)
        self.assertEqual(summary["missing_identity_count"], 0)
        self.assertTrue(summary["import_ready"])
        self.assertEqual(
            summary["account_clean_blockers"], ["account_not_flat_after_window"]
        )
        self.assertEqual(
            summary["runtime_window_import_health_gate"]["blockers"],
            ["dependency_quorum_blocked"],
        )
        self.assertEqual(
            summary["targets"][0]["paper_route_probe_symbols"], ["AAPL", "AMZN"]
        )

    def test_paper_route_target_plan_fails_closed_on_missing_handoff_or_identity(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                required_flags=["--runtime-window-import"],
                target_overrides={
                    "strategy_name": "",
                    "paper_route_probe_symbols": [],
                    "promotion_allowed": True,
                    "max_notional": "25",
                },
            ),
            require_paper_route_target_plan=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("paper_route_target_plan_handoff_flags", result["failed_checks"])
        self.assertIn(
            "paper_route_target_plan_target_identity", result["failed_checks"]
        )
        self.assertIn("paper_route_target_plan_probe_contract", result["failed_checks"])
        self.assertIn(
            "paper_route_target_plan_promotion_blocked", result["failed_checks"]
        )

    def test_paper_route_import_ready_is_separate_from_target_plan_presence(
        self,
    ) -> None:
        waiting = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )
        self.assertFalse(waiting["ok"])
        self.assertIn("paper_route_target_plan_import_ready", waiting["failed_checks"])

        ready = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(import_ready=True),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )
        self.assertTrue(ready["ok"], ready)

    def test_paper_route_readiness_surfaces_quote_fillability_blockers(
        self,
    ) -> None:
        evidence = _paper_route_evidence(import_ready=True)
        runtime_window_audit = evidence["runtime_window_import_audit"]
        assert isinstance(runtime_window_audit, dict)
        diagnostics = runtime_window_audit["diagnostics"]
        assert isinstance(diagnostics, dict)
        diagnostics["rejected_signal_diagnostic_reasons"] = [
            "source_signal_rejected_by_quote_quality",
            "source_reject_missing_bid",
            "source_reject_spread_bps_exceeded",
        ]

        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=evidence,
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "paper_route_target_plan_quote_fillability", result["failed_checks"]
        )
        self.assertEqual(
            result["next_action"],
            "repair_quote_quality_or_fillability_before_runtime_ledger_collection",
        )
        quote_fillability = result["paper_route_target_plan"]["quote_fillability"]
        self.assertTrue(quote_fillability["blocked"])
        self.assertEqual(quote_fillability["state"], "blocked")
        self.assertEqual(
            quote_fillability["repair_action"],
            "collect_bid_quote_before_routeability_claim",
        )
        self.assertEqual(
            quote_fillability["blocking_reasons"],
            [
                "source_reject_missing_bid",
                "source_reject_spread_bps_exceeded",
                "source_signal_rejected_by_quote_quality",
            ],
        )

    def test_paper_route_readiness_surfaces_target_quote_fillability_context(
        self,
    ) -> None:
        evidence = _paper_route_evidence(
            import_ready=True,
            target_overrides={
                "symbol": "AAPL",
                "quote_routeability": {
                    "symbol": "AAPL",
                    "status": "blocked",
                    "reason": "quote_feed_gap",
                    "reason_codes": ["quote_temporarily_unavailable"],
                    "quote_age_seconds": "61",
                    "spread_bps": "24.5",
                    "source": "paper_route_nbbo",
                },
            },
        )
        runtime_window_audit = evidence["runtime_window_import_audit"]
        assert isinstance(runtime_window_audit, dict)
        runtime_window_audit["blockers"] = ["spread_bps_exceeded"]
        runtime_window_audit["target_blockers"] = [
            {"blockers": ["source_reject_missing_ask"]}
        ]
        evidence["target_audits"] = [
            {
                "target": {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_name": "microbar-pairs-vwap-cap-safe",
                },
                "rejected_signal_activity": {
                    "blocking_reasons": ["source_reject_non_positive_ask"],
                    "reason_counts": [
                        {"reason": "source_reject_crossed_quote", "count": 2}
                    ],
                    "max_spread_bps": "98.1",
                },
            }
        ]

        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=evidence,
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertFalse(result["ok"])
        quote_fillability = result["paper_route_target_plan"]["quote_fillability"]
        self.assertTrue(quote_fillability["blocked"])
        self.assertEqual(
            quote_fillability["blocking_reasons"],
            [
                "quote_feed_gap",
                "quote_temporarily_unavailable",
                "source_reject_crossed_quote",
                "source_reject_missing_ask",
                "source_reject_non_positive_ask",
                "spread_bps_exceeded",
            ],
        )
        self.assertEqual(len(quote_fillability["targets"]), 2)
        self.assertEqual(
            quote_fillability["targets"][0]["repair_action"],
            "repair_quote_quality_or_fillability_before_runtime_ledger_collection",
        )
        self.assertEqual(
            quote_fillability["targets"][1]["repair_action"],
            "refresh_ask_quote_before_routeability_claim",
        )

    def test_quote_fillability_summary_reads_routeability_and_audit_shapes(
        self,
    ) -> None:
        evidence = _paper_route_evidence(import_ready=True)
        target_plan = evidence["next_paper_route_runtime_window_targets"]
        assert isinstance(target_plan, dict)
        targets = target_plan["targets"]
        assert isinstance(targets, list)
        target = targets[0]
        assert isinstance(target, dict)
        target["paper_route_quote_routeability"] = {
            "status": "blocked",
            "symbol": "AAPL",
            "reason": "stale_quote",
            "blocking_reasons": ["routeability_spread_guardrail_exceeded"],
            "quote_age_seconds": "61",
            "spread_bps": "75",
            "source": "paper_route_h_pairs_quote",
        }
        runtime_window_audit = evidence["runtime_window_import_audit"]
        assert isinstance(runtime_window_audit, dict)
        runtime_window_audit["blockers"] = ["fillability_receipt_missing"]
        runtime_window_audit["target_blockers"] = [
            {
                "hypothesis_id": "H-PAIRS-01",
                "blockers": ["source_reject_missing_ask"],
            }
        ]
        evidence["target_audits"] = [
            {
                "target": target,
                "rejected_signal_activity": {
                    "blocking_reasons": ["source_signal_rejected_by_quote_quality"],
                    "reason_counts": [{"reason": "spread_bps_exceeded", "count": 2}],
                    "max_spread_bps": "90",
                },
            }
        ]

        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=evidence,
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertFalse(result["ok"])
        quote_fillability = result["paper_route_target_plan"]["quote_fillability"]
        self.assertTrue(quote_fillability["present"])
        self.assertTrue(quote_fillability["blocked"])
        self.assertIn("stale_quote", quote_fillability["blocking_reasons"])
        self.assertIn(
            "routeability_spread_guardrail_exceeded",
            quote_fillability["blocking_reasons"],
        )
        self.assertIn(
            "source_signal_rejected_by_quote_quality",
            quote_fillability["blocking_reasons"],
        )
        self.assertEqual(quote_fillability["targets"][0]["symbol"], "AAPL")
        self.assertEqual(
            quote_fillability["targets"][0]["repair_action"],
            "refresh_quote_snapshot_and_recompute_route_fillability",
        )
        self.assertEqual(
            quote_fillability["targets"][1]["source"], "rejected_signal_activity"
        )

    def test_quote_fillability_helpers_keep_generic_repair_fallback(
        self,
    ) -> None:
        self.assertEqual(
            verifier._quote_fillability_reason("routeability_depth_missing"),
            "routeability_depth_missing",
        )
        self.assertEqual(
            verifier._quote_fillability_repair_action(["routeability_depth_missing"]),
            "repair_quote_quality_or_fillability_before_runtime_ledger_collection",
        )
        self.assertEqual(
            verifier._readiness_next_action(
                failed_checks=["paper_route_target_plan_quote_fillability"],
                checks={
                    "paper_route_target_plan_quote_fillability": {
                        "observed": {"blocking_reasons": []}
                    }
                },
                runtime_ledger_proof_packet=None,
            ),
            "repair_quote_quality_or_fillability_before_runtime_ledger_collection",
        )

    def test_paper_route_target_plan_allows_drift_only_evidence_collection(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=True,
                target_overrides={
                    "continuity_reason": "signal_continuity_nominal",
                    "drift_ok": "false",
                    "drift_reason": "drift_live_promotion_ineligible",
                    "runtime_window_import_health_gate": {
                        "schema_version": "torghut.runtime-window-import-health-gate.v1",
                        "dependency_quorum_decision": "allow",
                        "continuity_ok": "true",
                        "continuity_reason": "signal_continuity_nominal",
                        "drift_ok": "false",
                        "drift_reason": "drift_live_promotion_ineligible",
                        "blockers": [],
                        "promotion_blockers": ["drift_checks_not_ok"],
                    },
                    "runtime_window_import_health_gate_blockers": [],
                },
            ),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertTrue(result["ok"], result)
        health_gate = result["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 1)
        self.assertEqual(health_gate["blocked_target_count"], 0)
        self.assertEqual(health_gate["blockers"], [])
        self.assertEqual(health_gate["promotion_blockers"], ["drift_checks_not_ok"])
        self.assertEqual(
            health_gate["continuity_reasons"], ["signal_continuity_nominal"]
        )
        self.assertEqual(
            health_gate["drift_reasons"], ["drift_live_promotion_ineligible"]
        )
        target = result["paper_route_target_plan"]["targets"][0]
        self.assertEqual(target["continuity_reason"], "signal_continuity_nominal")
        self.assertEqual(target["drift_reason"], "drift_live_promotion_ineligible")

    def test_paper_route_target_plan_synthesizes_drift_promotion_blocker(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=True,
                target_overrides={
                    "drift_ok": "false",
                    "runtime_window_import_health_gate": {
                        "schema_version": "torghut.runtime-window-import-health-gate.v1",
                        "dependency_quorum_decision": "allow",
                        "continuity_ok": "true",
                        "drift_ok": "false",
                        "blockers": [],
                        "promotion_blockers": [],
                    },
                    "runtime_window_import_health_gate_blockers": [],
                },
            ),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertTrue(result["ok"], result)
        health_gate = result["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 1)
        self.assertEqual(health_gate["blocked_target_count"], 0)
        self.assertEqual(health_gate["blockers"], [])
        self.assertEqual(health_gate["promotion_blockers"], ["drift_not_ok"])

    def test_paper_route_target_plan_requires_runtime_import_health_gate(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            paper_route_evidence=_paper_route_evidence(
                import_ready=True,
                target_overrides={
                    "dependency_quorum_decision": "missing",
                    "continuity_ok": "false",
                    "runtime_window_import_health_gate": {
                        "schema_version": "torghut.runtime-window-import-health-gate.v1",
                        "dependency_quorum_decision": "missing",
                        "continuity_ok": "false",
                        "drift_ok": "true",
                        "blockers": [
                            "dependency_quorum_not_allow",
                            "continuity_not_ok",
                        ],
                    },
                    "runtime_window_import_health_gate_blockers": [
                        "dependency_quorum_not_allow",
                        "continuity_not_ok",
                    ],
                },
            ),
            require_paper_route_target_plan=True,
            require_paper_route_import_ready=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "paper_route_target_plan_import_health_gate", result["failed_checks"]
        )
        health_gate = result["paper_route_target_plan"][
            "runtime_window_import_health_gate"
        ]
        self.assertEqual(health_gate["ready_target_count"], 0)
        self.assertEqual(health_gate["blocked_target_count"], 1)
        self.assertEqual(
            health_gate["blockers"],
            ["continuity_not_ok", "dependency_quorum_not_allow"],
        )

    def test_required_paper_route_probe_candidate_fails_without_bounded_candidate(
        self,
    ) -> None:
        status = _ready_status()
        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "configured_enabled": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "0",
                "eligible_symbol_count": 0,
                "eligible_symbols": [],
                "active_symbols": [],
                "blocking_reasons": ["paper_route_probe_disabled"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_eligible_symbols"] = []
        summary["paper_route_probe_active_symbols"] = []

        result = evaluate_trading_readiness(
            status, require_paper_route_probe_candidate=True
        )

        self.assertFalse(result["ok"])
        self.assertIn("paper_route_probe_configured", result["failed_checks"])
        self.assertIn("paper_route_probe_candidate_symbols", result["failed_checks"])
        self.assertIn("paper_route_probe_notional_positive", result["failed_checks"])
        self.assertIn("paper_route_probe_blockers", result["failed_checks"])

    def test_payload_helpers_handle_runtime_payload_shapes(self) -> None:
        self.assertTrue(verifier._bool("open"))
        self.assertFalse(verifier._bool(object()))
        self.assertEqual(verifier._int(True), 1)
        self.assertEqual(verifier._int(3.8), 3)
        self.assertEqual(verifier._int("7.9"), 7)
        self.assertEqual(verifier._int("not-a-number", default=4), 4)
        self.assertEqual(verifier._int("", default=4), 4)
        self.assertIsNone(verifier._decimal(None))
        self.assertIsNone(verifier._decimal("not-a-number"))
        self.assertEqual(verifier._mapping(object()), {})
        self.assertEqual(verifier._sequence("NVDA"), [])

    def test_status_loaders_require_json_objects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "status.json"
            status_path.write_text(
                json.dumps(["not", "an", "object"]), encoding="utf-8"
            )

            with self.assertRaisesRegex(ValueError, "json_object_required"):
                verifier._load_json_object(status_path)

        self.assertEqual(_load_from_test_server({"ok": True}), {"ok": True})
        with self.assertRaisesRegex(ValueError, "json_object_required"):
            _load_from_test_server(["not", "an", "object"])
