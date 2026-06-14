from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    Execution,
    Mock,
    SimpleNamespace,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    _apply_projected_position_decision,
    _project_open_orders_onto_positions,
    datetime,
    patch,
    timedelta,
    timezone,
)


class TestTradingPipelinePositionProjectionA(TradingPipelineTestCaseBase):
    def test_apply_projected_position_decision_updates_market_value(self) -> None:
        positions = [
            {"symbol": "AAPL", "qty": "5", "side": "long", "market_value": "500"}
        ]
        decision = StrategyDecision(
            strategy_id="demo",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("2"),
            params={"price": "100"},
        )

        _apply_projected_position_decision(positions, decision)

        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0]["qty"], "7")
        self.assertEqual(positions[0]["side"], "long")
        self.assertEqual(positions[0]["market_value"], "700")

    def test_project_open_orders_onto_positions_projects_buy_exposure(self) -> None:
        positions: list[dict[str, Any]] = []

        projected = _project_open_orders_onto_positions(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "side": "buy",
                    "qty": "3",
                    "filled_qty": "1",
                    "limit_price": "100",
                    "type": "limit",
                    "time_in_force": "day",
                    "client_order_id": "client-aapl-buy",
                }
            ],
        )

        self.assertEqual(projected, 1)
        self.assertEqual(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "qty": "2",
                    "side": "long",
                    "market_value": "200",
                    "open_order_projection": True,
                    "open_order_projection_only": True,
                    "open_order_client_order_id": "client-aapl-buy",
                    "open_order_client_order_ids": ["client-aapl-buy"],
                    "open_order_projection_count": 1,
                }
            ],
        )

    def test_project_open_orders_onto_positions_projects_sell_against_existing_long(
        self,
    ) -> None:
        positions: list[dict[str, Any]] = [
            {"symbol": "AAPL", "qty": "5", "side": "long", "market_value": "500"}
        ]

        projected = _project_open_orders_onto_positions(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "side": "sell",
                    "qty": "4",
                    "filled_qty": "1",
                    "limit_price": "100",
                    "type": "limit",
                    "time_in_force": "day",
                }
            ],
        )

        self.assertEqual(projected, 1)
        self.assertEqual(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "qty": "2",
                    "side": "long",
                    "market_value": "200",
                    "open_order_projection": True,
                    "open_order_projection_only": False,
                    "open_order_projection_count": 1,
                }
            ],
        )

    def test_project_open_orders_onto_positions_preserves_projection_client_ids(
        self,
    ) -> None:
        positions: list[dict[str, Any]] = [
            {"symbol": "MSFT", "qty": "1", "side": "long"},
            {
                "symbol": "AAPL",
                "qty": "1",
                "side": "long",
                "market_value": "100",
                "open_order_projection": True,
                "open_order_projection_only": True,
                "open_order_client_order_id": "legacy-client",
                "open_order_client_order_ids": ["existing-client"],
                "open_order_projection_count": 1,
            },
        ]

        projected = _project_open_orders_onto_positions(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "side": "buy",
                    "qty": "1",
                    "filled_qty": "0",
                    "limit_price": "100",
                    "type": "limit",
                    "time_in_force": "day",
                    "client_order_id": "new-client",
                }
            ],
        )

        self.assertEqual(projected, 1)
        self.assertEqual(
            positions,
            [
                {"symbol": "MSFT", "qty": "1", "side": "long"},
                {
                    "symbol": "AAPL",
                    "qty": "2",
                    "side": "long",
                    "market_value": "200",
                    "open_order_client_order_id": "new-client",
                    "open_order_client_order_ids": [
                        "existing-client",
                        "legacy-client",
                        "new-client",
                    ],
                    "open_order_projection": True,
                    "open_order_projection_only": True,
                    "open_order_projection_count": 2,
                },
            ],
        )

    def test_resolve_execution_context_positions_projects_open_orders(self) -> None:
        pipeline = TradingPipeline.__new__(TradingPipeline)
        pipeline.account_label = "paper"

        class AdapterWithOpenOrders:
            name = "test"

            def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                if status == "open":
                    return [
                        {
                            "symbol": "AAPL",
                            "side": "buy",
                            "qty": "3",
                            "filled_qty": "1",
                            "limit_price": "100",
                            "type": "limit",
                            "time_in_force": "day",
                        }
                    ]
                return []

        pipeline.execution_adapter = AdapterWithOpenOrders()

        positions = pipeline._resolve_execution_context_positions([])

        self.assertEqual(
            positions,
            [
                {
                    "symbol": "AAPL",
                    "qty": "2",
                    "side": "long",
                    "market_value": "200",
                    "open_order_projection": True,
                    "open_order_projection_only": True,
                    "open_order_projection_count": 1,
                }
            ],
        )

    def test_resolve_execution_context_positions_tags_matching_strategy_fill(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="runtime isolated paper proof",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={"action": "buy"},
                rationale="paper-route-entry",
                status="submitted",
                created_at=session_open + timedelta(minutes=60),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="paper",
                    alpaca_order_id="paper-aapl-1",
                    client_order_id="paper-aapl-1-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("2"),
                    filled_qty=Decimal("2"),
                    avg_fill_price=Decimal("101"),
                    status="filled",
                    raw_order={},
                    created_at=session_open + timedelta(minutes=61),
                    updated_at=session_open + timedelta(minutes=61),
                )
            )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [
                        {
                            "symbol": "AAPL",
                            "qty": "2",
                            "side": "long",
                            "avg_entry_price": "101",
                        }
                    ],
                    session=session,
                )

        self.assertEqual(positions[0]["strategy_id"], str(strategy.id))
        self.assertEqual(
            positions[0]["strategy_position_source"],
            "current_session_filled_executions",
        )
        self.assertEqual(
            positions[0]["strategy_position_session_open"],
            session_open.isoformat(),
        )

    def test_resolve_execution_context_positions_tags_prior_open_strategy_exposure(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        prior_session_open = session_open - timedelta(days=1)
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="runtime isolated paper proof",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={"action": "buy"},
                rationale="paper-route-entry",
                status="filled",
                created_at=prior_session_open + timedelta(minutes=60),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="paper",
                    alpaca_order_id="paper-aapl-prior-open",
                    client_order_id="paper-aapl-prior-open-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("2"),
                    filled_qty=Decimal("2"),
                    avg_fill_price=Decimal("101"),
                    status="filled",
                    raw_order={},
                    created_at=prior_session_open + timedelta(minutes=61),
                    updated_at=prior_session_open + timedelta(minutes=61),
                )
            )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [
                        {
                            "symbol": "AAPL",
                            "qty": "2",
                            "side": "long",
                            "avg_entry_price": "101",
                        }
                    ],
                    session=session,
                )

        self.assertEqual(positions[0]["strategy_id"], str(strategy.id))
        self.assertEqual(
            positions[0]["strategy_position_source"],
            "open_exposure_filled_executions",
        )
        self.assertTrue(positions[0]["strategy_position_stale_session_repair"])
        self.assertEqual(
            positions[0]["strategy_position_session_open"],
            session_open.isoformat(),
        )

    def test_resolve_execution_context_positions_does_not_tag_closed_prior_exposure(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        prior_session_open = session_open - timedelta(days=1)
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="runtime isolated paper proof",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            for index, (side, created_offset) in enumerate(
                [("buy", 60), ("sell", 120)],
                start=1,
            ):
                decision = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    timeframe="1Sec",
                    decision_json={"action": side},
                    rationale="paper-route-entry" if side == "buy" else "time-exit",
                    status="filled",
                    created_at=prior_session_open + timedelta(minutes=created_offset),
                )
                session.add(decision)
                session.commit()
                session.refresh(decision)
                session.add(
                    Execution(
                        trade_decision_id=decision.id,
                        alpaca_account_label="paper",
                        alpaca_order_id=f"paper-aapl-prior-closed-{index}",
                        client_order_id=f"paper-aapl-prior-closed-{index}-client",
                        symbol="AAPL",
                        side=side,
                        order_type="market",
                        time_in_force="day",
                        submitted_qty=Decimal("2"),
                        filled_qty=Decimal("2"),
                        avg_fill_price=Decimal("101"),
                        status="filled",
                        raw_order={},
                        created_at=prior_session_open
                        + timedelta(minutes=created_offset + 1),
                        updated_at=prior_session_open
                        + timedelta(minutes=created_offset + 1),
                    )
                )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [{"symbol": "AAPL", "qty": "2", "side": "long"}],
                    session=session,
                )

        self.assertNotIn("strategy_id", positions[0])

    def test_resolve_execution_context_positions_does_not_tag_mismatched_fill(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="runtime isolated paper proof",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json={"action": "buy"},
                rationale="paper-route-entry",
                status="submitted",
                created_at=session_open + timedelta(minutes=60),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="paper",
                    alpaca_order_id="paper-aapl-2",
                    client_order_id="paper-aapl-2-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("2"),
                    filled_qty=Decimal("2"),
                    avg_fill_price=Decimal("101"),
                    status="filled",
                    raw_order={},
                    created_at=session_open + timedelta(minutes=61),
                    updated_at=session_open + timedelta(minutes=61),
                )
            )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [{"symbol": "AAPL", "qty": "3", "side": "long"}],
                    session=session,
                )

        self.assertNotIn("strategy_id", positions[0])

    def test_resolve_execution_context_positions_splits_multi_strategy_symbol_position(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        with self.session_local() as session:
            strategies = [
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="runtime isolated paper proof",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["AAPL"],
                ),
                Strategy(
                    name="microbar-volume-continuation-long-top2-chip-v1",
                    description="runtime isolated paper proof",
                    enabled=True,
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["AAPL"],
                ),
            ]
            session.add_all(strategies)
            session.commit()
            for strategy in strategies:
                session.refresh(strategy)

            for index, (strategy, qty, price) in enumerate(
                [
                    (strategies[0], Decimal("1.25"), Decimal("100")),
                    (strategies[1], Decimal("2.75"), Decimal("104")),
                ],
                start=1,
            ):
                decision = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    timeframe="1Sec",
                    decision_json={"action": "buy"},
                    rationale="paper-route-entry",
                    status="filled",
                    created_at=session_open + timedelta(minutes=60 + index),
                )
                session.add(decision)
                session.commit()
                session.refresh(decision)
                session.add(
                    Execution(
                        trade_decision_id=decision.id,
                        alpaca_account_label="paper",
                        alpaca_order_id=f"paper-aapl-{index}",
                        client_order_id=f"paper-aapl-{index}-client",
                        symbol="AAPL",
                        side="buy",
                        order_type="market",
                        time_in_force="day",
                        submitted_qty=qty,
                        filled_qty=qty,
                        avg_fill_price=price,
                        status="filled",
                        raw_order={},
                        created_at=session_open + timedelta(minutes=61 + index),
                        updated_at=session_open + timedelta(minutes=61 + index),
                    )
                )
            session.commit()

            pipeline = TradingPipeline.__new__(TradingPipeline)
            pipeline.account_label = "paper"

            class AdapterWithoutOpenOrders:
                name = "test"

                def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                    return []

            pipeline.execution_adapter = AdapterWithoutOpenOrders()

            with patch(
                "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                return_value=session_open + timedelta(minutes=150),
            ):
                positions = pipeline._resolve_execution_context_positions(
                    [{"symbol": "AAPL", "qty": "4.00", "side": "long"}],
                    session=session,
                )

        self.assertEqual(len(positions), 2)
        self.assertEqual(
            {position["strategy_id"] for position in positions},
            {str(strategy.id) for strategy in strategies},
        )
        self.assertEqual(
            {Decimal(str(position["qty"])) for position in positions},
            {Decimal("1.25"), Decimal("2.75")},
        )
        self.assertTrue(
            all(
                position["strategy_position_split_from_aggregate"]
                for position in positions
            )
        )

    def test_attach_current_session_strategy_position_tags_fails_closed_on_query_error(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        pipeline = TradingPipeline.__new__(TradingPipeline)
        pipeline.account_label = "paper"
        session = Mock()
        session.execute.side_effect = RuntimeError("db unavailable")
        positions = [{"symbol": "AAPL", "qty": "1", "side": "long"}]

        with patch(
            "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
            return_value=session_open + timedelta(minutes=150),
        ):
            tagged = pipeline._attach_current_session_strategy_position_tags(
                session,
                positions,
            )

        self.assertIs(tagged, positions)
        self.assertNotIn("strategy_id", tagged[0])

    def test_attach_current_session_strategy_position_tags_ignores_invalid_fill_rows(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        pipeline = TradingPipeline.__new__(TradingPipeline)
        pipeline.account_label = "paper"
        session = Mock()
        session.execute.return_value.all.return_value = [
            (
                SimpleNamespace(
                    symbol="",
                    filled_qty=Decimal("1"),
                    side="buy",
                    avg_fill_price=Decimal("101"),
                    created_at=session_open + timedelta(minutes=1),
                ),
                SimpleNamespace(symbol="", strategy_id="strategy-empty-symbol"),
            ),
            (
                SimpleNamespace(
                    symbol="AAPL",
                    filled_qty=None,
                    side="buy",
                    avg_fill_price=Decimal("101"),
                    created_at=session_open + timedelta(minutes=2),
                ),
                SimpleNamespace(symbol="AAPL", strategy_id="strategy-no-fill"),
            ),
            (
                SimpleNamespace(
                    symbol="AAPL",
                    filled_qty=Decimal("1"),
                    side="hold",
                    avg_fill_price=Decimal("101"),
                    created_at=session_open + timedelta(minutes=3),
                ),
                SimpleNamespace(symbol="AAPL", strategy_id="strategy-bad-side"),
            ),
        ]
        positions = [{"symbol": "AAPL", "qty": "1", "side": "long"}]

        with patch(
            "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
            return_value=session_open + timedelta(minutes=150),
        ):
            tagged = pipeline._attach_current_session_strategy_position_tags(
                session,
                positions,
            )

        self.assertIs(tagged, positions)
        self.assertNotIn("strategy_id", tagged[0])
