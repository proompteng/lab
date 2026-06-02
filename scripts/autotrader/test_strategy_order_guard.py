#!/usr/bin/env python3
from __future__ import annotations

import unittest
from unittest.mock import patch

import strategy_order_guard


class StrategyOrderGuardTest(unittest.TestCase):
    def test_allows_fresh_buy_bracket(self) -> None:
        decision = strategy_order_guard.decide_strategy_order(
            symbol="NVDA",
            side="buy",
            entry_limit=229.20,
            take_profit_limit=231.80,
            stop_loss_stop=227.90,
            latest_bid=229.15,
            latest_ask=229.20,
            latest_trade=229.18,
            max_spread_pct=0.35,
            min_target_headroom_pct=0.25,
        )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["reason"], "fresh_strategy_order")

    def test_blocks_live_stale_buy_bracket_when_target_headroom_is_too_small(self) -> None:
        decision = strategy_order_guard.decide_strategy_order(
            symbol="NVDA",
            side="buy",
            entry_limit=229.20,
            take_profit_limit=231.80,
            stop_loss_stop=227.90,
            latest_bid=231.00,
            latest_ask=231.44,
            latest_trade=231.04,
            max_spread_pct=0.35,
            min_target_headroom_pct=0.25,
        )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["reason"], "target_headroom_too_small")

    def test_blocks_buy_bracket_when_target_already_touched(self) -> None:
        decision = strategy_order_guard.decide_strategy_order(
            symbol="NVDA",
            side="buy",
            entry_limit=229.20,
            take_profit_limit=231.80,
            stop_loss_stop=227.90,
            latest_bid=231.70,
            latest_ask=231.75,
            latest_trade=231.85,
            max_spread_pct=0.35,
            min_target_headroom_pct=0.25,
        )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["reason"], "target_already_touched")

    def test_blocks_invalid_buy_bracket_prices(self) -> None:
        decision = strategy_order_guard.decide_strategy_order(
            symbol="NVDA",
            side="buy",
            entry_limit=229.20,
            take_profit_limit=228.00,
            stop_loss_stop=227.90,
            latest_bid=229.10,
            latest_ask=229.20,
            latest_trade=229.18,
            max_spread_pct=0.35,
            min_target_headroom_pct=0.25,
        )

        self.assertFalse(decision["allowed"])
        self.assertEqual(decision["reason"], "invalid_buy_bracket_prices")

    def test_allows_fresh_sell_bracket(self) -> None:
        decision = strategy_order_guard.decide_strategy_order(
            symbol="SPY",
            side="sell",
            entry_limit=500.00,
            take_profit_limit=495.00,
            stop_loss_stop=502.00,
            latest_bid=500.00,
            latest_ask=500.10,
            latest_trade=500.05,
            max_spread_pct=0.35,
            min_target_headroom_pct=0.25,
        )

        self.assertTrue(decision["allowed"])
        self.assertEqual(decision["reason"], "fresh_strategy_order")

    def test_evaluate_order_fetches_latest_quote_and_trade(self) -> None:
        case = self

        class FakeAlpaca:
            def __init__(self, *, timeout_seconds: float) -> None:
                self.timeout_seconds = timeout_seconds

            def data_get(self, path: str, query: dict[str, str]) -> object:
                case.assertEqual(query, {"symbols": "NVDA", "feed": "iex"})
                if path == "/stocks/quotes/latest":
                    return {"quotes": {"NVDA": {"bp": 229.15, "ap": 229.20}}}
                if path == "/stocks/trades/latest":
                    return {"trades": {"NVDA": {"p": 229.18}}}
                raise AssertionError(f"unexpected path {path}")

        args = strategy_order_guard.build_parser().parse_args(
            [
                "--symbol",
                "nvda",
                "--side",
                "buy",
                "--entry-limit",
                "229.20",
                "--take-profit-limit",
                "231.80",
                "--stop-loss-stop",
                "227.90",
            ]
        )
        with patch.object(strategy_order_guard, "AlpacaRestClient", FakeAlpaca):
            result = strategy_order_guard.evaluate_order(args)

        self.assertTrue(result["allowed"])
        self.assertEqual(result["symbol"], "NVDA")
        self.assertEqual(result["latestAsk"], 229.20)


if __name__ == "__main__":
    unittest.main()
