from __future__ import annotations

from unittest import TestCase

from app.config import settings
from app.trading.lean_runtime import (
    SCAFFOLD_BLOCKED_STATUS,
    _backtests,
    get_backtest,
    lean_authority_status,
    evaluate_strategy_shadow,
    shadow_simulate,
    submit_backtest,
)


class TestLeanRuntime(TestCase):
    def setUp(self) -> None:
        self.original_backtest_upstream_url = settings.trading_lean_backtest_upstream_url
        self.original_shadow_upstream_url = settings.trading_lean_shadow_upstream_url
        self.original_strategy_shadow_upstream_url = (
            settings.trading_lean_strategy_shadow_upstream_url
        )
        self.original_disable_switch = settings.trading_lean_lane_disable_switch
        _backtests.clear()

    def tearDown(self) -> None:
        settings.trading_lean_backtest_upstream_url = self.original_backtest_upstream_url
        settings.trading_lean_shadow_upstream_url = self.original_shadow_upstream_url
        settings.trading_lean_strategy_shadow_upstream_url = (
            self.original_strategy_shadow_upstream_url
        )
        settings.trading_lean_lane_disable_switch = self.original_disable_switch
        _backtests.clear()

    def test_backtest_submit_and_get_use_in_process_scaffold(self) -> None:
        settings.trading_lean_backtest_upstream_url = None
        submitted = submit_backtest(
            lane="research",
            config={"symbol": "BTC/USD"},
            correlation_id="corr-1",
        )

        self.assertEqual(submitted["status"], "queued")
        backtest_id = submitted["backtest_id"]
        _backtests[backtest_id].due_at = 0

        fetched = get_backtest(backtest_id)
        self.assertEqual(fetched["status"], "completed")
        result = fetched["result"]
        self.assertFalse(result["deterministic_replay_passed"])
        self.assertEqual(result["authority_mode"], "deterministic_scaffold")
        self.assertFalse(result["promotion_authority_eligible"])
        self.assertEqual(result["blocking_reason"], SCAFFOLD_BLOCKED_STATUS)

    def test_authority_status_reports_disabled_when_lane_disabled(self) -> None:
        settings.trading_lean_lane_disable_switch = True

        status = lean_authority_status()

        self.assertEqual(status["status"], "disabled")
        self.assertEqual(status["authority"], "blocked")
        self.assertEqual(status["authoritative_modes"], [])

    def test_strategy_shadow_uses_deterministic_scaffold(self) -> None:
        settings.trading_lean_strategy_shadow_upstream_url = None

        payload = evaluate_strategy_shadow(
            strategy_id="s1",
            symbol="BTC/USD",
            intent={"qty": 1},
            correlation_id="corr-1",
        )

        self.assertEqual(payload["parity_status"], SCAFFOLD_BLOCKED_STATUS)
        self.assertIn("governance", payload)
        self.assertFalse(payload["governance"]["promotion_ready"])

    def test_shadow_simulate_is_fail_closed_without_empirical_replay(self) -> None:
        settings.trading_lean_shadow_upstream_url = None

        payload = shadow_simulate(
            symbol="BTC/USD",
            side="buy",
            qty=1,
            intent_price=100.0,
            correlation_id="corr-1",
        )

        self.assertEqual(payload["parity_status"], SCAFFOLD_BLOCKED_STATUS)
        self.assertEqual(
            payload["failure_taxonomy"],
            "missing_empirical_shadow_replay",
        )
        self.assertFalse(payload["promotion_authority_eligible"])
