from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.order_idempotency.support import *


class TestOrderIdempotencyPart1(_TestOrderIdempotencyBase):
    def test_decision_hash_stable_for_same_intent(self) -> None:
        event_ts = datetime(2026, 2, 10, tzinfo=timezone.utc)
        decision_a = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=event_ts,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1.0"),
            order_type="market",
            time_in_force="day",
            params={"signal": "macd", "threshold": Decimal("1.5")},
        )
        decision_b = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=event_ts,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1.0"),
            order_type="market",
            time_in_force="day",
            params={"threshold": Decimal("1.5"), "signal": "macd"},
        )

        self.assertEqual(decision_hash(decision_a), decision_hash(decision_b))

    def test_decision_hash_changes_by_account_when_multi_account_enabled(self) -> None:
        settings.trading_multi_account_enabled = True
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 2, 10, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1.0"),
            order_type="market",
            time_in_force="day",
            params={"signal": "macd"},
        )
        hash_a = decision_hash(decision, account_label="paper-a")
        hash_b = decision_hash(decision, account_label="paper-b")
        self.assertNotEqual(hash_a, hash_b)

    def test_decision_hash_ignores_telemetry_only_params(self) -> None:
        event_ts = datetime(2026, 2, 10, tzinfo=timezone.utc)
        decision_a = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=event_ts,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1.0"),
            order_type="market",
            time_in_force="day",
            params={
                "forecast": {"point_forecast": "101.0"},
                "forecast_audit": {"inference_latency_ms": 114},
                "strategy_runtime": {"intent_conflicts_total": 0},
            },
        )
        decision_b = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=event_ts,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1.0"),
            order_type="market",
            time_in_force="day",
            params={
                "forecast": {"point_forecast": "101.0"},
                "forecast_audit": {"inference_latency_ms": 197},
                "strategy_runtime": {"intent_conflicts_total": 1},
            },
        )

        self.assertEqual(decision_hash(decision_a), decision_hash(decision_b))

    def test_execution_exists_ignores_unrelated_same_account_execution(self) -> None:
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

            first_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, 13, 0, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1.0"),
                params={"price": Decimal("100")},
            )
            second_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 2, 10, 13, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1.0"),
                params={"price": Decimal("101")},
            )

            executor = OrderExecutor()
            first_row = executor.ensure_decision(
                session, first_decision, strategy, "paper"
            )
            second_row = executor.ensure_decision(
                session, second_decision, strategy, "paper"
            )

            client = FakeAlpacaClient()
            first_execution = executor.submit_order(
                session, client, first_decision, first_row, "paper"
            )
            assert first_execution is not None

            self.assertFalse(executor.execution_exists(session, second_row))

            second_execution = executor.submit_order(
                session, client, second_decision, second_row, "paper"
            )
            assert second_execution is not None
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(executions), 2)

    def test_execution_exists_does_not_match_same_client_order_id_from_other_account(
        self,
    ) -> None:
        settings.trading_multi_account_enabled = True
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
                alpaca_account_label="paper-a",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL", "action": "buy"},
                rationale=None,
                status="planned",
                decision_hash="shared-client-id",
            )
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            session.add(
                Execution(
                    trade_decision_id=None,
                    alpaca_account_label="paper-b",
                    alpaca_order_id="other-order",
                    client_order_id="shared-client-id",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("0"),
                    status="accepted",
                    raw_order={"id": "other-order"},
                )
            )
            session.commit()

            executor = OrderExecutor()
            self.assertFalse(executor.execution_exists(session, decision_row))

        settings.trading_multi_account_enabled = False

    def test_reconciler_backfill_does_not_use_other_account_decisions_or_executions(
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

            decision_row_a = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper-a",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL", "params": {"price": "100"}},
                rationale=None,
                status="planned",
                decision_hash="shared-decision-hash",
            )
            decision_row_b = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper-b",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"symbol": "AAPL", "params": {"price": "100"}},
                rationale=None,
                status="planned",
                decision_hash="shared-decision-hash",
            )
            session.add_all([decision_row_a, decision_row_b])
            session.commit()
            session.refresh(decision_row_a)
            session.refresh(decision_row_b)

            session.add(
                Execution(
                    trade_decision_id=decision_row_b.id,
                    alpaca_account_label="paper-b",
                    alpaca_order_id="existing-b-order",
                    client_order_id="shared-decision-hash",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("0"),
                    status="accepted",
                    raw_order={"id": "existing-b-order"},
                )
            )
            session.commit()

            alpaca_client = FakeAlpacaClient()
            alpaca_client.submitted.append(
                {
                    "id": "reconciled-a-order",
                    "client_order_id": "shared-decision-hash",
                    "symbol": "AAPL",
                    "side": "buy",
                    "type": "market",
                    "time_in_force": "day",
                    "qty": "1",
                    "filled_qty": "0",
                    "status": "accepted",
                }
            )

            reconciler = Reconciler(account_label="paper-a")
            updates = reconciler.reconcile(session, alpaca_client)

            self.assertEqual(updates, 1)
            executions_a = (
                session.execute(
                    select(Execution).where(Execution.alpaca_account_label == "paper-a")
                )
                .scalars()
                .all()
            )
            executions_b = (
                session.execute(
                    select(Execution).where(Execution.alpaca_account_label == "paper-b")
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(executions_a), 1)
            self.assertEqual(len(executions_b), 1)
            self.assertEqual(executions_a[0].trade_decision_id, decision_row_a.id)
            self.assertEqual(executions_b[0].trade_decision_id, decision_row_b.id)

    def test_execution_exists_matches_by_client_order_id_hash(self) -> None:
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
            assert decision_row.decision_hash is not None

            orphan_execution = Execution(
                trade_decision_id=None,
                alpaca_account_label="paper",
                alpaca_order_id="order-orphan-1",
                client_order_id=decision_row.decision_hash,
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("0"),
                status="accepted",
                raw_order={"id": "order-orphan-1"},
            )
            session.add(orphan_execution)
            session.commit()

            self.assertTrue(executor.execution_exists(session, decision_row))

    def test_retry_after_db_failure_does_not_duplicate_submit(self) -> None:
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

            alpaca_client = FakeAlpacaClient()

            with patch("app.trading.execution.sync_order_to_db") as sync_mock:
                sync_mock.side_effect = RuntimeError("db write failed")
                with self.assertRaises(RuntimeError):
                    executor.submit_order(
                        session, alpaca_client, decision, decision_row, "paper"
                    )
                session.rollback()

            decision_row = session.get(TradeDecision, decision_row.id)
            assert decision_row is not None

            executor.submit_order(
                session, alpaca_client, decision, decision_row, "paper"
            )

            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(executions), 1)
            self.assertEqual(len(alpaca_client.submitted), 1)

    def test_submit_order_records_tca_row_with_null_safe_defaults(self) -> None:
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

            execution = executor.submit_order(
                session, FakeAlpacaClient(), decision, decision_row, "paper"
            )
            assert execution is not None

            tca = session.execute(
                select(ExecutionTCAMetric).where(
                    ExecutionTCAMetric.execution_id == execution.id
                )
            ).scalar_one()
            self.assertEqual(tca.arrival_price, Decimal("100"))
            self.assertIsNone(tca.avg_fill_price)
            self.assertIsNone(tca.slippage_bps)
            self.assertIsNone(tca.shortfall_notional)
            self.assertIsNone(tca.expected_shortfall_bps_p50)
            self.assertIsNone(tca.expected_shortfall_bps_p95)
            self.assertIsNone(tca.divergence_bps)

    def test_simulation_submit_order_uses_decision_price_for_fill_and_tca(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo-simulation",
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
                qty=Decimal("2"),
                order_type="market",
                time_in_force="day",
                params={
                    "price": Decimal("197.055"),
                    "simulation_context": {
                        "simulation_run_id": "sim-2026-05-05-chip",
                        "dataset_id": "dataset-chip",
                        "signal_event_ts": "2026-05-05T17:25:06+00:00",
                    },
                },
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

            self.assertEqual(execution.status, "filled")
            self.assertEqual(execution.avg_fill_price, Decimal("197.055"))
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            simulation_context = raw_order.get("simulation_context")
            assert isinstance(simulation_context, dict)
            self.assertEqual(simulation_context.get("simulated_fill_price"), "197.055")
            self.assertEqual(simulation_context.get("arrival_price"), "197.055")

            tca = session.execute(
                select(ExecutionTCAMetric).where(
                    ExecutionTCAMetric.execution_id == execution.id
                )
            ).scalar_one()
            self.assertEqual(tca.arrival_price, Decimal("197.055"))
            self.assertEqual(tca.avg_fill_price, Decimal("197.055"))
            self.assertEqual(tca.slippage_bps, Decimal("0"))
            self.assertEqual(tca.shortfall_notional, Decimal("0"))

    def test_simulation_submit_order_persists_queue_partial_fill_and_tca(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo-simulation-queue",
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
                qty=Decimal("10"),
                order_type="limit",
                time_in_force="day",
                limit_price=Decimal("100"),
                params={
                    "price": Decimal("100"),
                    "simulation_context": {
                        "simulation_run_id": "sim-2026-05-05-queue",
                        "dataset_id": "dataset-queue",
                        "signal_event_ts": "2026-05-05T17:25:06+00:00",
                        "depth_at_limit": "8",
                        "queue_ahead_qty": "3",
                        "queue_fill_probability": "0.75",
                    },
                },
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
                simulation_run_id="sim-2026-05-05-queue",
                dataset_id="dataset-queue",
            )

            execution = executor.submit_order(
                session,
                adapter,
                decision,
                decision_row,
                "paper",
            )
            assert execution is not None

            self.assertEqual(execution.status, "partially_filled")
            self.assertEqual(execution.submitted_qty, Decimal("10"))
            self.assertEqual(execution.filled_qty, Decimal("5"))
            self.assertEqual(execution.avg_fill_price, Decimal("100"))
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            simulation_context = raw_order.get("simulation_context")
            assert isinstance(simulation_context, dict)
            self.assertEqual(simulation_context.get("depth_at_limit"), "8")
            self.assertEqual(simulation_context.get("queue_ahead_qty"), "3")

            tca = session.execute(
                select(ExecutionTCAMetric).where(
                    ExecutionTCAMetric.execution_id == execution.id
                )
            ).scalar_one()
            self.assertEqual(tca.arrival_price, Decimal("100"))
            self.assertEqual(tca.avg_fill_price, Decimal("100"))
            self.assertEqual(tca.filled_qty, Decimal("5"))
            self.assertEqual(tca.slippage_bps, Decimal("0"))
            self.assertEqual(tca.shortfall_notional, Decimal("0"))

    def test_simulation_submit_order_copies_explicit_queue_context_from_execution_microstructure(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo-simulation-policy-queue",
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
                qty=Decimal("10"),
                order_type="limit",
                time_in_force="day",
                limit_price=Decimal("100"),
                params={
                    "price": Decimal("100"),
                    "execution_policy": {
                        "selected_order_type": "limit",
                        "adaptive": {"applied": True},
                    },
                    "execution_microstructure": {
                        "applied": True,
                        "state_valid": True,
                        "depth_at_limit": "8",
                        "queue_ahead_qty": "3",
                        "queue_fill_probability": "0.75",
                    },
                },
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
                simulation_run_id="sim-2026-05-05-policy-queue",
                dataset_id="dataset-policy-queue",
            )

            execution = executor.submit_order(
                session,
                adapter,
                decision,
                decision_row,
                "paper",
            )
            assert execution is not None

            self.assertEqual(execution.status, "partially_filled")
            self.assertEqual(execution.filled_qty, Decimal("5"))
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            simulation_context = raw_order.get("simulation_context")
            assert isinstance(simulation_context, dict)
            self.assertEqual(simulation_context.get("depth_at_limit"), "8")
            self.assertEqual(simulation_context.get("queue_ahead_qty"), "3")
            self.assertEqual(simulation_context.get("queue_fill_probability"), "0.75")

    def test_simulation_submit_order_does_not_infer_queue_context_from_microstructure_metadata(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo-simulation-policy-metadata",
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
                qty=Decimal("10"),
                order_type="limit",
                time_in_force="day",
                limit_price=Decimal("100"),
                params={
                    "price": Decimal("100"),
                    "execution_policy": {
                        "selected_order_type": "limit",
                        "adaptive": {"applied": True},
                    },
                    "execution_microstructure": {
                        "applied": True,
                        "state_valid": True,
                        "depth_top5_usd": "500",
                        "fill_hazard": "0.8",
                        "order_flow_imbalance": "0.25",
                        "liquidity_regime": "stressed",
                    },
                },
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
                simulation_run_id="sim-2026-05-05-policy-metadata",
                dataset_id="dataset-policy-metadata",
            )

            execution = executor.submit_order(
                session,
                adapter,
                decision,
                decision_row,
                "paper",
            )
            assert execution is not None

            self.assertEqual(execution.status, "filled")
            self.assertEqual(execution.filled_qty, Decimal("10"))
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            simulation_context = raw_order.get("simulation_context")
            assert isinstance(simulation_context, dict)
            self.assertNotIn("depth_at_limit", simulation_context)
            self.assertNotIn("available_depth_qty", simulation_context)
            self.assertNotIn("queue_ahead_qty", simulation_context)
            self.assertNotIn("queue_fill_probability", simulation_context)
            self.assertNotIn("market_order_intensity", simulation_context)
            self.assertNotIn("cancel_intensity", simulation_context)

    def test_simulation_submit_order_uses_price_snapshot_without_context(self) -> None:
        with self.session_local() as session:
            strategy = Strategy(
                name="demo-simulation-snapshot",
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
                params={"price_snapshot": {"price": "197.34"}},
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

            self.assertEqual(execution.avg_fill_price, Decimal("197.34"))
            raw_order = execution.raw_order
            assert isinstance(raw_order, dict)
            simulation_context = raw_order.get("simulation_context")
            assert isinstance(simulation_context, dict)
            self.assertEqual(simulation_context.get("simulated_fill_price"), "197.34")
            self.assertEqual(simulation_context.get("arrival_price"), "197.34")
