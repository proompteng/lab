from __future__ import annotations


from tests.submission_council.support import (
    Base,
    SimpleNamespace,
    StaticPool,
    Strategy,
    SubmissionCouncilTestCase,
    build_live_submission_gate_payload,
    create_engine,
    datetime,
    sessionmaker,
    settings,
    timezone,
)


class TestSubmissionCouncilLiveSubmissionGate(SubmissionCouncilTestCase):
    def test_primary_live_submission_reason_uses_first_operational_blocker(
        self,
    ) -> None:
        from app.trading.submission_council import (
            _primary_live_submission_blocked_reason,
        )

        self.assertEqual(
            _primary_live_submission_blocked_reason(
                [
                    "submit_disabled",
                    "live_submit_disabled",
                ]
            ),
            "submit_disabled",
        )

    def test_build_live_submission_gate_payload_keeps_activation_expiry_diagnostic_only(
        self,
    ) -> None:
        from app.config import settings

        settings.trading_live_submit_activation_expires_at = "2000-01-01T00:00:00Z"
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
                "capital_stage_totals": {"0.10x canary": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": "cand-1",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "promotion_eligible": True,
                        "capital_stage": "0.10x canary",
                        "reasons": [],
                        "observed": self._runtime_ledger_observed(),
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
                    "runtime_ledger_bucket": self._runtime_ledger_bucket_payload(),
                }
            ],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["reason"], "operational_submission_ready")
        self.assertNotIn("live_submit_activation_expired", result["blocked_reasons"])
        self.assertEqual(
            result["live_submit_activation"]["expires_at"],
            "2000-01-01T00:00:00+00:00",
        )

    def test_stale_empirical_status_no_longer_blocks_live_gate(self) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": False, "status": "degraded"},
            quant_health_status=self._healthy_quant_status(),
        )

        self.assertNotIn("empirical_jobs_not_ready", result["blocked_reasons"])
        self.assertIsNone(result["empirical_jobs_ready"])
        self.assertNotIn("empirical", result["segment_summary"])

    def test_operational_gate_blocks_when_submit_disabled_without_collection_contract(
        self,
    ) -> None:
        from app.config import settings

        settings.trading_simple_paper_route_probe_enabled = False
        settings.trading_simple_paper_route_probe_allow_live_mode = False
        settings.trading_simple_submit_enabled = False
        settings.trading_simple_paper_route_probe_max_notional = 0
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
        )

        self.assertNotIn("bounded_live_paper_collection_gate", result)
        operational_gate = result["operational_submission_gate"]
        self.assertFalse(operational_gate["allowed"])
        self.assertIn("submit_disabled", result["blocked_reasons"])
        self.assertIn("submit_disabled", operational_gate["blocked_reasons"])

    def test_live_gate_blocks_testnet_route_as_not_mainnet(self) -> None:
        from app.config import settings

        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_enabled = True
        settings.trading_testnet_after_hours_enabled = True
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=False,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
        )

        operational_gate = result["operational_submission_gate"]
        self.assertFalse(result["allowed"])
        self.assertEqual(result["reason"], "mainnet_route_unavailable")
        self.assertIn("mainnet_route_unavailable", result["blocked_reasons"])
        self.assertFalse(operational_gate["allowed"])
        self.assertEqual(operational_gate["reason"], "mainnet_route_unavailable")
        self.assertEqual(operational_gate["execution_route"]["route"], "testnet")

    def test_live_submit_activation_is_diagnostic_for_operational_gate(
        self,
    ) -> None:
        from app.config import settings

        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
        settings.trading_simple_submit_enabled = True
        settings.trading_simple_paper_route_probe_max_notional = 100
        settings.trading_live_submit_activation_expires_at = "not-a-date"
        settings.trading_testnet_after_hours_enabled = True
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=False,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
        )

        self.assertNotIn("bounded_live_paper_collection_gate", result)
        self.assertFalse(result["operational_submission_gate"]["allowed"])
        self.assertIn("mainnet_route_unavailable", result["blocked_reasons"])
        self.assertNotIn(
            "live_submit_activation_expiry_invalid",
            result["blocked_reasons"],
        )

    def test_runtime_import_plan_uses_configured_strategy_universe(
        self,
    ) -> None:
        account_label_before = settings.trading_account_label
        static_symbols_before = settings.trading_static_symbols_raw
        try:
            settings.trading_simple_paper_route_probe_enabled = True
            settings.trading_simple_paper_route_probe_allow_live_mode = True
            settings.trading_simple_submit_enabled = True
            settings.trading_simple_paper_route_probe_max_notional = 100
            settings.trading_live_submit_activation_expires_at = "2999-01-01T20:05:00Z"
            settings.trading_account_label = "PA3SX7FYNUTF"
            settings.trading_static_symbols_raw = "NVDA,AMD,MU,WDC"

            engine = create_engine(
                "sqlite+pysqlite:///:memory:",
                future=True,
                connect_args={"check_same_thread": False},
                poolclass=StaticPool,
            )
            Base.metadata.create_all(engine)
            session_local = sessionmaker(
                bind=engine,
                expire_on_commit=False,
                future=True,
            )

            with session_local() as session:
                session.add_all(
                    [
                        Strategy(
                            name="ai-chip-momentum",
                            description="configured paper collection",
                            enabled=True,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["NVDA", "TSLA", "AMD"],
                        ),
                        Strategy(
                            name="disabled-collector",
                            description="disabled collector",
                            enabled=False,
                            base_timeframe="1Min",
                            universe_type="static",
                            universe_symbols=["MU"],
                        ),
                    ]
                )
                session.commit()

                result = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=False,
                        last_autonomy_promotion_eligible=False,
                        last_autonomy_promotion_action=None,
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                    ),
                    hypothesis_summary={
                        "promotion_eligible_total": 0,
                        "capital_stage_totals": {"shadow": 1},
                        "dependency_quorum": {
                            "decision": "allow",
                            "reasons": [],
                            "message": "ready",
                        },
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    quant_health_status=self._healthy_quant_status(),
                    session=session,
                )
        finally:
            settings.trading_account_label = account_label_before
            settings.trading_static_symbols_raw = static_symbols_before

        self.assertFalse(result["allowed"])
        self.assertEqual(result["reason"], "mainnet_route_unavailable")
        self.assertNotIn(
            "runtime_window_import_required",
            result["blocked_reasons"],
        )
        import_plan = result["runtime_ledger_paper_probation_import_plan"]
        self.assertEqual(
            import_plan["schema_version"],
            "torghut.runtime-ledger-paper-probation-import-plan.v1",
        )
        self.assertGreaterEqual(import_plan["target_count"], 1)
        self.assertTrue(
            any(
                target["strategy_name"] == "ai-chip-momentum"
                for target in import_plan["targets"]
            )
        )
        self.assertNotIn("bounded_live_paper_collection_gate", result)
        self.assertFalse(result["operational_submission_gate"]["allowed"])
        self.assertIn("mainnet_route_unavailable", result["blocked_reasons"])

    def test_build_live_submission_gate_payload_exports_runtime_window_health_inputs(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_signal_continuity_state="expected_market_closed_staleness",
                last_signal_continuity_reason="cursor_tail_stable",
                last_signal_continuity_actionable=False,
                signal_continuity_alert_active=False,
                signal_continuity_alert_reason=None,
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
        )

        self.assertEqual(result["continuity_ok"], "true")
        self.assertEqual(result["continuity_source"], "signal_continuity")
        self.assertEqual(
            result["continuity_reason"], "expected_market_closed_staleness"
        )
        self.assertEqual(result["drift_ok"], "false")
        self.assertEqual(result["drift_source"], "drift_live_promotion_eligible")
        self.assertEqual(result["drift_reason"], "drift_live_promotion_ineligible")
        gate = result["runtime_window_import_health_gate"]
        self.assertEqual(gate["source"], "live_submission_gate")
        self.assertEqual(gate["dependency_quorum_decision"], "allow")
        self.assertEqual(gate["continuity_ok"], "true")
        self.assertEqual(gate["drift_ok"], "false")
        self.assertEqual(gate["blockers"], [])
        self.assertTrue(gate["ready"])
        self.assertEqual(gate["promotion_blockers"], ["drift_checks_not_ok"])
        self.assertEqual(result["runtime_window_import_health_gate_blockers"], [])
        self.assertEqual(
            result["runtime_window_import_promotion_blockers"],
            ["drift_checks_not_ok"],
        )

    def test_build_live_submission_gate_payload_blocks_runtime_window_on_signal_alert(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=True,
                last_signal_continuity_state="signal_lag_exceeded",
                last_signal_continuity_reason="signal_lag_exceeded",
                last_signal_continuity_actionable=True,
                signal_continuity_alert_active=True,
                signal_continuity_alert_reason="signal_lag_exceeded",
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
        )

        self.assertEqual(result["continuity_ok"], "false")
        self.assertEqual(result["continuity_source"], "signal_continuity")
        self.assertEqual(result["continuity_reason"], "signal_lag_exceeded")
        self.assertEqual(result["drift_ok"], "true")
        self.assertEqual(
            result["runtime_window_import_health_gate"]["blockers"],
            ["evidence_continuity_not_ok"],
        )

    def test_build_live_submission_gate_payload_clears_signal_lag_with_fresh_clickhouse_status(
        self,
    ) -> None:
        latest_signal_at = datetime.now(timezone.utc).isoformat()
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=True,
                last_signal_continuity_state="signal_lag_exceeded",
                last_signal_continuity_reason="signal_lag_exceeded",
                last_signal_continuity_actionable=True,
                signal_continuity_alert_active=True,
                signal_continuity_alert_reason="signal_lag_exceeded",
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "promotion_eligible": False,
                        "capital_stage": "shadow",
                        "reasons": [
                            "signal_continuity_alert_active",
                            "signal_lag_exceeded",
                        ],
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            clickhouse_ta_status={
                "state": "current",
                "latest_signal_at": latest_signal_at,
                "latest_accepted_event_at": latest_signal_at,
                "accepted_source_state": "current",
                "accepted_sources": ["ta"],
                "equity_ta_rows": 12,
                "equity_ta_symbols": 2,
                "source_ref": "clickhouse:ta_signals",
            },
        )

        self.assertEqual(result["continuity_ok"], "true")
        self.assertEqual(result["continuity_source"], "clickhouse_ta_status")
        self.assertEqual(result["continuity_reason"], "signals_present")
        self.assertEqual(result["runtime_window_import_health_gate"]["blockers"], [])
        ta_core = result["segment_summary"]["segments"]["ta-core"]
        self.assertEqual(ta_core["state"], "ok")
        self.assertNotIn("signal_continuity_alert_active", ta_core["reason_codes"])
        self.assertNotIn("signal_lag_exceeded", ta_core["reason_codes"])

    def test_build_live_submission_gate_payload_keeps_ta_core_blocked_when_clickhouse_accepted_source_stale(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                market_session_open=True,
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=True,
                last_signal_continuity_state="signal_lag_exceeded",
                last_signal_continuity_reason="signal_lag_exceeded",
                last_signal_continuity_actionable=True,
                signal_continuity_alert_active=True,
                signal_continuity_alert_reason="signal_lag_exceeded",
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    signal_lag_seconds=900,
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            clickhouse_ta_status={
                "state": "current",
                "latest_signal_at": "2026-06-30T20:54:52+00:00",
                "latest_accepted_event_at": "2026-06-30T20:54:52+00:00",
                "accepted_sources": ["ta"],
                "accepted_source_state": "stale",
                "blocking_reason": "accepted_ta_signal_stale",
            },
        )

        ta_core = result["segment_summary"]["segments"]["ta-core"]
        self.assertFalse(result["allowed"])
        self.assertIn("accepted_ta_signal_stale", result["blocked_reasons"])
        self.assertEqual(ta_core["state"], "blocked")
        self.assertIn("signal_continuity_alert_active", ta_core["reason_codes"])
        self.assertIn("signal_lag_exceeded", ta_core["reason_codes"])

    def test_build_live_submission_gate_payload_keeps_empty_quant_evidence_diagnostic_only(
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
                "reason": "quant_latest_metrics_empty",
                "blocking_reasons": [
                    "quant_latest_metrics_empty",
                    "quant_latest_store_alarm",
                ],
                "account": "paper",
                "window": "15m",
                "status": "degraded",
                "latest_metrics_count": 0,
                "latest_metrics_updated_at": None,
                "empty_latest_store_alarm": True,
                "missing_update_alarm": False,
                "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
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
        self.assertEqual(result["capital_state"], "live")
        self.assertNotIn("quant_latest_store_alarm", result["blocked_reasons"])
        self.assertIn(
            "quant_latest_store_alarm",
            result["quant_evidence"]["blocking_reasons"],
        )
        self.assertEqual(result["quant_health_ref"]["window"], "15m")

    def test_build_live_submission_gate_payload_requires_valid_certificate_evidence(
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
                "capital_stage_totals": {"0.10x canary": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": "cand-1",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "promotion_eligible": True,
                        "capital_stage": "0.10x canary",
                        "reasons": [],
                        "observed": self._runtime_ledger_observed(),
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
                    "runtime_ledger_bucket": self._runtime_ledger_bucket_payload(),
                }
            ],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["capital_state"], "live")
        self.assertEqual(result["reason_codes"], ["operational_submission_ready"])
        self.assertIsNone(result["evidence_tuple"]["hypothesis_id"])
        self.assertIsNone(result["evidence_tuple"]["candidate_id"])

    def test_build_live_submission_gate_payload_ignores_paper_runtime_certificate_for_submission(
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
                    "capital_stage_totals": {"0.10x canary": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": "cand-1",
                        "strategy_id": "intraday_tsmom_v1@paper",
                        "promotion_eligible": True,
                        "capital_stage": "0.10x canary",
                        "reasons": [],
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(observed_stage="paper"),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["capital_state"], "live")
        self.assertNotIn(
            "promotion_certificate_not_live_runtime",
            result["blocked_reasons"],
        )
        self.assertNotIn(
            "promotion_certificate_valid",
            result["reason_codes"],
        )

    def test_profit_window_contract_prices_stale_empirical_and_market_context_per_lane(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=900,
                last_market_context_domain_states={"technicals": "down"},
                market_context_alert_active=True,
                market_context_alert_reason="market_context_down",
                market_session_open=False,
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 0,
                    "capital_stage_totals": {"shadow": 2},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "state": "shadow",
                        "capital_stage": "shadow",
                        "reasons": [],
                        "dependency_capabilities": {
                            "required": [
                                "jangar_dependency_quorum",
                                "signal_continuity",
                            ],
                            "unknown": [],
                        },
                    },
                    {
                        "hypothesis_id": "H-REV-01",
                        "lane_id": "event-reversion",
                        "strategy_family": "event_reversion",
                        "state": "shadow",
                        "capital_stage": "shadow",
                        "reasons": ["market_context_stale"],
                        "dependency_capabilities": {
                            "required": [
                                "jangar_dependency_quorum",
                                "market_context_freshness",
                            ],
                            "unknown": [],
                        },
                    },
                ],
            },
            empirical_jobs_status={
                "ready": False,
                "status": "degraded",
                "stale_jobs": ["benchmark_parity"],
                "missing_jobs": [],
                "ineligible_jobs": [],
                "dataset_snapshot_refs": ["s3://torghut/empirical/cand-1"],
            },
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[],
        )

        contract = result["profit_window_contract"]
        self.assertEqual(contract["window_session_class"], "off_session")
        self.assertEqual(contract["summary"]["windows_total"], 2)
        escrows = contract["escrows"]
        empirical_escrows = [
            item for item in escrows if item["type"] == "empirical_jobs"
        ]
        self.assertTrue(empirical_escrows)
        self.assertTrue(all(item["status"] == "expired" for item in empirical_escrows))
        rev_market_escrow = next(
            item
            for item in escrows
            if item["type"] == "market_context"
            and item["hypothesis_id"] == "H-REV-01"
            and item["evidence_escrow_id"]
            in next(
                window
                for window in contract["windows"]
                if window["hypothesis_id"] == "H-REV-01"
            )["required_escrow_ids"]
        )
        rev_window = next(
            window
            for window in contract["windows"]
            if window["hypothesis_id"] == "H-REV-01"
        )
        cont_market_escrow = next(
            item
            for item in escrows
            if item["type"] == "market_context" and item["hypothesis_id"] == "H-CONT-01"
        )
        cont_window = next(
            window
            for window in contract["windows"]
            if window["hypothesis_id"] == "H-CONT-01"
        )
        self.assertTrue(rev_market_escrow["required"])
        self.assertIn(
            rev_market_escrow["evidence_escrow_id"],
            rev_window["blocking_escrow_ids"],
        )
        self.assertFalse(cont_market_escrow["required"])
        self.assertNotIn(
            cont_market_escrow["evidence_escrow_id"],
            cont_window["blocking_escrow_ids"],
        )
