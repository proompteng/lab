from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase
from unittest.mock import patch

from app import config
from app.trading.time_source import TradingTimeSource


class TestTradingTimeSource(TestCase):
    def setUp(self) -> None:
        self._snapshot = {
            "trading_simulation_enabled": config.settings.trading_simulation_enabled,
            "trading_simulation_clock_mode": config.settings.trading_simulation_clock_mode,
            "trading_simulation_window_start": config.settings.trading_simulation_window_start,
            "trading_simulation_clock_cache_seconds": config.settings.trading_simulation_clock_cache_seconds,
        }

    def tearDown(self) -> None:
        config.settings.trading_simulation_enabled = self._snapshot["trading_simulation_enabled"]
        config.settings.trading_simulation_clock_mode = self._snapshot["trading_simulation_clock_mode"]
        config.settings.trading_simulation_window_start = self._snapshot["trading_simulation_window_start"]
        config.settings.trading_simulation_clock_cache_seconds = self._snapshot["trading_simulation_clock_cache_seconds"]

    def test_snapshot_uses_cursor_time_when_available(self) -> None:
        config.settings.trading_simulation_enabled = True
        config.settings.trading_simulation_clock_mode = "cursor"
        config.settings.trading_simulation_window_start = "2026-03-06T18:00:00Z"
        source = TradingTimeSource()
        cursor_at = datetime(2026, 3, 6, 18, 15, tzinfo=timezone.utc)

        with patch.object(source, "_load_clickhouse_cursor", return_value=cursor_at):
            snapshot = source.snapshot(account_label="TORGHUT_SIM")

        self.assertEqual(snapshot.now, cursor_at)
        self.assertEqual(snapshot.source, "trade_cursor.clickhouse")

    def test_snapshot_falls_back_to_window_start_without_cursor(self) -> None:
        config.settings.trading_simulation_enabled = True
        config.settings.trading_simulation_clock_mode = "cursor"
        config.settings.trading_simulation_window_start = "2026-03-06T18:00:00Z"
        source = TradingTimeSource()

        with patch.object(source, "_load_clickhouse_cursor", return_value=None):
            snapshot = source.snapshot(account_label="TORGHUT_SIM")

        self.assertEqual(snapshot.now, datetime(2026, 3, 6, 18, 0, tzinfo=timezone.utc))
        self.assertEqual(snapshot.source, "window_start")

    def test_snapshot_cache_is_partitioned_by_account_label(self) -> None:
        config.settings.trading_simulation_enabled = True
        config.settings.trading_simulation_clock_mode = "cursor"
        config.settings.trading_simulation_window_start = "2026-03-06T18:00:00Z"
        config.settings.trading_simulation_clock_cache_seconds = 60
        source = TradingTimeSource()
        cursor_by_account = {
            "paper-a": datetime(2026, 3, 6, 18, 15, tzinfo=timezone.utc),
            "paper-b": datetime(2026, 3, 6, 18, 45, tzinfo=timezone.utc),
        }

        def _cursor_for_account(*, account_label: str) -> datetime:
            return cursor_by_account[account_label]

        with patch.object(source, "_load_clickhouse_cursor", side_effect=_cursor_for_account):
            first_snapshot = source.snapshot(account_label="paper-a")
            second_snapshot = source.snapshot(account_label="paper-b")
            repeated_first_snapshot = source.snapshot(account_label="paper-a")

        self.assertEqual(first_snapshot.now, cursor_by_account["paper-a"])
        self.assertEqual(second_snapshot.now, cursor_by_account["paper-b"])
        self.assertEqual(repeated_first_snapshot.now, cursor_by_account["paper-a"])
