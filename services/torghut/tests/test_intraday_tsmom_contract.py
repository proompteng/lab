from __future__ import annotations

import unittest
from decimal import Decimal

from app.trading.intraday_tsmom_contract import validate_intraday_tsmom_params
from app.trading.intraday_tsmom_contract.decimal import volatility_within_budget


class TestIntradayTsmomContract(unittest.TestCase):
    def test_volatility_budget_fails_closed_when_feature_is_missing(self) -> None:
        self.assertFalse(
            volatility_within_budget(
                None,
                floor=Decimal("0.0001"),
                ceil=Decimal("0.01"),
            )
        )

    def test_validate_intraday_tsmom_params_rejects_invalid_live_quality_fields(
        self,
    ) -> None:
        with self.assertRaisesRegex(
            ValueError, "invalid_max_recent_quote_invalid_ratio"
        ):
            validate_intraday_tsmom_params({"max_recent_quote_invalid_ratio": "bad"})

        with self.assertRaisesRegex(ValueError, "invalid_max_recent_quote_jump_bps"):
            validate_intraday_tsmom_params({"max_recent_quote_jump_bps": "bad"})

        with self.assertRaisesRegex(
            ValueError, "invalid_min_recent_microprice_bias_bps"
        ):
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
