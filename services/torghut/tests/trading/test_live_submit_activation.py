from __future__ import annotations

from datetime import datetime, timezone
from unittest import TestCase

from app.config import settings
from app.trading.live_submit_activation import (
    _coerce_utc_datetime,
    live_submit_activation_blocker,
    live_submit_activation_status,
)


class TestLiveSubmitActivation(TestCase):
    def setUp(self) -> None:
        self.original_expires_at = settings.trading_live_submit_activation_expires_at

    def tearDown(self) -> None:
        settings.trading_live_submit_activation_expires_at = self.original_expires_at

    def test_coerce_utc_datetime_accepts_datetime_and_rejects_non_temporal_values(
        self,
    ) -> None:
        aware = datetime(2026, 6, 17, 20, 5, tzinfo=timezone.utc)
        self.assertEqual(_coerce_utc_datetime(aware), aware)
        self.assertEqual(
            _coerce_utc_datetime(datetime(2026, 6, 17, 20, 5)),
            aware,
        )
        self.assertIsNone(_coerce_utc_datetime(object()))

    def test_invalid_activation_expiry_blocks_live_submit(self) -> None:
        settings.trading_live_submit_activation_expires_at = "not-a-date"

        status = live_submit_activation_status(
            now=datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc)
        )

        self.assertEqual(status["reason"], "live_submit_activation_expiry_invalid")
        self.assertTrue(status["expired"])
        self.assertEqual(
            live_submit_activation_blocker(
                now=datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc)
            ),
            "live_submit_activation_expiry_invalid",
        )
