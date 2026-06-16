from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.strategy_runtime.support import (
    Decimal,
    TestCase,
    _rank_thresholds,
    evaluate_mean_reversion_exhaustion_short,
)


class TestMeanReversionExhaustionShortSleeveCoverage(TestCase):
    def _base_kwargs(self) -> dict[str, object]:
        return {
            "params": {},
            "strategy_id": "strategy-1",
            "strategy_type": "mean_reversion_exhaustion_short_v1",
            "symbol": "META",
            "event_ts": "2026-03-24T17:18:12+00:00",
            "timeframe": "1Sec",
            "trace_enabled": True,
            "price": Decimal("598.40"),
            "ema12": Decimal("596.90"),
            "macd": Decimal("0.002"),
            "macd_signal": Decimal("-0.002"),
            "rsi14": Decimal("58"),
            "vol_realized_w60s": Decimal("0.00022"),
            "vwap_session": Decimal("595.90"),
            "spread_bps": Decimal("0.84"),
            "imbalance_bid_sz": Decimal("4300"),
            "imbalance_ask_sz": Decimal("4700"),
            "price_vs_session_open_bps": Decimal("42"),
            "price_vs_prev_session_close_bps": None,
            "opening_window_return_bps": Decimal("12"),
            "opening_window_return_from_prev_close_bps": None,
            "price_position_in_session_range": Decimal("0.86"),
            "price_vs_opening_range_high_bps": Decimal("4"),
            "session_range_bps": Decimal("88"),
            "recent_spread_bps_avg": Decimal("0.82"),
            "recent_spread_bps_max": Decimal("1.44"),
            "recent_imbalance_pressure_avg": Decimal("-0.07"),
            "recent_quote_invalid_ratio": Decimal("0.01"),
            "recent_quote_jump_bps_max": Decimal("10"),
            "recent_microprice_bias_bps_avg": Decimal("-0.80"),
            "cross_section_opening_window_return_rank": Decimal("0.86"),
            "cross_section_opening_window_return_from_prev_close_rank": None,
            "cross_section_continuation_rank": Decimal("0.38"),
            "cross_section_reversal_rank": Decimal("0.80"),
            "cross_section_session_open_rank": Decimal("0.84"),
            "cross_section_prev_session_close_rank": Decimal("0.81"),
            "cross_section_range_position_rank": Decimal("0.78"),
            "cross_section_vwap_w5m_rank": Decimal("0.76"),
            "cross_section_recent_imbalance_rank": Decimal("0.73"),
        }

    def test_mean_reversion_exhaustion_short_evaluator_covers_required_and_window_guards(
        self,
    ) -> None:
        missing_input = evaluate_mean_reversion_exhaustion_short(
            **(self._base_kwargs() | {"rsi14": None})
        )
        self.assertIsNone(missing_input.signal)
        assert missing_input.trace is not None
        self.assertEqual(missing_input.trace.first_failed_gate, "eligibility")

        outside_window = evaluate_mean_reversion_exhaustion_short(
            **(self._base_kwargs() | {"event_ts": "2026-03-24T13:15:00+00:00"})
        )
        self.assertIsNone(outside_window.signal)
        assert outside_window.trace is not None
        self.assertEqual(outside_window.trace.first_failed_gate, "eligibility")

    def test_mean_reversion_exhaustion_short_evaluator_covers_confidence_bonuses_and_no_signal(
        self,
    ) -> None:
        sell_result = evaluate_mean_reversion_exhaustion_short(**self._base_kwargs())
        self.assertIsNotNone(sell_result.signal)
        assert sell_result.signal is not None
        self.assertEqual(sell_result.signal.action, "sell")
        self.assertEqual(sell_result.signal.confidence, Decimal("0.76"))

        no_signal_result = evaluate_mean_reversion_exhaustion_short(
            **(
                self._base_kwargs()
                | {
                    "price": Decimal("595.30"),
                    "ema12": Decimal("595.20"),
                    "macd": Decimal("0.000"),
                    "macd_signal": Decimal("0.000"),
                    "rsi14": Decimal("50"),
                    "vwap_session": Decimal("595.00"),
                    "imbalance_bid_sz": Decimal("4500"),
                    "imbalance_ask_sz": Decimal("4500"),
                    "price_vs_session_open_bps": Decimal("5"),
                    "opening_window_return_bps": Decimal("2"),
                    "price_position_in_session_range": Decimal("0.50"),
                    "price_vs_opening_range_high_bps": Decimal("-20"),
                    "recent_imbalance_pressure_avg": Decimal("0.00"),
                    "recent_microprice_bias_bps_avg": Decimal("0.00"),
                    "cross_section_opening_window_return_rank": Decimal("0.40"),
                    "cross_section_continuation_rank": Decimal("0.50"),
                    "cross_section_reversal_rank": Decimal("0.40"),
                }
            )
        )
        self.assertIsNone(no_signal_result.signal)
        assert no_signal_result.trace is not None
        self.assertEqual(no_signal_result.trace.first_failed_gate, "structure")

    def test_mean_reversion_exhaustion_short_evaluator_supports_rank_selection(
        self,
    ) -> None:
        self.assertEqual(
            _rank_thresholds(universe_size=1, top_n=4), (Decimal("0"), Decimal("1"))
        )

        ranked_sell = evaluate_mean_reversion_exhaustion_short(
            **(
                self._base_kwargs()
                | {
                    "params": {
                        "rank_feature": "cross_section_reversal_rank",
                        "selection_mode": "reversal",
                        "top_n": "2",
                        "universe_size": "6",
                    },
                    "cross_section_reversal_rank": Decimal("0.85"),
                }
            )
        )
        self.assertIsNotNone(ranked_sell.signal)
        assert ranked_sell.signal is not None
        self.assertIn(
            "rank_feature:cross_section_reversal_rank", ranked_sell.signal.rationale
        )

        filtered_sell = evaluate_mean_reversion_exhaustion_short(
            **(
                self._base_kwargs()
                | {
                    "params": {
                        "rank_feature": "cross_section_reversal_rank",
                        "selection_mode": "reversal",
                        "top_n": "2",
                        "universe_size": "6",
                    },
                    "cross_section_reversal_rank": Decimal("0.60"),
                }
            )
        )
        self.assertIsNone(filtered_sell.signal)
        assert filtered_sell.trace is not None
        self.assertEqual(filtered_sell.trace.first_failed_gate, "rank_selection")

        continuation_sell = evaluate_mean_reversion_exhaustion_short(
            **(
                self._base_kwargs()
                | {
                    "params": {
                        "rank_feature": "cross_section_reversal_rank",
                        "selection_mode": "continuation",
                        "top_n": "2",
                        "universe_size": "6",
                    },
                    "cross_section_reversal_rank": Decimal("0.20"),
                }
            )
        )
        self.assertIsNotNone(continuation_sell.signal)
        assert continuation_sell.signal is not None
        self.assertIn("selection_mode:continuation", continuation_sell.signal.rationale)
