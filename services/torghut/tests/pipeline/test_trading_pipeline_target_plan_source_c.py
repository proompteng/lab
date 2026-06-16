from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RiskEngine,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_target_with_runtime_account_audit,
    cast,
    datetime,
    json,
    os,
    patch,
    timedelta,
    timezone,
)


class TestTradingPipelineTargetPlanSourceC(TradingPipelineTestCaseBase):
    def test_short_paper_route_probe_entry_after_exit_minute_rejected(self) -> None:
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
            account_label="paper",
            session_factory=self.session_local,
        )
        strategy = Strategy(
            name="paper-route-short-exit-bound",
            description=(
                "paper route short exit-bound fixture\n[catalog_metadata]\n"
                + json.dumps({"params": {"exit_minute_after_open": "120"}})
            ),
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AMZN"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AMZN",
            event_ts=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="route-probe-short-entry",
            params={"price": "200"},
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        ):
            self.assertTrue(
                pipeline._paper_route_probe_entry_after_exit_minute(
                    decision=decision,
                    strategy=strategy,
                )
            )

    def test_paper_route_probe_context_honors_external_target_plan_scope(self) -> None:
        from app import config

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
            account_label="paper",
            session_factory=self.session_local,
        )
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="route-probe-target-plan-scope",
            params={"price": "100"},
        )
        proof_floor = {
            "market_window": {"session_open": True},
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            "route_reacquisition_book": {
                "summary": {
                    "repair_candidate_symbols": ["AAPL", "NVDA"],
                    "paper_route_probe_eligible_symbols": ["AAPL", "NVDA"],
                }
            },
        }
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0

        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            return_value={
                "targets": [
                    {
                        "paper_route_probe_symbols": ["AAPL"],
                        "candidate_id": "candidate-pairs-a",
                        "hypothesis_id": "H-PAIRS-01",
                        "strategy_name": "pairs-runtime-a",
                    },
                    {
                        "paper_route_probe_symbols": ["MSFT"],
                        "candidate_id": "candidate-other",
                        "hypothesis_id": "H-OTHER",
                        "strategy_name": "other-runtime",
                    },
                ]
            },
        ):
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision,
                )
            )
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision.model_copy(update={"symbol": "AAPL"}),
                )
            )
            target_source_metadata = {
                "mode": "paper_route_target_plan_source_decision",
                "paper_route_probe_next_session_max_notional": "25",
            }
            scoped_context = pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision.model_copy(
                    update={
                        "symbol": "AAPL",
                        "params": {
                            "price": "100",
                            "paper_route_target_plan": target_source_metadata,
                            "paper_route_target_plan_source_decision": (
                                target_source_metadata
                            ),
                        },
                    }
                ),
            )

        self.assertIsNotNone(scoped_context)
        assert scoped_context is not None
        self.assertEqual(
            scoped_context.get("paper_route_target_plan_symbols"), ["AAPL", "MSFT"]
        )
        self.assertEqual(
            scoped_context.get("paper_route_target_plan_source"),
            "external_target_plan_url",
        )
        self.assertEqual(
            scoped_context.get("source_candidate_ids"), ["candidate-pairs-a"]
        )
        self.assertEqual(scoped_context.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(
            scoped_context.get("source_strategy_names"), ["pairs-runtime-a"]
        )
        self.assertEqual(
            scoped_context.get("paper_route_probe_lineage_targets"),
            [
                {
                    "candidate_id": "candidate-pairs-a",
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_name": "pairs-runtime-a",
                }
            ],
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            return_value={"load_error": "paper_route_target_plan_fetch_failed:test"},
        ):
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision.model_copy(update={"symbol": "AAPL"}),
                )
            )
        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            return_value={"targets": [{"paper_route_probe_symbols": []}]},
        ):
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision.model_copy(update={"symbol": "AAPL"}),
                )
            )

    def test_paper_decision_persists_external_target_lineage_without_gate_bypass(
        self,
    ) -> None:
        from app import config

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
            account_label="paper",
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
                event_ts=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
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
                            "candidate_id": "candidate-pairs-a",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
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

        self.assertEqual(params.get("source_candidate_ids"), ["candidate-pairs-a"])
        self.assertEqual(params.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(target_plan.get("mode"), "paper_route_target_lineage")
        self.assertEqual(
            target_plan.get("paper_route_probe_lineage_targets"),
            [
                {
                    "candidate_id": "candidate-pairs-a",
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                }
            ],
        )
        self.assertNotIn("paper_route_probe", params)

    def test_external_paper_route_target_plan_cache_spans_scheduler_cycle(
        self,
    ) -> None:
        from app import config

        original_target_plan_url = config.settings.trading_paper_route_target_plan_url
        original_target_plan_timeout = (
            config.settings.trading_paper_route_target_plan_timeout_seconds
        )
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
            account_label="paper",
            session_factory=self.session_local,
        )
        now = datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc)
        try:
            with (
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    side_effect=[
                        now,
                        now + timedelta(seconds=30),
                        now + timedelta(seconds=61),
                    ],
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                    return_value={
                        "targets": [
                            {
                                "paper_route_probe_symbols": ["AAPL"],
                                "candidate_id": "candidate-pairs-a",
                            }
                        ]
                    },
                ) as fetch_plan,
            ):
                first_symbols, first_error, first_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
                second_symbols, second_error, second_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
                third_symbols, third_error, third_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
        finally:
            config.settings.trading_paper_route_target_plan_url = (
                original_target_plan_url
            )
            config.settings.trading_paper_route_target_plan_timeout_seconds = (
                original_target_plan_timeout
            )

        self.assertEqual(first_symbols, {"AAPL"})
        self.assertIsNone(first_error)
        self.assertEqual(first_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(second_symbols, {"AAPL"})
        self.assertIsNone(second_error)
        self.assertEqual(second_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(third_symbols, {"AAPL"})
        self.assertIsNone(third_error)
        self.assertEqual(third_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(fetch_plan.call_count, 2)

    def test_external_paper_route_target_plan_cache_uses_recent_success_after_timeout(
        self,
    ) -> None:
        from app import config

        original_target_plan_url = config.settings.trading_paper_route_target_plan_url
        original_target_plan_timeout = (
            config.settings.trading_paper_route_target_plan_timeout_seconds
        )
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
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._paper_route_target_plan_cache = None
        pipeline._paper_route_target_plan_success_cache = None
        now = datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc)
        try:
            with (
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    side_effect=[now, now + timedelta(seconds=120)],
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                    side_effect=[
                        {
                            "targets": [
                                {
                                    "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                    "candidate_id": "candidate-pairs-a",
                                }
                            ]
                        },
                        {
                            "load_error": (
                                "paper_route_target_plan_fetch_failed:timed out"
                            ),
                        },
                    ],
                ) as fetch_plan,
            ):
                first_symbols, first_error, first_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
                second_symbols, second_error, second_targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached()
                )
        finally:
            config.settings.trading_paper_route_target_plan_url = (
                original_target_plan_url
            )
            config.settings.trading_paper_route_target_plan_timeout_seconds = (
                original_target_plan_timeout
            )

        self.assertEqual(first_symbols, {"AAPL", "AMZN"})
        self.assertIsNone(first_error)
        self.assertEqual(first_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(second_symbols, {"AAPL", "AMZN"})
        self.assertIsNone(second_error)
        self.assertEqual(second_targets[0]["candidate_id"], "candidate-pairs-a")
        self.assertEqual(
            second_targets[0]["paper_route_target_plan_cache_status"],
            "stale_success",
        )
        self.assertEqual(
            second_targets[0]["paper_route_target_plan_last_load_error"],
            "paper_route_target_plan_fetch_failed:timed out",
        )
        self.assertEqual(fetch_plan.call_count, 2)

    def test_self_referential_paper_route_target_plan_uses_local_gate_without_http(
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
        config.settings.trading_paper_route_target_plan_url = "http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-target-plan"
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
        pipeline._paper_route_target_plan_cache = None
        pipeline._paper_route_target_plan_success_cache = None
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
        )
        local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "targets": [
                    {
                        "candidate_id": "candidate-local-gate",
                        "hypothesis_id": "H-PAIRS-01",
                        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        "paper_route_probe_window_start": ("2026-06-01T13:30:00+00:00"),
                        "paper_route_probe_window_end": ("2026-06-01T20:00:00+00:00"),
                        "paper_route_probe_next_session_max_notional": "75000",
                    }
                ],
            }
        }
        try:
            with (
                patch.dict(
                    os.environ,
                    {"K_SERVICE": "torghut-sim", "POD_NAMESPACE": "torghut"},
                    clear=False,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
                ),
                patch.object(
                    pipeline, "_live_submission_gate", return_value=local_gate
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                    side_effect=AssertionError(
                        "scheduler must not self-fetch target plan"
                    ),
                ),
            ):
                symbols, error, targets = (
                    pipeline._external_paper_route_target_probe_symbols_cached(
                        session=None,
                        strategies=[strategy],
                    )
                )
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

        self.assertEqual(symbols, {"AAPL", "AMZN"})
        self.assertIsNone(error)
        self.assertEqual(targets[0]["candidate_id"], "candidate-local-gate")
        self.assertEqual(
            targets[0]["paper_route_target_plan_source"],
            "local_live_submission_gate",
        )
        self.assertEqual(targets[0]["paper_route_probe_symbols"], ["AAPL", "AMZN"])
        self.assertEqual(
            targets[0]["source_decision_readiness"]["schema_version"],
            "torghut.paper-route-source-decision-readiness.v1",
        )
        self.assertTrue(targets[0]["source_decision_readiness"]["ready"])
        self.assertEqual(
            targets[0]["source_decision_readiness"]["source"],
            "local_target_plan_probe_symbols",
        )
        self.assertEqual(
            targets[0]["source_decision_readiness"]["scoped_probe_symbols"],
            ["AAPL", "AMZN"],
        )

    def test_local_paper_route_target_plan_reports_missing_targets(self) -> None:
        pipeline = object.__new__(SimpleTradingPipeline)
        local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "targets": [],
            }
        }

        with patch.object(pipeline, "_live_submission_gate", return_value=local_gate):
            symbols, error, targets = pipeline._local_paper_route_target_probe_symbols(
                session=None,
                strategies=None,
            )

        self.assertEqual(symbols, set())
        self.assertEqual(error, "paper_route_target_plan_missing")
        self.assertEqual(targets, [])

    def test_local_paper_route_target_plan_falls_back_to_strategy_symbols(self) -> None:
        pipeline = object.__new__(SimpleTradingPipeline)
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
        )
        local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "targets": [
                    {
                        "candidate_id": "candidate-local-gate",
                        "hypothesis_id": "H-PAIRS-01",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_window_start": ("2026-06-01T13:30:00+00:00"),
                        "paper_route_probe_window_end": "2026-06-01T20:00:00+00:00",
                        "paper_route_probe_next_session_max_notional": "75000",
                    }
                ],
            }
        }

        with patch.object(pipeline, "_live_submission_gate", return_value=local_gate):
            symbols, error, targets = pipeline._local_paper_route_target_probe_symbols(
                session=None,
                strategies=[strategy],
            )

        self.assertEqual(symbols, {"AAPL", "AMZN"})
        self.assertIsNone(error)
        self.assertEqual(
            targets[0]["paper_route_target_plan_source"], "local_live_submission_gate"
        )
        self.assertEqual(targets[0]["paper_route_probe_symbols"], ["AAPL", "AMZN"])
        self.assertTrue(targets[0]["source_decision_readiness"]["ready"])
        self.assertEqual(
            targets[0]["source_decision_readiness"]["source"],
            "local_strategy_universe_target_plan_fallback",
        )
        self.assertEqual(
            targets[0]["source_decision_readiness"]["scoped_probe_symbols"],
            ["AAPL", "AMZN"],
        )

    def test_local_paper_route_target_plan_strategy_fallback_satisfies_source_collection_gate(
        self,
    ) -> None:
        pipeline = object.__new__(SimpleTradingPipeline)
        strategy = Strategy(
            name="intraday-tsmom-profit-v3",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "NVDA"],
        )
        local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "targets": [
                    {
                        "candidate_id": "candidate-local-source-collection",
                        "hypothesis_id": "H-TSMOM-LIQ-01",
                        "strategy_name": "intraday-tsmom-profit-v3",
                        "runtime_strategy_name": "intraday-tsmom-profit-v3",
                        "account_label": "TORGHUT_SIM",
                        "source_account_label": "TORGHUT_SIM",
                        "source_kind": "runtime_ledger_source_collection_candidate",
                        "source_manifest_ref": (
                            "config/trading/hypotheses/h-tsmom-liq-01.json"
                        ),
                        "source_collection_authorized": True,
                        "source_collection_authorization_scope": (
                            "source_window_evidence_collection_only"
                        ),
                        "evidence_collection_ok": True,
                        "observed_stage": "paper",
                        "paper_route_probe_window_start": ("2026-06-01T13:30:00+00:00"),
                        "paper_route_probe_window_end": "2026-06-01T20:00:00+00:00",
                        "paper_route_probe_next_session_max_notional": "75000",
                    }
                ],
            }
        }

        with patch.object(pipeline, "_live_submission_gate", return_value=local_gate):
            symbols, error, targets = pipeline._local_paper_route_target_probe_symbols(
                session=None,
                strategies=[strategy],
            )

        self.assertEqual(symbols, {"AAPL", "NVDA"})
        self.assertIsNone(error)
        target = _bounded_sim_collection_target_with_runtime_account_audit(
            targets[0],
            positions=[],
            account_label="TORGHUT_SIM",
        )
        blockers = _bounded_sim_collection_blockers(
            target,
            account_label="TORGHUT_SIM",
        )
        self.assertNotIn("bounded_sim_collection_probe_symbols_missing", blockers)
        self.assertNotIn(
            "bounded_sim_collection_source_decision_readiness_missing",
            blockers,
        )
        self.assertEqual(blockers, [])

    def test_local_paper_route_target_plan_requires_probe_symbols(self) -> None:
        pipeline = object.__new__(SimpleTradingPipeline)
        local_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
                "targets": [
                    {
                        "candidate_id": "candidate-local-gate",
                        "hypothesis_id": "H-PAIRS-01",
                        "account_label": "TORGHUT_SIM",
                        "paper_route_probe_window_start": ("2026-06-01T13:30:00+00:00"),
                        "paper_route_probe_window_end": "2026-06-01T20:00:00+00:00",
                        "paper_route_probe_next_session_max_notional": "75000",
                    }
                ],
            }
        }

        with patch.object(pipeline, "_live_submission_gate", return_value=local_gate):
            symbols, error, targets = pipeline._local_paper_route_target_probe_symbols(
                session=None,
                strategies=None,
            )

        self.assertEqual(symbols, set())
        self.assertEqual(error, "paper_route_target_plan_probe_symbols_missing")
        self.assertEqual(
            targets[0]["paper_route_target_plan_source"], "local_live_submission_gate"
        )
