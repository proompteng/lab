from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.strategy_runtime.support import (
    Decimal,
    MicrobarCrossSectionalLongPlugin,
    MicrobarCrossSectionalPairsPlugin,
    MicrobarCrossSectionalShortPlugin,
    Strategy,
    StrategyConfig,
    StrategyContext,
    StrategyDefinition,
    StrategyRegistry,
    StrategyRuntime,
    TestCase,
    _compose_strategy_description,
    _evaluate_microbar_cross_sectional,
    _microbar_entry_window_minutes,
    _microbar_exit_minute_after_open,
    _microbar_minutes_elapsed,
    _microbar_rank_thresholds,
    _microbar_universe_size,
    _test_feature_vector,
    uuid,
)


class TestStrategyRuntimeMicrobarCoverage(TestCase):
    def _context(
        self,
        *,
        params: dict[str, object] | None = None,
        event_ts: str = "2026-03-24T14:30:00+00:00",
        strategy_type: str = "microbar_cross_sectional_long_v1",
        symbol: str = "META",
        strategy_spec: dict[str, object] | None = None,
    ) -> StrategyContext:
        return StrategyContext(
            strategy_id="strategy-1",
            strategy_name="microbar-test",
            declared_strategy_id="microbar-test",
            strategy_type=strategy_type,
            strategy_version="1.0.0",
            event_ts=event_ts,
            symbol=symbol,
            timeframe="1Sec",
            params=dict(params or {}),
            trace_enabled=True,
            strategy_spec=dict(strategy_spec or {}),
        )

    def test_microbar_helper_parsers_cover_raw_fallback_and_invalid_inputs(
        self,
    ) -> None:
        context = self._context()
        self.assertEqual(
            _microbar_minutes_elapsed(
                context=self._context(event_ts="2026-03-24T14:31:00+00:00"),
                features=_test_feature_vector({"session_minutes_elapsed": "61"}),
            ),
            61,
        )
        self.assertIsNone(
            _microbar_minutes_elapsed(
                context=context,
                features=_test_feature_vector({"session_minutes_elapsed": "bad-value"}),
            )
        )
        self.assertEqual(
            _microbar_minutes_elapsed(
                context=self._context(event_ts="2026-03-24T14:35:00+00:00"),
                features=_test_feature_vector({}),
            ),
            65,
        )
        self.assertEqual(
            _microbar_minutes_elapsed(
                context=self._context(event_ts="2026-05-29T15:30:00+00:00"),
                features=_test_feature_vector({"session_minutes_elapsed": 60}),
            ),
            120,
        )
        self.assertEqual(
            _microbar_minutes_elapsed(
                context=self._context(event_ts="2026-01-05T15:30:00+00:00"),
                features=_test_feature_vector({}),
            ),
            60,
        )
        self.assertIsNone(
            _microbar_minutes_elapsed(
                context=self._context(event_ts="not-a-timestamp"),
                features=_test_feature_vector({}),
            )
        )

        self.assertIsNone(_microbar_exit_minute_after_open({}))
        self.assertIsNone(
            _microbar_exit_minute_after_open({"exit_minute_after_open": ""})
        )
        self.assertEqual(
            _microbar_exit_minute_after_open({"exit_minute_after_open": "close"}), 390
        )
        self.assertEqual(
            _microbar_exit_minute_after_open({"exit_minute_after_open": "75"}), 75
        )
        self.assertIsNone(
            _microbar_exit_minute_after_open({"exit_minute_after_open": "bad-value"})
        )
        self.assertEqual(_microbar_entry_window_minutes({}), 0)
        self.assertEqual(
            _microbar_entry_window_minutes({"entry_window_minutes": "30"}), 30
        )
        self.assertEqual(
            _microbar_entry_window_minutes({"entry_window_minutes": "-5"}), 0
        )
        self.assertEqual(
            _microbar_entry_window_minutes({"entry_window_minutes": "bad-value"}), 0
        )

    def test_microbar_universe_and_rank_threshold_helpers_cover_fallbacks(self) -> None:
        self.assertEqual(
            _microbar_universe_size(
                context=self._context(),
                params={"universe_size": "6"},
            ),
            6,
        )
        self.assertEqual(
            _microbar_universe_size(
                context=self._context(),
                params={
                    "universe_size": "bad-value",
                    "universe_symbols": ["META", "NVDA", "AAPL", ""],
                },
            ),
            3,
        )
        self.assertEqual(
            _microbar_universe_size(
                context=self._context(strategy_spec={"universe_symbols": ["META"]}),
                params={},
            ),
            2,
        )
        self.assertEqual(
            _microbar_universe_size(
                context=self._context(
                    strategy_spec={"universe_symbols": ["META", "NVDA", "AAPL", "MSFT"]}
                ),
                params={},
            ),
            4,
        )
        self.assertEqual(
            _microbar_rank_thresholds(universe_size=1, top_n=3),
            (Decimal("0"), Decimal("1")),
        )
        self.assertEqual(
            _microbar_rank_thresholds(universe_size=5, top_n=2),
            (Decimal("0.25"), Decimal("0.75")),
        )

    def test_microbar_cross_sectional_helper_covers_early_rejection_paths(self) -> None:
        base_params: dict[str, object] = {
            "entry_minute_after_open": "60",
            "exit_minute_after_open": "close",
            "signal_motif": "vwap_close_continuation",
            "gate_feature": "cross_section_continuation_breadth",
            "gate_min": "0.05",
            "gate_max": "0.20",
            "rank_feature": "cross_section_vwap_w5m_rank",
            "top_n": "2",
        }

        missing_minutes = _evaluate_microbar_cross_sectional(
            context=self._context(params=base_params, event_ts="bad-timestamp"),
            features=_test_feature_vector({}),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNone(missing_minutes.intent)
        assert missing_minutes.trace is not None
        self.assertEqual(missing_minutes.trace.first_failed_gate, "schedule")

        mismatched_minute = _evaluate_microbar_cross_sectional(
            context=self._context(
                params=base_params, event_ts="2026-03-24T14:29:00+00:00"
            ),
            features=_test_feature_vector({"session_minutes_elapsed": 59}),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNone(mismatched_minute.intent)
        assert mismatched_minute.trace is not None
        self.assertEqual(mismatched_minute.trace.first_failed_gate, "schedule")
        self.assertEqual(
            mismatched_minute.trace.gates[0].context["entry_window_minutes"], 0
        )

        regime_reject = _evaluate_microbar_cross_sectional(
            context=self._context(params=base_params),
            features=_test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_continuation_breadth": Decimal("0.30"),
                    "cross_section_vwap_w5m_rank": Decimal("0.10"),
                }
            ),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNone(regime_reject.intent)
        assert regime_reject.trace is not None
        self.assertEqual(regime_reject.trace.first_failed_gate, "regime_gate")
        self.assertEqual(len(regime_reject.trace.gates[0].thresholds), 2)

        missing_rank = _evaluate_microbar_cross_sectional(
            context=self._context(params=base_params),
            features=_test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_continuation_breadth": Decimal("0.10"),
                }
            ),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNone(missing_rank.intent)
        assert missing_rank.trace is not None
        self.assertEqual(missing_rank.trace.first_failed_gate, "rank_selection")

        window_entry = _evaluate_microbar_cross_sectional(
            context=self._context(
                params={
                    **base_params,
                    "entry_window_minutes": "30",
                    "gate_max": "0.40",
                }
            ),
            features=_test_feature_vector(
                {
                    "session_minutes_elapsed": 75,
                    "cross_section_continuation_breadth": Decimal("0.10"),
                    "cross_section_vwap_w5m_rank": Decimal("1"),
                }
            ),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNotNone(window_entry.intent)
        assert window_entry.trace is not None
        self.assertEqual(
            window_entry.trace.gates[0].context["entry_window_end_minute_after_open"],
            90,
        )

        late_window = _evaluate_microbar_cross_sectional(
            context=self._context(
                params={
                    **base_params,
                    "entry_window_minutes": "30",
                }
            ),
            features=_test_feature_vector({"session_minutes_elapsed": 91}),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNone(late_window.intent)
        assert late_window.trace is not None
        self.assertEqual(late_window.trace.first_failed_gate, "schedule")

    def test_microbar_cross_sectional_plugins_cover_entry_exit_and_selection_modes(
        self,
    ) -> None:
        long_plugin = MicrobarCrossSectionalLongPlugin()
        short_plugin = MicrobarCrossSectionalShortPlugin()

        exit_result = long_plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "60",
                    "exit_minute_after_open": "close",
                    "signal_motif": "vwap_close_continuation",
                    "rank_feature": "cross_section_vwap_w5m_rank",
                    "selection_mode": "continuation",
                    "top_n": "2",
                }
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 390,
                    "cross_section_vwap_w5m_rank": Decimal("0.02"),
                }
            ),
        )
        self.assertIsNotNone(exit_result.intent)
        assert exit_result.intent is not None
        self.assertEqual(exit_result.intent.action, "sell")

        continuation_buy = long_plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "open_window_continuation",
                    "rank_feature": "cross_section_session_open_rank",
                    "selection_mode": "continuation",
                    "top_n": "2",
                    "universe_size": "6",
                }
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_session_open_rank": Decimal("0.95"),
                }
            ),
        )
        self.assertIsNotNone(continuation_buy.intent)
        assert continuation_buy.intent is not None
        self.assertEqual(continuation_buy.intent.action, "buy")

        periodicity_buy = long_plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "0",
                    "exit_minute_after_open": "45",
                    "signal_motif": "prev_day_open45_periodicity",
                    "rank_feature": "cross_section_prev_day_open45_return_rank",
                    "selection_mode": "continuation",
                    "top_n": "1",
                    "universe_size": "12",
                },
                event_ts="2026-03-25T13:30:00+00:00",
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 0,
                    "cross_section_prev_day_open45_return_rank": Decimal("1"),
                }
            ),
        )
        self.assertIsNotNone(periodicity_buy.intent)
        assert periodicity_buy.intent is not None
        self.assertEqual(periodicity_buy.intent.action, "buy")
        self.assertEqual(
            periodicity_buy.intent.required_features,
            ("session_minutes_elapsed", "cross_section_prev_day_open45_return_rank"),
        )

        overnight_reversal_buy = long_plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "20",
                    "entry_window_minutes": "25",
                    "exit_minute_after_open": "150",
                    "signal_motif": "overnight_gap_reversal",
                    "rank_feature": "cross_section_prev_session_close_rank",
                    "selection_mode": "reversal",
                    "top_n": "2",
                    "universe_size": "8",
                    "gate_feature": (
                        "cross_section_positive_opening_window_return_from_prev_close_ratio"
                    ),
                    "gate_min": "0.20",
                    "gate_max": "0.80",
                },
                event_ts="2026-03-25T13:55:00+00:00",
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 25,
                    "cross_section_prev_session_close_rank": Decimal("0.05"),
                    "cross_section_positive_opening_window_return_from_prev_close_ratio": Decimal(
                        "0.42"
                    ),
                }
            ),
        )
        self.assertIsNotNone(overnight_reversal_buy.intent)
        assert overnight_reversal_buy.intent is not None
        self.assertEqual(overnight_reversal_buy.intent.action, "buy")
        self.assertEqual(
            overnight_reversal_buy.intent.required_features,
            (
                "session_minutes_elapsed",
                "cross_section_prev_session_close_rank",
                "cross_section_positive_opening_window_return_from_prev_close_ratio",
            ),
        )

        continuation_skip = _evaluate_microbar_cross_sectional(
            context=self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "open_window_continuation",
                    "rank_feature": "cross_section_session_open_rank",
                    "selection_mode": "continuation",
                    "top_n": "2",
                    "universe_size": "6",
                }
            ),
            features=_test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_session_open_rank": Decimal("0.20"),
                }
            ),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNone(continuation_skip.intent)
        assert continuation_skip.trace is not None
        self.assertEqual(continuation_skip.trace.first_failed_gate, "rank_selection")

        executable_universe_buy = _evaluate_microbar_cross_sectional(
            context=self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "high_volume_intraday_continuation_long_top2",
                    "rank_feature": "cross_section_microbar_volume_rank",
                    "selection_mode": "continuation",
                    "top_n": "2",
                    "universe_size": "12",
                }
            ),
            features=_test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_microbar_volume_rank": Decimal("0.75"),
                    "cross_section_microbar_volume_rank_universe_size": Decimal("5"),
                }
            ),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNotNone(executable_universe_buy.intent)
        assert executable_universe_buy.trace is not None
        self.assertEqual(
            executable_universe_buy.trace.gates[0].context["universe_size"], 5
        )

        clusterlob_rank_buy = _evaluate_microbar_cross_sectional(
            context=self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "clusterlob_directional_ofi_continuation",
                    "rank_feature": "cross_section_clusterlob_directional_ofi_rank",
                    "gate_feature": "clusterlob_event_cluster_stability_score",
                    "gate_min": "0.60",
                    "selection_mode": "continuation",
                    "top_n": "2",
                    "universe_size": "6",
                }
            ),
            features=_test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_clusterlob_directional_ofi_rank": Decimal("0.90"),
                    "clusterlob_event_cluster_stability_score": Decimal("0.72"),
                }
            ),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNotNone(clusterlob_rank_buy.intent)
        assert clusterlob_rank_buy.intent is not None
        self.assertIn(
            "rank_feature:cross_section_clusterlob_directional_ofi_rank",
            clusterlob_rank_buy.intent.rationale,
        )

        reversal_buy = _evaluate_microbar_cross_sectional(
            context=self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "open_window_reversal",
                    "rank_feature": "cross_section_session_open_rank",
                    "selection_mode": "reversal",
                    "top_n": "2",
                    "universe_size": "6",
                }
            ),
            features=_test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_session_open_rank": Decimal("0.05"),
                }
            ),
            entry_action="buy",
            exit_action="sell",
        )
        self.assertIsNotNone(reversal_buy.intent)
        assert reversal_buy.intent is not None
        self.assertEqual(reversal_buy.intent.action, "buy")

        reversal_sell = short_plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "open_window_reversal",
                    "rank_feature": "cross_section_session_open_rank",
                    "selection_mode": "reversal",
                    "top_n": "2",
                    "universe_size": "6",
                },
                strategy_type="microbar_cross_sectional_short_v1",
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_session_open_rank": Decimal("0.95"),
                }
            ),
        )
        self.assertIsNotNone(reversal_sell.intent)
        assert reversal_sell.intent is not None
        self.assertEqual(reversal_sell.intent.action, "sell")

        continuation_sell = short_plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "vwap_close_continuation",
                    "rank_feature": "cross_section_vwap_w5m_rank",
                    "selection_mode": "continuation",
                    "top_n": "2",
                    "universe_size": "6",
                },
                strategy_type="microbar_cross_sectional_short_v1",
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("0.05"),
                }
            ),
        )
        self.assertIsNotNone(continuation_sell.intent)
        assert continuation_sell.intent is not None
        self.assertEqual(continuation_sell.intent.action, "sell")

    def test_microbar_cross_sectional_pairs_plugin_emits_balanced_pair_sides(
        self,
    ) -> None:
        plugin = MicrobarCrossSectionalPairsPlugin()
        params = {
            "entry_minute_after_open": "60",
            "exit_minute_after_open": "120",
            "signal_motif": "vwap_close_continuation",
            "rank_feature": "cross_section_vwap_w5m_rank",
            "selection_mode": "continuation",
            "top_n": "2",
            "max_pair_legs": "2",
        }

        high_rank_entry = plugin.evaluate(
            self._context(
                params=params,
                strategy_type="microbar_cross_sectional_pairs_v1",
                symbol="AAPL",
                strategy_spec={"universe_symbols": ["AAPL", "AMZN"]},
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("1"),
                }
            ),
        )
        low_rank_entry = plugin.evaluate(
            self._context(
                params=params,
                strategy_type="microbar_cross_sectional_pairs_v1",
                symbol="AMZN",
                strategy_spec={"universe_symbols": ["AAPL", "AMZN"]},
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("0"),
                }
            ),
        )

        self.assertIsNotNone(high_rank_entry.intent)
        self.assertIsNotNone(low_rank_entry.intent)
        assert high_rank_entry.intent is not None
        assert low_rank_entry.intent is not None
        self.assertEqual(high_rank_entry.intent.action, "buy")
        self.assertEqual(low_rank_entry.intent.action, "sell")
        self.assertEqual(
            high_rank_entry.intent.target_notional,
            low_rank_entry.intent.target_notional,
        )
        self.assertIn("pair_side:high_rank", high_rank_entry.intent.rationale)
        self.assertIn("pair_side:low_rank", low_rank_entry.intent.rationale)
        self.assertIn("max_pair_legs:2", high_rank_entry.intent.rationale)
        assert high_rank_entry.trace is not None
        self.assertEqual(high_rank_entry.trace.gates[0].context["pair_side_count"], 1)

        high_rank_exit = plugin.evaluate(
            self._context(
                params=params,
                strategy_type="microbar_cross_sectional_pairs_v1",
                symbol="AAPL",
                strategy_spec={"universe_symbols": ["AAPL", "AMZN"]},
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 120,
                    "cross_section_vwap_w5m_rank": Decimal("1"),
                    "runtime_position_qty": Decimal("10"),
                }
            ),
        )
        low_rank_exit = plugin.evaluate(
            self._context(
                params=params,
                strategy_type="microbar_cross_sectional_pairs_v1",
                symbol="AMZN",
                strategy_spec={"universe_symbols": ["AAPL", "AMZN"]},
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 120,
                    "cross_section_vwap_w5m_rank": Decimal("0"),
                    "runtime_position_qty": Decimal("-10"),
                }
            ),
        )

        self.assertIsNotNone(high_rank_exit.intent)
        self.assertIsNotNone(low_rank_exit.intent)
        assert high_rank_exit.intent is not None
        assert low_rank_exit.intent is not None
        self.assertEqual(high_rank_exit.intent.action, "sell")
        self.assertEqual(low_rank_exit.intent.action, "buy")
        self.assertIn(
            "microbar_cross_sectional_pair_exit",
            high_rank_exit.intent.rationale,
        )
        self.assertIn("exit_basis:runtime_position", high_rank_exit.intent.rationale)

    def test_microbar_pairs_honors_configured_pair_universe_with_broader_feature_universe(
        self,
    ) -> None:
        plugin = MicrobarCrossSectionalPairsPlugin()
        params = {
            "entry_minute_after_open": "60",
            "signal_motif": "vwap_close_continuation",
            "rank_feature": "cross_section_vwap_w5m_rank",
            "selection_mode": "continuation",
            "top_n": "1",
            "max_pair_legs": "2",
        }

        high_rank_entry = plugin.evaluate(
            self._context(
                params=params,
                strategy_type="microbar_cross_sectional_pairs_v1",
                symbol="AAPL",
                strategy_spec={"universe_symbols": ["AAPL", "AMZN"]},
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("0.6667"),
                    "cross_section_vwap_w5m_rank_universe_size": Decimal("4"),
                },
                symbol="AAPL",
            ),
        )
        low_rank_entry = plugin.evaluate(
            self._context(
                params=params,
                strategy_type="microbar_cross_sectional_pairs_v1",
                symbol="AMZN",
                strategy_spec={"universe_symbols": ["AAPL", "AMZN"]},
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("0.3333"),
                    "cross_section_vwap_w5m_rank_universe_size": Decimal("4"),
                },
                symbol="AMZN",
            ),
        )
        ambiguous_midpoint = plugin.evaluate(
            self._context(
                params=params,
                strategy_type="microbar_cross_sectional_pairs_v1",
                symbol="AAPL",
                strategy_spec={"universe_symbols": ["AAPL", "AMZN"]},
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("0.5"),
                    "cross_section_vwap_w5m_rank_universe_size": Decimal("4"),
                },
                symbol="AAPL",
            ),
        )

        self.assertIsNotNone(high_rank_entry.intent)
        self.assertIsNotNone(low_rank_entry.intent)
        assert high_rank_entry.intent is not None
        assert low_rank_entry.intent is not None
        self.assertEqual(high_rank_entry.intent.action, "buy")
        self.assertEqual(low_rank_entry.intent.action, "sell")
        assert high_rank_entry.trace is not None
        self.assertEqual(
            high_rank_entry.trace.gates[0].context["rank_threshold_basis"],
            "configured_pair_midpoint",
        )
        self.assertEqual(
            high_rank_entry.trace.gates[0].context["configured_universe_size"],
            2,
        )
        self.assertEqual(
            high_rank_entry.trace.gates[0].context["observed_rank_universe_size"],
            4,
        )
        self.assertIsNone(ambiguous_midpoint.intent)
        assert ambiguous_midpoint.trace is not None
        self.assertEqual(
            ambiguous_midpoint.trace.gates[0].context["reason"],
            "ambiguous_pair_rank_midpoint",
        )

    def test_microbar_pairs_missing_rank_records_actionable_suppression(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid.uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description=_compose_strategy_description(
                StrategyConfig(
                    name="microbar-cross-sectional-pairs-v1",
                    strategy_id="microbar_cross_sectional_pairs_v1@research",
                    strategy_type="microbar_cross_sectional_pairs_v1",
                    version="1.0.0",
                    base_timeframe="1Sec",
                    universe_type="microbar_cross_sectional_pairs_v1",
                    universe_symbols=["AAPL", "AMZN"],
                    max_position_pct_equity=Decimal("6.0"),
                    max_notional_per_trade=Decimal("75000"),
                    params={
                        "entry_minute_after_open": "60",
                        "rank_feature": "cross_section_vwap_w5m_rank",
                        "selection_mode": "continuation",
                        "max_pair_legs": "2",
                    },
                )
            ),
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
            max_position_pct_equity=Decimal("6.0"),
            max_notional_per_trade=Decimal("75000"),
        )
        runtime = StrategyRuntime(trace_enabled=True)

        evaluation = runtime.evaluate_all(
            [strategy],
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "price": Decimal("200"),
                },
                symbol="AAPL",
            ),
            timeframe="1Sec",
        )

        self.assertEqual(evaluation.raw_intents, [])
        self.assertIn(
            f"{strategy.id}|rank_selection:missing_rank_feature",
            evaluation.observation.strategy_intent_suppression_total,
        )

    def test_microbar_cross_sectional_pairs_plugin_exits_by_position_after_rank_drift(
        self,
    ) -> None:
        plugin = MicrobarCrossSectionalPairsPlugin()
        params = {
            "entry_minute_after_open": "60",
            "exit_minute_after_open": "120",
            "signal_motif": "vwap_close_continuation",
            "rank_feature": "cross_section_vwap_w5m_rank",
            "selection_mode": "continuation",
            "top_n": "2",
            "max_pair_legs": "2",
        }

        long_exit = plugin.evaluate(
            self._context(
                params=params, strategy_type="microbar_cross_sectional_pairs_v1"
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 120,
                    "cross_section_vwap_w5m_rank": Decimal("0.5"),
                    "runtime_position_qty": Decimal("3"),
                }
            ),
        )
        short_exit = plugin.evaluate(
            self._context(
                params=params, strategy_type="microbar_cross_sectional_pairs_v1"
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 120,
                    "cross_section_vwap_w5m_rank": Decimal("0.5"),
                    "runtime_position_qty": Decimal("-2"),
                }
            ),
        )

        self.assertIsNotNone(long_exit.intent)
        self.assertIsNotNone(short_exit.intent)
        assert long_exit.intent is not None
        assert short_exit.intent is not None
        self.assertEqual(long_exit.intent.action, "sell")
        self.assertEqual(short_exit.intent.action, "buy")
        self.assertIn("position_side:long", long_exit.intent.rationale)
        self.assertIn("position_side:short", short_exit.intent.rationale)
        assert long_exit.trace is not None
        self.assertEqual(long_exit.trace.gates[0].gate, "pair_position_exit")

    def test_microbar_cross_sectional_pairs_plugin_fails_closed_without_exit_position(
        self,
    ) -> None:
        plugin = MicrobarCrossSectionalPairsPlugin()
        params = {
            "entry_minute_after_open": "60",
            "exit_minute_after_open": "120",
            "signal_motif": "vwap_close_continuation",
            "rank_feature": "cross_section_vwap_w5m_rank",
            "selection_mode": "continuation",
            "max_pair_legs": "2",
        }

        missing_position = plugin.evaluate(
            self._context(
                params=params, strategy_type="microbar_cross_sectional_pairs_v1"
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 120,
                    "cross_section_vwap_w5m_rank": Decimal("1"),
                }
            ),
        )
        flat_position = plugin.evaluate(
            self._context(
                params=params, strategy_type="microbar_cross_sectional_pairs_v1"
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 120,
                    "cross_section_vwap_w5m_rank": Decimal("1"),
                    "runtime_position_qty": Decimal("0"),
                }
            ),
        )

        self.assertIsNone(missing_position.intent)
        self.assertIsNone(flat_position.intent)
        assert missing_position.trace is not None
        assert flat_position.trace is not None
        self.assertEqual(missing_position.trace.first_failed_gate, "pair_position_exit")
        self.assertEqual(flat_position.trace.first_failed_gate, "pair_position_exit")
        self.assertEqual(
            missing_position.trace.gates[0].context["reason"],
            "missing_runtime_position_qty",
        )
        self.assertEqual(
            flat_position.trace.gates[0].context["reason"],
            "flat_runtime_position",
        )

    def test_microbar_cross_sectional_pairs_plugin_respects_max_pair_legs(
        self,
    ) -> None:
        plugin = MicrobarCrossSectionalPairsPlugin()
        middle_rank = plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "vwap_close_continuation",
                    "rank_feature": "cross_section_vwap_w5m_rank",
                    "selection_mode": "continuation",
                    "top_n": "3",
                    "max_pair_legs": "2",
                    "universe_size": "6",
                },
                strategy_type="microbar_cross_sectional_pairs_v1",
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("0.80"),
                }
            ),
        )
        self.assertIsNone(middle_rank.intent)
        assert middle_rank.trace is not None
        self.assertEqual(middle_rank.trace.first_failed_gate, "pair_rank_selection")
        self.assertEqual(middle_rank.trace.gates[0].context["pair_side_count"], 1)
        self.assertEqual(middle_rank.trace.gates[0].context["max_pair_legs"], 2)

        invalid_pair = plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "vwap_close_continuation",
                    "rank_feature": "cross_section_vwap_w5m_rank",
                    "selection_mode": "continuation",
                    "max_pair_legs": "1",
                    "universe_size": "6",
                },
                strategy_type="microbar_cross_sectional_pairs_v1",
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("1"),
                }
            ),
        )
        self.assertIsNone(invalid_pair.intent)
        assert invalid_pair.trace is not None
        self.assertEqual(invalid_pair.trace.first_failed_gate, "pair_leg_selection")

        reversal_high_rank = plugin.evaluate(
            self._context(
                params={
                    "entry_minute_after_open": "60",
                    "signal_motif": "vwap_close_reversal",
                    "rank_feature": "cross_section_vwap_w5m_rank",
                    "selection_mode": "reversal",
                    "max_pair_legs": "2",
                    "universe_size": "2",
                },
                strategy_type="microbar_cross_sectional_pairs_v1",
            ),
            _test_feature_vector(
                {
                    "session_minutes_elapsed": 60,
                    "cross_section_vwap_w5m_rank": Decimal("1"),
                }
            ),
        )
        self.assertIsNotNone(reversal_high_rank.intent)
        assert reversal_high_rank.intent is not None
        self.assertEqual(reversal_high_rank.intent.action, "sell")

    def test_strategy_registry_resolves_microbar_pairs_alias(self) -> None:
        registry = StrategyRegistry()
        definition = StrategyDefinition(
            strategy_id="strategy-1",
            strategy_name="microbar-cross-sectional-pairs-v1",
            declared_strategy_id="microbar_cross_sectional_pairs_v1@research",
            strategy_type="microbar_cross_sectional_pairs_v1",
            version="1.0.0",
            params={},
            feature_requirements=(),
            risk_profile="paper",
            execution_profile="paper",
            enabled=True,
            base_timeframe="1Sec",
        )

        plugin = registry.resolve(definition)

        self.assertIsInstance(plugin, MicrobarCrossSectionalPairsPlugin)
