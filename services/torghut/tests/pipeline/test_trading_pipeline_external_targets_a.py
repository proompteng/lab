from __future__ import annotations

# ruff: noqa: F403,F405
from tests.pipeline.trading_pipeline_base import *


class TestTradingPipelineExternalTargetsA(TradingPipelineTestCaseBase):
    def test_bounded_signal_scope_records_target_plan_fetch_failure(
        self,
    ) -> None:
        from app import config

        original_target_plan_url = config.settings.trading_paper_route_target_plan_url
        original_target_plan_timeout = (
            config.settings.trading_paper_route_target_plan_timeout_seconds
        )
        original_mode = config.settings.trading_mode
        original_probe_enabled = (
            config.settings.trading_simple_paper_route_probe_enabled
        )
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-target-plan"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        try:
            with (
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                    return_value={
                        "load_error": (
                            "paper_route_target_plan_fetch_failed:timed out"
                        ),
                        "fetch_attempts": 3,
                    },
                ) as fetch_plan,
            ):
                self.assertIsNone(pipeline._bounded_paper_route_signal_scope([]))
        finally:
            config.settings.trading_mode = original_mode
            config.settings.trading_simple_paper_route_probe_enabled = (
                original_probe_enabled
            )
            config.settings.trading_paper_route_target_plan_url = (
                original_target_plan_url
            )
            config.settings.trading_paper_route_target_plan_timeout_seconds = (
                original_target_plan_timeout
            )

        fetch_plan.assert_called_once_with(
            "http://torghut.local/trading/paper-route-target-plan",
            timeout_seconds=1.0,
            attempts=3,
            retry_backoff_seconds=0.25,
        )
        blocker = cast(
            dict[str, Any],
            getattr(pipeline.state, "last_bounded_evidence_collection_blocker"),
        )
        self.assertEqual(
            blocker.get("reason"),
            "paper_route_target_plan_fetch_failed:timed out",
        )
        self.assertEqual(
            blocker.get("blockers"),
            ["paper_route_target_plan_fetch_failed:timed out"],
        )
        self.assertEqual(blocker.get("source"), "external_target_plan_url")
        self.assertEqual(blocker.get("account_label"), "TORGHUT_SIM")
        self.assertEqual(blocker.get("fetch_attempts"), 3)

    def test_bounded_signal_scope_records_configured_target_plan_missing_symbols(
        self,
    ) -> None:
        from app import config

        original_target_plan_url = config.settings.trading_paper_route_target_plan_url
        original_mode = config.settings.trading_mode
        original_probe_enabled = (
            config.settings.trading_simple_paper_route_probe_enabled
        )
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-target-plan"
        )
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        try:
            with (
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
                patch.object(
                    SimpleTradingPipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=(set(), None, []),
                ),
            ):
                self.assertIsNone(pipeline._bounded_paper_route_signal_scope([]))
        finally:
            config.settings.trading_mode = original_mode
            config.settings.trading_simple_paper_route_probe_enabled = (
                original_probe_enabled
            )
            config.settings.trading_paper_route_target_plan_url = (
                original_target_plan_url
            )

        blocker = cast(
            dict[str, Any],
            getattr(pipeline.state, "last_bounded_evidence_collection_blocker"),
        )
        self.assertEqual(
            blocker.get("reason"),
            "paper_route_target_plan_probe_symbols_missing",
        )
        self.assertEqual(blocker.get("target_symbols"), [])
        self.assertEqual(blocker.get("target_count"), 0)

    def test_paper_route_target_source_decisions_record_target_plan_unavailable(
        self,
    ) -> None:
        from app import config

        original_target_plan_url = config.settings.trading_paper_route_target_plan_url
        original_mode = config.settings.trading_mode
        original_probe_enabled = (
            config.settings.trading_simple_paper_route_probe_enabled
        )
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-target-plan"
        )
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        try:
            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ):
                with patch.object(
                    SimpleTradingPipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=(
                        set(),
                        "paper_route_target_plan_fetch_failed:timed out",
                        [],
                    ),
                ):
                    self.assertEqual(
                        pipeline._paper_route_target_source_decisions(
                            strategies=[],
                            allowed_symbols=set(),
                        ),
                        [],
                    )
                fetch_blocker = cast(
                    dict[str, Any],
                    getattr(pipeline.state, "last_bounded_evidence_collection_blocker"),
                )

                with patch.object(
                    SimpleTradingPipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=(set(), None, []),
                ):
                    self.assertEqual(
                        pipeline._paper_route_target_source_decisions(
                            strategies=[],
                            allowed_symbols=set(),
                        ),
                        [],
                    )
                missing_symbol_blocker = cast(
                    dict[str, Any],
                    getattr(pipeline.state, "last_bounded_evidence_collection_blocker"),
                )
        finally:
            config.settings.trading_mode = original_mode
            config.settings.trading_simple_paper_route_probe_enabled = (
                original_probe_enabled
            )
            config.settings.trading_paper_route_target_plan_url = (
                original_target_plan_url
            )

        self.assertEqual(
            fetch_blocker.get("reason"),
            "paper_route_target_plan_fetch_failed:timed out",
        )
        self.assertEqual(
            missing_symbol_blocker.get("reason"),
            "paper_route_target_plan_probe_symbols_missing",
        )
        self.assertEqual(fetch_blocker.get("source"), "external_target_plan_url")
        self.assertEqual(
            missing_symbol_blocker.get("source"),
            "external_target_plan_url",
        )

    def test_matching_paper_target_signal_gets_strategy_signal_paper_authority(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 5, 28, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 28, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 5, 28, 15, 30, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "100"},
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                return_value={
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AAPL"],
                            "paper_route_probe_window_start": window_start.isoformat(),
                            "paper_route_probe_window_end": window_end.isoformat(),
                            "candidate_id": "candidate-pairs-a",
                            "hypothesis_id": "H-PAIRS-01",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "strategy_lookup_names": [
                                str(strategy.id),
                                "microbar-cross-sectional-pairs-v1",
                            ],
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-pairs-01.json"
                            ),
                            "dataset_snapshot_ref": (
                                "portfolio-profit-autoresearch-500-v1"
                            ),
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_REPLAY",
                            "paper_route_target_account_audit_state": (
                                self._paper_route_target_account_audit_state(["AAPL"])
                            ),
                            "paper_route_target_account_audit_blockers": [],
                            "runtime_strategy_name": (
                                "microbar-cross-sectional-pairs-v1"
                            ),
                            "evidence_collection_ok": True,
                            "canary_collection_authorized": True,
                            "bounded_evidence_collection_authorized": True,
                            "bounded_live_paper_collection_authorized": True,
                            "bounded_evidence_collection_scope": (
                                "paper_route_probe_next_session_only"
                            ),
                            "bounded_evidence_collection_blockers": [],
                            "runtime_window_import_health_gate_blockers": [],
                            "paper_route_account_pre_session_blockers": [],
                            "paper_route_hpairs_symbol_blockers": [],
                            "paper_route_probe_pair_balance_state": "balanced",
                            "source_decision_readiness": {
                                "ready": True,
                                "blockers": [],
                            },
                            "paper_probation_authorized": True,
                        }
                    ]
                },
            ):
                row = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(row)
            assert row is not None
            payload = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], payload.get("params"))
            target_plan = cast(dict[str, Any], params.get("paper_route_target_plan"))
            authority = cast(dict[str, Any], params.get("strategy_signal_paper"))

        self.assertEqual(params.get("source_candidate_ids"), ["candidate-pairs-a"])
        self.assertEqual(params.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(params.get("source_decision_mode"), "strategy_signal_paper")
        self.assertTrue(params.get("profit_proof_eligible"))
        self.assertFalse(params.get("promotion_allowed"))
        self.assertEqual(authority.get("mode"), "strategy_signal_paper")
        self.assertEqual(authority.get("candidate_id"), "candidate-pairs-a")
        self.assertEqual(authority.get("hypothesis_id"), "H-PAIRS-01")
        self.assertEqual(
            authority.get("source_kind"), "paper_route_probe_runtime_observed"
        )
        self.assertEqual(
            authority.get("paper_route_probe_window_start"), window_start.isoformat()
        )
        self.assertEqual(
            target_plan.get("source_decision_mode"), "strategy_signal_paper"
        )
        self.assertEqual(target_plan.get("account_label"), "TORGHUT_SIM")
        self.assertEqual(
            target_plan.get("bounded_evidence_collection_scope"),
            "paper_route_probe_next_session_only",
        )
        self.assertTrue(target_plan.get("profit_proof_eligible"))
        self.assertIsNotNone(
            _bounded_sim_collection_metadata_from_decision(
                StrategyDecision(
                    strategy_id=params.get("strategy_id", ""),
                    symbol="AAPL",
                    event_ts=datetime(2026, 5, 28, 15, 30, tzinfo=timezone.utc),
                    timeframe="1Sec",
                    action="sell",
                    qty=Decimal("1"),
                    params=params,
                ),
                account_label="TORGHUT_SIM",
                trading_mode="paper",
            )
        )
        self.assertNotIn("paper_route_probe", params)
        self.assertNotIn("paper_route_target_plan_source_decision", params)

    def test_strategy_signal_paper_uses_next_target_plan_over_closed_import_plan(
        self,
    ) -> None:
        from app import config

        closed_window_start = datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc)
        closed_window_end = datetime(2026, 5, 29, 20, 0, tzinfo=timezone.utc)
        next_window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        next_window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-target-plan"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            target_plan_payload = {
                "schema_version": "torghut.paper-route-target-plan.v1",
                "runtime_window_import_plan": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "purpose": "latest_closed_session_paper_route_runtime_window_import",
                    "target_count": 1,
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                            "paper_route_probe_window_start": (
                                closed_window_start.isoformat()
                            ),
                            "paper_route_probe_window_end": (
                                closed_window_end.isoformat()
                            ),
                            "candidate_id": "closed-friday-candidate",
                            "hypothesis_id": "H-PAIRS-01",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "paper_probation_authorized": True,
                        }
                    ],
                },
                "next_paper_route_runtime_window_targets": {
                    "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                    "purpose": "next_session_paper_route_runtime_window_evidence_collection",
                    "target_count": 1,
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                            "paper_route_probe_window_start": (
                                next_window_start.isoformat()
                            ),
                            "paper_route_probe_window_end": next_window_end.isoformat(),
                            "candidate_id": "candidate-pairs-monday",
                            "hypothesis_id": "H-PAIRS-01",
                            "observed_stage": "paper",
                            "strategy_family": "microbar_cross_sectional_pairs",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "strategy_lookup_names": [
                                str(strategy.id),
                                "microbar-cross-sectional-pairs-v1",
                            ],
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-pairs-01.json"
                            ),
                            "dataset_snapshot_ref": (
                                "portfolio-profit-autoresearch-500-v1"
                            ),
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_REPLAY",
                            "paper_route_target_account_audit_state": (
                                self._paper_route_target_account_audit_state(
                                    ["AAPL", "AMZN"]
                                )
                            ),
                            "paper_route_target_account_audit_blockers": [],
                            "runtime_strategy_name": (
                                "microbar-cross-sectional-pairs-v1"
                            ),
                            "evidence_collection_ok": True,
                            "canary_collection_authorized": True,
                            "bounded_evidence_collection_authorized": True,
                            "bounded_live_paper_collection_authorized": True,
                            "bounded_evidence_collection_scope": (
                                "paper_route_probe_next_session_only"
                            ),
                            "bounded_evidence_collection_blockers": [],
                            "runtime_window_import_health_gate_blockers": [],
                            "paper_route_account_pre_session_blockers": [],
                            "paper_route_hpairs_symbol_blockers": [],
                            "paper_route_probe_pair_balance_state": "balanced",
                            "source_decision_readiness": {
                                "ready": True,
                                "blockers": [],
                            },
                            "paper_probation_authorized": True,
                        }
                    ],
                },
            }
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 6, 1, 15, 30, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "100"},
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                return_value=paper_route_target_plan_from_payload(target_plan_payload),
            ):
                row = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(row)
            assert row is not None
            payload = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], payload.get("params"))
            authority = cast(dict[str, Any], params.get("strategy_signal_paper"))

        self.assertEqual(params.get("source_decision_mode"), "strategy_signal_paper")
        self.assertTrue(params.get("profit_proof_eligible"))
        self.assertEqual(authority.get("candidate_id"), "candidate-pairs-monday")
        self.assertNotEqual(authority.get("candidate_id"), "closed-friday-candidate")
        self.assertEqual(
            authority.get("paper_route_probe_window_start"),
            next_window_start.isoformat(),
        )
