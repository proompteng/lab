from __future__ import annotations

from tests.api.trading_api_support import (
    DOC29_SIMULATION_FULL_DAY_GATE,
    JangarDependencyQuorumStatus,
    OrderExecutor,
    Path,
    SQLAlchemyError,
    SimpleNamespace,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    TRACE_STATUS_SATISFIED,
    TemporaryDirectory,
    TradingApiTestCaseBase,
    TradingScheduler,
    VNextEmpiricalJobRun,
    _build_hypothesis_runtime_payload,
    _truthful_empirical_payload,
    app,
    build_completion_trace,
    datetime,
    json,
    patch,
    persist_completion_trace,
    settings,
    timezone,
)


class TestTradingApiStatusMetadata(TradingApiTestCaseBase):
    def test_hypothesis_runtime_payload_uses_certificate_evidence_merge(self) -> None:
        scheduler = TradingScheduler()
        scheduler.state.last_market_context_freshness_seconds = 30
        now = datetime.now(timezone.utc)
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
        dependency_quorum = JangarDependencyQuorumStatus(
            decision="allow",
            reasons=[],
            message="ready",
        )

        with self.session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="status-runtime-proof",
                    candidate_id="cand-status-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=12,
                    trade_count=12,
                    order_count=12,
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
                    run_id="status-runtime-proof",
                    candidate_id="cand-status-runtime",
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
                "app.api.status_helpers.load_hypothesis_registry", return_value=registry
            ),
            patch(
                "app.trading.submission_council.runtime_summary.load_hypothesis_registry",
                return_value=registry,
            ),
            patch(
                "app.trading.submission_council.runtime_summary.compile_hypothesis_runtime_statuses",
                return_value=runtime_items,
            ),
        ):
            payload, summary, _ = _build_hypothesis_runtime_payload(
                scheduler,
                tca_summary={},
                market_context_status={"last_freshness_seconds": 10},
                dependency_quorum=dependency_quorum,
                feature_readiness={},
            )

        self.assertEqual(summary["promotion_eligible_total"], 0)
        self.assertEqual(summary["paper_probation_eligible_total"], 1)
        self.assertEqual(payload["summary"]["promotion_eligible_total"], 0)
        self.assertEqual(payload["summary"]["paper_probation_eligible_total"], 1)
        item = payload["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertTrue(item["paper_probation_eligible"])
        self.assertEqual(item["paper_probation_target_capital_stage"], "0.10x canary")
        self.assertEqual(item["candidate_id"], "cand-status-runtime")
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["reasons"], ["paper_probation_evidence_collection_only"])

    def test_trading_status_exposes_rejection_and_market_context_controls(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.llm_policy_veto_total = 3
            scheduler.state.metrics.llm_runtime_fallback_total = 5
            scheduler.state.metrics.llm_requests_total = 100
            scheduler.state.metrics.llm_market_context_block_total = 7
            scheduler.state.metrics.pre_llm_capacity_reject_total = 11
            scheduler.state.metrics.pre_llm_qty_below_min_total = 13
            scheduler.state.market_session_open = True
            scheduler.state.last_market_context_symbol = "AAPL"
            scheduler.state.last_market_context_checked_at = datetime(
                2026, 3, 5, 15, 30, tzinfo=timezone.utc
            )
            scheduler.state.last_market_context_freshness_seconds = 120
            scheduler.state.last_market_context_quality_score = 0.92
            scheduler.state.last_market_context_domain_states = {
                "technicals": "ok",
                "fundamentals": "stale",
                "news": "ok",
                "regime": "ok",
            }
            scheduler.state.last_market_context_risk_flags = ["fundamentals_stale"]
            scheduler.state.last_market_context_allow_llm = False
            scheduler.state.last_market_context_reason = "market_context_stale"
            scheduler.state.market_context_alert_active = True
            scheduler.state.market_context_alert_reason = "market_context_stale"
            executor = OrderExecutor()
            executor._shorting_metadata_status.update(
                {
                    "account_ready": False,
                    "last_refresh_at": "2026-03-05T15:30:00+00:00",
                    "last_error": "account lookup unavailable",
                }
            )
            scheduler._pipeline = type(
                "PipelineStub",
                (),
                {"executor": executor, "llm_review_engine": None},
            )()
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["market_context"]["fail_mode"], "shadow_only")
            self.assertFalse(payload["market_context"]["required"])
            self.assertEqual(payload["market_context"]["last_symbol"], "AAPL")
            self.assertEqual(
                payload["market_context"]["last_reason"], "market_context_stale"
            )
            self.assertTrue(payload["market_context"]["alert_active"])
            self.assertEqual(payload["rejections"]["policy_veto_total"], 3)
            self.assertEqual(payload["rejections"]["runtime_fallback_total"], 5)
            self.assertAlmostEqual(
                payload["rejections"]["runtime_fallback_ratio"], 0.05
            )
            self.assertEqual(
                payload["rejections"]["runtime_fallback_alert_ratio_threshold"], 0.01
            )
            self.assertTrue(payload["rejections"]["runtime_fallback_alert_active"])
            self.assertEqual(payload["rejections"]["market_context_block_total"], 7)
            self.assertEqual(payload["rejections"]["pre_llm_capacity_reject_total"], 11)
            self.assertEqual(payload["rejections"]["pre_llm_qty_below_min_total"], 13)
            self.assertFalse(payload["shorting_metadata"]["account_ready"])
            self.assertTrue(payload["shorting_metadata"]["alert_active"])
            self.assertEqual(
                payload["shorting_metadata"]["last_error"],
                "account lookup unavailable",
            )
            self.assertTrue(payload["alerts"]["market_context_alert_active"])
            self.assertTrue(payload["alerts"]["runtime_fallback_alert_active"])
            self.assertTrue(payload["alerts"]["shorting_metadata_alert_active"])
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_metrics_includes_control_plane_contract(self) -> None:
        response = self.client.get("/trading/metrics")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("control_plane_contract", payload)
        self.assertIn("build", payload)
        self.assertIn("shadow_first", payload)
        self.assertEqual(
            payload["control_plane_contract"]["contract_version"],
            "torghut.quant-producer.v1",
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_hypotheses_total"], 5
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_blocked_total"], 4
        )
        self.assertEqual(
            payload["control_plane_contract"]["alpha_readiness_shadow_total"], 1
        )
        self.assertIn("critical_toggle_parity", payload["control_plane_contract"])
        self.assertIn("active_revision", payload["build"])

    def test_trading_status_and_metrics_expose_execution_advisor_counters(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.execution_advisor_usage_total = {
                "advisory_only": 2,
                "fallback": 3,
            }
            scheduler.state.metrics.execution_advisor_fallback_total = {
                "advisor_disabled": 1,
                "advisor_timeout": 2,
            }
            app.state.trading_scheduler = scheduler

            status_response = self.client.get("/trading/status")
            self.assertEqual(status_response.status_code, 200)
            status_payload = status_response.json()
            advisor = status_payload["execution_advisor"]
            self.assertIn("enabled", advisor)
            self.assertIn("live_apply_enabled", advisor)
            self.assertEqual(advisor["usage_total"]["advisory_only"], 2)
            self.assertEqual(advisor["fallback_total"]["advisor_timeout"], 2)

            with patch(
                "app.api.proof_floor_payloads.load_route_provenance_summary",
                return_value={},
            ):
                metrics_response = self.client.get("/metrics")
            self.assertEqual(metrics_response.status_code, 200)
            metrics_payload = metrics_response.text
            self.assertIn(
                'torghut_trading_execution_advisor_usage_total{status="advisory_only"} 2',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_execution_advisor_fallback_total{reason="advisor_disabled"} 1',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_state_total{state="blocked"} 4',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_state_total{state="shadow"} 1',
                metrics_payload,
            )
            self.assertIn(
                'torghut_trading_hypothesis_capital_stage_total{stage="shadow"} 5',
                metrics_payload,
            )
            self.assertIn(
                "torghut_trading_alpha_readiness_hypotheses_total 5",
                metrics_payload,
            )
            self.assertIn("torghut_trading_llm_runtime_fallback_ratio", metrics_payload)
            self.assertIn(
                "torghut_trading_market_context_alert_active", metrics_payload
            )
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    @patch(
        "app.api.status_helpers._load_tca_summary", side_effect=SQLAlchemyError("boom")
    )
    def test_trading_status_maps_unhandled_db_errors_to_503(
        self, _mock_tca: object
    ) -> None:
        response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["detail"], "database unavailable")

    def test_trading_status_includes_signal_ingest_metadata(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.last_ingest_reason = "cursor_ahead_of_stream"
            scheduler.state.last_ingest_signals_total = 0
            scheduler.state.autonomy_no_signal_streak = 4
            scheduler.state.last_autonomy_recommendation_trace_id = "trace-123"
            scheduler.state.last_signal_continuity_state = (
                "expected_market_closed_staleness"
            )
            scheduler.state.last_signal_continuity_reason = "no_signals_in_window"
            scheduler.state.last_signal_continuity_actionable = False
            scheduler.state.market_session_open = False
            scheduler.state.signal_continuity_alert_active = True
            scheduler.state.signal_continuity_alert_reason = "cursor_ahead_of_stream"
            scheduler.state.signal_continuity_recovery_streak = 1
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            autonomy = payload["autonomy"]
            self.assertEqual(autonomy["last_ingest_signal_count"], 0)
            self.assertEqual(autonomy["last_ingest_reason"], "cursor_ahead_of_stream")
            self.assertEqual(autonomy["no_signal_streak"], 4)
            self.assertEqual(autonomy["last_recommendation_trace_id"], "trace-123")
            continuity = payload["signal_continuity"]
            self.assertEqual(
                continuity["last_state"], "expected_market_closed_staleness"
            )
            self.assertEqual(continuity["last_reason"], "no_signals_in_window")
            self.assertFalse(continuity["last_actionable"])
            self.assertFalse(continuity["market_session_open"])
            self.assertTrue(continuity["alert_active"])
            self.assertEqual(continuity["alert_reason"], "cursor_ahead_of_stream")
            self.assertEqual(continuity["alert_recovery_streak"], 1)
            self.assertIsNone(payload["autonomy"]["last_actuation_intent"])
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_surfaces_universe_fail_safe_state(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.universe_source_status = "unavailable"
            scheduler.state.universe_source_reason = "jangar_symbols_fetch_failed"
            scheduler.state.universe_fail_safe_blocked = True
            scheduler.state.universe_fail_safe_block_reason = (
                "jangar_symbols_fetch_failed"
            )
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            continuity = response.json()["signal_continuity"]
            self.assertTrue(continuity["universe_fail_safe_blocked"])
            self.assertEqual(
                continuity["universe_fail_safe_block_reason"],
                "jangar_symbols_fetch_failed",
            )
            self.assertEqual(continuity["universe_status"], "unavailable")
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_includes_emergency_stop_recovery_fields(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.emergency_stop_active = True
            scheduler.state.emergency_stop_reason = "signal_lag_exceeded:900"
            scheduler.state.emergency_stop_triggered_at = datetime.now(timezone.utc)
            scheduler.state.emergency_stop_recovery_streak = 2
            scheduler.state.emergency_stop_resolved_at = datetime.now(timezone.utc)
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            rollback = payload["rollback"]
            self.assertIn("emergency_stop_recovery_streak", rollback)
            self.assertIn("emergency_stop_resolved_at", rollback)
            self.assertEqual(rollback["emergency_stop_recovery_streak"], 2)
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_status_includes_last_actuation_intent(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with TemporaryDirectory() as tmpdir:
            actuation_path = Path(tmpdir) / "actuation-intent.json"
            actuation_path.write_text(json.dumps({}), encoding="utf-8")
            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_actuation_intent = str(actuation_path)
                app.state.trading_scheduler = scheduler
                response = self.client.get("/trading/status")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.json()["autonomy"]["last_actuation_intent"],
                    str(actuation_path),
                )
            finally:
                if original_scheduler is None:
                    if hasattr(app.state, "trading_scheduler"):
                        del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_includes_no_signal_streak(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.autonomy_no_signal_streak = 7
            scheduler.state.last_autonomy_reason = "cursor_ahead_of_stream"
            scheduler.state.last_autonomy_recommendation_trace_id = "autonomy-trace-1"
            app.state.trading_scheduler = scheduler

            response = self.client.get("/trading/autonomy")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["no_signal_streak"], 7)
            self.assertEqual(payload["last_reason"], "cursor_ahead_of_stream")
            self.assertEqual(
                payload["last_recommendation_trace_id"], "autonomy-trace-1"
            )
            self.assertIsNone(payload["last_actuation_intent"])
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_exposes_bridge_status(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-evaluation.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-bridge-1",
                        "promotion_evidence": {
                            "simulation_calibration": {
                                "artifact_ref": "gates/simulation-calibration-report-v1.json",
                                "status": "calibrated",
                                "order_count": 12,
                                "artifact_authority": {
                                    "authoritative": True,
                                    "provenance": "paper_runtime_observed",
                                },
                            },
                            "shadow_live_deviation": {
                                "artifact_ref": "gates/shadow-live-deviation-report-v1.json",
                                "status": "within_budget",
                                "avg_abs_slippage_bps": "6",
                                "artifact_authority": {
                                    "authoritative": True,
                                    "provenance": "paper_runtime_observed",
                                },
                            },
                        },
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-bridge-1",
                            "recommendation_trace_id": "rec-trace-bridge-1",
                            "promotion_evidence_authority": {
                                "simulation_calibration": {
                                    "authoritative": True,
                                },
                                "shadow_live_deviation": {
                                    "authoritative": True,
                                },
                            },
                        },
                        "dependency_quorum": {
                            "decision": "allow",
                            "reasons": [],
                            "message": "All upstream dependencies are healthy.",
                        },
                        "alpha_readiness": {
                            "promotion_eligible": True,
                            "strategy_families": ["intraday_tsmom_v1"],
                            "matched_hypothesis_ids": ["intraday-tsmom"],
                            "reasons": [],
                        },
                        "vnext": {
                            "strategy_compilation": [
                                {
                                    "strategy_id": "intraday-tsmom",
                                    "compiler_source": "spec_v2",
                                    "spec_compiled": True,
                                }
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )
            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_gates = str(gate_path)
                scheduler.state.drift_status = "stable"
                app.state.trading_scheduler = scheduler

                with patch("app.api.trading_status.SessionLocal", self.session_local):
                    response = self.client.get("/trading/autonomy")
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["bridge_status"]["source"], "gate_report")
                self.assertIn(
                    payload["forecast_service"]["authority"], {"empirical", "blocked"}
                )
                self.assertIn(
                    payload["lean_authority"]["authority"], {"empirical", "blocked"}
                )
                self.assertIn(
                    payload["empirical_jobs"]["authority"], {"empirical", "blocked"}
                )
                self.assertEqual(
                    payload["bridge_status"]["strategy_compilation"]["spec_compiled"],
                    1,
                )
                self.assertEqual(
                    payload["bridge_status"]["simulation_calibration"]["status"],
                    "calibrated",
                )
                self.assertEqual(
                    payload["bridge_status"]["shadow_live_deviation"]["drift_status"],
                    "stable",
                )
                self.assertEqual(
                    payload["bridge_status"]["evidence_authority"][
                        "authoritative_count"
                    ],
                    2,
                )
                self.assertEqual(
                    payload["bridge_status"]["dependency_quorum"]["decision"],
                    "allow",
                )
                self.assertTrue(
                    payload["bridge_status"]["alpha_readiness"]["promotion_eligible"]
                )
            finally:
                if original_scheduler is None:
                    del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_empirical_jobs_endpoint_exposes_latest_job_freshness(self) -> None:
        with self.session_local() as session:
            session.add(
                VNextEmpiricalJobRun(
                    run_id="run-empirical-1",
                    candidate_id="cand-empirical-1",
                    job_name="benchmark parity",
                    job_type="benchmark_parity",
                    job_run_id="job-benchmark-1",
                    status="completed",
                    authority="empirical",
                    promotion_authority_eligible=True,
                    dataset_snapshot_ref="s3://datasets/run-empirical-1.json",
                    artifact_refs=["s3://artifacts/benchmark.json"],
                    payload_json=_truthful_empirical_payload(
                        job_run_id="job-benchmark-1",
                        dataset_snapshot_ref="s3://datasets/run-empirical-1.json",
                    ),
                )
            )
            session.commit()

        with patch("app.api.trading_status.SessionLocal", self.session_local):
            response = self.client.get("/trading/empirical-jobs")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("jobs", payload)
        self.assertEqual(
            payload["message"],
            "missing empirical jobs: foundation_router_parity, janus_event_car, janus_hgrm_reward",
        )
        self.assertEqual(payload["eligible_jobs"], ["benchmark_parity"])
        self.assertEqual(
            payload["missing_jobs"],
            ["foundation_router_parity", "janus_event_car", "janus_hgrm_reward"],
        )
        self.assertEqual(payload["jobs"]["benchmark_parity"]["authority"], "empirical")
        self.assertEqual(
            payload["jobs"]["benchmark_parity"]["job_run_id"], "job-benchmark-1"
        )

    def test_trading_completion_doc29_endpoint_exposes_traceable_gate_status(
        self,
    ) -> None:
        with self.session_local() as session:
            trace = build_completion_trace(
                doc_id="doc29",
                gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
                run_id="sim-2026-03-06-full-day",
                dataset_snapshot_ref="snapshot-1",
                candidate_id="cand-1",
                workflow_name="torghut-historical-simulation",
                analysis_run_names=[],
                artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
                db_row_refs={},
                status_snapshot={},
                result_by_gate={
                    DOC29_SIMULATION_FULL_DAY_GATE: {
                        "status": TRACE_STATUS_SATISFIED,
                        "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                        "acceptance_snapshot": {
                            "trade_decisions": 640,
                            "executions": 320,
                            "execution_tca_metrics": 320,
                            "execution_order_events": 320,
                            "coverage_ratio": 0.99,
                        },
                    }
                },
                blocked_reasons={},
                git_revision="abc123",
                image_digest="sha256:test",
            )
            persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref="s3://artifacts/completion-trace.json",
            )
            session.commit()

        with (
            patch("app.api.trading_status.SessionLocal", self.session_local),
            patch("app.api.common.BUILD_COMMIT", "abc123"),
        ):
            response = self.client.get("/trading/completion/doc29")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["doc_id"], "doc29")
        gate = next(
            item
            for item in payload["gates"]
            if item["gate_id"] == DOC29_SIMULATION_FULL_DAY_GATE
        )
        self.assertEqual(gate["status"], "satisfied")
        self.assertEqual(gate["latest_run"], "sim-2026-03-06-full-day")

        with (
            patch("app.api.trading_status.SessionLocal", self.session_local),
            patch("app.api.common.BUILD_COMMIT", "abc123"),
        ):
            gate_response = self.client.get(
                f"/trading/completion/doc29/{DOC29_SIMULATION_FULL_DAY_GATE}"
            )
        self.assertEqual(gate_response.status_code, 200)
        self.assertEqual(
            gate_response.json()["gate_id"], DOC29_SIMULATION_FULL_DAY_GATE
        )

    def test_trading_autonomy_evidence_continuity_endpoint_returns_state_report(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            scheduler = TradingScheduler()
            scheduler.state.last_evidence_continuity_report = {
                "checked_runs": 2,
                "failed_runs": 0,
                "ok": True,
            }
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/autonomy/evidence-continuity")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertIn("report", payload)
            self.assertEqual(payload["report"]["checked_runs"], 2)
            self.assertEqual(payload["report"]["failed_runs"], 0)
        finally:
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

    def test_trading_autonomy_evidence_continuity_endpoint_supports_refresh(
        self,
    ) -> None:
        response = self.client.get(
            "/trading/autonomy/evidence-continuity?refresh=true&run_limit=5"
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("report", payload)
        self.assertEqual(payload["report"]["checked_runs"], 0)
        self.assertEqual(payload["report"]["failed_runs"], 0)

    def test_trading_status_reports_effective_llm_guardrails(self) -> None:
        original = {
            "llm_shadow_mode": settings.llm_shadow_mode,
            "llm_enabled": settings.llm_enabled,
            "llm_rollout_stage": settings.llm_rollout_stage,
            "trading_mode": settings.trading_mode,
            "trading_live_enabled": settings.trading_live_enabled,
            "llm_fail_mode": settings.llm_fail_mode,
            "llm_fail_mode_enforcement": settings.llm_fail_mode_enforcement,
            "llm_fail_open_live_approved": settings.llm_fail_open_live_approved,
            "llm_allowed_models_raw": settings.llm_allowed_models_raw,
            "llm_evaluation_report": settings.llm_evaluation_report,
            "llm_effective_challenge_id": settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": settings.llm_shadow_completed_at,
            "llm_model_version_lock": settings.llm_model_version_lock,
        }
        settings.llm_enabled = True
        settings.llm_rollout_stage = "stage3"
        settings.llm_shadow_mode = False
        settings.trading_mode = "live"
        settings.trading_live_enabled = True
        settings.llm_fail_mode = "pass_through"
        settings.llm_fail_mode_enforcement = "configured"
        settings.llm_fail_open_live_approved = True
        settings.llm_allowed_models_raw = None
        settings.llm_evaluation_report = None
        settings.llm_effective_challenge_id = None
        settings.llm_shadow_completed_at = None
        settings.llm_model_version_lock = None

        try:
            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            llm = payload["llm"]
            self.assertEqual(llm["rollout_stage"], "stage3")
            self.assertFalse(llm["shadow_mode"])
            self.assertTrue(llm["effective_shadow_mode"])
            self.assertEqual(llm["fail_mode_enforcement"], "configured")
            self.assertIn("configured_fail_mode_enabled", llm["policy_exceptions"])
            self.assertIn("policy_resolution", llm)
            self.assertIn("policy_resolution_counters", llm)
            self.assertEqual(llm["policy_resolution"]["classification"], "compliant")
            self.assertFalse(llm["policy_resolution"]["fail_mode_exception_active"])
            self.assertFalse(llm["policy_resolution"]["fail_mode_violation_active"])
            self.assertIn("guardrails", llm)
            self.assertTrue(llm["guardrails"]["allow_requests"])
            self.assertIn("llm_evaluation_report_missing", llm["guardrails"]["reasons"])
            self.assertIn(
                "llm_model_version_lock_missing", llm["guardrails"]["reasons"]
            )
        finally:
            settings.llm_shadow_mode = original["llm_shadow_mode"]
            settings.llm_enabled = original["llm_enabled"]
            settings.llm_rollout_stage = original["llm_rollout_stage"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_live_enabled = original["trading_live_enabled"]
            settings.llm_fail_mode = original["llm_fail_mode"]
            settings.llm_fail_mode_enforcement = original["llm_fail_mode_enforcement"]
            settings.llm_fail_open_live_approved = original[
                "llm_fail_open_live_approved"
            ]
            settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            settings.llm_evaluation_report = original["llm_evaluation_report"]
            settings.llm_effective_challenge_id = original["llm_effective_challenge_id"]
            settings.llm_shadow_completed_at = original["llm_shadow_completed_at"]
            settings.llm_model_version_lock = original["llm_model_version_lock"]
