from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    Mock,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RecordingDecisionEngine,
    RiskEngine,
    SignalEnvelope,
    SimpleTradingPipeline,
    SimulationExecutionAdapter,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    cast,
    datetime,
    patch,
    select,
    timezone,
)


class TestTradingPipelineRouteExecutionA(TradingPipelineTestCaseBase):
    def test_paper_route_target_lineage_rejects_strategy_mismatch(self) -> None:
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
        decision = StrategyDecision(
            strategy_id="microbar-volume-continuation-long-top2-chip-v1@paper",
            symbol="AAPL",
            event_ts=datetime(2026, 5, 29, 17, 27, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("1"),
            params={"price": "310.49"},
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            return_value={
                "targets": [
                    {
                        "paper_route_probe_symbols": ["AAPL", "AMZN"],
                        "paper_route_probe_window_start": "2026-05-29T13:30:00+00:00",
                        "paper_route_probe_window_end": "2026-05-29T20:00:00+00:00",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "hypothesis_id": "H-PAIRS-01",
                        "strategy_name": "microbar-cross-sectional-pairs-v1",
                        "strategy_lookup_names": [
                            "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                            "microbar-cross-sectional-pairs-v1",
                        ],
                        "source_kind": "paper_route_probe_runtime_observed",
                    }
                ]
            },
        ):
            enriched = pipeline._with_paper_route_target_lineage(decision)

        self.assertNotIn("paper_route_target_plan", enriched.params)
        self.assertNotIn("source_candidate_ids", enriched.params)
        self.assertNotIn("source_hypothesis_ids", enriched.params)

    def test_paper_route_target_lineage_skips_empty_symbol_and_empty_lineage(
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
        base = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("1"),
            params={"price": "100"},
        )
        fetch = Mock(
            return_value={"targets": [{"paper_route_probe_symbols": ["AAPL"]}]}
        )

        blank_symbol = pipeline._with_paper_route_target_lineage(
            base.model_copy(update={"symbol": "   "})
        )
        with patch(
            "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
            fetch,
        ):
            empty_lineage = pipeline._with_paper_route_target_lineage(base)

        self.assertNotIn("paper_route_target_plan", blank_symbol.params)
        self.assertNotIn("paper_route_target_plan", empty_lineage.params)
        self.assertEqual(fetch.call_count, 1)

    def test_paper_route_probe_short_increasing_sell_classification(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="route-probe-short-classification",
            params={"price": "100"},
        )

        self.assertFalse(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(decision)
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {"simple_lane": "missing-resolution"},
                    }
                )
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {"simple_lane": {"quantity_resolution": "missing"}},
                    }
                )
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {
                            "simple_lane": {
                                "quantity_resolution": {"short_increasing": "yes"}
                            }
                        },
                    }
                )
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {
                            "simple_lane": {
                                "quantity_resolution": {"short_increasing": "off"}
                            }
                        },
                    }
                )
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {
                            "sizing": {
                                "quantity_resolution": {
                                    "reason": "sell_reducing_long_fractional_allowed"
                                }
                            }
                        },
                    }
                )
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_probe_short_increasing_sell(
                decision.model_copy(
                    update={
                        "action": "sell",
                        "params": {
                            "sizing": {
                                "quantity_resolution": {
                                    "reason": "sell_short_increasing_fractional_allowed"
                                }
                            }
                        },
                    }
                )
            )
        )

    def test_paper_route_probe_cap_rejects_missing_or_tiny_quantity(
        self,
    ) -> None:
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
        missing_price_decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="NVDA",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing-price",
            params={},
        )
        priced_decision = missing_price_decision.model_copy(
            update={"params": {"price": "100"}}
        )

        self.assertFalse(
            pipeline._paper_route_probe_capped_decision(
                decision=missing_price_decision,
                proof_floor={},
                context={"max_notional": "25"},
            )
        )
        self.assertFalse(
            pipeline._paper_route_probe_capped_decision(
                decision=priced_decision,
                proof_floor={},
                context={"max_notional": "0.00001"},
            )
        )

    def test_simple_pipeline_blocks_symbol_excluded_from_route_candidates(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "live"
        config.settings.trading_mode = "live"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-live-route-filter",
                description="simple live lane route candidate filter",
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
            "route_state": "live_micro_candidate",
            "capital_state": "live_allowed",
            "max_notional": "1000",
            "blocking_reasons": [],
            "route_reacquisition_book": {
                "summary": {
                    "scope_symbol_count": 2,
                    "candidate_symbols": ["AAPL"],
                    "repair_candidate_symbols": ["NVDA"],
                }
            },
        }
        with (
            patch.object(
                SimpleTradingPipeline,
                "_live_submission_gate",
                return_value={
                    "allowed": True,
                    "reason": "promotion_certificate_valid",
                    "blocked_reasons": [],
                    "capital_stage": "live",
                    "capital_state": "live",
                },
            ),
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ),
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 0)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            persisted_floor = cast(
                dict[str, Any], decision_json.get("profitability_proof_floor")
            )
            route_book = cast(
                dict[str, Any], persisted_floor.get("route_reacquisition_book")
            )
            route_summary = cast(dict[str, Any], route_book.get("summary"))

            self.assertEqual(decision.status, "blocked")
            self.assertEqual(
                decision_json.get("submission_stage"),
                "blocked_profitability_route_symbol",
            )
            self.assertEqual(
                decision_json.get("submission_block_reason"),
                "profitability_route_symbol_excluded",
            )
            self.assertEqual(route_summary.get("candidate_symbols"), ["AAPL"])

    def test_simple_pipeline_skips_out_of_strategy_universe_signals_before_quote_quality(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_kill_switch_enabled = False

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-universe-filter",
                description="simple lane universe filter regression",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        allowed_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )
        out_of_universe_signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, 1, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 6, tzinfo=timezone.utc),
            symbol="MSFT",
            timeframe="1Min",
            seq=2,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
                "spread": 1,
            },
        )

        alpaca_client = FakeAlpacaClient()
        decision_engine = RecordingDecisionEngine()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([allowed_signal, out_of_universe_signal]),
            decision_engine=decision_engine,
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

        pipeline.run_once()

        self.assertNotIn("MSFT", decision_engine.observed_symbols)

    def test_simple_pipeline_reconcile_updates_execution_status(self) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-reconcile",
                description="simple reconcile lane",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
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

        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value={
                "route_state": "paper_ready",
                "capital_state": "paper",
                "max_notional": "1000",
                "blocking_reasons": [],
            },
        ):
            pipeline.run_once()
        updates = pipeline.reconcile()

        self.assertEqual(updates, 1)
        with self.session_local() as session:
            execution = session.execute(select(Execution)).scalar_one()
            self.assertEqual(execution.status, "filled")

    def test_simple_pipeline_uses_client_order_id_for_idempotency(self) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-idempotency",
                description="simple idempotency",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="AAPL",
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

        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value={
                "route_state": "paper_ready",
                "capital_state": "paper",
                "max_notional": "1000",
                "blocking_reasons": [],
            },
        ):
            pipeline.run_once()
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        with self.session_local() as session:
            self.assertEqual(session.query(Execution).count(), 1)

    def test_simple_pipeline_blocks_shorts_when_asset_is_not_shortable(self) -> None:
        from app import config

        class _ShortBlockedClient(FakeAlpacaClient):
            def get_account(self) -> dict[str, str | bool]:
                account = super().get_account()
                account["shorting_enabled"] = True
                return account

            def get_asset(self, symbol_or_asset_id: str) -> dict[str, str | bool]:
                return {
                    "symbol": symbol_or_asset_id,
                    "tradable": True,
                    "shortable": False,
                }

        config.settings.trading_allow_shorts = True
        pipeline = SimpleTradingPipeline(
            alpaca_client=_ShortBlockedClient(),
            order_firewall=OrderFirewall(_ShortBlockedClient()),
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
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="shortability-check",
            params={"price": "100"},
        )

        reason = pipeline._simple_shortability_reason(decision=decision, positions=[])

        self.assertEqual(reason, "shorting_not_allowed_for_asset")

    def test_simple_pipeline_projects_remaining_buying_power_after_buy(self) -> None:
        account = {"buying_power": "150", "equity": "1000", "cash": "150"}
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="buying-power-projection",
            params={"price": "100", "simple_lane": {"notional": "100"}},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            account,
            [],
            decision,
        )

        self.assertEqual(Decimal(account["buying_power"]), Decimal("50"))

    def test_simple_pipeline_projects_short_increase_buying_power_for_excess_qty(
        self,
    ) -> None:
        account = {"buying_power": "150", "equity": "1000", "cash": "150"}
        positions = [{"symbol": "AAPL", "qty": "1", "side": "long"}]
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("3"),
            rationale="short-increase-projection",
            params={"price": "50", "simple_lane": {"notional": "150"}},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            account,
            positions,
            decision,
        )

        self.assertEqual(Decimal(account["buying_power"]), Decimal("50"))

    def test_simple_pipeline_skips_buying_power_projection_without_inputs(
        self,
    ) -> None:
        missing_buying_power = {"equity": "1000", "cash": "150"}
        buy_decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing-buying-power",
            params={"price": "100"},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            missing_buying_power,
            [],
            buy_decision,
        )

        self.assertNotIn("buying_power", missing_buying_power)

        missing_notional = {"buying_power": "150", "equity": "1000", "cash": "150"}
        no_price_decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing-notional",
            params={},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            missing_notional,
            [],
            no_price_decision,
        )

        self.assertEqual(Decimal(missing_notional["buying_power"]), Decimal("150"))

    def test_simple_pipeline_projects_notional_from_price_when_lane_missing(
        self,
    ) -> None:
        account = {"buying_power": "150", "equity": "1000", "cash": "150"}
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="price-notional-fallback",
            params={"price": "100"},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            account,
            [],
            decision,
        )

        self.assertEqual(Decimal(account["buying_power"]), Decimal("50"))

    def test_simple_pipeline_skips_projection_when_exposure_does_not_increase(
        self,
    ) -> None:
        reducing_sell_account = {
            "buying_power": "150",
            "equity": "1000",
            "cash": "150",
        }
        reducing_sell = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="reducing-sell",
            params={"price": "100", "simple_lane": {"notional": "100"}},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            reducing_sell_account,
            [{"symbol": "AAPL", "qty": "2", "side": "long"}],
            reducing_sell,
        )

        self.assertEqual(
            Decimal(reducing_sell_account["buying_power"]),
            Decimal("150"),
        )

        zero_qty_sell_account = {
            "buying_power": "150",
            "equity": "1000",
            "cash": "150",
        }
        zero_qty_sell = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("0"),
            rationale="zero-qty-sell",
            params={"price": "100", "simple_lane": {"notional": "100"}},
        )

        SimpleTradingPipeline._apply_simple_projected_buying_power(
            zero_qty_sell_account,
            [],
            zero_qty_sell,
        )

        self.assertEqual(
            Decimal(zero_qty_sell_account["buying_power"]),
            Decimal("150"),
        )

    def test_execution_routing_uses_order_firewall_for_non_simulation_adapter(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
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

        self.assertIs(
            pipeline._execution_client_for_symbol("MSFT"),
            pipeline.order_firewall,
        )
        self.assertIs(
            pipeline._execution_client_for_symbol("AAPL"),
            pipeline.order_firewall,
        )

    def test_execution_routing_uses_simulation_adapter_when_active(self) -> None:
        alpaca_client = FakeAlpacaClient()
        execution_adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="sim-route",
            dataset_id="dataset-route",
        )
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=execution_adapter,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )

        self.assertIs(
            pipeline._execution_client_for_symbol("MSFT"),
            execution_adapter,
        )
