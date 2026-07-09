from __future__ import annotations

from app.trading.models import ExecutionRequest

from tests.order_idempotency.support import (
    Decimal,
    Execution,
    FakeAlpacaClient,
    OrderExecutor,
    PositionLookupNoneClient,
    Strategy,
    StrategyDecision,
    _TestOrderIdempotencyBase,
    datetime,
    settings,
    timezone,
)


class TestDurableInventoryFallback(_TestOrderIdempotencyBase):
    def test_quantity_resolution_uses_durable_inventory_when_broker_readback_is_stale_positive(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = False
        executor = OrderExecutor()
        request = ExecutionRequest(
            decision_id="decision-1",
            symbol="AAPL",
            side="sell",
            qty=Decimal("0.5"),
            order_type="market",
            time_in_force="day",
        )

        class StalePositivePositionClient(FakeAlpacaClient):
            def list_positions(self) -> list[dict[str, str]]:
                return [{"symbol": "AAPL", "qty": "0.25", "side": "long"}]

        resolution = executor._quantity_resolution_for_request(
            execution_client=StalePositivePositionClient(),
            request=request,
            durable_position_qty=Decimal("0.5"),
        )

        self.assertTrue(resolution.fractional_allowed)
        self.assertFalse(resolution.short_increasing)
        self.assertEqual(resolution.position_qty, Decimal("0.5"))
        self.assertEqual(resolution.reason, "sell_reducing_long_fractional_allowed")

    def test_quantity_resolution_uses_durable_inventory_when_broker_readback_unavailable(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = False
        executor = OrderExecutor()
        request = ExecutionRequest(
            decision_id="decision-1",
            symbol="AAPL",
            side="sell",
            qty=Decimal("0.5"),
            order_type="market",
            time_in_force="day",
        )
        resolution = executor._quantity_resolution_for_request(
            execution_client=PositionLookupNoneClient(),
            request=request,
            durable_position_qty=Decimal("0.5"),
        )

        self.assertTrue(resolution.fractional_allowed)
        self.assertFalse(resolution.short_increasing)
        self.assertEqual(resolution.position_qty, Decimal("0.5"))
        self.assertEqual(resolution.reason, "sell_reducing_long_fractional_allowed")

    def test_submit_order_uses_durable_inventory_context_for_stale_broker_readback(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = False
        with self.session_local() as session:
            session.add(
                Execution(
                    alpaca_account_label="paper",
                    alpaca_order_id="existing-broker-buy",
                    client_order_id="existing-broker-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("0.5"),
                    filled_qty=Decimal("0.5"),
                    status="filled",
                    execution_expected_adapter="alpaca",
                    execution_actual_adapter="alpaca",
                    raw_order={},
                )
            )
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

            class StalePositivePositionClient(FakeAlpacaClient):
                def list_positions(self) -> list[dict[str, str]]:
                    return [{"symbol": "AAPL", "qty": "0.25", "side": "long"}]

            client = StalePositivePositionClient()
            execution = executor.submit_order(
                session,
                client,
                decision,
                decision_row,
                "paper",
            )

            assert execution is not None
            self.assertEqual(client.submitted[0]["qty"], "0.5")

    def test_quantity_resolution_keeps_broker_inventory_when_it_covers_request(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = False
        executor = OrderExecutor()
        request = ExecutionRequest(
            decision_id="decision-1",
            symbol="AAPL",
            side="sell",
            qty=Decimal("0.25"),
            order_type="market",
            time_in_force="day",
        )

        class CoveringPositionClient(FakeAlpacaClient):
            def list_positions(self) -> list[dict[str, str]]:
                return [{"symbol": "AAPL", "qty": "0.25", "side": "long"}]

        resolution = executor._quantity_resolution_for_request(
            execution_client=CoveringPositionClient(),
            request=request,
            durable_position_qty=Decimal("0.5"),
        )

        self.assertEqual(resolution.position_qty, Decimal("0.25"))
        self.assertEqual(resolution.reason, "sell_reducing_long_fractional_allowed")

    def test_quantity_resolution_preserves_explicit_flat_broker_readback(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = False
        executor = OrderExecutor()
        request = ExecutionRequest(
            decision_id="decision-1",
            symbol="AAPL",
            side="sell",
            qty=Decimal("0.5"),
            order_type="market",
            time_in_force="day",
        )
        resolution = executor._quantity_resolution_for_request(
            execution_client=FakeAlpacaClient(),
            request=request,
            durable_position_qty=Decimal("0.5"),
        )

        self.assertFalse(resolution.fractional_allowed)
        self.assertTrue(resolution.short_increasing)
        self.assertEqual(resolution.position_qty, Decimal("0"))
        self.assertEqual(resolution.reason, "sell_short_disallowed_integer_only")

    def test_quantity_resolution_preserves_explicit_short_broker_readback(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
        settings.trading_allow_shorts = False
        executor = OrderExecutor()
        request = ExecutionRequest(
            decision_id="decision-1",
            symbol="AAPL",
            side="sell",
            qty=Decimal("0.5"),
            order_type="market",
            time_in_force="day",
        )

        class ShortPositionClient(FakeAlpacaClient):
            def list_positions(self) -> list[dict[str, str]]:
                return [{"symbol": "AAPL", "qty": "0.25", "side": "short"}]

        resolution = executor._quantity_resolution_for_request(
            execution_client=ShortPositionClient(),
            request=request,
            durable_position_qty=Decimal("0.5"),
        )

        self.assertFalse(resolution.fractional_allowed)
        self.assertTrue(resolution.short_increasing)
        self.assertEqual(resolution.position_qty, Decimal("-0.25"))
        self.assertEqual(resolution.reason, "sell_short_disallowed_integer_only")

    def test_durable_inventory_returns_none_for_blank_symbol(self) -> None:
        with self.session_local() as session:
            self.assertIsNone(
                OrderExecutor._durable_position_qty_for_symbol(
                    session=session,
                    symbol=" ",
                    account_label="paper",
                )
            )

    def test_durable_inventory_excludes_non_broker_routes(self) -> None:
        with self.session_local() as session:
            rows = [
                Execution(
                    alpaca_account_label="paper",
                    alpaca_order_id="sim-order",
                    client_order_id="sim-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    status="filled",
                    execution_expected_adapter="simulation",
                    execution_actual_adapter="simulation",
                    raw_order={},
                ),
                Execution(
                    alpaca_account_label="paper",
                    alpaca_order_id="testnet-order",
                    client_order_id="testnet-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    status="filled",
                    execution_expected_adapter="testnet",
                    execution_actual_adapter="testnet",
                    raw_order={},
                ),
                Execution(
                    alpaca_account_label="paper",
                    alpaca_order_id="broker-buy-order",
                    client_order_id="broker-buy-client",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    status="filled",
                    execution_expected_adapter="alpaca",
                    execution_actual_adapter="alpaca",
                    raw_order={},
                ),
                Execution(
                    alpaca_account_label="paper",
                    alpaca_order_id="broker-sell-order",
                    client_order_id="broker-sell-client",
                    symbol="AAPL",
                    side="sell",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("0.75"),
                    filled_qty=Decimal("0.75"),
                    status="filled",
                    execution_expected_adapter="alpaca",
                    execution_actual_adapter="alpaca",
                    raw_order={},
                ),
            ]
            session.add_all(rows)
            session.commit()

            self.assertEqual(
                OrderExecutor._durable_position_qty_for_symbol(
                    session=session,
                    symbol="AAPL",
                    account_label="paper",
                ),
                Decimal("0.25"),
            )


