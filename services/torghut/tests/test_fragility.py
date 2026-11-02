from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.fragility import FragilityMonitor, FragilityMonitorConfig
from app.trading.models import StrategyDecision


class TestFragilityMonitor(TestCase):
    def test_snapshot_explicit_zero_values_override_fallbacks(self) -> None:
        monitor = FragilityMonitor(
            FragilityMonitorConfig(
                mode="enforce",
                unknown_state="elevated",
                elevated_threshold=Decimal("0.25"),
                stress_threshold=Decimal("0.50"),
                crisis_threshold=Decimal("0.75"),
                state_budget_multipliers={
                    "normal": Decimal("1"),
                    "elevated": Decimal("0.8"),
                    "stress": Decimal("0.6"),
                    "crisis": Decimal("0.4"),
                },
                state_capacity_multipliers={
                    "normal": Decimal("1"),
                    "elevated": Decimal("0.8"),
                    "stress": Decimal("0.6"),
                    "crisis": Decimal("0.4"),
                },
                state_participation_clamps={
                    "normal": Decimal("1"),
                    "elevated": Decimal("0.8"),
                    "stress": Decimal("0.5"),
                    "crisis": Decimal("0.25"),
                },
                state_abstain_bias={
                    "normal": Decimal("0"),
                    "elevated": Decimal("0.1"),
                    "stress": Decimal("0.25"),
                    "crisis": Decimal("0.5"),
                },
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
            params={
                "spread_acceleration": Decimal("0.9"),
                "liquidity_compression": Decimal("0.9"),
                "crowding_proxy": Decimal("0.9"),
                "correlation_concentration": Decimal("0.9"),
                "fragility_score": Decimal("0.9"),
                "fragility_state": "crisis",
                "fragility_snapshot": {
                    "spread_acceleration": Decimal("0"),
                    "liquidity_compression": Decimal("0"),
                    "crowding_proxy": Decimal("0"),
                    "correlation_concentration": Decimal("0"),
                    "fragility_score": Decimal("0"),
                    "fragility_state": "normal",
                },
            },
        )

        result = monitor.evaluate(decision)
        self.assertEqual(result.snapshot.spread_acceleration, Decimal("0"))
        self.assertEqual(result.snapshot.liquidity_compression, Decimal("0"))
        self.assertEqual(result.snapshot.crowding_proxy, Decimal("0"))
        self.assertEqual(result.snapshot.correlation_concentration, Decimal("0"))
        self.assertEqual(result.snapshot.fragility_score, Decimal("0"))
        self.assertEqual(result.snapshot.fragility_state, "normal")
