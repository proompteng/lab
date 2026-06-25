from __future__ import annotations

from app.trading.scheduler.submission_preparation.shared import (
    SubmissionPreparationRequest,
)
from tests.pipeline.trading_pipeline_base import (
    Any,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
    MarketSnapshot,
    OrderExecutor,
    OrderFirewall,
    QuoteQualityStatus,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    Reconciler,
    RiskEngine,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TimelinePriceFetcher,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    cast,
    datetime,
    patch,
    timedelta,
    timezone,
    uuid4,
)


class TestTradingPipelinePaperRouteQuoteA(TradingPipelineTestCaseBase):
    def test_simple_pipeline_blocks_unscoped_order_during_bounded_target_window(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"

        strategy_id = uuid4()
        strategy = Strategy(
            id=strategy_id,
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        target: dict[str, Any] = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": strategy.name,
            "runtime_strategy_name": strategy.name,
            "strategy_lookup_names": [str(strategy_id), strategy.name],
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_SIM",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_target_account_audit_state": (
                self._paper_route_target_account_audit_state(["AAPL"])
            ),
            "paper_route_target_account_audit_blockers": [],
            "paper_route_probe_next_session_max_notional": "250",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "evidence_collection_ok": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "source_decision_readiness": {"ready": True, "blockers": []},
        }
        proof_floor = {
            "route_state": "collecting",
            "capital_state": "paper",
            "max_notional": "250",
            "market_window": {"session_open": True},
            "blocking_reasons": [],
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
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )

        unscoped_decision = StrategyDecision(
            strategy_id=str(strategy_id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="unscoped target-window order",
            params={"price": "100"},
        )
        scoped_metadata = (
            SimpleTradingPipeline._paper_route_target_source_decision_metadata(
                target=target,
                strategy=strategy,
                symbol="AAPL",
                window_start=window_start,
                window_end=window_end,
                max_notional=Decimal("250"),
            )
        )
        scoped_decision = unscoped_decision.model_copy(
            update={
                "params": {
                    "price": "100",
                    "paper_route_target_plan_source_decision": scoped_metadata,
                }
            }
        )

        with self.session_local() as session:
            unscoped_row = TradeDecision(
                strategy_id=strategy_id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=unscoped_decision.model_dump(mode="json"),
                status="planned",
            )
            scoped_row = TradeDecision(
                strategy_id=strategy_id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=scoped_decision.model_dump(mode="json"),
                status="planned",
            )
            session.add_all([unscoped_row, scoped_row])
            session.commit()

            with (
                patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
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
            ):
                self.assertFalse(
                    pipeline._is_trading_submission_allowed(
                        session=session,
                        decision=unscoped_decision,
                        decision_row=unscoped_row,
                    )
                )
                self.assertTrue(
                    pipeline._is_trading_submission_allowed(
                        session=session,
                        decision=scoped_decision,
                        decision_row=scoped_row,
                    )
                )

            session.refresh(unscoped_row)
            session.refresh(scoped_row)
            unscoped_json = cast(dict[str, Any], unscoped_row.decision_json)
            scoped_json = cast(dict[str, Any], scoped_row.decision_json)

        self.assertEqual(unscoped_row.status, "blocked")
        self.assertEqual(
            unscoped_json.get("submission_stage"),
            "blocked_paper_route_target_window_unscoped",
        )
        self.assertEqual(
            unscoped_json.get("submission_block_reason"),
            "paper_route_target_window_requires_scoped_source_decision",
        )
        target_window = cast(
            dict[str, Any], unscoped_json.get("paper_route_target_window")
        )
        self.assertEqual(target_window.get("symbol"), "AAPL")
        self.assertEqual(target_window.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(scoped_row.status, "planned")
        self.assertNotIn("submission_block_reason", scoped_json)

    def test_paper_route_target_quote_routeability_blocks_missing_quote(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-target-source",
            params={
                "paper_route_target_plan": {"candidate_id": "c88421d619759b2cfaa6f4d0"},
                "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            },
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
            price_fetcher=FakePriceFetcher(Decimal("190.12")),
        )
        with self.session_local() as session:
            session.add(strategy)
            session.commit()
            row = pipeline.executor.ensure_decision(
                session,
                decision,
                strategy,
                "TORGHUT_SIM",
            )

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "100000",
                        "cash": "100000",
                        "buying_power": "100000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], row_json.get("params"))
            routeability = cast(dict[str, Any], params.get("quote_routeability"))

        self.assertIsNone(prepared)
        self.assertEqual(row.status, "rejected")
        self.assertEqual(routeability.get("status"), "blocked")
        self.assertEqual(routeability.get("reason"), "missing_executable_quote")
        self.assertEqual(
            row_json.get("reject_reason_atomic"), ["missing_executable_quote"]
        )

    def test_paper_route_target_quote_diagnostics_surface_wide_latest_quote(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-target-source",
            params={
                "paper_route_target_plan": {"candidate_id": "c88421d619759b2cfaa6f4d0"},
                "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            },
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
            price_fetcher=FakePriceFetcher(
                Decimal("190.12"),
                quote_lookup_diagnostics={
                    "schema_version": "torghut.quote-lookup-diagnostics.v1",
                    "source": "ta_signals_quote",
                    "latest_quote_present": True,
                    "latest_quote_accepted": False,
                    "latest_quote_rejected_reason": "spread_bps_exceeded",
                    "latest_quote_spread_bps": "105.2631578947368421052631579",
                },
            ),
        )
        with self.session_local() as session:
            session.add(strategy)
            session.commit()
            row = pipeline.executor.ensure_decision(
                session,
                decision,
                strategy,
                "TORGHUT_SIM",
            )

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "100000",
                        "cash": "100000",
                        "buying_power": "100000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], row_json.get("params"))
            routeability = cast(dict[str, Any], params.get("quote_routeability"))

        self.assertIsNone(prepared)
        self.assertEqual(row.status, "rejected")
        self.assertEqual(routeability.get("status"), "blocked")
        self.assertEqual(routeability.get("reason"), "spread_bps_exceeded")
        self.assertEqual(row_json.get("reject_reason_atomic"), ["spread_bps_exceeded"])
        diagnostics = cast(dict[str, Any], routeability.get("quote_lookup_diagnostics"))
        self.assertEqual(
            diagnostics.get("latest_quote_rejected_reason"),
            "spread_bps_exceeded",
        )

    def test_paper_route_quote_lookup_diagnostics_keep_unknown_reason_blocked(
        self,
    ) -> None:
        status = QuoteQualityStatus(
            valid=False,
            reason="missing_executable_quote",
        )

        rewritten = SimpleTradingPipeline._apply_quote_lookup_diagnostic_reason(
            status,
            quote_lookup_diagnostics={
                "latest_quote_rejected_reason": "missing_bid",
                "latest_quote_spread_bps": "42",
            },
        )

        self.assertIs(rewritten, status)
        self.assertEqual(rewritten.reason, "missing_executable_quote")

    def test_paper_route_target_quote_routeability_blocks_stale_and_wide_quotes(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        base_decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-target-source",
            params={
                "paper_route_target_plan": {"candidate_id": "c88421d619759b2cfaa6f4d0"},
                "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            },
        )
        cases = [
            (
                "wide",
                FakePriceFetcher(
                    Decimal("101"),
                    spread=Decimal("2"),
                    bid=Decimal("100"),
                    ask=Decimal("102"),
                ),
                "spread_bps_exceeded",
            ),
            (
                "stale",
                TimelinePriceFetcher(
                    {
                        now: MarketSnapshot(
                            symbol="AAPL",
                            as_of=now - timedelta(seconds=120),
                            price=Decimal("190.12"),
                            spread=Decimal("0.04"),
                            source="ta_microbars+ta_signals_quote",
                            bid=Decimal("190.10"),
                            ask=Decimal("190.14"),
                            quote_as_of=now - timedelta(seconds=120),
                            quote_source="ta_signals_quote",
                        )
                    }
                ),
                "stale_quote",
            ),
        ]

        with self.session_local() as session:
            session.add(strategy)
            session.commit()
            for label, price_fetcher, expected_reason in cases:
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
                    price_fetcher=price_fetcher,
                )
                decision = base_decision.model_copy(
                    update={"rationale": f"paper-route-target-source-{label}"}
                )
                row = pipeline.executor.ensure_decision(
                    session,
                    decision,
                    strategy,
                    "TORGHUT_SIM",
                )

                prepared = pipeline._prepare_decision_for_submission(
                    SubmissionPreparationRequest(
                        session=session,
                        decision=decision,
                        decision_row=row,
                        strategy=strategy,
                        account={
                            "equity": "100000",
                            "cash": "100000",
                            "buying_power": "100000",
                        },
                        positions=[],
                    )
                )
                session.refresh(row)
                row_json = cast(dict[str, Any], row.decision_json)
                params = cast(dict[str, Any], row_json.get("params"))
                routeability = cast(dict[str, Any], params.get("quote_routeability"))

                self.assertIsNone(prepared)
                self.assertEqual(row.status, "rejected")
                self.assertEqual(routeability.get("reason"), expected_reason)

    def test_paper_route_target_executable_quote_reaches_submit_eligibility(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-target-source",
            params={
                "paper_route_target_plan": {"candidate_id": "c88421d619759b2cfaa6f4d0"},
                "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            },
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
            price_fetcher=FakePriceFetcher(
                Decimal("190.12"),
                spread=Decimal("0.04"),
                bid=Decimal("190.10"),
                ask=Decimal("190.14"),
            ),
        )
        with self.session_local() as session:
            session.add(strategy)
            session.commit()
            row = pipeline.executor.ensure_decision(
                session,
                decision,
                strategy,
                "TORGHUT_SIM",
            )

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "100000",
                        "cash": "100000",
                        "buying_power": "100000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], row_json.get("params"))
            routeability = cast(dict[str, Any], params.get("quote_routeability"))

        self.assertIsNotNone(prepared)
        assert prepared is not None
        prepared_decision, snapshot = prepared
        self.assertIsNotNone(snapshot)
        self.assertEqual(prepared_decision.params.get("price"), Decimal("190.12"))
        self.assertEqual(routeability.get("status"), "accepted")
        self.assertEqual(routeability.get("reason"), "executable_quote_ready")
        self.assertEqual(params.get("price_snapshot", {}).get("bid"), "190.10")
        self.assertEqual(row.status, "planned")

    def test_bounded_collection_target_source_enforces_target_notional_broker_sizing(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 4, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_allow_shorts = True
        config.settings.trading_simple_max_notional_per_order = 100000.0
        config.settings.trading_simple_max_notional_per_symbol = 100000.0
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("100000"),
        )
        target_metadata = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "strategy_family": "microbar_cross_sectional_pairs",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_symbol_actions": {
                "AAPL": "buy",
                "AMZN": "sell",
            },
            "paper_route_probe_symbol_quantities": {
                "AAPL": "1",
                "AMZN": "1",
            },
            "paper_route_probe_next_session_max_notional": "75000",
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "evidence_collection_ok": True,
            "source_decision_readiness": {"ready": True, "blockers": []},
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
        }
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AMZN",
            event_ts=now,
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="bounded paper-route target source",
            params={
                "paper_route_target_plan": target_metadata,
                "source_decision_mode": (
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                ),
                "profit_proof_eligible": True,
            },
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
            price_fetcher=FakePriceFetcher(
                Decimal("250"),
                spread=Decimal("0.02"),
                bid=Decimal("250"),
                ask=Decimal("250.02"),
            ),
        )

        with self.session_local() as session:
            session.add(strategy)
            session.commit()
            row = pipeline.executor.ensure_decision(
                session,
                decision,
                strategy,
                "TORGHUT_SIM",
            )

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "200000",
                        "cash": "200000",
                        "buying_power": "200000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], row_json["params"])
            sizing = cast(dict[str, Any], params["paper_route_target_notional_sizing"])
            simple_lane = cast(dict[str, Any], params["simple_lane"])
            source_metadata = cast(dict[str, Any], params["paper_route_target_plan"])

        self.assertIsNotNone(prepared)
        assert prepared is not None
        prepared_decision, _snapshot = prepared
        self.assertEqual(prepared_decision.action, "sell")
        self.assertEqual(prepared_decision.qty, Decimal("150"))
        self.assertEqual(sizing["sizing_source"], "target_notional")
        self.assertEqual(sizing["symbol_notional_budget"], "37500.0")
        self.assertEqual(sizing["broker_resolved_qty"], "150")
        self.assertEqual(sizing["resolved_qty"], "150")
        self.assertEqual(
            sizing["broker_quantity_resolution"]["reason"],
            "sell_short_increasing_integer_only",
        )
        self.assertFalse(sizing["broker_quantity_resolution"]["fractional_allowed"])
        self.assertEqual(simple_lane["final_qty"], "150")
        self.assertTrue(simple_lane["target_source_notional_sized"])
        self.assertEqual(
            source_metadata["paper_route_target_notional_sizing"]["resolved_qty"],
            "150",
        )
        self.assertEqual(row.status, "planned")
