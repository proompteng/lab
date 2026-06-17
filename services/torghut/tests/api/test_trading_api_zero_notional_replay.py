from __future__ import annotations

from tests.api.trading_api_support import (
    FeatureQualityReport,
    SimpleNamespace,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    TradingApiTestCaseBase,
    TradingScheduler,
    app,
    datetime,
    patch,
    settings,
    timedelta,
    timezone,
)


class TestTradingApiZeroNotionalReplay(TradingApiTestCaseBase):
    def test_zero_notional_repair_endpoint_executes_drift_replay(self) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:drift",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "drift_checks",
                        "zero_notional_action": "rerun_drift_checks_for_blocked_hypotheses",
                        "before_refs": ["drift_detection:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        fetched: list[dict[str, object]] = []
        replayed: list[list[str]] = []

        def fetch_signals_with_reason(**kwargs: object) -> SimpleNamespace:
            fetched.append(kwargs)
            return SimpleNamespace(
                signals=[
                    SimpleNamespace(symbol="AAPL"),
                    SimpleNamespace(symbol="MSFT"),
                ],
                no_signal_reason=None,
                query_start="2026-05-13T04:00:00+00:00",
                query_end="2026-05-13T04:05:00+00:00",
            )

        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=fetch_signals_with_reason,
                ),
                _run_simple_drift_check=lambda signals: replayed.append(
                    [signal.symbol for signal in signals],
                ),
            ),
            state=SimpleNamespace(
                drift_last_detection_path="drift-detection/latest.json",
                drift_status="ok",
                drift_active_reason_codes=[],
            ),
        )
        app.state.trading_scheduler = scheduler

        with patch("app.api.maintenance.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rerun_drift_checks_for_blocked_hypotheses"
                "&execute=true&drift_limit=25"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertEqual(
            payload["after_refs"],
            ["drift_detection_checks", "drift-detection/latest.json"],
        )
        self.assertEqual(payload["runner_result"]["result"]["signals_evaluated"], 1)
        self.assertEqual(payload["runner_result"]["result"]["symbol_set"], ["AAPL"])
        self.assertEqual(fetched[0]["limit"], 25)
        self.assertEqual(replayed, [["AAPL"]])
        self.assertFalse(payload["order_submission_enabled"])
        self.assertEqual(payload["paper_notional_limit"], "0")
        self.assertEqual(payload["live_notional_limit"], "0")

    def test_zero_notional_repair_endpoint_replays_latest_signal_window(self) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:drift",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "drift_checks",
                        "zero_notional_action": "rerun_drift_checks_for_blocked_hypotheses",
                        "before_refs": ["drift_detection:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        fetched: list[dict[str, object]] = []
        replayed: list[list[str]] = []
        latest_signal_at = datetime(2026, 5, 12, 20, 57, tzinfo=timezone.utc)

        def fetch_signals_with_reason(**kwargs: object) -> SimpleNamespace:
            fetched.append(kwargs)
            if len(fetched) == 1:
                return SimpleNamespace(
                    signals=[],
                    no_signal_reason="cursor_ahead_of_stream",
                    query_start=kwargs["start"],
                    query_end=kwargs["end"],
                )
            return SimpleNamespace(
                signals=[
                    SimpleNamespace(symbol="AAPL"),
                    SimpleNamespace(symbol="MSFT"),
                ],
                no_signal_reason=None,
                query_start=kwargs["start"],
                query_end=kwargs["end"],
            )

        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=fetch_signals_with_reason,
                    latest_signal_status=lambda: {"latest_signal_at": latest_signal_at},
                ),
                _run_simple_drift_check=lambda signals: replayed.append(
                    [signal.symbol for signal in signals],
                ),
            ),
            state=SimpleNamespace(
                drift_last_detection_path="drift-detection/latest.json",
                drift_status="ok",
                drift_active_reason_codes=[],
            ),
        )
        app.state.trading_scheduler = scheduler

        with patch("app.api.maintenance.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rerun_drift_checks_for_blocked_hypotheses"
                "&execute=true&drift_limit=25"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertEqual(len(fetched), 2)
        self.assertEqual(fetched[1]["start"], latest_signal_at - timedelta(minutes=15))
        self.assertEqual(fetched[1]["end"], latest_signal_at)
        self.assertEqual(payload["runner_result"]["result"]["signals_evaluated"], 1)
        self.assertEqual(
            payload["runner_result"]["result"]["replay_window"],
            "latest_signal",
        )
        self.assertEqual(replayed, [["AAPL"]])
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_rebuilds_feature_rows_from_latest_window(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:features",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "feature_coverage",
                        "zero_notional_action": "rebuild_required_feature_rows",
                        "before_refs": ["feature_coverage:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        fetched: list[dict[str, object]] = []
        latest_signal_at = datetime(2026, 5, 12, 20, 57, tzinfo=timezone.utc)

        def fetch_signals_with_reason(**kwargs: object) -> SimpleNamespace:
            fetched.append(kwargs)
            if len(fetched) == 1:
                return SimpleNamespace(
                    signals=[],
                    no_signal_reason="cursor_ahead_of_stream",
                    query_start=kwargs["start"],
                    query_end=kwargs["end"],
                )
            return SimpleNamespace(
                signals=[
                    SimpleNamespace(symbol="AAPL"),
                    SimpleNamespace(symbol="MSFT"),
                ],
                no_signal_reason=None,
                query_start=kwargs["start"],
                query_end=kwargs["end"],
            )

        metrics = SimpleNamespace(
            feature_batch_rows_total=0,
            feature_null_rate={},
            feature_staleness_ms_p95=0,
            feature_duplicate_ratio=0.0,
            feature_schema_mismatch_total=0,
            feature_quality_rejections_total=0,
        )
        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=fetch_signals_with_reason,
                    latest_signal_status=lambda: {"latest_signal_at": latest_signal_at},
                ),
            ),
            state=SimpleNamespace(metrics=metrics),
        )
        app.state.trading_scheduler = scheduler
        quality_report = FeatureQualityReport(
            accepted=True,
            rows_total=2,
            null_rate_by_field={"macd": 0.0},
            staleness_ms_p95=200,
            duplicate_ratio=0.0,
            schema_mismatch_total=0,
            reasons=[],
        )

        with (
            patch("app.api.maintenance.trading_status", return_value=status_payload),
            patch(
                "app.api.maintenance.evaluate_feature_batch_quality",
                return_value=quality_report,
            ),
        ):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rebuild_required_feature_rows&execute=true&feature_limit=25"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertEqual(payload["after_refs"], ["feature_coverage_rows"])
        self.assertEqual(payload["runner_result"]["result"]["signals_evaluated"], 1)
        self.assertEqual(payload["runner_result"]["result"]["rows_total"], 2)
        self.assertEqual(
            payload["runner_result"]["result"]["replay_window"],
            "latest_signal",
        )
        self.assertEqual(metrics.feature_batch_rows_total, 2)
        self.assertEqual(len(fetched), 2)
        self.assertEqual(fetched[0]["limit"], 25)
        self.assertEqual(fetched[1]["start"], latest_signal_at - timedelta(minutes=15))
        self.assertEqual(fetched[1]["end"], latest_signal_at)
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_fails_closed_without_feature_runner(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:features",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "feature_coverage",
                        "zero_notional_action": "rebuild_required_feature_rows",
                        "before_refs": ["feature_coverage:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        app.state.trading_scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(ingestor=SimpleNamespace()),
        )

        with patch("app.api.maintenance.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rebuild_required_feature_rows&execute=true"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "runner_failed")
        self.assertEqual(payload["command_exit_code"], 78)
        self.assertEqual(
            payload["blocked_reasons"],
            ["feature_coverage_runner_unavailable"],
        )
        self.assertEqual(payload["after_refs"], [])
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_blocks_feature_replay_without_latest_window(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:features",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "feature_coverage",
                        "zero_notional_action": "rebuild_required_feature_rows",
                        "before_refs": ["feature_coverage:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }

        latest_status_variants = (
            None,
            lambda: [],
            lambda: {"latest_signal_at": "not-a-datetime"},
        )
        for latest_status in latest_status_variants:
            with self.subTest(latest_status=latest_status):
                ingestor_attrs = {
                    "fetch_signals_with_reason": lambda **kwargs: SimpleNamespace(
                        signals=[],
                        no_signal_reason="window_empty",
                        query_start=kwargs["start"],
                        query_end=kwargs["end"],
                    ),
                }
                if latest_status is not None:
                    ingestor_attrs["latest_signal_status"] = latest_status
                app.state.trading_scheduler = SimpleNamespace(
                    _pipeline=SimpleNamespace(
                        ingestor=SimpleNamespace(**ingestor_attrs),
                    ),
                    state=SimpleNamespace(metrics=SimpleNamespace()),
                )

                with patch(
                    "app.api.maintenance.trading_status", return_value=status_payload
                ):
                    response = self.client.post(
                        "/trading/profit-freshness/zero-notional-repair"
                        "?action=rebuild_required_feature_rows&execute=true"
                    )

                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(payload["execution_state"], "runner_blocked")
                self.assertEqual(payload["command_exit_code"], 78)
                self.assertEqual(
                    payload["blocked_reasons"],
                    ["feature_coverage_no_signals:window_empty"],
                )
                self.assertEqual(payload["after_refs"], [])
                self.assertEqual(
                    payload["runner_result"]["result"]["replay_window"],
                    "current",
                )
                self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_records_feature_quality_rejection(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:features",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "feature_coverage",
                        "zero_notional_action": "rebuild_required_feature_rows",
                        "before_refs": ["feature_coverage:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        rejected_reasons: list[list[str]] = []
        fetched: list[dict[str, object]] = []
        naive_latest_signal_at = datetime(2026, 5, 12, 20, 57)

        def fetch_signals_with_reason(**kwargs: object) -> SimpleNamespace:
            fetched.append(kwargs)
            if len(fetched) == 1:
                return SimpleNamespace(
                    signals=[],
                    no_signal_reason="cursor_ahead_of_stream",
                    query_start=kwargs["start"],
                    query_end=kwargs["end"],
                )
            return SimpleNamespace(
                signals=[SimpleNamespace(symbol="AAPL")],
                no_signal_reason=None,
                query_start=kwargs["start"],
                query_end=kwargs["end"],
            )

        metrics = SimpleNamespace(
            feature_batch_rows_total=0,
            feature_null_rate={},
            feature_staleness_ms_p95=0,
            feature_duplicate_ratio=0.0,
            feature_schema_mismatch_total=0,
            feature_quality_rejections_total=0,
            record_feature_quality_rejection=lambda reasons: rejected_reasons.append(
                list(reasons),
            ),
        )
        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=fetch_signals_with_reason,
                    latest_signal_status=lambda: {
                        "latest_signal_at": naive_latest_signal_at,
                    },
                ),
            ),
            state=SimpleNamespace(metrics=metrics),
        )
        app.state.trading_scheduler = scheduler
        quality_report = FeatureQualityReport(
            accepted=False,
            rows_total=1,
            null_rate_by_field={"macd": 1.0},
            staleness_ms_p95=200,
            duplicate_ratio=0.0,
            schema_mismatch_total=0,
            reasons=["required_feature_null_rate_high"],
        )

        with (
            patch("app.api.maintenance.trading_status", return_value=status_payload),
            patch(
                "app.api.maintenance.evaluate_feature_batch_quality",
                return_value=quality_report,
            ),
        ):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rebuild_required_feature_rows&execute=true"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertFalse(payload["runner_result"]["result"]["accepted"])
        self.assertEqual(
            payload["runner_result"]["result"]["reason_codes"],
            ["required_feature_null_rate_high"],
        )
        self.assertEqual(len(fetched), 2)
        self.assertEqual(
            fetched[1]["start"],
            naive_latest_signal_at.replace(tzinfo=timezone.utc) - timedelta(minutes=15),
        )
        self.assertEqual(metrics.feature_quality_rejections_total, 1)
        self.assertEqual(rejected_reasons, [["required_feature_null_rate_high"]])
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_blocks_drift_replay_without_signals(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:drift",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "drift_checks",
                        "zero_notional_action": "rerun_drift_checks_for_blocked_hypotheses",
                        "before_refs": ["drift_detection:AAPL:missing"],
                        "symbol_set": ["AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        scheduler = SimpleNamespace(
            _pipeline=SimpleNamespace(
                ingestor=SimpleNamespace(
                    fetch_signals_with_reason=lambda **_: SimpleNamespace(
                        signals=[],
                        no_signal_reason="window_empty",
                        query_start="2026-05-13T04:00:00+00:00",
                        query_end="2026-05-13T04:05:00+00:00",
                    ),
                    latest_signal_status=lambda: {"latest_signal_at": "not-a-datetime"},
                ),
                _run_simple_drift_check=lambda signals: self.fail(
                    f"unexpected drift replay: {signals}",
                ),
            ),
            state=SimpleNamespace(
                drift_last_detection_path="",
                drift_status=None,
                drift_active_reason_codes=[],
            ),
        )
        app.state.trading_scheduler = scheduler

        with patch("app.api.maintenance.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rerun_drift_checks_for_blocked_hypotheses&execute=true"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "runner_blocked")
        self.assertEqual(payload["command_exit_code"], 78)
        self.assertEqual(
            payload["blocked_reasons"],
            ["drift_check_no_signals:window_empty"],
        )
        self.assertEqual(payload["after_refs"], [])
        self.assertEqual(payload["runner_result"]["result"]["symbol_set"], ["AAPL"])
        self.assertFalse(payload["order_submission_enabled"])

        scheduler._pipeline.ingestor.latest_signal_status = lambda: None
        with patch("app.api.maintenance.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=rerun_drift_checks_for_blocked_hypotheses&execute=true"
            )
        self.assertEqual(response.json()["execution_state"], "runner_blocked")

    def test_trading_status_blocks_live_submission_when_lineage_tables_are_empty(
        self,
    ) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
        }
        try:
            settings.trading_enabled = True
            settings.trading_mode = "live"
            settings.trading_autonomy_enabled = False
            settings.trading_autonomy_allow_live_promotion = False
            settings.trading_kill_switch_enabled = False

            scheduler = TradingScheduler()
            scheduler.state.last_market_context_freshness_seconds = 30
            app.state.trading_scheduler = scheduler

            with self.session_local() as session:
                observed_at = datetime.now(timezone.utc)
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        window_started_at=observed_at - timedelta(minutes=15),
                        window_ended_at=observed_at,
                        market_session_count=1,
                        decision_count=1,
                        trade_count=1,
                        order_count=1,
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        capital_stage="0.10x canary",
                    )
                )
                session.add(
                    StrategyPromotionDecision(
                        run_id="run-1",
                        candidate_id="cand-1",
                        hypothesis_id="H-CONT-01",
                        promotion_target="live",
                        state="0.10x canary",
                        allowed=True,
                        reason_summary="ready",
                    )
                )
                session.commit()

            registry_item = SimpleNamespace(
                hypothesis_id="H-CONT-01",
                model_dump=lambda mode="json": {
                    "hypothesis_id": "H-CONT-01",
                    "lane_id": "lane-cand-1",
                    "strategy_family": "demo",
                    "segment_dependencies": [],
                },
            )

            with (
                patch(
                    "app.api.status_helpers._build_hypothesis_runtime_payload",
                    return_value=(
                        {
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
                                    "promotion_eligible": True,
                                    "capital_stage": "0.10x canary",
                                    "reasons": [],
                                    "segment_dependencies": [],
                                }
                            ],
                        },
                        {
                            "promotion_eligible_total": 1,
                            "capital_stage_totals": {"0.10x canary": 1},
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
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=SimpleNamespace(items=[registry_item]),
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
                        "source_url": "http://torghut.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
                    },
                ),
            ):
                response = self.client.get("/trading/status")

            self.assertEqual(response.status_code, 200)
            gate = response.json()["live_submission_gate"]
            self.assertFalse(gate["allowed"])
            self.assertEqual(gate["capital_state"], "observe")
            self.assertIn("dataset_snapshot_missing", gate["blocked_reasons"])
            self.assertIn("strategy_hypothesis_missing", gate["blocked_reasons"])
            self.assertEqual(gate["lineage_ref"]["status"], "missing")
            self.assertEqual(gate["lineage_ref"]["dataset_snapshot_count"], 0)
            self.assertEqual(gate["lineage_ref"]["strategy_hypothesis_count"], 0)
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
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler
