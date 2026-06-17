from __future__ import annotations

# ruff: noqa: F401,F403,F405
__test__ = False
from tests.prices.test_fetch_price_prefers_close_c import TestFetchPricePrefersCloseC
from tests.prices.test_fetch_alpaca_latest_quote_returns_none_on_http_failure import (
    TestFetchAlpacaLatestQuoteReturnsNoneOnHttpFailure,
)
