from __future__ import annotations

from tests.order_idempotency.support import (
    AccountShortingDisabledClient,
    ConflictingOrderClient,
    Decimal,
    Execution,
    ExecutionTCAMetric,
    FakeAlpacaClient,
    FilledAlpacaClient,
    OrderExecutor,
    PositionLookupNoneClient,
    SimulationExecutionAdapter,
    Strategy,
    StrategyDecision,
    SymbolNotShortableClient,
    _TestOrderIdempotencyBase,
    datetime,
    json,
    select,
    settings,
    timezone,
)


def _add_lagging_broker_fill(session: object, suffix: str) -> None:
    session.add(
        Execution(
            alpaca_account_label="paper",
            alpaca_order_id=f"lagging-setup-buy-{suffix}",
            client_order_id=f"lagging-setup-client-{suffix}",
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


class TestSimulationSubmitOrderWithoutPriceKeepsLegacyFallback(
    _TestOrderIdempotencyBase
):
    def test_simulation_submit_order_without_price_keeps_legacy_fallback(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo-simulation-no-price",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["NVDA"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="NVDA",
                event_ts=datetime(2026, 5, 5, 17, 25, 6, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
                params={},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )
            adapter = SimulationExecutionAdapter(
                bootstrap_servers=None,
                security_protocol=None,
                sasl_mechanism=None,
                sasl_username=None,
                sasl_password=None,
                topic="torghut.sim.trade-updates.v1",
                account_label="paper",
                simulation_run_id="sim-2026-05-05-chip",
                dataset_id="dataset-chip",
            )

            execution = executor.submit_order(
                session,
                adapter,
                decision,
                decision_row,
                "paper",
            )
            assert execution is not None

            self.assertEqual(execution.avg_fill_price, Decimal("1"))
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            simulation_context = raw_order.get("simulation_context")
            assert isinstance(simulation_context, dict)
            self.assertNotIn("simulated_fill_price", simulation_context)
            self.assertNotIn("arrival_price", simulation_context)

    def test_submit_order_persists_advice_provenance_and_simulator_expectations(
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
                action="buy",
                qty=Decimal("2.0"),
                params={
                    "price": Decimal("100"),
                    "execution_advisor": {
                        "applied": True,
                        "adverse_selection_risk": "0.3",
                        "fallback_reason": None,
                    },
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "expected_shortfall_bps_p50": "12.5",
                        "expected_shortfall_bps_p95": "30.0",
                        "simulator_version": "hawkes-lob-v1",
                    },
                },
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            execution = executor.submit_order(
                session, FilledAlpacaClient(), decision, decision_row, "paper"
            )
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            self.assertIn("_execution_advice_provenance", raw_order)

            tca = session.execute(
                select(ExecutionTCAMetric).where(
                    ExecutionTCAMetric.execution_id == execution.id
                )
            ).scalar_one()
            self.assertEqual(tca.expected_shortfall_bps_p50, Decimal("12.5"))
            self.assertEqual(tca.expected_shortfall_bps_p95, Decimal("30.0"))
            self.assertEqual(tca.realized_shortfall_bps, Decimal("100"))
            self.assertEqual(tca.divergence_bps, Decimal("87.5"))
            self.assertEqual(tca.simulator_version, "hawkes-lob-v1")

    def test_submit_order_prefers_persisted_advice_provenance(self) -> None:
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

            persisted_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1.0"),
                params={"price": Decimal("100")},
            )
            transient_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1.0"),
                params={
                    "price": Decimal("100"),
                    "execution_advisor": {
                        "applied": False,
                        "fallback_reason": "advisor_missing_inputs",
                    },
                },
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, persisted_decision, strategy, "paper"
            )
            executor.update_decision_params(
                session,
                decision_row,
                {
                    "execution_advisor": {
                        "applied": True,
                        "fallback_reason": None,
                        "max_participation_rate": "0.03",
                    }
                },
            )

            execution = executor.submit_order(
                session,
                FakeAlpacaClient(),
                transient_decision,
                decision_row,
                "paper",
            )
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            provenance = raw_order.get("_execution_advice_provenance")
            assert isinstance(provenance, dict)
            self.assertEqual(provenance.get("applied"), True)
            self.assertEqual(provenance.get("max_participation_rate"), "0.03")

    def test_submit_order_uses_execution_advisor_expectations_when_raw_advice_absent(
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
                action="buy",
                qty=Decimal("2.0"),
                params={
                    "price": Decimal("100"),
                    "execution_advisor": {
                        "applied": False,
                        "fallback_reason": "advisor_live_apply_disabled",
                        "expected_shortfall_bps_p50": "11.0",
                        "expected_shortfall_bps_p95": "23.0",
                        "simulator_version": "hawkes-lob-v2",
                    },
                },
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            execution = executor.submit_order(
                session, FilledAlpacaClient(), decision, decision_row, "paper"
            )
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            self.assertIn("_execution_advice_provenance", raw_order)

            tca = session.execute(
                select(ExecutionTCAMetric).where(
                    ExecutionTCAMetric.execution_id == execution.id
                )
            ).scalar_one()
            self.assertEqual(tca.expected_shortfall_bps_p50, Decimal("11.0"))
            self.assertEqual(tca.expected_shortfall_bps_p95, Decimal("23.0"))
            self.assertEqual(tca.simulator_version, "hawkes-lob-v2")
            self.assertEqual(tca.divergence_bps, Decimal("89.0"))

    def test_submit_order_prefers_persisted_execution_policy_context(self) -> None:
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
                action="buy",
                qty=Decimal("1.0"),
                params={
                    "price": Decimal("100"),
                    "execution_policy": {
                        "selected_order_type": "market",
                        "adaptive": {"applied": True, "reason": "transient_policy"},
                    },
                },
            )

            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )
            executor.update_decision_params(
                session,
                decision_row,
                {
                    "execution_policy": {
                        "selected_order_type": "limit",
                        "adaptive": {"applied": False, "reason": "persisted_policy"},
                    },
                    "execution_advisor": {
                        "applied": False,
                        "fallback_reason": "advisor_disabled",
                    },
                    "execution_microstructure": {
                        "applied": False,
                        "state_valid": True,
                    },
                },
            )

            execution = executor.submit_order(
                session, FakeAlpacaClient(), decision, decision_row, "paper"
            )
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)

            execution_policy = raw_order.get("execution_policy")
            assert isinstance(execution_policy, dict)
            self.assertEqual(execution_policy.get("selected_order_type"), "limit")
            adaptive = execution_policy.get("adaptive")
            assert isinstance(adaptive, dict)
            self.assertEqual(adaptive.get("reason"), "persisted_policy")
            execution_advisor = execution_policy.get("execution_advisor")
            assert isinstance(execution_advisor, dict)
            self.assertEqual(execution_advisor.get("applied"), False)
            self.assertEqual(
                execution_advisor.get("fallback_reason"), "advisor_disabled"
            )
            execution_microstructure = execution_policy.get("execution_microstructure")
            assert isinstance(execution_microstructure, dict)
            self.assertEqual(execution_microstructure.get("state_valid"), True)

    def test_submit_order_persists_runtime_ledger_metadata_in_audit(self) -> None:
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
                action="buy",
                qty=Decimal("1.0"),
                params={
                    "price": Decimal("100"),
                    "execution_policy": {
                        "selected_order_type": "limit",
                        "adaptive": {
                            "applied": True,
                            "max_participation_rate": "0.05",
                        },
                    },
                    "cost_model": {
                        "source": "broker_reported",
                        "commission_bps": "0",
                    },
                    "candidate_lineage": {
                        "candidate_id": "H-PAIRS-LIVE-PAPER",
                        "runtime_window_id": "2026-02-10-paper",
                    },
                    "runtime_ledger_cost": {
                        "cost_amount": "0",
                        "cost_basis": "broker_reported_commission",
                    },
                },
            )

            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )
            execution = executor.submit_order(
                session, FakeAlpacaClient(), decision, decision_row, "paper"
            )
            assert execution is not None
            audit = execution.execution_audit_json
            assert isinstance(audit, dict)

            execution_policy = audit.get("execution_policy")
            assert isinstance(execution_policy, dict)
            self.assertEqual(execution_policy.get("selected_order_type"), "limit")
            self.assertTrue(audit.get("execution_policy_hash"))
            self.assertTrue(audit.get("cost_model_hash"))
            self.assertTrue(audit.get("lineage_hash"))
            self.assertEqual(audit.get("cost_amount"), "0")
            self.assertEqual(audit.get("cost_basis"), "broker_reported_commission")
            runtime_cost = audit.get("runtime_ledger_cost")
            assert isinstance(runtime_cost, dict)
            self.assertEqual(runtime_cost.get("cost_amount"), "0")
            self.assertEqual(
                runtime_cost.get("cost_basis"), "broker_reported_commission"
            )

    def test_submit_order_falls_back_to_transient_execution_policy_context(
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

            persisted_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1.0"),
                params={"price": Decimal("100")},
            )
            transient_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1.0"),
                params={
                    "price": Decimal("100"),
                    "execution_policy": {
                        "selected_order_type": "market",
                        "adaptive": {"applied": True, "reason": "transient_policy"},
                    },
                    "execution_advisor": {
                        "applied": True,
                        "fallback_reason": None,
                    },
                    "execution_microstructure": {
                        "applied": True,
                        "state_valid": True,
                        "fallback_reason": None,
                    },
                },
            )

            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, persisted_decision, strategy, "paper"
            )
            execution = executor.submit_order(
                session,
                FakeAlpacaClient(),
                transient_decision,
                decision_row,
                "paper",
            )
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)

            execution_policy = raw_order.get("execution_policy")
            assert isinstance(execution_policy, dict)
            self.assertEqual(execution_policy.get("selected_order_type"), "market")
            adaptive = execution_policy.get("adaptive")
            assert isinstance(adaptive, dict)
            self.assertEqual(adaptive.get("reason"), "transient_policy")
            execution_advisor = execution_policy.get("execution_advisor")
            assert isinstance(execution_advisor, dict)
            self.assertEqual(execution_advisor.get("applied"), True)
            execution_microstructure = execution_policy.get("execution_microstructure")
            assert isinstance(execution_microstructure, dict)
            self.assertEqual(execution_microstructure.get("state_valid"), True)

    def test_submit_order_records_execution_policy_context_from_persisted_metadata(
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
                action="buy",
                qty=Decimal("1.0"),
                params={
                    "price": Decimal("100"),
                    "execution_advisor": {
                        "applied": True,
                        "fallback_reason": None,
                        "max_participation_rate": "0.03",
                    },
                    "execution_microstructure": {
                        "applied": False,
                        "state_valid": True,
                        "fallback_reason": None,
                    },
                },
            )

            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )
            execution = executor.submit_order(
                session, FakeAlpacaClient(), decision, decision_row, "paper"
            )
            assert execution is not None
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            execution_policy = raw_order.get("execution_policy")
            assert isinstance(execution_policy, dict)
            self.assertEqual(execution_policy.get("selected_order_type"), "market")
            execution_advisor = execution_policy.get("execution_advisor")
            assert isinstance(execution_advisor, dict)
            self.assertEqual(execution_advisor.get("applied"), True)
            self.assertEqual(execution_advisor.get("max_participation_rate"), "0.03")
            execution_microstructure = execution_policy.get("execution_microstructure")
            assert isinstance(execution_microstructure, dict)
            self.assertEqual(execution_microstructure.get("applied"), False)

    def test_submit_order_precheck_blocks_opposite_side_open_order(self) -> None:
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
                action="buy",
                qty=Decimal("1.0"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            client = ConflictingOrderClient()
            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(session, client, decision, decision_row, "paper")

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "broker_precheck")
            self.assertEqual(payload.get("code"), "precheck_opposite_side_open_order")
            self.assertEqual(payload.get("existing_order_id"), "order-conflict-1")
            self.assertEqual(len(client.submitted), 0)

    def test_submit_order_precheck_blocks_invalid_equity_fractional_qty(self) -> None:
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
                action="buy",
                qty=Decimal("0.5"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session, FakeAlpacaClient(), decision, decision_row, "paper"
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "local_qty_below_min")

    def test_submit_order_precheck_allows_equity_fractional_long_when_enabled(
        self,
    ) -> None:
        settings.trading_fractional_equities_enabled = True
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
                action="buy",
                qty=Decimal("0.5"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            execution = executor.submit_order(
                session,
                FakeAlpacaClient(),
                decision,
                decision_row,
                "paper",
            )
            self.assertIsNotNone(execution)

    def test_submit_order_precheck_uses_durable_inventory_for_lagging_fractional_exit(
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

            executor = OrderExecutor()
            buy_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, 14, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("0.5"),
                params={"price": Decimal("100")},
            )
            buy_decision_row = executor.ensure_decision(
                session, buy_decision, strategy, "paper"
            )
            buy_execution = executor.submit_order(
                session,
                FilledAlpacaClient(),
                buy_decision,
                buy_decision_row,
                "paper",
                execution_expected_adapter="alpaca",
            )
            self.assertIsNotNone(buy_execution)
            _add_lagging_broker_fill(session, "1")
            session.commit()

            sell_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, 20, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("0.5"),
                params={"price": Decimal("101")},
            )
            sell_decision_row = executor.ensure_decision(
                session, sell_decision, strategy, "paper"
            )
            lagging_client = PositionLookupNoneClient()

            sell_execution = executor.submit_order(
                session,
                lagging_client,
                sell_decision,
                sell_decision_row,
                "paper",
            )

            self.assertIsNotNone(sell_execution)
            self.assertEqual(len(lagging_client.submitted), 1)
            self.assertEqual(lagging_client.submitted[0]["side"], "sell")
            self.assertEqual(lagging_client.submitted[0]["qty"], "0.5")

    def test_submit_order_precheck_blocks_second_lagging_fractional_exit_when_reserved(
        self,
    ) -> None:
        class LaggingReservedSellClient(PositionLookupNoneClient):
            def list_orders(self, status: str = "all") -> list[dict[str, str]]:
                if status != "open":
                    return []
                return [
                    {
                        "id": "reserved-sell-1",
                        "client_order_id": "reserved-sell-client-id",
                        "symbol": "AAPL",
                        "side": "sell",
                        "type": "limit",
                        "time_in_force": "day",
                        "qty": "0.5",
                        "filled_qty": "0",
                        "status": "accepted",
                    }
                ]

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

            executor = OrderExecutor()
            buy_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, 14, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("0.5"),
                params={"price": Decimal("100")},
            )
            buy_decision_row = executor.ensure_decision(
                session, buy_decision, strategy, "paper"
            )
            buy_execution = executor.submit_order(
                session,
                FilledAlpacaClient(),
                buy_decision,
                buy_decision_row,
                "paper",
                execution_expected_adapter="alpaca",
            )
            self.assertIsNotNone(buy_execution)
            _add_lagging_broker_fill(session, "2")
            session.commit()

            sell_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, 20, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("0.5"),
                params={"price": Decimal("101")},
            )
            sell_decision_row = executor.ensure_decision(
                session, sell_decision, strategy, "paper"
            )
            lagging_client = LaggingReservedSellClient()

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session,
                    lagging_client,
                    sell_decision,
                    sell_decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "broker_precheck")
            self.assertEqual(payload.get("code"), "precheck_sell_qty_exceeds_available")
            self.assertEqual(Decimal(str(payload.get("position_qty"))), Decimal("0.5"))
            self.assertEqual(
                Decimal(str(payload.get("held_for_open_sells"))), Decimal("0.5")
            )
            self.assertEqual(Decimal(str(payload.get("available_qty"))), Decimal("0"))
            self.assertEqual(payload.get("existing_order_id"), "reserved-sell-1")
            self.assertEqual(len(lagging_client.submitted), 0)

    def test_submit_order_precheck_blocks_fractional_short_increasing_sell_when_enabled(
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

            with self.assertRaises(RuntimeError) as context:
                executor.submit_order(
                    session, FakeAlpacaClient(), decision, decision_row, "paper"
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "local_qty_below_min")

    def test_submit_order_precheck_blocks_short_when_account_shorting_disabled(
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
                    AccountShortingDisabledClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "local_account_shorting_disabled")

    def test_submit_order_precheck_blocks_short_when_symbol_not_shortable(self) -> None:
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
                    SymbolNotShortableClient(),
                    decision,
                    decision_row,
                    "paper",
                )

            payload = json.loads(str(context.exception))
            self.assertEqual(payload.get("source"), "local_pre_submit")
            self.assertEqual(payload.get("code"), "local_symbol_not_shortable")
