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
    SignalEnvelope,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    cast,
    datetime,
    json,
    patch,
    select,
    timezone,
    uuid4,
)


class TestTradingPipelineTargetPlanSourceB(TradingPipelineTestCaseBase):
    def test_live_bounded_paper_route_probe_does_not_bypass_retired_collection_blockers(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_simple_submit_enabled": (
                config.settings.trading_simple_submit_enabled
            ),
            "trading_simple_paper_route_probe_enabled": (
                config.settings.trading_simple_paper_route_probe_enabled
            ),
            "trading_simple_paper_route_probe_allow_live_mode": (
                config.settings.trading_simple_paper_route_probe_allow_live_mode
            ),
        }
        config.settings.trading_mode = "live"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_allow_live_mode = True
        try:
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
            strategy_id = str(uuid4())
            decision = StrategyDecision(
                strategy_id=strategy_id,
                symbol="AAPL",
                event_ts=datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="bounded-paper-route-probe",
                params={
                    "source_decision_mode": "bounded_paper_route_collection",
                    "profit_proof_eligible": True,
                    "paper_route_probe": {
                        "source_decision_mode": "bounded_paper_route_collection",
                        "profit_proof_eligible": True,
                    },
                },
            )
            gate = {
                "allowed": False,
                "blocked_reasons": [
                    "hypothesis_not_promotion_eligible",
                    "runtime_window_import_required",
                    "runtime_profit_target_import_required",
                ],
            }

            config.settings.trading_simple_paper_route_probe_allow_live_mode = False
            self.assertFalse(
                pipeline._bounded_live_paper_route_probe_submission_allowed(
                    decision,
                    gate,
                )
            )

            config.settings.trading_simple_paper_route_probe_allow_live_mode = True
            self.assertFalse(
                pipeline._bounded_live_paper_route_probe_submission_allowed(
                    decision,
                    gate,
                )
            )
            self.assertTrue(
                pipeline._bounded_live_paper_route_probe_submission_allowed(
                    decision,
                    {
                        **gate,
                        "blocked_reasons": [
                            *cast(list[str], gate["blocked_reasons"]),
                            "empirical_jobs_not_ready",
                        ],
                        "bounded_live_paper_collection_gate": {
                            "allowed": True,
                            "authority_scope": "bounded_evidence_collection_only",
                        },
                    },
                )
            )
            self.assertFalse(
                pipeline._bounded_live_paper_route_probe_submission_allowed(
                    decision,
                    {
                        **gate,
                        "bounded_live_paper_collection_gate": {
                            "allowed": False,
                            "reason": "live_submit_activation_expired",
                        },
                    },
                )
            )
            self.assertFalse(
                pipeline._bounded_live_paper_route_probe_submission_allowed(
                    decision,
                    {
                        **gate,
                        "blocked_reasons": [
                            *cast(list[str], gate["blocked_reasons"]),
                            "empirical_jobs_not_ready",
                        ],
                    },
                )
            )
            self.assertFalse(
                pipeline._bounded_live_paper_route_probe_submission_allowed(
                    decision,
                    {**gate, "blocked_reasons": []},
                )
            )
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_enabled = original[
                "trading_simple_paper_route_probe_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_allow_live_mode = original[
                "trading_simple_paper_route_probe_allow_live_mode"
            ]

    def test_live_gate_records_expired_activation_on_simple_lane(self) -> None:
        from app import config

        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_enabled": config.settings.trading_enabled,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_simple_submit_enabled": (
                config.settings.trading_simple_submit_enabled
            ),
            "trading_live_submit_enabled": config.settings.trading_live_submit_enabled,
            "trading_live_submit_activation_expires_at": (
                config.settings.trading_live_submit_activation_expires_at
            ),
        }
        config.settings.trading_mode = "live"
        config.settings.trading_enabled = True
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_live_submit_enabled = True
        config.settings.trading_live_submit_activation_expires_at = (
            "2000-01-01T00:00:00Z"
        )
        try:
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
            live_gate_owner = next(
                cls
                for cls in SimpleTradingPipeline.__mro__[1:]
                if "_live_submission_gate" in cls.__dict__
            )

            with patch.object(
                live_gate_owner,
                "_live_submission_gate",
                return_value={"allowed": True, "blocked_reasons": []},
            ):
                gate = pipeline._live_submission_gate()
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            config.settings.trading_live_submit_activation_expires_at = original[
                "trading_live_submit_activation_expires_at"
            ]

        self.assertTrue(gate["allowed"])
        simple_lane = cast(dict[str, Any], gate["simple_lane"])
        self.assertEqual(simple_lane["blocked_reasons"], [])
        self.assertEqual(
            simple_lane["live_submit_activation"]["reason"],
            "live_submit_activation_expired",
        )

    def test_live_bounded_paper_route_probe_passes_collection_only_proof_floor(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_simple_submit_enabled": (
                config.settings.trading_simple_submit_enabled
            ),
            "trading_simple_paper_route_probe_enabled": (
                config.settings.trading_simple_paper_route_probe_enabled
            ),
            "trading_simple_paper_route_probe_allow_live_mode": (
                config.settings.trading_simple_paper_route_probe_allow_live_mode
            ),
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_allow_live_mode = True
        try:
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
            strategy_id = str(uuid4())
            decision = StrategyDecision(
                strategy_id=strategy_id,
                symbol="AAPL",
                event_ts=datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="bounded-paper-route-probe",
                params={
                    "source_decision_mode": "bounded_paper_route_collection",
                    "profit_proof_eligible": True,
                    "paper_route_probe": {
                        "mode": "bounded_paper_route_collection",
                        "source_decision_mode": "bounded_paper_route_collection",
                        "profit_proof_eligible": True,
                    },
                },
            )
            gate = {
                "allowed": False,
                "blocked_reasons": [
                    "hypothesis_not_promotion_eligible",
                    "runtime_window_import_required",
                    "runtime_profit_target_import_required",
                ],
            }
            proof_floor = {
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": ["runtime_window_import_required"],
            }

            with self.session_local() as session:
                row = TradeDecision(
                    strategy_id=decision.strategy_id,
                    alpaca_account_label="paper",
                    symbol=decision.symbol,
                    timeframe=decision.timeframe,
                    decision_json=decision.model_dump(mode="json"),
                    status="planned",
                )
                session.add(row)
                session.commit()

                with (
                    patch.object(pipeline, "_live_submission_gate", return_value=gate),
                    patch.object(
                        SimpleTradingPipeline,
                        "_profitability_proof_floor",
                        return_value=proof_floor,
                    ),
                ):
                    self.assertFalse(
                        pipeline._is_trading_submission_allowed(
                            session=session,
                            decision=decision,
                            decision_row=row,
                        )
                    )

            proof_floor = {
                **proof_floor,
                "blocking_reasons": ["empirical_jobs_not_ready"],
            }
            with self.session_local() as session:
                row = TradeDecision(
                    strategy_id=decision.strategy_id,
                    alpaca_account_label="paper",
                    symbol=decision.symbol,
                    timeframe=decision.timeframe,
                    decision_json=decision.model_dump(mode="json"),
                    status="planned",
                )
                session.add(row)
                session.commit()

                with (
                    patch.object(
                        pipeline,
                        "_live_submission_gate",
                        return_value={
                            **gate,
                            "blocked_reasons": [
                                *cast(list[str], gate["blocked_reasons"]),
                                "empirical_jobs_not_ready",
                            ],
                        },
                    ),
                    patch.object(
                        SimpleTradingPipeline,
                        "_profitability_proof_floor",
                        return_value=proof_floor,
                    ),
                ):
                    self.assertFalse(
                        pipeline._is_trading_submission_allowed(
                            session=session,
                            decision=decision,
                            decision_row=row,
                        )
                    )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_enabled = original[
                "trading_simple_paper_route_probe_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_allow_live_mode = original[
                "trading_simple_paper_route_probe_allow_live_mode"
            ]

    def test_process_paper_route_target_source_decisions_records_submit_failure(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        state = TradingState()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=state,
            account_label="paper",
            session_factory=self.session_local,
        )
        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="target-plan-source-decision",
            params={"price": "100"},
        )
        positions: list[dict[str, Any]] = []

        with (
            patch.object(
                pipeline,
                "_paper_route_target_source_decisions",
                return_value=[decision],
            ) as source_decisions,
            patch.object(
                pipeline,
                "_handle_decision",
                side_effect=RuntimeError("submit failed"),
            ),
            self.session_local() as session,
        ):
            pipeline._process_paper_route_target_source_decisions(
                session=session,
                strategies=[strategy],
                account={"equity": "10000", "cash": "10000", "buying_power": "10000"},
                positions=positions,
                allowed_symbols={"AAPL"},
            )

        source_decisions.assert_called_once_with(
            strategies=[strategy],
            allowed_symbols={"AAPL"},
            positions=positions,
            session=session,
        )
        self.assertEqual(state.metrics.decisions_total, 1)
        self.assertEqual(state.metrics.orders_rejected_total, 1)
        self.assertEqual(
            state.metrics.decision_reject_reason_total.get("broker_submit_failed"),
            1,
        )

    def test_simple_pipeline_paper_route_probe_can_repair_symbol_outside_candidates(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-route-probe-repair-symbol",
                description="simple paper lane route probe repair symbol",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["NVDA"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True

        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": [
                "hypothesis_not_promotion_eligible",
                "execution_tca_symbol_missing",
            ],
            "route_reacquisition_book": {
                "summary": {
                    "candidate_symbols": ["AAPL"],
                    "repair_candidate_symbols": ["NVDA"],
                    "repair_candidates": [
                        {
                            "symbol": "NVDA",
                            "state": "missing",
                            "reason": "execution_tca_symbol_missing",
                        }
                    ],
                }
            },
        }
        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value=proof_floor,
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))
            simple_lane = cast(dict[str, Any], params.get("simple_lane"))

            self.assertEqual(decision.status, "submitted")
            self.assertEqual(paper_route_probe.get("symbol"), "NVDA")
            self.assertEqual(paper_route_probe.get("mode"), "paper_route_acquisition")
            self.assertEqual(simple_lane.get("paper_route_probe_cap_applied"), True)

    def test_paper_route_probe_helpers_handle_missing_repair_metadata(self) -> None:
        self.assertFalse(SimpleTradingPipeline._proof_floor_market_session_open({}))
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_route_repair_symbols({}), set()
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_paper_route_probe_symbols({}), set()
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_symbol_route_probe_reasons({}, "NVDA"),
            set(),
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_route_repair_symbols(
                {"route_reacquisition_book": {}}
            ),
            set(),
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_symbol_route_probe_reasons(
                {"route_reacquisition_book": {}},
                "NVDA",
            ),
            set(),
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_route_repair_symbols(
                {
                    "route_reacquisition_book": {
                        "summary": {
                            "repair_candidate_symbols": "NVDA",
                            "candidate_symbols": [" nvda ", "", "MU"],
                        }
                    }
                }
            ),
            {"NVDA", "MU"},
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_paper_route_probe_symbols(
                {
                    "route_reacquisition_book": {
                        "summary": {
                            "paper_route_probe_eligible_symbols": [
                                " nvda ",
                                "",
                                "MU",
                            ],
                            "paper_route_probe_active_symbols": ["aapl"],
                        },
                        "paper_route_probe": {
                            "eligible_symbols": ["INTC"],
                            "active_symbols": ["AMZN"],
                        },
                    }
                }
            ),
            {"AAPL", "AMZN", "INTC", "MU", "NVDA"},
        )
        self.assertEqual(
            SimpleTradingPipeline._proof_floor_symbol_route_probe_reasons(
                {
                    "route_reacquisition_book": {
                        "summary": {
                            "repair_candidates": [
                                object(),
                                {
                                    "symbol": "MU",
                                    "state": "missing",
                                    "reason": "execution_tca_symbol_missing",
                                },
                                {
                                    "symbol": "NVDA",
                                    "state": "blocked",
                                    "reason": "execution_tca_symbol_missing",
                                },
                            ]
                        }
                    }
                },
                "NVDA",
            ),
            set(),
        )

        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing-reference-price",
            params={},
        )

        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_reference_price(decision)
        )

    def test_paper_route_probe_context_rejects_unsafe_profiles(self) -> None:
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
            rationale="route-probe-context",
            params={"price": "100"},
        )
        proof_floor = {
            "market_window": {"session_open": True},
            "blocking_reasons": ["execution_tca_route_universe_empty"],
            "route_reacquisition_book": {
                "summary": {"repair_candidate_symbols": ["NVDA"]}
            },
        }

        config.settings.trading_mode = "live"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
            )
        )

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = False
        disabled_submit_probe_context = pipeline._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=decision,
        )
        self.assertIsNotNone(disabled_submit_probe_context)
        assert disabled_submit_probe_context is not None
        self.assertEqual(
            disabled_submit_probe_context.get("simple_submit_enabled"), False
        )
        self.assertEqual(
            disabled_submit_probe_context.get("simple_submit_bypass_scope"),
            "paper_route_probe_only",
        )

        config.settings.trading_simple_submit_enabled = True
        sell_decision = decision.model_copy(update={"action": "sell"})
        config.settings.trading_allow_shorts = False
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=sell_decision,
            )
        )
        reducing_sell_decision = decision.model_copy(
            update={
                "action": "sell",
                "params": {
                    "price": "100",
                    "simple_lane": {
                        "quantity_resolution": {
                            "action": "sell",
                            "reason": "sell_reducing_long_fractional_allowed",
                            "short_increasing": False,
                        }
                    },
                },
            }
        )
        reducing_sell_probe_context = pipeline._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=reducing_sell_decision,
        )
        self.assertIsNotNone(reducing_sell_probe_context)
        assert reducing_sell_probe_context is not None
        self.assertEqual(reducing_sell_probe_context.get("side"), "sell")
        self.assertEqual(
            reducing_sell_probe_context.get("mode"), "paper_route_acquisition"
        )
        config.settings.trading_allow_shorts = True
        sell_probe_context = pipeline._paper_route_probe_context(
            proof_floor=proof_floor,
            decision=sell_decision,
        )
        self.assertIsNotNone(sell_probe_context)
        assert sell_probe_context is not None
        self.assertEqual(sell_probe_context.get("side"), "sell")
        self.assertEqual(sell_probe_context.get("mode"), "paper_route_acquisition")

        config.settings.trading_simple_paper_route_probe_max_notional = 0.0
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
            )
        )

        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        closed_floor = {**proof_floor, "market_window": {"session_open": False}}
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=closed_floor,
                decision=decision,
            )
        )

        exit_bound_strategy = Strategy(
            name="paper-route-exit-bound",
            description=(
                "paper route exit-bound fixture\n[catalog_metadata]\n"
                + json.dumps({"params": {"exit_minute_after_open": "120"}})
            ),
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["NVDA"],
            max_notional_per_trade=Decimal("1000"),
        )
        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
        ):
            exit_bound_probe_context = pipeline._paper_route_probe_context(
                proof_floor=proof_floor,
                decision=decision,
                strategy=exit_bound_strategy,
            )
        self.assertIsNotNone(exit_bound_probe_context)
        assert exit_bound_probe_context is not None
        self.assertEqual(exit_bound_probe_context.get("exit_minute_after_open"), 120)
        self.assertEqual(
            exit_bound_probe_context.get("effective_exit_minute_after_open"),
            120,
        )
        self.assertEqual(
            exit_bound_probe_context.get("exit_due_at"),
            "2026-03-26T15:30:00+00:00",
        )
        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        ):
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=decision,
                    strategy=exit_bound_strategy,
                )
            )
            self.assertIsNone(
                pipeline._paper_route_probe_context(
                    proof_floor=proof_floor,
                    decision=sell_decision,
                    strategy=exit_bound_strategy,
                )
            )

        no_route_reason_floor = {
            **proof_floor,
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
        }
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=no_route_reason_floor,
                decision=decision,
            )
        )

        record_level_route_repair_floor = {
            **proof_floor,
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
            "route_reacquisition_book": {
                "summary": {"candidate_symbols": ["NVDA"]},
                "records": [
                    {
                        "symbol": "NVDA",
                        "state": "probing",
                        "reason": (
                            "route_tca_passed_but_dependency_receipts_block_capital"
                        ),
                    }
                ],
            },
        }
        record_level_probe_context = pipeline._paper_route_probe_context(
            proof_floor=record_level_route_repair_floor,
            decision=decision,
        )
        self.assertIsNotNone(record_level_probe_context)
        assert record_level_probe_context is not None
        self.assertIn(
            "route_tca_passed_but_dependency_receipts_block_capital",
            cast(list[str], record_level_probe_context.get("blocking_reasons")),
        )

        symbol_level_route_repair_floor = {
            **proof_floor,
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
            "route_reacquisition_book": {
                "summary": {
                    "repair_candidate_symbols": ["NVDA"],
                    "repair_candidates": [
                        {
                            "symbol": "NVDA",
                            "state": "missing",
                            "reason": "execution_tca_symbol_missing",
                        }
                    ],
                }
            },
        }
        symbol_level_probe_context = pipeline._paper_route_probe_context(
            proof_floor=symbol_level_route_repair_floor,
            decision=decision,
        )
        self.assertIsNotNone(symbol_level_probe_context)
        assert symbol_level_probe_context is not None
        self.assertEqual(
            symbol_level_probe_context.get("mode"), "paper_route_acquisition"
        )
        self.assertIn(
            "execution_tca_symbol_missing",
            cast(list[str], symbol_level_probe_context.get("blocking_reasons")),
        )

        paper_route_probe_symbol_floor = {
            **proof_floor,
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
            "route_reacquisition_book": {
                "summary": {
                    "repair_candidate_symbols": ["MU"],
                    "paper_route_probe_eligible_symbols": ["NVDA"],
                }
            },
        }
        eligible_symbol_probe_context = pipeline._paper_route_probe_context(
            proof_floor=paper_route_probe_symbol_floor,
            decision=decision,
        )
        self.assertIsNotNone(eligible_symbol_probe_context)
        assert eligible_symbol_probe_context is not None
        self.assertEqual(
            eligible_symbol_probe_context.get("paper_route_probe_symbols"), ["NVDA"]
        )
        self.assertEqual(
            eligible_symbol_probe_context.get("route_repair_symbols"), ["MU"]
        )

        wrong_symbol_floor = {
            **proof_floor,
            "route_reacquisition_book": {
                "summary": {"repair_candidate_symbols": ["MU"]}
            },
        }
        self.assertIsNone(
            pipeline._paper_route_probe_context(
                proof_floor=wrong_symbol_floor,
                decision=decision,
            )
        )
