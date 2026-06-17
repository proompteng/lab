from __future__ import annotations

from tests.execution_policy.support import (
    Decimal,
    ExecutionPolicy,
    MarketSnapshot,
    _TestExecutionPolicyBase,
    _config,
    _decision,
    _with_simple_lane_quantity_resolution,
    config,
)


class TestKillSwitchBlocks(_TestExecutionPolicyBase):
    def test_kill_switch_blocks(self) -> None:
        policy = ExecutionPolicy(config=_config(kill_switch_enabled=True))
        outcome = policy.evaluate(
            _decision(), strategy=None, positions=[], market_snapshot=None
        )
        self.assertFalse(outcome.approved)
        self.assertIn("kill_switch_enabled", outcome.reasons)

    def test_kill_switch_blocks_even_with_allocator_approved_metadata(self) -> None:
        policy = ExecutionPolicy(config=_config(kill_switch_enabled=True))
        decision = _decision()
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "allocator": {"status": "approved", "reason_codes": []},
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertFalse(outcome.approved)
        self.assertIn("kill_switch_enabled", outcome.reasons)

    def test_shorts_blocked_when_disabled(self) -> None:
        policy = ExecutionPolicy(config=_config(allow_shorts=False))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("5")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("shorts_not_allowed", outcome.reasons)

    def test_max_notional_enforced(self) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        outcome = policy.evaluate(
            _decision(qty=Decimal("2"), price=Decimal("75")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("max_notional_exceeded", outcome.reasons)

    def test_max_notional_does_not_block_position_reducing_sell(self) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("184"), price=Decimal("272.3")),
            strategy=None,
            positions=[{"symbol": "AAPL", "qty": "184", "side": "long"}],
            market_snapshot=None,
        )

        self.assertTrue(outcome.approved)
        self.assertNotIn("max_notional_exceeded", outcome.reasons)

    def test_max_notional_does_not_block_position_reducing_sell_with_broker_symbol_format(
        self,
    ) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("184"), price=Decimal("272.3")),
            strategy=None,
            positions=[{"symbol": " aapl ", "qty": "184", "side": "long"}],
            market_snapshot=None,
        )

        self.assertTrue(outcome.approved)
        self.assertNotIn("max_notional_exceeded", outcome.reasons)

    def test_max_notional_does_not_block_prechecked_reducing_sell_when_snapshot_missing(
        self,
    ) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        decision = _decision(
            action="sell",
            qty=Decimal("184.0000"),
            price=Decimal("273.97"),
        )
        decision = _with_simple_lane_quantity_resolution(
            decision,
            short_increasing="off",
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )

        self.assertTrue(outcome.approved)
        self.assertNotIn("max_notional_exceeded", outcome.reasons)
        self.assertNotIn("shorts_not_allowed", outcome.reasons)

    def test_max_notional_still_blocks_unmatched_prechecked_reducing_sell(
        self,
    ) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        decision = _decision(
            action="sell",
            qty=Decimal("184.0000"),
            price=Decimal("273.97"),
        )
        decision = _with_simple_lane_quantity_resolution(decision, symbol="MSFT")

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )

        self.assertFalse(outcome.approved)
        self.assertIn("max_notional_exceeded", outcome.reasons)

    def test_max_notional_still_blocks_invalid_prechecked_reducing_metadata(
        self,
    ) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        base_decision = _decision(
            action="sell",
            qty=Decimal("184.0000"),
            price=Decimal("273.97"),
        )
        cases: list[dict[str, object]] = [
            {"action": "buy"},
            {"position_qty": "100"},
            {"requested_qty": "100"},
            {"short_increasing": "yes"},
            {"short_increasing": None},
        ]

        for overrides in cases:
            with self.subTest(overrides=overrides):
                outcome = policy.evaluate(
                    _with_simple_lane_quantity_resolution(base_decision, **overrides),
                    strategy=None,
                    positions=[],
                    market_snapshot=None,
                )

                self.assertFalse(outcome.approved)
                self.assertIn("max_notional_exceeded", outcome.reasons)

    def test_max_notional_ignores_non_mapping_prechecked_resolution(
        self,
    ) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        decision = _decision(
            action="sell",
            qty=Decimal("184.0000"),
            price=Decimal("273.97"),
        )
        params = dict(decision.params)
        params["simple_lane"] = {"quantity_resolution": "not-a-resolution"}

        outcome = policy.evaluate(
            decision.model_copy(update={"params": params}),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )

        self.assertFalse(outcome.approved)
        self.assertIn("max_notional_exceeded", outcome.reasons)

    def test_prechecked_reducing_sell_ignores_non_positive_qty(
        self,
    ) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        decision = _with_simple_lane_quantity_resolution(
            _decision(action="sell", qty=Decimal("0"), price=Decimal("273.97")),
            requested_qty="0",
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )

        self.assertFalse(outcome.approved)
        self.assertIn("qty_non_positive", outcome.reasons)

    def test_max_notional_does_not_block_short_cover(self) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        outcome = policy.evaluate(
            _decision(action="buy", qty=Decimal("184"), price=Decimal("272.3")),
            strategy=None,
            positions=[{"symbol": "AAPL", "qty": "184", "side": "short"}],
            market_snapshot=None,
        )

        self.assertTrue(outcome.approved)
        self.assertNotIn("max_notional_exceeded", outcome.reasons)

    def test_max_notional_still_blocks_position_increasing_sell(self) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("100")))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("185"), price=Decimal("272.3")),
            strategy=None,
            positions=[{"symbol": "AAPL", "qty": "184", "side": "long"}],
            market_snapshot=None,
        )

        self.assertFalse(outcome.approved)
        self.assertIn("max_notional_exceeded", outcome.reasons)

    def test_price_snapshot_drives_notional_when_signal_price_is_stale(self) -> None:
        policy = ExecutionPolicy(config=_config(max_notional=Decimal("1000")))
        decision = _decision(qty=Decimal("3"), price=Decimal("412.6704331378219"))
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("412.6704331378219"),
                    "price_snapshot": {
                        "price": "316.93",
                        "source": "ta_microbars",
                        "as_of": "2026-03-31T13:38:20+00:00",
                    },
                }
            }
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=MarketSnapshot(
                symbol="AAPL",
                as_of=decision.event_ts,
                price=Decimal("316.93"),
                spread=None,
                source="ta_microbars",
            ),
        )

        self.assertTrue(outcome.approved)
        self.assertEqual(outcome.notional, Decimal("950.79"))
        self.assertNotIn("max_notional_exceeded", outcome.reasons)

    def test_min_notional_enforced(self) -> None:
        policy = ExecutionPolicy(config=_config(min_notional=Decimal("250")))
        outcome = policy.evaluate(
            _decision(qty=Decimal("2"), price=Decimal("100")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("min_notional_not_met", outcome.reasons)

    def test_crypto_fractional_qty_allowed(self) -> None:
        policy = ExecutionPolicy(config=_config(min_notional=Decimal("250")))
        decision = _decision(qty=Decimal("0.01000000"), price=Decimal("50000"))
        decision = decision.model_copy(update={"symbol": "BTC/USD"})
        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertTrue(outcome.approved)
        self.assertNotIn("qty_below_min", outcome.reasons)

    def test_equity_fractional_qty_rejected_as_invalid_increment(self) -> None:
        policy = ExecutionPolicy(config=_config())
        outcome = policy.evaluate(
            _decision(qty=Decimal("0.5"), price=Decimal("100")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("qty_below_min", outcome.reasons)

    def test_qty_below_min_uses_allocator_limiting_constraint_reason(self) -> None:
        policy = ExecutionPolicy(config=_config())
        decision = _decision(qty=Decimal("0.5"), price=Decimal("100"))
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "portfolio_sizing": {
                        "output": {
                            "limiting_constraint": "symbol_capacity_exhausted",
                        }
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("symbol_capacity_exhausted", outcome.reasons)
        self.assertNotIn("qty_below_min", outcome.reasons)

    def test_qty_below_min_falls_back_for_unknown_limiting_constraint(self) -> None:
        policy = ExecutionPolicy(config=_config())
        decision = _decision(qty=Decimal("0.5"), price=Decimal("100"))
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "portfolio_sizing": {
                        "output": {
                            "limiting_constraint": "insufficient_edge",
                        }
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("qty_below_min", outcome.reasons)

    def test_equity_fractional_qty_allowed_for_longs_when_enabled(self) -> None:
        config.settings.trading_fractional_equities_enabled = True
        policy = ExecutionPolicy(config=_config())
        outcome = policy.evaluate(
            _decision(qty=Decimal("0.5"), price=Decimal("100")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertTrue(outcome.approved)
        self.assertNotIn("qty_below_min", outcome.reasons)

    def test_equity_fractional_short_increasing_sell_rejected_when_enabled(
        self,
    ) -> None:
        config.settings.trading_fractional_equities_enabled = True
        policy = ExecutionPolicy(config=_config(allow_shorts=True))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("0.5"), price=Decimal("100")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertFalse(outcome.approved)
        self.assertIn("qty_below_min", outcome.reasons)

    def test_equity_fractional_sell_to_reduce_long_allowed_when_enabled(self) -> None:
        config.settings.trading_fractional_equities_enabled = True
        policy = ExecutionPolicy(config=_config(allow_shorts=True))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("0.5"), price=Decimal("100")),
            strategy=None,
            positions=[{"symbol": "AAPL", "qty": "1", "side": "long"}],
            market_snapshot=None,
        )
        self.assertTrue(outcome.approved)
        self.assertNotIn("qty_below_min", outcome.reasons)

    def test_approved_orders_stay_within_caps(self) -> None:
        policy = ExecutionPolicy(
            config=_config(
                max_notional=Decimal("300"),
                max_participation_rate=Decimal("0.25"),
            )
        )
        decision = _decision(qty=Decimal("2"), price=Decimal("100"))
        decision = decision.model_copy(
            update={"params": {"price": Decimal("100"), "adv": Decimal("2000")}}
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertTrue(outcome.approved)
        self.assertIsNotNone(outcome.notional)
        self.assertIsNotNone(outcome.participation_rate)
        self.assertLessEqual(outcome.notional or Decimal("0"), Decimal("300"))
        self.assertLessEqual(
            outcome.participation_rate or Decimal("0"), Decimal("0.25")
        )

    def test_participation_cap_enforced(self) -> None:
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.1")))
        decision = _decision(qty=Decimal("200"), price=Decimal("10"))
        decision = decision.model_copy(
            update={"params": {"price": Decimal("10"), "adv": Decimal("1000")}}
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertFalse(outcome.approved)
        self.assertIn("participation_exceeds_max", outcome.reasons)

    def test_allocator_participation_override_only_tightens(self) -> None:
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.5")))
        decision = _decision(qty=Decimal("200"), price=Decimal("10"))
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("10"),
                    "adv": Decimal("1000"),
                    "allocator": {"max_participation_rate_override": "0.1"},
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertFalse(outcome.approved)
        self.assertIn("participation_exceeds_max", outcome.reasons)

    def test_sell_to_reduce_long_position_allowed_with_no_shorts(self) -> None:
        policy = ExecutionPolicy(config=_config(allow_shorts=False))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("2")),
            strategy=None,
            positions=[{"symbol": "AAPL", "qty": "5", "side": "long"}],
            market_snapshot=None,
        )
        self.assertTrue(outcome.approved)
        self.assertNotIn("shorts_not_allowed", outcome.reasons)

    def test_shorts_allowed_when_enabled(self) -> None:
        policy = ExecutionPolicy(config=_config(allow_shorts=True))
        outcome = policy.evaluate(
            _decision(action="sell", qty=Decimal("2")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertTrue(outcome.approved)
        self.assertNotIn("shorts_not_allowed", outcome.reasons)

    def test_retry_backoff_schedule_sanitized_and_capped(self) -> None:
        policy = ExecutionPolicy(
            config=_config(
                max_retries=4,
                backoff_base_seconds=-1.0,
                backoff_multiplier=0.5,
                backoff_max_seconds=0.25,
            )
        )
        outcome = policy.evaluate(
            _decision(), strategy=None, positions=[], market_snapshot=None
        )
        self.assertEqual(outcome.retry_delays, [0.1, 0.1, 0.1, 0.1])

    def test_impact_assumptions_recorded(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        outcome = policy.evaluate(
            _decision(qty=Decimal("1"), price=Decimal("25")),
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        assumptions = outcome.impact_assumptions
        self.assertIn("model", assumptions)
        self.assertIn("inputs", assumptions)
        self.assertIn("estimate", assumptions)
        self.assertEqual(outcome.decision.order_type, "limit")

    def test_near_touch_prices_are_quantized_to_tick_size(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        decision = _decision(
            action="buy",
            qty=Decimal("1"),
            price=Decimal("635.815"),
            order_type="market",
        )
        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertEqual(outcome.decision.limit_price, Decimal("635.82"))

    def test_high_conviction_breakout_entry_keeps_market_order(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        decision = _decision(
            action="buy",
            qty=Decimal("1"),
            price=Decimal("635.815"),
            order_type="market",
        ).model_copy(
            update={
                "params": {
                    "price": Decimal("635.815"),
                    "spread": Decimal("0.20"),
                    "execution_features": {
                        "spread_bps": Decimal("3.15"),
                        "recent_microprice_bias_bps_avg": Decimal("0.20"),
                        "cross_section_continuation_rank": Decimal("0.82"),
                    },
                    "strategy_runtime": {
                        "source_strategy_runtime": [
                            {"strategy_type": "breakout_continuation_long_v1"}
                        ]
                    },
                }
            }
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )

        self.assertEqual(outcome.decision.order_type, "market")
        self.assertIsNone(outcome.decision.limit_price)

    def test_high_conviction_washout_entry_keeps_market_order(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        decision = _decision(
            action="buy",
            qty=Decimal("1"),
            price=Decimal("316.93"),
            order_type="market",
        ).model_copy(
            update={
                "params": {
                    "price": Decimal("316.93"),
                    "spread": Decimal("0.20"),
                    "execution_features": {
                        "spread_bps": Decimal("6.31"),
                        "recent_microprice_bias_bps_avg": Decimal("0.06"),
                        "cross_section_reversal_rank": Decimal("0.72"),
                    },
                    "strategy_runtime": {
                        "source_strategy_runtime": [
                            {"strategy_type": "washout_rebound_long_v1"}
                        ]
                    },
                }
            }
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )

        self.assertEqual(outcome.decision.order_type, "market")
        self.assertIsNone(outcome.decision.limit_price)

    def test_microbar_cross_sectional_short_entry_keeps_market_order(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        decision = _decision(
            action="sell",
            qty=Decimal("1"),
            price=Decimal("524.995"),
            order_type="market",
        ).model_copy(
            update={
                "rationale": "microbar_cross_sectional_entry,rank=1",
                "params": {
                    "price": Decimal("524.995"),
                    "spread": Decimal("0.20"),
                    "execution_features": {
                        "spread_bps": Decimal("3.81"),
                    },
                    "strategy_runtime": {
                        "source_strategy_runtime": [
                            {"strategy_type": "microbar_cross_sectional_short_v1"}
                        ]
                    },
                },
            }
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )

        self.assertEqual(outcome.decision.order_type, "market")
        self.assertIsNone(outcome.decision.limit_price)

    def test_microbar_cross_sectional_pairs_entry_keeps_market_order(self) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        decision = _decision(
            action="buy",
            qty=Decimal("1"),
            price=Decimal("189.24"),
            order_type="market",
        ).model_copy(
            update={
                "rationale": "microbar_cross_sectional_pair_entry,pair_side:high_rank",
                "params": {
                    "price": Decimal("189.24"),
                    "spread": Decimal("0.04"),
                    "execution_features": {
                        "spread_bps": Decimal("2.11"),
                    },
                    "strategy_runtime": {
                        "source_strategy_runtime": [
                            {"strategy_type": "microbar_cross_sectional_pairs_v1"}
                        ]
                    },
                },
            }
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )

        self.assertEqual(outcome.decision.order_type, "market")
        self.assertIsNone(outcome.decision.limit_price)

    def test_microbar_cross_sectional_pairs_signal_exit_keeps_market_order(
        self,
    ) -> None:
        policy = ExecutionPolicy(config=_config(prefer_limit=True))
        decision = _decision(
            action="sell",
            qty=Decimal("1"),
            price=Decimal("189.24"),
            order_type="market",
        ).model_copy(
            update={
                "rationale": "microbar_cross_sectional_pair_exit,pair_side:high_rank",
                "params": {
                    "price": Decimal("189.24"),
                    "spread": Decimal("0.04"),
                    "execution_features": {
                        "spread_bps": Decimal("2.11"),
                    },
                    "position_exit": {
                        "type": "runtime_signal_exit",
                        "position_side": "long",
                        "source": "strategy_runtime",
                    },
                    "strategy_runtime": {
                        "source_strategy_runtime": [
                            {"strategy_type": "microbar_cross_sectional_pairs_v1"}
                        ]
                    },
                },
            }
        )

        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[{"symbol": "AAPL", "qty": Decimal("1")}],
            market_snapshot=None,
        )

        self.assertEqual(outcome.decision.order_type, "market")
        self.assertIsNone(outcome.decision.limit_price)

    def test_limit_and_stop_prices_are_quantized(self) -> None:
        decision = _decision(
            action="sell",
            qty=Decimal("10"),
            order_type="limit",
            price=Decimal("120.1234"),
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("120.1234"),
                    "limit_price": Decimal("120.1234"),
                    "spread": Decimal("0.020"),
                }
            }
        )
        policy = ExecutionPolicy(config=_config(prefer_limit=False))
        outcome = policy.evaluate(
            decision,
            strategy=None,
            positions=[],
            market_snapshot=None,
        )
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertEqual(outcome.decision.limit_price, Decimal("120.12"))

    def test_advisor_tightens_participation_and_order_type_only(self) -> None:
        config.settings.trading_execution_advisor_enabled = True
        policy = ExecutionPolicy(config=_config(max_participation_rate=Decimal("0.25")))
        decision = _decision(
            qty=Decimal("10"), price=Decimal("100"), order_type="market"
        )
        decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "adv": Decimal("100000"),
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
                        "max_participation_rate": "0.05",
                        "preferred_order_type": "limit",
                        "adverse_selection_risk": "0.20",
                    },
                }
            }
        )
        outcome = policy.evaluate(
            decision, strategy=None, positions=[], market_snapshot=None
        )
        self.assertTrue(outcome.approved)
        self.assertEqual(outcome.decision.order_type, "limit")
        self.assertEqual(outcome.advisor_metadata["applied"], True)
        self.assertEqual(outcome.advisor_metadata["max_participation_rate"], "0.05")
        self.assertIn(
            "participation_rate_tightened",
            outcome.advisor_metadata["tightening_reasons"],
        )
        self.assertIn(
            "urgency_tier_bounded",
            outcome.advisor_metadata["tightening_reasons"],
        )
        params_update = outcome.params_update()
        self.assertIn("execution_advisor", params_update)

    def test_advisor_tightens_with_microstructure_signal_alias_payload(self) -> None:
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
                        "feature_quality_status": "pass",
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
        self.assertTrue(outcome.microstructure_metadata["state_valid"])
        self.assertTrue(outcome.advisor_metadata["applied"])
        self.assertIsNone(outcome.advisor_metadata["fallback_reason"])
