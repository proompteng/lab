from __future__ import annotations

from tests.api.trading_api_support import (
    SimpleNamespace,
    TradingApiTestCaseBase,
    TradingScheduler,
    _json_paths_containing,
    _mark_static_universe_loaded,
    app,
    datetime,
    patch,
    settings,
    timezone,
)


class TestTradingApiLiveGateLlm(TradingApiTestCaseBase):
    def test_trading_status_includes_llm_evaluation(self) -> None:
        with patch("app.api.trading_status.SessionLocal", self.session_local):
            response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("hypotheses", payload)
        self.assertIn("llm_evaluation", payload)
        self.assertIn("control_plane_contract", payload)
        self.assertIn("build", payload)
        self.assertIn("shadow_first", payload)
        self.assertIn("forecast_service", payload)
        self.assertIn("lean_authority", payload)
        self.assertIn("empirical_jobs", payload)
        self.assertIn("profit_lease_projection", payload)
        self.assertIn("renewal_bond_profit_escrow", payload)
        self.assertEqual(
            payload["profit_lease_projection"]["schema_version"],
            "torghut.profit-lease-provenance.v1",
        )
        self.assertEqual(
            payload["renewal_bond_profit_escrow"]["schema_version"],
            "torghut.renewal-bond-profit-escrow.v1",
        )
        self.assertEqual(
            payload["profit_lease_projection"]["torghut_capital"]["action_class"],
            "torghut_capital",
        )
        for retired_label in (
            "jangar_consumer",
            "jangar_action_lease",
            "jangar_quant",
            "jangar_custody",
            "jangar_routeability",
            "jangar_stage_clearance",
            "required_jangar",
        ):
            self.assertEqual(
                _json_paths_containing(payload, retired_label),
                [],
                f"retired label {retired_label} leaked into /trading/status",
            )
        evaluation = payload["llm_evaluation"]
        self.assertTrue(evaluation["ok"])
        self.assertGreaterEqual(evaluation["metrics"]["total_reviews"], 1)
        hypotheses = payload["hypotheses"]
        self.assertTrue(hypotheses["registry_loaded"])
        self.assertEqual(len(hypotheses["items"]), 5)
        self.assertEqual(hypotheses["dependency_quorum"]["decision"], "allow")
        self.assertEqual(
            hypotheses["dependency_quorum"]["reasons"],
            ["torghut_dependency_quorum_not_required"],
        )
        control_plane_contract = payload["control_plane_contract"]
        self.assertEqual(
            control_plane_contract["contract_version"], "torghut.quant-producer.v1"
        )
        self.assertIn("signal_lag_seconds", control_plane_contract)
        self.assertIn("signal_continuity_state", control_plane_contract)
        self.assertIn("signal_continuity_alert_active", control_plane_contract)
        self.assertIn("signal_continuity_promotion_block_total", control_plane_contract)
        self.assertIn("signal_expected_staleness_total", control_plane_contract)
        self.assertIn("submission_block_total", control_plane_contract)
        self.assertIn("decision_state_total", control_plane_contract)
        self.assertIn("planned_decision_age_seconds", control_plane_contract)
        self.assertIn("market_session_open", control_plane_contract)
        self.assertIn("universe_fail_safe_blocked", control_plane_contract)
        self.assertIn("domain_telemetry_event_total", control_plane_contract)
        self.assertIn("domain_telemetry_dropped_total", control_plane_contract)
        self.assertEqual(control_plane_contract["alpha_readiness_hypotheses_total"], 5)
        self.assertEqual(control_plane_contract["alpha_readiness_blocked_total"], 4)
        self.assertEqual(control_plane_contract["alpha_readiness_shadow_total"], 1)
        self.assertIn(control_plane_contract["active_capital_stage"], {"shadow", None})
        self.assertIn("critical_toggle_parity", control_plane_contract)
        self.assertIn(
            payload["shadow_first"]["critical_toggle_parity"]["status"],
            {"aligned", "diverged"},
        )
        self.assertEqual(
            payload["build"]["active_revision"],
            control_plane_contract["active_revision"],
        )
        self.assertEqual(
            control_plane_contract["alpha_readiness_dependency_quorum_decision"],
            "allow",
        )
        self.assertIn(
            payload["forecast_service"]["authority"], {"empirical", "blocked"}
        )
        self.assertIn(payload["lean_authority"]["authority"], {"empirical", "blocked"})
        self.assertIn(payload["empirical_jobs"]["authority"], {"empirical", "blocked"})

    def test_trading_status_blocks_live_submission_on_critical_toggle_parity_divergence(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_pipeline_mode = "simple"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = False
            settings.trading_kill_switch_enabled = True

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler

            hypothesis_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            dependency_quorum = SimpleNamespace(
                decision="allow",
                as_payload=lambda: {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            )

            with (
                patch(
                    "app.api.status_helpers._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": hypothesis_summary[
                                "dependency_quorum"
                            ],
                            "summary": hypothesis_summary,
                            "items": [],
                        },
                        hypothesis_summary,
                        dependency_quorum,
                    ),
                ),
                patch(
                    "app.api.trading_status._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            gate = payload["live_submission_gate"]
            self.assertFalse(gate["allowed"])
            self.assertEqual(gate["reason"], "kill_switch_enabled")
            self.assertIn("kill_switch_enabled", gate["blocked_reasons"])
            self.assertEqual(gate["critical_toggle_parity"]["status"], "diverged")
        finally:
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_autonomy_enabled = original["trading_autonomy_enabled"]
            settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_keeps_quant_latest_store_empty_diagnostic_only(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": settings.trading_live_submit_enabled,
            "trading_testnet_after_hours_enabled": (
                settings.trading_testnet_after_hours_enabled
            ),
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = True
            settings.trading_kill_switch_enabled = False
            settings.trading_simple_submit_enabled = True
            settings.trading_live_submit_enabled = True
            settings.trading_testnet_after_hours_enabled = True

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler

            hypothesis_summary = {
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            }
            dependency_quorum = SimpleNamespace(
                decision="allow",
                as_payload=lambda: {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            )

            with (
                patch(
                    "app.api.status_helpers._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": hypothesis_summary[
                                "dependency_quorum"
                            ],
                            "summary": hypothesis_summary,
                            "items": [],
                        },
                        hypothesis_summary,
                        dependency_quorum,
                    ),
                ),
                patch(
                    "app.api.trading_status._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.api.trading_status.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": False,
                        "status": "degraded",
                        "reason": "quant_latest_metrics_empty",
                        "blocking_reasons": [
                            "quant_latest_metrics_empty",
                            "quant_latest_store_alarm",
                        ],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://torghut.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
                        "latest_metrics_count": 0,
                        "latest_metrics_updated_at": None,
                        "empty_latest_store_alarm": True,
                        "missing_update_alarm": False,
                        "metrics_pipeline_lag_seconds": None,
                        "stage_count": 0,
                        "max_stage_lag_seconds": 0,
                        "stages": [],
                    },
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            gate = payload["live_submission_gate"]
            self.assertTrue(gate["allowed"])
            self.assertEqual(gate["reason"], "operational_submission_ready")
            self.assertEqual(gate["capital_state"], "live")
            self.assertNotIn("quant_latest_store_alarm", gate["blocked_reasons"])
            self.assertEqual(payload["execution_route"], "testnet")
            self.assertTrue(payload["operational_submission_gate"]["allowed"])
            self.assertEqual(payload["quant_evidence"]["window"], "15m")
            self.assertFalse(payload["quant_evidence"]["ok"])
        finally:
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_autonomy_enabled = original["trading_autonomy_enabled"]
            settings.trading_autonomy_allow_live_promotion = original[
                "trading_autonomy_allow_live_promotion"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            settings.trading_testnet_after_hours_enabled = original[
                "trading_testnet_after_hours_enabled"
            ]
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_live_submission_gate_matches_status_health_and_readyz(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_mode = settings.trading_mode
        original_enabled = settings.trading_enabled
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            scheduler = TradingScheduler()
            scheduler.state.running = True
            scheduler.state.last_run_at = datetime.now(timezone.utc)
            _mark_static_universe_loaded(scheduler)
            app.state.trading_scheduler = scheduler
            shared_gate = {
                "allowed": False,
                "reason": "promotion_certificate_missing",
                "blocked_reasons": [
                    "promotion_certificate_missing",
                    "hypothesis_window_evidence_missing",
                ],
                "certificate_id": None,
                "capital_stage": "shadow",
                "capital_state": "observe",
                "issued_at": None,
                "expires_at": None,
                "reason_codes": [
                    "promotion_certificate_missing",
                    "hypothesis_window_evidence_missing",
                ],
                "segment_summary": {
                    "segments": {
                        "execution": {"state": "ok", "reason_codes": []},
                        "empirical": {"state": "ok", "reason_codes": []},
                        "llm-review": {"state": "ok", "reason_codes": []},
                        "market-context": {"state": "ok", "reason_codes": []},
                        "ta-core": {"state": "ok", "reason_codes": []},
                    },
                    "evaluated_hypotheses": [],
                },
                "quant_health_ref": {
                    "account": "paper",
                    "window": "15m",
                    "status": "healthy",
                    "source_url": "http://torghut.test/quant/health",
                    "latest_metrics_updated_at": "2026-03-20T10:00:00Z",
                },
                "market_context_ref": {"last_freshness_seconds": 30},
                "evidence_tuple": {
                    "hypothesis_id": None,
                    "candidate_id": None,
                    "strategy_id": None,
                    "account": "paper",
                    "window": "15m",
                    "capital_state": "observe",
                },
                "lineage_ref": {
                    "status": "unverified",
                    "candidate_id": None,
                    "hypothesis_id": None,
                    "dataset_snapshot_count": 0,
                    "dataset_snapshot_id": None,
                    "dataset_snapshot_ref": None,
                    "dataset_snapshot_run_id": None,
                    "strategy_hypothesis_count": 0,
                    "strategy_hypothesis_id": None,
                    "lane_id": None,
                    "strategy_family": None,
                },
                "evaluated_tuples": [],
            }

            with (
                patch(
                    "app.api.status_helpers._build_hypothesis_runtime_payload",
                    return_value=(
                        {
                            "registry_loaded": True,
                            "registry_path": "test",
                            "registry_errors": [],
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                            "summary": {
                                "promotion_eligible_total": 1,
                                "capital_stage_totals": {"shadow": 1},
                                "dependency_quorum": {
                                    "decision": "allow",
                                    "reasons": [],
                                    "message": "ready",
                                },
                            },
                            "items": [],
                        },
                        {
                            "promotion_eligible_total": 1,
                            "capital_stage_totals": {"shadow": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        SimpleNamespace(
                            decision="allow",
                            as_payload=lambda: {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        ),
                    ),
                ),
                patch(
                    "app.api.trading_status._empirical_jobs_status",
                    return_value={"ready": True, "status": "healthy"},
                ),
                patch(
                    "app.api.trading_status.load_quant_evidence_status",
                    return_value={
                        "required": True,
                        "ok": True,
                        "status": "healthy",
                        "reason": "ready",
                        "blocking_reasons": [],
                        "account": "paper",
                        "window": "15m",
                        "source_url": "http://torghut.test/quant/health",
                        "latest_metrics_updated_at": "2026-03-20T10:00:00Z",
                    },
                ),
                patch(
                    "app.api.trading_status._build_live_submission_gate_payload",
                    return_value=shared_gate,
                ),
                patch(
                    "app.api.readiness_helpers.status_dependencies.build_api_live_submission_gate_payload",
                    return_value=shared_gate,
                ),
                patch(
                    "app.api.runtime_profitability._build_live_submission_gate_payload",
                    return_value=shared_gate,
                ),
            ):
                status_response = self.client.get("/trading/status")
                health_response = self.client.get("/trading/health")
                ready_response = self.client.get("/readyz")
                runtime_response = self.client.get("/trading/profitability/runtime")

            self.assertEqual(status_response.status_code, 200)
            self.assertEqual(health_response.status_code, 503)
            self.assertEqual(ready_response.status_code, 503)
            self.assertEqual(runtime_response.status_code, 200)
            self.assertEqual(
                status_response.json()["live_submission_gate"], shared_gate
            )
            self.assertEqual(
                health_response.json()["live_submission_gate"], shared_gate
            )
            self.assertEqual(
                runtime_response.json()["live_submission_gate"],
                shared_gate,
            )
            ready_gate = ready_response.json()["live_submission_gate"]
            self.assertFalse(ready_gate["allowed"])
            self.assertFalse(ready_gate["promotion_authority"])
            self.assertFalse(ready_gate["final_authority_ok"])
            self.assertFalse(ready_gate["final_promotion_allowed"])
            self.assertFalse(ready_gate["read_model_evaluated"])
            self.assertEqual(
                ready_gate["reason"],
                "readyz_core_dependencies_only",
            )
            self.assertNotIn("repair_receipt_frontier", ready_response.json())
            self.assertNotIn("repair_outcome_dividend_ledger", ready_response.json())
        finally:
            settings.trading_mode = original_mode
            settings.trading_enabled = original_enabled
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler
