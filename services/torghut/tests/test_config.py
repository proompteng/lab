from __future__ import annotations

from unittest import TestCase

from app.config import Settings
from pydantic import ValidationError


class TestConfig(TestCase):
    def test_rejects_static_universe_when_trading_enabled(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="static",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allows_static_universe_when_trading_and_autonomy_disabled(self) -> None:
        settings = Settings(
            TRADING_ENABLED=False,
            TRADING_AUTONOMY_ENABLED=False,
            TRADING_LIVE_ENABLED=False,
            TRADING_UNIVERSE_SOURCE="static",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(settings.trading_universe_source, "static")

    def test_rejects_live_mode_without_live_enabled(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="live",
                TRADING_LIVE_ENABLED=False,
                TRADING_UNIVERSE_SOURCE="static",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_rejects_paper_mode_with_live_enabled(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="paper",
                TRADING_LIVE_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="static",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_rejects_strict_veto_with_pass_through_fail_mode(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                LLM_FAIL_MODE="pass_through",
                LLM_FAIL_MODE_ENFORCEMENT="strict_veto",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allows_mode_coupled_configured_with_pass_through_fail_mode(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_LIVE_ENABLED=True,
            TRADING_UNIVERSE_SOURCE="jangar",
            LLM_FAIL_MODE="pass_through",
            LLM_FAIL_MODE_ENFORCEMENT="configured",
            TRADING_PARITY_POLICY="mode_coupled",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(settings.llm_effective_fail_mode(), "veto")

    def test_rejects_live_fail_open_without_explicit_approval(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(
                TRADING_MODE="live",
                TRADING_LIVE_ENABLED=True,
                TRADING_UNIVERSE_SOURCE="jangar",
                TRADING_PARITY_POLICY="live_equivalent",
                LLM_FAIL_MODE="pass_through",
                LLM_FAIL_MODE_ENFORCEMENT="configured",
                DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
            )

    def test_allows_live_fail_open_with_explicit_approval(self) -> None:
        settings = Settings(
            TRADING_MODE="live",
            TRADING_LIVE_ENABLED=True,
            TRADING_UNIVERSE_SOURCE="jangar",
            TRADING_PARITY_POLICY="live_equivalent",
            LLM_FAIL_MODE="pass_through",
            LLM_FAIL_MODE_ENFORCEMENT="configured",
            LLM_FAIL_OPEN_LIVE_APPROVED=True,
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )

        self.assertEqual(
            settings.llm_effective_fail_mode_for_current_rollout(), "pass_through"
        )

    def test_allocator_regime_maps_are_normalized(self) -> None:
        settings = Settings(
            TRADING_UNIVERSE_SOURCE="static",
            TRADING_ENABLED=False,
            TRADING_ALLOCATOR_ENABLED=True,
            TRADING_ALLOCATOR_REGIME_BUDGET_MULTIPLIERS={
                "vol=high|trend=flat|liq=liquid": 0.5
            },
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertTrue(settings.trading_allocator_enabled)
        self.assertIn(
            "vol=high|trend=flat|liq=liquid",
            settings.trading_allocator_regime_budget_multipliers,
        )

    def test_parses_signal_staleness_critical_reasons(self) -> None:
        settings = Settings(
            TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS="cursor_ahead_of_stream, universe_source_unavailable",
            DB_DSN="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        )
        self.assertEqual(
            settings.trading_signal_staleness_alert_critical_reasons,
            {"cursor_ahead_of_stream", "universe_source_unavailable"},
        )
