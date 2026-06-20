from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
    Mock,
    OrderExecutor,
    OrderFirewall,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    Reconciler,
    RiskEngine,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    Session,
    SignalEnvelope,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _parse_target_datetime,
    _target_price_snapshots,
    _target_probe_action,
    _target_probe_window,
    cast,
    datetime,
    patch,
    select,
    timedelta,
    timezone,
    uuid4,
)


class TestTradingPipelineTargetPlanSourceA(TradingPipelineTestCaseBase):
    def test_simple_pipeline_signal_cycle_still_generates_target_plan_source_decision(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 100.0
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="paper-route-candidate-v1",
                description="paper route candidate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        target = {
            "candidate_id": "cand-paper-route",
            "hypothesis_id": "H-PAPER-ROUTE",
            "observed_stage": "paper",
            "strategy_family": "microbar_pairs",
            "strategy_name": "paper-route-candidate-v1",
            "runtime_strategy_name": "paper-route-runtime-name",
            "strategy_lookup_names": [
                "paper-route-runtime-name",
                "paper-route-candidate-v1",
            ],
            "account_label": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-paper-route.json",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "25",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "exit_minute_after_open": "120",
            "paper_probation_authorized": True,
            "promotion_allowed": False,
            "final_promotion_authorized": False,
        }
        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
        }
        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor(
                [
                    SignalEnvelope(
                        event_ts=now,
                        symbol="AAPL",
                        payload={
                            "price": Decimal("100"),
                            "imbalance_bid_px": Decimal("99.99"),
                            "imbalance_ask_px": Decimal("100.01"),
                            "spread": Decimal("0.02"),
                        },
                        timeframe="1Min",
                    )
                ]
            ),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("100"),
                spread=Decimal("0.02"),
                bid=Decimal("99.99"),
                ask=Decimal("100.01"),
            ),
        )
        pipeline._is_market_session_open = lambda _now=None: True

        with (
            patch.object(
                pipeline,
                "_evaluate_signal_decisions",
                return_value=[],
            ) as evaluate_signals,
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
            patch(
                "app.trading.scheduler.pipeline.run_cycle.trading_now",
                return_value=now,
            ),
            patch(
                "app.trading.scheduler.pipeline.decision_lifecycle.trading_now",
                return_value=now,
            ),
            patch("app.trading.simulation.trading_now", return_value=now),
        ):
            pipeline.run_once()

        evaluate_signals.assert_called_once()
        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "buy")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "0.2499")
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            source_decision = cast(
                dict[str, Any],
                params.get("paper_route_target_plan_source_decision"),
            )
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))

            self.assertEqual(decision.status, "submitted")
            self.assertEqual(source_decision["candidate_id"], "cand-paper-route")
            self.assertEqual(
                source_decision["source_decision_mode"], "route_acquisition_probe"
            )
            self.assertFalse(source_decision["profit_proof_eligible"])
            self.assertEqual(source_decision["exit_minute_after_open"], 120)
            self.assertEqual(params["source_hypothesis_ids"], ["H-PAPER-ROUTE"])
            self.assertEqual(params["source_decision_mode"], "route_acquisition_probe")
            self.assertFalse(params["profit_proof_eligible"])
            self.assertTrue(paper_route_probe["target_source_authorized"])
            self.assertEqual(
                paper_route_probe["source_decision_mode"], "route_acquisition_probe"
            )
            self.assertFalse(paper_route_probe["profit_proof_eligible"])
            self.assertEqual(paper_route_probe["exit_minute_after_open"], 120)

    def test_simple_pipeline_target_plan_source_decision_requires_open_window(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 12, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="paper-route-candidate-v1",
                description="paper route candidate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        target = {
            "candidate_id": "cand-paper-route",
            "hypothesis_id": "H-PAPER-ROUTE",
            "strategy_name": "paper-route-candidate-v1",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "25",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "price_snapshots": _target_price_snapshots("AAPL"),
        }
        alpaca_client = FakeAlpacaClient()
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
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        pipeline._is_market_session_open = lambda _now=None: True

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
        ):
            pipeline.run_once()

        self.assertEqual(alpaca_client.submitted, [])
        with self.session_local() as session:
            self.assertEqual(list(session.execute(select(TradeDecision)).scalars()), [])

    def test_paper_route_target_source_decision_helpers_cover_rejection_edges(
        self,
    ) -> None:
        aware = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)

        self.assertEqual(_parse_target_datetime(aware), aware)
        self.assertEqual(
            _parse_target_datetime("2026-05-26T14:00:00"),
            aware,
        )
        self.assertIsNone(_parse_target_datetime(None))
        self.assertIsNone(_parse_target_datetime("not-a-date"))
        self.assertIsNone(
            _target_probe_window(
                {
                    "paper_route_probe_window_start": aware.isoformat(),
                    "paper_route_probe_window_end": aware.isoformat(),
                }
            )
        )
        self.assertEqual(
            _target_probe_action({"paper_route_probe_action": "long"}), "buy"
        )
        self.assertEqual(
            _target_probe_action({"paper_route_probe_side": "short"}), "sell"
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
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_strategy({}, [strategy])
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_strategy(
                {"strategy_name": "missing-strategy"},
                [strategy],
            )
        )
        self.assertIs(
            SimpleTradingPipeline._paper_route_target_strategy(
                {"strategy_name": "paper-route-candidate-v1"},
                [strategy],
            ),
            strategy,
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_target_strategy_symbols(
                Strategy(
                    name="string-universe",
                    description="string universe",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=cast(Any, "AAPL, MSFT"),
                )
            ),
            {"AAPL", "MSFT"},
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_target_strategy_symbols(
                Strategy(
                    name="invalid-universe",
                    description="invalid universe",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=cast(Any, object()),
                )
            ),
            set(),
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_position(
                [{"symbol": "AAPL", "qty": "10"}],
                " ",
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_position(
                [{"symbol": "AAPL", "qty": "0", "market_value": "25.50"}],
                "AAPL",
            )
        )

    def test_paper_route_target_source_decisions_guard_paths_and_dedupes(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = False
        config.settings.trading_fractional_equities_enabled = True

        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        target = {
            "strategy_name": "paper-route-candidate-v1",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "25",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "price_snapshots": _target_price_snapshots("AAPL"),
        }
        alpaca_client = FakeAlpacaClient()
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
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=now,
        ):
            config.settings.trading_mode = "live"
            self.assertEqual(
                pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                ),
                [],
            )

            config.settings.trading_mode = "paper"
            config.settings.trading_simple_paper_route_probe_enabled = False
            self.assertEqual(
                pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                ),
                [],
            )

            config.settings.trading_simple_paper_route_probe_enabled = True
            pipeline._is_market_session_open = lambda _now=None: False
            self.assertEqual(
                pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                ),
                [],
            )

            pipeline._is_market_session_open = lambda _now=None: True
            for skipped_target in (
                {
                    **target,
                    "paper_route_probe_window_start": window_start.isoformat(),
                    "paper_route_probe_window_end": window_start.isoformat(),
                },
                {**target, "paper_route_probe_next_session_max_notional": "0"},
                {**target, "strategy_name": "missing-strategy"},
                {**target, "paper_route_probe_action": "sell"},
            ):
                with patch.object(
                    SimpleTradingPipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL"}, None, [skipped_target]),
                ):
                    self.assertEqual(
                        pipeline._paper_route_target_source_decisions(
                            strategies=[strategy],
                            allowed_symbols={"AAPL"},
                        ),
                        [],
                    )

            with patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL"}, None, [target, dict(target)]),
            ):
                decisions = pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].symbol, "AAPL")
        self.assertEqual(decisions[0].action, "buy")

    def test_paper_route_target_source_decisions_skip_symbols_with_open_exposure(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_fractional_equities_enabled = True

        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("1000"),
        )
        target = {
            "strategy_name": "paper-route-candidate-v1",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_next_session_max_notional": "25",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "price_snapshots": _target_price_snapshots("AAPL", "AMZN"),
        }
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
        pipeline._is_market_session_open = lambda _now=None: True

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL", "AMZN"}, None, [target]),
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
        ):
            decisions = pipeline._paper_route_target_source_decisions(
                strategies=[strategy],
                allowed_symbols={"AAPL", "AMZN"},
                positions=[{"symbol": "AMZN", "qty": "41", "side": "short"}],
            )

        self.assertEqual([decision.symbol for decision in decisions], ["AAPL"])

    def test_paper_route_target_source_decisions_skip_db_strategy_exposure(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True

        with self.session_local() as session:
            strategy = Strategy(
                name="paper-route-candidate-v1",
                description="paper route candidate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            for symbol, source_decision_mode, profit_proof_eligible in (
                ("AAPL", STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE, True),
                ("AMZN", ROUTE_ACQUISITION_SOURCE_DECISION_MODE, False),
            ):
                decision_hash = f"source-mode-{symbol.lower()}-{uuid4()}"
                decision_row = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol=symbol,
                    timeframe="1Min",
                    decision_json=StrategyDecision(
                        strategy_id=str(strategy.id),
                        symbol=symbol,
                        event_ts=window_start + timedelta(minutes=5),
                        timeframe="1Min",
                        action="buy",
                        qty=Decimal("10"),
                        rationale="source-mode-fixture",
                        params={
                            "source_decision_mode": source_decision_mode,
                            "profit_proof_eligible": profit_proof_eligible,
                        },
                    ).model_dump(mode="json"),
                    rationale="source-mode-fixture",
                    status="submitted",
                    decision_hash=decision_hash,
                    created_at=window_start + timedelta(minutes=5),
                )
                session.add(decision_row)
                session.commit()
                session.refresh(decision_row)
                session.add(
                    Execution(
                        trade_decision_id=decision_row.id,
                        alpaca_account_label="paper",
                        alpaca_order_id=f"{symbol.lower()}-{uuid4()}",
                        client_order_id=decision_hash,
                        symbol=symbol,
                        side="buy",
                        order_type="market",
                        time_in_force="day",
                        submitted_qty=Decimal("10"),
                        filled_qty=Decimal("10"),
                        avg_fill_price=Decimal("100"),
                        status="filled",
                        created_at=window_start + timedelta(minutes=6),
                    )
                )
            session.commit()

            target = {
                "strategy_name": "paper-route-candidate-v1",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_next_session_max_notional": "25",
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
            }
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
            pipeline._is_market_session_open = lambda _now=None: True

            with (
                patch.object(
                    SimpleTradingPipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL", "AMZN"}, None, [target]),
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
            ):
                decisions = pipeline._paper_route_target_source_decisions(
                    session=session,
                    strategies=[strategy],
                    allowed_symbols={"AAPL", "AMZN"},
                    positions=[],
                )

        self.assertEqual(decisions, [])

    def test_paper_route_target_strategy_exposure_helper_fails_closed(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        mock_session = Mock(spec=Session)
        mock_session.execute.side_effect = RuntimeError("database offline")

        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="AAPL",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_strategy_exposure_helper_returns_false_without_key(
        self,
    ) -> None:
        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        mock_session = Mock(spec=Session)

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="AAPL",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol=" ",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )
        mock_session.execute.assert_not_called()

    def test_paper_route_target_strategy_exposure_helper_ignores_noise(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        result = Mock()
        result.all.return_value = [("buy", Decimal("0")), ("sell", None)]
        mock_session = Mock(spec=Session)
        mock_session.execute.return_value = result

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="aapl",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_strategy_exposure_helper_detects_buy_exposure(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        result = Mock()
        result.all.return_value = [("buy", Decimal("3"))]
        mock_session = Mock(spec=Session)
        mock_session.execute.return_value = result

        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_strategy_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="aapl",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_profit_proof_exposure_helper_fails_closed(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        mock_session = Mock(spec=Session)
        mock_session.execute.side_effect = RuntimeError("database offline")

        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="AAPL",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_profit_proof_exposure_helper_ignores_noise(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        result = Mock()
        result.all.return_value = [
            ("buy", Decimal("1"), ["not-a-decision-mapping"]),
            ("buy", Decimal("1"), {"params": "not-a-param-mapping"}),
            (
                "buy",
                Decimal("1"),
                {
                    "params": {
                        "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE
                    }
                },
            ),
            ("buy", None, {"params": {"profit_proof_eligible": True}}),
            (
                "sell",
                Decimal("2"),
                {
                    "params": {
                        "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                    }
                },
            ),
        ]
        mock_session = Mock(spec=Session)
        mock_session.execute.return_value = result

        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="aapl",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_profit_proof_exposure_accepts_flat_snapshot(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        fill_result = Mock()
        fill_result.all.return_value = [
            (
                "buy",
                Decimal("3"),
                {"params": {"profit_proof_eligible": True}},
                datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc),
            )
        ]
        snapshot_result = Mock()
        snapshot_result.first.return_value = (
            [{"symbol": "AAPL", "qty": "0", "market_value": "0"}],
            datetime(2026, 5, 26, 14, 5, tzinfo=timezone.utc),
        )
        mock_session = Mock(spec=Session)
        mock_session.execute.side_effect = [fill_result, snapshot_result]

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="aapl",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_target_profit_proof_exposure_helper_returns_false_without_key(
        self,
    ) -> None:
        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        mock_session = Mock(spec=Session)

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol="AAPL",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_open_profit_proof_exposure(
                session=cast(Session, mock_session),
                strategy=strategy,
                symbol=" ",
                account_label="paper",
                window_start=datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc),
            )
        )
