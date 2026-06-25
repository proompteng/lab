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
    SimpleNamespace,
    Strategy,
    StrategyDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    cast,
    datetime,
    patch,
    select,
    timezone,
)

from app.trading.scheduler.submission_preparation.shared import (
    TradingSubmissionRequest,
)


class TestTradingPipelineBoundedLiveClose(TradingPipelineTestCaseBase):
    @staticmethod
    def _pipeline(session_local: Any) -> SimpleTradingPipeline:
        return SimpleTradingPipeline(
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
            session_factory=session_local,
        )

    def test_live_bounded_close_sell_limit_is_marketable_at_bid(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-a",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 17, 20, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("0.1671"),
            order_type="limit",
            limit_price=Decimal("298.19"),
            params={
                "bounded_live_paper_route_close": True,
                "price_snapshot": {
                    "bid": "298.17",
                    "ask": "298.23",
                },
                "simple_lane": {
                    "bounded_live_paper_route_close": True,
                },
            },
        )

        prepared = SimpleTradingPipeline._marketable_bounded_live_close_decision(
            decision
        )

        self.assertEqual(prepared.order_type, "limit")
        self.assertEqual(prepared.limit_price, Decimal("298.17"))
        audit = cast(
            dict[str, Any],
            prepared.params["bounded_live_paper_route_close_order"],
        )
        self.assertEqual(audit["state"], "marketable_limit_adjusted")
        self.assertEqual(audit["original_limit_price"], "298.19")
        self.assertEqual(audit["marketable_limit_price"], "298.17")
        simple_lane = cast(dict[str, Any], prepared.params["simple_lane"])
        self.assertEqual(
            simple_lane["bounded_live_paper_route_close_order"],
            audit,
        )

    def test_live_bounded_close_buy_limit_is_marketable_at_ask(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-a",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 17, 20, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("0.1671"),
            order_type="limit",
            limit_price=Decimal("298.20"),
            params={
                "paper_route_probe_exit": {
                    "live_bounded_paper_route_close": True,
                },
                "quote_routeability": {
                    "bid": "298.17",
                    "ask": "298.23",
                },
            },
        )

        prepared = SimpleTradingPipeline._marketable_bounded_live_close_decision(
            decision
        )

        self.assertEqual(prepared.order_type, "limit")
        self.assertEqual(prepared.limit_price, Decimal("298.23"))
        audit = cast(
            dict[str, Any],
            prepared.params["bounded_live_paper_route_close_order"],
        )
        self.assertEqual(audit["state"], "marketable_limit_adjusted")
        self.assertEqual(audit["original_limit_price"], "298.20")
        self.assertEqual(audit["marketable_limit_price"], "298.23")

    def test_live_bounded_close_simple_lane_marker_is_marketable(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-a",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 17, 20, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("0.1671"),
            order_type="limit",
            limit_price=Decimal("298.19"),
            params={
                "simple_lane": {
                    "bounded_live_paper_route_close": True,
                },
                "price_snapshot": {
                    "bid": "298.17",
                    "ask": "298.23",
                },
            },
        )

        prepared = SimpleTradingPipeline._marketable_bounded_live_close_decision(
            decision
        )

        self.assertEqual(prepared.limit_price, Decimal("298.17"))

    def test_live_bounded_close_leaves_already_marketable_sell_limit(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-a",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 17, 20, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("0.1671"),
            order_type="limit",
            limit_price=Decimal("298.16"),
            params={
                "bounded_live_paper_route_close": True,
                "price_snapshot": {
                    "bid": "298.17",
                    "ask": "298.23",
                },
            },
        )

        prepared = SimpleTradingPipeline._marketable_bounded_live_close_decision(
            decision
        )

        self.assertEqual(prepared.limit_price, Decimal("298.16"))
        audit = cast(
            dict[str, Any],
            prepared.params["bounded_live_paper_route_close_order"],
        )
        self.assertEqual(audit["state"], "already_marketable")

    def test_live_bounded_close_leaves_already_marketable_buy_limit(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-a",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 17, 20, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("0.1671"),
            order_type="limit",
            limit_price=Decimal("298.24"),
            params={
                "bounded_live_paper_route_close": True,
                "price_snapshot": {
                    "bid": "298.17",
                    "ask": "298.23",
                },
            },
        )

        prepared = SimpleTradingPipeline._marketable_bounded_live_close_decision(
            decision
        )

        self.assertEqual(prepared.limit_price, Decimal("298.24"))
        audit = cast(
            dict[str, Any],
            prepared.params["bounded_live_paper_route_close_order"],
        )
        self.assertEqual(audit["state"], "already_marketable")

    def test_live_bounded_close_without_quote_leaves_decision_unchanged(self) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-a",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 17, 20, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("0.1671"),
            order_type="limit",
            limit_price=Decimal("298.19"),
            params={
                "bounded_live_paper_route_close": True,
            },
        )

        prepared = SimpleTradingPipeline._marketable_bounded_live_close_decision(
            decision
        )

        self.assertIs(prepared, decision)

    def test_live_bounded_close_bid_ask_fallback_sources(self) -> None:
        bid, ask = SimpleTradingPipeline._bounded_live_close_bid_ask(
            {
                "imbalance_bid_px": "298.17",
                "imbalance_ask_px": "298.23",
            }
        )
        self.assertEqual(bid, Decimal("298.17"))
        self.assertEqual(ask, Decimal("298.23"))

        bid, ask = SimpleTradingPipeline._bounded_live_close_bid_ask(
            {
                "bid": "298.11",
                "ask": "298.29",
            }
        )
        self.assertEqual(bid, Decimal("298.11"))
        self.assertEqual(ask, Decimal("298.29"))

    def test_live_bounded_paper_route_close_bypasses_gate_and_tags_exit(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_enabled": config.settings.trading_enabled,
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
        config.settings.trading_enabled = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_allow_live_mode = True
        self._seed_filled_paper_route_probe_entry(
            source_decision_mode="bounded_paper_route_collection",
            profit_proof_eligible=True,
            source_candidate_ids=("candidate-pairs-a",),
            source_hypothesis_ids=("H-PAIRS-01",),
            source_strategy_names=("microbar-cross-sectional-pairs-v1",),
        )
        try:
            pipeline = self._pipeline(self.session_local)
            gate = {
                "allowed": False,
                "blocked_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "runtime_ledger_source_collection_pending",
                ],
                "bounded_live_paper_collection_gate": {
                    "allowed": True,
                    "authority_scope": "bounded_evidence_collection_only",
                },
            }
            proof_floor = {
                "route_state": "repair_only",
                "capital_state": "paper",
                "max_notional": "100",
                "market_window": {"session_open": True},
                "blocking_reasons": ["runtime_ledger_source_collection_pending"],
                "route_reacquisition_book": {
                    "summary": {"paper_route_probe_eligible_symbols": ["AAPL"]}
                },
            }
            with self.session_local() as session:
                strategy = session.execute(select(Strategy)).scalar_one()
                decision = StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=datetime(2026, 3, 26, 16, 0, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="sell",
                    qty=Decimal("2"),
                    rationale="strategy-close-existing-bounded-collection-position",
                    params={
                        "simple_lane": {
                            "quantity_resolution": {
                                "reason": "sell_reducing_long_fractional_allowed",
                                "short_increasing": False,
                            }
                        }
                    },
                )
                decision_row = OrderExecutor().ensure_decision(
                    session,
                    decision,
                    strategy,
                    "paper",
                )

                with (
                    patch.object(
                        SimpleTradingPipeline,
                        "_live_submission_gate",
                        return_value=gate,
                    ),
                    patch.object(
                        SimpleTradingPipeline,
                        "_profitability_proof_floor",
                        return_value=proof_floor,
                    ),
                    patch(
                        "app.trading.scheduler.simple_pipeline.trading_now",
                        return_value=datetime(2026, 3, 26, 16, 0, tzinfo=timezone.utc),
                    ),
                ):
                    self.assertTrue(
                        pipeline._is_trading_submission_allowed(
                            session=session,
                            decision=decision,
                            decision_row=decision_row,
                        )
                    )

                session.refresh(decision_row)
                decision_json = cast(dict[str, Any], decision_row.decision_json)
                params = cast(dict[str, Any], decision_json["params"])
                exit_metadata = cast(
                    dict[str, Any],
                    params["paper_route_probe_exit"],
                )
                simple_lane = cast(dict[str, Any], params["simple_lane"])

            self.assertEqual(exit_metadata["mode"], "paper_route_exit")
            self.assertEqual(
                exit_metadata["source"],
                "filled_bounded_paper_route_collection_executions",
            )
            self.assertEqual(exit_metadata["db_open_qty"], "2.00000000")
            self.assertEqual(exit_metadata["db_open_side"], "long")
            self.assertTrue(exit_metadata["live_bounded_paper_route_close"])
            self.assertEqual(
                exit_metadata["source_candidate_ids"],
                ["candidate-pairs-a"],
            )
            self.assertTrue(simple_lane["bounded_live_paper_route_close"])
            self.assertEqual(
                simple_lane["submit_path"],
                "bounded_paper_route_collection",
            )
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_enabled = original[
                "trading_simple_paper_route_probe_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_allow_live_mode = original[
                "trading_simple_paper_route_probe_allow_live_mode"
            ]

    def test_live_unlinked_close_still_blocks_on_capital_gate(self) -> None:
        from app import config

        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_enabled": config.settings.trading_enabled,
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
        config.settings.trading_enabled = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_allow_live_mode = True
        try:
            pipeline = self._pipeline(self.session_local)
            gate = {
                "allowed": False,
                "reason": "alpha_readiness_not_promotion_eligible",
                "blocked_reasons": ["alpha_readiness_not_promotion_eligible"],
                "bounded_live_paper_collection_gate": {
                    "allowed": True,
                    "authority_scope": "bounded_evidence_collection_only",
                },
            }
            with self.session_local() as session:
                strategy = Strategy(
                    name="unlinked-live-close",
                    description="unlinked close must not bypass live capital gate",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL"],
                )
                session.add(strategy)
                session.commit()
                session.refresh(strategy)
                decision = StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=datetime(2026, 3, 26, 16, 0, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="sell",
                    qty=Decimal("2"),
                    rationale="unlinked-close",
                    params={},
                )
                decision_row = OrderExecutor().ensure_decision(
                    session,
                    decision,
                    strategy,
                    "paper",
                )

                with patch.object(
                    SimpleTradingPipeline,
                    "_live_submission_gate",
                    return_value=gate,
                ):
                    self.assertFalse(
                        pipeline._is_trading_submission_allowed(
                            session=session,
                            decision=decision,
                            decision_row=decision_row,
                        )
                    )

                session.refresh(decision_row)
                decision_json = cast(dict[str, Any], decision_row.decision_json)

            self.assertEqual(
                decision_json["submission_stage"],
                "blocked_live_submission_gate",
            )
            self.assertNotIn("paper_route_probe_exit", decision_json.get("params", {}))
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_enabled = original[
                "trading_simple_paper_route_probe_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_allow_live_mode = original[
                "trading_simple_paper_route_probe_allow_live_mode"
            ]

    def test_live_bounded_paper_route_close_respects_collection_gate(self) -> None:
        from app import config

        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_enabled": config.settings.trading_enabled,
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
        config.settings.trading_enabled = True
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_allow_live_mode = True
        self._seed_filled_paper_route_probe_entry(
            source_decision_mode="bounded_paper_route_collection",
            profit_proof_eligible=True,
        )
        try:
            pipeline = self._pipeline(self.session_local)
            gate = {
                "allowed": False,
                "reason": "alpha_readiness_not_promotion_eligible",
                "blocked_reasons": ["empirical_jobs_not_ready"],
            }
            with self.session_local() as session:
                strategy = session.execute(select(Strategy)).scalar_one()
                decision = StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=datetime(2026, 3, 26, 16, 0, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="sell",
                    qty=Decimal("2"),
                    rationale="close-blocked-when-bounded-gate-denies",
                    params={},
                )
                decision_row = OrderExecutor().ensure_decision(
                    session,
                    decision,
                    strategy,
                    "paper",
                )

                with patch.object(
                    SimpleTradingPipeline,
                    "_live_submission_gate",
                    return_value=gate,
                ):
                    self.assertFalse(
                        pipeline._is_trading_submission_allowed(
                            session=session,
                            decision=decision,
                            decision_row=decision_row,
                        )
                    )

                session.refresh(decision_row)
                decision_json = cast(dict[str, Any], decision_row.decision_json)

            self.assertEqual(
                decision_json["submission_stage"],
                "blocked_live_submission_gate",
            )
            self.assertNotIn("paper_route_probe_exit", decision_json.get("params", {}))
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_enabled = original[
                "trading_simple_paper_route_probe_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_allow_live_mode = original[
                "trading_simple_paper_route_probe_allow_live_mode"
            ]

    def test_bounded_paper_route_close_exposure_lookup_fail_closed(self) -> None:
        pipeline = self._pipeline(self.session_local)
        with self.session_local() as session:
            strategy = Strategy(
                name="lookup-fail-closed",
                description="lookup failures must not authorize closes",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 3, 26, 16, 0, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                rationale="lookup-fail-closed",
                params={},
            )
            decision_row = OrderExecutor().ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            request = TradingSubmissionRequest(
                session=session,
                decision=decision,
                decision_row=decision_row,
            )

            with patch.object(
                pipeline,
                "_paper_route_probe_exit_exposures",
                None,
            ):
                self.assertIsNone(
                    pipeline._bounded_live_paper_route_close_exposure(request)
                )
            with patch.object(
                pipeline,
                "_paper_route_probe_exit_exposures",
                side_effect=RuntimeError("boom"),
            ):
                self.assertIsNone(
                    pipeline._bounded_live_paper_route_close_exposure(request)
                )
            with patch.object(
                pipeline,
                "_paper_route_probe_exit_exposures",
                return_value=[],
            ):
                self.assertIsNone(
                    pipeline._bounded_live_paper_route_close_exposure(request)
                )

    def test_bounded_paper_route_close_matches_only_linked_exposure(self) -> None:
        source = "filled_bounded_paper_route_collection_executions"
        pipeline = self._pipeline(self.session_local)
        with self.session_local() as session:
            strategy = Strategy(
                name="linked-close-match",
                description="close matching fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 3, 26, 16, 0, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                rationale="linked-close-match",
                params={},
            )
            decision_row = OrderExecutor().ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            request = TradingSubmissionRequest(
                session=session,
                decision=decision,
                decision_row=decision_row,
            )
            wrong_strategy = SimpleNamespace(
                strategy=SimpleNamespace(id="wrong"),
                symbol="AAPL",
                exit_source=source,
                exit_action="sell",
                exit_qty=Decimal("2"),
            )
            matching = SimpleNamespace(
                strategy=SimpleNamespace(id=strategy.id),
                symbol="AAPL",
                exit_source=source,
                exit_action="sell",
                exit_qty="2",
            )
            wrong_symbol = SimpleNamespace(
                strategy=SimpleNamespace(id=strategy.id),
                symbol="MSFT",
                exit_source=source,
                exit_action="sell",
                exit_qty=Decimal("2"),
            )
            wrong_source = SimpleNamespace(
                strategy=SimpleNamespace(id=strategy.id),
                symbol="AAPL",
                exit_source="manual_close",
                exit_action="sell",
                exit_qty=Decimal("2"),
            )
            wrong_action = SimpleNamespace(
                strategy=SimpleNamespace(id=strategy.id),
                symbol="AAPL",
                exit_source=source,
                exit_action="buy",
                exit_qty=Decimal("2"),
            )

            self.assertFalse(
                pipeline._bounded_live_paper_route_close_matches_exposure(
                    decision,
                    wrong_symbol,
                )
            )
            self.assertFalse(
                pipeline._bounded_live_paper_route_close_matches_exposure(
                    decision,
                    wrong_source,
                )
            )
            self.assertFalse(
                pipeline._bounded_live_paper_route_close_matches_exposure(
                    decision,
                    wrong_action,
                )
            )
            with patch.object(
                pipeline,
                "_paper_route_probe_exit_exposures",
                return_value={"wrong": wrong_strategy, "match": matching},
            ):
                self.assertIs(
                    pipeline._bounded_live_paper_route_close_exposure(request),
                    matching,
                )
