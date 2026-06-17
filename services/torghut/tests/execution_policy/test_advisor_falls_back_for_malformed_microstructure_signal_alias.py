from __future__ import annotations

from tests.execution_policy.support import (
    AdaptiveExecutionPolicyDecision,
    Decimal,
    ExecutionPolicy,
    _TestExecutionPolicyBase,
    _config,
    _decision,
    config,
    datetime,
    timezone,
)


class TestAdvisorFallsBackForMalformedMicrostructureSignalAlias(
    _TestExecutionPolicyBase
):
    def test_advisor_falls_back_for_malformed_microstructure_signal_alias(
        self,
    ) -> None:
        config.settings.trading_execution_advisor_enabled = True
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "max_participation_rate": "0.05",
                        "preferred_order_type": "limit",
                        "adverse_selection_risk": "0.20",
                    },
                    "microstructure_signal": {
                        "schema_version": "microstructure_signal_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "feature_quality_status": "fail",
                        "expected_spread_impact_bps": "3.2",
                        "depth_top5_usd": "1500000",
                        "direction_probabilities": {
                            "up": "0.10",
                            "flat": "0.00",
                            "down": "0.10",
                        },
                        "liquidity_state": "normal",
                        "uncertainty_band": "low",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(
            outcome.microstructure_metadata["fallback_reason"],
            "microstructure_state_unavailable",
        )
        self.assertFalse(outcome.advisor_metadata["applied"])
        self.assertEqual(
            outcome.advisor_metadata["fallback_reason"],
            "advisor_missing_inputs",
        )

    def test_advisor_timeout_falls_back_to_baseline(self) -> None:
        config.settings.trading_execution_advisor_enabled = True
        config.settings.trading_execution_advisor_timeout_ms = 10
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "3.2",
                        "depth_top5_usd": "1500000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.8",
                        "liquidity_regime": "normal",
                    },
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "latency_ms": 50,
                        "max_participation_rate": "0.01",
                        "preferred_order_type": "limit",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(outcome.advisor_metadata["applied"], False)
        self.assertEqual(outcome.advisor_metadata["fallback_reason"], "advisor_timeout")

    def test_advisor_missing_inputs_falls_back_to_baseline(self) -> None:
        config.settings.trading_execution_advisor_enabled = True
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "3.2",
                        "depth_top5_usd": "1500000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.8",
                        "liquidity_regime": "normal",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(outcome.advisor_metadata["applied"], False)
        self.assertEqual(
            outcome.advisor_metadata["fallback_reason"], "advisor_missing_inputs"
        )

    def test_advisor_live_apply_flag_disables_broker_facing_application(self) -> None:
        config.settings.trading_execution_advisor_enabled = True
        config.settings.trading_execution_advisor_live_apply_enabled = False
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "adv": Decimal("100000"),
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "max_participation_rate": "0.05",
                        "preferred_order_type": "limit",
                        "adverse_selection_risk": "0.95",
                    },
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "1.8",
                        "depth_top5_usd": "1500000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.20",
                        "liquidity_regime": "normal",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertTrue(outcome.approved)
        self.assertEqual(outcome.decision.order_type, "market")
        self.assertEqual(outcome.advisor_metadata["applied"], False)
        self.assertEqual(
            outcome.advisor_metadata["fallback_reason"], "advisor_live_apply_disabled"
        )
        self.assertEqual(outcome.advisor_metadata["adverse_selection_risk"], None)

    def test_advisor_state_staleness_falls_back_deterministically(self) -> None:
        config.settings.trading_execution_advisor_enabled = True
        config.settings.trading_execution_advisor_max_staleness_seconds = 10
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2025-12-31T23:59:00Z",
                        "spread_bps": "3.2",
                        "depth_top5_usd": "1500000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.8",
                        "liquidity_regime": "normal",
                    },
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "max_participation_rate": "0.01",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(outcome.advisor_metadata["applied"], False)
        self.assertEqual(
            outcome.advisor_metadata["fallback_reason"], "advisor_state_stale"
        )

    def test_advisor_advice_staleness_falls_back_deterministically(self) -> None:
        config.settings.trading_execution_advisor_enabled = True
        config.settings.trading_execution_advisor_max_staleness_seconds = 10
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "3.2",
                        "depth_top5_usd": "1500000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.8",
                        "liquidity_regime": "normal",
                    },
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "event_ts": "2025-12-31T23:59:00Z",
                        "max_participation_rate": "0.01",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(outcome.advisor_metadata["applied"], False)
        self.assertEqual(
            outcome.advisor_metadata["fallback_reason"], "advisor_advice_stale"
        )

    def test_advisor_disabled_keeps_baseline_behavior(self) -> None:
        config.settings.trading_execution_advisor_enabled = False
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "execution_advice": {
                        "urgency_tier": "normal",
                        "max_participation_rate": "0.01",
                        "preferred_order_type": "limit",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertTrue(outcome.approved)
        self.assertEqual(outcome.decision.order_type, "market")
        self.assertEqual(outcome.advisor_metadata["applied"], False)
        self.assertEqual(
            outcome.advisor_metadata["fallback_reason"], "advisor_disabled"
        )

    def test_microstructure_controls_apply_limit_preference_when_stressed(self) -> None:
        config.settings.trading_execution_advisor_enabled = False
        policy = ExecutionPolicy(
            config=_config(max_participation_rate=Decimal("0.25"), prefer_limit=False)
        )
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "18",
                        "depth_top5_usd": "200000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 320,
                        "fill_hazard": "0.95",
                        "liquidity_regime": "stressed",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertTrue(outcome.microstructure_metadata["applied"])
        self.assertIn(
            "microstructure_regime_stressed",
            outcome.microstructure_metadata["tightening_reasons"],
        )

    def test_microstructure_pressure_extends_execution_seconds_and_prefers_limit(
        self,
    ) -> None:
        config.settings.trading_execution_advisor_enabled = False
        policy = ExecutionPolicy(
            config=_config(max_participation_rate=Decimal("0.25"), prefer_limit=False)
        )
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "12",
                        "depth_top5_usd": "200000",
                        "order_flow_imbalance": "0.60",
                        "latency_ms_estimate": 320,
                        "fill_hazard": "0.95",
                        "liquidity_regime": "stressed",
                    },
                }
            }
        )

        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )

        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertTrue(outcome.microstructure_metadata["applied"])
        self.assertEqual(
            Decimal(outcome.microstructure_metadata["execution_seconds_scale"]),
            Decimal("1.694"),
        )
        self.assertEqual(
            outcome.impact_assumptions["inputs"].get("execution_seconds"),
            102,
        )

    def test_microstructure_crumbling_quote_pressure_tightens_validation_only(
        self,
    ) -> None:
        config.settings.trading_execution_advisor_enabled = False
        policy = ExecutionPolicy(
            config=_config(max_participation_rate=Decimal("0.25"), prefer_limit=False)
        )
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        ).model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "2",
                        "depth_top5_usd": "1500000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.20",
                        "liquidity_regime": "normal",
                        "crumbling_quote_probability": "0.82",
                        "mechanical_liquidity_withdrawal_probability": "0.78",
                    },
                }
            }
        )

        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )

        self.assertTrue(outcome.approved)
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertTrue(outcome.microstructure_metadata["applied"])
        self.assertEqual(
            outcome.microstructure_metadata["crumbling_quote_probability"],
            "0.82",
        )
        self.assertEqual(
            outcome.microstructure_metadata[
                "mechanical_liquidity_withdrawal_probability"
            ],
            "0.78",
        )
        self.assertEqual(
            Decimal(outcome.microstructure_metadata["participation_rate_scale"]),
            Decimal("0.4225"),
        )
        self.assertEqual(
            Decimal(outcome.microstructure_metadata["execution_seconds_scale"]),
            Decimal("1.3225"),
        )
        self.assertEqual(
            outcome.impact_assumptions["inputs"].get("execution_seconds"),
            79,
        )
        self.assertIn(
            "microstructure_crumbling_quote_probability_above_pressure",
            outcome.microstructure_metadata["tightening_reasons"],
        )
        self.assertIn(
            "microstructure_mechanical_liquidity_withdrawal_above_pressure",
            outcome.microstructure_metadata["tightening_reasons"],
        )
        params_update = outcome.params_update()
        self.assertEqual(
            params_update["execution_microstructure"]["crumbling_quote_probability"],
            "0.82",
        )

    def test_microstructure_missing_state_falls_back_to_baseline_safely(self) -> None:
        config.settings.trading_execution_advisor_enabled = False
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "18",
                        "depth_top5_usd": "not-a-number",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 320,
                        "fill_hazard": "0.95",
                        "liquidity_regime": "stressed",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(
            outcome.microstructure_metadata["fallback_reason"],
            "microstructure_state_unavailable",
        )
        self.assertIn("execution_microstructure", outcome.params_update())

    def test_microstructure_state_staleness_falls_back_to_baseline_safely(self) -> None:
        config.settings.trading_execution_advisor_enabled = False
        config.settings.trading_execution_advisor_max_staleness_seconds = 10
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"),
            price=Decimal("100"),
            order_type="market",
            action="buy",
        ).model_copy(
            update={
                "event_ts": datetime(2026, 1, 1, 0, 1, 0, tzinfo=timezone.utc),
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "AAPL",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "8",
                        "depth_top5_usd": "200000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.45",
                        "liquidity_regime": "normal",
                    },
                },
            }
        )

        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )

        self.assertEqual(outcome.decision.order_type, "market")
        self.assertEqual(
            outcome.microstructure_metadata["fallback_reason"],
            "microstructure_state_stale",
        )
        self.assertFalse(outcome.microstructure_metadata["applied"])
        self.assertIn("execution_microstructure", outcome.params_update())

    def test_microstructure_symbol_mismatch_does_not_block_adaptive_policy(
        self,
    ) -> None:
        config.settings.trading_execution_advisor_enabled = False
        policy = ExecutionPolicy(
            config=_config(max_participation_rate=Decimal("0.25"), prefer_limit=False)
        )
        adaptive_policy = AdaptiveExecutionPolicyDecision(
            key="AAPL:trend",
            symbol="AAPL",
            regime_label="trend",
            sample_size=6,
            adaptive_samples=6,
            baseline_slippage_bps=Decimal("3"),
            recent_slippage_bps=Decimal("2"),
            baseline_shortfall_notional=Decimal("1"),
            recent_shortfall_notional=Decimal("20"),
            effect_size_bps=Decimal("1"),
            degradation_bps=Decimal("1"),
            expected_shortfall_coverage=Decimal("1"),
            expected_shortfall_sample_count=6,
            fallback_active=False,
            fallback_reason=None,
            prefer_limit=True,
            participation_rate_scale=Decimal("0.75"),
            execution_seconds_scale=Decimal("1.4"),
            aggressiveness="defensive",
            generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        ).model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "microstructure_state": {
                        "schema_version": "microstructure_state_v1",
                        "symbol": "MSFT",
                        "event_ts": "2026-01-01T00:00:00Z",
                        "spread_bps": "8",
                        "depth_top5_usd": "200000",
                        "order_flow_imbalance": "0.10",
                        "latency_ms_estimate": 20,
                        "fill_hazard": "0.45",
                        "liquidity_regime": "normal",
                    },
                }
            }
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
            adaptive_policy=adaptive_policy,
        )

        self.assertFalse(outcome.microstructure_metadata["applied"])
        self.assertEqual(
            outcome.microstructure_metadata["fallback_reason"],
            "microstructure_state_unavailable",
        )
        self.assertEqual(outcome.adaptive.decision.prefer_limit, True)
        self.assertEqual(outcome.adaptive.decision.aggressiveness, "defensive")
        self.assertTrue(outcome.adaptive.applied)
        self.assertEqual(outcome.decision.order_type, "limit")

    def test_adaptive_policy_fallback_is_respected_as_safe_default(self) -> None:
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.1")))
        adaptive_policy = AdaptiveExecutionPolicyDecision(
            key="AAPL:trend",
            symbol="AAPL",
            regime_label="trend",
            sample_size=6,
            adaptive_samples=6,
            baseline_slippage_bps=Decimal("8"),
            recent_slippage_bps=Decimal("16"),
            baseline_shortfall_notional=Decimal("1"),
            recent_shortfall_notional=Decimal("4"),
            effect_size_bps=Decimal("-8"),
            degradation_bps=Decimal("9"),
            expected_shortfall_coverage=Decimal("0.2"),
            expected_shortfall_sample_count=2,
            fallback_active=True,
            fallback_reason="adaptive_policy_expected_shortfall_coverage_low",
            prefer_limit=True,
            participation_rate_scale=Decimal("0.75"),
            execution_seconds_scale=Decimal("1.4"),
            aggressiveness="defensive",
            generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )

        outcome = policy.evaluate(
            _decision(qty=Decimal("1"), price=Decimal("100"), order_type="market"),
            strategy=None,
            positions=[],
            market_snapshot=None,
            adaptive_policy=adaptive_policy,
        )

        self.assertFalse(outcome.adaptive.applied)
        self.assertEqual(
            outcome.adaptive.decision.fallback_reason,
            "adaptive_policy_expected_shortfall_coverage_low",
        )
        self.assertEqual(outcome.decision.order_type, "market")
        self.assertEqual(outcome.adaptive.decision.prefer_limit, True)

    def test_adaptive_policy_shortfall_pressure_switches_to_defensive_limit(
        self,
    ) -> None:
        policy = ExecutionPolicy(
            config=_config(max_participation_rate=Decimal("0.2"), prefer_limit=False)
        )
        adaptive_policy = AdaptiveExecutionPolicyDecision(
            key="AAPL:trend",
            symbol="AAPL",
            regime_label="trend",
            sample_size=6,
            adaptive_samples=6,
            baseline_slippage_bps=Decimal("3"),
            recent_slippage_bps=Decimal("2"),
            baseline_shortfall_notional=Decimal("1"),
            recent_shortfall_notional=Decimal("18"),
            effect_size_bps=Decimal("1"),
            degradation_bps=Decimal("1"),
            expected_shortfall_coverage=Decimal("1"),
            expected_shortfall_sample_count=6,
            fallback_active=False,
            fallback_reason=None,
            prefer_limit=True,
            participation_rate_scale=Decimal("0.75"),
            execution_seconds_scale=Decimal("1.4"),
            aggressiveness="defensive",
            generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )

        outcome = policy.evaluate(
            _decision(qty=Decimal("1"), price=Decimal("100"), order_type="market"),
            strategy=None,
            positions=[],
            market_snapshot=None,
            adaptive_policy=adaptive_policy,
        )

        self.assertTrue(outcome.adaptive.applied)
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertTrue(outcome.adaptive.decision.prefer_limit)
        self.assertEqual(outcome.adaptive.decision.aggressiveness, "defensive")

    def test_adaptive_offensive_execution_scale_applies_with_neutral_microstructure(
        self,
    ) -> None:
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.2")))
        adaptive_policy = AdaptiveExecutionPolicyDecision(
            key="AAPL:trend",
            symbol="AAPL",
            regime_label="trend",
            sample_size=6,
            adaptive_samples=6,
            baseline_slippage_bps=Decimal("8"),
            recent_slippage_bps=Decimal("3"),
            baseline_shortfall_notional=Decimal("1"),
            recent_shortfall_notional=Decimal("0.5"),
            effect_size_bps=Decimal("-2"),
            degradation_bps=Decimal("1"),
            expected_shortfall_coverage=Decimal("1"),
            expected_shortfall_sample_count=6,
            fallback_active=False,
            fallback_reason=None,
            prefer_limit=False,
            participation_rate_scale=Decimal("1"),
            execution_seconds_scale=Decimal("0.85"),
            aggressiveness="offensive",
            generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )

        outcome = policy.evaluate(
            _decision(qty=Decimal("1"), price=Decimal("100"), order_type="market"),
            strategy=None,
            positions=[],
            market_snapshot=None,
            adaptive_policy=adaptive_policy,
        )

        self.assertTrue(outcome.adaptive.applied)
        self.assertEqual(outcome.impact_assumptions["inputs"]["execution_seconds"], 51)

    def test_near_zero_or_invalid_execution_scale_is_safely_clamped(self) -> None:
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.2")))
        adaptive_policy = AdaptiveExecutionPolicyDecision(
            key="AAPL:trend",
            symbol="AAPL",
            regime_label="trend",
            sample_size=6,
            adaptive_samples=6,
            baseline_slippage_bps=Decimal("8"),
            recent_slippage_bps=Decimal("3"),
            baseline_shortfall_notional=Decimal("1"),
            recent_shortfall_notional=Decimal("0.5"),
            effect_size_bps=Decimal("-2"),
            degradation_bps=Decimal("1"),
            expected_shortfall_coverage=Decimal("1"),
            expected_shortfall_sample_count=6,
            fallback_active=False,
            fallback_reason=None,
            prefer_limit=False,
            participation_rate_scale=Decimal("1"),
            execution_seconds_scale=Decimal("0"),
            aggressiveness="offensive",
            generated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )

        decision = _decision(
            qty=Decimal("1"), price=Decimal("100"), order_type="market"
        ).model_copy(
            update={"params": {"price": Decimal("100"), "execution_seconds": 5}}
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
            adaptive_policy=adaptive_policy,
        )

        self.assertTrue(outcome.adaptive.applied)
        self.assertEqual(outcome.impact_assumptions["inputs"]["execution_seconds"], 10)
