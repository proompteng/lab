from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.portfolio_sizing.support import *


class TestPortfolioSizingPart1(_TestPortfolioSizingBase):
    def test_intent_aggregator_preserves_fractional_qty_for_crypto(self) -> None:
        aggregator = IntentAggregator()
        decisions = [
            StrategyDecision(
                strategy_id="s2",
                symbol="BTC/USD",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("0.10000000"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100000")},
            ),
            StrategyDecision(
                strategy_id="s1",
                symbol="BTC/USD",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("0.25000000"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100000")},
            ),
        ]

        aggregated = aggregator.aggregate(decisions)

        self.assertEqual(len(aggregated), 1)
        self.assertEqual(aggregated[0].decision.action, "buy")
        self.assertEqual(aggregated[0].decision.qty, Decimal("0.15000000"))

    def test_intent_aggregator_merges_conflicting_intents_deterministically(
        self,
    ) -> None:
        aggregator = IntentAggregator()
        decisions = [
            StrategyDecision(
                strategy_id="s2",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("3"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
            StrategyDecision(
                strategy_id="s1",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("10"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
        ]

        aggregated = aggregator.aggregate(decisions)

        self.assertEqual(len(aggregated), 1)
        self.assertEqual(aggregated[0].decision.action, "buy")
        self.assertEqual(aggregated[0].decision.qty, Decimal("7"))
        self.assertTrue(aggregated[0].had_conflict)

    def test_intent_aggregator_preserves_fractional_equity_sell_qty(self) -> None:
        aggregator = IntentAggregator()
        decisions = [
            StrategyDecision(
                strategy_id="s1",
                symbol="NVDA",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("147.5843"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("177.74")},
            )
        ]

        aggregated = aggregator.aggregate(decisions)

        self.assertEqual(len(aggregated), 1)
        self.assertEqual(aggregated[0].decision.action, "sell")
        self.assertEqual(aggregated[0].decision.qty, Decimal("147.5843"))

    def test_allocator_clips_symbol_concentration_and_records_reason(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=Decimal("0.10"),
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("20"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "fragility_state": "normal",
                "spread_acceleration": Decimal("0"),
                "liquidity_compression": Decimal("0"),
                "crowding_proxy": Decimal("0"),
                "correlation_concentration": Decimal("0"),
            },
        )

        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertTrue(result.approved)
        self.assertTrue(result.clipped)
        self.assertIn(ALLOCATOR_CLIP_SYMBOL_CAPACITY, result.reason_codes)
        self.assertEqual(result.decision.qty, Decimal("10"))

    def test_allocator_regime_multiplier_can_force_reject(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=Decimal("0.10"),
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={
                    "vol=high|trend=flat|liq=liquid": Decimal("0.0")
                },
                regime_capacity_multipliers={},
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )

        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="vol=high|trend=flat|liq=liquid",
        )

        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertFalse(result.approved)
        self.assertIn(ALLOCATOR_REJECT_SYMBOL_CAPACITY, result.reason_codes)
        self.assertEqual(result.decision.qty, Decimal("0"))

    def test_allocator_applies_regime_low_confidence_penalty(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="vol=high|trend=flat|liq=liquid",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={"AAPL": Decimal("1000")},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
                regime_low_confidence_threshold=Decimal("0.60"),
                regime_low_confidence_multiplier=Decimal("0.70"),
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("20"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.55", "R1": "0.45"},
                },
            },
        )

        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="vol=high|trend=flat|liq=liquid",
        )

        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertTrue(result.approved)
        self.assertIn(ALLOCATOR_REGIME_LOW_CONFIDENCE, result.reason_codes)
        self.assertTrue(
            result.decision.params["allocator"]["regime_low_confidence_applied"]
        )
        self.assertEqual(
            Decimal(result.decision.params["allocator"]["regime_confidence"]),
            Decimal("0.55"),
        )
        self.assertEqual(
            Decimal(result.decision.params["allocator"]["budget_multiplier"]),
            Decimal("0.7"),
        )
        self.assertEqual(
            Decimal(result.decision.params["allocator"]["capacity_multiplier"]),
            Decimal("0.7"),
        )
        self.assertEqual(
            Decimal(result.decision.params["allocator"]["approved_qty"]),
            Decimal("7"),
        )

    def test_allocator_skips_regime_penalty_for_high_confidence(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="vol=high|trend=flat|liq=liquid",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={"AAPL": Decimal("1000")},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
                regime_low_confidence_threshold=Decimal("0.60"),
                regime_low_confidence_multiplier=Decimal("0.70"),
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("20"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.85", "R1": "0.15"},
                },
            },
        )

        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="vol=high|trend=flat|liq=liquid",
        )

        self.assertEqual(len(results), 1)
        result = results[0]
        self.assertTrue(result.approved)
        self.assertNotIn(ALLOCATOR_REGIME_LOW_CONFIDENCE, result.reason_codes)
        self.assertFalse(
            result.decision.params["allocator"]["regime_low_confidence_applied"]
        )
        self.assertEqual(
            Decimal(result.decision.params["allocator"]["budget_multiplier"]),
            Decimal("1"),
        )
        self.assertEqual(
            Decimal(result.decision.params["allocator"]["capacity_multiplier"]),
            Decimal("1"),
        )
        self.assertEqual(
            Decimal(result.decision.params["allocator"]["approved_qty"]),
            Decimal("10"),
        )

    def test_allocator_prioritizes_higher_strategy_factory_edge_under_shared_cap(
        self,
    ) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=Decimal("1500"),
                strategy_notional_caps={},
                symbol_notional_caps={},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        high_edge = StrategyDecision(
            strategy_id="high-edge",
            symbol="MSFT",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("20"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "strategy_factory": {
                    "posterior_edge_summary": {
                        "annualized_edge_mean_bps": "80",
                        "annualized_edge_lower_bps": "40",
                    },
                    "null_comparator_summary": {"baseline_outperformed": True},
                    "sequential_trial": {"status": "paper_ready"},
                    "cost_calibration": {"status": "calibrated"},
                },
            },
        )
        low_edge = high_edge.model_copy(
            update={
                "strategy_id": "low-edge",
                "symbol": "NVDA",
                "params": {
                    "price": Decimal("100"),
                    "strategy_factory": {
                        "posterior_edge_summary": {
                            "annualized_edge_mean_bps": "0",
                            "annualized_edge_lower_bps": "0",
                        },
                        "null_comparator_summary": {"baseline_outperformed": True},
                        "sequential_trial": {"status": "paper_ready"},
                        "cost_calibration": {"status": "calibrated"},
                    },
                },
            }
        )

        results = allocator.allocate(
            [low_edge, high_edge],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(
            [item.decision.strategy_id for item in results],
            ["high-edge", "low-edge"],
        )
        self.assertTrue(results[0].approved)
        self.assertEqual(results[0].approved_notional, Decimal("1500"))
        self.assertFalse(results[1].approved)
        self.assertIn(ALLOCATOR_REJECT_GROSS_EXPOSURE, results[1].reason_codes)

    def test_allocator_blocks_strategy_factory_observe_only_candidates(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=Decimal("1000"),
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decision = StrategyDecision(
            strategy_id="observe-only",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("5"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "strategy_factory": {
                    "posterior_edge_summary": {
                        "annualized_edge_mean_bps": "15",
                        "annualized_edge_lower_bps": "5",
                    },
                    "null_comparator_summary": {"baseline_outperformed": True},
                    "sequential_trial": {"status": "observe_only"},
                    "cost_calibration": {"status": "calibrated"},
                },
            },
        )

        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].approved)
        self.assertIn(ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY, results[0].reason_codes)

    def test_allocator_blocks_strategy_factory_baseline_fail_candidates(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=Decimal("1000"),
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decision = StrategyDecision(
            strategy_id="baseline-fail",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("5"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "strategy_factory": {
                    "posterior_edge_summary": {
                        "annualized_edge_mean_bps": "15",
                        "annualized_edge_lower_bps": "5",
                    },
                    "null_comparator_summary": {"baseline_outperformed": False},
                    "sequential_trial": {"status": "paper_ready"},
                    "cost_calibration": {"status": "calibrated"},
                },
            },
        )

        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].approved)
        self.assertIn(ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL, results[0].reason_codes)

    def test_allocator_clips_by_strategy_budget(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={"s1": Decimal("200"), "s2": Decimal("400")},
                symbol_notional_caps={},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decisions = [
            StrategyDecision(
                strategy_id="s1",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("3"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
            StrategyDecision(
                strategy_id="s2",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("3"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
        ]

        results = allocator.allocate(
            decisions,
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].approved)
        self.assertTrue(results[0].clipped)
        self.assertIn(ALLOCATOR_CLIP_STRATEGY_BUDGET, results[0].reason_codes)
        self.assertEqual(results[0].decision.qty, Decimal("4"))

    def test_allocator_clips_by_symbol_budget(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={"AAPL": Decimal("500")},
                correlation_group_caps={},
                symbol_correlation_groups={},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("7"),
            order_type="market",
            time_in_force="day",
            params={"price": Decimal("100")},
        )
        results = allocator.allocate(
            [decision],
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].approved)
        self.assertIn(ALLOCATOR_CLIP_SYMBOL_BUDGET, results[0].reason_codes)
        self.assertEqual(results[0].decision.qty, Decimal("5"))

    def test_allocator_rejects_when_correlation_budget_depleted(self) -> None:
        allocator = PortfolioAllocator(
            AllocationConfig(
                enabled=True,
                default_regime="neutral",
                default_budget_multiplier=Decimal("1.0"),
                default_capacity_multiplier=Decimal("1.0"),
                min_multiplier=Decimal("0"),
                max_multiplier=Decimal("2"),
                max_symbol_pct_equity=None,
                max_symbol_notional=None,
                max_gross_exposure=None,
                strategy_notional_caps={},
                symbol_notional_caps={},
                correlation_group_caps={"tech": Decimal("500")},
                symbol_correlation_groups={"AAPL": "tech"},
                regime_budget_multipliers={},
                regime_capacity_multipliers={},
            )
        )
        decisions = [
            StrategyDecision(
                strategy_id="s1",
                symbol="AAPL",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("6"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            ),
            StrategyDecision(
                strategy_id="s2",
                symbol="MSFT",
                event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100"), "correlation_group": "tech"},
            ),
        ]

        results = allocator.allocate(
            decisions,
            account={"equity": "10000", "buying_power": "10000", "cash": "10000"},
            positions=[],
            regime_label="neutral",
        )

        self.assertEqual(len(results), 2)
        approved = next(
            result for result in results if result.decision.symbol == "AAPL"
        )
        rejected = next(
            result for result in results if result.decision.symbol == "MSFT"
        )
        self.assertTrue(approved.approved)
        self.assertIn(ALLOCATOR_CLIP_CORRELATION_CAPACITY, approved.reason_codes)
        self.assertEqual(approved.decision.qty, Decimal("5"))
        self.assertFalse(rejected.approved)
        self.assertIn(ALLOCATOR_REJECT_CORRELATION_CAPACITY, rejected.reason_codes)
        self.assertEqual(rejected.decision.qty, Decimal("0"))

    def test_disabled_allocator_metadata_does_not_apply_regime_multiplier(self) -> None:
        sizer = PortfolioSizer(
            PortfolioSizingConfig(
                notional_per_position=None,
                volatility_target=None,
                volatility_floor=Decimal("0"),
                max_positions=None,
                max_notional_per_symbol=None,
                max_position_pct_equity=None,
                max_gross_exposure=None,
                max_net_exposure=None,
            )
        )
        decision = StrategyDecision(
            strategy_id="s1",
            symbol="AAPL",
            event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            params={
                "price": Decimal("100"),
                "allocator": {
                    "enabled": False,
                    "status": "approved",
                    "budget_multiplier": "0.5",
                    "capacity_multiplier": "0.5",
                    "approved_notional": "1000",
                },
            },
        )
        result = sizer.size(decision, account={"equity": "50000"}, positions=[])
        self.assertTrue(result.approved)
        self.assertEqual(result.decision.qty, Decimal("10"))
        self.assertNotIn(
            "allocator_regime_multiplier", result.audit["output"]["methods"]
        )

    def test_allocator_from_settings_consumes_normalized_correlation_maps(self) -> None:
        original_values = {
            "trading_allocator_correlation_group_caps": dict(
                config.settings.trading_allocator_correlation_group_caps
            ),
            "trading_allocator_symbol_correlation_groups": dict(
                config.settings.trading_allocator_symbol_correlation_groups
            ),
        }
        try:
            config.settings.trading_allocator_correlation_group_caps = {"legacy": 111.0}
            config.settings.trading_allocator_symbol_correlation_groups = {
                "MSFT": "legacy",
                " aapl ": " MegaCap ",
            }

            allocator = allocator_from_settings(Decimal("10000"))

            self.assertEqual(
                allocator.config.correlation_group_caps.get("legacy"), Decimal("111")
            )
            self.assertEqual(
                allocator.config.symbol_correlation_groups.get("AAPL"), "megacap"
            )
        finally:
            config.settings.trading_allocator_correlation_group_caps = original_values[
                "trading_allocator_correlation_group_caps"
            ]
            config.settings.trading_allocator_symbol_correlation_groups = (
                original_values["trading_allocator_symbol_correlation_groups"]
            )
