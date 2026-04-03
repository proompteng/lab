from __future__ import annotations

import unittest

from app.trading.intraday_tsmom_contract import validate_intraday_tsmom_params


class TestIntradayTsmomContract(unittest.TestCase):
    def test_validate_intraday_tsmom_params_rejects_invalid_live_quality_fields(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid_max_recent_quote_invalid_ratio"):
            validate_intraday_tsmom_params({"max_recent_quote_invalid_ratio": "bad"})

        with self.assertRaisesRegex(ValueError, "invalid_max_recent_quote_jump_bps"):
            validate_intraday_tsmom_params({"max_recent_quote_jump_bps": "bad"})

        with self.assertRaisesRegex(ValueError, "invalid_min_recent_microprice_bias_bps"):
            validate_intraday_tsmom_params({"min_recent_microprice_bias_bps": "bad"})

        with self.assertRaisesRegex(
            ValueError,
            "invalid_min_cross_section_opening_window_return_rank",
        ):
            validate_intraday_tsmom_params(
                {"min_cross_section_opening_window_return_rank": "bad"}
            )

        with self.assertRaisesRegex(
            ValueError,
            "invalid_min_cross_section_continuation_rank",
        ):
            validate_intraday_tsmom_params(
                {"min_cross_section_continuation_rank": "bad"}
            )

        with self.assertRaisesRegex(
            ValueError,
            "invalid_min_cross_section_continuation_breadth",
        ):
            validate_intraday_tsmom_params(
                {"min_cross_section_continuation_breadth": "bad"}
            )
