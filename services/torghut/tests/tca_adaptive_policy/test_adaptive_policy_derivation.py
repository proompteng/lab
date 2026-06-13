from __future__ import annotations

from tests.tca_adaptive_policy.support import (
    Decimal,
    Execution,
    ExecutionTCAMetric,
    TradeDecision,
    _TestAdaptiveExecutionPolicyDerivationBase,
    build_tca_gate_inputs,
    cast,
    datetime,
    derive_adaptive_execution_policy,
    patch,
    refresh_execution_tca_metrics,
    select,
    tca_module,
    timezone,
    upsert_execution_tca_metric,
)


class TestAdaptiveExecutionPolicyDerivationPart1(
    _TestAdaptiveExecutionPolicyDerivationBase
):
    def test_derivation_builds_defensive_override_for_high_recent_slippage(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("25"),
                    Decimal("25"),
                    Decimal("25"),
                ],
                shortfalls=[
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("20"),
                    Decimal("20"),
                    Decimal("20"),
                ],
                expected_shortfall_p50_values=[
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                ],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertEqual(decision.aggressiveness, "defensive")
        self.assertEqual(decision.prefer_limit, True)
        self.assertFalse(decision.fallback_active)
        self.assertEqual(decision.sample_size, 6)
        self.assertEqual(decision.regime_label, "trend")

    def test_derivation_builds_defensive_override_for_high_shortfall_only(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("8"),
                    Decimal("9"),
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("10"),
                ],
                shortfalls=[
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("18"),
                    Decimal("18"),
                    Decimal("18"),
                ],
                expected_shortfall_p50_values=[
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                ],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertEqual(decision.aggressiveness, "defensive")
        self.assertEqual(decision.prefer_limit, True)
        self.assertFalse(decision.fallback_active)
        self.assertGreater(
            decision.recent_shortfall_notional or Decimal("0"), Decimal("15")
        )

    def test_build_tca_gate_inputs_uses_absolute_metrics_for_tca_exposure(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[Decimal("12"), Decimal("-12")],
                shortfalls=[Decimal("4"), Decimal("-4")],
                expected_shortfall_p50_values=[Decimal("0"), Decimal("0")],
                realized_shortfall_bps_values=[Decimal("1"), Decimal("-1")],
                divergence_bps_values=[Decimal("1"), Decimal("-1")],
                adaptive_applied=False,
            )

            expected = build_tca_gate_inputs(session, strategy_id=strategy.id)
            self.assertEqual(expected["avg_slippage_bps"], Decimal("0"))
            self.assertEqual(expected["avg_abs_slippage_bps"], Decimal("12"))
            self.assertEqual(expected["avg_shortfall_notional"], Decimal("0"))
            self.assertEqual(expected["avg_shortfall_notional_abs"], Decimal("4"))
            self.assertEqual(expected["avg_divergence_bps"], Decimal("0"))
            self.assertEqual(expected["avg_divergence_bps_abs"], Decimal("1"))
            self.assertEqual(expected["avg_realized_shortfall_bps"], Decimal("0"))
            self.assertEqual(expected["avg_realized_shortfall_bps_abs"], Decimal("1"))
            self.assertEqual(expected["order_count"], 2)
            self.assertEqual(expected["expected_shortfall_sample_count"], 2)
            self.assertEqual(expected["expected_shortfall_coverage"], Decimal("1"))

    def test_build_tca_gate_inputs_filters_by_account_label(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[Decimal("4")],
                shortfalls=[Decimal("1")],
                expected_shortfall_p50_values=[Decimal("1")],
                realized_shortfall_bps_values=[Decimal("-8")],
                divergence_bps_values=[Decimal("0")],
                adaptive_applied=False,
                account_label="paper",
            )
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend-live",
                slippages=[Decimal("100")],
                shortfalls=[Decimal("10")],
                expected_shortfall_p50_values=[Decimal("1")],
                realized_shortfall_bps_values=[Decimal("12")],
                divergence_bps_values=[Decimal("0")],
                adaptive_applied=False,
                account_label="live",
            )

            paper = build_tca_gate_inputs(
                session,
                strategy_id=strategy.id,
                account_label="paper",
            )
            live = build_tca_gate_inputs(
                session,
                strategy_id=strategy.id,
                account_label="live",
            )

        self.assertEqual(paper["order_count"], 1)
        self.assertEqual(paper["avg_abs_slippage_bps"], Decimal("4"))
        self.assertEqual(live["order_count"], 1)
        self.assertEqual(live["avg_abs_slippage_bps"], Decimal("100"))

    def test_build_tca_gate_inputs_filters_by_scope_symbols_and_reports_breakdown(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[Decimal("4")],
                shortfalls=[Decimal("1")],
                expected_shortfall_p50_values=[Decimal("1")],
                realized_shortfall_bps_values=[Decimal("-2")],
                adaptive_applied=False,
            )
            self._insert_observations(
                session,
                strategy,
                symbol="NVDA",
                regime="trend-nvda",
                slippages=[Decimal("12")],
                shortfalls=[Decimal("1")],
                expected_shortfall_p50_values=[Decimal("1")],
                realized_shortfall_bps_values=[Decimal("1")],
                adaptive_applied=False,
            )
            self._insert_observations(
                session,
                strategy,
                symbol="META",
                regime="trend-meta",
                slippages=[Decimal("100")],
                shortfalls=[Decimal("1")],
                expected_shortfall_p50_values=[Decimal("1")],
                realized_shortfall_bps_values=[Decimal("99")],
                adaptive_applied=False,
            )

            summary = build_tca_gate_inputs(
                session,
                strategy_id=strategy.id,
                account_label="paper",
                symbols={"NVDA", "AAPL", "ORCL"},
            )

        self.assertEqual(summary["scope_symbols"], ["AAPL", "NVDA", "ORCL"])
        self.assertEqual(summary["scope_symbol_count"], 3)
        self.assertEqual(summary["order_count"], 2)
        self.assertEqual(summary["avg_abs_slippage_bps"], Decimal("8"))
        breakdown = {
            str(item["symbol"]): item
            for item in cast(list[dict[str, object]], summary["symbol_breakdown"])
        }
        self.assertEqual(breakdown["AAPL"]["order_count"], 1)
        self.assertEqual(breakdown["NVDA"]["avg_abs_slippage_bps"], Decimal("12"))
        self.assertEqual(breakdown["NVDA"]["avg_realized_shortfall_bps"], Decimal("1"))
        self.assertEqual(breakdown["ORCL"]["order_count"], 0)
        self.assertIsNone(breakdown["ORCL"]["avg_realized_shortfall_bps"])
        self.assertNotIn("META", breakdown)

    def test_build_tca_gate_inputs_reports_execution_settlement_coverage(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[Decimal("4")],
                shortfalls=[Decimal("1")],
                expected_shortfall_p50_values=[Decimal("1")],
                adaptive_applied=False,
            )
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "strategy_id": str(strategy.id),
                    "symbol": "AAPL",
                    "action": "buy",
                    "qty": "1",
                    "params": {"regime_label": "trend"},
                },
                rationale="test",
                status="submitted",
                decision_hash="hash-unsettled",
            )
            session.add(decision)
            session.flush()
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_order_id="order-unsettled",
                    client_order_id="client-unsettled",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100.01"),
                    status="filled",
                    execution_expected_adapter="alpaca",
                    execution_actual_adapter="alpaca",
                )
            )
            session.commit()

            expected = build_tca_gate_inputs(session, strategy_id=strategy.id)

        self.assertEqual(expected["order_count"], 1)
        self.assertEqual(expected["filled_execution_count"], 2)
        self.assertEqual(expected["unsettled_execution_count"], 1)
        self.assertIsNotNone(expected["latest_execution_created_at"])

    def test_upsert_tca_prefers_price_snapshot_over_stale_signal_price(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="MU",
                timeframe="1Min",
                decision_json={
                    "strategy_id": str(strategy.id),
                    "symbol": "MU",
                    "action": "sell",
                    "qty": "2.4232",
                    "params": {
                        "price": "412.6704331378219",
                        "price_snapshot": {
                            "price": "316.93",
                            "source": "ta_microbars",
                            "as_of": "2026-03-31T13:38:20+00:00",
                        },
                    },
                },
                rationale="test",
                status="submitted",
                decision_hash="hash-stale-signal-price",
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id="order-stale-signal-price",
                client_order_id="client-stale-signal-price",
                symbol="MU",
                side="sell",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("2.4232"),
                filled_qty=Decimal("2.4232"),
                avg_fill_price=Decimal("316.93"),
                status="filled",
                execution_expected_adapter="alpaca",
                execution_actual_adapter="alpaca",
            )
            session.add(execution)
            session.flush()

            metric = upsert_execution_tca_metric(session, execution)

        self.assertEqual(metric.arrival_price, Decimal("316.93"))
        self.assertEqual(metric.slippage_bps, Decimal("0"))
        self.assertEqual(metric.shortfall_notional, Decimal("0.0000"))

    def test_upsert_tca_journal_failure_respects_required_flag(self) -> None:
        with self.session_local() as session:
            execution = self._insert_tca_execution(
                session,
                order_id="order-tca-journal-optional",
                client_order_id="client-tca-journal-optional",
            )

            with (
                patch.object(tca_module.settings, "tigerbeetle_enabled", True),
                patch.object(tca_module.settings, "tigerbeetle_journal_enabled", True),
                patch.object(tca_module.settings, "tigerbeetle_required", False),
                patch(
                    (
                        "app.trading.tca_modules.lineage_read_model"
                        ".TigerBeetleLedgerJournal.journal_execution"
                    ),
                    side_effect=RuntimeError("journal failed"),
                ),
            ):
                with self.assertLogs(tca_module.logger, level="WARNING"):
                    metric = upsert_execution_tca_metric(session, execution)

            self.assertEqual(metric.execution_id, execution.id)

        with self.session_local() as session:
            execution = self._insert_tca_execution(
                session,
                order_id="order-tca-journal-required",
                client_order_id="client-tca-journal-required",
            )

            with (
                patch.object(tca_module.settings, "tigerbeetle_enabled", True),
                patch.object(tca_module.settings, "tigerbeetle_journal_enabled", True),
                patch.object(tca_module.settings, "tigerbeetle_required", True),
                patch(
                    (
                        "app.trading.tca_modules.lineage_read_model"
                        ".TigerBeetleLedgerJournal.journal_execution"
                    ),
                    side_effect=RuntimeError("journal failed"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "journal failed"):
                    upsert_execution_tca_metric(session, execution)

    def test_upsert_tca_refreshes_existing_metric_computed_at(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="MU",
                timeframe="1Min",
                decision_json={
                    "strategy_id": str(strategy.id),
                    "symbol": "MU",
                    "action": "sell",
                    "qty": "2",
                    "params": {
                        "price": "412.67",
                        "price_snapshot": {"price": "316.93"},
                    },
                },
                rationale="test",
                status="submitted",
                decision_hash="hash-existing-tca",
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id="order-existing-tca",
                client_order_id="client-existing-tca",
                symbol="MU",
                side="sell",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("2"),
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("316.93"),
                status="filled",
                execution_expected_adapter="alpaca",
                execution_actual_adapter="alpaca",
            )
            session.add(execution)
            session.flush()
            old_computed_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
            session.add(
                ExecutionTCAMetric(
                    execution_id=execution.id,
                    trade_decision_id=decision.id,
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="MU",
                    side="sell",
                    arrival_price=Decimal("412.67"),
                    avg_fill_price=Decimal("316.93"),
                    filled_qty=Decimal("2"),
                    signed_qty=Decimal("-2"),
                    slippage_bps=Decimal("2319"),
                    shortfall_notional=Decimal("191.48"),
                    churn_qty=Decimal("0"),
                    churn_ratio=Decimal("0"),
                    computed_at=old_computed_at,
                )
            )
            session.commit()

            metric = upsert_execution_tca_metric(session, execution)

        self.assertEqual(metric.arrival_price, Decimal("316.93"))
        self.assertEqual(metric.slippage_bps, Decimal("0"))
        self.assertGreater(
            metric.computed_at.replace(tzinfo=timezone.utc), old_computed_at
        )

    def test_refresh_execution_tca_metrics_rematerializes_stale_rows(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="MU",
                timeframe="1Min",
                decision_json={
                    "strategy_id": str(strategy.id),
                    "symbol": "MU",
                    "action": "sell",
                    "qty": "2",
                    "params": {
                        "price": "412.67",
                        "price_snapshot": {"price": "316.93"},
                    },
                },
                rationale="test",
                status="submitted",
                decision_hash="hash-refresh-tca",
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id="order-refresh-tca",
                client_order_id="client-refresh-tca",
                symbol="MU",
                side="sell",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("2"),
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("316.93"),
                status="filled",
                execution_expected_adapter="alpaca",
                execution_actual_adapter="alpaca",
            )
            session.add(execution)
            session.flush()
            old_computed_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
            session.add(
                ExecutionTCAMetric(
                    execution_id=execution.id,
                    trade_decision_id=decision.id,
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="MU",
                    side="sell",
                    arrival_price=Decimal("412.67"),
                    avg_fill_price=Decimal("316.93"),
                    filled_qty=Decimal("2"),
                    signed_qty=Decimal("-2"),
                    slippage_bps=Decimal("2319"),
                    shortfall_notional=Decimal("191.48"),
                    churn_qty=Decimal("0"),
                    churn_ratio=Decimal("0"),
                    computed_at=old_computed_at,
                )
            )
            session.commit()

            result = refresh_execution_tca_metrics(
                session,
                stale_before=datetime(2026, 1, 2, tzinfo=timezone.utc),
                limit=10,
            )
            session.commit()
            metric = session.execute(
                select(ExecutionTCAMetric).where(
                    ExecutionTCAMetric.execution_id == execution.id
                )
            ).scalar_one()

        self.assertEqual(result["selected"], 1)
        self.assertEqual(result["refreshed"], 1)
        self.assertEqual(metric.arrival_price, Decimal("316.93"))
        self.assertEqual(metric.slippage_bps, Decimal("0"))
        self.assertGreater(
            metric.computed_at.replace(tzinfo=timezone.utc), old_computed_at
        )

    def test_refresh_execution_tca_metrics_dry_run_reports_account_selection(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "strategy_id": str(strategy.id),
                    "symbol": "AAPL",
                    "action": "buy",
                    "qty": "1",
                    "params": {"price": "100"},
                },
                rationale="test",
                status="submitted",
                decision_hash="hash-dry-run-tca",
            )
            session.add(decision)
            session.flush()
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id="order-dry-run-tca",
                client_order_id="client-dry-run-tca",
                symbol="AAPL",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                status="filled",
                alpaca_account_label="paper",
                execution_expected_adapter="alpaca",
                execution_actual_adapter="alpaca",
            )
            session.add(execution)
            session.commit()

            result = refresh_execution_tca_metrics(
                session,
                account_label="paper",
                stale_before=datetime.now(timezone.utc),
                limit=10,
                dry_run=True,
            )

        self.assertEqual(result["selected"], 1)
        self.assertEqual(result["refreshed"], 0)
        self.assertEqual(result["dry_run"], True)
        self.assertEqual(result["account_label"], "paper")

    def test_upsert_tca_preserves_execution_account_without_decision_link(self) -> None:
        with self.session_local() as session:
            execution = Execution(
                trade_decision_id=None,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="order-unlinked-tca",
                client_order_id="client-unlinked-tca",
                symbol="NVDA",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=Decimal("100"),
                status="filled",
                execution_expected_adapter="alpaca",
                execution_actual_adapter="alpaca",
            )
            session.add(execution)
            session.flush()

            metric = upsert_execution_tca_metric(session, execution)
            tca_inputs = build_tca_gate_inputs(
                session,
                account_label="TORGHUT_SIM",
                symbols=["NVDA"],
            )

        self.assertEqual(metric.alpaca_account_label, "TORGHUT_SIM")
        self.assertIsNone(metric.trade_decision_id)
        self.assertIsNone(metric.strategy_id)
        self.assertEqual(tca_inputs["order_count"], 1)
        self.assertEqual(tca_inputs["filled_execution_count"], 1)

    def test_derivation_fallback_when_expected_shortfall_coverage_is_insufficient(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("8"),
                    Decimal("8"),
                    Decimal("8"),
                    Decimal("8"),
                    Decimal("8"),
                    Decimal("8"),
                ],
                shortfalls=[
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                ],
                expected_shortfall_p50_values=[Decimal("4"), Decimal("4")],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertTrue(decision.fallback_active)
        self.assertEqual(
            decision.fallback_reason, "adaptive_policy_expected_shortfall_coverage_low"
        )
        self.assertEqual(decision.expected_shortfall_sample_count, 2)
        self.assertEqual(decision.expected_shortfall_coverage, Decimal(2) / Decimal(6))

    def test_derivation_fallback_when_expected_shortfall_calibration_is_missing(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("8"),
                    Decimal("9"),
                    Decimal("10"),
                    Decimal("11"),
                    Decimal("12"),
                    Decimal("13"),
                ],
                shortfalls=[
                    Decimal("1"),
                    Decimal("2"),
                    Decimal("3"),
                    Decimal("4"),
                    Decimal("5"),
                    Decimal("6"),
                ],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertTrue(decision.fallback_active)
        self.assertEqual(
            decision.fallback_reason,
            "adaptive_policy_expected_shortfall_coverage_missing",
        )
        self.assertEqual(decision.expected_shortfall_sample_count, 0)

    def test_derivation_triggers_fallback_when_adaptive_degrades(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="all",
                slippages=[
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("18"),
                    Decimal("18"),
                    Decimal("18"),
                ],
                shortfalls=[
                    Decimal("3"),
                    Decimal("3"),
                    Decimal("3"),
                    Decimal("9"),
                    Decimal("9"),
                    Decimal("9"),
                ],
                expected_shortfall_p50_values=[
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                ],
                adaptive_applied=True,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label=None,
            )

        self.assertTrue(decision.fallback_active)
        self.assertEqual(decision.fallback_reason, "adaptive_policy_degraded")
        self.assertIsNone(decision.prefer_limit)
        self.assertGreater(decision.degradation_bps or Decimal("0"), Decimal("4"))
