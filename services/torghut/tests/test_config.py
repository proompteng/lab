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
