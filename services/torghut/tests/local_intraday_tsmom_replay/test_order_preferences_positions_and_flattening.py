from __future__ import annotations

from app.trading.economic_policy import load_economic_policy
from app.trading.quote_quality import assess_signal_quote_quality

from tests.local_intraday_tsmom_replay.support import (
    date,
    datetime,
    timezone,
    Decimal,
    patch,
    FlattenPositionsRequest,
    TransactionCostModel,
    SignalEnvelope,
    StrategyDecision,
    PendingOrder,
    PositionState,
    _SHARED_POSITION_OWNER,
    _apply_filled_decision,
    _apply_order_preferences,
    _flatten_positions,
    _init_funnel_stats,
    _positions_payload,
    _reconcile_pending_order_before_immediate_fill,
    _should_replace_pending_order,
    _TestLocalIntradayTsmomReplayBase,
)


class TestOrderPreferencesPositionsAndFlattening(_TestLocalIntradayTsmomReplayBase):
    def test_apply_filled_decision_buy_covers_existing_short(self) -> None:
        signal = self._signal(bid="522.90", ask="523.00", price="522.95")
        decision = self._decision(
            action="buy", order_type="limit", limit_price="523.00"
        )
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("523.22"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        day_bucket = {
            "decision_count": 1,
            "filled_count": 0,
            "filled_notional": Decimal("0"),
            "gross_pnl": Decimal("0"),
            "net_pnl": Decimal("0"),
            "cost_total": Decimal("0"),
            "wins": 0,
            "losses": 0,
            "closed_trades": [],
        }
        all_closed_trades: list[object] = []

        cash = _apply_filled_decision(
            decision=decision,
            signal=signal,
            fill_price=Decimal("523.00"),
            filled_at=signal.event_ts,
            created_at=signal.event_ts,
            positions=positions,
            day_bucket=day_bucket,
            cost_model=TransactionCostModel(),
            cash=Decimal("15231.20"),
            all_closed_trades=all_closed_trades,
        )

        self.assertNotIn(("META", _SHARED_POSITION_OWNER), positions)
        self.assertEqual(day_bucket["filled_count"], 1)
        self.assertGreater(day_bucket["gross_pnl"], Decimal("0"))
        self.assertGreater(day_bucket["net_pnl"], Decimal("0"))
        self.assertEqual(day_bucket["wins"], 1)
        self.assertEqual(len(all_closed_trades), 1)
        self.assertLess(cash, Decimal("15231.20"))

    def test_quote_quality_rejects_wide_spread_outlier(self) -> None:
        signal = self._signal(bid="239.11", ask="253.69", price="246.40")
        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("253.70"),
            policy=load_economic_policy().quote_quality_policy(),
        )

        self.assertFalse(status.valid)
        self.assertEqual(status.reason, "spread_bps_exceeded")

    def test_quote_quality_accepts_normal_tight_quote(self) -> None:
        signal = self._signal(bid="253.69", ask="253.72", price="253.705")
        status = assess_signal_quote_quality(
            signal=signal,
            previous_price=Decimal("253.68"),
            policy=load_economic_policy().quote_quality_policy(),
        )

        self.assertTrue(status.valid)

    def test_session_flatten_exit_keeps_market_order(self) -> None:
        decision = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="session_flatten_exit",
            params={"position_exit": {"type": "session_flatten_minute_utc"}},
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "market")
        self.assertIsNone(updated.limit_price)

    def test_high_conviction_breakout_entry_keeps_market_order(self) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="breakout_entry",
            params={
                "execution_features": {
                    "spread_bps": Decimal("4"),
                    "recent_microprice_bias_bps_avg": Decimal("0.20"),
                    "cross_section_continuation_rank": Decimal("0.82"),
                },
                "strategy_runtime": {
                    "source_strategy_runtime": [
                        {"strategy_type": "breakout_continuation_long_v1"}
                    ]
                },
            },
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "market")
        self.assertIsNone(updated.limit_price)

    def test_candidate_prefer_limit_converts_market_entry_when_global_default_false(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="ordinary_entry",
            params={"entry_order_type": "prefer_limit"},
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        with patch(
            "scripts.intraday_tsmom_replay.order_lifecycle.settings.trading_execution_prefer_limit",
            False,
        ):
            updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "limit")
        self.assertEqual(updated.limit_price, Decimal("525.10"))

    def test_strategy_params_can_drive_candidate_order_preference(self) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="ordinary_entry",
            params={},
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        with patch(
            "scripts.intraday_tsmom_replay.order_lifecycle.settings.trading_execution_prefer_limit",
            False,
        ):
            updated = _apply_order_preferences(
                decision,
                signal,
                strategy_params={"entry_order_type": "prefer_limit"},
            )

        self.assertEqual(updated.order_type, "limit")
        self.assertEqual(updated.limit_price, Decimal("525.10"))

    def test_candidate_market_order_type_keeps_market_when_global_prefer_limit_true(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="ordinary_entry",
            params={"entry_order_type": "market"},
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        with patch(
            "scripts.intraday_tsmom_replay.order_lifecycle.settings.trading_execution_prefer_limit",
            True,
        ):
            updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "market")
        self.assertIsNone(updated.limit_price)

    def test_candidate_market_order_spread_cap_overrides_high_conviction_exception(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="breakout-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="breakout_entry",
            params={
                "entry_order_type": "prefer_limit",
                "market_order_spread_bps_max": "2",
                "execution_features": {
                    "spread_bps": Decimal("4"),
                    "recent_microprice_bias_bps_avg": Decimal("0.20"),
                    "cross_section_continuation_rank": Decimal("0.82"),
                },
                "strategy_runtime": {
                    "source_strategy_runtime": [
                        {"strategy_type": "breakout_continuation_long_v1"}
                    ]
                },
            },
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "limit")
        self.assertEqual(updated.limit_price, Decimal("525.10"))

    def test_microbar_cross_sectional_short_entry_keeps_market_order(self) -> None:
        decision = StrategyDecision(
            strategy_id="short-cross-row-id",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 13, 30, 1, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="microbar_cross_sectional_entry,rank=1",
            params={
                "execution_features": {
                    "spread_bps": Decimal("4"),
                },
                "strategy_runtime": {
                    "source_strategy_runtime": [
                        {"strategy_type": "microbar_cross_sectional_short_v1"}
                    ]
                },
            },
        )
        signal = self._signal(bid="524.90", ask="525.10", price="525.00")

        updated = _apply_order_preferences(decision, signal)

        self.assertEqual(updated.order_type, "market")
        self.assertIsNone(updated.limit_price)

    def test_session_flatten_exit_replaces_resting_sell_limit(self) -> None:
        existing = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("524.10"),
            rationale="signal_exit",
            params={"position_exit": {"type": "signal_exit"}},
        )
        replacement = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 30, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="session_flatten_exit",
            params={"position_exit": {"type": "session_flatten_minute_utc"}},
        )

        should_replace = _should_replace_pending_order(
            existing=existing,
            replacement=replacement,
        )

        self.assertTrue(should_replace)

    def test_more_aggressive_sell_limit_replaces_resting_sell_limit(self) -> None:
        existing = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("524.10"),
            rationale="signal_exit",
            params={"position_exit": {"type": "signal_exit"}},
        )
        replacement = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 12, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("10"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.80"),
            rationale="signal_exit",
            params={"position_exit": {"type": "signal_exit"}},
        )

        should_replace = _should_replace_pending_order(
            existing=existing,
            replacement=replacement,
        )

        self.assertTrue(should_replace)

    def test_buy_market_replaces_same_priority_resting_buy_limit(self) -> None:
        existing = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 11, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.80"),
            rationale="entry",
            params={},
        )
        replacement = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 19, 12, 0, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("10"),
            order_type="market",
            time_in_force="day",
            rationale="entry",
            params={},
        )

        should_replace = _should_replace_pending_order(
            existing=existing,
            replacement=replacement,
        )

        self.assertTrue(should_replace)

    def test_immediate_fill_clears_existing_pending_order_for_same_position_owner(
        self,
    ) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        existing_pending = PendingOrder(
            decision=self._decision(
                action="buy", order_type="limit", limit_price="523.10"
            ),
            created_at=datetime(2026, 3, 27, 17, 29, 55, tzinfo=timezone.utc),
            signal=signal,
        )
        pending_orders = {("META", _SHARED_POSITION_OWNER): existing_pending}
        immediate_decision = self._decision(
            action="buy", order_type="limit", limit_price="523.40"
        )

        _reconcile_pending_order_before_immediate_fill(
            decision=immediate_decision,
            pending_orders=pending_orders,
            created_at=signal.event_ts,
        )

        self.assertNotIn(("META", _SHARED_POSITION_OWNER), pending_orders)

    def test_positions_payload_projects_pending_buy_exposure(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_buy = PendingOrder(
            decision=self._decision(
                action="buy", order_type="limit", limit_price="523.40"
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            {},
            {},
            {("META", _SHARED_POSITION_OWNER): pending_buy},
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": _SHARED_POSITION_OWNER,
                    "qty": "10",
                    "side": "long",
                    "market_value": "5234.00",
                    "avg_entry_price": "523.40",
                    "opened_at": signal.event_ts.isoformat(),
                    "decision_at": pending_buy.created_at.isoformat(),
                    "pending_entry": True,
                }
            ],
        )

    def test_positions_payload_projects_pending_sell_against_existing_long(
        self,
    ) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("10"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_sell = PendingOrder(
            decision=self._decision(
                action="sell", order_type="limit", limit_price="523.10"
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_sell},
        )

        self.assertEqual(payload, [])

    def test_positions_payload_projects_pending_short_entry(self) -> None:
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_sell = PendingOrder(
            decision=self._decision(
                action="sell", order_type="limit", limit_price="523.22"
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            {},
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_sell},
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": _SHARED_POSITION_OWNER,
                    "qty": "10",
                    "side": "short",
                    "market_value": "-5232.50",
                    "avg_entry_price": "523.22",
                    "opened_at": signal.event_ts.isoformat(),
                    "decision_at": pending_sell.created_at.isoformat(),
                    "pending_entry": True,
                }
            ],
        )

    def test_positions_payload_projects_pending_buy_cover_against_existing_short(
        self,
    ) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_buy = PendingOrder(
            decision=self._decision(
                action="buy", order_type="limit", limit_price="523.28"
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_buy},
        )

        self.assertEqual(payload, [])

    def test_positions_payload_projects_partial_pending_buy_cover_against_existing_short(
        self,
    ) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        partial_cover = StrategyDecision(
            strategy_id="intraday_tsmom_v1@prod",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="buy",
            qty=Decimal("4"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.28"),
            rationale="test",
            params={},
        )
        pending_buy = PendingOrder(
            decision=partial_cover,
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_buy},
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": _SHARED_POSITION_OWNER,
                    "qty": "6",
                    "side": "short",
                    "market_value": "-3139.50",
                    "avg_entry_price": "520",
                    "opened_at": "2026-03-27T17:00:00+00:00",
                    "decision_at": "2026-03-27T17:00:00+00:00",
                    "pending_entry": False,
                }
            ],
        )

    def test_positions_payload_projects_pending_sell_against_existing_short(
        self,
    ) -> None:
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-5"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            )
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_sell = PendingOrder(
            decision=StrategyDecision(
                strategy_id="intraday_tsmom_v1@prod",
                symbol="META",
                event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("4"),
                order_type="limit",
                time_in_force="day",
                limit_price=Decimal("523.22"),
                rationale="test",
                params={},
            ),
            created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            signal=signal,
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {("META", _SHARED_POSITION_OWNER): pending_sell},
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": _SHARED_POSITION_OWNER,
                    "qty": "9",
                    "side": "short",
                    "market_value": "-4709.25",
                    "avg_entry_price": "521.4311111111111111111111111",
                    "opened_at": "2026-03-27T17:00:00+00:00",
                    "decision_at": "2026-03-27T17:00:00+00:00",
                    "pending_entry": False,
                }
            ],
        )

    def test_positions_payload_keeps_other_strategy_position_when_isolated_sell_pending(
        self,
    ) -> None:
        positions = {
            ("META", "breakout_continuation_long_v1@research"): PositionState(
                strategy_id="breakout_continuation_long_v1@research",
                qty=Decimal("10"),
                avg_entry_price=Decimal("520"),
                opened_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 0, 0, tzinfo=timezone.utc),
            ),
            ("META", "mean_reversion_rebound_long_v1@research"): PositionState(
                strategy_id="mean_reversion_rebound_long_v1@research",
                qty=Decimal("6"),
                avg_entry_price=Decimal("521"),
                opened_at=datetime(2026, 3, 27, 17, 5, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("0"),
                decision_at=datetime(2026, 3, 27, 17, 5, 0, tzinfo=timezone.utc),
            ),
        }
        signal = self._signal(bid="523.22", ask="523.28", price="523.25")
        pending_sell = StrategyDecision(
            strategy_id="mean_reversion_rebound_long_v1@research",
            symbol="META",
            event_ts=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("6"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("523.10"),
            rationale="mean_reversion_rebound_exit",
            params={"strategy_runtime": {"position_isolation_mode": "per_strategy"}},
        )

        payload = _positions_payload(
            positions,
            {"META": Decimal("523.25")},
            {
                ("META", "mean_reversion_rebound_long_v1@research"): PendingOrder(
                    decision=pending_sell,
                    created_at=datetime(2026, 3, 27, 17, 30, 3, tzinfo=timezone.utc),
                    signal=signal,
                )
            },
        )

        self.assertEqual(
            payload,
            [
                {
                    "symbol": "META",
                    "strategy_id": "breakout_continuation_long_v1@research",
                    "qty": "10",
                    "side": "long",
                    "market_value": "5232.50",
                    "avg_entry_price": "520",
                    "opened_at": "2026-03-27T17:00:00+00:00",
                    "decision_at": "2026-03-27T17:00:00+00:00",
                    "pending_entry": False,
                }
            ],
        )

    def test_flatten_positions_closes_short_and_books_pnl(self) -> None:
        day = date(2026, 4, 2)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 4, 2, 19, 59, 59, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=1,
            payload={"price": Decimal("520.50")},
        )
        positions = {
            ("META", _SHARED_POSITION_OWNER): PositionState(
                strategy_id=_SHARED_POSITION_OWNER,
                qty=Decimal("-10"),
                avg_entry_price=Decimal("523.22"),
                opened_at=datetime(2026, 4, 2, 14, 30, 0, tzinfo=timezone.utc),
                entry_cost_total=Decimal("1.00"),
                decision_at=datetime(2026, 4, 2, 14, 30, 0, tzinfo=timezone.utc),
            )
        }
        stats = _init_funnel_stats()
        stats["closed_trades"] = []
        funnel_stats: dict[tuple[str, str], dict[str, object]] = {}
        all_closed_trades: list[object] = []

        cash = _flatten_positions(
            FlattenPositionsRequest(
                day=day,
                stats=stats,
                funnel_stats=funnel_stats,
                positions=positions,
                last_signals={"META": signal},
                last_prices={"META": Decimal("520.50")},
                cost_model=TransactionCostModel(),
                all_closed_trades=all_closed_trades,
                cash=Decimal("15231.20"),
            )
        )

        self.assertEqual(positions, {})
        self.assertLess(cash, Decimal("15231.20"))
        self.assertEqual(stats["filled_count"], 1)
        self.assertGreater(stats["gross_pnl"], Decimal("0"))
        self.assertGreater(stats["net_pnl"], Decimal("0"))
        self.assertEqual(stats["wins"], 1)
        self.assertEqual(len(all_closed_trades), 1)
