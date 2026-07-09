from __future__ import annotations

from tests.order_idempotency.support import (
    AccountMetadataUnavailableClient,
    AccountMetadataUnavailableClientWithLongPosition,
    AccountShortingUnknownClient,
    AssetMetadataUnavailableClient,
    AssetShortabilityUnknownClient,
    Decimal,
    FakeAlpacaClient,
    PartiallyHeldInventoryClient,
    HeldInventoryClient,
    LeanExecutionAdapter,
    OrderExecutor,
    PositionLookupNoneClient,
    PositionLookupUnavailableClient,
    PositionLookupUnavailableHeldInventoryClient,
    Reconciler,
    Strategy,
    StrategyDecision,
    SymbolNotEasyToBorrowClient,
    SymbolNotShortableClient,
    TradeDecision,
    _TestOrderIdempotencyBase,
    _format_order_submit_rejection,
    datetime,
    json,
    select,
    settings,
    timezone,
)


class TestSubmitOrderPrecheckBlocksShortWhenLeanFallbackSymbolNotShortable(
    _TestOrderIdempotencyBase
):
    def test_submit_order_precheck_blocks_short_when_lean_fallback_symbol_not_shortable(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        settings.trading_mode = "live"
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )
            execution_client = LeanExecutionAdapter(
                base_url="http://lean.invalid",
                timeout_seconds=1,
                fallback=SymbolNotShortableClient(),
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    execution_client,
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "local_symbol_not_shortable")

    def test_submit_order_precheck_blocks_short_when_symbol_not_easy_to_borrow(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    SymbolNotEasyToBorrowClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "local_symbol_not_easy_to_borrow")

    def test_submit_order_precheck_blocks_short_when_account_metadata_unavailable_live(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        settings.trading_mode = "live"
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    AccountMetadataUnavailableClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "shorting_metadata_unavailable")

    def test_submit_order_precheck_blocks_short_when_account_shorting_status_unknown_live(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        settings.trading_mode = "live"
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    AccountShortingUnknownClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "shorting_metadata_unavailable")

    def test_submit_order_precheck_blocks_short_when_asset_metadata_unavailable_live(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        settings.trading_mode = "live"
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    AssetMetadataUnavailableClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "shorting_metadata_unavailable")

    def test_submit_order_precheck_blocks_short_when_asset_shortability_unknown_live(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        settings.trading_mode = "live"
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    AssetShortabilityUnknownClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "shorting_metadata_unavailable")

    def test_submit_order_precheck_allows_position_reducing_sell_without_shorting_metadata(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        settings.trading_mode = "live"
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            execution = executor.submit_order(
                session,
                AccountMetadataUnavailableClientWithLongPosition(),
                decision,
                decision_row,
                "paper",
            )

            self.assertIsNotNone(execution)
            self.assertEqual(execution.status, "accepted")

    def test_submit_order_precheck_allows_short_when_asset_metadata_unavailable_paper(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        settings.trading_mode = "paper"
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            execution = executor.submit_order(
                session,
                AssetMetadataUnavailableClient(),
                decision,
                decision_row,
                "paper",
            )

            self.assertIsNotNone(execution)

    def test_submit_order_precheck_rejects_fractional_sell_when_position_lookup_unavailable(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = True
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("0.5"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaisesRegex(RuntimeError, "local_qty_below_min"):
                executor.submit_order(
                    session,
                    PositionLookupUnavailableClient(),
                    decision,
                    decision_row,
                    "paper",
                )

    def test_submit_order_precheck_rejects_fractional_sell_when_position_lookup_returns_none(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = True
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("0.5"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaisesRegex(RuntimeError, "local_qty_below_min"):
                executor.submit_order(
                    session,
                    PositionLookupNoneClient(),
                    decision,
                    decision_row,
                    "paper",
                )

    def test_submit_order_precheck_blocks_sell_when_inventory_held_by_open_orders(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    HeldInventoryClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "broker_precheck")
            self.assertEqual(payload.get("code"), "precheck_sell_qty_exceeds_available")

    def test_submit_order_precheck_blocks_sell_when_inventory_held_and_position_lookup_unavailable(
        self,
    ) -> None:
        settings.trading_allow_shorts = True
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    PositionLookupUnavailableHeldInventoryClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "broker_precheck")
            self.assertEqual(payload.get("code"), "precheck_sell_qty_exceeds_available")
            self.assertEqual(payload.get("position_qty"), None)

    def test_submit_order_precheck_clips_sell_to_available_inventory(self) -> None:
        settings.trading_allow_shorts = True
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
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
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("2"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            client = PartiallyHeldInventoryClient()
            execution = executor.submit_order(
                session,
                client,
                decision,
                decision_row,
                "paper",
            )

            assert execution is not None
            self.assertEqual(client.submitted[0]["qty"], "1.0")
            session.refresh(decision_row)
            payload = decision_row.decision_json
            assert isinstance(payload, dict)
            self.assertEqual(payload.get("qty"), "1")
            adjustment = payload.get("broker_precheck_adjustment")
            assert isinstance(adjustment, dict)
            self.assertEqual(adjustment.get("requested_qty"), "2")
            self.assertEqual(adjustment.get("adjusted_qty"), "1")

    def test_local_pre_submit_rejection_formats_with_distinct_reason_prefix(
        self,
    ) -> None:
        error = RuntimeError(
            json.dumps(
                {
                    "source": "local_pre_submit",
                    "code": "local_qty_below_min",
                    "reject_reason": "qty below minimum increment 1",
                }
            )
        )
        formatted = _format_order_submit_rejection(error)
        self.assertIn("local_pre_submit_rejected", formatted)
        self.assertIn("code=local_qty_below_min", formatted)

    def test_reconciler_backfills_missing_execution_by_client_order_id(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision_hash_value = "decision-hash-1"
            decision_row = TradeDecision(
                strategy_id=str(strategy.id),
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL"},
                rationale=None,
                status="planned",
                decision_hash=decision_hash_value,
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            alpaca_client = FakeAlpacaClient()
            alpaca_client.submitted.append(
                {
                    "id": "order-1",
                    "client_order_id": decision_hash_value,
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                }
            )

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, alpaca_client)

            self.assertEqual(updates, 1)
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(executions), 1)
            self.assertEqual(executions[0].client_order_id, decision_hash_value)

            refreshed_decision = session.get(TradeDecision, decision_row.id)
            assert refreshed_decision is not None
            self.assertEqual(refreshed_decision.status, "accepted")

    def test_reconciler_backfill_normalizes_fallback_route_for_new_execution(
        self,
    ) -> None:
        class FallbackAwareAlpacaClient(FakeAlpacaClient):
            last_route = "alpaca_fallback"

            def get_order_by_client_order_id(
                self, client_order_id: str
            ) -> dict[str, str] | None:
                return {
                    "id": "order-2",
                    "client_order_id": client_order_id,
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "_execution_route_expected": "lean",
                    "_execution_route_actual": "alpaca_fallback",
                }

        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL"},
                rationale=None,
                status="planned",
                decision_hash="decision-hash-2",
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, FallbackAwareAlpacaClient())

            self.assertEqual(updates, 1)
            execution = session.execute(
                select(Execution).where(Execution.trade_decision_id == decision_row.id)
            ).scalar_one()
            assert execution is not None
            self.assertEqual(execution.execution_expected_adapter, "lean")
            self.assertEqual(execution.execution_actual_adapter, "alpaca")

    def test_reconciler_backfill_sets_expected_from_actual(self) -> None:
        class AdapterOnlyAlpacaClient(FakeAlpacaClient):
            last_route = "alpaca"

            def get_order_by_client_order_id(
                self, client_order_id: str
            ) -> dict[str, str] | None:
                return {
                    "id": "order-3",
                    "client_order_id": client_order_id,
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                    "_execution_adapter": "lean",
                }

        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL"},
                rationale=None,
                status="planned",
                decision_hash="decision-hash-3",
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            reconciler = Reconciler()
            updates = reconciler.reconcile(session, AdapterOnlyAlpacaClient())

            self.assertEqual(updates, 1)
            execution = session.execute(
                select(Execution).where(Execution.trade_decision_id == decision_row.id)
            ).scalar_one()
            assert execution is not None
            self.assertEqual(execution.execution_expected_adapter, "lean")
            self.assertEqual(execution.execution_actual_adapter, "lean")
